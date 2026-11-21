import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  isFadeOverride,
  mapVttToClip,
  parseComposition,
  parseCuesFile,
  parseVtt,
  resolveCues,
  type BeatsFile,
  type CompositionClip,
  type CompositionDoc,
  type ParsedVtt,
} from '@open-director/protocol';
import { launchDeterministicBrowser, openStagePage } from './browser.js';
import { buildStageHtml } from './composer.js';
import {
  computeCompositionDuration,
  getFfmpegPath,
  probeProjectMedia,
  resolveOutputFps,
  type MediaProbeInfo,
} from './media.js';
import { startProjectServer } from './server.js';
import { ensureBuiltinSfxFile } from './sfx-library.js';

export interface ExportProgress {
  phase: 'preparing' | 'rendering' | 'done';
  frame: number;
  totalFrames: number;
  percent: number;
}

export interface ExportOptions {
  fps?: number;
  scale?: number;
  crf?: number;
  onProgress?: (progress: ExportProgress) => void;
}

export interface ExportResult {
  outPath: string;
  width: number;
  height: number;
  fps: number;
  totalFrames: number;
  durationSec: number;
  audioClipCount: number;
  errors: string[];
}

interface AudibleClipSpec {
  clip: CompositionClip;
  filePath: string;
  durationSec: number;
}

function buildAtempoFilters(speed: number): string[] {
  if (Math.abs(speed - 1) < 1e-4) return [];
  const filters: string[] = [];
  let rem = speed;
  while (rem < 0.5) {
    filters.push('atempo=0.5');
    rem /= 0.5;
  }
  while (rem > 2.0) {
    filters.push('atempo=2.0');
    rem /= 2.0;
  }
  filters.push(`atempo=${rem.toFixed(6)}`);
  return filters;
}

function collectAudibleClips(
  projectDir: string,
  doc: CompositionDoc,
  mediaInfo: ReadonlyMap<string, MediaProbeInfo>,
): AudibleClipSpec[] {
  const out: AudibleClipSpec[] = [];
  for (const track of doc.tracks) {
    if (track.hidden || track.muted) continue;
    for (const clip of track.clips) {
      if (clip.kind !== 'audio' && clip.kind !== 'video') continue;
      if (clip.muted || clip.volume <= 0) continue;
      const info = mediaInfo.get(clip.src);
      if (!info?.hasAudio) continue;
      const filePath = join(projectDir, clip.src);
      if (!existsSync(filePath)) continue;
      const srcEnd = clip.outSec ?? info.durationSec;
      const dur = Math.max(0, (srcEnd - clip.inSec) / clip.speed);
      if (dur <= 0) continue;
      out.push({ clip, filePath, durationSec: dur });
    }
  }
  return out;
}

interface PageSfxEventSpec {
  filePath: string;
  filmSec: number;
  gainDb: number;
  pan: number;
}

interface DuckConfig {
  duckDb: number;
  attack: number;
  release: number;
}

function parseDuckConfig(raw: string | undefined): DuckConfig | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DuckConfig>;
    return {
      duckDb: typeof parsed.duckDb === 'number' ? parsed.duckDb : -12,
      attack: typeof parsed.attack === 'number' ? Math.max(0, parsed.attack) : 0.15,
      release: typeof parsed.release === 'number' ? Math.max(0, parsed.release) : 0.35,
    };
  } catch {
    return { duckDb: -12, attack: 0.15, release: 0.35 };
  }
}

function collectSpeechIntervals(
  projectDir: string,
  audible: AudibleClipSpec[],
  duckClipId: string,
  attack: number,
  release: number,
): Array<[number, number]> {
  const rawIntervals: Array<[number, number]> = [];
  for (const item of audible) {
    if (item.clip.id === duckClipId) continue;
    if (item.clip.passthroughAttrs['data-adudir-duck']) continue;
    const vttPath = join(projectDir, item.clip.src.replace(/\.[^.]+$/, '.vtt'));
    if (existsSync(vttPath)) {
      try {
        const mapped = mapVttToClip(parseVtt(readFileSync(vttPath, 'utf8')), item.clip);
        if (mapped.length > 0) {
          for (const m of mapped) {
            rawIntervals.push([Math.max(0, m.startSec - attack), m.endSec + release]);
          }
          continue;
        }
      } catch {}
    }
    rawIntervals.push([Math.max(0, item.clip.at - attack), item.clip.at + item.durationSec + release]);
  }
  if (rawIntervals.length === 0) return [];
  rawIntervals.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [rawIntervals[0]];
  for (let i = 1; i < rawIntervals.length; i += 1) {
    const prev = merged[merged.length - 1];
    const cur = rawIntervals[i];
    if (cur[0] <= prev[1]) prev[1] = Math.max(prev[1], cur[1]);
    else merged.push(cur);
  }
  return merged;
}

function buildAudioFilterGraph(
  projectDir: string,
  audible: AudibleClipSpec[],
  sfxEvents: PageSfxEventSpec[],
): {
  inputArgs: string[];
  filterComplex: string | null;
  audioMap: string | null;
} {
  if (audible.length === 0 && sfxEvents.length === 0) {
    return { inputArgs: [], filterComplex: null, audioMap: null };
  }

  const inputArgs: string[] = [];
  const chains: string[] = [];
  const labels: string[] = [];
  let nextInputIdx = 1; // 0 is image2pipe video stdin

  for (let i = 0; i < audible.length; i += 1) {
    const { clip, filePath, durationSec } = audible[i];
    const inputIdx = nextInputIdx++;
    inputArgs.push('-i', filePath);

    const srcEnd = clip.inSec + durationSec * clip.speed;
    const steps: string[] = [
      `atrim=start=${clip.inSec.toFixed(6)}:end=${srcEnd.toFixed(6)}`,
      'asetpts=PTS-STARTPTS',
      ...buildAtempoFilters(clip.speed),
      'aformat=sample_rates=44100:channel_layouts=stereo',
    ];

    const fadeEntry = clip.overrides.find(isFadeOverride);
    if (fadeEntry) {
      const [fadeIn, fadeOut] = fadeEntry.fade;
      if (fadeIn > 0) {
        steps.push(`afade=t=in:st=0:d=${Math.min(fadeIn, durationSec).toFixed(4)}`);
      }
      if (fadeOut > 0) {
        const outStart = Math.max(0, durationSec - fadeOut);
        steps.push(`afade=t=out:st=${outStart.toFixed(4)}:d=${Math.min(fadeOut, durationSec).toFixed(4)}`);
      }
    }

    if (Math.abs(clip.volume - 1) > 1e-4) {
      steps.push(`volume=${clip.volume.toFixed(4)}`);
    }

    const delayMs = Math.round(clip.at * 1000);
    if (delayMs > 0) {
      steps.push(`adelay=${delayMs}|${delayMs}`);
    }

    const duckCfg = parseDuckConfig(clip.passthroughAttrs['data-adudir-duck']);
    if (duckCfg) {
      const intervals = collectSpeechIntervals(projectDir, audible, clip.id, duckCfg.attack, duckCfg.release);
      if (intervals.length > 0) {
        const duckLin = Math.pow(10, duckCfg.duckDb / 20).toFixed(4);
        const cond = intervals.map(([s, e]) => `between(t,${s.toFixed(3)},${e.toFixed(3)})`).join('+');
        steps.push(`volume='if(gt(${cond},0),${duckLin},1)':eval=frame`);
      }
    }

    const label = `a${i}`;
    chains.push(`[${inputIdx}:a]${steps.join(',')}[${label}]`);
    labels.push(`[${label}]`);
  }

  for (let j = 0; j < sfxEvents.length; j += 1) {
    const sfx = sfxEvents[j];
    const inputIdx = nextInputIdx++;
    inputArgs.push('-i', sfx.filePath);

    const linearGain = Math.pow(10, sfx.gainDb / 20);
    const leftGain = sfx.pan > 0 ? Math.max(0, 1 - sfx.pan) : 1;
    const rightGain = sfx.pan < 0 ? Math.max(0, 1 + sfx.pan) : 1;
    const delayMs = Math.max(0, Math.round(sfx.filmSec * 1000));

    const steps = [
      'asetpts=PTS-STARTPTS',
      'aformat=sample_rates=44100:channel_layouts=stereo',
      `pan=stereo|c0=${leftGain.toFixed(3)}*c0|c1=${rightGain.toFixed(3)}*c1`,
      `volume=${linearGain.toFixed(4)}`,
    ];
    if (delayMs > 0) {
      steps.push(`adelay=${delayMs}|${delayMs}`);
    }

    const label = `sfx${j}`;
    chains.push(`[${inputIdx}:a]${steps.join(',')}[${label}]`);
    labels.push(`[${label}]`);
  }

  if (labels.length === 1) {
    chains.push(`${labels[0]}alimiter=limit=0.95[aout]`);
  } else {
    chains.push(`${labels.join('')}amix=inputs=${labels.length}:duration=longest:normalize=0,alimiter=limit=0.95[aout]`);
  }

  return {
    inputArgs,
    filterComplex: chains.join(';'),
    audioMap: '[aout]',
  };
}

/**
 * Deterministically render all frames of `composition.html` through headless Chromium,
 * encode H.264 video, and mix independent audio clips via FFmpeg into an MP4 file.
 */
export async function exportProjectVideo(
  projectDir: string,
  outMp4Path: string,
  options: ExportOptions = {},
): Promise<ExportResult> {
  options.onProgress?.({ phase: 'preparing', frame: 0, totalFrames: 1, percent: 0 });

  const compHtml = readFileSync(join(projectDir, 'composition.html'), 'utf8');
  const doc = parseComposition(compHtml);
  const mediaInfo = await probeProjectMedia(projectDir, doc);

  let resolvedCueTimes: Record<string, number | undefined> = {};
  const cuesPath = join(projectDir, 'cues.json');
  if (existsSync(cuesPath)) {
    const cuesFile = parseCuesFile(readFileSync(cuesPath, 'utf8'));
    const intrinsic = new Map<string, number>();
    for (const [k, info] of mediaInfo.entries()) intrinsic.set(k, info.durationSec);
    const vttBySource = new Map<string, ParsedVtt>();
    const beatsBySource = new Map<string, BeatsFile>();
    for (const track of doc.tracks) {
      for (const clip of track.clips) {
        if (clip.kind !== 'audio' && clip.kind !== 'video') continue;
        const vttPath = join(projectDir, clip.src.replace(/\.[^.]+$/, '.vtt'));
        if (existsSync(vttPath) && !vttBySource.has(clip.src)) {
          try { vttBySource.set(clip.src, parseVtt(readFileSync(vttPath, 'utf8'))); } catch {}
        }
        const beatsPath = join(projectDir, `${clip.src}.beats.json`);
        if (existsSync(beatsPath) && !beatsBySource.has(clip.src)) {
          try { beatsBySource.set(clip.src, JSON.parse(readFileSync(beatsPath, 'utf8')) as BeatsFile); } catch {}
        }
      }
    }
    for (const [name, r] of Object.entries(resolveCues(cuesFile, doc, vttBySource, intrinsic, beatsBySource))) {
      resolvedCueTimes[name] = r.filmSec;
    }
  }

  const fps = options.fps ?? resolveOutputFps(doc, mediaInfo);
  const scale = options.scale ?? 1;
  const totalDuration = Math.max(0.1, computeCompositionDuration(doc, mediaInfo));
  const totalFrames = Math.max(1, Math.ceil(totalDuration * fps));

  const stageHtml = buildStageHtml(doc, mediaInfo, totalDuration);
  const server = await startProjectServer(projectDir, {
    clockConfig: { cues: resolvedCueTimes },
    stageHtmlProvider: async () => stageHtml,
  });

  const browser = await launchDeterministicBrowser();
  mkdirSync(dirname(outMp4Path), { recursive: true });

  const audible = collectAudibleClips(projectDir, doc, mediaInfo);

  try {
    const { page, errors } = await openStagePage(
      browser,
      server.origin,
      doc.viewport.width,
      doc.viewport.height,
      scale,
    );

    const rawPageSfx = await page.evaluate(() => {
      const st = (
        window as unknown as {
          __openDirectorStage?: {
            getSfxEvents?(): Array<{
              clipId: string;
              pageSrc: string;
              filmSec: number;
              id?: string;
              src?: string;
              gain?: number;
              pan?: number;
            }>;
          };
        }
      ).__openDirectorStage;
      return st?.getSfxEvents?.() ?? [];
    });

    const sfxEvents: PageSfxEventSpec[] = [];
    for (const ev of rawPageSfx) {
      let filePath: string | null = null;
      if (ev.id) {
        filePath = ensureBuiltinSfxFile(ev.id);
      } else if (ev.src) {
        const candidate = join(projectDir, dirname(ev.pageSrc), ev.src);
        if (existsSync(candidate)) filePath = candidate;
      }
      if (filePath) {
        sfxEvents.push({
          filePath,
          filmSec: ev.filmSec,
          gainDb: Math.max(-60, Math.min(12, ev.gain ?? 0)),
          pan: Math.max(-1, Math.min(1, ev.pan ?? 0)),
        });
      }
    }

    const { inputArgs, filterComplex, audioMap } = buildAudioFilterGraph(projectDir, audible, sfxEvents);

    const ffmpegBin = getFfmpegPath();
    const ffmpegArgs = [
      '-y',
      '-f',
      'image2pipe',
      '-vcodec',
      'png',
      '-framerate',
      String(fps),
      '-i',
      '-',
      ...inputArgs,
      ...(filterComplex ? ['-filter_complex', filterComplex] : []),
      '-map',
      '0:v',
      ...(audioMap ? ['-map', audioMap, '-c:a', 'aac', '-b:a', '192k'] : []),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-crf',
      String(options.crf ?? 18),
      '-preset',
      'medium',
      '-movflags',
      '+faststart',
      '-t',
      totalDuration.toFixed(4),
      outMp4Path,
    ];

    const proc = spawn(ffmpegBin, ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    let ffmpegStderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      ffmpegStderr = (ffmpegStderr + chunk.toString('utf8')).slice(-8192);
    });

    const ffmpegDone = new Promise<void>((resolve, reject) => {
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}: ${ffmpegStderr}`));
      });
    });

    for (let i = 0; i < totalFrames; i += 1) {
      const t = i / fps;
      await page.evaluate(async (time) => {
        const st = (
          window as unknown as {
            __openDirectorStage: { renderAtTime(t: number): Promise<void> };
          }
        ).__openDirectorStage;
        await st.renderAtTime(time);
      }, t);
      const png = await page.screenshot({ type: 'png' });
      const ok = proc.stdin.write(png);
      if (!ok) {
        await new Promise<void>((r) => proc.stdin.once('drain', r));
      }
      options.onProgress?.({
        phase: 'rendering',
        frame: i + 1,
        totalFrames,
        percent: Math.round(((i + 1) / totalFrames) * 100),
      });
    }

    proc.stdin.end();
    await ffmpegDone;

    options.onProgress?.({ phase: 'done', frame: totalFrames, totalFrames, percent: 100 });
    return {
      outPath: outMp4Path,
      width: Math.round(doc.viewport.width * scale),
      height: Math.round(doc.viewport.height * scale),
      fps,
      totalFrames,
      durationSec: totalDuration,
      audioClipCount: audible.length + sfxEvents.length,
      errors,
    };
  } finally {
    await browser.close();
    await server.close();
  }
}

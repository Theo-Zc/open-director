import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parseComposition, type BeatsFile } from '@open-director/protocol';
import { captureProjectFrames } from './browser.js';
import { getFfmpegPath, probeProjectMedia } from './media.js';

const execFileAsync = promisify(execFile);

export interface LoudnessMeasurement {
  measuredLufs: number;
  measuredTruePeakDbtp: number;
  measuredLra: number;
  measuredThresh: number;
}

/**
 * Measure integrated loudness (LUFS), true peak (dBTP), and loudness range (LRA)
 * of a media file segment using FFmpeg's `loudnorm` filter.
 */
export async function measureAudioLoudness(
  filePath: string,
  options: { inSec?: number; outSec?: number } = {},
): Promise<LoudnessMeasurement> {
  const ffmpeg = getFfmpegPath();
  const trimArgs: string[] = [];
  if (options.inSec !== undefined && options.inSec > 0) {
    trimArgs.push('-ss', String(options.inSec));
  }
  if (options.outSec !== undefined) {
    const start = options.inSec ?? 0;
    if (options.outSec > start) {
      trimArgs.push('-t', String(options.outSec - start));
    }
  }

  const { stderr } = await execFileAsync(ffmpeg, [
    '-hide_banner',
    '-nostats',
    ...trimArgs,
    '-i',
    filePath,
    '-af',
    'loudnorm=I=-18:TP=-1.0:LRA=11:print_format=json',
    '-f',
    'null',
    '-',
  ]);

  const match = stderr.match(/\{[\s\S]*"input_i"[\s\S]*\}/);
  if (!match) {
    throw new Error(`Failed to parse FFmpeg loudnorm measurement for "${filePath}"`);
  }
  const parsed = JSON.parse(match[0]) as {
    input_i: string;
    input_tp: string;
    input_lra: string;
    input_thresh: string;
  };

  return {
    measuredLufs: Number(parsed.input_i),
    measuredTruePeakDbtp: Number(parsed.input_tp),
    measuredLra: Number(parsed.input_lra),
    measuredThresh: Number(parsed.input_thresh),
  };
}

/**
 * Extract onset beat timestamps and approximate BPM from an audio file by analyzing
 * short-time energy flux on decoded 8kHz mono PCM frames.
 */
export async function extractBeatOnsets(filePath: string, saveBeside = false): Promise<BeatsFile> {
  const ffmpeg = getFfmpegPath();
  const sampleRate = 8000;
  const proc = spawn(
    ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-i', filePath, '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', 'pipe:1'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const chunks: Buffer[] = [];
  let errText = '';
  proc.stdout.on('data', (c: Buffer) => chunks.push(c));
  proc.stderr.on('data', (c: Buffer) => {
    errText += c.toString('utf8');
  });

  await new Promise<void>((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(errText || `ffmpeg exited ${code}`))));
  });

  const buf = Buffer.concat(chunks);
  const floatCount = Math.floor(buf.byteLength / 4);
  const samples = new Float32Array(floatCount);
  for (let i = 0; i < floatCount; i += 1) {
    samples[i] = buf.readFloatLE(i * 4);
  }

  // 20ms hop = 160 samples
  const hop = 160;
  const win = 320;
  const energies: number[] = [];
  for (let pos = 0; pos + win <= floatCount; pos += hop) {
    let sum = 0;
    for (let j = 0; j < win; j += 1) {
      sum += samples[pos + j] * samples[pos + j];
    }
    energies.push(Math.sqrt(sum / win));
  }

  const flux: number[] = [0];
  for (let i = 1; i < energies.length; i += 1) {
    flux.push(Math.max(0, energies[i] - energies[i - 1]));
  }

  // Adaptive local threshold peak picking (min spacing 0.25s = ~12 hops)
  const beats: number[] = [];
  const windowHalf = 15;
  let lastBeatHop = -100;
  for (let i = 1; i < flux.length - 1; i += 1) {
    const start = Math.max(0, i - windowHalf);
    const end = Math.min(flux.length, i + windowHalf + 1);
    let mean = 0;
    for (let k = start; k < end; k += 1) mean += flux[k];
    mean /= end - start;
    const thresh = Math.max(0.015, mean * 2.1);

    if (flux[i] > thresh && flux[i] >= flux[i - 1] && flux[i] > flux[i + 1] && i - lastBeatHop >= 12) {
      beats.push(Number(((i * hop) / sampleRate).toFixed(3)));
      lastBeatHop = i;
    }
  }

  let bpm = 120;
  if (beats.length >= 2) {
    const intervals: number[] = [];
    for (let i = 1; i < beats.length; i += 1) {
      const dt = beats[i] - beats[i - 1];
      if (dt >= 0.25 && dt <= 1.5) intervals.push(dt);
    }
    if (intervals.length > 0) {
      intervals.sort((a, b) => a - b);
      const median = intervals[Math.floor(intervals.length / 2)];
      bpm = Math.round(60 / median);
    }
  }

  const result: BeatsFile = { bpm, beatsPerBar: 4, beats };
  if (saveBeside) {
    writeFileSync(`${filePath}.beats.json`, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  return result;
}

/**
 * Compute a 64-bit difference hash (dHash) of a video/image frame using FFmpeg 9x8 grayscale scale.
 */
export async function computeFrameDhash(filePath: string, atSec = 0): Promise<string> {
  const ffmpeg = getFfmpegPath();
  const proc = spawn(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      ...(atSec > 0 ? ['-ss', String(atSec)] : []),
      '-i',
      filePath,
      '-frames:v',
      '1',
      '-vf',
      'scale=9:8,format=gray',
      '-f',
      'rawvideo',
      'pipe:1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const chunks: Buffer[] = [];
  proc.stdout.on('data', (c: Buffer) => chunks.push(c));
  await new Promise<void>((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`dhash ffmpeg exited ${code}`))));
  });

  const pixels = Buffer.concat(chunks);
  if (pixels.byteLength < 72) {
    throw new Error(`Expected 72 grayscale bytes for dHash, got ${pixels.byteLength}`);
  }

  let hash = 0n;
  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      const idx = row * 9 + col;
      if (pixels[idx] < pixels[idx + 1]) {
        hash |= 1n << BigInt(row * 8 + col);
      }
    }
  }
  return hash.toString();
}

export interface ProjectAuditReport {
  samples: Array<{ timeSec: number; clipId: string; hint: string }>;
  overflows: Array<{ timeSec: number; clipId: string; text: string }>;
  missingAssets: string[];
  audioLoudness: Array<{ clipId: string; src: string; measuredLufs: number; measuredTruePeakDbtp: number; measuredLra: number }>;
  errors: string[];
}

/**
 * Run a comprehensive preflight audit across sample placeholders, text clipping,
 * missing sources, and real audio track loudness.
 */
export async function auditProject(projectDir: string): Promise<ProjectAuditReport> {
  const compPath = join(projectDir, 'composition.html');
  const doc = parseComposition(readFileSync(compPath, 'utf8'));
  const mediaInfo = await probeProjectMedia(projectDir, doc);

  const missingAssets: string[] = [];
  const audioTargets: Array<{ clipId: string; src: string; filePath: string; inSec: number; outSec?: number }> = [];
  const sampleTimes = new Set<number>([0]);

  for (const track of doc.tracks) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      const full = join(projectDir, clip.src);
      if (!existsSync(full)) {
        missingAssets.push(clip.src);
        continue;
      }
      if (clip.kind === 'page') {
        sampleTimes.add(Number((clip.at + 0.5).toFixed(2)));
        if (clip.outSec !== undefined) {
          const mid = clip.at + (clip.outSec - clip.inSec) * 0.5;
          sampleTimes.add(Number(mid.toFixed(2)));
        }
      }
      if ((clip.kind === 'audio' || clip.kind === 'video') && !track.muted && !clip.muted) {
        const info = mediaInfo.get(clip.src);
        if (info?.hasAudio) {
          audioTargets.push({ clipId: clip.id, src: clip.src, filePath: full, inSec: clip.inSec, outSec: clip.outSec });
        }
      }
    }
  }

  const samples: ProjectAuditReport['samples'] = [];
  const overflows: ProjectAuditReport['overflows'] = [];
  const errors: string[] = [];

  if (sampleTimes.size > 0) {
    const times = [...sampleTimes].sort((a, b) => a - b).slice(0, 6);
    const look = await captureProjectFrames(projectDir, times, { scale: 0.5 });
    for (const f of look.frames) {
      for (const s of f.warnings.samples) {
        samples.push({ timeSec: f.timeSec, clipId: s.clipId, hint: s.hint });
      }
      for (const o of f.warnings.overflows) {
        overflows.push({ timeSec: f.timeSec, clipId: o.clipId, text: o.text });
      }
      errors.push(...f.errors);
    }
  }

  const audioLoudness: ProjectAuditReport['audioLoudness'] = [];
  for (const target of audioTargets) {
    try {
      const m = await measureAudioLoudness(target.filePath, { inSec: target.inSec, outSec: target.outSec });
      audioLoudness.push({
        clipId: target.clipId,
        src: target.src,
        measuredLufs: m.measuredLufs,
        measuredTruePeakDbtp: m.measuredTruePeakDbtp,
        measuredLra: m.measuredLra,
      });
    } catch {
      // ignore unmeasurable clips
    }
  }

  return {
    samples,
    overflows,
    missingAssets,
    audioLoudness,
    errors: [...new Set(errors)],
  };
}

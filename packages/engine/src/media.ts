import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getClipTimelineDuration, type CompositionDoc } from '@open-director/protocol';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

export interface MediaProbeInfo {
  durationSec: number;
  width?: number;
  height?: number;
  fps?: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

function resolveBinary(envKey: string, bundledPkg: string, fallbackNames: string[]): string {
  const fromEnv = process.env[envKey];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  try {
    const loaded = require(bundledPkg) as string | { path?: string };
    const candidate = typeof loaded === 'string' ? loaded : loaded?.path;
    if (candidate && existsSync(candidate)) return candidate;
  } catch {
    // ignore missing optional bundled binary
  }

  for (const name of fallbackNames) {
    if (existsSync(name)) return name;
  }
  return fallbackNames[0];
}

export function getFfmpegPath(): string {
  return resolveBinary('OPEN_DIRECTOR_FFMPEG', 'ffmpeg-static', [
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    'ffmpeg',
  ]);
}

export function getFfprobePath(): string {
  return resolveBinary('OPEN_DIRECTOR_FFPROBE', 'ffprobe-static', [
    '/opt/homebrew/bin/ffprobe',
    '/usr/local/bin/ffprobe',
    'ffprobe',
  ]);
}

function parseFrameRate(raw: string | undefined): number | undefined {
  if (!raw || raw === '0/0') return undefined;
  const [nStr, dStr] = raw.split('/');
  const n = Number(nStr);
  const d = dStr ? Number(dStr) : 1;
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return undefined;
  return n / d;
}

export async function probeMedia(filePath: string): Promise<MediaProbeInfo> {
  const ffprobe = getFfprobePath();
  const { stdout } = await execFileAsync(ffprobe, [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);
  const data = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      r_frame_rate?: string;
      duration?: string;
    }>;
  };

  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  const durationSec = Number(data.format?.duration ?? video?.duration ?? audio?.duration ?? 0);

  return {
    durationSec: Number.isFinite(durationSec) ? durationSec : 0,
    width: video?.width,
    height: video?.height,
    fps: parseFrameRate(video?.avg_frame_rate) ?? parseFrameRate(video?.r_frame_rate),
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
  };
}

/**
 * Probe all unique `<video>` and `<audio>` files referenced by `composition.html`.
 */
export async function probeProjectMedia(
  projectDir: string,
  doc: CompositionDoc,
): Promise<Map<string, MediaProbeInfo>> {
  const uniqueSources = new Set<string>();
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.kind === 'video' || clip.kind === 'audio') {
        uniqueSources.add(clip.src);
      }
    }
  }

  const result = new Map<string, MediaProbeInfo>();
  await Promise.all(
    [...uniqueSources].map(async (src) => {
      const fullPath = join(projectDir, src);
      if (!existsSync(fullPath)) return;
      try {
        result.set(src, await probeMedia(fullPath));
      } catch {
        // leave unprobed if unreadable; validator reports missing/broken files separately
      }
    }),
  );
  return result;
}

const STANDARD_RATES = [24, 25, 30, 50, 60];

function snapToCommonRate(fps: number): number {
  if (Math.abs(fps - 23.976) < 0.1) return 24;
  if (Math.abs(fps - 29.97) < 0.1) return 30;
  if (Math.abs(fps - 59.94) < 0.1) return 60;
  let best = 30;
  let bestDist = Infinity;
  for (const r of STANDARD_RATES) {
    const d = Math.abs(fps - r);
    if (d < bestDist) {
      best = r;
      bestDist = d;
    }
  }
  return best;
}

export function resolveOutputFps(
  doc: CompositionDoc,
  mediaInfo: ReadonlyMap<string, MediaProbeInfo>,
): number {
  if (doc.fps !== 'auto') return doc.fps;
  const rates: number[] = [];
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== 'video') continue;
      const fps = mediaInfo.get(clip.src)?.fps;
      if (fps) rates.push(snapToCommonRate(fps));
    }
  }
  if (rates.length === 0) return 30;
  return Math.max(...rates);
}

export function computeCompositionDuration(
  doc: CompositionDoc,
  mediaInfo: ReadonlyMap<string, MediaProbeInfo>,
  pageDurations: ReadonlyMap<string, number> = new Map(),
): number {
  const intrinsic = new Map<string, number>();
  for (const [k, info] of mediaInfo.entries()) intrinsic.set(k, info.durationSec);
  for (const [k, d] of pageDurations.entries()) intrinsic.set(k, d);

  let maxEnd = 0;
  for (const track of doc.tracks) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      const dur = getClipTimelineDuration(clip, intrinsic);
      const end = clip.at + (dur ?? 5);
      if (end > maxEnd) maxEnd = end;
    }
  }
  return maxEnd;
}

import { z } from 'zod';
import type { CompositionClip, CompositionDoc } from './composition.js';
import type { ParsedVtt } from './vtt.js';

export const CUE_SPEC_SCHEMA = z.union([
  z.object({
    at: z.number().finite(),
    offset: z.number().finite().optional(),
  }),
  z.object({
    word: z.string().min(1),
    clip: z.string().min(1),
    n: z.number().int().positive().optional(),
    offset: z.number().finite().optional(),
  }),
  z.object({
    clip: z.string().min(1),
    edge: z.enum(['start', 'end']),
    offset: z.number().finite().optional(),
  }),
  z.object({
    bar: z.number().int().positive(),
    beat: z.number().int().positive().optional(),
    clip: z.string().min(1),
    offset: z.number().finite().optional(),
  }),
]);

export interface BeatsFile {
  bpm?: number;
  beatsPerBar?: number;
  beats: number[];
}

export const CUES_FILE_SCHEMA = z.object({
  schema: z.literal('open-director.cues/1').default('open-director.cues/1'),
  cues: z.record(CUE_SPEC_SCHEMA),
});

export type CueSpec = z.infer<typeof CUE_SPEC_SCHEMA>;
export type CuesFile = z.infer<typeof CUES_FILE_SCHEMA>;

export interface ResolvedCue {
  name: string;
  filmSec?: number;
  status: 'ok' | 'missing';
  reason?: string;
}

export function parseCuesFile(raw: string): CuesFile {
  const parsed = JSON.parse(raw);
  return CUES_FILE_SCHEMA.parse(parsed);
}

function findClipById(doc: CompositionDoc, clipId: string): CompositionClip | undefined {
  for (const track of doc.tracks) {
    const found = track.clips.find((c) => c.id === clipId);
    if (found) return found;
  }
  return undefined;
}

function findWordInClip(
  vtt: ParsedVtt,
  clip: CompositionClip,
  word: string,
  occurrence = 1,
): number | undefined {
  let count = 0;
  const outLimit = clip.outSec ?? Infinity;
  const speed = clip.speed || 1;
  const target = word.toLowerCase();

  for (const cue of vtt.cues) {
    if (cue.endSec <= clip.inSec || cue.startSec >= outLimit) continue;
    for (const w of cue.words) {
      if (w.at < clip.inSec || w.at > outLimit) continue;
      if (w.text.toLowerCase().includes(target)) {
        count += 1;
        if (count === occurrence) {
          return clip.at + (w.at - clip.inSec) / speed;
        }
      }
    }
    if (cue.words.length === 0 && cue.plainText.toLowerCase().includes(target)) {
      count += 1;
      if (count === occurrence) {
        const clamped = Math.max(clip.inSec, cue.startSec);
        return clip.at + (clamped - clip.inSec) / speed;
      }
    }
  }
  return undefined;
}

/**
 * Resolve all named cues in `cues.json` to absolute film seconds against the current composition and VTT files.
 */
export function resolveCues(
  cuesFile: CuesFile,
  doc: CompositionDoc,
  vttBySource: ReadonlyMap<string, ParsedVtt> = new Map(),
  intrinsicDurationsSec: ReadonlyMap<string, number> = new Map(),
  beatsBySource: ReadonlyMap<string, BeatsFile> = new Map(),
): Record<string, ResolvedCue> {
  const result: Record<string, ResolvedCue> = {};

  for (const [name, spec] of Object.entries(cuesFile.cues)) {
    const offset = spec.offset ?? 0;
    if ('at' in spec) {
      result[name] = { name, filmSec: spec.at + offset, status: 'ok' };
      continue;
    }

    const clip = findClipById(doc, spec.clip);
    if (!clip) {
      result[name] = { name, status: 'missing', reason: `Clip "${spec.clip}" not found` };
      continue;
    }

    if ('bar' in spec) {
      const beatsData = beatsBySource.get(clip.src);
      if (!beatsData || beatsData.beats.length === 0) {
        result[name] = { name, status: 'missing', reason: `No beats analysis found for "${clip.src}"` };
        continue;
      }
      const bpb = beatsData.beatsPerBar ?? 4;
      const beatIdx = (spec.bar - 1) * bpb + ((spec.beat ?? 1) - 1);
      if (beatIdx < 0 || beatIdx >= beatsData.beats.length) {
        result[name] = {
          name,
          status: 'missing',
          reason: `Bar ${spec.bar} beat ${spec.beat ?? 1} (index ${beatIdx}) exceeds ${beatsData.beats.length} detected beats`,
        };
        continue;
      }
      const sourceSec = beatsData.beats[beatIdx];
      const filmSec = clip.at + (sourceSec - clip.inSec) / clip.speed + offset;
      result[name] = { name, filmSec, status: 'ok' };
      continue;
    }

    if ('edge' in spec) {
      if (spec.edge === 'start') {
        result[name] = { name, filmSec: clip.at + offset, status: 'ok' };
      } else {
        const srcEnd = clip.outSec ?? intrinsicDurationsSec.get(clip.src);
        if (srcEnd === undefined) {
          result[name] = { name, status: 'missing', reason: `Clip "${clip.id}" duration is unknown` };
        } else {
          const dur = (srcEnd - clip.inSec) / clip.speed;
          result[name] = { name, filmSec: clip.at + dur + offset, status: 'ok' };
        }
      }
      continue;
    }

    const vtt = vttBySource.get(clip.src);
    if (!vtt) {
      result[name] = { name, status: 'missing', reason: `No VTT subtitles found for "${clip.src}"` };
      continue;
    }

    const foundSec = findWordInClip(vtt, clip, spec.word, spec.n ?? 1);
    if (foundSec === undefined) {
      result[name] = { name, status: 'missing', reason: `Word "${spec.word}" (#${spec.n ?? 1}) not found in clip "${clip.id}"` };
    } else {
      result[name] = { name, filmSec: foundSec + offset, status: 'ok' };
    }
  }

  return result;
}

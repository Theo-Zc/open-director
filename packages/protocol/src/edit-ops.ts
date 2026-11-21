import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { z } from 'zod';
import {
  getClipTimelineDuration,
  parseComposition,
  parseMediaSrc,
  serializeComposition,
  validateComposition,
  type ClipKind,
  type CompositionClip,
  type CompositionDoc,
} from './composition.js';
import { isElementOverride, isFadeOverride, setRootParamInOverrides, type ElementOverride } from './overrides.js';

export const EDIT_OP_SCHEMA = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('move'),
    clip: z.string().min(1),
    at: z.number().nonnegative().optional(),
    track: z.union([z.number().int().nonnegative(), z.literal('top'), z.literal('new')]).optional(),
  }),
  z.object({
    op: z.literal('trim'),
    clip: z.string().min(1),
    from: z.number().nonnegative(),
    to: z.number().positive().optional(),
  }),
  z.object({
    op: z.literal('set'),
    clip: z.string().min(1),
    volume: z.number().nonnegative().optional(),
    speed: z.number().min(0.25).max(4).optional(),
    muted: z.boolean().optional(),
  }),
  z.object({
    op: z.literal('fade'),
    clip: z.string().min(1),
    in: z.number().nonnegative(),
    out: z.number().nonnegative(),
  }),
  z.object({
    op: z.literal('text'),
    clip: z.string().min(1),
    at: z.string().min(1),
    text: z.string(),
    n: z.number().int().positive().optional(),
  }),
  z.object({
    op: z.literal('style'),
    clip: z.string().min(1),
    at: z.string().min(1),
    style: z.record(z.string()),
    n: z.number().int().positive().optional(),
  }),
  z.object({
    op: z.literal('param'),
    clip: z.string().min(1),
    name: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  }),
  z.object({
    op: z.literal('box'),
    clip: z.string().min(1),
    left: z.number().optional(),
    top: z.number().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    rotate: z.number().optional(),
    css: z.record(z.string()).optional(),
  }),
  z.object({
    op: z.literal('add'),
    clip: z.object({
      id: z.string().min(1).optional(),
      kind: z.enum(['page', 'video', 'image', 'audio']).optional(),
      src: z.string().min(1),
      at: z.number().nonnegative().optional(),
      from: z.number().nonnegative().optional(),
      to: z.number().positive().optional(),
      volume: z.number().nonnegative().optional(),
      speed: z.number().min(0.25).max(4).optional(),
      muted: z.boolean().optional(),
      left: z.number().optional(),
      top: z.number().optional(),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
    }),
    track: z.union([z.number().int().nonnegative(), z.literal('top'), z.literal('new')]).optional(),
  }),
  z.object({
    op: z.literal('remove'),
    clip: z.string().min(1),
  }),
  z.object({
    op: z.literal('ripple'),
    clip: z.string().min(1),
    by: z.number().finite(),
  }),
  z.object({
    op: z.literal('split'),
    clip: z.string().min(1),
    atFilmSec: z.number().nonnegative(),
  }),
  z.object({
    op: z.literal('attr'),
    clip: z.string().min(1),
    name: z.string().min(1),
    value: z.string().nullable(),
  }),
  z.object({
    op: z.literal('track'),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative().optional(),
    hidden: z.boolean().optional(),
    muted: z.boolean().optional(),
    locked: z.boolean().optional(),
    remove: z.boolean().optional(),
  }),
]);

export type EditOp = z.infer<typeof EDIT_OP_SCHEMA>;

export interface HistoryEntry {
  id: string;
  timestamp: string;
  author: 'human' | 'agent';
  why: string;
  ops: EditOp[];
  changes: string[];
  affectedClipIds?: string[];
  focusTimeSec?: number;
  beforeSha256: string;
  afterSha256: string;
  beforeHtml: string;
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']);

function inferKindFromSrc(src: string): ClipKind {
  const clean = src.split('#')[0];
  const ext = extname(clean).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'page';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  throw new Error(`Cannot infer clip kind from "${src}"; pass clip.kind explicitly`);
}

function locateClip(doc: CompositionDoc, clipId: string): { trackIdx: number; clipIdx: number; clip: CompositionClip } {
  for (let ti = 0; ti < doc.tracks.length; ti += 1) {
    const ci = doc.tracks[ti].clips.findIndex((c) => c.id === clipId);
    if (ci !== -1) return { trackIdx: ti, clipIdx: ci, clip: doc.tracks[ti].clips[ci] };
  }
  throw new Error(`Clip "${clipId}" not found`);
}

function assertTrackMutable(doc: CompositionDoc, trackIdx: number, author: 'human' | 'agent'): void {
  const track = doc.tracks[trackIdx];
  if (!track) throw new Error(`Track ${trackIdx} does not exist`);
  if (track.locked && author === 'agent') {
    throw new Error(`Track ${trackIdx} is locked; agent edits cannot modify locked tracks`);
  }
}

function upsertElementOverride(
  clip: CompositionClip,
  at: string,
  n: number | undefined,
  mutate: (entry: ElementOverride) => void,
): void {
  let entry = clip.overrides.find(
    (o): o is ElementOverride => isElementOverride(o) && o.at === at && (o.n ?? undefined) === (n ?? undefined),
  );
  if (!entry) {
    entry = { at, ...(n !== undefined ? { n } : {}) };
    clip.overrides.push(entry);
  }
  mutate(entry);
}

/**
 * Apply an atomic batch of `EditOp`s to an in-memory `CompositionDoc` (mutates a deep clone).
 */
export function applyEditOps(
  doc: CompositionDoc,
  ops: EditOp[],
  options: {
    author?: 'human' | 'agent';
    intrinsicDurationsSec?: ReadonlyMap<string, number>;
  } = {},
): { nextDoc: CompositionDoc; changes: string[]; affectedClipIds: string[]; focusTimeSec?: number } {
  const author = options.author ?? 'human';
  const next: CompositionDoc = structuredClone(doc);
  const changes: string[] = [];
  const affected = new Set<string>();
  let focusTimeSec: number | undefined;

  const trackAffected = (clip: CompositionClip) => {
    affected.add(clip.id);
    if (focusTimeSec === undefined) focusTimeSec = clip.at;
  };

  for (const op of ops) {
    switch (op.op) {
      case 'move': {
        const { trackIdx, clipIdx, clip } = locateClip(next, op.clip);
        assertTrackMutable(next, trackIdx, author);
        const parts: string[] = [];
        if (op.at !== undefined) {
          parts.push(`at ${clip.at} -> ${op.at}`);
          clip.at = op.at;
          focusTimeSec = op.at;
        }
        trackAffected(clip);
        if (op.track !== undefined) {
          let targetIdx: number;
          if (op.track === 'top') {
            next.tracks.unshift({ hidden: false, muted: false, locked: false, passthroughAttrs: {}, clips: [] });
            targetIdx = 0;
            const shiftedFrom = trackIdx + 1;
            next.tracks[shiftedFrom].clips.splice(clipIdx, 1);
            next.tracks[targetIdx].clips.push(clip);
            parts.push(`track ${trackIdx} -> top(0)`);
          } else if (op.track === 'new') {
            next.tracks.push({ hidden: false, muted: false, locked: false, passthroughAttrs: {}, clips: [] });
            targetIdx = next.tracks.length - 1;
            next.tracks[trackIdx].clips.splice(clipIdx, 1);
            next.tracks[targetIdx].clips.push(clip);
            parts.push(`track ${trackIdx} -> new(${targetIdx})`);
          } else {
            assertTrackMutable(next, op.track, author);
            if (op.track !== trackIdx) {
              next.tracks[trackIdx].clips.splice(clipIdx, 1);
              next.tracks[op.track].clips.push(clip);
              parts.push(`track ${trackIdx} -> ${op.track}`);
            }
          }
        }
        changes.push(`move ${clip.id}: ${parts.join(', ')}`);
        break;
      }

      case 'trim': {
        const { trackIdx, clip } = locateClip(next, op.clip);
        assertTrackMutable(next, trackIdx, author);
        if (op.to !== undefined && op.to <= op.from) {
          throw new Error(`trim on "${clip.id}": to (${op.to}) must be > from (${op.from})`);
        }
        clip.inSec = op.from;
        clip.outSec = op.to;
        trackAffected(clip);
        changes.push(`trim ${clip.id}: #t=${op.from}${op.to !== undefined ? ',' + op.to : ''}`);
        break;
      }

      case 'set': {
        const { trackIdx, clip } = locateClip(next, op.clip);
        assertTrackMutable(next, trackIdx, author);
        if (clip.kind !== 'video' && clip.kind !== 'audio') {
          throw new Error(`"set" volume/speed/muted only applies to video or audio clips (got ${clip.kind})`);
        }
        if (op.speed !== undefined) clip.speed = op.speed;
        if (op.muted !== undefined) {
          clip.muted = op.muted;
          if (op.muted) clip.volume = 0;
        }
        if (op.volume !== undefined) {
          clip.volume = op.volume;
          clip.muted = op.volume === 0;
        }
        trackAffected(clip);
        changes.push(`set ${clip.id}: speed=${clip.speed}, volume=${clip.volume}, muted=${clip.muted}`);
        break;
      }

      case 'fade': {
        const { trackIdx, clip } = locateClip(next, op.clip);
        assertTrackMutable(next, trackIdx, author);
        const existingIdx = clip.overrides.findIndex(isFadeOverride);
        if (op.in === 0 && op.out === 0) {
          if (existingIdx !== -1) clip.overrides.splice(existingIdx, 1);
        } else if (existingIdx !== -1) {
          clip.overrides[existingIdx] = { fade: [op.in, op.out] };
        } else {
          clip.overrides.push({ fade: [op.in, op.out] });
        }
        trackAffected(clip);
        changes.push(`fade ${clip.id}: [${op.in}, ${op.out}]`);
        break;
      }

      case 'text': {
        const { trackIdx, clip } = locateClip(next, op.clip);
        assertTrackMutable(next, trackIdx, author);
        if (clip.kind !== 'page') {
          throw new Error(`"text" override is only supported on page clips`);
        }
        upsertElementOverride(clip, op.at, op.n, (entry) => {
          entry.text = op.text;
        });
        trackAffected(clip);
        changes.push(`text ${clip.id} (${op.at}): "${op.text.slice(0, 32)}"`);
        break;
      }

      case 'style': {
        const { trackIdx, clip } = locateClip(next, op.clip);
        assertTrackMutable(next, trackIdx, author);
        if (clip.kind !== 'page') {
          throw new Error(`"style" override is only supported on page clips`);
        }
        upsertElementOverride(clip, op.at, op.n, (entry) => {
          entry.style = { ...(entry.style ?? {}), ...op.style };
        });
        trackAffected(clip);
        changes.push(`style ${clip.id} (${op.at}): ${Object.keys(op.style).join(', ')}`);
        break;
      }

      case 'param': {
        const { trackIdx, clip } = locateClip(next, op.clip);
        assertTrackMutable(next, trackIdx, author);
        if (clip.kind !== 'page') {
          throw new Error(`"param" override is only supported on page clips`);
        }
        let encoded: string | null = null;
        if (op.value !== null) {
          if (typeof op.value === 'boolean') encoded = op.value ? '1' : '0';
          else if (typeof op.value === 'number') encoded = String(op.value);
          else if (op.value.startsWith('#')) encoded = op.value.toLowerCase();
          else encoded = JSON.stringify(op.value);
        }
        clip.overrides = setRootParamInOverrides(clip.overrides, op.name, encoded);
        trackAffected(clip);
        changes.push(`param ${clip.id} --${op.name} = ${encoded ?? 'default'}`);
        break;
      }

      case 'box': {
        const { trackIdx, clip } = locateClip(next, op.clip);
        assertTrackMutable(next, trackIdx, author);
        if (op.left !== undefined) clip.box.left = op.left;
        if (op.top !== undefined) clip.box.top = op.top;
        if (op.width !== undefined) clip.box.width = op.width;
        if (op.height !== undefined) clip.box.height = op.height;
        if (op.rotate !== undefined) clip.rotate = op.rotate;
        if (op.css) {
          Object.assign(clip.visualStyle, op.css);
        }
        trackAffected(clip);
        changes.push(`box ${clip.id}`);
        break;
      }

      case 'add': {
        const parsedSrc = parseMediaSrc(op.clip.src);
        const kind = op.clip.kind ?? inferKindFromSrc(parsedSrc.src);
        const inSec = op.clip.from ?? parsedSrc.inSec;
        const outSec = op.clip.to ?? parsedSrc.outSec;
        if (kind === 'image' && outSec === undefined) {
          throw new Error(`Adding <img> clip "${parsedSrc.src}" requires "to" or "#t=in,out"`);
        }
        const id = op.clip.id ?? (basename(parsedSrc.src, extname(parsedSrc.src)) || 'clip');
        const newClip: CompositionClip = {
          id,
          explicitId: true,
          kind,
          src: parsedSrc.src,
          inSec,
          outSec,
          at: op.clip.at ?? 0,
          speed: op.clip.speed ?? 1,
          volume: op.clip.muted ? 0 : (op.clip.volume ?? 1),
          muted: op.clip.muted ?? false,
          box: {
            ...(op.clip.left !== undefined ? { left: op.clip.left } : {}),
            ...(op.clip.top !== undefined ? { top: op.clip.top } : {}),
            ...(op.clip.width !== undefined ? { width: op.clip.width } : {}),
            ...(op.clip.height !== undefined ? { height: op.clip.height } : {}),
          },
          visualStyle: {},
          overrides: [],
          passthroughAttrs: {},
        };

        if (op.track === 'top') {
          next.tracks.unshift({ hidden: false, muted: false, locked: false, passthroughAttrs: {}, clips: [newClip] });
        } else if (op.track === 'new' || next.tracks.length === 0) {
          next.tracks.push({ hidden: false, muted: false, locked: false, passthroughAttrs: {}, clips: [newClip] });
        } else {
          const ti = op.track ?? 0;
          assertTrackMutable(next, ti, author);
          next.tracks[ti].clips.push(newClip);
        }
        trackAffected(newClip);
        changes.push(`add ${newClip.id} (${newClip.src}) at ${newClip.at}s`);
        break;
      }

      case 'remove': {
        const { trackIdx, clipIdx, clip } = locateClip(next, op.clip);
        assertTrackMutable(next, trackIdx, author);
        next.tracks[trackIdx].clips.splice(clipIdx, 1);
        affected.add(clip.id);
        changes.push(`remove ${clip.id}`);
        break;
      }

      case 'ripple': {
        const { trackIdx, clip } = locateClip(next, op.clip);
        assertTrackMutable(next, trackIdx, author);
        const dur = getClipTimelineDuration(clip, options.intrinsicDurationsSec);
        if (dur === undefined) {
          throw new Error(`ripple requires known duration on "${clip.id}"`);
        }
        const newDur = dur + op.by;
        if (newDur <= 0.01) {
          throw new Error(`ripple on "${clip.id}" would make duration <= 0.01s (${newDur})`);
        }
        const oldEnd = clip.at + dur;
        const srcEnd = clip.outSec ?? options.intrinsicDurationsSec?.get(clip.src) ?? clip.inSec + dur * clip.speed;
        clip.outSec = srcEnd + op.by * clip.speed;
        trackAffected(clip);

        for (const [ti, t] of next.tracks.entries()) {
          if (t.locked && author === 'agent') continue;
          for (const other of t.clips) {
            if (other.id === clip.id) continue;
            if (other.at >= oldEnd - 1e-3) {
              assertTrackMutable(next, ti, author);
              other.at = Math.max(0, other.at + op.by);
            }
          }
        }
        changes.push(`ripple ${clip.id} by ${op.by >= 0 ? '+' : ''}${op.by}s`);
        break;
      }

      case 'split': {
        const { trackIdx, clipIdx, clip } = locateClip(next, op.clip);
        assertTrackMutable(next, trackIdx, author);
        const dur = getClipTimelineDuration(clip, options.intrinsicDurationsSec);
        if (dur === undefined) {
          throw new Error(`split requires known duration on "${clip.id}"`);
        }
        const offsetTimeline = op.atFilmSec - clip.at;
        if (offsetTimeline <= 0.05 || offsetTimeline >= dur - 0.05) {
          throw new Error(
            `split at ${op.atFilmSec}s is outside interior of clip "${clip.id}" (${clip.at.toFixed(2)}..${(clip.at + dur).toFixed(2)}s)`,
          );
        }
        const splitSrc = clip.inSec + offsetTimeline * clip.speed;
        const origOut = clip.outSec ?? options.intrinsicDurationsSec?.get(clip.src) ?? clip.inSec + dur * clip.speed;
        clip.outSec = Number(splitSrc.toFixed(9));

        const existingIds = new Set(next.tracks.flatMap((t) => t.clips.map((c) => c.id)));
        let suffix = 2;
        let newId = `${clip.id}_${suffix}`;
        while (existingIds.has(newId)) {
          suffix += 1;
          newId = `${clip.id}_${suffix}`;
        }

        const rightClip: CompositionClip = structuredClone(clip);
        rightClip.id = newId;
        rightClip.explicitId = true;
        rightClip.at = Number(op.atFilmSec.toFixed(9));
        rightClip.inSec = Number(splitSrc.toFixed(9));
        rightClip.outSec = Number(origOut.toFixed(9));

        next.tracks[trackIdx].clips.splice(clipIdx + 1, 0, rightClip);
        affected.add(clip.id);
        affected.add(rightClip.id);
        focusTimeSec = op.atFilmSec;
        changes.push(`split ${clip.id} at ${op.atFilmSec.toFixed(2)}s -> ${clip.id} + ${rightClip.id}`);
        break;
      }

      case 'attr': {
        const { trackIdx, clip } = locateClip(next, op.clip);
        assertTrackMutable(next, trackIdx, author);
        if (!op.name.startsWith('data-') && !op.name.startsWith('aria-') && op.name !== 'title') {
          throw new Error(`attr op only supports data-*, aria-*, or title attributes (got "${op.name}")`);
        }
        if (op.value === null) {
          delete clip.passthroughAttrs[op.name];
        } else {
          clip.passthroughAttrs[op.name] = op.value;
        }
        trackAffected(clip);
        changes.push(`attr ${clip.id} ${op.name}=${op.value ?? 'removed'}`);
        break;
      }

      case 'track': {
        assertTrackMutable(next, op.from, author);
        if (op.remove) {
          if (next.tracks[op.from].clips.length > 0) {
            throw new Error(`Cannot remove non-empty track ${op.from}`);
          }
          next.tracks.splice(op.from, 1);
          changes.push(`track ${op.from} removed`);
          break;
        }
        const track = next.tracks[op.from];
        if (op.hidden !== undefined) track.hidden = op.hidden;
        if (op.muted !== undefined) track.muted = op.muted;
        if (op.locked !== undefined) track.locked = op.locked;
        if (op.to !== undefined && op.to !== op.from) {
          if (op.to >= next.tracks.length) throw new Error(`Target track index ${op.to} out of range`);
          const [moved] = next.tracks.splice(op.from, 1);
          next.tracks.splice(op.to, 0, moved);
          changes.push(`track ${op.from} -> ${op.to}`);
        } else {
          changes.push(`track ${op.from} flags updated`);
        }
        break;
      }
    }
  }

  validateComposition(next, options.intrinsicDurationsSec);
  return { nextDoc: next, changes, affectedClipIds: [...affected], focusTimeSec };
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const HISTORY_REL_PATH = join('.open-director', 'history.jsonl');

export function readEditHistory(projectDir: string): HistoryEntry[] {
  const file = join(projectDir, HISTORY_REL_PATH);
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as HistoryEntry);
}

/**
 * Commit an atomic batch of `EditOp`s to `composition.html` on disk and append an undoable entry to `.open-director/history.jsonl`.
 */
export function commitProjectEdit(
  projectDir: string,
  ops: EditOp[],
  options: {
    why: string;
    author?: 'human' | 'agent';
    intrinsicDurationsSec?: ReadonlyMap<string, number>;
  },
): { doc: CompositionDoc; entry: HistoryEntry } {
  const compPath = join(projectDir, 'composition.html');
  const beforeHtml = readFileSync(compPath, 'utf8');
  const doc = parseComposition(beforeHtml, options.intrinsicDurationsSec);
  const { nextDoc, changes, affectedClipIds, focusTimeSec } = applyEditOps(doc, ops, options);
  const afterHtml = serializeComposition(nextDoc);

  writeFileSync(compPath, afterHtml, 'utf8');

  const entry: HistoryEntry = {
    id: `edit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    author: options.author ?? 'human',
    why: options.why,
    ops,
    changes,
    affectedClipIds,
    focusTimeSec,
    beforeSha256: sha256(beforeHtml),
    afterSha256: sha256(afterHtml),
    beforeHtml,
  };

  const histPath = join(projectDir, HISTORY_REL_PATH);
  mkdirSync(join(projectDir, '.open-director'), { recursive: true });
  appendFileSync(histPath, `${JSON.stringify(entry)}\n`, 'utf8');

  return { doc: nextDoc, entry };
}

/**
 * Undo the most recent edit in `.open-director/history.jsonl`. Refuses if `composition.html` was modified externally unless `force: true`.
 */
export function undoProjectEdit(
  projectDir: string,
  options: { force?: boolean } = {},
): { undone: HistoryEntry; doc: CompositionDoc } {
  const entries = readEditHistory(projectDir);
  if (entries.length === 0) {
    throw new Error('No edits in history to undo');
  }

  const last = entries[entries.length - 1];
  const compPath = join(projectDir, 'composition.html');
  const currentHtml = readFileSync(compPath, 'utf8');
  const currentHash = sha256(currentHtml);

  if (!options.force && currentHash !== last.afterSha256) {
    throw new Error(
      'composition.html was modified externally since the last recorded edit; pass force: true to restore anyway',
    );
  }

  writeFileSync(compPath, last.beforeHtml, 'utf8');
  const remaining = entries.slice(0, -1);
  const histPath = join(projectDir, HISTORY_REL_PATH);
  writeFileSync(histPath, remaining.map((e) => JSON.stringify(e)).join('\n') + (remaining.length ? '\n' : ''), 'utf8');

  return { undone: last, doc: parseComposition(last.beforeHtml) };
}

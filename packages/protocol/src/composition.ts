import { basename, extname } from 'node:path';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import { parseOverrides, serializeOverrides, type ClipOverride } from './overrides.js';

type DocumentNode = DefaultTreeAdapterTypes.Document;
type ElementNode = DefaultTreeAdapterTypes.Element;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;

export type ClipKind = 'page' | 'video' | 'image' | 'audio';

export const ALLOWED_FPS_VALUES = new Set([23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120]);

const FORBIDDEN_LAYOUT_PROPS = new Set([
  'position',
  'transform',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'inset',
  'right',
  'bottom',
]);

const CLIP_TAG_TO_KIND: Record<string, ClipKind> = {
  iframe: 'page',
  video: 'video',
  img: 'image',
  audio: 'audio',
};

const KIND_TO_TAG: Record<ClipKind, string> = {
  page: 'iframe',
  video: 'video',
  image: 'img',
  audio: 'audio',
};

const PRESERVED_PASSTHROUGH_ATTRS = new Set(['alt', 'title', 'lang', 'dir']);

export interface ClipBox {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}

export interface CompositionClip {
  id: string;
  explicitId: boolean;
  kind: ClipKind;
  src: string;
  inSec: number;
  outSec?: number;
  at: number;
  speed: number;
  volume: number;
  muted: boolean;
  size?: { width: number; height: number };
  rotate?: number;
  className?: string;
  box: ClipBox;
  visualStyle: Record<string, string>;
  overrides: ClipOverride[];
  passthroughAttrs: Record<string, string>;
}

export interface CompositionTrack {
  id?: string;
  hidden: boolean;
  muted: boolean;
  locked: boolean;
  passthroughAttrs: Record<string, string>;
  clips: CompositionClip[];
}

export interface CompositionDoc {
  viewport: { width: number; height: number };
  fps: number | 'auto';
  styles: string[];
  extraHeadHtml: string[];
  tracks: CompositionTrack[];
}

export class CompositionSyntaxError extends Error {
  readonly line?: number;
  readonly col?: number;

  constructor(message: string, node?: ElementNode) {
    const loc = node?.sourceCodeLocation;
    const prefix = loc ? `line ${loc.startLine}:${loc.startCol}: ` : '';
    super(`${prefix}${message}`);
    this.name = 'CompositionSyntaxError';
    this.line = loc?.startLine;
    this.col = loc?.startCol;
  }
}

function getAttr(el: ElementNode, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

function hasAttr(el: ElementNode, name: string): boolean {
  return el.attrs.some((a) => a.name === name);
}

function isPassthroughAttr(name: string): boolean {
  return PRESERVED_PASSTHROUGH_ATTRS.has(name) || name.startsWith('data-') || name.startsWith('aria-');
}

function parseViewport(content: string | undefined, node?: ElementNode): { width: number; height: number } {
  if (!content) return { width: 1920, height: 1080 };
  const wMatch = content.match(/\bwidth\s*=\s*(\d+)/i);
  const hMatch = content.match(/\bheight\s*=\s*(\d+)/i);
  if (!wMatch || !hMatch) {
    throw new CompositionSyntaxError('Viewport meta must specify numeric width and height', node);
  }
  const width = Number(wMatch[1]);
  const height = Number(hMatch[1]);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new CompositionSyntaxError('Viewport width and height must be positive integers', node);
  }
  return { width, height };
}

function parseFpsMeta(content: string | undefined, node?: ElementNode): number | 'auto' {
  if (!content) return 30;
  const trimmed = content.trim();
  if (trimmed === 'auto') return 'auto';
  const n = Number(trimmed);
  if (!ALLOWED_FPS_VALUES.has(n)) {
    throw new CompositionSyntaxError(
      `Invalid film-fps "${content}". Allowed: ${[...ALLOWED_FPS_VALUES].join(', ')}, auto`,
      node,
    );
  }
  return n;
}

export function parseMediaSrc(rawSrc: string, node?: ElementNode): { src: string; inSec: number; outSec?: number } {
  const hashIdx = rawSrc.indexOf('#');
  if (hashIdx === -1) {
    return { src: rawSrc, inSec: 0 };
  }
  const src = rawSrc.slice(0, hashIdx);
  const fragment = rawSrc.slice(hashIdx + 1);
  if (!fragment.startsWith('t=')) {
    throw new CompositionSyntaxError(`Unsupported media fragment "#${fragment}"; expected "#t=in[,out]"`, node);
  }
  const [inRaw, outRaw, extra] = fragment.slice(2).split(',');
  if (extra !== undefined || inRaw === '') {
    throw new CompositionSyntaxError(`Malformed media fragment "#${fragment}"`, node);
  }
  const inSec = Number(inRaw);
  if (!Number.isFinite(inSec) || inSec < 0) {
    throw new CompositionSyntaxError(`Invalid fragment start time "${inRaw}"`, node);
  }
  if (outRaw === undefined || outRaw === '') {
    return { src, inSec };
  }
  const outSec = Number(outRaw);
  if (!Number.isFinite(outSec) || outSec <= inSec) {
    throw new CompositionSyntaxError(`Fragment end "${outRaw}" must be greater than start "${inRaw}"`, node);
  }
  return { src, inSec, outSec };
}

export function formatMediaSrc(src: string, inSec: number, outSec?: number): string {
  const fmt = (n: number) => Number(n.toFixed(9)).toString();
  if (outSec === undefined && inSec === 0) return src;
  if (outSec === undefined) return `${src}#t=${fmt(inSec)}`;
  return `${src}#t=${fmt(inSec)},${fmt(outSec)}`;
}

function parseStyleAttr(
  rawStyle: string | undefined,
  node?: ElementNode,
): { box: ClipBox; visualStyle: Record<string, string> } {
  const box: ClipBox = {};
  const visualStyle: Record<string, string> = {};
  if (!rawStyle || !rawStyle.trim()) return { box, visualStyle };

  const declarations = rawStyle
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean);

  for (const decl of declarations) {
    const colon = decl.indexOf(':');
    if (colon === -1) {
      throw new CompositionSyntaxError(`Invalid CSS declaration "${decl}"`, node);
    }
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const val = decl.slice(colon + 1).trim();
    if (FORBIDDEN_LAYOUT_PROPS.has(prop)) {
      throw new CompositionSyntaxError(
        `Clip style cannot set "${prop}"; host controls placement via left/top/width/height/rotate`,
        node,
      );
    }
    if (prop === 'left' || prop === 'top' || prop === 'width' || prop === 'height') {
      const m = val.match(/^(-?\d+(?:\.\d+)?)px$/i);
      if (!m) {
        throw new CompositionSyntaxError(`Clip "${prop}" must be in px (got "${val}")`, node);
      }
      box[prop] = Number(m[1]);
    } else {
      visualStyle[prop] = val;
    }
  }
  return { box, visualStyle };
}

function parseSizeAttr(raw: string | undefined, node?: ElementNode): { width: number; height: number } | undefined {
  if (!raw) return undefined;
  const m = raw.trim().match(/^(\d+)x(\d+)$/i);
  if (!m) {
    throw new CompositionSyntaxError(`Invalid size attribute "${raw}"; expected WxH`, node);
  }
  return { width: Number(m[1]), height: Number(m[2]) };
}

function parseFiniteNumber(raw: string | undefined, fallback: number, name: string, node?: ElementNode): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new CompositionSyntaxError(`Attribute "${name}" must be a finite number (got "${raw}")`, node);
  }
  return n;
}

function textContent(node: ElementNode): string {
  return node.childNodes
    .filter((c): c is DefaultTreeAdapterTypes.TextNode => c.nodeName === '#text')
    .map((c) => c.value)
    .join('');
}

function isElement(node: ChildNode): node is ElementNode {
  return 'tagName' in node;
}

function isIgnorableTextOrComment(node: ChildNode): boolean {
  if (node.nodeName === '#comment') return true;
  if (node.nodeName === '#text') {
    return !(node as DefaultTreeAdapterTypes.TextNode).value.trim();
  }
  return false;
}

const ALLOWED_CLIP_ATTRS = new Set(['id', 'src', 'at', 'speed', 'volume', 'muted', 'size', 'rotate', 'class', 'style', 'overrides']);
const ALLOWED_TRACK_ATTRS = new Set(['id', 'hidden', 'muted', 'locked']);

function parseClipElement(el: ElementNode): CompositionClip {
  const kind = CLIP_TAG_TO_KIND[el.tagName];
  if (!kind) {
    throw new CompositionSyntaxError(`Unexpected clip element <${el.tagName}>; expected iframe, video, img, or audio`, el);
  }
  if (el.childNodes.some((c) => !isIgnorableTextOrComment(c))) {
    throw new CompositionSyntaxError(`Clip <${el.tagName}> must not contain child elements or text`, el);
  }

  for (const attr of el.attrs) {
    if (!ALLOWED_CLIP_ATTRS.has(attr.name) && !isPassthroughAttr(attr.name)) {
      throw new CompositionSyntaxError(`Unknown attribute "${attr.name}" on <${el.tagName}>`, el);
    }
  }

  const rawSrc = getAttr(el, 'src');
  if (!rawSrc) {
    throw new CompositionSyntaxError(`<${el.tagName}> is missing required "src" attribute`, el);
  }
  const { src, inSec, outSec } = parseMediaSrc(rawSrc, el);
  if (kind === 'image' && outSec === undefined) {
    throw new CompositionSyntaxError(`<img> clip "${src}" requires explicit "#t=in,out" duration`, el);
  }

  const explicitIdAttr = getAttr(el, 'id');
  const derivedId = basename(src, extname(src)) || 'clip';
  const id = explicitIdAttr ?? derivedId;

  const at = parseFiniteNumber(getAttr(el, 'at'), 0, 'at', el);
  if (at < 0) {
    throw new CompositionSyntaxError(`Clip "${id}" has negative "at" (${at})`, el);
  }

  const speedAttr = getAttr(el, 'speed');
  if (speedAttr !== undefined && (kind === 'page' || kind === 'image')) {
    throw new CompositionSyntaxError(`"speed" is only valid on <video> and <audio> clips`, el);
  }
  const speed = parseFiniteNumber(speedAttr, 1, 'speed', el);
  if (speed < 0.25 || speed > 4) {
    throw new CompositionSyntaxError(`Clip "${id}" speed ${speed} out of range [0.25, 4]`, el);
  }

  const muted = hasAttr(el, 'muted');
  const volumeAttr = getAttr(el, 'volume');
  if ((muted || volumeAttr !== undefined) && (kind === 'page' || kind === 'image')) {
    throw new CompositionSyntaxError(`"volume" and "muted" are only valid on <video> and <audio> clips`, el);
  }
  const volume = muted ? 0 : parseFiniteNumber(volumeAttr, 1, 'volume', el);
  if (volume < 0) {
    throw new CompositionSyntaxError(`Clip "${id}" volume ${volume} must be >= 0`, el);
  }

  const sizeAttr = getAttr(el, 'size');
  if (sizeAttr !== undefined && kind !== 'page') {
    throw new CompositionSyntaxError(`"size" attribute is only valid on <iframe> page clips`, el);
  }
  const size = parseSizeAttr(sizeAttr, el);

  const rotateAttr = getAttr(el, 'rotate');
  const rotate = rotateAttr !== undefined ? parseFiniteNumber(rotateAttr, 0, 'rotate', el) : undefined;

  const { box, visualStyle } = parseStyleAttr(getAttr(el, 'style'), el);

  let overrides: ClipOverride[] = [];
  const rawOverrides = getAttr(el, 'overrides');
  if (rawOverrides !== undefined) {
    try {
      overrides = parseOverrides(rawOverrides);
    } catch (err) {
      throw new CompositionSyntaxError((err as Error).message, el);
    }
  }

  const passthroughAttrs: Record<string, string> = {};
  for (const attr of el.attrs) {
    if (isPassthroughAttr(attr.name)) {
      passthroughAttrs[attr.name] = attr.value;
    }
  }

  return {
    id,
    explicitId: explicitIdAttr !== undefined,
    kind,
    src,
    inSec,
    outSec,
    at,
    speed,
    volume,
    muted,
    size,
    rotate,
    className: getAttr(el, 'class'),
    box,
    visualStyle,
    overrides,
    passthroughAttrs,
  };
}

/**
 * Compute clip duration on the timeline when `#t=in,out` or an intrinsic asset duration is known.
 */
export function getClipTimelineDuration(
  clip: CompositionClip,
  intrinsicDurationsSec: ReadonlyMap<string, number> = new Map(),
): number | undefined {
  const sourceEnd = clip.outSec ?? intrinsicDurationsSec.get(clip.src);
  if (sourceEnd === undefined) return undefined;
  return Math.max(0, (sourceEnd - clip.inSec) / clip.speed);
}

/**
 * Validate clip uniqueness across the whole composition and non-overlap within each track.
 */
export function validateComposition(
  doc: CompositionDoc,
  intrinsicDurationsSec: ReadonlyMap<string, number> = new Map(),
): void {
  const seenIds = new Set<string>();
  for (const [trackIdx, track] of doc.tracks.entries()) {
    for (const clip of track.clips) {
      if (seenIds.has(clip.id)) {
        throw new CompositionSyntaxError(`Duplicate clip id "${clip.id}"`);
      }
      seenIds.add(clip.id);
    }

    const timed = track.clips
      .map((clip) => {
        const dur = getClipTimelineDuration(clip, intrinsicDurationsSec);
        return dur !== undefined ? { clip, start: clip.at, end: clip.at + dur } : null;
      })
      .filter((x): x is { clip: CompositionClip; start: number; end: number } => x !== null)
      .sort((a, b) => a.start - b.start);

    for (let i = 1; i < timed.length; i += 1) {
      const prev = timed[i - 1];
      const cur = timed[i];
      if (cur.start < prev.end - 1e-6) {
        throw new CompositionSyntaxError(
          `Clips "${prev.clip.id}" (${prev.start.toFixed(3)}..${prev.end.toFixed(3)}s) and "${cur.clip.id}" (${cur.start.toFixed(3)}..${cur.end.toFixed(3)}s) overlap on track ${trackIdx}`,
        );
      }
    }
  }
}

/**
 * Strictly parse a `composition.html` document into a structured `CompositionDoc`.
 */
export function parseComposition(
  html: string,
  intrinsicDurationsSec: ReadonlyMap<string, number> = new Map(),
): CompositionDoc {
  const tree: DocumentNode = parse(html, { sourceCodeLocationInfo: true });
  const htmlEl = tree.childNodes.find((n): n is ElementNode => isElement(n) && n.tagName === 'html');
  if (!htmlEl) {
    throw new CompositionSyntaxError('composition.html must contain an <html> root element');
  }

  const headEl = htmlEl.childNodes.find((n): n is ElementNode => isElement(n) && n.tagName === 'head');
  const bodyEl = htmlEl.childNodes.find((n): n is ElementNode => isElement(n) && n.tagName === 'body');
  if (!bodyEl) {
    throw new CompositionSyntaxError('composition.html must contain a <body> element');
  }

  let viewport = { width: 1920, height: 1080 };
  let fps: number | 'auto' = 30;
  const styles: string[] = [];
  const extraHeadHtml: string[] = [];

  if (headEl) {
    for (const node of headEl.childNodes) {
      if (isIgnorableTextOrComment(node)) continue;
      if (!isElement(node)) continue;
      if (node.tagName === 'meta') {
        const name = getAttr(node, 'name')?.toLowerCase();
        if (name === 'viewport') {
          viewport = parseViewport(getAttr(node, 'content'), node);
          continue;
        }
        if (name === 'film-fps') {
          fps = parseFpsMeta(getAttr(node, 'content'), node);
          continue;
        }
        if (hasAttr(node, 'charset')) continue;
      }
      if (node.tagName === 'style') {
        styles.push(textContent(node));
        continue;
      }
      if (node.tagName === 'script') {
        throw new CompositionSyntaxError('<script> is not allowed in composition.html head; motion lives in pages', node);
      }
      if (node.tagName === 'link' || node.tagName === 'title') {
        const attrs = node.attrs.map((a) => `${a.name}="${escapeAttr(a.value)}"`).join(' ');
        if (node.tagName === 'link') {
          extraHeadHtml.push(`<link ${attrs}>`);
        } else {
          extraHeadHtml.push(`<title>${escapeHtml(textContent(node))}</title>`);
        }
        continue;
      }
      throw new CompositionSyntaxError(`Unexpected element <${node.tagName}> in <head>`, node);
    }
  }

  const tracks: CompositionTrack[] = [];
  for (const node of bodyEl.childNodes) {
    if (isIgnorableTextOrComment(node)) continue;
    if (!isElement(node) || node.tagName !== 'section') {
      const el = isElement(node) ? node : undefined;
      throw new CompositionSyntaxError(
        `Only <section> track elements are allowed inside <body> (found ${el ? `<${el.tagName}>` : node.nodeName})`,
        el,
      );
    }
    for (const attr of node.attrs) {
      if (!ALLOWED_TRACK_ATTRS.has(attr.name) && !isPassthroughAttr(attr.name)) {
        throw new CompositionSyntaxError(`Unknown attribute "${attr.name}" on <section>`, node);
      }
    }
    const passthroughAttrs: Record<string, string> = {};
    for (const attr of node.attrs) {
      if (isPassthroughAttr(attr.name)) passthroughAttrs[attr.name] = attr.value;
    }

    const clips: CompositionClip[] = [];
    for (const child of node.childNodes) {
      if (isIgnorableTextOrComment(child)) continue;
      if (!isElement(child)) {
        throw new CompositionSyntaxError('Unexpected non-element node inside <section>', node);
      }
      clips.push(parseClipElement(child));
    }

    tracks.push({
      id: getAttr(node, 'id'),
      hidden: hasAttr(node, 'hidden'),
      muted: hasAttr(node, 'muted'),
      locked: hasAttr(node, 'locked'),
      passthroughAttrs,
      clips,
    });
  }

  const doc: CompositionDoc = { viewport, fps, styles, extraHeadHtml, tracks };
  validateComposition(doc, intrinsicDurationsSec);
  return doc;
}

function escapeAttr(val: string): string {
  return val
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttrSingleFriendly(val: string): string {
  return val.replace(/'/g, '&#39;');
}

function escapeHtml(val: string): string {
  return val.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatNum(n: number): string {
  return Number(n.toFixed(9)).toString();
}

function buildClipStyleString(clip: CompositionClip): string | undefined {
  const parts: string[] = [];
  for (const key of ['left', 'top', 'width', 'height'] as const) {
    const val = clip.box[key];
    if (val !== undefined) parts.push(`${key}: ${formatNum(val)}px`);
  }
  for (const [prop, val] of Object.entries(clip.visualStyle)) {
    parts.push(`${prop}: ${val}`);
  }
  return parts.length > 0 ? parts.join('; ') : undefined;
}

function serializeClip(clip: CompositionClip): string {
  const tag = KIND_TO_TAG[clip.kind];
  const attrs: string[] = [];
  attrs.push(`id="${escapeAttr(clip.id)}"`);
  attrs.push(`src="${escapeAttr(formatMediaSrc(clip.src, clip.inSec, clip.outSec))}"`);
  if (clip.at !== 0) attrs.push(`at="${formatNum(clip.at)}"`);
  if (clip.speed !== 1) attrs.push(`speed="${formatNum(clip.speed)}"`);
  if (clip.muted) {
    attrs.push('muted');
  } else if (clip.volume !== 1) {
    attrs.push(`volume="${formatNum(clip.volume)}"`);
  }
  if (clip.size) attrs.push(`size="${clip.size.width}x${clip.size.height}"`);
  if (clip.rotate !== undefined && clip.rotate !== 0) attrs.push(`rotate="${formatNum(clip.rotate)}"`);
  if (clip.className) attrs.push(`class="${escapeAttr(clip.className)}"`);
  const styleStr = buildClipStyleString(clip);
  if (styleStr) attrs.push(`style="${escapeAttr(styleStr)}"`);
  const overridesStr = serializeOverrides(clip.overrides);
  if (overridesStr) attrs.push(`overrides='${escapeAttrSingleFriendly(overridesStr)}'`);
  for (const [k, v] of Object.entries(clip.passthroughAttrs)) {
    attrs.push(`${k}="${escapeAttr(v)}"`);
  }

  if (tag === 'img') {
    return `    <img ${attrs.join(' ')}>`;
  }
  return `    <${tag} ${attrs.join(' ')}></${tag}>`;
}

/**
 * Serialize a `CompositionDoc` back into deterministic `composition.html`.
 */
export function serializeComposition(doc: CompositionDoc): string {
  const lines: string[] = [
    '<!doctype html>',
    '<html>',
    '<head>',
    '  <meta charset="utf-8">',
    `  <meta name="viewport" content="width=${doc.viewport.width}, height=${doc.viewport.height}">`,
    `  <meta name="film-fps" content="${doc.fps}">`,
  ];

  for (const extra of doc.extraHeadHtml) {
    lines.push(`  ${extra}`);
  }
  for (const css of doc.styles) {
    lines.push('  <style>');
    for (const l of css.trim().split('\n')) {
      lines.push(`  ${l}`);
    }
    lines.push('  </style>');
  }

  lines.push('</head>');
  lines.push('<body>');

  for (const track of doc.tracks) {
    const tAttrs: string[] = [];
    if (track.id) tAttrs.push(`id="${escapeAttr(track.id)}"`);
    if (track.hidden) tAttrs.push('hidden');
    if (track.muted) tAttrs.push('muted');
    if (track.locked) tAttrs.push('locked');
    for (const [k, v] of Object.entries(track.passthroughAttrs)) {
      tAttrs.push(`${k}="${escapeAttr(v)}"`);
    }
    lines.push(`  <section${tAttrs.length > 0 ? ' ' + tAttrs.join(' ') : ''}>`);
    for (const clip of track.clips) {
      lines.push(serializeClip(clip));
    }
    lines.push('  </section>');
  }

  lines.push('</body>');
  lines.push('</html>');
  return `${lines.join('\n')}\n`;
}

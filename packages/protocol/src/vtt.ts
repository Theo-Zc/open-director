export interface VttWord {
  text: string;
  at: number;
}

export interface VttCue {
  id?: string;
  startSec: number;
  endSec: number;
  voice?: string;
  rawText: string;
  plainText: string;
  words: VttWord[];
}

export interface ParsedVtt {
  handCut: boolean;
  cues: VttCue[];
}

export interface MappedSubtitleCue {
  clipId: string;
  startSec: number;
  endSec: number;
  voice?: string;
  text: string;
}

const HAND_CUT_MARKER = 'NOTE Each cue is one subtitle';

export function parseVttTimestamp(ts: string): number {
  const cleaned = ts.trim();
  const parts = cleaned.split(':');
  if (parts.length === 2) {
    const [m, s] = parts;
    return Number(m) * 60 + Number(s);
  }
  if (parts.length === 3) {
    const [h, m, s] = parts;
    return Number(h) * 3600 + Number(m) * 60 + Number(s);
  }
  throw new Error(`Invalid WebVTT timestamp: "${ts}"`);
}

function stripTagsAndCollectWords(rawText: string, cueStartSec: number): {
  voice?: string;
  plainText: string;
  words: VttWord[];
} {
  let voice: string | undefined;
  const voiceMatch = rawText.match(/<v\s+([^>]+)>/i);
  if (voiceMatch) {
    voice = voiceMatch[1].trim();
  }

  const words: VttWord[] = [];
  let currentAt = cueStartSec;
  const tokenRegex = /<(\d{2}:(?:\d{2}:)?\d{2}\.\d{3})>|<\/?[^>]+>|([^<]+)/g;
  let plainParts: string[] = [];

  for (const match of rawText.matchAll(tokenRegex)) {
    if (match[1]) {
      currentAt = parseVttTimestamp(match[1]);
    } else if (match[2]) {
      const segment = match[2];
      plainParts.push(segment);
      const trimmed = segment.trim();
      if (trimmed) {
        words.push({ text: trimmed, at: currentAt });
      }
    }
  }

  const plainText = plainParts
    .join('')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { voice, plainText, words };
}

/**
 * Parse a WebVTT subtitle file, preserving inline timestamp word timings and `<v>` voice tags.
 */
export function parseVtt(content: string): ParsedVtt {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const handCut = normalized.includes(HAND_CUT_MARKER);
  const blocks = normalized.split(/\n{2,}/);
  const cues: VttCue[] = [];

  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trimEnd());
    if (lines.length === 0) continue;
    const first = lines[0].trim();
    if (!first || first.startsWith('WEBVTT') || first.startsWith('NOTE') || first.startsWith('STYLE')) {
      continue;
    }

    let timingLineIdx = lines.findIndex((l) => l.includes('-->'));
    if (timingLineIdx === -1) continue;

    const id = timingLineIdx > 0 ? lines[timingLineIdx - 1].trim() || undefined : undefined;
    const timingLine = lines[timingLineIdx].trim();
    const [startRaw, restRaw] = timingLine.split('-->');
    if (!startRaw || !restRaw) continue;
    const endRaw = restRaw.trim().split(/\s+/)[0];

    const startSec = parseVttTimestamp(startRaw);
    const endSec = parseVttTimestamp(endRaw);
    const rawText = lines.slice(timingLineIdx + 1).join('\n').trim();
    const { voice, plainText, words } = stripTagsAndCollectWords(rawText, startSec);

    cues.push({
      id,
      startSec,
      endSec,
      voice,
      rawText,
      plainText,
      words,
    });
  }

  return { handCut, cues };
}

/**
 * Map a source media VTT file onto the film timeline using the clip's `at`, `#t=in,out`, and `speed`.
 */
export function mapVttToClip(
  vtt: ParsedVtt,
  clip: { id: string; at: number; inSec: number; outSec?: number; speed: number },
): MappedSubtitleCue[] {
  const outLimit = clip.outSec ?? Infinity;
  const speed = clip.speed || 1;
  const mapped: MappedSubtitleCue[] = [];

  for (const cue of vtt.cues) {
    const clampedStart = Math.max(cue.startSec, clip.inSec);
    const clampedEnd = Math.min(cue.endSec, outLimit);
    if (clampedEnd <= clampedStart) continue;

    mapped.push({
      clipId: clip.id,
      startSec: clip.at + (clampedStart - clip.inSec) / speed,
      endSec: clip.at + (clampedEnd - clip.inSec) / speed,
      voice: cue.voice,
      text: cue.plainText,
    });
  }

  return mapped;
}

function formatSrtTimestamp(sec: number): string {
  const clamped = Math.max(0, sec);
  const msTotal = Math.round(clamped * 1000);
  const ms = msTotal % 1000;
  const secTotal = Math.floor(msTotal / 1000);
  const s = secTotal % 60;
  const minTotal = Math.floor(secTotal / 60);
  const m = minTotal % 60;
  const h = Math.floor(minTotal / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function formatVttTimestamp(sec: number): string {
  return formatSrtTimestamp(sec).replace(',', '.');
}

/**
 * Format mapped timeline subtitle cues as a standard `.srt` file.
 */
export function formatCombinedSrt(cues: MappedSubtitleCue[]): string {
  const sorted = [...cues].sort((a, b) => a.startSec - b.startSec);
  return sorted
    .map(
      (c, idx) =>
        `${idx + 1}\n${formatSrtTimestamp(c.startSec)} --> ${formatSrtTimestamp(c.endSec)}\n${c.text}`,
    )
    .join('\n\n')
    .concat(sorted.length > 0 ? '\n' : '');
}

/**
 * Format mapped timeline subtitle cues as a combined WebVTT file.
 */
export function formatCombinedVtt(cues: MappedSubtitleCue[]): string {
  const sorted = [...cues].sort((a, b) => a.startSec - b.startSec);
  const body = sorted
    .map((c) => {
      const voicePrefix = c.voice ? `<v ${c.voice}>` : '';
      return `${formatVttTimestamp(c.startSec)} --> ${formatVttTimestamp(c.endSec)}\n${voicePrefix}${c.text}`;
    })
    .join('\n\n');
  return `WEBVTT\n\n${body}${body ? '\n' : ''}`;
}

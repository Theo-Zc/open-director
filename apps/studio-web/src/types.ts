export type ClipKind = 'page' | 'video' | 'image' | 'audio';

export type ParamDecl =
  | { type: 'color'; default: string; label?: string; group?: string; hint?: string }
  | { type: 'number'; default: number; min?: number; max?: number; step?: number; unit?: string; label?: string; group?: string; hint?: string }
  | { type: 'text'; default: string; maxLength?: number; multiline?: boolean; label?: string; group?: string; hint?: string }
  | { type: 'toggle'; default: boolean; label?: string; group?: string; hint?: string };

export type ClipOverride =
  | { fade: [number, number] }
  | { at: string; n?: number; t?: [number, number]; s?: number | [number, number]; r?: number; style?: Record<string, string>; text?: string; lock?: boolean };

export interface CompositionClip {
  id: string;
  kind: ClipKind;
  src: string;
  inSec: number;
  outSec?: number;
  at: number;
  speed: number;
  volume: number;
  muted: boolean;
  rotate?: number;
  box: { left?: number; top?: number; width?: number; height?: number };
  visualStyle: Record<string, string>;
  overrides: ClipOverride[];
  passthroughAttrs?: Record<string, string>;
}

export interface CompositionTrack {
  id?: string;
  hidden: boolean;
  muted: boolean;
  locked: boolean;
  clips: CompositionClip[];
}

export interface CompositionDoc {
  viewport: { width: number; height: number };
  fps: number | 'auto';
  tracks: CompositionTrack[];
}

export interface MediaInfo {
  durationSec: number;
  width?: number;
  height?: number;
  fps?: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

export interface HistoryItem {
  id: string;
  timestamp: string;
  author: 'human' | 'agent';
  why: string;
  changes: string[];
  affectedClipIds?: string[];
  focusTimeSec?: number;
  diffLines?: string[];
}

export interface SubtitleCue {
  clipId: string;
  startSec: number;
  endSec: number;
  voice?: string;
  text: string;
}

export interface ProjectAssetItem {
  relPath: string;
  kind: 'image' | 'video' | 'audio' | 'page';
  bytes: number;
  durationSec?: number;
}

export interface PageSfxDecl {
  at: number;
  id?: string;
  src?: string;
  gain?: number;
  pan?: number;
  label?: string;
}

export interface ProjectSnapshot {
  projectDir: string;
  filmOrigin: string;
  manifest: {
    kind: 'project' | 'template';
    manifest: {
      project?: { id: string; name: string; revision: number };
      template?: { id: string; name: string; version: string };
    };
  };
  doc: CompositionDoc;
  durationSec: number;
  report: {
    valid: boolean;
    fps?: number;
    errors: string[];
    warnings: string[];
  };
  mediaInfo: Record<string, MediaInfo>;
  pageMeta: Record<string, { duration?: number; params: Record<string, ParamDecl>; sfx?: PageSfxDecl[] }>;
  history: HistoryItem[];
  cues: Record<string, { name: string; filmSec?: number; status: string; reason?: string }>;
  subtitles: SubtitleCue[];
  assets: ProjectAssetItem[];
}

export interface TemplateSummary {
  id: string;
  dir: string;
  name: string;
  version: string;
  description?: string;
  width: number;
  height: number;
  fps: number;
  entry: string;
  guide?: {
    purpose?: string;
    firstReply?: string;
    fit?: { goodFor?: string[]; notFor?: string[] };
  };
}

export interface AuditReport {
  samples: Array<{ timeSec: number; clipId: string; hint: string }>;
  overflows: Array<{ timeSec: number; clipId: string; text: string }>;
  missingAssets: string[];
  audioLoudness: Array<{ clipId: string; src: string; measuredLufs: number; measuredTruePeakDbtp: number; measuredLra: number }>;
  errors: string[];
}

export interface LookFrameResult {
  timeSec: number;
  warnings: { samples: Array<{ clipId: string; hint: string }>; overflows: Array<{ clipId: string; text: string }> };
  errors: string[];
  dataUrl: string;
}

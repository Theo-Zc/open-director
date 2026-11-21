import type { AuditReport, LookFrameResult, ProjectSnapshot, TemplateSummary } from './types';

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data as T;
}

export function fetchProject(): Promise<ProjectSnapshot> {
  return requestJson<ProjectSnapshot>('/api/project');
}

export function fetchTemplates(): Promise<{ templates: TemplateSummary[] }> {
  return requestJson('/api/templates');
}

export function instantiateTemplateApi(templateId: string, projectName?: string): Promise<{ ok: true; snapshot: ProjectSnapshot }> {
  return requestJson('/api/templates/instantiate', {
    method: 'POST',
    body: JSON.stringify({ templateId, projectName }),
  });
}

export function uploadAssetFile(
  filename: string,
  base64: string,
  folder: 'assets' | 'scenes' = 'assets',
): Promise<{ ok: true; relPath: string; snapshot: ProjectSnapshot }> {
  return requestJson('/api/assets/upload', {
    method: 'POST',
    body: JSON.stringify({ filename, base64, folder }),
  });
}

export function submitEdit(
  ops: Array<Record<string, unknown>>,
  why: string,
  author: 'human' | 'agent' = 'human',
): Promise<{ ok: true; snapshot: ProjectSnapshot }> {
  return requestJson('/api/edit', {
    method: 'POST',
    body: JSON.stringify({ ops, why, author }),
  });
}

export function submitUndo(): Promise<{ ok: true; snapshot: ProjectSnapshot }> {
  return requestJson('/api/undo', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function requestLook(times: number[]): Promise<{ frames: LookFrameResult[] }> {
  return requestJson('/api/look', {
    method: 'POST',
    body: JSON.stringify({ times, scale: 0.5 }),
  });
}

export function runAudit(): Promise<AuditReport> {
  return requestJson('/api/audit');
}

export function matchLoudnessApi(apply = true): Promise<{
  plans: Array<{ trackIndex: number; role: string; targetLufs: number; measuredLufs: number; gainDb: number }>;
  snapshot?: ProjectSnapshot;
}> {
  return requestJson('/api/audio/match-loudness', {
    method: 'POST',
    body: JSON.stringify({ apply }),
  });
}

export function analyzeBeatsApi(src: string): Promise<{ ok: true; beats: { bpm: number; beats: number[] }; snapshot: ProjectSnapshot }> {
  return requestJson('/api/audio/analyze-beats', {
    method: 'POST',
    body: JSON.stringify({ src }),
  });
}

export function sendAgentChat(payload: {
  prompt: string;
  currentTime: number;
  apiBase?: string;
  apiKey?: string;
  model?: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}): Promise<{
  reply: string;
  toolTrace: Array<{ tool: string; args: Record<string, unknown>; resultSummary: string }>;
  changed: boolean;
  snapshot: ProjectSnapshot;
}> {
  return requestJson('/api/agent/chat', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function startExport(filename = 'output.mp4'): Promise<{ started: boolean; outPath: string }> {
  return requestJson('/api/export', {
    method: 'POST',
    body: JSON.stringify({ filename }),
  });
}

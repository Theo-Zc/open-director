import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import {
  EDIT_OP_SCHEMA,
  commitProjectEdit,
  exportFcpxml,
  formatCombinedSrt,
  formatCombinedVtt,
  mapVttToClip,
  parseComposition,
  parseCuesFile,
  parseMotionManifest,
  parseVtt,
  readEditHistory,
  resolveCues,
  undoProjectEdit,
  type BeatsFile,
  type EditOp,
  type MappedSubtitleCue,
  type ParamDecl,
  type ParsedVtt,
} from '@open-director/protocol';
import {
  BUILTIN_SFX_CATALOG,
  auditProject,
  buildStageHtml,
  captureProjectFrames,
  computeCompositionDuration,
  discoverTemplates,
  exportProjectVideo,
  extractBeatOnsets,
  instantiateTemplate,
  measureAudioLoudness,
  probeMedia,
  probeProjectMedia,
  readPageMetadata,
  resolveOutputFps,
  startProjectServer,
  validateProject,
  type ProjectServer,
} from '@open-director/engine';
import { runAgentConversation } from './agent-loop.js';

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

const EDIT_BODY_SCHEMA = z.object({
  why: z.string().min(1),
  author: z.enum(['human', 'agent']).optional(),
  ops: z.array(EDIT_OP_SCHEMA).min(1),
});

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolveBody(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(payload));
}

function computeSimpleLineDiff(beforeHtml: string, afterHtml: string): string[] {
  const before = beforeHtml.split('\n');
  const after = afterHtml.split('\n');
  const out: string[] = [];
  const max = Math.max(before.length, after.length);
  for (let i = 0; i < max; i += 1) {
    const b = before[i];
    const a = after[i];
    if (b === a) continue;
    if (b !== undefined) out.push(`- ${b.trimEnd()}`);
    if (a !== undefined) out.push(`+ ${a.trimEnd()}`);
  }
  return out.slice(0, 40);
}

async function listProjectAssets(projectDir: string) {
  const items: Array<{ relPath: string; kind: 'image' | 'video' | 'audio' | 'page'; bytes: number; durationSec?: number }> = [];
  for (const folder of ['assets', 'scenes']) {
    const dir = join(projectDir, folder);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (!statSync(full).isFile()) continue;
      const ext = extname(name).toLowerCase();
      if (ext === '.vtt' || name.endsWith('.beats.json')) continue;
      const relPath = `${folder}/${name}`;
      const bytes = statSync(full).size;
      if (ext === '.html' || ext === '.htm') {
        items.push({ relPath, kind: 'page', bytes });
      } else if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(ext)) {
        items.push({ relPath, kind: 'image', bytes });
      } else if (['.mp4', '.mov', '.webm', '.mkv'].includes(ext)) {
        const info = await probeMedia(full).catch(() => null);
        items.push({ relPath, kind: 'video', bytes, durationSec: info?.durationSec });
      } else if (['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'].includes(ext)) {
        const info = await probeMedia(full).catch(() => null);
        items.push({ relPath, kind: 'audio', bytes, durationSec: info?.durationSec });
      }
    }
  }
  return items;
}

async function buildProjectSnapshot(projectDir: string, filmOrigin: string) {
  const manifestRaw = readFileSync(join(projectDir, 'motion.json'), 'utf8');
  const manifest = parseMotionManifest(manifestRaw);
  const compHtml = readFileSync(join(projectDir, 'composition.html'), 'utf8');
  const doc = parseComposition(compHtml);
  const mediaMap = await probeProjectMedia(projectDir, doc);
  const report = await validateProject(projectDir);

  const mediaInfo: Record<string, unknown> = {};
  const intrinsic = new Map<string, number>();
  for (const [k, v] of mediaMap.entries()) {
    mediaInfo[k] = v;
    intrinsic.set(k, v.durationSec);
  }

  const pageMeta: Record<string, { duration?: number; params: Record<string, ParamDecl>; sfx: unknown[] }> = {};
  const pageDurations = new Map<string, number>();
  const subtitles: MappedSubtitleCue[] = [];
  const vttBySource = new Map<string, ParsedVtt>();
  const beatsBySource = new Map<string, BeatsFile>();

  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (clip.kind === 'page' && !pageMeta[clip.src] && existsSync(join(projectDir, clip.src))) {
        try {
          const meta = await readPageMetadata(projectDir, clip.src);
          pageMeta[clip.src] = { duration: meta.duration, params: meta.params, sfx: meta.sfx };
          if (meta.duration !== undefined) pageDurations.set(clip.src, meta.duration);
        } catch {
          pageMeta[clip.src] = { params: {}, sfx: [] };
        }
      }
      if (clip.kind === 'audio' || clip.kind === 'video') {
        const vttPath = join(projectDir, clip.src.replace(/\.[^.]+$/, '.vtt'));
        if (existsSync(vttPath)) {
          try {
            const parsedVtt = parseVtt(readFileSync(vttPath, 'utf8'));
            vttBySource.set(clip.src, parsedVtt);
            if (!track.hidden && !track.muted && !clip.muted) {
              subtitles.push(...mapVttToClip(parsedVtt, clip));
            }
          } catch {}
        }
        const beatsPath = join(projectDir, `${clip.src}.beats.json`);
        if (existsSync(beatsPath) && !beatsBySource.has(clip.src)) {
          try {
            beatsBySource.set(clip.src, JSON.parse(readFileSync(beatsPath, 'utf8')) as BeatsFile);
          } catch {}
        }
      }
    }
  }

  let cues: Record<string, unknown> = {};
  const cuesPath = join(projectDir, 'cues.json');
  if (existsSync(cuesPath)) {
    try {
      const cuesFile = parseCuesFile(readFileSync(cuesPath, 'utf8'));
      cues = resolveCues(cuesFile, doc, vttBySource, intrinsic, beatsBySource);
    } catch {}
  }

  const rawHistory = readEditHistory(projectDir);
  const history = rawHistory.map((item, idx) => {
    const nextHtml = idx + 1 < rawHistory.length ? rawHistory[idx + 1].beforeHtml : compHtml;
    return {
      id: item.id,
      timestamp: item.timestamp,
      author: item.author,
      why: item.why,
      changes: item.changes,
      affectedClipIds: item.affectedClipIds ?? [],
      focusTimeSec: item.focusTimeSec,
      diffLines: computeSimpleLineDiff(item.beforeHtml, nextHtml),
    };
  });

  return {
    projectDir,
    filmOrigin,
    manifest,
    doc,
    durationSec: computeCompositionDuration(doc, mediaMap, pageDurations),
    report,
    mediaInfo,
    pageMeta,
    history,
    cues,
    subtitles: subtitles.sort((a, b) => a.startSec - b.startSec),
    assets: await listProjectAssets(projectDir),
  };
}

export interface StudioServerHandle {
  origin: string;
  filmOrigin: string;
  close(): Promise<void>;
}

export async function startStudioServer(options: {
  projectDir: string;
  port?: number;
  webDistDir?: string;
  analyzerUrl?: string;
  templatesRoot?: string;
}): Promise<StudioServerHandle> {
  let activeProjectDir = resolve(options.projectDir);
  const analyzerUrl = options.analyzerUrl ?? process.env.OPEN_DIRECTOR_ANALYZER_URL ?? 'http://127.0.0.1:8765';
  const templatesRoot =
    options.templatesRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../templates');

  const createFilmServerFor = (dir: string): Promise<ProjectServer> =>
    startProjectServer(dir, {
      stageHtmlProvider: async () => {
        const doc = parseComposition(readFileSync(join(dir, 'composition.html'), 'utf8'));
        const media = await probeProjectMedia(dir, doc);
        const totalDur = computeCompositionDuration(doc, media);
        return buildStageHtml(doc, media, totalDur);
      },
    });

  let filmServer = await createFilmServerFor(activeProjectDir);

  const switchProject = async (nextDir: string) => {
    const resolved = resolve(nextDir);
    const rep = await validateProject(resolved);
    if (!rep.valid) {
      throw new Error(`Invalid project "${resolved}": ${rep.errors.join('; ')}`);
    }
    const prev = filmServer;
    activeProjectDir = resolved;
    filmServer = await createFilmServerFor(activeProjectDir);
    await prev.close();
  };

  const sockets = new Set<WebSocket>();
  const broadcast = (event: Record<string, unknown>) => {
    const payload = JSON.stringify(event);
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  };

  let exporting = false;

  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
      }

      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      if (req.method === 'GET' && url.pathname === '/api/health') {
        sendJson(res, 200, { ok: true, projectDir: activeProjectDir, filmOrigin: filmServer.origin });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/project') {
        sendJson(res, 200, await buildProjectSnapshot(activeProjectDir, filmServer.origin));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/templates') {
        sendJson(res, 200, { templates: discoverTemplates(templatesRoot) });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/templates/instantiate') {
        const body = z
          .object({
            templateId: z.string().min(1),
            targetDir: z.string().optional(),
            projectName: z.string().optional(),
            params: z.record(z.unknown()).optional(),
          })
          .parse(await readJsonBody(req));
        const tpl = discoverTemplates(templatesRoot).find((t) => t.id === body.templateId);
        if (!tpl) {
          sendJson(res, 404, { error: `Template "${body.templateId}" not found` });
          return;
        }
        const defaultWorkspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../workspaces');
        const destDir = body.targetDir
          ? resolve(body.targetDir)
          : join(defaultWorkspaceRoot, `${tpl.id}-${Date.now()}`);
        instantiateTemplate(tpl.dir, destDir, { projectName: body.projectName, params: body.params });
        await switchProject(destDir);
        const snapshot = await buildProjectSnapshot(activeProjectDir, filmServer.origin);
        broadcast({ type: 'project-switched', projectDir: activeProjectDir });
        sendJson(res, 200, { ok: true, snapshot });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/projects/open') {
        const body = z.object({ projectDir: z.string().min(1) }).parse(await readJsonBody(req));
        await switchProject(body.projectDir);
        const snapshot = await buildProjectSnapshot(activeProjectDir, filmServer.origin);
        broadcast({ type: 'project-switched', projectDir: activeProjectDir });
        sendJson(res, 200, { ok: true, snapshot });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/assets/upload') {
        const body = z
          .object({
            filename: z.string().min(1),
            base64: z.string().min(1),
            folder: z.enum(['assets', 'scenes']).default('assets'),
          })
          .parse(await readJsonBody(req));
        const safeName = basename(body.filename).replace(/[^a-zA-Z0-9._\u4e00-\u9fff-]/g, '_');
        const destDir = join(activeProjectDir, body.folder);
        mkdirSync(destDir, { recursive: true });
        const full = resolve(destDir, safeName);
        if (relative(activeProjectDir, full).startsWith('..') || relative(activeProjectDir, full).includes(`..${sep}`)) {
          throw new Error('Invalid upload path');
        }
        const rawB64 = body.base64.includes(',') ? body.base64.split(',')[1] : body.base64;
        writeFileSync(full, Buffer.from(rawB64, 'base64'));
        const snapshot = await buildProjectSnapshot(activeProjectDir, filmServer.origin);
        sendJson(res, 200, { ok: true, relPath: `${body.folder}/${safeName}`, snapshot });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/sfx') {
        const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
        const items = q
          ? BUILTIN_SFX_CATALOG.filter(
              (s) => s.id.includes(q) || s.title.toLowerCase().includes(q) || s.tags.some((t) => t.toLowerCase().includes(q)),
            )
          : BUILTIN_SFX_CATALOG;
        sendJson(res, 200, { items });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/audit') {
        sendJson(res, 200, await auditProject(activeProjectDir));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/audio/match-loudness') {
        const body = (await readJsonBody(req)) as { apply?: boolean };
        const doc = parseComposition(readFileSync(join(activeProjectDir, 'composition.html'), 'utf8'));
        const media = await probeProjectMedia(activeProjectDir, doc);
        const tracksInput: Array<{
          trackIndex: number;
          clipId: string;
          role: string;
          currentVolume: number;
          measuredLufs: number;
          measuredTruePeakDbtp: number;
          measuredLra: number;
        }> = [];

        for (let ti = 0; ti < doc.tracks.length; ti += 1) {
          const track = doc.tracks[ti];
          if (track.hidden || track.muted) continue;
          for (const clip of track.clips) {
            if ((clip.kind !== 'audio' && clip.kind !== 'video') || clip.muted) continue;
            if (!media.get(clip.src)?.hasAudio) continue;
            const m = await measureAudioLoudness(join(activeProjectDir, clip.src), {
              inSec: clip.inSec,
              outSec: clip.outSec,
            });
            const role = clip.passthroughAttrs['data-adudir-duck']
              ? 'bgm'
              : existsSync(join(activeProjectDir, clip.src.replace(/\.[^.]+$/, '.vtt')))
                ? 'dialogue'
                : 'default';
            tracksInput.push({
              trackIndex: ti,
              clipId: clip.id,
              role,
              currentVolume: clip.volume,
              measuredLufs: m.measuredLufs,
              measuredTruePeakDbtp: m.measuredTruePeakDbtp,
              measuredLra: m.measuredLra,
            });
          }
        }

        let plans: Array<{ trackIndex: number; role: string; targetLufs: number; measuredLufs: number; gainDb: number; needsLimiting: boolean }> = [];
        try {
          const up = await fetch(`${analyzerUrl}/v1/audio/loudness-plan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tracks: tracksInput }),
          });
          if (up.ok) {
            plans = ((await up.json()) as { plans: typeof plans }).plans;
          }
        } catch {}

        if (plans.length === 0) {
          const targets: Record<string, number> = { dialogue: -18, dub: -16, bgm: -23, default: -18 };
          plans = tracksInput.map((t) => {
            const targetLufs = targets[t.role] ?? -18;
            const gainDb = targetLufs - t.measuredLufs;
            return {
              trackIndex: t.trackIndex,
              role: t.role,
              targetLufs,
              measuredLufs: t.measuredLufs,
              gainDb,
              needsLimiting: t.measuredTruePeakDbtp + gainDb > -1.0,
            };
          });
        }

        let snapshot = null;
        if (body?.apply && tracksInput.length > 0) {
          const ops: EditOp[] = tracksInput.map((t, idx) => {
            const gainDb = plans[idx]?.gainDb ?? 0;
            const nextVol = Number(Math.min(4, Math.max(0.05, t.currentVolume * Math.pow(10, gainDb / 20))).toFixed(3));
            return { op: 'set', clip: t.clipId, volume: nextVol };
          });
          const intrinsic = new Map<string, number>();
          for (const [k, v] of media.entries()) intrinsic.set(k, v.durationSec);
          const { entry } = commitProjectEdit(activeProjectDir, ops, {
            why: '自动统一各音轨响度（Loudness Match）',
            author: 'agent',
            intrinsicDurationsSec: intrinsic,
          });
          snapshot = await buildProjectSnapshot(activeProjectDir, filmServer.origin);
          broadcast({
            type: 'project-updated',
            author: 'agent',
            why: entry.why,
            changes: entry.changes,
            affectedClipIds: entry.affectedClipIds,
            focusTimeSec: entry.focusTimeSec,
          });
        }

        sendJson(res, 200, { plans, tracks: tracksInput, ...(snapshot ? { snapshot } : {}) });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/audio/analyze-beats') {
        const body = z.object({ src: z.string().min(1) }).parse(await readJsonBody(req));
        const filePath = resolve(activeProjectDir, body.src);
        const beats = await extractBeatOnsets(filePath, true);
        const snapshot = await buildProjectSnapshot(activeProjectDir, filmServer.origin);
        sendJson(res, 200, { ok: true, beats, snapshot });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/export/fcpxml') {
        const doc = parseComposition(readFileSync(join(activeProjectDir, 'composition.html'), 'utf8'));
        const media = await probeProjectMedia(activeProjectDir, doc);
        const intrinsic = new Map<string, number>();
        for (const [k, v] of media.entries()) intrinsic.set(k, v.durationSec);
        const xml = exportFcpxml(doc, { fps: resolveOutputFps(doc, media), intrinsicDurationsSec: intrinsic });
        res.writeHead(200, {
          'Content-Type': 'application/xml; charset=utf-8',
          'Content-Disposition': 'attachment; filename="timeline.fcpxml"',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(xml);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/export/subtitles') {
        const fmt = url.searchParams.get('format') === 'vtt' ? 'vtt' : 'srt';
        const doc = parseComposition(readFileSync(join(activeProjectDir, 'composition.html'), 'utf8'));
        const cues: MappedSubtitleCue[] = [];
        for (const track of doc.tracks) {
          if (track.hidden || track.muted) continue;
          for (const clip of track.clips) {
            if ((clip.kind !== 'audio' && clip.kind !== 'video') || clip.muted) continue;
            const vttPath = join(activeProjectDir, clip.src.replace(/\.[^.]+$/, '.vtt'));
            if (existsSync(vttPath)) cues.push(...mapVttToClip(parseVtt(readFileSync(vttPath, 'utf8')), clip));
          }
        }
        const text = fmt === 'vtt' ? formatCombinedVtt(cues) : formatCombinedSrt(cues);
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="subtitles.${fmt}"`,
          'Access-Control-Allow-Origin': '*',
        });
        res.end(text);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/agent/chat') {
        const body = z
          .object({
            prompt: z.string().min(1),
            currentTime: z.number().default(0),
            apiBase: z.string().optional(),
            apiKey: z.string().optional(),
            model: z.string().optional(),
            history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).optional(),
          })
          .parse(await readJsonBody(req));

        const result = await runAgentConversation({
          projectDir: activeProjectDir,
          prompt: body.prompt,
          currentTime: body.currentTime,
          apiBase: body.apiBase,
          apiKey: body.apiKey,
          model: body.model,
          history: body.history,
          onEditCommitted: (info) => {
            broadcast({
              type: 'project-updated',
              author: 'agent',
              why: info.why,
              changes: info.changes,
              affectedClipIds: info.affectedClipIds,
              focusTimeSec: info.focusTimeSec,
            });
          },
        });
        const snapshot = await buildProjectSnapshot(activeProjectDir, filmServer.origin);
        sendJson(res, 200, { ...result, snapshot });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/edit') {
        const body = EDIT_BODY_SCHEMA.parse(await readJsonBody(req));
        const doc = parseComposition(readFileSync(join(activeProjectDir, 'composition.html'), 'utf8'));
        const media = await probeProjectMedia(activeProjectDir, doc);
        const intrinsic = new Map<string, number>();
        for (const [k, v] of media.entries()) intrinsic.set(k, v.durationSec);

        const { entry } = commitProjectEdit(activeProjectDir, body.ops as EditOp[], {
          why: body.why,
          author: body.author ?? 'human',
          intrinsicDurationsSec: intrinsic,
        });
        const snapshot = await buildProjectSnapshot(activeProjectDir, filmServer.origin);
        broadcast({
          type: 'project-updated',
          entryId: entry.id,
          author: entry.author,
          why: entry.why,
          changes: entry.changes,
          affectedClipIds: entry.affectedClipIds,
          focusTimeSec: entry.focusTimeSec,
        });
        sendJson(res, 200, { ok: true, entry, snapshot });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/undo') {
        const body = (await readJsonBody(req)) as { force?: boolean };
        const { undone } = undoProjectEdit(activeProjectDir, { force: Boolean(body?.force) });
        const snapshot = await buildProjectSnapshot(activeProjectDir, filmServer.origin);
        broadcast({
          type: 'project-updated',
          undoneId: undone.id,
          why: `撤销：${undone.why}`,
          changes: undone.changes,
          affectedClipIds: undone.affectedClipIds,
        });
        sendJson(res, 200, { ok: true, undone, snapshot });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/look') {
        const body = z
          .object({ times: z.array(z.number().nonnegative()).min(1).max(6), scale: z.number().optional() })
          .parse(await readJsonBody(req));
        const captured = await captureProjectFrames(activeProjectDir, body.times, { scale: body.scale ?? 0.5 });
        sendJson(res, 200, {
          width: captured.width,
          height: captured.height,
          frames: captured.frames.map((f) => ({
            timeSec: f.timeSec,
            warnings: f.warnings,
            errors: f.errors,
            dataUrl: `data:image/png;base64,${f.png.toString('base64')}`,
          })),
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/export') {
        if (exporting) {
          sendJson(res, 409, { error: 'An export job is already running' });
          return;
        }
        const body = (await readJsonBody(req)) as { filename?: string; fps?: number; scale?: number };
        const filename = body?.filename?.replace(/[^a-zA-Z0-9._-]/g, '_') || 'output.mp4';
        const outPath = join(activeProjectDir, filename);
        exporting = true;
        sendJson(res, 202, { started: true, outPath });

        void exportProjectVideo(activeProjectDir, outPath, {
          fps: body?.fps,
          scale: body?.scale,
          onProgress: (p) => broadcast({ type: 'export-progress', ...p }),
        })
          .then((result) => {
            exporting = false;
            broadcast({ type: 'export-done', result });
          })
          .catch((err) => {
            exporting = false;
            broadcast({ type: 'export-error', message: (err as Error).message });
          });
        return;
      }

      if (url.pathname.startsWith('/api/analyzer/')) {
        const targetUrl = `${analyzerUrl}${url.pathname.replace('/api/analyzer', '')}`;
        try {
          const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
          const upstream = await fetch(targetUrl, {
            method: req.method,
            headers: { 'Content-Type': 'application/json' },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          });
          const data = await upstream.json();
          sendJson(res, upstream.status, data);
        } catch {
          sendJson(res, 503, {
            error: `Python analyzer service unavailable at ${analyzerUrl}.`,
          });
        }
        return;
      }

      if (options.webDistDir && existsSync(options.webDistDir)) {
        const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
        const candidate = resolve(options.webDistDir, rel);
        const target =
          existsSync(candidate) && statSync(candidate).isFile()
            ? candidate
            : join(options.webDistDir, 'index.html');
        const mime = STATIC_MIME[extname(target)] ?? 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });
        createReadStream(target).pipe(res);
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
  });

  const port = options.port ?? Number(process.env.OPEN_DIRECTOR_PORT ?? 4173);
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => ok());
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;

  return {
    origin: `http://127.0.0.1:${actualPort}`,
    get filmOrigin() {
      return filmServer.origin;
    },
    async close() {
      wss.close();
      await filmServer.close();
      await new Promise<void>((ok, fail) => server.close((e) => (e ? fail(e) : ok())));
    },
  };
}

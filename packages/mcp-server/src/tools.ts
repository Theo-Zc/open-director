import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  CUE_SPEC_SCHEMA,
  EDIT_OP_SCHEMA,
  commitProjectEdit,
  exportFcpxml,
  formatCombinedSrt,
  formatCombinedVtt,
  mapVttToClip,
  parseComposition,
  parseCuesFile,
  parseVtt,
  readEditHistory,
  resolveCues,
  undoProjectEdit,
  type BeatsFile,
  type EditOp,
  type MappedSubtitleCue,
  type ParsedVtt,
} from '@open-director/protocol';
import {
  BUILTIN_SFX_CATALOG,
  auditProject,
  captureProjectFrames,
  discoverTemplates,
  exportProjectVideo,
  extractBeatOnsets,
  instantiateTemplate,
  probeProjectMedia,
  readPageMetadata,
  resolveOutputFps,
  validateProject,
} from '@open-director/engine';

export interface McpToolContent {
  type: 'text' | 'image';
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>, projectDir: string): Promise<{ content: McpToolContent[]; isError?: boolean }>;
}

const EDIT_ARGS_SCHEMA = z.object({
  why: z.string().min(1),
  ops: z.array(EDIT_OP_SCHEMA).min(1),
});

const LOOK_ARGS_SCHEMA = z.object({
  times: z.array(z.number().nonnegative()).min(1).max(8),
  scale: z.number().min(0.25).max(2).optional(),
});

const SET_CUE_ARGS_SCHEMA = z.object({
  name: z.string().min(1),
  spec: CUE_SPEC_SCHEMA,
});

const EXPORT_ARGS_SCHEMA = z.object({
  outPath: z.string().min(1),
  fps: z.number().positive().optional(),
  scale: z.number().min(0.25).max(2).optional(),
});

export function createProjectTools(): McpToolDefinition[] {
  return [
    {
      name: 'project_status',
      description: 'Validate the .motion project and return viewport, fps, duration, tracks, clips, and missing assets.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args, projectDir) {
        const report = await validateProject(projectDir);
        const doc = existsSync(join(projectDir, 'composition.html'))
          ? parseComposition(readFileSync(join(projectDir, 'composition.html'), 'utf8'))
          : null;
        return {
          content: [{ type: 'text', text: JSON.stringify({ projectDir, report, tracks: doc?.tracks ?? [] }, null, 2) }],
        };
      },
    },
    {
      name: 'read_composition',
      description: 'Read raw composition.html and cues.json from the active project.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args, projectDir) {
        const comp = readFileSync(join(projectDir, 'composition.html'), 'utf8');
        const cuesPath = join(projectDir, 'cues.json');
        const cues = existsSync(cuesPath) ? readFileSync(cuesPath, 'utf8') : null;
        return {
          content: [{ type: 'text', text: JSON.stringify({ compositionHtml: comp, cuesJson: cues }, null, 2) }],
        };
      },
    },
    {
      name: 'edit_timeline',
      description: 'Atomically apply structured edit ops (move, trim, set, fade, text, style, param, box, add, remove, ripple, track) with an undoable why description.',
      inputSchema: {
        type: 'object',
        required: ['why', 'ops'],
        properties: {
          why: { type: 'string', description: 'Human-readable summary of why this edit is made.' },
          ops: { type: 'array', items: { type: 'object' }, minItems: 1 },
        },
      },
      async run(args, projectDir) {
        const parsed = EDIT_ARGS_SCHEMA.parse(args);
        const doc = parseComposition(readFileSync(join(projectDir, 'composition.html'), 'utf8'));
        const media = await probeProjectMedia(projectDir, doc);
        const intrinsic = new Map<string, number>();
        for (const [k, info] of media.entries()) intrinsic.set(k, info.durationSec);

        const { entry } = commitProjectEdit(projectDir, parsed.ops as EditOp[], {
          why: parsed.why,
          author: 'agent',
          intrinsicDurationsSec: intrinsic,
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ok: true, id: entry.id, changes: entry.changes }, null, 2),
            },
          ],
        };
      },
    },
    {
      name: 'edit_log',
      description: 'List recorded edit history entries for the project.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args, projectDir) {
        const entries = readEditHistory(projectDir).map(({ id, timestamp, author, why, changes }) => ({
          id,
          timestamp,
          author,
          why,
          changes,
        }));
        return { content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }] };
      },
    },
    {
      name: 'undo_edit',
      description: 'Undo the most recent recorded timeline edit.',
      inputSchema: {
        type: 'object',
        properties: { force: { type: 'boolean' } },
      },
      async run(args, projectDir) {
        const force = Boolean(args.force);
        const { undone } = undoProjectEdit(projectDir, { force });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ok: true, undoneId: undone.id, why: undone.why, changes: undone.changes }, null, 2),
            },
          ],
        };
      },
    },
    {
      name: 'look_frames',
      description: 'Render deterministic frames at the requested film timestamps (seconds) and return PNG images + sample/overflow warnings.',
      inputSchema: {
        type: 'object',
        required: ['times'],
        properties: {
          times: { type: 'array', items: { type: 'number' }, minItems: 1, maxItems: 8 },
          scale: { type: 'number', minimum: 0.25, maximum: 2 },
        },
      },
      async run(args, projectDir) {
        const parsed = LOOK_ARGS_SCHEMA.parse(args);
        const res = await captureProjectFrames(projectDir, parsed.times, { scale: parsed.scale ?? 0.5 });
        const content: McpToolContent[] = [
          {
            type: 'text',
            text: JSON.stringify(
              {
                width: res.width,
                height: res.height,
                frames: res.frames.map((f) => ({ timeSec: f.timeSec, warnings: f.warnings, errors: f.errors })),
              },
              null,
              2,
            ),
          },
        ];
        for (const f of res.frames) {
          content.push({
            type: 'image',
            data: f.png.toString('base64'),
            mimeType: 'image/png',
          });
        }
        return { content };
      },
    },
    {
      name: 'list_params',
      description: 'Inspect declared window.film.params on a page file inside the project.',
      inputSchema: {
        type: 'object',
        required: ['page'],
        properties: { page: { type: 'string' } },
      },
      async run(args, projectDir) {
        const pagePath = z.string().min(1).parse(args.page);
        const meta = await readPageMetadata(projectDir, pagePath);
        return { content: [{ type: 'text', text: JSON.stringify(meta, null, 2) }] };
      },
    },
    {
      name: 'list_cues',
      description: 'Read and resolve cues.json anchors to film timestamps.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args, projectDir) {
        const cuesPath = join(projectDir, 'cues.json');
        if (!existsSync(cuesPath)) {
          return { content: [{ type: 'text', text: JSON.stringify({ cues: {}, resolved: {} }, null, 2) }] };
        }
        const doc = parseComposition(readFileSync(join(projectDir, 'composition.html'), 'utf8'));
        const cuesFile = parseCuesFile(readFileSync(cuesPath, 'utf8'));
        const media = await probeProjectMedia(projectDir, doc);
        const intrinsic = new Map<string, number>();
        for (const [k, info] of media.entries()) intrinsic.set(k, info.durationSec);
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
        const resolved = resolveCues(cuesFile, doc, vttBySource, intrinsic, beatsBySource);
        return { content: [{ type: 'text', text: JSON.stringify({ cues: cuesFile.cues, resolved }, null, 2) }] };
      },
    },
    {
      name: 'set_cue',
      description: 'Set or update a named timing cue in cues.json.',
      inputSchema: {
        type: 'object',
        required: ['name', 'spec'],
        properties: {
          name: { type: 'string' },
          spec: { type: 'object' },
        },
      },
      async run(args, projectDir) {
        const parsed = SET_CUE_ARGS_SCHEMA.parse(args);
        const cuesPath = join(projectDir, 'cues.json');
        const current = existsSync(cuesPath)
          ? parseCuesFile(readFileSync(cuesPath, 'utf8'))
          : { schema: 'open-director.cues/1' as const, cues: {} };
        current.cues[parsed.name] = parsed.spec;
        writeFileSync(cuesPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, cue: parsed.name, spec: parsed.spec }, null, 2) }] };
      },
    },
    {
      name: 'export_video',
      description: 'Render the full composition deterministically and encode an MP4 video with mixed audio.',
      inputSchema: {
        type: 'object',
        required: ['outPath'],
        properties: {
          outPath: { type: 'string' },
          fps: { type: 'number' },
          scale: { type: 'number' },
        },
      },
      async run(args, projectDir) {
        const parsed = EXPORT_ARGS_SCHEMA.parse(args);
        const resolvedOut = resolve(projectDir, parsed.outPath);
        const res = await exportProjectVideo(projectDir, resolvedOut, {
          fps: parsed.fps,
          scale: parsed.scale,
        });
        return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
      },
    },
    {
      name: 'audit_project',
      description: 'Run preflight checks: detect visible data-film-sample placeholders, clipped text overflow, missing assets, and measure real LUFS loudness.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args, projectDir) {
        const audit = await auditProject(projectDir);
        return { content: [{ type: 'text', text: JSON.stringify(audit, null, 2) }] };
      },
    },
    {
      name: 'list_sfx',
      description: 'Search built-in procedural SFX library (served at __film/sfx/<id>) by keyword.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
      },
      async run(args) {
        const q = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
        const items = q
          ? BUILTIN_SFX_CATALOG.filter(
              (s) =>
                s.id.includes(q) ||
                s.title.toLowerCase().includes(q) ||
                s.title_en.toLowerCase().includes(q) ||
                s.tags.some((t) => t.toLowerCase().includes(q) || q.includes(t.toLowerCase())),
            )
          : BUILTIN_SFX_CATALOG;
        return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
      },
    },
    {
      name: 'analyze_beats',
      description: 'Extract BPM and beat timestamps from an audio clip in the project and save <src>.beats.json.',
      inputSchema: {
        type: 'object',
        required: ['src'],
        properties: { src: { type: 'string' } },
      },
      async run(args, projectDir) {
        const src = z.string().min(1).parse(args.src);
        const target = resolve(projectDir, src);
        const beats = await extractBeatOnsets(target, true);
        return { content: [{ type: 'text', text: JSON.stringify(beats, null, 2) }] };
      },
    },
    {
      name: 'export_fcpxml',
      description: 'Export composition.html as an FCPXML 1.10 timeline for Final Cut Pro or DaVinci Resolve.',
      inputSchema: {
        type: 'object',
        properties: { outPath: { type: 'string' } },
      },
      async run(args, projectDir) {
        const outPath = resolve(projectDir, typeof args.outPath === 'string' ? args.outPath : 'timeline.fcpxml');
        const doc = parseComposition(readFileSync(join(projectDir, 'composition.html'), 'utf8'));
        const media = await probeProjectMedia(projectDir, doc);
        const intrinsic = new Map<string, number>();
        for (const [k, v] of media.entries()) intrinsic.set(k, v.durationSec);
        const xml = exportFcpxml(doc, { fps: resolveOutputFps(doc, media), intrinsicDurationsSec: intrinsic });
        writeFileSync(outPath, xml, 'utf8');
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, outPath }) }] };
      },
    },
    {
      name: 'export_subtitles',
      description: 'Export combined project subtitles across audible clips as SRT or WebVTT.',
      inputSchema: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['srt', 'vtt'] },
          outPath: { type: 'string' },
        },
      },
      async run(args, projectDir) {
        const fmt = args.format === 'vtt' ? 'vtt' : 'srt';
        const doc = parseComposition(readFileSync(join(projectDir, 'composition.html'), 'utf8'));
        const cues: MappedSubtitleCue[] = [];
        for (const track of doc.tracks) {
          if (track.hidden || track.muted) continue;
          for (const clip of track.clips) {
            if ((clip.kind !== 'audio' && clip.kind !== 'video') || clip.muted) continue;
            const vttPath = join(projectDir, clip.src.replace(/\.[^.]+$/, '.vtt'));
            if (!existsSync(vttPath)) continue;
            cues.push(...mapVttToClip(parseVtt(readFileSync(vttPath, 'utf8')), clip));
          }
        }
        const text = fmt === 'vtt' ? formatCombinedVtt(cues) : formatCombinedSrt(cues);
        const outPath = resolve(projectDir, typeof args.outPath === 'string' ? args.outPath : `subtitles.${fmt}`);
        writeFileSync(outPath, text, 'utf8');
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, outPath, cueCount: cues.length }) }] };
      },
    },
    {
      name: 'list_templates',
      description: 'List available built-in .motion templates.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        const templatesRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../templates');
        const list = discoverTemplates(templatesRoot);
        return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
      },
    },
    {
      name: 'new_from_template',
      description: 'Instantiate a built-in template into a target project directory.',
      inputSchema: {
        type: 'object',
        required: ['templateId', 'targetDir'],
        properties: {
          templateId: { type: 'string' },
          targetDir: { type: 'string' },
          projectName: { type: 'string' },
          params: { type: 'object' },
        },
      },
      async run(args) {
        const templatesRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../templates');
        const list = discoverTemplates(templatesRoot);
        const tpl = list.find((t) => t.id === args.templateId);
        if (!tpl) throw new Error(`Template "${String(args.templateId)}" not found`);
        const res = instantiateTemplate(tpl.dir, String(args.targetDir), {
          projectName: typeof args.projectName === 'string' ? args.projectName : undefined,
          params: (args.params as Record<string, unknown>) ?? undefined,
        });
        return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
      },
    },
  ];
}

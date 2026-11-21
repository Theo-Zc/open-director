#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EDIT_OP_SCHEMA,
  commitProjectEdit,
  createProjectManifest,
  exportFcpxml,
  formatCombinedSrt,
  mapVttToClip,
  parseComposition,
  parseVtt,
  readEditHistory,
  serializeComposition,
  undoProjectEdit,
  type CompositionDoc,
  type MappedSubtitleCue,
} from '@open-director/protocol';
import {
  BUILTIN_SFX_CATALOG,
  auditProject,
  captureProjectFrames,
  discoverTemplates,
  exportProjectVideo,
  extractBeatOnsets,
  instantiateTemplate,
  packMotionArchive,
  probeProjectMedia,
  readPageMetadata,
  resolveOutputFps,
  unpackMotionArchive,
  validateProject,
} from '@open-director/engine';
import { z } from 'zod';
import { runMcpStdioServer } from './server.js';

function takeFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const val = args[idx + 1];
  args.splice(idx, 2);
  return val;
}

function hasBoolFlag(args: string[], flag: string): boolean {
  const idx = args.indexOf(flag);
  if (idx === -1) return false;
  args.splice(idx, 1);
  return true;
}

async function cmdInit(args: string[]): Promise<void> {
  const dir = resolve(args[0] ?? '.');
  const name = takeFlag(args, '--name') ?? basename(dir);
  mkdirSync(join(dir, 'scenes'), { recursive: true });
  mkdirSync(join(dir, 'assets'), { recursive: true });

  const manifest = createProjectManifest({ id: `proj-${Date.now()}`, name });
  writeFileSync(join(dir, 'motion.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  writeFileSync(
    join(dir, 'scenes', 'intro.html'),
    `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; width: 100%; height: 100%; background: #0f172a; color: #f8fafc; font-family: system-ui, sans-serif; display: grid; place-items: center; }
  .card { padding: 48px 64px; border-radius: 24px; border: 2px solid var(--accent); background: rgba(15, 23, 42, 0.85); text-align: center; }
  h1 { margin: 0; font-size: 64px; }
</style>
</head>
<body>
  <div class="card"><h1 id="title">Open Director</h1></div>
  <script type="module">
    import { useParams } from './__film/film-params.mjs';
    const el = document.querySelector('.card');
    const title = document.getElementById('title');
    window.film = {
      duration: 4,
      params: {
        accent: { type: 'color', default: '#38bdf8', label: 'Accent' },
        title: { type: 'text', default: 'Open Director', label: 'Title' },
      },
      frame(t) {
        title.textContent = param('title');
        const p = Math.min(1, Math.max(0, t / 0.6));
        const ease = 1 - Math.pow(1 - p, 3);
        el.style.opacity = String(ease);
        el.style.transform = \`translateY(\${(1 - ease) * 32}px)\`;
      },
    };
    const param = useParams(window.film);
  </script>
</body>
</html>
`,
    'utf8',
  );

  const doc: CompositionDoc = {
    viewport: { width: 1920, height: 1080 },
    fps: 30,
    styles: [],
    extraHeadHtml: [],
    tracks: [
      {
        id: 'main',
        hidden: false,
        muted: false,
        locked: false,
        passthroughAttrs: {},
        clips: [
          {
            id: 'intro',
            explicitId: true,
            kind: 'page',
            src: 'scenes/intro.html',
            inSec: 0,
            outSec: 4,
            at: 0,
            speed: 1,
            volume: 1,
            muted: false,
            box: {},
            visualStyle: {},
            overrides: [],
            passthroughAttrs: {},
          },
        ],
      },
    ],
  };
  writeFileSync(join(dir, 'composition.html'), serializeComposition(doc), 'utf8');
  console.log(`Initialized project at ${dir}`);
}

async function cmdValidate(args: string[]): Promise<void> {
  const dir = resolve(args[0] ?? '.');
  const report = await validateProject(dir);
  console.log(JSON.stringify(report, null, 2));
  if (!report.valid) process.exitCode = 1;
}

async function cmdLook(args: string[]): Promise<void> {
  const dir = resolve(args[0] ?? '.');
  const atRaw = takeFlag(args, '--at') ?? '0,1';
  const outDir = resolve(takeFlag(args, '--out') ?? join(dir, '.open-director', 'look'));
  const scale = Number(takeFlag(args, '--scale') ?? '1');
  const times = atRaw.split(',').map((s) => Number(s.trim()));
  mkdirSync(outDir, { recursive: true });
  const res = await captureProjectFrames(dir, times, { scale });
  for (const f of res.frames) {
    const file = join(outDir, `frame_${f.timeSec.toFixed(3)}s.png`);
    writeFileSync(file, f.png);
    console.log(`Saved ${file} (samples=${f.warnings.samples.length}, overflows=${f.warnings.overflows.length})`);
  }
}

async function cmdRender(args: string[]): Promise<void> {
  const dir = resolve(args[0] ?? '.');
  const outPath = resolve(takeFlag(args, '--out') ?? join(dir, 'output.mp4'));
  const fpsRaw = takeFlag(args, '--fps');
  const scaleRaw = takeFlag(args, '--scale');
  const res = await exportProjectVideo(dir, outPath, {
    ...(fpsRaw ? { fps: Number(fpsRaw) } : {}),
    ...(scaleRaw ? { scale: Number(scaleRaw) } : {}),
    onProgress: (p) => {
      if (p.phase === 'rendering' && (p.frame === p.totalFrames || p.frame % 15 === 0)) {
        process.stderr.write(`\rRendering ${p.frame}/${p.totalFrames} (${p.percent}%)`);
      }
    },
  });
  process.stderr.write('\n');
  console.log(JSON.stringify(res, null, 2));
}

async function cmdEdit(args: string[]): Promise<void> {
  const dir = resolve(args[0] ?? '.');
  const why = takeFlag(args, '--why') ?? 'CLI edit';
  const rawOps = takeFlag(args, '--ops') ?? args[1];
  if (!rawOps) throw new Error('Pass --ops <json>');
  const parsed = JSON.parse(rawOps);
  const ops = z.array(EDIT_OP_SCHEMA).parse(Array.isArray(parsed) ? parsed : [parsed]);
  const doc = parseComposition(readFileSync(join(dir, 'composition.html'), 'utf8'));
  const media = await probeProjectMedia(dir, doc);
  const intrinsic = new Map<string, number>();
  for (const [k, info] of media.entries()) intrinsic.set(k, info.durationSec);
  const { entry } = commitProjectEdit(dir, ops, { why, author: 'human', intrinsicDurationsSec: intrinsic });
  console.log(JSON.stringify({ id: entry.id, changes: entry.changes }, null, 2));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args.shift();

  switch (cmd) {
    case 'init':
      await cmdInit(args);
      break;
    case 'validate':
      await cmdValidate(args);
      break;
    case 'params': {
      const dir = resolve(args[0] ?? '.');
      const page = args[1];
      if (!page) throw new Error('Usage: open-director params <projectDir> <page.html>');
      console.log(JSON.stringify(await readPageMetadata(dir, page), null, 2));
      break;
    }
    case 'look':
      await cmdLook(args);
      break;
    case 'render':
      await cmdRender(args);
      break;
    case 'edit':
      await cmdEdit(args);
      break;
    case 'undo': {
      const dir = resolve(args[0] ?? '.');
      const force = hasBoolFlag(args, '--force');
      const { undone } = undoProjectEdit(dir, { force });
      console.log(JSON.stringify({ undone: undone.id, why: undone.why, changes: undone.changes }, null, 2));
      break;
    }
    case 'history': {
      const dir = resolve(args[0] ?? '.');
      console.log(
        JSON.stringify(
          readEditHistory(dir).map(({ id, timestamp, author, why, changes }) => ({ id, timestamp, author, why, changes })),
          null,
          2,
        ),
      );
      break;
    }
    case 'pack': {
      const dir = resolve(args[0] ?? '.');
      const out = resolve(takeFlag(args, '--out') ?? `${basename(dir)}.motion`);
      console.log(JSON.stringify(await packMotionArchive(dir, out), null, 2));
      break;
    }
    case 'unpack': {
      const archive = resolve(args[0]);
      const target = resolve(args[1] ?? basename(archive, '.motion'));
      console.log(JSON.stringify(await unpackMotionArchive(archive, target), null, 2));
      break;
    }
    case 'templates': {
      const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../templates');
      console.log(JSON.stringify(discoverTemplates(root), null, 2));
      break;
    }
    case 'new': {
      const templateId = takeFlag(args, '--template');
      const target = resolve(args[0] ?? '.');
      if (!templateId) throw new Error('Usage: open-director new --template <id> <targetDir>');
      const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../templates');
      const tpl = discoverTemplates(root).find((t) => t.id === templateId);
      if (!tpl) throw new Error(`Unknown template "${templateId}"`);
      console.log(JSON.stringify(instantiateTemplate(tpl.dir, target, { projectName: takeFlag(args, '--name') }), null, 2));
      break;
    }
    case 'audit': {
      const dir = resolve(args[0] ?? '.');
      console.log(JSON.stringify(await auditProject(dir), null, 2));
      break;
    }
    case 'beats': {
      const dir = resolve(args[0] ?? '.');
      const src = args[1];
      if (!src) throw new Error('Usage: open-director beats <projectDir> <assets/music.wav>');
      console.log(JSON.stringify(await extractBeatOnsets(resolve(dir, src), true), null, 2));
      break;
    }
    case 'sfx': {
      const q = (args[0] ?? '').toLowerCase();
      const items = q
        ? BUILTIN_SFX_CATALOG.filter((s) => s.id.includes(q) || s.title.includes(q) || s.tags.some((t) => t.includes(q)))
        : BUILTIN_SFX_CATALOG;
      console.log(JSON.stringify(items, null, 2));
      break;
    }
    case 'fcpxml': {
      const dir = resolve(args[0] ?? '.');
      const outPath = resolve(takeFlag(args, '--out') ?? join(dir, 'timeline.fcpxml'));
      const doc = parseComposition(readFileSync(join(dir, 'composition.html'), 'utf8'));
      const media = await probeProjectMedia(dir, doc);
      const intrinsic = new Map<string, number>();
      for (const [k, v] of media.entries()) intrinsic.set(k, v.durationSec);
      writeFileSync(outPath, exportFcpxml(doc, { fps: resolveOutputFps(doc, media), intrinsicDurationsSec: intrinsic }), 'utf8');
      console.log(JSON.stringify({ ok: true, outPath }));
      break;
    }
    case 'srt': {
      const dir = resolve(args[0] ?? '.');
      const outPath = resolve(takeFlag(args, '--out') ?? join(dir, 'subtitles.srt'));
      const doc = parseComposition(readFileSync(join(dir, 'composition.html'), 'utf8'));
      const cues: MappedSubtitleCue[] = [];
      for (const track of doc.tracks) {
        if (track.hidden || track.muted) continue;
        for (const clip of track.clips) {
          if ((clip.kind !== 'audio' && clip.kind !== 'video') || clip.muted) continue;
          const vttPath = join(dir, clip.src.replace(/\.[^.]+$/, '.vtt'));
          if (existsSync(vttPath)) cues.push(...mapVttToClip(parseVtt(readFileSync(vttPath, 'utf8')), clip));
        }
      }
      writeFileSync(outPath, formatCombinedSrt(cues), 'utf8');
      console.log(JSON.stringify({ ok: true, outPath, cueCount: cues.length }));
      break;
    }
    case 'mcp': {
      const dir = resolve(args[0] ?? '.');
      await runMcpStdioServer(dir);
      break;
    }
    default:
      console.log(`Usage: open-director <command> [options]

Commands:
  init [dir] [--name NAME]            Create a starter .motion project
  templates                           List built-in .motion templates
  new --template ID [dir]             Instantiate a template into a new workspace
  validate [dir]                      Validate motion.json, composition.html, cues, and assets
  audit [dir]                         Run preflight audit (samples, text overflow, loudness)
  params <dir> <page.html>            Inspect declared window.film.params and film.sfx
  look [dir] --at 0,1.5 --out DIR     Capture deterministic PNG frames
  render [dir] --out out.mp4          Render video + mixed audio + film.sfx to MP4
  edit [dir] --ops JSON --why TEXT    Apply atomic timeline edit ops
  undo [dir] [--force]                Undo the last timeline edit
  history [dir]                       Show edit history log
  beats <dir> <audioFile>             Extract BPM and beat timestamps (.beats.json)
  sfx [query]                         Search built-in procedural SFX library
  fcpxml [dir] --out timeline.fcpxml  Export FCPXML 1.10 timeline
  srt [dir] --out subtitles.srt       Export combined SRT subtitles
  pack [dir] --out file.motion        Pack project into .motion ZIP with SHA-256 integrity
  unpack <file.motion> [targetDir]    Verify and unpack a .motion archive into a workspace
  mcp [dir]                           Start stdio MCP server over a project directory`);
      if (cmd) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});

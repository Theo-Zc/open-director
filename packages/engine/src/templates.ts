import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  createProjectManifest,
  parseMotionManifest,
  serializeComposition,
  type ClipOverride,
  type CompositionDoc,
  type TemplateManifest,
} from '@open-director/protocol';

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
  guide?: Record<string, unknown>;
  paramsSchema?: Record<string, unknown>;
  defaultPreset?: Record<string, unknown>;
  presets: string[];
  coverRelPath?: string;
}

/**
 * Scan a directory of `.motion` template folders and return validated metadata.
 */
export function discoverTemplates(templatesRoot: string): TemplateSummary[] {
  const root = resolve(templatesRoot);
  if (!existsSync(root)) return [];

  const summaries: TemplateSummary[] = [];
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    if (!statSync(dir).isDirectory()) continue;
    const manifestPath = join(dir, 'motion.json');
    if (!existsSync(manifestPath)) continue;

    try {
      const parsed = parseMotionManifest(readFileSync(manifestPath, 'utf8'));
      if (parsed.kind !== 'template') continue;
      const tpl: TemplateManifest = parsed.manifest;
      const entryPage = tpl.runtime.entry ?? 'src/index.html';
      if (!existsSync(join(dir, entryPage))) continue;

      const guidePath = join(dir, tpl.ai?.guide ?? 'guide.json');
      const schemaPath = join(dir, tpl.parameters?.schema ?? 'params.schema.json');
      const defaultPresetPath = join(dir, tpl.parameters?.defaultPreset ?? 'presets/demo.json');
      const presetsDir = join(dir, 'presets');

      const presets = existsSync(presetsDir)
        ? readdirSync(presetsDir).filter((f) => f.endsWith('.json'))
        : [];

      summaries.push({
        id: tpl.template.id,
        dir,
        name: tpl.template.name,
        version: tpl.template.version,
        description: tpl.template.description,
        width: tpl.output.width,
        height: tpl.output.height,
        fps: tpl.output.fps.num / tpl.output.fps.den,
        entry: entryPage,
        guide: existsSync(guidePath) ? JSON.parse(readFileSync(guidePath, 'utf8')) : undefined,
        paramsSchema: existsSync(schemaPath) ? JSON.parse(readFileSync(schemaPath, 'utf8')) : undefined,
        defaultPreset: existsSync(defaultPresetPath) ? JSON.parse(readFileSync(defaultPresetPath, 'utf8')) : undefined,
        presets,
        coverRelPath: tpl.preview?.cover && existsSync(join(dir, tpl.preview.cover)) ? tpl.preview.cover : undefined,
      });
    } catch {
      // skip invalid template folders
    }
  }
  return summaries;
}

function encodeOverrideParam(val: unknown): string {
  if (typeof val === 'boolean') return val ? '1' : '0';
  if (typeof val === 'number') return String(val);
  if (typeof val === 'string' && val.startsWith('#')) return val.toLowerCase();
  return JSON.stringify(val);
}

/**
 * Instantiate a `.motion` template directory into a fresh, editable
 * `adudir-motion-project/2` workspace without altering the source template.
 */
export function instantiateTemplate(
  templateDir: string,
  targetDir: string,
  options: {
    projectName?: string;
    presetName?: string;
    params?: Record<string, unknown>;
  } = {},
): { projectDir: string; entry: string } {
  const srcRoot = resolve(templateDir);
  const destRoot = resolve(targetDir);
  const parsed = parseMotionManifest(readFileSync(join(srcRoot, 'motion.json'), 'utf8'));
  if (parsed.kind !== 'template') {
    throw new Error(`"${templateDir}" is not a motiongit-template`);
  }
  const tpl = parsed.manifest;
  const entryPage = tpl.runtime.entry ?? 'src/index.html';

  mkdirSync(destRoot, { recursive: true });
  for (const folder of ['src', 'assets']) {
    const srcFolder = join(srcRoot, folder);
    if (existsSync(srcFolder)) {
      cpSync(srcFolder, join(destRoot, folder), { recursive: true });
    }
  }
  mkdirSync(join(destRoot, 'assets'), { recursive: true });

  let initialParams: Record<string, unknown> = {};
  const presetFile = options.presetName
    ? join(srcRoot, 'presets', options.presetName)
    : join(srcRoot, tpl.parameters?.defaultPreset ?? 'presets/demo.json');
  if (existsSync(presetFile)) {
    initialParams = JSON.parse(readFileSync(presetFile, 'utf8'));
  }
  if (options.params) {
    initialParams = { ...initialParams, ...options.params };
  }

  const rootStyle: Record<string, string> = {};
  for (const [k, v] of Object.entries(initialParams)) {
    if (/^[a-z][A-Za-z0-9_]{0,39}$/.test(k) && v !== undefined && v !== null && typeof v !== 'object') {
      rootStyle[`--${k}`] = encodeOverrideParam(v);
    }
  }
  const overrides: ClipOverride[] = Object.keys(rootStyle).length > 0 ? [{ at: ':root', style: rootStyle }] : [];

  const fps = tpl.output.fps.num / tpl.output.fps.den;
  const doc: CompositionDoc = {
    viewport: { width: tpl.output.width, height: tpl.output.height },
    fps,
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
            id: tpl.template.id,
            explicitId: true,
            kind: 'page',
            src: entryPage,
            inSec: 0,
            at: 0,
            speed: 1,
            volume: 1,
            muted: false,
            box: {},
            visualStyle: {},
            overrides,
            passthroughAttrs: {},
          },
        ],
      },
    ],
  };

  writeFileSync(join(destRoot, 'composition.html'), serializeComposition(doc), 'utf8');
  const projManifest = createProjectManifest({
    id: `${tpl.template.id}-${Date.now()}`,
    name: options.projectName ?? tpl.template.name,
    width: tpl.output.width,
    height: tpl.output.height,
    fps,
    source: {
      kind: 'motiongit-template',
      template: tpl.template.id,
      version: tpl.template.version,
      entry: entryPage,
    },
  });
  writeFileSync(join(destRoot, 'motion.json'), `${JSON.stringify(projManifest, null, 2)}\n`, 'utf8');

  if (existsSync(join(srcRoot, 'guide.json'))) {
    cpSync(join(srcRoot, 'guide.json'), join(destRoot, 'guide.json'));
  }

  return { projectDir: destRoot, entry: entryPage };
}

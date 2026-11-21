import { z } from 'zod';

export const FPS_RATIO_SCHEMA = z.object({
  num: z.number().int().positive(),
  den: z.number().int().positive(),
});

export const OUTPUT_SPEC_SCHEMA = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: FPS_RATIO_SCHEMA,
  layouts: z
    .record(
      z.object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      }),
    )
    .optional(),
  defaultLayout: z.string().optional(),
});

export const TEMPLATE_MANIFEST_SCHEMA = z.object({
  format: z.literal('motiongit-template'),
  specVersion: z.string().min(1),
  template: z.object({
    id: z.string().min(1),
    version: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    language: z.string().optional(),
  }),
  runtime: z.object({
    profile: z.string().min(1),
    entry: z.string().min(1).optional(),
    engine: z.string().optional(),
  }),
  output: OUTPUT_SPEC_SCHEMA,
  parameters: z
    .object({
      schema: z.string().optional(),
      defaultPreset: z.string().optional(),
    })
    .optional(),
  ai: z
    .object({
      entry: z.string().optional(),
      guide: z.string().optional(),
    })
    .optional(),
  preview: z
    .object({
      cover: z.string().optional(),
      portraitCover: z.string().optional(),
    })
    .optional(),
  license: z
    .object({
      id: z.string().optional(),
      file: z.string().optional(),
    })
    .optional(),
  integrity: z.string().optional(),
  assets: z
    .object({
      manifest: z.string().optional(),
    })
    .optional(),
});

export const PROJECT_MANIFEST_SCHEMA = z.object({
  format: z.literal('adudir-motion-project'),
  specVersion: z.string().min(1),
  packageProfile: z.string().optional(),
  project: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    revision: z.number().int().nonnegative().default(1),
    source: z
      .object({
        kind: z.string(),
        template: z.string(),
        version: z.string().optional(),
        entry: z.string().optional(),
      })
      .optional(),
  }),
  runtime: z.object({
    profile: z.literal('adudir.composition/1'),
    entry: z.string().min(1).default('composition.html'),
    engine: z.string().optional(),
  }),
  output: OUTPUT_SPEC_SCHEMA.optional(),
});

export type TemplateManifest = z.infer<typeof TEMPLATE_MANIFEST_SCHEMA>;
export type ProjectManifest = z.infer<typeof PROJECT_MANIFEST_SCHEMA>;

export type ParsedManifest =
  | { kind: 'template'; manifest: TemplateManifest }
  | { kind: 'project'; manifest: ProjectManifest };

/**
 * Parse and strictly validate a `motion.json` payload for either a `.motion`
 * template package or an editable `adudir-motion-project` workspace.
 */
export function parseMotionManifest(rawJson: string): ParsedManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(rawJson);
  } catch (err) {
    throw new Error(`Invalid motion.json: ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || !('format' in raw)) {
    throw new Error('Invalid motion.json: missing top-level "format" field');
  }
  const format = (raw as { format?: unknown }).format;
  if (format === 'motiongit-template') {
    return { kind: 'template', manifest: TEMPLATE_MANIFEST_SCHEMA.parse(raw) };
  }
  if (format === 'adudir-motion-project') {
    return { kind: 'project', manifest: PROJECT_MANIFEST_SCHEMA.parse(raw) };
  }
  throw new Error(`Unsupported motion.json format: ${String(format)}`);
}

/**
 * Create a clean `adudir-motion-project/2` manifest for newly initialized
 * or unpacked projects.
 */
export function createProjectManifest(options: {
  id: string;
  name: string;
  width?: number;
  height?: number;
  fps?: number;
  source?: NonNullable<ProjectManifest['project']['source']>;
}): ProjectManifest {
  const fps = options.fps ?? 30;
  return {
    format: 'adudir-motion-project',
    specVersion: '2.0.0',
    packageProfile: 'adudir-motion-project/2',
    project: {
      id: options.id,
      name: options.name,
      revision: 1,
      ...(options.source ? { source: options.source } : {}),
    },
    runtime: {
      profile: 'adudir.composition/1',
      entry: 'composition.html',
      engine: 'open-director',
    },
    output: {
      width: options.width ?? 1920,
      height: options.height ?? 1080,
      fps: { num: Math.round(fps * 1000), den: 1000 },
    },
  };
}

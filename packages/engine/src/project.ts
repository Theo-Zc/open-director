import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import JSZip from 'jszip';
import {
  createProjectManifest,
  parseComposition,
  parseCuesFile,
  parseMotionManifest,
  parseVtt,
  serializeComposition,
  type CompositionDoc,
  type ParsedManifest,
} from '@open-director/protocol';
import { computeCompositionDuration, probeProjectMedia, resolveOutputFps } from './media.js';

export interface ProjectValidationReport {
  valid: boolean;
  manifestKind?: ParsedManifest['kind'];
  projectName?: string;
  viewport?: { width: number; height: number };
  fps?: number;
  durationSec?: number;
  trackCount?: number;
  clipCount?: number;
  missingFiles: string[];
  errors: string[];
  warnings: string[];
}

function sha256Buffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Validate a `.motion` project directory (`motion.json`, `composition.html`, `cues.json`,
 * referenced local media/pages, and associated `.vtt` subtitles).
 */
export async function validateProject(projectDir: string): Promise<ProjectValidationReport> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const missingFiles: string[] = [];

  const manifestPath = join(projectDir, 'motion.json');
  let manifestKind: ParsedManifest['kind'] | undefined;
  let projectName: string | undefined;

  if (!existsSync(manifestPath)) {
    errors.push('Missing motion.json');
  } else {
    try {
      const parsed = parseMotionManifest(readFileSync(manifestPath, 'utf8'));
      manifestKind = parsed.kind;
      projectName = parsed.kind === 'project' ? parsed.manifest.project.name : parsed.manifest.template.name;
    } catch (err) {
      errors.push(`motion.json: ${(err as Error).message}`);
    }
  }

  const compPath = join(projectDir, 'composition.html');
  if (!existsSync(compPath)) {
    errors.push('Missing composition.html');
    return { valid: false, manifestKind, projectName, missingFiles, errors, warnings };
  }

  let doc: CompositionDoc;
  try {
    doc = parseComposition(readFileSync(compPath, 'utf8'));
  } catch (err) {
    errors.push(`composition.html: ${(err as Error).message}`);
    return { valid: false, manifestKind, projectName, missingFiles, errors, warnings };
  }

  let clipCount = 0;
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      clipCount += 1;
      const assetPath = join(projectDir, clip.src);
      if (!existsSync(assetPath)) {
        missingFiles.push(clip.src);
        errors.push(`Missing referenced source "${clip.src}" (clip "${clip.id}")`);
      }
      if (clip.kind === 'audio' || clip.kind === 'video') {
        const vttCandidate = join(projectDir, clip.src.replace(/\.[^.]+$/, '.vtt'));
        if (existsSync(vttCandidate)) {
          try {
            parseVtt(readFileSync(vttCandidate, 'utf8'));
          } catch (err) {
            warnings.push(`Invalid VTT "${relative(projectDir, vttCandidate)}": ${(err as Error).message}`);
          }
        }
      }
    }
  }

  const cuesPath = join(projectDir, 'cues.json');
  if (existsSync(cuesPath)) {
    try {
      parseCuesFile(readFileSync(cuesPath, 'utf8'));
    } catch (err) {
      errors.push(`cues.json: ${(err as Error).message}`);
    }
  }

  const mediaInfo = await probeProjectMedia(projectDir, doc);
  const fps = resolveOutputFps(doc, mediaInfo);
  const durationSec = computeCompositionDuration(doc, mediaInfo);

  return {
    valid: errors.length === 0,
    manifestKind,
    projectName,
    viewport: doc.viewport,
    fps,
    durationSec,
    trackCount: doc.tracks.length,
    clipCount,
    missingFiles,
    errors,
    warnings,
  };
}

/**
 * Unpack a `.motion` ZIP archive into a fresh workspace directory, verifying
 * `integrity.json` SHA-256 checksums if present and promoting templates into an
 * editable `adudir-motion-project/2` folder without modifying the source `.motion`.
 */
export async function unpackMotionArchive(
  motionZipPath: string,
  targetDir: string,
): Promise<{ kind: ParsedManifest['kind']; verifiedFiles: number }> {
  const buf = readFileSync(motionZipPath);
  const zip = await JSZip.loadAsync(buf);

  const manifestEntry = zip.file('motion.json');
  if (!manifestEntry) {
    throw new Error('Archive is not a valid .motion package: missing root motion.json');
  }
  const parsed = parseMotionManifest(await manifestEntry.async('string'));

  // Verify integrity.json if present
  let verifiedFiles = 0;
  const integrityEntry = zip.file('integrity.json');
  if (integrityEntry) {
    const integrity = JSON.parse(await integrityEntry.async('string')) as Record<string, string>;
    for (const [relPath, expectedHash] of Object.entries(integrity)) {
      const f = zip.file(relPath);
      if (!f) throw new Error(`integrity.json lists missing file "${relPath}"`);
      const actualHash = sha256Buffer(await f.async('nodebuffer'));
      if (actualHash !== expectedHash) {
        throw new Error(`SHA-256 mismatch for "${relPath}" (expected ${expectedHash}, got ${actualHash})`);
      }
      verifiedFiles += 1;
    }
  }

  mkdirSync(targetDir, { recursive: true });
  for (const [relPath, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const dest = join(targetDir, relPath);
    mkdirSync(join(dest, '..'), { recursive: true });
    writeFileSync(dest, await entry.async('nodebuffer'));
  }

  // If unpacking a page template, initialize an editable project wrapper
  if (parsed.kind === 'template' && !existsSync(join(targetDir, 'composition.html'))) {
    const tpl = parsed.manifest;
    const entryPage = tpl.runtime.entry ?? 'index.html';
    const doc: CompositionDoc = {
      viewport: { width: tpl.output.width, height: tpl.output.height },
      fps: tpl.output.fps.num / tpl.output.fps.den,
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
              overrides: [],
              passthroughAttrs: {},
            },
          ],
        },
      ],
    };
    writeFileSync(join(targetDir, 'composition.html'), serializeComposition(doc), 'utf8');
    const projManifest = createProjectManifest({
      id: `${tpl.template.id}-${Date.now()}`,
      name: tpl.template.name,
      width: tpl.output.width,
      height: tpl.output.height,
      fps: tpl.output.fps.num / tpl.output.fps.den,
      source: {
        kind: 'motiongit-template',
        template: tpl.template.id,
        version: tpl.template.version,
        entry: entryPage,
      },
    });
    writeFileSync(join(targetDir, 'motion.json'), `${JSON.stringify(projManifest, null, 2)}\n`, 'utf8');
  }

  return { kind: parsed.kind, verifiedFiles };
}

function walkFiles(dir: string, root: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === '.open-director' || name === '.git' || name === 'node_modules' || name === '.DS_Store') {
      continue;
    }
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkFiles(full, root, out);
    else if (st.isFile() && name !== 'integrity.json') {
      out.push(relative(root, full).replace(/\\/g, '/'));
    }
  }
}

/**
 * Pack a project directory into a `.motion` ZIP archive with SHA-256 `integrity.json`.
 */
export async function packMotionArchive(projectDir: string, outMotionZipPath: string): Promise<{ fileCount: number }> {
  const report = await validateProject(projectDir);
  if (!report.valid) {
    throw new Error(`Cannot pack invalid project: ${report.errors.join('; ')}`);
  }

  const files: string[] = [];
  walkFiles(projectDir, projectDir, files);
  files.sort();

  const zip = new JSZip();
  const integrity: Record<string, string> = {};
  for (const rel of files) {
    const data = readFileSync(join(projectDir, rel));
    integrity[rel] = sha256Buffer(data);
    zip.file(rel, data);
  }
  zip.file('integrity.json', `${JSON.stringify(integrity, null, 2)}\n`);

  const outBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  mkdirSync(join(outMotionZipPath, '..'), { recursive: true });
  writeFileSync(outMotionZipPath, outBuf);
  return { fileCount: files.length + 1 };
}

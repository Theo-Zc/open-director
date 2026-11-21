import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import {
  parseComposition,
  parseCuesFile,
  parseVtt,
  resolveCues,
  type BeatsFile,
  type ParamDecl,
  type ParsedVtt,
} from '@open-director/protocol';
import { buildStageHtml } from './composer.js';
import { computeCompositionDuration, probeProjectMedia } from './media.js';
import { startProjectServer } from './server.js';

export interface FrameInspectionWarning {
  samples: Array<{ clipId: string; hint: string }>;
  overflows: Array<{ clipId: string; text: string }>;
}

export interface CapturedFrame {
  timeSec: number;
  png: Buffer;
  warnings: FrameInspectionWarning;
  errors: string[];
}

export function findBrowserExecutable(): string | undefined {
  const fromEnv = process.env.OPEN_DIRECTOR_BROWSER;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

export async function launchDeterministicBrowser(): Promise<Browser> {
  const executablePath = findBrowserExecutable();
  return chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: [
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
}

async function prepareStageContext(projectDir: string) {
  const compPath = join(projectDir, 'composition.html');
  const html = await import('node:fs/promises').then((fs) => fs.readFile(compPath, 'utf8'));
  const doc = parseComposition(html);
  const mediaInfo = await probeProjectMedia(projectDir, doc);

  const cuesPath = join(projectDir, 'cues.json');
  let resolvedCueTimes: Record<string, number | undefined> = {};
  if (existsSync(cuesPath)) {
    const rawCues = readFileSync(cuesPath, 'utf8');
    const cuesFile = parseCuesFile(rawCues);
    const intrinsic = new Map<string, number>();
    for (const [k, info] of mediaInfo.entries()) intrinsic.set(k, info.durationSec);
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
    for (const [name, r] of Object.entries(resolved)) {
      resolvedCueTimes[name] = r.filmSec;
    }
  }

  const pageDurations = new Map<string, number>();
  const totalDuration = computeCompositionDuration(doc, mediaInfo, pageDurations);
  const stageHtml = buildStageHtml(doc, mediaInfo, totalDuration);

  const server = await startProjectServer(projectDir, {
    clockConfig: { cues: resolvedCueTimes },
    stageHtmlProvider: async () => stageHtml,
  });

  return { doc, mediaInfo, totalDuration, server };
}

export async function openStagePage(
  browser: Browser,
  origin: string,
  width: number,
  height: number,
  deviceScaleFactor = 1,
): Promise<{ page: Page; errors: string[] }> {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('requestfailed', (req) => {
    errors.push(`requestfailed: ${req.url()} (${req.failure()?.errorText ?? 'unknown'})`);
  });

  await page.goto(`${origin}/__film/stage.html`, { waitUntil: 'load' });
  await page.evaluate(async () => {
    await (window as unknown as { __openDirectorStage: { ready: Promise<void> } }).__openDirectorStage.ready;
  });
  return { page, errors };
}

/**
 * Capture deterministic PNG frames of a project's composition at specific timestamps (seconds).
 */
export async function captureProjectFrames(
  projectDir: string,
  timesSec: number[],
  options: { scale?: number } = {},
): Promise<{ width: number; height: number; frames: CapturedFrame[] }> {
  const { doc, server } = await prepareStageContext(projectDir);
  const browser = await launchDeterministicBrowser();
  try {
    const { page, errors } = await openStagePage(
      browser,
      server.origin,
      doc.viewport.width,
      doc.viewport.height,
      options.scale ?? 1,
    );

    const frames: CapturedFrame[] = [];
    for (const t of timesSec) {
      const warnings = await page.evaluate(async (time) => {
        const st = (
          window as unknown as {
            __openDirectorStage: {
              renderAtTime(t: number): Promise<void>;
              inspectCurrentWarnings(): FrameInspectionWarning;
            };
          }
        ).__openDirectorStage;
        await st.renderAtTime(time);
        return st.inspectCurrentWarnings();
      }, t);
      const png = await page.screenshot({ type: 'png' });
      frames.push({ timeSec: t, png, warnings, errors: [...errors] });
    }
    return { width: doc.viewport.width, height: doc.viewport.height, frames };
  } finally {
    await browser.close();
    await server.close();
  }
}

/**
 * Verify that a standalone `window.film` page is deterministic by rendering time `t`
 * twice (after scrubbing through another timestamp in between) and comparing pixel bytes.
 */
export async function verifyPageDeterminism(
  projectDir: string,
  pageRelPath: string,
  t = 1.0,
): Promise<{ deterministic: boolean; byteLengthA: number; byteLengthB: number }> {
  const server = await startProjectServer(projectDir);
  const browser = await launchDeterministicBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const cleanRel = pageRelPath.replace(/^\/+/, '');
    await page.goto(`${server.origin}/${cleanRel}?__film_host=1`, { waitUntil: 'load' });
    await page.waitForFunction(() => Boolean((window as unknown as { film?: unknown }).film), null, { timeout: 10_000 });
    await page.evaluate(async () => {
      const w = window as unknown as { film: { ready?: Promise<unknown> | (() => Promise<unknown>) } };
      const r = typeof w.film.ready === 'function' ? w.film.ready() : w.film.ready;
      if (r) await r;
    });

    const render = async (time: number) => {
      await page.evaluate(async (ts) => {
        const w = window as unknown as {
          filmHost: { time(t: number): void; settle(t: number): void };
          film: { frame(t: number): Promise<unknown> | unknown };
        };
        w.filmHost.time(ts);
        await w.film.frame(ts);
        w.filmHost.settle(ts);
      }, time);
      return page.screenshot({ type: 'png' });
    };

    const shotA = await render(t);
    await render(t + 1.37);
    const shotB = await render(t);
    return {
      deterministic: Buffer.compare(shotA, shotB) === 0,
      byteLengthA: shotA.byteLength,
      byteLengthB: shotB.byteLength,
    };
  } finally {
    await browser.close();
    await server.close();
  }
}

export interface PageSfxDecl {
  at: number;
  id?: string;
  src?: string;
  gain?: number;
  pan?: number;
  label?: string;
}

/**
 * Headlessly inspect a page's `window.film.params`, `film.sfx`, and `duration`.
 */
export async function readPageMetadata(
  projectDir: string,
  pageRelPath: string,
): Promise<{ duration?: number; width?: number; height?: number; params: Record<string, ParamDecl>; sfx: PageSfxDecl[] }> {
  const server = await startProjectServer(projectDir);
  const browser = await launchDeterministicBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const cleanRel = pageRelPath.replace(/^\/+/, '');
    await page.goto(`${server.origin}/${cleanRel}?__film_host=1`, { waitUntil: 'load' });
    await page.waitForFunction(() => Boolean((window as unknown as { film?: unknown }).film), null, { timeout: 10_000 });
    return await page.evaluate(() => {
      const film = (window as unknown as {
        film: { duration?: number; width?: number; height?: number; params?: Record<string, ParamDecl>; sfx?: PageSfxDecl[] };
      }).film;
      return {
        duration: typeof film.duration === 'number' ? film.duration : undefined,
        width: typeof film.width === 'number' ? film.width : undefined,
        height: typeof film.height === 'number' ? film.height : undefined,
        params: film.params && typeof film.params === 'object' ? film.params : {},
        sfx: Array.isArray(film.sfx) ? film.sfx : [],
      };
    });
  } finally {
    await browser.close();
    await server.close();
  }
}

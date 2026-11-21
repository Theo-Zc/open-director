import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectManifest } from '@open-director/protocol';
import {
  auditProject,
  captureProjectFrames,
  computeFrameDhash,
  discoverTemplates,
  exportProjectVideo,
  extractBeatOnsets,
  getFfmpegPath,
  instantiateTemplate,
  measureAudioLoudness,
  packMotionArchive,
  probeMedia,
  readPageMetadata,
  unpackMotionArchive,
  validateProject,
  verifyPageDeterminism,
} from '../dist/index.js';

function createTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'od-engine-'));
  mkdirSync(join(dir, 'scenes'), { recursive: true });
  mkdirSync(join(dir, 'assets'), { recursive: true });

  // Synthesize a 1.5s 440Hz sine WAV clip using bundled ffmpeg
  execFileSync(getFfmpegPath(), [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1.5',
    '-c:a',
    'pcm_s16le',
    join(dir, 'assets', 'tone.wav'),
  ]);

  const manifest = createProjectManifest({
    id: 'test-proj',
    name: 'Engine Test',
    width: 640,
    height: 360,
    fps: 24,
  });
  writeFileSync(join(dir, 'motion.json'), JSON.stringify(manifest, null, 2), 'utf8');

  writeFileSync(
    join(dir, 'scenes', 'card.html'),
    `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; width: 100%; height: 100%; background: #10141e; color: #fff; font-family: sans-serif; display: flex; align-items: center; justify-content: center; }
  #box { padding: 24px 36px; border-radius: 16px; border: 3px solid var(--accent); text-align: center; }
  #badge { margin-top: 12px; font-size: 14px; opacity: 0.85; }
</style>
</head>
<body>
  <div id="box">
    <h1 id="title">Title</h1>
    <div id="badge" data-film-sample="示例标签">Sample</div>
  </div>
  <script type="module">
    import { useParams } from './__film/film-params.mjs';
    import { spring, ease } from './__film/motion-primitives.mjs';
    const titleEl = document.getElementById('title');
    const boxEl = document.getElementById('box');
    window.film = {
      duration: 1.0,
      sfx: [{ at: 0.25, id: 'pop_soft', gain: -3, pan: -0.25, label: 'Pop' }],
      params: {
        accent: { type: 'color', default: '#2fd3b4', label: 'Accent' },
        headline: { type: 'text', default: 'Default Heading', label: 'Headline' },
      },
      frame(t) {
        titleEl.textContent = param('headline');
        const jitter = Math.round(Math.random() * 1000);
        const y = Math.round((1 - spring(t, { stiffness: 220, damping: 20 })) * 20 * ease.outCubic(Math.min(1, t / 0.5)));
        boxEl.dataset.tick = String(Math.round(performance.now())) + ':' + jitter;
        boxEl.style.transform = 'translateY(' + y + 'px)';
      },
    };
    const param = useParams(window.film);
  </script>
</body>
</html>
`,
    'utf8',
  );

  writeFileSync(
    join(dir, 'composition.html'),
    `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=640, height=360">
  <meta name="film-fps" content="24">
</head>
<body>
  <section id="visual">
    <iframe id="card" src="scenes/card.html#t=0,1.0" at="0" overrides='[{"at":":root","style":{"--accent":"#ff6b35","--headline":"\\"Deterministic Render\\""}}]' ></iframe>
  </section>
  <section id="audio">
    <audio id="tone" src="assets/tone.wav#t=0,1.0" at="0" volume="0.6" data-adudir-duck='{"duckDb":-10}' overrides='[{"fade":[0.1,0.1]}]'></audio>
  </section>
</body>
</html>
`,
    'utf8',
  );

  return dir;
}

test('engine validates, captures deterministic frames, packs/unpacks .motion, and exports MP4', async () => {
  const dir = createTempProject();
  const unpackDir = mkdtempSync(join(tmpdir(), 'od-unpack-'));
  try {
    const report = await validateProject(dir);
    assert.equal(report.valid, true, report.errors.join(', '));
    assert.equal(report.fps, 24);
    assert.equal(report.durationSec, 1.0);

    const meta = await readPageMetadata(dir, 'scenes/card.html');
    assert.equal(meta.duration, 1.0);
    assert.equal(meta.params.accent?.type, 'color');
    assert.equal(meta.sfx.length, 1);
    assert.equal(meta.sfx[0].id, 'pop_soft');

    const det = await verifyPageDeterminism(dir, 'scenes/card.html', 0.42);
    assert.equal(det.deterministic, true);

    const look = await captureProjectFrames(dir, [0.25, 0.75]);
    assert.equal(look.frames.length, 2);
    assert.ok(look.frames[0].png.byteLength > 1000);
    assert.equal(look.frames[0].warnings.samples.length, 1);
    assert.equal(look.frames[0].warnings.samples[0].hint, '示例标签');

    const zipPath = join(dir, 'bundle.motion');
    const packed = await packMotionArchive(dir, zipPath);
    assert.ok(packed.fileCount >= 3);
    assert.ok(existsSync(zipPath));

    const unpacked = await unpackMotionArchive(zipPath, unpackDir);
    assert.equal(unpacked.kind, 'project');
    assert.ok(unpacked.verifiedFiles >= 3);

    const mp4Path = join(dir, 'out.mp4');
    const exported = await exportProjectVideo(dir, mp4Path, { fps: 12 });
    assert.ok(existsSync(mp4Path));
    assert.equal(exported.totalFrames, 12);
    assert.equal(exported.audioClipCount, 2); // tone.wav + pop_soft from film.sfx
    assert.deepEqual(exported.errors, []);

    const probed = await probeMedia(mp4Path);
    assert.equal(probed.hasVideo, true);
    assert.equal(probed.hasAudio, true);
    assert.equal(probed.width, 640);
    assert.equal(probed.height, 360);
    assert.ok(probed.durationSec >= 0.8);

    const loudness = await measureAudioLoudness(join(dir, 'assets', 'tone.wav'));
    assert.ok(Number.isFinite(loudness.measuredLufs));
    const beats = await extractBeatOnsets(join(dir, 'assets', 'tone.wav'));
    assert.ok((beats.bpm ?? 0) > 0);
    const dhash = await computeFrameDhash(mp4Path, 0.1);
    assert.ok(/^\d+$/.test(dhash));
    const audit = await auditProject(dir);
    assert.ok(audit.samples.length >= 1);
    assert.equal(audit.audioLoudness.length, 1);

    // Verify all 3 built-in templates can be discovered and instantiated cleanly
    const templatesDir = join(process.cwd(), '..', '..', 'templates');
    const templates = discoverTemplates(templatesDir);
    assert.equal(templates.length, 3);
    for (const tpl of templates) {
      const tplInstDir = mkdtempSync(join(tmpdir(), `od-tpl-${tpl.id}-`));
      try {
        instantiateTemplate(tpl.dir, tplInstDir, { projectName: `Inst ${tpl.id}` });
        const tplLook = await captureProjectFrames(tplInstDir, [1.0], { scale: 0.25 });
        assert.deepEqual(tplLook.frames[0].errors, []);
      } finally {
        rmSync(tplInstDir, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(unpackDir, { recursive: true, force: true });
  }
});

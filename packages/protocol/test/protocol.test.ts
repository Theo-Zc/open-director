import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyEditOps,
  commitProjectEdit,
  createProjectManifest,
  exportFcpxml,
  formatCombinedSrt,
  formatCombinedVtt,
  mapVttToClip,
  parseComposition,
  parseCuesFile,
  parseMotionManifest,
  parseVtt,
  resolveCues,
  serializeComposition,
  undoProjectEdit,
} from '../dist/index.js';

const SAMPLE_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=1080, height=1920">
  <meta name="film-fps" content="60">
  <style>
    .card { border-radius: 24px; object-fit: cover; }
  </style>
</head>
<body>
  <section id="overlay">
    <iframe id="title" src="scenes/title.html#t=0,4" at="0.5" overrides='[{"at":":root","style":{"--accent":"#00e0ff"}},{"at":"#headline","text":"Hello World"}]'></iframe>
  </section>
  <section id="main">
    <video id="talk" src="assets/a.mp4#t=2,10" at="0" speed="1" volume="0.9" class="card" style="left: 40px; top: 80px; width: 1000px; height: 600px" overrides='[{"fade":[0.25,0.5]}]'></video>
  </section>
</body>
</html>
`;

test('parseMotionManifest supports project and template manifests', () => {
  const proj = createProjectManifest({ id: 'p1', name: 'Demo', width: 1280, height: 720, fps: 30 });
  const parsed = parseMotionManifest(JSON.stringify(proj));
  assert.equal(parsed.kind, 'project');
  assert.equal(parsed.manifest.project.name, 'Demo');

  const tpl = parseMotionManifest(
    JSON.stringify({
      format: 'motiongit-template',
      specVersion: '0.1.0-draft.1',
      template: { id: 't1', version: '1.0.0', name: 'Sample' },
      runtime: { profile: 'adudir.page/1', entry: 'src/index.html' },
      output: { width: 1920, height: 1080, fps: { num: 60, den: 1 } },
    }),
  );
  assert.equal(tpl.kind, 'template');
  assert.equal(tpl.manifest.runtime.entry, 'src/index.html');
});

test('parseComposition and serializeComposition round-trip faithfully', () => {
  const doc = parseComposition(SAMPLE_HTML);
  assert.equal(doc.viewport.width, 1080);
  assert.equal(doc.viewport.height, 1920);
  assert.equal(doc.fps, 60);
  assert.equal(doc.tracks.length, 2);
  assert.equal(doc.tracks[0].clips[0].id, 'title');
  assert.equal(doc.tracks[1].clips[0].speed, 1);

  const roundTripped = serializeComposition(doc);
  const reparsed = parseComposition(roundTripped);
  assert.deepEqual(reparsed.tracks, doc.tracks);
});

test('parseComposition rejects forbidden CSS properties and overlapping clips', () => {
  assert.throws(
    () =>
      parseComposition(`<!doctype html><html><body><section>
        <img id="bad" src="a.png#t=0,2" style="position: absolute; left: 10px">
      </section></body></html>`),
    /cannot set "position"/,
  );

  assert.throws(
    () =>
      parseComposition(`<!doctype html><html><body><section>
        <img id="a" src="a.png#t=0,3" at="0">
        <img id="b" src="b.png#t=0,2" at="2.5">
      </section></body></html>`),
    /overlap on track 0/,
  );
});

test('applyEditOps validates locked tracks and supports atomic commit + undo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'od-proto-'));
  try {
    writeFileSync(join(dir, 'composition.html'), SAMPLE_HTML, 'utf8');

    const { doc: updated } = commitProjectEdit(
      dir,
      [
        { op: 'param', clip: 'title', name: 'accent', value: '#ff5500' },
        { op: 'move', clip: 'title', at: 1.25 },
        { op: 'fade', clip: 'talk', in: 0.4, out: 0.6 },
      ],
      { why: 'adjust title timing and accent color', author: 'agent' },
    );

    assert.equal(updated.tracks[0].clips[0].at, 1.25);

    // Locked track cannot be mutated by agent
    const lockedDoc = structuredClone(updated);
    lockedDoc.tracks[0].locked = true;
    assert.throws(
      () => applyEditOps(lockedDoc, [{ op: 'move', clip: 'title', at: 2 }], { author: 'agent' }),
      /locked/,
    );

    const { doc: reverted } = undoProjectEdit(dir);
    assert.equal(reverted.tracks[0].clips[0].at, 0.5);
    assert.ok(readFileSync(join(dir, 'composition.html'), 'utf8').includes('#00e0ff'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('VTT and cues.json resolve word and clip-edge anchors accurately', () => {
  const vtt = parseVtt(`WEBVTT

00:00:01.000 --> 00:00:05.000
<v Host><00:00:01.200>hello <00:00:02.500>motion <00:00:04.000>world
`);
  const doc = parseComposition(SAMPLE_HTML);
  const mapped = mapVttToClip(vtt, { id: 'talk', at: 0, inSec: 2, outSec: 10, speed: 2 });
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].startSec, 0);
  assert.equal(mapped[0].endSec, 1.5);

  const cues = parseCuesFile(
    JSON.stringify({
      cues: {
        hit: { word: 'motion', clip: 'talk' },
        titleEnd: { clip: 'title', edge: 'end', offset: 0.5 },
      },
    }),
  );
  // talk plays #t=2,10 at at=0 speed=1, so "motion" at 2.5s in source => 0.5s in film
  const resolved = resolveCues(cues, doc, new Map([['assets/a.mp4', vtt]]));
  assert.equal(resolved.hit.status, 'ok');
  assert.equal(resolved.hit.filmSec, 0.5);
  assert.equal(resolved.titleEnd.filmSec, 5.0);
});

test('split, attr, bar/beat cues, SRT/VTT export, and FCPXML generation work cleanly', () => {
  const doc = parseComposition(SAMPLE_HTML);
  const splitRes = applyEditOps(doc, [
    { op: 'split', clip: 'talk', atFilmSec: 3.0 },
    { op: 'attr', clip: 'talk', name: 'data-adudir-duck', value: '{"duckDb":-12}' },
  ]);
  assert.equal(splitRes.nextDoc.tracks[1].clips.length, 2);
  assert.equal(splitRes.nextDoc.tracks[1].clips[0].outSec, 5);
  assert.equal(splitRes.nextDoc.tracks[1].clips[1].id, 'talk_2');
  assert.equal(splitRes.nextDoc.tracks[1].clips[1].at, 3);
  assert.equal(splitRes.nextDoc.tracks[1].clips[1].inSec, 5);
  assert.ok(splitRes.affectedClipIds.includes('talk_2'));

  const cues = parseCuesFile(JSON.stringify({ cues: { drop: { bar: 2, beat: 1, clip: 'talk' } } }));
  const beats = new Map([['assets/a.mp4', { bpm: 120, beatsPerBar: 4, beats: [0, 0.5, 1, 1.5, 2.5, 3, 3.5, 4] }]]);
  const barRes = resolveCues(cues, splitRes.nextDoc, new Map(), new Map(), beats);
  // bar 2 beat 1 = index 4 = 2.5s in source; talk inSec=2 => filmSec = 0 + (2.5 - 2) = 0.5
  assert.equal(barRes.drop.filmSec, 0.5);

  const srt = formatCombinedSrt([{ clipId: 'talk', startSec: 0.2, endSec: 1.5, text: 'Hello' }]);
  assert.ok(srt.includes('00:00:00,200 --> 00:00:01,500'));
  const vttOut = formatCombinedVtt([{ clipId: 'talk', startSec: 0.2, endSec: 1.5, voice: 'Host', text: 'Hello' }]);
  assert.ok(vttOut.includes('<v Host>Hello'));

  const xml = exportFcpxml(splitRes.nextDoc, { projectName: 'Test Film', fps: 60 });
  assert.ok(xml.includes('<fcpxml version="1.10">'));
  assert.ok(xml.includes('name="talk_2"'));
});

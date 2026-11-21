import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectManifest } from '@open-director/protocol';
import { getFfmpegPath } from '@open-director/engine';
import { startStudioServer } from '../dist/index.js';

test('studio-server serves snapshot, applies edit, undoes, exports FCPXML/SRT, and runs local agent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'od-studio-'));
  const instTarget = mkdtempSync(join(tmpdir(), 'od-studio-tpl-'));
  mkdirSync(join(dir, 'scenes'), { recursive: true });
  mkdirSync(join(dir, 'assets'), { recursive: true });

  execFileSync(getFfmpegPath(), [
    '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2.0',
    '-c:a', 'pcm_s16le', join(dir, 'assets', 'vo.wav'),
  ]);
  writeFileSync(join(dir, 'assets', 'vo.vtt'), 'WEBVTT\n\n00:00:00.200 --> 00:00:01.500\nHello Studio\n', 'utf8');
  writeFileSync(
    join(dir, 'motion.json'),
    JSON.stringify(createProjectManifest({ id: 's1', name: 'Studio Test' }), null, 2),
    'utf8',
  );
  writeFileSync(
    join(dir, 'scenes', 'main.html'),
    `<!doctype html><html><body><script>window.film={duration:2,params:{accent:{type:'color',default:'#112233'}},frame(){}}</script></body></html>`,
    'utf8',
  );
  writeFileSync(
    join(dir, 'composition.html'),
    `<!doctype html><html><body><section><iframe id="main" src="scenes/main.html#t=0,2" at="0"></iframe></section><section><audio id="vo" src="assets/vo.wav#t=0,2" at="0"></audio></section></body></html>`,
    'utf8',
  );

  const handle = await startStudioServer({
    projectDir: dir,
    port: 0,
    templatesRoot: join(process.cwd(), '..', '..', 'templates'),
  });
  try {
    const health = await fetch(`${handle.origin}/api/health`).then((r) => r.json() as Promise<{ ok: boolean }>);
    assert.equal(health.ok, true);

    const proj = await fetch(`${handle.origin}/api/project`).then((r) => r.json() as Promise<{ durationSec: number; doc: { tracks: Array<{ clips: Array<{ at: number }> }> } }>);
    assert.equal(proj.durationSec, 2);
    assert.equal(proj.doc.tracks[0].clips[0].at, 0);

    const editRes = await fetch(`${handle.origin}/api/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ why: 'shift start', ops: [{ op: 'move', clip: 'main', at: 0.5 }] }),
    }).then((r) => r.json() as Promise<{ ok: boolean; snapshot: { doc: { tracks: Array<{ clips: Array<{ at: number }> }> } } }>);
    assert.equal(editRes.ok, true);
    assert.equal(editRes.snapshot.doc.tracks[0].clips[0].at, 0.5);

    const undoRes = await fetch(`${handle.origin}/api/undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).then((r) => r.json() as Promise<{ ok: boolean; snapshot: { doc: { tracks: Array<{ clips: Array<{ at: number }> }> } } }>);
    assert.equal(undoRes.ok, true);
    assert.equal(undoRes.snapshot.doc.tracks[0].clips[0].at, 0);

    const fcpxml = await fetch(`${handle.origin}/api/export/fcpxml`).then((r) => r.text());
    assert.ok(fcpxml.includes('<fcpxml version="1.10">'));

    const srt = await fetch(`${handle.origin}/api/export/subtitles?format=srt`).then((r) => r.text());
    assert.ok(srt.includes('Hello Studio'));

    const loudRes = await fetch(`${handle.origin}/api/audio/match-loudness`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apply: true }),
    }).then((r) => r.json() as Promise<{ plans: Array<{ targetLufs: number }> }>);
    assert.equal(loudRes.plans[0].targetLufs, -18);

    const agentRes = await fetch(`${handle.origin}/api/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '把强调色改成紫色', currentTime: 0.5 }),
    }).then((r) => r.json() as Promise<{ changed: boolean }>);
    assert.equal(agentRes.changed, true);

    const tpls = await fetch(`${handle.origin}/api/templates`).then((r) => r.json() as Promise<{ templates: Array<{ id: string }> }>);
    assert.equal(tpls.templates.length, 3);

    const instRes = await fetch(`${handle.origin}/api/templates/instantiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: 'knowledge-cards', targetDir: instTarget }),
    }).then((r) => r.json() as Promise<{ ok: boolean; snapshot: { projectDir: string } }>);
    assert.equal(instRes.ok, true);
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(instTarget, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectManifest } from '@open-director/protocol';
import { createProjectTools } from '../dist/index.js';

test('MCP tools read status, apply atomic edit, and undo', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'od-mcp-'));
  try {
    mkdirSync(join(dir, 'scenes'), { recursive: true });
    writeFileSync(
      join(dir, 'motion.json'),
      JSON.stringify(createProjectManifest({ id: 'm1', name: 'MCP Test' }), null, 2),
      'utf8',
    );
    writeFileSync(
      join(dir, 'scenes', 'a.html'),
      `<!doctype html><html><body><script>window.film={duration:3,frame(){}}</script></body></html>`,
      'utf8',
    );
    writeFileSync(
      join(dir, 'composition.html'),
      `<!doctype html><html><body><section><iframe id="a" src="scenes/a.html#t=0,3" at="0"></iframe></section></body></html>`,
      'utf8',
    );

    const tools = new Map(createProjectTools().map((t) => [t.name, t]));
    const statusRes = await tools.get('project_status')!.run({}, dir);
    const statusJson = JSON.parse(statusRes.content[0].text!);
    assert.equal(statusJson.report.valid, true);

    await tools.get('edit_timeline')!.run(
      { why: 'shift intro', ops: [{ op: 'move', clip: 'a', at: 1.5 }] },
      dir,
    );
    const logRes = await tools.get('edit_log')!.run({}, dir);
    assert.equal(JSON.parse(logRes.content[0].text!).length, 1);

    await tools.get('undo_edit')!.run({}, dir);
    const compRes = await tools.get('read_composition')!.run({}, dir);
    assert.ok(!compRes.content[0].text!.includes('at=\\"1.5\\"'));

    const sfxRes = await tools.get('list_sfx')!.run({ query: 'pop' }, dir);
    assert.ok(JSON.parse(sfxRes.content[0].text!).length >= 1);

    const tplRes = await tools.get('list_templates')!.run({}, dir);
    assert.equal(JSON.parse(tplRes.content[0].text!).length, 3);

    const fcpRes = await tools.get('export_fcpxml')!.run({}, dir);
    assert.equal(JSON.parse(fcpRes.content[0].text!).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

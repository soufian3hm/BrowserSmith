'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fsp = require('node:fs/promises');
const p = require('../src/shared/protocol');
const w = require('../src/main/workspace');

test('parsePath accepts the shapes a model actually emits', () => {
  assert.equal(p.parsePath('src/utils/debounce.ts'), 'src/utils/debounce.ts');
  assert.equal(p.parsePath('```\nsrc/a.ts\n```'), 'src/a.ts');
  assert.equal(p.parsePath('- src/b.tsx'), 'src/b.tsx');
  assert.equal(p.parsePath('`index.js`'), 'index.js');
  assert.equal(p.parsePath('  README.md  '), 'README.md');
  assert.equal(p.parsePath('lib/deep/nested/file.test.ts'), 'lib/deep/nested/file.test.ts');
});

test('parsePath rejects prose so we never write a garbage filename', () => {
  assert.equal(p.parsePath('Sure! I think we should start with the main file.'), null);
  assert.equal(p.parsePath(''), null);
  assert.equal(p.parsePath('no extension here'), null);
});

test('parsePath recognises the DONE sentinel', () => {
  assert.equal(p.parsePath('DONE'), 'DONE');
  assert.equal(p.parsePath('  done. '), 'DONE');
  assert.equal(p.parsePath('**DONE**'), 'DONE');
});

test('parseVerdict is strict about the one-word contract', () => {
  assert.equal(p.parseVerdict('PRINT'), 'PRINT');
  assert.equal(p.parseVerdict(' retry '), 'RETRY');
  assert.equal(p.parseVerdict('PRINT.'), 'PRINT');
  assert.equal(p.parseVerdict('maybe looks fine'), null);
  assert.equal(p.parseVerdict(''), null);
});

test('unfence strips exactly one code fence', () => {
  assert.equal(p.unfence('```ts\nconst x = 1\n```'), 'const x = 1');
  assert.equal(p.unfence('```\nplain\n```'), 'plain');
  assert.equal(p.unfence('no fence'), 'no fence');
  // Inner fences inside a document must survive.
  assert.ok(p.unfence('```md\n# hi\n```js\nx\n```\n```').includes('```js'));
});

test('slug makes a safe single directory segment', () => {
  assert.equal(p.slug('My Cool Tool'), 'my-cool-tool');
  assert.equal(p.slug('../../etc/passwd'), 'etc-passwd');
  assert.equal(p.slug('!!!'), 'untitled');
  assert.equal(p.slug(''), 'untitled');
  assert.ok(!p.slug('a'.repeat(200)).includes('/'));
  assert.ok(p.slug('a'.repeat(200)).length <= 48);
});

test('workspace confines every path, including hostile ones', () => {
  const escapes = [
    '../../evil.txt',
    '../outside.js',
    '/etc/passwd',
    'C:/Windows/System32/x.dll',
    'a/../../../b.txt',
    '....//....//x',
  ];
  for (const bad of escapes) {
    let full = null;
    try { full = w.resolveSafe(bad); } catch { continue; } // rejected outright: fine
    assert.ok(
      full === w.ROOT || full.startsWith(w.ROOT + path.sep),
      `escaped workspace: ${bad} -> ${full}`
    );
  }
  assert.throws(() => w.resolveSafe(''), /empty path/);
});

test('workspace writes, reads and lists inside a project folder', async (t) => {
  const proj = 'test-proj-' + process.pid;
  t.after(() => fsp.rm(path.join(w.ROOT, proj), { recursive: true, force: true }));

  const res = await w.writeFile(`${proj}/src/index.ts`, 'export const x = 1\n');
  assert.equal(res.rel, `${proj}/src/index.ts`);
  assert.equal(await w.readFile(`${proj}/src/index.ts`), 'export const x = 1\n');
  assert.ok((await w.list()).includes(`${proj}/src/index.ts`));
});

test('every protocol helper the renderer uses is exposed on the bridge', async () => {
  // contextBridge re-exports protocol field by field, so adding a helper to
  // protocol.js without adding it here fails only at runtime, mid-run. Catch it.
  const bridge = await fsp.readFile(
    path.join(__dirname, '..', 'src', 'main', 'preload-control.js'), 'utf8'
  );
  const renderer = await fsp.readFile(
    path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8'
  );

  const used = new Set([...renderer.matchAll(/protocol\.(\w+)/g)].map((m) => m[1]));
  for (const name of used) {
    assert.ok(
      new RegExp(`\\b${name}\\b`).test(bridge),
      `renderer uses protocol.${name} but preload-control.js does not expose it`
    );
  }

  const tags = new Set([...renderer.matchAll(/protocol\.TAGS\.(\w+)/g)].map((m) => m[1]));
  for (const t of tags) {
    assert.ok(
      new RegExp(`${t}:\\s*protocol\\.TAGS\\.${t}`).test(bridge),
      `renderer uses TAGS.${t} but the bridge does not forward it`
    );
  }
  assert.ok(used.size > 3, 'sanity: expected the renderer to use several helpers');
});

test('a full planner/builder exchange parses end to end', () => {
  // Simulated replies in the exact shape the tabs return them.
  const pathReply = '```\nsrc/debounce.ts\n```';
  const buildReply = '```typescript\nexport const debounce = () => {}\n```';
  const verdictReply = 'PRINT';
  const nextReply = 'DONE';

  const file = p.parsePath(pathReply);
  assert.equal(file, 'src/debounce.ts');
  const body = p.unfence(buildReply);
  assert.equal(body, 'export const debounce = () => {}');
  assert.equal(p.parseVerdict(verdictReply), 'PRINT');
  assert.equal(p.parsePath(nextReply), 'DONE');

  const full = `${p.slug('My Tool')}/${file}`;
  assert.ok(w.resolveSafe(full).startsWith(w.ROOT + path.sep));
});

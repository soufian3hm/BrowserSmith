'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fsp = require('node:fs/promises');
const p = require('../src/shared/protocol');
const w = require('../src/main/workspace');

const MODE_KEYS = ['auto', 'nextjs', 'vite', 'static', 'node', 'python'];

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

test('parseAudit: DONE means finished, anything else is one short missing line', () => {
  assert.equal(p.parseAudit('DONE'), null);
  assert.equal(p.parseAudit('  done. '), null);
  assert.equal(p.parseAudit('**DONE**'), null);
  assert.equal(p.parseAudit('```\nDONE\n```'), null);
  assert.equal(
    p.parseAudit('missing a README explaining usage'),
    'missing a README explaining usage'
  );
  // Streaming placeholders must not be mistaken for the verdict line.
  assert.equal(
    p.parseAudit('Thinking...\nstyles.css is linked from index.html but never written'),
    'styles.css is linked from index.html but never written'
  );
  // Only the first substantive line matters, capped at 200 chars.
  assert.equal(p.parseAudit('needs a nav\nand also lots more prose'), 'needs a nav');
  assert.ok((p.parseAudit('x'.repeat(500)) || '').length <= 200);
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

test('MODES carries exactly the contract entries and fields', () => {
  assert.deepEqual(Object.keys(p.MODES).sort(), [...MODE_KEYS].sort());
  for (const key of MODE_KEYS) {
    const m = p.MODES[key];
    assert.equal(m.key, key);
    assert.ok(typeof m.label === 'string' && m.label.length > 0, `${key}.label`);
    assert.equal(typeof m.scaffold, 'boolean', `${key}.scaffold`);
    assert.ok(
      m.devScript === null || (typeof m.devScript === 'string' && m.devScript.length > 0),
      `${key}.devScript`
    );
    assert.ok(m.previews === 'browser' || m.previews === 'run', `${key}.previews`);
    assert.ok(typeof m.hint === 'string' && m.hint.length > 10, `${key}.hint`);
  }
  // The exact values the toolchain and renderer rely on.
  assert.deepEqual(
    MODE_KEYS.map((k) => [k, p.MODES[k].scaffold, p.MODES[k].devScript, p.MODES[k].previews]),
    [
      ['auto', false, null, 'browser'],
      ['nextjs', true, 'dev', 'browser'],
      ['vite', true, 'dev', 'browser'],
      ['static', false, null, 'browser'],
      ['node', true, null, 'run'],
      ['python', true, null, 'run'],
    ]
  );
});

test('systems() returns four substantial role prompts for every mode', () => {
  for (const key of [...MODE_KEYS, 'bogus', undefined]) {
    const s = p.systems(key);
    for (const role of ['planner', 'builder', 'reviewer', 'auditor']) {
      assert.ok(
        typeof s[role] === 'string' && s[role].trim().length > 40,
        `systems(${key}).${role} must be a substantial prompt`
      );
    }
  }
  // Mode conventions must actually reach the prompts.
  assert.ok(p.systems('nextjs').planner.includes('app/page.tsx'));
  assert.ok(p.systems('python').builder.includes('main.py'));
  const rev = p.systems('static').reviewer;
  assert.ok(/PRINT/.test(rev) && /RETRY/.test(rev));
  assert.ok(/DONE/.test(p.systems('node').auditor));
});

test('TAGS embed the mode hint and a sample file from the existing list', () => {
  const mode = p.MODES.nextjs;
  const files = ['app/page.tsx', 'components/Nav.tsx'];

  const req = p.TAGS.request('make a blog', mode, files);
  assert.ok(req.includes('make a blog'));
  assert.ok(req.includes(mode.hint));
  assert.ok(req.includes('components/Nav.tsx'));

  const build = p.TAGS.build('app/blog/page.tsx', 'make a blog', mode, files);
  assert.ok(build.includes('PATH: app/blog/page.tsx'));
  assert.ok(build.includes(mode.hint));
  assert.ok(build.includes('components/Nav.tsx'));
  assert.ok(/Output only the complete contents of/.test(build));

  const next = p.TAGS.next(['app/page.tsx'], 'needs a nav', files);
  assert.ok(next.includes('app/page.tsx'));
  assert.ok(next.includes('needs a nav'));
  assert.ok(next.includes('components/Nav.tsx'));
  assert.ok(!p.TAGS.next([], '', files).includes('AUDITOR SAYS'));

  const audit = p.TAGS.audit('make a blog', ['app/page.tsx'], mode);
  assert.ok(audit.includes('make a blog'));
  assert.ok(audit.includes('app/page.tsx'));
  assert.ok(/definition of done/i.test(audit), 'audit must remind the mode definition-of-done');
  assert.ok(/DONE/.test(audit));
});

test('the rendered file list caps at 60 lines then summarises the rest', () => {
  const files = Array.from({ length: 65 }, (_, i) => `src/f${i}.ts`);
  const req = p.TAGS.request('big project', p.MODES.vite, files);
  assert.ok(req.includes('src/f59.ts'), '60th file still listed');
  assert.ok(!req.includes('src/f60.ts'), '61st file must be cut');
  assert.ok(req.includes('(+5 more)'));
  // Empty lists must not render a bare header.
  assert.ok(p.TAGS.request('x', p.MODES.auto, []).includes('(none yet)'));
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

test('the bridge exposes every contract protocol name the renderer needs', async () => {
  // contextBridge re-exports protocol field by field, so adding a helper to
  // protocol.js without exposing it there fails only at runtime, mid-run.
  // Read both sides of the seam at runtime so this guards the integrated tree.
  const bridge = await fsp.readFile(
    path.join(__dirname, '..', 'src', 'main', 'preload-control.js'), 'utf8'
  );
  const renderer = await fsp.readFile(
    path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8'
  );

  // The shared contract: protocol.js must export each name and
  // preload-control.js must forward it onto window.notioned.protocol.
  const contract = [
    'MODES', 'systems', 'TAGS',
    'parsePath', 'parseVerdict', 'parseAudit',
    'unfence', 'clean', 'slug', 'rejectReason',
  ];
  for (const name of contract) {
    assert.ok(name in p, `protocol.js does not export ${name}`);
    assert.ok(
      new RegExp(`\\b${name}\\b`).test(bridge),
      `preload-control.js does not expose protocol.${name}`
    );
  }
  for (const tag of ['request', 'build', 'review', 'next', 'audit']) {
    assert.equal(typeof p.TAGS[tag], 'function', `protocol.TAGS.${tag} missing`);
  }

  // And whatever the renderer actually calls must be on the bridge too.
  const used = new Set([...renderer.matchAll(/protocol\.(\w+)/g)].map((m) => m[1]));
  for (const name of used) {
    assert.ok(
      new RegExp(`\\b${name}\\b`).test(bridge),
      `renderer uses protocol.${name} but preload-control.js does not expose it`
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

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

/* ---------------------------------------------------------- extractBody */

test('extractBody (a): one fence wrapping the whole reply', () => {
  assert.equal(
    p.extractBody('```html\n<!DOCTYPE html>\n<h1>hi</h1>\n```', 'index.html'),
    '<!DOCTYPE html>\n<h1>hi</h1>\n'
  );
  assert.equal(p.extractBody('```\nplain\n```', 'a.txt'), 'plain\n');
  // A markdown file keeps its inner fences: there they are real content.
  assert.ok(p.extractBody('```md\n# Title\n\n```js\nx\n```\n```', 'README.md').includes('```js'));
});

test('extractBody (b): one file split across several fences is rejoined in order', () => {
  const reply =
    'Part 1:\n```html\n<!DOCTYPE html>\n<body>\n```\n' +
    'Part 2:\n```html\n<script>let x = 1</script>\n</body>\n```';
  assert.equal(
    p.extractBody(reply, 'index.html'),
    '<!DOCTYPE html>\n<body>\n<script>let x = 1</script>\n</body>\n'
  );
  // No fence markers may survive inside a non-markdown body.
  assert.ok(!p.extractBody(reply, 'index.html').includes('```'));
});

test('extractBody (c): prose around the fence is dropped', () => {
  const reply =
    "Sure! Here's the file you asked for:\n\n```js\nconst x = 1;\n```\n\nLet me know if you want more.";
  assert.equal(p.extractBody(reply, 'a.js'), 'const x = 1;\n');

  // An install snippet beside the real block must not be pasted into the file.
  const withSidecar =
    'First run:\n```bash\nnpm i\n```\nThen the file:\n```json\n{\n  "name": "x"\n}\n```';
  assert.equal(p.extractBody(withSidecar, 'package.json'), '{\n  "name": "x"\n}\n');

  // A stream cut off before the closing fence still yields what arrived.
  assert.equal(
    p.extractBody('```js\nconst x = 1;\nconst y =', 'a.js'),
    'const x = 1;\nconst y =\n'
  );

  // A fence carrying metadata is still a fence, not a line of the file.
  assert.equal(
    p.extractBody('Here:\n```jsx title="App.jsx"\nexport default App;\n```', 'App.jsx'),
    'export default App;\n'
  );
});

test('extractBody (d): no fences at all - salvage the code out of the prose', () => {
  const reply =
    'Sure! Here is index.html:\n' +
    '<!DOCTYPE html>\n<html>\n<body>hi</body>\n</html>\n' +
    'This creates a page with a body.\n' +
    'Let me know if you want styling.';
  assert.equal(
    p.extractBody(reply, 'index.html'),
    '<!DOCTYPE html>\n<html>\n<body>hi</body>\n</html>\n'
  );

  assert.equal(
    p.extractBody('Here you go:\nimport os\n\ndef main():\n    print("hi")', 'main.py'),
    'import os\n\ndef main():\n    print("hi")\n'
  );
  assert.equal(
    p.extractBody('The package manifest:\n{\n  "name": "x"\n}\nHope this helps!', 'package.json'),
    '{\n  "name": "x"\n}\n'
  );
  assert.equal(
    p.extractBody(
      'Here it is.\nbody { margin: 0; }\n.card { padding: 8px; }\nThis creates a card.',
      'style.css'
    ),
    'body { margin: 0; }\n.card { padding: 8px; }\n'
  );
  // A module docstring and a bare assignment are file content, not commentary.
  assert.equal(
    p.extractBody('Sure:\n"""Game of life."""\nimport sys\nprint(1)', 'main.py'),
    '"""Game of life."""\nimport sys\nprint(1)\n'
  );
  assert.equal(
    p.extractBody('Sure:\nPORT = 8080\nprint(PORT)', 'conf.py'),
    'PORT = 8080\nprint(PORT)\n'
  );
});

test('extractBody never returns prose, so the caller can retry', () => {
  assert.equal(p.extractBody('I am not sure which file you mean.', 'a.js'), '');
  assert.equal(p.extractBody('', 'a.js'), '');
  assert.equal(p.extractBody(null, 'a.js'), '');
  assert.equal(p.extractBody('```\n\n```', 'a.js'), '');
  // Streaming placeholders alone are not a file either.
  assert.equal(p.extractBody('Thinking...\nGenerating', 'a.js'), '');
});

/* --------------------------------------------------------- rejectReason */

test('rejectReason still catches the cases that mean "ask again"', () => {
  assert.equal(p.rejectReason(''), 'empty');
  assert.equal(p.rejectReason('ok'), 'too short to be a file');
  assert.ok(p.rejectReason('Output only the complete contents of index.html'));
  assert.ok(p.rejectReason('PATH: a.js\nREQUEST: make a thing\nsome more text'));
  assert.ok(p.rejectReason('REVIEW\nPATH: a.js\nCONTENT: whatever goes here'));
  assert.ok(/unclosed <script>/.test(p.rejectReason('<html><body><script>\nvar a = 1;')));
  assert.ok(/unclosed <style>/.test(p.rejectReason('<html><head><style>\nbody { color: red; }')));
  assert.ok(/unclosed <html>/.test(p.rejectReason('<html>\n<body>a paragraph of text</body>')));
});

test('rejectReason flags only unmistakable truncation', () => {
  assert.ok(/inside a string/.test(p.rejectReason('const a = 1;\nconst msg = "you crashed into')));
  // Ending on an open construct, but only once the file is big enough to be
  // a real attempt rather than a deliberate stub.
  assert.ok(p.rejectReason('x'.repeat(2100) + '\nfunction go() {'));
  assert.equal(p.rejectReason('function go() {'), null);
});

test('rejectReason accepts valid files that the old brace count rejected', () => {
  const jsx = `"use client";
import { useState } from "react";

const css = \`
  .card { color: red;
  .card:hover { color: blue;
\`;

export default function Card({ title }) {
  const [n, setN] = useState(0);
  const open = "{";
  const re = /\\{\\{\\s*/g;
  const label = "it's fine";
  return (
    <div className="card" onClick={() => setN(n + 1)}>
      <h1>{title} {n} {label} {open} {String(re)}</h1>
    </div>
  );
}
`;
  assert.equal(p.rejectReason(jsx), null, 'JSX + template literals must survive review');
  // Deliberately unbalanced braces, all of them inside strings or regexes.
  assert.ok((jsx.match(/\{/g) || []).length - (jsx.match(/\}/g) || []).length > 2);

  // An HTML file whose <script> closes only at the very end is complete.
  const html =
    '<!DOCTYPE html>\n<html>\n<head><style>body { margin: 0 }</style></head>\n' +
    '<body>\n<script>\nconst tag = "</scr" + "ipt>";\nconst brace = "{";\n</script>\n</body>\n</html>\n';
  assert.equal(p.rejectReason(html), null);

  // Python: a file ending on a docstring delimiter is not an open string.
  assert.equal(p.rejectReason('def f():\n    """\n    Does a thing.\n    """'), null);
  // Nor is an apostrophe in a trailing comment.
  assert.equal(p.rejectReason("const a = 1;\n// don't touch this"), null);
});

/* ------------------------------------------------------------ inferMode */

test('inferMode reads the stack out of the request text', () => {
  assert.equal(p.inferMode('build me a next js app'), 'nextjs');
  assert.equal(p.inferMode('hill climb racing in Next.js'), 'nextjs');
  assert.equal(p.inferMode('use the app router'), 'nextjs');
  assert.equal(p.inferMode('a vite project'), 'vite');
  assert.equal(p.inferMode('make a react app for notes'), 'vite');
  assert.equal(p.inferMode('a python flask api'), 'python');
  assert.equal(p.inferMode('write main.py for me'), 'python');
  assert.equal(p.inferMode('a cli that renames files'), 'node');
  assert.equal(p.inferMode('node script to parse logs'), 'node');
  assert.equal(p.inferMode('a single html landing page'), 'static');

  // With no explicit stack signal it must NOT guess. Picking a mode here is
  // how "build me a search engine" became a single index.html: the planner
  // never got to choose, a regex chose for it.
  assert.equal(p.inferMode('hill climb racing game'), 'auto');
  assert.equal(p.inferMode('a dashboard showing sales'), 'auto');
  assert.equal(p.inferMode('rename every file in a folder'), 'auto');
  assert.equal(p.inferMode('a standalone web search engine with image and video tabs'), 'auto');
  assert.equal(p.inferMode(''), 'auto');

  // Whatever it returns must still be a real mode.
  for (const req of ['x', 'a game', 'next js', 'flask', '', null]) {
    assert.ok(p.MODES[p.inferMode(req)], `inferMode returned an unknown mode`);
  }
});

/* ------------------------------------------------------------- condense */

test('condense keeps a head and a tail with a visible elision marker', () => {
  const body = 'H'.repeat(30000) + 'T'.repeat(30000);
  const out = p.condense(body);
  assert.ok(out.length < 4200, `condensed to ${out.length} chars`);
  assert.ok(out.startsWith('H'.repeat(100)), 'head preserved');
  assert.ok(out.endsWith('T'.repeat(100)), 'tail preserved');
  assert.ok(/\.\.\. \d+ characters elided \.\.\./.test(out), 'elision marker present');
  const elided = Number(out.match(/\.\.\. (\d+) characters elided/)[1]);
  assert.equal(elided, body.length - 2500 - 1500);
  assert.ok(out.split('H').length - 1 >= 2400, 'about 2500 head chars survive');

  // Small bodies pass straight through, untouched.
  assert.equal(p.condense('const x = 1;'), 'const x = 1;');
  assert.equal(p.condense(''), '');
  assert.equal(p.condense(null), '');
  assert.equal(p.condense('x'.repeat(4000)).length, 4000);
  assert.ok(p.condense('x'.repeat(600), 200).length < 300);
});

test('the reviewer prompt is bounded no matter how big the file is', () => {
  // A 51KB body pasted into a composer wedged the tab and the reviewer was
  // skipped, so the review tag must condense on its own.
  const huge = 'z'.repeat(51822);
  const prompt = p.TAGS.review('index.html', huge);
  // Bounded, but NOT so tight that a normal file looks truncated: a 4000-char
  // cap turned an ordinary 22KB page into head+tail around a huge gap, and the
  // reviewer - reading exactly what it was shown - answered RETRY to complete
  // files until the run gave up. Well under the ~50KB that wedges a composer.
  assert.ok(prompt.length < 14000, `review prompt was ${prompt.length} chars`);
  assert.ok(prompt.length > 8000, 'so aggressive the reviewer cannot judge the code');
  assert.ok(prompt.includes('characters elided'));
  // And it must say the gap is ours, or the reviewer reads it as truncation.
  assert.ok(/do not answer RETRY because of it/i.test(prompt));
  assert.ok(/PRINT/.test(prompt) && /RETRY/.test(prompt));
  assert.ok(prompt.includes('index.html'));
});

test('the builder prompt demands one single fenced block', () => {
  for (const key of MODE_KEYS) {
    const b = p.systems(key).builder;
    assert.ok(/ONE single fenced code block/i.test(b), `${key}: no single-block rule`);
    assert.ok(/never split/i.test(b), `${key}: no anti-split rule`);
    assert.ok(/nothing outside that block/i.test(b), `${key}: prose is not forbidden`);
  }
  // The reviewer must know the elision marker is ours, not a truncated file.
  assert.ok(/characters elided/.test(p.systems('static').reviewer));
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
    let full;
    try {
      full = w.resolveSafe(bad);
    } catch {
      continue;
    } // rejected outright: fine
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
    path.join(__dirname, '..', 'src', 'main', 'preload-control.js'),
    'utf8'
  );
  const renderer = await fsp.readFile(
    path.join(__dirname, '..', 'src', 'renderer', 'app.js'),
    'utf8'
  );

  // The shared contract: protocol.js must export each name and
  // preload-control.js must forward it onto the bridge's `protocol` namespace.
  // (test/seam.test.js checks the same seam by loading the bridge for real.)
  const contract = [
    'MODES',
    'systems',
    'TAGS',
    'parsePath',
    'parseVerdict',
    'parseAudit',
    'unfence',
    'clean',
    'slug',
    'rejectReason',
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

/* ================================================================== */
/* Shapes that have actually come back from a live tab.               */
/* ================================================================== */

test('extractBody: blank lines inside a body are never dropped', () => {
  // A file whose blank lines are eaten stops being the file the builder wrote:
  // Python loses its block structure and markdown loses every paragraph break.
  const py = 'import sys\n\n\ndef main():\n\n    print("hi")\n\n\nmain()';
  assert.equal(p.extractBody('```python\n' + py + '\n```', 'main.py'), py + '\n');

  const md = '# Title\n\nA paragraph.\n\n- one\n- two\n';
  assert.ok(p.extractBody('```md\n' + md + '```', 'README.md').includes('\n\n- one'));
});

test('extractBody: leading blank lines go, trailing whitespace is normalised', () => {
  assert.equal(p.extractBody('```\n\n\nconst x = 1;\n\n\n```', 'a.js'), 'const x = 1;\n');
  // Exactly one trailing newline, whatever arrived.
  for (const tail of ['', '\n', '\n\n\n', '   \n  \n']) {
    assert.equal(p.extractBody('```\nconst x = 1;\n' + tail + '```', 'a.js'), 'const x = 1;\n');
  }
});

test('extractBody: three blocks in a row are still one file, in order', () => {
  const reply =
    'Here it is:\n' +
    '```css\n.a { color: red }\n```\n' +
    'and then\n' +
    '```css\n.b { color: blue }\n```\n' +
    'finally\n' +
    '```css\n.c { color: green }\n```';
  assert.equal(
    p.extractBody(reply, 'style.css'),
    '.a { color: red }\n.b { color: blue }\n.c { color: green }\n'
  );
});

test('extractBody: several sidecar blocks are dropped, the real one survives', () => {
  const reply =
    'Install:\n```bash\nnpm i\n```\n' +
    'Then run:\n```console\nnpm start\n```\n' +
    'The file:\n```js\nmodule.exports = 1;\n```\n' +
    'Output:\n```text\n1\n```';
  assert.equal(p.extractBody(reply, 'index.js'), 'module.exports = 1;\n');
});

test('extractBody: a lone sidecar block IS the file when nothing else is', () => {
  // A shell script legitimately arrives in a ```bash block; dropping every
  // sidecar unconditionally would write an empty file for run.sh.
  assert.equal(
    p.extractBody('```bash\n#!/usr/bin/env bash\necho hi\n```', 'run.sh'),
    '#!/usr/bin/env bash\necho hi\n'
  );
});

test('extractBody: an unclosed fence still yields what arrived', () => {
  const cut = p.extractBody('Here:\n```html\n<!DOCTYPE html>\n<html>\n<body>', 'index.html');
  assert.equal(cut, '<!DOCTYPE html>\n<html>\n<body>\n');
  // And the caller is told it is unusable rather than writing half a page.
  assert.ok(p.rejectReason(cut), 'a truncated html body must be rejected');
});

test('extractBody: the file body never carries a fence marker out', () => {
  const messy =
    'Part one:\n```html\n<style>\n.a { color: red }\n```\n' + '```html\n</style>\n<h1>hi</h1>\n```';
  const out = p.extractBody(messy, 'index.html');
  assert.ok(!out.includes('```'), 'a stray fence inside <style> silently kills the CSS after it');
  assert.ok(out.includes('.a { color: red }') && out.includes('<h1>hi</h1>'));
});

test('stripStrayFences leaves markdown alone and cleans everything else', () => {
  const body = '# Title\n```js\nconst x = 1;\n```\ntail\n';
  for (const md of ['README.md', 'docs/GUIDE.markdown', 'page.mdx', 'UPPER.MD']) {
    assert.equal(p.stripStrayFences(body, md), body, `${md} must keep its fences`);
  }
  assert.equal(p.stripStrayFences(body, 'a.js'), '# Title\nconst x = 1;\ntail\n');
  // No path at all is treated as "not markdown" - the safe default.
  assert.ok(!p.stripStrayFences(body).includes('```'));
});

/* --------------------------------------------------------------- condense */

test('condense boundaries: one under, exactly at, and one over the limit', () => {
  assert.equal(p.condense('x'.repeat(99), 100).length, 99);
  assert.equal(p.condense('x'.repeat(100), 100).length, 100);
  const over = p.condense('x'.repeat(101), 100);
  assert.ok(over.includes('characters elided'));

  // A zero or nonsense budget yields nothing rather than the whole file: the
  // reviewer getting an empty CONTENT is recoverable, a wedged tab is not.
  assert.equal(p.condense('x'.repeat(5000), 0), '');
  assert.equal(p.condense('x'.repeat(5000), -1), '');
});

test('condense splits head and tail at the documented 5:3 ratio', () => {
  const body = 'A'.repeat(10000) + 'B'.repeat(10000);
  const out = p.condense(body, 800);
  const head = out.slice(0, out.indexOf('\n\n...'));
  const tail = out.slice(out.lastIndexOf('...\n\n') + 5);
  assert.equal(head.length, 500);
  assert.equal(tail.length, 300);
  assert.ok(/^A+$/.test(head) && /^B+$/.test(tail));
  assert.equal(Number(out.match(/\.\.\. (\d+) characters elided/)[1]), 20000 - 800);
});

test('condense keeps the reviewer prompt bounded for every mode', () => {
  // The 51KB paste that wedged a tab was an index.html; the same file arrives
  // for every mode, so the bound cannot depend on the mode.
  const huge = 'z'.repeat(120000);
  for (const file of ['index.html', 'app/page.tsx', 'main.py', 'src/App.jsx']) {
    const prompt = p.TAGS.review(file, huge);
    assert.ok(prompt.length < 14000, `${file}: review prompt was ${prompt.length} chars`);
    assert.ok(prompt.includes(file));
  }
});

/* --------------------------------------------------------------- inferMode */

test('inferMode: the stack signal wins wherever it appears in the sentence', () => {
  assert.equal(p.inferMode('I would like a NEXT.JS dashboard please'), 'nextjs');
  assert.equal(p.inferMode('something with next-js and tailwind'), 'nextjs');
  assert.equal(p.inferMode('use the App Router for this'), 'nextjs');
  assert.equal(p.inferMode('a react spa for tracking habits'), 'vite');
  assert.equal(p.inferMode('build it with Django'), 'python');
  assert.equal(p.inferMode('a pygame platformer'), 'python');
  assert.equal(p.inferMode('a terminal tool for tagging photos'), 'node');
  assert.equal(p.inferMode('a command-line converter'), 'node');
  assert.equal(p.inferMode('one file, no build step'), 'static');
});

test('inferMode: earlier signals beat later ones, and nothing beats no signal', () => {
  // Both a Next.js and a Python word: the first rule in the list wins, so the
  // outcome is deterministic rather than dependent on word order.
  assert.equal(p.inferMode('a next js app with a python helper script'), 'nextjs');
  assert.equal(p.inferMode('a python api and a react app'), 'vite');
  // "react frontend" is not one of the phrases vite claims, so the python
  // signal is the only explicit one left and it wins.
  assert.equal(p.inferMode('a python api and a react frontend'), 'python');

  // The tie-break that used to guess "static" from visual words is gone: a
  // regex quietly deciding the project is one HTML page is how "build me a
  // search engine" became a single index.html.
  for (const visual of [
    'a hill climb racing game',
    'an interactive dashboard with charts',
    'a drawing app with a canvas',
    'a 3d spinning cube',
    'a photo gallery with a carousel',
  ]) {
    assert.equal(p.inferMode(visual), 'auto', `"${visual}" must stay in auto`);
  }
});

test('inferMode never returns anything that is not a mode', () => {
  for (const junk of [null, undefined, '', 0, 42, {}, [], '```', 'DONE']) {
    const key = p.inferMode(junk);
    assert.ok(p.MODES[key], `inferMode(${JSON.stringify(junk)}) returned ${key}`);
  }
});

/* -------------------------------------------------------------- workspace */

test('workspace refuses the traversal shapes a chat reply actually produces', () => {
  const hostile = [
    '..',
    '../',
    '../../../../../../Windows/System32/drivers/etc/hosts',
    '..\\..\\secret.txt',
    'proj/../../outside.js',
    'proj/sub/../../../outside.js',
    './../outside.js',
    '%2e%2e/outside.js', // not decoded by us, so it is just a folder name
  ];
  for (const rel of hostile) {
    let full;
    try {
      full = w.resolveSafe(rel);
    } catch {
      continue;
    } // refused: fine
    assert.ok(
      full === w.ROOT || full.startsWith(w.ROOT + path.sep),
      `escaped the workspace: ${rel} -> ${full}`
    );
  }
});

test('workspace normalises the separators and prefixes a reply may carry', () => {
  const inside = w.resolveSafe('proj/src/index.ts');
  assert.equal(w.resolveSafe('proj\\src\\index.ts'), inside, 'windows separators');
  assert.equal(w.resolveSafe('/proj/src/index.ts'), inside, 'a leading slash');
  assert.equal(w.resolveSafe('  proj/src/index.ts  '), inside, 'surrounding whitespace');
  assert.equal(w.resolveSafe('proj/./src/index.ts'), inside, 'a dot segment');
});

test('workspace rejects an empty or unusable path outright', () => {
  // A lone separator or drive prefix reduces to nothing once stripped.
  for (const bad of ['', '   ', null, undefined, '/', '\\', 'C:']) {
    assert.throws(() => w.resolveSafe(bad), JSON.stringify(bad) + ' must be refused');
  }
  // A NUL byte would truncate the path inside libuv. Built rather than
  // written literally: an invisible NUL in a source file is unreadable.
  assert.throws(() => w.resolveSafe('proj/a' + String.fromCharCode(0) + 'b.txt'));
});

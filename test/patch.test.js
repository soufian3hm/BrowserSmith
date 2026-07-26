'use strict';
const test = require('node:test');
const assert = require('node:assert');
const p = require('../src/shared/patch');

const FILE = `"use client";
import { useRef } from "react";

export default function Page() {
  const particlesRef = useRef(null);

  const drawParticles = (cameraX, cameraY) => {
    for (const particle of particlesRef.current) {
      draw(particle, cameraX, cameraY);
    }
  };

  return <canvas />;
}
`;

test('parses a single find/replace block', () => {
  const reply = [
    '<<<<<<< FIND',
    '    for (const particle of particlesRef.current) {',
    '=======',
    '    for (const particle of particlesRef.current ?? []) {',
    '>>>>>>> REPLACE',
  ].join('\n');
  const patches = p.parsePatches(reply);
  assert.equal(patches.length, 1);
  assert.match(patches[0].replace, /\?\? \[\]/);
});

test('parses several blocks in one reply', () => {
  const reply = [
    '<<<<<<< FIND',
    'const a = 1;',
    '=======',
    'const a = 2;',
    '>>>>>>> REPLACE',
    '<<<<<<< FIND',
    'const b = 3;',
    '=======',
    'const b = 4;',
    '>>>>>>> REPLACE',
  ].join('\n');
  assert.equal(p.parsePatches(reply).length, 2);
});

test('applies a patch to the real file', () => {
  const patches = p.parsePatches(
    [
      '<<<<<<< FIND',
      '    for (const particle of particlesRef.current) {',
      '=======',
      '    for (const particle of particlesRef.current ?? []) {',
      '>>>>>>> REPLACE',
    ].join('\n')
  );
  const res = p.applyPatches(FILE, patches);
  assert.equal(res.applied.length, 1);
  assert.equal(res.failed.length, 0);
  assert.match(res.text, /particlesRef\.current \?\? \[\]/);
  // Everything else survives untouched.
  assert.match(res.text, /export default function Page/);
  assert.match(res.text, /<canvas \/>/);
});

test('tolerates wrong indentation in FIND', () => {
  const patches = p.parsePatches(
    [
      '<<<<<<< FIND',
      'for (const particle of particlesRef.current) {',
      '=======',
      'for (const particle of particlesRef.current ?? []) {',
      '>>>>>>> REPLACE',
    ].join('\n')
  );
  const res = p.applyPatches(FILE, patches);
  assert.equal(res.applied.length, 1, 'should match despite lost indentation');
  // The replacement keeps the file's own indentation.
  assert.match(res.text, /\n {4}for \(const particle of particlesRef\.current \?\? \[\]\) \{/);
});

test('refuses an ambiguous FIND rather than corrupting the file', () => {
  const src = 'const x = 1;\nconst y = 2;\nconst x = 1;\n';
  const patches = [{ find: 'const x = 1;', replace: 'const x = 9;' }];
  const res = p.applyPatches(src, patches);
  assert.equal(res.applied.length, 0);
  assert.equal(res.failed.length, 1);
  assert.equal(res.text, src, 'file must be left exactly as it was');
});

test('reports a FIND that is simply absent', () => {
  const res = p.applyPatches(FILE, [{ find: 'nonexistent line', replace: 'x' }]);
  assert.equal(res.failed.length, 1);
  assert.match(res.failed[0].reason, /not found/);
});

test('detects the REWRITE escape hatch', () => {
  assert.equal(p.wantsRewrite('REWRITE'), true);
  assert.equal(p.wantsRewrite('  rewrite  '), true);
  assert.equal(p.wantsRewrite('<<<<<<< FIND'), false);
});

test('parses the error location out of a real Next.js overlay', () => {
  const overlay =
    'Unhandled Runtime Error\nTypeError: particlesRef.current is not iterable\nSource\napp\\page.tsx (619:39) @ current';
  assert.deepEqual(p.parseErrorLocation(overlay), { file: 'app/page.tsx', line: 619 });
});

test('parses other stack shapes', () => {
  assert.deepEqual(p.parseErrorLocation('at /src/lib/game.js:42:11'), {
    file: '/src/lib/game.js',
    line: 42,
  });
  assert.equal(p.parseErrorLocation('no location here'), null);
});

test('excerpt centres on the failing line and numbers it', () => {
  const src = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n');
  const out = p.excerpt(src, 100, 5);
  assert.match(out, /100 {2}line 100/);
  assert.ok(!out.includes('line 80'), 'should not reach far above the error');
  assert.ok(!out.includes('line 120'), 'should not reach far below the error');
});

/* ================================================================== */
/* Fences, ambiguity and line endings - the three ways a patch has     */
/* corrupted a file rather than fixing it.                             */
/* ================================================================== */

const FENCE = '```';

test('a code fence inside a patch never reaches the file', () => {
  // Models wrap patches in a fence constantly despite being told not to, and
  // this path bypasses the reviewer entirely: whatever comes out is written.
  const reply = [
    '<<<<<<< FIND',
    FENCE + 'js',
    'const a = 1;',
    FENCE,
    '=======',
    FENCE + 'js',
    'const a = 2;',
    FENCE,
    '>>>>>>> REPLACE',
  ].join('\n');
  const patches = p.parsePatches(reply);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].find, 'const a = 1;');
  assert.equal(patches[0].replace, 'const a = 2;');

  const res = p.applyPatches('const a = 1;\n', patches);
  assert.equal(res.text, 'const a = 2;\n');
  assert.ok(!res.text.includes('`'), 'a fence written into the file breaks it silently');
});

test('a fence around the whole reply is stripped too', () => {
  const reply = [
    FENCE,
    '<<<<<<< FIND',
    'const a = 1;',
    '=======',
    'const a = 2;',
    '>>>>>>> REPLACE',
    FENCE,
  ].join('\n');
  const patches = p.parsePatches(reply);
  assert.equal(patches.length, 1);
  assert.ok(!patches[0].replace.includes('`'));
});

test('prose around the markers is ignored', () => {
  const reply = [
    'Sure - the bug is the missing null check. Here is the fix:',
    '',
    '<<<<<<< FIND',
    'const a = 1;',
    '=======',
    'const a = 2;',
    '>>>>>>> REPLACE',
    '',
    'Let me know if you want me to explain it.',
  ].join('\n');
  const patches = p.parsePatches(reply);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].replace, 'const a = 2;');
});

test('a reply with no markers at all yields no patches', () => {
  assert.deepEqual(p.parsePatches('I could not work out what is wrong.'), []);
  assert.deepEqual(p.parsePatches(''), []);
  assert.deepEqual(p.parsePatches(null), []);
  // An empty FIND is not a patch: it would match everywhere.
  assert.deepEqual(p.parsePatches('<<<<<<< FIND\n   \n=======\nsomething\n>>>>>>> REPLACE'), []);
});

test('CRLF anywhere - in the reply or in the file - still applies cleanly', () => {
  const reply = ['<<<<<<< FIND', 'const a = 1;', '=======', 'const a = 2;', '>>>>>>> REPLACE'].join(
    '\r\n'
  );
  const patches = p.parsePatches(reply);
  assert.equal(patches.length, 1);

  const res = p.applyPatches('const a = 1;\r\nconst b = 3;\r\n', patches);
  assert.equal(res.applied.length, 1);
  assert.ok(!res.text.includes('\r'), 'the file must not end up with mixed line endings');
  assert.equal(res.text, 'const a = 2;\nconst b = 3;\n');
});

test('an ambiguous FIND is refused even when the copies differ only in indent', () => {
  const src = [
    'function a() {',
    '  return 1;',
    '}',
    'function b() {',
    '    return 1;',
    '}',
    '',
  ].join('\n');
  const res = p.applyPatches(src, [{ find: 'return 1;', replace: 'return 2;' }]);
  assert.equal(res.applied.length, 0);
  assert.equal(res.failed.length, 1);
  assert.match(res.failed[0].reason, /more than once/);
  assert.equal(res.text, src, 'the file must be left byte for byte as it was');
});

test('one bad patch in a batch does not take the good ones with it', () => {
  const src = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
  const res = p.applyPatches(src, [
    { find: 'const a = 1;', replace: 'const a = 9;' },
    { find: 'const zzz = 0;', replace: 'const zzz = 1;' },
    { find: 'const c = 3;', replace: 'const c = 7;' },
  ]);
  assert.equal(res.applied.length, 2);
  assert.equal(res.failed.length, 1);
  assert.equal(res.text, 'const a = 9;\nconst b = 2;\nconst c = 7;\n');
  // The caller falls back to a full rewrite off this list, so it has to carry
  // the patch itself, not just a message.
  assert.equal(res.failed[0].find, 'const zzz = 0;');
});

test('a multi-line patch written without indentation is re-anchored to the file', () => {
  // The exact match fails on the indentation, the line-trimmed pass finds it,
  // and the replacement is shifted back to where the original sat.
  const src = ['class A {', '  run() {', '    go();', '    stop();', '  }', '}', ''].join('\n');
  const res = p.applyPatches(src, [
    { find: 'go();\nstop();', replace: 'go();\npause();\nstop();' },
  ]);
  assert.equal(res.applied.length, 1, 'lost indentation must not fail the patch');
  assert.equal(
    res.text,
    ['class A {', '  run() {', '    go();', '    pause();', '    stop();', '  }', '}', ''].join(
      '\n'
    )
  );
});

test('an empty replacement deletes the matched lines', () => {
  const src = 'keep me\ndelete me\nkeep me too\n';
  const res = p.applyPatches(src, [{ find: 'delete me', replace: '' }]);
  assert.equal(res.applied.length, 1);
  assert.ok(!res.text.includes('delete me'));
  assert.ok(res.text.includes('keep me') && res.text.includes('keep me too'));
});

test('trailing whitespace differences do not defeat a patch', () => {
  // Models drop trailing spaces when they copy a line out of a file.
  const src = 'const a = 1;   \nconst b = 2;\n';
  const res = p.applyPatches(src, [{ find: 'const a = 1;', replace: 'const a = 5;' }]);
  assert.equal(res.applied.length, 1);
  assert.ok(res.text.startsWith('const a = 5;'));
});

test('wantsRewrite only fires on the escape hatch itself', () => {
  assert.equal(p.wantsRewrite('REWRITE'), true);
  assert.equal(p.wantsRewrite('  rewrite  '), true);
  assert.equal(p.wantsRewrite('**REWRITE**'), true);
  assert.equal(p.wantsRewrite(''), false);
  assert.equal(p.wantsRewrite(null), false);
  assert.equal(p.wantsRewrite('I will rewrite the whole file for you'), false);
  assert.equal(
    p.wantsRewrite('<<<<<<< FIND\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> REPLACE'),
    false
  );
});

/* -------------------------------------------------------- error locations */

test('parseErrorLocation reads the overlays we actually see', () => {
  assert.deepEqual(p.parseErrorLocation('app\\page.tsx (619:39) @ current'), {
    file: 'app/page.tsx',
    line: 619,
  });
  assert.deepEqual(p.parseErrorLocation('at src/main.js:42:11'), {
    file: 'src/main.js',
    line: 42,
  });
  assert.deepEqual(p.parseErrorLocation('./src/App.jsx:10:2'), { file: 'src/App.jsx', line: 10 });
  assert.deepEqual(p.parseErrorLocation('Error in components/Nav.tsx:7'), {
    file: 'components/Nav.tsx',
    line: 7,
  });
});

test('parseErrorLocation does not invent a location out of noise', () => {
  assert.equal(p.parseErrorLocation('no location here'), null);
  assert.equal(p.parseErrorLocation(''), null);
  assert.equal(p.parseErrorLocation(null), null);
  // A version banner is not a stack frame.
  assert.equal(p.parseErrorLocation('Next.js 15.1.6 - ready in 1200 ms'), null);
});

/* ------------------------------------------------------------- excerpt */

test('excerpt clamps at both ends of the file', () => {
  const src = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
  const top = p.excerpt(src, 1, 5);
  assert.match(top, /^\s+1 {2}line 1$/m);
  assert.ok(!top.includes('line 7'), 'must not read past the radius');

  const bottom = p.excerpt(src, 30, 5);
  assert.match(bottom, /30 {2}line 30/);
  assert.ok(!bottom.includes('line 24'));

  // A line number past the end of the file yields the tail, not a crash.
  assert.ok(p.excerpt(src, 500, 3).length >= 0);
});

test('excerpt with no usable line number shows the head of the file', () => {
  const src = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n');
  for (const bad of [0, null, undefined, -5]) {
    const out = p.excerpt(src, bad, 4);
    assert.match(out, /1 {2}line 1/, `excerpt(${bad}) should start at the top`);
  }
  // An empty file has nothing to centre on: line numbers at most, no content,
  // and no throw.
  for (const empty of ['', null, undefined]) {
    for (const line of p.excerpt(empty, 10, 4).split('\n')) {
      assert.match(line, /^\s*\d*\s*$/, `an empty file excerpted to "${line}"`);
    }
  }
});

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
    '<<<<<<< FIND', 'const a = 1;', '=======', 'const a = 2;', '>>>>>>> REPLACE',
    '<<<<<<< FIND', 'const b = 3;', '=======', 'const b = 4;', '>>>>>>> REPLACE',
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

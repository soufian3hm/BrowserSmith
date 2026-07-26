'use strict';
/**
 * The published surface: the manifest a stranger reads, the scripts they run,
 * and the packaging config that decides what ends up inside a downloadable
 * build.
 *
 * The last one is not cosmetic. `.profile/` is a live logged-in Chromium
 * session and `workspace/` is whatever this machine generated - either of them
 * inside a release artifact is a credential leak with a download counter on it.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const readRoot = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');
const pkg = JSON.parse(readRoot('package.json'));

/**
 * The `- item` entries of a `key:` block in a small, hand-written YAML file.
 * Deeper lines that are not list items (a mapping continued under one entry)
 * are part of the block and skipped; anything at or above the block's own
 * indentation ends it.
 */
function ymlList(text, key) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === `${key}:`);
  assert.ok(start >= 0, `electron-builder.yml has no "${key}:" block`);
  const indent = lines[start].match(/^\s*/)[0].length;
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (line.match(/^\s*/)[0].length <= indent) break;
    const m = line.match(/^\s*-\s*(.+?)\s*$/);
    if (m) out.push(m[1].replace(/^['"]|['"]$/g, ''));
  }
  assert.ok(out.length, `"${key}:" is empty`);
  return out;
}

/* ------------------------------------------------------------- the manifest */

test('package.json carries the metadata a public repo needs', () => {
  assert.equal(pkg.name, 'browsersmith');
  assert.equal(pkg.productName, 'BrowserSmith');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.license, 'MIT');
  assert.ok(fs.existsSync(path.join(ROOT, 'LICENSE')), 'the license field needs a LICENSE file');
  assert.ok(pkg.author, 'no author');
  assert.ok(pkg.description && pkg.description.length > 40, 'description is missing or a stub');
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.length >= 4);

  for (const url of [pkg.homepage, pkg.bugs.url, pkg.repository.url]) {
    assert.match(url, /github\.com\/soufian3hm\/BrowserSmith/i, `points elsewhere: ${url}`);
  }
  assert.equal(pkg.repository.type, 'git');

  // Six dev dependencies refuse to install below this, and nothing else warns
  // the user before npm starts spewing EBADENGINE.
  assert.match(pkg.engines.node, /^>=\s*\d+\.\d+\.\d+$/);
  assert.ok(parseInt(pkg.engines.node.replace(/\D+/, ''), 10) >= 22);

  assert.ok(fs.existsSync(path.join(ROOT, pkg.main)), `main entry missing: ${pkg.main}`);
});

test('the test script runs the whole test directory, never one named file', () => {
  const script = pkg.scripts.test;
  assert.match(script, /node --test/);
  // Naming files individually is how test/patch.test.js - the suite guarding
  // the code that silently corrupts a user's file - went a release without
  // ever being executed.
  assert.ok(
    !/test[/\\][\w.-]+\.test\.js/.test(script.replace(/\*/g, '')),
    `the test script names individual files: ${script}`
  );
  assert.ok(script.includes('test/'), 'the test script must point at test/');
});

test('every script a contributor is told to run exists', () => {
  for (const name of ['start', 'test', 'lint', 'format', 'package']) {
    assert.ok(pkg.scripts[name], `missing script: ${name}`);
  }
  assert.match(pkg.scripts.package, /electron-builder/);
  assert.match(pkg.scripts.lint, /eslint/);
  assert.match(pkg.scripts.format, /prettier/);
});

test('the dependency lists stay honest', () => {
  // Electron is a build-time dependency; as a runtime one it would be
  // downloaded a second time inside every packaged build.
  assert.ok(pkg.devDependencies.electron, 'electron must be a devDependency');
  assert.ok(!pkg.dependencies.electron, 'electron must never be a runtime dependency');
  for (const name of ['electron-builder', 'eslint', 'prettier']) {
    assert.ok(pkg.devDependencies[name], `missing devDependency: ${name}`);
  }

  // sharp and png-to-ico each pulled tens of MB of platform-specific natives
  // into every stranger's first install, for an icon build step that does not
  // exist - the icons are committed under assets/.
  for (const unused of ['sharp', 'png-to-ico']) {
    assert.ok(!pkg.devDependencies[unused], `${unused} is not used by any script`);
    assert.ok(!pkg.dependencies[unused], `${unused} is not used by any script`);
  }

  // Anything the app requires at runtime has to be a real dependency, or the
  // packaged build starts and immediately cannot find its own modules.
  assert.ok(pkg.dependencies['@modelcontextprotocol/sdk']);
  assert.ok(pkg.dependencies.zod);
});

test('the committed lockfile matches the manifest it was generated from', () => {
  // A lockfile that still carries the previous project name is what a visitor
  // clones, and `npm ci` refuses to install one that has drifted from the
  // manifest - which turns a green CI badge into a red one on the first PR.
  const lock = JSON.parse(readRoot('package-lock.json'));
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);

  const root = lock.packages[''];
  for (const [name, range] of Object.entries(pkg.dependencies)) {
    assert.equal(root.dependencies[name], range, `lockfile is stale for ${name}`);
  }
  for (const [name, range] of Object.entries(pkg.devDependencies)) {
    assert.equal(root.devDependencies[name], range, `lockfile is stale for ${name}`);
  }
});

/* ------------------------------------------------------------ the packaging */

test('the packaged build can never contain the login or the workspace', () => {
  const yml = readRoot('electron-builder.yml');
  const files = ymlList(yml, 'files');

  // Present as explicit negations...
  for (const must of ['!.profile/**', '!workspace/**']) {
    assert.ok(files.includes(must), `electron-builder.yml files: is missing ${must}`);
  }
  // ...and absent from every positive glob, so a later "**/*" cannot re-admit
  // them by accident.
  for (const glob of files.filter((f) => !f.startsWith('!'))) {
    assert.ok(
      !/(^|\/)(\.profile|workspace)(\/|$)/.test(glob),
      `a positive glob would package a forbidden directory: ${glob}`
    );
    assert.notEqual(glob, '**/*', 'an unrestricted glob would package .profile and workspace');
    assert.notEqual(glob, '**', 'an unrestricted glob would package .profile and workspace');
  }

  // git must not carry them either - the same two directories, one commit away.
  const gitignore = readRoot('.gitignore');
  assert.match(gitignore, /^\.profile\/?$/m);
  assert.match(gitignore, /^workspace\/?$/m);
});

test('electron-builder is configured for a real Windows release', () => {
  const yml = readRoot('electron-builder.yml');
  assert.match(yml, /^productName:\s*BrowserSmith$/m);
  assert.match(yml, /^appId:\s*[\w.]+$/m);
  assert.match(yml, /output:\s*build-out/);

  // The committed icon, not a generated one.
  assert.match(yml, /icon:\s*assets\/icon\.ico/);
  assert.ok(fs.existsSync(path.join(ROOT, 'assets', 'icon.ico')), 'assets/icon.ico is missing');

  const targets = ymlList(yml.slice(yml.indexOf('\nwin:')), 'target');
  const named = targets.join(' ');
  assert.match(named, /nsis/, 'no Windows installer target');
  assert.match(named, /portable/, 'no portable target');

  // A per-machine install lands in Program Files, which is not writable - and
  // the app keeps .profile and workspace next to its own executable.
  assert.match(yml, /perMachine:\s*false/);
});

/* --------------------------------------------------------------- the brand */

test('nothing in the shipped tree still says notioned', () => {
  const seen = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      // This file necessarily spells the old name out to search for it.
      else if (full !== __filename && /\.(js|json|html|css|yml)$/.test(e.name)) {
        if (/notioned/i.test(fs.readFileSync(full, 'utf8'))) seen.push(path.relative(ROOT, full));
      }
    }
  };
  for (const dir of ['src', 'tools', 'test']) walk(path.join(ROOT, dir));
  assert.deepEqual(seen, [], `the abandoned project name survives in: ${seen.join(', ')}`);
});

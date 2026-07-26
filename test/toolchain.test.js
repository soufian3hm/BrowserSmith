'use strict';
/**
 * The toolchain is the security boundary of the whole app: model output decides
 * which project is touched and which ecosystem is detected, and everything it
 * decides ends in a spawn() or a write. These tests cover the things that have
 * actually gone wrong - a command escaping the allow-list, a project name
 * escaping the workspace, plan() reading the wrong runtime off disk - plus the
 * scaffold's promise never to overwrite existing work.
 *
 * Nothing here starts a process: run() is only ever exercised on its rejection
 * path, and plan() is pure inspection of a directory.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fsp = require('node:fs/promises');

const toolchain = require('../src/main/toolchain');
const workspace = require('../src/main/workspace');

/**
 * Fixtures are top-level workspace folders, because a project name must be a
 * single safe segment and projectDir() confines it to the workspace root -
 * there is no way to point it at the OS temp dir. The shared prefix carries the
 * pid so parallel runs cannot collide, and after() sweeps every folder that
 * starts with it even when a test throws.
 */
const PREFIX = `bstest${process.pid}-`;

async function fixture(name, files) {
  const project = PREFIX + name;
  const dir = path.join(workspace.ROOT, project);
  await fsp.mkdir(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, ...rel.split('/'));
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, content, 'utf8');
  }
  return project;
}

test.after(async () => {
  const entries = await fsp.readdir(workspace.ROOT).catch(() => []);
  await Promise.all(
    entries
      .filter((e) => e.startsWith(PREFIX))
      .map((e) => fsp.rm(path.join(workspace.ROOT, e), { recursive: true, force: true }))
  );
});

/* --------------------------------------------------------- the allow-list */

test('run() refuses any executable that is not on the allow-list', async () => {
  for (const cmd of ['rm', 'del', 'curl', 'wget', 'powershell', 'cmd', 'git', 'ssh', '']) {
    await assert.rejects(
      () => toolchain.run(null, 'proj', cmd, []),
      /command not allowed/,
      `${cmd || '(empty)'} must be refused`
    );
  }
});

test('startProcessServer() applies the same allow-list', async () => {
  await assert.rejects(
    () => toolchain.startProcessServer(null, 'proj', 'curl', ['http://x']),
    /command not allowed/
  );
});

test('the allow-list holds runtimes, never shells or network tools', () => {
  for (const cmd of ['npm', 'node', 'python', 'go', 'cargo', 'dotnet']) {
    assert.ok(toolchain.ALLOWED.has(cmd), `${cmd} should be runnable`);
  }
  // `bash`/`sh` are present on purpose (a .sh project is a real project) but
  // nothing that exists to fetch or delete may ever join them.
  for (const cmd of ['rm', 'del', 'curl', 'wget', 'powershell', 'cmd.exe', 'reg', 'schtasks']) {
    assert.ok(!toolchain.ALLOWED.has(cmd), `${cmd} must never be allow-listed`);
  }
});

/* ------------------------------------------------------- path confinement */

test('projectDir refuses every project name that is not one safe segment', () => {
  const hostile = [
    '../../etc',
    '..',
    '../sibling',
    'a/../../../b',
    'C:/Windows/System32',
    '/etc/passwd',
    'nested/project',
    'nested\\project',
    '.',
    '.hidden',
    '',
    '   ',
    'con', // a Windows device: opening it hangs rather than failing
    'nul',
    'lpt1',
  ];
  for (const bad of hostile) {
    assert.throws(() => toolchain.projectDir(bad), `${JSON.stringify(bad)} must be refused`);
  }
});

test('projectDir resolves an ordinary name inside the workspace', () => {
  const full = toolchain.projectDir('demo-1.0');
  assert.ok(full.startsWith(workspace.ROOT + path.sep));
  // A trailing separator must not produce a different directory than without.
  assert.equal(toolchain.projectDir('demo/'), toolchain.projectDir('demo'));
});

test('scaffold cannot be aimed outside the workspace', async () => {
  await assert.rejects(() => toolchain.scaffold('../../escaped', 'node'));
  await assert.rejects(() => toolchain.scaffold('a/b', 'node'));
});

/* ------------------------------------------------------------- scaffold */

test('scaffold writes a starter and then never overwrites it', async () => {
  const project = PREFIX + 'scaffold-node';
  const first = await toolchain.scaffold(project, 'node');
  assert.deepEqual(first.skipped, []);
  assert.ok(first.created.includes('package.json'));
  assert.ok(first.created.includes('index.js'));

  // Whatever the agents wrote afterwards is the user's work now.
  const entry = path.join(toolchain.projectDir(project), 'index.js');
  await fsp.writeFile(entry, 'console.log("real work");\n', 'utf8');

  const second = await toolchain.scaffold(project, 'node');
  assert.deepEqual(second.created, [], 'a second scaffold must create nothing');
  assert.deepEqual(second.skipped.sort(), first.created.sort());
  assert.equal(await fsp.readFile(entry, 'utf8'), 'console.log("real work");\n');
});

test('scaffold produces a valid npm name from an awkward project name', async () => {
  const project = `${PREFIX}Silly_Name-1`;
  const res = await toolchain.scaffold(project, 'vite');
  assert.ok(res.created.includes('package.json'));
  const pkg = JSON.parse(
    await fsp.readFile(path.join(toolchain.projectDir(project), 'package.json'), 'utf8')
  );
  // npm rejects capitals and most punctuation in a package name.
  assert.match(pkg.name, /^[a-z0-9][a-z0-9._-]*$/);
});

test('the scaffold-free modes write nothing at all', async () => {
  for (const mode of ['static', 'auto', 'nope']) {
    const res = await toolchain.scaffold(`${PREFIX}none-${mode}`, mode);
    assert.deepEqual(res, { created: [], skipped: [] }, `${mode} must not scaffold`);
  }
});

/* ------------------------------------------------------------------ plan */

test('plan: a package.json dev script is the strongest signal there is', async () => {
  const project = await fixture('node-web', {
    'package.json': JSON.stringify({
      name: 'x',
      scripts: { dev: 'next dev', build: 'next build' },
      dependencies: { next: '15.1.6' },
    }),
    'app/page.tsx': 'export default function Home() { return <main/>; }\n',
  });
  const pl = await toolchain.plan(project);
  assert.equal(pl.kind, 'node-web');
  assert.equal(pl.serve.cmd, 'npm');
  assert.deepEqual(pl.serve.args, ['run', 'dev']);
  assert.equal(pl.serve.label, 'npm run dev');
  assert.equal(pl.preview, 'browser');
  assert.equal(pl.steps.length, 1);
  assert.equal(pl.steps[0].cmd, 'npm');
  assert.deepEqual(pl.steps[0].args, ['install']);
});

test('plan: the declared packageManager wins over npm', async () => {
  const project = await fixture('pnpm-web', {
    'package.json': JSON.stringify({
      name: 'x',
      packageManager: 'pnpm@9.0.0',
      scripts: { start: 'vite' },
      dependencies: { vite: '^6' },
    }),
  });
  const pl = await toolchain.plan(project);
  assert.equal(pl.serve.cmd, 'pnpm');
  assert.deepEqual(pl.serve.args, ['run', 'start']);
  assert.equal(pl.steps[0].cmd, 'pnpm');
});

test('plan: a dev script beats a stray script in another language', async () => {
  // A web project that also ships a helper script must not be planned as a
  // Python project - that ordering is what made a web app unverifiable.
  const project = await fixture('mixed', {
    'package.json': JSON.stringify({ name: 'x', scripts: { dev: 'next dev' } }),
    'tools/convert.py': 'print("helper")\n',
    'index.html': '<!doctype html><title>x</title>\n',
  });
  const pl = await toolchain.plan(project);
  assert.equal(pl.kind, 'node-web');
  assert.equal(pl.htmlEntry, 'index.html');
  // No dependencies declared, so there is nothing to install first.
  assert.deepEqual(pl.steps, []);
});

test('plan: a package.json with no dev script runs its entry point', async () => {
  const project = await fixture('node-script', {
    'package.json': JSON.stringify({ name: 'x', scripts: { test: 'node --test' } }),
    'index.js': 'console.log("hi");\n',
  });
  const pl = await toolchain.plan(project);
  assert.equal(pl.kind, 'node-script');
  assert.equal(pl.run.cmd, 'node');
  // "--" then a path-prefixed entry: neither a leading dash nor a bare name
  // can be reinterpreted as a node flag.
  assert.ok(pl.run.args.includes('--'));
  assert.match(pl.run.args[pl.run.args.length - 1], /^\.[\\/]index\.js$/);
  assert.equal(pl.preview, 'output');
});

test('plan: a lone index.html is a static site with no build step', async () => {
  const project = await fixture('static', {
    'index.html': '<!doctype html><h1>hi</h1>\n',
    'styles.css': 'body { margin: 0 }\n',
  });
  const pl = await toolchain.plan(project);
  assert.equal(pl.kind, 'static');
  assert.equal(pl.htmlEntry, 'index.html');
  assert.equal(pl.preview, 'browser');
  assert.equal(pl.serve, undefined);
  assert.equal(pl.run, undefined);
});

test('plan: python is detected, and its entry point is found', async () => {
  const project = await fixture('py-script', {
    'main.py': 'def main():\n    print("hello")\n\nmain()\n',
    'requirements.txt': 'rich\n',
  });
  const pl = await toolchain.plan(project);
  assert.equal(pl.language, 'Python');
  assert.equal(pl.entry, 'main.py');
  if (pl.kind === 'python-unavailable') {
    // No interpreter here: say so instead of inventing a verification that
    // cannot run, which is what made the auditor reject a valid project.
    assert.match(pl.doneMeans, /not installed on this machine/);
    assert.deepEqual(pl.steps, []);
  } else {
    assert.equal(pl.kind, 'python-script');
    // The entry is passed path-prefixed ("./main.py") so a file whose name
    // begins with a dash can never be read as an interpreter flag.
    assert.equal(pl.run.args.length, 1);
    assert.match(pl.run.args[0], /^\.[\\/]main\.py$/);
    assert.equal(pl.steps[0].kind, 'install');
    assert.ok(pl.steps[0].args.includes('requirements.txt'));
  }
});

test('plan: python source that opens a listener is a server, not a script', async () => {
  const project = await fixture('py-web', {
    'app.py': 'from flask import Flask\napp = Flask(__name__)\napp.run(port=5000)\n',
  });
  const pl = await toolchain.plan(project);
  assert.equal(pl.language, 'Python');
  assert.equal(pl.entry, 'app.py');
  if (pl.kind !== 'python-unavailable') {
    assert.equal(pl.kind, 'python-web');
    assert.equal(pl.preview, 'browser');
    assert.ok(
      pl.serve.args.some((a) => /app\.py$/.test(a)),
      `serve args should reference app.py: ${JSON.stringify(pl.serve.args)}`
    );
  }
});

test('plan: a python project that also emits HTML gets both previews', async () => {
  const project = await fixture('py-plus-html', {
    'main.py': 'print("writes a report")\n',
    'index.html': '<!doctype html><h1>report</h1>\n',
  });
  const pl = await toolchain.plan(project);
  assert.equal(pl.htmlEntry, 'index.html');
  assert.ok(pl.doneMeans.includes('index.html'), 'the HTML artefact must be part of done');
});

test('plan: a Go project is recognised by go.mod', async () => {
  const project = await fixture('go-proj', {
    'go.mod': 'module example.com/x\n\ngo 1.22\n',
    'main.go': 'package main\n\nfunc main() { println("hi") }\n',
  });
  const pl = await toolchain.plan(project);
  assert.equal(pl.language, 'Go');
  assert.match(pl.kind, /^go-(script|web|unavailable)$/);
  assert.equal(pl.entry, 'main.go');
});

test('plan: an empty project is honestly unknown', async () => {
  const project = await fixture('empty', {});
  const pl = await toolchain.plan(project);
  assert.equal(pl.kind, 'unknown');
  assert.equal(pl.preview, 'none');
  assert.equal(pl.language, null);
});

test('plan never leaks a filesystem path into anything a chat tab could see', async () => {
  // Every field of the plan can end up in a prompt. An absolute path there
  // leaks the OS username to a third-party chat service.
  const project = await fixture('leak-check', {
    'package.json': JSON.stringify({ name: 'x', scripts: { dev: 'vite' } }),
    'index.html': '<!doctype html>\n',
  });
  const serialized = JSON.stringify(await toolchain.plan(project));
  assert.ok(!serialized.includes(workspace.ROOT.replace(/\\/g, '\\\\')), 'workspace root leaked');
  assert.ok(!/[A-Za-z]:[\\/]{1,2}Users/i.test(serialized), 'a Windows user path leaked');
  assert.ok(!/\/home\/[\w.-]+/.test(serialized), 'a POSIX home path leaked');
});

/* ---------------------------------------------------------------- inspect */

test('inspect reports what package.json declares, and shrugs when there is none', async () => {
  const withPkg = await fixture('inspect-yes', {
    'package.json': JSON.stringify({
      name: 'thing',
      scripts: { dev: 'vite', build: 'vite build' },
      dependencies: { react: '19.0.0' },
      devDependencies: { vite: '^6' },
    }),
  });
  assert.deepEqual(await toolchain.inspect(withPkg), {
    hasPackageJson: true,
    scripts: ['dev', 'build'],
    deps: 2,
    name: 'thing',
  });

  const bare = await fixture('inspect-no', { 'main.py': 'print(1)\n' });
  assert.deepEqual(await toolchain.inspect(bare), {
    hasPackageJson: false,
    scripts: [],
    deps: 0,
    name: null,
  });

  // Malformed JSON must not throw - the agents write this file.
  const broken = await fixture('inspect-broken', { 'package.json': '{ not json' });
  assert.equal((await toolchain.inspect(broken)).hasPackageJson, false);
});

test('findStaticEntry looks only in the three sane places', async () => {
  const nested = await fixture('static-nested', { 'public/index.html': '<!doctype html>\n' });
  assert.equal(await toolchain.findStaticEntry(nested), 'public/index.html');

  const none = await fixture('static-none', { 'notes.txt': 'hi\n' });
  assert.equal(await toolchain.findStaticEntry(none), null);
});

test('serverLog and serverErrors are silent for a project with no server', () => {
  const never = PREFIX + 'never-started';
  assert.equal(toolchain.serverLog(never), '');
  assert.equal(toolchain.serverErrors(never), '');
  assert.equal(toolchain.stopServer(never), false);
});

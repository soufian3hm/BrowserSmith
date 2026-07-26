'use strict';
/**
 * Runs the projects the agents write: install dependencies, start a dev server,
 * find its URL, and screenshot the running page.
 *
 * Everything is confined to workspace/<project>. Commands are allow-listed by
 * their executable, because the argument list originates from an AI reply and
 * must never be treated as a shell string - we always spawn without a shell.
 */
const { spawn } = require('node:child_process');
const { BrowserWindow, nativeImage, clipboard } = require('electron');
const path = require('node:path');
const fsp = require('node:fs/promises');
const workspace = require('./workspace');

const IS_WIN = process.platform === 'win32';

/** Only these executables may ever be launched. */
const ALLOWED = new Set(['npm', 'npx', 'node', 'pnpm', 'yarn', 'python', 'pip']);

/** On Windows the package managers are .cmd shims; node/python/pip are .exe. */
const CMD_SHIMS = new Set(['npm', 'npx', 'pnpm', 'yarn']);

/**
 * Node 20.12+ refuses to spawn .cmd/.bat with shell:false (CVE-2024-27980
 * hardening throws EINVAL), so on Windows the npm-family shims must go through
 * cmd.exe. The argv stays an array of fixed, app-authored strings and the
 * executable is still allow-listed, so no model text ever reaches a shell line.
 */
function spawnSpec(cmd, args) {
  if (IS_WIN && CMD_SHIMS.has(cmd)) {
    const comspec = process.env.ComSpec || 'cmd.exe';
    return { file: comspec, args: ['/d', '/s', '/c', cmd, ...args] };
  }
  return { file: cmd, args };
}

function exeName(cmd) {
  return IS_WIN && CMD_SHIMS.has(cmd) ? `${cmd}.cmd` : cmd;
}

/** A dev-server URL printed by vite / next / CRA / astro / etc. */
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/[^\s"']*)?/i;

const servers = new Map(); // project -> { child, url, log[] }

function projectDir(project) {
  // Reuse the workspace sandbox so a project name can never escape.
  return workspace.resolveSafe(String(project).replace(/[\\/]+$/, ''));
}

function emit(win, channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/**
 * Run a command to completion, streaming output to the renderer.
 * Resolves with {code, out} - a non-zero exit is data, not an exception,
 * because the agents are supposed to read and react to build failures.
 */
function run(win, project, cmd, args = [], opts = {}) {
  if (!ALLOWED.has(cmd)) {
    return Promise.reject(new Error(`command not allowed: ${cmd}`));
  }
  const cwd = projectDir(project);
  const timeoutMs = opts.timeoutMs ?? 300000;

  return new Promise((resolve, reject) => {
    let child;
    try {
      const spec = spawnSpec(cmd, args);
      child = spawn(spec.file, spec.args, {
        cwd,
        shell: false, // argv stays an array; model text never becomes a shell string
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'], // stdin EOF: interactive CLIs exit, not hang
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' },
      });
    } catch (e) {
      return reject(e);
    }

    const chunks = [];
    let settled = false;
    const push = (buf) => {
      const text = buf.toString();
      chunks.push(text);
      emit(win, 'tool:output', { project, cmd, text });
    };

    child.stdout.on('data', push);
    child.stderr.on('data', push);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      treeKill(child); // npm's real work runs in grandchildren; kill() leaves them alive
      resolve({ code: -1, out: chunks.join(''), timedOut: true });
    }, timeoutMs);

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out: chunks.join(''), timedOut: false });
    });
  });
}

/**
 * Start a long-running dev server and resolve as soon as it prints a URL.
 * The process stays alive afterwards so the preview can be loaded.
 */
function startServer(win, project, script = 'dev', opts = {}) {
  stopServer(project);
  const cwd = projectDir(project);
  const timeoutMs = opts.timeoutMs ?? 120000;

  return new Promise((resolve, reject) => {
    let child;
    try {
      const spec = spawnSpec('npm', ['run', script]);
      child = spawn(spec.file, spec.args, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', BROWSER: 'none' },
      });
    } catch (e) {
      return reject(e);
    }

    const entry = { child, url: null, log: [] };
    servers.set(project, entry);

    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };

    const onData = (buf) => {
      const text = buf.toString();
      entry.log.push(text);
      emit(win, 'tool:output', { project, cmd: `npm run ${script}`, text });
      const m = text.match(URL_RE);
      if (m && !entry.url) {
        entry.url = m[0].replace(/0\.0\.0\.0/, 'localhost').replace(/[.,)]+$/, '');
        // Give the server a breath to finish binding before anyone loads it.
        setTimeout(() => finish(resolve, { url: entry.url, pid: child.pid }), 1500);
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => finish(reject, e));
    child.on('close', (code) =>
      finish(reject, new Error(`dev server exited (${code}) before printing a URL`))
    );

    const timer = setTimeout(
      () => {
        stopServer(project); // do not leave the URL-less server running forever
        finish(reject, new Error('dev server printed no URL in time'));
      },
      timeoutMs
    );
  });
}

/** Kill a process and everything it spawned. */
function treeKill(child) {
  try {
    if (IS_WIN) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGTERM');
  } catch { /* already gone */ }
}

function stopServer(project) {
  const entry = servers.get(project);
  if (!entry) return false;
  treeKill(entry.child);
  servers.delete(project);
  return true;
}

function stopAll() {
  for (const project of [...servers.keys()]) stopServer(project);
}

/**
 * Load a URL in an offscreen window and capture it.
 * Saved under workspace/<project>/.preview/ and also placed on the clipboard,
 * which is how the screenshot gets pasted into a chat tab for review.
 */
async function screenshot(project, url, opts = {}) {
  const width = opts.width ?? 1280;
  const height = opts.height ?? 800;

  const win = new BrowserWindow({
    width,
    height,
    show: false,
    webPreferences: { offscreen: false, nodeIntegration: false, contextIsolation: true },
  });

  try {
    await win.loadURL(url);
    // Let fonts, images and any client-side render settle.
    await new Promise((r) => setTimeout(r, opts.settleMs ?? 2500));

    const image = await win.webContents.capturePage();
    const png = image.toPNG();

    const dir = path.join(projectDir(project), '.preview');
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'preview.png');
    await fsp.writeFile(file, png);

    clipboard.writeImage(nativeImage.createFromBuffer(png));

    const title = win.webContents.getTitle();
    const text = await win.webContents
      .executeJavaScript('document.body ? document.body.innerText.slice(0, 600) : ""')
      .catch(() => '');

    return { file, bytes: png.length, title, text, url };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/** Does this project have a package.json, and which scripts does it define? */
async function inspect(project) {
  const pkgPath = path.join(projectDir(project), 'package.json');
  try {
    const pkg = JSON.parse(await fsp.readFile(pkgPath, 'utf8'));
    return {
      hasPackageJson: true,
      scripts: Object.keys(pkg.scripts || {}),
      deps: Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length,
      name: pkg.name || null,
    };
  } catch {
    return { hasPackageJson: false, scripts: [], deps: 0, name: null };
  }
}

/** A static index.html with no package.json still deserves a preview. */
async function findStaticEntry(project) {
  for (const candidate of ['index.html', 'public/index.html', 'src/index.html']) {
    try {
      await fsp.access(path.join(projectDir(project), candidate));
      return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Scaffolding                                                         */
/* ------------------------------------------------------------------ */

/** package.json "name" must be a valid npm name; project names may not be. */
function slugify(name) {
  const s = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');
  return s || 'app';
}

function json(obj) {
  return JSON.stringify(obj, null, 2) + '\n';
}

/** Template files per mode. Each returns [{ rel, content }]. */
function templateFiles(project, modeKey) {
  const name = slugify(project);

  if (modeKey === 'nextjs') {
    return [
      {
        rel: 'package.json',
        content: json({
          name,
          version: '0.1.0',
          private: true,
          scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
          dependencies: { next: '15.1.6', react: '19.0.0', 'react-dom': '19.0.0' },
          devDependencies: {
            typescript: '^5.7.2',
            '@types/react': '^19.0.0',
            '@types/node': '^22.10.0',
          },
        }),
      },
      {
        rel: 'tsconfig.json',
        content: json({
          compilerOptions: {
            target: 'ES2017',
            lib: ['dom', 'dom.iterable', 'esnext'],
            allowJs: true,
            skipLibCheck: true,
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            module: 'esnext',
            moduleResolution: 'bundler',
            resolveJsonModule: true,
            isolatedModules: true,
            jsx: 'preserve',
            incremental: true,
            plugins: [{ name: 'next' }],
            paths: { '@/*': ['./*'] },
          },
          include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
          exclude: ['node_modules'],
        }),
      },
      {
        rel: 'next.config.mjs',
        content:
          "/** @type {import('next').NextConfig} */\n" +
          'const nextConfig = {};\n\nexport default nextConfig;\n',
      },
      {
        rel: 'app/layout.tsx',
        content: `import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "${name}",
  description: "Generated by buildgpt",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
      },
      {
        rel: 'app/globals.css',
        content: `/* Thin modern reset - dark-friendly. */
*, *::before, *::after { box-sizing: border-box; }
* { margin: 0; }
html, body { height: 100%; }
body {
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  background: #101014;
  color: #e7e7ec;
}
@media (prefers-color-scheme: light) {
  body { background: #fafafa; color: #17171a; }
}
img, picture, video, canvas, svg { display: block; max-width: 100%; }
input, button, textarea, select { font: inherit; }
p, h1, h2, h3, h4, h5, h6 { overflow-wrap: break-word; }
a { color: inherit; }
`,
      },
      {
        rel: 'app/page.tsx',
        content: `/**
 * SCAFFOLD PLACEHOLDER - replace this file.
 * The agents are expected to overwrite app/page.tsx with the real project.
 */
export default function Home() {
  return (
    <main style={{ padding: "4rem 2rem", textAlign: "center" }}>
      <h1>Scaffold placeholder</h1>
      <p>Replace app/page.tsx with the real application.</p>
    </main>
  );
}
`,
      },
      { rel: '.gitignore', content: 'node_modules/\n.next/\n' },
    ];
  }

  if (modeKey === 'vite') {
    return [
      {
        rel: 'package.json',
        content: json({
          name,
          version: '0.1.0',
          private: true,
          type: 'module',
          scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
          dependencies: { react: '19.0.0', 'react-dom': '19.0.0' },
          devDependencies: { vite: '^6.0.7', '@vitejs/plugin-react': '^4.3.4' },
        }),
      },
      {
        rel: 'vite.config.js',
        content: `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});
`,
      },
      {
        rel: 'index.html',
        content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${name}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`,
      },
      {
        rel: 'src/main.jsx',
        content: `import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`,
      },
      {
        rel: 'src/App.jsx',
        content: `/**
 * SCAFFOLD PLACEHOLDER - replace this file.
 * The agents are expected to overwrite src/App.jsx with the real project.
 */
export default function App() {
  return (
    <main style={{ padding: '4rem 2rem', textAlign: 'center' }}>
      <h1>Scaffold placeholder</h1>
      <p>Replace src/App.jsx with the real application.</p>
    </main>
  );
}
`,
      },
      { rel: '.gitignore', content: 'node_modules/\ndist/\n' },
    ];
  }

  if (modeKey === 'node') {
    return [
      {
        rel: 'package.json',
        content: json({
          name,
          version: '0.1.0',
          private: true,
          // No "type": "module": the seeded builder contract mandates CommonJS,
          // and the two sides must agree or every node run fails at verify.
          scripts: { start: 'node index.js' },
        }),
      },
      {
        rel: 'index.js',
        content: `// SCAFFOLD PLACEHOLDER - replace this file.
// The agents are expected to overwrite index.js with the real program.
console.log('scaffold placeholder - replace index.js');
`,
      },
      { rel: '.gitignore', content: 'node_modules/\n' },
    ];
  }

  if (modeKey === 'python') {
    return [
      {
        rel: 'main.py',
        content: `# SCAFFOLD PLACEHOLDER - replace this file.
# The agents are expected to overwrite main.py with the real program.
print("scaffold placeholder - replace main.py")
`,
      },
      {
        rel: 'requirements.txt',
        content: '# Add dependencies here, one per line.\n',
      },
    ];
  }

  // static / auto (or anything unknown): nothing to scaffold.
  return [];
}

/**
 * Write a runnable starter into workspace/<project>/ WITHOUT touching any
 * file that already exists - existing work is reported as skipped, never
 * overwritten. Returns { created: [rel...], skipped: [rel...] }.
 */
async function scaffold(project, modeKey) {
  const dir = projectDir(project);
  const files = templateFiles(project, modeKey);
  const created = [];
  const skipped = [];

  for (const { rel, content } of files) {
    const full = path.join(dir, ...rel.split('/'));
    await fsp.mkdir(path.dirname(full), { recursive: true });
    try {
      // 'wx' fails if the file exists - no check-then-write race.
      await fsp.writeFile(full, content, { encoding: 'utf8', flag: 'wx' });
      created.push(rel);
    } catch (e) {
      if (e && e.code === 'EEXIST') skipped.push(rel);
      else throw e;
    }
  }
  return { created, skipped };
}

/* ------------------------------------------------------------------ */
/* User terminal                                                       */
/* ------------------------------------------------------------------ */

/**
 * Run a HUMAN-TYPED command line in a real shell.
 *
 * This channel exists ONLY for commands the user types into the terminal
 * panel themselves. AI-driven execution must stay on the allow-listed run()
 * above - model output never reaches a shell string through here.
 *
 * An empty project resolves to the workspace ROOT; anything else is confined
 * to workspace/<project>. Output streams to the renderer as "term:output".
 */
function runShell(win, project, commandLine) {
  const proj = String(project || '').trim();
  const cwd = proj ? projectDir(proj) : workspace.ROOT;
  const line = String(commandLine || '').trim();
  if (!line) return Promise.resolve({ code: 0, timedOut: false });

  const TIMEOUT_MS = 600000; // 10 minutes

  return new Promise((resolve, reject) => {
    fsp.mkdir(cwd, { recursive: true }).then(() => {
      let child;
      try {
        child = spawn(
          IS_WIN ? 'powershell.exe' : '/bin/sh',
          IS_WIN
            ? ['-NoProfile', '-NonInteractive', '-Command', line]
            : ['-lc', line],
          {
            cwd,
            shell: false,
            windowsHide: true,
            env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
          }
        );
      } catch (e) {
        return reject(e);
      }

      let settled = false;
      const push = (buf) => {
        emit(win, 'term:output', { project: proj, text: buf.toString() });
      };
      child.stdout.on('data', push);
      child.stderr.on('data', push);

      const killTree = () => {
        try {
          if (IS_WIN) {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
              windowsHide: true,
            });
          } else {
            child.kill('SIGKILL');
          }
        } catch { /* already gone */ }
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        killTree();
        emit(win, 'term:output', {
          project: proj,
          text: '\n[terminal] command timed out after 10 minutes - killed\n',
        });
        resolve({ code: -1, timedOut: true });
      }, TIMEOUT_MS);

      child.on('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, timedOut: false });
      });
    }, reject);
  });
}

module.exports = {
  run,
  startServer,
  stopServer,
  stopAll,
  screenshot,
  inspect,
  findStaticEntry,
  projectDir,
  scaffold,
  runShell,
  ALLOWED,
};

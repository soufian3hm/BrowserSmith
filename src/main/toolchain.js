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

/**
 * Only these executables may ever be launched.
 *
 * The list is broad on purpose - the whole point is that any project the agents
 * can write, they can also run - but it is still a fixed allow-list: the
 * argument arrays are built by this file, never by model output.
 */
const ALLOWED = new Set([
  // JS/TS
  'npm', 'npx', 'node', 'pnpm', 'yarn', 'bun', 'deno',
  // Python
  'python', 'python3', 'pip', 'pip3', 'uv',
  // Compiled
  'go', 'cargo', 'rustc', 'dotnet', 'javac', 'java', 'mvn', 'gradle',
  // Scripting
  'ruby', 'bundle', 'php', 'perl', 'bash', 'sh',
  // Build drivers
  'make', 'cmake', 'dart', 'flutter', 'swift', 'elixir', 'mix',
]);

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
  return startProcessServer(win, project, 'npm', ['run', script], opts);
}

/**
 * Start any long-running server and resolve once it prints a URL.
 *
 * Not npm-specific: a Python backend (`python app.py`, flask, http.server) is
 * just as much a dev server, and forcing every project through `npm run dev`
 * is what made a Python + HTML project unverifiable.
 */
function startProcessServer(win, project, cmd, args, opts = {}) {
  if (!ALLOWED.has(cmd)) {
    return Promise.reject(new Error(`command not allowed: ${cmd}`));
  }
  stopServer(project);
  const cwd = projectDir(project);
  const timeoutMs = opts.timeoutMs ?? 120000;

  return new Promise((resolve, reject) => {
    let child;
    try {
      const spec = spawnSpec(cmd, args);
      child = spawn(spec.file, spec.args, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NO_COLOR: '1',
          FORCE_COLOR: '0',
          BROWSER: 'none',
          // Python buffers stdout when it is not a TTY, so a Flask/http.server
          // banner would arrive minutes late - long after we gave up waiting
          // for a URL. Unbuffered output makes the URL appear immediately.
          PYTHONUNBUFFERED: '1',
        },
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
      emit(win, 'tool:output', { project, cmd: `${cmd} ${args.join(' ')}`, text });
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
/**
 * Get a page past its start screen and into its actual working state.
 *
 * Everything here is a no-op on a page that does not care: a click on empty
 * space, Enter, and Space are all harmless on a static document. Returns a
 * plain-English list of what was done so the reviewer can be told the app was
 * actually driven, not just loaded.
 */
async function startTheApp(win, { width, height }) {
  const wc = win.webContents;
  const done = [];
  const key = (keyCode) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode });
    wc.sendInputEvent({ type: 'keyUp', keyCode });
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    // A click first: many start screens are a button, and a click also gives
    // the canvas keyboard focus so the key presses below actually land.
    const x = Math.round(width / 2);
    const y = Math.round(height / 2);
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    done.push('clicked the centre of the page');
    await wait(400);

    key('Return');
    key('Space');
    done.push('pressed Enter and Space to dismiss any start screen');
    await wait(900);

    // Hold a movement key briefly so a game shows motion rather than frame one.
    for (let i = 0; i < 12; i++) {
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'w' });
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
      await wait(60);
    }
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'w' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
    done.push('held W and Right for ~1s to exercise the controls');
  } catch {
    // Driving the page is best-effort; a screenshot of the menu still beats none.
  }
  return done;
}

async function screenshot(project, url, opts = {}) {
  const width = opts.width ?? 1280;
  const height = opts.height ?? 800;

  const win = new BrowserWindow({
    width,
    height,
    show: false,
    webPreferences: { offscreen: false, nodeIntegration: false, contextIsolation: true },
  });

  // A screenshot shows THAT the page is broken; only the console and the error
  // overlay say WHY. Without these the reviewer could report "shows an error"
  // and the builder had nothing to work from - now it gets the real message,
  // file and line.
  let interactions = [];
  const consoleErrors = [];
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level < 2) return; // 0 verbose, 1 info, 2 warning, 3 error
    const where = sourceId ? ` (${String(sourceId).split('/').pop()}:${line})` : '';
    consoleErrors.push(`${level === 3 ? 'error' : 'warn'}: ${message}${where}`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    consoleErrors.push(`page failed to load: ${desc} (${code})`);
  });

  try {
    await win.loadURL(url);
    // Let fonts, images and any client-side render settle.
    await new Promise((r) => setTimeout(r, opts.settleMs ?? 2500));

    // Games and apps commonly open on a title screen ("PRESS ENTER TO DRIVE").
    // Screenshotting that and asking "does this satisfy the request?" produced
    // a FIX verdict on a perfectly working game, so drive past the menu first
    // and let it run for a beat before looking.
    if (opts.interact !== false) {
      interactions = await startTheApp(win, { width, height });
      await new Promise((r) => setTimeout(r, 1200));
    }

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

    // Next.js renders its error overlay inside a <nextjs-portal> shadow root,
    // so document.body.innerText does not contain a word of it. Vite and CRA
    // use their own overlay elements. Read whichever is present.
    const overlay = await win.webContents
      .executeJavaScript(
        `(() => {
          const out = [];
          for (const el of document.querySelectorAll('nextjs-portal, vite-error-overlay, #vite-error-overlay')) {
            const root = el.shadowRoot || el;
            const t = (root.textContent || '').trim();
            if (t) out.push(t);
          }
          const plain = document.querySelector('#webpack-dev-server-client-overlay, .error-overlay');
          if (plain && plain.textContent.trim()) out.push(plain.textContent.trim());
          return out.join('\\n').slice(0, 2000);
        })()`
      )
      .catch(() => '');

    return {
      file,
      bytes: png.length,
      title,
      text,
      url,
      overlay,
      interactions,
      consoleErrors: consoleErrors.slice(0, 20),
      // One field the caller can drop straight into a prompt.
      diagnostics: [overlay, consoleErrors.slice(0, 12).join('\n')]
        .filter(Boolean)
        .join('\n')
        .slice(0, 3000),
    };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * Recent dev-server output for a project.
 *
 * A compile error (bad import, TypeScript failure) is printed by the dev server
 * and may never reach the browser at all, so the screenshot path alone cannot
 * see it. Returned newest-last and trimmed, ready to paste into a prompt.
 */
function serverLog(project, maxChars = 3000) {
  const entry = servers.get(project);
  if (!entry) return '';
  const text = entry.log.join('');
  // Compile failures are what matter; keep the tail, that is where they land.
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

/** Lines from a dev-server log that look like real problems. */
function serverErrors(project) {
  const text = serverLog(project, 8000);
  if (!text) return '';
  const hits = text
    .split('\n')
    .filter((l) => /(error|failed|cannot find|module not found|unhandled|✗|×)/i.test(l))
    .map((l) => l.trim())
    .filter(Boolean);
  return [...new Set(hits)].slice(-15).join('\n');
}

/**
 * Does this source listen on a socket rather than just print and exit?
 *
 * One regex across every language: the distinction that matters is
 * "serve and preview a page" vs "run and read stdout", and it is the same
 * question whatever the project is written in.
 */
const SERVER_RE = new RegExp(
  [
    // Python
    'flask|fastapi|uvicorn|django|aiohttp|bottle|tornado|starlette|http\\.server|socketserver|BaseHTTPRequestHandler|run_simple',
    // Node
    'express|fastify|koa|hapi|next|nuxt|vite|http\\.createServer|createServer|listen\\s*\\(',
    // Go
    'net/http|http\\.ListenAndServe|gin\\.|echo\\.New|fiber\\.New',
    // Rust
    'actix_web|axum|rocket|warp|tiny_http',
    // Java / .NET
    'SpringApplication|@RestController|HttpListener|WebApplication\\.CreateBuilder|app\\.MapGet',
    // Ruby / PHP / others
    'Sinatra|Rails|rack|WEBrick|Phoenix\\.Endpoint',
  ].join('|'),
  'i'
);

/** Executable availability, resolved once per session. */
const binCache = new Map();
function hasBinary(cmd) {
  if (binCache.has(cmd)) return binCache.get(cmd);
  let ok = false;
  try {
    const probe = require('node:child_process').spawnSync(
      IS_WIN ? 'where' : 'which',
      [cmd],
      { windowsHide: true, timeout: 4000 }
    );
    ok = probe.status === 0;
  } catch {
    ok = false;
  }
  binCache.set(cmd, ok);
  return ok;
}

/** First binary in the list that exists on this machine. */
const firstBinary = (...cands) => cands.find((c) => hasBinary(c)) || null;

/**
 * How to install, run and preview each ecosystem.
 *
 * Declarative on purpose: "make it work for everything" is a data problem, and
 * adding a language should mean adding a row here, not another branch in the
 * planner. `detect` runs against the project's file list; `sources` is a sample
 * of its text so the server-vs-script question can be answered by what the code
 * actually does rather than by which language it is written in.
 */
const RUNTIMES = [
  {
    key: 'go',
    label: 'Go',
    bin: () => firstBinary('go'),
    detect: (f) => f.includes('go.mod') || f.some((x) => x.endsWith('.go')),
    entry: (f) => f.find((x) => x === 'main.go') || f.find((x) => x.endsWith('.go')),
    install: (f) => (f.includes('go.mod') ? { cmd: 'go', args: ['mod', 'download'], optional: true } : null),
    cmd: (bin, entry, f) => ({ cmd: bin, args: f.includes('go.mod') ? ['run', '.'] : ['run', entry] }),
  },
  {
    key: 'rust',
    label: 'Rust',
    bin: () => firstBinary('cargo'),
    detect: (f) => f.includes('Cargo.toml'),
    entry: () => 'src/main.rs',
    install: () => null, // cargo run fetches and builds in one step
    cmd: (bin) => ({ cmd: bin, args: ['run'] }),
  },
  {
    key: 'dotnet',
    label: '.NET',
    bin: () => firstBinary('dotnet'),
    detect: (f) => f.some((x) => /\.(csproj|fsproj|sln)$/.test(x)),
    entry: (f) => f.find((x) => /\.(csproj|fsproj)$/.test(x)),
    install: () => ({ cmd: 'dotnet', args: ['restore'], optional: true }),
    cmd: (bin) => ({ cmd: bin, args: ['run'] }),
  },
  {
    key: 'java-maven',
    label: 'Java (Maven)',
    bin: () => firstBinary('mvn'),
    detect: (f) => f.includes('pom.xml'),
    entry: () => 'pom.xml',
    install: () => null,
    cmd: (bin) => ({ cmd: bin, args: ['-q', 'compile', 'exec:java'] }),
  },
  {
    key: 'java-gradle',
    label: 'Java (Gradle)',
    bin: () => firstBinary('gradle'),
    detect: (f) => f.includes('build.gradle') || f.includes('build.gradle.kts'),
    entry: (f) => (f.includes('build.gradle') ? 'build.gradle' : 'build.gradle.kts'),
    install: () => null,
    cmd: (bin) => ({ cmd: bin, args: ['-q', 'run'] }),
  },
  {
    key: 'ruby',
    label: 'Ruby',
    bin: () => firstBinary('ruby'),
    detect: (f) => f.some((x) => x.endsWith('.rb')),
    entry: (f) =>
      ['main.rb', 'app.rb', 'server.rb'].find((c) => f.includes(c)) || f.find((x) => x.endsWith('.rb')),
    install: (f) => (f.includes('Gemfile') ? { cmd: 'bundle', args: ['install'], optional: true } : null),
    cmd: (bin, entry) => ({ cmd: bin, args: [entry] }),
  },
  {
    key: 'php',
    label: 'PHP',
    bin: () => firstBinary('php'),
    detect: (f) => f.some((x) => x.endsWith('.php')),
    entry: (f) => ['index.php', 'app.php'].find((c) => f.includes(c)) || f.find((x) => x.endsWith('.php')),
    install: () => null,
    // PHP's built-in server is the sane way to preview a PHP project.
    cmd: (bin, entry) => ({ cmd: bin, args: ['-S', 'localhost:8000'], serves: true, entry }),
  },
  {
    key: 'python',
    label: 'Python',
    bin: () => firstBinary('python', 'python3'),
    detect: (f) => f.some((x) => x.endsWith('.py')),
    entry: (f) =>
      ['main.py', 'app.py', 'server.py', 'run.py', '__main__.py', 'index.py'].find((c) => f.includes(c)) ||
      f.find((x) => x.endsWith('.py') && !x.includes('/')) ||
      f.find((x) => x.endsWith('.py')),
    install: (f) =>
      f.includes('requirements.txt')
        ? { cmd: hasBinary('pip') ? 'pip' : 'pip3', args: ['install', '-r', 'requirements.txt'], optional: true }
        : null,
    cmd: (bin, entry) => ({ cmd: bin, args: [entry] }),
  },
  {
    key: 'deno',
    label: 'Deno',
    bin: () => firstBinary('deno'),
    detect: (f) => f.includes('deno.json') || f.includes('deno.jsonc'),
    entry: (f) => ['main.ts', 'mod.ts', 'index.ts'].find((c) => f.includes(c)) || 'main.ts',
    install: () => null,
    cmd: (bin, entry) => ({ cmd: bin, args: ['run', '-A', entry] }),
  },
  {
    key: 'shell',
    label: 'Shell',
    bin: () => firstBinary('bash', 'sh'),
    detect: (f) => f.some((x) => x.endsWith('.sh')),
    entry: (f) => ['main.sh', 'run.sh', 'start.sh'].find((c) => f.includes(c)) || f.find((x) => x.endsWith('.sh')),
    install: () => null,
    cmd: (bin, entry) => ({ cmd: bin, args: [entry] }),
  },
  {
    key: 'make',
    label: 'Make',
    bin: () => firstBinary('make'),
    detect: (f) => f.includes('Makefile') || f.includes('makefile'),
    entry: () => 'Makefile',
    install: () => null,
    cmd: (bin) => ({ cmd: bin, args: ['run'] }),
  },
];

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function readIfPresent(p) {
  try { return await fsp.readFile(p, 'utf8'); } catch { return ''; }
}

/**
 * Decide how to build, run and preview a project from WHAT IS ON DISK, not
 * from the mode the user picked.
 *
 * The mode used to pick one strategy up front - "browser" meant npm + a dev
 * server, "run" meant execute and read stdout - so a Python backend serving an
 * HTML frontend had nowhere to go. The auditor was told done meant
 * `python main.py runs cleanly`, saw .html files, and rejected the project as
 * impossible. A project can legitimately be several of these things at once,
 * so the plan is derived per project and can both run a server AND preview a
 * page.
 */
async function plan(project) {
  const dir = projectDir(project);
  const files = await list(project);

  const pkgRaw = await readIfPresent(path.join(dir, 'package.json'));
  let pkg = null;
  try { pkg = pkgRaw ? JSON.parse(pkgRaw) : null; } catch { pkg = null; }
  const scripts = pkg ? Object.keys(pkg.scripts || {}) : [];

  const htmlEntry =
    ['index.html', 'public/index.html', 'src/index.html', 'templates/index.html'].find((c) =>
      files.includes(c)
    ) || files.find((f) => f.endsWith('.html')) || null;

  const steps = [];

  // 1. A declared dev/start script is the strongest signal there is - the
  //    project itself is telling us how it wants to be run.
  const webScript = ['dev', 'start', 'serve', 'preview'].find((s) => scripts.includes(s));
  if (pkg && webScript) {
    const pm = pkg.packageManager && /pnpm/.test(pkg.packageManager) ? 'pnpm'
      : pkg.packageManager && /yarn/.test(pkg.packageManager) ? 'yarn'
      : files.includes('bun.lockb') && hasBinary('bun') ? 'bun'
      : 'npm';
    if (Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length) {
      steps.push({ kind: 'install', cmd: pm, args: ['install'], timeoutMs: 420000 });
    }
    return {
      kind: 'node-web',
      language: 'JavaScript/TypeScript',
      steps,
      serve: { cmd: pm, args: ['run', webScript], label: `${pm} run ${webScript}` },
      preview: 'browser',
      htmlEntry,
      doneMeans: `\`${pm} run ${webScript}\` serves the app and the page renders correctly`,
      why: `package.json defines a "${webScript}" script`,
    };
  }

  // 2. Every other ecosystem, by what is actually on disk.
  for (const rt of RUNTIMES) {
    if (!rt.detect(files)) continue;

    const bin = rt.bin();
    const entry = rt.entry(files) || null;

    if (!bin) {
      // Detected but unrunnable. Say so plainly instead of inventing a
      // verification the machine cannot perform - that mismatch is exactly
      // what made the auditor reject a valid project as impossible.
      return {
        kind: `${rt.key}-unavailable`,
        language: rt.label,
        steps: [],
        preview: htmlEntry ? 'browser' : 'none',
        htmlEntry,
        entry,
        unavailable: rt.label,
        doneMeans:
          `the ${rt.label} sources are complete and correct` +
          (htmlEntry ? `, and ${htmlEntry} opens and shows the result` : '') +
          ` (${rt.label} is not installed on this machine, so it cannot be executed here - do not treat that as a defect in the code)`,
        why: `${rt.label} project detected but no runtime installed`,
      };
    }

    const inst = rt.install(files);
    if (inst) steps.push({ kind: 'install', timeoutMs: 300000, ...inst });

    const sources = (
      await Promise.all(
        files.filter((f) => /\.(py|js|ts|go|rs|rb|php|java|cs|ex)$/.test(f))
          .slice(0, 12)
          .map((f) => readIfPresent(path.join(dir, f)))
      )
    ).join('\n');

    const spec = rt.cmd(bin, entry, files);
    const serves = spec.serves || SERVER_RE.test(sources);

    if (serves) {
      return {
        kind: `${rt.key}-web`,
        language: rt.label,
        steps,
        serve: { cmd: spec.cmd, args: spec.args, label: `${spec.cmd} ${spec.args.join(' ')}` },
        preview: 'browser',
        entry,
        htmlEntry,
        doneMeans:
          `\`${spec.cmd} ${spec.args.join(' ')}\` starts the server and the page it serves renders correctly` +
          (htmlEntry ? ` (it serves ${htmlEntry})` : ''),
        why: `${rt.label} sources open a network listener`,
      };
    }

    return {
      kind: `${rt.key}-script`,
      language: rt.label,
      steps,
      run: {
        cmd: spec.cmd,
        args: spec.args,
        label: `${spec.cmd} ${spec.args.join(' ')}`,
        timeoutMs: 120000,
      },
      preview: htmlEntry ? 'output+browser' : 'output',
      entry,
      htmlEntry,
      doneMeans:
        `\`${spec.cmd} ${spec.args.join(' ')}\` runs cleanly and does what was asked` +
        (htmlEntry ? `, and ${htmlEntry} opens and shows the result` : ''),
      why: htmlEntry ? `${rt.label} entry plus an HTML artefact` : `${rt.label} entry, no listener opened`,
    };
  }

  // 3. Node project with no dev script.
  if (pkg) {
    if (Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length) {
      steps.push({ kind: 'install', cmd: 'npm', args: ['install'], timeoutMs: 420000 });
    }
    const entry = files.includes('index.js') ? 'index.js' : files.find((f) => f.endsWith('.js')) || 'index.js';
    return {
      kind: 'node-script',
      language: 'JavaScript/TypeScript',
      steps,
      run: { cmd: 'node', args: [entry], label: `node ${entry}`, timeoutMs: 120000 },
      preview: htmlEntry ? 'output+browser' : 'output',
      entry,
      htmlEntry,
      doneMeans: `\`node ${entry}\` runs cleanly and does what was asked`,
      why: 'package.json with no dev/start script',
    };
  }

  // 4. Plain static page.
  if (htmlEntry) {
    return {
      kind: 'static',
      language: 'HTML/CSS/JS',
      steps,
      preview: 'browser',
      htmlEntry,
      doneMeans: `opening ${htmlEntry} straight from disk shows the finished result`,
      why: `${htmlEntry} with no build step`,
    };
  }

  return {
    kind: 'unknown',
    language: null,
    steps,
    preview: 'none',
    doneMeans: 'the files satisfy the request',
    why: 'no runnable entry point found yet',
  };
}

/** Project-relative files, install/build noise excluded. */
async function list(project) {
  const dir = projectDir(project);
  const out = [];
  async function walk(d, rel) {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (['node_modules', '.next', '.git', '.preview', '__pycache__', 'venv', '.venv'].includes(e.name)) continue;
        await walk(path.join(d, e.name), rel ? `${rel}/${e.name}` : e.name);
      } else {
        out.push(rel ? `${rel}/${e.name}` : e.name);
      }
    }
  }
  await walk(dir, '');
  return out;
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
  plan,
  startProcessServer,
  serverLog,
  serverErrors,
  ALLOWED,
};

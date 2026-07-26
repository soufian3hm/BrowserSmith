'use strict';
/**
 * Runs the projects the agents write: install dependencies, build, start a dev
 * server, find its URL, run the test suite, and screenshot the running page.
 *
 * Everything is confined to workspace/<project>. Commands are allow-listed by
 * their executable AND validated argument by argument, because the argument
 * list originates from an AI reply and must never be treated as a shell string
 * - we always spawn without a shell.
 */
const { spawn } = require('node:child_process');
const net = require('node:net');
const { BrowserWindow, nativeImage, clipboard } = require('electron');
const path = require('node:path');
const fsp = require('node:fs/promises');
// Sync fs alongside the promises API: PATH probing answers a question asked from
// inside synchronous planning code, and awaiting it would spread async through
// every RUNTIMES entry for a handful of stat calls.
const fs = require('node:fs');
const workspace = require('./workspace');

const IS_WIN = process.platform === 'win32';

/**
 * Only these executables may ever be launched.
 *
 * This is exactly the set `plan()` can emit - nothing more. The previous list
 * carried a dozen binaries the planner never produces, and `npx` in particular
 * turned the allow-list into a fiction: `npx <anything>` is the whole npm
 * registry. An allow-list is only worth something if it is the smallest set
 * that still runs every project the agents can write.
 */
const ALLOWED = new Set([
  // JS/TS
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'node',
  'deno',
  // Python
  'python',
  'python3',
  'pip',
  'pip3',
  // Compiled
  'go',
  'cargo',
  'dotnet',
  'mvn',
  'gradle',
  // Scripting
  'ruby',
  'bundle',
  'php',
  'bash',
  'sh',
  // Build drivers
  'make',
]);

/**
 * Flags that turn an interpreter into an arbitrary-code evaluator.
 *
 * The executable allow-list alone buys nothing while `node -e`, `python -c` or
 * `bash -c` is one argument away, and `args` reaches this file over IPC from
 * the renderer. `python -m` stays permitted: the planner emits it for uvicorn
 * and http.server, which are how two whole ecosystems get previewed.
 */
const DENY_FLAGS = {
  node: ['-e', '--eval', '-p', '--print', '--experimental-loader', '--require', '-r'],
  deno: ['eval'],
  python: ['-c'],
  python3: ['-c'],
  bash: ['-c'],
  sh: ['-c'],
  ruby: ['-e'],
  php: ['-r'],
};

/** On Windows the package managers are .cmd shims; node/python/pip are .exe. */
const CMD_SHIMS = new Set(['npm', 'pnpm', 'yarn']);

/**
 * cmd.exe does not parse argv the way Node quotes it.
 *
 * Node quotes spawn arguments with MSVCRT rules; cmd.exe uses its own, and
 * still expands `&`, `|`, `^`, `<`, `>` and `%VAR%` inside those quotes - the
 * BatBadBut / CVE-2024-27980 class. Every argument that will pass through
 * ComSpec must therefore be plain enough that no cmd metacharacter survives.
 */
const CMD_SAFE_ARG = /^[A-Za-z0-9._@:=,+\-/\\]+$/;

/**
 * Reject anything that is not a plain, app-shaped argument.
 *
 * Returns the validated array. Throws with the offending value named, because
 * a silent drop would change the command into a different, still-running one.
 */
function validateArgv(cmd, args) {
  if (!Array.isArray(args)) throw new Error('arguments must be an array');
  if (args.length > 64) throw new Error('too many arguments');
  const deny = DENY_FLAGS[cmd] || [];
  const out = [];
  for (const raw of args) {
    if (typeof raw !== 'string') throw new Error('argument is not a string');
    if (raw.length > 4096) throw new Error('argument is too long');
    // A newline or an ESC reaches the child untouched - measured, not assumed:
    // spawnSync with an ESC and a newline in an argument exits 0 - and either
    // can rewrite a terminal line so the panel hides what actually ran. NUL is
    // the opposite case: Node rejects it first with ERR_INVALID_ARG_VALUE,
    // naming an args[] index belonging to the command this file assembles
    // rather than anything the caller passed. Screening the whole C0 range here
    // means both failures name the argument instead.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(raw)) {
      throw new Error('argument contains a control character');
    }
    if (deny.includes(raw.toLowerCase())) {
      throw new Error(`argument not allowed for ${cmd}: ${raw}`);
    }
    out.push(raw);
  }
  if (IS_WIN && CMD_SHIMS.has(cmd)) {
    for (const a of out) {
      if (!CMD_SAFE_ARG.test(a)) throw new Error(`unsafe argument for cmd.exe: ${a}`);
    }
  }
  return out;
}

/**
 * Node 20.12+ refuses to spawn .cmd/.bat with shell:false (CVE-2024-27980
 * hardening throws EINVAL), so on Windows the npm-family shims must go through
 * cmd.exe. Arguments are validated by validateArgv first, so nothing that
 * cmd.exe would re-interpret can reach this line.
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

/**
 * A filename becomes an argument, never a flag.
 *
 * `python x.py` where x.py is literally named `-c...` runs the name as code.
 * The planner already refuses dash-leading basenames; prefixing with an
 * explicit relative directory closes the same hole for every runtime at once.
 */
function asEntryArg(entry) {
  const rel = String(entry).replace(/\\/g, '/');
  return IS_WIN ? '.\\' + rel.replace(/\//g, '\\') : './' + rel;
}

/** A dev-server URL printed by vite / next / CRA / astro / etc. */
const URL_RE =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[::\])(?::\d+)?(?:\/[^\s"']*)?/i;

const servers = new Map(); // project -> { child, url, log[], cmd, port, startedAt }

/**
 * Every child this module has spawned and not yet reaped.
 *
 * A dev server started from the built-in terminal, or a seven-minute install,
 * used to be reachable by nothing: stopServer only knew the `servers` map, so
 * quitting the app left the process running with no way to kill it from the UI.
 */
const live = new Set();

function trackChild(child, meta) {
  if (!child) return;
  const rec = { child, ...meta };
  live.add(rec);
  child.on('close', () => live.delete(rec));
  child.on('error', () => live.delete(rec));
}

function projectDir(project) {
  // Reuse the workspace sandbox so a project name can never escape.
  const name = String(project).replace(/[\\/]+$/, '');
  workspace.assertProjectName(name);
  return workspace.resolveSafe(name);
}

function emit(win, channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/* ------------------------------------------------------------------ */
/* Per-project run log                                                 */
/* ------------------------------------------------------------------ */

/**
 * Everything a run printed, kept on disk next to the project.
 *
 * The terminal panel is a ring buffer: by the time a run fails, the output
 * that explains why has usually scrolled away and there is no artefact left to
 * read.
 *
 * Writes are batched on a timer rather than issued per chunk: a build that
 * prints a thousand lines a second would otherwise queue a thousand
 * mkdir+stat+append round trips behind each other, and the log is a
 * convenience - it must never become the slow part of a run. Failures are
 * swallowed for the same reason.
 */
const LOG_DIR = '.browsersmith';
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const LOG_FLUSH_MS = 250;
const logBuffers = new Map(); // project -> { parts[], bytes, timer, writing }

function appendRunLog(project, text) {
  if (!project || !text) return;
  let buf = logBuffers.get(project);
  if (!buf) {
    buf = { parts: [], bytes: 0, timer: null, writing: false };
    logBuffers.set(project, buf);
  }
  buf.parts.push(text);
  buf.bytes += text.length;
  // Drop the oldest pending text rather than grow without bound if the writer
  // cannot keep up with the producer.
  while (buf.bytes > LOG_MAX_BYTES && buf.parts.length > 1) {
    buf.bytes -= buf.parts.shift().length;
  }
  if (buf.timer) return;
  buf.timer = setTimeout(() => flushRunLog(project), LOG_FLUSH_MS);
  buf.timer.unref?.();
}

async function flushRunLog(project) {
  const buf = logBuffers.get(project);
  if (!buf) return;
  buf.timer = null;
  if (buf.writing || !buf.parts.length) return;
  const text = buf.parts.join('');
  buf.parts = [];
  buf.bytes = 0;
  buf.writing = true;
  try {
    const dir = path.join(projectDir(project), LOG_DIR);
    const file = path.join(dir, 'run.log');
    await fsp.mkdir(dir, { recursive: true });
    const stat = await fsp.stat(file).catch(() => null);
    if (stat && stat.size > LOG_MAX_BYTES) {
      await fsp.rm(file, { force: true }); // one rotation is enough to stay bounded
    }
    await fsp.appendFile(file, text);
  } catch {
    // An invalid project name, a deleted folder, a full disk: none of these
    // are worth failing a run over.
  } finally {
    buf.writing = false;
    if (buf.parts.length && !buf.timer) {
      buf.timer = setTimeout(() => flushRunLog(project), LOG_FLUSH_MS);
      buf.timer.unref?.();
    }
  }
}

/* ------------------------------------------------------------------ */
/* Environment                                                         */
/* ------------------------------------------------------------------ */

/**
 * Project-local .env, because half the frameworks the agents write assume one.
 *
 * Parsed here rather than by adding a dependency: the format is KEY=VALUE and
 * the failure mode of a clever parser (executing `$(...)`) is worse than the
 * failure mode of a dumb one. Keys are restricted so a malformed file cannot
 * overwrite PATH or NODE_OPTIONS out from under the child.
 */
const ENV_PROTECTED = new Set(['PATH', 'Path', 'NODE_OPTIONS', 'ComSpec', 'SystemRoot']);

function parseDotEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (ENV_PROTECTED.has(m[1])) continue;
    out[m[1]] = value;
  }
  return out;
}

async function projectEnv(project) {
  const dir = projectDir(project);
  const merged = {};
  // .env first, .env.local second: local wins, which is what every framework
  // that reads these files does.
  for (const name of ['.env', '.env.local']) {
    const stat = await fsp.stat(path.join(dir, name)).catch(() => null);
    if (!stat || !stat.isFile() || stat.size > 128 * 1024) continue;
    Object.assign(merged, parseDotEnv(await readIfPresent(path.join(dir, name))));
  }
  return merged;
}

/* ------------------------------------------------------------------ */
/* Ports                                                               */
/* ------------------------------------------------------------------ */

/** Is this TCP port free on loopback right now? */
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/** The first free port at or after `from`, or null if the range is exhausted. */
async function findFreePort(from, tries = 20) {
  for (let p = from; p < from + tries; p++) {
    if (await portFree(p)) return p;
  }
  return null;
}

/**
 * Which process is holding a port, best effort.
 *
 * "EADDRINUSE" on its own is a dead end for a user who never saw the previous
 * run start a server. A pid at least lets them (or the Stop button) end it.
 */
function portHolder(port) {
  return new Promise((resolve) => {
    const file = IS_WIN ? 'netstat' : 'lsof';
    const args = IS_WIN ? ['-ano', '-p', 'tcp'] : ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'];
    let child;
    try {
      child = spawn(file, args, { windowsHide: true });
    } catch {
      return resolve(null);
    }
    let out = '';
    child.stdout.on('data', (b) => {
      out += b.toString();
    });
    child.stderr.on('data', () => {});
    child.on('error', () => resolve(null)); // netstat/lsof missing is not fatal
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      resolve(null);
    }, 4000);
    timer.unref?.();
    child.on('close', () => {
      clearTimeout(timer);
      const lines = out.split(/\r?\n/);
      if (IS_WIN) {
        const hit = lines.find((l) => /LISTENING/i.test(l) && new RegExp(`[:.]${port}\\b`).test(l));
        const pid = hit && hit.trim().split(/\s+/).pop();
        return resolve(pid && /^\d+$/.test(pid) ? { pid: Number(pid), name: null } : null);
      }
      const hit = lines[1];
      if (!hit) return resolve(null);
      const cols = hit.trim().split(/\s+/);
      const pid = Number(cols[1]);
      return resolve(Number.isFinite(pid) ? { pid, name: cols[0] } : null);
    });
  });
}

/** Kill whatever is listening on a port. Used by the UI's "free the port" action. */
async function freePort(port) {
  const holder = await portHolder(port);
  if (!holder) return { freed: false, reason: 'nothing is listening on that port' };
  // Never let the app kill itself out from under the user.
  if (holder.pid === process.pid) return { freed: false, reason: 'the port is held by this app' };
  try {
    if (IS_WIN) {
      const k = spawn('taskkill', ['/pid', String(holder.pid), '/T', '/F'], { windowsHide: true });
      k.on('error', () => {});
    } else {
      process.kill(holder.pid, 'SIGKILL');
    }
  } catch (e) {
    return { freed: false, pid: holder.pid, reason: e.message };
  }
  return { freed: true, pid: holder.pid };
}

const PORT_IN_USE_RE =
  /EADDRINUSE|address already in use|port .*is (?:already )?in use|listen tcp .*: bind/i;

function portFromText(text) {
  const m = String(text).match(/(?::|port\s+)(\d{2,5})\b/i);
  return m ? Number(m[1]) : null;
}

/* ------------------------------------------------------------------ */
/* Running commands                                                    */
/* ------------------------------------------------------------------ */

/** Output kept per command. The callers only ever read the last ~30 lines. */
const MAX_OUT_BYTES = 256 * 1024;

/**
 * Run a command to completion, streaming output to the renderer.
 * Resolves with {code, out} - a non-zero exit is data, not an exception,
 * because the agents are supposed to read and react to build failures.
 */
async function run(win, project, cmd, args = [], opts = {}) {
  if (!ALLOWED.has(cmd)) {
    throw new Error(`command not allowed: ${cmd}`);
  }
  const argv = validateArgv(cmd, args);
  const cwd = projectDir(project);
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 300000;
  const dotenv = await projectEnv(project).catch(() => ({}));

  return new Promise((resolve, reject) => {
    let child;
    try {
      const spec = spawnSpec(cmd, argv);
      child = spawn(spec.file, spec.args, {
        cwd,
        shell: false, // argv stays an array; model text never becomes a shell string
        windowsHide: true,
        windowsVerbatimArguments: false, // documented, not merely defaulted
        stdio: ['ignore', 'pipe', 'pipe'], // stdin EOF: interactive CLIs exit, not hang
        // A process group, so treeKill can end the grandchildren an installer
        // spawns rather than orphaning them.
        detached: !IS_WIN,
        env: { ...process.env, ...dotenv, NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' },
      });
    } catch (e) {
      return reject(e);
    }
    trackChild(child, { project, label: `${cmd} ${argv.join(' ')}`, kind: 'command' });

    // Bounded on purpose: a generated script that prints in a loop for its
    // whole timeout would otherwise buffer hundreds of MB in the main process
    // and then structured-clone all of it across IPC.
    const chunks = [];
    let bytes = 0;
    let truncated = false;
    let settled = false;
    const push = (buf) => {
      const text = buf.toString();
      chunks.push(text);
      bytes += text.length;
      while (bytes > MAX_OUT_BYTES && chunks.length > 1) {
        bytes -= chunks.shift().length;
        truncated = true;
      }
      emit(win, 'tool:output', { project, cmd, text });
      appendRunLog(project, text);
    };
    const collected = () =>
      (truncated ? '[... earlier output trimmed ...]\n' : '') + chunks.join('');

    child.stdout.on('data', push);
    child.stderr.on('data', push);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      treeKill(child); // npm's real work runs in grandchildren; kill() leaves them alive
      resolve({ code: -1, out: collected(), timedOut: true });
    }, timeoutMs);

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // ENOENT here means the toolchain is missing, not that the code is bad.
      if (e && e.code === 'ENOENT') {
        e.message = `${exeName(cmd)} is not installed or not on PATH - install it to run this project (this is not a defect in the generated code)`;
        e.missingBinary = cmd;
      }
      reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out: collected(), timedOut: false });
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
async function startProcessServer(win, project, cmd, args, opts = {}) {
  if (!ALLOWED.has(cmd)) {
    throw new Error(`command not allowed: ${cmd}`);
  }
  const argv = validateArgv(cmd, args);
  stopServer(project);
  const cwd = projectDir(project);
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 120000;
  const dotenv = await projectEnv(project).catch(() => ({}));

  // If the framework's usual port is already taken, hand the child a free one
  // up front: a leaked server from a previous run otherwise turns every
  // subsequent run into an EADDRINUSE the user cannot act on. PORT covers the
  // frameworks that read it; a port we put in the argv ourselves is rewritten
  // in place, because those never look at the environment.
  const argvPort = defaultPortFor(cmd, argv);
  const wanted = Number(opts.port) || argvPort;
  let portHint = null;
  let finalArgv = argv;
  if (wanted && !(await portFree(wanted))) {
    portHint = await findFreePort(wanted + 1);
    if (portHint && argvPort === wanted) {
      finalArgv = argv.map((a) => a.replace(new RegExp(`\\b${wanted}\\b`), String(portHint)));
    }
  }

  return new Promise((resolve, reject) => {
    let child;
    try {
      const spec = spawnSpec(cmd, finalArgv);
      child = spawn(spec.file, spec.args, {
        cwd,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: !IS_WIN, // gives treeKill a process group to signal
        env: {
          ...process.env,
          ...dotenv,
          NO_COLOR: '1',
          FORCE_COLOR: '0',
          BROWSER: 'none',
          ...(portHint ? { PORT: String(portHint) } : {}),
          // Python buffers stdout when it is not a TTY, so a Flask/http.server
          // banner would arrive minutes late - long after we gave up waiting
          // for a URL. Unbuffered output makes the URL appear immediately.
          PYTHONUNBUFFERED: '1',
        },
      });
    } catch (e) {
      return reject(e);
    }

    const entry = {
      child,
      url: null,
      log: [],
      logBytes: 0,
      cmd: `${cmd} ${finalArgv.join(' ')}`,
      port: portHint || wanted || null,
      startedAt: Date.now(),
      project,
    };
    servers.set(project, entry);
    trackChild(child, { project, label: entry.cmd, kind: 'server' });

    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };

    let portClash = null;
    const onData = (buf) => {
      const text = buf.toString();
      entry.log.push(text);
      entry.logBytes += text.length;
      while (entry.logBytes > MAX_OUT_BYTES && entry.log.length > 1) {
        entry.logBytes -= entry.log.shift().length;
      }
      emit(win, 'tool:output', { project, cmd: entry.cmd, text });
      appendRunLog(project, text);
      if (!portClash && PORT_IN_USE_RE.test(text)) {
        portClash = portFromText(text) || entry.port;
      }
      const m = text.match(URL_RE);
      if (m && !entry.url) {
        entry.url = m[0].replace(/0\.0\.0\.0/, 'localhost').replace(/[.,)]+$/, '');
        const found = portFromText(entry.url);
        if (found) entry.port = found;
        // Give the server a breath to finish binding before anyone loads it.
        setTimeout(
          () => finish(resolve, { url: entry.url, pid: child.pid, port: entry.port }),
          1500
        );
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      if (e && e.code === 'ENOENT') {
        e.message = `${exeName(cmd)} is not installed or not on PATH - install it to run this project (this is not a defect in the generated code)`;
        e.missingBinary = cmd;
      }
      finish(reject, e);
    });
    child.on('close', async (code) => {
      if (settled) return;
      if (portClash) {
        const holder = await portHolder(portClash).catch(() => null);
        return finish(
          reject,
          new Error(
            `port ${portClash} is already in use` +
              (holder
                ? ` (held by pid ${holder.pid}${holder.name ? ` - ${holder.name}` : ''})`
                : '') +
              ' - stop that process or let the server pick another port'
          )
        );
      }
      finish(reject, new Error(`dev server exited (${code}) before printing a URL`));
    });

    const timer = setTimeout(() => {
      stopServer(project); // do not leave the URL-less server running forever
      finish(reject, new Error('dev server printed no URL in time'));
    }, timeoutMs);
  });
}

/** The port a given serve command will try first, when we can know it. */
function defaultPortFor(cmd, args) {
  const line = `${cmd} ${args.join(' ')}`;
  const explicit = line.match(/(?:--port[= ]|-p[= ]|:)(\d{2,5})\b/);
  if (explicit) return Number(explicit[1]);
  return null;
}

/** Kill a process and everything it spawned. */
function treeKill(child) {
  if (!child || child.killed) return;
  try {
    if (IS_WIN) {
      // spawn reports launch failure via an 'error' EVENT, not a throw - an
      // unhandled one is an uncaught exception that takes down the main process.
      const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      k.on('error', () => {});
      return;
    }
    // The real server is a grandchild (npm -> next -> node), so killing the
    // wrapper alone left the port bound forever. Children are spawned detached,
    // which makes the pid a process-group id we can signal as a whole.
    try {
      process.kill(-child.pid, 'SIGTERM');
      setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }, 3000).unref?.();
    } catch {
      child.kill('SIGTERM');
    }
  } catch {
    /* already gone */
  }
}

function stopServer(project) {
  const entry = servers.get(project);
  if (!entry) return false;
  treeKill(entry.child);
  servers.delete(project);
  return true;
}

/** Everything currently running, for the UI's running-processes strip. */
function serverList() {
  const out = [];
  for (const [project, e] of servers) {
    out.push({
      project,
      cmd: e.cmd,
      url: e.url,
      port: e.port,
      pid: e.child && e.child.pid ? e.child.pid : null,
      uptimeMs: Date.now() - e.startedAt,
      kind: 'server',
    });
  }
  for (const rec of live) {
    if (rec.kind === 'server') continue; // already listed above, with its URL
    out.push({
      project: rec.project || null,
      cmd: rec.label,
      url: null,
      port: null,
      pid: rec.child && rec.child.pid ? rec.child.pid : null,
      uptimeMs: null,
      kind: rec.kind,
    });
  }
  return out;
}

/** Kill one tracked process by pid, whatever list it is on. */
function stopPid(pid) {
  const target = Number(pid);
  if (!Number.isInteger(target) || target <= 0) throw new Error('invalid pid');
  for (const [project, e] of servers) {
    if (e.child && e.child.pid === target) {
      stopServer(project);
      return true;
    }
  }
  for (const rec of live) {
    if (rec.child && rec.child.pid === target) {
      treeKill(rec.child);
      return true;
    }
  }
  return false; // never signal a pid this app did not spawn
}

function stopAll() {
  for (const project of [...servers.keys()]) stopServer(project);
  // Installs and terminal commands are not in `servers` and used to outlive
  // the app with no way to kill them from the UI.
  for (const rec of [...live]) treeKill(rec.child);
  live.clear();
  // stopAll runs on quit, so anything still sitting in the log batcher has one
  // last chance to reach disk - that tail is usually the failure.
  for (const project of [...logBuffers.keys()]) flushRunLog(project);
}

/* ------------------------------------------------------------------ */
/* Preview                                                             */
/* ------------------------------------------------------------------ */

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

/**
 * Load a URL in an offscreen window and capture it.
 * Saved under workspace/<project>/.preview/ and also placed on the clipboard,
 * which is how the screenshot gets pasted into a chat tab for review.
 */
async function screenshot(project, url, opts = {}) {
  const width = opts.width ?? 1280;
  const height = opts.height ?? 800;
  const loadTimeoutMs = opts.loadTimeoutMs ?? 30000;

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

  // The clipboard is the transport for the screenshot, but it is also the
  // user's clipboard: taking it several times per run and never giving it back
  // silently destroys whatever they had copied.
  const savedImage = clipboard.readImage();
  const savedText = savedImage.isEmpty() ? clipboard.readText() : '';
  let capturedPng = null;

  try {
    // A server that accepts the connection but never finishes the response - a
    // hung SSR render, a redirect loop - parks the entire run here otherwise,
    // because loadURL has no timeout of its own.
    let loadTimer = null;
    await Promise.race([
      win.loadURL(url),
      new Promise((_r, rj) => {
        loadTimer = setTimeout(() => {
          try {
            win.webContents.stop();
          } catch {}
          rj(new Error(`preview did not load in ${Math.round(loadTimeoutMs / 1000)}s: ${url}`));
        }, loadTimeoutMs);
        loadTimer.unref?.();
      }),
    ]).finally(() => clearTimeout(loadTimer));

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
    capturedPng = png;

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
      clipboardRestored: true,
    };
  } finally {
    if (!win.isDestroyed()) win.destroy();
    // Hand the clipboard back once the caller has had time to paste the
    // screenshot into a chat tab - but only if OUR image is still on it. The
    // user may have copied something else in the meantime, and taking that
    // away would be the same bug in the other direction.
    if (capturedPng) {
      const restore = () => {
        try {
          const now = clipboard.readImage();
          if (now.isEmpty() || !now.toPNG().equals(capturedPng)) return;
          if (!savedImage.isEmpty()) clipboard.writeImage(savedImage);
          else if (savedText) clipboard.writeText(savedText);
          else clipboard.clear();
        } catch {
          /* the user's clipboard, not ours to fail a run over */
        }
      };
      const t = setTimeout(restore, opts.clipboardHoldMs ?? 20000);
      t.unref?.();
    }
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
    .filter((l) => /(error|failed|cannot find|module not found|unhandled|EADDRINUSE|✗|×)/i.test(l))
    .map((l) => l.trim())
    .filter(Boolean);
  return [...new Set(hits)].slice(-15).join('\n');
}

/* ------------------------------------------------------------------ */
/* Planning                                                            */
/* ------------------------------------------------------------------ */

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
    'express|fastify|koa|hapi|next|nuxt|vite|http\\.createServer|createServer|listen\\s*\\(|Bun\\.serve',
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

/**
 * Is this executable on PATH?
 *
 * This walks PATH itself rather than spawning `where`/`which`, because the
 * subprocess version reported node as MISSING on a machine that had it: the
 * probe carried a 4s timeout, a cold Windows runner took longer than that to
 * answer, and spawnSync then returned status null. A null status is not a
 * non-zero exit - it is no answer at all - but `status === 0` collapsed the two,
 * and the false negative was memoised for the rest of the session. The app went
 * on to tell the user their Node project could not run.
 *
 * Walking PATH is what where/which do anyway, minus the process, the timeout and
 * that whole failure mode. isFile() matters: a directory called `node` on PATH
 * exists without being runnable, and the executable bit is the POSIX half of the
 * same question.
 */
function onPath(cmd) {
  const exts = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      try {
        if (!fs.statSync(full).isFile()) continue;
        if (!IS_WIN) fs.accessSync(full, fs.constants.X_OK);
        return true;
      } catch {
        /* not here, or not readable - keep looking */
      }
    }
  }
  return false;
}

/** Executable availability, memoised per session. */
const binCache = new Map();
function hasBinary(cmd) {
  if (binCache.has(cmd)) return binCache.get(cmd);
  const ok = onPath(cmd);
  binCache.set(cmd, ok);
  return ok;
}

/**
 * Forget what was probed, so the next question re-reads the machine.
 *
 * A session outlives the user installing a runtime: someone told "python is not
 * installed" installs it and asks again, and a cache that answered once would
 * keep repeating the stale no for as long as the app stays open.
 */
function resetProbeCache() {
  binCache.clear();
  moduleCache.clear();
}

/** First binary in the list that exists on this machine. */
const firstBinary = (...cands) => cands.find((c) => hasBinary(c)) || null;

/** Is this Python module importable? Answers "can we `python -m uvicorn`?". */
const moduleCache = new Map();
function hasPythonModule(bin, mod) {
  const key = `${bin}:${mod}`;
  if (moduleCache.has(key)) return moduleCache.get(key);
  let ok;
  try {
    const probe = require('node:child_process').spawnSync(
      bin,
      [
        '-c',
        `import importlib.util,sys; sys.exit(0 if importlib.util.find_spec(${JSON.stringify(mod)}) else 1)`,
      ],
      { windowsHide: true, timeout: 8000 }
    );
    ok = probe.status === 0;
  } catch {
    ok = false;
  }
  moduleCache.set(key, ok);
  return ok;
}

/**
 * What this machine can actually run, for the first-run panel.
 *
 * A missing toolchain is a fact about the computer, never a defect in the
 * generated code - stating it plainly up front is what stops the auditor
 * inventing a verification the machine cannot perform.
 */
function preflight() {
  const rows = [
    { key: 'node', label: 'Node.js', bins: ['node'] },
    { key: 'npm', label: 'npm', bins: ['npm'] },
    { key: 'pnpm', label: 'pnpm', bins: ['pnpm'] },
    { key: 'yarn', label: 'Yarn', bins: ['yarn'] },
    { key: 'bun', label: 'Bun', bins: ['bun'] },
    { key: 'deno', label: 'Deno', bins: ['deno'] },
    { key: 'python', label: 'Python', bins: ['python', 'python3'] },
    { key: 'pip', label: 'pip', bins: ['pip', 'pip3'] },
    { key: 'go', label: 'Go', bins: ['go'] },
    { key: 'cargo', label: 'Rust (cargo)', bins: ['cargo'] },
    { key: 'dotnet', label: '.NET', bins: ['dotnet'] },
    { key: 'mvn', label: 'Maven', bins: ['mvn'] },
    { key: 'gradle', label: 'Gradle', bins: ['gradle'] },
    { key: 'ruby', label: 'Ruby', bins: ['ruby'] },
    { key: 'php', label: 'PHP', bins: ['php'] },
    { key: 'make', label: 'Make', bins: ['make'] },
  ];
  return rows.map((r) => {
    const found = firstBinary(...r.bins);
    return { key: r.key, label: r.label, found: Boolean(found), bin: found };
  });
}

/**
 * How to install, run and preview each ecosystem.
 *
 * Declarative on purpose: "make it work for everything" is a data problem, and
 * adding a language should mean adding a row here, not another branch in the
 * planner. `detect` runs against the project's file list; `sources` is a sample
 * of its text so the server-vs-script question can be answered by what the code
 * actually does rather than by which language it is written in.
 *
 * `frameworks` rows come first inside a language: Django and a bare script are
 * both Python, but only one of them is started with `manage.py runserver`.
 */
const RUNTIMES = [
  {
    key: 'go',
    label: 'Go',
    bin: () => firstBinary('go'),
    detect: (f) => f.includes('go.mod') || f.some((x) => x.endsWith('.go')),
    entry: (f) => f.find((x) => x === 'main.go') || f.find((x) => x.endsWith('.go')),
    install: (f) =>
      f.includes('go.mod') ? { cmd: 'go', args: ['mod', 'download'], optional: true } : null,
    cmd: (bin, entry, f) => ({
      cmd: bin,
      args: f.includes('go.mod') ? ['run', '.'] : ['run', asEntryArg(entry)],
    }),
    test: (f) =>
      f.some((x) => x.endsWith('_test.go')) ? { cmd: 'go', args: ['test', './...'] } : null,
  },
  {
    key: 'rust',
    label: 'Rust',
    bin: () => firstBinary('cargo'),
    detect: (f) => f.includes('Cargo.toml'),
    entry: () => 'src/main.rs',
    install: () => null, // cargo run fetches and builds in one step
    cmd: (bin) => ({ cmd: bin, args: ['run'] }),
    test: (f) =>
      f.some((x) => x.startsWith('tests/') || x.endsWith('.rs'))
        ? { cmd: 'cargo', args: ['test'] }
        : null,
  },
  {
    key: 'dotnet',
    label: '.NET',
    bin: () => firstBinary('dotnet'),
    detect: (f) => f.some((x) => /\.(csproj|fsproj|sln)$/.test(x)),
    entry: (f) => f.find((x) => /\.(csproj|fsproj)$/.test(x)),
    install: () => ({ cmd: 'dotnet', args: ['restore'], optional: true }),
    build: () => ({ cmd: 'dotnet', args: ['build', '--nologo'], optional: true }),
    cmd: (bin) => ({ cmd: bin, args: ['run'] }),
  },
  {
    key: 'spring-maven',
    label: 'Spring Boot (Maven)',
    bin: () => firstBinary('mvn'),
    detect: (f, ctx) => f.includes('pom.xml') && /spring-boot/i.test(ctx.pomXml || ''),
    entry: () => 'pom.xml',
    install: () => null,
    // spring-boot:run compiles and starts the embedded server in one step.
    cmd: (bin) => ({ cmd: bin, args: ['-q', 'spring-boot:run'], serves: true }),
    test: () => ({ cmd: 'mvn', args: ['-q', 'test'] }),
  },
  {
    key: 'java-maven',
    label: 'Java (Maven)',
    bin: () => firstBinary('mvn'),
    detect: (f) => f.includes('pom.xml'),
    entry: () => 'pom.xml',
    install: () => null,
    cmd: (bin) => ({ cmd: bin, args: ['-q', 'compile', 'exec:java'] }),
    test: () => ({ cmd: 'mvn', args: ['-q', 'test'] }),
  },
  {
    key: 'spring-gradle',
    label: 'Spring Boot (Gradle)',
    bin: () => firstBinary('gradle'),
    detect: (f, ctx) =>
      (f.includes('build.gradle') || f.includes('build.gradle.kts')) &&
      /org\.springframework\.boot/i.test(ctx.buildGradle || ''),
    entry: (f) => (f.includes('build.gradle') ? 'build.gradle' : 'build.gradle.kts'),
    install: () => null,
    cmd: (bin) => ({ cmd: bin, args: ['-q', 'bootRun'], serves: true }),
    test: () => ({ cmd: 'gradle', args: ['-q', 'test'] }),
  },
  {
    key: 'java-gradle',
    label: 'Java (Gradle)',
    bin: () => firstBinary('gradle'),
    detect: (f) => f.includes('build.gradle') || f.includes('build.gradle.kts'),
    entry: (f) => (f.includes('build.gradle') ? 'build.gradle' : 'build.gradle.kts'),
    install: () => null,
    cmd: (bin) => ({ cmd: bin, args: ['-q', 'run'] }),
    test: () => ({ cmd: 'gradle', args: ['-q', 'test'] }),
  },
  {
    key: 'rails',
    label: 'Ruby on Rails',
    bin: () => firstBinary('ruby'),
    detect: (f) => f.includes('config/application.rb') || f.includes('bin/rails'),
    entry: () => 'config/application.rb',
    install: (f) =>
      f.includes('Gemfile') ? { cmd: 'bundle', args: ['install'], optional: true } : null,
    // Through bundler, because a Rails app's gems are almost never global.
    cmd: () => ({
      cmd: hasBinary('bundle') ? 'bundle' : 'ruby',
      args: hasBinary('bundle')
        ? ['exec', 'rails', 'server', '-p', '3000']
        : [asEntryArg('bin/rails'), 'server', '-p', '3000'],
      serves: true,
    }),
    test: (f) =>
      f.some((x) => x.startsWith('spec/')) && hasBinary('bundle')
        ? { cmd: 'bundle', args: ['exec', 'rspec'] }
        : { cmd: 'bundle', args: ['exec', 'rails', 'test'] },
  },
  {
    key: 'ruby',
    label: 'Ruby',
    bin: () => firstBinary('ruby'),
    detect: (f) => f.some((x) => x.endsWith('.rb')),
    entry: (f) =>
      ['main.rb', 'app.rb', 'server.rb'].find((c) => f.includes(c)) ||
      f.find((x) => x.endsWith('.rb')),
    install: (f) =>
      f.includes('Gemfile') ? { cmd: 'bundle', args: ['install'], optional: true } : null,
    cmd: (bin, entry) => ({ cmd: bin, args: [asEntryArg(entry)] }),
  },
  {
    key: 'laravel',
    label: 'Laravel',
    bin: () => firstBinary('php'),
    detect: (f) => f.includes('artisan'),
    entry: () => 'artisan',
    install: () => null, // composer is not on the allow-list; vendor/ ships with the project
    cmd: (bin) => ({
      cmd: bin,
      args: [asEntryArg('artisan'), 'serve', '--port=8000'],
      serves: true,
    }),
    test: () => ({ cmd: 'php', args: [asEntryArg('artisan'), 'test'] }),
  },
  {
    key: 'php',
    label: 'PHP',
    bin: () => firstBinary('php'),
    detect: (f) => f.some((x) => x.endsWith('.php')),
    entry: (f) =>
      ['index.php', 'app.php'].find((c) => f.includes(c)) || f.find((x) => x.endsWith('.php')),
    install: () => null,
    // PHP's built-in server is the sane way to preview a PHP project.
    cmd: (bin, entry) => ({ cmd: bin, args: ['-S', 'localhost:8000'], serves: true, entry }),
  },
  {
    key: 'django',
    label: 'Django',
    bin: () => firstBinary('python', 'python3'),
    detect: (f, ctx) =>
      f.includes('manage.py') && /django/i.test(ctx.pySources || ctx.requirements || ''),
    entry: () => 'manage.py',
    install: (f) => pipStep(f),
    // --noreload: the autoreloader forks a second process that our tree-kill
    // has to chase, and a preview run does not need it.
    cmd: (bin) => ({
      cmd: bin,
      args: [asEntryArg('manage.py'), 'runserver', '8000', '--noreload'],
      serves: true,
    }),
    test: () => ({ cmd: 'python', args: [asEntryArg('manage.py'), 'test'] }),
  },
  {
    key: 'fastapi',
    label: 'FastAPI',
    bin: () => firstBinary('python', 'python3'),
    detect: (_f, ctx) => /FastAPI\s*\(/.test(ctx.pySources || ''),
    entry: (f, ctx) => ctx.fastapiFile || f.find((x) => x.endsWith('.py')),
    install: (f) => pipStep(f),
    cmd: (bin, entry, _f, ctx) => {
      // A file that calls uvicorn.run() already starts itself; anything else
      // needs uvicorn driving it, and `python -m` avoids depending on a
      // uvicorn shim being on PATH.
      if (ctx && /uvicorn\.run\s*\(/.test(ctx.pySources || '')) {
        return { cmd: bin, args: [asEntryArg(entry)], serves: true };
      }
      const mod = pythonModuleName(entry);
      if (mod && hasPythonModule(bin, 'uvicorn')) {
        return { cmd: bin, args: ['-m', 'uvicorn', `${mod}:app`, '--port', '8000'], serves: true };
      }
      return { cmd: bin, args: [asEntryArg(entry)], serves: true };
    },
    test: (f) => pytestStep(f),
  },
  {
    key: 'python',
    label: 'Python',
    bin: () => firstBinary('python', 'python3'),
    detect: (f) => f.some((x) => x.endsWith('.py')),
    entry: (f) =>
      ['main.py', 'app.py', 'server.py', 'run.py', '__main__.py', 'index.py'].find((c) =>
        f.includes(c)
      ) ||
      f.find((x) => x.endsWith('.py') && !x.includes('/')) ||
      f.find((x) => x.endsWith('.py')),
    install: (f) => pipStep(f),
    cmd: (bin, entry) => ({ cmd: bin, args: [asEntryArg(entry)] }),
    test: (f) => pytestStep(f),
  },
  {
    key: 'deno',
    label: 'Deno',
    bin: () => firstBinary('deno'),
    detect: (f) => f.includes('deno.json') || f.includes('deno.jsonc'),
    entry: (f) => ['main.ts', 'mod.ts', 'index.ts'].find((c) => f.includes(c)) || 'main.ts',
    install: () => null,
    cmd: (bin, entry) => ({ cmd: bin, args: ['run', '-A', asEntryArg(entry)] }),
    test: () => ({ cmd: 'deno', args: ['test', '-A'] }),
  },
  // The two rows below only ever run when there is NO package.json - a project
  // with one is planned by the JavaScript branch above. The HTML guard keeps a
  // static page that happens to ship a script.js from being planned as a
  // program: that page is meant to be opened, not executed.
  {
    key: 'bun',
    label: 'Bun',
    bin: () => firstBinary('bun'),
    detect: (f) =>
      !f.some((x) => x.endsWith('.html')) &&
      (f.includes('bunfig.toml') || f.includes('bun.lockb') || f.some((x) => /\.tsx?$/.test(x))),
    entry: (f) =>
      ['index.ts', 'main.ts', 'server.ts', 'app.ts'].find((c) => f.includes(c)) ||
      f.find((x) => /\.tsx?$/.test(x)),
    install: () => null,
    cmd: (bin, entry) => ({ cmd: bin, args: ['run', asEntryArg(entry)] }),
    test: (f) => (f.some((x) => /\.test\.tsx?$/.test(x)) ? { cmd: 'bun', args: ['test'] } : null),
  },
  {
    key: 'node',
    label: 'Node.js',
    bin: () => firstBinary('node'),
    detect: (f) => !f.some((x) => x.endsWith('.html')) && f.some((x) => /\.(mjs|cjs|js)$/.test(x)),
    entry: (f) =>
      ['index.js', 'main.js', 'server.js', 'app.js', 'index.mjs'].find((c) => f.includes(c)) ||
      f.find((x) => /\.(mjs|cjs|js)$/.test(x)),
    install: () => null,
    cmd: (bin, entry) => ({ cmd: bin, args: ['--', asEntryArg(entry)] }),
  },
  {
    key: 'shell',
    label: 'Shell',
    bin: () => firstBinary('bash', 'sh'),
    detect: (f) => f.some((x) => x.endsWith('.sh')),
    entry: (f) =>
      ['main.sh', 'run.sh', 'start.sh'].find((c) => f.includes(c)) ||
      f.find((x) => x.endsWith('.sh')),
    install: () => null,
    cmd: (bin, entry) => ({ cmd: bin, args: [asEntryArg(entry)] }),
  },
  {
    key: 'make',
    label: 'Make',
    bin: () => firstBinary('make'),
    detect: (f) => f.includes('Makefile') || f.includes('makefile'),
    entry: () => 'Makefile',
    install: () => null,
    cmd: (bin) => ({ cmd: bin, args: ['run'] }),
    test: () => ({ cmd: 'make', args: ['test'] }),
  },
];

function pipStep(files) {
  if (!files.includes('requirements.txt')) return null;
  const pip = firstBinary('pip', 'pip3');
  if (!pip) return null; // no pip: say nothing rather than fail a step that cannot run
  // --no-cache-dir keeps a model-authored requirements file from filling the
  // user's pip cache with packages they never asked for.
  return {
    cmd: pip,
    args: ['install', '--no-cache-dir', '-r', 'requirements.txt'],
    optional: true,
  };
}

function pytestStep(files) {
  const bin = firstBinary('python', 'python3');
  if (!bin) return null;
  const hasTests =
    files.some((f) => /(^|\/)(test_[^/]+\.py|[^/]+_test\.py)$/.test(f)) ||
    files.includes('pytest.ini') ||
    files.includes('conftest.py');
  if (!hasTests || !hasPythonModule(bin, 'pytest')) return null;
  return { cmd: bin, args: ['-m', 'pytest', '-q'] };
}

/** `app/main.py` -> `app.main`, and null when it is not a legal module path. */
function pythonModuleName(entry) {
  if (!entry || !entry.endsWith('.py')) return null;
  const parts = entry.slice(0, -3).split('/');
  if (!parts.every((p) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(p))) return null;
  return parts.join('.');
}

/* ---- JavaScript: package manager, monorepo, framework ---- */

/**
 * Which package manager this project is asking for.
 *
 * The lockfile is the strongest signal - running `npm install` over a
 * pnpm-lock.yaml resolves a different dependency tree than the one the project
 * was written against - but a lockfile for a manager that is not installed is
 * worse than useless, so availability decides the tie.
 */
function detectPackageManager(files, pkg) {
  const declared = pkg && typeof pkg.packageManager === 'string' ? pkg.packageManager : '';
  const byField = /^(pnpm|yarn|bun|npm)@/.exec(declared);
  const candidates = [];
  if (byField) candidates.push(byField[1]);
  if (files.includes('pnpm-lock.yaml')) candidates.push('pnpm');
  if (files.includes('yarn.lock')) candidates.push('yarn');
  if (files.includes('bun.lockb') || files.includes('bun.lock') || files.includes('bunfig.toml')) {
    candidates.push('bun');
  }
  if (files.includes('package-lock.json')) candidates.push('npm');

  for (const c of candidates) {
    if (hasBinary(c)) return { pm: c, why: `lockfile/packageManager says ${c}` };
  }
  // The lockfile asked for something this machine does not have. Any package
  // manager beats refusing to run the project at all.
  const available = firstBinary('npm', 'pnpm', 'yarn', 'bun');
  if (candidates.length && available) {
    return {
      pm: available,
      why: `${candidates[0]} is not installed - falling back to ${available}`,
      fallbackFrom: candidates[0],
    };
  }
  return { pm: available, why: `no lockfile; using ${available || 'no package manager'}` };
}

/** Run a package-manager subcommand against a subdirectory of the project. */
function pmInDir(pm, dir, rest) {
  if (!dir || dir === '.') return rest;
  if (pm === 'npm') return ['--prefix', dir, ...rest];
  if (pm === 'pnpm') return ['-C', dir, ...rest];
  return ['--cwd', dir, ...rest]; // yarn and bun both spell it this way
}

/**
 * A monorepo's runnable app is not at its root.
 *
 * `npm install` belongs at the root (that is where the workspace graph is) but
 * `run dev` belongs in the package that has a dev script, and pointing the
 * preview at the root just starts nothing.
 */
function detectWorkspace(files, pkg, pkgByDir) {
  const isMono =
    (pkg && Array.isArray(pkg.workspaces)) ||
    (pkg && pkg.workspaces && Array.isArray(pkg.workspaces.packages)) ||
    files.includes('pnpm-workspace.yaml') ||
    files.includes('turbo.json') ||
    files.includes('lerna.json') ||
    files.includes('nx.json');
  if (!isMono) return null;

  // Prefer a conventional app folder, then anything with a dev/start script.
  const ranked = [...pkgByDir.entries()]
    .filter(([dir]) => dir && dir !== '.')
    .sort(([a], [b]) => {
      const score = (d) => (/^apps?\//.test(d) ? 0 : /^(packages|services)\//.test(d) ? 1 : 2);
      return score(a) - score(b) || a.localeCompare(b);
    });
  for (const [dir, sub] of ranked) {
    const scripts = Object.keys((sub && sub.scripts) || {});
    if (scripts.some((s) => ['dev', 'start', 'serve'].includes(s))) {
      return { dir, scripts, name: sub.name || dir };
    }
  }
  return { dir: null, scripts: [], name: null };
}

/** Framework identity, default port and the word a human would use for it. */
const JS_FRAMEWORKS = [
  { dep: 'next', label: 'Next.js', port: 3000 },
  { dep: 'nuxt', label: 'Nuxt', port: 3000 },
  { dep: '@sveltejs/kit', label: 'SvelteKit', port: 5173 },
  { dep: 'astro', label: 'Astro', port: 4321 },
  { dep: '@remix-run/dev', label: 'Remix', port: 3000 },
  { dep: 'react-router', label: 'React Router (framework mode)', port: 5173 },
  { dep: '@nestjs/core', label: 'NestJS', port: 3000 },
  { dep: 'svelte', label: 'Svelte', port: 5173 },
  { dep: 'vite', label: 'Vite', port: 5173 },
  { dep: 'express', label: 'Express', port: 3000 },
  { dep: 'fastify', label: 'Fastify', port: 3000 },
  { dep: 'koa', label: 'Koa', port: 3000 },
  { dep: 'hono', label: 'Hono', port: 3000 },
];

function detectJsFramework(pkg) {
  const deps = { ...(pkg && pkg.dependencies), ...(pkg && pkg.devDependencies) };
  for (const f of JS_FRAMEWORKS) {
    if (deps[f.dep]) return f;
  }
  return null;
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readIfPresent(p) {
  try {
    return await fsp.readFile(p, 'utf8');
  } catch {
    return '';
  }
}

async function readJsonIfPresent(p) {
  try {
    return JSON.parse(await fsp.readFile(p, 'utf8'));
  } catch {
    return null;
  }
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
  const all = await list(project);
  // A basename beginning with '-' is not a filename to a command line, it is a
  // flag: `python -c...py` executes the name. Such a file is never an entry.
  const files = all.filter((f) => !path.basename(f).startsWith('-'));

  const pkg = await readJsonIfPresent(path.join(dir, 'package.json'));

  const htmlEntry =
    ['index.html', 'public/index.html', 'src/index.html', 'templates/index.html'].find((c) =>
      files.includes(c)
    ) ||
    files.find((f) => f.endsWith('.html')) ||
    null;

  const steps = [];

  // 1. A declared dev/start script is the strongest signal there is - the
  //    project itself is telling us how it wants to be run.
  //    Nested package.json files are read too, because in a monorepo the root
  //    has the workspace graph and a child has the app.
  const pkgByDir = new Map();
  if (pkg) pkgByDir.set('.', pkg);
  for (const f of files) {
    if (!f.endsWith('package.json') || f === 'package.json') continue;
    const sub = await readJsonIfPresent(path.join(dir, f));
    if (sub) pkgByDir.set(path.posix.dirname(f), sub);
  }

  if (pkg) {
    const { pm, why: pmWhy, fallbackFrom } = detectPackageManager(files, pkg);
    if (!pm) {
      // Node itself is missing. That is a fact about this machine, not a bug
      // in the code, and saying so is what stops the auditor rejecting a
      // perfectly good project as impossible.
      return {
        kind: 'node-unavailable',
        language: 'JavaScript/TypeScript',
        steps: [],
        preview: htmlEntry ? 'browser' : 'none',
        htmlEntry,
        unavailable: 'Node.js/npm',
        doneMeans:
          'the JavaScript sources are complete and correct' +
          (htmlEntry ? `, and ${htmlEntry} opens and shows the result` : '') +
          ' (Node.js is not installed on this machine, so it cannot be executed here - do not treat that as a defect in the code)',
        why: 'package.json found but no Node package manager installed',
      };
    }

    const mono = detectWorkspace(files, pkg, pkgByDir);
    const appDir = mono && mono.dir ? mono.dir : null;
    const appPkg = appDir ? pkgByDir.get(appDir) : pkg;
    const appScripts = Object.keys((appPkg && appPkg.scripts) || {});
    const framework = detectJsFramework(appPkg) || detectJsFramework(pkg);

    const hasDeps =
      Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0 ||
      (appPkg !== pkg &&
        Object.keys({ ...appPkg.dependencies, ...appPkg.devDependencies }).length > 0);
    if (hasDeps) {
      steps.push({
        kind: 'install',
        cmd: pm,
        args: ['install'], // at the ROOT: that is where a workspace graph lives
        timeoutMs: 420000,
        label: `${pm} install`,
      });
    }

    const webScript = ['dev', 'start', 'serve', 'preview'].find((s) => appScripts.includes(s));
    // A project with `build` + `preview`/`start` but no `dev` is a real shape
    // (Astro, Vite, SvelteKit static, Next export). It must be built before it
    // can be served, and skipping that step made the preview a 404.
    const needsBuild =
      appScripts.includes('build') &&
      (!webScript || webScript === 'start' || webScript === 'preview');
    if (needsBuild) {
      steps.push({
        kind: 'build',
        cmd: pm,
        args: pmInDir(pm, appDir, ['run', 'build']),
        timeoutMs: 420000,
        label: `${pm} run build`,
      });
    }

    const testScript = appScripts.includes('test') && !isStubTestScript(appPkg) ? 'test' : null;
    const testStep = testScript
      ? { cmd: pm, args: pmInDir(pm, appDir, ['run', 'test']), label: `${pm} run test` }
      : null;

    if (webScript) {
      const serveArgs = pmInDir(pm, appDir, ['run', webScript]);
      return {
        kind: 'node-web',
        language: 'JavaScript/TypeScript',
        framework: framework ? framework.label : null,
        packageManager: pm,
        workspaceDir: appDir,
        steps,
        test: testStep,
        serve: {
          cmd: pm,
          args: serveArgs,
          label: `${pm} ${serveArgs.join(' ')}`,
          port: framework ? framework.port : null,
        },
        preview: 'browser',
        htmlEntry,
        doneMeans: `\`${pm} run ${webScript}\` serves the app and the page renders correctly`,
        why:
          `package.json defines a "${webScript}" script` +
          (framework ? ` (${framework.label})` : '') +
          (appDir ? `, in the ${appDir} workspace package` : '') +
          (fallbackFrom ? `; ${pmWhy}` : ''),
      };
    }

    // 2b. Node project with no dev script at all.
    const entryCandidates = [
      'index.js',
      'index.mjs',
      'main.js',
      'server.js',
      'app.js',
      'src/index.js',
    ];
    const entry =
      (pkg.main && files.includes(pkg.main) ? pkg.main : null) ||
      entryCandidates.find((c) => files.includes(c)) ||
      files.find((f) => /\.(mjs|cjs|js)$/.test(f)) ||
      'index.js';
    const jsSources = await sampleSources(dir, files);
    const serves = SERVER_RE.test(jsSources);
    const runner = pm === 'bun' && hasBinary('bun') ? 'bun' : 'node';
    const runArgs = runner === 'node' ? ['--', asEntryArg(entry)] : [asEntryArg(entry)];
    const label = `${runner} ${asEntryArg(entry)}`;

    if (serves) {
      return {
        kind: 'node-server',
        language: 'JavaScript/TypeScript',
        framework: framework ? framework.label : null,
        packageManager: pm,
        steps,
        test: testStep,
        serve: { cmd: runner, args: runArgs, label, port: framework ? framework.port : null },
        preview: 'browser',
        entry,
        htmlEntry,
        doneMeans: `\`${label}\` starts the server and the page it serves renders correctly`,
        why: `${framework ? framework.label : 'Node'} sources open a network listener`,
      };
    }

    return {
      kind: 'node-script',
      language: 'JavaScript/TypeScript',
      packageManager: pm,
      steps,
      test: testStep,
      run: { cmd: runner, args: runArgs, label, timeoutMs: 120000 },
      preview: htmlEntry ? 'output+browser' : 'output',
      entry,
      htmlEntry,
      doneMeans: `\`${label}\` runs cleanly and does what was asked`,
      why: 'package.json with no dev/start script',
    };
  }

  // 3. Every other ecosystem, by what is actually on disk.
  const ctx = await runtimeContext(dir, files);
  for (const rt of RUNTIMES) {
    if (!rt.detect(files, ctx)) continue;

    const bin = rt.bin();
    const entry = rt.entry(files, ctx) || null;

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
    if (inst)
      steps.push({
        kind: 'install',
        timeoutMs: 300000,
        label: `${inst.cmd} ${inst.args.join(' ')}`,
        ...inst,
      });
    const build = rt.build ? rt.build(files) : null;
    if (build)
      steps.push({
        kind: 'build',
        timeoutMs: 300000,
        label: `${build.cmd} ${build.args.join(' ')}`,
        ...build,
      });

    const spec = rt.cmd(bin, entry, files, ctx);
    const serves = spec.serves || SERVER_RE.test(ctx.sources);
    const testSpec = rt.test ? rt.test(files, ctx) : null;
    const test =
      testSpec && hasBinary(testSpec.cmd)
        ? { ...testSpec, label: `${testSpec.cmd} ${testSpec.args.join(' ')}` }
        : null;

    if (serves) {
      return {
        kind: `${rt.key}-web`,
        language: rt.label,
        framework: rt.label,
        steps,
        test,
        serve: {
          cmd: spec.cmd,
          args: spec.args,
          label: `${spec.cmd} ${spec.args.join(' ')}`,
          port: defaultPortFor(spec.cmd, spec.args),
        },
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
      test,
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
      why: htmlEntry
        ? `${rt.label} entry plus an HTML artefact`
        : `${rt.label} entry, no listener opened`,
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

/** `npm init` writes a test script that only fails; it is not a test suite. */
function isStubTestScript(pkg) {
  const t = pkg && pkg.scripts && pkg.scripts.test;
  return !t || /no test specified/i.test(t);
}

async function sampleSources(dir, files) {
  const picked = files
    .filter((f) => /\.(py|js|mjs|cjs|ts|tsx|go|rs|rb|php|java|cs|ex)$/.test(f))
    .slice(0, 12);
  const bodies = await Promise.all(picked.map((f) => readIfPresent(path.join(dir, f))));
  return bodies.join('\n');
}

/**
 * The few file bodies the RUNTIMES rows need to tell frameworks apart.
 * Read once per plan rather than once per row - `detect` runs for every row.
 */
async function runtimeContext(dir, files) {
  const sources = await sampleSources(dir, files);
  const pyFiles = files.filter((f) => f.endsWith('.py')).slice(0, 12);
  const pyBodies = await Promise.all(pyFiles.map((f) => readIfPresent(path.join(dir, f))));
  const fastapiIdx = pyBodies.findIndex((b) => /FastAPI\s*\(/.test(b));
  return {
    sources,
    pySources: pyBodies.join('\n'),
    fastapiFile: fastapiIdx >= 0 ? pyFiles[fastapiIdx] : null,
    requirements: await readIfPresent(path.join(dir, 'requirements.txt')),
    pomXml: files.includes('pom.xml') ? await readIfPresent(path.join(dir, 'pom.xml')) : '',
    buildGradle: await readIfPresent(
      path.join(dir, files.includes('build.gradle') ? 'build.gradle' : 'build.gradle.kts')
    ),
  };
}

/** Project-relative files, install/build noise excluded. */
async function list(project) {
  const dir = projectDir(project);
  const out = [];
  async function walk(d, rel) {
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue; // a link can point out of the workspace, or at itself
      if (e.isDirectory()) {
        if (workspace.SKIP_DIRS.has(e.name)) continue;
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
    if (await exists(path.join(projectDir(project), candidate))) return candidate;
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
  description: "Generated by BrowserSmith",
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
  if (line.length > 8192) return Promise.reject(new Error('command line is too long'));
  // Node throws ERR_INVALID_ARG_VALUE on a NUL before the OS ever sees it, and
  // its message names 'args[1]' - an index into the powershell invocation this
  // function builds, which the user never typed and cannot act on. Rejecting it
  // here blames the command line by name. NUL only: a multi-line command pasted
  // into the terminal panel is legitimate, and an ESC reaches the shell anyway.
  // eslint-disable-next-line no-control-regex
  if (/\u0000/.test(line)) return Promise.reject(new Error('command line contains a NUL byte'));

  const TIMEOUT_MS = 600000; // 10 minutes

  return new Promise((resolve, reject) => {
    fsp.mkdir(cwd, { recursive: true }).then(() => {
      let child;
      try {
        child = spawn(
          IS_WIN ? 'powershell.exe' : '/bin/sh',
          IS_WIN ? ['-NoProfile', '-NonInteractive', '-Command', line] : ['-lc', line],
          {
            cwd,
            shell: false,
            windowsHide: true,
            detached: !IS_WIN, // a process group, so a stray server is killable
            env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
          }
        );
      } catch (e) {
        return reject(e);
      }
      // Tracked like everything else: a `npm run dev` typed in here used to be
      // reachable by nothing - not Stop, not stopAll, not quit.
      trackChild(child, { project: proj, label: line.slice(0, 120), kind: 'terminal' });

      let settled = false;
      const push = (buf) => {
        const text = buf.toString();
        emit(win, 'term:output', { project: proj, text });
        if (proj) appendRunLog(proj, text);
      };
      child.stdout.on('data', push);
      child.stderr.on('data', push);

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        treeKill(child);
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
  stopPid,
  stopAll,
  serverList,
  screenshot,
  inspect,
  findStaticEntry,
  projectDir,
  scaffold,
  runShell,
  plan,
  preflight,
  startProcessServer,
  serverLog,
  serverErrors,
  portFree,
  findFreePort,
  portHolder,
  freePort,
  validateArgv,
  parseDotEnv,
  hasBinary,
  resetProbeCache,
  ALLOWED,
};

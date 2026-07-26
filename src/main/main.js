'use strict';
const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  nativeImage,
  shell,
  webContents,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const workspace = require('./workspace');
const { SITE, PRODUCT } = require('../shared/site');
const sessionStore = require('./session-store');
const toolchain = require('./toolchain');

/**
 * The app icon, as a path (for BrowserWindow) and as an image (for dialogs).
 * .ico carries every size Windows asks for; everywhere else wants the PNG.
 */
const ICON_PATH = (() => {
  const dir = path.join(__dirname, '..', '..', 'assets');
  const file = path.join(dir, process.platform === 'win32' ? 'logo.ico' : 'logo-512.png');
  return fs.existsSync(file) ? file : null;
})();
const ICON_PNG = (() => {
  const file = path.join(__dirname, '..', '..', 'assets', 'logo-512.png');
  return fs.existsSync(file) ? file : null;
})();

// Before ready: the name is what the OS shows in the task manager, the menu bar
// and notifications, and setting it later leaves "Electron" behind in some of
// them. The AppUserModelID is what pins the taskbar icon to this app on
// Windows instead of to the generic Electron shell.
app.setName(PRODUCT.product);
if (process.platform === 'win32') app.setAppUserModelId(`com.${PRODUCT.brand}.app`);

/** How much text one insertText call may carry, and the gap between calls. */
// Chunking exists for the ~50KB paste that wedges a composer, not for ordinary
// prompts. A 12KB review prompt used to be split into four pieces for no gain
// and every extra seam is a chance to land text out of order, so only genuinely
// huge bodies are split at all.
const TYPE_CHUNK = 24000;
const TYPE_YIELD_MS = 16; // ~one frame: long enough for the editor to paint

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Split a prompt for chunked insertion. Concatenating the pieces reproduces the
 * input byte for byte.
 *
 * Boundaries are pulled back to the end of a line whenever one is in reach: the
 * composer runs markdown input rules on what it receives, and cutting through
 * the middle of a fence or a list marker gives it something different to look
 * at than the whole prompt would.
 */
function typeChunks(text) {
  const out = [];
  for (let i = 0; i < text.length; ) {
    let end = Math.min(i + TYPE_CHUNK, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end - 1);
      if (nl > i) end = nl + 1;
    }
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Renderer input validation                                           */
/* ------------------------------------------------------------------ */

/**
 * Everything crossing an ipcMain.handle boundary is renderer input, and the
 * renderer runs model-derived strings. Validate here, once, so no handler has
 * to remember to - and so a compromised renderer buys nothing a normal run
 * could not already do.
 */
function asProject(value) {
  return workspace.assertProjectName(value); // throws with the bad name quoted
}

function asRelPath(value) {
  const rel = String(value ?? '');
  if (!rel.trim()) throw new Error('path is required');
  if (rel.length > 1024) throw new Error('path is too long');
  workspace.resolveSafe(rel); // throws if it escapes the workspace
  return rel;
}

const MAX_FILE_BYTES = 8 * 1024 * 1024;
function asFileContent(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
    throw new Error('file is too large to write (8MB limit)');
  }
  return text;
}

function asWebContentsId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error('invalid tab id');
  const wc = webContents.fromId(id);
  if (!wc || wc.isDestroyed()) throw new Error('no such webContents ' + id);
  return wc;
}

function asCommand(value) {
  const cmd = String(value ?? '');
  if (!toolchain.ALLOWED.has(cmd)) throw new Error(`command not allowed: ${cmd}`);
  return cmd;
}

function asArgs(cmd, value) {
  return toolchain.validateArgv(cmd, value === undefined ? [] : value);
}

function asTimeout(value, fallback) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return fallback;
  return Math.min(ms, 30 * 60 * 1000);
}

/** Loopback in every spelling a dev server might print, IPv6 included. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1', '[::]']);

function asLocalHttpUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new Error('not a valid URL: ' + value);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('only http(s) URLs are permitted');
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error('only localhost / 127.0.0.1 / [::1] is permitted');
  }
  return parsed.toString();
}

/**
 * A preview URL: a local dev server, or a file inside the workspace.
 * A file: URL pointing anywhere else would let the preview window read the
 * user's disk on behalf of whatever the model wrote.
 */
function asPreviewUrl(value) {
  const raw = String(value ?? '');
  if (/^file:/i.test(raw)) {
    let full;
    try {
      // The workspace path can contain spaces, so the URL is percent-encoded;
      // a malformed escape throws here rather than sneaking past the check.
      const parsed = new URL(raw);
      full = path.normalize(decodeURIComponent(parsed.pathname).replace(/^\/([A-Za-z]:)/, '$1'));
    } catch {
      throw new Error('not a valid file URL: ' + raw);
    }
    const root = path.normalize(workspace.ROOT);
    if (full !== root && !full.startsWith(root + path.sep)) {
      throw new Error('preview file must live inside the workspace');
    }
    return raw;
  }
  return asLocalHttpUrl(raw);
}

/* ------------------------------------------------------------------ */
/* Window + menu                                                       */
/* ------------------------------------------------------------------ */

const mainWin = () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) || null;

// The control window's webContents id. The navigation guard treats it
// differently from every other window, and identity is the only reliable test:
// the offscreen screenshot window is the same `type` and must not be pinned.
let controlWebContentsId = -1;

function createWindow() {
  const win = new BrowserWindow({
    width: 1680,
    height: 1000,
    backgroundColor: '#111113',
    title: PRODUCT.product,
    ...(ICON_PATH ? { icon: ICON_PATH } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload-control.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // A sandboxed preload may only require 'electron' and a few builtins, so
      // it cannot load ../shared/protocol. The control window loads no remote
      // content - only our own index.html - so unsandboxing it is contained.
      // The chat webviews stay sandboxed; their preload requires nothing.
      sandbox: false,
      webviewTag: true, // the four chat tabs
    },
  });
  controlWebContentsId = win.webContents.id;
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // The window is the product, not the document: without this the <title> in
  // index.html wins and the taskbar entry says whatever that file happens to
  // contain.
  win.on('page-title-updated', (e) => {
    e.preventDefault();
    win.setTitle(PRODUCT.product);
  });

  // The site's OAuth / "open in app" popups must stay inside our session, not
  // bounce to the system browser where the login would not be captured.
  win.webContents.on('will-attach-webview', (_e, prefs) => {
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
  });
  return win;
}

/** Tell the renderer a menu item was chosen. It is free to ignore any of them. */
function toRenderer(command) {
  const win = mainWin();
  if (win) win.webContents.send('app:menu', command);
}

function showAbout() {
  const win = mainWin();
  const detail = [
    PRODUCT.tagline + '.',
    '',
    `Version      ${app.getVersion()}`,
    `License      ${PRODUCT.license}`,
    `Repository   ${PRODUCT.repo}`,
    '',
    `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
    `Workspace    ${workspace.ROOT}`,
  ].join('\n');

  const opts = {
    type: 'info',
    title: `About ${PRODUCT.product}`,
    message: PRODUCT.product,
    detail,
    buttons: ['Close', 'Open repository', 'Report an issue'],
    defaultId: 0,
    cancelId: 0,
    ...(ICON_PNG ? { icon: nativeImage.createFromPath(ICON_PNG) } : {}),
  };
  const done = (r) => {
    if (r.response === 1) shell.openExternal(PRODUCT.repo);
    if (r.response === 2) shell.openExternal(PRODUCT.issues);
  };
  (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)).then(done).catch(() => {});
}

/**
 * A real application menu.
 *
 * Electron's stock menu ships a Help item that opens electronjs.org, which is
 * in every screenshot anyone takes of this app. Every item below does something
 * this app actually offers, with the accelerators each platform expects.
 */
function buildMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac
      ? [{
          label: PRODUCT.product,
          submenu: [
            { label: `About ${PRODUCT.product}`, click: showAbout },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }]
      : []),
    {
      label: '&File',
      submenu: [
        {
          label: 'New Run',
          accelerator: 'CmdOrCtrl+N',
          click: () => toRenderer('new-run'),
        },
        {
          label: 'Stop Run',
          accelerator: 'CmdOrCtrl+.',
          click: () => toRenderer('stop-run'),
        },
        { type: 'separator' },
        {
          label: 'Open Workspace Folder',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => shell.openPath(workspace.ROOT),
        },
        {
          label: 'Open Profile Folder',
          click: () => shell.openPath(app.getPath('userData')),
        },
        { type: 'separator' },
        {
          label: 'Stop All Servers',
          click: () => {
            toolchain.stopAll();
            toRenderer('servers-stopped');
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', accelerator: 'CmdOrCtrl+Q' },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac
          ? [{ role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' }]
          : [{ role: 'delete' }, { type: 'separator' }, { role: 'selectAll' }]),
      ],
    },
    {
      label: '&View',
      submenu: [
        { role: 'reload', accelerator: 'CmdOrCtrl+R' },
        { role: 'forceReload' },
        { role: 'toggleDevTools', accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I' },
        { type: 'separator' },
        { role: 'resetZoom', accelerator: 'CmdOrCtrl+0' },
        { role: 'zoomIn', accelerator: 'CmdOrCtrl+Plus' },
        { role: 'zoomOut', accelerator: 'CmdOrCtrl+-' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '&Window',
      submenu: isMac
        ? [
            { role: 'minimize' },
            { role: 'zoom' }, // macOS only - on Windows/Linux the role does not exist
            { type: 'separator' },
            { role: 'front' },
          ]
        : [{ role: 'minimize' }, { type: 'separator' }, { role: 'close' }],
    },
    {
      label: '&Help',
      role: 'help',
      submenu: [
        {
          label: `${PRODUCT.product} on GitHub`,
          click: () => shell.openExternal(PRODUCT.repo),
        },
        {
          label: 'Report an Issue',
          click: () => shell.openExternal(PRODUCT.issues),
        },
        { type: 'separator' },
        {
          label: 'Check Toolchain',
          click: () => toRenderer('preflight'),
        },
        ...(isMac ? [] : [{ type: 'separator' }, { label: `About ${PRODUCT.product}`, click: showAbout }]),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** A file:// URL that points at something inside workspace/. */
function isWorkspaceFileUrl(url) {
  try {
    asPreviewUrl(url);
    return /^file:/i.test(url);
  } catch {
    return false;
  }
}

/**
 * Nothing this app opens may navigate off the origins it knows about.
 *
 * The chat webviews carry `allowpopups`, and the preview loads model-authored
 * pages: without this, one `window.open('file:///...')` is an unconstrained
 * BrowserWindow pointed at the user's disk. Static previews are the one
 * file:// case that is legitimate, and only inside the workspace.
 */
function allowedTarget(url, { allowWorkspaceFile = false } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === 'file:') return allowWorkspaceFile && isWorkspaceFileUrl(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (LOOPBACK_HOSTS.has(u.hostname)) return true;
  const host = u.hostname.toLowerCase();
  return SITE.cookieDomains.some((d) => host === d || host.endsWith('.' + d));
}

function guardWebContents() {
  app.on('web-contents-created', (_e, wc) => {
    wc.setWindowOpenHandler(({ url }) => {
      // A popup never gets file://, whatever it claims to point at.
      if (allowedTarget(url)) return { action: 'allow' };
      // A link the USER clicked - in our own UI or in a chat tab - is still a
      // link they may want, so it opens in their browser. A pop-up from the
      // preview is model-authored code and gets nothing: it must not be able
      // to open browser tabs on the user's machine.
      const userDriven = wc.id === controlWebContentsId || wc.getType() === 'webview';
      if (userDriven && /^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e, url) => {
      // The control window navigating away would unload the whole UI. Only
      // that one window is pinned to file:// - the offscreen preview window is
      // also type 'window' and must be free to follow a dev server's redirect.
      if (wc.id === controlWebContentsId) {
        if (!url.startsWith('file://')) e.preventDefault();
        return;
      }
      // Everything else: the chat product, a local dev server, or a workspace
      // file. Never an arbitrary origin.
      if (!allowedTarget(url, { allowWorkspaceFile: true })) e.preventDefault();
    });
    wc.on('will-attach-webview', (_ev, prefs) => {
      prefs.nodeIntegration = false;
      prefs.contextIsolation = true;
      // The preload is deliberately NOT stripped here. Every <webview> in this
      // app comes from our own index.html and points at preload-chatgpt.js;
      // deleting it on a path-comparison mismatch (a percent-encoded space in
      // the profile path is enough) would boot the chat tabs with no DOM
      // knowledge at all, which surfaces minutes later as unexplained timeouts.
    });
  });
}

/* ------------------------------------------------------------------ */
/* Startup                                                             */
/* ------------------------------------------------------------------ */

// One instance only - two Electron processes sharing a cookie store is how
// logins get clobbered. Everything below the lock (pinning the profile
// directory, probing it for writability, opening a window) must not run in the
// second process, or it writes into the profile the first one is using.
let PROFILE_DIR = null;

if (!app.requestSingleInstanceLock()) {
  app.exit(0); // exit, not quit: quit runs before-quit handlers and can be cancelled
} else {
  app.on('second-instance', () => {
    const win = mainWin();
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  // Must happen before app is ready and before any session is touched.
  PROFILE_DIR = sessionStore.pinProfileDir();

  app.whenReady().then(async () => {
    await sessionStore.assertWritable();
    sessionStore.watch();
    guardWebContents();
    buildMenu();
    if (process.platform === 'darwin' && app.dock && ICON_PNG) {
      app.dock.setIcon(nativeImage.createFromPath(ICON_PNG));
    }

    registerIpc();

    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch((err) => {
    // Installed under Program Files, a read-only folder or a locked OneDrive
    // path, assertWritable rejects and createWindow is never reached: the user
    // gets a running process and no window, with nothing explaining why.
    dialog.showErrorBox(
      `${PRODUCT.product} cannot start`,
      `The profile folder is not writable:
${PROFILE_DIR}

${err && err.message ? err.message : err}`
    );
    app.exit(1);
  });
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

/** The last plan computed per project, so a step can be run by index. */
const lastPlan = new Map();

function registerIpc() {
  ipcMain.handle('fs:write', (_e, { path: rel, content }) =>
    workspace.writeFile(asRelPath(rel), asFileContent(content))
  );
  ipcMain.handle('fs:read', (_e, { path: rel }) => workspace.readFile(asRelPath(rel)));
  ipcMain.handle('fs:list', () => workspace.list());
  ipcMain.handle('fs:root', () => workspace.ROOT);

  // Typing and Enter go through webContents, not synthetic DOM events: those
  // are untrusted and a rich-text editor ignores them when the window is not
  // OS-focused. This path works with the window in the background.
  //
  // The text arrives in pieces because one insertText of a whole 50KB prompt
  // blocks the target tab's renderer for seconds: ProseMirror re-parses and
  // re-lays-out the entire document in a single task, and every composer read
  // that follows times out - which is how a review round silently turned into
  // "reviewer unavailable, accepting the file". Chunking hands the editor work
  // it can finish between frames. The handler stays awaitable, so the renderer
  // still learns exactly when the last piece has landed.
  ipcMain.handle('tab:type', async (_e, { id, text }) => {
    const wc = asWebContentsId(id);
    const body = String(text ?? '');
    wc.focus();
    if (body.length <= TYPE_CHUNK) {
      await wc.insertText(body);
      return true;
    }
    // Focus ONCE, before the first piece, and never again inside the loop.
    // Focusing a contenteditable restores its saved selection, so re-focusing
    // between pieces put the caret back where it had been and the next chunk
    // landed there instead of after the previous one. The prompt arrived
    // scrambled - the trailing "Reply with exactly one word" instruction ended
    // up buried mid-file - and the reviewer, reading a jumbled document, quite
    // reasonably answered RETRY to every complete file we sent it.
    for (const piece of typeChunks(body)) {
      if (wc.isDestroyed()) throw new Error('tab closed while typing');
      await wc.insertText(piece);
      await delay(TYPE_YIELD_MS);
    }
    return true;
  });

  // Renderer-side webview.focus() only takes effect when the OS window itself
  // is focused. webContents.focus() does not care, so popup menus open even
  // with the app in the background.
  ipcMain.handle('tab:focus', (_e, { id }) => {
    asWebContentsId(id).focus();
    return true;
  });

  ipcMain.handle('tab:enter', (_e, { id }) => {
    const wc = asWebContentsId(id);
    wc.focus();
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    wc.sendInputEvent({ type: 'char', keyCode: '\r' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    return true;
  });

  // Paste whatever is on the clipboard (a screenshot, in practice) into a tab.
  // This is how a chat tab gets to actually see the running preview.
  ipcMain.handle('tab:paste', (_e, { id }) => {
    const wc = asWebContentsId(id);
    wc.focus();
    const mod = process.platform === 'darwin' ? 'cmd' : 'control';
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: [mod] });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: [mod] });
    return true;
  });

  ipcMain.handle('tool:run', (_e, { project, cmd, args, timeoutMs }) => {
    const c = asCommand(cmd);
    return toolchain.run(mainWin(), asProject(project), c, asArgs(c, args), {
      timeoutMs: asTimeout(timeoutMs, 300000),
    });
  });

  /**
   * Run step N of the plan THIS process computed, by index.
   *
   * Preferred over tool:run: the renderer names an index, never a command or
   * an argument, so no command line can originate outside the main process.
   */
  ipcMain.handle('tool:runStep', (_e, { project, index }) => {
    const proj = asProject(project);
    const p = lastPlan.get(proj);
    if (!p) throw new Error('no plan computed for ' + proj);
    const i = Number(index);
    const step = Array.isArray(p.steps) ? p.steps[i] : null;
    if (!step) throw new Error(`no step ${index} in the plan for ${proj}`);
    return toolchain.run(mainWin(), proj, step.cmd, step.args, {
      timeoutMs: asTimeout(step.timeoutMs, 300000),
    });
  });

  ipcMain.handle('tool:serve', (_e, { project, script }) => {
    const name = String(script ?? 'dev');
    if (!/^[A-Za-z0-9:._-]{1,64}$/.test(name)) throw new Error('invalid script name: ' + name);
    return toolchain.startServer(mainWin(), asProject(project), name);
  });
  ipcMain.handle('tool:stop', (_e, { project }) => toolchain.stopServer(asProject(project)));
  ipcMain.handle('tool:screenshot', (_e, { project, url }) =>
    toolchain.screenshot(asProject(project), asPreviewUrl(url))
  );
  ipcMain.handle('tool:inspect', (_e, { project }) => toolchain.inspect(asProject(project)));
  ipcMain.handle('tool:plan', async (_e, { project }) => {
    const proj = asProject(project);
    const p = await toolchain.plan(proj);
    lastPlan.set(proj, p); // so tool:runStep can execute it without a round trip
    return p;
  });
  ipcMain.handle('tool:serveCmd', (_e, { project, cmd, args, port }) => {
    const c = asCommand(cmd);
    return toolchain.startProcessServer(mainWin(), asProject(project), c, asArgs(c, args), {
      port: Number(port) || undefined,
    });
  });
  ipcMain.handle('tool:serverErrors', (_e, { project }) => toolchain.serverErrors(asProject(project)));
  ipcMain.handle('tool:staticEntry', (_e, { project }) => toolchain.findStaticEntry(asProject(project)));
  ipcMain.handle('tool:scaffold', (_e, { project, modeKey }) => {
    const key = String(modeKey ?? '');
    if (!/^[a-z0-9-]{1,32}$/.test(key)) throw new Error('invalid mode: ' + key);
    return toolchain.scaffold(asProject(project), key);
  });

  // Everything currently running, so a leaked dev server is visible and
  // killable instead of surfacing as EADDRINUSE on the next run.
  ipcMain.handle('tool:servers', () => toolchain.serverList());
  ipcMain.handle('tool:stopPid', (_e, { pid }) => toolchain.stopPid(pid));
  ipcMain.handle('tool:freePort', (_e, { port }) => {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('invalid port');
    return toolchain.freePort(p);
  });

  // Which toolchains this machine has. A missing one is a fact about the
  // computer, never a defect in the generated code.
  ipcMain.handle('tool:preflight', async () => {
    const status = await sessionStore.status().catch(() => ({ loggedIn: false }));
    return {
      product: PRODUCT.product,
      version: app.getVersion(),
      workspace: workspace.ROOT,
      profileDir: app.getPath('userData'),
      // Names and expiry dates only - a cookie value never leaves the session.
      loggedIn: Boolean(status.loggedIn),
      runtimes: toolchain.preflight(),
    };
  });

  // Human-typed terminal only. An empty project runs at the workspace root.
  ipcMain.handle('term:exec', (_e, { project, commandLine }) => {
    const proj = String(project ?? '').trim();
    if (proj) asProject(proj);
    return toolchain.runShell(mainWin(), proj, String(commandLine ?? ''));
  });

  // The renderer may only ever open a local dev server in the system browser.
  ipcMain.handle('shell:open', (_e, { url }) => shell.openExternal(asLocalHttpUrl(url)));

  /**
   * Open a workspace file with the OS default handler.
   *
   * Static projects preview from file:///, and shell.openExternal refuses
   * those - which left "Open in browser" permanently broken for one of the
   * shipped modes.
   */
  ipcMain.handle('shell:openFile', async (_e, { path: rel }) => {
    const full = workspace.resolveSafe(asRelPath(rel));
    const err = await shell.openPath(full);
    if (err) throw new Error(err);
    return true;
  });

  ipcMain.handle('session:status', () => sessionStore.status());
  ipcMain.handle('session:flush', () => sessionStore.flush());
  ipcMain.handle('session:clear', () => sessionStore.clear());
  ipcMain.handle('session:reveal', () => shell.openPath(app.getPath('userData')));

  ipcMain.handle('app:info', () => ({
    product: PRODUCT.product,
    brand: PRODUCT.brand,
    version: app.getVersion(),
    license: PRODUCT.license,
    repo: PRODUCT.repo,
    issues: PRODUCT.issues,
    workspace: workspace.ROOT,
  }));
}

/* ------------------------------------------------------------------ */
/* Shutdown                                                            */
/* ------------------------------------------------------------------ */

// window-all-closed never fires when the quit came from the menu, Cmd+Q or
// app.quit(), which left a dev server per run holding its port after exit.
// before-quit does not await promises, so the quit is held open explicitly
// until the cookie store has actually been written.
let cleanedUp = false;
app.on('before-quit', (e) => {
  if (cleanedUp) return;
  cleanedUp = true;
  e.preventDefault();
  toolchain.stopAll();
  sessionStore.dispose().finally(() => app.exit(0));
});

app.on('window-all-closed', async () => {
  toolchain.stopAll(); // never leave a dev server running after the app closes
  await sessionStore.flush(); // never lose a login on close
  if (process.platform !== 'darwin') app.quit();
});

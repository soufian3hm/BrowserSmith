'use strict';
const { app, BrowserWindow, ipcMain, shell, webContents } = require('electron');
const path = require('node:path');
const workspace = require('./workspace');
const { SITE } = require('../shared/site');
const sessionStore = require('./session-store');
const toolchain = require('./toolchain');

// Must happen before app is ready and before any session is touched.
const PROFILE_DIR = sessionStore.pinProfileDir();

// One instance only - two Electron processes sharing a cookie store is how
// logins get clobbered.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
}

/** How much text one insertText call may carry, and the gap between calls. */
const TYPE_CHUNK = 4096;
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

function createWindow() {
  const win = new BrowserWindow({
    width: 1680,
    height: 1000,
    backgroundColor: '#111113',
    title: SITE.brand,
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
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // The site's OAuth / "open in app" popups must stay inside our session, not
  // bounce to the system browser where the login would not be captured.
  win.webContents.on('will-attach-webview', (_e, prefs) => {
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
  });
  return win;
}

app.whenReady().then(async () => {
  await sessionStore.assertWritable();
  sessionStore.watch();

  ipcMain.handle('fs:write', (_e, { path: rel, content }) => workspace.writeFile(rel, content));
  ipcMain.handle('fs:read', (_e, { path: rel }) => workspace.readFile(rel));
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
    const wc = webContents.fromId(id);
    if (!wc) throw new Error('no such webContents ' + id);
    const body = String(text ?? '');
    wc.focus();
    if (body.length <= TYPE_CHUNK) {
      await wc.insertText(body);
      return true;
    }
    for (const piece of typeChunks(body)) {
      if (wc.isDestroyed()) throw new Error('tab closed while typing');
      // Re-focus per piece: another tab focusing mid-insert would otherwise
      // spray the rest of the prompt into the wrong composer.
      wc.focus();
      await wc.insertText(piece);
      await delay(TYPE_YIELD_MS);
    }
    return true;
  });

  // Renderer-side webview.focus() only takes effect when the OS window itself
  // is focused. webContents.focus() does not care, so popup menus open even
  // with the app in the background.
  ipcMain.handle('tab:focus', (_e, { id }) => {
    const wc = webContents.fromId(id);
    if (!wc) throw new Error('no such webContents ' + id);
    wc.focus();
    return true;
  });

  ipcMain.handle('tab:enter', (_e, { id }) => {
    const wc = webContents.fromId(id);
    if (!wc) throw new Error('no such webContents ' + id);
    wc.focus();
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    wc.sendInputEvent({ type: 'char', keyCode: '\r' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    return true;
  });

  // Paste whatever is on the clipboard (a screenshot, in practice) into a tab.
  // This is how a chat tab gets to actually see the running preview.
  ipcMain.handle('tab:paste', (_e, { id }) => {
    const wc = webContents.fromId(id);
    if (!wc) throw new Error('no such webContents ' + id);
    wc.focus();
    const mod = process.platform === 'darwin' ? 'cmd' : 'control';
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: [mod] });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: [mod] });
    return true;
  });

  const mainWin = () => BrowserWindow.getAllWindows()[0];
  ipcMain.handle('tool:run', (_e, { project, cmd, args, timeoutMs }) =>
    toolchain.run(mainWin(), project, cmd, args, { timeoutMs })
  );
  ipcMain.handle('tool:serve', (_e, { project, script }) =>
    toolchain.startServer(mainWin(), project, script)
  );
  ipcMain.handle('tool:stop', (_e, { project }) => toolchain.stopServer(project));
  ipcMain.handle('tool:screenshot', (_e, { project, url }) =>
    toolchain.screenshot(project, url)
  );
  ipcMain.handle('tool:inspect', (_e, { project }) => toolchain.inspect(project));
  ipcMain.handle('tool:staticEntry', (_e, { project }) => toolchain.findStaticEntry(project));
  ipcMain.handle('tool:scaffold', (_e, { project, modeKey }) =>
    toolchain.scaffold(project, modeKey)
  );

  // Human-typed terminal only. An empty project runs at the workspace root.
  ipcMain.handle('term:exec', (_e, { project, commandLine }) =>
    toolchain.runShell(mainWin(), project, commandLine)
  );

  // The renderer may only ever open a local dev server in the system browser.
  ipcMain.handle('shell:open', (_e, { url }) => {
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch {
      throw new Error('shell:open - not a valid URL: ' + url);
    }
    const httpOk = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    const hostOk = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (!httpOk || !hostOk) {
      throw new Error('shell:open - only http(s) on localhost/127.0.0.1 is permitted');
    }
    return shell.openExternal(parsed.toString());
  });

  ipcMain.handle('session:status', () => sessionStore.status());
  ipcMain.handle('session:flush', () => sessionStore.flush());
  ipcMain.handle('session:clear', () => sessionStore.clear());
  ipcMain.handle('session:reveal', () => shell.openPath(PROFILE_DIR));

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  toolchain.stopAll(); // never leave a dev server running after the app closes
  await sessionStore.flush(); // never lose a login on close
  if (process.platform !== 'darwin') app.quit();
});

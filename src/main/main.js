'use strict';
const { app, BrowserWindow, ipcMain, shell, webContents } = require('electron');
const path = require('node:path');
const workspace = require('./workspace');
const sessionStore = require('./session-store');

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

function createWindow() {
  const win = new BrowserWindow({
    width: 1680,
    height: 1000,
    backgroundColor: '#111113',
    title: 'notioned',
    webPreferences: {
      preload: path.join(__dirname, 'preload-control.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // A sandboxed preload may only require 'electron' and a few builtins, so
      // it cannot load ../shared/protocol. The control window loads no remote
      // content - only our own index.html - so unsandboxing it is contained.
      // The two Notion webviews stay sandboxed; their preload requires nothing.
      sandbox: false,
      webviewTag: true, // the two Notion tabs
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Notion's OAuth / "open in app" popups must stay inside our session, not
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
  ipcMain.handle('tab:type', (_e, { id, text }) => {
    const wc = webContents.fromId(id);
    if (!wc) throw new Error('no such webContents ' + id);
    wc.focus();
    wc.insertText(text);
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
  await sessionStore.flush(); // never lose a login on close
  if (process.platform !== 'darwin') app.quit();
});

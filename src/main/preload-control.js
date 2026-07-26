'use strict';
/**
 * Bridge between the control renderer (app.js) and the main process.
 * Exposes exactly the surface described in the shared contract - app.js is
 * written against this shape, nothing else. `site` rides along so the renderer
 * can name the chat product in its copy without hardcoding it.
 */
const { contextBridge, ipcRenderer } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const protocol = require('../shared/protocol');
const patch = require('../shared/patch');
const { SITE } = require('../shared/site');

// The webview preload sits beside this file and is named after the site key,
// so the seam stays the only place the product is spelled out. Fail loudly if
// it is missing: tabs would otherwise boot with no DOM knowledge at all, which
// shows up much later as unexplained timeouts.
const webviewPreload = `preload-${SITE.key}.js`;
if (!fs.existsSync(path.join(__dirname, webviewPreload))) {
  throw new Error(`webview preload not found: ${webviewPreload}`);
}

const api = {
  site: SITE,
  preloadPath: 'file://' + path.join(__dirname, webviewPreload).replace(/\\/g, '/'),
  partition: SITE.partition,

  protocol: {
    MODES: protocol.MODES,
    systems: (modeKey) => protocol.systems(modeKey),
    TAGS: {
      request: (text, mode, existingFiles) => protocol.TAGS.request(text, mode, existingFiles),
      build: (p, text, mode, existingFiles) => protocol.TAGS.build(p, text, mode, existingFiles),
      review: (p, body) => protocol.TAGS.review(p, body),
      next: (written, note, existingFiles) => protocol.TAGS.next(written, note, existingFiles),
      audit: (request, written, mode) => protocol.TAGS.audit(request, written, mode),
    },
    parsePath: (reply) => protocol.parsePath(reply),
    parseVerdict: (reply) => protocol.parseVerdict(reply),
    parseAudit: (reply) => protocol.parseAudit(reply),
    unfence: (text) => protocol.unfence(text),
    stripStrayFences: (body, filePath) => protocol.stripStrayFences(body, filePath),
    condense: (text, max) => protocol.condense(text, max),
    extractBody: (reply, filePath) => protocol.extractBody(reply, filePath),
    clean: (text) => protocol.clean(text),
    slug: (text) => protocol.slug(text),
    rejectReason: (text) => protocol.rejectReason(text),
  },

  fs: {
    write: (relPath, content) => ipcRenderer.invoke('fs:write', { path: relPath, content }),
    read: (relPath) => ipcRenderer.invoke('fs:read', { path: relPath }),
    list: () => ipcRenderer.invoke('fs:list'),
    root: () => ipcRenderer.invoke('fs:root'),
  },

  session: {
    status: () => ipcRenderer.invoke('session:status'),
    flush: () => ipcRenderer.invoke('session:flush'),
    clear: () => ipcRenderer.invoke('session:clear'),
    reveal: () => ipcRenderer.invoke('session:reveal'),
  },

  tabs: {
    type: (id, text) => ipcRenderer.invoke('tab:type', { id, text }),
    enter: (id) => ipcRenderer.invoke('tab:enter', { id }),
    paste: (id) => ipcRenderer.invoke('tab:paste', { id }),
    focus: (id) => ipcRenderer.invoke('tab:focus', { id }),
  },

  tool: {
    run: (project, cmd, args, timeoutMs) =>
      ipcRenderer.invoke('tool:run', { project, cmd, args, timeoutMs }),
    serve: (project, script) => ipcRenderer.invoke('tool:serve', { project, script }),
    stop: (project) => ipcRenderer.invoke('tool:stop', { project }),
    screenshot: (project, url) => ipcRenderer.invoke('tool:screenshot', { project, url }),
    inspect: (project) => ipcRenderer.invoke('tool:inspect', { project }),
    staticEntry: (project) => ipcRenderer.invoke('tool:staticEntry', { project }),
    plan: (project) => ipcRenderer.invoke('tool:plan', { project }),
    serveCmd: (project, cmd, args) => ipcRenderer.invoke('tool:serveCmd', { project, cmd, args }),
    serverErrors: (project) => ipcRenderer.invoke('tool:serverErrors', { project }),
    scaffold: (project, modeKey) => ipcRenderer.invoke('tool:scaffold', { project, modeKey }),
    onOutput: (cb) => ipcRenderer.on('tool:output', (_e, p) => cb(p)),
  },

  // Surgical find/replace fixes: pure functions, no IPC needed.
  patch: {
    PATCH_FORMAT: patch.PATCH_FORMAT,
    parsePatches: (reply) => patch.parsePatches(reply),
    wantsRewrite: (reply) => patch.wantsRewrite(reply),
    applyPatches: (source, patches) => patch.applyPatches(source, patches),
    parseErrorLocation: (text) => patch.parseErrorLocation(text),
    excerpt: (source, line, radius) => patch.excerpt(source, line, radius),
  },

  // Human-typed terminal only; the empty string means the workspace root.
  term: {
    exec: (projectOrEmpty, commandLine) =>
      ipcRenderer.invoke('term:exec', { project: projectOrEmpty, commandLine }),
    onOutput: (cb) => ipcRenderer.on('term:output', (_e, p) => cb(p)),
  },

  // main.js only permits http(s) on localhost / 127.0.0.1.
  shell: {
    open: (url) => ipcRenderer.invoke('shell:open', { url }),
  },
};

contextBridge.exposeInMainWorld(SITE.brand, api);

'use strict';
/**
 * Bridge between the control renderer (app.js) and the main process.
 * Exposes exactly the window.notioned surface described in the shared
 * contract - app.js is written against this shape, nothing else.
 */
const { contextBridge, ipcRenderer } = require('electron');
const path = require('node:path');
const protocol = require('../shared/protocol');

contextBridge.exposeInMainWorld('notioned', {
  preloadPath:
    'file://' + path.join(__dirname, 'preload-notion.js').replace(/\\/g, '/'),
  partition: 'persist:notion',

  protocol: {
    MODES: protocol.MODES,
    systems: (modeKey) => protocol.systems(modeKey),
    TAGS: {
      request: (text, mode, existingFiles) =>
        protocol.TAGS.request(text, mode, existingFiles),
      build: (p, text, mode, existingFiles) =>
        protocol.TAGS.build(p, text, mode, existingFiles),
      review: (p, body) => protocol.TAGS.review(p, body),
      next: (written, note, existingFiles) =>
        protocol.TAGS.next(written, note, existingFiles),
      audit: (request, written, mode) => protocol.TAGS.audit(request, written, mode),
    },
    parsePath: (reply) => protocol.parsePath(reply),
    parseVerdict: (reply) => protocol.parseVerdict(reply),
    parseAudit: (reply) => protocol.parseAudit(reply),
    unfence: (text) => protocol.unfence(text),
    clean: (text) => protocol.clean(text),
    slug: (text) => protocol.slug(text),
    rejectReason: (text) => protocol.rejectReason(text),
  },

  fs: {
    write: (relPath, content) =>
      ipcRenderer.invoke('fs:write', { path: relPath, content }),
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
    screenshot: (project, url) =>
      ipcRenderer.invoke('tool:screenshot', { project, url }),
    inspect: (project) => ipcRenderer.invoke('tool:inspect', { project }),
    staticEntry: (project) => ipcRenderer.invoke('tool:staticEntry', { project }),
    scaffold: (project, modeKey) =>
      ipcRenderer.invoke('tool:scaffold', { project, modeKey }),
    onOutput: (cb) => ipcRenderer.on('tool:output', (_e, p) => cb(p)),
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
});

'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const path = require('node:path');
const protocol = require('../shared/protocol');

contextBridge.exposeInMainWorld('notioned', {
  preloadPath:
    'file://' + path.join(__dirname, 'preload-notion.js').replace(/\\/g, '/'),
  partition: 'persist:notion',
  protocol: {
    PLANNER_SYSTEM: protocol.PLANNER_SYSTEM,
    BUILDER_SYSTEM: protocol.BUILDER_SYSTEM,
    TAGS: {
      request: protocol.TAGS.request,
      build: protocol.TAGS.build,
      review: protocol.TAGS.review,
      next: protocol.TAGS.next,
    },
    slug: protocol.slug,
    clean: protocol.clean,
    rejectReason: protocol.rejectReason,
    unfence: protocol.unfence,
    parsePath: protocol.parsePath,
    parseVerdict: protocol.parseVerdict,
  },
  tabs: {
    type: (id, text) => ipcRenderer.invoke('tab:type', { id, text }),
    enter: (id) => ipcRenderer.invoke('tab:enter', { id }),
  },
  session: {
    status: () => ipcRenderer.invoke('session:status'),
    flush: () => ipcRenderer.invoke('session:flush'),
    clear: () => ipcRenderer.invoke('session:clear'),
    reveal: () => ipcRenderer.invoke('session:reveal'),
  },
  fs: {
    write: (p, content) => ipcRenderer.invoke('fs:write', { path: p, content }),
    read: (p) => ipcRenderer.invoke('fs:read', { path: p }),
    list: () => ipcRenderer.invoke('fs:list'),
    root: () => ipcRenderer.invoke('fs:root'),
  },
});

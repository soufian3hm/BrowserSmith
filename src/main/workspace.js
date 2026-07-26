'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

/**
 * Every file the loop produces lands under ./workspace. Content coming back
 * from the chat tabs is untrusted text, so paths are sanitized and confined here -
 * a reply of "../../.ssh/authorized_keys" must never escape.
 */
function computeRoot() {
  // In the packaged app, projects live next to the .exe where the user can
  // see them. In dev (and for the plain-node MCP server) they live in the
  // repo root, as always.
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) {
      return path.join(path.dirname(process.execPath), 'workspace');
    }
  } catch { /* plain node (MCP server) - no electron */ }
  return path.resolve(__dirname, '..', '..', 'workspace');
}
const ROOT = computeRoot();

function resolveSafe(rel) {
  const cleaned = String(rel || '')
    .replace(/\\/g, '/')
    .replace(/^[a-zA-Z]:/, '')
    .replace(/^\/+/, '')
    .trim();
  if (!cleaned) throw new Error('empty path');
  const full = path.resolve(ROOT, cleaned);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) {
    throw new Error(`path escapes workspace: ${rel}`);
  }
  return full;
}

async function writeFile(rel, content) {
  const full = resolveSafe(rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf8');
  return { path: full, rel, bytes: Buffer.byteLength(content, 'utf8') };
}

async function readFile(rel) {
  return fs.readFile(resolveSafe(rel), 'utf8');
}

// Never descend into these: npm install alone adds tens of thousands of files,
// and list() runs on every agent round - an unpruned walk turns each round into
// a multi-second stall plus a huge IPC payload.
const SKIP_DIRS = new Set([
  'node_modules', '.next', '.git', '.preview', '.turbo', '.cache', 'dist', 'build', '__pycache__',
]);

async function list() {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(path.relative(ROOT, p).replace(/\\/g, '/'));
    }
  }
  await walk(ROOT);
  return out;
}

module.exports = { ROOT, resolveSafe, writeFile, readFile, list };

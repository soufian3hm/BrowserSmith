'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
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

/**
 * The workspace root with every symlink already resolved.
 *
 * Prefix matching alone is not containment: `npm install` on a model-authored
 * package.json containing `"dep": "file:../../.."` leaves a junction under
 * node_modules/, and a write through it passes a string test while landing
 * anywhere on disk. Resolved once - the root does not move at runtime.
 */
let rootReal = null;
function realRoot() {
  if (rootReal) return rootReal;
  try {
    fs.mkdirSync(ROOT, { recursive: true });
    rootReal = fs.realpathSync(ROOT);
  } catch {
    rootReal = ROOT; // unwritable root: assertWritable reports it with a dialog
  }
  return rootReal;
}

function within(parent, child) {
  return child === parent || child.startsWith(parent + path.sep);
}

/**
 * The deepest ancestor of `full` that exists, resolved through symlinks.
 * A path we are about to create has no realpath of its own, but the directory
 * it will be created in does - and that is the one that can be a junction.
 */
function realExistingAncestor(full) {
  let cur = full;
  for (;;) {
    try {
      return fs.realpathSync(cur);
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return null; // walked past the drive root
      cur = up;
    }
  }
}

function resolveSafe(rel) {
  const cleaned = String(rel || '')
    .replace(/\\/g, '/')
    .replace(/^[a-zA-Z]:/, '')
    .replace(/^\/+/, '')
    .trim();
  if (!cleaned) throw new Error('empty path');
  // A NUL truncates the path inside libuv, so "ok.txt\0../../etc" would pass
  // every check above and open something else entirely.
  if (cleaned.includes('\0')) throw new Error(`path contains a NUL byte: ${rel}`);
  const full = path.resolve(ROOT, cleaned);
  if (!within(ROOT, full)) {
    throw new Error(`path escapes workspace: ${rel}`);
  }

  // Second gate: the real, symlink-resolved location must be inside the real
  // root too. Only the logical path is returned - callers (and the tests)
  // expect paths under ROOT, not under whatever ROOT happens to link to.
  const anchor = realExistingAncestor(full);
  if (anchor && !within(realRoot(), anchor)) {
    throw new Error(`path escapes workspace through a link: ${rel}`);
  }
  return full;
}

// CON, PRN, AUX, NUL, COM1-9, LPT1-9 are devices on Windows: opening one hangs
// instead of failing.
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * A project name that is safe as a single folder under the workspace.
 *
 * The renderer derives these from model output, so they arrive as arbitrary
 * text: reject separators, dot-segments and device names rather than quietly
 * sanitising them into a different project's folder.
 */
function assertProjectName(project) {
  const name = String(project ?? '').trim();
  if (!name) throw new Error('project name is empty');
  if (name.length > 120) throw new Error('project name is too long');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(`invalid project name: ${name}`);
  }
  if (name === '.' || name === '..' || name.includes('..')) {
    throw new Error(`invalid project name: ${name}`);
  }
  if (WIN_RESERVED.test(name)) throw new Error(`reserved project name: ${name}`);
  return name;
}

async function writeFile(rel, content) {
  const full = resolveSafe(rel);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content, 'utf8');
  return { path: full, rel, bytes: Buffer.byteLength(content, 'utf8') };
}

async function readFile(rel) {
  return fsp.readFile(resolveSafe(rel), 'utf8');
}

// Never descend into these: npm install alone adds tens of thousands of files,
// and list() runs on every agent round - an unpruned walk turns each round into
// a multi-second stall plus a huge IPC payload.
const SKIP_DIRS = new Set([
  'node_modules', '.next', '.git', '.preview', '.turbo', '.cache', 'dist', 'build', '__pycache__',
  '.venv', 'venv', '.svelte-kit', '.astro', '.nuxt', '.output', 'target', 'vendor', '.browsersmith',
]);

async function list() {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
      // A symlinked directory can point back out of the workspace (or at
      // itself); walking it is both an escape and an infinite loop.
      if (e.isSymbolicLink()) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(path.relative(ROOT, p).replace(/\\/g, '/'));
    }
  }
  await walk(ROOT);
  return out;
}

module.exports = { ROOT, resolveSafe, assertProjectName, writeFile, readFile, list, SKIP_DIRS };

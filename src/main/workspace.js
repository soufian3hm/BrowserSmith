'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

/**
 * Every file the loop produces lands under ./workspace. Content coming back
 * from Notion is untrusted text, so paths are sanitized and confined here -
 * a reply of "../../.ssh/authorized_keys" must never escape.
 */
const ROOT = path.resolve(__dirname, '..', '..', 'workspace');

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
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(path.relative(ROOT, p).replace(/\\/g, '/'));
    }
  }
  await walk(ROOT);
  return out;
}

module.exports = { ROOT, resolveSafe, writeFile, readFile, list };

'use strict';
/**
 * Surgical edits instead of whole-file rewrites.
 *
 * When a run fails on one bad line, asking the builder to re-emit the entire
 * file costs a full generation, risks regressing everything that already
 * worked, and - on a 50KB file - is exactly the payload that wedges a chat tab.
 * A find/replace patch is a few hundred characters either way.
 *
 * The format is deliberately the conflict-marker shape models already produce
 * reliably, and matching is forgiving about indentation because that is the
 * detail they most often get subtly wrong.
 */

/** Instructions handed to the builder when we want a patch, not a file. */
const PATCH_FORMAT = [
  'Reply with ONE OR MORE search/replace patches and nothing else:',
  '',
  '<<<<<<< FIND',
  'the exact lines to replace, copied character for character from the file',
  '=======',
  'the corrected lines',
  '>>>>>>> REPLACE',
  '',
  'Rules:',
  '- FIND must appear EXACTLY ONCE in the file. Include a few surrounding lines if needed to make it unique.',
  '- Copy FIND from the file verbatim - do not retype it from memory, do not reformat it.',
  '- Keep patches minimal: change only what is broken.',
  '- No prose, no explanation, no code fences around the markers.',
  '- If the fix genuinely cannot be expressed as a patch, reply with the single word REWRITE.',
].join('\n');

const BLOCK_RE =
  /<{3,}\s*FIND\s*\r?\n([\s\S]*?)\r?\n={3,}\s*\r?\n([\s\S]*?)\r?\n>{3,}\s*REPLACE/g;

/** Pull every find/replace pair out of a reply. */
function parsePatches(reply) {
  const text = String(reply || '').replace(/\r\n/g, '\n');
  const out = [];
  let m;
  BLOCK_RE.lastIndex = 0;
  while ((m = BLOCK_RE.exec(text)) !== null) {
    const find = m[1];
    const replace = m[2];
    if (find.trim()) out.push({ find, replace });
  }
  return out;
}

/** Did the builder tell us a patch is not possible? */
function wantsRewrite(reply) {
  return /^\W*REWRITE\W*$/im.test(String(reply || '').trim());
}

const norm = (s) => s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '');

/**
 * Find `needle` in `hay` allowing for indentation drift.
 *
 * Models reproduce logic faithfully and leading whitespace sloppily, so an
 * exact-only match rejects patches that are otherwise perfect. We try exact
 * first, then re-anchor on the same lines with their indentation stripped.
 * Returns {start, end} into `hay`, or null.
 */
function locate(hay, needle) {
  const exact = hay.indexOf(needle);
  if (exact !== -1) {
    // Ambiguous matches are refused: replacing the wrong copy silently
    // corrupts a file, which is worse than failing the patch.
    return hay.indexOf(needle, exact + 1) === -1
      ? { start: exact, end: exact + needle.length }
      : null;
  }

  const hayLines = hay.split('\n');
  const needLines = needle.split('\n').filter((l, i, a) => !(l.trim() === '' && (i === 0 || i === a.length - 1)));
  if (!needLines.length) return null;
  const trimmed = needLines.map((l) => l.trim());

  let found = null;
  for (let i = 0; i + trimmed.length <= hayLines.length; i++) {
    let hit = true;
    for (let j = 0; j < trimmed.length; j++) {
      if (hayLines[i + j].trim() !== trimmed[j]) { hit = false; break; }
    }
    if (!hit) continue;
    if (found) return null; // ambiguous again
    found = i;
  }
  if (found === null) return null;

  const start = hayLines.slice(0, found).reduce((n, l) => n + l.length + 1, 0);
  const end =
    start + hayLines.slice(found, found + trimmed.length).reduce((n, l) => n + l.length + 1, 0) - 1;
  return { start, end };
}

/** Re-indent `replacement` to sit where `original` sat. */
function reindent(original, replacement) {
  const indentOf = (s) => (s.match(/^[ \t]*/) || [''])[0];
  const origIndent = indentOf(original.split('\n')[0] || '');
  const replLines = replacement.split('\n');
  const replIndent = indentOf(replLines[0] || '');
  if (origIndent === replIndent) return replacement;
  return replLines
    .map((l) => (l.startsWith(replIndent) ? origIndent + l.slice(replIndent.length) : l))
    .join('\n');
}

/**
 * Apply patches to a source file.
 * Returns { text, applied, failed } - `failed` carries the patches whose FIND
 * did not match uniquely, so the caller can fall back to a full rewrite.
 */
function applyPatches(source, patches) {
  let text = norm(String(source || ''));
  const applied = [];
  const failed = [];

  for (const p of patches) {
    const find = norm(p.find);
    const at = locate(text, find);
    if (!at) {
      failed.push({ ...p, reason: 'FIND not found, or matched more than once' });
      continue;
    }
    const original = text.slice(at.start, at.end);
    text = text.slice(0, at.start) + reindent(original, norm(p.replace)) + text.slice(at.end);
    applied.push(p);
  }
  return { text, applied, failed };
}

/**
 * Where a stack trace or error overlay says the problem is.
 * Handles "app\page.tsx (619:39)", "app/page.tsx:619:39" and "at .../file.js:12".
 */
function parseErrorLocation(diagnostics) {
  const t = String(diagnostics || '').replace(/\\/g, '/');
  const patterns = [
    /([\w./-]+\.[a-z]{2,4})\s*\((\d+):(\d+)\)/i,
    /([\w./-]+\.[a-z]{2,4}):(\d+):(\d+)/i,
    /([\w./-]+\.[a-z]{2,4}):(\d+)/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) return { file: m[1].replace(/^\.\//, ''), line: Number(m[2]) };
  }
  return null;
}

/**
 * The slice of a file around a line, with line numbers.
 * The builder needs enough context to copy a unique FIND out of it.
 */
function excerpt(source, line, radius = 40) {
  const lines = String(source || '').split('\n');
  if (!line || line < 1) return lines.slice(0, radius * 2).map(numbered(1)).join('\n');
  const from = Math.max(0, line - radius);
  const to = Math.min(lines.length, line + radius);
  return lines.slice(from, to).map(numbered(from + 1)).join('\n');
}

const numbered = (start) => (l, i) => `${String(start + i).padStart(5)}  ${l}`;

module.exports = {
  PATCH_FORMAT,
  parsePatches,
  wantsRewrite,
  applyPatches,
  parseErrorLocation,
  excerpt,
};

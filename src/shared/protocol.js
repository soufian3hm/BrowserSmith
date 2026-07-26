'use strict';

/**
 * The wire contract between the orchestrator and the two Notion tabs.
 *
 * Tab A ("planner")  -> we type the user's request here. It must answer with a
 *                       single line: the file path, nothing else, no thinking.
 * Tab B ("builder")  -> we paste tab A's answer here. It answers with the file
 *                       body (usually fenced code).
 * Tab A again        -> we show it tab B's answer. It must reply with exactly
 *                       one word: PRINT (accept) or RETRY (reject).
 */

const PLANNER_SYSTEM = `You are the PLANNER half of a two-agent file-writing loop.
Rules you must never break:
1. When you receive a REQUEST, reply with ONE line only: the relative file path to create (e.g. src/utils/slug.ts).
2. No prose, no thinking, no markdown, no backticks, no explanation. Just the path.
3. When you receive a REVIEW block, reply with EXACTLY ONE WORD: PRINT if the content is a valid, complete file for that path, otherwise RETRY.
4. When you receive a WRITTEN SO FAR block, reply with either the next file path needed, or the single word DONE if the project is complete.
5. Never output anything other than a path, DONE, or the single word PRINT / RETRY.`;

const BUILDER_SYSTEM = `You are the BUILDER half of a two-agent file-writing loop.
Rules you must never break:
1. You receive a file path and a request. Output ONLY the full contents of that file.
2. No commentary before or after. No explanation. A single fenced code block is allowed; nothing else.
3. The file must be complete and runnable on its own - never abbreviate with "..." or "rest unchanged".`;

const TAGS = {
  request: (text) => `REQUEST\n${text}\n\nReply with the file path only.`,
  build: (path, text) =>
    `PATH: ${path}\nREQUEST: ${text}\n\nOutput only the complete contents of ${path}.`,
  review: (path, body) =>
    `REVIEW\nPATH: ${path}\nCONTENT:\n${body}\n\nReply with exactly one word: PRINT or RETRY.`,
  next: (written) =>
    `WRITTEN SO FAR:\n${written.map((f) => '- ' + f).join('\n') || '(none)'}\n\n` +
    `Reply with the next file path needed to finish the project, or the single word DONE.`,
};

/** Turn a free-text project name into a safe single directory segment. */
function slug(name) {
  const s = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || 'untitled';
}

/** Streaming placeholders that must never be mistaken for file content. */
const PLACEHOLDER_LINE =
  /^(generating|thinking|searching|working|loading|writing file|reading file|creating|analyz\w*|planning|browsing|running|loaded [\w\s]*tools?|using [\w\s]*tool|alpha)[\s.…]*$/i;

/** Drop UI noise the transcript picks up around a reply. */
function clean(text) {
  return String(text || '')
    .split('\n')
    .filter((l) => !PLACEHOLDER_LINE.test(l.trim()))
    // Notion stamps a time on each message bubble, e.g. "4:37 AM".
    .filter((l) => !/^\d{1,2}:\d{2}\s*(AM|PM)?$/i.test(l.trim()))
    .join('\n')
    .trim();
}

/** Strip a single surrounding fenced code block, if present. */
function unfence(text) {
  const t = clean(text);
  const m = t.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  return m ? m[1] : t;
}

/**
 * Pull a plausible relative file path out of the planner's reply.
 * Returns the string 'DONE' when the planner signals the project is complete.
 */
function parsePath(reply) {
  const text = unfence(reply).trim();
  if (/^\W*DONE\W*$/i.test(text)) return 'DONE';
  const line = text
    .split('\n')
    .map((l) => l.trim().replace(/^[-*`]\s*/, '').replace(/[`'"]/g, ''))
    .find((l) => l && /^[\w.][\w./-]*\.[A-Za-z0-9]+$/.test(l) && !/\s/.test(l));
  return line || null;
}

/** The planner's verdict word, or null if it did not follow the contract. */
function parseVerdict(reply) {
  const word = unfence(reply).trim().toUpperCase().match(/\b(PRINT|RETRY)\b/);
  return word ? word[1] : null;
}

/**
 * Reject a "file" that is really our own prompt echoed back, or a placeholder.
 * Returns a reason string, or null when the content looks like a real file.
 */
function rejectReason(body) {
  const t = clean(body);
  if (!t) return 'empty';
  if (t.length < 12) return 'too short to be a file';
  if (/Output only the complete contents of/i.test(t)) return 'echoed our prompt';
  if (/^PATH:/im.test(t) && /^REQUEST:/im.test(t)) return 'echoed the prompt header';
  if (/^(REVIEW|REQUEST|WRITTEN SO FAR)$/im.test(t)) return 'echoed a protocol tag';
  return null;
}

module.exports = {
  PLANNER_SYSTEM,
  BUILDER_SYSTEM,
  TAGS,
  slug,
  clean,
  rejectReason,
  unfence,
  parsePath,
  parseVerdict,
};

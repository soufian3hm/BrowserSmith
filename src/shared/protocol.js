'use strict';

/**
 * The wire contract between the orchestrator and the four chat tabs.
 *
 * Tab A ("planner")  -> receives the request plus the existing-files list and
 *                       answers with ONE line: the next file path, or DONE.
 * Tab B ("builder")  -> receives the path + request and answers with the file
 *                       body (usually fenced code).
 * Tab C ("reviewer") -> receives path + body, answers exactly PRINT or RETRY.
 * Tab D ("auditor")  -> receives request + files written, answers with the one
 *                       most important missing piece, or DONE.
 *
 * Everything is mode-aware: MODES describes each project flavour and
 * systems(modeKey) produces the four role prompts for it.
 */

/* ------------------------------------------------------------------ modes */

const MODES = {
  auto: {
    key: 'auto',
    label: 'Auto',
    scaffold: false,
    devScript: null,
    previews: 'browser',
    hint:
      'No fixed framework - use the simplest stack that satisfies the request; ' +
      'when in doubt, one self-contained index.html at the project root.',
  },
  nextjs: {
    key: 'nextjs',
    label: 'Next.js',
    scaffold: true,
    devScript: 'dev',
    previews: 'browser',
    hint:
      'Next.js App Router in TypeScript: pages in app/ (app/page.tsx, ' +
      'app/layout.tsx, app/globals.css), shared UI in components/*.tsx. ' +
      'The scaffold already exists on disk - naming a scaffold file replaces it.',
  },
  vite: {
    key: 'vite',
    label: 'Vite',
    scaffold: true,
    devScript: 'dev',
    previews: 'browser',
    hint:
      'Vite project: index.html at the project root loads the entry module ' +
      'from src/ with <script type="module">; keep all source under src/. ' +
      'The scaffold already exists on disk - naming a scaffold file replaces it.',
  },
  static: {
    key: 'static',
    label: 'Static site',
    scaffold: false,
    devScript: null,
    previews: 'browser',
    hint:
      'Plain static site, no build step: index.html at the project root, ' +
      'optional styles.css and script.js beside it, relative paths only - ' +
      'it must work opened straight from disk.',
  },
  node: {
    key: 'node',
    label: 'Node.js',
    scaffold: true,
    devScript: null,
    previews: 'run',
    hint:
      'Plain Node.js (CommonJS) run as `node index.js`: entry index.js at the ' +
      'project root, Node core modules only, no npm installs.',
  },
  python: {
    key: 'python',
    label: 'Python',
    scaffold: true,
    devScript: null,
    previews: 'run',
    hint:
      'Python 3 run as `python main.py`: entry main.py at the project root, ' +
      'standard library only, no pip installs.',
  },
};

/** Fuller per-mode conventions woven into the role prompts. */
const CONVENTIONS = {
  auto:
    'No framework is fixed. Infer the simplest stack that fully satisfies the ' +
    'request - for anything visual prefer a single self-contained index.html ' +
    'with inline CSS and JS and no build step; add more files only when the ' +
    'request clearly needs them.',
  nextjs:
    'This is a Next.js App Router project in TypeScript. Routes live under ' +
    'app/: app/page.tsx is the home page, app/layout.tsx the root layout, ' +
    'app/globals.css the global styles. Shared UI belongs in components/*.tsx, ' +
    'imported with relative paths unless the existing tsconfig defines an ' +
    'alias. The scaffold (package.json, tsconfig.json, next config, ' +
    'app/layout.tsx, app/page.tsx, app/globals.css) already exists on disk. ' +
    'Use only react and next - no extra npm packages. Any component using ' +
    'hooks or event handlers needs "use client" as its first line.',
  vite:
    'This is a Vite project. index.html at the project root is the entry page ' +
    'and loads the main module from src/ with <script type="module">. All ' +
    'source lives under src/; styles are src/*.css files imported from the ' +
    'code. The scaffold (package.json, index.html, the src/ entry) already ' +
    'exists on disk. No npm packages beyond what the scaffold provides.',
  static:
    'This is a plain static site with no build step and no server: index.html ' +
    'at the project root, optional styles.css and script.js referenced with ' +
    'relative paths. Everything must work when index.html is opened straight ' +
    'from disk - no npm packages, no bundler, no external CDNs.',
  node:
    'This is a plain Node.js project. The entry point is index.js at the ' +
    'project root and the whole program must run with `node index.js` using ' +
    'only Node core modules (CommonJS require) - no npm installs. Split logic ' +
    'into small local modules such as lib/*.js when it grows.',
  python:
    'This is a Python 3 project. The entry point is main.py at the project ' +
    'root and the whole program must run with `python main.py` using only the ' +
    'standard library - no pip installs. Split logic into small local modules ' +
    'when it grows.',
};

/** What "finished" means, per mode - the auditor judges against this. */
const DEFINITION_OF_DONE = {
  auto:
    'the files as written satisfy the request end to end; anything visual ' +
    'works by simply opening index.html',
  nextjs:
    '`npm run dev` serves the requested app: app/page.tsx renders it, every ' +
    'import resolves to a file that exists, and package.json/tsconfig were ' +
    'only touched if genuinely required',
  vite:
    '`npm run dev` serves the requested app: index.html loads the src/ entry ' +
    'and every import resolves to a file that exists',
  static:
    'opening index.html straight from disk shows the complete working result',
  node: '`node index.js` runs cleanly and demonstrates the requested behavior',
  python:
    '`python main.py` runs cleanly and demonstrates the requested behavior',
};

/** A believable example path for the planner prompt, per mode. */
const EXAMPLE_PATH = {
  auto: 'index.html',
  nextjs: 'components/Header.tsx',
  vite: 'src/app.ts',
  static: 'script.js',
  node: 'lib/store.js',
  python: 'game.py',
};

/* ---------------------------------------------------------- role prompts */

/** The four role prompts (planner/builder/reviewer/auditor) for a mode. */
function systems(modeKey) {
  const mode = MODES[modeKey] || MODES.auto;
  const conv = CONVENTIONS[mode.key];
  const done = DEFINITION_OF_DONE[mode.key];
  const example = EXAMPLE_PATH[mode.key];

  const scaffoldRule = mode.scaffold
    ? 'The scaffold already exists on disk and appears in the EXISTING FILES ' +
      'list - name a scaffold file only to REPLACE its contents, and never ' +
      're-emit package.json, lockfiles or config files unless the request ' +
      'genuinely changes them.'
    : 'There is no scaffold - your first path is the entry file itself ' +
      (mode.previews === 'browser' ? '(usually index.html).' : '.');

  const qualityRule =
    mode.previews === 'browser'
      ? 'Make it genuinely pleasant to look at: tasteful, self-contained ' +
        'styling - real spacing, a deliberate palette, readable typography - ' +
        'with no external fonts, CDNs, or image files that do not exist.'
      : 'Make it pleasant to run: clear console output, small well-named ' +
        'functions, graceful handling of bad input.';

  const planner = `You are the PLANNER in a four-agent loop that writes a real project into a workspace folder.
${conv}
Rules you must never break:
1. Reply INSTANTLY with ONE line only. No thinking out loud, no tools, no browsing, no markdown, no backticks, no prose. You never write file contents yourself.
2. To a REQUEST or a WRITTEN SO FAR block, answer with exactly one relative file path (e.g. ${example}) - the single most useful file to write next - or the single word DONE when nothing more is needed.
3. Place files using the EXISTING FILES list: extend the structure that is already there and keep every import resolvable. Naming a file that already exists means its contents get REPLACED, so only name one when you mean to rewrite it.
4. ${scaffoldRule}
5. To a REVIEW block, answer with EXACTLY ONE WORD: PRINT if the content is a valid, complete file for that path, otherwise RETRY.
6. Never output anything except one path, DONE, PRINT or RETRY.`;

  const builder = `You are the BUILDER in a four-agent loop that writes a real project into a workspace folder.
${conv}
Rules you must never break:
1. You get a PATH, the REQUEST and the EXISTING FILES list. Output ONLY the complete contents of that one file - nothing before it, nothing after it. A single fenced code block around the file is allowed.
2. The file must be complete top to bottom: "...", "rest unchanged", "add more here" and TODO stubs for core behavior are all forbidden.
3. Every import and reference must resolve: import only from the platform itself, from files on the EXISTING FILES list, or from the file being written. Never import a package or file that does not exist.
4. ${qualityRule}
5. Match the language to the file extension and keep the file ready to drop straight onto disk.`;

  const reviewer = `You are the REVIEWER in a four-agent loop building a real project.
${conv}
Rules you must never break:
1. You get a PATH and its proposed CONTENT. Judge that one file only: is it complete and correct for this path in this kind of project?
2. RETRY when it is truncated or elided ("..."), echoes the prompt back, is the wrong language for the extension, or imports files or packages that cannot exist here. PRINT when a competent teammate would commit it as-is.
3. Reply with EXACTLY ONE WORD: PRINT or RETRY. No tools, no rewriting, no explanation.`;

  const auditor = `You are the AUDITOR in a four-agent loop building a real project.
Definition of done: ${done}.
Rules you must never break:
1. You get the project REQUEST and the FILES WRITTEN list. Compare them against the request and nothing else.
2. If something essential is missing, reply with ONE short line naming the single most important missing piece (e.g. "index.html links style.css but it was never written").
3. If the files already satisfy the request, reply with the single word DONE. Do not invent extras - no bonus pages, no tests, no polish beyond the request. A small working app beats a long file list.
4. No tools, no files, no code. One line maximum.`;

  return { planner, builder, reviewer, auditor };
}

/* ------------------------------------------------------------------ tags */

/** Never render more than this many file lines into a prompt. */
const FILE_LIST_CAP = 60;

function renderFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean).map(String) : [];
  if (!list.length) return '(none yet)';
  const lines = list.slice(0, FILE_LIST_CAP).map((f) => '- ' + f);
  if (list.length > FILE_LIST_CAP) lines.push(`(+${list.length - FILE_LIST_CAP} more)`);
  return lines.join('\n');
}

function asMode(mode) {
  return (mode && mode.key && MODES[mode.key]) || MODES.auto;
}

function modeLine(mode) {
  const m = asMode(mode);
  return `MODE: ${m.label} - ${m.hint}`;
}

const TAGS = {
  request: (text, mode, existingFiles) =>
    `REQUEST\n${text}\n\n${modeLine(mode)}\nEXISTING FILES:\n${renderFiles(existingFiles)}\n\n` +
    `Reply with ONE line: the relative path of the next file to write. Nothing else.`,
  build: (path, text, mode, existingFiles) =>
    `PATH: ${path}\nREQUEST: ${text}\n${modeLine(mode)}\nEXISTING FILES:\n${renderFiles(existingFiles)}\n\n` +
    `Output only the complete contents of ${path}.`,
  review: (path, body) =>
    `REVIEW\nPATH: ${path}\nCONTENT:\n${body}\n\nReply with exactly one word: PRINT or RETRY.`,
  next: (written, note, existingFiles) =>
    `WRITTEN SO FAR:\n${renderFiles(written)}\n` +
    (note ? `AUDITOR SAYS: ${note}\n` : '') +
    `EXISTING FILES:\n${renderFiles(existingFiles)}\n\n` +
    `Reply with the next file path needed to finish the project, or the single word DONE.`,
  audit: (request, written, mode) => {
    const m = asMode(mode);
    return (
      `PROJECT: ${request}\nMODE: ${m.label}\nFILES WRITTEN:\n${renderFiles(written)}\n\n` +
      `Definition of done: ${DEFINITION_OF_DONE[m.key]}.\n` +
      `If that is already met, reply DONE. Otherwise name the single most important missing piece in one short line.`
    );
  },
};

/* --------------------------------------------------------------- parsers */
/* Battle-tested against live chat-product output - carried over as-is. */

/** The auditor's answer: null when it says the project is finished. */
function parseAudit(reply) {
  const t = clean(unfence(reply)).split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
  if (/^\W*DONE\W*$/i.test(t)) return null;
  return t.slice(0, 200) || null;
}

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
  /^(generating|thinking|searching|working|loading|writing file|reading file|creating|crafting|drafting|composing|reviewing|preparing|analyz\w*|planning|browsing|running|loaded [\w\s]*tools?|using [\w\s]*tool|alpha)[\s.…]*$/i;

/** Drop UI noise the transcript picks up around a reply. */
function clean(text) {
  return String(text || '')
    .split('\n')
    .filter((l) => !PLACEHOLDER_LINE.test(l.trim()))
    // Chat UIs stamp a time on each message bubble, e.g. "4:37 AM".
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
    .find(
      (l) =>
        l &&
        /^[\w.][\w./-]*\.[A-Za-z0-9]+$/.test(l) &&
        !/\s/.test(l) &&
        // ".." would climb into a SIBLING project before workspace.resolveSafe
        // ever sees it, because app.js prefixes "<project>/" first.
        !l.split('/').includes('..')
    );
  return line || null;
}

/** The reviewer's verdict word, or null if it did not follow the contract. */
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
  MODES,
  systems,
  TAGS,
  parsePath,
  parseVerdict,
  parseAudit,
  unfence,
  clean,
  slug,
  rejectReason,
};

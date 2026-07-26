'use strict';

/**
 * The wire contract between the orchestrator and the four chat tabs.
 *
 * Tab A ("planner")  -> receives the request plus the existing-files list and
 *                       answers with ONE line: the next file path, or DONE.
 * Tab B ("builder")  -> receives the path + request and answers with the file
 *                       body in one fenced block; extractBody() salvages the
 *                       body from whatever shape actually comes back.
 * Tab C ("reviewer") -> receives path + a CONDENSED body, answers exactly
 *                       PRINT or RETRY - it only ever needs one word back, so
 *                       it never gets the whole file (see condense).
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
      'No fixed framework and no default. YOU choose the stack that genuinely ' +
      'fits this request - any language, any runtime, any number of files.',
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
      'Node.js (CommonJS) run as `node index.js`: entry index.js at the ' +
      'project root; declare any dependency in package.json.',
  },
  python: {
    key: 'python',
    label: 'Python',
    scaffold: true,
    devScript: null,
    previews: 'run',
    hint:
      'Python 3 run as `python main.py`: entry main.py at the project root; ' +
      'list any dependency in requirements.txt.',
  },
};

/** Fuller per-mode conventions woven into the role prompts. */
const CONVENTIONS = {
  auto:
    'No framework, language or file layout is fixed, and there is no default ' +
    'to fall back on. Decide what this request actually needs and build that: ' +
    'a Python service, a Go binary, a Node CLI, a multi-file web app, a single ' +
    'HTML page - whatever genuinely fits. Choose the stack a competent engineer ' +
    'would choose for this specific problem, structure it in as many files as ' +
    'that stack normally uses, and do not reach for a self-contained HTML page ' +
    'unless the request really is a static page. If it needs a server, write a ' +
    'server. If it needs to crawl or process data, write real code in a ' +
    'language suited to that. The runner detects and runs whatever you produce.',
  nextjs:
    'This is a Next.js App Router project in TypeScript. Routes live under ' +
    'app/: app/page.tsx is the home page, app/layout.tsx the root layout, ' +
    'app/globals.css the global styles. Shared UI belongs in components/*.tsx, ' +
    'imported with relative paths unless the existing tsconfig defines an ' +
    'alias. The scaffold (package.json, tsconfig.json, next config, ' +
    'app/layout.tsx, app/page.tsx, app/globals.css) already exists on disk. ' +
    'Prefer react and next alone, but declare any package you genuinely need ' +
    'in package.json - dependencies are installed before the app runs. Any component using ' +
    'hooks or event handlers needs "use client" as its first line.',
  vite:
    'This is a Vite project. index.html at the project root is the entry page ' +
    'and loads the main module from src/ with <script type="module">. All ' +
    'source lives under src/; styles are src/*.css files imported from the ' +
    'code. The scaffold (package.json, index.html, the src/ entry) already ' +
    'exists on disk. Declare any package you genuinely need in package.json - ' +
    'dependencies are installed before the app runs.',
  static:
    'This is a plain static site with no build step and no server: index.html ' +
    'at the project root, optional styles.css and script.js referenced with ' +
    'relative paths. Everything must work when index.html is opened straight ' +
    'from disk - no npm packages, no bundler, no external CDNs.',
  node:
    'This is a Node.js project. The entry point is index.js at the project ' +
    'root and it must run with `node index.js` (CommonJS require). Prefer Node ' +
    'core modules so it runs with no install step, but if the task genuinely ' +
    'needs a package, declare it in package.json - dependencies are installed ' +
    'before the project is run. Split logic into local modules as it grows.',
  python:
    'This is a Python 3 project. The entry point is main.py at the project ' +
    'root and it must run with `python main.py`. Prefer the standard library ' +
    'so it runs with no install step, but if the task genuinely needs a ' +
    'package, list it in requirements.txt - it is installed before the project ' +
    'is run. Split logic into local modules as it grows.',
};

/** What "finished" means, per mode - the auditor judges against this. */
const DEFINITION_OF_DONE = {
  auto:
    'the project as written satisfies the request end to end, using whatever ' +
    'stack the planner chose, and its own entry point runs or serves cleanly',
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
  auto: null,
  nextjs: 'components/Header.tsx',
  vite: 'src/app.ts',
  static: 'script.js',
  node: 'lib/store.js',
  python: 'game.py',
};

/* -------------------------------------------------------------- auto mode */

/**
 * Anything that has to be LOOKED at rather than run in a terminal. Used only
 * as the tie-breaker after every explicit stack signal has missed.
 */
const VISUAL_ASK =
  /\b(game|arcade|platformer|racing|racer|puzzle|clone|animation|animate[ds]?|canvas|webgl|three\.?js|3d|svg|ui|interface|page|webpage|website|web ?app|site|landing|portfolio|dashboard|chart|graph|visuali[sz]\w*|simulator|editor|drawing|paint|gallery|slider|carousel|clock|timer|calculator|todo|quiz|player|map|form)\b/i;

/**
 * Guess a concrete MODES key from the raw request text, for when the user
 * leaves the mode on Auto.
 *
 * A live run answered "a next js app" with index.html + package.json and the
 * auditor rightly rejected it, so the stack signals are checked before the
 * visual/terminal tie-break. "next js" is written with a space at least as
 * often as "next.js", hence the loose separator.
 */
function inferMode(requestText) {
  const t = String(requestText || '');
  if (/next[\s._-]?js\b|app router/i.test(t)) return 'nextjs';
  if (/\bvite\b|\breact\s+(app|spa|project|site)\b/i.test(t)) return 'vite';
  if (/\bpython\b|\bflask\b|\bdjango\b|\bpygame\b|\.py\b/i.test(t)) return 'python';
  if (/\bcli\b|node script|command[- ]line|\bterminal\b/i.test(t)) return 'node';
  if (/\bstatic\b|landing page|single html|one file|single file/i.test(t)) return 'static';
  // No further guessing. Everything above is an explicit signal from the
  // user; beyond that, staying in Auto lets the planner pick the stack rather
  // than having this regex quietly decide the project is a static page.
  return 'auto';
}

/* ---------------------------------------------------------- role prompts */

/** The four role prompts (planner/builder/reviewer/auditor) for a mode. */
function systems(modeKey) {
  const mode = MODES[modeKey] || MODES.auto;
  const conv = CONVENTIONS[mode.key];
  const done = DEFINITION_OF_DONE[mode.key];
  const example = EXAMPLE_PATH[mode.key];
  // Auto has no example on purpose: naming one biases every project toward it.
  const egPath = example ? ` (e.g. ${example})` : '';

  const scaffoldRule = mode.scaffold
    ? 'The scaffold already exists on disk and appears in the EXISTING FILES ' +
      'list - name a scaffold file only to REPLACE its contents, and never ' +
      're-emit package.json, lockfiles or config files unless the request ' +
      'genuinely changes them.'
    : 'There is no scaffold - your first path is the entry point of whatever ' +
      'stack this project needs.';

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
2. To a REQUEST or a WRITTEN SO FAR block, answer with exactly one relative file path${egPath} - the single most useful file to write next - or the single word DONE when nothing more is needed. The whole answer is that one token: no "Next file:", no bullet, no period, no quotes, no code fence.
3. Place files using the EXISTING FILES list: extend the structure that is already there and keep every import resolvable. Naming a file that already exists means its contents get REPLACED, so only name one when you mean to rewrite it.
4. ${scaffoldRule}
5. To a REVIEW block, answer with EXACTLY ONE WORD: PRINT if the content is a valid, complete file for that path, otherwise RETRY.
6. Never output anything except one path, DONE, PRINT or RETRY.`;

  const builder = `You are the BUILDER in a four-agent loop that writes a real project into a workspace folder.
${conv}
Rules you must never break:
1. You get a PATH, the REQUEST and the EXISTING FILES list. Answer with the complete contents of that ONE file inside ONE single fenced code block: \`\`\` on its own line, the whole file, \`\`\` on its own line.
2. Nothing outside that block. No greeting, no explanation, no headings, no "Here is", no notes after it. The block is the entire message.
3. Never split the file across two or more code blocks - one file, one block, even when it is long. Never reopen a fence to continue.
4. The file must be complete top to bottom: "...", "rest of the code unchanged", "add more here" and TODO stubs for core behavior are all forbidden. If it is long, write it out in full anyway.
5. Every import and reference must resolve: import only from the platform itself, from files on the EXISTING FILES list, or from the file being written. Never import a package or file that does not exist.
6. ${qualityRule}
7. Match the language to the file extension and keep the file ready to drop straight onto disk.`;

  const reviewer = `You are the REVIEWER in a four-agent loop building a real project.
${conv}
Rules you must never break:
1. You get a PATH and its proposed CONTENT. Judge that one file only: is it complete and correct for this path in this kind of project?
2. Long files arrive shortened: a middle section is replaced by a marker reading "... N characters elided ...". That marker is OUR doing, never the author's - judge the head and tail you can see and treat the middle as fine.
3. RETRY when the file itself is cut off mid-token, is abbreviated by its author ("rest unchanged", "// ...", TODO stubs for core behavior), echoes the prompt back, is the wrong language for the extension, or imports files or packages that cannot exist here. PRINT when a competent teammate would commit it as-is.
4. Your ENTIRE reply is one word: PRINT or RETRY. No tools, no rewriting, no reasons, no punctuation, no code fence. Anything longer is a failure.`;

  const auditor = `You are the AUDITOR in a four-agent loop building a real project.
Definition of done: ${done}.
Rules you must never break:
1. You get the project REQUEST and the FILES WRITTEN list. Compare them against the request and nothing else.
2. If something essential is missing, reply with ONE short line naming the single most important missing piece (e.g. "index.html links style.css but it was never written"). One line, under 20 words, no list, no preamble, no markdown.
3. If the files already satisfy the request, your entire reply is the single word DONE. Do not invent extras - no bonus pages, no tests, no polish beyond the request. A small working app beats a long file list.
4. No tools, no files, no code. One line maximum, always.`;

  return { planner, builder, reviewer, auditor };
}

/* -------------------------------------------------------- payload budget */

/**
 * Shrink a file body to head + tail so a prompt never carries the whole file.
 *
 * Typing tens of thousands of characters into a ProseMirror composer takes
 * long enough that the tab looks hung and the round is abandoned. The head
 * carries imports/structure and the tail shows whether the file actually
 * finishes, which is all a one-word verdict needs.
 */
function condense(body, max = 4000) {
  const t = String(body || '');
  if (!(max > 0)) return '';
  if (t.length <= max) return t;
  const head = Math.max(1, Math.round(max * 0.625)); // ~2500 of the default 4000
  const tail = Math.max(0, max - head); // ~1500
  const elided = t.length - head - tail;
  return (
    t.slice(0, head) +
    `\n\n... ${elided} characters elided ...\n\n` +
    (tail ? t.slice(t.length - tail) : '')
  );
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
    // The leading phrase is also how rejectReason spots the prompt echoed
    // back as a "file", so it has to stay word for word.
    `Output only the complete contents of ${path} - in ONE fenced code block, ` +
      `nothing before it, nothing after it, never split across blocks.`,
  // condense() here and not at the call site: a 51KB body typed into the
  // composer wedged the tab, prepare/composerText timed out and the run
  // silently skipped review. The reviewer only ever answers one word.
  review: (path, body) => {
    const full = String(body || '');
    // 12000, not 4000: at 4000 a normal 22KB page came back as head+tail around
    // a huge gap, and the reviewer - correctly reading what it was shown - said
    // RETRY to complete files over and over. Still far under the ~50KB paste
    // that wedges a composer, which is the reason any cap exists.
    const shown = condense(full, 12000);
    const elided = shown.length < full.length;
    return (
      `REVIEW\nPATH: ${path}\nCONTENT:\n${shown}\n\n` +
      (elided
        ? `NOTE: the middle of this file was cut out by the harness purely to keep ` +
          `the message short. The file on disk is ${full.length} characters and is ` +
          `COMPLETE. The gap is not truncation - do not answer RETRY because of it. ` +
          `Judge only the code you can actually see.\n\n`
        : '') +
      `Reply with exactly one word: PRINT or RETRY.`
    );
  },
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
    // ChatGPT message chrome that sits inside the transcript text. "Retry" is
    // deliberately absent: it is the reviewer's verdict word.
    .filter(
      (l) => !/^(show (more|less)|copy( code)?|edit|regenerate|share|read aloud)$/i.test(l.trim())
    )
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
 * Remove fence markers left inside a file body.
 *
 * unfence() only strips a fence wrapping the WHOLE reply. ChatGPT often splits
 * one file across several code blocks, so rebuilt fences end up in the middle
 * of the content - a live run produced an index.html with ``` inside its
 * <style> block, which renders but silently corrupts the CSS after it.
 * Markdown files are left alone: there a fence line is real content.
 */
function stripStrayFences(body, filePath = '') {
  if (/\.(md|markdown|mdx)$/i.test(filePath)) return body;
  return String(body || '')
    .split('\n')
    .filter((l) => !/^\s*```[\w+#.-]*(\s[^`]*)?$/.test(l))
    .join('\n');
}

/* --------------------------------------------------------- body recovery */

/**
 * A markdown fence line: ```lang to open, bare ``` to close. The trailing
 * slack is for the metadata some renderers add, e.g. ```jsx title="App.jsx".
 */
const FENCE_LINE = /^\s*```+\s*([\w+#.-]*)\s*[^`]*$/;

/**
 * Blocks the builder emits AROUND the file rather than as part of it -
 * install commands, sample output, a diff. Dropped only when a real block
 * survives, so a single ```bash file still comes through.
 */
const SIDECAR_LANG = /^(bash|sh|shell|zsh|console|cmd|powershell|ps1|text|plaintext|output|log|diff)$/;

/** The first line that could plausibly BE a file rather than talk about one. */
const FILE_START = [
  /^#/, // shebang, #include, a python comment, a markdown heading
  /^<!doctype/i,
  /^<!--/,
  /^<\?/,
  /^<\/?[a-z][\w:-]*(?:[\s>/]|$)/i,
  /^(?:import|export|const|var|function|class|async|await|def|return|require\(|module\.exports)\b/,
  /^let\s+[\w$]+\s*[=:;]/,
  /^from\s+[\w.]+\s+import\b/,
  /^(?:package|@import|@media|@tailwind|@keyframes|:root|\/\*|\/\/)/,
  /^['"]{3}/, // a python module docstring
  /^['"]use (strict|client)['"]/,
  /^if\s+__name__/,
  /^[{[]/, // JSON, and package.json in particular
  /^[\w$.]+\s*=\s*\S/, // PORT = 8080, module.exports = ...
  /^[.#]?[\w-]+(?:[.#:][\w-]+)*(?:\s*[,>+~]\s*[.#]?[\w-]+)*\s*\{/, // a CSS rule
];

/** Sign-off prose models tack on after the code. */
const CHATTER_LINE =
  /^(let me know|this (creates|gives|makes|adds|will|is|does|implements|produces|renders)|would you like|hope (this|that)|feel free|you can (now|then|also)|note that|if you (want|need|'d like)|next steps?\b|to run\b|enjoy\b|that'?s it\b|i (can|could|hope|added|used|kept|left)|the (file|code) above)/i;

/** Collect every fenced block in order, tolerating a fence left unclosed. */
function fencedBlocks(text) {
  const out = [];
  let lines = null;
  let lang = '';
  for (const line of String(text).split('\n')) {
    const fence = line.match(FENCE_LINE);
    if (lines === null) {
      if (fence) {
        lines = [];
        lang = (fence[1] || '').toLowerCase();
      }
      continue; // prose between blocks
    }
    if (fence) {
      out.push({ lang, body: lines.join('\n') });
      lines = null;
      lang = '';
      continue;
    }
    lines.push(line);
  }
  // A stream cut mid-block still has content worth judging - rejectReason
  // decides whether it is salvageable, not this scanner.
  if (lines && lines.length) out.push({ lang, body: lines.join('\n') });
  return out.filter((b) => b.body.trim());
}

/** Cut prose off both ends of an unfenced reply, keeping the code between. */
function salvageUnfenced(text) {
  const lines = String(text).split('\n');
  const start = lines.findIndex((l) => {
    const s = l.trim();
    return s.length > 0 && FILE_START.some((re) => re.test(s));
  });
  if (start < 0) return ''; // prose only - better to retry than to write talk to disk
  const kept = lines.slice(start);
  while (kept.length) {
    const last = kept[kept.length - 1].trim();
    // Trailing code lines end in punctuation; a sign-off ends in a word or a
    // full stop, so only strip when both the phrasing and the shape say prose.
    if (!last || (CHATTER_LINE.test(last) && !/[;,{}()[\]>]$/.test(last))) kept.pop();
    else break;
  }
  return kept.join('\n');
}

/**
 * Derive a file body from whatever the builder actually replied.
 *
 * The prompt asks for one fenced block, but live runs produce all four of:
 * one clean fence, one file split across several fences, fences wrapped in
 * prose, and no fences at all with the code buried in commentary. Returns ''
 * when nothing file-shaped survives so the caller retries instead of writing
 * an apology to disk.
 */
function extractBody(reply, filePath = '') {
  const text = clean(reply);
  if (!text) return '';

  let body;
  const whole = text.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (whole) {
    // One fence around everything: inner fences are real content (README.md).
    body = whole[1];
  } else {
    let blocks = fencedBlocks(text);
    if (blocks.length > 1) {
      const real = blocks.filter((b) => !SIDECAR_LANG.test(b.lang));
      if (real.length) blocks = real;
    }
    body = blocks.length
      ? blocks.map((b) => b.body).join('\n')
      : salvageUnfenced(text);
  }

  body = stripStrayFences(body, filePath).replace(/^\n+/, '').replace(/\s+$/, '');
  return body.trim() ? body + '\n' : '';
}

/* --------------------------------------------------------------- vetting */

/**
 * Does the last line stop inside an open string? Scans with string state so an
 * apostrophe inside "it's" cannot be mistaken for an opening quote.
 */
function endsInsideString(line) {
  const s = line.replace(/"""|'''/g, ''); // python docstring delimiters
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') {
      quote = c;
    } else if (c === '/' && s[i + 1] === '/') {
      break; // apostrophes live in comments too
    }
  }
  return quote !== null;
}

/**
 * Reject a "file" that is really our own prompt echoed back, a placeholder, or
 * a reply cut off mid-stream.
 *
 * Deliberately biased towards FALSE NEGATIVES: a wrong rejection burns a whole
 * rebuild round (plan + build + review), a missed one costs a single review
 * round because the reviewer catches it. That is why brace counting is gone -
 * braces inside strings, regexes, template literals and JSX made it fire on
 * perfectly valid files - and why only unmistakable signals remain.
 */
function rejectReason(body) {
  const t = clean(body);
  if (!t) return 'empty';
  if (t.length < 12) return 'too short to be a file';
  if (/Output only the complete contents of/i.test(t)) return 'echoed our prompt';
  if (/^PATH:/im.test(t) && /^REQUEST:/im.test(t)) return 'echoed the prompt header';
  if (/^(REVIEW|REQUEST|WRITTEN SO FAR)$/im.test(t)) return 'echoed a protocol tag';

  // Tags that never close ANYWHERE in the body: an unclosed <script> is not a
  // style choice, the stream stopped. Counting pairs is not worth it - one
  // "</script>" inside a JS string would flip a valid file to rejected.
  if (/<script\b/i.test(t) && !/<\/script\s*>/i.test(t)) return 'truncated: unclosed <script>';
  if (/<style\b/i.test(t) && !/<\/style\s*>/i.test(t)) return 'truncated: unclosed <style>';
  if (/<html\b/i.test(t) && !/<\/html\s*>/i.test(t)) return 'truncated: unclosed <html>';

  const last = (t.split('\n').filter((l) => l.trim()).pop() || '').trim();
  const comment = /^(#|\/\/|\*|<!--|--|;)/.test(last) || /^[`'"]+$/.test(last);
  if (!comment && !/[;,{}()[\]>:]$/.test(last) && endsInsideString(last)) {
    return 'truncated: ends inside a string';
  }
  // Nothing valid ends on an opening bracket; the size gate keeps short
  // fragments that are legitimately a stub out of it.
  if (t.length > 2000 && /[{([]$/.test(last)) return 'truncated: ends on an open construct';

  return null;
}

module.exports = {
  MODES,
  systems,
  TAGS,
  inferMode,
  parsePath,
  parseVerdict,
  parseAudit,
  unfence,
  stripStrayFences,
  extractBody,
  condense,
  clean,
  slug,
  rejectReason,
};

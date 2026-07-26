'use strict';
/*
 * Orchestrator. Drives 4 chat tabs (planner / builder / reviewer / auditor)
 * through one loop that writes a real project into workspace/<project>/, then
 * builds it, runs it, screenshots it and shows the result in the preview view.
 *
 * You touch exactly one control: the request box in the sidebar. Role contracts
 * are installed into each tab automatically, and every message between tabs is
 * relayed by this file - nothing is ever typed into a chat by hand.
 *
 * Everything site-specific (name, URL, auth cookie, login hint) comes off
 * `site`, so this file never names the chat product it is driving.
 */

const { protocol, fs, session, tabs, tool, term, shell, preloadPath, partition, site } =
  window.browsersmith || window.buildgpt;

const els = {
  a: document.getElementById('tab-a'),
  b: document.getElementById('tab-b'),
  c: document.getElementById('tab-c'),
  d: document.getElementById('tab-d'),
  preview: document.getElementById('tab-preview'),
  previewUrl: document.getElementById('preview-url'),
  openExternal: document.getElementById('btn-open-external'),
  views: document.getElementById('views'),
  viewAgents: document.getElementById('btn-view-agents'),
  viewPreview: document.getElementById('btn-view-preview'),
  run: document.getElementById('btn-run'),
  stop: document.getElementById('btn-stop'),
  prompt: document.getElementById('prompt'),
  project: document.getElementById('project'),
  mode: document.getElementById('mode'),
  selftest: document.getElementById('btn-selftest'),
  autopilot: document.getElementById('btn-autopilot'),
  modelAll: document.getElementById('model-all'),
  log: document.getElementById('log'),
  terminal: document.getElementById('terminal'),
  termInput: document.getElementById('term-input'),
  files: document.getElementById('files'),
  status: document.getElementById('status'),
  session: document.getElementById('session'),
  forget: document.getElementById('btn-forget'),
};

const TAGS_ALL = ['a', 'b', 'c', 'd'];
const wvOf = (tag) => els[tag];

// Roles are fixed: four tabs, always.
const ROLES = { planner: 'a', builder: 'b', reviewer: 'c', auditor: 'd' };
const QA = ROLES.auditor;

// No knobs for these any more - sane constants.
const RETRIES = 4; // per-file build attempts, before the adaptive budget trims them
const FILE_BACKSTOP = 200; // distinct files one run may write
// Rounds and files are different budgets. The planner loop used to be bounded
// by FILE_BACKSTOP, which made the file cap unreachable - a round that rewrites
// an existing path never grows `written` - so nothing at all bounded the number
// of rounds, the wall clock, or the number of messages sent to the chat tabs.
const ROUND_BACKSTOP = 400;
const RUN_BUDGET_MS = 90 * 60 * 1000;
const MESSAGE_BUDGET = 800;
/** The planner may replace a file it already wrote, but not forever. */
const MAX_WRITES_PER_PATH = 3;

// The preview webview gets NO preload/partition - only the agent tabs do.
for (const tag of TAGS_ALL) {
  wvOf(tag).setAttribute('preload', preloadPath);
  wvOf(tag).setAttribute('partition', partition);
}

/** Tabs with a command in flight - a Stop has to know which ones it interrupted. */
const busyTags = new Set();

function markBusy(tag, on, what = '') {
  if (on) busyTags.add(tag);
  else busyTags.delete(tag);
  const el = document.querySelector(`.tab[data-tab="${tag}"]`);
  if (!el) return;
  el.classList.toggle('busy', on);
  // What this tab is doing right now. With four webviews on screen a hard
  // reset otherwise looks exactly like a crash.
  if (on && what) el.dataset.act = what;
  else delete el.dataset.act;
  el.title = on && what ? `${tag.toUpperCase()}: ${what}` : '';
}

let running = false;
let abort = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Everything a run knows about itself.
 *
 * The status pill, the final summary and .browsersmith/run.json all read from
 * here, so they cannot disagree about what actually happened - the pill used to
 * say "done" both for a run that wrote nothing and for a run the user stopped.
 */
const run = {
  active: false,
  startedAt: 0,
  phase: 'idle',
  project: '',
  request: '',
  modeKey: '',
  rounds: 0,
  messages: 0,
  written: [],
  unreviewed: [], // reached disk without a reviewer PRINT
  failedFiles: [], // the builder never produced a usable version
  note: null,
  outcome: 'idle',
  internalError: null,
};

function resetRun(project, request, modeKey) {
  Object.assign(run, {
    active: true,
    startedAt: Date.now(),
    phase: 'starting',
    project,
    request,
    modeKey,
    rounds: 0,
    messages: 0,
    written: [],
    unreviewed: [],
    failedFiles: [],
    note: null,
    outcome: 'running',
    internalError: null,
  });
  renderStatus(); // the clock starts now, not at the first status() call
}

const mmss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** Why a run must wrap up now, or null while it still has room. */
function budgetExceeded() {
  if (!run.active) return null;
  if (run.messages >= MESSAGE_BUDGET) return `message budget (${MESSAGE_BUDGET} sent) reached`;
  if (run.rounds >= ROUND_BACKSTOP) return `round cap (${ROUND_BACKSTOP}) reached`;
  if (Date.now() - run.startedAt >= RUN_BUDGET_MS) {
    return `time budget (${Math.round(RUN_BUDGET_MS / 60000)} min) reached`;
  }
  return null;
}

/* ---------------------------------------------------------------- logging */

function log(msg, cls = '') {
  const line = document.createElement('div');
  const t = new Date().toLocaleTimeString();
  line.innerHTML = `<span class="t">${t}</span> <span class="${cls}"></span>`;
  line.lastChild.textContent = msg;
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
}

/**
 * A log line with the evidence folded away behind it.
 *
 * The only trace of a write used to be "wrote workspace/x (N bytes)": prose
 * written into a file body, or a stray fence spliced in by a patch, was
 * invisible. Both are obvious at a glance here, and cost one click.
 */
function logDetail(summary, body, cls = '') {
  const wrap = document.createElement('details');
  const head = document.createElement('summary');
  const t = new Date().toLocaleTimeString();
  head.innerHTML = `<span class="t">${t}</span> <span class="${cls}"></span>`;
  head.lastChild.textContent = summary;
  const pre = document.createElement('pre');
  pre.textContent = String(body ?? '');
  Object.assign(pre.style, {
    margin: '2px 0 6px 0',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    maxHeight: '220px',
    overflow: 'auto',
    opacity: '0.85',
  });
  wrap.append(head, pre);
  els.log.appendChild(wrap);
  els.log.scrollTop = els.log.scrollHeight;
}

/** The head of a file body, for the write receipt. */
function preview30(text) {
  const lines = String(text || '').split('\n');
  const head = lines.slice(0, 30).join('\n');
  return lines.length > 30 ? `${head}\n… ${lines.length - 30} more line(s)` : head;
}

/** States that are an END, not a step: no spinner, no elapsed clock. */
const TERMINAL_STATES = ['idle', 'done', 'failed', 'stopped', 'partial'];

function renderStatus() {
  const parts = [run.phase];
  if (run.active) {
    parts.push(mmss(Date.now() - run.startedAt));
    parts.push(`${run.written.length} file${run.written.length === 1 ? '' : 's'}`);
    parts.push(`${run.messages} msg`);
  }
  els.status.textContent = parts.join(' · ');
  // The header dot animates while something is actually happening.
  els.status.classList.toggle('working', !TERMINAL_STATES.includes(run.phase));
}

function status(s) {
  run.phase = s;
  renderStatus();
}

// A run lasts minutes; a frozen string is indistinguishable from a hang.
setInterval(() => {
  if (run.active) renderStatus();
}, 1000);

/* --------------------------------------------------------------- terminal */

function termLine(text) {
  const chunk = String(text ?? '').replace(/\r/g, '');
  for (const raw of chunk.split('\n')) {
    const lineText = raw.replace(/\s+$/, '');
    if (!lineText) continue;
    const line = document.createElement('div');
    line.textContent = lineText;
    els.terminal.appendChild(line);
  }
  while (els.terminal.childElementCount > 800) els.terminal.firstChild.remove();
  els.terminal.scrollTop = els.terminal.scrollHeight;
}

// Everything the toolchain prints, and everything the user-typed terminal
// prints, lands in the same pane.
tool.onOutput(({ cmd, text }) => termLine(`[${cmd}] ${String(text ?? '').replace(/\s+$/, '')}`));
term.onOutput(({ text }) => termLine(text));

/** The project the user-typed terminal runs in: the sidebar slug, or the root. */
const currentProjectSlug = () =>
  els.project.value.trim() ? protocol.slug(els.project.value) : '';

els.termInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const cmd = els.termInput.value.trim();
  if (!cmd) return;
  termLine('$ ' + cmd);
  els.termInput.value = '';
  term.exec(currentProjectSlug(), cmd).catch((err) => termLine(String(err.message || err)));
});

/* ------------------------------------------------------------ view switch */

function setView(name) {
  els.views.dataset.view = name;
  els.viewAgents.classList.toggle('active', name === 'agents');
  els.viewPreview.classList.toggle('active', name === 'preview');
}
els.viewAgents.addEventListener('click', () => setView('agents'));
els.viewPreview.addEventListener('click', () => setView('preview'));

function showPreview(url) {
  els.preview.src = url;
  els.previewUrl.textContent = url;
  setView('preview');
}

els.openExternal.addEventListener('click', () => {
  const url = els.previewUrl.textContent.trim();
  if (!/^https?:\/\//i.test(url)) {
    log('external open only works for http(s) preview URLs', 'err');
    return;
  }
  shell.open(url).catch((e) => log(`open failed: ${e.message}`, 'err'));
});

/* ------------------------------------------------------------------- mode */

function currentMode() {
  const key = els.mode.value || 'nextjs';
  return protocol.MODES[key] || protocol.MODES.auto;
}

/* ------------------------------------------------------- webview bridging */

let seq = 0;
const pending = new Map();

function bind(wvArg, tag) {
  const wv = wvArg;
  wv.addEventListener('ipc-message', (e) => {
    if (e.channel === 'drive:done') {
      const { id, result, error } = e.args[0];
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      error ? p.reject(new Error(error)) : p.resolve(result);
    } else if (e.channel === 'picked') {
      log(`${tag}: picked ${e.args[0].which} -> ${e.args[0].selector}`, 'ok');
    }
  });
  wv.addEventListener('did-fail-load', (e) => {
    if (e.errorCode !== -3) log(`${tag} load failed: ${e.errorDescription}`, 'err');
  });
}
for (const tag of TAGS_ALL) bind(wvOf(tag), tag.toUpperCase());

/**
 * Reject everything in flight.
 *
 * Stop used to be a flag polled at loop boundaries, and awaitReply holds for up
 * to 630s - so Stop could take ten minutes to do anything visible and the app
 * looked hung. Rejecting the pending entries unwinds the loop at once; a late
 * `drive:done` for a cancelled id finds no entry and is ignored.
 */
function cancelPending(reason = 'stopped') {
  const waiting = [...pending.values()];
  pending.clear();
  for (const p of waiting) p.reject(new Error(reason));
  return waiting.length;
}

function drive(wv, cmd, args = {}, timeoutMs = 200000) {
  // Once a run is cancelling, a new tab command must not queue up behind the
  // one being abandoned.
  if (abort) return Promise.reject(new Error('stopped'));
  const id = ++seq;
  // Only one webview holds keyboard focus at a time, and a contenteditable
  // ignores synthetic input when its webContents is unfocused. Focus the
  // target tab before every command that touches the composer.
  // Focus goes through the main process: renderer-side webview.focus() is a
  // no-op while the app window is in the background, which made popup menus
  // open in only one tab.
  if (['ask', 'selftest', 'listModels', 'selectModel', 'prepare'].includes(cmd)) {
    try { tabs.focus(wv.getWebContentsId()); } catch { /* not attached yet */ }
  }
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    wv.send('drive', { id, cmd, args });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${cmd} timed out`));
    }, timeoutMs);
  });
}

/** Letters and digits only — survives the composer's markdown auto-formatting. */
const normalizeForCompare = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Send `text` to a tab and return its reply.
 *
 * Typing goes through the main process (webContents.insertText) rather than
 * synthetic DOM events, so it works even when the window is in the background.
 * Sending prefers the site's own send button and falls back to a real Enter key
 * event.
 */
async function ask(wv, text, opts) {
  const id = wv.getWebContentsId();

  await drive(wv, 'prepare', {}, 15000);
  await tabs.type(id, text);

  // Confirm the text actually landed before sending - otherwise we would send
  // an empty prompt and then wait three minutes for a reply that never comes.
  //
  // The composer auto-formats markdown as you type, so its text is not
  // byte-identical to what we sent (backticks, #, - and _ all get rewritten).
  // Compare on letters and digits only.
  const want = normalizeForCompare(text).slice(0, 30);
  const settled = async () => {
    for (let i = 0; i < 25; i++) {
      const seen = await drive(wv, 'composerText', {}, 8000);
      if (normalizeForCompare(seen).includes(want)) return seen;
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  };

  // The composer is briefly non-interactive while the chat is still rendering a
  // previous answer, so one clean retry is worth more than failing the run.
  let landed = await settled();
  if (!landed) {
    await new Promise((r) => setTimeout(r, 3000));
    await drive(wv, 'prepare', {}, 15000);
    await tabs.type(id, text);
    landed = await settled();
  }
  if (!landed) throw new Error('composer never received the prompt');

  const clicked = await drive(wv, 'clickSend', {}, 8000);
  if (!clicked) await tabs.enter(id);
  run.messages++; // the run budget counts what we actually sent

  // awaitReply needs the prompt so it can find and skip our own echo. The
  // inner (preload) timeout must be shorter than the outer drive timeout, or
  // the preload's salvage path loses the race and we get a bare timeout.
  // The preload decides completion from ChatGPT's own generating state, so the
  // outer guard only has to outlast it - never cut a long generation short.
  return drive(wv, 'awaitReply', { opts: { timeoutMs: 600000, ...opts, text } }, 630000);
}

/* ------------------------------------------------------------- the loop */

/**
 * Chat UIs virtualize long transcripts - old messages unmount as new ones
 * stream - which blinds the growth-based reply detector. Live symptom: after
 * one 13KB code reply, every later awaitReply on that tab timed out. So when a
 * tab's transcript passes this size, rotate it to a fresh chat and reseed.
 * Every prompt is self-contained (path + request + existing files), so no
 * conversational memory is lost.
 */
const ROTATE_AT_CHARS = 12000;

async function rotateIfBloated(tag) {
  let chars = 0;
  try {
    chars = await drive(wvOf(tag), 'chars', {}, 8000);
  } catch {
    return;
  }
  if (chars < ROTATE_AT_CHARS) return;
  try {
    if (site.freshChatByNavigation) {
      // Navigating carries the temporary-chat flag; the in-page "New chat"
      // button would open a normal, saved conversation instead.
      await hardResetTab(tag);
    } else {
      try {
        await drive(wvOf(tag), 'newChat', {}, 30000);
      } catch (e) {
        // The chat is now in an unknown mid-transition state; a soft retry
        // types into a dead composer. Reload onto a guaranteed-fresh chat.
        log(`${tag.toUpperCase()}: new-chat click failed (${e.message}) — hard reset`, 'err');
        await hardResetTab(tag);
      }
    }
    seeded.delete(tag);
    log(`${tag.toUpperCase()}: transcript hit ${chars} chars — rotated to a fresh chat`, 'ok');
    if (autopilot && tag === ROLES.planner) {
      watchBaseline = await tabTranscript(els.a).catch(() => null);
    }
    await seedTab(tag);
  } catch (e) {
    // Continuing here left the run talking to a tab that had just been reloaded
    // onto a brand-new chat and therefore held NO role contract: an unseeded
    // builder answers with prose, an unseeded reviewer writes an essay, and the
    // only trace was one "continuing" line scrolled far up the log. Fail the
    // round instead - the caller reseeds and retries.
    seeded.delete(tag);
    throw new Error(`${tag.toUpperCase()}: chat rotation failed (${e.message})`);
  }
}

/** The host the agent tabs must be on for a page to be usable at all. */
const SITE_HOST = (() => {
  try {
    return new URL(site.url).host;
  } catch {
    return '';
  }
})();

function loadFreshChat(tag) {
  const wv = wvOf(tag);
  return new Promise((resolve) => {
    const done = () => {
      wv.removeEventListener('did-stop-loading', done);
      clearTimeout(timer);
      setTimeout(resolve, 3000); // let the composer mount
    };
    const timer = setTimeout(done, 25000);
    wv.addEventListener('did-stop-loading', done);
    wv.src = site.url;
  });
}

/**
 * Point the tab at a brand-new chat and CHECK that it got there.
 *
 * did-stop-loading fires for an offline error page, an expired session and a
 * captcha interstitial exactly as it does for a usable chat. Without the probe
 * the reset "succeeded" and the run failed much later with "composer not found
 * - use Pick Composer", which points the user at the element pickers instead of
 * at the real cause.
 */
async function hardResetTab(tag) {
  seeded.delete(tag);
  await loadFreshChat(tag);
  for (let i = 0; i < 2; i++) {
    const probe = await drive(wvOf(tag), 'probe', {}, 10000).catch(() => null);
    const onSite = !SITE_HOST || String(probe?.url || '').includes(SITE_HOST);
    if (probe && probe.composer && onSite) return;
    if (i === 0) await sleep(4000); // a slow mount is not a broken page
  }
  throw new Error(
    `tab ${tag.toUpperCase()} is not on a usable ${site.name} page — check the login and the network`
  );
}

/** Ask a role's tab, marking it busy so you can see who is working. */
async function askRole(tag, prompt, opts) {
  await rotateIfBloated(tag);
  markBusy(tag, true, run.phase);
  try {
    return await ask(wvOf(tag), prompt, opts);
  } finally {
    markBusy(tag, false);
  }
}

/**
 * Seed each tab with its role contract, automatically.
 *
 * You never type into a chat yourself - the single input in the sidebar is the
 * only thing you touch. Seeding happens once per tab per app session,
 * but the contracts are mode-aware: switching mode reseeds all four tabs.
 */
const seeded = new Set();
let seededMode = null;

const ROLE_OF_TAG = { a: 'planner', b: 'builder', c: 'reviewer', d: 'auditor' };

/** Send one tab its role contract. Used at run start and after chat rotation. */
async function seedTab(tag) {
  if (seeded.has(tag) || !seededMode) return;
  const contract = protocol.systems(seededMode)[ROLE_OF_TAG[tag]];
  status(`seeding ${tag.toUpperCase()}`);
  markBusy(tag, true, 'seeding');
  try {
    try {
      await ask(wvOf(tag), contract + '\n\nReply with exactly: READY');
    } catch (e) {
      if (abort) throw e; // a Stop is not something to retry through
      // One clean retry in a fresh chat: a seed that cannot be read dooms the
      // whole run, and rotation clears every known cause of unreadable replies.
      log(`${tag.toUpperCase()} seed failed (${e.message}) — hard reset and retry`, 'err');
      // A soft new-chat retry types into the same dead composer; go straight
      // to the reliable path: reload the tab onto a fresh chat.
      await hardResetTab(tag);
      await ask(wvOf(tag), contract + '\n\nReply with exactly: READY');
    }
    seeded.add(tag);
    log(`${tag.toUpperCase()} seeded (${seededMode})`, 'ok');
  } finally {
    markBusy(tag, false);
  }
}

async function ensureSeeded(modeKey) {
  if (seededMode !== modeKey) {
    seeded.clear();
    seededMode = modeKey;
  }
  // NOT named `pending`: that shadowed the module-level in-flight registry
  // every drive() call depends on.
  const unseeded = TAGS_ALL.filter((t) => !seeded.has(t));
  if (!unseeded.length) return;

  // The four seeds are independent, and typing goes to a specific webContents
  // rather than "whatever has focus", so they can run at once. Serially this
  // was 28s of a 113s run - a quarter of the wall clock spent waiting on four
  // things that never needed to wait for each other.
  status(`seeding ${unseeded.length} tabs`);
  // Staggered, not simultaneous: four identical requests landing in the same
  // millisecond looks like a burst and has drawn ERR_ADDRESS_UNREACHABLE.
  // 400ms apart keeps nearly all the parallel win without the thundering herd.
  const results = await Promise.allSettled(
    unseeded.map(
      (tag, i) =>
        new Promise((resolve, reject) =>
          setTimeout(() => seedTab(tag).then(resolve, reject), i * 400)
        )
    )
  );

  // Concurrency is the one thing that could plausibly upset the composer, so
  // anything that failed gets a serial second chance before the run gives up.
  const failed = unseeded.filter((_, i) => results[i].status === 'rejected');
  for (const tag of failed) {
    log(`${tag.toUpperCase()}: parallel seed failed — retrying on its own`, 'err');
    await seedTab(tag);
  }
}

/** Build noise that must never reach a prompt or the files list. */
const NOISE_RE = /(^|\/)(node_modules|\.next|\.preview|\.browsersmith)(\/|$)/;

/** Where a run records itself, for the summary and for Resume. */
const RUN_FILE = '.browsersmith/run.json';

/**
 * Checkpoint the run after every write.
 *
 * Any single hard failure used to discard the whole run; with this on disk,
 * Resume continues from the last file instead of restarting the planner from
 * zero. Never fail a run over its own bookkeeping.
 */
async function saveRunFile(project, preview = null) {
  try {
    const record = {
      version: 1,
      project,
      request: run.request,
      mode: run.modeKey,
      startedAt: new Date(run.startedAt).toISOString(),
      updatedAt: new Date().toISOString(),
      elapsedMs: Date.now() - run.startedAt,
      rounds: run.rounds,
      messages: run.messages,
      written: run.written,
      unreviewed: [...new Set(run.unreviewed)],
      failed: [...new Set(run.failedFiles)],
      note: run.note,
      outcome: run.outcome,
      // safeLocation, not the raw URL: a file:// preview path carries the OS
      // account name, and this file is inside a project people will publish.
      preview: preview
        ? {
            ok: !!preview.ok,
            skipped: !!preview.skipped,
            stage: preview.stage || null,
            where: preview.url ? safeLocation(preview.url, project) : null,
          }
        : null,
    };
    await fs.write(`${project}/${RUN_FILE}`, JSON.stringify(record, null, 2) + '\n');
  } catch {
    /* history is a nicety; a locked or full disk must not end the build */
  }
}

async function loadRunFile(project) {
  try {
    return JSON.parse(await fs.read(`${project}/${RUN_FILE}`));
  } catch {
    return null;
  }
}

/** Project-relative files on disk, minus install/build noise. */
async function existingFiles(project) {
  const prefix = project + '/';
  return (await fs.list())
    .filter((f) => f.startsWith(prefix))
    .map((f) => f.slice(prefix.length))
    .filter((f) => !NOISE_RE.test(f));
}

/**
 * The reviewer's verdict, preferring the word it actually committed to.
 *
 * protocol.parseVerdict returns the FIRST of PRINT/RETRY found anywhere, so
 * "I would not RETRY this; PRINT" threw away an approved file and burned a full
 * rebuild round. An exact one-word reply wins; otherwise the LAST verdict word
 * is the one the reviewer settled on.
 */
function readVerdict(reply) {
  const t = protocol.clean(reply).trim();
  const exact = t.match(/^\W*(PRINT|RETRY)\W*$/i);
  if (exact) return exact[1].toUpperCase();
  const all = [...t.toUpperCase().matchAll(/\b(PRINT|RETRY)\b/g)];
  if (all.length) return all[all.length - 1][1];
  return protocol.parseVerdict(reply);
}

/**
 * How many build attempts this file gets.
 *
 * A fixed 5 attempts per file means a run near its ceiling spends what is left
 * perfecting one file instead of finishing the project.
 */
function attemptsFor() {
  if (!run.active) return RETRIES + 1;
  const left = Math.min(
    1 - (Date.now() - run.startedAt) / RUN_BUDGET_MS,
    1 - run.messages / MESSAGE_BUDGET
  );
  if (left <= 0.1) return 1;
  if (left <= 0.3) return 2;
  return RETRIES + 1;
}

/** Build one file: builder writes it, reviewer judges it, we save it. */
async function buildFile(project, filePath, request, mode) {
  // The last body that survived vetting but never got a PRINT. Losing nine
  // finished files because the tenth reviewer round was flaky is worse than
  // writing it with a loud UNREVIEWED line.
  let salvage = null;

  for (let attempt = 0; attempt < attemptsFor(); attempt++) {
    if (abort) throw new Error('stopped');

    status(`B: building ${filePath} (try ${attempt + 1})`);

    // A slow or stuck reply must cost this attempt, not the whole project -
    // one README timing out used to abandon an otherwise healthy build.
    let buildReply;
    try {
      const existing = await existingFiles(project);
      buildReply = await askRole(
        ROLES.builder,
        protocol.TAGS.build(filePath, request, mode, existing)
      );
    } catch (e) {
      if (abort) throw e;
      log(`build attempt ${attempt + 1} failed: ${e.message}`, 'err');
      // A blind chat stays blind: a prompt that vanished once will vanish
      // again (seen live at 5.5KB - NOT a transcript-size problem). Give the
      // next attempt a brand-new chat instead of the same broken one. A failed
      // rotation lands here too: that tab has no contract any more.
      if (
        /no response detected|timed out|composer never received|rotation failed/i.test(
          String(e.message || e)
        )
      ) {
        log('B: reply detection broke — moving to a fresh chat', 'err');
        await hardResetTab(ROLES.builder).catch(() => {});
        await seedTab(ROLES.builder).catch(() => {});
      }
      continue;
    }
    // unfence removes a fence wrapping the whole reply; ChatGPT also splits one
    // file across several code blocks, leaving ``` lines mid-file.
    // extractBody handles every shape ChatGPT actually returns: one fence,
    // several fences that are really one file, fences with prose around them,
    // and no fences at all. unfence alone only stripped a fence wrapping the
    // WHOLE reply, so "Here is the file:" was being written into the file.
    const candidate = protocol.extractBody(buildReply, filePath);
    const bad = protocol.rejectReason(candidate);
    if (bad) {
      log(`B output rejected (${bad}), retrying`, 'err');
      continue;
    }
    log(`B returned ${candidate.length} chars`, 'b');
    salvage = candidate;

    status('C: reviewing');
    let verdictReply;
    let reviewed = true;
    try {
      verdictReply = await askRole(ROLES.reviewer, protocol.TAGS.review(filePath, candidate));
    } catch (e) {
      // A Stop is not a flaky reviewer: it must not turn into a write.
      if (abort) throw e;
      // The file itself looks fine; losing it to a flaky reviewer would be worse
      // than accepting it, so a reviewer timeout counts as approval - but the
      // user is told, in as many words, that nothing reviewed this file.
      log(`reviewer unavailable (${e.message}) — accepting the file`, 'err');
      verdictReply = 'PRINT';
      reviewed = false;
    }
    const verdict = readVerdict(verdictReply);
    log(`verdict = ${verdict ?? '(unparseable) ' + verdictReply.slice(0, 80)}`, 'a');

    if (verdict === 'PRINT') {
      return writeReviewed(project, filePath, candidate, reviewed ? 'reviewed PRINT' : null);
    }
    log('RETRY -> rebuilding', 'err');
  }

  if (salvage) {
    // Every attempt is spent and the body is still structurally sound: write it
    // rather than throwing the file (and, historically, the whole run) away.
    return writeReviewed(project, filePath, salvage, null, 'the reviewer never returned PRINT');
  }
  return null;
}

/**
 * Write a file body, and say plainly whether anything reviewed it.
 *
 * Nothing may reach disk without either a reviewer verdict or an UNREVIEWED
 * line the user can actually see.
 */
async function writeReviewed(project, filePath, body, verdictNote, why = '') {
  // Every project gets its own folder under workspace/.
  const res = await fs.write(`${project}/${filePath}`, body);
  if (!verdictNote) {
    run.unreviewed.push(filePath);
    log(`UNREVIEWED: wrote workspace/${res.rel} — ${why || 'no reviewer verdict'}`, 'err');
  }
  logDetail(
    `wrote workspace/${res.rel} (${res.bytes} bytes) · ${verdictNote || 'UNREVIEWED'}`,
    preview30(body),
    verdictNote ? 'ok' : 'err'
  );
  await refreshFiles();
  return res;
}

/** Phrases the planner ends on when it means DONE but forgets the contract. */
const DONE_PROSE =
  /\b(done|complete|completed|finished|nothing (?:more|else|further)|no (?:more|further|additional) files?)\b/i;

/**
 * Read the planner's answer as a path, DONE, or nothing.
 *
 * "The project is complete." is the planner AGREEING, not breaking contract;
 * treating it as a broken contract cost a nudge round and then killed the run.
 */
function readPath(reply) {
  const direct = protocol.parsePath(reply);
  if (direct) return direct;
  const t = protocol.clean(reply).trim();
  if (!t || t.length > 200) return null;
  // Only when no line in it could be a path - "app/page.tsx is done" is a path.
  const hasPath = t.split('\n').some((l) => protocol.parsePath(l));
  return !hasPath && DONE_PROSE.test(t) ? 'DONE' : null;
}

/**
 * The path hiding inside a prose answer, as a last resort.
 *
 * protocol.parsePath requires the WHOLE line to be the path, so "src/app.ts is
 * the next file" reads as null - and that one sentence used to end the run.
 * Only used after the explicit nudge has already failed: it guesses, and a
 * guess is only better than giving up.
 */
function salvagePath(reply) {
  const t = protocol.clean(reply);
  if (!t || t.length > 400) return null;
  for (const raw of t.split(/[\s,;:()"'`]+/)) {
    const token = raw.replace(/[.]+$/, '');
    if (!/^[\w.][\w./-]*\.[A-Za-z0-9]+$/.test(token)) continue;
    if (token.split('/').includes('..')) continue;
    return token;
  }
  return null;
}

/**
 * Ask the planner something that must come back as a path.
 *
 * The model sometimes drops into an agent/tool mode and answers with tool
 * chatter instead of obeying the one-line contract. Re-asking with an explicit
 * nudge recovers it, which is cheaper than failing the whole run. Returns
 * { path, raw } - `path` is a relative path, the string 'DONE', or null.
 */
async function askForPath(prompt) {
  const tag = ROLES.planner;
  let reply;
  try {
    reply = await askRole(tag, prompt);
  } catch (e) {
    if (abort) throw e;
    // The planner going quiet takes the entire run with it, so it gets the
    // same fresh-chat recovery the builder already has.
    log(`planner unavailable (${e.message}) — fresh chat, one retry`, 'err');
    await hardResetTab(tag);
    await seedTab(tag);
    reply = await askRole(tag, prompt);
  }
  log(`${tag.toUpperCase()} raw: ${reply.slice(0, 160)}`, 'a');
  let path = readPath(reply);
  if (path) return { path, raw: reply };

  log('planner broke contract — re-asking with a nudge', 'err');
  reply = await askRole(
    tag,
    'Do not use any tools and do not write any files yourself. ' +
      'Reply with ONE line only: the relative file path, or the word DONE. Nothing else.'
  );
  log(`${tag.toUpperCase()} retry: ${reply.slice(0, 160)}`, 'a');
  path = readPath(reply);
  if (!path) {
    const guess = salvagePath(reply);
    if (guess) {
      log(`planner still broke contract — taking "${guess}" out of its answer`, 'err');
      return { path: guess, raw: reply };
    }
  }
  return { path, raw: reply };
}

/** Dev servers this session started, by project slug. */
const servers = new Set();

/** Tabs a Stop interrupted mid-reply; the next run reloads them first. */
const needsReset = new Set();

/**
 * Stop every dev server we started, except one worth keeping.
 *
 * runProject only ever stopped the server for the project it was about to
 * build, and Stop stopped nothing at all, so an aborted run - and every
 * autopilot request, which derives a new slug each time - left a server holding
 * a port until the window closed.
 */
async function stopServers(keep = null) {
  for (const project of [...servers]) {
    if (project === keep) continue;
    servers.delete(project);
    try {
      const stopped = await tool.stop(project);
      if (stopped) log(`dev server for ${project} stopped`, 'ok');
    } catch {
      /* it was not running */
    }
  }
}

/**
 * Run the plan/build/review/audit loop, then verify what it produced.
 *
 * `opts.resume` carries a previous run's `written` + `note` so a project that
 * died on file 10 continues instead of restarting the planner from zero.
 */
async function runProject(request, opts = {}) {
  const mode = currentMode();
  const project = protocol.slug(els.project.value || request);
  els.project.value = project;
  run.project = project;
  run.modeKey = mode.key;
  log(`project → workspace/${project}/  (mode: ${mode.label || mode.key})`, 'ok');

  // Every dev server this session started, not just this project's: autopilot
  // derives a NEW slug from every request, so N requests left N servers holding
  // N ports until the window closed.
  await stopServers();
  // A fresh run kills the old server for this project even if a previous
  // session started it; the toolchain will start a new one after the build.
  try {
    const stopped = await tool.stop(project);
    if (stopped) log('previous dev server stopped', 'ok');
  } catch {
    /* nothing was running */
  }

  // A tab left mid-generation by a Stop cannot be typed into; the next run
  // reloads it onto a fresh chat instead of failing five attempts deep.
  if (needsReset.size) {
    log(`recovering ${needsReset.size} tab(s) left mid-reply by the last stop`, 'err');
    for (const tag of [...needsReset]) {
      try {
        await hardResetTab(tag);
        needsReset.delete(tag);
      } catch (e) {
        log(`${tag.toUpperCase()}: ${e.message}`, 'err');
      }
    }
  }

  // Framework modes start from a real scaffold so the agents only write the
  // files that matter. A resumed run already has one.
  if (mode.scaffold && !opts.resume) {
    status(`scaffolding ${mode.key}`);
    log(`scaffolding ${mode.key} project…`);
    try {
      const r = await tool.scaffold(project, mode.key);
      const created = Array.isArray(r) ? r : (r && (r.created || r.files)) || [];
      if (created.length) {
        log(`scaffold created ${created.length} file(s)`, 'ok');
        for (const f of created.slice(0, 20)) log(`  ${f}`);
        if (created.length > 20) log(`  (+${created.length - 20} more)`);
      } else {
        log('scaffold done', 'ok');
      }
    } catch (e) {
      log(`scaffold failed: ${e.message} — continuing without it`, 'err');
    }
    await refreshFiles();
  }

  // Tabs may still hold a long transcript from a previous run (or a previous
  // app session) - and a bloated transcript blinds reply detection. Rotate
  // BEFORE seeding, because seeding itself needs a readable reply.
  for (const tag of TAGS_ALL) {
    if (abort) throw new Error('stopped');
    // Rotation now throws rather than silently continuing on an unseeded tab;
    // here that is not fatal, because ensureSeeded is the very next thing.
    try {
      await rotateIfBloated(tag);
    } catch (e) {
      if (abort) throw e;
      log(`${e.message} — reseeding it`, 'err');
    }
  }

  // Contracts are installed automatically; nothing is ever typed into a chat
  // by hand. Mode-aware: switching mode reseeds.
  await ensureSeeded(mode.key);

  const written = run.written;
  // The planner is allowed to re-name a file to REPLACE it (the auditor asks
  // for exactly that), so repeats are capped rather than treated as done.
  const writeCounts = new Map();
  let note = null; // the auditor's last "what's still missing"

  if (opts.resume) {
    for (const f of opts.resume.written || []) if (!written.includes(f)) written.push(f);
    note = opts.resume.note || null;
    log(`resuming: ${written.length} file(s) already written${note ? ` — auditor said: ${note}` : ''}`, 'ok');
  }
  run.note = note;

  let reply;
  if (written.length) {
    status('planner: next file?');
    reply = await askForPath(protocol.TAGS.next(written, note, await existingFiles(project)));
  } else {
    status('planner: asking for path');
    reply = await askForPath(protocol.TAGS.request(request, mode, await existingFiles(project)));
  }

  // The planner refusing to move on is not the same as the project being done.
  let repeatStrikes = 0;

  for (let round = 0; round < ROUND_BACKSTOP; round++) {
    if (abort) throw new Error('stopped');
    run.rounds = round + 1;

    const over = budgetExceeded();
    if (over) {
      log(`${over} — wrapping up with what exists`, 'err');
      break;
    }

    const filePath = reply.path;
    if (filePath === 'DONE') { log('planner says DONE', 'ok'); break; }
    if (!filePath) {
      // Was a throw, which abandoned the whole run: a nine-file project died
      // because the planner answered file ten in prose, and nothing already
      // written was ever installed, run or previewed.
      log(
        `planner did not return a usable path — building stops here: ` +
          `"${protocol.clean(reply.raw).replace(/\n/g, ' ').slice(0, 120)}"`,
        'err'
      );
      break;
    }
    if (written.length >= FILE_BACKSTOP) {
      log(`file backstop (${FILE_BACKSTOP} files) reached — stopping the loop`, 'err');
      break;
    }

    const seen = writeCounts.get(filePath) || 0;
    if (seen >= MAX_WRITES_PER_PATH) {
      // A deliberate rewrite is legitimate - it is exactly what the auditor
      // asks for - so the planner is told to pick something else rather than
      // the project being declared finished behind its back.
      repeatStrikes++;
      if (repeatStrikes > 2) {
        log(`planner will not move past ${filePath} — ending the build here`, 'err');
        break;
      }
      log(`${filePath} has already been written ${seen} times — asking for a different file`, 'err');
      reply = await askForPath(
        `${filePath} has been written ${seen} times already and will not be written again.\n` +
          `Reply with ONE different relative file path that is still needed, or the single word DONE.`
      );
      continue;
    }
    log(`path = ${filePath}${seen ? ' (rewrite)' : ''}`, 'ok');

    const res = await buildFile(project, filePath, request, mode);
    if (!res) {
      // Was a throw. One file the builder cannot get right must not cost every
      // file that is already on disk.
      run.failedFiles.push(filePath);
      log(`no usable ${filePath} after every attempt — leaving it out of the project`, 'err');
      if (run.failedFiles.length > 1) {
        log('two files have now failed to build — finishing with what exists', 'err');
        break;
      }
      status('planner: next file?');
      reply = await askForPath(
        `${filePath} could not be produced and has been skipped.\n` +
          `Reply with ONE different relative file path that is still needed, or the single word DONE.`
      );
      continue;
    }
    writeCounts.set(filePath, seen + 1);
    if (!written.includes(filePath)) written.push(filePath);
    await saveRunFile(project);

    // The auditor looks at the whole project and tells the planner what is
    // still missing - this is the hand-off that keeps the loop going until the
    // work is genuinely complete rather than merely non-empty.
    note = null;
    let auditDone = false;
    status('D: auditing');
    try {
      const auditReply = await askRole(ROLES.auditor, protocol.TAGS.audit(request, written, mode));
      note = protocol.parseAudit(auditReply);
      log(note ? `auditor: ${note}` : 'auditor: DONE', note ? 'a' : 'ok');
      auditDone = !note;
    } catch (e) {
      if (abort) throw e;
      log(`auditor unavailable (${e.message}) — continuing`, 'err');
    }
    run.note = note;
    if (auditDone) break;

    status('planner: next file?');
    reply = await askForPath(protocol.TAGS.next(written, note, await existingFiles(project)));
  }

  // Build, run and look at it. A failure here is not the end of the run - it
  // becomes the next instruction, which is the whole point of the loop.
  let preview = null;
  if (written.length && !abort) {
    preview = await verifyAndFix(project, request, mode, written);

    // Passing or not, if we know where the project is running, show it. The
    // server stays up for the user - the next run (or quitting) stops it.
    // If there is a URL there is something to look at, whatever the mode said.
    // Gating this on mode.previews hid the page a Python or Node server was
    // serving, purely because the mode had been labelled a "run" mode.
    if (preview && preview.url) showPreview(preview.url);
  }

  await saveRunFile(project, preview);
  return { project, written, preview };
}

/** One line that identifies a failure, so a repeat of it is recognisable. */
function signatureOf(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)[0]
    ?.toLowerCase()
    .replace(/\d+/g, '#')
    .slice(0, 120) || 'unknown failure';
}

/** The remedies for a failing project, weakest and cheapest first. */
const FIX_LADDER = ['patch', 'rewrite', 'replan'];

/**
 * Verify the project, and when it fails, fix it - escalating, never looping.
 *
 * The same error coming back means the last remedy did not work, so the next
 * round climbs the ladder instead of repeating it: patch the line the trace
 * names, then rewrite that whole file, then ask the planner which file is
 * really at fault. Three rounds of re-patching the wrong file is how a run used
 * to spend twenty minutes going nowhere.
 */
async function verifyAndFix(project, request, mode, written) {
  const spentOn = new Map(); // failure signature -> remedies already tried
  let preview = null;

  for (let round = 0; round < 4; round++) {
    if (abort) throw new Error('stopped');
    const over = budgetExceeded();
    if (over) {
      log(`${over} — skipping further fix rounds`, 'err');
      break;
    }

    try {
      preview = await verifyProject(project, request, mode);
    } catch (e) {
      // A stopped run must never be reported as a finished one.
      if (abort) throw e;
      log(`verify failed: ${e.message}`, 'err');
      break;
    }
    if (preview.ok || preview.skipped) break;

    const fix = preview.detail || `${preview.stage} failed`;
    const sig = signatureOf(fix);
    const spent = spentOn.get(sig) || 0;
    spentOn.set(sig, spent + 1);
    if (spent >= FIX_LADDER.length) {
      log('the same failure survived patch, rewrite and replan — stopping the fix loop', 'err');
      break;
    }
    log(`fixing (${FIX_LADDER[spent]}): ${fix.split('\n')[0]}`, 'err');

    // The remedies talk to the builder and the planner, and "Verify again" can
    // reach this point with nothing seeded. Free when they already are.
    await ensureSeeded(mode.key);

    // Each rung falls forward when it cannot act at all, so an error with no
    // file location does not waste a round.
    let acted = null;
    if (spent === 0) acted = await tryPatch(project, fix);
    if (!acted && spent <= 1) acted = await rewriteForFix(project, request, mode, fix);
    if (!acted) acted = await replanFix(project, request, mode, fix);
    if (!acted) {
      log('nothing left to try for this failure', 'err');
      break;
    }
    if (!written.includes(acted)) written.push(acted);
    await saveRunFile(project, preview);
  }
  return preview;
}

/** Rewrite the file the error itself names. Null when it names none. */
async function rewriteForFix(project, request, mode, fix) {
  const patch = (window.browsersmith || window.buildgpt).patch;
  const loc = patch && patch.parseErrorLocation(fix);
  if (!loc) return null;
  const file = projectRelative(project, loc.file);
  log(`rewriting ${file} in full`, 'err');
  const res = await buildFile(
    project,
    file,
    `${request}\n\nFIX REQUIRED: ${protocol.condense(scrubPaths(fix), 1200)}`,
    mode
  );
  return res ? file : null;
}

/** Ask the planner which file is really at fault, then rewrite that. */
async function replanFix(project, request, mode, fix) {
  status('planner: fixing');
  const safeFix = protocol.condense(scrubPaths(fix), 1200);
  const { path: fixPath } = await askForPath(
    `The project was built and run. It did not pass.\n` +
      `PROBLEM: ${safeFix}\n\nReply with the ONE file path to rewrite to fix this.`
  );
  if (!fixPath || fixPath === 'DONE') return null;
  const res = await buildFile(project, fixPath, `${request}\n\nFIX REQUIRED: ${safeFix}`, mode);
  return res ? fixPath : null;
}

/**
 * What was verified, and what was not - in plain words.
 *
 * "project done - 0 file(s) ... not verified" followed by a green "done" pill
 * was the single most dishonest thing the app said.
 */
const STAGE_WORDS = {
  install: 'the install/build step',
  serve: 'starting the server',
  run: 'running it',
  screenshot: 'the screenshot',
  preview: 'the check of the screenshot',
};

function verifiedLine(preview) {
  if (!run.written.length) return 'nothing was written, so nothing was verified';
  if (!preview) return 'NOT verified — the project was never installed, run or previewed';
  if (preview.skipped) return 'nothing runnable to verify (no dev script and no entry point found)';
  if (preview.ok) {
    if (preview.stage === 'run') return 'ran it and the auditor judged its output a PASS';
    const how = /^https?:/i.test(preview.url || '') ? 'served it' : 'opened the page from disk';
    return `${how}, screenshotted it, and the auditor judged the result a PASS`;
  }
  const why = (preview.detail || '').split('\n')[0] || 'no detail';
  const stage = STAGE_WORDS[preview.stage] || preview.stage;
  return `NOT verified — ${stage} failed: ${why.slice(0, 160)}`;
}

/**
 * The same conclusion, safe to type into a chat: no error text, no traces.
 * Build output carries absolute paths, and a chat tab must never see one.
 */
function verifiedShort(preview) {
  if (!run.written.length) return 'nothing was written, so nothing was verified';
  if (!preview) return 'the project was not installed, run or previewed';
  if (preview.skipped) return 'there was nothing runnable to verify';
  if (preview.ok) return 'it was run and judged working';
  return `it did not pass at ${STAGE_WORDS[preview.stage] || preview.stage}`;
}

/** The closing report. Every claim here is one this run can actually support. */
function reportRun(preview, outcome) {
  const elapsed = mmss(Date.now() - run.startedAt);
  log(
    `run ${outcome} — ${run.written.length} file(s) in workspace/${run.project}/ in ${elapsed} ` +
      `(${run.rounds} planner round(s), ${run.messages} chat message(s))`,
    outcome === 'done' ? 'ok' : 'err'
  );
  log(`verified: ${verifiedLine(preview)}`, preview && preview.ok ? 'ok' : 'err');
  if (run.unreviewed.length) {
    // A file can be written unreviewed more than once (a patch, then another);
    // the user wants the set, not the tally.
    log(
      `UNREVIEWED — written without a reviewer PRINT: ${[...new Set(run.unreviewed)].join(', ')}`,
      'err'
    );
  }
  if (run.failedFiles.length) {
    log(`never written: ${run.failedFiles.join(', ')}`, 'err');
  }
  if (run.internalError) {
    log(`an internal error happened during this run: ${run.internalError}`, 'err');
  }
}

/* --------------------------------------------------------------- patching */

/**
 * Fix the broken lines instead of rewriting the file.
 *
 * Returns the patched path on success, or null to fall back to a full rewrite.
 * Falling back is the normal, expected outcome whenever the error does not
 * name a location or the builder cannot express the fix as a patch - a wrong
 * patch silently corrupts a file, so anything uncertain declines.
 */
/**
 * The project-relative form of a file a stack trace names.
 *
 * Traces quote absolute paths, and everything up to and including the project
 * folder is ours: without this the read below always failed and every patch
 * silently degraded into a full rewrite.
 */
function projectRelative(project, file) {
  const marker = `${project}/`;
  const at = String(file || '').replace(/\\/g, '/').lastIndexOf(marker);
  return at >= 0 ? file.replace(/\\/g, '/').slice(at + marker.length) : file;
}

async function tryPatch(project, errorText) {
  const patch = (window.browsersmith || window.buildgpt).patch;
  if (!patch) return null;

  const parsed = patch.parseErrorLocation(errorText);
  if (!parsed) return null;
  const loc = { ...parsed, file: projectRelative(project, parsed.file) };

  let source;
  try {
    source = await fs.read(`${project}/${loc.file}`);
  } catch (e) {
    // Silence here meant the run degraded to a full rewrite with no
    // explanation - a locked file and a trace naming somebody else's file
    // looked identical.
    log(`patch skipped: cannot read ${loc.file} (${e.message}) — rewriting instead`, 'err');
    return null;
  }

  log(`patching ${loc.file}:${loc.line} instead of rewriting it`, 'ok');
  status(`${ROLES.builder.toUpperCase()}: patching ${loc.file}`);

  let reply;
  try {
    reply = await askRole(
      ROLES.builder,
      `This file is throwing an error at line ${loc.line}.\n\n` +
        `ERROR:\n${protocol.condense(scrubPaths(errorText), 800)}\n\n` +
        `FILE (${loc.file}), lines around the error:\n${patch.excerpt(source, loc.line)}\n\n` +
        patch.PATCH_FORMAT
    );
  } catch (e) {
    if (abort) throw e; // unwind now rather than falling through to a rewrite
    log(`patch attempt failed (${e.message}) — rewriting instead`, 'err');
    return null;
  }

  if (patch.wantsRewrite(reply)) {
    log('builder says this needs a rewrite, not a patch', 'err');
    return null;
  }

  const patches = patch.parsePatches(reply);
  if (!patches.length) {
    log('no usable patch in the reply — rewriting instead', 'err');
    return null;
  }

  const { text, applied, failed } = patch.applyPatches(source, patches);
  if (!applied.length) {
    log(`patch did not apply (${failed[0]?.reason || 'no match'}) — rewriting instead`, 'err');
    return null;
  }
  if (failed.length) log(`${failed.length} of ${patches.length} hunks did not apply`, 'err');

  // This path never sees the reviewer, so the result is vetted here or not at
  // all: models wrap patches in fences constantly, and a spliced-in ``` or a
  // replacement that truncates the file would go straight to disk.
  const vetted = protocol.stripStrayFences(text, loc.file);
  const bad = protocol.rejectReason(vetted);
  if (bad) {
    log(`patched ${loc.file} did not hold up (${bad}) — rewriting instead`, 'err');
    return null;
  }

  const res = await fs.write(`${project}/${loc.file}`, vetted);
  run.unreviewed.push(loc.file);
  log(
    `UNREVIEWED: patched ${applied.length} hunk(s) into ${loc.file} (${res.bytes} bytes) — ` +
      `a patch is applied without a reviewer verdict`,
    'err'
  );
  logDetail(
    `patch applied to ${loc.file} — ${applied.length} hunk(s)`,
    applied
      .map((p, i) => `--- hunk ${i + 1} · before\n${p.find}\n--- hunk ${i + 1} · after\n${p.replace}`)
      .join('\n\n'),
    'ok'
  );
  await refreshFiles();
  return loc.file;
}

/* ------------------------------------------------------- build & preview */

/** Trim noisy build output down to something a chat message can carry. */
function tailLines(text, n = 25) {
  return String(text || '')
    .split('\n')
    .map((l) => l.replace(/\r/g, '').trimEnd())
    .filter(Boolean)
    .slice(-n)
    .join('\n')
    .slice(-2000);
}

/**
 * Take the written project from "files on disk" to "verified": either serve
 * and screenshot it (browser modes) or execute it and read the output (run
 * modes), then have the QA tab judge the result against the request.
 */
async function verifyProject(project, request, mode) {
  // How to verify comes from what is ON DISK, not from the mode the user
  // picked. A Python backend serving an HTML frontend is both a "run" and a
  // "browser" project; forcing one strategy up front made it unverifiable and
  // told the auditor a definition of done that could not be satisfied.
  let p = null;
  try {
    p = await tool.plan(project);
  } catch (e) {
    log(`plan failed (${e.message}) — falling back to the mode`, 'err');
  }
  if (!p) {
    return mode.previews === 'run'
      ? verifyByRunning(project, request, mode)
      : verifyInBrowser(project, request, mode);
  }

  log(`plan: ${p.kind} — ${p.why}`, 'ok');
  if (p.unavailable) {
    log(`${p.unavailable} is not installed — checking the files, not running them`, 'err');
  }
  return verifyByPlan(project, request, p);
}

/**
 * Run a project according to its plan: install, then either serve-and-look or
 * run-and-read, and for a script that also emits a page, both.
 */
async function verifyByPlan(project, request, p) {
  await tool.stop(project).catch(() => {});

  for (const step of p.steps || []) {
    if (abort) throw new Error('stopped');
    status(`${step.cmd} ${step.args.join(' ')}`);
    log(`${step.cmd} ${step.args.join(' ')}…`);
    let res;
    try {
      res = await tool.run(project, step.cmd, step.args, step.timeoutMs || 300000);
    } catch (e) {
      if (step.optional) { log(`${step.cmd} unavailable (${e.message}) — continuing`, 'err'); continue; }
      return { ok: false, stage: 'install', detail: e.message };
    }
    if (res.code !== 0) {
      const tail = tailLines(res.out, 20);
      if (step.optional) { log(`${step.cmd} failed (non-fatal), continuing`, 'err'); continue; }
      return { ok: false, stage: 'install', detail: `${step.cmd} failed:\n${tail}` };
    }
    log(`${step.cmd} ok`, 'ok');
  }

  let url = null;
  let runOutput = '';

  if (p.serve) {
    status(p.serve.label);
    log(`starting: ${p.serve.label}…`);
    try {
      const srv = await tool.serveCmd(project, p.serve.cmd, p.serve.args);
      url = srv.url;
      servers.add(project); // so Stop and the next run can take the port back
      log(`server up at ${url}`, 'ok');
    } catch (e) {
      const errs = await serverErrorText(project);
      return { ok: false, stage: 'serve', detail: `${e.message}${errs ? '\n' + errs : ''}` };
    }
  } else if (p.run) {
    status(p.run.label);
    log(`running: ${p.run.label}…`);
    try {
      const res = await tool.run(project, p.run.cmd, p.run.args, p.run.timeoutMs || 120000);
      runOutput = tailLines(res.out, 30) || '(no output)';
      const note = res.timedOut ? 'timed out' : `exit code ${res.code}`;
      log(`finished — ${note}`, res.code === 0 ? 'ok' : 'err');
      termLine(runOutput);
      if (res.code !== 0) {
        return { ok: false, stage: 'run', detail: `${note}\n${runOutput}` };
      }
    } catch (e) {
      return { ok: false, stage: 'run', detail: e.message };
    }
  }

  // A script that also produced a page still deserves a look.
  if (!url && p.preview !== 'none' && p.htmlEntry) {
    url = 'file:///' + (await fs.root()).replace(/\\/g, '/') + `/${project}/${p.htmlEntry}`;
    log(`previewing ${p.htmlEntry}`, 'ok');
  }

  if (!url) {
    // Nothing to look at: judge the output text instead.
    if (!runOutput) return { ok: true, skipped: true };
    return judgeText(project, request, p, runOutput);
  }

  return judgePage(project, request, p, url, runOutput);
}

/**
 * What we are allowed to tell a chat tab about where the project is running.
 *
 * A file:// preview URL contains the absolute path - and therefore the user's
 * Windows account name - and it was being typed verbatim into the conversation
 * on every static-preview run. Localhost URLs are fine and useful; anything on
 * disk becomes a project-relative label.
 */
function safeLocation(url, project) {
  const u = String(url || '');
  if (/^https?:\/\//i.test(u)) return u;
  const rel = u.split('/').slice(-1)[0] || 'index.html';
  return `workspace/${project}/${rel}`;
}

/** The workspace root, resolved once, purely so it can be redacted. */
let workspaceRoot = null;
fs.root()
  .then((r) => {
    workspaceRoot = r;
  })
  .catch(() => {});

const HOME_DIR_RE = /(?:[A-Za-z]:)?[\\/](?:Users|home)[\\/][^\\/\s"'`]+/gi;

/**
 * Remove absolute filesystem paths from anything about to be typed into a chat.
 *
 * Install output, stack traces and framework overlays are full of them, and on
 * Windows every one carries the user's account name. The relative tail is what
 * makes the error useful, and it survives untouched - patch.parseErrorLocation
 * still finds "app/page.tsx:12" inside the result.
 */
function scrubPaths(text) {
  let t = String(text || '');
  if (workspaceRoot) {
    t = t.split(workspaceRoot).join('workspace');
    t = t.split(workspaceRoot.replace(/\\/g, '/')).join('workspace');
  }
  return t.replace(HOME_DIR_RE, '~');
}

/** Dev-server compile errors, if the bridge exposes them. */
async function serverErrorText(project) {
  try {
    return tool.serverErrors ? await tool.serverErrors(project) : '';
  } catch {
    return '';
  }
}

/**
 * Screenshot a running page and have the QA tab judge it.
 *
 * The screenshot is taken AFTER the harness clicks and presses Enter/Space/W,
 * so a game is past its title screen; and the framework's error overlay is read
 * out of its shadow DOM, so a failure comes back as a real stack trace rather
 * than "it shows an error".
 */
async function judgePage(project, request, p, url, runOutput) {
  let shot, verdict;
  try {
    status('screenshotting');
    shot = await tool.screenshot(project, url);
    log(`screenshot ${Math.round(shot.bytes / 1024)}KB — "${shot.title || 'untitled'}"`, 'ok');
    await refreshFiles();

    const diagnostics = [shot.diagnostics || '', await serverErrorText(project)]
      .filter(Boolean)
      .join('\n')
      .slice(0, 2500);
    if (diagnostics) log(`errors on the page: ${diagnostics.split('\n')[0]}`, 'err');

    const drove = (shot.interactions || []).join('; ');
    status(`${QA.toUpperCase()}: judging the preview`);
    verdict = await askWithImage(
      QA,
      // safeLocation, never the raw URL: a file:// preview path carries the
      // absolute path and therefore the user's account name.
      `Screenshot of the running project at ${safeLocation(url, project)}.\n` +
        `REQUEST: ${request}\n` +
        (drove ? `The harness already ${drove}, so this is the app in use.\n` : '') +
        // Build output and framework overlays quote absolute paths; the tab
        // gets the useful tail of them and never the OS account name.
        (runOutput ? `Program output:\n${scrubPaths(runOutput)}\n` : '') +
        (diagnostics ? `Errors detected on the page:\n${scrubPaths(diagnostics)}\n` : '') +
        `\nDoes this look like a working result for the request?\n` +
        `A title screen, menu or landing state is a PASS - you do not need to see it mid-use.\n` +
        `Reply FIX only if something is genuinely broken: an error overlay, a blank page, ` +
        `an obviously unstyled mess, or the wrong app entirely.\n` +
        `Reply PASS, or FIX followed by one short line.`
    );
    log(`verdict: ${verdict.slice(0, 160)}`, 'a');

    const { pass, detail } = await parsePassFix(verdict);
    return {
      ok: pass,
      stage: 'preview',
      url,
      shot: shot.file,
      // The real error beats the model's description of it every time.
      detail: pass ? null : (diagnostics || detail),
      diagnostics,
    };
  } catch (e) {
    log(`preview check failed: ${e.message}`, 'err');
    return { ok: false, stage: 'screenshot', url, detail: e.message };
  }
}

/** No page to look at: judge what the program printed. */
async function judgeText(project, request, p, output) {
  status(`${QA.toUpperCase()}: judging the output`);
  const verdict = await askRole(
    QA,
    `The project was run with: ${p.run ? p.run.label : 'its entry point'}\n` +
      `OUTPUT:\n${scrubPaths(output)}\n\nREQUEST: ${request}\n\n` +
      `Does this output satisfy the request? Be generous - if it clearly works, say PASS.\n` +
      `Reply PASS, or FIX followed by one short line.`
  );
  log(`verdict: ${verdict.slice(0, 160)}`, 'a');
  const { pass, detail } = await parsePassFix(verdict);
  return { ok: pass, stage: 'run', url: null, detail };
}

/** Browser modes: install, serve (or static file), screenshot, judge. */
async function verifyInBrowser(project, request, mode) {
  const info = await tool.inspect(project);

  let url = null;

  if (info.hasPackageJson) {
    log(`package.json found — scripts: ${info.scripts.join(', ') || '(none)'}`, 'ok');

    status('npm install');
    log('running npm install…');
    const install = await tool.run(project, 'npm', ['install'], 420000);
    if (install.code !== 0) {
      log(`npm install failed (code ${install.code})`, 'err');
      return { ok: false, stage: 'install', detail: tailLines(install.out) };
    }
    log('npm install ok', 'ok');

    const script =
      mode.devScript && info.scripts.includes(mode.devScript)
        ? mode.devScript
        : ['dev', 'start', 'serve', 'preview'].find((s) => info.scripts.includes(s));
    if (script) {
      status(`npm run ${script}`);
      log(`starting dev server: npm run ${script}…`);
      try {
        const srv = await tool.serve(project, script);
        url = srv.url;
        servers.add(project); // so Stop and the next run can take the port back
        log(`dev server up at ${url}`, 'ok');
      } catch (e) {
        log(`dev server failed: ${e.message}`, 'err');
        return { ok: false, stage: 'serve', detail: e.message };
      }
    }
  }

  // No server? A plain index.html is still previewable.
  if (!url) {
    const entry = await tool.staticEntry(project);
    if (!entry) {
      log('nothing previewable (no dev script, no index.html)', 'err');
      return { ok: true, skipped: true };
    }
    url = 'file:///' + (await fs.root()).replace(/\\/g, '/') + `/${project}/${entry}`;
    log(`previewing static file: ${entry}`, 'ok');
  }

  // A crashed server or a stuck QA tab is a verify FAILURE that should feed the
  // fix loop, not an exception that aborts the whole run.
  let shot, verdict;
  try {
    status('screenshotting preview');
    shot = await tool.screenshot(project, url);
    log(`screenshot ${Math.round(shot.bytes / 1024)}KB — "${shot.title || 'untitled'}"`, 'ok');
    await refreshFiles();

    // The screenshot is on the clipboard; paste it into the QA tab so the
    // model can actually see what it built, then ask for a verdict.
    status(`${QA.toUpperCase()}: reviewing the preview`);
    verdict = await askWithImage(
      QA,
      // safeLocation, never the raw URL - a file:// path leaks the OS username.
      `This is a screenshot of the running project at ${safeLocation(url, project)}.\n` +
        `ORIGINAL REQUEST: ${request}\n\n` +
        `Does it satisfy the request? Reply PASS, or FIX followed by one short line.`
    );
  } catch (e) {
    log(`preview check failed: ${e.message}`, 'err');
    return { ok: false, stage: 'screenshot', url, detail: e.message };
  }
  log(`preview verdict: ${verdict.slice(0, 160)}`, 'a');

  // The dev server is deliberately NOT stopped here: it keeps serving the
  // preview view. The next run for this project (or quitting) stops it.

  const { pass, detail } = await parsePassFix(verdict);
  return { ok: pass, stage: 'preview', url, shot: shot.file, detail };
}

/**
 * PASS/FIX with a prose tolerance: if the QA tab ignored the one-word contract,
 * re-ask once before treating the answer as a failure.
 */
async function parsePassFix(verdict) {
  const read = (v) => {
    const t = protocol.clean(v);
    // Decide on the FIRST verdict word, not on the presence of either: the old
    // `PASS && !FIX` test inverted "PASS - no fix needed" into a failure, and
    // the loop then rewrote a file that was already correct to fix the
    // problem "needed".
    const m = t.match(/\b(PASS|FIX)\b/i);
    const pass = !!m && m[1].toUpperCase() === 'PASS';
    const fix = !!m && !pass;
    return {
      pass,
      fix,
      // Only a real FIX carries a reason; anything else keeps the first line.
      detail: pass ? null : t.slice(m ? m.index + m[0].length : 0).replace(/^[:\s-]*/, '').split('\n')[0],
    };
  };
  let r = read(verdict);
  if (r.pass || r.fix) return r;
  try {
    const again = await askRole(QA, 'Reply with exactly one word: PASS or FIX (with one line after FIX).');
    r = read(again);
  } catch { /* keep the prose reading */ }
  if (!r.pass && !r.fix) r.detail = protocol.clean(verdict).split('\n')[0] || 'unclear verdict';
  return r;
}

/** Run modes (node/python): execute the entry file and judge the output. */
async function verifyByRunning(project, request, mode) {
  const [cmd, args] = mode.key === 'python' ? ['python', ['main.py']] : ['node', ['index.js']];

  status(`running ${cmd} ${args.join(' ')}`);
  log(`running ${cmd} ${args.join(' ')}…`);
  let res;
  try {
    res = await tool.run(project, cmd, args, 60000);
  } catch (e) {
    log(`run failed to start: ${e.message}`, 'err');
    return { ok: false, stage: 'run', url: null, detail: e.message };
  }

  const tail = tailLines(res.out, 30) || '(no output)';
  const exitNote = res.timedOut ? 'timed out after 60s' : `exit code ${res.code}`;
  log(`run finished — ${exitNote}`, res.code === 0 ? 'ok' : 'err');
  termLine(`[${cmd}] ${exitNote}`);
  for (const l of tail.split('\n')) log(`  ${l}`);
  termLine(tail);

  status(`${QA.toUpperCase()}: reviewing the output`);
  const verdict = await askRole(
    QA,
    `The project was executed with: ${cmd} ${args.join(' ')} (${exitNote}).\n` +
      `OUTPUT (tail):\n${scrubPaths(tail)}\n\n` +
      `ORIGINAL REQUEST: ${request}\n\n` +
      `Does the output satisfy the request? Reply PASS, or FIX followed by one short line.`
  );
  log(`run verdict: ${verdict.slice(0, 160)}`, 'a');

  const { pass, detail } = await parsePassFix(verdict);
  return { ok: pass, stage: 'run', url: null, detail };
}

/**
 * How long to watch the composer for a pasted image to appear, and the blind
 * wait to fall back on when nothing observable changes.
 */
const PASTE_WATCH_MS = 6000;
const PASTE_BLIND_MS = 2500;

/**
 * Wait for a pasted screenshot to actually attach.
 *
 * The attachment chip renders inside the composer, so composerText changes the
 * moment the upload lands - watching for that is both faster than a fixed sleep
 * when the site is quick and safer when it is slow. If nothing changes (some
 * composers render the chip outside the text node we read), fall back to the
 * blind wait that this replaced rather than typing over a half-done upload.
 */
async function waitForPastedImage(wv, before) {
  const deadline = Date.now() + PASTE_WATCH_MS;
  while (Date.now() < deadline) {
    const now = await drive(wv, 'composerText', {}, 8000).catch(() => null);
    if (now !== null && (now || '') !== before) {
      await new Promise((r) => setTimeout(r, 600)); // let the upload settle
      return true;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Send a prompt plus the clipboard image to a tab. */
async function askWithImage(tag, text) {
  const wv = wvOf(tag);
  const id = wv.getWebContentsId();
  markBusy(tag, true, run.phase);
  try {
    await drive(wv, 'prepare', {}, 15000);
    // An unreadable baseline must not look like "the image arrived", so a
    // failed read counts as an empty composer.
    const before = (await drive(wv, 'composerText', {}, 8000).catch(() => '')) || '';
    await tabs.paste(id);                       // the screenshot
    if (!(await waitForPastedImage(wv, before))) {
      await new Promise((r) => setTimeout(r, PASTE_BLIND_MS));
    }
    await tabs.type(id, text);
    await new Promise((r) => setTimeout(r, 500));
    const clicked = await drive(wv, 'clickSend', {}, 8000);
    if (!clicked) await tabs.enter(id);
    run.messages++;
    return await drive(wv, 'awaitReply', { opts: { text, quietMs: 6000, timeoutMs: 600000 } }, 630000);
  } finally {
    markBusy(tag, false);
  }
}

/* ---------------------------------------------------------------- actions */

async function refreshFiles() {
  const list = (await fs.list()).filter((f) => !NOISE_RE.test(f));
  els.files.innerHTML = '';
  const CAP = 400;
  for (const f of list.slice(0, CAP)) {
    const li = document.createElement('li');
    li.textContent = f;
    els.files.appendChild(li);
  }
  if (list.length > CAP) {
    const li = document.createElement('li');
    li.textContent = `(+${list.length - CAP} more)`;
    els.files.appendChild(li);
  }
}

/**
 * Buttons this file needs. They are created here rather than assumed, so the
 * renderer keeps working whichever version of the page it is loaded into.
 */
function ensureButton(id, label, title) {
  let btn = document.getElementById(id);
  if (btn) return btn;
  btn = document.createElement('button');
  btn.id = id;
  btn.textContent = label;
  btn.title = title;
  const row = els.stop.parentElement || document.body;
  // The row was laid out for two buttons; four must wrap rather than be clipped
  // off the edge of a narrow sidebar.
  if (row.style) row.style.flexWrap = 'wrap';
  row.appendChild(btn);
  return btn;
}

els.resume = ensureButton(
  'btn-resume',
  'Resume',
  'Continue the last run for this project instead of starting over'
);
els.verify = ensureButton(
  'btn-verify',
  'Verify again',
  'Install, run, screenshot and judge the current project without rebuilding it'
);

/** One place that decides what a finished run is allowed to claim. */
function finishRun(preview, outcome) {
  run.outcome = outcome;
  run.active = false;
  reportRun(preview, outcome);
  status(outcome);
}

function startingRun() {
  running = true;
  abort = false;
  els.run.disabled = true;
  els.resume.disabled = true;
  els.verify.disabled = true;
  els.stop.disabled = false;
  els.stop.textContent = 'Stop';
}

async function endingRun() {
  running = false;
  abort = false; // a leftover abort would reject every later tab command
  run.active = false;
  els.run.disabled = false;
  els.resume.disabled = false;
  els.verify.disabled = false;
  els.stop.disabled = true;
  els.stop.textContent = 'Stop';
  // Our own relay messages are now all over the transcript; hold autopilot off
  // long enough to re-baseline against them.
  autopilotCooldownUntil = Date.now() + 30000;
  watchBaseline = await tabTranscript(els.a).catch(() => null);
}

/** Run or resume, with one honest terminal state at the end of it. */
async function startRun(request, opts = {}) {
  if (running) return;
  if (!request) {
    log('describe what to build first', 'err');
    els.prompt.focus();
    return;
  }
  startingRun();
  resetRun(protocol.slug(els.project.value || request), request, (currentMode() || {}).key);
  let preview = null;
  try {
    const res = await runProject(request, opts);
    preview = res.preview;
    // A run that produced nothing is not a success, and neither is one the user
    // stopped: both used to end on a green "done".
    if (!res.written.length) finishRun(preview, 'failed');
    else if (preview && (preview.ok || preview.skipped)) finishRun(preview, 'done');
    else finishRun(preview, 'partial');
  } catch (err) {
    const stopped = abort;
    log(String(err.message || err), 'err');
    finishRun(preview, stopped ? 'stopped' : 'failed');
    // Nothing is going to look at this project now; do not leave its server
    // holding a port.
    await stopServers().catch(() => {});
  } finally {
    await endingRun();
  }
}

els.run.addEventListener('click', () => startRun(els.prompt.value.trim()));

els.resume.addEventListener('click', async () => {
  if (running) return;
  const project = currentProjectSlug();
  if (!project) {
    log('name a project to resume (the Project box)', 'err');
    return;
  }
  const prev = await loadRunFile(project);
  if (!prev) {
    log(`no saved run in workspace/${project}/ — press Run to start one`, 'err');
    return;
  }
  const request = prev.request || els.prompt.value.trim();
  els.prompt.value = request;
  if (prev.mode && [...els.mode.options].some((o) => o.value === prev.mode)) {
    els.mode.value = prev.mode;
  }
  log(
    `resuming ${project}: ${(prev.written || []).length} file(s) written, ` +
      `last outcome "${prev.outcome || 'unknown'}"`,
    'ok'
  );
  await startRun(request, { resume: { written: prev.written || [], note: prev.note || null } });
});

// Verification is a standalone function; without this the only way to reach it
// is a full plan-build-review run that re-generates files the user just fixed.
els.verify.addEventListener('click', async () => {
  if (running) return;
  const project = currentProjectSlug();
  if (!project) {
    log('name a project to verify (the Project box)', 'err');
    return;
  }
  const prev = await loadRunFile(project);
  const request = els.prompt.value.trim() || prev?.request || 'the project as written';
  startingRun();
  resetRun(project, request, (currentMode() || {}).key);
  let preview = null;
  try {
    // The report has to describe what is on disk, not "nothing was written":
    // this path verifies files a previous run (or the user) produced.
    run.written = prev?.written?.length ? [...prev.written] : await existingFiles(project);
    preview = await verifyAndFix(project, request, currentMode(), run.written);
    if (preview && preview.url) showPreview(preview.url);
    finishRun(preview, preview && (preview.ok || preview.skipped) ? 'done' : 'partial');
  } catch (err) {
    const stopped = abort;
    log(String(err.message || err), 'err');
    finishRun(preview, stopped ? 'stopped' : 'failed');
  } finally {
    await endingRun();
  }
});

els.stop.addEventListener('click', async () => {
  if (!running || abort) return;
  abort = true;
  // Stop used to set a flag polled at loop boundaries while an awaitReply held
  // for up to 630s: the button stayed enabled, a second click did nothing, and
  // the app looked hung for ten minutes.
  els.stop.disabled = true;
  els.stop.textContent = 'Stopping…';
  status('stopping');
  const cancelled = cancelPending();
  log(`stop requested — cancelled ${cancelled} in-flight tab command(s)`, 'err');
  // Whatever those tabs were generating, they are mid-reply now; the next run
  // reloads them rather than typing into a wedged composer.
  for (const tag of busyTags) needsReset.add(tag);
  await stopServers().catch(() => {});
});

/**
 * A rejection nobody awaited must never leave the pill claiming something
 * untrue - "planner: next file?" forever, on a run that died three minutes ago.
 */
window.addEventListener('unhandledrejection', (e) => {
  const msg = String(e.reason?.message || e.reason || 'unknown error');
  run.internalError = msg;
  log(`internal error (unhandled rejection): ${msg}`, 'err');
  if (!running && !TERMINAL_STATES.includes(run.phase)) status('idle');
});

window.addEventListener('error', (e) => {
  run.internalError = String(e.message || 'script error');
  log(`internal error: ${run.internalError}`, 'err');
  if (!running && !TERMINAL_STATES.includes(run.phase)) status('idle');
});

/* ----------------------------------------------------------------- models */

const modelSelect = (tag) => document.getElementById('model-' + tag);

/**
 * Fill a tab's model dropdown from the site's own model menu.
 *
 * The composer toolbar mounts well after the page reports ready, so a single
 * attempt on load finds nothing and the dropdown sits empty. Retry with backoff
 * until the menu exists.
 */
async function loadModels(tag, { attempts = 1, quiet = false } = {}) {
  const wv = wvOf(tag);
  const sel = modelSelect(tag);
  if (!sel) return;
  // Opening the site's model dropdown while a run is typing into the same
  // composer corrupts both; model loading waits until the loop is idle.
  if (running) {
    if (!quiet) log(`${tag.toUpperCase()}: busy with a run — reload models later`, 'err');
    return;
  }

  for (let i = 0; i < attempts; i++) {
    try {
      // Focus is not instantaneous; clicking the dropdown before it lands opens
      // nothing, which is why only the last-focused tab used to populate.
      await tabs.focus(wv.getWebContentsId());
      await new Promise((r) => setTimeout(r, 700));
      const { current, models } = await drive(wv, 'listModels', {}, 20000);
      if (models.length) {
        sel.innerHTML = '';
        for (const m of models) {
          const o = document.createElement('option');
          o.value = m;
          o.textContent = m;
          if (m === current) o.selected = true;
          sel.appendChild(o);
        }
        log(`${tag.toUpperCase()}: ${models.length} models, current "${current}"`, 'ok');
        return;
      }
    } catch (e) {
      if (!quiet && i === attempts - 1) {
        log(`${tag.toUpperCase()} model list failed: ${e.message}`, 'err');
      }
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 2500 + i * 1500));
  }

  sel.innerHTML = '<option value="">no models found</option>';
  if (!quiet) log(`${tag.toUpperCase()}: no models — try ⟳, or Pick → model`, 'err');
}

for (const btn of document.querySelectorAll('[data-models]')) {
  btn.addEventListener('click', () => loadModels(btn.dataset.models, { attempts: 3 }));
}

/**
 * Anything that touches a composer has to wait for the loop.
 *
 * Opening the site's model popover in - or clearing - the composer the run is
 * typing into corrupts both. loadModels already refused; these did not.
 */
function busyWithRun(what) {
  if (!running) return false;
  log(`${what} is unavailable while a run is going — press Stop first`, 'err');
  return true;
}

for (const tag of TAGS_ALL) {
  const sel = modelSelect(tag);
  sel.addEventListener('change', async () => {
    if (!sel.value) return;
    if (busyWithRun('switching model')) return;
    try {
      const r = await drive(wvOf(tag), 'selectModel', { name: sel.value }, 25000);
      log(`${tag.toUpperCase()}: model → ${r.selected}${r.alreadyActive ? ' (already)' : ''}`, 'ok');
    } catch (e) {
      log(`${tag.toUpperCase()} model select failed: ${e.message}`, 'err');
    }
  });
}

/**
 * Auto-populate once each tab has rendered its composer.
 *
 * Serialised: reading the list means opening the site's dropdown and closing it
 * again, and four tabs doing that at once interfere with each other - two of
 * them came back empty every time until this was a queue.
 */
let modelQueue = Promise.resolve();
for (const tag of TAGS_ALL) {
  let done = false;
  wvOf(tag).addEventListener('did-finish-load', () => {
    if (done) return;
    done = true;
    modelQueue = modelQueue
      .then(() => new Promise((r) => setTimeout(r, 2500)))
      .then(() => loadModels(tag, { attempts: 4, quiet: true }))
      .catch(() => {});
  });
}

/* ------------------------------------------------- one model for all tabs */

/** Mirror whichever tab has a populated list into the "set all" dropdown. */
function syncAllModelsOptions() {
  const source = TAGS_ALL.map(modelSelect).find((s) => s && s.options.length > 1);
  if (!source) return;
  const current = els.modelAll.value;
  els.modelAll.innerHTML = '<option value="">All models…</option>';
  for (const o of source.options) {
    if (!o.value) continue;
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.value;
    els.modelAll.appendChild(opt);
  }
  els.modelAll.value = current;
}
setInterval(syncAllModelsOptions, 4000);

els.modelAll.addEventListener('change', async () => {
  const name = els.modelAll.value;
  if (!name) return;
  if (busyWithRun('setting every tab’s model')) return;
  log(`setting every tab to "${name}"…`);
  // Serialised for the same reason the initial load is: concurrent dropdowns
  // in different tabs interfere with each other.
  for (const tag of TAGS_ALL) {
    try {
      const r = await drive(wvOf(tag), 'selectModel', { name }, 25000);
      const sel = modelSelect(tag);
      if (sel) sel.value = name;
      log(`${tag.toUpperCase()}: → ${r.selected}${r.alreadyActive ? ' (already)' : ''}`, 'ok');
    } catch (e) {
      log(`${tag.toUpperCase()} could not switch: ${e.message}`, 'err');
    }
  }
  status('idle');
});

/* -------------------------------------------------------------- self test */

els.selftest.addEventListener('click', async () => {
  // It types a marker into all four composers and then clears them: mid-run
  // that wipes the prompt the loop just typed.
  if (busyWithRun('the self-test')) return;
  status('self-testing');
  let allPass = true;
  for (const t of TAGS_ALL) {
    const [tag, wv] = [t.toUpperCase(), wvOf(t)];
    try {
      const r = await drive(wv, 'selftest', {}, 30000);
      const checks = [...r.checks];

      // Typing and the send button can only be verified together: the site does
      // not render a send control until the composer has content. Type a
      // marker through the real input path, inspect, then clear without sending.
      // No markdown-trigger characters: the composer would rewrite them
      // mid-typing and end up empty, which also hides the send button.
      const marker = `${site.brand} selftest ping`;
      try {
        await drive(wv, 'prepare', {}, 15000);
        await tabs.type(wv.getWebContentsId(), marker);
        await new Promise((r2) => setTimeout(r2, 400));
        const landed = await drive(wv, 'composerText', {}, 8000);
        const typed = landed.includes(marker);
        checks.push({
          name: 'typing round-trip (not sent)',
          pass: typed,
          detail: typed ? 'text landed via webContents.insertText' : 'composer rejected text',
        });

        const send = await drive(wv, 'describeSend', {}, 8000);
        checks.push({
          name: 'send button (appears once text is present)',
          pass: !!send,
          detail: send || 'no send control found — Enter fallback will be used',
        });
      } finally {
        await drive(wv, 'clearComposer', {}, 8000).catch(() => {});
      }

      const passed = checks.filter((c) => c.pass).length;
      log(`── TAB ${tag}: ${passed}/${checks.length} checks passed`, passed === checks.length ? 'ok' : 'err');
      for (const c of checks) {
        log(`   ${c.pass ? '✓' : '✗'} ${c.name}: ${c.detail}`, c.pass ? '' : 'err');
        if (!c.pass) allPass = false;
      }
    } catch (e) {
      allPass = false;
      log(`TAB ${tag} self-test failed: ${e.message}`, 'err');
    }
  }
  log(allPass ? 'self-test: all green — safe to Run' : 'self-test: fix the ✗ rows first', allPass ? 'ok' : 'err');
  status('idle');
});

document.querySelectorAll('[data-pick]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (busyWithRun('the element picker')) return;
    const [tab, which] = btn.dataset.pick.split('-');
    drive(wvOf(tab), 'pick', { which }, 5000).catch(() => {});
    log(`click the ${which} in tab ${tab.toUpperCase()}`);
  });
});

/* ----------------------------------------------------------- autopilot */

/**
 * Hands-off mode. You type ONE message into tab A's chat yourself; the
 * system notices it, runs the whole planner/builder/review loop to completion,
 * and then posts a summary back into that same chat so you learn it is done
 * without watching the app. It builds in whatever mode the sidebar is set to.
 */
let autopilot = false;
let watchBaseline = null;

async function tabTranscript(wv) {
  const probe = await drive(wv, 'probe', {}, 8000);
  return probe.transcriptChars;
}

/**
 * Text the orchestrator itself puts into a chat. Autopilot must never treat
 * this as a human request - it once mistook its own traffic for a new message,
 * took over a finished run, and reported "0 files" over real work.
 */
const OWN_TRAFFIC =
  /\b(REQUEST|REVIEW|PATH:|WRITTEN SO FAR|AUDITOR SAYS|PROJECT:|FILES WRITTEN|ORIGINAL REQUEST|FIX REQUIRED|PROBLEM:|Reply with exactly|Reply with ONE line|The build is complete|PLANNER in a|BUILDER in a|REVIEWER in a|AUDITOR in a)\b/i;

/** Protocol control words a human echo of which must never start a build. */
const PROTOCOL_WORDS = /^\W*(DONE|PRINT|RETRY|READY|PASS|FIX)\W*$/i;

let autopilotCooldownUntil = 0;
let pollInFlight = false;
/** Transcript length of the last delta we looked at and passed on. */
let ignoredAt = -1;

/**
 * What the human actually typed, without tab A's own answer stuck to it.
 *
 * transcriptTail is a raw character slice of the transcript, and tab A is the
 * PLANNER - so it answers the human's message with a file path and the delta
 * contains both. That went in verbatim as the build request AND as the folder
 * name, producing projects called "build-me-a-snake-game-app-page-tsx".
 */
let canReadUserMessage = true;

async function readNewRequest(delta) {
  // Newer preloads can hand back the newest user message directly; older ones
  // reject with "unknown cmd", which is the signal to stop asking and fall
  // back to slicing the transcript.
  if (canReadUserMessage) {
    const direct = await drive(els.a, 'lastUserMessage', {}, 8000).catch((e) => {
      if (/unknown cmd/i.test(String(e.message || e))) canReadUserMessage = false;
      return null;
    });
    if (direct && String(direct).trim()) return protocol.clean(direct);
  }
  const raw = await drive(els.a, 'transcriptTail', { tail: delta }, 8000).catch(() => '');
  return stripPlannerReply(protocol.clean(raw));
}

/** Drop trailing lines that are tab A answering us with a path or DONE. */
function stripPlannerReply(text) {
  const lines = String(text || '').split('\n');
  while (lines.length) {
    const last = lines[lines.length - 1].trim();
    if (!last || protocol.parsePath(last)) lines.pop();
    else break;
  }
  return lines.join('\n').trim();
}

async function pollAutopilot() {
  if (!autopilot || running || pollInFlight) return;
  pollInFlight = true;
  try {
    // After a run ends the transcript is full of our own messages, and the
    // baseline was re-read once at the end of the run. Do NOT null it on every
    // tick: that swallowed anything typed in the 30 seconds after a build
    // finished - the most natural moment to type the next request.
    if (Date.now() < autopilotCooldownUntil) return;

    let chars;
    try {
      chars = await tabTranscript(els.a);
    } catch {
      return;
    }

    if (watchBaseline === null) { watchBaseline = chars; return; }
    // A shrink means the chat was reset (new chat, reload) - re-baseline.
    if (chars < watchBaseline) { watchBaseline = chars; return; }
    if (chars === watchBaseline) return;

    // Something arrived. Let it settle before reading, so we do not grab a
    // half-streamed reply.
    await new Promise((r) => setTimeout(r, 4000));
    const settled = await tabTranscript(els.a).catch(() => chars);
    if (settled !== chars) return; // still streaming — check again next tick
    // Already looked at this exact transcript and passed on it. The baseline
    // deliberately stays put for a too-short delta, so without this the same
    // line would be re-read, and re-logged, every five seconds.
    if (settled === ignoredAt) return;

    // Read only the DELTA since the baseline: a fixed-size tail drags earlier
    // protocol traffic into view, which either vetoes real requests or feeds
    // stale text into the build.
    const grew = Math.max(settled - watchBaseline, 0);
    const request = await readNewRequest(Math.min(grew + 100, 4000));

    // The baseline used to advance HERE, before the checks below, so every
    // rejected delta was skipped forever and silently. It now advances only
    // when the text is genuinely ours (or genuinely used).
    if (!request) {
      watchBaseline = settled;
      log(`autopilot: ignored ${grew} new chars — nothing readable in them`);
      return;
    }
    if (OWN_TRAFFIC.test(request)) {
      watchBaseline = settled;
      log(`autopilot: ignored ${grew} chars — that was our own relay traffic`);
      return;
    }
    if (PROTOCOL_WORDS.test(request) || request.length < 12) {
      // Deliberately not consumed: a real request typed right after this one
      // must still be visible in the next delta.
      ignoredAt = settled;
      log(`autopilot: ignored "${request.slice(0, 40)}" — too short to be a request`);
      return;
    }

    if (running) return; // a Run started while we were settling
    watchBaseline = settled;
    log(`autopilot: new request — "${request.replace(/\n/g, ' ').slice(0, 120)}"`, 'ok');
    await runAutopilot(request);
  } finally {
    pollInFlight = false;
  }
}

/** How long the user gets to veto an autopilot build with Stop. */
const AUTOPILOT_GRACE_MS = 3000;

async function runAutopilot(request) {
  if (running) return;
  // Stop sets abort and only the manual Run handler cleared it, so one Stop
  // press bricked autopilot for the rest of the session. startingRun clears it.
  startingRun();
  els.prompt.value = request;
  // A fresh autopilot request gets its own folder; reusing the previous slug
  // would pollute the new project with the old one's files.
  els.project.value = protocol.slug(request);
  status('autopilot: starting in 3s — press Stop to cancel');
  log(`autopilot: building "${request.replace(/\n/g, ' ').slice(0, 80)}" — Stop within 3s to cancel`, 'ok');
  for (let i = 0; i < AUTOPILOT_GRACE_MS / 250 && !abort; i++) await sleep(250);
  if (abort) {
    log('autopilot: cancelled before it started', 'err');
    status('idle');
    await endingRun();
    return;
  }

  resetRun(protocol.slug(request), request, (currentMode() || {}).key);
  let preview = null;
  try {
    const res = await runProject(request);
    preview = res.preview;

    // Tell the user, in the chat they used, that the job is finished. Do NOT
    // invite a reply - a one-word answer here once relaunched the whole build.
    // The claim has to match the run: "the build is complete" over a failed
    // verification is exactly the lie this whole pass exists to remove.
    const summary =
      `The build is complete. ${res.written.length} file(s) written to ` +
      `workspace/${res.project}/: ${res.written.join(', ') || '(none)'}. ` +
      `Verification: ${verifiedShort(preview)}. ` +
      `No reply needed - type a new request whenever you want the next build.`;
    await ask(els.a, summary).catch(() => {});
    log(`autopilot: reported completion in chat — ${res.written.length} file(s)`, 'ok');
    if (!res.written.length) finishRun(preview, 'failed');
    else if (preview && (preview.ok || preview.skipped)) finishRun(preview, 'done');
    else finishRun(preview, 'partial');
  } catch (err) {
    const stopped = abort;
    log(`autopilot ${stopped ? 'stopped' : 'failed'}: ${err.message}`, 'err');
    finishRun(preview, stopped ? 'stopped' : 'failed');
    await stopServers().catch(() => {});
  } finally {
    await endingRun();
  }
}

els.autopilot.addEventListener('click', async () => {
  autopilot = !autopilot;
  els.autopilot.classList.toggle('primary', autopilot);
  els.autopilot.setAttribute('aria-pressed', String(autopilot));
  els.autopilot.textContent = autopilot ? 'Autopilot: ON' : 'Autopilot';
  if (autopilot) {
    watchBaseline = await tabTranscript(els.a).catch(() => null);
    log(`autopilot ON — type your request into tab A's ${site.name} chat, once.`, 'ok');
    log('the system will plan, build, review, write files, then reply in chat.', 'ok');
  } else {
    log('autopilot OFF');
  }
});

setInterval(() => pollAutopilot().catch(() => {}), 5000);

/* --------------------------------------------------------- session status */

let wasLoggedIn = null;

async function refreshLogin() {
  const s = await session.status();
  els.session.className = 'pill ' + (s.loggedIn ? 'in' : 'out');
  els.session.textContent = s.loggedIn
    ? `session saved · ${site.primaryAuthCookie} → ${s.cookies?.[site.primaryAuthCookie] ?? 'set'}`
    : `not logged in — ${site.loginHint}`;
  els.session.title = `profile: ${s.profileDir}\ncookies: ${s.total}`;

  if (wasLoggedIn === false && s.loggedIn) {
    await session.flush();
    log('login captured and flushed to disk — it will survive restarts', 'ok');
    log('all four tabs share this session', 'ok');
  }
  wasLoggedIn = s.loggedIn;
}

els.forget.addEventListener('click', async () => {
  await session.clear();
  log('saved session wiped', 'err');
  seeded.clear(); // fresh chats know nothing; contracts must be re-sent
  seededMode = null;
  for (const tag of TAGS_ALL) wvOf(tag).reload();
  refreshLogin().catch(() => {});
});

// A reloaded or crashed tab lands in a fresh conversation that has never seen
// its contract; forgetting that made later runs talk to an unseeded model.
for (const tag of TAGS_ALL) {
  wvOf(tag).addEventListener('did-navigate', () => seeded.delete(tag));
}

// Reloading a tab after login is what makes the other tabs pick up the session.
for (const tag of TAGS_ALL) {
  const wv = wvOf(tag);
  wv.addEventListener('did-navigate', () => refreshLogin().catch(() => {}));
  wv.addEventListener('did-navigate-in-page', () => refreshLogin().catch(() => {}));
}
setInterval(() => refreshLogin().catch(() => {}), 4000);
refreshLogin().catch(() => {});

/* ------------------------------------------------------------------ init */

setView('agents');
refreshFiles().catch(() => {});
log(`ready. ${site.loginHint} — the other tabs share the session.`);

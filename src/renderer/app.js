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
  window.buildgpt;

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
const RETRIES = 4; // per-file build attempts
const FILE_BACKSTOP = 200; // runaway guard; the planner/auditor decide "done"

// The preview webview gets NO preload/partition - only the agent tabs do.
for (const tag of TAGS_ALL) {
  wvOf(tag).setAttribute('preload', preloadPath);
  wvOf(tag).setAttribute('partition', partition);
}

function markBusy(tag, on) {
  const el = document.querySelector(`.tab[data-tab="${tag}"]`);
  if (el) el.classList.toggle('busy', on);
}

let running = false;
let abort = false;

/* ---------------------------------------------------------------- logging */

function log(msg, cls = '') {
  const line = document.createElement('div');
  const t = new Date().toLocaleTimeString();
  line.innerHTML = `<span class="t">${t}</span> <span class="${cls}"></span>`;
  line.lastChild.textContent = msg;
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
}

function status(s) {
  els.status.textContent = s;
  // The header dot animates while something is actually happening.
  els.status.classList.toggle('working', !['idle', 'done', 'failed'].includes(s));
}

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

function drive(wv, cmd, args = {}, timeoutMs = 200000) {
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
    log(`${tag.toUpperCase()}: chat rotation failed (${e.message}) — continuing`, 'err');
  }
}

/** Point the tab at a brand-new chat. The reliable last resort. */
function hardResetTab(tag) {
  const wv = wvOf(tag);
  return new Promise((resolve) => {
    const done = () => {
      wv.removeEventListener('did-stop-loading', done);
      clearTimeout(timer);
      seeded.delete(tag);
      setTimeout(resolve, 3000); // let the composer mount
    };
    const timer = setTimeout(done, 25000);
    wv.addEventListener('did-stop-loading', done);
    wv.src = site.url;
  });
}

/** Ask a role's tab, marking it busy so you can see who is working. */
async function askRole(tag, prompt, opts) {
  await rotateIfBloated(tag);
  markBusy(tag, true);
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
  markBusy(tag, true);
  try {
    try {
      await ask(wvOf(tag), contract + '\n\nReply with exactly: READY');
    } catch (e) {
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
  const pending = TAGS_ALL.filter((t) => !seeded.has(t));
  if (!pending.length) return;

  // The four seeds are independent, and typing goes to a specific webContents
  // rather than "whatever has focus", so they can run at once. Serially this
  // was 28s of a 113s run - a quarter of the wall clock spent waiting on four
  // things that never needed to wait for each other.
  status(`seeding ${pending.length} tabs`);
  // Staggered, not simultaneous: four identical requests landing in the same
  // millisecond looks like a burst and has drawn ERR_ADDRESS_UNREACHABLE.
  // 400ms apart keeps nearly all the parallel win without the thundering herd.
  const results = await Promise.allSettled(
    pending.map(
      (tag, i) =>
        new Promise((resolve, reject) =>
          setTimeout(() => seedTab(tag).then(resolve, reject), i * 400)
        )
    )
  );

  // Concurrency is the one thing that could plausibly upset the composer, so
  // anything that failed gets a serial second chance before the run gives up.
  const failed = pending.filter((_, i) => results[i].status === 'rejected');
  for (const tag of failed) {
    log(`${tag.toUpperCase()}: parallel seed failed — retrying on its own`, 'err');
    await seedTab(tag);
  }
}

/** Build noise that must never reach a prompt or the files list. */
const NOISE_RE = /(^|\/)(node_modules|\.next|\.preview)(\/|$)/;

/** Project-relative files on disk, minus install/build noise. */
async function existingFiles(project) {
  const prefix = project + '/';
  return (await fs.list())
    .filter((f) => f.startsWith(prefix))
    .map((f) => f.slice(prefix.length))
    .filter((f) => !NOISE_RE.test(f));
}

/** Build one file: builder writes it, reviewer judges it, we save it. */
async function buildFile(project, filePath, request, mode) {
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
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
      log(`build attempt ${attempt + 1} failed: ${e.message}`, 'err');
      // A blind chat stays blind: a prompt that vanished once will vanish
      // again (seen live at 5.5KB - NOT a transcript-size problem). Give the
      // next attempt a brand-new chat instead of the same broken one.
      if (/no response detected|timed out|composer never received/i.test(String(e.message || e))) {
        log('B: reply detection broke — moving to a fresh chat', 'err');
        await hardResetTab(ROLES.builder).catch(() => {});
        await seedTab(ROLES.builder).catch(() => {});
      }
      continue;
    }
    // unfence removes a fence wrapping the whole reply; ChatGPT also splits one
    // file across several code blocks, leaving ``` lines mid-file.
    const candidate = protocol.stripStrayFences(protocol.unfence(buildReply), filePath);
    const bad = protocol.rejectReason(candidate);
    if (bad) {
      log(`B output rejected (${bad}), retrying`, 'err');
      continue;
    }
    log(`B returned ${candidate.length} chars`, 'b');

    status('C: reviewing');
    let verdictReply;
    try {
      verdictReply = await askRole(ROLES.reviewer, protocol.TAGS.review(filePath, candidate));
    } catch (e) {
      // The file itself looks fine; losing it to a flaky reviewer would be worse
      // than accepting it, so a reviewer timeout counts as approval.
      log(`reviewer unavailable (${e.message}) — accepting the file`, 'err');
      verdictReply = 'PRINT';
    }
    const verdict = protocol.parseVerdict(verdictReply);
    log(`verdict = ${verdict ?? '(unparseable) ' + verdictReply.slice(0, 80)}`, 'a');

    if (verdict === 'PRINT') {
      // Every project gets its own folder under workspace/.
      const res = await fs.write(`${project}/${filePath}`, candidate);
      log(`wrote workspace/${res.rel} (${res.bytes} bytes)`, 'ok');
      await refreshFiles();
      return res;
    }
    log('RETRY -> rebuilding', 'err');
  }
  return null;
}

/**
 * Ask the planner something that must come back as a path.
 *
 * The model sometimes drops into an agent/tool mode and answers with tool
 * chatter instead of obeying the one-line contract. Re-asking with an explicit
 * nudge recovers it, which is cheaper than failing the whole run.
 */
async function askForPath(prompt) {
  const tag = ROLES.planner;
  let reply = await askRole(tag, prompt);
  log(`${tag.toUpperCase()} raw: ${reply.slice(0, 160)}`, 'a');
  if (protocol.parsePath(reply)) return reply;

  log('planner broke contract — re-asking with a nudge', 'err');
  reply = await askRole(
    tag,
    'Do not use any tools and do not write any files yourself. ' +
      'Reply with ONE line only: the relative file path, or the word DONE. Nothing else.'
  );
  log(`${tag.toUpperCase()} retry: ${reply.slice(0, 160)}`, 'a');
  return reply;
}

async function runProject(request) {
  const mode = currentMode();
  const project = protocol.slug(els.project.value || request);
  els.project.value = project;
  log(`project → workspace/${project}/  (mode: ${mode.label || mode.key})`, 'ok');

  // A fresh run kills the old server for this project; the toolchain will
  // start a new one after the build.
  try {
    const stopped = await tool.stop(project);
    if (stopped) log('previous dev server stopped', 'ok');
  } catch { /* nothing was running */ }

  // Framework modes start from a real scaffold so the agents only write the
  // files that matter.
  if (mode.scaffold) {
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
    await rotateIfBloated(tag);
  }

  // Contracts are installed automatically; nothing is ever typed into a chat
  // by hand. Mode-aware: switching mode reseeds.
  await ensureSeeded(mode.key);

  status('planner: asking for path');
  let reply = await askForPath(protocol.TAGS.request(request, mode, await existingFiles(project)));

  const written = [];
  // The planner is allowed to re-name a file to REPLACE it (the auditor asks
  // for exactly that), so repeats are capped rather than treated as done.
  const writeCounts = new Map();
  const MAX_WRITES_PER_PATH = 3;
  let note = null; // the auditor's last "what's still missing"

  for (let i = 0; i < FILE_BACKSTOP; i++) {
    if (abort) throw new Error('stopped');

    const filePath = protocol.parsePath(reply);
    if (filePath === 'DONE') { log('planner says DONE', 'ok'); break; }
    if (!filePath) throw new Error('planner did not return a usable path');
    if ((writeCounts.get(filePath) || 0) >= MAX_WRITES_PER_PATH) {
      log(`planner keeps returning ${filePath} — treating the project as done`, 'err');
      break;
    }
    log(`path = ${filePath}${writeCounts.has(filePath) ? ' (rewrite)' : ''}`, 'ok');

    const res = await buildFile(project, filePath, request, mode);
    if (!res) throw new Error(`never got PRINT for ${filePath}`);
    writeCounts.set(filePath, (writeCounts.get(filePath) || 0) + 1);
    if (!written.includes(filePath)) written.push(filePath);
    if (written.length >= FILE_BACKSTOP) {
      log(`file backstop (${FILE_BACKSTOP}) reached — stopping the loop`, 'err');
      break;
    }

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
      log(`auditor unavailable (${e.message}) — continuing`, 'err');
    }
    if (auditDone) break;

    status('planner: next file?');
    reply = await askForPath(protocol.TAGS.next(written, note, await existingFiles(project)));
  }

  // Build, run and look at it. A failure here is not the end of the run - it
  // becomes the next instruction, which is the whole point of the loop.
  let preview = null;
  if (written.length && !abort) {
    for (let round = 0; round < 3; round++) {
      if (abort) break;
      try {
        preview = await verifyProject(project, request, mode);
      } catch (e) {
        log(`verify failed: ${e.message}`, 'err');
        break;
      }
      if (preview.ok || preview.skipped) break;
      if (round === 2) break; // two fix rounds spent

      const fix = preview.detail || `${preview.stage} failed`;
      log(`fixing: ${fix.split('\n')[0]}`, 'err');

      // A stack trace names the file and line, so try a surgical patch before
      // regenerating the whole file - a 48KB rewrite to fix one loop wastes a
      // full generation and risks breaking everything that already worked.
      const patched = await tryPatch(project, fix);
      if (patched) {
        if (!written.includes(patched)) written.push(patched);
        continue;
      }

      status('planner: fixing');
      const fixReply = await askForPath(
        `The project was built and run. It did not pass.\n` +
          `PROBLEM: ${condense(fix, 1200)}\n\nReply with the ONE file path to rewrite to fix this.`
      );
      const fixPath = protocol.parsePath(fixReply);
      if (!fixPath || fixPath === 'DONE') break;
      const res = await buildFile(
        project,
        fixPath,
        `${request}\n\nFIX REQUIRED: ${condense(fix, 1200)}`,
        mode
      );
      if (!res) break;
      if (!written.includes(fixPath)) written.push(fixPath);
    }

    // Passing or not, if we know where the project is running, show it. The
    // server stays up for the user - the next run (or quitting) stops it.
    // If there is a URL there is something to look at, whatever the mode said.
    // Gating this on mode.previews hid the page a Python or Node server was
    // serving, purely because the mode had been labelled a "run" mode.
    if (preview && preview.url) showPreview(preview.url);
  }

  const verdict = preview?.skipped
    ? 'not previewable'
    : preview
      ? (preview.ok ? 'preview PASSED' : 'preview still failing')
      : 'not verified';
  log(`project done — ${written.length} file(s) in workspace/${project}/ — ${verdict}`, 'ok');
  return { project, written, preview };
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
async function tryPatch(project, errorText) {
  const patch = window.buildgpt.patch;
  if (!patch) return null;

  const loc = patch.parseErrorLocation(errorText);
  if (!loc) return null;

  let source;
  try {
    source = await fs.read(`${project}/${loc.file}`);
  } catch {
    return null; // the trace names a file we did not write
  }

  log(`patching ${loc.file}:${loc.line} instead of rewriting it`, 'ok');
  status(`${ROLES.builder.toUpperCase()}: patching ${loc.file}`);

  let reply;
  try {
    reply = await askRole(
      ROLES.builder,
      `This file is throwing an error at line ${loc.line}.\n\n` +
        `ERROR:\n${condense(errorText, 800)}\n\n` +
        `FILE (${loc.file}), lines around the error:\n${patch.excerpt(source, loc.line)}\n\n` +
        patch.PATCH_FORMAT
    );
  } catch (e) {
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

  const res = await fs.write(`${project}/${loc.file}`, text);
  log(`patched ${applied.length} hunk(s) in ${loc.file} (${res.bytes} bytes)`, 'ok');
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
      `Screenshot of the running project at ${url}.\n` +
        `REQUEST: ${request}\n` +
        (drove ? `The harness already ${drove}, so this is the app in use.\n` : '') +
        (runOutput ? `Program output:\n${runOutput}\n` : '') +
        (diagnostics ? `Errors detected on the page:\n${diagnostics}\n` : '') +
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
      `OUTPUT:\n${output}\n\nREQUEST: ${request}\n\n` +
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
      `This is a screenshot of the running project at ${url}.\n` +
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
    const pass = /\bPASS\b/i.test(t) && !/\bFIX\b/i.test(t);
    const fix = /\bFIX\b/i.test(t);
    return { pass, fix, detail: pass ? null : t.replace(/^.*\bFIX\b[:\s-]*/is, '').split('\n')[0] };
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
      `OUTPUT (tail):\n${tail}\n\n` +
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
  markBusy(tag, true);
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

els.run.addEventListener('click', async () => {
  const request = els.prompt.value.trim();
  if (!request || running) return;
  running = true; abort = false;
  els.run.disabled = true; els.stop.disabled = false;
  try {
    await runProject(request);
    status('done');
  } catch (err) {
    log(String(err.message || err), 'err');
    status('failed');
  } finally {
    running = false;
    // Our own relay messages are now all over the transcript; hold autopilot
    // off long enough to re-baseline against them.
    autopilotCooldownUntil = Date.now() + 30000;
    watchBaseline = null;
    els.run.disabled = false; els.stop.disabled = true;
  }
});

els.stop.addEventListener('click', () => { abort = true; log('stop requested'); });

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

for (const tag of TAGS_ALL) {
  const sel = modelSelect(tag);
  sel.addEventListener('change', async () => {
    if (!sel.value) return;
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

async function pollAutopilot() {
  if (!autopilot || running || pollInFlight) return;
  pollInFlight = true;
  try {
    // After a run ends, the transcript is full of our own messages. Re-baseline
    // instead of reading them as a new instruction.
    if (Date.now() < autopilotCooldownUntil) {
      watchBaseline = null;
      return;
    }
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

    // Read only the DELTA since the baseline: a fixed-size tail drags earlier
    // protocol traffic into view, which either vetoes real requests or feeds
    // stale text into the build.
    const delta = Math.min(Math.max(settled - watchBaseline, 0) + 100, 4000);
    watchBaseline = settled;
    const text = await drive(els.a, 'transcriptTail', { tail: delta }, 8000).catch(() => '');
    const request = protocol.clean(text);
    if (!request) return;
    if (request.length < 12) return;            // "DONE", "ok", stray words
    if (PROTOCOL_WORDS.test(request)) return;
    if (OWN_TRAFFIC.test(request)) return;      // our own relay, not a human

    if (running) return; // a Run started while we were settling
    log('autopilot: new chat message detected, taking over', 'ok');
    await runAutopilot(request);
  } finally {
    pollInFlight = false;
  }
}

async function runAutopilot(request) {
  if (running) return;
  running = true;
  els.run.disabled = true;
  els.stop.disabled = false;
  try {
    els.prompt.value = request;
    // A fresh autopilot request gets its own folder; reusing the previous slug
    // would pollute the new project with the old one's files.
    els.project.value = protocol.slug(request);
    const { project, written } = await runProject(request);

    // Tell the user, in the chat they used, that the job is finished. Do NOT
    // invite a reply - a one-word answer here once relaunched the whole build.
    const summary =
      `The build is complete. ${written.length} file(s) written to ` +
      `workspace/${project}/: ${written.join(', ')}. ` +
      `No reply needed - type a new request whenever you want the next build.`;
    await ask(els.a, summary).catch(() => {});
    log(`autopilot: reported completion in chat — ${written.length} file(s)`, 'ok');
    status('done');
  } catch (err) {
    log(`autopilot failed: ${err.message}`, 'err');
    status('failed');
  } finally {
    running = false;
    autopilotCooldownUntil = Date.now() + 30000;
    els.run.disabled = false;
    els.stop.disabled = true;
    watchBaseline = await tabTranscript(els.a).catch(() => null);
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

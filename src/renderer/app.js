'use strict';
/* Orchestrator. Drives two Notion webviews through the planner/builder loop. */

const { protocol, fs, session, tabs, preloadPath, partition } = window.notioned;

const els = {
  a: document.getElementById('tab-a'),
  b: document.getElementById('tab-b'),
  run: document.getElementById('btn-run'),
  stop: document.getElementById('btn-stop'),
  seed: document.getElementById('btn-seed'),
  probe: document.getElementById('btn-probe'),
  prompt: document.getElementById('prompt'),
  project: document.getElementById('project'),
  retries: document.getElementById('retries'),
  maxfiles: document.getElementById('maxfiles'),
  selftest: document.getElementById('btn-selftest'),
  autopilot: document.getElementById('btn-autopilot'),
  modelA: document.getElementById('model-a'),
  modelB: document.getElementById('model-b'),
  log: document.getElementById('log'),
  files: document.getElementById('files'),
  status: document.getElementById('status'),
  login: document.getElementById('login'),
  logout: document.getElementById('btn-logout'),
};

for (const wv of [els.a, els.b]) {
  wv.setAttribute('preload', preloadPath);
  wv.setAttribute('partition', partition);
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
const status = (s) => (els.status.textContent = s);

/* ------------------------------------------------------- webview bridging */

let seq = 0;
const pending = new Map();

function bind(wv, tag) {
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
bind(els.a, 'A');
bind(els.b, 'B');

function drive(wv, cmd, args = {}, timeoutMs = 200000) {
  const id = ++seq;
  // Only one webview holds keyboard focus at a time, and a contenteditable
  // ignores synthetic input when its webContents is unfocused. Focus the
  // target tab before every command that touches the composer.
  if (cmd === 'ask' || cmd === 'selftest') {
    try { wv.focus(); } catch { /* not attached yet */ }
  }
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    wv.send('drive', { id, cmd, args });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${cmd} timed out`));
    }, timeoutMs);
  });
}

/** Letters and digits only — survives Notion's markdown auto-formatting. */
const normalizeForCompare = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Send `text` to a tab and return its reply.
 *
 * Typing goes through the main process (webContents.insertText) rather than
 * synthetic DOM events, so it works even when the window is in the background.
 * Sending prefers Notion's own button and falls back to a real Enter key event.
 */
async function ask(wv, text, opts) {
  const id = wv.getWebContentsId();

  await drive(wv, 'prepare', {}, 15000);
  await tabs.type(id, text);

  // Confirm the text actually landed before sending - otherwise we would send
  // an empty prompt and then wait three minutes for a reply that never comes.
  //
  // Notion auto-formats markdown as you type, so the composer's text is not
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

  // The composer is briefly non-interactive while Notion is still rendering a
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

  // awaitReply needs the prompt so it can find and skip our own echo.
  return drive(wv, 'awaitReply', { opts: { ...opts, text } }, 260000);
}

/* ------------------------------------------------------------- the loop */

/** Build one file: B writes it, A reviews it, we save it. Returns bytes or null. */
async function buildFile(project, filePath, request) {
  const maxRetries = Number(els.retries.value) || 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (abort) throw new Error('stopped');

    status(`B: building ${filePath} (try ${attempt + 1})`);
    const buildReply = await ask(els.b, protocol.TAGS.build(filePath, request));
    const candidate = protocol.unfence(buildReply);
    const bad = protocol.rejectReason(candidate);
    if (bad) {
      log(`B output rejected (${bad}), retrying`, 'err');
      continue;
    }
    log(`B returned ${candidate.length} chars`, 'b');

    status('A: reviewing');
    const verdictReply = await ask(els.a, protocol.TAGS.review(filePath, candidate));
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
 * Notion AI sometimes drops into an agent mode and answers with tool chatter
 * instead of obeying the one-line contract. Re-asking with an explicit nudge
 * recovers it, which is cheaper than failing the whole run.
 */
async function askForPath(prompt) {
  let reply = await ask(els.a, prompt);
  log(`A raw: ${reply.slice(0, 200)}`, 'a');
  if (protocol.parsePath(reply)) return reply;

  log('planner broke contract — re-asking with a nudge', 'err');
  reply = await ask(
    els.a,
    'Do not use any tools and do not write any files yourself. ' +
      'Reply with ONE line only: the relative file path. Nothing else.'
  );
  log(`A retry: ${reply.slice(0, 200)}`, 'a');
  return reply;
}

async function runProject(request) {
  const project = protocol.slug(els.project.value || request);
  const maxFiles = Number(els.maxfiles.value) || 1;
  els.project.value = project;
  log(`project → workspace/${project}/`, 'ok');

  // First path comes from the plain REQUEST; later ones from the WRITTEN block.
  status('A: asking for path');
  let reply = await askForPath(protocol.TAGS.request(request));

  const written = [];
  for (let i = 0; i < maxFiles; i++) {
    if (abort) throw new Error('stopped');

    const filePath = protocol.parsePath(reply);
    if (filePath === 'DONE') { log('planner says DONE', 'ok'); break; }
    if (!filePath) throw new Error('planner did not return a usable path');
    if (written.includes(filePath)) {
      log(`planner repeated ${filePath}, treating as done`, 'err');
      break;
    }
    log(`path = ${filePath}`, 'ok');

    const res = await buildFile(project, filePath, request);
    if (!res) throw new Error(`never got PRINT for ${filePath}`);
    written.push(filePath);

    status('A: next file?');
    reply = await askForPath(protocol.TAGS.next(written));
  }

  log(`project done — ${written.length} file(s) in workspace/${project}/`, 'ok');
  return { project, written };
}

/* ---------------------------------------------------------------- actions */

async function seedRoles() {
  status('seeding roles');
  log('seeding A = planner, B = builder');
  await ask(els.a, protocol.PLANNER_SYSTEM + '\n\nReply with exactly: READY');
  await ask(els.b, protocol.BUILDER_SYSTEM + '\n\nReply with exactly: READY');
  log('roles seeded', 'ok');
  status('idle');
}

async function refreshFiles() {
  const list = await fs.list();
  els.files.innerHTML = '';
  for (const f of list) {
    const li = document.createElement('li');
    li.textContent = f;
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
    els.run.disabled = false; els.stop.disabled = true;
  }
});

els.stop.addEventListener('click', () => { abort = true; log('stop requested'); });
els.seed.addEventListener('click', () => seedRoles().catch((e) => log(String(e), 'err')));

els.probe.addEventListener('click', async () => {
  for (const [tag, wv] of [['A', els.a], ['B', els.b]]) {
    try {
      log(`${tag} probe: ${JSON.stringify(await drive(wv, 'probe', {}, 8000))}`);
    } catch (e) {
      log(`${tag} probe failed: ${e.message}`, 'err');
    }
  }
});

/* ----------------------------------------------------------------- models */

async function loadModels(tag) {
  const wv = tag === 'a' ? els.a : els.b;
  const sel = tag === 'a' ? els.modelA : els.modelB;
  status(`${tag.toUpperCase()}: reading models`);
  try {
    const { current, models } = await drive(wv, 'listModels', {}, 15000);
    sel.innerHTML = '';
    for (const m of models) {
      const o = document.createElement('option');
      o.value = m;
      o.textContent = m;
      if (m === current) o.selected = true;
      sel.appendChild(o);
    }
    if (!models.length) {
      sel.innerHTML = '<option value="">none found</option>';
      log(`${tag.toUpperCase()}: no models found — use Pick → ${tag.toUpperCase()} model`, 'err');
    } else {
      log(`${tag.toUpperCase()}: ${models.length} models, current "${current}"`, 'ok');
    }
  } catch (e) {
    log(`${tag.toUpperCase()} model list failed: ${e.message}`, 'err');
  }
  status('idle');
}

for (const btn of document.querySelectorAll('[data-models]')) {
  btn.addEventListener('click', () => loadModels(btn.dataset.models));
}

for (const [tag, sel] of [['a', els.modelA], ['b', els.modelB]]) {
  sel.addEventListener('change', async () => {
    if (!sel.value) return;
    const wv = tag === 'a' ? els.a : els.b;
    try {
      const r = await drive(wv, 'selectModel', { name: sel.value }, 20000);
      log(`${tag.toUpperCase()}: model → ${r.selected}${r.alreadyActive ? ' (already)' : ''}`, 'ok');
    } catch (e) {
      log(`${tag.toUpperCase()} model select failed: ${e.message}`, 'err');
    }
  });
}

/* -------------------------------------------------------------- self test */

els.selftest.addEventListener('click', async () => {
  status('self-testing');
  let allPass = true;
  for (const [tag, wv] of [['A', els.a], ['B', els.b]]) {
    try {
      const r = await drive(wv, 'selftest', {}, 30000);
      const checks = [...r.checks];

      // Typing and the send button can only be verified together: Notion does
      // not render a send control until the composer has content. Type a
      // marker through the real input path, inspect, then clear without sending.
      // No markdown-trigger characters: Notion would rewrite them mid-typing
      // and the composer would end up empty, which also hides the send button.
      const marker = 'notioned selftest ping';
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
    drive(tab === 'a' ? els.a : els.b, 'pick', { which }, 5000).catch(() => {});
    log(`click the ${which} in tab ${tab.toUpperCase()}`);
  });
});

/* ----------------------------------------------------------- autopilot */

/**
 * Hands-off mode. You type ONE message into tab A's Notion chat yourself; the
 * system notices it, runs the whole planner/builder/review loop to completion,
 * and then posts a summary back into that same chat so you learn it is done
 * without watching the app.
 */
let autopilot = false;
let watchBaseline = null;

async function tabTranscript(wv) {
  const probe = await drive(wv, 'probe', {}, 8000);
  return probe.transcriptChars;
}

/** Read what the planner said last, as the starting path for a run. */
async function pollAutopilot() {
  if (!autopilot || running) return;
  let chars;
  try {
    chars = await tabTranscript(els.a);
  } catch {
    return;
  }

  if (watchBaseline === null) { watchBaseline = chars; return; }
  if (chars <= watchBaseline) return;

  // Something arrived. Let it settle before reading, so we do not grab a
  // half-streamed reply.
  await new Promise((r) => setTimeout(r, 4000));
  const settled = await tabTranscript(els.a).catch(() => chars);
  if (settled !== chars) return; // still streaming — check again next tick

  watchBaseline = settled;
  const text = await drive(els.a, 'transcriptTail', { tail: 1200 }, 8000).catch(() => '');
  const request = protocol.clean(text);
  if (!request) return;

  log('autopilot: new chat message detected, taking over', 'ok');
  await runAutopilot(request);
}

async function runAutopilot(request) {
  running = true;
  els.run.disabled = true;
  els.stop.disabled = false;
  try {
    els.prompt.value = request;
    const { project, written } = await runProject(request);

    // Tell the user, in the chat they used, that the job is finished.
    const summary =
      `The build is complete. ${written.length} file(s) written to ` +
      `workspace/${project}/: ${written.join(', ')}. ` +
      `Reply DONE to acknowledge.`;
    await ask(els.a, summary).catch(() => {});
    log(`autopilot: reported completion in chat — ${written.length} file(s)`, 'ok');
    status('autopilot: done');
  } catch (err) {
    log(`autopilot failed: ${err.message}`, 'err');
    status('autopilot: failed');
  } finally {
    running = false;
    els.run.disabled = false;
    els.stop.disabled = true;
    watchBaseline = await tabTranscript(els.a).catch(() => null);
  }
}

els.autopilot.addEventListener('click', async () => {
  autopilot = !autopilot;
  els.autopilot.classList.toggle('primary', autopilot);
  els.autopilot.textContent = autopilot ? 'Autopilot: ON' : 'Autopilot';
  if (autopilot) {
    watchBaseline = await tabTranscript(els.a).catch(() => null);
    log('autopilot ON — type your request into the LEFT Notion chat, once.', 'ok');
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
  els.login.className = 'pill ' + (s.loggedIn ? 'in' : 'out');
  els.login.textContent = s.loggedIn
    ? `session saved · token_v2 → ${s.cookies.token_v2}`
    : 'not logged in — log in on the left tab';
  els.login.title = `profile: ${s.profileDir}\ncookies: ${s.total}`;

  if (wasLoggedIn === false && s.loggedIn) {
    await session.flush();
    log('login captured and flushed to disk — it will survive restarts', 'ok');
    log('both tabs share this session, so tab B is signed in too', 'ok');
  }
  wasLoggedIn = s.loggedIn;
}

els.logout.addEventListener('click', async () => {
  await session.clear();
  log('saved session wiped', 'err');
  els.a.reload();
  els.b.reload();
  refreshLogin();
});

// Reloading a tab after login is what makes the second tab pick up the session.
for (const wv of [els.a, els.b]) {
  wv.addEventListener('did-navigate', refreshLogin);
  wv.addEventListener('did-navigate-in-page', refreshLogin);
}
setInterval(refreshLogin, 4000);
refreshLogin();

refreshFiles();
log('ready. log into Notion in the LEFT tab only — the right tab shares it.');

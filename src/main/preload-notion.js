'use strict';
/**
 * Injected into every Notion AI tab. Owns all DOM knowledge.
 *
 * Notion's markup changes without warning, so nothing here hardcodes a Notion
 * class name. We find the composer heuristically, and the user can override
 * both selectors at runtime via "pick mode" (click the element, we remember it).
 */
const { ipcRenderer } = require('electron');

const state = {
  composerSelector: null, // user-picked override
  outputSelector: null,   // user-picked override
  sendSelector: null,     // user-picked override
  modelSelector: null,    // user-picked override for the model dropdown trigger
  picking: null,          // 'composer' | 'output' | 'send' | 'model' | null
};

/** Names Notion currently exposes; used to recognise the model dropdown. */
const MODEL_HINT =
  /\b(claude|opus|sonnet|haiku|fable|gpt|o\d|gemini|llama|mistral|mixtral|deepseek|grok|kimi|glm|qwen|nova|command|notion ai|auto|default)\b/i;

/* ------------------------------------------------------------------ utils */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cssPath(el) {
  // Short, reasonably stable path: prefer id, then data-* attrs, then nth-child.
  const parts = [];
  for (let n = el; n && n.nodeType === 1 && parts.length < 6; n = n.parentElement) {
    if (n.id) { parts.unshift(`#${CSS.escape(n.id)}`); break; }
    const dataAttr = [...n.attributes].find((a) => a.name.startsWith('data-') && a.value);
    if (dataAttr) {
      parts.unshift(`${n.tagName.toLowerCase()}[${dataAttr.name}="${CSS.escape(dataAttr.value)}"]`);
      continue;
    }
    const idx = n.parentElement ? [...n.parentElement.children].indexOf(n) + 1 : 1;
    parts.unshift(`${n.tagName.toLowerCase()}:nth-child(${idx})`);
  }
  return parts.join(' > ');
}

/**
 * `min` is the smallest edge we accept. It defaults small because Notion's send
 * control is a 28px icon button - an earlier 40px floor silently filtered it
 * out. Composer detection passes a larger floor of its own.
 */
function visible(el, min = 8) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width < min || r.height < min) return false;
  const s = getComputedStyle(el);
  return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
}

/** The message input box. */
function findComposer() {
  if (state.composerSelector) {
    const el = document.querySelector(state.composerSelector);
    if (visible(el)) return el;
  }
  const candidates = [
    ...document.querySelectorAll(
      '[contenteditable="true"], textarea, [role="textbox"]'
    ),
  ].filter((el) => visible(el, 40)); // a composer is never a tiny icon
  if (!candidates.length) return null;
  // The composer is the lowest one on screen (Notion puts it at the bottom).
  return candidates.sort(
    (a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top
  )[0];
}

/** The scroll container holding the conversation. */
function findOutputRoot() {
  if (state.outputSelector) {
    const el = document.querySelector(state.outputSelector);
    if (el) return el;
  }
  const composer = findComposer();
  // Walk up from the composer looking for a scrollable ancestor.
  let node = composer;
  while (node && node.parentElement) {
    node = node.parentElement;
    const s = getComputedStyle(node);
    if (
      (s.overflowY === 'auto' || s.overflowY === 'scroll') &&
      node.scrollHeight > node.clientHeight
    ) {
      return node;
    }
  }
  // Notion's message scroller is often a sibling of the composer, not an
  // ancestor. Fall back to the largest scrollable region on the page.
  const scrollers = [...document.querySelectorAll('div, main, section')]
    .filter((el) => {
      const s = getComputedStyle(el);
      if (s.overflowY !== 'auto' && s.overflowY !== 'scroll') return false;
      const r = el.getBoundingClientRect();
      return r.height > 200 && r.width > 200;
    })
    .sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return ra.width * ra.height - rb.width * rb.height;
    });
  if (scrollers.length) return scrollers.pop();

  return document.querySelector('main') || document.body;
}

/* ------------------------------------------------------------------ typing */

function focusEl(el) {
  el.scrollIntoView({ block: 'center' });
  el.focus();
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  el.click();
}

/**
 * Insert text without triggering Notion's markdown/slash-command handlers more
 * than necessary. beforeinput+insertText is what a real paste looks like to
 * ProseMirror-style editors.
 */
function insertText(el, text) {
  focusEl(el);
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    const setter = Object.getOwnPropertyDescriptor(
      el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      'value'
    ).set;
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  // contenteditable: clear then paste.
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);
  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  el.dispatchEvent(
    new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })
  );
  // Fallback for editors that ignore synthetic paste.
  if (!el.textContent.trim()) document.execCommand('insertText', false, text);
}

/**
 * Notion's send control. Preferred over Enter: Enter can insert a newline in a
 * rich-text composer, or be swallowed by an open slash-command menu.
 * Identified by aria-label / icon semantics, and by sitting to the right of and
 * vertically aligned with the composer.
 */
function findSendButton() {
  if (state.sendSelector) {
    const el = document.querySelector(state.sendSelector);
    if (visible(el)) return el;
  }
  const composer = findComposer();
  if (!composer) return null;
  const cr = composer.getBoundingClientRect();

  // The model dropdown sits in the same toolbar and would otherwise win on
  // position alone - clicking it opens a menu instead of sending.
  const modelTrigger = findModelTrigger();

  const all = [...document.querySelectorAll('button, [role="button"]')].filter(
    (b) => visible(b) && !b.disabled && b !== modelTrigger
  );

  const byLabel = all.filter((b) => {
    const label = `${b.getAttribute('aria-label') || ''} ${b.title || ''}`;
    return /\b(send|submit)\b/i.test(label);
  });
  if (byLabel.length) return byLabel[0];

  const near = all.filter((b) => {
    const r = b.getBoundingClientRect();
    const alignedVertically = r.top < cr.bottom + 60 && r.bottom > cr.top - 60;
    const rightOfCenter = r.left > cr.left + cr.width * 0.5;
    const smallish = r.width < 120 && r.height < 80;
    return alignedVertically && rightOfCenter && smallish;
  });

  // Send is an icon button: no text of its own. Anything with a word in it is
  // a mode/model/attachment control, not send.
  const iconOnly = near.filter((b) => !(b.textContent || '').trim());
  const pool = iconOnly.length ? iconOnly : near.filter((b) => !MODEL_HINT.test(b.textContent || ''));

  // Rightmost wins - send sits at the end of the toolbar.
  return pool.sort(
    (a, b) => a.getBoundingClientRect().right - b.getBoundingClientRect().right
  ).pop() || null;
}

function pressEnter(el) {
  for (const type of ['keydown', 'keypress', 'keyup']) {
    el.dispatchEvent(
      new KeyboardEvent(type, {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      })
    );
  }
}

/* ----------------------------------------------------------------- models */

/**
 * The control that opens the model list. It lives in the composer's toolbar and
 * its label is the currently-selected model, so we match on model-ish text
 * within the composer's own container rather than anywhere on the page.
 */
function findModelTrigger() {
  if (state.modelSelector) {
    const el = document.querySelector(state.modelSelector);
    if (visible(el)) return el;
  }
  const composer = findComposer();
  if (!composer) return null;
  const cr = composer.getBoundingClientRect();

  // Locate it by position, not by DOM depth: the toolbar's nesting changes with
  // viewport size (it sits deeper when a tab is only a quarter of the window),
  // which silently broke an earlier ancestor-climbing version of this.
  const buttons = [
    ...document.querySelectorAll('button, [role="button"], [role="combobox"]'),
  ]
    .filter(visible)
    .filter((b) => {
      const r = b.getBoundingClientRect();
      const nearComposer = r.top < cr.bottom + 80 && r.bottom > cr.top - 80;
      const t = (b.textContent || '').trim();
      return nearComposer && t.length > 0 && t.length < 40 && MODEL_HINT.test(t);
    })
    .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);

  return buttons[0] || null;
}

function openMenuItems() {
  const items = [
    ...document.querySelectorAll(
      '[role="menuitem"], [role="option"], [role="menuitemradio"]'
    ),
  ].filter(visible);
  return items.map((el) => ({ el, label: (el.innerText || '').trim().split('\n')[0] }));
}

/** Open the dropdown, read every model, close it again. Non-destructive. */
async function listModels() {
  const trigger = findModelTrigger();
  if (!trigger) throw new Error('model dropdown not found - use Pick Model');
  const current = (trigger.textContent || '').trim();

  trigger.click();

  // Wait for menu items that actually have text. Waiting only for the items to
  // exist wins the race too early: they mount before their labels render, so we
  // read a list of empty strings and conclude there are no models.
  let labels = [];
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    labels = openMenuItems()
      .map((it) => it.label)
      .filter((l) => l && MODEL_HINT.test(l));
    if (labels.length >= 2) {
      await sleep(250); // let the rest of the list paint
      labels = openMenuItems()
        .map((it) => it.label)
        .filter((l) => l && MODEL_HINT.test(l));
      break;
    }
  }
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(150);
  return { current, models: [...new Set(labels)] };
}

/** Open the dropdown and click the entry matching `name`. */
async function selectModel(name) {
  const trigger = findModelTrigger();
  if (!trigger) throw new Error('model dropdown not found - use Pick Model');
  if ((trigger.textContent || '').trim().toLowerCase() === name.toLowerCase()) {
    return { selected: name, alreadyActive: true };
  }
  trigger.click();

  let match = null;
  for (let i = 0; i < 20 && !match; i++) {
    await sleep(100);
    const items = openMenuItems();
    match =
      items.find((it) => it.label.toLowerCase() === name.toLowerCase()) ||
      items.find((it) => it.label.toLowerCase().includes(name.toLowerCase()));
  }
  if (!match) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    throw new Error(`model "${name}" not in the list`);
  }
  match.el.click();
  await sleep(400);
  return { selected: (findModelTrigger()?.textContent || '').trim() || name };
}

/* ---------------------------------------------------------------- reading */

function transcript() {
  const root = findOutputRoot();
  return root ? root.innerText : '';
}

/* ---------------------------------------------------- main-process typing */

/**
 * Focus and empty the composer, and snapshot the transcript.
 *
 * Text itself is injected by the main process via webContents.insertText,
 * because synthetic key/paste events are untrusted: ProseMirror ignores them
 * whenever the window is not OS-focused. The main process does not care about
 * focus, which is what makes unattended runs reliable.
 */
function prepare() {
  const composer = findComposer();
  if (!composer) throw new Error('composer not found - use Pick Composer');
  focusEl(composer);
  if (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT') {
    insertText(composer, '');
  } else {
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
  }
  state.before = transcript();
  return { before: state.before.length };
}

/** Click Notion's send control. Returns false if we could not find one. */
function clickSend() {
  const btn = findSendButton();
  if (!btn || btn.disabled) return false;
  btn.click();
  return true;
}

/** True once the composer actually holds our text (so we know typing landed). */
function composerText() {
  const c = findComposer();
  return c ? (c.innerText ?? c.value ?? '') : '';
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Status lines Notion shows while it works - never part of an answer.
 * Notion AI can enter an agent mode that emits tool chatter ("Writing file",
 * "Loaded Computer tools"); treating those as a finished reply is what made
 * early runs return junk, so they are filtered and they do not count as output.
 */
const PLACEHOLDER =
  /^(generating|thinking|searching|working|loading|writing file|reading file|creating|crafting|drafting|composing|reviewing|preparing|analyz\w*|planning|browsing|running|loaded [\w\s]*tools?|using [\w\s]*tool|alpha|…|\.{3})[\s.…]*$/i;

/**
 * Everything after the echo of our own prompt.
 *
 * Notion renders the message we sent into the transcript, so raw "text added
 * since we sent" always begins with our own words. We anchor on the tail of the
 * prompt and take what follows.
 */
function afterEcho(text, full) {
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
  for (const anchor of [lines[lines.length - 1], lines[0]]) {
    if (!anchor || anchor.length < 8) continue;
    const i = full.lastIndexOf(anchor);
    if (i !== -1) return full.slice(i + anchor.length);
  }
  return null;
}

/**
 * Wait for a genuine reply.
 *
 * Three conditions, all required: our prompt's echo has appeared, real content
 * exists after it, and that content is neither a streaming placeholder nor
 * still changing. Waiting on "transcript stopped growing" alone is not enough -
 * the echo itself is growth, and it settles before the model starts answering.
 */
async function awaitReply(opts = {}) {
  const text = opts.text || '';
  // Agent mode can sit on an unchanged status line for seconds at a time, so
  // "quiet" has to be longer than the gap between its tool steps.
  const quietMs = opts.quietMs ?? 5000;
  const timeoutMs = opts.timeoutMs ?? 300000;
  const before = state.before ?? '';
  const started = Date.now();

  // 1. Wait for our own message to show up in the transcript.
  let echoSeen = false;
  const wanted = norm(text).slice(0, 40);
  while (Date.now() - started < 30000) {
    if (norm(transcript()).includes(wanted)) { echoSeen = true; break; }
    await sleep(250);
  }

  // 2. Wait for content after the echo to appear, settle, and not be a placeholder.
  let lastDelta = null;
  let lastChange = Date.now();

  while (Date.now() - started < timeoutMs) {
    await sleep(400);
    const full = transcript();

    let delta = echoSeen ? afterEcho(text, full) : null;
    if (delta === null) {
      delta = full.startsWith(before) ? full.slice(before.length) : full;
    }
    delta = delta.trim();

    // Drop trailing placeholder lines while the model is still streaming.
    const meaningful = delta
      .split('\n')
      .filter((l) => l.trim() && !PLACEHOLDER.test(l.trim()))
      .join('\n')
      .trim();

    if (meaningful !== lastDelta) {
      lastDelta = meaningful;
      lastChange = Date.now();
      continue;
    }
    if (meaningful && Date.now() - lastChange > quietMs) return meaningful;
  }

  if (lastDelta) return lastDelta;
  throw new Error('no response detected before timeout');
}

/** Diagnostic: open the model menu and report what the DOM actually contains. */
async function dumpMenu() {
  const trigger = findModelTrigger();
  if (!trigger) return { error: 'no model trigger found' };
  const label = (trigger.textContent || '').trim();
  trigger.click();
  await sleep(1500);

  const q = (s) => document.querySelectorAll(s).length;
  const pool = [
    ...document.querySelectorAll(
      '[role="menu"] *, [role="listbox"] *, [role="dialog"] *, [data-overlay] *'
    ),
  ];
  const sample = pool
    .map((e) => (e.innerText || '').trim().split('\n')[0])
    .filter((t) => t && t.length < 32);

  const out = {
    trigger: label,
    menuitem: q('[role="menuitem"]'),
    option: q('[role="option"]'),
    radio: q('[role="menuitemradio"]'),
    containers: q('[role="menu"], [role="listbox"], [role="dialog"]'),
    sample: [...new Set(sample)].slice(0, 30),
  };
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return out;
}

/** Empty the composer without sending. */
function clearComposer() {
  const c = findComposer();
  if (!c) return false;
  focusEl(c);
  if (c.tagName === 'TEXTAREA' || c.tagName === 'INPUT') insertText(c, '');
  else {
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
  }
  return true;
}

/** Describe the send control, if one is currently rendered. */
function describeSend() {
  const b = findSendButton();
  if (!b) return false;
  return (b.getAttribute('aria-label') || b.title || b.textContent || 'icon button').trim() ||
    'icon button';
}

/** Diagnostic: what buttons actually surround the composer? */
function dumpButtons() {
  const composer = findComposer();
  if (!composer) return [];
  const cr = composer.getBoundingClientRect();
  return [...document.querySelectorAll('button, [role="button"]')]
    .filter(visible)
    .filter((b) => {
      const r = b.getBoundingClientRect();
      return r.top < cr.bottom + 80 && r.bottom > cr.top - 80;
    })
    .map((b) => {
      const r = b.getBoundingClientRect();
      return {
        text: (b.textContent || '').trim().slice(0, 24),
        aria: b.getAttribute('aria-label'),
        disabled: !!b.disabled,
        x: Math.round(r.left), right: Math.round(r.right),
        w: Math.round(r.width), h: Math.round(r.height),
        svg: !!b.querySelector('svg'),
      };
    })
    .sort((a, b) => a.x - b.x);
}

/**
 * Legacy single-shot path, kept for the in-page self-test.
 */
async function ask(text, opts = {}) {
  const quietMs = opts.quietMs ?? 1800;
  const timeoutMs = opts.timeoutMs ?? 180000;

  const composer = findComposer();
  if (!composer) throw new Error('composer not found - use Pick Composer');

  const before = transcript();
  insertText(composer, text);
  await sleep(300);

  // Prefer the real send button; Enter is the fallback for when we can't find it.
  const btn = findSendButton();
  if (btn && !btn.disabled) {
    btn.click();
    await sleep(200);
    // If the composer still holds our text, the click missed - fall back.
    if ((composer.innerText || composer.value || '').trim().startsWith(text.slice(0, 30))) {
      pressEnter(composer);
    }
  } else {
    pressEnter(composer);
  }

  const started = Date.now();
  let last = before;
  let lastChange = Date.now();
  let grew = false;

  while (Date.now() - started < timeoutMs) {
    await sleep(300);
    const now = transcript();
    if (now !== last) {
      last = now;
      lastChange = Date.now();
      if (now.length > before.length) grew = true;
    } else if (grew && Date.now() - lastChange > quietMs) {
      break;
    }
  }
  if (!grew) throw new Error('no response detected before timeout');

  // The reply is whatever was appended after our own echoed prompt.
  let delta = last.startsWith(before) ? last.slice(before.length) : last;
  const echo = delta.indexOf(text.slice(0, 60));
  if (echo !== -1) delta = delta.slice(echo + text.length);
  return delta.trim();
}

/* -------------------------------------------------------------- new chat */

/**
 * Start a fresh conversation. Long transcripts get virtualized by Notion -
 * old messages unmount as new ones stream - which blinds the growth-based
 * reply detector. Rotating to a new chat resets that cleanly.
 */
async function newChat() {
  const btn = [...document.querySelectorAll('button, [role="button"], a[href]')].find((b) => {
    const label = `${b.getAttribute('aria-label') || ''} ${b.title || ''}`;
    return /\bnew (chat|conversation)\b/i.test(label);
  });
  if (!btn) throw new Error('New chat button not found');
  btn.click();
  // The click may navigate; the fresh chat's composer mounts noticeably later.
  // Poll cheaply: findComposer first, and transcript() (expensive innerText on
  // a large DOM) only once a composer exists - constant transcript() polling
  // is what used to push this past the caller's timeout.
  for (let i = 0; i < 20; i++) {
    await sleep(400);
    const c = findComposer();
    if (!c) continue;
    const chars = transcript().length;
    if (chars < 2000) return { chars };
  }
  throw new Error('new chat did not produce a usable composer');
}

/* ------------------------------------------------------------- self test */

/**
 * Non-destructive checks against the live page. Everything here either only
 * reads, or types into the composer and then clears it again - nothing is sent
 * to Notion, so running this costs no AI credits and leaves no chat history.
 */
async function selftest() {
  const checks = [];
  const check = (name, fn) => {
    try {
      const detail = fn();
      checks.push({ name, pass: detail !== false && detail != null, detail: String(detail) });
    } catch (e) {
      checks.push({ name, pass: false, detail: String(e.message || e) });
    }
  };

  check('page is Notion', () => (/notion\.com/.test(location.host) ? location.host : false));
  check('logged in (no login form)', () =>
    document.querySelector('input[type="password"]') ? false : 'no password field'
  );

  const composer = findComposer();
  check('composer found', () => (composer ? cssPath(composer) : false));
  check('composer is editable', () =>
    composer &&
    (composer.isContentEditable || ['TEXTAREA', 'INPUT'].includes(composer.tagName))
      ? composer.tagName + (composer.isContentEditable ? '[contenteditable]' : '')
      : false
  );

  // NB: the send button is deliberately not checked here. Notion only renders
  // it once the composer has text, so it can only be verified mid-typing -
  // the renderer's self-test does that after injecting a marker.

  const root = findOutputRoot();
  check('output root found', () => (root ? cssPath(root) : false));
  check('transcript readable', () => {
    const n = transcript().length;
    return n > 0 ? `${n} chars` : false;
  });

  check('model trigger found', () => {
    const m = findModelTrigger();
    return m ? (m.textContent || '').trim() : false;
  });

  const passed = checks.filter((c) => c.pass).length;
  return { passed, total: checks.length, checks };
}

/* ------------------------------------------------------------- pick mode */

function startPick(which) {
  state.picking = which;
  document.body.style.cursor = 'crosshair';
}

document.addEventListener(
  'click',
  (e) => {
    if (!state.picking) return;
    e.preventDefault();
    e.stopPropagation();
    const sel = cssPath(e.target);
    if (state.picking === 'composer') state.composerSelector = sel;
    else if (state.picking === 'send') state.sendSelector = sel;
    else if (state.picking === 'model') state.modelSelector = sel;
    else state.outputSelector = sel;
    ipcRenderer.sendToHost('picked', { which: state.picking, selector: sel });
    state.picking = null;
    document.body.style.cursor = '';
  },
  true
);

/* --------------------------------------------------------------- bridge */

ipcRenderer.on('drive', async (_e, { id, cmd, args }) => {
  try {
    let result = null;
    if (cmd === 'ask') result = await ask(args.text, args.opts);
    else if (cmd === 'prepare') result = prepare();
    else if (cmd === 'clickSend') result = clickSend();
    else if (cmd === 'composerText') result = composerText();
    else if (cmd === 'awaitReply') result = await awaitReply(args.opts);
    else if (cmd === 'dumpButtons') result = dumpButtons();
    else if (cmd === 'clearComposer') result = clearComposer();
    else if (cmd === 'chars') result = transcript().length;
    else if (cmd === 'newChat') result = await newChat();
    else if (cmd === 'transcriptTail') {
      // The newest message, for autopilot to read what the user just typed.
      const t = transcript();
      result = t.slice(Math.max(0, t.length - (args.tail || 1200)));
    }
    else if (cmd === 'describeSend') result = describeSend();
    else if (cmd === 'dumpMenu') result = await dumpMenu();
    else if (cmd === 'pick') startPick(args.which);
    else if (cmd === 'listModels') result = await listModels();
    else if (cmd === 'selectModel') result = await selectModel(args.name);
    else if (cmd === 'selftest') result = await selftest();
    else if (cmd === 'probe') {
      const composer = findComposer();
      const send = findSendButton();
      const model = findModelTrigger();
      result = {
        url: location.href,
        composer: composer ? cssPath(composer) : null,
        sendButton: send ? (send.getAttribute('aria-label') || send.textContent || '?').trim() : null,
        modelTrigger: model ? (model.textContent || '').trim() : null,
        outputRoot: findOutputRoot() ? cssPath(findOutputRoot()) : null,
        transcriptChars: transcript().length,
        overrides: {
          composer: state.composerSelector,
          output: state.outputSelector,
          send: state.sendSelector,
          model: state.modelSelector,
        },
      };
    }
    else if (cmd === 'setSelectors') {
      if (args.composer) state.composerSelector = args.composer;
      if (args.output) state.outputSelector = args.output;
      if (args.send) state.sendSelector = args.send;
      if (args.model) state.modelSelector = args.model;
      result = true;
    } else throw new Error(`unknown cmd ${cmd}`);
    ipcRenderer.sendToHost('drive:done', { id, result });
  } catch (err) {
    ipcRenderer.sendToHost('drive:done', { id, error: String(err.message || err) });
  }
});

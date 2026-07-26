'use strict';
/**
 * Injected into every ChatGPT tab. Owns all DOM knowledge.
 *
 * OpenAI's markup changes without warning, so nothing here depends on a
 * generated class name. Known-good hooks (#prompt-textarea, data-testid
 * send-button / stop-button, data-message-author-role) are tried first and every
 * one of them falls back to the geometry/role heuristics that carried this
 * driver before, so a redesign degrades instead of breaking. The user can also
 * override every selector at runtime via "pick mode" (click the element, we
 * remember it).
 *
 * This preload is sandboxed, so it cannot require('../shared/site'): the site
 * constants it needs (new-chat label, host check) are duplicated here as local
 * regexes. Keep them in step with src/shared/site.js.
 */
const { ipcRenderer } = require('electron');

const state = {
  composerSelector: null, // user-picked override
  outputSelector: null,   // user-picked override
  sendSelector: null,     // user-picked override
  modelSelector: null,    // user-picked override for the model dropdown trigger
  picking: null,          // 'composer' | 'output' | 'send' | 'model' | null
};

/**
 * Names ChatGPT currently exposes, plus the generic families, used to recognise
 * the model dropdown. "chatgpt" is listed separately because \bgpt\b does not
 * match inside "ChatGPT" - the trigger's label is usually exactly that word.
 */
const MODEL_HINT =
  /\b(chatgpt|gpt|o\d|auto|thinking|instant|mini|pro|legacy|turbo|claude|opus|sonnet|haiku|fable|gemini|llama|mistral|mixtral|deepseek|grok|kimi|glm|qwen|nova|command|default)\b/i;

/**
 * Header controls that MODEL_HINT would otherwise claim: "Upgrade to Go",
 * "Get Plus" and friends contain model words but open a paywall, not a menu.
 */
const MODEL_DENY =
  /\b(upgrade|subscribe|renew|billing|payment|invoice|credits?|auto-?reload|admin|workspace|get (plus|pro|go)|share|new chat|log ?in|log ?out|sign ?up|sign ?in|settings|profile|invite|help|archive|library|sora|gpts|projects)\b/i;

/** Kept local because ../shared/site is unreachable from a sandboxed preload. */
const NEW_CHAT_LABEL = /\bnew chat\b/i;

/* ------------------------------------------------------------------ utils */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** querySelector that survives a selector Chromium refuses to parse. */
function q1(sel) {
  try {
    return document.querySelector(sel);
  } catch {
    return null;
  }
}

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
 * `min` is the smallest edge we accept. It defaults small because the send
 * control is a ~32px icon button - an earlier 40px floor silently filtered it
 * out. Composer detection passes a larger floor of its own.
 */
function visible(el, min = 8) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width < min || r.height < min) return false;
  const s = getComputedStyle(el);
  return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
}

const isDisabled = (el) =>
  !!el && (el.disabled === true || el.getAttribute('aria-disabled') === 'true');

/** ChatGPT's composer is a ProseMirror contenteditable, normally #prompt-textarea. */
const COMPOSER_SELECTORS = [
  '#prompt-textarea',
  'div[contenteditable="true"].ProseMirror',
  'form [contenteditable="true"]',
];

/** The message input box. */
function findComposer() {
  if (state.composerSelector) {
    const el = document.querySelector(state.composerSelector);
    if (visible(el)) return el;
  }
  // Identity beats size: when we know exactly which node it is, do not put it
  // through the "is this big enough to be a composer" filter below.
  for (const sel of COMPOSER_SELECTORS) {
    const el = q1(sel);
    if (visible(el)) return el;
  }
  const candidates = [
    ...document.querySelectorAll(
      '[contenteditable="true"], textarea, [role="textbox"]'
    ),
  ].filter((el) => visible(el, 40)); // a composer is never a tiny icon
  if (!candidates.length) return null;
  // The composer is the lowest one on screen (ChatGPT docks it to the bottom).
  return candidates.sort(
    (a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top
  )[0];
}

/** One turn of the conversation, newest last, in document order. */
function messageNodes() {
  const byRole = [...document.querySelectorAll('[data-message-author-role]')];
  if (byRole.length) return byRole;
  return [...document.querySelectorAll('article[data-testid^="conversation-turn"]')];
}

/** The scroll container holding the conversation. */
function findOutputRoot() {
  if (state.outputSelector) {
    const el = document.querySelector(state.outputSelector);
    if (el) return el;
  }
  // Anchor on a real message when there is one: the thread's scroller is its
  // nearest scrollable ancestor, and that is true whatever the layout does.
  const msgs = messageNodes();
  const scrollableAncestor = (start) => {
    for (let n = start; n && n.parentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (
        (s.overflowY === 'auto' || s.overflowY === 'scroll') &&
        n.scrollHeight > n.clientHeight &&
        n.getBoundingClientRect().height > 200
      ) {
        return n;
      }
    }
    return null;
  };
  if (msgs.length) {
    const root = scrollableAncestor(msgs[msgs.length - 1]);
    if (root) return root;
  }

  const composer = findComposer();
  const fromComposer = composer && composer.parentElement
    ? scrollableAncestor(composer.parentElement)
    : null;
  if (fromComposer) return fromComposer;

  // Last resort: the largest scrollable region on the page.
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
 * Insert text without triggering the composer's markdown/slash-command handlers
 * more than necessary. beforeinput+insertText is what a real paste looks like to
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

/* -------------------------------------------------------------- generating */

/**
 * ChatGPT swaps the send button for a stop button while it streams, so the stop
 * button is both a hazard (clicking it aborts the answer) and the single most
 * reliable "still working" signal on the page.
 */
function findStopButton() {
  const explicit = q1('[data-testid="stop-button"]');
  if (visible(explicit)) return explicit;
  return (
    [...document.querySelectorAll('button, [role="button"]')].find((b) => {
      if (!visible(b)) return false;
      const label = `${b.getAttribute('aria-label') || ''} ${b.title || ''}`;
      return /\bstop\b/i.test(label);
    }) || null
  );
}

const isGenerating = () => !!findStopButton();

/**
 * The send control. Preferred over Enter: Enter can insert a newline in a
 * rich-text composer, or be swallowed by an open slash-command menu.
 */
const SEND_DENY =
  /\b(stop|voice|dictate|dictation|microphone|mic|speech|read aloud|attach|upload|file|image|photo|camera|tools?|search|model|menu|settings|scroll|copy|edit|regenerate)\b/i;

function findSendButton() {
  if (state.sendSelector) {
    const el = document.querySelector(state.sendSelector);
    if (visible(el)) return el;
  }
  // While a reply streams this testid belongs to the stop button instead, so an
  // exact match on "send-button" can never hand back the abort control.
  const explicit = q1('[data-testid="send-button"]');
  if (visible(explicit) && !isDisabled(explicit)) return explicit;

  const composer = findComposer();
  if (!composer) return null;
  const cr = composer.getBoundingClientRect();

  // The model dropdown and the stop button both sit in reach of the composer
  // and would otherwise win on position alone - one opens a menu instead of
  // sending, the other kills the answer we are waiting for.
  const modelTrigger = findModelTrigger();
  const stop = findStopButton();

  const all = [...document.querySelectorAll('button, [role="button"]')].filter((b) => {
    if (!visible(b) || isDisabled(b) || b === modelTrigger || b === stop) return false;
    const label = `${b.getAttribute('aria-label') || ''} ${b.title || ''} ${b.getAttribute('data-testid') || ''}`;
    return !SEND_DENY.test(label);
  });

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

const MODEL_SELECTORS = [
  '[data-testid="model-switcher-dropdown-button"]',
  '[data-testid*="model-switcher"]',
  '[data-testid*="model-selector"]',
  'button[aria-label*="model" i]',
];

const HEADER_SEL =
  'header, nav, [role="banner"], [role="navigation"], [role="toolbar"], [data-testid*="header"]';

/**
 * The control that opens the model list. Its label is the currently-selected
 * model, so we match on model-ish text - but unlike Notion, ChatGPT puts it at
 * the TOP of the conversation, not in the composer's toolbar. Searching the
 * whole page and scoring header/nav placement is what replaces the old
 * proximity-to-composer geometry, which looked in exactly the wrong place.
 *
 * Must never call findSendButton: that one calls us, to exclude us.
 */
function findModelTrigger() {
  if (state.modelSelector) {
    const el = document.querySelector(state.modelSelector);
    if (visible(el)) return el;
  }
  for (const sel of MODEL_SELECTORS) {
    const el = q1(sel);
    if (visible(el)) return el;
  }

  // Only on a conversation page. On /admin/billing the scan matched a "Turn on
  // auto-reload" button (\bauto\b) and clicking it opened billing settings.
  if (!/^\/(c\/|g\/|$)/.test(location.pathname) && location.pathname !== '/') {
    return null;
  }

  const scored = [
    ...document.querySelectorAll('button, [role="button"], [role="combobox"]'),
  ]
    .filter(visible)
    // A model picker is a menu opener. Requiring the affordance rejects the
    // plain action buttons that merely happen to contain a model-ish word.
    .filter(
      (b) =>
        b.getAttribute('aria-haspopup') ||
        b.hasAttribute('aria-expanded') ||
        b.getAttribute('role') === 'combobox'
    )
    .map((b) => ({ b, t: (b.textContent || '').trim() }))
    .filter(({ t }) => {
      if (!t || t.length >= 40 || MODEL_DENY.test(t)) return false;
      // "auto" is only a model name on its own; inside a phrase it is almost
      // always something else ("auto-reload", "automatic backups").
      if (/^auto$/i.test(t)) return true;
      return MODEL_HINT.test(t) && !/\bauto-/i.test(t);
    })
    .map(({ b }) => {
      const r = b.getBoundingClientRect();
      let score = 0;
      if (b.closest(HEADER_SEL)) score += 4;
      if (b.getAttribute('aria-haspopup')) score += 3;
      if (b.hasAttribute('aria-expanded')) score += 1;
      if (r.top < 160) score += 2;
      // Anything hugging the bottom is composer furniture (attachments, tools).
      if (r.top > window.innerHeight - 200) score -= 3;
      return { b, score, top: r.top, left: r.left };
    })
    .sort((a, b) => b.score - a.score || a.top - b.top || a.left - b.left);

  return scored.length ? scored[0].b : null;
}

function openMenuItems() {
  const items = [
    ...document.querySelectorAll(
      '[role="menuitem"], [role="option"], [role="menuitemradio"]'
    ),
  ].filter(visible);
  return items.map((el) => ({ el, label: (el.innerText || '').trim().split('\n')[0] }));
}

/**
 * Close whatever popover we opened. Escape alone is not enough for every
 * portalled menu, so fall back to an outside pointer press.
 */
async function closeMenu() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(150);
  if (!openMenuItems().length) return;
  for (const type of ['pointerdown', 'mousedown', 'mouseup']) {
    document.body.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: 2, clientY: 2 }));
  }
  await sleep(150);
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
  await closeMenu();
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
    await closeMenu();
    throw new Error(`model "${name}" not in the list`);
  }
  match.el.click();
  await sleep(400);
  return { selected: (findModelTrigger()?.textContent || '').trim() || name };
}

/* ---------------------------------------------------------------- reading */

/**
 * Re-fence a rendered code block.
 *
 * innerText of a ChatGPT <pre> is "python\nCopy\nEdit\n<code>" - the toolbar is
 * inside the block - and it carries no backticks. Handing that straight to the
 * orchestrator would write "python/Copy/Edit" into the top of every generated
 * file, and protocol.unfence() would have nothing to strip. So we rebuild the
 * fence from the <code> element alone.
 */
function fenceOf(pre) {
  const code = pre.querySelector('code');
  const body = ((code || pre).innerText || '').replace(/\s+$/, '');
  const lang = (code && (String(code.className).match(/language-([\w+#-]+)/) || [])[1]) || '';
  return '```' + lang + '\n' + body + '\n```';
}

/**
 * One message as text, with its code blocks fenced.
 *
 * The substitution is done on the live innerText rather than on a clone:
 * innerText of a detached node degrades to textContent and loses every line
 * break, which would destroy the file bodies we are here to collect.
 */
function readMessage(el) {
  const text = el.innerText || '';
  const pres = el.querySelectorAll('pre');
  if (!pres.length) return text.trim();

  let out = '';
  let cursor = 0;
  for (const pre of pres) {
    const raw = (pre.innerText || '').trim();
    const i = raw ? text.indexOf(raw, cursor) : -1;
    if (i === -1) continue;
    out += text.slice(cursor, i) + fenceOf(pre);
    cursor = i + raw.length;
  }
  return (out + text.slice(cursor)).trim();
}

/**
 * The conversation as text. Reading the message nodes rather than the whole
 * scroller keeps page furniture ("ChatGPT can make mistakes", the composer
 * itself when it lives inside the scroll region) out of the delta we diff.
 */
function transcript() {
  const nodes = messageNodes();
  if (nodes.length) {
    return nodes.map(readMessage).filter(Boolean).join('\n\n');
  }
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

/** Click the send control. Returns false if we could not find one. */
function clickSend() {
  const btn = findSendButton();
  if (!btn || isDisabled(btn)) return false;
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
 * Status lines shown while the model works - never part of an answer.
 * ChatGPT surfaces reasoning and tool chatter ("Thinking", "Searching the web",
 * "Thought for 8 seconds") in the same text flow; treating those as a finished
 * reply is what made early runs return junk, so they are filtered and they do
 * not count as output.
 */
const PLACEHOLDER =
  /^(generating|thinking|reasoning|reasoned|searching|searching the web|browsing|browsing the web|finding sources|reading sources|done thinking|analyz\w*|working|loading|reading|planning|running|creating|crafting|drafting|composing|reviewing|preparing|writing file|reading file|(thought|reasoned|worked|searched|analyzed) for [\w\s.]*|loaded [\w\s]*tools?|using [\w\s]*tool|alpha|…|\.{3})[\s.…]*$/i;

/**
 * Per-message UI controls that render as text inside the transcript.
 * "Retry" is deliberately excluded: it is the reviewer's verdict word.
 */
const CHROME =
  /^(show (more|less)|copy( code)?|edit|regenerate|share|read aloud|good response|bad response)$/i;

/**
 * Everything after the echo of our own prompt.
 *
 * The message we sent is rendered into the transcript, so raw "text added since
 * we sent" always begins with our own words. We anchor on the tail of the
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
 *
 * The stop button refines that but never replaces it: while it is on screen we
 * refuse to return a half-written answer, and once we have seen it and it goes
 * away we trust a much shorter quiet period. If we never see it at all (missing
 * testid, reply finished between polls) the original timing still decides.
 */
/** No output change for this long while still generating means the tab is wedged. */
const STUCK_MS = 300000;

async function awaitReply(opts = {}) {
  const text = opts.text || '';
  // Reasoning can sit on an unchanged status line for seconds at a time, so
  // "quiet" has to be longer than the gap between its steps.
  const quietMs = opts.quietMs ?? 5000;
  // Long files legitimately take minutes; the generating state decides when
  // we are done, this is only a backstop against a dead tab.
  const timeoutMs = opts.timeoutMs ?? 600000;
  const before = state.before ?? '';
  const started = Date.now();

  // 1. Wait for our own message to show up in the transcript.
  let echoSeen = false;
  const wanted = norm(text).slice(0, 40);
  while (Date.now() - started < 30000) {
    if (norm(transcript()).includes(wanted)) { echoSeen = true; break; }
    await sleep(250);
  }

  // 2. Wait for the answer, using the UI's own generating state as the
  //    authority rather than a stopwatch.
  let lastDelta = null;
  let lastChange = Date.now();
  let sawGenerating = false;
  let idleTicks = 0; // consecutive polls with no stop button visible

  while (Date.now() - started < timeoutMs) {
    await sleep(200);
    // Sample the stop button every tick, not only once content is stable:
    // a fast reply can start and finish between two lazy checks, and never
    // "seeing" generation is what forces the slow no-signal quiet window.
    const generating = isGenerating();
    if (generating) {
      sawGenerating = true;
      idleTicks = 0;
    } else {
      idleTicks++;
    }
    const full = transcript();

    let delta = echoSeen ? afterEcho(text, full) : null;
    if (delta === null) {
      delta = full.startsWith(before) ? full.slice(before.length) : full;
    }
    delta = delta.trim();

    // Drop placeholder AND message chrome. ChatGPT collapses a long prompt
    // behind "Show more", and that button's text arriving in the transcript
    // used to look like the reply landing - the quiet window then elapsed
    // before the real answer had started streaming.
    const meaningful = delta
      .split('\n')
      .filter((l) => {
        const t = l.trim();
        return t && !PLACEHOLDER.test(t) && !CHROME.test(t);
      })
      .join('\n')
      .trim();

    if (meaningful !== lastDelta) {
      lastDelta = meaningful;
      lastChange = Date.now();
      continue;
    }

    // While the UI says it is still generating there is nothing to decide:
    // never hand back a half-written answer. Long code blocks render into a
    // <pre> whose text does not grow tick by tick, so the transcript can sit
    // unchanged for tens of seconds mid-stream - an earlier "stalled while
    // generating" escape hatch fired there and handed the reviewer 2518 chars
    // of an unfinished file. Only a stall long enough to mean the tab is
    // genuinely wedged breaks out.
    if (generating) {
      if (Date.now() - lastChange > STUCK_MS) {
        throw new Error('generation stalled - no output change in 5 minutes');
      }
      continue;
    }

    if (!meaningful) continue;

    const stableFor = Date.now() - lastChange;
    if (sawGenerating) {
      // We watched a real generation cycle begin and end. The stop button
      // flickers between tokens, so require it gone for several consecutive
      // polls as well as the content holding still.
      if (idleTicks >= 5 && stableFor > 1500) return meaningful;
    } else if (stableFor > Math.max(quietMs, 12000)) {
      // We never saw the stop button at all - a missing testid, or a reply
      // that finished between polls. With no UI signal to trust, wait far
      // longer before believing the text has stopped growing.
      return meaningful;
    }
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
      '[role="menu"] *, [role="listbox"] *, [role="dialog"] *, [data-overlay] *, ' +
      '[data-radix-popper-content-wrapper] *'
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
  await closeMenu();
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
        testid: b.getAttribute('data-testid'),
        disabled: isDisabled(b),
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
  if (btn && !isDisabled(btn)) {
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
    } else if (grew && !isGenerating() && Date.now() - lastChange > quietMs) {
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
 * Start a fresh conversation. Long transcripts get virtualized - old messages
 * unmount as new ones stream - which blinds the growth-based reply detector.
 * Rotating to a new chat resets that cleanly.
 */
async function newChat() {
  const labelled = (b) => {
    const label = `${b.getAttribute('aria-label') || ''} ${b.title || ''}`;
    return NEW_CHAT_LABEL.test(label) || /\bnew conversation\b/i.test(label);
  };
  // An untitled conversation in the sidebar is *called* "New chat", so text
  // matching alone would reopen an old thread instead of starting one. Trust
  // aria-label/testid first, and never accept a history link.
  const candidates = [...document.querySelectorAll('button, [role="button"], a[href]')];
  const byText = (b) =>
    !b.closest('a[href^="/c/"]') &&
    NEW_CHAT_LABEL.test((b.textContent || '').trim()) &&
    (b.textContent || '').trim().length < 24;

  const pool = [
    q1('[data-testid="create-new-chat-button"]'),
    ...candidates.filter(labelled),
    ...candidates.filter(byText),
  ].filter(Boolean);

  const btn = pool.find((b) => visible(b)) || pool[0];
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
 * reads, or types into the composer and then clears it again - nothing is sent,
 * so running this costs no credits and leaves no chat history.
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

  check('page is ChatGPT', () =>
    /(^|\.)(chatgpt\.com|openai\.com)$/.test(location.host) ? location.host : false
  );
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

  // NB: the send button is deliberately not checked here. ChatGPT shows a
  // voice control until the composer has text, so send can only be verified
  // mid-typing - the renderer's self-test does that after injecting a marker.

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

/* ------------------------------------------------------------ declutter */

/**
 * Account banners ChatGPT injects above the conversation ("A workspace member
 * hit a limit", upgrade nags). They steal vertical space in a quarter-screen
 * tab, and their buttons are exactly the kind of thing the model-picker scan
 * has to keep stepping around. Hidden, never clicked - this only changes what
 * is displayed, it does not dismiss or act on the notice.
 */
const BANNER_TEXT =
  /(workspace member hit a limit|turn on auto-?reload|add credits|upgrade your plan|you're out of credits)/i;

function declutter() {
  const buttons = [...document.querySelectorAll('button, a[role="button"]')];
  for (const b of buttons) {
    if (!BANNER_TEXT.test((b.textContent || '').trim())) continue;
    // Climb to the banner container: the first ancestor that is wide, short,
    // and does not contain the composer (hiding that would break the tab).
    let node = b;
    for (let i = 0; i < 6 && node.parentElement; i++) {
      node = node.parentElement;
      const r = node.getBoundingClientRect();
      if (r.width > 250 && r.height > 0 && r.height < 220 && !node.querySelector('#prompt-textarea')) {
        node.style.setProperty('display', 'none', 'important');
        break;
      }
    }
  }
}

function watchForBanners() {
  declutter();
  // Deliberately a slow poll and NOT a MutationObserver: streaming a reply
  // mutates the DOM on every token, and a full button scan per mutation
  // janked the page badly enough that the transcript looked frozen - partial
  // replies then read as "settled" and came back truncated.
  setInterval(declutter, 5000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', watchForBanners);
} else {
  watchForBanners();
}

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
        messages: messageNodes().length,
        generating: isGenerating(),
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

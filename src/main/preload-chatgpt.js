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
 * remember it) - composer, output, send, stop, model and new chat all have a
 * pick target, because any one of them going missing is enough to stall a run.
 *
 * When a hook really is gone the `health` command says so in one structured
 * report instead of leaving the caller to discover it as a ten-minute timeout.
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
  stopSelector: null,     // user-picked override for the stop/abort control
  modelSelector: null,    // user-picked override for the model dropdown trigger
  newchatSelector: null,  // user-picked override for the new-chat control
  picking: null,          // one of HOOKS, or null
  before: '',             // transcript snapshot taken by prepare()
  beforeMessages: 0,      // message count at that snapshot
};

/** Every element the driver needs. Pick targets and `health` rows follow this. */
const HOOKS = ['composer', 'output', 'send', 'stop', 'model', 'newchat'];

const OVERRIDE_KEY = {
  composer: 'composerSelector',
  output: 'outputSelector',
  send: 'sendSelector',
  stop: 'stopSelector',
  model: 'modelSelector',
  newchat: 'newchatSelector',
};

/**
 * How each hook was last located: 'picked' (user override), 'known' (a
 * documented selector) or 'heuristic' (geometry/role guessing). `health`
 * reports it, because "found by heuristic" is the early warning that the
 * markup has moved and the next release will break outright.
 */
const via = { composer: null, output: null, send: null, stop: null, model: null, newchat: null };

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

/**
 * Rows inside the open model menu that are not models: the upsell, and the
 * entries that only open another submenu. Selecting either used to be reported
 * as "model switched" while it had actually opened a paywall or left a submenu
 * hanging over the composer. Phrases, not bare words, so a real model called
 * "GPT-4o legacy" still lists.
 */
const MENU_DENY =
  /(\b(upgrade|subscribe|billing|payment|invoice|credits?|manage|see (all )?plans?|learn more|try (plus|pro|go)|get (plus|pro|go))\b|legacy models|more models|other models|temporary chat)/i;

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

/** matches() that survives a selector Chromium refuses to parse. */
function matches(el, sel) {
  try {
    return !!el && el.matches(sel);
  } catch {
    return false;
  }
}

/** sendToHost throws once the host webview is gone; nothing here may die of it. */
function emit(channel, payload) {
  try {
    ipcRenderer.sendToHost(channel, payload);
  } catch { /* host detached mid-run */ }
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

/** textContent walks the subtree but never forces layout, unlike innerText. */
const textLen = (el) => ((el && el.textContent) || '').length;

const labelOf = (el) =>
  `${(el && el.getAttribute('aria-label')) || ''} ${(el && el.title) || ''} ${(el && el.getAttribute('data-testid')) || ''}`;

/**
 * Element caches.
 *
 * findComposer/findOutputRoot/findSendButton/findModelTrigger all sit on the
 * per-poll path (transcript, isGenerating, probe) and each costs a forced
 * layout per candidate. Re-deriving them five times a second is a measurable
 * share of a streaming tab's frame budget, so each is remembered for a moment
 * and re-validated by isConnected - which is free, and is what a navigation or
 * a re-render trips.
 */
const NODE_CACHE_MS = 500;
let composerCache = { el: null, at: 0 };
let rootCache = { el: null, at: 0 };
let sendCache = { el: null, at: 0 };
let modelCache = { el: null, at: 0 };

const cacheHit = (c, ms = NODE_CACHE_MS) =>
  c.el && c.el.isConnected && Date.now() - c.at < ms;

/** A pick, a clear or a navigation makes every remembered node a guess. */
function invalidateCaches() {
  composerCache = { el: null, at: 0 };
  rootCache = { el: null, at: 0 };
  sendCache = { el: null, at: 0 };
  modelCache = { el: null, at: 0 };
  stopCache = { el: null, at: 0 };
  msgCache = { at: 0, nodes: [] };
  tCache = { at: 0, text: '' };
}

/* -------------------------------------------------------------- composer */

/** ChatGPT's composer is a ProseMirror contenteditable, normally #prompt-textarea. */
const COMPOSER_SELECTORS = [
  '#prompt-textarea',
  'div[contenteditable="true"].ProseMirror',
  'form [contenteditable="true"]',
];

/** The message input box. */
function findComposer() {
  if (cacheHit(composerCache)) return composerCache.el;
  const found = locateComposer();
  composerCache = { el: found, at: Date.now() };
  return found;
}

function locateComposer() {
  if (state.composerSelector) {
    const el = q1(state.composerSelector);
    if (visible(el)) { via.composer = 'picked'; return el; }
  }
  // Identity beats size: when we know exactly which node it is, do not put it
  // through the "is this big enough to be a composer" filter below.
  for (const sel of COMPOSER_SELECTORS) {
    const el = q1(sel);
    if (visible(el)) { via.composer = 'known'; return el; }
  }
  const candidates = [
    ...document.querySelectorAll(
      '[contenteditable="true"], textarea, [role="textbox"]'
    ),
  ].filter((el) => visible(el, 40)); // a composer is never a tiny icon
  if (!candidates.length) { via.composer = null; return null; }
  via.composer = 'heuristic';
  // The composer is the lowest one on screen (ChatGPT docks it to the bottom).
  return candidates.sort(
    (a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top
  )[0];
}

/* -------------------------------------------------------------- messages */

/** Long enough to collapse five-times-a-second callers, short enough to feel live. */
const MSG_CACHE_MS = 250;
let msgCache = { at: 0, nodes: [] };

/**
 * One turn of the conversation, newest last, in document order.
 *
 * querySelectorAll over a 60KB transcript is cheap next to innerText but not
 * free, and every poll asks for it several times. The list is remembered for a
 * quarter second and thrown away the moment its tail has been unmounted -
 * which is exactly what a virtualized transcript does as it scrolls.
 */
function messageNodes(force) {
  if (!force && Date.now() - msgCache.at < MSG_CACHE_MS) {
    const n = msgCache.nodes;
    if (!n.length || n[n.length - 1].isConnected) return n;
  }
  const byRole = [...document.querySelectorAll('[data-message-author-role]')];
  const nodes = byRole.length
    ? byRole
    : [...document.querySelectorAll('article[data-testid^="conversation-turn"]')];
  msgCache = { at: Date.now(), nodes };
  return nodes;
}

/* ----------------------------------------------------------- output root */

/** The scroll container holding the conversation. */
function findOutputRoot() {
  if (cacheHit(rootCache)) return rootCache.el;
  const found = locateOutputRoot();
  rootCache = { el: found, at: Date.now() };
  return found;
}

function scrollableAncestor(start) {
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
}

function locateOutputRoot() {
  if (state.outputSelector) {
    const el = q1(state.outputSelector);
    if (el) { via.output = 'picked'; return el; }
  }
  // Anchor on a real message when there is one: the thread's scroller is its
  // nearest scrollable ancestor, and that is true whatever the layout does.
  const msgs = messageNodes();
  if (msgs.length) {
    const root = scrollableAncestor(msgs[msgs.length - 1]);
    if (root) { via.output = 'known'; return root; }
  }

  const composer = findComposer();
  const fromComposer = composer && composer.parentElement
    ? scrollableAncestor(composer.parentElement)
    : null;
  if (fromComposer) { via.output = 'heuristic'; return fromComposer; }

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
  if (scrollers.length) { via.output = 'heuristic'; return scrollers.pop(); }

  via.output = null;
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
 * How much text one synthetic paste may carry.
 *
 * ProseMirror re-parses and re-lays-out the whole document per paste, so a
 * single 30KB drop blocks the tab's renderer for seconds - and every composer
 * read that follows times out. The main process chunks for the same reason
 * (main.js TYPE_CHUNK); this in-page path is the self-test fallback and has to
 * survive the same document sizes.
 */
const PASTE_CHUNK = 2000;

/**
 * Split on line boundaries where possible. Concatenating the pieces reproduces
 * the input byte for byte - a chunk that ends mid-fence gets auto-formatted
 * into something we never wrote.
 */
function chunksOf(text, max) {
  const src = String(text);
  const out = [];
  let start = 0;
  while (start < src.length) {
    let end = Math.min(start + max, src.length);
    if (end < src.length) {
      const nl = src.lastIndexOf('\n', end);
      if (nl > start) end = nl + 1; // keep the newline with the chunk it ends
    }
    out.push(src.slice(start, end));
    start = end;
  }
  return out.length ? out : [''];
}

function pasteInto(el, chunk) {
  const dt = new DataTransfer();
  dt.setData('text/plain', chunk);
  el.dispatchEvent(
    new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })
  );
}

/**
 * Insert text without triggering the composer's markdown/slash-command handlers
 * more than necessary. beforeinput+insertText is what a real paste looks like to
 * ProseMirror-style editors.
 *
 * Returns whether the text demonstrably landed, so callers can fail loudly
 * instead of sending an empty prompt and waiting three minutes for a reply.
 */
function insertText(el, text) {
  focusEl(el);
  if (isField(el)) {
    const setter = Object.getOwnPropertyDescriptor(
      el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      'value'
    ).set;
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return (el.value || '') === text;
  }
  // contenteditable: clear then paste, one chunk at a time.
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);
  for (const chunk of chunksOf(text, PASTE_CHUNK)) {
    const grewFrom = textLen(el);
    pasteInto(el, chunk);
    // Some builds ignore a synthetic paste outright. insertText is the other
    // synthetic path and is accepted more often; trying it per chunk is what
    // stops one rejected piece from silently truncating the prompt.
    if (textLen(el) <= grewFrom && chunk.trim()) {
      document.execCommand('insertText', false, chunk);
    }
  }
  return !text.trim() || !!(el.textContent || '').trim();
}

/* -------------------------------------------------------------- generating */

/**
 * ChatGPT swaps the send button for a stop button while it streams, so the stop
 * button is both a hazard (clicking it aborts the answer) and the single most
 * reliable "still working" signal on the page.
 */
const STOP_SELECTORS = [
  '[data-testid="stop-button"]',
  'button[data-testid*="stop" i]',
  'button[aria-label*="stop" i]',
  '[role="button"][aria-label*="stop" i]',
];

/** Last node we accepted as the stop button, and when we last swept for one. */
let stopCache = { el: null, at: 0 };
const STOP_SWEEP_MS = 700;

/**
 * When we last actually saw a stop button.
 *
 * Distinct from "did this call find one": the sweep is throttled, so a single
 * missed frame returns null for up to STOP_SWEEP_MS without anything having
 * changed on the page. Treating that as "idle" turned one re-render into
 * several consecutive idle votes and returned a partial reply.
 */
let lastStopSeenAt = 0;

/**
 * Is this still a stop control?
 *
 * Identity is re-checked, not assumed: the site swaps stop back to send by
 * re-rendering the SAME element with new attributes, so a cached node that is
 * merely still on screen would report "generating" forever - and awaitReply is
 * built never to return while that is true.
 */
function stillStop(el) {
  if (!el || !el.isConnected) return false;
  if (state.stopSelector && matches(el, state.stopSelector)) return true;
  for (const sel of STOP_SELECTORS) {
    if (matches(el, sel)) return true;
  }
  const label = `${el.getAttribute('aria-label') || ''} ${el.title || ''}`;
  return /\bstop\b/i.test(label);
}

/**
 * Only a control in the composer's own band counts.
 *
 * awaitReply refuses to return while this reports generating, so a permanently
 * mounted "Stop" elsewhere on the page - read-aloud playback, a modal, a
 * sharing control - would turn every reply into a full-timeout abandon.
 * ChatGPT's read-aloud button is in this DOM and its aria-label contains
 * "stop", which is exactly how that failure reached production. Anchoring on
 * the composer costs us nothing worse than falling back to the timing path.
 */
function nearComposer(el, slack = 240) {
  const c = findComposer();
  if (!c) return true; // no composer to judge against: do not veto
  const r = el.getBoundingClientRect();
  const cr = c.getBoundingClientRect();
  return r.top < cr.bottom + slack && r.bottom > cr.top - slack;
}

function findStopButton() {
  // awaitReply asks this five times a second for as long as a reply takes, so
  // the order here is deliberate: re-checking the node we already found is a
  // handful of attribute reads, while sweeping every button on the page costs a
  // forced layout per button and is what makes the tab feel frozen mid-stream.
  const cached = stopCache.el;
  if (stillStop(cached) && visible(cached) && nearComposer(cached)) {
    stopCache.at = Date.now();
    lastStopSeenAt = stopCache.at;
    via.stop = via.stop || 'known';
    return cached;
  }

  if (state.stopSelector) {
    const el = q1(state.stopSelector);
    if (visible(el) && nearComposer(el)) {
      stopCache = { el, at: Date.now() };
      lastStopSeenAt = stopCache.at;
      via.stop = 'picked';
      return el;
    }
  }

  for (const sel of STOP_SELECTORS) {
    const el = q1(sel);
    if (visible(el) && nearComposer(el)) {
      stopCache = { el, at: Date.now() };
      lastStopSeenAt = stopCache.at;
      via.stop = 'known';
      return el;
    }
  }

  // Full sweep only when every known hook is gone - i.e. a redesign - and never
  // more than once a second. Labels are tested before visibility so the layout
  // flush is paid for one candidate instead of several hundred.
  if (Date.now() - stopCache.at < STOP_SWEEP_MS) return null;
  const found =
    [...document.querySelectorAll('button, [role="button"]')].find((b) => {
      const label = `${b.getAttribute('aria-label') || ''} ${b.title || ''}`;
      return /\bstop\b/i.test(label) && visible(b) && nearComposer(b);
    }) || null;
  stopCache = { el: found, at: Date.now() };
  if (found) {
    lastStopSeenAt = stopCache.at;
    via.stop = 'heuristic';
  }
  return found;
}

const isGenerating = () => !!findStopButton();

/**
 * How long after the last sighting a missing stop button still means "unknown".
 * Comfortably longer than STOP_SWEEP_MS so the sweep throttle alone can never
 * be mistaken for the answer having finished.
 */
const STOP_GRACE_MS = 3000;

/* ------------------------------------------------------------------- send */

/**
 * The send control. Preferred over Enter: Enter can insert a newline in a
 * rich-text composer, or be swallowed by an open slash-command menu.
 */
const SEND_DENY =
  /\b(stop|voice|dictate|dictation|microphone|mic|speech|read aloud|attach|upload|file|image|photo|camera|tools?|search|model|menu|settings|scroll|copy|edit|regenerate)\b/i;

function findSendButton() {
  // Short cache only, and never trusted once the node has become the stop
  // button: ChatGPT reuses the same element for both, and handing back the
  // abort control as "send" kills the answer we are waiting for.
  if (cacheHit(sendCache, 400) && !stillStop(sendCache.el) && !isDisabled(sendCache.el)) {
    return sendCache.el;
  }
  const found = locateSendButton();
  sendCache = { el: found, at: Date.now() };
  return found;
}

function locateSendButton() {
  if (state.sendSelector) {
    const el = q1(state.sendSelector);
    if (visible(el) && !stillStop(el)) { via.send = 'picked'; return el; }
  }
  // While a reply streams this testid belongs to the stop button instead, so an
  // exact match on "send-button" can never hand back the abort control.
  const explicit = q1('[data-testid="send-button"]');
  if (visible(explicit) && !isDisabled(explicit) && !stillStop(explicit)) {
    via.send = 'known';
    return explicit;
  }

  const composer = findComposer();
  if (!composer) { via.send = null; return null; }
  const cr = composer.getBoundingClientRect();

  // The model dropdown and the stop button both sit in reach of the composer
  // and would otherwise win on position alone - one opens a menu instead of
  // sending, the other kills the answer we are waiting for.
  const modelTrigger = findModelTrigger();
  const stop = findStopButton();

  const all = [...document.querySelectorAll('button, [role="button"]')].filter((b) => {
    if (!visible(b) || isDisabled(b) || b === modelTrigger || b === stop) return false;
    return !SEND_DENY.test(labelOf(b));
  });

  const byLabel = all.filter((b) => {
    const label = `${b.getAttribute('aria-label') || ''} ${b.title || ''}`;
    return /\b(send|submit)\b/i.test(label);
  });
  if (byLabel.length) { via.send = 'known'; return byLabel[0]; }

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
  const found = pool.sort(
    (a, b) => a.getBoundingClientRect().right - b.getBoundingClientRect().right
  ).pop() || null;
  via.send = found ? 'heuristic' : null;
  return found;
}

/**
 * Cheap positive "not generating any more" vote.
 *
 * ChatGPT swaps stop back to send when it finishes, so a live send control is
 * evidence the answer is done - evidence that absence-of-stop alone cannot
 * give us, since absence is also what a renamed testid looks like. Deliberately
 * only the documented selector plus the cached node: this runs every poll and
 * must not trigger the whole-page button sweep.
 */
function sendReady() {
  const explicit = q1('[data-testid="send-button"]');
  if (explicit && visible(explicit) && !isDisabled(explicit) && !stillStop(explicit)) return true;
  const cached = sendCache.el;
  return !!(
    cached &&
    cached.isConnected &&
    !stillStop(cached) &&
    !isDisabled(cached) &&
    visible(cached)
  );
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
 * Would clicking this take money, or leave the conversation?
 *
 * The model scan is the one place in this file that clicks something it merely
 * guessed at, so the guess has to be provably harmless. Anything that navigates
 * is a destination (pricing, settings, another chat), not a menu opener, and a
 * billing word anywhere in the accessible name is disqualifying on its own.
 */
function isBillingish(el) {
  if (!el) return true;
  if (MODEL_DENY.test(labelOf(el))) return true;
  if (MENU_DENY.test((el.textContent || '').trim())) return true;
  const link = el.closest('a[href]');
  if (link) {
    const href = link.getAttribute('href') || '';
    if (href && href !== '#' && !/^javascript:/i.test(href)) return true;
  }
  return !!el.closest('[data-testid*="upgrade" i], [data-testid*="billing" i], [data-testid*="account" i]');
}

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
  if (cacheHit(modelCache)) return modelCache.el;
  const found = locateModelTrigger();
  modelCache = { el: found, at: Date.now() };
  return found;
}

/** Below this the candidate is a coincidence, not a dropdown. */
const MODEL_SCORE_FLOOR = 2;

function locateModelTrigger() {
  if (state.modelSelector) {
    const el = q1(state.modelSelector);
    if (visible(el)) { via.model = 'picked'; return el; }
  }
  for (const sel of MODEL_SELECTORS) {
    const el = q1(sel);
    if (visible(el) && !isBillingish(el)) { via.model = 'known'; return el; }
  }

  // Only on a conversation page. On /admin/billing the scan matched a "Turn on
  // auto-reload" button (\bauto\b) and clicking it opened billing settings.
  if (!/^\/(c\/|g\/|$)/.test(location.pathname) && location.pathname !== '/') {
    via.model = null;
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
    .filter((b) => !isBillingish(b))
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

  // A weak best candidate is worse than none: the caller can say "use Pick
  // Model", but it cannot undo a click on whatever this returned.
  if (!scored.length || scored[0].score < MODEL_SCORE_FLOOR) { via.model = null; return null; }
  via.model = 'heuristic';
  return scored[0].b;
}

/** Refuse to click a trigger that could cost money, even a user-picked one. */
function safeTrigger() {
  const trigger = findModelTrigger();
  if (!trigger) throw new Error('model dropdown not found - use Pick Model');
  if (isBillingish(trigger)) {
    throw new Error(
      'the chosen model control navigates or looks like billing - refusing to click it; use Pick Model'
    );
  }
  return trigger;
}

function openMenuItems() {
  const items = [
    ...document.querySelectorAll(
      '[role="menuitem"], [role="option"], [role="menuitemradio"]'
    ),
  ].filter(visible);
  return items.map((el) => ({ el, label: (el.innerText || '').trim().split('\n')[0] }));
}

/** A row in the open menu that is a model, not an upsell or a submenu. */
const isModelLabel = (l) => !!l && MODEL_HINT.test(l) && !MODEL_DENY.test(l) && !MENU_DENY.test(l);

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
  const trigger = safeTrigger();
  const current = (trigger.textContent || '').trim();

  trigger.click();

  // Wait for menu items that actually have text. Waiting only for the items to
  // exist wins the race too early: they mount before their labels render, so we
  // read a list of empty strings and conclude there are no models.
  let labels = [];
  let opened = false;
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    const items = openMenuItems();
    if (items.length) opened = true;
    labels = items.map((it) => it.label).filter(isModelLabel);
    if (labels.length >= 2) {
      await sleep(250); // let the rest of the list paint
      labels = openMenuItems().map((it) => it.label).filter(isModelLabel);
      break;
    }
  }
  await closeMenu();
  // `opened` separates "this is not the model trigger" from "the menu opened
  // and holds nothing we recognise as a model" - one is a pick-mode problem,
  // the other is a MODEL_HINT problem, and they need different fixes.
  return { current, models: [...new Set(labels)], opened };
}

/** Open the dropdown and click the entry matching `name`. */
async function selectModel(name) {
  const trigger = safeTrigger();
  const current = (trigger.textContent || '').trim();
  if (current.toLowerCase() === String(name).toLowerCase()) {
    return { selected: current, alreadyActive: true };
  }
  trigger.click();

  let match = null;
  for (let i = 0; i < 20 && !match; i++) {
    await sleep(100);
    const items = openMenuItems().filter((it) => isModelLabel(it.label));
    match =
      items.find((it) => it.label.toLowerCase() === String(name).toLowerCase()) ||
      items.find((it) => it.label.toLowerCase().includes(String(name).toLowerCase()));
  }
  if (!match) {
    await closeMenu();
    throw new Error(`model "${name}" not in the list`);
  }
  match.el.click();

  // Give the trigger a moment to relabel, then always close: a click that
  // opened a submenu instead of switching models used to leave that submenu
  // sitting over the composer for the next prepare/clickSend.
  let selected = current;
  for (let i = 0; i < 12; i++) {
    await sleep(200);
    selected = (findModelTrigger()?.textContent || '').trim();
    if (selected && selected !== current) break;
  }
  const stillOpen = openMenuItems().length > 0;
  await closeMenu();
  if (selected === current && stillOpen) {
    // The menu is still up, so the click opened something rather than choosing
    // something. Reporting the old model as the new one is how a run silently
    // used the wrong model for every file.
    throw new Error(`"${name}" opened a submenu instead of switching model`);
  }
  return { selected: selected || name, verified: selected !== current };
}

/* ---------------------------------------------------------------- reading */

/** Toolbar rows ChatGPT renders INSIDE a <pre>, above the code itself. */
const CODE_TOOLBAR = /^(copy|copy code|edit|copy to clipboard)$/i;

/**
 * Re-fence a rendered code block.
 *
 * innerText of a ChatGPT <pre> is "python\nCopy\nEdit\n<code>" - the toolbar is
 * inside the block - and it carries no backticks. Handing that straight to the
 * orchestrator would write "python/Copy/Edit" into the top of every generated
 * file, and protocol.unfence() would have nothing to strip. So we rebuild the
 * fence from the <code> element alone, and when there is no <code> element we
 * strip the toolbar rows by hand rather than fencing chrome into the file.
 */
function fenceOf(pre) {
  const code = pre.querySelector('code');
  if (code) {
    const body = (code.innerText || '').replace(/\s+$/, '');
    const lang = (String(code.className).match(/language-([\w+#-]+)/) || [])[1] || '';
    return '```' + lang + '\n' + body + '\n```';
  }

  const lines = (pre.innerText || '').replace(/\s+$/, '').split('\n');
  let i = 0;
  let lang = '';
  // A lone word followed by Copy/Edit is the language chip, not code. Requiring
  // the toolbar row after it is what stops a real first line being eaten.
  if (
    lines[0] && /^[\w+#-]{1,20}$/.test(lines[0].trim()) &&
    CODE_TOOLBAR.test((lines[1] || '').trim())
  ) {
    lang = lines[0].trim();
    i = 1;
  }
  while (lines[i] && CODE_TOOLBAR.test(lines[i].trim())) i++;
  return '```' + lang + '\n' + lines.slice(i).join('\n') + '\n```';
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
 * Rendered text per message, keyed by a change stamp that costs no layout.
 *
 * innerText forces the whole document's layout to be flushed, so re-reading
 * every message of a 60KB conversation - which awaitReply used to do five
 * times a second - spends most of the tab's frame budget re-deriving text that
 * cannot have changed. A message is frozen once it has finished streaming.
 */
const messageCache = new WeakMap();

const stamp = (el) => textLen(el) + ':' + el.getElementsByTagName('pre').length;

function readMessageCached(el, live) {
  // The newest message is the one being written, so it is always read fresh:
  // a stale tail is how a half-finished file gets mistaken for a whole one.
  if (live) return readMessage(el);
  const key = stamp(el);
  const hit = messageCache.get(el);
  if (hit && hit.key === key) return hit.text;
  const text = readMessage(el);
  messageCache.set(el, { key, text });
  return text;
}

/** Long enough to collapse the callers that poll, short enough to feel live. */
const TRANSCRIPT_TTL_MS = 150;
let tCache = { at: 0, text: '' };

/**
 * The conversation as text. Reading the message nodes rather than the whole
 * scroller keeps page furniture ("ChatGPT can make mistakes", the composer
 * itself when it lives inside the scroll region) out of the delta we diff.
 *
 * Pass `force` when the answer must not be up to 150ms old - a baseline
 * snapshot, in practice.
 */
function transcript(force) {
  if (!force && Date.now() - tCache.at < TRANSCRIPT_TTL_MS) return tCache.text;
  const nodes = messageNodes(force);
  let text;
  if (nodes.length) {
    const last = nodes.length - 1;
    text = nodes
      .map((el, i) => readMessageCached(el, i === last))
      .filter(Boolean)
      .join('\n\n');
  } else {
    // Always a string: callers take .length of this without checking, and a
    // root that has not painted yet has no innerText at all.
    const root = findOutputRoot();
    text = (root && root.innerText) || '';
  }
  tCache = { at: Date.now(), text };
  return text;
}

/**
 * Conversation size without touching innerText.
 *
 * `chars` runs before every single round (rotateIfBloated) and probe is polled
 * by autopilot, so the old transcript().length forced a full-document layout
 * flush in a tab that may be mid-stream - the same jank that makes a streaming
 * transcript look frozen and a partial reply look settled. textContent walks
 * the same subtree and forces nothing.
 */
function transcriptSize() {
  const nodes = messageNodes();
  if (!nodes.length) return tCache.text.length;
  let n = 0;
  for (const el of nodes) n += textLen(el);
  return n;
}

/** The newest messages only - autopilot wants a tail, not the whole thread. */
function transcriptTail(chars) {
  const want = Math.max(1, chars || 1200);
  const nodes = messageNodes();
  if (!nodes.length) {
    const t = transcript();
    return t.slice(Math.max(0, t.length - want));
  }
  let out = '';
  for (let i = nodes.length - 1; i >= 0 && out.length < want; i--) {
    const one = readMessageCached(nodes[i], i === nodes.length - 1);
    out = one + (out ? '\n\n' + out : '');
  }
  return out.slice(Math.max(0, out.length - want));
}

/* ---------------------------------------------------- main-process typing */

const isField = (el) => !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT');

/** Can text actually be put into this thing right now? */
const isEditable = (el) =>
  !!el &&
  (el.isContentEditable || isField(el)) &&
  !isDisabled(el) &&
  el.readOnly !== true;

/**
 * What the composer holds. textContent rather than innerText: this is polled
 * while the previous answer is still rendering, and innerText would force a
 * full layout flush on every read. Every caller compares on letters and digits
 * or on "did this change at all", so the lost line breaks cost nothing.
 */
function composerValue(el) {
  if (!el) return '';
  if (isField(el)) return el.value ?? '';
  return el.textContent ?? '';
}

/**
 * Empty the composer.
 *
 * selectAll/delete act on the focused editable - with focus elsewhere they act
 * on the DOCUMENT, so the focus check is a guard against clearing the page
 * rather than the input. Returns false when it could not safely try.
 */
function emptyComposer(el) {
  if (isField(el)) {
    insertText(el, '');
    return true;
  }
  const active = document.activeElement;
  if (active !== el && !el.contains(active)) return false;
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);
  if (!composerValue(el).trim()) return true;
  // execCommand needs the frame to own focus; when it does not, put the
  // selection over the element explicitly and try once more before giving up.
  try {
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.addRange(range);
    document.execCommand('delete', false, null);
  } catch { /* no selection API in this frame state */ }
  return !composerValue(el).trim();
}

/** Budget for prepare. Must stay well inside the renderer's own 15s guard. */
const PREPARE_WAIT_MS = 6000;

/**
 * Leftover this big is a whole previous prompt, not a placeholder node.
 * Appending the next prompt to it sends both at once, and the caller's landing
 * check passes on the concatenation, so nothing downstream ever notices.
 */
const LEFTOVER_FATAL = 200;

/**
 * Focus and empty the composer, and snapshot the transcript.
 *
 * Text itself is injected by the main process via webContents.insertText,
 * because synthetic key/paste events are untrusted: ProseMirror ignores them
 * whenever the window is not OS-focused. The main process does not care about
 * focus, which is what makes unattended runs reliable.
 *
 * It waits instead of failing on the first look: the composer unmounts across a
 * navigation and goes read-only while a previous answer renders, and answering
 * "not there" for a tab that is merely busy costs the caller a whole round.
 */
async function prepare() {
  let composer = null;
  const deadline = Date.now() + PREPARE_WAIT_MS;
  for (;;) {
    const el = findComposer();
    if (isEditable(el)) { composer = el; break; }
    if (Date.now() >= deadline) {
      throw new Error(
        el
          ? 'composer found but not editable - use Pick Composer'
          : `composer not found - use Pick Composer${missingNote()}`
      );
    }
    await sleep(200);
  }

  focusEl(composer);
  emptyComposer(composer);

  // A composer that still holds the last prompt would prepend it to the next
  // one. One execCommand loses that race often enough - ProseMirror re-renders
  // under it, an attachment chip is still uploading - to be worth retrying.
  let leftover = composerValue(composer).trim();
  for (let i = 0; i < 6 && leftover; i++) {
    await sleep(120);
    focusEl(composer);
    emptyComposer(composer);
    leftover = composerValue(composer).trim();
  }

  state.before = transcript(true);
  state.beforeMessages = messageNodes().length;

  // Small leftovers are reported rather than thrown: some composers render
  // their placeholder as a real node, and refusing to prepare over that would
  // fail every prompt instead of just this one. A leftover the size of a prompt
  // is a different animal - that one gets sent twice if we say nothing.
  if (leftover.length >= LEFTOVER_FATAL) {
    throw new Error(
      `composer still holds ${leftover.length} chars of the previous prompt ` +
      '- refusing to append; focus the app window or clear the composer'
    );
  }
  return {
    before: state.before.length,
    messages: state.beforeMessages,
    cleared: !leftover,
    leftover: leftover.length,
  };
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
  return composerValue(findComposer());
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
 *
 * The search runs FORWARD from the pre-send baseline, never backward from the
 * end: lastIndexOf finds the model's own restatement of the anchor, and our
 * build prompts start with "PATH: <path>" and end with the "Output only the
 * complete contents of..." instruction - both of which a reply commonly quotes.
 * Anchoring on that occurrence silently threw away everything written before
 * it, which on the small-answer path is most of the file.
 */
function afterEcho(text, full, before) {
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
  // A little slack, because earlier turns can reflow between the snapshot and
  // now (a "Show more" collapsing) and shift the baseline by a few characters.
  // Never more than a quarter of it, though: on a short baseline a fixed slack
  // reaches back past the start, and then an anchor sitting in the PREVIOUS
  // turn is accepted as this turn's echo.
  const baseline = String(before || '').length;
  const from = Math.max(0, baseline - Math.min(200, Math.floor(baseline / 4)));
  for (const anchor of [lines[lines.length - 1], lines[0]]) {
    if (!anchor || anchor.length < 8) continue;
    const i = full.indexOf(anchor, from);
    if (i !== -1) return full.slice(i + anchor.length);
  }
  return null;
}

/**
 * Enough of a message to recognise our own prompt in. Our prompts are tagged in
 * their first line, and the needle is 40 characters, so a generous prefix beats
 * normalising 30KB of pasted file bodies on every poll.
 */
const ECHO_SCAN_CHARS = 8000;
const headOf = (el) => norm((el.textContent || '').slice(0, ECHO_SCAN_CHARS));

/**
 * Has our own prompt been rendered into the conversation yet?
 *
 * Only the newest turns can hold it, and norm() throws away everything except
 * letters and digits - so textContent is enough, and unlike innerText it costs
 * no layout. This runs four times a second for up to 30s.
 */
function echoVisible(wanted) {
  if (!wanted) return true;
  const nodes = messageNodes();
  if (!nodes.length) return norm(transcript()).includes(wanted);
  for (let i = nodes.length - 1; i >= Math.max(0, nodes.length - 4); i--) {
    if (headOf(nodes[i]).includes(wanted)) return true;
  }
  return false;
}

/**
 * The answer to the prompt we just sent, as a message node - or null when it is
 * not on screen yet.
 *
 * Two things have to hold, and both matter. The newest turn must be the model's
 * (while only our own echo is rendered, handing it back would look exactly like
 * a finished reply), and the turn before it must be OUR prompt: a retry sends
 * the same text into the same chat, and the PREVIOUS answer is stable,
 * non-empty and completely wrong.
 */
function freshAnswerNode(wanted) {
  const nodes = messageNodes();
  const last = nodes[nodes.length - 1];
  if (!last) return null;
  const role = last.getAttribute('data-message-author-role');
  if (!role || role === 'user') return null; // no roles in the markup: not safe
  if (!wanted) return last;

  for (let i = nodes.length - 2; i >= 0 && i >= nodes.length - 5; i--) {
    if (nodes[i].getAttribute('data-message-author-role') !== 'user') continue;
    // Only the newest user turn counts - an older identical prompt is exactly
    // the case this exists to reject.
    return headOf(nodes[i]).includes(wanted) ? last : null;
  }
  return null;
}

/**
 * The newest message the HUMAN typed.
 *
 * Autopilot otherwise has to slice it out of a transcript diff and strip the
 * planner's own answer back off, which mis-fires whenever the roles interleave.
 * When the markup carries author roles - it does on ChatGPT today - the newest
 * user turn is simply readable, so read it. Returns '' when roles are absent,
 * which tells the caller to fall back to the diff.
 */
function lastUserMessage() {
  const nodes = messageNodes();
  for (let i = nodes.length - 1; i >= 0; i--) {
    const role = nodes[i].getAttribute('data-message-author-role');
    if (!role) return ''; // no roles in this markup - caller falls back
    if (role !== 'user') continue;
    const text = readMessage(nodes[i]).trim();
    // Our own relay prompts are user turns too; autopilot filters those itself,
    // but returning the newest one regardless keeps this function honest.
    return text;
  }
  return '';
}

/**
 * The reply so far.
 *
 * When the markup carries author roles - it always does on ChatGPT today - the
 * answer node IS the reply, so read only that. It is both the correct answer
 * (no string anchoring to mis-slice) and the cheap one: re-deriving the other
 * 60KB several times a second is precisely what starved the tab and made a long
 * reply arrive truncated. The whole-transcript diff below is the fallback for
 * markup with no roles at all.
 */
function replyDelta(text, before, echoSeen, wanted) {
  if (echoSeen) {
    const answer = freshAnswerNode(wanted);
    if (answer) return readMessage(answer);
  }
  const full = transcript();
  if (echoSeen) {
    const delta = afterEcho(text, full, before);
    if (delta !== null) return delta;
  }
  if (full.startsWith(before)) return full.slice(before.length);
  // The baseline no longer prefixes the transcript (virtualization unmounted
  // the older turns), so there is no honest delta to give. Returning `full`
  // here handed the caller the WHOLE conversation as one reply, and
  // protocol.extractBody then glued every fenced block in it - several earlier
  // files - into the file being written. Waiting and timing out is recoverable;
  // that was not.
  return '';
}

/** No output change for this long while still generating means the tab is wedged. */
const STUCK_MS = 300000;

/** Consecutive stop-free polls (200ms each) before we believe the answer ended. */
const IDLE_TICKS = 15;            // 3s, with no corroboration
const IDLE_TICKS_SEND_READY = 8;  // 1.6s, with the send control back on screen

/** How long a prompt may take to appear in the transcript before we call it lost. */
const DELIVERY_GRACE_MS = 90000;

/** Live counter cadence. Cheap, but not per-poll cheap. */
const PROGRESS_MS = 1000;

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
async function awaitReply(opts = {}, driveId = null) {
  const text = opts.text || '';
  // Reasoning can sit on an unchanged status line for seconds at a time, so
  // "quiet" has to be longer than the gap between its steps.
  const quietMs = opts.quietMs ?? 5000;
  // Long files legitimately take minutes; the generating state decides when
  // we are done, this is only a backstop against a dead tab.
  const timeoutMs = opts.timeoutMs ?? 600000;
  const before = state.before ?? '';
  const beforeMessages = state.beforeMessages ?? 0;
  const started = Date.now();

  // 1. Wait for our own message to show up in the transcript.
  let echoSeen = false;
  const wanted = norm(text).slice(0, 40);
  while (Date.now() - started < 30000) {
    if (echoVisible(wanted)) { echoSeen = true; break; }
    await sleep(250);
  }

  // 2. Wait for the answer, using the UI's own generating state as the
  //    authority rather than a stopwatch.
  let lastDelta = null;
  let lastChange = Date.now();
  let sawGenerating = false;
  let idleTicks = 0; // consecutive polls with the stop button confidently gone
  let lastProgress = 0;

  const finish = (out, why) => {
    emit('replyEnd', {
      id: driveId,
      why,
      chars: out.length,
      sawGenerating,
      idleTicks,
      ms: Date.now() - started,
    });
    return out;
  };

  while (Date.now() - started < timeoutMs) {
    await sleep(200);
    // Sample the stop button every tick, not only once content is stable:
    // a fast reply can start and finish between two lazy checks, and never
    // "seeing" generation is what forces the slow no-signal quiet window.
    const generating = isGenerating();
    if (generating) {
      sawGenerating = true;
      idleTicks = 0;
    } else if (Date.now() - lastStopSeenAt > STOP_GRACE_MS) {
      // Only count an idle tick once the stop button has been absent longer
      // than the sweep throttle can explain. A single missed selector hit used
      // to buy three or four "idle" votes for free, which - with a real 500ms
      // gap between tokens - was enough to return half a file.
      idleTicks++;
    }
    // A prompt that took longer than step 1 to render is not a lost cause: the
    // echo is what unlocks reading the answer node directly, so keep looking
    // for it instead of diffing the whole transcript for the next ten minutes.
    if (!echoSeen && echoVisible(wanted)) echoSeen = true;
    const delta = replyDelta(text, before, echoSeen, wanted).trim();

    // Drop placeholder AND message chrome. ChatGPT collapses a long prompt
    // behind "Show more", and that button's text arriving in the transcript
    // used to look like the reply landing - the quiet window then elapsed
    // before the real answer had started streaming.
    // Drop status lines and message chrome, but KEEP blank lines: this value is
    // what awaitReply returns, and it becomes the file written to disk. Filtering
    // empty lines out here silently stripped every blank line from every file the
    // app has ever produced - no paragraph breaks in markdown, no spacing between
    // functions. Only the emptiness CHECK below ignores whitespace.
    const kept = delta.split('\n').filter((l) => {
      const t = l.trim();
      return !t || (!PLACEHOLDER.test(t) && !CHROME.test(t));
    });
    const meaningful = kept.join('\n').replace(/^\n+/, '').replace(/\s+$/, '');

    if (Date.now() - lastProgress > PROGRESS_MS) {
      lastProgress = Date.now();
      // The renderer draws a live counter from this. Four minutes of silence is
      // the single most common reason a new user decides the app has hung.
      emit('progress', {
        id: driveId,
        chars: meaningful.length,
        generating,
        echoSeen,
        ms: Date.now() - started,
      });
    }

    if (meaningful !== lastDelta) {
      lastDelta = meaningful;
      lastChange = Date.now();
      continue;
    }

    // Nothing has arrived and nothing is happening: say which hook is missing
    // rather than sitting here for the full ten minutes. A send click that did
    // not register, or a transcript we can no longer read, both land here.
    if (
      !meaningful && !echoSeen && !generating && !sawGenerating &&
      Date.now() - started > DELIVERY_GRACE_MS &&
      messageNodes().length <= beforeMessages
    ) {
      throw new Error(
        `prompt never reached the chat - no new message in ${Math.round(DELIVERY_GRACE_MS / 1000)}s` +
        missingNote()
      );
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
      // polls as well as the content holding still - fewer of them when the
      // send control is back on screen, because ChatGPT swaps one for the
      // other and that is positive evidence rather than mere absence.
      const need = sendReady() ? IDLE_TICKS_SEND_READY : IDLE_TICKS;
      if (idleTicks >= need && stableFor > 1500) return finish(meaningful, 'stop-button-cleared');
    } else if (stableFor > Math.max(quietMs, 12000)) {
      // We never saw the stop button at all - a missing testid, or a reply
      // that finished between polls. With no UI signal to trust, wait far
      // longer before believing the text has stopped growing.
      return finish(meaningful, 'no-signal-quiet');
    }
  }

  // Out of budget. Handing back lastDelta while the model is STILL streaming
  // returns half a file that looks complete - the exact failure that wrote a
  // 617-char stub over a 6400-char answer. Only salvage once generation has
  // demonstrably stopped.
  if (lastDelta && !isGenerating()) return finish(lastDelta, 'timeout-salvage');
  throw new Error(
    isGenerating()
      ? 'still generating after the full timeout - reply abandoned rather than truncated'
      : `no response detected before timeout (echo ${echoSeen ? 'seen' : 'never rendered'}, ` +
        `${messageNodes().length} messages)${missingNote()}`
  );
}

/* ------------------------------------------------------------ diagnostics */

/**
 * Which hooks are missing right now, as a sentence fragment.
 *
 * Every error that used to read "no response detected before timeout" now says
 * what the driver could not see, because that is the difference between a user
 * filing "it stopped working" and a user clicking the right Pick button.
 */
function missingNote() {
  const gone = [];
  if (!findComposer()) gone.push('composer');
  if (!messageNodes().length) gone.push('messages');
  if (!findSendButton()) gone.push('send button');
  if (!lastStopSeenAt) gone.push('stop button (never seen)');
  return gone.length ? ` - not found: ${gone.join(', ')}. Run Health, then Pick.` : '';
}

/**
 * Structured report of every element the driver needs.
 *
 * This is what the UI shows when ChatGPT changes: one row per hook, whether it
 * was found, how (a documented selector, a heuristic, or the user's own pick),
 * and which pick target fixes it. Nothing here clicks anything, so it is safe
 * to run at any time, including mid-generation.
 */
function health() {
  const composer = findComposer();
  const root = findOutputRoot();
  const send = findSendButton();
  const stop = findStopButton();
  const model = findModelTrigger();
  const newchat = findNewChatButton();
  const msgs = messageNodes();

  const row = (name, el, opts = {}) => ({
    name,
    found: !!el,
    via: el ? via[name] : null,
    override: state[OVERRIDE_KEY[name]] || null,
    selector: el ? cssPath(el) : null,
    detail: el ? (opts.detail ? opts.detail(el) : '') : (opts.absent || ''),
    critical: !!opts.critical,
    pick: name,
  });

  const elements = [
    row('composer', composer, {
      critical: true,
      detail: (el) => (isEditable(el) ? `${el.tagName} editable` : `${el.tagName} NOT editable`),
      absent: 'no contenteditable or textarea on the page',
    }),
    // locateOutputRoot falls back to <body> so transcript() always has
    // something to read; that is not a FOUND scroller, and reporting it as one
    // would hide the exact breakage this row exists to surface.
    row('output', via.output ? root : null, {
      critical: true,
      detail: () => `${msgs.length} messages, ${transcriptSize()} chars`,
      absent: 'no scrollable conversation container',
    }),
    row('send', send, {
      detail: (el) => (labelOf(el).trim() || 'icon button'),
      // ChatGPT renders a voice button until the composer holds text, so an
      // absent send button on an idle tab is normal, not broken.
      absent: 'not rendered while the composer is empty - Enter is the fallback',
    }),
    row('stop', stop, {
      detail: (el) => (labelOf(el).trim() || 'icon button'),
      absent: lastStopSeenAt
        ? 'only rendered while generating - seen earlier this session'
        : 'only rendered while generating - never seen yet',
    }),
    row('model', model, {
      detail: (el) => (el.textContent || '').trim(),
      absent: 'no menu-opening control with a model-ish label',
    }),
    row('newchat', newchat, {
      detail: (el) => (labelOf(el).trim() || (el.textContent || '').trim().slice(0, 24)),
      absent: 'no new-chat control (navigation is used instead on this site)',
    }),
  ];

  const page = /(^|\.)(chatgpt\.com|openai\.com)$/.test(location.host);
  const loggedIn = !document.querySelector('input[type="password"]');
  const broken = elements.filter((e) => e.critical && !e.found).map((e) => e.name);
  const degraded = elements.filter((e) => e.found && e.via === 'heuristic').map((e) => e.name);

  return {
    ok: page && loggedIn && !broken.length,
    url: location.href,
    host: location.host,
    page,
    loggedIn,
    messages: msgs.length,
    chars: transcriptSize(),
    generating: !!stop,
    elements,
    broken,
    degraded,
    summary: !page
      ? 'not a ChatGPT page'
      : !loggedIn
        ? 'a login form is on screen - sign in first'
        : broken.length
          ? `missing: ${broken.join(', ')} - use the matching Pick button`
          : degraded.length
            ? `working, but ${degraded.join(', ')} found by heuristic - the markup has moved`
            : 'all hooks found',
  };
}

/** Diagnostic: open the model menu and report what the DOM actually contains. */
async function dumpMenu() {
  let trigger;
  try {
    trigger = safeTrigger();
  } catch (e) {
    return { error: String(e.message || e) };
  }
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
  emptyComposer(c);
  return !composerValue(c).trim();
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
  if (!composer) throw new Error(`composer not found - use Pick Composer${missingNote()}`);

  const before = transcript(true);
  if (!insertText(composer, text)) {
    throw new Error('composer refused the text - the editor ignored both paste and insertText');
  }
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
  if (!grew) throw new Error(`no response detected before timeout${missingNote()}`);

  // The reply is whatever was appended after our own echoed prompt.
  let delta = last.startsWith(before) ? last.slice(before.length) : last;
  const echo = delta.indexOf(text.slice(0, 60));
  if (echo !== -1) delta = delta.slice(echo + text.length);
  return delta.trim();
}

/* -------------------------------------------------------------- new chat */

const NEW_CHAT_SELECTORS = [
  '[data-testid="create-new-chat-button"]',
  '[data-testid*="new-chat" i]',
  '[data-testid*="new-thread" i]',
];

/** A sidebar entry for an existing conversation, which must never be clicked. */
const isHistoryLink = (el) => !!el.closest('a[href^="/c/"]');

/**
 * The control that starts a fresh conversation.
 *
 * An untitled conversation in the sidebar is *called* "New chat", so text
 * matching alone would reopen an old thread instead of starting one. Trust
 * testid and aria-label first, and never accept a history link.
 */
function findNewChatButton() {
  if (state.newchatSelector) {
    const el = q1(state.newchatSelector);
    if (visible(el) && !isHistoryLink(el)) { via.newchat = 'picked'; return el; }
  }
  for (const sel of NEW_CHAT_SELECTORS) {
    const el = q1(sel);
    if (visible(el) && !isHistoryLink(el)) { via.newchat = 'known'; return el; }
  }

  const candidates = [...document.querySelectorAll('button, [role="button"], a[href]')]
    .filter((b) => !isHistoryLink(b));
  const labelled = candidates.filter((b) => {
    const label = `${b.getAttribute('aria-label') || ''} ${b.title || ''}`;
    return NEW_CHAT_LABEL.test(label) || /\bnew conversation\b/i.test(label);
  });
  if (labelled.length) {
    const el = labelled.find(visible) || labelled[0];
    via.newchat = 'known';
    return el;
  }

  const byText = candidates.filter((b) => {
    const t = (b.textContent || '').trim();
    return NEW_CHAT_LABEL.test(t) && t.length < 24;
  });
  if (byText.length) {
    via.newchat = 'heuristic';
    return byText.find(visible) || byText[0];
  }
  via.newchat = null;
  return null;
}

/**
 * Start a fresh conversation. Long transcripts get virtualized - old messages
 * unmount as new ones stream - which blinds the growth-based reply detector.
 * Rotating to a new chat resets that cleanly.
 */
async function newChat() {
  const btn = findNewChatButton();
  if (!btn) throw new Error('New chat button not found - use Pick New Chat');
  btn.click();
  invalidateCaches();

  // The click may navigate; the fresh chat's composer mounts noticeably later,
  // and returning before it does means the next prompt is typed into nothing.
  // Poll cheaply: findComposer first, and the emptiness check only once an
  // EDITABLE composer exists.
  for (let i = 0; i < 20; i++) {
    await sleep(400);
    const c = findComposer();
    if (!isEditable(c)) continue;
    // Message count, not character count: with no messages mounted the old
    // transcript().length fell through to the output root's innerText, which on
    // an account with history resolves to the sidebar's chat list - never under
    // 2000 chars, so this threw even after succeeding.
    const messages = messageNodes(true).length;
    if (messages === 0 || transcriptSize() < 2000) {
      state.before = '';
      state.beforeMessages = messages;
      return { chars: transcriptSize(), messages, url: location.href };
    }
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
  check('composer is editable', () => (isEditable(composer) ? composer.tagName : false));

  // NB: the send button is deliberately not checked here. ChatGPT shows a
  // voice control until the composer has text, so send can only be verified
  // mid-typing - the renderer's self-test does that after injecting a marker.

  const root = findOutputRoot();
  check('output root found', () => (root && via.output ? cssPath(root) : false));
  check('transcript readable', () => {
    if (!root) return false;
    const n = messageNodes().length;
    // A brand-new chat legitimately has no messages; failing the row there sent
    // people hunting for a breakage that was just an empty conversation.
    return n ? `${n} messages, ${transcriptSize()} chars` : 'empty conversation';
  });

  check('model trigger found', () => {
    const m = findModelTrigger();
    return m ? (m.textContent || '').trim() : false;
  });

  const passed = checks.filter((c) => c.pass).length;
  // The structured report rides along so the UI can offer the right Pick button
  // for whichever row failed, without a second round trip.
  return { passed, total: checks.length, checks, health: health() };
}

/* ------------------------------------------------------------- pick mode */

const PICK_CURSOR = 'crosshair';

function startPick(which) {
  if (which === 'cancel') return stopPick();
  if (!HOOKS.includes(which)) throw new Error(`unknown pick target "${which}"`);
  state.picking = which;
  document.body.style.cursor = PICK_CURSOR;
  return which;
}

function stopPick() {
  state.picking = null;
  document.body.style.cursor = '';
  return null;
}

/**
 * Turn a click into the element we actually wanted.
 *
 * Two jobs, both learned the hard way. Clicks land on the inner <svg> of an
 * icon button, so we climb to the control itself; and a stray click on the page
 * background used to be stored verbatim as the composer override, which then
 * beat every heuristic and left the tab permanently dead. A pick that cannot be
 * validated is rejected and told to the user rather than remembered.
 */
function resolvePick(which, target) {
  if (!target || target.nodeType !== 1) return { error: 'that is not an element' };

  if (which === 'composer') {
    const el =
      target.closest('[contenteditable="true"], textarea, input, [role="textbox"]') || target;
    return isEditable(el)
      ? { el }
      : { error: 'that is not something text can be typed into' };
  }

  if (which === 'output') {
    const el = scrollableAncestor(target) || target;
    const r = el.getBoundingClientRect();
    return r.height > 200 && el.scrollHeight > el.clientHeight
      ? { el }
      : { error: 'that is not the scrollable conversation area' };
  }

  // send / stop / model / newchat are all controls.
  const el = target.closest('button, [role="button"], a[href]') || target;
  if (!matches(el, 'button, [role="button"], a[href]')) {
    return { error: 'that is not a button' };
  }
  if (which !== 'newchat' && matches(el, 'a[href]') && !matches(el, '[role="button"]')) {
    return { error: 'that is a link - it would navigate away instead of acting' };
  }
  if (which === 'newchat' && isHistoryLink(el)) {
    return { error: 'that is an existing conversation, not the new-chat control' };
  }
  if (which === 'model' && isBillingish(el)) {
    return { error: 'that control navigates or looks like billing - it will not be clicked' };
  }
  return { el };
}

document.addEventListener(
  'click',
  (e) => {
    if (!state.picking) return;
    e.preventDefault();
    e.stopPropagation();
    const which = state.picking;
    const { el, error } = resolvePick(which, e.target);
    if (error) {
      // Stay in pick mode: the user aimed at the wrong thing, and dropping out
      // now means clicking the toolbar button again for another try.
      emit('picked', { which, selector: null, rejected: true, reason: error });
      return;
    }
    const sel = cssPath(el);
    // cssPath climbs at most six levels, so it can describe a node it cannot
    // uniquely address. Storing such a path silently points every later lookup
    // at a sibling - worse than having no override at all, and invisible.
    if (q1(sel) !== el) {
      emit('picked', {
        which,
        selector: null,
        rejected: true,
        reason: 'that element has no stable selector - try its parent, or the control itself',
      });
      return;
    }
    state[OVERRIDE_KEY[which]] = sel;
    invalidateCaches();
    emit('picked', { which, selector: sel });
    stopPick();
  },
  true
);

// Escape is the way out of a pick started by mistake; without it the next
// click anywhere on the page was consumed as a pick.
document.addEventListener(
  'keydown',
  (e) => {
    if (!state.picking || e.key !== 'Escape') return;
    const which = state.picking;
    stopPick();
    emit('picked', { which, selector: null, cancelled: true });
  },
  true
);

/**
 * Apply (or clear) selector overrides.
 *
 * The renderer re-sends these after every reload, because a hard reset drops
 * the whole preload - a pick that only lived in this module's scope survived
 * about one chat rotation. An explicitly null/empty value clears that override,
 * which is what the UI's Clear button sends.
 */
function setSelectors(args = {}) {
  const applied = {};
  const rejected = {};
  for (const hook of HOOKS) {
    if (!(hook in args)) continue;
    const value = args[hook];
    if (!value) {
      state[OVERRIDE_KEY[hook]] = null;
      applied[hook] = null;
      continue;
    }
    const sel = String(value);
    // A selector Chromium refuses to parse throws out of every find* call, and
    // the override is sticky, so an unparseable pick killed the tab until
    // reload. Prove it parses before storing it.
    try {
      document.querySelector(sel);
    } catch {
      rejected[hook] = sel;
      continue;
    }
    state[OVERRIDE_KEY[hook]] = sel;
    applied[hook] = sel;
  }
  invalidateCaches();
  return { applied, rejected, overrides: overrides() };
}

const overrides = () =>
  Object.fromEntries(HOOKS.map((h) => [h, state[OVERRIDE_KEY[h]] || null]));

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

/** node -> the inline display value it had before we hid it. */
const hiddenNodes = new Map();
/** A mis-aimed hide is invisible and permanent; cap how much damage one can do. */
const MAX_HIDDEN = 6;

function declutter() {
  // Restore anything whose banner text has gone: the site dismissed it, or we
  // hid the wrong node and the user deserves it back without a reload.
  for (const [node, prev] of hiddenNodes) {
    if (!node.isConnected) { hiddenNodes.delete(node); continue; }
    if (BANNER_TEXT.test(node.textContent || '')) continue;
    node.style.setProperty('display', prev.display, prev.priority);
    if (!node.getAttribute('style')) node.removeAttribute('style');
    hiddenNodes.delete(node);
    emit('declutter', { action: 'restored', selector: cssPath(node) });
  }

  const composer = findComposer();
  const root = findOutputRoot();
  for (const b of document.querySelectorAll('button, a[role="button"]')) {
    const t = (b.textContent || '').trim();
    // A long text is a paragraph that merely mentions credits, not a nag button.
    if (!t || t.length > 60 || !BANNER_TEXT.test(t)) continue;
    if (hiddenNodes.size >= MAX_HIDDEN) return;
    // Climb to the banner container: the first ancestor that is wide, short,
    // holds little text, and contains neither the composer nor the conversation
    // (hiding either would blind the whole tab). The old single guard was a
    // hardcoded #prompt-textarea lookup - the exact id a redesign renames, and
    // this file's whole job is to survive that.
    let node = b;
    for (let i = 0; i < 6 && node.parentElement; i++) {
      node = node.parentElement;
      if (node === document.body || node === document.documentElement) break;
      if (composer && node.contains(composer)) break;
      if (root && node.contains(root)) break;
      if (textLen(node) > 400) break;
      const r = node.getBoundingClientRect();
      if (r.width > 250 && r.height > 0 && r.height < 220) {
        if (hiddenNodes.has(node)) break;
        hiddenNodes.set(node, {
          display: node.style.getPropertyValue('display'),
          priority: node.style.getPropertyPriority('display'),
        });
        node.style.setProperty('display', 'none', 'important');
        emit('declutter', { action: 'hid', selector: cssPath(node), text: t.slice(0, 60) });
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
    else if (cmd === 'prepare') result = await prepare();
    else if (cmd === 'clickSend') result = clickSend();
    else if (cmd === 'composerText') result = composerText();
    else if (cmd === 'awaitReply') result = await awaitReply(args.opts, id);
    else if (cmd === 'dumpButtons') result = dumpButtons();
    else if (cmd === 'clearComposer') result = clearComposer();
    else if (cmd === 'chars') result = transcriptSize();
    else if (cmd === 'newChat') result = await newChat();
    else if (cmd === 'lastUserMessage') result = lastUserMessage();
    else if (cmd === 'transcriptTail') {
      // The newest message, for autopilot to read what the user just typed.
      result = transcriptTail(args.tail || 1200);
    }
    else if (cmd === 'describeSend') result = describeSend();
    else if (cmd === 'dumpMenu') result = await dumpMenu();
    else if (cmd === 'pick') result = startPick(args.which);
    else if (cmd === 'listModels') result = await listModels();
    else if (cmd === 'selectModel') result = await selectModel(args.name);
    else if (cmd === 'selftest') result = await selftest();
    else if (cmd === 'health') result = health();
    else if (cmd === 'probe') {
      const composer = findComposer();
      const send = findSendButton();
      const model = findModelTrigger();
      // Autopilot polls probe purely for transcriptChars, so nothing in here
      // may do the same expensive lookup twice - and the size is counted
      // without innerText, which used to flush layout on every poll.
      const outputRoot = findOutputRoot();
      result = {
        url: location.href,
        composer: composer ? cssPath(composer) : null,
        sendButton: send ? (send.getAttribute('aria-label') || send.textContent || '?').trim() : null,
        modelTrigger: model ? (model.textContent || '').trim() : null,
        outputRoot: outputRoot ? cssPath(outputRoot) : null,
        transcriptChars: transcriptSize(),
        messages: messageNodes().length,
        generating: isGenerating(),
        overrides: overrides(),
      };
    }
    else if (cmd === 'setSelectors') result = setSelectors(args);
    else throw new Error(`unknown cmd ${cmd}`);
    ipcRenderer.sendToHost('drive:done', { id, result });
  } catch (err) {
    ipcRenderer.sendToHost('drive:done', { id, error: String(err.message || err) });
  }
});

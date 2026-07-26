'use strict';
const { session, app } = require('electron');
const path = require('node:path');
const fsp = require('node:fs/promises');

/**
 * Durable login for the Notion tabs.
 *
 * Both webviews share one partition, so a single login covers both tabs (same
 * account, as intended). Chromium keeps `persist:` partitions on disk under
 * userData, but it only flushes the cookie store lazily - a hard kill can lose
 * a fresh login. So we flush explicitly: on an interval, on navigation, and on
 * quit. Nothing here ever reads or exports the cookie values themselves.
 */

const PARTITION = 'persist:notion';
const AUTH_COOKIES = ['token_v2', 'p_sync_session', 'notion_user_id'];

let ses = null;
let flushTimer = null;

/** Pin the profile next to the app so it is obvious, portable, and stable. */
function pinProfileDir() {
  const dir = path.join(__dirname, '..', '..', '.profile');
  app.setPath('userData', dir);
  return dir;
}

function get() {
  if (!ses) ses = session.fromPartition(PARTITION);
  return ses;
}

async function flush() {
  try {
    await get().cookies.flushStore();
    return true;
  } catch {
    return false;
  }
}

/**
 * Login status without leaking secrets: we report which auth cookies exist and
 * when they expire - never their values.
 */
async function status() {
  const s = get();
  // Electron's `domain` filter does not match a leading-dot domain, and the
  // auth cookies are spread across notion.com / app.notion.com. Fetch the whole
  // store and filter by suffix instead - correctness beats cleverness here.
  const everything = await s.cookies.get({}).catch(() => []);
  const all = everything.filter((c) => (c.domain || '').replace(/^\./, '').endsWith('notion.com'));
  const found = {};
  for (const name of AUTH_COOKIES) {
    const c = all.find((x) => x.name === name);
    if (c) {
      found[name] = c.expirationDate
        ? new Date(c.expirationDate * 1000).toISOString().slice(0, 10)
        : 'session-only';
    }
  }
  return {
    loggedIn: Boolean(found.token_v2),
    cookies: found,
    total: all.length,
    profileDir: app.getPath('userData'),
  };
}

/** Full logout: wipe the partition so the next launch starts clean. */
async function clear() {
  const s = get();
  await s.clearStorageData({
    storages: ['cookies', 'localstorage', 'indexdb', 'websql', 'serviceworkers', 'cachestorage'],
  });
  await flush();
}

/** Start periodic + lifecycle flushing. Call once, after app ready. */
function watch() {
  const s = get();

  // Notion refuses to render in a frame unless we drop the framing headers.
  s.webRequest.onHeadersReceived((details, cb) => {
    const headers = { ...details.responseHeaders };
    for (const k of Object.keys(headers)) {
      const lk = k.toLowerCase();
      if (lk === 'x-frame-options') delete headers[k];
      else if (lk === 'content-security-policy') {
        headers[k] = headers[k].map((v) => v.replace(/frame-ancestors[^;]*;?/gi, ''));
      }
    }
    cb({ responseHeaders: headers });
  });

  // A login writes cookies; flush shortly after any cookie change settles.
  let debounce = null;
  s.cookies.on('changed', (_e, cookie) => {
    if (!AUTH_COOKIES.includes(cookie.name)) return;
    clearTimeout(debounce);
    debounce = setTimeout(flush, 1500);
  });

  flushTimer = setInterval(flush, 60000);
  flushTimer.unref?.();

  app.on('before-quit', () => {
    clearInterval(flushTimer);
    flush();
  });
}

/** Sanity check that the profile dir is actually writable. */
async function assertWritable() {
  const dir = app.getPath('userData');
  await fsp.mkdir(dir, { recursive: true });
  const probe = path.join(dir, '.write-probe');
  await fsp.writeFile(probe, 'ok');
  await fsp.unlink(probe);
  return dir;
}

module.exports = { PARTITION, pinProfileDir, get, flush, status, clear, watch, assertWritable };

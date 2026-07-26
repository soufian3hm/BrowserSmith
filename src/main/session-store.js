'use strict';
const { session, app } = require('electron');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { SITE } = require('../shared/site');

/**
 * Durable login for the chat tabs.
 *
 * All webviews share one partition, so a single login covers every tab (same
 * account, as intended). Chromium keeps `persist:` partitions on disk under
 * userData, but it only flushes the cookie store lazily - a hard kill can lose
 * a fresh login. So we flush explicitly: on an interval, on navigation, and on
 * quit. Nothing here ever reads or exports the cookie values themselves.
 */

const PARTITION = SITE.partition;
const AUTH_COOKIES = SITE.authCookies;

let ses = null;
let flushTimer = null;

/** Pin the profile next to the app so it is obvious, portable, and stable. */
function pinProfileDir() {
  // Packaged: next to the .exe (portable). Dev: in the repo root. Both are
  // writable and both keep the login local and visible.
  const dir = app.isPackaged
    ? path.join(path.dirname(process.execPath), '.profile')
    : path.join(__dirname, '..', '..', '.profile');
  app.setPath('userData', dir);
  return dir;
}

function get() {
  if (!ses) ses = session.fromPartition(PARTITION);
  return ses;
}

/**
 * True for a cookie belonging to the site or any of its subdomains. The
 * leading dot Chromium writes on shared-host cookies has to come off first,
 * and an exact/dot-suffix test keeps a lookalike domain out of the count.
 */
function onSite(domain) {
  const host = (domain || '').replace(/^\./, '').toLowerCase();
  return SITE.cookieDomains.some((d) => host === d || host.endsWith('.' + d));
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
  // auth cookies are spread across several hosts of the site. Fetch the whole
  // store and match ourselves instead - correctness beats cleverness here.
  const everything = await s.cookies.get({}).catch(() => []);
  const all = everything.filter((c) => onSite(c.domain));
  const found = {};
  for (const name of AUTH_COOKIES) {
    // Prefix, not equality: next-auth splits a large JWT across
    // `<name>.0`, `<name>.1`, ... and a Google SSO token is large enough to be
    // chunked - exact matching reported a logged-in session as logged out.
    const c = all.find((x) => x.name === name || x.name.startsWith(name + '.'));
    if (c) {
      found[name] = c.expirationDate
        ? new Date(c.expirationDate * 1000).toISOString().slice(0, 10)
        : 'session-only';
    }
  }
  return {
    loggedIn: Boolean(found[SITE.primaryAuthCookie]),
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

/**
 * URL patterns for the site itself, derived from the one list of its domains.
 *
 * The framing headers must be dropped for the chat product and for NOTHING
 * else: an unfiltered listener also strips X-Frame-Options and frame-ancestors
 * from every bank, identity provider and OAuth hop the user passes through
 * inside a tab, which is a clickjacking hole we would be opening on their
 * behalf.
 */
function siteUrlPatterns() {
  const out = [];
  for (const d of SITE.cookieDomains) {
    out.push(`*://${d}/*`, `*://*.${d}/*`);
  }
  return out;
}

/** Start periodic + lifecycle flushing. Call once, after app ready. */
function watch() {
  const s = get();

  // The site refuses to render in a frame unless we drop the framing headers:
  // it sends both X-Frame-Options and a CSP frame-ancestors directive.
  s.webRequest.onHeadersReceived({ urls: siteUrlPatterns() }, (details, cb) => {
    const headers = { ...details.responseHeaders };
    for (const k of Object.keys(headers)) {
      const lk = k.toLowerCase();
      if (lk === 'x-frame-options') delete headers[k];
      // Report-only counts: Chromium enforces frame-ancestors from it for
      // reporting purposes and it is what the site actually sends on some
      // routes, so leaving it alone still blanked the tab.
      else if (lk === 'content-security-policy' || lk === 'content-security-policy-report-only') {
        headers[k] = headers[k].map((v) => v.replace(/frame-ancestors[^;]*;?/gi, ''));
      }
    }
    cb({ responseHeaders: headers });
  });

  // A login writes cookies; flush shortly after any cookie change settles.
  let debounce = null;
  s.cookies.on('changed', (_e, cookie) => {
    const isAuth = AUTH_COOKIES.some(
      (n) => cookie.name === n || cookie.name.startsWith(n + '.')
    );
    if (!isAuth) return;
    clearTimeout(debounce);
    debounce = setTimeout(flush, 1500);
  });

  flushTimer = setInterval(flush, 60000);
  flushTimer.unref?.();
}

/**
 * Stop the timer and write the cookie store out, once.
 *
 * Deliberately NOT wired to `before-quit` here: that event does not await
 * promises, so a fire-and-forget flush loses the login on exactly the quit path
 * it was meant to protect. main.js owns the single before-quit handler that
 * holds the quit open until this resolves.
 */
async function dispose() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  return flush();
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

module.exports = {
  PARTITION,
  pinProfileDir,
  get,
  flush,
  status,
  clear,
  watch,
  dispose,
  assertWritable,
  siteUrlPatterns,
};

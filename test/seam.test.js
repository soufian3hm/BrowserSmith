'use strict';
/**
 * The renderer/main seam.
 *
 * Three files have to agree and none of them imports another: app.js calls
 * `tool.plan(...)`, preload-control.js decides whether that name exists at all,
 * and main.js decides whether the channel behind it is handled. A name that
 * falls through the gap fails at RUNTIME, mid-run, several minutes into a build
 * - the single most expensive failure this project has.
 *
 * So the bridge is really LOADED here (with electron stubbed) rather than
 * pattern-matched: the assertions run against the object the renderer would
 * actually get, and every IPC channel it can produce is checked against the
 * handlers main.js registers.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');

const protocolModule = require('../src/shared/protocol');
const patchModule = require('../src/shared/patch');
const { SITE } = require('../src/shared/site');

const SRC = path.join(__dirname, '..', 'src');
const read = (...parts) => fs.readFileSync(path.join(SRC, ...parts), 'utf8');

/**
 * Execute preload-control.js against a stub electron and return what it handed
 * to contextBridge, plus recorders for the channels it talks on.
 */
function loadBridge() {
  const channels = [];
  let exposed = null;

  const stub = {
    contextBridge: {
      exposeInMainWorld: (name, api) => {
        exposed = { name, api };
      },
    },
    ipcRenderer: {
      invoke: (channel) => {
        channels.push(channel);
        return Promise.resolve(null);
      },
      on: (channel) => {
        channels.push(channel);
      },
      send: (channel) => {
        channels.push(channel);
      },
    },
  };

  const target = require.resolve('../src/main/preload-control.js');
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === 'electron') return stub;
    return origLoad.apply(this, arguments);
  };
  try {
    delete require.cache[target];
    require(target);
  } finally {
    Module._load = origLoad;
    delete require.cache[target];
  }

  assert.ok(exposed, 'preload-control.js never called contextBridge.exposeInMainWorld');
  return { ...exposed, channels };
}

/** Channels main.js answers. */
function handledChannels() {
  const main = fs.readFileSync(path.join(SRC, 'main', 'main.js'), 'utf8');
  return new Set([...main.matchAll(/ipcMain\.handle\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]));
}

/* ------------------------------------------------------------- the global */

test('the bridge global, site.brand and the renderer all name the same thing', () => {
  const { name } = loadBridge();
  assert.equal(name, SITE.brand, 'the exposed global must come from site.brand');

  // The rename is a one-line change in site.js only if the renderer actually
  // reads the global site.js names. It carries a legacy fallback, so accept
  // any `window.<x>` it reads as long as the current brand is among them.
  const app = read('renderer', 'app.js');
  const globals = [...app.matchAll(/window\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  assert.ok(
    globals.includes(SITE.brand),
    `app.js never reads window.${SITE.brand} - the rename broke the renderer`
  );
});

test('every namespace the renderer destructures off the bridge exists', () => {
  const { api } = loadBridge();
  const app = read('renderer', 'app.js');
  const m = app.match(/const\s*\{([^}]+)\}\s*=[\s\S]{0,60}?window\./);
  assert.ok(m, 'app.js no longer destructures the bridge in one place');

  const names = m[1]
    .split(',')
    .map((s) => s.trim().split(':')[0].trim())
    .filter(Boolean);
  assert.ok(names.length >= 5, 'sanity: expected the renderer to take several namespaces');
  for (const name of names) {
    assert.ok(name in api, `app.js destructures "${name}" but the bridge does not expose it`);
  }
});

/* ------------------------------------------------- renderer -> bridge names */

test('every protocol, patch and tool name the renderer uses is on the bridge', () => {
  const { api } = loadBridge();
  const app = read('renderer', 'app.js');

  // The leading lookbehind matters: app.js also has `els.session`, and without
  // it every DOM property read off that element would be demanded of the
  // bridge.
  const namespaces = ['protocol', 'patch', 'fs', 'session', 'tabs', 'tool', 'term', 'shell'];
  let checked = 0;
  for (const ns of namespaces) {
    assert.ok(api[ns], `the bridge no longer exposes ${ns}`);
    const re = new RegExp(`(?<![.\\w$])${ns}\\.([A-Za-z_$][\\w$]*)`, 'g');
    for (const [, member] of app.matchAll(re)) {
      assert.ok(
        member in api[ns],
        `app.js calls ${ns}.${member} but preload-control.js does not expose it`
      );
      checked++;
    }
  }
  assert.ok(checked > 20, `sanity: only ${checked} bridge members seen in the renderer`);

  // TAGS is a nested object, so membership on `protocol` is not enough.
  for (const [, tag] of app.matchAll(/TAGS\.([A-Za-z_$][\w$]*)/g)) {
    assert.equal(typeof api.protocol.TAGS[tag], 'function', `TAGS.${tag} is not on the bridge`);
  }
});

test('the bridge re-exports the whole shared contract, field by field', () => {
  const { api } = loadBridge();

  // contextBridge cannot pass a module object through, so every helper is
  // re-listed by hand - which is exactly how one gets forgotten.
  // Anything deliberately kept off the bridge belongs here, with a reason.
  const NOT_BRIDGED = new Set([
    // inferMode is main-process-only today: the renderer sends the mode the
    // user picked. If the renderer ever needs to guess, bridge it.
    'inferMode',
  ]);

  for (const name of Object.keys(protocolModule)) {
    if (NOT_BRIDGED.has(name)) {
      assert.ok(!(name in api.protocol), `${name} is now bridged - drop it from NOT_BRIDGED`);
      continue;
    }
    assert.ok(name in api.protocol, `protocol.${name} is exported but never bridged`);
  }
  for (const name of Object.keys(patchModule)) {
    assert.ok(name in api.patch, `patch.${name} is exported but never bridged`);
  }
});

/* ---------------------------------------------------- bridge -> main.js IPC */

test('every IPC channel the bridge can send is handled in main.js', () => {
  const { api, channels } = loadBridge();
  const handled = handledChannels();
  assert.ok(handled.size > 10, 'sanity: main.js registered almost no handlers');

  // Only the namespaces that actually cross the process boundary; protocol and
  // patch are pure functions and calling them here would prove nothing.
  const ipcNamespaces = ['fs', 'session', 'tabs', 'tool', 'term', 'shell'];
  const noop = () => {};
  for (const ns of ipcNamespaces) {
    for (const [member, fn] of Object.entries(api[ns])) {
      if (typeof fn !== 'function') continue;
      // A callback is a valid argument everywhere: the IPC members only pack
      // their arguments into a payload object, and the `on*` members want one.
      fn(noop, noop, noop, noop);
      assert.ok(channels.length, `${ns}.${member} sent nothing over IPC`);
      for (const channel of channels.splice(0)) {
        // 'tool:output' / 'term:output' are pushed FROM main, so they are
        // subscriptions rather than handled channels.
        if (channel.endsWith(':output')) continue;
        assert.ok(
          handled.has(channel),
          `${ns}.${member} invokes "${channel}" but main.js has no handler for it`
        );
      }
    }
  }
});

test('every IPC channel is namespaced, so a typo cannot look like a new feature', () => {
  const { api, channels } = loadBridge();
  const noop = () => {};
  for (const ns of ['fs', 'session', 'tabs', 'tool', 'term', 'shell']) {
    for (const fn of Object.values(api[ns])) {
      if (typeof fn === 'function') fn(noop, noop, noop, noop);
    }
  }

  const prefixes = ['fs:', 'session:', 'tab:', 'tool:', 'term:', 'shell:', 'app:'];
  for (const channel of new Set([...channels, ...handledChannels()])) {
    assert.ok(
      prefixes.some((p) => channel.startsWith(p)),
      `channel "${channel}" is outside every known namespace`
    );
  }
});

/* ------------------------------------------------------------- preload path */

test('the bridge points the chat tabs at a preload file that exists', () => {
  const { api } = loadBridge();
  assert.equal(api.partition, SITE.partition);
  assert.match(api.preloadPath, /^file:\/\//);
  const file = api.preloadPath.replace(/^file:\/\//, '');
  assert.ok(fs.existsSync(file), `webview preload missing: ${file}`);
  // Named after the site key, so retargeting the app stays a one-file change.
  assert.ok(api.preloadPath.endsWith(`preload-${SITE.key}.js`));
});

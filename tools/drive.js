#!/usr/bin/env node
'use strict';
/**
 * Remote-control the running BrowserSmith window over Chrome DevTools Protocol.
 * Start the app with --remote-debugging-port=9222, then:
 *
 *   node tools/drive.js targets
 *   node tools/drive.js eval  "document.title"
 *   node tools/drive.js click "#btn-selftest"
 *   node tools/drive.js log
 *
 * Used to verify the app by operating its real UI, not by mocking it.
 */

const PORT = process.env.CDP_PORT || 9222;

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

/** The control window (index.html), not one of the four chat webviews. */
async function controlTarget() {
  const list = await targets();
  // Must be the control window, not a project preview that happens to be an
  // index.html (the pomodoro build produced exactly that collision).
  const t = list.find((x) => x.type === 'page' && x.url.includes('src/renderer/index.html'));
  if (!t) throw new Error('control window not found - is the app running?');
  return t;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    ws.onopen = () =>
      resolve({
        send(method, params = {}) {
          const msgId = ++id;
          ws.send(JSON.stringify({ id: msgId, method, params }));
          return new Promise((res, rej) => {
            pending.set(msgId, { res, rej });
            setTimeout(() => pending.delete(msgId) && rej(new Error(method + ' timeout')), 600000);
          });
        },
        close: () => ws.close(),
      });
    ws.onerror = (e) => reject(new Error('cdp connect failed: ' + (e.message || 'error')));
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
    };
  });
}

async function evaluate(expression, { awaitPromise = true } = {}) {
  const t = await controlTarget();
  const cdp = await connect(t.webSocketDebuggerUrl);
  try {
    const r = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  } finally {
    cdp.close();
  }
}

const CMDS = {
  async targets() {
    console.log((await targets()).map((t) => `${t.type}\t${t.title}\t${t.url}`).join('\n'));
  },
  async eval(expr) {
    const v = await evaluate(expr);
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  },
  async click(selector) {
    const v = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'NOT FOUND: ' + ${JSON.stringify(selector)};
      el.click();
      return 'clicked ' + ${JSON.stringify(selector)};
    })()`);
    console.log(v);
  },
  /** Run a preload command in one tab: drive.js tab a dumpMenu */
  async tab(which, cmd) {
    const v = await evaluate(`(async () => {
      const wv = document.getElementById('tab-${which}');
      wv.focus();
      await new Promise(r => setTimeout(r, 800));
      const id = 700000 + Math.floor(Math.random() * 100000);
      return new Promise(res => {
        const h = e => {
          if (e.channel === 'drive:done' && e.args[0].id === id) {
            wv.removeEventListener('ipc-message', h);
            res(JSON.stringify(e.args[0], null, 1));
          }
        };
        wv.addEventListener('ipc-message', h);
        wv.send('drive', { id, cmd: '${cmd}', args: {} });
        setTimeout(() => res('TIMEOUT'), 40000);
      });
    })()`);
    console.log(v);
  },
  async log(n = '80') {
    const v = await evaluate(
      `[...document.querySelectorAll('#log > div')].slice(-${Number(n)}).map(d => d.innerText).join('\\n')`
    );
    console.log(v || '(log empty)');
  },
};

const [cmd, ...args] = process.argv.slice(2);
if (!Object.prototype.hasOwnProperty.call(CMDS, cmd)) {
  // Generated, not typed out: a hand-written list silently went stale the day
  // `tab` was added, hiding the one command that drives a webview preload.
  console.error(`usage: drive.js <${Object.keys(CMDS).join('|')}> [arg]`);
  process.exit(1);
}
CMDS[cmd](...args)
  .then(() => process.exit(0)) // the CDP socket keeps the loop alive otherwise
  .catch((e) => {
    console.error('ERROR: ' + e.message);
    process.exit(1);
  });

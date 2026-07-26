# Pre-release audit findings

Criticals are already fixed. Everything below is outstanding.


## LENS: loop

### Defects (17)

- **[major] app.js:563** `if (!res) throw new Error(...)` (line 563) and `throw new Error('planner did not return a usable path')` (line 555) abandon the whole run from inside the planning loop. Everything already written is never installed, never run, never screenshotted and never previewed — a 9-file project dies because file 10 failed review five times. `askForPath` makes this likely: verified that `parsePath('src/app.ts is the next file')` returns null, so one prose answer from the planner (after the single nudge) kills the run.
  - FIX: Replace both throws with `log(...); break;` so control falls through to the verify/preview block on whatever `written` contains, and report the partial outcome in the final log line.

- **[major] app.js:648** The status pill lies about two distinct failures. (a) If the planner answers DONE on its first turn, `written` is empty, the entire verify block (line 594) is skipped, and the run logs 'project done — 0 file(s) … not verified' then sets status('done'). (b) If the user presses Stop during verification, verifyByPlan throws 'stopped', it is swallowed at line 599 as `verify failed: stopped` + `break`, `preview` stays null, and the run returns normally so the click handler also sets status('done'). A stopped run and a run that produced nothing both report success.
  - FIX: Throw (or return a failed result) when `written.length === 0`, and rethrow the 'stopped' error out of the verify try at line 599 so the outer handler shows a distinct 'stopped' status instead of 'done'.

- **[major] app.js:995** parsePassFix computes `pass = /\bPASS\b/ && !/\bFIX\b/`, so any passing verdict that mentions the word 'fix' is inverted into a failure. Verified: `'PASS - no fix needed'` → `{pass:false, fix:true, detail:'needed'}` and `'PASS. Nothing to fix here.'` → `detail:'here.'`. A working preview then enters the fix loop and the planner is asked to rewrite a file to fix the problem 'needed', which regenerates and can break a file that was already correct.
  - FIX: Decide on the FIRST verdict token instead of on presence/absence: `const m = t.match(/\b(PASS|FIX)\b/i); const pass = m && m[1].toUpperCase() === 'PASS';` and only take `detail` from the text after a leading FIX.

- **[major] app.js:294** When seedTab throws inside rotateIfBloated, the catch logs 'chat rotation failed — continuing' and the run continues against a tab that has just been reloaded onto a brand-new chat and therefore holds NO role contract. An unseeded builder returns conversational prose (which finding #2 then writes to disk); an unseeded reviewer returns an essay, parseVerdict returns null, and all 5 build attempts burn before the run dies with 'never got PRINT'. The real cause is one 'continuing' line scrolled far up the activity log.
  - FIX: In the catch at line 293-295, do not continue: `seeded.delete(tag); throw new Error(...)` so buildFile's per-attempt handler reseeds, or retry seedTab once more and abort the round if it still fails.

- **[major] app.js:1247** loadModels correctly refuses to run while `running` (line 1155), but three other controls that touch the same composers have no such guard: the 'All models…' change handler (1247), the per-tab model select handlers (1197), the Self-test button (1268, which types a marker into all four composers and then calls clearComposer on them), and the element pickers (1320). Using any of them mid-run opens the site's popover in, or wipes, the composer the loop is currently typing into. The All-models handler additionally calls `status('idle')` at line 1263, overwriting the live run status.
  - FIX: Add the same `if (running) { log('busy with a run'); return; }` guard to all four handlers, or set `disabled = true` on those controls in the Run click handler and clear it in its finally.

- **[major] app.js:1136** Stop only sets a flag that is polled at loop boundaries; nothing in flight is cancelled. `awaitReply` has a 630 s outer guard (line 249) and `npm install` a 420 s one (line 921), so Stop can take 10+ minutes to have any effect. The button stays enabled, a second click does nothing, and the only feedback is 'stop requested' — the app looks hung.
  - FIX: On click: `abort = true; els.stop.disabled = true; log('stopping after the current step — this can take a few minutes')`. Longer term, thread an AbortSignal through drive() so pending entries can be rejected immediately, and check `abort` between the awaits inside buildFile and verifyByPlan.

- **[major] app.js:1415** Dev servers leak per project slug. runProject only stops the server for the project it is about to build (line 503), and Stop never calls tool.stop at all, so any aborted or failed run leaves its server alive. runAutopilot derives a NEW slug from every request (line 1415), so N autopilot requests leave N dev servers (and N bound ports) running until the window closes — toolchain.stopAll is wired only to 'window-all-closed' (main.js:207).
  - FIX: Call `await tool.stop(project).catch(()=>{})` in runProject's catch/abort path, and have the Stop handler stop the current project's server. Optionally expose a stopAll IPC and call it from Stop.

- **[major] app.js:1390** pollAutopilot advances `watchBaseline = settled` at line 1390 BEFORE the veto checks at 1393-1396, so any delta rejected as too short / PROTOCOL_WORDS / OWN_TRAFFIC is permanently skipped and never logged. Combined with the cooldown branch at 1364-1367, which nulls the baseline on every tick for 30 s after a run ends, anything the user types in the 30 seconds after a build finishes — the most natural moment to type the next request — is silently swallowed with zero feedback.
  - FIX: Move `watchBaseline = settled` to after the accept checks (advance it on rejection only for the OWN_TRAFFIC case), and log a line whenever a delta is ignored, e.g. `log('autopilot: ignored N chars (looked like our own traffic)')`.

- **[major] app.js:1391** Autopilot reads the request via `transcriptTail` (preload-chatgpt.js:1253), a raw character slice of the whole transcript. Tab A is seeded as the PLANNER, so it answers the human's message with a file path — and the delta therefore contains both. The result is used verbatim as the build request (line 1412) and as the project slug (line 1415), producing requests like `build me a snake game\n\napp/page.tsx` and folders like `build-me-a-snake-game-app-page-tsx`.
  - FIX: Add a `lastUserMessage` command to the preload that returns the newest node with `data-message-author-role="user"` (the markup is already queried by messageNodes), and have pollAutopilot use that instead of transcriptTail.

- **[minor] app.js:672** tryPatch's `catch { return null; }` around fs.read swallows every failure — a locked file, an EPERM, a bad path — and reports nothing at all, so the run silently degrades to a full rewrite with no explanation. With finding #1 also failing silently on the same function, the patch path can never succeed and the user is never told why.
  - FIX: `catch (e) { log(`patch skipped: cannot read ${loc.file} (${e.message})`, 'err'); return null; }`.

- **[minor] app.js:299** hardResetTab resolves 3 s after did-stop-loading (or after a blind 25 s timer) without ever checking that the page actually loaded. An offline machine, an expired session, or a Cloudflare interstitial produces a 'successful' reset; the next prepare then fails with 'composer not found - use Pick Composer', which points the user at the element pickers instead of at the real cause (not logged in / no network).
  - FIX: After the load settles, drive a cheap `probe` and reject if `composer` is null or the URL is not on the site host, so the caller can report 'tab A is not on a usable ChatGPT page — check login/network'.

- **[minor] protocol.js:274** condense does not count the elision marker against `max`, so it can return MORE than the budget: verified `condense('x'.repeat(4001)).length === 4031`. For an input barely over the limit it also elides a single character while adding a 30-character marker, i.e. it makes the payload larger and the file less readable for no benefit.
  - FIX: Compute `const MARK = 34;` and return `t` unchanged when `t.length <= max + MARK`; subtract MARK from the head/tail split so the result never exceeds `max`.

- **[minor] protocol.js:411** parseVerdict returns the FIRST of PRINT/RETRY found anywhere in the reply. Verified: `parseVerdict('I would not RETRY this; PRINT')` → `'RETRY'`, which throws away an approved file and burns a full rebuild round (one builder generation plus one review).
  - FIX: Prefer an exact one-word match first (`/^\W*(PRINT|RETRY)\W*$/`), then fall back to the LAST occurrence rather than the first.

- **[minor] patch.js:116** applyPatches runs `norm()` over the entire source, so a successful one-line patch also rewrites every CRLF to LF and strips trailing whitespace from every line of the file. On Windows that silently changes the line endings of a file the user never touched, and in Markdown it deletes two-space hard line breaks.
  - FIX: Normalise only for matching: keep the original `source` string, locate against a normalised copy with an index map, and splice the replacement into the untouched original.

- **[minor] package.json:8** `npm test` runs only `test/protocol.test.js`, so `test/patch.test.js` never executes in CI or for a contributor. Worse, the one test that exists to guard the renderer/bridge seam (protocol.test.js:401 'the bridge exposes every contract protocol name the renderer needs') hardcodes a contract list that omits `condense` and `extractBody` — which is exactly why findings #1 and #2 ship with a fully green suite. Its comment still says `window.notioned.protocol`, a leftover from the sibling port.
  - FIX: Change the script to `node --test test/`, derive the contract array from `Object.keys(protocol)` minus an explicit internals allow-list, and additionally assert that every `protocol.<name>(` referenced in app.js exists on the bridge.

- **[minor] app.js:566** `if (written.length >= FILE_BACKSTOP)` is unreachable as a real guard: `written` grows by at most one per iteration and the enclosing loop is already bounded by `for (let i = 0; i < FILE_BACKSTOP; i++)`, so the for-bound always fires first. The 'runaway guard' the comment describes does not exist — nothing bounds total rounds, wall-clock time, or messages sent.
  - FIX: Make the for-loop bound a ROUND cap (e.g. 400) and keep this as the real file cap, and add a wall-clock/message budget checked in the same place.

- **[minor] app.js:367** `const pending = TAGS_ALL.filter(...)` inside ensureSeeded shadows the module-level `pending` Map declared at line 156, which is the in-flight registry every drive() call depends on. Harmless today only because the inner scope never touches the map — a landmine for the next edit, and the kind of thing a reviewer notices immediately in a repo asking for stars.
  - FIX: Rename the local to `unseeded` (and its uses at lines 367, 369, 374, 379, 389).

### Improvements (10)

- **Stop / cancellation** Make Stop real: thread an AbortSignal through drive() so the pending awaitReply rejects immediately, kill the project's dev server, reset `abort`, and show 'stopped' as its own terminal state instead of 'done'.
  - WHY: Today Stop is a flag polled at loop boundaries — it can take 10+ minutes to take effect, leaves a dev server holding a port, and (via the missing `abort = false` in runAutopilot) permanently disables autopilot. Users will press Stop within the first five minutes of trying this.  (medium)

- **Run budget & visibility** Put a live budget in the header: elapsed time, rounds used, chat messages sent, files written, and a user-set ceiling on each — with the run ending cleanly and previewing what exists when a ceiling is hit.
  - WHY: FILE_BACKSTOP=200 with RETRIES=4 means a single run can send well over a thousand messages to ChatGPT with no time bound. A user who leaves it overnight on an auditor that keeps finding 'one more missing piece' burns their account's rate limits and cannot tell how far along it is.  (medium)

- **Resume & run history** Write a `.buildgpt/run.json` in each project holding request, mode, every path written, each verdict, patches applied and the final preview URL; add a 'Resume' button that continues from the last `written`+`note` instead of restarting the planner from zero.
  - WHY: Any single hard failure (one file that never gets PRINT, one planner prose answer) currently discards the entire run. Resuming a 9-of-10 project instead of rebuilding it is the difference between a demo and a tool people use twice.  (medium)

- **Transparency of writes** Show the exact bytes about to hit disk before writing: file path, reviewer verdict, size, and for patches a highlighted before/after hunk — in a collapsible entry in the Activity panel.
  - WHY: Right now the only trace is `wrote workspace/x (N bytes)`. Two of the three defects that corrupt files (prose written into the body, a stray ``` spliced in by a patch) would be obvious in one glance and invisible in the current log.  (low)

- **Per-role model defaults** Default the reviewer and auditor tabs to the fastest/cheapest model and the builder to the strongest, automatically on first model load, instead of leaving all four on whatever the account default is.
  - WHY: The reviewer and auditor contracts demand a single word (PRINT/RETRY, DONE/one line). Running a reasoning model there costs minutes per file for one token of output — the single biggest wall-clock win available, and a stranger has no way to know it matters.  (low)

- **Preview surface** Show the captured screenshot inline next to the preview URL along with the QA verdict and any error-overlay text, instead of only saving it to `.preview/` and the clipboard.
  - WHY: Screenshot-driven verification is the app's most impressive feature and the user currently never sees the screenshot the whole loop is built around — only a one-line 'verdict:' in the log.  (low)

- **Tab status** Render the current action on each tab header — 'B · Builder · writing app/page.tsx (try 2/5)', 'A · rotating chat (13k)' — rather than only toggling a `busy` CSS class.
  - WHY: With four webviews on screen the user cannot tell which tab is working or why one just reloaded itself; a hard reset currently looks exactly like a crash.  (low)

- **Re-verify without a rebuild** Add a 'Verify again' button that reruns verifyProject on the current project without touching the planner, so a user who hand-edits a file (or fixes an install) can re-run install/serve/screenshot/judge in seconds.
  - WHY: Verification is already a standalone function; today the only way to reach it is a full plan-build-review run, which re-generates files the user just fixed by hand.  (low)

- **Workspace access** Make the workspace panel actionable: click a file to open it, plus an 'Open folder' button (shell.openPath) in the panel head.
  - WHY: The output location moves between dev (`<repo>/workspace`) and the packaged app (next to the .exe, workspace.js:14-21), so a first-time user of the published build genuinely cannot find what was built.  (low)

- **Autopilot feedback** Log every autopilot decision — 'saw 240 new chars', 'ignored: matched our own traffic', 'cooldown, re-baselining' — and show the request it extracted before starting the build, with a 3-second cancel.
  - WHY: Autopilot currently drops user messages silently (baseline advances before the veto checks) and can start a build from a request polluted with tab A's own reply. Both failure modes are invisible, which is why it has misfired in production twice.  (low)


## LENS: main

### Defects (21)

- **[major] src/main/toolchain.js:25** `ALLOWED` gates only the executable name, never the argv, and it lists 12 binaries that `plan()` can never emit: `npx`, `rustc`, `javac`, `java`, `perl`, `uv`, `cmake`, `dart`, `flutter`, `swift`, `elixir`, `mix`. Combined with the free-form `tool:run(project, cmd, args)` IPC, `npx <anything>` alone is registry-wide arbitrary code execution, and `bash -c` / `node -e` / `python -c` are one argv away — the allow-list buys nothing it claims to.
  - FIX: Cut ALLOWED to the set `plan()` actually produces (npm, pnpm, yarn, bun, node, python, python3, pip, pip3, go, cargo, dotnet, mvn, gradle, ruby, bundle, php, deno, bash, sh, make). Better: delete the free-form `tool:run` IPC and expose `tool:runStep(project, stepIndex)` that executes the step from the plan the main process itself just computed, so the renderer can never name a command or an argument.

- **[major] src/main/toolchain.js:548** `plan()` puts a model-chosen on-disk filename straight into argv with no `--` separator and no leading-dash rejection (`cmd: (bin, entry) => ({ cmd: bin, args: [entry] })`, same at lines 523, 557, 566, and 725). A file named e.g. `-cimport os;os.system('...')#x.py` satisfies `endsWith('.py')` and is executed by `python` as `-c` code, not as a script. This is not hypothetical: `workspace/build-me-a-standalone-web-search-engine-that-run/-w` is a 91KB file with a leading dash sitting in the workspace right now.
  - FIX: In `plan()`, drop any candidate whose basename starts with `-` (`files.filter(f => !path.basename(f).startsWith('-'))`), and pass every entry as an explicit relative path — `['./' + entry]` on POSIX, `['.\\' + entry]` on Windows — plus `--` where the runtime supports it (`node --`, `go run --`).

- **[major] src/main/toolchain.js:47** `spawnSpec` routes npm/npx/pnpm/yarn through `ComSpec /d /s /c` with `shell:false`. Node quotes argv with MSVCRT rules, which cmd.exe does not use — cmd.exe still expands `&`, `|`, `^`, `<`, `>` and `%VAR%` inside those quotes (the CVE-2024-27980 / BatBadBut class). The comment claims "no model text ever reaches a shell line", but nothing in the function enforces that; `run()`'s `args` parameter is free-form and reaches this path.
  - FIX: Validate before the ComSpec spawn: `for (const a of args) if (!/^[A-Za-z0-9._@:=,+\-\/\\]+$/.test(a)) throw new Error('unsafe argument for cmd.exe: ' + a);` — and pass `windowsVerbatimArguments: false` explicitly so the intent is documented.

- **[major] src/shared/patch.js:138** `parseErrorLocation` accepts `..` and `node_modules` in the path it extracts (`[\w./-]+` matches both), and its result is used unvalidated at `src/renderer/app.js:671` and `:711` as `fs.write(`${project}/${loc.file}`, ...)`. An error overlay from the model-generated app reporting `../other-project/index.js:12` silently overwrites a *different* project's file; the common Next.js case `node_modules/next/dist/.../x.js:1` makes the fix loop burn a full round patching a dependency that the next `npm install` reverts.
  - FIX: Reject in `parseErrorLocation`: `if (m[1].split('/').includes('..') || /(^|\/)node_modules\//.test(m[1])) continue;` before returning.

- **[major] src/main/session-store.js:104** `s.webRequest.onHeadersReceived` is registered with no URL filter, so X-Frame-Options is deleted and `frame-ancestors` is stripped from the CSP of *every* response in the `persist:chatgpt` partition — including any third-party site the user reaches through an OAuth/SSO hop inside a tab. `content-security-policy-report-only` is also not handled.
  - FIX: Scope the filter: `s.webRequest.onHeadersReceived({ urls: ['https://*.chatgpt.com/*', 'https://*.openai.com/*'] }, cb)` (drive it from `SITE.cookieDomains` so the seam holds), and strip `frame-ancestors` from the report-only header too.

- **[major] src/main/toolchain.js:1094** `runShell` children are never registered anywhere. A user typing `npm run dev` or `python server.py` into the built-in terminal starts a process that `stopServer`, `stopAll` and app quit all ignore — it outlives the app with no way to kill it from the UI. The same is true of `run()`'s children (line 89): a 7-minute `npm install` keeps running after quit.
  - FIX: Keep a module-level `const live = new Set()`, add every child on spawn and remove it on `close`, and have `stopAll()` treeKill everything in `live` in addition to the `servers` map.

- **[major] src/main/toolchain.js:100** `run()` accumulates every stdout/stderr chunk into `chunks` with no cap, then returns `chunks.join('')` across IPC. A generated Python script that prints in a loop for its 120s timeout, or a verbose native build, buffers hundreds of MB in the main process and then structured-clones it to the renderer — an OOM in the one process whose death takes the whole app with it.
  - FIX: Cap the buffer: keep a running byte count, and once it exceeds ~256KB shift from the front (`while (bytes > MAX) bytes -= chunks.shift().length`). The caller only ever uses `tailLines(res.out, 20-30)` anyway.

- **[major] src/main/toolchain.js:319** `await win.loadURL(url)` in `screenshot()` has no timeout. A dev server that accepted the TCP connection but never finishes the response (a hung SSR render, an infinite redirect) parks the entire run indefinitely — `judgePage` awaits it, and the offscreen BrowserWindow is never destroyed because `finally` is not reached.
  - FIX: `await Promise.race([win.loadURL(url), new Promise((_, rj) => setTimeout(() => { win.webContents.stop(); rj(new Error('preview did not load in 30s')); }, 30000))])` — the `finally` already destroys the window.

- **[major] package.json:2** No `license` field and no LICENSE file anywhere in the repo — legally "all rights reserved", which is the first thing a reviewer checks on a repo asking for stars, and it blocks any corporate use. Also missing `author`, `repository`, `bugs`, `homepage`, and `engines` (tools/drive.js uses the global `WebSocket`, which requires Node >= 22 — on Node 20 it dies with "WebSocket is not defined").
  - FIX: Add a LICENSE file (MIT), and to package.json: `"license": "MIT"`, `"author"`, `"repository": {"type":"git","url":"..."}`, `"bugs"`, `"homepage"`, `"engines": {"node": ">=22"}`.

- **[major] README.md:92** The Safety section claims "`npm install` executes package install scripts … Everything is confined to the project folder." That is false: install scripts and the generated program run as the user with the full inherited environment (`env: { ...process.env }` at toolchain.js:94 and :165), so they can reach anything the user can. The section also never mentions that `pip install -r requirements.txt` from a model-authored manifest is run automatically (toolchain.js:546), which executes arbitrary `setup.py` at install time.
  - FIX: Replace with an accurate warning: model-authored `package.json`/`requirements.txt` are installed and their install hooks execute with the user's full privileges and environment — file writes are confined to `workspace/`, process privileges are not. Run `npm install --ignore-scripts` by default with an explicit opt-in toggle in the UI, and name pip explicitly.

- **[major] src/renderer/app.js:16** The renderer destructures `window.buildgpt` as a hard-coded literal while `src/main/preload-control.js:116` exposes the bridge under `SITE.brand`. `src/renderer/index.html` lines 93/101/109/117 likewise hard-code `https://chatgpt.com/?temporary-chat=true` in all four webviews, despite `src/shared/site.js` being documented as "the single place the target chat product is defined". The imminent BrowserSmith rename will change `SITE.brand` and produce a blank window whose only symptom is a destructure TypeError in devtools.
  - FIX: Read the bridge dynamically (`const api = window[document.documentElement.dataset.brand] || window.buildgpt`), or simply expose under a fixed key like `'bridge'` and keep `SITE.brand` for display copy only. Set the four webview `src` attributes from `site.url` in app.js instead of in the HTML, and leave `src` out of index.html.

- **[major] src/main/main.js:10** `sessionStore.pinProfileDir()` runs at module top-level, before the single-instance lock is evaluated on line 14, and `app.whenReady().then(...)` on line 81 is registered outside the `else` branch. A second launch therefore calls `app.setPath('userData', ...)` on the profile the first instance is actively using and races into `assertWritable`, which writes a `.write-probe` file into it — the exact "two processes sharing a cookie store" scenario the comment on line 12 says must not happen.
  - FIX: Move both `pinProfileDir()` and the whole `app.whenReady()` block inside the `else` of the lock check, and use `app.exit(0)` rather than `app.quit()` in the not-acquired branch so nothing further runs.

- **[minor] src/main/main.js:189** The `shell:open` host allow-list is `localhost` / `127.0.0.1` only. `new URL('http://[::1]:5173').hostname` is `'[::1]'`, so "Open in browser" throws for any IPv6-bound dev server. `URL_RE` at toolchain.js:60 has the same gap, so such a server never gets a URL detected at all and `startProcessServer` rejects with "dev server printed no URL in time".
  - FIX: Add `'[::1]'` and `'::1'` to `hostOk`, and extend URL_RE to `https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?...`.

- **[minor] src/main/main.js:181** `shell:open` correctly rejects non-localhost, but the renderer's only caller (`src/renderer/app.js:137-144`) pre-filters on `/^https?:\/\//` — so for a `static`-kind plan, whose preview URL is a `file:///` path, the "Open in browser" button always fails with "external open only works for http(s) preview URLs". Static HTML is one of the six shipped modes; its Open button is dead.
  - FIX: Add an `shell:openFile` IPC that runs the path through `workspace.resolveSafe` and calls `shell.openPath(full)`, and have the renderer route `file:` URLs there.

- **[minor] src/renderer/index.html:3** No `Content-Security-Policy` meta tag on the control window. Electron prints its "Insecure Content-Security-Policy" security warning to the console on every launch — the first thing anyone opening devtools on this app sees.
  - FIX: Add `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'">`. Webviews are unaffected by the embedder's CSP.

- **[minor] src/main/main.js:74** All four chat webviews carry `allowpopups` (index.html:93/101/109/117) and there is no `app.on('web-contents-created')` handler installing `setWindowOpenHandler` or a `will-navigate` guard. Any popup the site (or a generated page in the preview webview) opens becomes an unconstrained BrowserWindow that can navigate anywhere, including `file://`.
  - FIX: `app.on('web-contents-created', (_e, wc) => { wc.setWindowOpenHandler(({ url }) => allowedOrigin(url) ? { action: 'allow' } : { action: 'deny' }); wc.on('will-navigate', (e, url) => { if (!allowedOrigin(url)) e.preventDefault(); }); })`, allowing only `SITE.cookieDomains` and localhost.

- **[minor] src/main/workspace.js:24** `resolveSafe` confines by string prefix on the *logical* path and never resolves symlinks. `npm install` on a model-authored `package.json` containing `"dep": "file:../../../.."` creates a junction/symlink under `node_modules/`, after which a write to `proj/node_modules/dep/anything` passes the prefix check and lands outside `workspace/`.
  - FIX: After computing `full`, realpath the nearest existing ancestor and re-check containment: `const base = await fsp.realpath(existingAncestorOf(full)); if (base !== ROOTREAL && !base.startsWith(ROOTREAL + path.sep)) throw ...` (compare against `fs.realpathSync(ROOT)`).

- **[minor] src/main/session-store.js:130** `app.on('before-quit', () => { clearInterval(flushTimer); flush(); })` fires and forgets an async `flushStore()`; `before-quit` does not wait for promises, so the process can exit mid-flush — defeating the stated purpose ("never lose a login on close") on exactly the quit path where `window-all-closed`'s awaited flush does not run.
  - FIX: Guard and defer: `let quitting = false; app.on('before-quit', (e) => { if (quitting) return; quitting = true; e.preventDefault(); clearInterval(flushTimer); flush().finally(() => app.exit(0)); });`

- **[minor] package.json:9** `"test": "node --test test/protocol.test.js"` names one file; `test/patch.test.js` exists and is never executed by `npm test`, so the patch engine — the code that rewrites the user's files — has coverage that silently never runs in CI.
  - FIX: `"test": "node --test test/"`.

- **[minor] tools/drive.js:4** Stale prior-product branding in a repo about to be published as BrowserSmith: line 4 says "the running notioned window" and line 22 says "not the two Notion webviews" (there are four, and the target is ChatGPT). `src/mcp/server.js:13` also registers the server name as `'buildgpt'`.
  - FIX: Update both comments to the new product name and tab count, and drive `McpServer({ name })` off `SITE.brand` so the rename is a one-file change as the architecture claims.

- **[minor] src/main/toolchain.js:340** `clipboard.writeImage(...)` silently destroys whatever the user had on the clipboard, on every screenshot — several times per run, with no warning anywhere in the UI or README. Whatever the user copied before hitting Run is gone.
  - FIX: Save `clipboard.readImage()`/`readText()` before writing, restore it after `tab:paste` completes, and note the clipboard use in the README.

### Improvements (9)

- **Dev-server lifecycle** Show running servers in the UI: a small strip listing project, command, port and PID, each with a Stop button, fed by a `tool:servers` IPC over the existing `servers` map. Add a startup reclaim that detects a port already bound by a previous crashed run and offers to kill it.
  - WHY: Right now a leaked or crashed server is invisible — the user finds out when the next run fails with EADDRINUSE and has no way to fix it from inside the app.  (~1 hour)

- **Install safety** Before running install steps, show the model-authored dependency list (package.json deps / requirements.txt lines) in the activity feed with a one-click 'Install' confirmation, and run `npm install --ignore-scripts` / `pip install --no-cache-dir` by default with a settings toggle for full scripts.
  - WHY: The app currently installs and executes arbitrary packages an LLM named, with zero visibility. This is the single objection an experienced engineer will raise in the first GitHub issue, and it is cheap to answer.  (~2 hours)

- **First-run experience** Add a preflight panel on launch: profile dir writable, Node/npm/python versions found, ChatGPT login status, workspace path — each a green/red row with the exact fix text. Replace the current silent failure when `assertWritable` rejects.
  - WHY: A stranger on a fresh machine currently gets either a blank window or a mid-run 'command not allowed' with no context. The RUNTIMES table already computes binary availability; surfacing it costs almost nothing.  (~2 hours)

- **Toolchain output** Give the terminal panel per-project tabs and a persisted `workspace/<project>/.buildgpt/run.log`, instead of one shared 800-line ring buffer that mixes dev-server output, install output and human commands.
  - WHY: When a run fails, the interesting output has usually already scrolled out of the ring buffer, and there is no artifact left on disk to read afterwards.  (~3 hours)

- **Portability** Add `npm run package:win` / `package:mac` / `package:linux` scripts with explicit `--ignore` rules, plus a GitHub Actions release workflow that builds all three and attaches them to a tag.
  - WHY: The repo has @electron/packager as a devDependency and a commit claiming a portable Windows executable, but no reproducible way to build it — the first thing a would-be contributor tries and cannot do.  (~2 hours)

- **Preview URLs** Serve static projects over a tiny built-in `http://127.0.0.1:<port>/` static server rooted at `workspace/<project>/` instead of `file:///`.
  - WHY: It fixes three things at once: the dead 'Open in browser' button for static mode, the absolute-machine-path leak into the ChatGPT prompt, and the `file://` origin restrictions (fetch, modules, service workers) that make generated static apps fail in preview but work when deployed.  (~2 hours)

- **Fix loop** When `parseErrorLocation` points inside `node_modules`, treat it as a dependency problem: re-run install, or ask the planner to change the dependency, rather than asking the builder to patch a vendored file.
  - WHY: Next.js and Vite overlays name `node_modules` paths constantly; today each one burns a full model round producing a patch that the next install silently reverts.  (~1 hour)

- **Determinism / cost** Persist a per-run transcript (`workspace/<project>/.buildgpt/run-<ts>.json`) with every prompt, reply, plan, command, exit code and verdict, and add a 'Replay' that re-runs the toolchain steps without touching the chat tabs.
  - WHY: Debugging a bad build currently means watching four chat tabs live. A replayable record is also what turns a demo repo into something people file useful issues against.  (~4 hours)

- **Runtime coverage** Surface `plan()`'s decision in the UI as an editable card — detected language, install steps, serve/run command, definition of done — with an override the user can pin per project.
  - WHY: `plan()` already computes exactly this and explains itself via `why` and `doneMeans`, but the user only sees a one-line log entry and cannot correct a wrong guess without editing files on disk.  (~3 hours)


## LENS: driver

### Defects (14)

- **[major] src/main/preload-chatgpt.js:272** `if (Date.now() - stopCache.at < STOP_SWEEP_MS) return null;` converts a single missed selector hit into ~700ms (3-4 consecutive polls) of reported "not generating". `stopCache.at` is only refreshed on a successful selector hit or a full sweep, so when ChatGPT re-renders the stop button for one frame the early return fires repeatedly without ever re-sweeping. Combined with `idleTicks >= 5` at line 932 (only 1.0s of absence) and the fact that PLACEHOLDER deliberately makes status-line churn look like "no text change", one flicker plus a 500ms real gap returns a partial reply.
  - FIX: Separate "unknown" from "idle": keep a `lastStopSeenAt` timestamp updated on every positive detection, and in awaitReply count an idle tick only when `Date.now() - lastStopSeenAt > 3000`. Also raise `idleTicks >= 5` to `>= 15` (3s) so it cannot be satisfied by the sweep-throttle window alone.

- **[major] src/main/preload-chatgpt.js:743** `afterEcho` anchors with `full.lastIndexOf(anchor)` over the entire transcript, so it finds the LAST occurrence — which is inside the model's reply whenever the reply restates the anchor. The build prompt's first line is `PATH: <path>` and its last line is the `Output only the complete contents of <path>...` instruction; a reply that opens with the path (very common) or quotes the instruction gets cut at that point and everything before it is discarded. This is the small-answer path, used for every reply under BIG_ANSWER (6000 chars), i.e. most files and every reviewer verdict.
  - FIX: Bound the search to the echo region instead of the whole string: `const i = full.indexOf(anchor, Math.max(0, before.length - anchor.length));` and take the first match at or after the pre-send baseline. Better still, when `messageNodes()` carries `data-message-author-role` (always, on ChatGPT), use `freshAnswerNode(wanted)` unconditionally in replyDelta rather than only above the BIG_TRANSCRIPT/BIG_ANSWER thresholds — the role attribute already proves which node is the answer, so string anchoring is not needed at all.

- **[major] src/main/preload-chatgpt.js:100** User-picked selector overrides are read with raw `document.querySelector` at lines 100, 132, 294 and 381, not with the `q1()` wrapper that exists three lines above for exactly this reason. `cssPath` builds selectors from arbitrary `data-*` attribute values, and `setSelectors` accepts arbitrary strings; a selector Chromium refuses to parse throws a SyntaxError straight out of `findComposer`/`findOutputRoot`/`findSendButton`/`findModelTrigger`, failing `prepare` and every subsequent command. Because the override is sticky in module state, the tab is permanently dead until reload. notioned/src/main/preload-notion.js uses `q1()` at all four sites.
  - FIX: Replace `document.querySelector(state.XSelector)` with `q1(state.XSelector)` at lines 100, 132, 294 and 381.

- **[major] src/main/preload-chatgpt.js:1288** Pick mode is write-only. `setSelectors` is defined here but grep across the whole repo finds no caller; the renderer only logs the `picked` event (src/renderer/app.js:167-169) and never stores it. Overrides live solely in this preload's module scope, and `hardResetTab` (src/renderer/app.js:299-311) sets `wv.src = site.url` on every chat rotation (every 12000 transcript chars) plus at run start, reloading the preload and discarding every pick. The file header sells pick mode as the rescue for a ChatGPT redesign; in practice it survives a few rounds.
  - FIX: In app.js, keep a `picks` map per tag, populate it in the `picked` handler, persist it via session-store, and re-send `drive(wv, 'setSelectors', picks[tag])` from each webview's `did-finish-load` listener (one already exists at app.js:1216 for model loading).

- **[major] src/main/preload-chatgpt.js:1176** The pick-mode click handler accepts whatever the user clicks with no validation and no cancel path: a stray click on the page background stores `body > div:nth-child(2)` as the composer override, which then silently beats every heuristic (and, per the finding above, can throw). There is no Escape-to-cancel and no way to clear an override from the UI.
  - FIX: Validate before storing — `composer` must satisfy `isEditable`, `send`/`model` must be a `button`/`[role=button]` (climb with `e.target.closest('button,[role="button"]')` so clicking an inner `<svg>` records the button), `output` must be scrollable — and `sendToHost('picked', {which, selector:null, rejected:true})` otherwise. Add a `keydown` Escape listener that clears `state.picking` and the crosshair cursor, and a `setSelectors` call with empty values wired to a Clear button.

- **[major] src/main/preload-chatgpt.js:253** The stop button is the one selector awaitReply cannot do without, and it is the only hook `startPick` (line 1183-1186) does not cover — pick supports composer/output/send/model only. If ChatGPT renames `data-testid="stop-button"` and drops the "stop" aria-label/title, `isGenerating()` is permanently false, `sawGenerating` never becomes true, and every reply falls to the no-signal branch at line 933 that returns after 12s of unchanged filtered text. A long fenced block renders with no per-tick innerText growth, so that branch returns truncated files rather than merely being slow. The "a redesign degrades instead of breaking" claim in the header comment does not hold for this selector.
  - FIX: Add `'stop'` to the pick targets and to `state` (used first in `findStopButton`), and add a positive idle signal so absence-of-stop is not the only vote: treat the tab as idle only when `findSendButton()` returns a non-disabled element AND no stop button is found, since ChatGPT swaps one for the other.

- **[major] src/main/preload-chatgpt.js:259** `findStopButton` has no proximity anchoring, unlike notioned/src/main/preload-notion.js:332-367 which gates every candidate through `nearComposer()`. `button[aria-label*="stop" i]` matches ChatGPT's read-aloud playback control — the CHROME regex at line 730 confirms read-aloud buttons are in this DOM — so while a message is being read aloud `isGenerating()` is true page-wide. awaitReply is built never to return while that is true, so every round burns its full 600s timeout and then hits the partial-return defect at line 941.
  - FIX: Port `nearComposer(el, slack = 240)` from preload-notion.js:332 and apply it in all three branches of `findStopButton` (cached check, selector loop, full sweep), exactly as notioned does.

- **[major] src/main/preload-chatgpt.js:1216** `declutter`'s climb guard is a single hardcoded id: `!node.querySelector('#prompt-textarea')`. There is no conversation-root guard, no cap on the button's own text length, no cap on the ancestor's text length, and no stop at `document.body`/`documentElement` — all four of which notioned has (preload-notion.js:1257-1280). Any wide (>250px) short (<220px) ancestor within 6 levels of a banner-text button gets `display:none !important` with no restore path. The moment ChatGPT renames `#prompt-textarea` — the exact redesign this file exists to survive — or the user picks a different composer, declutter can hide the composer's own container or the model switcher's header, permanently, and the only recovery is a reload.
  - FIX: Port the notioned guards into the climb loop: `if (node === document.body || node === document.documentElement) break; if (composer && node.contains(composer)) break; if (root && node.contains(root)) break; if ((node.textContent||'').length > 400) break;`, hoisting `const composer = findComposer(); const root = findOutputRoot();` above the button loop, and cap the button match with `t.length > 60` as notioned does at line 1262.

- **[major] src/main/preload-chatgpt.js:469** `listModels` filters menu labels through `MODEL_HINT` only — `MODEL_DENY` is applied to the trigger (line 408) but never to the menu contents. ChatGPT's model menu contains an upgrade/upsell row and a "Legacy models" submenu entry (`\blegacy\b` is in MODEL_HINT), so both are offered in the app's own model dropdown as if they were models. Selecting the upsell opens a paywall; selecting the submenu opens a submenu. `selectModel` then compounds it: line 503 clicks and returns after 400ms with no `closeMenu()`, so the submenu is left open on top of the composer for the next `prepare`/`clickSend`.
  - FIX: Add `&& !MODEL_DENY.test(l)` to both label filters in listModels (lines 469 and 474). In selectModel, `await closeMenu()` on the success path too, and verify the trigger label actually changed before reporting success — if it did not, close and throw so the caller can report a real failure instead of logging the old model as the new one.

- **[major] src/main/preload-chatgpt.js:697** `prepare()` returns `{ cleared }` to report that the composer still holds the previous prompt, and no caller ever reads it — src/renderer/app.js:211, 235 and 1079 all do a bare `await drive(wv, 'prepare', {}, 15000)`. `emptyComposer` relies on `document.execCommand('selectAll'/'delete')`, which silently no-ops when the webContents is not focused, so on an unattended run the old prompt survives and `webContents.insertText` appends the new one after it. app.js's landing check (`normalizeForCompare(seen).includes(want)`, line 223) passes on the concatenation, so a doubled prompt is sent with no warning.
  - FIX: Have `ask()` capture the prepare result and, when `cleared` is false, clear from the main process instead — add an ipc handler that calls `wc.selectAll()` then `wc.delete()` (trusted input, focus-independent, same path already used for `insertText`) — and only fall back to failing the round if the composer is still non-empty after that.

- **[major] src/main/preload-chatgpt.js:829** `return full.startsWith(before) ? full.slice(before.length) : full;` — when the echo was never seen and ChatGPT's virtualization has unmounted earlier turns so the transcript no longer starts with the baseline, replyDelta returns the ENTIRE conversation as the "reply". It is stable and non-empty, so awaitReply returns it, and `protocol.extractBody` concatenates every fenced block in it (fencedBlocks + `blocks.map(b => b.body).join('\n')`) into one file — several earlier files glued together and written to disk under the current path.
  - FIX: When `!echoSeen`, do not fabricate a delta: return `''` from replyDelta so awaitReply keeps waiting, and let the 600s timeout throw. The caller already treats a thrown timeout as a blind chat and hard-resets the tab, which is the correct recovery; silently writing the whole transcript to a file is not.

- **[minor] src/main/preload-chatgpt.js:1078** `newChat()` is unreachable for this site — src/shared/site.js sets `freshChatByNavigation: true`, so src/renderer/app.js:273 always takes the `hardResetTab` branch and the `newChat` drive command is never issued. Forty lines of ChatGPT-specific DOM guessing ship untested. If it were reached it would also be wrong twice: line 1108 accepts a composer that is not editable (`if (!c) continue`, where notioned:1160 uses `isEditable`), and line 1109 gates on `transcript().length < 2000`, which on an empty new chat falls through to `findOutputRoot().innerText` — with no messages the scrollable-ancestor walk fails and the largest-scroller fallback resolves to the sidebar chat-history list, so on any account with history `chars` never drops below 2000 and it throws even after succeeding.
  - FIX: Delete `newChat` and its bridge case, or gate the loop on `isEditable(c) && messageNodes().length === 0` instead of a character count.

- **[minor] src/main/preload-chatgpt.js:521** `fenceOf` falls back to `pre.innerText` when the block has no `<code>` child — which reintroduces exactly the toolbar text the function's docstring exists to strip. ChatGPT's `<pre>` carries `python\nCopy\nEdit\n` inside the block, so a code block rendered without a `<code>` wrapper gets `Copy`/`Edit` fenced into the top of the file. `protocol.clean` only removes those when they are the whole line, which they are here, so it happens to survive today — but the fence's language line does not, and the rebuilt fence claims a language it read from a class that does not exist.
  - FIX: When `pre.querySelector('code')` is null, drop the leading toolbar lines explicitly (`body.replace(/^(?:[\w+#-]+\n)?(?:Copy|Edit)\n(?:Copy|Edit\n)*/,'')`) or return the raw text unfenced rather than guessing a fence around chrome.

- **[minor] src/main/preload-chatgpt.js:819** The big-answer fast path in `replyDelta` returns `readMessage(answer)` before ever calling `transcript()`, so `tCache.text` stops being refreshed the moment that path engages. Every subsequent evaluation of `tCache.text.length >= BIG_TRANSCRIPT` is tested against a frozen value — the transcript-size half of the threshold silently stops working for the rest of the reply, leaving only the answer-size half.
  - FIX: Track the transcript size in its own variable updated by `transcript()`, or test `messageNodes().reduce((n, el) => n + el.textContent.length, 0)` which costs no layout, instead of reading a cache the fast path deliberately bypasses.

### Improvements (8)

- **reply detection** Emit progress from awaitReply. It already recomputes `meaningful` every 200ms — add `ipcRenderer.sendToHost('progress', { id, chars: meaningful.length, generating })` and render a live character counter and a generating dot per tab in the renderer.
  - WHY: Today a 4-minute file generation is indistinguishable from a hung tab; the single most common reason a new user kills the app is that nothing moves for minutes.  (small — one sendToHost in the poll loop, one ipc-message case in app.js bind())

- **reply detection** Return a reason with every reply: `{ text, why: 'stop-button-cleared' | 'no-signal-quiet' | 'timeout-salvage', sawGenerating, idleTicks, stableFor }`, and log it. Warn loudly in the UI on anything other than 'stop-button-cleared'.
  - WHY: All three of the historical truncation bugs returned through a fallback branch. Right now a truncated file and a clean finish look identical in the log, so the failure is only discovered when the app runs the broken code.  (small)

- **selector resilience** Persist picked selectors per site and re-apply them on every `did-finish-load` (setSelectors already exists and is dead code), add a `stop` pick target, and show the active overrides plus a Clear button in the diagnose panel.
  - WHY: Pick mode is the advertised answer to "ChatGPT redesigned overnight", and it currently evaporates on the next chat rotation. This is the difference between a redesign costing a user 30 seconds and costing them the app.  (medium)

- **diagnostics** One "Export DOM report" button that writes selftest + probe + dumpButtons + dumpMenu for all four tabs to a JSON file in the workspace, with a copy-ready GitHub issue template.
  - WHY: When the markup changes, the maintainer needs the four things this file already knows how to produce. Without it every issue is "it stopped working" and the fix cycle is days.  (small — all four commands exist; this is a button and a fs:write)

- **onboarding** Run selftest automatically on first load of each tab, show a red/green strip per hook (page, login, composer, transcript, model, stop button), and disable Run until composer and transcript pass — with the failing row linking straight to its Pick button.
  - WHY: A stranger on a fresh machine currently discovers breakage as a 10-minute timeout mid-build. The self-test already tells you in 200ms; nothing surfaces it before the run.  (small)

- **shared driver** Extract the site-independent engine (awaitReply, transcript/message cache, prepare, pick mode, declutter skeleton) into src/shared/driver.js and reduce each preload to a selector table plus site quirks. The two preloads are ~1000 lines each and ~85% identical, and they have already diverged on five behaviours that matter (timeout salvage guard, q1 on overrides, nearComposer, isEditable in newChat, declutter guards).
  - WHY: Every bug fixed in one repo is a bug still shipping in the other — which is precisely how the timeout salvage guard exists in notioned and not in buildgpt. It also makes the header's "pointing the app at a different chat UI is a one-file change" claim true, which is a real selling point for the public repo.  (large)

- **declutter** Record what was hidden (`WeakSet` of nodes plus their original display value), restore it when the banner text is gone, and log `hid banner container <cssPath>` once per node.
  - WHY: Right now a mis-targeted hide is invisible, permanent and only fixable by reload — and the user has no way to know that the reason the model dropdown vanished is the app's own declutter pass.  (small)

- **throughput** Adopt notioned's 500ms node caches for findComposer/findOutputRoot (preload-notion.js:96-143), and make `chars` return a layout-free size (sum of messageNodes textContent lengths) instead of building the whole transcript string.
  - WHY: `chars` runs before every single askRole via rotateIfBloated, and probe/transcriptTail are polled — each currently forces a full-document layout flush in a tab that may be mid-stream. Less jank directly reduces the frozen-transcript condition that produces partial replies.  (small)


## LENS: ux

### Defects (22)

- **[major] app.js:1099** `refreshFiles` renders `fs.list()` for the whole workspace root — every file of every project ever built, unsorted, capped at 400 — into a 118px-tall panel, so after the second build the file you just generated is buried among unrelated projects and the panel is worthless as "what did it make?".
  - FIX: Filter to `currentProjectSlug()`, strip the project prefix, sort with newly-written paths first, mark files written in this run with a coloured dot, and put the count in the panel head (`workspace/my-app/ · 14 files`).

- **[major] index.html:179** The generated project is a dead end: `#files` renders plain non-interactive `<li>` text, there is no "open folder" / "show in explorer" affordance anywhere (main.js only exposes `session:reveal` for the .profile dir, and it is never wired to any button), and `shell:open` rejects everything except http(s) on localhost — so nothing in the UI can take a user to the files it just wrote. In the packaged build they land in `workspace/` beside the .exe, a path the app never displays.
  - FIX: Add `ipcMain.handle('workspace:reveal', (_e,{project}) => shell.openPath(path.join(workspace.ROOT, project||'')))`, expose it in preload-control.js, put an "Open folder" button in the `workspace/` panel head, and make each `<li>` clickable to `fs.read` the file into the preview view.

- **[major] app.js:397** The headline capability — the app screenshots the running project and looks at it — is invisible to the user: the PNG is written to `workspace/<project>/.preview/preview.png` (toolchain.js:337) and `NOISE_RE` then filters `.preview` out of the files list, so the only trace is a log line reading "screenshot 128KB". The user never sees the image the auditor judged.
  - FIX: Append an `<img>` thumbnail (from the returned file path, or a data URI) into the activity feed when `tool.screenshot` resolves, and add a third segment next to Agents/Preview showing the last screenshot full size.

- **[major] app.js:82** A run takes many minutes and the only progress signal is a single replaced string in `#status` plus a pulsing dot — no elapsed time, no step counter, no "file 3 of ~8", no indication whether a five-minute silence is a long generation or a hang. `status()` also toggles a `.working` class that has no rule in style.css (dead code).
  - FIX: Track `runStartedAt` in the Run handler, render `status` as `planner · file 3 · 04:12` with a `setInterval` ticking the elapsed clock, add a thin indeterminate progress bar under the header while `running`, and delete the dead `.working` toggle.

- **[major] app.js:1136** Stop only sets `abort = true`, which is checked between awaits — an in-flight `awaitReply` holds for up to 630s (app.js:249), so Stop can appear to do nothing for ten minutes while the button stays enabled, the status text keeps advancing and the only feedback is one grey log line "stop requested".
  - FIX: On click set the button to `Stopping…`, disable it, set `status('stopping — finishing the current reply')`, and reject the outstanding `pending` promises immediately (walk the `pending` map and reject with 'stopped') so the loop unwinds at once.

- **[major] app.js:1187** When the tabs are not logged in yet — i.e. on every fresh install — the four automatic model loads fail quietly and each dropdown ends up reading the literal string "no models found". The first screenshot a visitor sees is an app with four broken-looking dropdowns.
  - FIX: Branch on session state: render `<option>sign in to load models</option>` while `!loggedIn`, `<option>loading models…</option>` during the retry loop, and only fall back to a "couldn't read the model menu — try ⟳" option after a genuine failure while logged in.

- **[major] style.css:534** `.sidebar { overflow: hidden }` combined with the fixed heights below it (#prompt 104px, #terminal 128px, #files 118px, activity min 110px) needs ~740px of sidebar height; on any window shorter than roughly 950px — a 1366×768 laptop, or a non-maximised window on 1080p — the terminal input and the entire `workspace/` panel are clipped off the bottom with no scrollbar and no way to reach them.
  - FIX: Set `overflow-y: auto` on `.sidebar`, convert `#terminal`/`#files` fixed heights to `min-height` + `flex`, and give the sidebar a `min-height: 0` flex child layout that degrades by scrolling rather than clipping.

- **[major] main.js:54** The window opens hardcoded at 1680×1000 with no clamp to the display work area, no `minWidth`/`minHeight` and no `maximize()`; on a 1366×768 laptop Electron centres it at x≈-157, pushing ~160px of the 360px sidebar — the app's only control surface — off the right edge of the screen on first launch.
  - FIX: Read `screen.getPrimaryDisplay().workAreaSize` and use `Math.min(1680, workArea.width)` / `Math.min(1000, workArea.height)`, add `minWidth: 1100, minHeight: 720`, and call `win.maximize()` when the work area is smaller than the requested size.

- **[major] toolchain.js:340** Every verification round silently overwrites the user's system clipboard with the preview PNG (`clipboard.writeImage`) — whatever they had copied is gone, repeatedly, with no warning in the UI or the README.
  - FIX: Snapshot `clipboard.readText()`/`readImage()` before the paste and restore it after `tabs.paste` completes in askWithImage, and say "uses the clipboard to hand screenshots to the reviewer" in the README and in the Advanced menu note.

- **[major] preload-chatgpt.js:20** Picked selector overrides live only in the preload's in-memory `state` object, and the app navigates tabs constantly (`hardResetTab`, rotation every ~12KB, `did-navigate`) — so the Advanced menu's advertised "rescue hatch for when ChatGPT's UI changes" is wiped within minutes of a run and always lost on restart, with no indication in the UI that an override is (or is no longer) active.
  - FIX: Persist overrides via a `selectors:get/set` IPC into a JSON file under the profile dir, re-apply them on every `dom-ready`, show a badge on the picker button when an override is active, and add a "reset selectors" item to the menu.

- **[major] index.html:137** Mode defaults to Next.js, the single heaviest option: a first-time user typing "make me a snake game" gets a full Next.js scaffold plus an `npm install` of next/react/react-dom before anything appears, and nothing in the UI explains what a mode does — the `MODES[key].hint` strings in protocol.js are written but never shown, and the dropdown labels ("Vite + React", "Static HTML", "Node CLI", "Auto-detect") don't even match the labels the log prints ("Vite", "Static site", "Node.js", "Auto").
  - FIX: Default the select to `auto`, render `protocol.MODES[value].hint` in a helper line under the dropdown on change, add a cost hint for scaffolded modes ("scaffolds + npm install, ~60s first run"), and generate the `<option>` list from `protocol.MODES` so labels can never diverge.

- **[major] package.json:6** `@electron/packager` is a devDependency but there is no `package`/`dist` script and the README never mentions building, so a stranger cannot produce the "portable Windows executable" the project advertises; `assets/icon.svg` is likewise never referenced by BrowserWindow (`icon:` is absent in main.js:53) or by any packager config, so the window, taskbar and every screenshot show the default Electron logo.
  - FIX: Add `"package": "electron-packager . BrowserSmith --platform=win32 --arch=x64 --icon=assets/icon.ico --out=dist-app --overwrite"`, commit a converted `assets/icon.ico`/`icon.png`, pass `icon:` to `new BrowserWindow`, and document the command in the README.

- **[major] README.md:1** The repo has no LICENSE file at all, and the README leads with an ASCII diagram rather than a screenshot or GIF of the running app — for a public launch aiming at stars, the first is a legal blocker for anyone evaluating adoption and the second throws away the only marketing asset the project has (a 2×2 grid of agents building something live).
  - FIX: Add an MIT LICENSE file and a `license` field to package.json, and put a 10-second GIF (prompt typed → four tabs glowing → preview tab showing the running app) directly under the H1.

- **[minor] app.js:1117** `if (!request || running) return;` makes the Run button a silent no-op on an empty prompt, and there is no login guard either — clicking Run while logged out starts a doomed run that fails minutes later with the cryptic "composer never received the prompt".
  - FIX: Show inline validation (focus the textarea, flash its border, log "describe what to build first"), and disable Run with the tooltip "log in to ChatGPT in tab A first" while `session.status().loggedIn` is false.

- **[minor] index.html:123** The Preview view is an unexplained dead end before the first build: a black webview showing `about:blank`, a URL bar reading "about:blank", and an "Open in browser" button whose only effect is an error line in the log (app.js:139-141).
  - FIX: Render an empty state in the preview view ("Nothing running yet — start a build and your app appears here"), and disable `#btn-open-external` until `#preview-url` holds an http(s) URL.

- **[minor] app.js:112** The only keydown handler in the entire renderer is the terminal input: there is no Ctrl/Cmd+Enter to Run from the prompt box, no Esc to Stop, no shortcut to switch views or focus a tab, and no ↑/↓ history in the terminal — every action requires a mouse trip to the sidebar.
  - FIX: Add a document-level keydown map: Ctrl/Cmd+Enter → Run, Esc → Stop, Ctrl+1..4 → focus tab A–D, Ctrl+P → toggle Agents/Preview, Ctrl+L → clear log; keep a command array in the terminal input for ↑/↓ recall.

- **[minor] style.css:16** `--faint: #6f6f7a` on the panel background (#0c0c10) is ≈3.9:1 — below WCAG AA 4.5:1 for normal text — and it is used for the prompt placeholder (style.css:138), the terminal placeholder (663) and all three empty-state strings (607, 631, 677), i.e. exactly the text a first-time user must read on an empty app.
  - FIX: Lift `--faint` to about #8a8a96 (≈5.6:1) or reserve it for decorative use only and render empty-state/placeholder copy in `--muted`.

- **[minor] app.js:125** The Agents/Preview segmented control is styled purely by `:has()` in CSS while `setView` toggles an `.active` class that no rule matches (dead code), the buttons carry no `aria-pressed`, and the four `<webview>` elements have no accessible name — a screen reader user gets four unlabelled frames and a toggle with no state.
  - FIX: Drop the dead `.active` toggles, set `aria-pressed` on both segment buttons in `setView`, and give each webview a `title`/`aria-label` ("Planner chat", "Builder chat", …).

- **[minor] index.html:165** `#log` is `aria-live="polite"` while carrying hundreds of build lines, so a screen-reader user has every raw log line read aloud during a run; `#status` is a second live region announcing the same transitions.
  - FIX: Set the log to `aria-live="off" role="log"` and keep a single polite live region for milestone announcements only (seeded, file written, verdict, done/failed).

- **[minor] index.html:5** The product name is hardcoded in the page (`<title>buildgpt</title>` and `<span class="brand">buildgpt</span>`) and the webview URLs hardcode `https://chatgpt.com/?temporary-chat=true` (lines 93, 101, 109, 117), defeating the site.js abstraction that the rest of the codebase carefully honours — and the page title overrides the `title: SITE.brand` set in main.js:57, so the rename will leave the window still called buildgpt.
  - FIX: Set `document.title` and the brand span text from `site.brand` at startup in app.js, and assign each webview's `src` from `site.url` in the same loop that already sets preload/partition (app.js:58-61).

- **[minor] drive.js:4** Public-repo copy still references the sibling project: "Remote-control the running notioned window" (line 4) and "not the two Notion webviews" (line 22), and test/protocol.test.js:413 comments about `window.notioned.protocol` — the first thing a curious engineer greps for looks like a half-finished fork.
  - FIX: Replace the stale product names with the new brand and the correct "four chat webviews" wording before publishing; add a `grep -ri notion` check to the test script.

- **[minor] index.html:173** The built-in terminal offers no placeholder text next to the `$`, no hint that it runs PowerShell inside the current project folder, and no indication of which folder it is in — an empty caret with no context.
  - FIX: Add `placeholder="npm run build — runs in workspace/<project>/ (PowerShell)"` and render the resolved project folder in the Terminal panel head.

### Improvements (12)

- **First run / onboarding** A dismissible first-run checklist card that occupies the sidebar above the prompt: (1) Log in to ChatGPT in tab A — auto-checks when the session pill flips and auto-reloads B/C/D; (2) Pick a mode — with a one-line explanation; (3) Describe what to build — with three clickable example prompts ("a snake game", "a markdown notes app", "a CLI that renames photos by EXIF date"). Disappears permanently after the first successful run.
  - WHY: Today the entire instruction set for a stranger is one grey log line at the bottom of a dense sidebar, and the four tabs open on an unexplained login page. This is the difference between a 30-second first build and closing the tab.  (~120 lines of HTML/CSS/JS in the renderer, plus one localStorage flag)

- **Run progress** Replace the single status string with a live run header: elapsed clock, current phase (plan → build → review → audit → verify), current file name, files-written count, and a per-phase spinner; each agent tab head also shows what it is doing right now ("writing app/page.tsx", "reviewing 4.2KB") instead of only glowing.
  - WHY: Runs last minutes with zero feedback about whether progress is happening or the loop is stuck — the most common reason a user kills a tool that is actually working. It also makes the marketing screenshot self-explanatory.  (medium — status plumbing already exists, needs a structured state object instead of strings)

- **Output / results** Turn the `workspace/` panel into a real result surface: scoped to the current project, new files flagged, click a file to read it into a syntax-highlighted viewer in the work area, a diff badge when a path is rewritten (the loop allows up to 3 writes per path), plus "Open folder" and "Copy path" buttons.
  - WHY: The app writes real projects and then gives the user no way to look at a single line of what it wrote — the payoff of the whole run is currently invisible inside the product.  (medium — `fs.read` already exists; needs one reveal IPC and a viewer pane)

- **Results / trust** Show the screenshot the auditor judged, inline: thumbnail in the activity feed at the moment it is taken, click to enlarge, with the detected page title and any error-overlay text beside it.
  - WHY: "It looks at the running app" is the single most differentiating claim of the project, and right now the user has to take it on faith from a log line stating a file size.  (small)

- **Failure handling** Structured failure cards in the activity feed instead of red log lines: a card with the stage (install / serve / screenshot / review), the first error line, an expandable full output, and action buttons — Retry this step, Open the file at the error location, Copy the report.
  - WHY: Every failure today is a one-line red string in a mono log; a new user cannot tell a recoverable dev-server hiccup from a dead run, and cannot file a useful issue.  (medium)

- **Shareability** A "Copy run report" button that emits markdown: prompt, mode, elapsed, files written with byte counts, verdicts, and the preview screenshot path — one click, ready to paste into a GitHub issue or a tweet.
  - WHY: Makes bug reports actionable and turns every successful run into free marketing; costs almost nothing since all the data is already in memory.  (small)

- **Keyboard** Ctrl/Cmd+Enter to run from the prompt box, Esc to stop, Ctrl+1–4 to focus an agent tab, Ctrl+P to flip Agents/Preview, Ctrl+L to clear the log, ↑/↓ history in the terminal, and a `?` overlay listing them.
  - WHY: The product is aimed at engineers, and it currently has exactly zero shortcuts — every single action is a mouse trip.  (small)

- **Settings** A real settings sheet in the Advanced menu: workspace folder location, per-file retries and the runaway backstop (both hardcoded at app.js:54-55), reply timeouts, autopilot poll interval, "restore clipboard after screenshots", and "reset picked selectors".
  - WHY: Anything a user wants to tune today requires editing source; and the workspace location in a portable build is undiscoverable.  (medium)

- **Project history** A project switcher above the prompt listing previous `workspace/*` folders with their last run time — click to re-open a project, re-preview it (restart its dev server), continue building on it, or delete it.
  - WHY: The workspace already accumulates builds (six folders in this very repo) but the app treats every run as if the past does not exist; a stranger's second session starts from nothing.  (medium)

- **Mode clarity** Under the mode dropdown, render the mode's own `hint` text plus what it will do first ("scaffolds Next.js + npm install — about a minute before the first file"), and default to Auto so a small request stays small.
  - WHY: Modes are the one decision the user must make before pressing Run and the UI explains none of them; the current default silently commits a "make me a snake game" request to a full Next.js install.  (small)

- **Agent tabs** Per-tab controls in each `.tab-head`: reload, open this chat in the system browser, and a visible state chip (idle / typing / waiting for reply 01:12 / rate-limited) driven by the same events the busy class already uses.
  - WHY: When a tab hits a ChatGPT usage limit or lands on a captcha, the app currently just times out; the user is staring at the answer on screen with no way for the app to acknowledge it.  (medium)

- **Screenshot marketing** Ship an app icon, a proper window title, and a light-on-dark "hero" state: brand mark, the four labelled agents mid-build with the emerald glow, and a preview tab showing a finished app — then use exactly that frame in the README and the release page.
  - WHY: The default Electron icon and stock menu bar are in every screenshot the project will ever publish, and they read "weekend hack" before anyone reads a line of the README.  (small)


## LENS: repo

### Defects (22)

- **[major] package.json:2** No LICENSE file anywhere in the repo and no `license` field in package.json, so the code is legally all-rights-reserved: nobody can fork, redistribute, or use it at a company, and GitHub's sidebar will show no license badge.
  - FIX: Add a top-level `LICENSE` (MIT is the norm for this class of tool) and `"license": "MIT"` to package.json.

- **[major] package.json:9** `"test": "node --test test/protocol.test.js"` runs only one of the two test files — test/patch.test.js (10 tests, all passing, verified) never executes. patch.js is the surgical find/replace repair path, i.e. the exact code whose failure mode is silently corrupting a user's file; test/patch.test.js:78 is literally named "refuses an ambiguous FIND rather than corrupting the file" and nothing runs it.
  - FIX: Change to `"test": "node --test test/"` (Node 20+ globs the directory), so adding a test file can never again mean adding a file nobody runs.

- **[major] package-lock.json:2** The committed lockfile (git show HEAD:package-lock.json) still declares `"name": "notioned"` at lines 2 and 8 while package.json says `buildgpt` — the published lockfile advertises the abandoned project name and is out of sync with the manifest.
  - FIX: After the BrowserSmith rename, run `npm install --package-lock-only` and commit, so both files carry one name. (The working tree has since been regenerated to `buildgpt` by a concurrent npm install, but HEAD — what a visitor clones — still says notioned.)

- **[major] package.json:4** Zero public-repo metadata: no `author`, `repository`, `homepage`, `bugs`, `keywords`, or `engines`. `engines` matters concretely — six dev-dependency entries in package-lock.json (lines 28, 45, 101, 167, 211, 229) require `node >=22.12.0`, and nothing tells a user on Node 20 LTS that before npm starts spewing EBADENGINE.
  - FIX: Add `"author"`, `"repository": {"type":"git","url":"git+https://github.com/<org>/browsersmith.git"}`, `"bugs"`, `"homepage"`, `"keywords"`, `"license"`, and `"engines": {"node": ">=22.12.0"}`; add a matching `.nvmrc`.

- **[major] .github/workflows/ci.yml:1** No CI at all — 576 lines of genuinely good tests exist and pass, and nothing runs them on push or PR. There is also no badge and no `npm test` mention in the README, so a visitor evaluating the repo in 10 seconds has no evidence the project is tested.
  - FIX: Add a workflow running `npm ci && npm test` on `windows-latest`, `ubuntu-latest`, `macos-latest` (the app has platform branches at src/main/toolchain.js:16/1107 and src/main/main.js:147 that nothing exercises), and put the status badge on README line 1.

- **[major] package.json:14** `sharp@^0.35.3` and `png-to-ico@^3.0.2` were added as devDependencies but no script in package.json uses them. sharp pulls platform-specific native binaries, so every stranger's first `npm install` now downloads tens of MB of image-processing natives (on top of Electron's ~100MB) for a build step that does not exist.
  - FIX: Commit the generated `.ico`/`.icns` into `build/` and remove both devDependencies, or move icon generation into a separate `tools/icon/package.json` that is not installed by the root manifest.

- **[major] README.md:23** The "Run" section is `npm install` / `npm start` and nothing else — it never states which OS is supported, which Node version is required, that a ChatGPT **account** is mandatory, or that a free-tier account's message caps will stall a run that sends hundreds of messages per project. A stranger on a clean machine cannot tell whether this will work for them before spending 100MB and a login.
  - FIX: Add a Requirements block above Run: OS support (README.md:56 says the terminal is PowerShell, but toolchain.js:1107 falls back to /bin/sh — say explicitly which platforms are tested), `Node >= 22.12`, "a ChatGPT account you are willing to log into; expect a paid plan for anything non-trivial — a single project is hundreds of messages".

- **[major] README.md:31** README promises "A packaged build keeps that same `.profile/` folder next to the executable, so the whole thing stays portable" and `@electron/packager` is a devDependency, but package.json has no `package`/`build` script and the README never gives the command. The required flags (`--no-asar`, `--out build-out`) exist only inside commit 8b40357's body.
  - FIX: Add `"package:win": "electron-packager . --platform=win32 --arch=x64 --no-asar --out build-out --overwrite"` to scripts and reference it from the README.

- **[major] README.md:31** No git tags (`git tag -l` is empty), no CHANGELOG, no GitHub Release — and the portable .exe will be unsigned, so Windows SmartScreen shows "Windows protected your PC — Unknown publisher" on first launch. Most first-time users click "Don't run" and never come back, and nothing in the repo warns them.
  - FIX: Tag `v0.1.0`, add CHANGELOG.md (Keep a Changelog format), publish a Release with the zipped portable build plus SHA256SUMS, and add a README line: "The build is unsigned — Windows will show SmartScreen. Click More info → Run anyway, or verify the SHA256 against the release." State whether code-signing is planned.

- **[major] README.md:87** The "Safety" section covers path sandboxing and cookie handling but says nothing about the fact that the app drives the ChatGPT web UI at hundreds of automated messages per run, which OpenAI's Terms of Use prohibit outside the API — and the current name embeds "GPT", which OpenAI's brand guidelines forbid in product names.
  - FIX: Add a Disclaimer section: not affiliated with or endorsed by OpenAI; ChatGPT and the OpenAI logo are trademarks of OpenAI; automating the web UI may violate OpenAI's Terms of Use and you are responsible for your own account. The BrowserSmith rename fixes the trademark half — purge the remaining `buildgpt` strings while you are there (README:1,84; package.json:2; toolchain.js:879; app.js:16,663; index.html:5,10; style.css:2; site.js:13).

- **[major] README.md:1** No screenshot, GIF, or demo anywhere in a 94-line README for an app whose entire pitch is visual — four live chat panes driving each other plus a running app preview. The 10-second star decision is made on the first screenful, and right now that screenful is an ASCII diagram.
  - FIX: Put a 20-30s GIF directly under the H1: type one sentence → the four tabs light up in sequence → the preview tab shows the finished app running. This is the highest-leverage single change for the star target.

- **[major] src/main/toolchain.js:25** The command allow-list (lines 25-36), the Windows ComSpec spawn path (`spawnSpec`, line 47), the `command not allowed` rejection (line 79), and `projectDir`'s reliance on `workspace.resolveSafe` (line 66) are the security boundary of the entire app — model output decides what runs — and toolchain.js has zero tests across all 1184 lines. preload-chatgpt.js (1299 lines) is likewise untested.
  - FIX: Add test/toolchain.test.js asserting: `run()` rejects a command outside ALLOWED; `spawnSpec('npm', ...)` produces `['/d','/s','/c','npm',...]` on win32 and a bare argv elsewhere; `projectDir('../../etc')` throws; `scaffold()` never overwrites an existing file (the `wx` flag at line 1070).

- **[major] src/renderer/index.html:93** src/shared/site.js:7 claims "pointing the app at a different chat UI is a one-file change", but index.html hardcodes `https://chatgpt.com/?temporary-chat=true` in four `<webview src>` attributes (93, 101, 109, 117) and the literal string "ChatGPT" in nine places (12, 25, 31, 89, 97, 105, 113, 153). Worse, those four webviews begin loading from HTML before app.js:58-60 attaches `preload` and `partition`, so the first navigation of every agent tab is unguarded.
  - FIX: Remove `src` from the four webviews in index.html and have app.js set `preload`, `partition`, and `src = site.url` together in the same loop; render the role labels and menu copy from `site.name` instead of the literal. Then the docstring's claim is actually true — which is what an engineer who reads site.js and then index.html will check.

- **[major] SECURITY.md:1** No SECURITY.md, so a researcher who finds an issue in an app that stores live session cookies on disk, runs `npm install` on model-authored package.json files, and spawns 30 allow-listed binaries has no private disclosure channel and will open a public issue.
  - FIX: Add SECURITY.md with a reporting address (or enable GitHub private vulnerability reporting), the supported-version policy, and an explicit non-goal: "model replies are untrusted input; the trust boundary is workspace/<project>/ plus the ALLOWED list in src/main/toolchain.js."

- **[minor] .gitignore:6** Ignores `dist-app/` and `build-out/`, but @electron/packager's default `--out` is the current directory, producing `buildgpt-win32-x64/` (~250MB of Electron) in the repo root, which is not ignored. The first contributor who runs the packager without the undocumented `--out build-out` sees 250MB of untracked binaries in `git status`.
  - FIX: Add `*-win32-*/`, `*-darwin-*/`, `*-linux-*/`, `out/`, `dist/`, `*.log`, `.env*` to .gitignore.

- **[minor] .gitattributes:1** No .gitattributes — every git operation in this Windows checkout warns "LF will be replaced by CRLF the next time Git touches it", so a Windows contributor's first commit will carry whole-file line-ending churn that buries the real diff.
  - FIX: Add `.gitattributes` with `* text=auto eol=lf` and `*.ps1 text eol=crlf`.

- **[minor] test/protocol.test.js:413** Stale `notioned` references survive in files that will be public: this comment says the bridge is forwarded onto `window.notioned.protocol` (it is `window.buildgpt`); tools/drive.js:4 says "Remote-control the running notioned window"; tools/drive.js:22 says "not the two Notion webviews" when there are four ChatGPT webviews.
  - FIX: Update all three comments during the rename pass; `git grep -i notioned` and `git grep -i notion` must come back empty.

- **[minor] tools/drive.js:129** The usage string prints `usage: drive.js <targets|eval|click|log> [arg]` but CMDS also implements `tab` (line 99), so the one command that drives a webview preload is invisible to anyone reading the error.
  - FIX: Change to `usage: drive.js <targets|eval|click|tab|log> [arg]`, or generate it from `Object.keys(CMDS).join('|')`.

- **[minor] test/protocol.test.js:392** The workspace test creates `workspace/test-proj-<pid>/` inside the user's real project directory — cleaned up in `t.after`, but an interrupted or crashed run leaves scratch folders sitting among the user's actual generated projects, and CI on a fresh clone silently creates the directory as a side effect.
  - FIX: Let src/main/workspace.js honour a `BUILDGPT_WORKSPACE` env override in `computeRoot()` and point the test at `fs.mkdtemp(os.tmpdir())`.

- **[minor] (git history — all 12 commits):?** Every commit is authored as `soufiane <soufian3hm@gmail.com>`, and commit 8b40357's body still says "the Notion login" — both become permanent and scrapeable the moment the repo is pushed public.
  - FIX: If the personal address should not be public, rewrite before the first push (`git filter-repo --mailmap` to a `<id>+<user>@users.noreply.github.com` address) — this is the last moment it is cheap. If it is a deliberate choice, leave it. Either way the stale "Notion login" line in 8b40357 is worth an amended history since you are rewriting anyway.

- **[minor] CONTRIBUTING.md:1** No CONTRIBUTING.md, no .github/ISSUE_TEMPLATE, no PR template, no CODE_OF_CONDUCT — a project targeting 1000 stars will get bug reports that are unreproducible screenshots of a ChatGPT UI that has since changed.
  - FIX: Add a bug-report issue template that requires: OS, Node version, app version, mode used, the exact prompt, and the Activity-panel log. Add CONTRIBUTING.md documenting `npm test`, the DOM-driver conventions (no class-name selectors — the codebase already honours this), and the element-picker rescue path for UI changes.

- **[minor] package.json:4** `git remote -v` shows `origin` pointing at the local sibling `C:/Users/AZUS TUF/Desktop/notioned`, and package.json has no `repository` field, so nothing in the tree or config points at the project's eventual home.
  - FIX: Repoint `origin` at the GitHub URL before pushing and add the matching `repository` field. (The remote lives in .git/config and is never published, so this is a workflow gap, not a leak.)

### Improvements (10)

- **README / first impression** Open with a 20-30s GIF: one sentence typed into the sidebar, the four tabs lighting up in sequence, the Preview tab showing the finished app running. Follow it with a three-bullet "why this is different" (no API key, real running app not a code dump, real errors read out of the framework overlay) before any architecture diagram.
  - WHY: The star decision is made on the first screenful. Right now the first screenful is an ASCII diagram, which reads as a side project; a working GIF of four AI tabs building and running an app reads as a product.  (half a day)

- **Onboarding** When `session.status().loggedIn` is false, overlay tab A with a large "Log in to ChatGPT here — tabs B, C and D share this login automatically" card instead of only writing it to the Activity log (src/renderer/app.js:1503, :1464). Dismiss it the moment the auth cookie appears.
  - WHY: A first-run user sees four identical ChatGPT login screens and no indication that logging into one covers all four. The single most likely first-minute abandonment.  (2 hours)

- **Onboarding** Add 3-4 one-click example prompts as chips under the prompt textarea ("a hill climb racing game", "a markdown notes app in Next.js", "a CLI that renames files by EXIF date") — reuse the ones the repo has actually built, which are sitting in workspace/.
  - WHY: An empty textarea with 'Describe what to build' converts far worse than a chip a user can click and watch. Also demonstrates the mode range without reading docs.  (1 hour)

- **Distribution** Add `npm run package:win` plus a GitHub Actions release workflow that builds on tag push and attaches a zipped portable build with SHA256SUMS, then a Download button at the top of the README.
  - WHY: Most of the audience will never run `npm install` on an Electron repo. Right now there is no download, no tag, and no documented way to produce the .exe the README already promises.  (half a day)

- **Trust / security posture** Add a short 'What this app can do to your machine' section: it runs `npm install` on package.json files an AI wrote, it spawns the 30 executables listed in toolchain.js:25-36, and it holds your ChatGPT session in ./.profile. Link each claim to the enforcing line of code.
  - WHY: An experienced engineer's first question about an app that runs AI-authored code is exactly this, and the codebase already has good answers (allow-list, no shell, sandboxed paths). Not stating them reads as not having thought about it.  (1 hour)

- **Observability / shareability** Write a per-run transcript to `workspace/<project>/.run/run.json` (mode, prompt, every planner/builder/reviewer/auditor exchange, verdicts, retries, build output, final verify result) and add an "Export run" button.
  - WHY: Lets users post 'here is exactly what the four agents did to build this' — the highest-signal shareable artifact this project can produce, and it makes bug reports reproducible instead of being screenshots of a since-changed ChatGPT UI.  (1 day)

- **Cross-platform confidence** Either run the app once on macOS and Linux and say so in the README, or state plainly "Windows only for now; macOS/Linux paths exist but are untested" — and add the CI matrix so the platform branches (toolchain.js:16, :1107, main.js:147) at least compile and unit-test everywhere.
  - WHY: Silence on OS support means every macOS visitor assumes it works, tries it, hits the PowerShell path, and opens an issue. An honest one-liner converts that into a 'good first issue' instead of a bad review.  (2 hours for the disclaimer + CI, more to actually verify)

- **Rename hygiene** Make the brand genuinely single-source before renaming: fixed contextBridge global, `site.brand` used for the window title / header / CSS comment, `site.url` used for the four webview `src` values, and one test asserting `git grep -i buildgpt` finds nothing outside site.js.
  - WHY: The BrowserSmith rename currently touches nine files and silently breaks the renderer at app.js:16. Fixing the seam first makes the rename a one-line change and makes site.js's own docstring true — which is a claim reviewers will check.  (3 hours)

- **Reliability signalling** Surface the retry/rotation machinery in the UI: a small per-tab counter showing rounds sent, chat rotations, and retries, plus a 'chat rotated (transcript too large)' line in Activity.
  - WHY: The self-healing described in README lines 59-72 is the most impressive engineering in the project and is currently invisible — users only see it as a mysterious pause. Making it visible turns the app's hardest problem into a feature people screenshot.  (3 hours)

- **Adoption surface** Ship the MCP server as a documented, standalone entry point with its own README section showing the full Claude Code / Cursor config block, and give it read access to the run transcript above (`run_read`) alongside workspace_list/read/write.
  - WHY: The MCP angle is the cheapest path to a second audience — people who will never run the Electron app but will happily add an MCP server. Right now it is four lines at README:74-85 and easy to miss entirely.  (3 hours)

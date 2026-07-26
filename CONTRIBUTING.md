# Contributing to BrowserSmith

Thanks for looking. This is a DOM driver bolted to a build system, so most of
the interesting rules here are counter-intuitive until you have watched a live
run fail. Read [The non-negotiables](#the-non-negotiables) before changing
anything under `src/main/preload-chatgpt.js` or `src/renderer/app.js`.

## Dev loop

```bash
npm install          # Electron and the build tooling; the tests need none of it
npm start            # launches the app
npm test             # the suite
npm run lint         # ESLint
npm run format:check # Prettier
```

Bare `node --test` from the repo root discovers every test file on every
supported Node version, so a new test file can never be one nobody runs. The
protocol and patch tests need nothing but Node built-ins; the toolchain tests
load `src/main/toolchain.js`, which requires `electron` at module scope, so run
`npm install` first.

`node --check <file>` parses an Electron-only file (main process, preloads,
toolchain) without launching Electron. CI does this across every file in `src/`
and `tools/` on both operating systems, on Node 20 and 22.

Packaged builds go through electron-builder, configured in
`electron-builder.yml`:

```bash
npm run package:win    # NSIS installer, portable .exe and zip
```

Two things in that config are load-bearing. `asar: false`, because the webview
`preload` attribute is a `file://` URL built from `__dirname` and a `file://`
URL inside `app.asar` is not resolved through Electron's asar shim — the chat
tabs would boot with no DOM knowledge at all. And `files:` is an allow-list, not
a filter, because `.profile/` holds a live logged-in session and `workspace/`
holds whatever was generated on that machine. Neither may ever be packaged.

### What to run before opening a PR

1. `npm test` — all tests pass.
2. `npm run lint` and `npm run format:check` — clean.
3. `node --check` on every Electron-only file you touched.
4. If you touched the driver, **run the app** and build one real project. There
   is no substitute; unit tests cannot catch a selector that no longer matches.

## Where things live

| Path | What it owns |
| --- | --- |
| `src/shared/protocol.js` | The wire contract: modes, the four role prompts, tag builders, and every parser that turns a chat reply into a path, a verdict or a file body. Pure functions, fully unit-tested. |
| `src/shared/patch.js` | Find/replace patching. Pure, unit-tested, and the one place a bug silently corrupts a user's file. |
| `src/shared/site.js` | Everything site-specific: name, URL, auth cookies, brand. Nothing else should name the chat product. |
| `src/main/preload-chatgpt.js` | **All** DOM knowledge. Injected into each chat tab. |
| `src/main/toolchain.js` | Installing, running, serving, screenshotting, scaffolding. The command allow-list lives here. |
| `src/main/workspace.js` | The path sandbox. |
| `src/renderer/app.js` | The orchestrator: the loop, retries, rotation, verification, autopilot. |
| `test/` | `node:test`. New test files are picked up automatically by bare `node --test`. |

## The non-negotiables

Each of these was learned from a production failure. If a change appears to make
one unnecessary, it is far more likely that the failure is simply not visible in
your test. Say so in the PR and explain what you did to check.

- **Typing and focus go through the main process** (`webContents.insertText`,
  `webContents.focus`), never synthetic DOM events. ProseMirror ignores
  untrusted input events while the window is unfocused, which is most of an
  unattended run.
- **`awaitReply` must never return while the UI reports generating**, and must
  never drop blank lines from a body. Returning early yields half a file that
  looks complete; filtering blank lines strips every paragraph break from every
  file the app produces.
- **The reviewer gets a condensed body, never a whole file.** A 51KB paste
  wedged the composer, the readiness check timed out, and the run silently
  skipped review.
- **Chat rotation and hard-reset recovery stay.** Long transcripts blind reply
  detection; a blind chat never recovers in place.
- **Autopilot must not trigger on the orchestrator's own relay traffic.**
- **npm-family commands spawn through `ComSpec` on Windows.** Node 20.12+ throws
  `EINVAL` on `.cmd` with `shell: false`.
- **Auto mode must not default to `index.html`.** `inferMode` returns `auto`
  unless the request carries an explicit stack signal.
- **`extractBody`, not `unfence`, derives file bodies**, and patches strip code
  fences before applying.
- **Nothing may ever send an absolute filesystem path into a chat tab.** It
  leaks the OS username.

## DOM driver conventions

`src/main/preload-chatgpt.js` is the only file allowed to know about ChatGPT's
markup, and it follows three rules:

1. **No generated class names, ever.** They change without warning. Use stable
   hooks (`#prompt-textarea`, `data-testid="send-button"` / `"stop-button"`,
   `data-message-author-role`) and give every one of them a geometry or ARIA
   fallback, so a redesign degrades instead of breaking.
2. **Assume the element is a lie until re-checked.** The site swaps stop back to
   send by re-rendering the same element with new attributes. A cached node that
   is still on screen is not proof of anything.
3. **Never force layout in a poll.** `innerText` flushes layout for the whole
   document. Polling a 60KB transcript five times a second with `innerText` is
   what starved the tab and made long replies arrive truncated. Use
   `textContent` for change detection and `innerText` only when the rendered
   text is the answer.

If ChatGPT's UI changes and a selector stops matching, the user-facing rescue
path is **Advanced → Element pickers**: click a picker, then click the real
element in the tab, and the override is remembered. Fix the heuristic in code
too, but the picker is what keeps the app usable in the meantime.

## Style

- Comments explain **why**, never what the next line does. If a comment could be
  deleted without losing information, delete it.
- Prettier and ESLint decide formatting: `npm run format` before you push, and
  no reformatting-only diffs in a PR that is about something else.
- CommonJS (`require`), `'use strict'`, two-space indent.
- No emoji in code, comments, UI copy or commit messages.
- Product copy says "BrowserSmith". The brand string lives in
  `src/shared/site.js` and nowhere else.

## Pull requests

- One concern per PR. A driver fix and a UI change are two PRs.
- Say what you ran. "Built a Next.js todo app end to end on Windows, Node 22"
  is worth more than any description of the diff.
- If you changed a parser, add a test with the **real** malformed reply that
  motivated it. Every parser in `protocol.js` exists because of a specific
  broken output; the tests read like a museum of them, and that is the point.

## Reporting bugs

Use the issue templates. A driver bug without the Activity-panel log and the
exact prompt is not reproducible — the UI on the other end may have changed
between your run and ours.

Security issues go through [SECURITY.md](SECURITY.md), not the issue tracker.

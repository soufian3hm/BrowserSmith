<!--
  One concern per PR. A driver fix and a UI change are two PRs.
  Read CONTRIBUTING.md if you have not — the non-negotiables there each came
  from a production failure.
-->

## What this changes

<!-- One paragraph. What was wrong, and what the change does about it. -->

## Why

<!-- The failure that motivated it. If you saw it live, describe the run. -->

## How it was verified

- [ ] `node --test` passes
- [ ] `node --check` passes on every file touched
- [ ] Ran the app and built at least one project end to end

Details (OS, Node version, mode, the request you typed, what the app produced):

<!-- e.g. Windows 11, Node 22.12, Next.js mode, "a markdown notes app" —
     7 files, dev server up, preview PASSED on the first verify round. -->

## Non-negotiables

Confirm the change preserves these, or explain why it does not need to:

- [ ] Typing and focus still go through the main process, not synthetic events
- [ ] `awaitReply` still never returns while the UI reports generating, and
      still keeps blank lines
- [ ] The reviewer still receives a condensed body, never a whole file
- [ ] Chat rotation and hard-reset recovery still work
- [ ] Autopilot still ignores the orchestrator's own relay traffic
- [ ] npm-family commands still spawn through `ComSpec` on Windows
- [ ] Auto mode still does not default to `index.html`
- [ ] `extractBody` still derives file bodies, and patches still strip fences
- [ ] No absolute filesystem path can reach a chat tab
- [ ] No generated class-name selectors were added to the driver

## Tests

<!-- If you changed a parser, add a test using the real malformed reply that
     motivated it. If you did not add tests, say why. -->

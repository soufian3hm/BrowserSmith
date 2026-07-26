# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Nothing has been tagged yet. Everything below is staged for **1.0.0**, the first
release.

## [Unreleased]

### Added

- Four-tab agent loop: planner, builder, reviewer and auditor, each seeded with
  its own role contract and driven entirely by the orchestrator. The only
  control the user touches is the request box.
- Verification after the build: dependencies installed, dev server started or
  entry point run, the page driven past its start screen, then screenshotted
  and judged. Verification is derived from what is on disk, not from the mode,
  so a project can both serve an API and preview a page.
- Real error reading: the framework error overlay is pulled out of the shadow
  DOM (`nextjs-portal`, `vite-error-overlay`, the webpack dev-server overlay),
  alongside console errors and dev-server compile output, and pasted into the
  next prompt as one field.
- Surgical patching (`src/shared/patch.js`): a stack trace's file and line
  become a numbered excerpt and a find/replace patch request, instead of a
  whole-file rewrite. A FIND that matches more than once is refused rather than
  applied to the wrong copy.
- Modes with real scaffolds: Auto, Next.js, Vite, Static site, Node.js, Python.
  Framework modes write a runnable starter before the agents begin, and never
  overwrite a file that already exists.
- Runtime table covering Go, Rust, .NET, Java (Maven and Gradle), Ruby, PHP,
  Python, Deno, shell and make — detection, install, and run-or-serve, with an
  explicit "detected but no runtime installed" plan instead of an invented
  verification.
- Autopilot: type one request directly into the planner's chat and the app takes
  over, builds the project, and reports back into the same chat.
- Terminal panel for human-typed commands, scoped to the current project folder.
- Preview tab showing the running app, with an Open button for the system
  browser.
- Per-tab model selection, a self-test that inspects the live DOM without
  sending anything, and element pickers to re-teach a selector when the chat UI
  changes.
- MCP stdio server (`npm run mcp`) exposing `workspace_list`, `workspace_read`
  and `workspace_write` over the same workspace.
- Packaging through electron-builder: a Windows installer, a portable
  executable and a zip. The packaged file list is an allow-list, so the logged-in
  session profile and the generated workspace can never be shipped inside a
  build. macOS and Linux targets are configured but have not been built or run.
- ESLint and Prettier configuration for the repository.
- Repository documentation: README, CONTRIBUTING, SECURITY, LICENSE (MIT), issue
  and pull request templates, and CI running the test suite and a syntax check
  across every source file on Node 20 and 22, on Ubuntu and Windows.

### Changed

- Renamed to **BrowserSmith**. The brand lives in `src/shared/site.js`; product
  copy no longer contains the previous names.
- The reviewer receives a condensed head-and-tail of a file with the middle
  elided, never the whole body, and its contract explains that the elision
  marker is ours.
- `extractBody` replaced `unfence` as the source of file bodies: it handles one
  fence, several fences that are really one file, fences wrapped in prose, and
  replies with no fences at all, and returns nothing when nothing file-shaped
  survives.
- `inferMode` returns `auto` unless the request carries an explicit stack
  signal. It no longer guesses "static page" by default.
- Reply completion is decided by the chat UI's own generating state rather than
  by a stopwatch or by "the text stopped changing".
- File count caps and retry knobs removed. The planner and auditor decide when
  a project is done, behind a runaway backstop.

### Fixed

- Typing and focus moved to the main process (`webContents.insertText`,
  `webContents.focus`). Synthetic DOM events are ignored by the composer
  whenever the window is unfocused, which is most of an unattended run.
- `awaitReply` no longer returns while generation is in progress. It previously
  handed back 2518 characters of an unfinished file when a long code block sat
  unchanged in the DOM mid-stream.
- Blank lines are no longer stripped from replies, which had been removing every
  paragraph break from every generated file.
- Tabs rotate to a fresh temporary chat past 12KB of transcript, and a chat that
  goes blind anyway is hard-reset and reseeded instead of retried in place.
- A 51KB paste no longer wedges the composer and silently skips review.
- npm-family commands spawn through `ComSpec` on Windows; Node 20.12+ throws
  `EINVAL` when spawning a `.cmd` with `shell: false`.
- Autopilot no longer triggers on the orchestrator's own relay traffic, which
  had caused it to take over a finished run and report zero files over real
  work.
- Stray code-fence lines are stripped from file bodies. A live run produced an
  `index.html` with a fence inside its `<style>` block, silently corrupting the
  CSS after it.
- Screenshots are taken after the page is driven past a start screen. A working
  game was failing verification because the capture showed its title screen.
- Absolute filesystem paths are never sent into a chat tab.

[Unreleased]: https://github.com/soufian3hm/BrowserSmith/commits/main

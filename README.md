# buildgpt

Four ChatGPT tabs orchestrated into a build system that ships real, running
projects. You type one request in the sidebar; the agents do everything else.

```
            ┌───────────────────────────── you type ONE request ──┐
            ▼                                                     │
  A · planner ──"components/Calculator.tsx"──► B · builder ──file body──► C · reviewer
      ▲                                                                     │ PRINT / RETRY
      │                                                   file written ◄────┘
      │                                                        │
  D · auditor ◄── "what's still missing?" ─────────────────────┘
      │ DONE
      ▼
  scaffold-aware build:  npm install → dev server → screenshot
      │                                                │
      │                        pasted into D: "PASS or FIX?"
      ▼                                                │
  preview tab (fifth webview) shows the RUNNING app ◄──┘   FIX → planner fixes → rebuild
```

## Run

```bash
npm install
npm start
```

Log into ChatGPT **once, in tab A** — all four tabs share the persistent
`persist:chatgpt` session (profile in `./.profile/`, git-ignored, flushed
aggressively so a hard kill never loses the login). A packaged build keeps that
same `.profile/` folder next to the executable, so the whole thing stays
portable: copy the folder, keep your login.

## Using it

1. Pick a **mode**: Next.js, Vite + React, Static HTML, Node CLI, Python, or
   Auto. Framework modes scaffold a real runnable starter first (package.json,
   tsconfig, app router files…), and every agent prompt carries the current
   file list, so new files land in the right places.
2. Name the project (optional — the request is slugged otherwise). Every run
   lives in its own `workspace/<project>/` folder.
3. Type the request. Hit **Run**.
4. Watch the activity feed; build output streams into the built-in terminal.
   When the app is up, the **Preview** view switches on automatically with the
   dev server still running. **Open** launches it in your system browser.

There are no file caps or retry knobs - the planner and auditor decide when the
project is done (with a runaway backstop).

**Autopilot** watches tab A's chat: type a request directly into ChatGPT and the
system takes over, builds, then reports back into the same chat.

**Terminal**: human-typed commands run in the current project folder
(PowerShell). AI-driven commands are separately allow-listed (`npm`, `npx`,
`node`, `python`, …) and always spawned without a shell.

## Self-healing details (learned from live runs)

- **Chat rotation**: ChatGPT virtualizes long threads, which blinds reply
  detection. Tabs rotate to a fresh chat past ~12KB and reseed automatically; a
  tab that goes fully blind gets a hard reset.
- **Send path**: ChatGPT's real send button, with a keyboard fallback; typing
  goes through `webContents.insertText` so it works while the window is
  unfocused.
- **Reply detection**: transcript-growth with echo skipping and status-line
  filtering (`Thinking`, `Searching the web`, …) — no ChatGPT class names
  anywhere.
- **Advanced menu** (header): Self-test (checks the live DOM without sending
  anything), element pickers (click to re-teach a selector if ChatGPT
  redesigns), Forget login.

## MCP

```bash
npm run mcp
```

Exposes `workspace_list` / `workspace_read` / `workspace_write` over stdio, so
Claude Code or any MCP client can read and write the same workspace:

```bash
claude mcp add buildgpt -- node ./src/mcp/server.js
```

## Safety

- Model replies are untrusted input: paths are sandboxed to
  `workspace/<project>/` (traversal rejected twice - parser and filesystem).
- `npm install` executes package install scripts - that is inherent to
  building real apps. Everything is confined to the project folder.
- The app never reads or exports cookie values; the session pill shows only
  cookie names and expiry.

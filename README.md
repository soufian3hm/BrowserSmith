# notioned

Two Notion AI tabs talking to each other, producing real files on disk.

```
you ──► TAB A (planner) ──► "src/utils/debounce.ts"
             │
             ▼
        TAB B (builder) ──► full file contents
             │
             ▼
        TAB A (reviewer) ──► "PRINT"  ──► workspace/src/utils/debounce.ts
                             "RETRY" ──► back to TAB B
```

## Run

```bash
npm install
npm start
```

## The session

Log in **once, in the left tab only**. Both webviews share the `persist:notion`
partition, so the right tab is signed into the same account automatically
(reload it if it was already open).

The profile lives in `./.profile/` (git-ignored). It survives app restarts,
machine reboots, and rebuilds — the only things that clear it are the **Forget
login** button and deleting that folder. Cookies are flushed to disk on login,
every 60s, on window close, and on quit, so a hard kill won't cost you the
session. The header pill shows the live state and the `token_v2` expiry date.

The app never reads or exports cookie *values* — only their names and expiry,
to render that pill.

First launch: log into Notion **once** in the left tab. Then:

1. **Self-test** — checks the live DOM without sending anything to Notion.
   Costs no AI credits and leaves no chat history. Fix any ✗ before running.
2. **⟳** next to each tab — loads Notion's model list into that tab's dropdown.
   Selecting one clicks it through on the page automatically.
3. **Seed roles** — sends the planner/builder contracts into each tab.
4. Name the **Project**, type a request, hit **Run**.

## Projects

Each run writes into its own folder: `workspace/<project-slug>/`. The project
name is slugged to a single safe directory segment, so runs never collide and
never escape. The planner keeps returning paths until it says `DONE` or the
**Max files** cap is hit, so one Run produces a whole small project, not one file.

## Sending

The driver clicks Notion's actual send button (found by aria-label, or by
position relative to the composer). Enter is only a fallback — in a rich-text
composer Enter can insert a newline or get swallowed by a slash-command menu.
If the button isn't found, use **Pick → A send** and click it once.

## When Notion changes its DOM

The driver finds the composer heuristically (lowest visible editable element).
If that breaks, use **Pick A composer** / **Pick A output** and click the real
elements — the selector is remembered for the session.

**Probe** reports whether each tab currently has a usable composer.

## MCP handshake

```bash
npm run mcp
```

Exposes `workspace_list`, `workspace_read`, `workspace_write` over stdio so
Claude Code (or any MCP client) reads and writes the same directory. Register it:

```bash
claude mcp add notioned -- node ./src/mcp/server.js
```

## Safety notes

- Notion's replies are **untrusted input**. Paths are sanitized and confined to
  `workspace/`; a reply of `../../.ssh/config` is rejected, not followed.
- Never paste session cookies into this repo. Log in through the app UI so the
  credentials live only in Electron's encrypted `persist:notion` partition.
- Response completion is detected by "transcript stopped growing", not by a
  Notion class name — that's the part most likely to survive Notion redesigns.

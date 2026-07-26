# BrowserSmith 1.0.0

Turn your ChatGPT account into a local software factory. Four browser tabs plan,
write, review and audit a real project, then install it, run it, screenshot it,
read the actual error and patch the broken lines.

No API key. No tokens. It automates the ChatGPT web UI, so a free account works.

## Install

**Windows**

| Download | Use it when |
| --- | --- |
| `BrowserSmith-1.0.0-win-x64-setup.exe` | You want it installed with a Start-menu entry. Per-user, no admin prompt. |
| `BrowserSmith-1.0.0-win-x64-portable.exe` | You want one file to double-click. Unpacks to `%TEMP%` on each run. |
| `BrowserSmith-1.0.0-win-x64.zip` | You want it fully portable — this is the only build where your login and your projects really do sit in the folder beside the executable. |

The build is **not code-signed**, so Windows SmartScreen will warn you the first
time. *More info → Run anyway*. If you would rather not take that on trust, the
source is here and `npm install && npm start` runs the same app.

macOS and Linux targets are configured but have not been built or run by anyone
yet. If you try one, an issue reporting what happened is genuinely useful.

## First run

1. Launch it and log in to ChatGPT **in tab A only** — the other three share the
   session.
2. Pick a mode (or leave it on Auto), type one sentence, press **Run**.
3. Watch the four tabs work. The **Preview** tab opens on its own when the app
   is running.

Everything it writes lands in `workspace/<project>/` next to the executable.

## What it can build

Next.js, Vite, static sites, Node CLIs and Python — plus anything else the
planner chooses in Auto mode. Verification is derived from what is actually on
disk rather than from the mode you picked, so a Python backend serving an HTML
page gets both a server and a browser preview. Go, Rust, .NET, Java, Ruby, PHP,
Deno, shell and make are detected and run when their runtime is installed; when
it is not, the app says so plainly instead of blaming the generated code.

## Known limitations

- It drives a web UI, so a ChatGPT redesign can break the driver. There is a
  **Health** check and click-to-pick element overrides for exactly that day.
- One build sends roughly 20–40 messages. Free-tier rate limits will slow it
  down, and heavy use can get a session logged out.
- `npm install` runs the `package.json` the model wrote. That is inherent to
  building real projects, it is confined to the project folder, and you should
  know it happens.
- Verified end to end on Next.js, static sites and a Node CLI. Other runtimes
  are exercised less.

## Privacy

No telemetry. No API keys. Conversations run in ChatGPT's temporary chat so they
stay out of your history. Your session lives in a local `.profile` folder and the
app reads cookie *names and expiry* only — never values. Generated file paths are
scrubbed before anything is typed into a chat, so your OS username does not leave
the machine.

## Checksums

Published with the release assets. Verify with:

```
certutil -hashfile BrowserSmith-1.0.0-win-x64-setup.exe SHA256
```

Turn your ChatGPT account into a local software factory. Four browser tabs plan,
write, review and audit a real project — then BrowserSmith installs it, runs it,
screenshots it, reads the actual error out of the framework's overlay, and
patches the broken lines.

No API key. No tokens. It automates the ChatGPT web UI, so a free account works.

## Download

| File | Use it when |
| --- | --- |
| **BrowserSmith-1.0.0-win-x64-setup.exe** | You want it installed properly — Start-menu entry, Desktop shortcut, Add/Remove Programs. Per-user, no admin prompt. |
| **BrowserSmith-1.0.0-win-x64-portable.exe** | You want one file to double-click. Unpacks to `%TEMP%` on each run. |
| **BrowserSmith-1.0.0-win-x64.zip** | You want it fully portable — this is the only Windows build where your login and your projects really do sit in the folder beside the executable. |

The build is **not code-signed**, so Windows SmartScreen will warn you the first
time: *More info → Run anyway*. If you would rather not take that on trust, the
source is right here and `npm install && npm start` runs the same app.

macOS and Linux targets are configured but have not been built or run by anyone.
If you try one, an issue saying what happened is genuinely useful.

## First run

1. Launch it and log in to ChatGPT **in tab A only** — the other three share the
   session.
2. Pick a mode, or leave it on Auto. Type one sentence. Press **Run**.
3. The **Preview** tab opens on its own once the app is running.

Everything it writes lands in `workspace/<project>/` beside the executable.

## What it builds

Next.js, Vite, static sites, Node CLIs and Python — plus whatever the planner
picks in Auto mode. Verification is derived from what is actually on disk rather
than the mode you chose, so a Python backend serving an HTML page gets both a
server and a browser preview. Go, Rust, .NET, Java, Ruby, PHP, Deno, shell and
make are detected and run when their runtime is installed; when it is not, the
app says so plainly instead of blaming the generated code.

## Verified in this build

- A pomodoro web app: written, reviewed, opened from disk, screenshotted with the
  timer counting down, judged PASS.
- A Node CLI that reads a CSV and prints per-column statistics — approved on the
  first review attempt, and its output checked by hand against a real file.
- 108 automated tests covering the reply parsers, the patch engine, the runtime
  planner, the workspace sandbox and the packaging config.
- Built on **Electron 43.2.0 / Chromium 150**, and booted from this exact tree:
  four chat tabs attached and loaded, the 2x2 grid measured, the login carried
  across from the previous runtime, no console errors.

## Known limitations

- It drives a web UI, so a ChatGPT redesign can break the driver. There is a
  **Health** check and click-to-pick element overrides for exactly that day.
- One build sends roughly 20–40 messages. Free-tier rate limits will slow it
  down, and heavy sustained use can get a session logged out.
- `npm install` runs the `package.json` the model wrote. That is inherent to
  building real projects; it is confined to the project folder, and you should
  know it happens.
- Verified end to end on Next.js, static sites and a Node CLI. Other runtimes are
  exercised less.

## Privacy

No telemetry. No API keys. Conversations run in ChatGPT's temporary chat so they
stay out of your history. Your session lives in a local `.profile` folder, and
the app reads cookie *names and expiry* only — never values. Generated file paths
are scrubbed before anything is typed into a chat, so your OS username never
leaves the machine. Neither `.profile` nor `workspace` can end up inside a
release artifact — there is a test that fails the build if they could.

## Checksums (SHA-256)

```
4afbfb92a5add6a879a5600dbb3235caaaae351d607f529c070a29d641243259  BrowserSmith-1.0.0-win-x64-setup.exe
fd472148ad801954e545e382cd233d9d13ceac9c05b7cad7319bd93d22aec23c  BrowserSmith-1.0.0-win-x64-portable.exe
0dd66d8233f359a1b29447af7990e7bcb601ca85a7b3d5476c30d1a808ed2d25  BrowserSmith-1.0.0-win-x64.zip
```

Verify with:

```
certutil -hashfile BrowserSmith-1.0.0-win-x64-setup.exe SHA256
```

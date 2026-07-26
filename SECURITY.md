# Security policy

## Reporting a vulnerability

Do not open a public issue.

Use GitHub's private vulnerability reporting:
[**Report a vulnerability**](https://github.com/soufian3hm/BrowserSmith/security/advisories/new).
If that is unavailable to you, email **soufian3hm@gmail.com** with `BrowserSmith
security` in the subject.

Please include the app version or commit, your OS and Node version, and the
smallest reproduction you can manage — ideally the exact request or model reply
that triggers it, since almost every interesting input to this app is text that
came back from a chat tab.

You will get an acknowledgement within 7 days and an assessment within 14. Fixes
land in a normal release; you will be credited in [CHANGELOG.md](CHANGELOG.md)
unless you ask not to be.

## Supported versions

This project is pre-1.0. Only the latest release and the `main` branch receive
fixes. There are no backports.

## The trust boundary

**Every reply from a chat tab is untrusted input.** It decides file paths, file
contents and — indirectly — what gets installed. Two things contain it:

1. **`workspace/<project>/`.** `src/main/workspace.js` resolves every path
   against that root and throws if the result lands outside it. The protocol
   parser rejects a path containing `..` before the filesystem layer ever sees
   it, because the orchestrator prefixes the project name and a lone `..` would
   otherwise reach a sibling project.
2. **The `ALLOWED` set in `src/main/toolchain.js`.** Only those executables can
   be launched by the agent loop. Argument arrays are built by the app, never by
   model output, and every spawn is `shell: false`. On Windows the npm-family
   shims go through `cmd /d /s /c` because Node refuses to spawn `.cmd` with
   `shell: false` — the argv is still an array of app-authored strings.

A report that model output escaped either of those is a vulnerability. So is
anything that causes a cookie value, an access token, or an absolute filesystem
path to leave the machine.

## Known and accepted risks

These are design decisions, not bugs. Reporting them is welcome as a discussion,
but they will not be treated as vulnerabilities.

- **`npm install` runs install scripts from a `package.json` a model wrote.**
  Building a real app means installing real dependencies, and install scripts
  execute arbitrary code with your user's privileges. The blast radius is your
  account, not the project folder. Run the app in a VM or container if that is
  not acceptable.
- **The terminal panel runs a real shell.** That channel exists only for
  commands the user types. Model output never reaches it.
- **A live ChatGPT session sits on disk** in `./.profile/`, protected by nothing
  but your filesystem permissions. The app never reads or exports cookie values;
  it reports names and expiry dates only. "Forget login" wipes the folder.
- **The agent loop can write any file inside its own project folder**,
  including `package.json`. That is the feature.

## Scope

In scope: this repository. Out of scope: ChatGPT itself, OpenAI's
infrastructure, and anything a generated project does after you take it out of
the workspace and run it yourself.

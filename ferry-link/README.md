# Ferry Link

Send a Claude Design project straight into Figma: tell Claude "send my Portfolio to Figma", and it appears in the Ferry panel, ready to import as editable layers, with your tokens as Figma variables and your themes as modes.

Nothing leaves your computer. Claude reads the design through Claude Design's own connector; Ferry Link downloads it from Claude Design and hands it to the Ferry panel on this machine.

## Set up (once)

1. Install **Ferry** in Figma (Figma Community → Ferry).
2. In Claude Code:
   ```
   /plugin marketplace add manthanjha7/ferry
   /plugin install ferry-link@ferry
   ```
3. Run `/mcp` and sign in to **claude-design** with your claude.ai account.
4. Open Ferry in Figma. It shows a code under **From Claude**; tell Claude `pair Ferry 1234-5678` with your code.

## Use

- In Claude Code: *"send my Portfolio design to Figma"*.
- Or from Claude Design: **Export → Send to local coding agent**. Paste the prompt into Claude Code and add *"send it to Figma"*.

Then in Figma, click the design under **From Claude** in the Ferry panel, and **Import**.

## How it works

- `ferry-link` is an MCP server that Claude Code starts. Its tools:
  - `send_to_figma` takes the project's file list (from the Claude Design connector's `list_files`) and a preview link (`render_preview`). It downloads every file, images included, into a zip in `~/.ferry/inbox`.
  - `pair_figma` pairs a Ferry panel.
  - `ferry_status` reports what's waiting.
- It serves that inbox on `127.0.0.1:47841`, to the Ferry panel only:
  - requests must come from Figma's plugin frame (origin `null`) and name this machine as the host;
  - the panel must be paired.
- A design waits for a day, then is dropped. One that has been opened leaves the inbox.

## Where it works

- **Claude Code** (the terminal, and the Code tab of the Claude desktop app): yes. Claude Code carries the Claude Design connector Ferry Link needs.
- **Claude chat** (claude.ai, the desktop app's chat): not yet. The Claude Design connector isn't offered there, and it doesn't let other apps sign in to it. Until it is, designers without Claude Code download the project's .zip from Claude Design and drop it into Ferry.

## Develop

No dependencies: Node 18 or later. Tests: `node test/test.mjs` and `node test/robust.mjs`.

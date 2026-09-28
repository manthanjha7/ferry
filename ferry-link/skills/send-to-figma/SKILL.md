---
name: send-to-figma
description: Send a Claude Design project into Figma as editable layers through the Ferry plugin. Use when the user says "send my <project> to Figma", "export this design to Figma", "open this in Figma", "import into Figma", pastes a claude.ai/design link and mentions Figma, or pastes Claude Design's "Send to local coding agent" prompt and asks for Figma rather than code. Also use for "pair Ferry <code>".
---

# Send to Figma

Ferry Link (this plugin's `ferry-link` MCP server) hands a Claude Design project to the Ferry plugin open in the user's Figma. You read the project with the Claude Design connector (`claude-design` MCP server); Ferry Link downloads it and Ferry imports it.

## Steps

1. **Pairing.** If the user says "pair Ferry 1234-5678", call `pair_figma` with the code and stop.
2. **Find the project.**
   - From a claude.ai/design link: the project id is the UUID after `/design/p/`; the page is the `file=` value, if there is one.
   - From a name ("my Portfolio"): call `list_projects` and pick the closest name. If two are equally close, ask which.
3. **List every file:** `list_files` with `depth: -1`.
4. **Get a preview link:** `render_preview` for the page the user means. With no page named, use the project's main page: the only `.html`, else the one that matches the project name, else the first `.dc.html`.
5. **Send:** call `send_to_figma` with the project's name, the `serve_url` from step 4, every path from step 3, and the page.
6. **Tell the user** what `send_to_figma` said, in one or two lines: where to click in Figma (the Ferry panel, under "From Claude"), and anything it could not download.

## Rules

- **Never show, log or save the `serve_url`.** It carries a token to the user's project. It is for `send_to_figma` only.
- If the Claude Design connector asks for sign-in, tell the user to run `/mcp` and sign in to `claude-design` with their claude.ai account, then try again.
- If `send_to_figma` says no Ferry panel is open: tell the user to open Ferry in Figma (Plugins → Ferry). The design waits for a day.
- If it says the panel is not paired: the panel shows a code; the user says "pair Ferry <code>".
- Send only what the user asked for. Don't send other projects or pages.

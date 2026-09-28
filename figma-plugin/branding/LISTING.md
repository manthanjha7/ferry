# Ferry — Figma Community listing

Everything needed to publish. Assets sit beside this file; copy is below.

## Assets
- **Icon** — `icon.png` (128×128). Source: `icon.html`.
- **Cover** — `cover.png` (1920×960). Source: `cover.html`.
- Rebuild either after an edit:
  ```bash
  CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  "$CHROME" --headless --force-device-scale-factor=1 --default-background-color=00000000 \
    --window-size=128,128 --screenshot="$PWD/icon.png" "file://$PWD/icon.html"
  "$CHROME" --headless --force-device-scale-factor=1 \
    --window-size=1920,960 --screenshot="$PWD/cover.png" "file://$PWD/cover.html"
  ```

## Name
Ferry

## Tagline (one line, shown under the name)
Bring Claude Design screens into Figma as editable layers, with your own tokens and themes intact.

## Description
Drop a Claude Design export into Ferry and it lands in Figma as native layers you can edit: real auto-layout where the design had it, text as text, and frames named the way the design named them. One screen or a whole project in a single import.

When the design uses a design system, Ferry keeps it. Your tokens arrive as Figma **variables** under their own names (`--primary` stays an alias of `--green-700`, not a hex it guessed), and a light/dark theme becomes a pair of variable **modes** you can switch on any frame. A document's declared states come in as frames wired into a clickable prototype.

It runs locally inside Figma: no server, no account. The only thing it downloads is the Google Fonts your design links, so text comes in at its real size. Your files never leave your machine.

What it does not do yet: turn repeated elements into components, bind text to text styles, or import CSS background images. Those arrive as plain layers.

*Not affiliated with Anthropic or Figma. "Claude Design" is used only to describe what this imports.*

## Tags
claude design, html to figma, import, design system, variables, design tokens, variable modes, dark mode, auto layout, prototype

## Notes for the publish flow
- The listing title can carry the descriptive phrase for discoverability, e.g.
  **"Ferry — Claude Design to Figma, with your tokens"**, while the plugin name in
  `manifest.json` stays **Ferry**.
- Keep the non-affiliation line in the description (above). It is the reason a
  "Claude Design" reference in the title is safe nominative use rather than an
  implied endorsement.
- `networkAccess` allows only `fonts.googleapis.com` and `fonts.gstatic.com`, with the reasoning shown on the listing.

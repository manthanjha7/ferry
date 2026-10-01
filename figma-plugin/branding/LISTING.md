# Ferry: Figma Community listing

Everything needed to publish. Assets sit beside this file; copy is below.

## Assets
Every image is a real capture from Figma: a demo design (Tidepool, a scheduling page with a light and a dark theme, built in Claude Design's format) imported with Ferry. Nothing is mocked up.
- **Icon**: `icon.png` (128×128). An F built from layer bars.
- **Thumbnail**: `cover.png` (1920×1080).
- **Carousel**, in this order:
  1. `carousel-1-import.mp4`: the import, start to finish (20 s, recorded in Figma).
  2. `carousel-2-tokens.png`: Figma's Variables table, Light and Dark modes, aliases intact.
  3. `carousel-3-variants.png`: a hover variant with its prototype interaction.
  4. `carousel-4-layout.png`: auto layout and bound variables on an imported card.
  5. `carousel-5-link.png`: a design sent from Claude Code, waiting in the panel.
- **GIF** for the README: `ferry-import.gif` (the carousel takes MP4, not GIF).
- **Sources** are in `src/`: one HTML page per image, `listing.css`, `mark.svg`, and the raw captures in `src/shots/`. Rebuild with `sh render.sh`.

## Name (the listing title)
Ferry: Claude Design to Figma (Variables, Modes, Auto Layout)

The plugin itself stays named **Ferry** in `manifest.json`. The title follows the pattern the most-used import plugins use: name, colon, the job, specifics in brackets.

## Tagline (100 characters, shown under the name)
Turn Claude Design exports into editable Figma layers, with tokens as variables and themes as modes.

## Description
Ferry imports Claude Design exports into Figma as native, editable layers. Not a screenshot: real frames, real auto layout and real text, named the way the design named them.

How to use
1. In Claude Design, export your project as a .zip, or a single .html file.
2. Run Ferry in Figma and drop the file in.
3. Click Import.

What you get
- Design tokens become Figma variables, under their own names. Aliases stay aliases: primary still points at green-700.
- A light and a dark theme become variable modes, with one frame per theme.
- Repeated elements become components, with instances in the design.
- Hover states become Default and Hover variants, wired to play in your prototype.
- React prototypes (Tailwind included) and Claude Design animations come across too.

Send it from Claude Code (optional)
Install the free Ferry Link companion in Claude Code, then say "send my Portfolio to Figma". The design appears in Ferry, ready to import. Setup is two lines, shown in the panel.

Privacy
Ferry runs on your computer. No account, no server, no tracking. It loads only what a design itself uses from the web: its Google Fonts, and Tailwind for designs built with it.

Known limits
Text is not yet bound to text styles. Images a design links from other websites are left out, with a note.

Free and open source: github.com/manthanjha7/ferry
Questions and bugs: github.com/manthanjha7/ferry/issues

Not affiliated with Anthropic or Figma. "Claude Design" is used only to describe what Ferry imports.

## Tags
claude design, html to figma, import, design system, variables, design tokens, variable modes, dark mode, auto layout, components, prototype

## Notes for the publish flow
- No em dashes anywhere in the public copy.
- Keep the non-affiliation line in the description (above). It is the reason a
  "Claude Design" reference in the title is safe nominative use rather than an
  implied endorsement.
- `networkAccess` allows `fonts.googleapis.com` and `fonts.gstatic.com` (a design's own fonts), `cdn.tailwindcss.com` (designs built with Tailwind) and `http://localhost:47841` (Ferry Link on the same computer), with the reasoning shown on the listing.

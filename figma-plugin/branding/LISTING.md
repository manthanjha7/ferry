# Ferry — Figma Community listing

Everything needed to publish. Assets sit beside this file; copy is below.

## Assets
- **Icon**: `icon.png` (128×128). The mark is an F built from layer bars, the middle one in the signal colour.
- **Cover**: `cover.png` (1920×1080).
- **Carousel**, in this order after the cover:
  1. `carousel-1-tokens.png`: tokens become variables, themes become modes.
  2. `carousel-2-components.png`: components and hover variants.
  3. `carousel-3-link.png`: sending a design from Claude Code.
- **Sources** are in `src/`: `brand.css` (palette and type), `mark.svg`, and one HTML page per image. Rebuild everything with `sh render.sh`, or one image with `sh render.sh cover` (also `icon`, `tokens`, `components`, `link`).
- **Brand**:
  - Black `#0A0A0A` and white, with one signal colour, mint `#B8FF65`.
  - Type: Inter Tight for headlines, Inter for body text, JetBrains Mono for labels (all from Google Fonts).
  - No Claude or Figma marks.

## Name
Ferry

## Tagline (one line, shown under the name)
Bring Claude Design screens into Figma as editable layers, with your own tokens and themes intact.

## Description
Drop a Claude Design export into Ferry and it lands in Figma as native layers you can edit: real auto-layout where the design had it, text as text, and frames named the way the design named them. One screen or a whole project in a single import. Designs built as React prototypes (Tailwind and all) and Claude Design animations come across too, animations as one frame per scene wired to play.

When the design uses a design system, Ferry keeps it. Your tokens arrive as Figma **variables** under their own names (`--primary` stays an alias of `--green-700`, not a hex it guessed), and a light/dark theme becomes a pair of variable **modes** you can switch on any frame. Repeated elements become **components**, and anything that changes on hover gets a **Default/Hover variant** that plays in your prototype. A document's declared states come in as frames wired into a clickable prototype.

**No download needed if you use Claude Code:** install Ferry Link (two lines, shown in the panel) and tell Claude "send my Portfolio to Figma". The design appears in Ferry, ready to import.

It runs locally: no server, no account. Ferry loads only what a design itself uses from the web: its Google Fonts, and Tailwind for designs built with it. Your files never leave your machine.

What it does not do yet: bind text to text styles, or load images a design links from other websites. Those arrive as plain layers, or are left out with a note.

*Not affiliated with Anthropic or Figma. "Claude Design" is used only to describe what this imports.*

## Tags
claude design, html to figma, import, design system, variables, design tokens, variable modes, dark mode, auto layout, components, prototype

## Notes for the publish flow
- The listing title can carry the descriptive phrase for discoverability, e.g.
  **"Ferry — Claude Design to Figma, with your tokens"**, while the plugin name in
  `manifest.json` stays **Ferry**.
- Keep the non-affiliation line in the description (above). It is the reason a
  "Claude Design" reference in the title is safe nominative use rather than an
  implied endorsement.
- `networkAccess` allows `fonts.googleapis.com` and `fonts.gstatic.com` (a design's own fonts), `cdn.tailwindcss.com` (designs built with Tailwind) and `http://localhost:47841` (Ferry Link on the same computer), with the reasoning shown on the listing.

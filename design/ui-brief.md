# Ferry — plugin UI design brief

Paste the whole of this into Claude Design.

---

Design the UI for **Ferry**, a Figma plugin that imports Claude Design screens into Figma as editable layers, with the design system's tokens bound to real Figma variables.

Produce a single self-contained HTML page. This is a real, working UI, not a mockup — the markup will be used directly.

## Hard constraints, please do not deviate

**Canvas.** A Figma plugin panel: exactly **400px wide × 620px tall**. It floats over the Figma canvas. Design at that size; nothing may be cut off.

**Theme.** Figma injects its own theme as CSS custom properties into the plugin, and the plugin must match whichever theme the user is in. Use these and nothing else for colour — no hardcoded hex:

`--figma-color-bg`, `--figma-color-bg-secondary`, `--figma-color-bg-brand`, `--figma-color-bg-selected`, `--figma-color-bg-warning`, `--figma-color-bg-warning-tertiary`, `--figma-color-text`, `--figma-color-text-secondary`, `--figma-color-text-tertiary`, `--figma-color-text-brand`, `--figma-color-text-onbrand`, `--figma-color-text-danger`, `--figma-color-text-success`, `--figma-color-border`, `--figma-color-border-selected`

Always give each a fallback, e.g. `var(--figma-color-bg, #ffffff)`. It must look right in both light and dark.

Define the light and dark values in two separate blocks so both sets are on the record, but do **not** put a theme class on the root element and do not define the variables on `:root`. Figma injects these same names into the plugin iframe under `.figma-light` / `.figma-dark` on `<html>`, and anything defined at `:root` ties with those on specificity: whichever stylesheet the browser saw last wins, which is a coin toss whose losing side is a white panel with white text for every dark-mode user. Scope the fallback so it cannot apply when either Figma class is present.

**Type.** Inter, 11px base — Figma's own UI scale. This should feel native to Figma, not like a website embedded in it. Dense, quiet, utilitarian. No marketing polish, no hero text, no illustration.

**Every class name must start with `cd2f-`.** This is not stylistic. The plugin renders the user's imported document into this same page in order to measure it, so that document's CSS lands on our UI. Namespacing is what stops a stranger's stylesheet destroying the panel. For the same reason, re-assert `font-family` and colour with `!important` on the app shell.

**Layout shape.** A fixed shell: a scrolling middle section, and a footer pinned to the bottom that never scrolls away. The footer holds progress, status, the action buttons and the footnote. The content has outgrown the panel before and pushed the Import button off-screen — that must not be possible.

## Required element IDs

The plugin's code binds to these exact IDs. Every one must exist, with the element type given. Styling and arrangement are yours; the IDs are not. A missing one is not a cosmetic problem: the panel looks each of them up with no null check, so it crashes at load.

Two rules that follow from how the code drives them:

- Anything marked "hidden by default" below is shown again with `display: block`, so its own layout must not depend on being a flex container. Where a hidden wrapper holds a label beside a field, put the flex row **inside** the wrapper.
- No element may rely on an id it is not given here. The importing spinner, for example, has no id, so it has to be derivable from `cd2f-status`, whose class is rewritten as `cd2f-status cd2f-status--idle|working|done|error` on every status change. That rewrite also wipes anything else on that element, so the status colour has to live in those four classes and never inline.

| id | element | purpose |
|---|---|---|
| `cd2f-dropzone` | div | drag-and-drop target |
| `cd2f-pick-file` | span | "choose a file" link |
| `cd2f-pick-folder` | span | "choose a folder" link |
| `cd2f-file` | input[type=file] | hidden |
| `cd2f-folder` | input[type=file] | hidden |
| `cd2f-page-row` | div | wrapper, hidden until multiple screens found |
| `cd2f-page` | select | which screen to import, or all of them |
| `cd2f-page-hint` | div | one line under the picker saying what "All screens" will do |
| `cd2f-states-row` | div | wrapper, hidden unless one screen is selected and it declares enumerable props |
| `cd2f-states` | select[multiple] | which props to import one frame per value of |
| `cd2f-states-hint` | div | how many frames that comes to, or why the matrix was refused |
| `cd2f-token-warning` | div | warning panel, hidden by default |
| `cd2f-token-warning-text` | div | warning body copy |
| `cd2f-copy-prompt` | button | small button inside the warning |
| `cd2f-paste` | textarea | paste markup instead of a file |
| `cd2f-token-mode` | div | radiogroup wrapping the three token modes |
| `cd2f-token-mode-map` | input[type=radio] | "Map onto my design system" |
| `cd2f-token-mode-build` | input[type=radio] | "Build a design system from this export" |
| `cd2f-token-mode-none` | input[type=radio] | "None" |
| `cd2f-target-row` | div | wraps the collection picker and its checkbox, shown only in Map mode |
| `cd2f-build-row` | div | shown only in Build mode |
| `cd2f-build-status` | span | which design system was found in the export |
| `cd2f-target` | select | which variable collection to map onto (Map mode only) |
| `cd2f-ds-status` | span | e.g. "none" / "7 files saved" |
| `cd2f-pick-ds` | span | "add token files" link |
| `cd2f-ds-forget-wrap` | span | wrapper, hidden until a design system is saved |
| `cd2f-ds-forget` | span | "forget" link |
| `cd2f-ds` | input[type=file] | hidden |
| `cd2f-create-missing-row` | label | wraps the checkbox and its description |
| `cd2f-create-missing` | input[type=checkbox] | checked by default |
| `cd2f-infer-stacks` | input[type=checkbox] | checked by default |
| `cd2f-width` | input[type=number] | default 1440 |
| `cd2f-progress` | div | thin bar, hidden by default |
| `cd2f-progress-bar` | div | the fill inside it |
| `cd2f-status` | div | one line of live status |
| `cd2f-summary` | div | results list, hidden by default, scrolls internally |
| `cd2f-import` | button | primary action |
| `cd2f-close` | button | secondary action |

Two spans carry no id but are read all the same: inside `cd2f-token-mode`, one `[data-cd2f-reason="map"]` and one `[data-cd2f-reason="build"]`, each beside its own radio. They hold the reason a mode cannot be chosen, e.g. "no variable collections in this file". Leave them empty in the markup.

## Content and copy

Use this copy as written.

**Header.** Title "Ferry". Subtitle: "Import Claude Design screens as editable layers, with your design tokens bound to Figma variables."

**Drop zone.** "Drop your .html file or .zip export", and beneath it "or choose a file · choose a folder" with both as links. Both formats are named because both are accepted directly: a Claude Design project export arrives as a .zip and the plugin unpacks it itself, so `cd2f-file` accepts `.html` and `.zip` and takes several files at once.

**Screen picker** (hidden unless the drop holds several screens). Label "Screen", then the select. Its first option is "All screens (3)" and that is what a project export selects by default, because every screen in the export becomes its own frame. Beneath the select, one line of hint text: "Each screen becomes its own top-level frame." A very large export says so there instead: "40 screens found. Pick one, or choose All screens to import the first 12."

**States picker** (hidden unless exactly one screen is selected and that document declares props worth enumerating). Label "States", then a list box a few rows tall listing one prop per line as "state (7)", "theme (2)": the name the document uses and how many values it has. The widest one starts ticked. Beneath it, one line of hint text carrying the arithmetic: "14 frames: state (7) × theme (2). The first varies fastest, one row per sweep." Past the cap it turns into a refusal, and the way out has to be in it: "a (5) × b (5) is 25 combinations, past the 24-frame cap. Untick a prop." Import is disabled while that line is showing.

**Warning panel** (hidden by default). Amber, left border accent, readable in dark mode. Body text plus a small "Copy prompt" button. Example copy it must accommodate: *"This document builds itself at load time (242 placeholders, 50 loop blocks). Those need Claude Design's scripts, which cannot run here, so parts of this import will be placeholders rather than the real design."* Assume up to four lines.

**Divider** reading "or paste markup", then a small monospace textarea, roughly three lines tall.

**Design tokens panel.** Label "Design tokens", then three radio options on their own lines. These are three different jobs, not three settings, and the layout has to make that obvious:

1. "Map onto my design system", with the collection select directly beneath it and indented, and beneath that the checkbox "Create variables for what it does not cover" with hint "Anything your library doesn't cover lands in a separate local collection rather than being dropped".
2. "Build a design system from this export", with an indented status line beneath it reading either "Acme Design System, 6 token files in this export. save this as my design system" (the last part a link) or "No _ds folder in this export. Building from whatever tokens the document declares itself."
3. "None", with secondary text "Colours import as literal values".

Only the selected mode's indented block is visible. A radio whose precondition is absent is disabled rather than hidden, with the reason in small tertiary text next to its label: "no variable collections in this file" beside Map, "nothing loaded yet" beside Build.

Below the whole group, outside it, the line "Design system CSS: none · add token files" with an optional "· forget", then hint text: "Only needed when the document doesn't link its own `_ds` tokens, which exported decks usually don't."

**Options panel.** Checkbox "Infer auto-layout" with hint "Turn evenly-spaced stacks into auto-layout, not just explicit flex". Then a row: "Viewport width" [1440] "px".

**Footer.** Progress bar, status line, the results summary, then Import (primary, fills the width) and Close (secondary, narrow). Footnote in small tertiary text: "Runs entirely on your machine. No network access. Not affiliated with Anthropic." and beneath it "build 2026-07-28 14:58:18". The build stamp is not decoration: Figma caches plugin code between runs, so it is the only way to tell from inside the panel whether a rebuild actually loaded.

The status line gets a small spinner beside it while an import is running. See the note above about deriving it from `cd2f-status`.

Summary rows are whole sentences written into `cd2f-summary` as `<div class="cd2f-summary-line">`, e.g. "554 layers created" or "12 prototype links created. Press ⇧E or open the Prototype tab to see them". They are not a count plus a label, so do not design a separate numeric column for them; style the one line, and let tabular figures do the aligning.

## States to design

Show these as separate boards so each is unambiguous:

1. **Empty** — nothing loaded, Import disabled.
2. **File loaded** — status reads "homepage.html ready.", Import enabled.
3. **Folder loaded** — screen picker visible with several options.
4. **Warning** — amber panel visible, Import relabelled "Import anyway".
5. **Importing** — progress bar part-filled, status "Building in Figma…", Import disabled.
6. **Done** — summary list visible with lines like "554 layers created", "125 new variables created", "3 fonts substituted", status "Imported." in success colour.
7. **Error** — status in danger colour, e.g. "That is Claude Design's bundled single-page export, which has no markup to read. Export the whole project instead."
8. **All screens** — picker reading "All screens (3)" selected, hint visible beneath it, status "3 screens ready. Each becomes its own top-level frame.", Import enabled.
9. **Build mode** — the Build radio selected, collection picker hidden, Map disabled and reading "no variable collections in this file", build status reading "Acme Design System, 6 token files in this export. save this as my design system".
10. **States**: one screen selected, the states list box showing "state (7)" and "theme (2)" both ticked, hint reading "14 frames: state (7) × theme (2). The first varies fastest, one row per sweep.", Import enabled.
11. **States refused**: the same list box on a bigger schema, hint reading "a (5) × b (5) is 25 combinations, past the 24-frame cap. Untick a prop.", Import disabled.
12. **Done, with a prototype**: board 6 plus one more summary line, "12 prototype links created. Press ⇧E or open the Prototype tab to see them". Nothing new to lay out, but the line has to survive being skimmed: Figma draws prototype connections only in the Prototype tab, so an import that wired fourteen frames together looks identical on canvas to one that wired nothing, and this line is the only place the user is told where to look.

## What good looks like

It should be indistinguishable from a first-party Figma panel: tight spacing, small type, restrained colour, information dense without feeling cramped. The user is mid-task in Figma. Nothing should demand attention except the warning state, which must be impossible to miss.

Avoid: rounded card stacks with heavy shadows, gradients, large headings, icons for their own sake, or anything that reads as a marketing page.

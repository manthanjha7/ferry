# Listing captures

How the listing images and video were made: a demo design imported with Ferry in
the real Figma desktop app, captured over the debugging port. Nothing is mocked up.

- `demo/Tidepool/` is the demo design, in Claude Design's `.dc.html` format, with
  a light and a dark theme.
- Set-up: build with `node build.mjs --selftest`, launch Figma as in
  `test/figma/README.md`, open a scratch file, and zip the demo:
  `mkdir -p /tmp/ferry-capture && (cd demo && zip -qr /tmp/ferry-capture/tidepool.zip Tidepool)`.
- Each script takes the scratch tab's target-id prefix, hard-coded at the top as
  `EFA84508`; change it to yours.
  - `stage.mjs`: a fresh import, arranged for the thumbnail.
  - `record.mjs`: the import video, as a screencast (frames in `/tmp/fig/rec`, then
    `ffmpeg -f concat` as in the script's output).
  - `shotProto.mjs`, `shotD.mjs`: the variants and auto-layout stills.
  - `link.mjs`: a design waiting under "From Claude", from a throwaway Ferry Link.
- Captures are cropped into `../src/shots/` and composed by `../render.sh`.
- Rebuild with a normal `node build.mjs` before committing `dist/`.

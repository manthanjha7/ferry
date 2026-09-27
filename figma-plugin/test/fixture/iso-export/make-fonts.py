#!/usr/bin/env python3
"""Generates the two fixture fonts the asset-inlining checks measure text with.

    python3 test/fixture/iso-export/make-fonts.py     # from figma-plugin/

Both files are called iso-text.ttf and both declare the family "Iso Text". They
differ in one thing only: the advance width of every glyph. The one under
_ds/<system>/fonts/ is what `url("../fonts/iso-text.ttf")` inside
_ds/<system>/tokens/fonts.css means, and it advances a full em per glyph, so a
10-character string at 20px is exactly 200px wide. The one under fonts/ is what
that same reference would resolve to if it were resolved against the DOCUMENT
instead of against the stylesheet, and it advances half an em, so the same
string comes out 100px.

That makes "did the url() resolve against the right base" a number the harness
can read off a measured TEXT node rather than a claim about a code path. A
third answer (neither file inlined at all) shows up as neither width, since a
fallback family advances something else again.

Generated rather than committed by hand, and generated rather than borrowed:
these are the repository's own fonts, with no licence attached to anyone else's
outlines. Regenerating them is byte-stable, so re-running this changes nothing
unless the metrics above change.
"""

from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

UPEM = 1000
CHARS = (
    " !\"#$%&'()*+,-./0123456789:;<=>?@"
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`"
    "abcdefghijklmnopqrstuvwxyz{|}~"
)


def build(path: Path, advance: int) -> None:
    order = [".notdef"] + [f"g{ord(c):04x}" for c in CHARS]

    fb = FontBuilder(UPEM, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({ord(c): f"g{ord(c):04x}" for c in CHARS})

    # One filled box per glyph, inset from the advance so consecutive glyphs do
    # not merge into a solid bar. The shape is irrelevant to measurement; a font
    # with nothing but empty outlines is legal but harder to eyeball in a
    # screenshot when something goes wrong.
    pen = TTGlyphPen(None)
    pen.moveTo((60, 0))
    pen.lineTo((60, 700))
    pen.lineTo((advance - 60, 700))
    pen.lineTo((advance - 60, 0))
    pen.closePath()
    box = pen.glyph()

    blank = TTGlyphPen(None).glyph()
    fb.setupGlyf({name: (blank if name == ".notdef" else box) for name in order})
    fb.setupHorizontalMetrics({name: (advance, 60) for name in order})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupNameTable(
        {
            "familyName": "Iso Text",
            "styleName": "Regular",
            "psName": "IsoText-Regular",
            "version": "1.0",
        }
    )
    fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
    fb.setupPost()
    # Fixed date, so the two files are reproducible byte for byte.
    fb.font["head"].created = 0
    fb.font["head"].modified = 0
    fb.save(str(path))
    print(f"{path}: advance {advance}/{UPEM}")


here = Path(__file__).resolve().parent
(here / "_ds/iso-design-system-0000/fonts").mkdir(parents=True, exist_ok=True)
(here / "fonts").mkdir(parents=True, exist_ok=True)

build(here / "_ds/iso-design-system-0000/fonts/iso-text.ttf", UPEM)
build(here / "fonts/iso-text.ttf", UPEM // 2)

"""
Per-element diff: every [data-name] box in the browser against the Figma layer
of the same name (absolute position, walking the Figma tree).

    python3 boxes.py reference.boxes.json tree.json [tolerance=2]
"""
import json, sys
ref = json.load(open(sys.argv[1]))
tree = json.load(open(sys.argv[2]))
tol = float(sys.argv[3]) if len(sys.argv) > 3 else 2
figma = {}
import math
def bbox(n, x, y):
    """A rotated Figma layer's x/y is its turned top-left corner; compare its bounding box."""
    rot = n.get("rotation") or 0
    if not rot:
        return x, y, n["w"], n["h"]
    a = math.radians(-rot)  # Figma counts anticlockwise
    pts = [(0, 0), (n["w"], 0), (0, n["h"]), (n["w"], n["h"])]
    xs = [x + px * math.cos(a) - py * math.sin(a) for px, py in pts]
    ys = [y + px * math.sin(a) + py * math.cos(a) for px, py in pts]
    return min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)
def walk(n, ox=0, oy=0, top=False):
    x, y = (0, 0) if top else (ox + n["x"], oy + n["y"])
    bx, by, bw, bh = bbox(n, x, y)
    entry = {"x": round(bx, 1), "y": round(by, 1), "w": round(bw, 1), "h": round(bh, 1), "type": n["type"]}
    figma.setdefault(n["name"], []).append(entry)
    if n["type"] == "TEXT":
        figma.setdefault("text:" + " ".join(n.get("characters", "").split()), []).append(entry)
    for c in n.get("children", []):
        walk(c, x, y)
for f in tree["frames"]:
    walk(f, top=True)
bad = 0
for b in ref:
    cands = (figma.get(b["name"]) if b["name"] else None) or (figma.get("text:" + b["text"]) if b.get("text") else None)
    if not cands:
        print(f"MISSING  {b['name'] or 'text:' + (b.get('text') or '')[:40]}")
        bad += 1
        continue
    c = min(cands, key=lambda c: abs(c["x"] - b["x"]) + abs(c["y"] - b["y"]))
    kind = b.get("kind", "box")
    by_text = not (b["name"] and figma.get(b["name"]))
    if by_text and abs(c["x"] - b["x"]) + abs(c["y"] - b["y"]) > 200:
        # A repeated text ("41", "5") whose nearest copy is far away is not this one.
        print(f"MISSING  near {b['name'] or 'text:' + (b.get('text') or '')[:40]}")
        bad += 1
        continue
    if kind == "box" and by_text and c["type"] == "TEXT":
        # A padded box (a tab, a pill) matched by its words: compare centres.
        kind = "centre"
    if kind == "glyph" and c["type"] == "TEXT":
        # Glyph box vs line box: compare the left edge and the vertical centre.
        d = {"x": round(c["x"] - b["x"], 1), "cy": round((c["y"] + c["h"] / 2) - (b["y"] + b["h"] / 2), 1)}
    elif kind == "centre":
        d = {"cx": round((c["x"] + c["w"] / 2) - (b["x"] + b["w"] / 2), 1), "cy": round((c["y"] + c["h"] / 2) - (b["y"] + b["h"] / 2), 1)}
    elif kind == "block" and c["type"] == "TEXT":
        # A paragraph's box is its line boxes: top and height, and the left edge.
        d = {"x": round(c["x"] - b["x"], 1), "y": round(c["y"] - b["y"], 1), "h": round(c["h"] - b["h"], 1)}
    else:
        d = {k: round(c[k] - b[k], 1) for k in ("x", "y", "w", "h")}
    if any(abs(v) > tol for v in d.values()):
        bad += 1
        label = b['name'] or ('"' + (b.get('text') or '')[:26] + '"')
        print(f"OFF      {label[:28]:28} browser {b['x']},{b['y']} {b['w']}x{b['h']}  figma {c['x']},{c['y']} {c['w']}x{c['h']}  delta {d}")
print(f"{len(ref) - bad}/{len(ref)} elements within {tol}px")

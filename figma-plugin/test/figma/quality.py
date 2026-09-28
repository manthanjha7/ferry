"""
What a designer gets: a quality report on Figma's layer tree.

    python3 quality.py tree.json

Counts the things that make an import hard to work with even when it looks
right: generic layer names, frames with children but no auto-layout, text
that is not text, invisible or empty layers, colours not bound to variables
when a design system exists, and fonts Figma substituted.
"""
import json, re, sys
tree = json.load(open(sys.argv[1]))
stats = {"layers": 0, "frames": 0, "text": 0, "images": 0, "vectors": 0, "generic_names": [], "absolute_frames_with_children": 0,
         "auto_layout_frames": 0, "empty_frames": 0, "invisible": 0, "bound_fills": 0, "fills": 0, "fonts": {}}
GENERIC = re.compile(r"^(Frame|Group|Rectangle|Vector|Div|Span|Section|Container|Layer)( \d+)?$", re.I)
def walk(n, depth=0):
    stats["layers"] += 1
    t = n["type"]
    if t == "FRAME":
        stats["frames"] += 1
        kids = n.get("children", [])
        if n.get("layout"): stats["auto_layout_frames"] += 1
        elif len(kids) > 1: stats["absolute_frames_with_children"] += 1
        if not kids and not n.get("fills"): stats["empty_frames"] += 1
    if t == "TEXT":
        stats["text"] += 1
        stats["fonts"][n.get("font")] = stats["fonts"].get(n.get("font"), 0) + 1
    if t == "RECTANGLE": stats["images"] += 1
    if t in ("VECTOR", "BOOLEAN_OPERATION"): stats["vectors"] += 1
    if n.get("opacity") == 0: stats["invisible"] += 1
    if GENERIC.match(n["name"]) and depth > 0: stats["generic_names"].append(n["name"])
    for f in n.get("fills", []):
        stats["fills"] += 1
        if f.endswith("*"): stats["bound_fills"] += 1
    for c in n.get("children", []): walk(c, depth + 1)
for f in tree["frames"]: walk(f)
g = stats.pop("generic_names")
stats["generic_names"] = len(g)
stats["generic_examples"] = sorted(set(g))[:8]
stats["collections"] = tree.get("collections")
stats["reactions"] = [r for r in tree.get("reactions", []) if r["reactions"]]
print(json.dumps(stats, indent=1))

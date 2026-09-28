"""
Score what Figma rendered against the browser reference.

    python3 compare.py reference.png figma.png out_dir

Writes side-by-side.png (reference | figma | diff), and prints the share of
pixels that differ, plus the regions where differences cluster (40px cells),
so a failure points at a place on the page rather than a number.
"""
import json, sys
from PIL import Image, ImageChops, ImageDraw
import numpy as np

ref_path, fig_path, out_dir = sys.argv[1:4]
ref = Image.open(ref_path).convert("RGB")
fig = Image.open(fig_path).convert("RGB")
W, H = max(ref.width, fig.width), max(ref.height, fig.height)
def pad(im):
    canvas = Image.new("RGB", (W, H), (255, 0, 255))
    canvas.paste(im, (0, 0))
    return canvas
r, f = np.asarray(pad(ref)).astype(int), np.asarray(pad(fig)).astype(int)
delta = np.abs(r - f).max(axis=2)
bad = delta > 40
share = float(bad.mean())

CELL = 40
cells = []
for y in range(0, H, CELL):
    for x in range(0, W, CELL):
        block = bad[y:y+CELL, x:x+CELL]
        if block.size and block.mean() > 0.15:
            cells.append((x, y))
# merge adjacent cells into regions
regions = []
seen = set()
cellset = set(cells)
for c in cells:
    if c in seen: continue
    stack, group = [c], []
    while stack:
        cx, cy = stack.pop()
        if (cx, cy) in seen or (cx, cy) not in cellset: continue
        seen.add((cx, cy)); group.append((cx, cy))
        for dx, dy in ((CELL,0),(-CELL,0),(0,CELL),(0,-CELL)):
            stack.append((cx+dx, cy+dy))
    xs = [g[0] for g in group]; ys = [g[1] for g in group]
    regions.append({"x": min(xs), "y": min(ys), "w": max(xs)-min(xs)+CELL, "h": max(ys)-min(ys)+CELL, "cells": len(group)})
regions.sort(key=lambda g: -g["cells"])

heat = Image.fromarray((np.where(bad, 255, 0)).astype("uint8")).convert("RGB")
side = Image.new("RGB", (W * 3 + 20, H), (40, 40, 40))
side.paste(pad(ref), (0, 0)); side.paste(pad(fig), (W + 10, 0)); side.paste(heat, (2 * W + 20, 0))
draw = ImageDraw.Draw(side)
for g in regions[:30]:
    for off in (0, W + 10):
        draw.rectangle([g["x"] + off, g["y"], g["x"] + off + g["w"], g["y"] + g["h"]], outline=(255, 0, 0), width=3)
scale = min(1.0, 2400 / side.width)
side = side.resize((int(side.width * scale), int(side.height * scale)))
side.save(f"{out_dir}/side-by-side.png")
print(json.dumps({"ref": [ref.width, ref.height], "figma": [fig.width, fig.height], "mismatch": round(share, 4), "regions": regions[:15]}))

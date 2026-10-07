#!/usr/bin/env python3
"""Render the picker's raster icons from the same design as icon.svg.

    python tools/make-icons.py

Writes, next to icon.svg:

    icon-192.png   manifest icon, "any" purpose
    icon-512.png   manifest icon, "any" purpose
    icon-180.png   apple-touch-icon (full-bleed square — iOS masks it itself,
                   so pre-rounding it would show a rounded square inside
                   iOS's own rounded mask)

Why raster icons exist at all: the manifest used to declare only an SVG with
`sizes: "any"`, and there was no apple-touch-icon. Chrome wants a 192 and a 512
raster for an install, and iOS ignores SVG entirely, falling back to a screenshot
of the page for the home-screen icon.

The design is the SVG's: a #101216 tile with the "CS" mark in #f4f5f7, bold,
centred. Keep the numbers here in step with icon.svg if the mark changes.

Needs Pillow (`pip install pillow`) and one bold system sans; the search below
covers the usual Windows/macOS/Linux locations.
"""

from __future__ import annotations

import os
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

BG = "#101216"
FG = "#f4f5f7"

# icon.svg is drawn on a 64-unit grid.
VIEWBOX = 64
RADIUS = 14
MARK = "CS"
MARK_SIZE = 26
MARK_BASELINE = 42

FONT_CANDIDATES = [
    "C:/Windows/Fonts/segoeuib.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
]


def find_font() -> str:
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            return path
    sys.exit(
        "No bold system sans found. Add its path to FONT_CANDIDATES in "
        "tools/make-icons.py, then re-run."
    )


def render(size: int, rounded: bool) -> Image.Image:
    # Supersample 4x and downscale, so the corner radius and the glyph edges are
    # antialiased the way the SVG's own renderer would produce them.
    scale = 4
    px = size * scale
    img = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    if rounded:
        draw.rounded_rectangle(
            [(0, 0), (px - 1, px - 1)],
            radius=round(RADIUS / VIEWBOX * px),
            fill=BG,
        )
    else:
        draw.rectangle([(0, 0), (px - 1, px - 1)], fill=BG)

    font = ImageFont.truetype(find_font(), round(MARK_SIZE / VIEWBOX * px))
    draw.text(
        (px / 2, MARK_BASELINE / VIEWBOX * px),
        MARK,
        font=font,
        fill=FG,
        anchor="ms",  # horizontally centred on the SVG's baseline
    )

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    outputs = [
        ("icon-192.png", 192, True),
        ("icon-512.png", 512, True),
        ("icon-180.png", 180, False),
    ]
    for name, size, rounded in outputs:
        path = os.path.join(ROOT, name)
        render(size, rounded).save(path, "PNG", optimize=True)
        print(f"wrote {name} ({size}x{size}, {os.path.getsize(path)} bytes)")


if __name__ == "__main__":
    main()

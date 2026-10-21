#!/usr/bin/env python3
"""Render og-image.png — the 1200x630 card social previews and link unfurls use.

    python3 tools/make-og-image.py

The site ships Geist as woff2, which Pillow cannot open, so the two faces used
here are decompressed to a temporary TTF first (fontTools + brotli, both
generation-time only). The palette is the dark theme's, and the little week grid
on the right is the product in one glance: named modules, coloured blocks, no
overlaps.

The output is committed, so this script is only needed when the card changes.
"""

import io
import os
import tempfile

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "og-image.png")

W, H = 1200, 630

BG = (16, 18, 22)
SURFACE = (23, 26, 32)
SURFACE_2 = (29, 33, 40)
BORDER = (38, 43, 51)
TEXT = (232, 234, 240)
TEXT_2 = (167, 174, 187)
TEXT_3 = (133, 141, 155)
ACCENT = (96, 165, 250)
ACCENT_SOLID = (29, 78, 216)
OK = (52, 211, 153)
WARN = (251, 191, 36)
VIOLET = (167, 139, 250)


def load_face(name):
    """woff2 -> a temp .ttf Pillow can open."""
    source = os.path.join(ROOT, "fonts", name)
    font = TTFont(source)
    font.flavor = None
    handle = tempfile.NamedTemporaryFile(suffix=".ttf", delete=False)
    font.save(handle.name)
    handle.close()
    return handle.name


SEMIBOLD = load_face("Geist-SemiBold.woff2")
MEDIUM = load_face("Geist-Medium.woff2")
REGULAR = load_face("Geist-Regular.woff2")
MONO = load_face("GeistMono-Regular.woff2")


def face(path, size):
    return ImageFont.truetype(path, size)


def rounded(draw, box, radius, fill=None, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def main():
    image = Image.new("RGB", (W, H), BG)

    # A soft accent glow behind the copy, so the card is not a flat rectangle.
    glow = Image.new("RGB", (W, H), BG)
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse((-220, -260, 760, 700), fill=(22, 40, 74))
    glow_draw.ellipse((300, 260, 900, 900), fill=(18, 30, 52))
    glow = glow.filter(ImageFilter.GaussianBlur(150))
    image = Image.blend(image, glow, 0.75)

    draw = ImageDraw.Draw(image)

    # Hairline grid: the timetable motif, at the edge of visibility.
    for x in range(0, W, 40):
        draw.line([(x, 0), (x, H)], fill=(24, 27, 33), width=1)
    for y in range(0, H, 40):
        draw.line([(0, y), (W, y)], fill=(24, 27, 33), width=1)

    left = 74

    # Brand row ------------------------------------------------------------
    rounded(draw, (left, 62, left + 58, 120), 14, fill=ACCENT_SOLID)
    mark = face(SEMIBOLD, 25)
    mark_box = draw.textbbox((0, 0), "CS", font=mark)
    draw.text(
        (left + 29 - (mark_box[2] - mark_box[0]) / 2, 91 - (mark_box[3] - mark_box[1]) / 2 - 2),
        "CS",
        font=mark,
        fill=(255, 255, 255),
    )

    brand = face(MEDIUM, 27)
    draw.text((left + 74, 91), "CSNL Module Picker", font=brand, fill=TEXT, anchor="lm")

    # Headline -------------------------------------------------------------
    headline = face(SEMIBOLD, 70)
    draw.text((left, 176), "Clash-free UCD", font=headline, fill=TEXT)
    draw.text((left, 254), "CS timetables.", font=headline, fill=TEXT)

    underline_y = 352
    rounded(draw, (left, underline_y, left + 92, underline_y + 6), 3, fill=ACCENT)

    # Supporting copy ------------------------------------------------------
    body = face(REGULAR, 28)
    draw.text((left, 386), "Live class times from UCD's own timetable,", font=body, fill=TEXT_2)
    draw.text((left, 424), "exam-free filters and a credit-target planner.", font=body, fill=TEXT_2)

    # Domain ---------------------------------------------------------------
    mono = face(MONO, 20)
    draw.text((left, 512), "ucdcsnlmodulepicker.pages.dev", font=mono, fill=TEXT_3)
    small = face(REGULAR, 19)
    draw.text((left, 548), "Free · no account · not an official UCD service", font=small, fill=(110, 118, 132))

    # Week card ------------------------------------------------------------
    card = (742, 96, 1126, 578)
    rounded(draw, card, 20, fill=SURFACE, outline=BORDER, width=1)

    # Panel head
    head = face(MEDIUM, 16)
    draw.text((766, 122), "Week 5 · Autumn", font=head, fill=TEXT_3)
    rounded(draw, (1012, 114, 1104, 146), 8, fill=SURFACE_2, outline=BORDER)
    pill = face(MEDIUM, 13)
    draw.text((1058, 130), "No clashes", font=pill, fill=OK, anchor="mm")

    grid_top = 168
    grid_bottom = 512
    days = ["Mon", "Tue", "Wed", "Thu", "Fri"]
    col_w = (1126 - 30 - 742 - 16) / 5
    grid_left = 766
    day_font = face(MONO, 11)
    for index, day in enumerate(days):
        x = grid_left + index * (col_w + 4)
        draw.text((x, grid_top - 22), day.upper(), font=day_font, fill=TEXT_3)
        rounded(draw, (x, grid_top, x + col_w, grid_bottom), 8, outline=(30, 34, 42), width=1)

    def block(day_index, start, end, label, colour, dark):
        x0 = grid_left + day_index * (col_w + 4)
        x1 = x0 + col_w
        y0 = grid_top + start
        y1 = grid_top + end
        rounded(draw, (x0 + 2, y0, x1 - 2, y1), 7, fill=dark)
        draw.line([(x0 + 2, y0 + 6), (x0 + 2, y1 - 6)], fill=colour, width=3)
        text = face(MEDIUM, 11)
        lines = label.split("\n")
        offset = y0 + 10
        for line in lines:
            draw.text((x0 + 10, offset), line, font=text, fill=colour)
            offset += 15

    block(0, 20, 96, "COMP\n30960", OK, (23, 52, 43))
    block(0, 170, 246, "COMP\n30030", ACCENT, (24, 41, 68))
    block(1, 95, 171, "COMP\n41730", VIOLET, (43, 36, 66))
    block(2, 20, 96, "COMP\n30030", ACCENT, (24, 41, 68))
    block(2, 245, 321, "COMP\n41760", WARN, (54, 45, 22))
    block(3, 95, 171, "COMP\n30960", OK, (23, 52, 43))
    block(4, 170, 246, "COMP\n41730", VIOLET, (43, 36, 66))

    # A quiet footer inside the card: credits, the thing the planner targets.
    credits = face(MEDIUM, 13)
    draw.text((766, 550), "60 / 90 credits planned", font=credits, fill=TEXT_3)

    image.save(OUT, "PNG", optimize=True)
    print("wrote %s (%d bytes, %dx%d)" % (OUT, os.path.getsize(OUT), W, H))
    for path in (SEMIBOLD, MEDIUM, REGULAR, MONO):
        try:
            os.unlink(path)
        except OSError:
            pass


if __name__ == "__main__":
    main()

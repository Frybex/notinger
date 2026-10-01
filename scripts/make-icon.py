#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
SS = 4
CANVAS = SIZE * SS
INSET = 82
PLATE = SIZE - INSET * 2
RADIUS = 200

TOP = (46, 49, 58)
BOTTOM = (17, 19, 24)
CREAM = (245, 240, 230)
ACCENT = (240, 154, 116)

OUT = Path(__file__).resolve().parent.parent / "build" / "icon.png"


def s(value: float) -> int:
    return int(round(value * SS))


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def plate_color(y: float) -> tuple[int, int, int]:
    t = min(max(y / (SIZE - 1), 0.0), 1.0)
    return tuple(int(round(lerp(TOP[i], BOTTOM[i], t))) for i in range(3))


def bezier(p0, p1, p2, p3, t):
    mt = 1 - t
    x = mt**3 * p0[0] + 3 * mt**2 * t * p1[0] + 3 * mt * t**2 * p2[0] + t**3 * p3[0]
    y = mt**3 * p0[1] + 3 * mt**2 * t * p1[1] + 3 * mt * t**2 * p2[1] + t**3 * p3[1]
    return x, y


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def build_plate() -> Image.Image:
    plate_px = s(PLATE)
    gradient = Image.new("RGB", (plate_px, plate_px))
    draw = ImageDraw.Draw(gradient)
    for row in range(plate_px):
        y = row / SS + INSET
        draw.line([(0, row), (plate_px, row)], fill=plate_color(y))
    plate = Image.new("RGBA", (plate_px, plate_px), (0, 0, 0, 0))
    plate.paste(gradient, (0, 0), rounded_mask(plate_px, s(RADIUS)))

    ink = Image.new("RGBA", (plate_px, plate_px), (0, 0, 0, 0))
    ink_draw = ImageDraw.Draw(ink)
    p0 = (322, 700)
    p1 = (322, 452)
    p2 = (702, 578)
    p3 = (702, 330)
    steps = 900
    for step in range(steps + 1):
        t = step / steps
        x, y = bezier(p0, p1, p2, p3, t)
        radius = lerp(17.0, 22.0, t)
        local_x = (x - INSET) * SS
        local_y = (y - INSET) * SS
        ink_draw.ellipse(
            (local_x - radius * SS, local_y - radius * SS, local_x + radius * SS, local_y + radius * SS),
            fill=CREAM,
        )
    for node in (p0, p3):
        color = plate_color(node[1])
        local_x = (node[0] - INSET) * SS
        local_y = (node[1] - INSET) * SS
        ink_draw.ellipse(
            (local_x - s(38), local_y - s(38), local_x + s(38), local_y + s(38)),
            fill=CREAM,
        )
        ink_draw.ellipse(
            (local_x - s(15), local_y - s(15), local_x + s(15), local_y + s(15)),
            fill=color + (255,),
        )
    plate.alpha_composite(ink)

    dots = Image.new("RGBA", (plate_px, plate_px), (0, 0, 0, 0))
    dots_draw = ImageDraw.Draw(dots)
    dot_positions = [(700, 776), (752, 776), (804, 776), (752, 724), (804, 724)]
    for x, y in dot_positions:
        local_x = (x - INSET) * SS
        local_y = (y - INSET) * SS
        dots_draw.ellipse(
            (local_x - s(7), local_y - s(7), local_x + s(7), local_y + s(7)),
            fill=ACCENT + (70,),
        )
    plate.alpha_composite(dots)
    return plate


def main() -> None:
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))

    shadow = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    shadow.paste(
        (8, 9, 12, 120),
        (s(INSET), s(INSET + 22)),
        rounded_mask(s(PLATE), s(RADIUS)),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(s(16)))
    canvas = Image.alpha_composite(canvas, shadow)

    plate = build_plate()
    canvas.paste(plate, (s(INSET), s(INSET)), plate)

    icon = canvas.resize((SIZE, SIZE), Image.LANCZOS)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    icon.save(OUT, "PNG")
    print(f"icône écrite : {OUT}")


if __name__ == "__main__":
    main()

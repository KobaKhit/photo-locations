from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# Allow full 8K × 3-panel canvases.
Image.MAX_IMAGE_PIXELS = 200_000_000


# Full 8K exports from the app (not chat thumbnails).
SOURCE_DIR = Path(r"C:\Users\kobak\Downloads")
OUTPUT_DIR = Path(r"C:\Users\kobak\Desktop\photo-locations")

ACCENT = "#ffd23c"
BACKGROUND = "#05070a"
PANEL = "#0b0f13"
MUTED = "#8f9aa3"
WHITE = "#f4f1df"
BORDER = "#293038"

FONT_BOLD = Path(r"C:\Windows\Fonts\arialbd.ttf")
FONT_REGULAR = Path(r"C:\Windows\Fonts\arial.ttf")

SUBTITLE = (
    "Equal Earth projection. 337,110 geotagged Flickr photos (2026). "
    "Population: GHSL 2020."
)


def source(name: str) -> Path:
    path = SOURCE_DIR / name
    if not path.is_file():
        raise FileNotFoundError(path)
    return path


def font(path: Path, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(path), size)


def build_infographic(
    output_name: str,
    title: str,
    subtitle: str,
    panels: list[tuple[str, str, Path]],
) -> Path:
    source_images = [Image.open(path).convert("RGB") for _, _, path in panels]
    source_width, source_height = source_images[0].size
    if any(image.size != source_images[0].size for image in source_images):
        raise RuntimeError("All source exports must have matching dimensions")

    # Chrome scales with the export so text stays sharp at 8K.
    ui = source_width / 1920
    margin = max(24, round(40 * ui))
    title_size = max(28, round(48 * ui))
    subtitle_size = max(16, round(22 * ui))
    index_size = max(16, round(26 * ui))
    label_size = max(18, round(28 * ui))
    description_size = max(14, round(20 * ui))
    title_height = max(80, round(140 * ui))
    panel_header_height = max(40, round(72 * ui))
    panel_gap = max(16, round(28 * ui))
    panel_height = panel_header_height + source_height
    width = source_width + margin * 2
    height = (
        title_height
        + len(panels) * panel_height
        + (len(panels) - 1) * panel_gap
        + margin
    )

    canvas = Image.new("RGB", (width, height), BACKGROUND)
    draw = ImageDraw.Draw(canvas)

    draw.text(
        (margin, round(28 * ui)),
        title,
        fill=ACCENT,
        font=font(FONT_BOLD, title_size),
    )
    draw.text(
        (margin, round(28 * ui) + title_size + round(18 * ui)),
        subtitle,
        fill=MUTED,
        font=font(FONT_REGULAR, subtitle_size),
    )

    y = title_height
    for index, ((label, description, _), image) in enumerate(
        zip(panels, source_images), start=1
    ):
        draw.rounded_rectangle(
            (margin, y, width - margin, y + panel_height),
            radius=max(4, round(6 * ui)),
            fill=PANEL,
            outline=BORDER,
            width=max(1, round(2 * ui)),
        )
        draw.text(
            (margin + round(22 * ui), y + round(18 * ui)),
            f"{index:02d}",
            fill=ACCENT,
            font=font(FONT_BOLD, index_size),
        )
        draw.text(
            (margin + round(78 * ui), y + round(16 * ui)),
            label.upper(),
            fill=WHITE,
            font=font(FONT_BOLD, label_size),
        )
        description_font = font(FONT_REGULAR, description_size)
        description_width = draw.textlength(description, font=description_font)
        draw.text(
            (width - margin - round(22 * ui) - description_width, y + round(22 * ui)),
            description,
            fill=MUTED,
            font=description_font,
        )
        canvas.paste(image, (margin, y + panel_header_height))
        y += panel_height + panel_gap

    output = OUTPUT_DIR / output_name
    # Keep full resolution; avoid heavy recompression that softens text.
    canvas.save(output, "PNG", compress_level=3)
    for image in source_images:
        image.close()
    return output


hex_panels = [
    (
        "Photos per capita",
        "Photos per 1,000 residents",
        source("flickr-2026-hex-per-capita-equal-earth-8k.png"),
    ),
    (
        "Photo count",
        "Raw geotagged photo density",
        source("flickr-2026-hex-photos-equal-earth-8k.png"),
    ),
    (
        "World population",
        "GHSL resident population (2020)",
        source("flickr-2026-hex-population-equal-earth-8k.png"),
    ),
]


def points_panels() -> list[tuple[str, str, Path]]:
    return [
        (
            "Photos per capita",
            "Photos per 1,000 residents",
            source("flickr-2026-points-per-capita-equal-earth-8k.png"),
        ),
        (
            "Photo count",
            "Individual geotagged photos",
            source("flickr-2026-points-photos-equal-earth-8k.png"),
        ),
        (
            "World population",
            "GHSL resident population (2020)",
            source("flickr-2026-points-population-equal-earth-8k.png"),
        ),
    ]


if __name__ == "__main__":
    import sys

    targets = set(sys.argv[1:]) or {"hex", "points"}
    outputs: list[Path] = []
    if "hex" in targets:
        outputs.append(
            build_infographic(
                "infographic-hex-equal-earth.png",
                "PHOTO GEOGRAPHY 2026: HEX VIEW",
                SUBTITLE,
                hex_panels,
            )
        )
    if "points" in targets:
        outputs.append(
            build_infographic(
                "infographic-points-equal-earth.png",
                "PHOTO GEOGRAPHY 2026: POINTS VIEW",
                SUBTITLE,
                points_panels(),
            )
        )
    for output in outputs:
        print(output)

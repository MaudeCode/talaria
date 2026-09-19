#!/usr/bin/env python3
"""Regenerate favicon and install icons from static/brand/brandmark.svg.

Developer-only: uv run --no-project --with playwright python scripts/generate-brand-icons.py
Uses Playwright's installed Chromium; the application has no build step.
"""
import struct
from pathlib import Path
from xml.etree import ElementTree as ET


def main():
    from playwright.sync_api import sync_playwright

    static = Path(__file__).resolve().parents[1] / "static" / "brand"
    source = ET.parse(static / "brandmark.svg").getroot()
    ET.register_namespace("", "http://www.w3.org/2000/svg")
    shape = "".join(ET.tostring(child, encoding="unicode") for child in source)

    def svg(dark=False, adaptive=False, install=False):
        background, ink = ("#141425", "#FFD700") if dark else ("#FAF7F0", "#876517")
        # Install icons keep the whole mark inside the maskable safe circle.
        scale = 0.7 if install else 0.98
        x, y = (1024 - 767 * scale) / 2, (1024 - 824 * scale) / 2
        media = "@media(prefers-color-scheme:dark){.tile{fill:#141425}.mark{fill:#FFD700}}" if adaptive else ""
        return (
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="512" height="512">\n'
            f'<style>.tile{{fill:{background}}}.mark{{fill:{ink}}}{media}</style>\n'
            f'<rect class="tile" width="1024" height="1024" rx="{0 if install else 230}"/>\n'
            f'<g class="mark" fill-rule="evenodd" transform="translate({x} {y}) scale({scale})">{shape}</g>\n'
            '</svg>\n'
        )

    for name, content in {
        "favicon.svg": svg(adaptive=True),
        "favicon-light.svg": svg(),
        "favicon-dark.svg": svg(dark=True),
        "favicon-512.svg": svg(dark=True, install=True),
    }.items():
        (static / name).write_text(content)

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(device_scale_factor=1, color_scheme="dark")

        def png(size, install=False):
            page.set_viewport_size({"width": size, "height": size})
            page.set_content('<style>body{margin:0}svg{width:100vw;height:100vh;display:block}</style>' + svg(dark=True, install=install))
            return page.screenshot(omit_background=True)

        for size in (32, 192, 512):
            (static / f"favicon-{size}.png").write_bytes(png(size, install=size > 32))
        (static / "apple-touch-icon.png").write_bytes(png(512, install=True))
        # ICO supports PNG frames, so no image-conversion dependency is needed.
        frames = [(size, png(size)) for size in (16, 32, 48)]
        offset = 6 + 16 * len(frames)
        directory = bytearray(struct.pack("<HHH", 0, 1, len(frames)))
        for size, data in frames:
            directory.extend(struct.pack("<BBBBHHII", size, size, 0, 0, 1, 32, len(data), offset))
            offset += len(data)
        (static / "favicon.ico").write_bytes(directory + b"".join(data for _, data in frames))
        browser.close()


if __name__ == "__main__":
    main()

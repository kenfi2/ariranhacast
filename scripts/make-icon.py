#!/usr/bin/env python3
"""Gera assets/icon.png, icon.ico e tray.png (rosto de ariranha estilizado, desenho original).
Uso: python3 scripts/make-icon.py   (precisa do Pillow)"""
from PIL import Image, ImageDraw

S = 1024  # desenha grande e reduz (suaviza as bordas)
BROWN, DARK, CREAM = (138, 90, 60, 255), (43, 29, 23, 255), (237, 222, 198, 255)
EAR_IN = (96, 62, 42, 255)
ACCENT = (124, 140, 255, 255)


def otter(d: ImageDraw.ImageDraw, dy: int = 0) -> None:
    def e(cx, cy, rx, ry, fill):
        d.ellipse((cx - rx, cy + dy - ry, cx + rx, cy + dy + ry), fill=fill)

    # orelhas
    for cx in (238, 786):
        e(cx, 392, 58, 58, BROWN)
        e(cx, 398, 28, 28, EAR_IN)
    # cabeça e babador claro (marca típica da ariranha)
    e(512, 570, 352, 258, BROWN)
    e(512, 840, 250, 120, CREAM)
    e(512, 668, 250, 168, CREAM)
    # focinho
    e(512, 592, 74, 50, DARK)
    d.line((512, 640 + dy, 512, 700 + dy), fill=DARK, width=18)
    d.arc((432, 650 + dy, 512, 740 + dy), 0, 90, fill=DARK, width=16)
    d.arc((512, 650 + dy, 592, 740 + dy), 90, 180, fill=DARK, width=16)
    # olhos
    for cx in (396, 628):
        e(cx, 490, 40, 44, DARK)
        e(cx + 12, 474, 12, 12, (255, 255, 255, 255))
    # bigodes
    for sx in (-1, 1):
        for k, ang in enumerate((-14, 0, 14)):
            x0 = 512 + sx * 120
            y0 = 640 + dy + k * 22
            d.line((x0, y0, 512 + sx * 290, y0 + ang * 3), fill=(255, 255, 255, 210), width=8)


def icon() -> Image.Image:
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, S - 1, S - 1), radius=230, fill=(23, 26, 33, 255))
    otter(d, dy=-10)
    # arcos de "transmissão" no canto
    for r, w in ((70, 26), (125, 26)):
        d.arc((880 - r, 150 - r, 880 + r, 150 + r), 270, 360, fill=ACCENT, width=w)
    d.ellipse((880 - 22, 150 - 22, 880 + 22, 150 + 22), fill=ACCENT)
    return im.resize((256, 256), Image.LANCZOS)


def tray() -> Image.Image:
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    otter(ImageDraw.Draw(im), dy=-10)
    box = im.getbbox()
    im = im.crop(box)
    side = max(im.size)
    sq = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    sq.paste(im, ((side - im.width) // 2, (side - im.height) // 2))
    return sq.resize((32, 32), Image.LANCZOS)


if __name__ == '__main__':
    big = icon()
    big.save('assets/icon.png')
    big.save('assets/icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    tray().save('assets/tray.png')
    print('ok')

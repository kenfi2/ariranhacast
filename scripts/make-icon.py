#!/usr/bin/env python3
"""Gera assets/icon.png, icon.ico e tray.png a partir de assets/icon-source.png
(arte da ariranha). Remove o fundo preto em volta do quadrado arredondado.
Uso: python3 scripts/make-icon.py   (precisa do Pillow)"""
from PIL import Image, ImageChops, ImageDraw, ImageFilter

src = Image.open('assets/icon-source.png').convert('RGB')
w, h = src.size

# Fundo = pixels quase pretos ligados aos cantos (o contorno escuro do desenho não é tocado).
dark = src.convert('L').point(lambda v: 255 if v < 7 else 0)
seed = dark.copy()
for corner in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
    ImageDraw.floodfill(seed, corner, 128)
outside = seed.point(lambda v: 255 if v == 128 else 0)
# Come 4 px da borda (tira a franja escura) e suaviza o recorte.
outside = outside.filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.GaussianBlur(1.5))
alpha = ImageChops.invert(outside)
art = src.copy()
art.putalpha(alpha)
box = alpha.point(lambda v: 255 if v > 8 else 0).getbbox()
art = art.crop(box)
side = max(art.size)
sq = Image.new('RGBA', (side, side), (0, 0, 0, 0))
sq.paste(art, ((side - art.width) // 2, (side - art.height) // 2))

big = sq.resize((256, 256), Image.LANCZOS)
big.save('assets/icon.png')
big.save('assets/icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
sq.resize((32, 32), Image.LANCZOS).save('assets/tray.png')
# conferência visual: ícone sobre fundo claro e escuro
check = Image.new('RGB', (560, 280), (255, 255, 255))
check.paste((30, 30, 30), (280, 0, 560, 280))
check.paste(big, (12, 12), big)
check.paste(big, (292, 12), big)
check.save('/tmp/icon-check.png')
print('ok', sq.size)

"""Ikony PWA Music Base (styl ikony panelu: niebieski kwadrat, białe słupki równoważnika). python3 pwa/ikony.py"""
import os
from PIL import Image, ImageDraw

TU = os.path.dirname(os.path.abspath(__file__))
NIEBIESKI, BIALY = (37, 99, 214, 255), (255, 255, 255, 255)
SLUPKI = [0.22, 0.42, 0.62, 0.38, 0.52, 0.30]   # wysokości (część boku)


def rysuj(bok: int, maskowalna: bool) -> Image.Image:
    s = 4   # rysujemy 4× większą i zmniejszamy – gładkie krawędzie
    B = bok * s
    im = Image.new('RGBA', (B, B), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if maskowalna:
        d.rectangle([0, 0, B, B], fill=NIEBIESKI)
        obszar = 0.62   # bezpieczna strefa maskowalnej ikony: środkowe 80% – słupki mniejsze
    else:
        d.rounded_rectangle([0, 0, B - 1, B - 1], radius=int(B * 0.22), fill=NIEBIESKI)
        obszar = 0.80
    n, szer = len(SLUPKI), B * obszar
    w = szer / (n * 1.6)
    x0, dol = (B - szer) / 2 + w * 0.3, B * (0.5 + obszar * 0.36)
    for i, h in enumerate(SLUPKI):
        x = x0 + i * w * 1.6
        d.rounded_rectangle([x, dol - B * h * obszar / 0.8, x + w, dol], radius=w / 2, fill=BIALY)
    return im.resize((bok, bok), Image.LANCZOS)


for bok, mask, nazwa in ((192, False, 'ikona-192.png'), (512, False, 'ikona-512.png'), (512, True, 'ikona-maskowalna-512.png')):
    rysuj(bok, mask).save(os.path.join(TU, nazwa), optimize=True)
print('ok')

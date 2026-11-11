"""Przeliczanie podsumowań na Dysku: wywołuje Odbiornik, aż nie będzie zaległości.

1. przeliczZalegle – podsumowania miesięcy, których brakuje (np. dane wgrane przed aktualizacją Odbiornika),
2. przeliczZbiorcze – lata stacji, miesiące i lata całego radia, indeks utworów.
Każde wywołanie trwa najwyżej ~4,5 min (limit Apps Script 6 min); pętla kończy się, gdy nie ma pracy
albo minie --max-minuty. Wywołania aplikacji internetowej nie zużywają dziennego limitu wyzwalaczy.

  python3 -m scraper.przeliczanie --max-minuty 30
"""
from __future__ import annotations

import argparse
import sys
import time

from .magazyn import BladOdbiornika, MagazynDysk


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--max-minuty", type=float, default=30)
    a = ap.parse_args(argv)
    mag = MagazynDysk()
    koniec = time.monotonic() + a.max_minuty * 60
    for akcja in ("przeliczZalegle", "przeliczZbiorcze"):
        while time.monotonic() < koniec:
            t0 = time.monotonic()
            try:
                w = mag.wyslij(akcja)
            except BladOdbiornika as e:
                if "nieznana akcja" in str(e):
                    print("Odbiornik nie ma jeszcze tej funkcji (stara wersja wdrożenia) – pomijam do aktualizacji.")
                    return 0
                raise
            print(f"{akcja}: zrobione {w.get('zrobione')}, pozostało {w.get('pozostalo')} ({time.monotonic() - t0:.0f} s)", flush=True)
            if not w.get("pozostalo"):
                break
            # przerwa: Odbiornik ma jedną blokadę, a ta nie ustawia czekających w kolejce – bez przerwy
            # pobieranie historii i aktualizacja bieżąca czekałyby na swoją kolej w nieskończoność
            time.sleep(20)
    return 0


if __name__ == "__main__":
    sys.exit(main())

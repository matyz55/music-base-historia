"""Uzupełnianie metadanych bez przerwy (osobne zadanie GitHub Actions, repozytorium publiczne – minuty bez opłat).

Tryby (każdy w osobnym zadaniu, więc z innego adresu IP i bez wzajemnego czekania):
  mb      – rok, kraj, długość nagrania: Songster (lokalny indeks), potem MusicBrainz (1 zapytanie na 1,1 s,
            limit MusicBrainz: średnio 1 na sekundę z jednego adresu),
  jezyk   – język tekstu i wulgaryzmy z lrclib.net (1 zapytanie na sekundę),
  gatunek – disco polo (MusicBrainz tylko dla kandydatów, Wikidata gdy dostępna),
  szczegoly – kompozytor, autor słów, producent, ISRC, pierwsze wydawnictwo (MusicBrainz, utwory z ≥ 20 emisjami).

Porcja za porcją (najczęściej grane najpierw), aż skończy się czas albo utwory. Gdy zostaje praca,
na końcu wypisuje ZOSTALA_PRACA – workflow zleca wtedy kolejne zadanie.

  python3 -m scraper.metadane_petla --tryb mb --max-minuty 300
"""
from __future__ import annotations

import argparse
import sys
import time
from types import SimpleNamespace

from .disco_polo import gatunki_pass
from .magazyn import MagazynDysk
from .metadane import _metadane, jezyki, szczegoly_pass


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tryb", choices=["mb", "jezyk", "gatunek", "szczegoly"], required=True)
    ap.add_argument("--max-minuty", type=float, default=300)
    ap.add_argument("--porcja", type=int, default=5000)
    a = ap.parse_args(argv)
    koniec = time.monotonic() + a.max_minuty * 60
    porcji, zostalo = 0, True
    while time.monotonic() < koniec - 60:
        porcji += 1
        if a.tryb == "mb":
            n = _metadane(SimpleNamespace(limit=a.porcja), 0, koniec)
        elif a.tryb == "jezyk":
            # najpierw ocena wulgaryzmów dla utworów sprawdzonych wcześniej (mają język, nie mają pola w), potem nowe
            n = jezyki(MagazynDysk(), koniec, limit=min(a.porcja, 3000), tryb="wulg")
            if not n:
                n = jezyki(MagazynDysk(), koniec, limit=min(a.porcja, 3000))
        elif a.tryb == "szczegoly":
            n = szczegoly_pass(MagazynDysk(), koniec, limit=min(a.porcja, 2000))
        else:
            n = gatunki_pass(MagazynDysk(), koniec, limit=a.porcja)
        if not n:   # nic do zrobienia (albo źródło chwilowo niedostępne) – koniec tego zadania
            zostalo = False
            break
    print(f"Tryb {a.tryb}: porcji {porcji}", flush=True)
    if zostalo:
        print("ZOSTALA_PRACA", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

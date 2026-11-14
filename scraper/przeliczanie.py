"""Przeliczanie podsumowań na Dysku: wywołuje Odbiornik, aż nie będzie zaległości.

1. przeliczZalegle – podsumowania miesięcy, których brakuje (np. dane wgrane przed aktualizacją Odbiornika),
2. przeliczZbiorcze – lata stacji, miesiące i lata całego radia, indeks utworów,
3. plikiPanelu – małe pliki dla panelu (metadane lekkie, wyszukiwarka, Start, rankingi, tygodnie, pliki lat).
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
    ap.add_argument("--natychmiast", action="store_true", help="bez czekania 90 min na „dojrzałość” miesięcy (testy)")
    a = ap.parse_args(argv)
    mag = MagazynDysk()
    koniec = time.monotonic() + a.max_minuty * 60
    # szybka diagnostyka plików .json na Dysku (stan stacji, indeks, pliki pomocnicze) – wynik w dzienniku
    try:
        d = mag.wyslij("diagnostyka")
        print(f"Diagnostyka: sprawdzono {d.get('sprawdzone')} plików, problemy: {d.get('problemy') or 'brak'}", flush=True)
    except BladOdbiornika as e:
        print(f"Diagnostyka niedostępna: {e}", flush=True)
    zostalo = False
    # plikiPanelu (od 14.11.2026): małe pliki dla panelu (Start, Ranking, wyszukiwarka…) liczone w Odbiorniku.
    # Najpierw pilne (najwyżej 3 wywołania) – żeby panel nie czekał, aż skończy się pobieranie historii – potem reszta.
    kroki = (("przeliczZalegle", {}, None), ("plikiPanelu", {"pilne": True}, 3), ("przeliczZbiorcze", {}, None), ("plikiPanelu", {}, None))
    for akcja, opcje, maks in kroki:
        w = {"pozostalo": 1}
        wywolan = 0
        # przeliczZbiorcze zostawia ok. 8 min na pliki panelu (tygodnie, pliki lat, rankingi 365 dni i „Ten rok”),
        # inaczej przy pobieraniu historii mogłyby nie dostać czasu przez wiele uruchomień
        do_kiedy = koniec - min(480, a.max_minuty * 60 * 0.2) if akcja == "przeliczZbiorcze" else koniec
        while time.monotonic() < do_kiedy and (maks is None or wywolan < maks):
            wywolan += 1
            t0 = time.monotonic()
            try:
                w = mag.wyslij(akcja, natychmiast=a.natychmiast, **opcje)
            except BladOdbiornika as e:
                if akcja == "plikiPanelu":
                    # stara wersja Odbiornika albo błąd w plikach panelu – przeliczanie idzie dalej bez nich
                    print(f"plikiPanelu: pomijam ({e})", flush=True)
                    w = {}
                    break
                if "nieznana akcja" in str(e):
                    print("Odbiornik nie ma jeszcze tej funkcji (stara wersja wdrożenia) – pomijam do aktualizacji.")
                    return 0
                raise
            czeka = f", czeka na dojrzałość: {w['czeka']}" if w.get("czeka") else ""
            nazwa = akcja + (" (pilne)" if opcje.get("pilne") else "")
            print(f"{nazwa}: zrobione {w.get('zrobione')}, pozostało {w.get('pozostalo')}{czeka} ({time.monotonic() - t0:.0f} s)", flush=True)
            if w.get("diag"):   # co zrobiło wywołanie (lata stacji / całego radia, indeks utworów, miesiące, paczki, pliki panelu)
                print(f"    {w['diag']}", flush=True)
            if not w.get("pozostalo"):
                break
            # przerwa: Odbiornik ma jedną blokadę, a ta nie ustawia czekających w kolejce – bez przerwy
            # pobieranie historii i aktualizacja bieżąca czekałyby na swoją kolej w nieskończoność
            time.sleep(20)
        if not opcje.get("pilne"):   # pilne: resztę zrobi wywołanie po przeliczZbiorcze
            zostalo = zostalo or bool(w.get("pozostalo"))
    # znacznik dla workflow: zostało coś do przeliczenia → od razu następne zadanie (harmonogram GitHuba bywa opóźniony o godziny)
    print("ZOSTALA_PRACA" if zostalo else "PRZELICZANIE_GOTOWE", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

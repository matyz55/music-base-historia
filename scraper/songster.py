"""Wczytywanie bazy piosenek gry Songster (songs.js) i dopasowanie utworów z radia.

Songster to osobny projekt (github.com/matyz55/songster). Ten moduł tylko czyta jego plik
songs.js – nic w nim nie zmienia. Domyślnie pobiera aktualną wersję z GitHub Pages.
"""
from __future__ import annotations

import json
import re
import urllib.request

from .normalize import tytul, wykonawcy

SONGS_URL = "https://matyz55.github.io/songster/songs.js"


def _js_na_json(tekst: str) -> list[dict]:
    """songs.js to tablica obiektów JS z kluczami bez cudzysłowów – zamieniamy na JSON."""
    start = tekst.index("[", tekst.index("window.SONGS"))
    koniec = tekst.rindex("]") + 1
    cialo = tekst[start:koniec]
    # klucze bez cudzysłowów tylko poza napisami: dzielimy na napisy i resztę
    czesci = re.split(r'("(?:[^"\\]|\\.)*")', cialo)
    for i in range(0, len(czesci), 2):
        czesci[i] = re.sub(r"([{,]\s*)([A-Za-z_]\w*)\s*:", r'\1"\2":', czesci[i])
        czesci[i] = re.sub(r",(\s*[}\]])", r"\1", czesci[i])
    return json.loads("".join(czesci))


def wczytaj(zrodlo: str = SONGS_URL) -> list[dict]:
    if zrodlo.startswith("http"):
        with urllib.request.urlopen(zrodlo, timeout=60) as odp:
            tekst = odp.read().decode("utf-8")
    else:
        with open(zrodlo, encoding="utf-8") as f:
            tekst = f.read()
    return _js_na_json(tekst)


class Indeks:
    """Szybkie sprawdzanie, czy utwór (wykonawca + tytuł) jest w Songsterze."""

    def __init__(self, piosenki: list[dict]):
        self.piosenki = piosenki
        self._mapa: dict[tuple[str, str], dict] = {}
        for p in piosenki:
            nazwy = [p.get("a", ""), p.get("ma", ""), p.get("ia", "")] + list(p.get("x", []) or [])
            t = tytul(p.get("t", ""))
            for n in nazwy:
                for w in wykonawcy(n or ""):
                    self._mapa.setdefault((w, t), p)

    def znajdz(self, artysta: str, tytul_: str) -> dict | None:
        t = tytul(tytul_)
        for w in wykonawcy(artysta):
            p = self._mapa.get((w, t))
            if p:
                return p
        return None

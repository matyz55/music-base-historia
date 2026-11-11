"""Metadane utworów: rok/data wydania, polski/zagraniczny, kraj, gatunki, identyfikator Spotify.

Źródła (w tej kolejności):
1. Songster (github.com/matyz55/songster) – rok pierwszego wydania sprawdzony procesem gry (VERIFICATION.md),
   kraj wykonawcy, gatunki, identyfikator Spotify; dopasowanie po ujednoliconym wykonawcy i tytule,
2. MusicBrainz – najwcześniejsza „first-release-date” nagrań tego wykonawcy o tym tytule (wynik ≥ 90)
   i kraj wykonawcy; najwyżej 1 zapytanie na sekundę (zasada MusicBrainz).
Utwory bez wyniku są oznaczane próbą i sprawdzane ponownie najwcześniej po 30 dniach.

  python3 -m scraper.metadane --max-minuty 10
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request

from .magazyn import BladOdbiornika, MagazynDysk
from .normalize import tytul, wykonawca, wykonawcy
from .songster import SONGS_URL, Indeks, wczytaj

MB = "https://musicbrainz.org/ws/2"
UA = "MusicBaseScrapper/0.2 (prywatne archiwum playlist)"


def wczytaj_spotify_songstera() -> dict[str, str]:
    url = SONGS_URL.replace("songs.js", "songs-sp.js")
    with urllib.request.urlopen(url, timeout=60) as odp:
        tekst = odp.read().decode("utf-8")
    cialo = tekst[tekst.index("{"): tekst.rindex("}") + 1]
    return json.loads(re.sub(r",(\s*})", r"\1", cialo))  # plik JS dopuszcza przecinek po ostatnim elemencie


class MusicBrainz:
    def __init__(self):
        self._ostatnie = 0.0
        self.kraje: dict[str, str | None] = {}

    def _get(self, sciezka: str) -> dict:
        czekaj = self._ostatnie + 1.1 - time.monotonic()
        if czekaj > 0:
            time.sleep(czekaj)
        self._ostatnie = time.monotonic()
        req = urllib.request.Request(MB + sciezka, headers={"User-Agent": UA, "Accept": "application/json"})
        for proba in range(3):
            try:
                with urllib.request.urlopen(req, timeout=30) as odp:
                    return json.load(odp)
            except urllib.error.HTTPError as e:
                if e.code in (503, 429):
                    time.sleep(5 * (proba + 1))
                    continue
                raise
        return {}

    def kraj(self, artist_id: str) -> str | None:
        if artist_id not in self.kraje:
            self.kraje[artist_id] = (self._get(f"/artist/{artist_id}?fmt=json") or {}).get("country")
        return self.kraje[artist_id]

    def utwor(self, a: str, t: str) -> dict | None:
        glowny = re.split(r"\s*(?:/|&|,| feat\.? | ft\.? | x )\s*", a, flags=re.I)[0]
        tyt = re.sub(r"\s*[(\[].*?[)\]]", "", t).strip()
        q = f'recording:"{tyt}" AND artist:"{glowny}"'
        d = self._get("/recording?fmt=json&limit=25&query=" + urllib.parse.quote(q))
        wk, tk = set(wykonawcy(a)), tytul(t)
        najlepsze = None
        for r in d.get("recordings", []):
            if r.get("score", 0) < 90 or not r.get("first-release-date") or tytul(r.get("title", "")) != tk:
                continue
            kredyty = r.get("artist-credit") or []
            if not any(wykonawca(k.get("name", "")) in wk for k in kredyty if isinstance(k, dict)):
                continue
            data = r["first-release-date"]
            if najlepsze is None or data < najlepsze[0]:
                najlepsze = (data, kredyty[0]["artist"]["id"])
        if not najlepsze:
            return None
        kraj = self.kraj(najlepsze[1])
        wynik = {"y": int(najlepsze[0][:4]), "d": najlepsze[0], "z": "MusicBrainz"}
        if kraj:
            wynik.update({"cc": kraj, "c": "PL" if kraj == "PL" else "INT"})
        return wynik


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--max-minuty", type=float, default=10)
    ap.add_argument("--limit", type=int, default=5000, help="ile utworów bez metadanych pobrać z Odbiornika")
    a = ap.parse_args(argv)
    koniec = time.monotonic() + a.max_minuty * 60
    mag = MagazynDysk()
    try:
        braki = mag.wyslij("kluczeBezMetadanych", limit=a.limit)["klucze"]
    except BladOdbiornika as e:
        if "nieznana akcja" in str(e):
            print("Odbiornik nie ma jeszcze tej funkcji (stara wersja wdrożenia) – pomijam do aktualizacji.")
            return 0
        raise
    print(f"Bez metadanych: {len(braki)} (najczęściej grane najpierw)")
    if not braki:
        return 0
    indeks = Indeks(wczytaj())
    sp = wczytaj_spotify_songstera()
    wynik, z_songstera, z_mb, bez = {}, 0, 0, 0

    def wyslij():
        if wynik:
            mag.wyslij("zapiszMetadane", metadane=dict(wynik))
            wynik.clear()

    reszta = []
    for k, art, tyt, _n in braki:
        s = indeks.znajdz(art, tyt)
        if s:
            m = {"y": s.get("y"), "z": "Songster", "c": "PL" if s.get("c") == "PL" else "INT", "cc": s.get("cc") or None, "g": s.get("g") or None,
                 "sp": sp.get(f"{s['a']}|{s['t']}")}
            wynik[k] = {p: v for p, v in m.items() if v}
            z_songstera += 1
        else:
            reszta.append((k, art, tyt))
    wyslij()
    mb = MusicBrainz()
    for k, art, tyt in reszta:
        if time.monotonic() > koniec:
            break
        try:
            m = mb.utwor(art, tyt)
        except Exception as e:  # sieć – spróbujemy przy następnym uruchomieniu
            print(f"MusicBrainz: {art} – {tyt}: {e}", file=sys.stderr)
            continue
        if m:
            wynik[k] = m
            z_mb += 1
        else:
            wynik[k] = {"proba": int(time.time() * 1000)}
            bez += 1
        if len(wynik) >= 100:
            wyslij()
    wyslij()
    print(f"Songster: {z_songstera}, MusicBrainz: {z_mb}, bez wyniku: {bez}, niesprawdzone (limit czasu): {len(reszta) - z_mb - bez}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

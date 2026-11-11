"""Pobieranie playlist z serwisu odSluchane.eu (archiwum od 2009 r., ok. 65 stacji).

Ustalone eksperymentalnie 11.11.2026 (nie z dokumentacji – serwis jej nie publikuje):
- lista stacji: /radio, strona stacji /radio/<slug> zawiera odnośnik szukaj.php?r=<id>,
- playlista: /szukaj.php?r=<id>&date=DD-MM-RRRR&time_from=G&time_to=G,
- okno do 10 godzin działa (10–20), 12 godzin i więcej zwraca „Brak wyników”,
  więc doba = 3 zapytania: 0–10, 10–20, 20–0,
- robots.txt niczego nie zabrania; z kompresją gzip odpowiedź ma ok. 27 KB.
"""
from __future__ import annotations

import datetime as dt
import gzip
import html
import re
import time
import urllib.error
import urllib.request

BAZA = "https://www.odsluchane.eu"
OKNA = ((0, 10), (10, 20), (20, 0))
USER_AGENT = "Mozilla/5.0 (compatible; MusicBaseScrapper/0.1; prywatne archiwum)"


class Pobieracz:
    """Pobiera strony z odstępem między zapytaniami i ponawia po błędach sieci."""

    def __init__(self, odstep: float = 1.0, proby: int = 4):
        self.odstep = odstep
        self.proby = proby
        self._ostatnie = 0.0
        self.zapytan = 0
        self.bajtow = 0

    def pobierz(self, url: str) -> str:
        for proba in range(self.proby):
            czekaj = self._ostatnie + self.odstep - time.monotonic()
            if czekaj > 0:
                time.sleep(czekaj)
            self._ostatnie = time.monotonic()
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "gzip"})
            try:
                with urllib.request.urlopen(req, timeout=30) as odp:
                    dane = odp.read()
                    if odp.headers.get("Content-Encoding") == "gzip":
                        dane = gzip.decompress(dane)
                self.zapytan += 1
                self.bajtow += len(dane)
                return dane.decode("utf-8", errors="replace")
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                kod = getattr(e, "code", None)
                if kod is not None and 400 <= kod < 500 and kod != 429:
                    raise
                time.sleep(2 ** (proba + 1))  # 2, 4, 8, 16 s
        raise RuntimeError(f"Nie udało się pobrać {url} po {self.proby} próbach")


# stacje, których nie zbieramy (decyzja użytkownika 11.11.2026: RMF Dance usunięte z bazy)
WYKLUCZONE = {"rmf_dance"}


def lista_stacji(p: Pobieracz) -> list[str]:
    s = p.pobierz(f"{BAZA}/radio")
    slugi = sorted(set(re.findall(r'href="https://www\.odsluchane\.eu/radio/([a-z0-9_]+)"', s)))
    return [x for x in slugi if x != "index" and x not in WYKLUCZONE]


def id_stacji(p: Pobieracz, slug: str) -> tuple[int, str]:
    """Zwraca (id, nazwa stacji)."""
    s = p.pobierz(f"{BAZA}/radio/{slug}")
    m = re.search(r"szukaj\.php\?r=(\d+)", s)
    if not m:
        raise ValueError(f"Nie znaleziono id stacji {slug}")
    n = re.search(r"stacji:\s*([^:<]+?)\s*::", s)
    return int(m.group(1)), (n.group(1).strip() if n else slug)


_WIERSZ = re.compile(r"<tr>\s*<td>(\d\d:\d\d)</td>\s*<td>(.*?)</td>", re.S)


def parsuj(strona: str) -> list[dict]:
    """Wiersze playlisty: godzina, wykonawca, tytuł, id utworu w odSluchane (gdy jest)."""
    wynik = []
    for godz, komorka in _WIERSZ.findall(strona):
        m = re.search(r"/utwor/(\d+)/", komorka)
        tekst = html.unescape(re.sub(r"<[^>]+>", " ", komorka))
        tekst = re.sub(r"\s+", " ", tekst).strip()
        a, sep, t = tekst.partition(" - ")
        if not sep:
            a, t = tekst, ""
        wynik.append({"g": godz, "a": a.strip(), "t": t.strip(), "id": int(m.group(1)) if m else None})
    return wynik


def doba(p: Pobieracz, r: int, dzien: dt.date) -> list[dict]:
    """Cała doba emisji (3 zapytania), bez powtórzeń na styku okien."""
    d = dzien.strftime("%d-%m-%Y")
    wynik, widziane = [], set()
    for od, do in OKNA:
        s = p.pobierz(f"{BAZA}/szukaj.php?r={r}&date={d}&time_from={od}&time_to={do}")
        for w in parsuj(s):
            k = (w["g"], w["a"], w["t"])
            if k not in widziane:
                widziane.add(k)
                wynik.append(w)
    wynik.sort(key=lambda w: w["g"])
    return wynik

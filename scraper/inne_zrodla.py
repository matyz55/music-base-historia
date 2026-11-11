"""Stacje spoza odSluchane.eu: playlisty prosto ze stron stacji.

  radio_357   – radio357.pl/twoje-357/playlista/dzien/RRRR-MM-DD/ (każda doba, także historia; HTML:
                songDate / songArtis / songTitle)
  nowy_swiat  – nowyswiat.online/playlista (tylko bieżąca doba; HTML: data-date, rns-vote-title, rns-vote-names)
  rmf24       – api.rmfon.pl/stations/190/playlist (3 ostatnie utwory) – za mało na zapytanie co godzinę, więc
                zbiera je Odbiornik co 10 minut (apps-script/OdbiornikNaZywo.gs), nie ten moduł.

Zapis: paczka miesięcy przez Odbiornik (zapiszPaczke) – przesłane doby zastępują swoje stare wiersze, więc ta sama
doba może być wysyłana wiele razy (dzisiejsza co godzinę rośnie). Stan stacji ma zrodlo ≠ odsluchane, więc
aktualizacja z odSluchane i pobieranie historii odSluchane ją pomijają.

  python3 -m scraper.inne_zrodla --historia 2021-01-01 --max-minuty 30   # jednorazowo: historia Radia 357
"""
from __future__ import annotations

import argparse
import datetime as dt
import html
import re
import sys
import time
from zoneinfo import ZoneInfo

from .magazyn import MagazynDysk, MagazynLokalny
from .odsluchane import Pobieracz

STREFA = ZoneInfo("Europe/Warsaw")
STACJE = {
    "radio_357": {"nazwa": "Radio 357", "zrodlo": "radio357"},
    "nowy_swiat": {"nazwa": "Radio Nowy Świat", "zrodlo": "nowyswiat"},
}


def _tekst(s: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s))).strip()


def parsuj_357(strona: str, dzien: dt.date) -> list[dict]:
    """Utwory z HTML strony dnia Radia 357 (nagłówki audycji – programGroupDate – są pomijane)."""
    wynik = []
    for blok in strona.split('class="programGroupSong')[1:]:
        g = re.search(r'class="songDate">\s*(\d{1,2}):(\d{2})', blok)
        a = re.search(r'class="songArtis">(.*?)</', blok, re.S)
        t = re.search(r'class="songTitle">(.*?)</', blok, re.S)
        if g and a and t:
            wynik.append({"d": dzien.isoformat(), "g": f"{int(g.group(1)):02d}:{g.group(2)}", "a": _tekst(a.group(1)), "t": _tekst(t.group(1)), "id": None})
    return sorted(wynik, key=lambda w: w["g"])


def parsuj_nowy_swiat(strona: str) -> list[dict]:
    """Utwory z HTML playlisty Nowego Świata (pełna data i godzina w data-date)."""
    wynik = []
    for blok in strona.split('class="rns-vote-list-element"')[1:]:
        dd = re.search(r'data-date="(\d{4}-\d\d-\d\d) (\d\d):(\d\d)', blok)
        t = re.search(r'class="rns-vote-title">(.*?)</', blok, re.S)
        a = re.search(r'class="rns-vote-names">(.*?)</', blok, re.S)
        if dd and t and a:
            wynik.append({"d": dd.group(1), "g": f"{dd.group(2)}:{dd.group(3)}", "a": _tekst(a.group(1)), "t": _tekst(t.group(1)), "id": None})
    return sorted(wynik, key=lambda w: (w["d"], w["g"]))


def doba_357(p: Pobieracz, dzien: dt.date) -> list[dict]:
    return parsuj_357(p.pobierz(f"https://radio357.pl/twoje-357/playlista/dzien/{dzien.isoformat()}/"), dzien)


def _paczka(slug: str, wiersze: list[dict], dni: list[str]) -> dict:
    ile = {d: 0 for d in dni}
    for w in wiersze:
        ile[w["d"]] = ile.get(w["d"], 0) + 1
    info = STACJE[slug]
    return {"slug": slug, "wiersze": wiersze, "stan": {"slug": slug, "nazwa": info["nazwa"], "zrodlo": info["zrodlo"], "dni": ile, "miesiace_puste": []}}


def aktualizuj(mag, p: Pobieracz, dzis: dt.date, zaleglosci: int = 2) -> list[str]:
    """Co godzinę: Radio 357 – dziś i `zaleglosci` dni wstecz; Nowy Świat – dzisiejsza strona playlisty."""
    wpisy, raport = [], []
    try:
        dni = [dzis - dt.timedelta(days=k) for k in range(zaleglosci, -1, -1)]
        wiersze = []
        for d in dni:
            wiersze += doba_357(p, d)
        wpisy.append(_paczka("radio_357", wiersze, [d.isoformat() for d in dni]))
        raport.append(f"radio_357: {len(wiersze)} emisji ({dni[0]} – {dni[-1]})")
    except Exception as e:  # jedna stacja nie zatrzymuje pozostałych
        raport.append(f"radio_357: BŁĄD {e}")
    try:
        w = parsuj_nowy_swiat(p.pobierz("https://nowyswiat.online/playlista"))
        if w:
            wpisy.append(_paczka("nowy_swiat", w, sorted({x["d"] for x in w})))
        raport.append(f"nowy_swiat: {len(w)} emisji")
    except Exception as e:
        raport.append(f"nowy_swiat: BŁĄD {e}")
    if wpisy:
        mag.zapisz_paczke(wpisy)
    return raport


def historia_357(mag, p: Pobieracz, od: dt.date, max_minuty: float) -> None:
    """Historia Radia 357 miesiąc po miesiącu wstecz od wczoraj; pomija doby już zapisane (wznawialne)."""
    koniec = time.monotonic() + max_minuty * 60
    stan = mag.stany(["radio_357"]).get("radio_357") or {}
    zrobione = set((stan or {}).get("dni", {}))
    d = dt.datetime.now(STREFA).date() - dt.timedelta(days=1)
    puste_z_rzedu = 0
    while d >= od and time.monotonic() < koniec:
        mies = d.strftime("%Y-%m")
        dni, wiersze = [], []
        while d >= od and d.strftime("%Y-%m") == mies and time.monotonic() < koniec:
            if d.isoformat() not in zrobione:
                w = doba_357(p, d)
                dni.append(d.isoformat())
                wiersze += w
                puste_z_rzedu = 0 if w else puste_z_rzedu + 1
            d -= dt.timedelta(days=1)
        if dni:
            mag.zapisz_paczke([_paczka("radio_357", wiersze, dni)])
            print(f"radio_357 {mies}: {len(dni)} dób, {len(wiersze)} emisji", flush=True)
        if puste_z_rzedu >= 45:   # półtora miesiąca bez playlisty – początek historii stacji
            print("radio_357: 45 pustych dób z rzędu – koniec historii", flush=True)
            break
    # znacznik dla workflow: bez niego zadanie od razu uruchamia następne
    print("HISTORIA_KOMPLETNA" if (d < od or puste_z_rzedu >= 45) else "ZOSTALA_PRACA", flush=True)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--historia", help="pobierz historię Radia 357 od tej daty (RRRR-MM-DD)")
    ap.add_argument("--max-minuty", type=float, default=30)
    ap.add_argument("--magazyn", choices=["dysk", "lokalny"], default="dysk")
    a = ap.parse_args(argv)
    mag = MagazynDysk() if a.magazyn == "dysk" else MagazynLokalny()
    p = Pobieracz(odstep=1.0)
    if a.historia:
        historia_357(mag, p, dt.date.fromisoformat(a.historia), a.max_minuty)
    else:
        for r in aktualizuj(mag, p, dt.datetime.now(STREFA).date()):
            print(r)
    return 0


if __name__ == "__main__":
    sys.exit(main())

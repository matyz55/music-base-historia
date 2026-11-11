"""Jednorazowe pobranie całej historii playlist z odSluchane.eu – tydzień po tygodniu, wszystkie stacje naraz.

Krok = 7 dni (licząc wstecz od wczoraj). W każdym kroku pobierane są brakujące doby wszystkich stacji,
potem całość trafia jedną paczką do magazynu i zaczyna się kolejny tydzień wstecz. Historia rośnie więc
równo dla wszystkich stacji. Tydzień 65 stacji to ok. 1 365 zapytań (ok. 23 min przy 1 zapytaniu/s),
czyli ok. 1,2 roku historii całego radia na dobę pracy.

Wznawianie po dniach: stan każdej stacji zawiera pobrane doby, więc przerwany tydzień jest dokończony
(pobierane są tylko brakujące dni). Miesiące bez danych wykrywa próbka (15. dzień, 10:00–20:00) –
taki miesiąc stacji jest pomijany i zapamiętany w stanie jako „pusty”.

Przykłady:
  python3 -m scraper.backfill --stacje rmf_fm,radio_zet --od 2025              # lokalnie, do data/
  python3 -m scraper.backfill --magazyn dysk --max-minuty 330                   # GitHub Actions → Dysk Google
"""
from __future__ import annotations

import argparse
import datetime as dt
import sys
import time
from zoneinfo import ZoneInfo

from .magazyn import MagazynDysk, MagazynLokalny
from .odsluchane import BAZA, Pobieracz, doba, id_stacji, lista_stacji, parsuj


def miesiac_ma_dane(p: Pobieracz, r: int, rok: int, mies: int, najpozniej: dt.date) -> bool:
    """Próbki: 15., 5. i 25. dzień (10:00–20:00), przyszłe dni zastąpione ostatnim dostępnym.
    Miesiąc jest pusty dopiero, gdy wszystkie próbki są puste (pojedyncza doba bywa luką)."""
    for dzien in (15, 5, 25):
        d = min(dt.date(rok, mies, dzien), najpozniej).strftime("%d-%m-%Y")
        if parsuj(p.pobierz(f"{BAZA}/szukaj.php?r={r}&date={d}&time_from=10&time_to=20")):
            return True
    return False


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stacje", default="all", help="lista slugów po przecinku albo 'all'")
    ap.add_argument("--od", type=int, default=2009, help="najstarszy rok")
    ap.add_argument("--odstep", type=float, default=1.0, help="sekundy między zapytaniami (domyślnie 1)")
    ap.add_argument("--max-minuty", type=float, default=0, help="zakończ po tylu minutach (0 = bez limitu)")
    ap.add_argument("--magazyn", choices=["lokalny", "dysk"], default="lokalny")
    a = ap.parse_args(argv)

    mag = MagazynDysk() if a.magazyn == "dysk" else MagazynLokalny()
    p = Pobieracz(odstep=a.odstep)
    start = time.monotonic()
    koniec = start + a.max_minuty * 60 if a.max_minuty else float("inf")
    wczoraj = dt.datetime.now(ZoneInfo("Europe/Warsaw")).date() - dt.timedelta(days=1)
    najstarszy = dt.date(a.od, 1, 1)

    slugi = lista_stacji(p) if a.stacje == "all" else [s.strip() for s in a.stacje.split(",") if s.strip()]
    stany = mag.stany(slugi)
    nowe_id = []
    for s in slugi:
        if not stany[s].get("r"):
            stany[s]["r"], stany[s]["nazwa"] = id_stacji(p, s)
            nowe_id.append({"slug": s, "stan": stany[s], "wiersze": []})
    if nowe_id:
        mag.zapisz_paczke(nowe_id)

    ma_dane: dict[tuple[str, str], bool] = {}  # (stacja, RRRR-MM) → wynik próbki w tym uruchomieniu
    dob = 0

    def raport(tekst: str) -> None:
        print(f"{tekst} | {dob} dób, {p.zapytan} zapytań, {p.bajtow / 1e6:.0f} MB, {(time.monotonic() - start) / 60:.0f} min", flush=True)

    koniec_tyg = wczoraj
    while koniec_tyg >= najstarszy:
        poczatek_tyg = max(koniec_tyg - dt.timedelta(days=6), najstarszy)
        tydzien = [koniec_tyg - dt.timedelta(days=i) for i in range((koniec_tyg - poczatek_tyg).days + 1)]
        paczka, emisji, limit = [], 0, False
        for s in slugi:
            st = stany[s]
            brak = [d for d in tydzien if d.isoformat() not in st["dni"]]
            dni_ok, wiersze, zmiana = {}, [], False
            for d in brak:
                km = d.strftime("%Y-%m")
                if km in st["miesiace_puste"]:
                    continue
                if time.monotonic() > koniec:
                    limit = True
                    break
                if (s, km) not in ma_dane:
                    ma_dane[(s, km)] = miesiac_ma_dane(p, st["r"], d.year, d.month, wczoraj)
                    if not ma_dane[(s, km)]:
                        st["miesiace_puste"].append(km)
                        zmiana = True
                        continue
                w = doba(p, st["r"], d)
                wiersze.extend({"d": d.isoformat(), **x} for x in w)
                dni_ok[d.isoformat()] = len(w)
                dob += 1
            if limit:
                break  # niedokończona stacja w tym tygodniu – jej doby zostaną pobrane ponownie
            if dni_ok or zmiana:
                st["dni"].update(dni_ok)
                paczka.append({"slug": s, "stan": st, "wiersze": wiersze})
                emisji += len(wiersze)
        if paczka:
            mag.zapisz_paczke(paczka)
        if limit:
            raport(f"Limit czasu w tygodniu {poczatek_tyg}–{koniec_tyg} (zapisane: {len(paczka)} stacji) – wznów tym samym poleceniem")
            return 0
        if paczka:
            raport(f"Tydzień {poczatek_tyg}–{koniec_tyg}: {len(paczka)} stacji, {emisji} emisji")
        koniec_tyg = poczatek_tyg - dt.timedelta(days=1)
    raport("Koniec – cała historia pobrana")
    return 0


if __name__ == "__main__":
    sys.exit(main())

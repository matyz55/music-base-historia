"""Rozmiar danych w Odbiorniku – do zaplanowania aplikacji offline (PWA, 14.11.2026).

Wypisuje wyłącznie liczby (bez treści plików): ile plików i ile MB (skompresowanych, tak jak leżą na Dysku) ma
każda grupa – widoki dla panelu, lekkie metadane, surowe emisje stacji (łącznie i rok po roku) – oraz szacunek
paczki podstawowej i paczki z emisjami z ostatnich 12 miesięcy. Korzysta z akcji Odbiornika eksportPlikow (lista).

  python3 -m scraper.rozmiar_danych
"""
from __future__ import annotations

import collections
import datetime as dt
import sys

from .magazyn import MagazynDysk


def podsumuj(pliki: list[dict], dzis: dt.date | None = None) -> dict:
    dzis = dzis or dt.date.today()
    granica = f"{dzis.year - 1}-{dzis.month:02d}"   # ostatnie 12 pełnych miesięcy + bieżący
    grupy = collections.defaultdict(lambda: [0, 0])
    lata = collections.defaultdict(lambda: [0, 0])
    stacje = set()
    ost12 = [0, 0]
    for p in pliki:
        s, b = p["s"], int(p.get("b") or 0)
        if s.startswith("s/"):
            _, slug, mies = s.split("/")
            stacje.add(slug)
            grupy["emisje"][0] += 1; grupy["emisje"][1] += b
            lata[mies[:4]][0] += 1; lata[mies[:4]][1] += b
            if mies >= granica:
                ost12[0] += 1; ost12[1] += b
        elif s.startswith("w/"):
            grupy["widoki"][0] += 1; grupy["widoki"][1] += b
        else:
            grupy["metadane"][0] += 1; grupy["metadane"][1] += b
    podst = grupy["widoki"][1] + grupy["metadane"][1]
    return {"grupy": dict(grupy), "lata": dict(sorted(lata.items())), "stacji": len(stacje), "ost12": ost12,
            "podstawowa_b": podst, "z_ost12_b": podst + ost12[1], "wszystko_b": sum(v[1] for v in grupy.values())}


def mb(b: int) -> str:
    return f"{b / 1e6:,.1f} MB".replace(",", " ")


def main() -> int:
    mag = MagazynDysk()
    try:
        pliki = mag.lista_partiami("eksportPlikow", lista=True)
    except RuntimeError as e:
        print(f"Odbiornik nie podał listy plików ({e}) – nie da się zmierzyć.", flush=True)
        return 1
    w = podsumuj(pliki)
    print("Rozmiar danych w Odbiorniku (pliki skompresowane gzip, tak jak na Dysku):")
    for nazwa, opis in (("widoki", "widoki dla panelu (rankingi, tygodnie, wyszukiwarka…)"), ("metadane", "lekkie metadane utworów"), ("emisje", f"surowe emisje, {w['stacji']} stacji")):
        n, b = w["grupy"].get(nazwa, [0, 0])
        print(f"  {opis}: {n} plików, {mb(b)}")
    print("Surowe emisje rok po roku:")
    for r, (n, b) in w["lata"].items():
        print(f"  {r}: {n} plików, {mb(b)}")
    print(f"Paczka podstawowa (widoki + metadane): {mb(w['podstawowa_b'])}")
    print(f"+ emisje z ostatnich 12 miesięcy ({w['ost12'][0]} plików): {mb(w['z_ost12_b'])}")
    print(f"Wszystko: {mb(w['wszystko_b'])}")
    r = mag.wyslij("eksportPlikow", rozmiary=True).get("rozmiary")
    if r:
        f = r["foldery"]
        print("Podsumowania (_agg) – wszystkie pliki, z których korzysta panel:")
        grupy = collections.defaultdict(lambda: [0, 0, 0])   # rodzaj → foldery, pliki, bajty
        for nazwa, (n, b) in f.items():
            rodzaj = "jednostki (stacje i sieci)" if nazwa.startswith("v2/") and nazwa.count("/") == 1 and not nazwa.startswith("v2/_") else nazwa if nazwa.startswith(("v2/_", "agg")) else "inne"
            if nazwa.startswith("v2/") and nazwa.count("/") >= 2:
                rodzaj = "podfoldery: " + nazwa.split("/", 2)[1] if nazwa.split("/")[1].startswith("_") else "podfoldery jednostek"
            g = grupy[rodzaj]; g[0] += 1; g[1] += n; g[2] += b
        for rodzaj, (fo, n, b) in sorted(grupy.items(), key=lambda x: -x[1][2]):
            print(f"  {rodzaj}: {n} plików{f' w {fo} folderach' if fo > 1 else ''}, {mb(b)}")
        print(f"Podsumowania razem: {sum(v[0] for v in f.values())} plików, {mb(sum(v[1] for v in f.values()))}"
              + (" – PRZERWANO po " + str(r["sekund"]) + " s, wynik niepełny" if r.get("przerwano") else f" (liczone {r['sekund']} s)"))
    else:
        print("Odbiornik bez trybu rozmiarów podsumowań – wklej nowy OdbiornikEksport.gs, żeby zmierzyć wszystko.")
    try:
        drzewo = mag.lista_partiami("eksportPlikow", drzewo=True)
        print(f"Paczka danych aplikacji offline (PWA): {len(drzewo)} plików, {mb(sum(p['b'] for p in drzewo))}")
        najw = sorted(drzewo, key=lambda p: -p["b"])[:5]
        print("  największe pliki: " + ", ".join(f"{p['s'][2:]} ({mb(p['b'])})" for p in najw))
    except RuntimeError as e:
        print(f"Tryb drzewa niedostępny ({e}).")
    print("Uwaga: to rozmiary skompresowane; w aplikacji (np. jako Parquet) wielkość będzie inna – zmierzę przy budowie.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

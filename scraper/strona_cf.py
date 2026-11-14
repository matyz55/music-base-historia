"""X1–X3 (plan rozwoju, 14.11.2026): strona statyczna Music Base na Cloudflare Pages, chroniona Cloudflare Access.

  X1 – rankingi (7/30/90/365 dni, rok, cała historia; wszystkie / polskie / zagraniczne) i notowanie tygodniowe
       z gotowych plików Odbiornika (bez Apps Script przy oglądaniu: strona otwiera się od razu, także na telefonie);
  X2 – surowe emisje w plikach Parquet (stacja × rok), budowane w GitHub Actions biblioteką DuckDB;
  X3 – zapytania SQL w przeglądarce (DuckDB-Wasm) na tych plikach – bez serwera i bez R2.

Pliki Parquet leżą na tej samej stronie Pages (limit: 20 000 plików, 25 MiB na plik – dokumentacja Cloudflare Pages),
a nie w R2: R2 wymaga wykupienia subskrypcji i nalicza opłaty powyżej progu darmowego.

Bezpieczeństwo: dane trafiają na stronę dopiero, gdy adres projektu bez logowania NIE zwraca treści (Access włączony).
Inaczej publikowana jest tylko strona z prośbą o włączenie Access.

  python3 -m scraper.strona_cf --katalog data/cf --projekt music-base            (pobranie, budowa, publikacja)
  python3 -m scraper.strona_cf --katalog data/cf --bez-publikacji                (tylko budowa, np. do podglądu)
Sekrety (Actions): ODBIORNIK_URL, ODBIORNIK_TOKEN, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID.
"""
from __future__ import annotations

import argparse
import base64
import gzip
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

from . import normalize

WRANGLER = "wrangler@4.156.0"          # wydana 29.10.2026
MAX_PACZKA = 20_000_000                # bajtów na jedno wywołanie Odbiornika (limit akcji: 25 MB)
PARQUET_MAX = 24 * 1024 * 1024         # Pages: 25 MiB na plik


def _gz_json(b: bytes):
    try:
        return gzip.decompress(b)
    except OSError:   # atrapa Dysku w testach zapisuje treść jako base64
        return gzip.decompress(base64.b64decode(b))


def synchronizuj(mag, katalog: str) -> dict:
    """Pliki z Odbiornika do katalog/pliki (tylko zmienione od poprzedniego razu – manifest). Zwraca listę zmienionych."""
    os.makedirs(os.path.join(katalog, "pliki"), exist_ok=True)
    sc_man = os.path.join(katalog, "manifest.json")
    man = json.load(open(sc_man)) if os.path.exists(sc_man) else {}
    lista = mag.wyslij("eksportPlikow", lista=True)["pliki"]
    zmienione = [p for p in lista if man.get(p["s"]) != p["t"] or not os.path.exists(_lok(katalog, p["s"]))]
    print(f"Plików w Odbiorniku: {len(lista)}, do pobrania: {len(zmienione)} ({sum(p['b'] for p in zmienione) / 1e6:.1f} MB)", flush=True)
    i = 0
    while i < len(zmienione):
        paczka, b = [], 0
        while i < len(zmienione) and (not paczka or b + zmienione[i]["b"] <= MAX_PACZKA):
            paczka.append(zmienione[i]); b += zmienione[i]["b"]; i += 1
        odp = mag.wyslij("eksportPlikow", sciezki=[p["s"] for p in paczka])
        for p in paczka:
            d = odp["dane"].get(p["s"])
            if d is None:
                if p["s"] in odp.get("pominiete", []):
                    i = zmienione.index(p); break   # nie zmieściło się – następne wywołanie od tego pliku
                continue
            sc = _lok(katalog, p["s"])
            os.makedirs(os.path.dirname(sc), exist_ok=True)
            with open(sc, "wb") as f:
                f.write(base64.b64decode(d))
            man[p["s"]] = p["t"]
        json.dump(man, open(sc_man, "w"))
    return {p["s"] for p in zmienione}


def _lok(katalog: str, s: str) -> str:
    return os.path.join(katalog, "pliki", *s.split("/"))


def zbuduj_parquet(katalog: str, wyjscie: str, zmienione: set | None) -> list[dict]:
    """Stacja × rok → parquet/<stacja>_<rok>.parquet (kolumny: stacja, d, g, a, t, k, zr). Przebudowa tylko zmienionych lat."""
    import duckdb
    baza = os.path.join(katalog, "pliki", "s")
    cache = os.path.join(katalog, "parquet")
    os.makedirs(cache, exist_ok=True)
    pliki = []
    for slug in sorted(os.listdir(baza)) if os.path.isdir(baza) else []:
        lata: dict[str, list[str]] = {}
        for m in sorted(os.listdir(os.path.join(baza, slug))):
            lata.setdefault(m[:4], []).append(m)
        for rok, mies in lata.items():
            nazwa = f"{slug}_{rok}.parquet"
            sc = os.path.join(cache, nazwa)
            if zmienione is None or any(f"s/{slug}/{m}" in zmienione for m in mies) or not os.path.exists(sc):
                tmp = os.path.join(katalog, "tmp.jsonl")
                n = 0
                with open(tmp, "w", encoding="utf-8") as out:
                    for m in mies:
                        for linia in _gz_json(open(os.path.join(baza, slug, m), "rb").read()).decode("utf-8").splitlines():
                            if not linia.strip():
                                continue
                            w = json.loads(linia)
                            out.write(json.dumps({"stacja": slug, "d": w.get("d"), "g": w.get("g"), "a": w.get("a"), "t": w.get("t"),
                                                  "k": normalize.klucz(w.get("a") or "", w.get("t") or ""), "zr": w.get("zr")}, ensure_ascii=False) + "\n")
                            n += 1
                if n:
                    duckdb.sql(f"""COPY (SELECT stacja, CAST(d AS DATE) AS d, g, a, t, k, zr FROM read_json('{tmp}', format='newline_delimited',
                        columns={{'stacja':'VARCHAR','d':'VARCHAR','g':'VARCHAR','a':'VARCHAR','t':'VARCHAR','k':'VARCHAR','zr':'VARCHAR'}}) ORDER BY d, g)
                        TO '{sc}' (FORMAT parquet, COMPRESSION zstd)""")
                os.remove(tmp)
            if os.path.exists(sc):
                if os.path.getsize(sc) > PARQUET_MAX:
                    print(f"POMIJAM {nazwa}: {os.path.getsize(sc) / 1e6:.1f} MB > limit pliku Pages", flush=True)
                    continue
                os.makedirs(os.path.join(wyjscie, "parquet"), exist_ok=True)
                shutil.copy(sc, os.path.join(wyjscie, "parquet", nazwa))
                pliki.append({"plik": "parquet/" + nazwa, "stacja": slug, "rok": int(rok), "b": os.path.getsize(sc)})
    return pliki


def zbuduj_strone(katalog: str, wyjscie: str, zmienione: set | None) -> dict:
    if os.path.exists(wyjscie):
        shutil.rmtree(wyjscie)
    os.makedirs(os.path.join(wyjscie, "dane"))
    widoki = []
    wdir = os.path.join(katalog, "pliki", "w")
    for n in sorted(os.listdir(wdir)) if os.path.isdir(wdir) else []:
        if n.startswith(("ranking_", "tygodnie_")):
            cel = n.replace(".json.gz", ".json")
            with open(os.path.join(wyjscie, "dane", cel), "wb") as f:
                f.write(_gz_json(open(os.path.join(wdir, n), "rb").read()))
            widoki.append(cel)
    parquet = zbuduj_parquet(katalog, wyjscie, zmienione)
    spis = {"zbudowano": time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime()), "widoki": widoki, "parquet": parquet}
    json.dump(spis, open(os.path.join(wyjscie, "dane", "spis.json"), "w"), ensure_ascii=False)
    szablon = os.path.join(os.path.dirname(__file__), "szablon_cf")
    for n in os.listdir(szablon):
        shutil.copy(os.path.join(szablon, n), os.path.join(wyjscie, n))
    plikow = sum(len(f) for _, _, f in os.walk(wyjscie))
    print(f"Strona: {len(widoki)} widoków, {len(parquet)} plików Parquet ({sum(p['b'] for p in parquet) / 1e6:.1f} MB), razem plików {plikow} (limit Pages 20 000)", flush=True)
    return spis


def chroniona(projekt: str) -> bool:
    """True, gdy https://<projekt>.pages.dev bez logowania nie oddaje treści (przekierowanie do Access albo 401/403)."""
    url = f"https://{projekt}.pages.dev/"

    class BezPrzekierowan(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None
    try:
        odp = urllib.request.build_opener(BezPrzekierowan).open(urllib.request.Request(url, headers={"User-Agent": "MusicBase/1.0"}), timeout=30)
        return False if odp.status == 200 else True
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 303, 307, 308):
            return "cloudflareaccess.com" in (e.headers.get("Location") or "")
        return e.code in (401, 403)
    except Exception as e:  # projekt jeszcze nie istnieje (pierwsza publikacja) – brak danych na stronie
        print(f"Sprawdzenie ochrony: {e}", flush=True)
        return False


def publikuj(katalog_strony: str, projekt: str) -> None:
    # projekt Pages (Direct Upload) – przy pierwszej publikacji; gdy już istnieje, wrangler zgłasza błąd, który pomijamy
    subprocess.run(["npx", "--yes", WRANGLER, "pages", "project", "create", projekt, "--production-branch", "main"], check=False)
    subprocess.run(["npx", "--yes", WRANGLER, "pages", "deploy", katalog_strony, "--project-name", projekt, "--branch", "main", "--commit-dirty=true"], check=True)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--katalog", default="data/cf")
    ap.add_argument("--projekt", default="music-base")
    ap.add_argument("--bez-pobierania", action="store_true")
    ap.add_argument("--bez-publikacji", action="store_true")
    a = ap.parse_args(argv)
    zmienione = None
    if not a.bez_pobierania:
        from .magazyn import MagazynDysk
        zmienione = synchronizuj(MagazynDysk(), a.katalog)
    wyjscie = os.path.join(a.katalog, "strona")
    if a.bez_publikacji:
        zbuduj_strone(a.katalog, wyjscie, zmienione)
        return 0
    if not chroniona(a.projekt):
        print(f"UWAGA: https://{a.projekt}.pages.dev/ nie jest chroniona przez Cloudflare Access – publikuję tylko stronę z instrukcją, bez danych.", flush=True)
        zast = os.path.join(a.katalog, "zastepcza")
        os.makedirs(zast, exist_ok=True)
        shutil.copy(os.path.join(os.path.dirname(__file__), "szablon_cf", "zastepcza.html"), os.path.join(zast, "index.html"))
        publikuj(zast, a.projekt)
        print("ZOSTALA_PRACA", flush=True)
        return 0
    zbuduj_strone(a.katalog, wyjscie, zmienione)
    os.remove(os.path.join(wyjscie, "zastepcza.html"))
    publikuj(wyjscie, a.projekt)
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Podsumowanie zadania GitHub Actions do Odbiornika (O2): panel pokazuje je w „Stanie danych”, a strażnik
w Odbiorniku wysyła alert, gdy zadanie się nie udało albo długo nie raportowało.

Ostatni krok każdego workflow (if: always()):
  python3 -m scraper.raport_zadania --zadanie historia --status ${{ job.status }} --plik wynik.txt
Błąd wysyłki nie psuje zadania (zawsze kod 0).
"""
from __future__ import annotations

import argparse
import os
import sys

from .magazyn import MagazynDysk


def podsumuj(plik: str) -> dict:
    linie: list[str] = []
    try:
        with open(plik, encoding="utf-8", errors="replace") as f:
            linie = [l.rstrip() for l in f if l.strip()]
    except OSError:
        pass
    return {
        "bledow": sum(1 for l in linie if "BŁĄD" in l or "Traceback" in l or "Error" in l),
        "zostalo": any("ZOSTALA_PRACA" in l for l in linie),
        "ostatnie": [l[:300] for l in linie[-6:]],
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--zadanie", required=True)
    ap.add_argument("--status", default="success")
    ap.add_argument("--plik", default="wynik.txt")
    a = ap.parse_args(argv)
    if not os.environ.get("ODBIORNIK_URL") or not os.environ.get("ODBIORNIK_TOKEN"):
        return 0
    url = ""
    if os.environ.get("GITHUB_RUN_ID"):
        url = f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/{os.environ.get('GITHUB_REPOSITORY', '')}/actions/runs/{os.environ['GITHUB_RUN_ID']}"
    try:
        MagazynDysk().wyslij("dziennikZadania", zadanie=a.zadanie, status=a.status, url=url, **podsumuj(a.plik))
        print(f"Raport zadania {a.zadanie}: {a.status}", flush=True)
    except Exception as e:  # stary Odbiornik albo chwilowy błąd – zadanie się nie wywraca
        print(f"Raport zadania {a.zadanie} niewysłany: {e}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

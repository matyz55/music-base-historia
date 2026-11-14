"""K8 (plan rozwoju, 14.11.2026): identyfikatory nagrań MusicBrainz ze zrzutu kanonicznego, bez zapytań do API.

Zrzut „Canonical MusicBrainz data” (MetaBrainz, licencja CC0, aktualizowany ok. dwa razy w miesiącu):
https://data.metabrainz.org/pub/musicbrainz/canonical_data/ – archiwum .tar.zst (~2 GB) z plikiem
canonical/canonical_musicbrainz_data.csv (~7,7 GB) o kolumnach (sprawdzone 14.11.2026 na zrzucie 20261103):
  id, artist_credit_id, artist_mbids, artist_credit_name, release_mbid, release_name, recording_mbid,
  recording_name, combined_lookup, score
Plik czytany strumieniowo (nic nie trafia na dysk). Dopasowanie: ten sam klucz co w Music Base (normalize.klucz –
główny wykonawca + tytuł bez dopisków). Kilka nagrań o tym samym kluczu (remastery, wersje koncertowe) → najniższy
„score”: dokumentacja mówi tylko o „kolejności priorytetu”, a w danych wersja studyjna ma najniższy (np. Queen –
Bohemian Rhapsody z „A Night at the Opera”: 9 941, wersje koncertowe i remiksy: miliony).
Zrzut nie zawiera roku wydania – tylko identyfikatory (mb – nagranie, mbr – wydanie); ListenBrainz (I2) korzysta z mb.

  python3 -m scraper.musicbrainz_zrzut                     (najnowszy zrzut)
  python3 -m scraper.musicbrainz_zrzut --plik zrzut.tar.zst (plik lokalny, do testów)
"""
from __future__ import annotations

import argparse
import csv
import io
import re
import subprocess
import sys
import tarfile
import time
import urllib.request

from . import normalize
from .magazyn import MagazynDysk

KATALOG = "https://data.metabrainz.org/pub/musicbrainz/canonical_data/"
UA = "MusicBase/1.0 (prywatne archiwum playlist radiowych)"
PLIK_CSV = "canonical_musicbrainz_data.csv"


def najnowszy_zrzut() -> str:
    req = urllib.request.Request(KATALOG, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as odp:
        html = odp.read().decode("utf-8", "replace")
    nazwy = sorted(set(re.findall(r'href="(musicbrainz-canonical-dump-\d{8}-\d{6})/"', html)))
    if not nazwy:
        raise RuntimeError("nie znaleziono zrzutu w " + KATALOG)
    n = nazwy[-1]
    return f"{KATALOG}{n}/{n}.tar.zst"


def strumien_zst(zrodlo):
    """Rozpakowany strumień .zst: moduł zstandard, a bez niego program zstd."""
    try:
        import zstandard
        return zstandard.ZstdDecompressor().stream_reader(zrodlo, read_size=1 << 20), None
    except ImportError:
        p = subprocess.Popen(["zstd", "-dc"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)

        def pompa():
            while True:
                c = zrodlo.read(1 << 20)
                if not c:
                    break
                p.stdin.write(c)
            p.stdin.close()
        import threading
        threading.Thread(target=pompa, daemon=True).start()
        return p.stdout, p


class _Czytnik(io.RawIOBase):
    """Opakowanie pliku z tarfile w trybie strumieniowym (TextIOWrapper wymaga readable/seekable)."""
    def __init__(self, f):
        self.f = f

    def readable(self):
        return True

    def readinto(self, b):
        d = self.f.read(len(b))
        b[:len(d)] = d
        return len(d)


def wiersze_csv(zrodlo):
    """Wiersze canonical_musicbrainz_data.csv z archiwum .tar.zst (strumieniowo)."""
    s, proc = strumien_zst(zrodlo)
    with tarfile.open(fileobj=s, mode="r|") as tar:
        for czl in tar:
            if czl.isfile() and czl.name.endswith("/" + PLIK_CSV):
                tekst = io.TextIOWrapper(_Czytnik(tar.extractfile(czl)), encoding="utf-8", errors="replace", newline="")
                yield from csv.DictReader(tekst)
                return
    if proc:
        proc.wait()


def dopasuj(wiersze, szukane: dict[str, list[str]], koniec: float | None = None) -> tuple[dict, int]:
    """szukane: klucz znormalizowany → klucze Music Base. Zwraca (klucz MB → (score, recording, release), wierszy)."""
    wykonawcy = {k.split("|", 1)[0] for k in szukane}
    najlepsze: dict[str, tuple[int, str, str]] = {}
    ost_id, ost_wyk, n = None, None, 0
    for w in wiersze:
        n += 1
        if koniec and n % 1_000_000 == 0 and time.monotonic() > koniec:
            print(f"Limit czasu po {n} wierszach", flush=True)
            break
        aid = w.get("artist_credit_id")
        if aid != ost_id:   # wiersze są pogrupowane wg artist_credit_id – wykonawca liczony raz na grupę
            ost_id = aid
            g = normalize.wykonawcy(w.get("artist_credit_name") or "")
            ost_wyk = g[0] if g and g[0] in wykonawcy else None
        if not ost_wyk:
            continue
        kl = ost_wyk + "|" + normalize.tytul(w.get("recording_name") or "")
        if kl not in szukane:
            continue
        try:
            sc = int(w.get("score") or 0)
        except ValueError:
            sc = 1 << 62
        if kl not in najlepsze or sc < najlepsze[kl][0]:
            najlepsze[kl] = (sc, w.get("recording_mbid") or "", w.get("release_mbid") or "")
    return najlepsze, n


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--plik", help="lokalne archiwum .tar.zst zamiast pobierania")
    ap.add_argument("--max-minuty", type=float, default=300)
    ap.add_argument("--min-emisji", type=int, default=2)
    a = ap.parse_args(argv)
    koniec = time.monotonic() + a.max_minuty * 60
    mag = MagazynDysk()
    szukane: dict[str, list[str]] = {}
    pomin = 0
    while True:
        odp = mag.wyslij("kluczeBezMetadanych", tryb="mbid", limit=20000, pomin=pomin, min=a.min_emisji)
        if odp.get("tryb") != "mbid":
            print("Odbiornik bez trybu „mbid” – pomijam do aktualizacji OdbiornikAgregaty.gs", flush=True)
            return 0
        cz = odp.get("klucze") or []
        for x in cz:
            szukane.setdefault(normalize.klucz(x[1], x[2]), []).append(x[0])
        pomin += len(cz)
        if len(cz) < 20000:
            break
    print(f"Do sprawdzenia: {pomin} utworów bez identyfikatora MusicBrainz", flush=True)
    if not szukane:
        return 0
    if a.plik:
        zrodlo = open(a.plik, "rb")
    else:
        url = najnowszy_zrzut()
        print("Zrzut: " + url, flush=True)
        zrodlo = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=120)
    t0 = time.monotonic()
    with zrodlo:
        najlepsze, n = dopasuj(wiersze_csv(zrodlo), szukane, koniec)
    przerwano = time.monotonic() > koniec
    print(f"Przeczytano {n} wierszy w {round((time.monotonic() - t0) / 60, 1)} min; dopasowano {len(najlepsze)} z {len(szukane)}", flush=True)
    teraz = int(time.time() * 1000)
    wynik = {}
    for kl, klucze in szukane.items():
        x = najlepsze.get(kl)
        for k in klucze:
            if x:
                wynik[k] = {"mb": x[1], "mbr": x[2], "mbz": "zrzut"}
            elif not przerwano:   # niepełny przegląd nie oznacza braku – bez znacznika próby
                wynik[k] = {"mbk": teraz}
    pozycje = list(wynik.items())
    for i in range(0, len(pozycje), 2000):
        mag.wyslij("zapiszMetadane", metadane=dict(pozycje[i:i + 2000]))
    print(f"MusicBrainz (zrzut): zapisano {sum(1 for v in wynik.values() if 'mb' in v)} identyfikatorów", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

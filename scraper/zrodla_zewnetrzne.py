"""Zewnętrzne źródła o utworach (plan rozwoju I1–I4, 14.11.2026) – w GitHub Actions, wyniki do Odbiornika.

  deezer       – I1: tempo (BPM; tylko część utworów), popularność (rank), ISRC, data wydania, explicit.
                 api.deezer.com bez klucza; ok. 4 zapytania na sekundę (limit Deezera: 50 na 5 s).
  listenbrainz – I2: odsłuchania i słuchacze nagrania (MBID z MusicBrainz) – POST /1/popularity/recording, po 100.
  apple        – I3: Apple Music Top 100 Polska (RSS Apple Marketing Tools) – raz na dobę, historia w _agg/zewnetrzne.
  youtube      – I4: wyświetlenia teledysku (YouTube Data API v3, sekret YOUTUBE_API_KEY): wyszukiwanie najwyżej
                 90 nowych utworów na dobę (100 jednostek limitu każde), odświeżenie wyświetleń po 50 (1 jednostka).

  python3 -m scraper.zrodla_zewnetrzne --tryb deezer --max-minuty 300
  python3 -m scraper.zrodla_zewnetrzne --tryb dzienne     (apple + listenbrainz + youtube)
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

from . import normalize
from .magazyn import MagazynDysk

UA = "MusicBase/1.0 (prywatne archiwum playlist radiowych)"


def _get(url: str, dane: bytes | None = None, naglowki: dict | None = None, timeout: int = 25):
    req = urllib.request.Request(url, data=dane, headers={"User-Agent": UA, **(naglowki or {})})
    with urllib.request.urlopen(req, timeout=timeout) as odp:
        return json.load(odp)


def _klucze(mag: MagazynDysk, tryb: str, limit: int, **dodatkowe) -> list | None:
    odp = mag.wyslij("kluczeBezMetadanych", limit=limit, tryb=tryb, **dodatkowe)
    if odp.get("tryb") != tryb:
        print(f"Odbiornik bez trybu „{tryb}” – pomijam do aktualizacji OdbiornikAgregaty.gs", flush=True)
        return None
    return odp["klucze"]


def teraz_ms() -> int:
    return int(time.time() * 1000)


# ---------------- I1: Deezer ----------------

def dopasuj_deezer(a: str, t: str, wyniki: list[dict]) -> dict | None:
    """Pierwszy wynik z tym samym kluczem utworu (wykonawca główny + tytuł bez dopisków), jak klucz w bazie."""
    k = normalize.klucz(a, t)
    for x in wyniki:
        if normalize.klucz(x.get("artist", {}).get("name", ""), x.get("title", "")) == k:
            return x
    wk, tk = k.split("|")
    for x in wyniki:   # wykonawca się zgadza, tytuł zaczyna się tak samo (np. „Tytuł (Radio Edit)” w bazie)
        if normalize.klucz(x.get("artist", {}).get("name", ""), "x").split("|")[0] == wk and normalize.tytul(x.get("title_short") or x.get("title", "")) == tk:
            return x
    return None


def deezer_pass(mag: MagazynDysk, koniec: float, limit: int = 2000) -> int:
    braki = _klucze(mag, "deezer", limit)
    if braki is None:
        return 0
    print(f"Bez danych z Deezera: {len(braki)}", flush=True)
    wynik, ost, licz = {}, 0.0, {"dopasowane": 0, "brak": 0, "bpm": 0}
    for k, a, t, _n, *_ in braki:
        if time.monotonic() > koniec:
            break
        try:
            glowny = re.split(r"\s*(?:/|&|,| feat\.? | ft\.? | x )\s*", a, flags=re.I)[0]
            tyt = re.sub(r"\s*[(\[].*?[)\]]", "", t).strip()
            czekaj = ost + 0.25 - time.monotonic()
            if czekaj > 0:
                time.sleep(czekaj)
            ost = time.monotonic()
            s = _get("https://api.deezer.com/search?" + urllib.parse.urlencode({"q": f"{glowny} {tyt}", "limit": 10}))
            if s.get("error"):
                raise RuntimeError(str(s["error"]))
            x = dopasuj_deezer(a, t, s.get("data") or [])
            if not x:
                wynik[k] = {"dzp": teraz_ms()}
                licz["brak"] += 1
            else:
                time.sleep(0.25)
                d = _get(f"https://api.deezer.com/track/{x['id']}")
                w = {"dz": x["id"], "dzr": d.get("rank") or x.get("rank") or 0, "ex": 1 if d.get("explicit_lyrics") else 0}
                if d.get("bpm") and float(d["bpm"]) > 0:
                    w["bpm"] = round(float(d["bpm"]), 1)
                    licz["bpm"] += 1
                if d.get("isrc"):
                    w["dzi"] = d["isrc"]
                if d.get("release_date") and d["release_date"] != "0000-00-00":
                    w["dzd"] = d["release_date"]
                wynik[k] = w
                licz["dopasowane"] += 1
        except Exception as e:  # sieć / limit – następnym razem
            print(f"Deezer {k}: {e}", flush=True)
            time.sleep(5)
            continue
        if len(wynik) >= 100:
            mag.wyslij("zapiszMetadane", metadane=dict(wynik))
            wynik.clear()
    if wynik:
        mag.wyslij("zapiszMetadane", metadane=wynik)
    print(f"Deezer: {licz}", flush=True)
    return len(braki)


# ---------------- I2: ListenBrainz ----------------

def listenbrainz_pass(mag: MagazynDysk, koniec: float, limit: int = 5000) -> int:
    braki = _klucze(mag, "listenbrainz", limit)
    if not braki:
        return 0
    wynik = {}
    for i in range(0, len(braki), 100):
        if time.monotonic() > koniec:
            break
        cz = [x for x in braki[i:i + 100] if len(x) > 4 and x[4]]
        mbid = {x[4]: x[0] for x in cz}
        try:
            d = _get("https://api.listenbrainz.org/1/popularity/recording", json.dumps({"recording_mbids": list(mbid)}).encode(), {"Content-Type": "application/json"})
        except Exception as e:
            print(f"ListenBrainz: {e}", flush=True)
            time.sleep(10)
            continue
        for r in d or []:
            k = mbid.get(r.get("recording_mbid"))
            if k:
                wynik[k] = {"lbc": r.get("total_listen_count") or 0, "lbu": r.get("total_user_count") or 0, "lbt": teraz_ms()}
        time.sleep(1)
    for i in range(0, len(wynik), 500):
        mag.wyslij("zapiszMetadane", metadane=dict(list(wynik.items())[i:i + 500]))
    print(f"ListenBrainz: {len(wynik)} nagrań", flush=True)
    return len(braki)


# ---------------- I3: Apple Music Top Polska ----------------

def apple_top(mag: MagazynDysk) -> int:
    for proba in range(3):   # serwis bywa wolny (14.11.2026: przekroczony czas odpowiedzi)
        try:
            d = _get("https://rss.marketingtools.apple.com/api/v2/pl/music/most-played/100/songs.json", timeout=60)
            break
        except Exception as e:
            if proba == 2:
                raise
            print(f"Apple Music: {e} – ponawiam", flush=True)
            time.sleep(15 * (proba + 1))
    pozycje = [{"poz": i + 1, "a": r.get("artistName", ""), "t": r.get("name", ""), "id": r.get("id"), "url": r.get("url"), "wyd": r.get("releaseDate")}
               for i, r in enumerate(d.get("feed", {}).get("results", []))]
    for p in pozycje:
        p["k"] = normalize.klucz(p["a"], p["t"])
    mag.wyslij("zapiszZewnetrzne", zrodlo="apple_top_pl", data=dt.date.today().isoformat(), pozycje=pozycje)
    print(f"Apple Music Top Polska: {len(pozycje)} pozycji", flush=True)
    return len(pozycje)


# ---------------- I4: YouTube ----------------

def youtube_pass(mag: MagazynDysk, koniec: float, wyszukan: int = 90) -> int:
    klucz = os.environ.get("YOUTUBE_API_KEY")
    if not klucz:
        print("YouTube: brak sekretu YOUTUBE_API_KEY – pomijam", flush=True)
        return 0
    api = "https://www.googleapis.com/youtube/v3/"
    # 1) odświeżenie wyświetleń znanych teledysków (1 jednostka na 50 filmów)
    znane = _klucze(mag, "youtube_odswiez", 2000) or []
    wynik = {}
    for i in range(0, len(znane), 50):
        cz = {x[4]: x[0] for x in znane[i:i + 50] if len(x) > 4 and x[4]}
        if not cz:
            continue
        try:
            d = _get(api + "videos?" + urllib.parse.urlencode({"part": "statistics", "id": ",".join(cz), "key": klucz}))
        except Exception as e:
            print(f"YouTube (statystyki): {e}", flush=True)
            break
        for v in d.get("items", []):
            wynik[cz[v["id"]]] = {"ytv": int(v.get("statistics", {}).get("viewCount", 0)), "ytt": teraz_ms()}
    # 2) wyszukanie teledysków najczęściej granych utworów bez filmu (100 jednostek na wyszukanie)
    nowe = _klucze(mag, "youtube", wyszukan) or []
    for k, a, t, _n, *_ in nowe:
        if time.monotonic() > koniec:
            break
        try:
            s = _get(api + "search?" + urllib.parse.urlencode({"part": "id", "type": "video", "maxResults": 1, "q": f"{a} {t}", "key": klucz}))
            vid = (s.get("items") or [{}])[0].get("id", {}).get("videoId")
            if not vid:
                wynik[k] = {"ytp": teraz_ms()}
                continue
            v = _get(api + "videos?" + urllib.parse.urlencode({"part": "statistics,snippet", "id": vid, "key": klucz}))
            it = (v.get("items") or [{}])[0]
            wynik[k] = {"yt": vid, "ytv": int(it.get("statistics", {}).get("viewCount", 0)), "ytt": teraz_ms(), "ytk": it.get("snippet", {}).get("channelTitle", "")[:80]}
        except Exception as e:
            print(f"YouTube {k}: {e}", flush=True)
            break   # najczęściej wyczerpany dzienny limit
    for i in range(0, len(wynik), 500):
        mag.wyslij("zapiszMetadane", metadane=dict(list(wynik.items())[i:i + 500]))
    print(f"YouTube: {len(wynik)} utworów", flush=True)
    return len(nowe)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tryb", choices=["deezer", "listenbrainz", "apple", "youtube", "dzienne"], required=True)
    ap.add_argument("--max-minuty", type=float, default=60)
    a = ap.parse_args(argv)
    koniec = time.monotonic() + a.max_minuty * 60
    mag = MagazynDysk()
    zostalo = False
    if a.tryb == "deezer":
        while time.monotonic() < koniec - 60:
            n = deezer_pass(mag, koniec)
            if not n:
                break
        else:
            zostalo = True
    # każde źródło ma własny limit czasu (14.11.2026: wspólny limit zużył ListenBrainz i YouTube nie wykonał żadnego wyszukiwania);
    # YouTube przed ListenBrainz – ma dzienny limit zapytań, więc robi mało, ale codziennie
    for tryb, f in (("apple", lambda k: apple_top(mag)), ("youtube", lambda k: youtube_pass(mag, k)), ("listenbrainz", lambda k: listenbrainz_pass(mag, k))):
        if a.tryb in (tryb, "dzienne"):
            try:
                f(time.monotonic() + a.max_minuty * 60)
            except Exception as e:  # jedno źródło nie zatrzymuje pozostałych
                print(f"BŁĄD {tryb}: {e}", flush=True)
    if zostalo:
        print("ZOSTALA_PRACA", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

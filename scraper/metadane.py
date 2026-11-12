"""Metadane utworów: rok/data wydania, polski/zagraniczny, kraj, gatunki, identyfikator Spotify.

Źródła (w tej kolejności):
1. Songster (github.com/matyz55/songster) – rok pierwszego wydania sprawdzony procesem gry (VERIFICATION.md),
   kraj wykonawcy, gatunki, identyfikator Spotify; dopasowanie po ujednoliconym wykonawcy i tytule,
2. MusicBrainz – najwcześniejsza „first-release-date” nagrań tego wykonawcy o tym tytule (wynik ≥ 90)
   i kraj wykonawcy; najwyżej 1 zapytanie na sekundę (zasada MusicBrainz).
Utwory bez wyniku są oznaczane próbą i sprawdzane ponownie najwcześniej po 30 dniach.
3. Język tekstu (j: pl / en / inny / instr) z tekstu w lrclib.net – do kwoty polskiej i profilu utworu;
   najwyżej 1 zapytanie na sekundę, utwory bez tekstu oznaczane próbą (jp).

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
from .disco_polo import gatunki_pass
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
                najlepsze = (data, kredyty[0]["artist"]["id"], r.get("length"))
        if not najlepsze:
            return None
        kraj = self.kraj(najlepsze[1])
        wynik = {"y": int(najlepsze[0][:4]), "d": najlepsze[0], "z": "MusicBrainz"}
        # długość nagrania (ms w MusicBrainz) → sekundy; panel liczy z niej minuty muzyki i kwotę wg czasu (A7, A8)
        if isinstance(najlepsze[2], int) and 30_000 <= najlepsze[2] <= 1_200_000:
            wynik["l"] = round(najlepsze[2] / 1000)
        if kraj:
            wynik.update({"cc": kraj, "c": "PL" if kraj == "PL" else "INT"})
        return wynik


PL_SLOWA = set("w się nie że to jak ja ty mnie cię jest być tak już czy co ale bo gdy kiedy jeszcze tylko my nas nam wy was tam ten mój moja twój twoja jestem będzie był była chcę".split())
EN_SLOWA = set("the you and me my to is it in that of on your for love be all we don't i'm can just know so oh baby what when like now never".split())
# Inne języki: słowa funkcyjne, które pokrywają się z polskimi krótkimi słowami („a”, „i”, „na”, „te”, „mi”) –
# bez nich włoski albo hiszpański tekst bywał liczony jako polski (test na lrclib.net 11.11.2026: 3 z 22 błędnie).
INNE_SLOWA = {
    "es": set("el la los las que de y en un una por con para mi tu te yo es no lo le se del al como más pero quiero amor corazón".split()),
    "it": set("il la che di e un una non per con mi ti io sei è sono come ma più amore della nel cosa siamo".split()),
    "fr": set("le la les et je tu il de un une pas que qui est dans pour avec mon ma moi toi c'est on ne plus".split()),
    "de": set("der die das und ich du nicht ist ein eine mit zu dich mich mein dein auf wir es so was wie".split()),
    "pt": set("o a os as que de e um uma não eu você meu minha com para por do da mais te".split()),
}
LITERY_PL = set("ąćęłńśźż")
LITERY_INNE = set("àâäçèéêëîïìíòôöùûüúñßãõ")


def jezyk_tekstu(tekst: str) -> str:
    """Ocena języka tekstu: słowa funkcyjne + litery charakterystyczne. Zwraca pl, en, inny albo "" (za krótki)."""
    slowa = re.findall(r"[^\W\d_]+(?:'[^\W\d_]+)?", tekst.lower())
    if len(slowa) < 15:
        return ""
    wyniki = {
        "pl": sum(w in PL_SLOWA for w in slowa) + 3 * sum(any(c in LITERY_PL for c in w) for w in slowa),
        "en": sum(w in EN_SLOWA for w in slowa),
    }
    for jez, zbior in INNE_SLOWA.items():
        wyniki[jez] = sum(w in zbior for w in slowa) + 3 * sum(any(c in LITERY_INNE for c in w) for w in slowa)
    kolejnosc = sorted(wyniki.items(), key=lambda x: -x[1])
    (najl, w1), (_, w2) = kolejnosc[0], kolejnosc[1]
    if najl in ("pl", "en") and w1 >= 8 and w1 > w2 * 1.2:
        return najl
    return "inny"


def jezyki(mag: MagazynDysk, koniec: float) -> None:
    braki = mag.wyslij("kluczeBezMetadanych", limit=3000, tryb="jezyk")["klucze"]
    print(f"Bez języka tekstu: {len(braki)}")
    wynik, ostatnie, liczniki = {}, 0.0, {}
    for k, a, t, _n in braki:
        if time.monotonic() > koniec:
            break
        czekaj = ostatnie + 1.0 - time.monotonic()
        if czekaj > 0:
            time.sleep(czekaj)
        ostatnie = time.monotonic()
        glowny = re.split(r"\s*(?:/|&|,| feat\.? | ft\.? | x )\s*", a, flags=re.I)[0]
        tyt = re.sub(r"\s*[(\[].*?[)\]]", "", t).strip()
        url = "https://lrclib.net/api/get?" + urllib.parse.urlencode({"artist_name": glowny, "track_name": tyt})
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=20) as odp:
                d = json.load(odp)
        except urllib.error.HTTPError as e:
            d = {} if e.code == 404 else None
        except Exception:
            d = None
        if d is None:
            continue  # błąd sieci – następnym razem
        j = "instr" if d.get("instrumental") else jezyk_tekstu(d.get("plainLyrics") or "")
        wynik[k] = {"j": j} if j else {"jp": int(time.time() * 1000)}
        liczniki[j or "brak"] = liczniki.get(j or "brak", 0) + 1
        if len(wynik) >= 100:
            mag.wyslij("zapiszMetadane", metadane=dict(wynik))
            wynik.clear()
    if wynik:
        mag.wyslij("zapiszMetadane", metadane=wynik)
    print(f"Język tekstu: {liczniki}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--max-minuty", type=float, default=10)
    ap.add_argument("--limit", type=int, default=5000, help="ile utworów bez metadanych pobrać z Odbiornika")
    ap.add_argument("--jezyk-minuty", type=float, default=None, help="ile minut na ustalanie języka tekstu (domyślnie 1/3 czasu)")
    ap.add_argument("--gatunek-minuty", type=float, default=None, help="ile minut na sprawdzanie disco polo (domyślnie 1/3 czasu)")
    a = ap.parse_args(argv)
    jez_min = a.max_minuty / 3 if a.jezyk_minuty is None else a.jezyk_minuty
    gat_min = a.max_minuty / 3 if a.gatunek_minuty is None else a.gatunek_minuty
    koniec = time.monotonic() + (a.max_minuty - jez_min - gat_min) * 60
    try:
        return _metadane(a, jez_min, koniec)
    finally:
        if gat_min > 0:
            gatunki_pass(MagazynDysk(), time.monotonic() + gat_min * 60)


def _metadane(a, jez_min: float, koniec: float) -> int:
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
        if jez_min > 0:
            jezyki(mag, time.monotonic() + jez_min * 60)
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
    if jez_min > 0:
        jezyki(mag, time.monotonic() + jez_min * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())

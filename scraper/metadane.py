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

from .wulgaryzmy import poziom as poziom_wulgaryzmow
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

    def nagranie(self, a: str, t: str) -> dict | None:
        """Najlepiej dopasowane nagranie z wyszukiwarki (wynik ≥ 90, ten sam tytuł, wykonawca w kredytach, najwcześniejsze)."""
        glowny = re.split(r"\s*(?:/|&|,| feat\.? | ft\.? | x )\s*", a, flags=re.I)[0]
        tyt = re.sub(r"\s*[(\[].*?[)\]]", "", t).strip()
        d = self._get("/recording?fmt=json&limit=25&query=" + urllib.parse.quote(f'recording:"{tyt}" AND artist:"{glowny}"'))
        wk, tk, naj = set(wykonawcy(a)), tytul(t), None
        for r in d.get("recordings", []):
            if r.get("score", 0) < 90 or tytul(r.get("title", "")) != tk:
                continue
            if not any(wykonawca(k.get("name", "")) in wk for k in (r.get("artist-credit") or []) if isinstance(k, dict)):
                continue
            if naj is None or (r.get("first-release-date") or "9999") < (naj.get("first-release-date") or "9999"):
                naj = r
        return naj

    def szczegoly(self, a: str, t: str) -> dict:
        """Kompozytor, autor słów, producent, ISRC/ISWC, pierwsze wydawnictwo z wytwórnią – pola do metadanych
        (kp, as, au, ar, pr, isrc, iswc, wy, mb) i znacznik sz (sprawdzone). Do 4 zapytań."""
        wynik: dict = {"sz": int(time.time() * 1000)}
        r0 = self.nagranie(a, t)
        if not r0:
            return wynik
        r = self._get(f"/recording/{r0['id']}?fmt=json&inc=isrcs+releases+release-groups+work-rels+artist-rels") or {}
        rola = lambda rel, typy: sorted({x["artist"]["name"] for x in rel or [] if x.get("artist") and x.get("type") in typy})
        wynik.update({"mb": r0["id"], "pr": rola(r.get("relations"), {"producer", "co-producer"}), "isrc": (r.get("isrcs") or [])[:3]})
        wyd = sorted([x for x in r.get("releases") or [] if x.get("date")], key=lambda x: x["date"])
        pierwsze = next((x for x in wyd if x.get("status") == "Official"), wyd[0] if wyd else None)
        if pierwsze:
            rel = self._get(f"/release/{pierwsze['id']}?fmt=json&inc=labels") or {}
            wynik["wy"] = {"t": pierwsze.get("title"), "d": pierwsze.get("date"), "k": pierwsze.get("country"),
                           "typ": (pierwsze.get("release-group") or {}).get("primary-type"), "id": pierwsze["id"],
                           "lab": [x["label"]["name"] for x in rel.get("label-info") or [] if x.get("label")][:3]}
        praca = next((x["work"] for x in r.get("relations") or [] if x.get("work")), None)
        if praca:
            w = self._get(f"/work/{praca['id']}?fmt=json&inc=artist-rels") or {}
            rel = w.get("relations")
            wynik.update({"kp": rola(rel, {"composer"}), "as": rola(rel, {"lyricist"}), "au": rola(rel, {"writer"}),
                          "ar": rola(rel, {"arranger"}), "iswc": (w.get("iswcs") or [])[:2]})
        return {k: v for k, v in wynik.items() if v not in ([], None, "")}

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


def jezyki(mag: MagazynDysk, koniec: float, limit: int = 3000, tryb: str = "jezyk") -> int:
    """Język tekstu i wulgaryzmy (pole w: 2/1/0, scraper/wulgaryzmy.py) z lrclib.net (1 zapytanie/s).
    tryb „wulg”: utwory z językiem, ale jeszcze bez oceny wulgaryzmów (sprawdzone przed 12.11.2026).
    Zwraca liczbę utworów w tej porcji (0 = nic do zrobienia)."""
    odp = mag.wyslij("kluczeBezMetadanych", limit=limit, tryb=tryb)
    if tryb != "jezyk" and odp.get("tryb") != tryb:   # starszy Odbiornik nie zna trybu (zwróciłby inne utwory)
        print(f"Odbiornik bez trybu „{tryb}” – pomijam do aktualizacji OdbiornikAgregaty.gs")
        return 0
    braki = odp["klucze"]
    print(f"Bez {'języka tekstu' if tryb == 'jezyk' else 'oceny wulgaryzmów'}: {len(braki)}")
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
        tekst = d.get("plainLyrics") or ""
        j = "instr" if d.get("instrumental") else jezyk_tekstu(tekst)
        wynik[k] = {"j": j, "w": 0 if j == "instr" else poziom_wulgaryzmow(tekst)} if j else {"jp": int(time.time() * 1000)}
        liczniki[j or "brak"] = liczniki.get(j or "brak", 0) + 1
        if len(wynik) >= 100:
            mag.wyslij("zapiszMetadane", metadane=dict(wynik))
            wynik.clear()
    if wynik:
        mag.wyslij("zapiszMetadane", metadane=wynik)
    print(f"Język tekstu: {liczniki}", flush=True)
    return len(braki)


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
        _metadane(a, jez_min, koniec)
        return 0
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
    print(f"Bez metadanych: {len(braki)} (najczęściej grane najpierw)", flush=True)
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
    print(f"Songster: {z_songstera}, MusicBrainz: {z_mb}, bez wyniku: {bez}, niesprawdzone (limit czasu): {len(reszta) - z_mb - bez}", flush=True)
    if jez_min > 0:
        jezyki(mag, time.monotonic() + jez_min * 60)
    return len(braki)


if __name__ == "__main__":
    sys.exit(main())


class Discogs:
    """Twórcy z Discogs (api.discogs.com; token osobisty w zmiennej DISCOGS_TOKEN – sekret GitHuba, nigdy w kodzie).
    Wyszukiwarka /database/search (type=release, artist, track), potem /releases/{id}: role z extraartists
    utworu i wydawnictwa (pole tracks ogranicza rolę do wskazanych pozycji). Limit z tokenem: 60 zapytań/min → odstęp 1,1 s.
    Format jak w bibliotece joalla/discogs_client (token jako parametr zapytania)."""
    API = "https://api.discogs.com"
    ROLE = {"kp": ("music by", "composed by", "composer"), "as": ("lyrics by", "words by", "text by", "lyricist"),
            "au": ("written-by", "written by", "songwriter"), "ar": ("arranged by",), "pr": ("producer",)}

    def __init__(self, token: str | None):
        self.token = token
        self._ostatnie = 0.0

    def _get(self, sciezka: str, **par) -> dict:
        czekaj = self._ostatnie + 1.1 - time.monotonic()
        if czekaj > 0:
            time.sleep(czekaj)
        self._ostatnie = time.monotonic()
        url = self.API + sciezka + "?" + urllib.parse.urlencode({**par, "token": self.token})
        for proba in range(3):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=30) as odp:
                    return json.load(odp)
            except urllib.error.HTTPError as e:   # komunikat bez adresu – token nie trafia do dziennika
                if e.code in (429, 503):
                    time.sleep(20 * (proba + 1))
                    continue
                raise RuntimeError(f"Discogs HTTP {e.code}") from None
        return {}

    @staticmethod
    def _nazwa(x: dict) -> str:
        return re.sub(r"\s*\(\d+\)$", "", x.get("name") or "").strip()   # „Jan Kowalski (2)” – numer rozróżniający w Discogs

    def _role(self, rola: str) -> list[str]:
        """„Music By, Lyrics By [Polish]” → ["kp", "as"] (jedna osoba może mieć kilka ról po przecinku)."""
        wynik = []
        for r in re.sub(r"\s*\[.*?\]", "", rola or "").lower().split(","):
            r = r.strip()
            for pole, wzorce in self.ROLE.items():
                if r in wzorce and pole not in wynik:
                    wynik.append(pole)
        return wynik

    def tworcy(self, a: str, t: str) -> dict:
        if not self.token:
            return {}
        glowny = re.split(r"\s*(?:/|&|,| feat\.? | ft\.? | x )\s*", a, flags=re.I)[0]
        tyt = re.sub(r"\s*[(\[].*?[)\]]", "", t).strip()
        wyn = self._get("/database/search", type="release", artist=glowny, track=tyt, per_page=8).get("results") or []
        wk, tk = set(wykonawcy(a)), tytul(t)
        for r in wyn[:5]:
            rel = self._get(f"/releases/{r['id']}")
            if not any(wykonawca(self._nazwa(x)) in wk for x in rel.get("artists") or []):
                continue
            utw = next((x for x in rel.get("tracklist") or [] if x.get("type_", "track") == "track" and tytul(x.get("title", "")) == tk), None)
            if not utw:
                continue
            poz = (utw.get("position") or "").strip()
            role = list(utw.get("extraartists") or [])
            for x in rel.get("extraartists") or []:
                tr = (x.get("tracks") or "").strip()
                if not tr or (poz and poz in [y.strip() for y in re.split(r",|\bto\b", tr)]):
                    role.append(x)
            w: dict = {}
            for x in role:
                for pole in self._role(x.get("role", "")):
                    if self._nazwa(x) not in w.setdefault(pole, []):
                        w[pole].append(self._nazwa(x))
            if w.get("kp") or w.get("as") or w.get("au"):
                w["dg"] = rel.get("id")
                w["dlab"] = [x.get("name") for x in rel.get("labels") or [] if x.get("name")][:2]
                return {k: v for k, v in w.items() if v}
        return {}


class Wikidata:
    """Twórcy z Wikidata (Action API: wbsearchentities + wbgetentities, nie WDQS): kompozytor P86, autor tekstu P676,
    producent P162, wytwórnia P264, data publikacji P577. Utwór musi być piosenką/singlem/utworem muzycznym (P31)
    z wykonawcą (P175) o tej samej nazwie co w playliście. Odstęp 1 s między zapytaniami."""
    API = "https://www.wikidata.org/w/api.php"
    TYPY = {"Q7366", "Q134556", "Q105543609", "Q2188189", "Q55850593"}   # piosenka, singel, utwór muzyczny, dzieło muzyczne, nagranie

    def __init__(self):
        self._ostatnie = 0.0

    def _get(self, **par) -> dict:
        czekaj = self._ostatnie + 1.0 - time.monotonic()
        if czekaj > 0:
            time.sleep(czekaj)
        self._ostatnie = time.monotonic()
        url = self.API + "?" + urllib.parse.urlencode({"format": "json", **par})
        for proba in range(3):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=30) as odp:
                    return json.load(odp)
            except urllib.error.HTTPError as e:
                if e.code in (429, 503):
                    time.sleep(10 * (proba + 1))
                    continue
                raise
        return {}

    @staticmethod
    def _wartosci(enc: dict, p: str) -> list:
        w = []
        for c in (enc.get("claims") or {}).get(p, []):
            v = ((c.get("mainsnak") or {}).get("datavalue") or {}).get("value")
            if isinstance(v, dict) and v.get("id"):
                w.append(v["id"])
            elif isinstance(v, dict) and v.get("time"):
                w.append(v["time"])
        return w

    def _etykiety(self, ids: list[str]) -> dict[str, str]:
        wynik = {}
        for i in range(0, len(ids), 50):
            d = self._get(action="wbgetentities", ids="|".join(ids[i:i + 50]), props="labels", languages="pl|en")
            for q, e in (d.get("entities") or {}).items():
                lab = e.get("labels") or {}
                wynik[q] = (lab.get("pl") or lab.get("en") or {}).get("value", q)
        return wynik

    def tworcy(self, a: str, t: str) -> dict:
        tyt = re.sub(r"\s*[(\[].*?[)\]]", "", t).strip()
        ids = []
        for jez in ("pl", "en"):
            d = self._get(action="wbsearchentities", search=tyt, language=jez, type="item", limit=10)
            ids += [x["id"] for x in d.get("search") or [] if x["id"] not in ids]
        if not ids:
            return {}
        enc = (self._get(action="wbgetentities", ids="|".join(ids[:20]), props="claims|labels", languages="pl|en").get("entities") or {})
        kand = {q: e for q, e in enc.items() if self.TYPY & set(self._wartosci(e, "P31")) and tytul(((e.get("labels") or {}).get("pl") or (e.get("labels") or {}).get("en") or {}).get("value", "")) == tytul(t)}
        if not kand:
            return {}
        wyk = {q for e in kand.values() for q in self._wartosci(e, "P175")}
        nazwy = self._etykiety(sorted(wyk)) if wyk else {}
        wk = set(wykonawcy(a))
        for q, e in kand.items():
            if not any(wykonawca(nazwy.get(x, "")) in wk for x in self._wartosci(e, "P175")):
                continue
            pola = {"kp": "P86", "as": "P676", "pr": "P162", "lab": "P264"}
            qid = {k: self._wartosci(e, p) for k, p in pola.items()}
            et = self._etykiety(sorted({x for v in qid.values() for x in v}))
            w = {k: [et.get(x, x) for x in v] for k, v in qid.items() if v}
            data = self._wartosci(e, "P577")
            if data:
                w["wdd"] = data[0].lstrip("+")[:10]
            w["wd"] = q
            return w
        return {}


def szczegoly_pass(mag: MagazynDysk, koniec: float, limit: int = 2000, min_emisji: int = 20) -> int:
    """Szczegóły z MusicBrainz (kompozytor, autor słów, wydanie) dla utworów z ≥ min_emisji, najczęściej grane najpierw."""
    import os
    wersja = 2 if os.environ.get("DISCOGS_TOKEN") else 1   # v2: z Discogs – utwory bez twórców sprawdzone v1 idą jeszcze raz
    odp = mag.wyslij("kluczeBezMetadanych", limit=limit, tryb="szczegoly", min=min_emisji, wersja=wersja)
    if odp.get("tryb") != "szczegoly":
        print("Odbiornik bez trybu „szczegoly” – pomijam do aktualizacji OdbiornikAgregaty.gs")
        return 0
    braki = odp["klucze"]
    print(f"Bez szczegółów (≥ {min_emisji} emisji): {len(braki)}", flush=True)
    mb, wd, dg, wynik, z_kompozytorem, z_wikidata, sprawdzone = MusicBrainz(), Wikidata(), Discogs(os.environ.get("DISCOGS_TOKEN")), {}, 0, 0, 0
    z_discogs = 0
    print(f"Discogs: {'token jest' if dg.token else 'brak tokenu DISCOGS_TOKEN – pomijam to źródło'}", flush=True)
    for k, a, t, _n in braki:
        if time.monotonic() > koniec:
            break
        try:
            w = mb.szczegoly(a, t)
        except Exception as e:  # sieć – spróbujemy następnym razem
            print(f"Szczegóły: {a} – {t}: {e}", file=sys.stderr)
            continue
        if not (w.get("kp") or w.get("as") or w.get("au")) and dg.token:
            # MusicBrainz bez twórców – Discogs (credits wydawnictw, dobre pokrycie polskich wydań)
            try:
                d = dg.tworcy(a, t)
            except Exception as e:
                d = {}
                print(f"Discogs: {a} – {t}: {e}", file=sys.stderr)
            if d:
                z_discogs += 1
                w.update({"zt": "Discogs", "dg": d["dg"], **{x: d[x] for x in ("kp", "as", "au", "ar") if d.get(x)}})
                if d.get("pr") and not w.get("pr"):
                    w["pr"] = d["pr"]
                if d.get("dlab") and not (w.get("wy") or {}).get("lab"):
                    w["wlab"] = d["dlab"]
        if not (w.get("kp") or w.get("as") or w.get("au")):
            # dalej bez twórców – Wikidata (osobny serwis, własny limit)
            try:
                d = wd.tworcy(a, t)
            except Exception as e:
                d = {}
                print(f"Wikidata: {a} – {t}: {e}", file=sys.stderr)
            if d.get("kp") or d.get("as"):
                z_wikidata += 1
                w.update({"zt": "Wikidata", "kp": d.get("kp", []), "as": d.get("as", []), "wd": d["wd"]})
                if d.get("pr") and not w.get("pr"):
                    w["pr"] = d["pr"]
                if d.get("lab") and not (w.get("wy") or {}).get("lab"):
                    w["wlab"] = d["lab"]
            elif d.get("wd"):
                w["wd"] = d["wd"]
        w["szv"] = wersja
        wynik[k] = {x: v for x, v in w.items() if v not in ([], None, "")}
        sprawdzone += 1
        z_kompozytorem += bool(w.get("kp") or w.get("au") or w.get("as"))
        if len(wynik) >= 100:
            mag.wyslij("zapiszMetadane", metadane=dict(wynik))
            wynik.clear()
    if wynik:
        mag.wyslij("zapiszMetadane", metadane=wynik)
    print(f"Szczegóły: sprawdzono {sprawdzone}, z kompozytorem/autorem {z_kompozytorem} (w tym z Discogs {z_discogs}, z Wikidata {z_wikidata})", flush=True)
    return len(braki)

"""Gatunek „disco polo” – tylko dla utworów, które ewidentnie do niego należą.

Songster celowo nie ma tego gatunku (usunięty, CHANGELOG Songstera), a w radiu disco polo naturalnie występuje.
Oznaczenie wymaga potwierdzenia w kuratorowanych źródłach, nie samej nazwy:

Źródła (pobierane raz na uruchomienie):
  • MusicBrainz – wykonawcy z tagiem / gatunkiem „disco polo”, w których disco polo ma najwięcej głosów,
  • Wikidata – obiekty z gatunkiem (P136) disco polo (Q1185390): wykonawcy (z identyfikatorem MusicBrainz P434,
    jeśli jest) i pojedyncze utwory (z wykonawcą P175); wykonawca liczy się, gdy ma najwyżej 2 inne gatunki.

Reguły dla utworu (wykonawca A, tytuł T):
  1. utwór z Wikidata (gatunek disco polo, ten sam tytuł i wykonawca) → „Wikidata (utwór)”,
  2. nazwa któregoś z wykonawców A jest na liście wykonawców disco polo ORAZ
     a) nagranie T w MusicBrainz ma w kredytach wykonawcę o identyfikatorze z listy → potwierdzone identyfikatorem, albo
     b) nagrania nie ma, ale nazwa jest jednoznaczna: w MusicBrainz nie ma innego wykonawcy o tej samej nazwie spoza
        listy (np. „Focus”, „Live”, „Chanel”, „Venus” – także zespoły rockowe / pop z innych krajów → NIE oznaczamy),
  3. nigdy, gdy gatunki utworu (Songster) wskazują inny styl (rock, metal, hip hop, jazz, muzyka klasyczna…).

Wynik w metadanych: dp = źródło potwierdzenia (pole „g” zostaje nietknięte; panel dokleja „disco polo”),
gp = wersja reguł (utwór sprawdzony; zmiana WERSJA sprawdza wszystko jeszcze raz).
"""
from __future__ import annotations

import json
import re
import sys
import time
import urllib.parse
import urllib.request

from .normalize import klucz, tytul, wykonawca, wykonawcy

WERSJA = 1
QID = "Q1185390"   # disco polo w Wikidata (etykieta pl „disco polo”, sprawdzone 11.11.2026)
UA = "MusicBaseScrapper/0.2 (prywatne archiwum playlist)"
# Te same osoby pod innym imieniem, którego nie mają aliasy MusicBrainz ani Wikidata (sprawdzone 11.11.2026).
# Zenon Martyniuk (Akcent) występuje w playlistach jako „Zenek Martyniuk” – pl.wikipedia.org/wiki/Zenon_Martyniuk.
ALIASY = {"zenek martyniuk": "zenon martyniuk"}
# Wykonawcy dance, których MusicBrainz ma oznaczonych jako disco polo – decyzja użytkownika 12.11.2026: nie oznaczamy.
NIE_DISCO_POLO = {"stachursky", "d-bomb", "d bomb"}
# Utwory oznaczone przed tą decyzją (dzienniki 12.11.2026) – dp: False przy każdym uruchomieniu (idempotentne).
KOREKTY = [("Stachursky", "Czuje I Wiem"), ("Stachursky", "Taki Jestem"), ("Stachursky", "Gdy Zaplaczesz"),
           ("Stachursky", "Z Każdym Twym Oddechem"), ("Stachursky", "Szampan I Truskawki"), ("Basta & Stachursky", "8 Sekund"),
           ("D-Bomb", "Shake Your Boom Boom"), ("D-Bomb", "Mysle...")]
WYKLUCZAJACE = {"rock", "metal", "hard rock", "heavy metal", "punk", "hip hop", "rap", "jazz", "blues", "classical",
                "muzyka klasyczna", "reggae", "soul", "funk", "country", "indie", "alternative", "grunge"}


def _json(url: str, naglowki: dict | None = None, przerwa: float = 5) -> dict:
    """GET JSON z ponowieniami (429/503 i zerwane połączenia); po 4 próbach – wyjątek."""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json", **(naglowki or {})})
    for proba in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as odp:
                return json.load(odp)
        except urllib.error.HTTPError as e:
            if e.code not in (429, 503) or proba == 3:
                raise
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            if proba == 3:
                raise
        time.sleep(przerwa * (proba + 1))
    return {}


class Zrodla:
    """Listy z MusicBrainz i Wikidata + zapytania o nagrania (1 zapytanie na sekundę do MusicBrainz)."""

    def __init__(self):
        self._ostatnie = 0.0
        self.mbid: dict[str, str] = {}          # MBID → źródło („MusicBrainz” / „Wikidata”)
        self.nazwy: dict[str, set[str]] = {}    # nazwa (ujednolicona) → MBID-y wykonawców disco polo (pusty = tylko Wikidata)
        self.utwory: dict[tuple[str, str], str] = {}   # (wykonawca, tytuł) → „Wikidata (utwór)”
        self._jednoznaczne: dict[str, bool] = {}

    def mb(self, sciezka: str) -> dict:
        czekaj = self._ostatnie + 1.1 - time.monotonic()
        if czekaj > 0:
            time.sleep(czekaj)
        self._ostatnie = time.monotonic()
        return _json("https://musicbrainz.org/ws/2" + sciezka)

    def _dodaj_nazwe(self, nazwa: str, mbid: str | None) -> None:
        n = wykonawca(nazwa)
        if len(n) < 2:
            return
        self.nazwy.setdefault(n, set())
        if mbid:
            self.nazwy[n].add(mbid)
        for alias, wlasciwa in ALIASY.items():
            if wlasciwa == n:
                self.nazwy.setdefault(alias, set()).update(self.nazwy[n])

    def wczytaj(self) -> None:
        # MusicBrainz: wykonawcy z tagiem disco polo, w których to najczęściej głosowany tag
        od, razem = 0, None
        while razem is None or od < razem:
            d = self.mb(f"/artist?fmt=json&limit=100&offset={od}&query=" + urllib.parse.quote('tag:"disco polo"'))
            razem = d.get("count", 0)
            artysci = d.get("artists", [])
            if not artysci:
                break
            for a in artysci:
                tagi = {t["name"].lower(): t.get("count", 0) for t in a.get("tags", [])}
                if "disco polo" in tagi and tagi["disco polo"] >= max(tagi.values()):
                    self.mbid[a["id"]] = "MusicBrainz"
                    self._dodaj_nazwe(a["name"], a["id"])
                    for al in a.get("aliases", []) or []:
                        self._dodaj_nazwe(al.get("name", ""), a["id"])
            od += len(artysci)
        # Wikidata: wykonawcy i utwory z gatunkiem disco polo (w 11.2026 limit 1 zapytanie na minutę – jedno zapytanie)
        zapytanie = f"""SELECT ?x ?nazwa ?mb ?typ ?wyk (GROUP_CONCAT(DISTINCT ?alias; separator="|") AS ?aliasy)
            (COUNT(DISTINCT ?inny) AS ?inne) WHERE {{
          ?x wdt:P136 wd:{QID} .
          ?x rdfs:label ?nazwa . FILTER(LANG(?nazwa) = "pl")
          OPTIONAL {{ ?x wdt:P434 ?mb }}
          OPTIONAL {{ ?x wdt:P31 ?typ }}
          OPTIONAL {{ ?x wdt:P175 ?w . ?w rdfs:label ?wyk . FILTER(LANG(?wyk) = "pl") }}
          OPTIONAL {{ ?x skos:altLabel ?alias . FILTER(LANG(?alias) = "pl") }}
          OPTIONAL {{ ?x wdt:P136 ?inny . FILTER(?inny != wd:{QID}) }}
        }} GROUP BY ?x ?nazwa ?mb ?typ ?wyk"""
        try:
            d = _json("https://query.wikidata.org/sparql?format=json&query=" + urllib.parse.quote(zapytanie),
                      {"Accept": "application/sparql-results+json"}, przerwa=65)
        except Exception as e:   # bez Wikidata – same potwierdzenia z MusicBrainz (ostrożniej, nie mniej pewnie)
            print(f"Disco polo: Wikidata niedostępna ({e}) – tylko MusicBrainz", flush=True)
            d = {}
        UTWOR = {"Q7366", "Q134556", "Q105543609", "Q2188189"}   # piosenka, singel, utwór muzyczny/kompozycja, dzieło muzyczne
        ALBUM = {"Q482994", "Q208569", "Q209939", "Q222910"}      # album, album studyjny, kompilacja, album z największymi przebojami
        self.wikidata = 0
        for b in d.get("results", {}).get("bindings", []):
            self.wikidata += 1
            typ = b.get("typ", {}).get("value", "").rsplit("/", 1)[-1]
            nazwa = b["nazwa"]["value"]
            if typ in UTWOR:
                if "wyk" in b:
                    self.utwory[(wykonawca(b["wyk"]["value"]), tytul(nazwa))] = "Wikidata (utwór)"
            elif typ in ALBUM:
                continue
            elif int(b.get("inne", {}).get("value", 0)) <= 2:
                mb = b.get("mb", {}).get("value")
                if mb:
                    self.mbid.setdefault(mb, "Wikidata")
                for n in [nazwa] + [x for x in b.get("aliasy", {}).get("value", "").split("|") if x]:
                    self._dodaj_nazwe(n, mb)

    def jednoznaczna(self, nazwa: str) -> bool:
        """W MusicBrainz nie ma wykonawcy o tej nazwie spoza listy disco polo."""
        if nazwa not in self._jednoznaczne:
            d = self.mb("/artist?fmt=json&limit=25&query=" + urllib.parse.quote(f'artist:"{nazwa}"'))
            obce = [a for a in d.get("artists", []) if wykonawca(a.get("name", "")) == nazwa and a["id"] not in self.mbid]
            self._jednoznaczne[nazwa] = not obce
        return self._jednoznaczne[nazwa]

    def nagranie(self, a: str, t: str) -> set[str] | None:
        """MBID-y wykonawców nagrania (najlepsze dopasowanie tytułu i wykonawcy) albo None."""
        glowny = re.split(r"\s*(?:/|&|,| feat\.? | ft\.? | x )\s*", a, flags=re.I)[0]
        tyt = re.sub(r"\s*[(\[].*?[)\]]", "", t).strip()
        d = self.mb("/recording?fmt=json&limit=25&query=" + urllib.parse.quote(f'recording:"{tyt}" AND artist:"{glowny}"'))
        wk, tk = set(wykonawcy(a)), tytul(t)
        for r in d.get("recordings", []):
            if r.get("score", 0) < 90 or tytul(r.get("title", "")) != tk:
                continue
            kred = [k["artist"] for k in r.get("artist-credit") or [] if isinstance(k, dict) and "artist" in k]
            if any(wykonawca(x.get("name", "")) in wk for x in kred):
                return {x["id"] for x in kred}
        return None


def klasyfikuj(z: Zrodla, a: str, t: str, gatunki: list[str] | None) -> str | None:
    """Źródło potwierdzenia disco polo albo None."""
    if gatunki and WYKLUCZAJACE & {g.lower() for g in gatunki}:
        return None
    wk, tk = wykonawcy(a), tytul(t)
    if any(w in NIE_DISCO_POLO or wykonawca(w) in NIE_DISCO_POLO for w in wk):
        return None
    for w in wk:
        if (w, tk) in z.utwory:
            return z.utwory[(w, tk)]
    kandydaci = [w for w in wk if w in z.nazwy]
    if not kandydaci:
        return None
    ids = z.nagranie(a, t)
    if ids is not None:
        trafione = [i for i in ids if i in z.mbid]
        return z.mbid[trafione[0]] if trafione else None   # nagranie innego wykonawcy o tej nazwie → nie
    for w in kandydaci:
        if z.jednoznaczna(w):
            ids_w = z.nazwy[w]
            return next((z.mbid[i] for i in ids_w if i in z.mbid), "Wikidata")
    return None


def gatunki_pass(mag, koniec: float, limit: int = 5000) -> int:
    """Sprawdza utwory bez bieżącej wersji sprawdzenia (gp < WERSJA) – najczęściej grane najpierw."""
    try:
        mag.wyslij("zapiszMetadane", metadane={klucz(a, t): {"dp": False} for a, t in KOREKTY})
    except Exception as e:  # spróbujemy przy następnym uruchomieniu
        print(f"Disco polo: korekty niezapisane ({e})")
    try:
        braki = mag.wyslij("kluczeBezMetadanych", tryb="gatunek", wersja=WERSJA, limit=limit)["klucze"]
    except Exception as e:  # stara wersja Odbiornika – pominięcie do aktualizacji
        print(f"Disco polo: pomijam ({e})")
        return 0
    if braki and len(braki[0]) < 5:   # stary Odbiornik nie zna trybu „gatunek” (zwraca listę bez gatunków)
        print("Disco polo: Odbiornik bez trybu „gatunek” – pomijam do aktualizacji OdbiornikAgregaty.gs")
        return 0
    if not braki:
        print("Disco polo: wszystkie utwory sprawdzone")
        return 0
    z = Zrodla()
    try:
        z.wczytaj()
    except Exception as e:   # MusicBrainz przeciążony – spróbujemy przy następnym uruchomieniu
        print(f"Disco polo: źródła niedostępne ({e}) – pomijam w tym uruchomieniu")
        return 0
    print(f"Disco polo: źródła – wykonawców (nazw) {len(z.nazwy)}, identyfikatorów MusicBrainz {len(z.mbid)}, utworów z Wikidata {len(z.utwory)}; do sprawdzenia {len(braki)}", flush=True)
    wynik, oznaczone, sprawdzone = {}, [], 0
    for wiersz in braki:
        if time.monotonic() > koniec:
            break
        k, a, t = wiersz[0], wiersz[1], wiersz[2]
        g = wiersz[4] if len(wiersz) > 4 else None
        try:
            zr = klasyfikuj(z, a, t, g)
        except Exception as e:   # sieć – spróbujemy następnym razem
            print(f"Disco polo: {a} – {t}: {e}", file=sys.stderr)
            continue
        wynik[k] = {"gp": WERSJA, **({"dp": zr} if zr else {})}
        sprawdzone += 1
        if zr:
            oznaczone.append(f"{a} – {t} [{zr}]")
        if len(wynik) >= 1000:
            mag.wyslij("zapiszMetadane", metadane=wynik)
            wynik = {}
    if wynik:
        mag.wyslij("zapiszMetadane", metadane=wynik)
    print(f"Disco polo: sprawdzono {sprawdzone}, oznaczono {len(oznaczone)}")
    for o in oznaczone[:200]:
        print("  disco polo:", o)
    return sprawdzone

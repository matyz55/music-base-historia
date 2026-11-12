"""Gdzie trafiają pobrane dane: lokalny katalog albo Dysk Google (przez Apps Script „Odbiornik”).

Jednostką zapisu jest pełny miesiąc jednej stacji (plik JSONL, na Dysku spakowany gzipem) i stan stacji:
  stan = {"slug", "r", "nazwa", "dni": {"RRRR-MM-DD": liczba_utworów}, "miesiace_puste": ["RRRR-MM", ...]}
Stan jest zapisywany razem z miesiącem, więc przerwane pobieranie wznawia się od pierwszego niezapisanego miesiąca.
"""
from __future__ import annotations

import base64
import gzip
import json
import os
import urllib.request


def _linie(wiersze: list[dict]) -> str:
    return "".join(json.dumps(w, ensure_ascii=False, separators=(",", ":")) + "\n" for w in wiersze)


def nowy_stan(slug: str) -> dict:
    return {"slug": slug, "dni": {}, "miesiace_puste": []}


class MagazynLokalny:
    def __init__(self, katalog: str = os.path.join("data", "odsluchane")):
        self.katalog = katalog

    def _sc(self, slug: str, nazwa: str) -> str:
        return os.path.join(self.katalog, slug, nazwa)

    def stany(self, slugi: list[str]) -> dict[str, dict]:
        wynik = {}
        for s in slugi:
            try:
                with open(self._sc(s, "stan.json"), encoding="utf-8") as f:
                    wynik[s] = json.load(f)
            except FileNotFoundError:
                wynik[s] = nowy_stan(s)
        return wynik

    def _zapisz(self, sciezka: str, tekst: str) -> None:
        os.makedirs(os.path.dirname(sciezka), exist_ok=True)
        with open(sciezka + ".tmp", "w", encoding="utf-8") as f:
            f.write(tekst)
        os.replace(sciezka + ".tmp", sciezka)

    def zapisz_stan(self, stan: dict) -> None:
        self._zapisz(self._sc(stan["slug"], "stan.json"), json.dumps(stan, ensure_ascii=False, separators=(",", ":"), sort_keys=True))

    def zapisz_miesiac(self, slug: str, miesiac: str, wiersze: list[dict], stan: dict) -> None:
        self._zapisz(self._sc(slug, f"{miesiac}.jsonl"), _linie(wiersze))
        self.zapisz_stan(stan)

    def zapisz_paczke(self, wpisy: list[dict]) -> None:
        """wpisy: [{"slug", "stan", "wiersze"}]; wiersze scalane z plikami miesięcy (doby zastępują stare)."""
        for w in wpisy:
            for m, nowe in _po_miesiacach(w["wiersze"]).items():
                sc = self._sc(w["slug"], f"{m}.jsonl")
                daty = {x["d"] for x in nowe}
                stare = []
                if os.path.exists(sc):
                    with open(sc, encoding="utf-8") as f:
                        stare = [json.loads(l) for l in f if l.strip()]
                razem = sorted([x for x in stare if x["d"] not in daty] + nowe, key=lambda x: (x["d"], x["g"]))
                self._zapisz(sc, _linie(razem))
            self.zapisz_stan(w["stan"])


def _po_miesiacach(wiersze: list[dict]) -> dict[str, list[dict]]:
    m: dict[str, list[dict]] = {}
    for w in wiersze:
        m.setdefault(w["d"][:7], []).append(w)
    return m


class BladOdbiornika(RuntimeError):
    pass


class MagazynDysk:
    """Klient aplikacji internetowej Apps Script (apps-script/Odbiornik.gs)."""

    def __init__(self, url: str | None = None, token: str | None = None):
        self.url = url or os.environ.get("ODBIORNIK_URL", "")
        self.token = token or os.environ.get("ODBIORNIK_TOKEN", "")
        if not self.url or not self.token:
            raise SystemExit("Brak ODBIORNIK_URL lub ODBIORNIK_TOKEN (sekrety GitHuba albo zmienne środowiskowe).")

    # aktualizacja bieżąca ustawia True: przy zajętej blokadzie Odbiornik odkłada zapis do kolejki, zamiast kazać czekać
    # (starsza wersja Odbiornika pole ignoruje i czeka jak dotąd)
    kolejka = False

    def wyslij(self, akcja: str, **dane) -> dict:
        if self.kolejka:
            dane["kolejka"] = True
        tresc = json.dumps({"akcja": akcja, "token": self.token, **dane}, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(self.url, data=tresc, headers={"Content-Type": "application/json"})
        ostatni = None
        for _ in range(8):  # przy zajętej blokadzie Odbiornika łącznie do ~4 min czekania
            try:
                # Apps Script odpowiada przekierowaniem 302; urllib przechodzi pod nowy adres metodą GET – tak ma być
                with urllib.request.urlopen(req, timeout=420) as odp:
                    wynik = json.loads(odp.read().decode("utf-8"))
                if not wynik.get("ok"):
                    blad = str(wynik.get("blad"))
                    # blokada zajęta (np. trwa przeliczanie podsumowań) – ponawiamy
                    # przejściowe: blokada zajęta (trwa przeliczanie), ucięta treść żądania, przeciążenie usług Google
                    if any(x in blad.lower() for x in ("lock", "timeout", "blokad", "unexpected end of json", "service", "exceeded", "przekroczono")):
                        ostatni = blad
                        import time
                        time.sleep(30)
                        continue
                    raise BladOdbiornika(f"{akcja}: {blad}")
                return wynik
            except (OSError, json.JSONDecodeError) as e:  # sieć, przeciążenie, strona błędu zamiast JSON
                ostatni = e
                import time
                time.sleep(10)
        raise BladOdbiornika(f"{akcja}: {ostatni}")

    def stany(self, slugi: list[str]) -> dict[str, dict]:
        st = self.wyslij("stan", slugi=slugi)["stan"]
        return {s: (st.get(s) or nowy_stan(s)) for s in slugi}

    def indeks(self) -> dict:
        return self.wyslij("indeks")["indeks"]

    def zapisz_stan(self, stan: dict) -> None:
        self.wyslij("zapiszStan", slug=stan["slug"], stan=stan)

    def zapisz_miesiac(self, slug: str, miesiac: str, wiersze: list[dict], stan: dict) -> None:
        gz = base64.b64encode(gzip.compress(_linie(wiersze).encode("utf-8"))).decode("ascii")
        self.wyslij("zapiszMiesiac", slug=slug, miesiac=miesiac, gz=gz, stan=stan)

    def zapisz_paczke(self, wpisy: list[dict], max_bajtow: int = 1_500_000) -> None:
        """wpisy: [{"slug", "stan", "wiersze"}] – wysyłane w częściach do ok. 1,5 MB i 10 stacji (gzip w base64)."""
        czesc, rozmiar = [], 0
        for w in wpisy:
            miesiace = {m: base64.b64encode(gzip.compress(_linie(x).encode("utf-8"))).decode("ascii")
                        for m, x in _po_miesiacach(w["wiersze"]).items()}
            wpis = {"slug": w["slug"], "stan": w["stan"], "miesiace": miesiace}
            n = sum(len(v) for v in miesiace.values()) + 2000
            if czesc and (rozmiar + n > max_bajtow or len(czesc) >= 10):
                self.wyslij("zapiszPaczke", wpisy=czesc)
                czesc, rozmiar = [], 0
            czesc.append(wpis)
            rozmiar += n
        if czesc:
            self.wyslij("zapiszPaczke", wpisy=czesc)

    def zapisz_okno(self, slug: str, data: str, okno: int, wiersze: list[dict]) -> None:
        self.wyslij("zapiszOkno", slug=slug, data=data, okno=okno, wiersze=wiersze)

    def zapisz_okna(self, okna: list[dict]) -> None:
        """okna: [{"slug", "data", "okno", "wiersze"}] – jedno żądanie zamiast wielu."""
        for i in range(0, len(okna), 40):
            self.wyslij("zapiszOkna", okna=okna[i:i + 40])

    def domknij_doby(self, doby: list[dict]) -> None:
        """doby: [{"slug", "data", "wiersze", "r", "nazwa"}] – po 15 w żądaniu (każda doba to odczyt i zapis pliku miesiąca)."""
        for i in range(0, len(doby), 15):
            self.wyslij("domknijDoby", doby=doby[i:i + 15])

    def domknij_dobe(self, slug: str, data: str, wiersze: list[dict], r: int, nazwa: str) -> None:
        self.wyslij("domknijDobe", slug=slug, data=data, wiersze=wiersze, r=r, nazwa=nazwa)

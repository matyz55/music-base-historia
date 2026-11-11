"""Ujednolicanie zapisu wykonawców i tytułów, żeby ten sam utwór z różnych źródeł dał ten sam klucz.

Źródła piszą ten sam utwór różnie: z polskimi znakami albo bez („Lece Tam” / „Lecę tam”),
z dopiskami („(Radio Edit)”, „[From GTA VI]”), z gośćmi po „feat.” albo po ukośniku.
"""
import re
import unicodedata

_DOPISKI = re.compile(r"\((?:[^)]*)\)|\[(?:[^\]]*)\]")
_GOSCIE = re.compile(r"\s(?:feat\.?|ft\.?|featuring)\s.*$")
# separatory wielu wykonawców: „A / B”, „A & B”, „A, B”, „A x B”, „A feat. B”, „A i B” nie (bywa w nazwach zespołów)
_SEPARATORY = re.compile(r"\s*(?:/|&|,|\sx\s|\sfeat\.?\s|\sft\.?\s|\sfeaturing\s|\svs\.?\s)\s*", re.I)


def bez_znakow(s: str) -> str:
    """Małe litery, bez polskich i innych znaków diakrytycznych."""
    s = s.lower().replace("ł", "l").replace("’", "'").replace("`", "'").replace('"', "'")
    s = unicodedata.normalize("NFKD", s)
    return "".join(c for c in s if not unicodedata.combining(c))


def tytul(t: str) -> str:
    t = bez_znakow(t)
    t = _DOPISKI.sub(" ", t)
    t = _GOSCIE.sub(" ", " " + t)
    t = re.sub(r"[^a-z0-9]+", " ", t)
    return t.strip()


def wykonawca(a: str) -> str:
    a = bez_znakow(a)
    a = _DOPISKI.sub(" ", a)
    a = re.sub(r"^the\s+", "", a)
    a = re.sub(r"[^a-z0-9]+", " ", a)
    return a.strip()


def wykonawcy(a: str) -> list[str]:
    """Lista znormalizowanych wykonawców; pierwszy to wykonawca główny."""
    czesci = [wykonawca(x) for x in _SEPARATORY.split(a)]
    return [c for c in czesci if c]


def klucz(a: str, t: str) -> str:
    """Klucz utworu: główny wykonawca + tytuł."""
    w = wykonawcy(a)
    return f"{w[0] if w else ''}|{tytul(t)}"

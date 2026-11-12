"""Wulgaryzmy w tekście utworu – lista w narzedzia/wulgaryzmy.json (ta sama w panelu: Klucze.html).

poziom(tekst) → 2 (są słowa wulgarne – do ocenzurowania przed emisją), 1 (tylko „do rozważenia”), 0 (brak).
Lista jest heurystyczna: wynik to podpowiedź dla redakcji, nie ocena prawna.
"""
from __future__ import annotations

import json
import pathlib
import re
import unicodedata

_D = json.loads((pathlib.Path(__file__).resolve().parent.parent / "narzedzia" / "wulgaryzmy.json").read_text(encoding="utf-8"))
_PRZED = "(?:" + "|".join(sorted(_D["pl"]["przedrostki"], key=len, reverse=True)) + ")"
_PL2 = re.compile(rf"^{_PRZED}{{0,2}}(?:{'|'.join(_D['pl']['rdzenie2'])})")
_PL1 = re.compile(rf"^{_PRZED}{{0,2}}(?:{'|'.join(_D['pl']['rdzenie1'])})")
_EN2 = re.compile("|".join(_D["en"]["rdzenie2"]))
_S2 = set(_D["pl"]["slowa2"]) | set(_D["en"]["slowa2"])
_S1 = set(_D["pl"]["slowa1"]) | set(_D["en"]["slowa1"])
_SLOWO = re.compile(r"[^\W\d_]+(?:['’][^\W\d_]+)*")


def ascii_male(s: str) -> str:
    s = s.lower().replace("ł", "l")
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def poziom_slowa(slowo: str) -> int:
    w = ascii_male(slowo).replace("’", "'")
    if w in _S2 or _PL2.match(w) or _EN2.search(w):
        return 2
    if w in _S1 or _PL1.match(w):
        return 1
    return 0


def poziom(tekst: str) -> int:
    return max((poziom_slowa(m.group()) for m in _SLOWO.finditer(tekst or "")), default=0)

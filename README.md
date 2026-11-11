# Music Base – pobieranie historii

Tymczasowe repozytorium do jednorazowego pobrania historii playlist polskich stacji radiowych
z [odSluchane.eu](https://www.odsluchane.eu/radio) (od 2009 r.). Publiczne tylko po to, żeby GitHub Actions
liczył minuty za darmo. **Dane nie trafiają do tego repozytorium** – zadanie wysyła je na prywatny Dysk Google
przez aplikację Apps Script (adres i token w sekretach `ODBIORNIK_URL`, `ODBIORNIK_TOKEN`).

- Kolejność: tydzień po tygodniu wstecz, w każdym tygodniu wszystkie stacje.
- Tempo: 1 zapytanie na sekundę (ok. 23 min na tydzień wszystkich stacji).
- Zadanie trwa do ~5,5 h; harmonogram co godzinę uruchamia kolejne, postęp jest zapisany na Dysku.
- Po pobraniu całej historii repozytorium można usunąć.

Uruchomienie lokalne (bez Dysku): `python3 -m scraper.backfill --stacje rmf_fm --od 2026` → `data/`.

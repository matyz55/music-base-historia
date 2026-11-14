/**
 * Music Base – wspólna logika (ten sam plik w projektach „Odbiornik” i „Panel”).
 * Klucz utworu MUSI być identyczny z scraper/normalize.py (test: tests/test_klucze.mjs).
 */

var NAZWA_FOLDERU = 'Music Base – dane';
var FOLDER_AGG = '_agg';
var OKNO_SIECI_MIN = 3;   // ta sama piosenka na stacjach jednej sieci w odstępie do 3 min = jedno odtworzenie

/**
 * Sieci stacji: stacje nadające częściowo wspólny program. Na liście stacji są jedną pozycją,
 * w profilu sieci można zobaczyć każdą stację osobno. Ustalone na danych odSluchane.eu:
 * Fama 5.11.2025 (wspólne noce i większość dnia), Jura i Radio 90 9.11.2026 (83% wspólnych emisji).
 */
var SIECI = {
  siec_fama: { nazwa: 'Radio Fama', czlonkowie: ['fama_kielce', 'fama_slupsk', 'fama_tomaszow_mazowiecki', 'fama_wolomin'] },
  siec_jura_90: { nazwa: 'Jura / Radio 90', czlonkowie: ['jura', 'radio_90'] },
};

/** Czytelne nazwy stacji (odSluchane.eu podaje skróty, np. „ZET”, „90”). */
var NAZWY_STACJI = {
  radio_zet: 'Radio ZET', radio_90: 'Radio 90', radio_wawa: 'Eska2 (dawniej Radio Wawa)', planeta_fm: 'Planeta FM',
  bialystok: 'Radio Białystok', krakow: 'Radio Kraków', lodz: 'Radio Łódź', lodz_extra: 'Radio Łódź Extra',
  olsztyn: 'Radio Olsztyn', opole: 'Radio Opole', radio_poznan: 'Radio Poznań', szczecin: 'Radio Szczecin',
  szczecin_extra: 'Radio Szczecin Extra', wroclaw: 'Radio Wrocław', pik: 'Radio PiK', bielsko: 'Radio Bielsko',
  radio_plus: 'Radio Plus', radio_elka: 'Radio Elka', radio_kolor: 'Radio Kolor', radio_centrum_kalisz: 'Radio Centrum (Kalisz)',
  radio_gra: 'Radio GRA Toruń', radio_express: 'Radio Express', katolickie_radio_ciechanow: 'Katolickie Radio Ciechanów',
  jura: 'Radio Jura', muzo_fm: 'Muzo FM (obecnie Eska Rock)', jedynka: 'Jedynka (Polskie Radio)', dwojka: 'Dwójka (Polskie Radio)', trojka: 'Trójka (Polskie Radio)',
  czworka: 'Czwórka (Polskie Radio)', radio_meteor: 'Radio Meteor',
  radio_357: 'Radio 357', nowy_swiat: 'Radio Nowy Świat', rmf24: 'RMF24',
};

/** Stacje usunięte z bazy (decyzja użytkownika 11.11.2026). Ich surowe dane zostają na Dysku, ale nie wchodzą do
 *  podsumowań całego radia, list stacji ani alertów. */
var WYKLUCZONE_STACJE = { rmf_dance: 1 };

function nazwaStacji(slug, zapasowa) { return SIECI[slug] ? SIECI[slug].nazwa : (NAZWY_STACJI[slug] || zapasowa || slug); }

var NIE_PIOSENKI = ['fakty', 'wiadomosci', 'serwis informacyjny', 'reklama', 'jingiel', 'dzingiel'];

function siecStacji(slug) {
  for (var s in SIECI) if (SIECI[s].czlonkowie.indexOf(slug) >= 0) return s;
  return null;
}

// ---------------- klucz utworu (port scraper/normalize.py) ----------------

function bezZnakow_(s) {
  s = String(s || '').toLowerCase().replace(/ł/g, 'l').replace(/[’`]/g, "'").replace(/"/g, "'");
  return s.normalize('NFKD').replace(/[̀-ͯ᪰-᫿᷀-᷿⃐-⃿︠-︯]/g, '');
}
var DOPISKI_ = /\([^)]*\)|\[[^\]]*\]/g;
function tytulKlucz(t) {
  t = bezZnakow_(t).replace(DOPISKI_, ' ');
  t = (' ' + t).replace(/\s(?:feat\.?|ft\.?|featuring)\s[\s\S]*$/, ' ');
  return t.replace(/[^a-z0-9]+/g, ' ').trim();
}
function wykonawcaKlucz(a) {
  a = bezZnakow_(a).replace(DOPISKI_, ' ').replace(/^the\s+/, '');
  return a.replace(/[^a-z0-9]+/g, ' ').trim();
}
var SEPARATORY_ = /\s*(?:\/|&|,|\sx\s|\sfeat\.?\s|\sft\.?\s|\sfeaturing\s|\svs\.?\s)\s*/i;
// przedrostki nazw stacji dopisywane w metadanych strumienia (np. Muzo FM: „Eska Rock: Kult – Baranek”)
var PRZEDROSTKI_STACJI_ = /^\s*(?:eska rock|radio eska rock)\s*:\s*/i;
function oczyscWykonawce(a) { return String(a || '').replace(PRZEDROSTKI_STACJI_, ''); }
function wykonawcyKlucz(a) {
  return oczyscWykonawce(a).split(SEPARATORY_).map(wykonawcaKlucz).filter(Boolean);
}
function kluczUtworu(a, t) {
  var w = wykonawcyKlucz(a);
  return (w[0] || '') + '|' + tytulKlucz(t);
}
// sama nazwa stacji jako wykonawca = komunikat stacji (np. „Eska Rock – Pobierz Apkę i Słuchaj Wszędzie!”)
var NAZWY_STACJI_JAKO_WYKONAWCA_ = ['eska rock', 'radio eska rock', 'eska', 'radio eska', 'rmf fm', 'radio zet', 'radio meteor', 'antyradio'];
function czyPiosenka(a, t) {
  if (!String(a || '').trim() || !String(t || '').trim()) return false;
  var al = String(a).toLowerCase();
  if (NAZWY_STACJI_JAKO_WYKONAWCA_.indexOf(wykonawcaKlucz(a)) >= 0) return false;
  return !NIE_PIOSENKI.some(function (x) { return al.indexOf(x) >= 0; });
}

// ---------------- daty ----------------

/** Dzień tygodnia 0 = poniedziałek … 6 = niedziela, dla daty RRRR-MM-DD. */
function dzienTyg(d) {
  var x = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)));
  return (x.getUTCDay() + 6) % 7;
}
function minuty_(g) { return +g.slice(0, 2) * 60 + +g.slice(3, 5); }

// ---------------- agregaty ----------------
//
// Agregat miesiąca jednostki (stacja albo sieć): _agg/<jednostka>/<RRRR-MM>.json.gz
//   { m: "RRRR-MM", emisji: n, dni: {"DD": liczba emisji}, u: { klucz: [a, t, n, {"DD": n}, {"tg*24+h": n}, "DD GG:MM", ["DD GG:MM", …]] } }
// (tg – dzień tygodnia od poniedziałku = 0, h – godzina; pole 5 – pierwsza emisja w miesiącu, pole 6 – wszystkie emisje)

/** Wiersze {d, g, a, t} jednego miesiąca → agregat miesiąca. */
function agregujMiesiac(m, wiersze, pop) {
  var agg = { m: m, emisji: 0, dni: {}, u: {} };
  wiersze.forEach(function (w) {
    if (!czyPiosenka(w.a, w.t)) return;
    var k = kluczUtworu(w.a, w.t);
    if (pop) k = kluczPoprawiony(k, w.a, pop);
    var dd = w.d.slice(8, 10);
    var hw = String(dzienTyg(w.d) * 24 + +w.g.slice(0, 2));
    var e = agg.u[k];
    if (!e) e = agg.u[k] = pop && pop.nazwa[k] ? [pop.nazwa[k][0], pop.nazwa[k][1], 0, {}, {}, dd + ' ' + w.g, []] : [oczyscWykonawce(w.a), w.t, 0, {}, {}, dd + ' ' + w.g, []];
    e[2]++;
    e[6].push(dd + ' ' + w.g);
    e[3][dd] = (e[3][dd] || 0) + 1;
    e[4][hw] = (e[4][hw] || 0) + 1;
    if (dd + ' ' + w.g < e[5]) e[5] = dd + ' ' + w.g;
    agg.dni[dd] = (agg.dni[dd] || 0) + 1;
    agg.emisji++;
  });
  return agg;
}

/**
 * O5: ręczne poprawki dopasowań (_agg/poprawki.json, ustawiane w panelu) → {scal: {z: na}, nazwa: {k: [a, t]}, rozdziel: {k: [{gdy, na}]}}.
 * Dane surowe zostają bez zmian – poprawki działają przy liczeniu podsumowań miesięcy.
 */
function przygotujPoprawki(d) {
  var pop = { scal: {}, nazwa: {}, rozdziel: {} };
  ((d && d.lista) || []).forEach(function (x) {
    if (x.typ === 'scal' && x.z && x.na) pop.scal[x.z] = x.na;
    if (x.typ === 'nazwa' && x.k) pop.nazwa[x.k] = [x.a || x.k.split('|')[0], x.t || x.k.split('|')[1]];
    if (x.typ === 'rozdziel' && x.k && x.gdyWykonawca && x.na) (pop.rozdziel[x.k] = pop.rozdziel[x.k] || []).push({ gdy: String(x.gdyWykonawca).toLowerCase(), na: x.na });
  });
  return pop;
}
function kluczPoprawiony(k, aSurowy, pop) {
  var r = pop.rozdziel[k];
  if (r) for (var i = 0; i < r.length; i++) if (String(aSurowy || '').toLowerCase().indexOf(r[i].gdy) >= 0) { k = r[i].na; break; }
  for (var n = 0; n < 5 && pop.scal[k]; n++) k = pop.scal[k];
  return k;
}

/**
 * Wiersze stacji jednej sieci → wiersze sieci bez powtórzeń: ta sama piosenka na różnych stacjach
 * w odstępie do OKNO_SIECI_MIN minut liczy się raz. Lokalne pasma (inne utwory) zostają osobno.
 * wierszeStacji: {slug: [wiersze]}.
 */
function scalSiec(wierszeStacji) {
  var wszystkie = [];
  Object.keys(wierszeStacji).forEach(function (s) {
    wierszeStacji[s].forEach(function (w) {
      if (!czyPiosenka(w.a, w.t)) return;
      wszystkie.push({ d: w.d, g: w.g, a: oczyscWykonawce(w.a), t: w.t, s: s, k: kluczUtworu(w.a, w.t), c: Date.UTC(+w.d.slice(0, 4), +w.d.slice(5, 7) - 1, +w.d.slice(8, 10)) / 60000 + minuty_(w.g) });
    });
  });
  wszystkie.sort(function (x, y) { return x.c - y.c; });
  var ostatnie = {};   // klucz → {c, stacje}
  var wynik = [];
  wszystkie.forEach(function (w) {
    var o = ostatnie[w.k];
    if (o && w.c - o.c <= OKNO_SIECI_MIN && !o.stacje[w.s]) { o.stacje[w.s] = 1; return; }
    ostatnie[w.k] = { c: w.c, stacje: {} };
    ostatnie[w.k].stacje[w.s] = 1;
    wynik.push({ d: w.d, g: w.g, a: w.a, t: w.t });
  });
  return wynik;
}

/** Agregaty miesięcy → agregat roku: u[klucz] = [a, t, n, {"MM": n}, {hw: n}, "MM-DD GG:MM"]. */
/** Numer paczki (0–15) utworu: skrót FNV-1a głównego wykonawcy – wszystkie utwory wykonawcy w jednej paczce. */
var PACZEK_UTWOROW = 16;
function paczkaUtworu(k) {
  var s = String(k).split('|')[0], h = 2166136261;
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h % PACZEK_UTWOROW;
}
function nazwaPaczki(n) { return 's' + ('0' + n).slice(-2) + '.json.gz'; }
/** K6: paczka indeksu utworów razem z archiwum (utwory niegrane od 36 miesięcy, indeks_arch_sNN). */
function paczkaIndeksuPelna(fw, i) {
  var p = czytajGz(fw, 'indeks_' + nazwaPaczki(i)) || {}, a = czytajGz(fw, 'indeks_arch_' + nazwaPaczki(i));
  if (a) Object.keys(a).forEach(function (k) { if (!p[k]) p[k] = a[k]; });
  return p;
}

/**
 * 48-bitowy skrót klucza utworu (FNV-1a 32 bity + 16 bitów drugiego skrótu) – plik „znane” (pierwsza emisja i liczba
 * emisji KAŻDEGO utworu, ok. 2 MB zamiast ~15 MB pełnego indeksu). Liczba całkowita < 2^48, dokładna w JavaScript.
 * Szansa, że któreś dwa z 400 tys. utworów dostaną ten sam skrót: ok. 0,03% (wtedy dzielą jeden wpis).
 */
function skrotKlucza(k) {
  var s = String(k), h1 = 2166136261, h2 = 0x2545f491;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    h2 = (h2 ^ (h2 >>> 13)) >>> 0;
  }
  return h1 * 65536 + (h2 >>> 16);
}

function agregujRok(r, miesiace) {
  var agg = { r: r, emisji: 0, mies: {}, u: {} };
  miesiace.forEach(function (am) {
    if (!am) return;
    var mm = am.m.slice(5, 7);
    agg.mies[mm] = { emisji: am.emisji, dni: Object.keys(am.dni).length };
    agg.emisji += am.emisji;
    Object.keys(am.u).forEach(function (k) {
      var x = am.u[k], e = agg.u[k];
      if (!e) e = agg.u[k] = [x[0], x[1], 0, {}, {}, mm + '-' + x[5]];
      e[2] += x[2];
      e[3][mm] = (e[3][mm] || 0) + x[2];
      Object.keys(x[4]).forEach(function (h) { e[4][h] = (e[4][h] || 0) + x[4][h]; });
      if (mm + '-' + x[5] < e[5]) e[5] = mm + '-' + x[5];
    });
  });
  return agg;
}

// ---------------- Dysk ----------------

function podfolder(rodzic, nazwa, utworz) {
  var it = rodzic.getFoldersByName(nazwa);
  if (it.hasNext()) return it.next();
  return utworz === false ? null : rodzic.createFolder(nazwa);
}
/** Wszystkie kopie pliku o tej nazwie poza koszem (wyszukiwanie w folderze Dysku zwraca też pliki z kosza). */
function kopiePliku(folder, nazwa) {
  var wynik = [], it = folder.getFilesByName(nazwa);
  while (it.hasNext()) { var p = it.next(); if (!p.isTrashed()) wynik.push(p); }
  return wynik.sort(function (a, b) { return b.getLastUpdated() - a.getLastUpdated(); });
}
/** Najnowsza kopia pliku poza koszem. */
function znajdzPlik(folder, nazwa) {
  if (!folder) return null;
  return kopiePliku(folder, nazwa)[0] || null;
}
/** Zapis: nowy plik, potem wszystkie starsze kopie do kosza. Pusty plik nie jest zapisywany. */
function zapiszPlik(folder, nazwa, blob) {
  if (!blob.getBytes().length) throw new Error('Próba zapisu pustego pliku ' + nazwa);
  blob.setName(nazwa);
  var stare = kopiePliku(folder, nazwa);
  var nowy = folder.createFile(blob);
  stare.forEach(function (p) { if (p.getId() !== nowy.getId()) p.setTrashed(true); });
}
/** JSON.parse z nazwą pliku w komunikacie błędu (żeby było wiadomo, który plik jest uszkodzony). */
function parsujJson(tekst, opis) {
  try { return JSON.parse(tekst); } catch (e) {
    throw new Error('Uszkodzony plik „' + opis + '” (' + String(tekst).length + ' znaków): ' + e.message);
  }
}
/** Wiersze JSONL → obiekty; uszkodzone wiersze są pomijane zamiast przerywać zapis. */
function parsujLinie(linie) {
  var wynik = [];
  linie.forEach(function (l) { try { wynik.push(JSON.parse(l)); } catch (e) { /* uszkodzony wiersz */ } });
  return wynik;
}
/**
 * Odczyt odporny na uszkodzenia: najnowsza poprawna kopia – najpierw poza koszem, potem z kosza
 * (poprzednie wersje po każdym zapisie trafiają do kosza). Brak poprawnej kopii = jak brak pliku.
 */
function czytajOdporne_(folder, nazwa, czytaj) {
  if (!folder) return null;
  var wszystkie = [], it = folder.getFilesByName(nazwa);
  while (it.hasNext()) wszystkie.push(it.next());
  if (!wszystkie.length) return null;
  wszystkie.sort(function (a, b) { return (a.isTrashed() - b.isTrashed()) || (b.getLastUpdated() - a.getLastUpdated()); });
  for (var i = 0; i < wszystkie.length; i++) {
    try {
      var tekst = czytaj(wszystkie[i]);
      if (String(tekst).trim()) return parsujJson(tekst, folder.getName() + '/' + nazwa);
    } catch (e) { /* uszkodzona kopia – próbujemy starszej */ }
  }
  // żadna kopia nie jest poprawna: traktujemy jak brak pliku (dane da się odtworzyć), zamiast blokować wszystkie zapisy
  console.log('Brak poprawnej kopii pliku ' + folder.getName() + '/' + nazwa + ' – traktuję jak brak pliku');
  return null;
}
function czytajGz(folder, nazwa) {
  return czytajOdporne_(folder, nazwa, function (p) { return Utilities.ungzip(p.getBlob().setContentType('application/x-gzip')).getDataAsString('UTF-8'); });
}
function zapiszGz(folder, nazwa, obiekt) {
  zapiszPlik(folder, nazwa, Utilities.gzip(Utilities.newBlob(JSON.stringify(obiekt), 'application/json')));
}
function czytajJsonPlik(folder, nazwa) {
  return czytajOdporne_(folder, nazwa, function (p) { return p.getBlob().getDataAsString('UTF-8'); });
}
function zapiszJsonPlik(folder, nazwa, obiekt) {
  zapiszPlik(folder, nazwa, Utilities.newBlob(JSON.stringify(obiekt), 'application/json'));
}
/** Wiersze surowego miesiąca stacji (plik RRRR-MM.jsonl.gz). */
function czytajSurowyMiesiac(folderStacji, m) {
  var p = znajdzPlik(folderStacji, m + '.jsonl.gz');
  if (!p) return [];
  return parsujLinie(Utilities.ungzip(p.getBlob().setContentType('application/x-gzip')).getDataAsString('UTF-8').split('\n').filter(String));
}

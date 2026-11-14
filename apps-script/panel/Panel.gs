/**
 * Music Base – Panel (aplikacja internetowa, dostęp tylko dla właściciela).
 * Czyta dane z folderu „Music Base – dane” (zapisuje je Odbiornik). Pliki projektu:
 * Wspolne.gs (wspólny z Odbiornikiem), Panel.gs, Spotify.gs, Index.html.
 *
 * Funkcje wywoływane z przeglądarki przez google.script.run zwracają obiekty JSON;
 * błąd jest zwracany jako {blad: "..."} zamiast wyjątku, żeby panel zawsze pokazał komunikat.
 */

/** Ikona panelu (PNG w repozytorium, serwowana przez GitHub – Apps Script wymaga adresu URL obrazka). */
var IKONA_PANELU = 'https://raw.githubusercontent.com/matyz55/music-base-historia/main/ikona.png';

function doGet(e) {
  if (e && e.parameter && e.parameter.code && e.parameter.state) return spotifyPowrot_(e);
  var t = HtmlService.createTemplateFromFile('Index');
  // < jako \u003c: parametr z adresu nie może zamknąć znacznika <script>
  t.parametry = JSON.stringify((e && e.parameter) || {}).replace(/</g, '\\u003c').replace(/\//g, '\\/');
  // „/” jako „\\/”: Apps Script wycina z kodu strony wszystko po „//”, także wewnątrz napisu (11.11.2026)
  t.adres = JSON.stringify(ScriptApp.getService().getUrl()).replace(/\//g, '\\/');
  // M8: ikona Music Base (karta przeglądarki, skrót na ekranie głównym) i tryb aplikacji dla skrótu na telefonie
  return t.evaluate().setTitle('Music Base')
    .setFaviconUrl(IKONA_PANELU)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .addMetaTag('mobile-web-app-capable', 'yes')
    .addMetaTag('apple-mobile-web-app-capable', 'yes')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function bezpiecznie_(f) {
  try { return f(); } catch (e) { return { blad: String(e && e.message || e) }; }
}

// ---------------- dostęp do danych ----------------

var _PAM = {};
function folderGlowny_() {
  if (_PAM.fg) return _PAM.fg;
  var id = PropertiesService.getScriptProperties().getProperty('FOLDER_ID');
  if (id) { try { return (_PAM.fg = DriveApp.getFolderById(id)); } catch (e) { /* szukamy po nazwie */ } }
  var it = DriveApp.getFoldersByName(NAZWA_FOLDERU);
  if (!it.hasNext()) throw new Error('Nie znaleziono folderu „' + NAZWA_FOLDERU + '” na Dysku.');
  _PAM.fg = it.next();
  PropertiesService.getScriptProperties().setProperty('FOLDER_ID', _PAM.fg.getId());
  return _PAM.fg;
}
function folderAgg_() { return _PAM.fa || (_PAM.fa = podfolder(folderGlowny_(), FOLDER_AGG)); }
function folderPods_() { return _PAM.fp || (_PAM.fp = podfolder(folderAgg_(), 'v2')); }
function folderJ_(j) {
  _PAM.fj = _PAM.fj || {};
  if (_PAM.fj[j] === undefined) _PAM.fj[j] = podfolder(folderPods_(), j, false);
  return _PAM.fj[j];
}
function agg_(j, nazwa) {
  var klucz = j + '/' + nazwa;
  _PAM.agg = _PAM.agg || {};
  if (_PAM.agg[klucz] === undefined) _PAM.agg[klucz] = folderJ_(j) ? czytajGz(folderJ_(j), nazwa) : null;
  return _PAM.agg[klucz];
}
/**
 * Indeks stacji bez wykluczonych (WYKLUCZONE_STACJE w Wspolne.gs – np. RMF Dance usunięte 11.11.2026) i bez stacji,
 * które nie mają ani jednej doby z emisjami (ostatni = null; 12.11.2026: Planeta FM, RDN Małopolska – odSluchane nie
 * ma ich playlist). Gdy pojawią się dane, stacja wróci do panelu sama.
 */
function indeksStacji_() {
  if (_PAM.ind) return _PAM.ind;
  var ind = czytajJsonPlik(folderGlowny_(), 'indeks.json') || {}, w = {};
  Object.keys(ind).forEach(function (s) { if (!WYKLUCZONE_STACJE[s] && ind[s] && ind[s].ostatni) w[s] = ind[s]; });
  return (_PAM.ind = w);
}
/**
 * Metadane do list i analiz (rok, data, kraj, język, gatunki, wulgaryzmy, długość): plik lekki z Odbiornika
 * (_agg/metadane_lekkie.json.gz, ~1/5 pełnych). Pełne metadane jednego utworu – metadaneUtworu_ (paczka 1/16).
 * Pełnego indeksu utworów (~15 MB) ani pełnych metadanych (~6 MB) panel nie czyta – 14.11.2026 nie mieściły się
 * w limicie czasu i pamięci (Start, Ranking, wyszukiwarka bez wyniku).
 */
function metadane_() {
  if (_PAM.meta) return _PAM.meta;
  var l = czytajGz(folderAgg_(), 'metadane_lekkie.json.gz');
  _PAM.metaN = l ? l.n : 0;
  return (_PAM.meta = (l && l.u) || {});
}
function metadaneUtworu_(k) {
  var f = podfolder(folderAgg_(), 'metadane', false), p = f ? czytajGz(f, nazwaPaczki(paczkaUtworu(k))) : null;
  return (p && p[k]) || metadane_()[k] || {};
}
/** Pierwsza emisja i liczba emisji każdego utworu (znane.json.gz: posortowane 48-bitowe skróty kluczy, różnice). */
function znane_() {
  if (_PAM.zn !== undefined) return _PAM.zn;
  var z = agg_('_wszystkie', 'znane.json.gz');
  if (!z || !z.h) return (_PAM.zn = null);
  for (var i = 1; i < z.h.length; i++) z.h[i] += z.h[i - 1];
  z.baza0 = Date.parse(z.baza + 'T00:00:00Z');
  return (_PAM.zn = z);
}
/** {pierwsza: "RRRR-MM-DD", n: emisje w całej bazie}; null – utworu nie ma w indeksie; undefined – brak pliku znane. */
function znany_(k) {
  var z = znane_();
  if (!z) return undefined;
  var h = skrotKlucza(k), lo = 0, hi = z.h.length - 1;
  while (lo <= hi) {
    var s = (lo + hi) >> 1, v = z.h[s];
    if (v === h) return { pierwsza: new Date(z.baza0 + z.d[s] * 864e5).toISOString().slice(0, 10), n: z.e[s] };
    if (v < h) lo = s + 1; else hi = s - 1;
  }
  return null;
}
/** Paczka indeksu z utworami jednego wykonawcy (szybko: ~1/16 indeksu). */
function indeksPaczki_(k) {
  var n = nazwaPaczki(paczkaUtworu(k)), p = agg_('_wszystkie', 'indeks_' + n) || {}, a = agg_('_wszystkie', 'indeks_arch_' + n);
  if (!a) return p;
  var w = {};   // K6: kopia – agg_ trzyma paczki w pamięci wykonania
  Object.keys(a).forEach(function (x) { w[x] = a[x]; });
  Object.keys(p).forEach(function (x) { w[x] = p[x]; });
  return w;
}
function moje_() { return _PAM.moje || (_PAM.moje = czytajJsonPlik(folderAgg_(), 'moje.json') || {}); }

/**
 * Pamięć podręczna wyników (CacheService, do 6 h): spakowany JSON, jeśli mieści się w limicie 100 KB na wartość.
 * Klucz zawiera wersję danych (czas ostatniego przeliczenia), więc po nowych danych wynik liczy się od nowa.
 */
function zPamieci_(klucz, sekundy, f) {
  var c = CacheService.getScriptCache(), k = 'mb3:' + klucz.slice(0, 200);
  try {
    var z = c.get(k);
    if (z) return JSON.parse(Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(z), 'application/x-gzip')).getDataAsString('UTF-8'));
  } catch (e) { /* uszkodzony wpis – liczymy od nowa */ }
  var w = f();
  try {
    var b64 = Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(JSON.stringify(w), 'application/json')).getBytes());
    if (b64.length < 99000 && !(w && w.blad)) c.put(k, b64, sekundy);
  } catch (e) { /* za duże – bez pamięci */ }
  return w;
}
function nazwaJednostki_(j) {
  if (j === '_wszystkie') return 'Wszystkie stacje';
  return nazwaStacji(j, (indeksStacji_()[j] || {}).nazwa);
}

// ---------------- zakresy dat ----------------

function miesiaceZakresu_(od, doo) {
  var wynik = [], r = +od.slice(0, 4), m = +od.slice(5, 7);
  while (true) {
    var mm = r + '-' + ('0' + m).slice(-2);
    if (mm > doo.slice(0, 7)) break;
    wynik.push(mm);
    if (++m > 12) { m = 1; r++; }
  }
  return wynik;
}
function ostatniDzien_(mm) { return new Date(Date.UTC(+mm.slice(0, 4), +mm.slice(5, 7), 0)).getUTCDate(); }

/**
 * Liczby emisji utworów jednostki (albo '_wszystkie') w zakresie dat [od, do].
 * Pełne lata – z agregatu roku, pełne miesiące – z agregatu miesiąca, części miesięcy – z dni.
 * Zwraca {u: {k: [a, t, n, pierwsza "RRRR-MM-DD GG:MM"|null]}, emisji, dni: liczba dób z danymi}.
 */
function zbierz_(j, od, doo) {
  var wynik = { u: {}, emisji: 0, dni: 0 };
  var dodaj = function (k, a, t, n, pierwsza) {
    if (!n) return;
    var e = wynik.u[k];
    if (!e) e = wynik.u[k] = [a, t, 0, pierwsza];
    e[2] += n;
    if (pierwsza && (!e[3] || pierwsza < e[3])) e[3] = pierwsza;
    wynik.emisji += n;
  };
  var miesiace = miesiaceZakresu_(od, doo), i = 0;
  while (i < miesiace.length) {
    var mm = miesiace[i], r = mm.slice(0, 4);
    // cały rok w zakresie → agregat roku
    if (mm.slice(5) === '01' && od <= r + '-01-01' && doo >= r + '-12-31') {
      var ar = agg_(j, r + '.json.gz');
      if (ar) {
        Object.keys(ar.u).forEach(function (k) {
          var x = ar.u[k];
          dodaj(k, x[0], x[1], x[2], j === '_wszystkie' ? null : r + '-' + x[5]);
        });
        if (ar.mies) Object.keys(ar.mies).forEach(function (m2) { wynik.dni += ar.mies[m2].dni || 0; });
        i += 12;
        continue;
      }
    }
    var am = agg_(j, mm + '.json.gz');
    i++;
    if (!am) continue;
    var pocz = od.slice(0, 7) === mm ? +od.slice(8, 10) : 1;
    var kon = doo.slice(0, 7) === mm ? +doo.slice(8, 10) : ostatniDzien_(mm);
    var caly = pocz === 1 && kon === ostatniDzien_(mm);
    Object.keys(am.dni).forEach(function (d) { if (+d >= pocz && +d <= kon) wynik.dni++; });
    Object.keys(am.u).forEach(function (k) {
      var x = am.u[k], n = 0;
      if (caly) n = x[2];
      else Object.keys(x[3]).forEach(function (d) { if (+d >= pocz && +d <= kon) n += x[3][d]; });
      var pierwsza = j === '_wszystkie' ? null : (caly ? mm + '-' + x[5] : null);
      dodaj(k, x[0], x[1], n, pierwsza);
    });
  }
  return wynik;
}

function zbierzWiele_(jednostki, od, doo) {
  if (!jednostki || !jednostki.length) return zbierz_('_wszystkie', od, doo);
  var wynik = { u: {}, emisji: 0, dni: 0 };
  jednostki.forEach(function (j) {
    var z = zbierz_(j, od, doo);
    wynik.emisji += z.emisji;
    wynik.dni = Math.max(wynik.dni, z.dni);
    Object.keys(z.u).forEach(function (k) {
      var x = z.u[k], e = wynik.u[k];
      if (!e) e = wynik.u[k] = [x[0], x[1], 0, x[3]];
      e[2] += x[2];
      if (x[3] && (!e[3] || x[3] < e[3])) e[3] = x[3];
    });
  });
  return wynik;
}

function poprzedniOkres_(od, doo) {
  var d1 = new Date(od + 'T00:00:00Z'), d2 = new Date(doo + 'T00:00:00Z');
  var dni = Math.round((d2 - d1) / 864e5) + 1;
  var p2 = new Date(d1.getTime() - 864e5), p1 = new Date(d1.getTime() - dni * 864e5);
  return [p1.toISOString().slice(0, 10), p2.toISOString().slice(0, 10)];
}

function pasujeMeta_(m, p) {
  if (p.rokOd || p.rokDo) {
    if (!m || !m.y) return false;
    if (p.rokOd && m.y < +p.rokOd) return false;
    if (p.rokDo && m.y > +p.rokDo) return false;
  }
  if (p.kraj) {
    if (!m || !m.c) return false;
    // INT – zagraniczni (każdy znany kraj poza Polską); wcześniej porównanie z „INT” nie pasowało do żadnego utworu
    if (p.kraj === 'INT' ? m.c === 'PL' : m.c !== p.kraj) return false;
  }
  return true;
}

/** Gatunki z Songstera + „disco polo” potwierdzone w MusicBrainz / Wikidata (scraper/disco_polo.py). */
function gatunkiUtworu_(m) {
  var g = (m.g || []).slice();
  if (m.dp && g.indexOf('disco polo') < 0) g.unshift('disco polo');
  return g.length ? g : null;
}

function wierszUtworu_(k, x, meta) {
  var m = meta[k] || {};
  return { k: k, a: x[0], t: x[1], n: x[2], y: m.y || null, d: m.d || null, c: m.c || null, cc: m.cc || null, sp: m.sp || null, z: m.z || null, g: gatunkiUtworu_(m), j: m.j || null, dp: m.dp || null, w: m.w || null, bpm: m.bpm || null };
}

// ---------------- funkcje dla przeglądarki ----------------

/** Dane startowe: jednostki (sieci jako jedna pozycja), zakres danych, stan usług. */
function start() {
  return bezpiecznie_(function () {
    var ind = indeksStacji_(), jedn = {}, min = null, max = null;
    Object.keys(ind).forEach(function (s) {
      var x = ind[s];
      if (x.pierwszy && (!min || x.pierwszy < min)) min = x.pierwszy;
      if (x.ostatni && (!max || x.ostatni > max)) max = x.ostatni;
      var siec = siecStacji(s);
      var cz = { id: s, nazwa: nazwaJednostki_(s), pierwszy: x.pierwszy, ostatni: x.ostatni, dob: x.dob, zrodlo: x.zrodlo || 'odsluchane' };
      if (siec) {
        var j = jedn[siec] = jedn[siec] || { id: siec, nazwa: SIECI[siec].nazwa, typ: 'siec', czlonkowie: [], pierwszy: null, ostatni: null };
        j.czlonkowie.push(cz);
        if (x.pierwszy && (!j.pierwszy || x.pierwszy < j.pierwszy)) j.pierwszy = x.pierwszy;
        if (x.ostatni && (!j.ostatni || x.ostatni > j.ostatni)) j.ostatni = x.ostatni;
      } else {
        cz.typ = 'stacja';
        jedn[s] = cz;
      }
    });
    var lista = Object.keys(jedn).map(function (k) { return jedn[k]; })
      .filter(function (j) { return j.pierwszy; })
      .sort(function (a, b) { return a.nazwa.localeCompare(b.nazwa, 'pl'); });
    var dzis = Utilities.formatDate(new Date(), 'Europe/Warsaw', 'yyyy-MM-dd');
    return { jednostki: lista, od: min, do: max, dzis: dzis, spotify: spotifyStan(), moje: moje_(), adres: ScriptApp.getService().getUrl(), ramowki: Object.keys(ZRODLA_RAMOWEK), grupy: grupyStacji_(), infoStacji: infoStacji_() };
  });
}

/**
 * Ranking utworów albo wykonawców.
 * p = {jednostki: [id] (puste = wszystkie stacje), od, do, typ: 'utwory'|'wykonawcy', rokOd, rokDo, kraj: ''|'PL'|'INT', limit}
 */
function trendTygodniowy_(pozycje, jednostki, doo) {
  var kon = Date.parse(doo + 'T12:00:00Z'), pocz = kon - 55 * 864e5, chce = {};
  pozycje.forEach(function (x) { chce[x.k] = x; x.trend = [0, 0, 0, 0, 0, 0, 0, 0]; });
  var od = new Date(pocz).toISOString().slice(0, 10);
  (jednostki && jednostki.length ? jednostki : ['_wszystkie']).forEach(function (j) {
    miesiaceZakresu_(od, doo).forEach(function (m) {
      var a = agg_(j, m + '.json.gz');
      if (!a) return;
      Object.keys(a.u).forEach(function (k) {
        var x = chce[k];
        if (!x) return;
        Object.keys(a.u[k][3]).forEach(function (d) {
          var t = Date.parse(m + '-' + d + 'T12:00:00Z'), i = Math.floor((t - pocz) / (7 * 864e5));
          if (i >= 0 && i < 8) x.trend[i] += a.u[k][3][d];
        });
      });
    });
  });
}
var PRESETY_RANKINGU_ = { '7': 7, '30': 30, '90': 90, '365': 365, rok: 'rok', wszystko: 'wszystko' };
/** Nazwa gotowego rankingu dla okresu: przycisk okresu (p.preset) albo okres równy jednemu z nich (link, Spotify). */
function presetRankingu_(p) {
  if (PRESETY_RANKINGU_[String(p.preset)]) return String(p.preset);
  var kon = ostatniDzienDanych_();
  if (!kon || p.do !== kon) return null;
  var w = null;
  [7, 30, 90, 365].forEach(function (L) { if (p.od === dataPlus_(kon, -(L - 1))) w = String(L); });
  if (!w && p.od === kon.slice(0, 4) + '-01-01') w = 'rok';
  return w;
}
/**
 * Ranking wszystkich stacji z gotowego zestawienia Odbiornika (ranking_<okres>.json.gz): 3000 utworów i 1000 wykonawców
 * w wariantach wszyscy / polscy / zagraniczni, z miejscem w poprzednim okresie. Filtr roku wydania i „tylko ulubione”
 * – z tych 3000 utworów; gdy lista mogła się skrócić, wynik ma przyblizony: true.
 */
function rankingGotowy_(p, limit) {
  var nazwa = presetRankingu_(p);
  if (!nazwa) return null;
  var r = agg_('_wszystkie', 'ranking_' + nazwa + '.json.gz');
  if (!r || !r.w) return null;
  var v = r.w[p.kraj === 'PL' ? 'PL' : p.kraj === 'INT' ? 'INT' : ''];
  if (!v) return null;
  var rokOd = +p.rokOd || 0, rokDo = +p.rokDo || 0, rokF = !!(rokOd || rokDo), ulub = p.tylkoUlubione ? (moje_().ulubioneUtwory || {}) : null;
  var info = function (k) { return r.s[k] || [k.split('|')[0], k.split('|')[1], null, null]; };
  var pasujeRok = function (y) { return !rokF || !!(y && (!rokOd || y >= rokOd) && (!rokDo || y <= rokDo)); };
  var pelna = v.u.length >= v.n, pelnaP = v.p.length >= v.pn, min = v.u.length ? v.u[v.u.length - 1][1] : 0;
  var wiersz = function (x) {
    var s = info(x[0]), m = s[2] || {};
    var w = { k: x[0], a: s[0], t: s[1], n: x[1], y: m.y || null, d: m.d || null, c: m.c || null, cc: m.cc || null, sp: m.sp || null,
      z: m.z || null, g: gatunkiUtworu_(m), j: m.j || null, dp: m.dp || null, w: m.w || null, bpm: m.bpm || null, pierwsza: null };
    if (s[3]) w.trend = s[3];
    return w;
  };
  var rokT = p.porownanie === 'rok' && r.rokTemu;   // O3: zmiana miejsca wobec tego samego okresu rok temu
  var wynik = { emisji: r.emisji, dni: r.dni, poprzedniOkres: rokT ? r.rokTemu : r.pop, emisjiPoprzednio: rokT ? r.emisjiRokTemu : r.emisjiPoprzednio, od: r.od, do: r.do, gotowy: r.zbudowano, porownanie: rokT ? 'rok' : 'poprzedni' };
  if (p.porownanie === 'rok' && !r.rokTemu) wynik.bezRokuTemu = true;
  var f = v.u.filter(function (x) { return pasujeRok((info(x[0])[2] || {}).y) && (!ulub || ulub[x[0]]); });
  if (p.typ === 'wykonawcy') {
    if (!rokF && !ulub) {
      wynik.pozycje = v.a.slice(0, limit).map(function (x, i) { return { k: x[0], a: x[1], n: x[2], utworow: x[3], top: [x[4], x[5], x[6]], miejsce: i + 1, poprzednio: rokT ? null : x[7] }; });
      wynik.wszystkich = v.nw;
      return wynik;
    }
    // z filtrem: wykonawcy z listy utworów okresu (przybliżenie, chyba że lista okresu jest w pliku w całości)
    var zlicz = function (lista, czyRok) {
      var w = {};
      lista.forEach(function (x) {
        var wk = x[0].split('|')[0], s = info(x[0]), e = w[wk] || (w[wk] = { k: wk, a: String(s[0]).split(/\s+(?:\/|&|feat\.?|ft\.?|x)\s+/i)[0], n: 0, utworow: 0, top: null });
        e.n += x[1]; e.utworow++;
        if (!e.top || x[1] > e.top[1]) e.top = [s[1], x[1], x[0]];
      });
      return Object.keys(w).map(function (k) { return w[k]; }).sort(function (a, b) { return b.n - a.n || a.a.localeCompare(b.a, 'pl'); });
    };
    var akt = zlicz(f), stare = zlicz(v.p.filter(function (x) { return pasujeRok(x[2]); })), mS = {};
    stare.forEach(function (x, i) { mS[x.k] = i + 1; });
    akt.forEach(function (x, i) { x.miejsce = i + 1; x.poprzednio = mS[x.k] || null; });
    wynik.pozycje = akt.slice(0, limit);
    wynik.wszystkich = akt.length;
    if (!(pelna && pelnaP)) { wynik.przyblizony = true; wynik.zListy = v.u.length; }
    return wynik;
  }
  var mP = null, ileP = 0;
  if (rokF) { mP = {}; v.p.forEach(function (x) { if (pasujeRok(x[2])) mP[x[0]] = ++ileP; }); }
  var bezF = !rokF && !ulub;
  wynik.pozycje = (bezF ? v.u : f).slice(0, limit).map(function (x, i) {
    var w = wiersz(x);
    w.miejsce = i + 1;
    if (rokT) w.poprzednio = mP ? null : (x[4] || null);
    else if (!mP) w.poprzednio = x[2];
    else if (mP[x[0]]) w.poprzednio = mP[x[0]];
    else { w.poprzednio = null; if (x[3] > 0 && !pelnaP) w.poprzednioPoza = ileP; }   // grany wcześniej, ale poza listą
    return w;
  });
  if (bezF) wynik.wszystkich = v.n;
  else {
    var ost = wynik.pozycje.length ? wynik.pozycje[wynik.pozycje.length - 1].n : 0;
    wynik.wszystkich = f.length;
    if (!pelna && (wynik.pozycje.length < limit || ost <= min)) { wynik.przyblizony = true; wynik.zListy = v.u.length; }
  }
  return wynik;
}
function ranking(p) {
  return bezpiecznie_(function () {
    var limit = Math.min(+p.limit || 100, 1000);
    if (!(p.jednostki && p.jednostki.length)) {
      var gotowy = p.naZywo ? null : rankingGotowy_(p, limit);   // naZywo: bez gotowego zestawienia (testy)
      if (gotowy) return gotowy;
      // wszystkie stacje na żywo czytają pliki miesięcy całego radia (kilka MB każdy) – tylko krótkie okresy
      if (Math.round((Date.parse(p.do) - Date.parse(p.od)) / 864e5) + 1 > 35)
        return { blad: 'Ranking wszystkich stacji dla tego okresu liczy się z gotowego zestawienia, a tego jeszcze nie ma (powstaje w Odbiorniku przy przeliczaniu, zwykle do godziny po aktualizacji). Wybierz okres przyciskiem (7 dni … Wszystko), okres do 35 dni albo konkretne stacje.' };
    }
    var meta = metadane_();
    var teraz = zbierzWiele_(p.jednostki, p.od, p.do);
    var pop = p.porownanie === 'rok' ? [dataPlus_(p.od, -364), dataPlus_(p.do, -364)] : poprzedniOkres_(p.od, p.do);   // O3
    var wczesniej = zbierzWiele_(p.jednostki, pop[0], pop[1]);
    var pozycje = function (zb, filtr) {
      var lista = [];
      if (p.typ === 'wykonawcy') {
        var w = {};
        Object.keys(zb.u).forEach(function (k) {
          if (filtr && !pasujeMeta_(meta[k], p)) return;
          var x = zb.u[k], wk = k.split('|')[0];
          var e = w[wk] = w[wk] || { k: wk, a: String(x[0]).split(/\s+(?:\/|&|feat\.?|ft\.?|x)\s+/i)[0], n: 0, utworow: 0, top: null };
          e.n += x[2];
          e.utworow++;
          if (!e.top || x[2] > e.top[1]) e.top = [x[1], x[2], k];
        });
        lista = Object.keys(w).map(function (k) { return w[k]; });
      } else {
        lista = Object.keys(zb.u).filter(function (k) { return !filtr || pasujeMeta_(meta[k], p); })
          .map(function (k) { var r = wierszUtworu_(k, zb.u[k], meta); r.pierwsza = zb.u[k][3]; return r; });
      }
      lista.sort(function (a, b) { return b.n - a.n || a.a.localeCompare(b.a, 'pl'); });
      return lista;
    };
    if (p.tylkoUlubione) {
      var ul = moje_().ulubioneUtwory || {};
      Object.keys(teraz.u).forEach(function (k) { if (!ul[k]) delete teraz.u[k]; });
    }
    var akt = pozycje(teraz, true), stare = pozycje(wczesniej, true), miejscaStare = {};
    stare.forEach(function (x, i) { miejscaStare[x.k] = i + 1; });
    akt.forEach(function (x, i) { x.miejsce = i + 1; x.poprzednio = miejscaStare[x.k] || null; });
    var wynikowe = akt.slice(0, limit);
    // R1: emisje w 8 kolejnych tygodniach kończących się na końcu okresu (dzienne dane z plików miesięcy; utwory)
    if (p.typ !== 'wykonawcy' && (Date.parse(p.do) - Date.parse(p.od)) / 864e5 <= 93) trendTygodniowy_(wynikowe, p.jednostki, p.do);
    return {
      pozycje: wynikowe, wszystkich: akt.length, emisji: teraz.emisji, dni: teraz.dni,
      poprzedniOkres: pop, emisjiPoprzednio: wczesniej.emisji,
    };
  });
}

/**
 * Wyszukiwarka utworów: 50 000 najczęściej granych (szukaj_utwory.json.gz z Odbiornika) – szybko; opcje.calaBaza –
 * cała baza z 16 paczek indeksu po kolei (wolniej, bez trzymania całego indeksu w pamięci).
 */
function szukaj(q, opcje) {
  return bezpiecznie_(function () {
    var slowa = tytulKlucz(q).split(' ').filter(Boolean);
    if (!slowa.length) return { wyniki: [] };
    var pasuje = function (k) { var tekst = k.replace('|', ' '); return slowa.every(function (s) { return tekst.indexOf(s) >= 0; }); };
    var z = opcje && opcje.calaBaza ? null : agg_('_wszystkie', 'szukaj_utwory.json.gz'), wyniki = [];
    if (z && z.u) {
      z.u.forEach(function (x) { if (pasuje(x[0])) wyniki.push({ k: x[0], a: x[1], t: x[2], n: x[3], pierwsza: x[4], ostatni: x[5], stacji: x[6], y: x[7], z: x[8], c: x[9], w: x[10] }); });
      return { wyniki: wyniki.slice(0, 500), wszystkich: wyniki.length, przeszukano: z.u.length, wBazie: z.n };
    }
    var meta = metadane_(), fw = folderJ_('_wszystkie');
    for (var i = 0; i < PACZEK_UTWOROW; i++) {
      var p = paczkaIndeksuPelna(fw, i);
      Object.keys(p).forEach(function (k) {
        if (!pasuje(k)) return;
        var x = p[k], m = meta[k] || {};
        wyniki.push({ k: k, a: x[0], t: x[1], n: x[2], pierwsza: x[3], ostatni: x[4], stacji: x[5], y: m.y || null, z: m.z || null, c: m.c || null, w: m.w || null });
      });
    }
    wyniki.sort(function (a, b) { return b.n - a.n; });
    return { wyniki: wyniki.slice(0, 500), wszystkich: wyniki.length, calaBaza: true };
  });
}

/**
 * Profil utworu: dane z paczki indeksu (szybko), metadane, inne wersje tego wykonawcy, dzisiejsze emisje, moje oznaczenia.
 * Wszystkie emisje dociąga osobno emisjeUtworu (rok po roku, równolegle z przeglądarki).
 */
function profilUtworu(k) {
  return bezpiecznie_(function () {
    var paczka = indeksPaczki_(k), x = paczka[k];
    if (!x) return { blad: 'Nie ma tego utworu w indeksie utworów. Po imporcie historii indeks jest budowany automatycznie (zadania w GitHubie) – profile utworów, wyszukiwarka i Ranking pojawią się, gdy powstanie; potem nowe utwory dochodzą najpóźniej po ok. 1,5–3 h.' };
    var baza = function (t) { return tytulKlucz(String(t).replace(/\b(radio edit|extended|remix|rmx|mix|edit|version|wersja|live|acoustic|akustycznie|remaster(ed)?|\d{4} remaster)\b/gi, ' ')).replace(/\s+/g, ' ').trim(); };
    var mojaBaza = baza(x[1]), wyk = k.split('|')[0];
    var wersje = Object.keys(paczka).filter(function (k2) { return k2 !== k && k2.split('|')[0] === wyk && baza(paczka[k2][1]) === mojaBaza; })
      .map(function (k2) { return { k: k2, a: paczka[k2][0], t: paczka[k2][1], n: paczka[k2][2] }; });
    var innych = Object.keys(paczka).filter(function (k2) { return k2.split('|')[0] === wyk && k2 !== k; })
      .map(function (k2) { return { k: k2, t: paczka[k2][1], n: paczka[k2][2] }; }).sort(function (p, q) { return q.n - p.n; }).slice(0, 12);
    var dzis = czytajJsonPlik(folderAgg_(), 'dzis.json') || {}, dzisiaj = [];
    Object.keys(dzis.stacje || {}).forEach(function (s) {
      Object.keys(dzis.stacje[s]).forEach(function (o) {
        dzis.stacje[s][o].forEach(function (w) { if (kluczUtworu(w.a, w.t) === k) dzisiaj.push({ g: w.g, s: s, d: dzis.data }); });
      });
    });
    var m = moje_();
    return {
      k: k, a: x[0], t: x[1], n: x[2], pierwsza: x[3], ostatni: x[4], stacji: x[5], lata: x[6] || [], miesiace: x[7] || [],
      meta: metadaneUtworu_(k), wersje: wersje, inneUtwory: innych, dzis: dzisiaj,
      spotifyCache: (spotifyCache_()[k] || null),
      moje: { ulubiony: !!(m.ulubioneUtwory || {})[k], tagi: (m.tagi || {})[k] || [], notatka: (m.notatki || {})[k] || '' },
      nazwy: nazwyStacji_(),
    };
  });
}

/** Nazwy wszystkich stacji i sieci (dla list emisji). */
function nazwyStacji_() {
  var w = {};
  Object.keys(indeksStacji_()).forEach(function (s) { w[s] = nazwaJednostki_(s); });
  Object.keys(SIECI).forEach(function (s) { w[s] = SIECI[s].nazwa; });
  return w;
}

/** Wszystkie emisje utworu w podanych miesiącach: {"RRRR-MM": {stacja: ["DD GG:MM", …]}}. */
function emisjeUtworu(k, miesiace) {
  return bezpiecznie_(function () {
    var wynik = {}, fu = folderJ_('_utwory'), nazwa = nazwaPaczki(paczkaUtworu(k));
    (miesiace || []).forEach(function (m) {
      var f = fu && podfolder(fu, m, false);
      var p = f && czytajGz(f, nazwa);
      if (p && p[k]) wynik[m] = p[k].s;
    });
    return { emisje: wynik };
  });
}

/**
 * Najlepsze tygodnie utworu w rankingu całego radia (tydzień = poniedziałek–niedziela) w latach jego emisji (do 3 lat):
 * z gotowych list 300 najczęściej granych w każdym tygodniu (tygodnie_RRRR.json.gz z Odbiornika). Miejsce = 1 + liczba
 * utworów z większą liczbą emisji w tym tygodniu (remis – to samo miejsce). Tygodnie poza pierwszą 300 nie są znane.
 */
function najlepszeMiejsca(k, miesiace) {
  return bezpiecznie_(function () {
    var lata = {};
    (miesiace || []).slice(-36).forEach(function (m) { lata[String(m).slice(0, 4)] = 1; });
    var wynik = [], top = 300;
    Object.keys(lata).sort().forEach(function (r) {
      var t = agg_('_wszystkie', 'tygodnie_' + r + '.json.gz');
      if (!t || !t.w) return;
      Object.keys(t.w).sort().forEach(function (pn) {
        var w = t.w[pn], n = 0, wiecej = 0;
        top = Math.max(top, w.u.length);
        for (var i = 0; i < w.u.length; i++) if (w.u[i][0] === k) { n = w.u[i][1]; break; }
        if (!n) return;
        w.u.forEach(function (x) { if (x[1] > n) wiecej++; });
        wynik.push({ tydzien: pn, n: n, miejsce: wiecej + 1, utworow: w.n });
      });
    });
    return { tygodnie: wynik, najlepsze: wynik.slice().sort(function (p, q) { return p.miejsce - q.miejsce || q.n - p.n; })[0] || null,
      wTop10: wynik.filter(function (x) { return x.miejsce <= 10; }).length, zTop: top };
  });
}

/**
 * Podobne utwory: podobny rozkład emisji między stacjami w tym samym roku (kosinus), bez danych Spotify – wśród
 * 20 000 najczęściej granych utworów roku (podobne_RRRR.json.gz z Odbiornika).
 */
function podobneUtwory(k, rok) {
  return bezpiecznie_(function () {
    var g = agg_('_wszystkie', 'podobne_' + rok + '.json.gz');
    if (!g || !g.u) return { podobne: [], info: 'Podobne utwory pojawią się po przeliczeniu roku ' + rok + ' w Odbiorniku.' };
    var ja = null;
    for (var i = 0; i < g.u.length; i++) if (g.u[i][0] === k) { ja = g.u[i]; break; }
    if (!ja) return { podobne: [], info: 'Podobne utwory są liczone dla ' + g.u.length + ' najczęściej granych utworów roku ' + rok + '.' };
    var v = ja[4], nv = Math.sqrt(Object.keys(v).reduce(function (s, j) { return s + v[j] * v[j]; }, 0)), wyk = k.split('|')[0];
    var wynik = g.u.filter(function (x) { return x[0] !== k && x[3] >= 10 && x[0].split('|')[0] !== wyk; }).map(function (x) {
      var w = x[4], il = 0, nw = 0;
      Object.keys(w).forEach(function (j) { nw += w[j] * w[j]; if (v[j]) il += v[j] * w[j]; });
      return { k: x[0], a: x[1], t: x[2], n: x[3], pod: il / (nv * Math.sqrt(nw) || 1), y: x[5] || null };
    }).sort(function (p, q) { return q.pod - p.pod; }).slice(0, 50);
    return { podobne: wynik };
  });
}

/**
 * Profil stacji albo sieci w zakresie dat: liczby, rotacja, godziny, nowości; dla sieci – stacje osobno
 * i udział wspólnego programu (emisje stacji ponad emisje sieci = powtórzenia we wspólnych pasmach).
 */
function profilJednostki(j, od, doo) {
  return bezpiecznie_(function () {
    var meta = metadane_(), z = zbierz_(j, od, doo);
    var lista = Object.keys(z.u).map(function (k) { return wierszUtworu_(k, z.u[k], meta); }).sort(function (a, b) { return b.n - a.n; });
    var suma = function (arr) { return arr.reduce(function (s, x) { return s + x.n; }, 0); };
    var top20 = suma(lista.slice(0, 20)), top100 = suma(lista.slice(0, 100));
    var hw = {};
    miesiaceZakresu_(od, doo).forEach(function (mm) {
      var am = agg_(j, mm + '.json.gz');
      if (am) Object.keys(am.u).forEach(function (k) { var x = am.u[k][4]; Object.keys(x).forEach(function (h) { hw[h] = (hw[h] || 0) + x[h]; }); });
    });
    var zLatami = lista.filter(function (x) { return x.y; });
    var srRok = zLatami.length ? Math.round(zLatami.reduce(function (s, x) { return s + x.y * x.n; }, 0) / zLatami.reduce(function (s, x) { return s + x.n; }, 0)) : null;
    var pl = lista.filter(function (x) { return x.c === 'PL'; }), zKrajem = lista.filter(function (x) { return x.c; });
    var wynik = {
      id: j, nazwa: nazwaJednostki_(j), od: od, do: doo, emisji: z.emisji, dni: z.dni, utworow: lista.length,
      top: lista.slice(0, 300), udzialTop20: z.emisji ? top20 / z.emisji : 0, udzialTop100: z.emisji ? top100 / z.emisji : 0,
      hw: hw, sredniRokWydania: srRok,
      udzialPL: zKrajem.length ? suma(pl) / suma(zKrajem) : null, pokrycieKraju: z.emisji ? suma(zKrajem) / z.emisji : 0,
      nowe: lista.filter(function (x) { var i = znany_(x.k); return i && i.pierwsza >= od; }).slice(0, 200),
    };
    // O3: ten sam okres rok temu
    var zr = zbierz_(j, dataPlus_(od, -364), dataPlus_(doo, -364)), lr = Object.keys(zr.u);
    var plR = lr.filter(function (k) { return (meta[k] || {}).c === 'PL'; }), zkR = lr.filter(function (k) { return (meta[k] || {}).c; });
    wynik.rokTemu = zr.emisji ? { od: dataPlus_(od, -364), do: dataPlus_(doo, -364), emisji: zr.emisji, utworow: lr.length,
      udzialPL: zkR.length ? plR.reduce(function (s, k) { return s + zr.u[k][2]; }, 0) / zkR.reduce(function (s, k) { return s + zr.u[k][2]; }, 0) : null } : null;
    if (SIECI[j]) {
      wynik.czlonkowie = SIECI[j].czlonkowie.map(function (s) {
        var zs = zbierz_(s, od, doo);
        return { id: s, nazwa: nazwaJednostki_(s), emisji: zs.emisji, utworow: Object.keys(zs.u).length };
      });
      var sumaStacji = wynik.czlonkowie.reduce(function (s, x) { return s + x.emisji; }, 0);
      wynik.wspolnePowtorzenia = sumaStacji - z.emisji;
    }
    return wynik;
  });
}

/** Porównanie stacji: wspólne utwory, unikalne, podobieństwo par, udział polskich, kto zagrał pierwszy. */
function porownaj(jednostki, od, doo) {
  return bezpiecznie_(function () {
    if (!jednostki || jednostki.length < 2) return { blad: 'Wybierz co najmniej dwie stacje.' };
    var meta = metadane_(), dane = {};
    jednostki.forEach(function (j) { dane[j] = zbierz_(j, od, doo); });
    var wszystkie = {};
    jednostki.forEach(function (j) { Object.keys(dane[j].u).forEach(function (k) { wszystkie[k] = (wszystkie[k] || 0) + 1; }); });
    var wspolne = Object.keys(wszystkie).filter(function (k) { return wszystkie[k] === jednostki.length; });
    var podsum = jednostki.map(function (j) {
      var u = dane[j].u, klucze = Object.keys(u);
      var unikalne = klucze.filter(function (k) { return wszystkie[k] === 1; });
      var zKrajem = 0, pl = 0, lata = 0, zRokiem = 0;
      klucze.forEach(function (k) {
        var m = meta[k];
        if (m && m.c) { zKrajem += u[k][2]; if (m.c === 'PL') pl += u[k][2]; }
        if (m && m.y) { lata += m.y * u[k][2]; zRokiem += u[k][2]; }
      });
      return {
        id: j, nazwa: nazwaJednostki_(j), emisji: dane[j].emisji, utworow: klucze.length, unikalnych: unikalne.length,
        udzialPL: zKrajem ? pl / zKrajem : null, sredniRok: zRokiem ? Math.round(lata / zRokiem) : null,
        topUnikalne: unikalne.sort(function (a, b) { return u[b][2] - u[a][2]; }).slice(0, 100).map(function (k) { return wierszUtworu_(k, u[k], meta); }),
      };
    });
    var pary = [];
    for (var i = 0; i < jednostki.length; i++) for (var j2 = i + 1; j2 < jednostki.length; j2++) {
      var a = Object.keys(dane[jednostki[i]].u), b = dane[jednostki[j2]].u;
      var cz = a.filter(function (k) { return b[k]; }).length;
      pary.push({ a: jednostki[i], b: jednostki[j2], wspolnych: cz, jaccard: cz / (a.length + Object.keys(b).length - cz || 1) });
    }
    var wspolneLista = wspolne.map(function (k) {
      var n = 0, pierwszy = null;
      jednostki.forEach(function (j) {
        var x = dane[j].u[k];
        n += x[2];
        if (x[3] && (!pierwszy || x[3] < pierwszy.d)) pierwszy = { j: nazwaJednostki_(j), d: x[3] };
      });
      var r = wierszUtworu_(k, [dane[jednostki[0]].u[k][0], dane[jednostki[0]].u[k][1], n], meta);
      r.pierwszy = pierwszy;
      r.naStacjach = jednostki.map(function (j) { return dane[j].u[k][2]; });
      return r;
    }).sort(function (a, b) { return b.n - a.n; });
    return { stacje: podsum, pary: pary, wspolnych: wspolne.length, wspolne: wspolneLista.slice(0, 50) };
  });
}

/** Dzisiejsze emisje: ostatnie utwory każdej jednostki (sieci bez powtórzeń wspólnych pasm). */
/** S2: dzisiejsze emisje wybranych (ulubionych) stacji – najczęściej grane, pierwszy raz w bazie, udział polskich. */
function dzisNaStacjach(stacje) {
  return bezpiecznie_(function () {
    var d = czytajJsonPlik(folderAgg_(), 'dzis.json') || {}, chce = {};
    (stacje || []).forEach(function (j) { chce[j] = 1; (SIECI[j] ? SIECI[j].czlonkowie : []).forEach(function (s) { chce[s] = 1; }); });
    var zn = znane_(), meta = metadane_(), u = {}, nowe = {}, emisji = 0, zKrajem = 0, pl = 0, ileSt = {};
    Object.keys(d.stacje || {}).forEach(function (s) {
      if (!chce[s] && !chce[siecStacji(s)]) return;
      Object.keys(d.stacje[s]).forEach(function (o) {
        d.stacje[s][o].forEach(function (w) {
          if (!czyPiosenka(w.a, w.t)) return;
          var k = kluczUtworu(w.a, w.t), x = u[k] = u[k] || { k: k, a: w.a, t: w.t, n: 0, st: {} };
          x.n++; x.st[s] = 1; emisji++; ileSt[s] = 1;
          var m = meta[k] || {};
          if (m.c) { zKrajem++; if (m.c === 'PL') pl++; }
          var i = zn ? znany_(k) : undefined;
          if (zn && (!i || i.pierwsza >= d.data) && (!nowe[k] || w.g < nowe[k].g)) nowe[k] = { k: k, a: w.a, t: w.t, g: w.g, s: s };
        });
      });
    });
    var top = Object.keys(u).map(function (k) { var x = u[k]; return { k: k, a: x.a, t: x.t, n: x.n, stacji: Object.keys(x.st).length, y: (meta[k] || {}).y || null, c: (meta[k] || {}).c || null }; })
      .sort(function (a, b) { return b.n - a.n; });
    return { data: d.data || null, emisji: emisji, utworow: top.length, stacje: Object.keys(ileSt), udzialPL: zKrajem ? pl / zKrajem : null, pokrycie: emisji ? zKrajem / emisji : 0,
      top: top.slice(0, 200), nowe: zn ? Object.keys(nowe).map(function (k) { return nowe[k]; }).sort(function (a, b) { return a.g < b.g ? 1 : -1; }).slice(0, 200) : null };
  });
}

function dzis() {
  return bezpiecznie_(function () {
    var d = czytajJsonPlik(folderAgg_(), 'dzis.json') || {};
    var wgJedn = {};
    Object.keys(d.stacje || {}).forEach(function (s) {
      var j = siecStacji(s) || s, rows = [];
      Object.keys(d.stacje[s]).forEach(function (o) { d.stacje[s][o].forEach(function (w) { rows.push({ d: d.data, g: w.g, a: w.a, t: w.t }); }); });
      (wgJedn[j] = wgJedn[j] || {})[s] = rows;
    });
    var wynik = Object.keys(wgJedn).map(function (j) {
      var wiersze = SIECI[j] ? scalSiec(wgJedn[j]) : wgJedn[j][j].filter(function (w) { return czyPiosenka(w.a, w.t); });
      wiersze.sort(function (a, b) { return a.g < b.g ? 1 : -1; });
      return { id: j, nazwa: nazwaJednostki_(j), emisji: wiersze.length, ostatnie: wiersze.slice(0, 12).map(function (w) { return { g: w.g, a: w.a, t: w.t, k: kluczUtworu(w.a, w.t) }; }) };
    }).sort(function (a, b) { return a.nazwa.localeCompare(b.nazwa, 'pl'); });
    var utwory = {};
    wynik.forEach(function (j) { j.ostatnie.forEach(function (w) { (utwory[w.k] = utwory[w.k] || { a: w.a, t: w.t, k: w.k, stacji: 0 }).stacji++; }); });
    return { data: d.data || null, jednostki: wynik };
  });
}

// ---------------- alerty ----------------

function alerty() {
  return bezpiecznie_(function () {
    var u = czytajJsonPlik(folderAgg_(), 'ustawienia.json') || {};
    return { alerty: u.alerty || [], email: Session.getEffectiveUser().getEmail() };
  });
}
function zapiszAlerty(lista) {
  return bezpiecznie_(function () {
    var fa = folderAgg_(), u = czytajJsonPlik(fa, 'ustawienia.json') || {};
    u.alerty = (lista || []).map(function (a) {
      // typy dzienne (N3) mają klucz zaczynający się od „_” – kolektor (Odbiornik) nigdy ich nie dopasuje do emisji
      if (a.typ === 'top10' || a.typ === 'debiut3') return { id: a.id || Utilities.getUuid(), typ: a.typ, klucz: '_' + a.typ, opis: a.opis || a.typ, stacje: a.stacje || [] };
      if (a.typ === 'powrot') {
        var kp = a.tekst ? (wykonawcyKlucz(a.tekst)[0] || '') : (a.klucz || '_powrot');
        return { id: a.id || Utilities.getUuid(), typ: 'powrot', klucz: kp, opis: a.opis || 'Powrót wykonawcy', stacje: [] };
      }
      var klucz = a.typ === 'utwor' ? a.klucz : (wykonawcyKlucz(a.tekst || a.klucz)[0] || '');
      return { id: a.id || Utilities.getUuid(), typ: a.typ === 'utwor' ? 'utwor' : 'wykonawca', klucz: klucz, opis: a.opis || a.tekst || klucz, stacje: a.stacje || [] };
    }).filter(function (a) { return a.klucz; });
    zapiszJsonPlik(fa, 'ustawienia.json', u);
    return { alerty: u.alerty };
  });
}

// ---------------- eksport dla Apple Music ----------------

/** Plik CSV (Tytuł, Wykonawca) w folderze „Music Base – eksporty” – do importu w konwerterze playlist. */
function eksportApple(nazwa, wiersze) {
  return bezpiecznie_(function () {
    var f = podfolder(DriveApp.getRootFolder(), 'Music Base – eksporty');
    var esc = function (s) { return '"' + String(s).replace(/"/g, '""') + '"'; };
    var csv = 'Title,Artist\n' + wiersze.map(function (w) { return esc(w.t) + ',' + esc(w.a); }).join('\n') + '\n';
    var plik = f.createFile(Utilities.newBlob(csv, 'text/csv', (nazwa || 'playlista').replace(/[\\/:*?"<>|]/g, '-') + '.csv'));
    return { url: plik.getUrl(), tekst: wiersze.map(function (w) { return w.a + ' - ' + w.t; }).join('\n') };
  });
}

/** Wstawia treść pliku HTML projektu (moduły skryptów panelu). */
/**
 * F6: kilka lekkich zapytań panelu w jednym wykonaniu (wspólny odczyt plików z Dysku). Tylko funkcje z listy;
 * każda zwraca swój wynik albo {blad}.
 */
function pakiet(lista) {
  // mapa tworzona przy wywołaniu: pliki .gs wczytują się po kolei, a część funkcji jest w Analizy.gs
  var dozwolone = { profilJednostki: profilJednostki, zmianyJednostki: zmianyJednostki, naTleRynku: naTleRynku, jakoscDanych: jakoscDanych,
    wyrozniki: wyrozniki, podobneStacje: podobneStacje, profilUtworu: profilUtworu, najlepszeMiejsca: najlepszeMiejsca, podobneUtwory: podobneUtwory };
  return (lista || []).slice(0, 12).map(function (z) {
    var f = dozwolone[z && z[0]];
    if (!f) return { blad: 'Nieznane zapytanie: ' + (z && z[0]) };
    try { return f.apply(null, z[1] || []); } catch (e) { return { blad: e.message }; }
  });
}

function include(nazwa) {
  return HtmlService.createHtmlOutputFromFile(nazwa).getContent();
}

// ---------------- Z2: profil wykonawcy ----------------

/**
 * Wykonawca (klucz jak w kluczu utworu – pierwszy wykonawca, bez polskich znaków): utwory, w których jest pierwszym
 * wykonawcą (paczka indeksu tego wykonawcy) albo gościem (goscie_sNN.json.gz); emisje na stacjach i w miesiącach
 * z plików wykonawców lat całego radia (wykonawcy/RRRR_sNN.json.gz). Pamięć serwera 6 h.
 */
function profilWykonawcy(wk) {
  return bezpiecznie_(function () {
    wk = String(wk || '').trim();
    if (!wk) return { blad: 'Brak wykonawcy.' };
    return zPamieci_('wykonawca2|' + wk, 21600, function () {
      var paczka = indeksPaczki_(wk + '|'), meta = metadane_(), nazwa = nazwaPaczki(paczkaUtworu(wk));
      var wiersz = function (k, x) { var m = meta[k] || {}; return { k: k, a: x[0], t: x[1], n: x[2], pierwsza: x[3], ostatni: x[4], stacji: x[5], y: m.y || null, c: m.c || null }; };
      var utwory = Object.keys(paczka).filter(function (k) { return k.split('|')[0] === wk; }).map(function (k) { return wiersz(k, paczka[k]); });
      var gp = agg_('_wszystkie', 'goscie_' + nazwa), gosc = ((gp && gp[wk]) || []).map(function (x) { return wiersz(x[0], x.slice(1)); });
      if (!utwory.length && !gosc.length) return { blad: 'Nie ma takiego wykonawcy w indeksie utworów.' };
      utwory.sort(function (a, b) { return b.n - a.n; });
      gosc.sort(function (a, b) { return b.n - a.n; });
      var stacje = {}, mies = {}, fw = folderJ_('_wszystkie'), fwy = fw && podfolder(fw, 'wykonawcy', false), lata = [];
      if (fwy) { var it = fwy.getFiles(); while (it.hasNext()) { var f = it.next(), n = f.getName(); if (!f.isTrashed() && n.slice(5) === nazwa && /^\d{4}_/.test(n) && lata.indexOf(n.slice(0, 4)) < 0) lata.push(n.slice(0, 4)); } }
      lata.sort().forEach(function (r) {
        var p = czytajGz(fwy, r + '_' + nazwa), e = p && p[wk];
        if (!e) return;
        Object.keys(e.s).forEach(function (j) { stacje[j] = (stacje[j] || 0) + e.s[j]; });
        Object.keys(e.m).forEach(function (mm) { mies[r + '-' + mm] = (mies[r + '-' + mm] || 0) + e.m[mm]; });
      });
      var emisji = utwory.reduce(function (s, x) { return s + x.n; }, 0) + gosc.reduce(function (s, x) { return s + x.n; }, 0);
      var pierwsza = utwory.concat(gosc).map(function (x) { return x.pierwsza; }).filter(Boolean).sort()[0] || null;
      return {
        wk: wk, nazwa: utwory.length ? String(utwory[0].a).split(/\s+(?:\/|&|feat\.?|ft\.?|x)\s+/i)[0] : wk, emisji: emisji, pierwsza: pierwsza,
        utwory: utwory.slice(0, 500), goscinne: gosc.slice(0, 300),
        stacje: Object.keys(stacje).map(function (j) { return { id: j, nazwa: nazwaJednostki_(j), n: stacje[j] }; }).sort(function (a, b) { return b.n - a.n; }),
        miesiace: Object.keys(mies).sort().map(function (m) { return [m, mies[m]]; }),
      };
    });
  });
}

/** Z1: wykonawcy pasujący do zapytania – 30 000 najczęściej granych (szukaj_wykonawcy.json.gz); opcje.calaBaza – paczki indeksu. */
function szukajWykonawcow(q, opcje) {
  return bezpiecznie_(function () {
    var slowa = tytulKlucz(q).split(' ').filter(Boolean);
    if (!slowa.length) return { wykonawcy: [] };
    var pasuje = function (wk) { return slowa.every(function (s) { return wk.indexOf(s) >= 0; }); };
    var z = opcje && opcje.calaBaza ? null : agg_('_wszystkie', 'szukaj_wykonawcy.json.gz');
    if (z && z.w) {
      var l = z.w.filter(function (x) { return pasuje(x[0]); }).map(function (x) { return { wk: x[0], a: x[1], n: x[2], utworow: x[3] }; });
      return { wykonawcy: l.slice(0, 200), wszystkich: l.length, przeszukano: z.w.length, wBazie: z.n };
    }
    var w = {}, fw = folderJ_('_wszystkie');
    for (var i = 0; i < PACZEK_UTWOROW; i++) {
      var p = paczkaIndeksuPelna(fw, i);
      Object.keys(p).forEach(function (k) {
        var wk = k.split('|')[0];
        if (!pasuje(wk)) return;
        var x = p[k], e = w[wk] = w[wk] || { wk: wk, a: String(x[0]).split(/\s+(?:\/|&|feat\.?|ft\.?|x)\s+/i)[0], n: 0, utworow: 0 };
        e.n += x[2]; e.utworow++;
      });
    }
    var lista = Object.keys(w).map(function (k) { return w[k]; }).sort(function (a, b) { return b.n - a.n; });
    return { wykonawcy: lista.slice(0, 200), wszystkich: lista.length, calaBaza: true };
  });
}

// ---------------- dane utworu z MusicBrainz (kompozytor, autor słów, wydanie, ISRC…) ----------------

/**
 * Szczegóły nagrania z MusicBrainz – na żądanie z profilu utworu (4 zapytania, odstęp 1,1 s – limit MusicBrainz
 * to średnio 1 zapytanie na sekundę). Wynik w pamięci serwera na 6 h; przeglądarka trzyma go 7 dni.
 * Dopasowanie jak w scraper/metadane.py: wynik ≥ 90, ten sam tytuł (klucz) i wykonawca w kredytach; najwcześniejsze wydanie.
 */
var MB_UA_ = 'MusicBasePanel/1.0 (prywatne archiwum playlist)';
function mbGet_(sciezka, ostatnie) {
  var czekaj = ostatnie.t + 1100 - Date.now();
  if (czekaj > 0) Utilities.sleep(czekaj);
  ostatnie.t = Date.now();
  // MusicBrainz przy obciążeniu odpowiada 503 „server is currently busy” (12.11.2026 co drugie zapytanie) – ponawiamy z przerwą
  for (var proba = 0; proba < 6; proba++) {
    var odp = UrlFetchApp.fetch('https:\/\/musicbrainz.org/ws/2' + sciezka + (sciezka.indexOf('?') < 0 ? '?' : '&') + 'fmt=json', { muteHttpExceptions: true, headers: { 'User-Agent': MB_UA_, Accept: 'application/json' } });
    var kod = odp.getResponseCode();
    if (kod === 200) return JSON.parse(odp.getContentText());
    if (kod === 404) return null;
    if (kod !== 503 && kod !== 429 && kod !== 0) throw new Error('MusicBrainz: HTTP ' + kod);
    Utilities.sleep(1500 * (proba + 1));
    ostatnie.t = Date.now();
  }
  throw new Error('MusicBrainz jest przeciążony – spróbuj za chwilę');
}
function szczegolyUtworu(a, t) {
  return bezpiecznie_(function () {
    return zPamieci_('mb1|' + kluczUtworu(a, t), 21600, function () {
      var ost = { t: 0 }, glowny = String(a).split(/\s*(?:\/|&|,| feat\.? | ft\.? | x )\s*/i)[0];
      var tyt = String(t).replace(/\s*[(\[].*?[)\]]/g, '').trim();
      var s = mbGet_('/recording?limit=25&query=' + encodeURIComponent('recording:"' + tyt + '" AND artist:"' + glowny + '"'), ost) || {};
      var wk = wykonawcyKlucz(a), tk = tytulKlucz(t), najl = null;
      (s.recordings || []).forEach(function (r) {
        if ((r.score || 0) < 90 || tytulKlucz(r.title || '') !== tk) return;
        var ok = (r['artist-credit'] || []).some(function (c) { return c.name && wk.indexOf(wykonawcaKlucz(c.name)) >= 0 || (c.artist && wk.indexOf(wykonawcaKlucz(c.artist.name)) >= 0); });
        if (!ok) return;
        var d = r['first-release-date'] || '9999';
        if (!najl || d < (najl['first-release-date'] || '9999')) najl = r;
      });
      if (!najl) return { brak: true };
      var r = mbGet_('/recording/' + najl.id + '?inc=artist-credits+isrcs+releases+release-groups+work-rels+artist-rels+genres', ost) || {};
      var role = function (rel) { return (rel || []).filter(function (x) { return x.artist; }).map(function (x) { return { typ: x.type, kto: x.artist.name, atr: x.attributes || [] }; }); };
      var w = { mbid: r.id, tytul: r.title, dlugosc: r.length || null, pierwszeWydanie: r['first-release-date'] || null,
        wykonawcy: (r['artist-credit'] || []).map(function (c) { return c.name + (c.joinphrase || ''); }).join(''),
        isrc: r.isrcs || [], gatunki: (r.genres || []).sort(function (x, y) { return (y.count || 0) - (x.count || 0); }).slice(0, 5).map(function (g) { return g.name; }),
        nagranie: role(r.relations), utwory: [], wydania: 0, wydanie: null };
      // wydania: najwcześniejsze oficjalne (album / singel), z wytwórnią
      var wyd = (r.releases || []).filter(function (x) { return x.date; }).sort(function (x, y) { return x.date < y.date ? -1 : 1; });
      w.wydania = (r.releases || []).length;
      var pierwsze = wyd.filter(function (x) { return x.status === 'Official'; })[0] || wyd[0];
      if (pierwsze) {
        w.wydanie = { tytul: pierwsze.title, data: pierwsze.date, kraj: pierwsze.country || null, typ: (pierwsze['release-group'] || {})['primary-type'] || null,
          typy2: (pierwsze['release-group'] || {})['secondary-types'] || [], mbid: pierwsze.id };
        var rel = mbGet_('/release/' + pierwsze.id + '?inc=labels', ost) || {};
        w.wydanie.wytwornie = (rel['label-info'] || []).filter(function (x) { return x.label; }).map(function (x) { return x.label.name + (x['catalog-number'] ? ' (' + x['catalog-number'] + ')' : ''); });
        w.wydanie.kodKreskowy = rel.barcode || null;
      }
      // utwór (kompozycja): kompozytor, autor słów, ISWC, język
      (r.relations || []).filter(function (x) { return x.work; }).slice(0, 2).forEach(function (x) {
        var dz = mbGet_('/work/' + x.work.id + '?inc=artist-rels', ost) || {};
        w.utwory.push({ tytul: dz.title || x.work.title, mbid: x.work.id, iswc: dz.iswcs || [], jezyki: dz.languages || (dz.language ? [dz.language] : []), autorzy: role(dz.relations) });
      });
      return w;
    });
  });
}

// ---------------- wydawnictwo z Discogs (publiczny adres /releases/{id} – bez tokenu) ----------------

/**
 * Pełne dane wydawnictwa Discogs, na którym jest utwór (numer dg zebrany w tle – zadanie Metadane, tryb szczegoly):
 * format, kraj, gatunki i style, wytwórnie z numerem katalogowym, firmy (℗, ©, wydawca, studio), wszystkie kredyty
 * dotyczące tego utworu, identyfikatory, statystyki społeczności (ma / chce / ocena), oferty sprzedaży, wersje wydania (master).
 * Bez tokenu Discogs pozwala na 25 zapytań na minutę – 1–2 zapytania na profil, wynik w pamięci 6 h (przeglądarka 7 dni).
 */
function discogsWydanie(id, tytul) {
  return bezpiecznie_(function () {
    if (!/^\d{1,12}$/.test(String(id))) throw new Error('zły numer wydawnictwa Discogs');
    return zPamieci_('dg1|' + id + '|' + tytulKlucz(tytul || ''), 21600, function () {
      var get = function (sciezka) {
        for (var proba = 0; proba < 3; proba++) {
          var odp = UrlFetchApp.fetch('https:\/\/api.discogs.com' + sciezka, { muteHttpExceptions: true, headers: { 'User-Agent': MB_UA_ } });
          var kod = odp.getResponseCode();
          if (kod === 200) return JSON.parse(odp.getContentText());
          if (kod === 404) return null;
          if (kod !== 429 && kod !== 503) throw new Error('Discogs: HTTP ' + kod);
          Utilities.sleep(3000 * (proba + 1));
        }
        throw new Error('Discogs jest przeciążony – spróbuj za chwilę');
      };
      var r = get('/releases/' + id);
      if (!r) return { brak: true };
      var tk = tytulKlucz(tytul || ''), utw = null;
      (r.tracklist || []).forEach(function (x) { if (!utw && (x.type_ || 'track') === 'track' && tytulKlucz(x.title || '') === tk) utw = x; });
      var poz = utw ? String(utw.position || '').trim() : '';
      var nazwa = function (x) { return String(x.name || '').replace(/\s*\(\d+\)$/, ''); };
      // kredyty: utworu + wydawnictwa (bez ograniczenia albo z tą pozycją w polu tracks)
      var kredyty = {};
      (utw ? utw.extraartists || [] : []).concat((r.extraartists || []).filter(function (x) {
        var tr = String(x.tracks || '').trim();
        return !tr || (poz && tr.split(/,|\bto\b/).map(function (y) { return y.trim(); }).indexOf(poz) >= 0);
      })).forEach(function (x) {
        String(x.role || '').split(',').forEach(function (rola) {
          rola = rola.trim(); if (!rola) return;
          var l = kredyty[rola] = kredyty[rola] || [];
          if (l.indexOf(nazwa(x)) < 0) l.push(nazwa(x));
        });
      });
      var w = {
        id: r.id, tytul: r.title, link: r.uri || ('https:\/\/www.discogs.com/release/' + r.id), rok: r.year || null, wydano: r.released_formatted || r.released || null,
        kraj: r.country || null, gatunki: r.genres || [], style: r.styles || [],
        formaty: (r.formats || []).map(function (f) { return (f.qty && f.qty !== '1' ? f.qty + '× ' : '') + f.name + ((f.descriptions || []).length ? ' (' + f.descriptions.join(', ') + ')' : '') + (f.text ? ' – ' + f.text : ''); }),
        wytwornie: (r.labels || []).map(function (x) { return nazwa(x) + (x.catno && x.catno !== 'none' ? ' – ' + x.catno : ''); }),
        firmy: (r.companies || []).map(function (x) { return { rola: x.entity_type_name, kto: nazwa(x) }; }),
        kredyty: kredyty, pozycja: poz || null, czas: utw && utw.duration || null, utworow: (r.tracklist || []).filter(function (x) { return (x.type_ || 'track') === 'track'; }).length,
        identyfikatory: (r.identifiers || []).filter(function (x) { return ['Barcode', 'Label Code', 'ISRC', 'Rights Society'].indexOf(x.type) >= 0; }).map(function (x) { return { typ: x.type, wart: x.value, opis: x.description || null }; }),
        master: null,   // statystyki społeczności i rynku Discogs pominięte (14.11.2026)
      };
      if (r.master_id) {
        var m = get('/masters/' + r.master_id);
        var wer = get('/masters/' + r.master_id + '/versions?per_page=1');
        w.master = { id: r.master_id, rok: (m || {}).year || null, wersji: wer && wer.pagination ? wer.pagination.items : null, link: 'https:\/\/www.discogs.com/master/' + r.master_id };
      }
      return w;
    });
  });
}

/**
 * Music Base – Panel: strona główna (widżety), „teraz na antenie”, „tego dnia”, moje ustawienia, raport tygodniowy.
 */

function dataPlus_(iso, dni) { var d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + dni); return d.toISOString().slice(0, 10); }
function ostatniDzienDanych_() {
  var ind = indeksStacji_();
  return Object.keys(ind).map(function (s) { return ind[s].ostatni; }).filter(Boolean).sort().pop() || null;
}

/** Liczby emisji utworów całego radia dzień po dniu w zakresie (z miesięcy całego radia): {k: {a, t, dni: {iso: n}}}. */
function dzienneRadia_(od, doo) {
  var wynik = {};
  miesiaceZakresu_(od, doo).forEach(function (m) {
    var g = agg_('_wszystkie', m + '.json.gz');
    if (!g) return;
    Object.keys(g.u).forEach(function (k) {
      var x = g.u[k];
      Object.keys(x[3]).forEach(function (d) {
        var iso = m + '-' + d;
        if (iso < od || iso > doo) return;
        var e = wynik[k] = wynik[k] || { a: x[0], t: x[1], dni: {} };
        e.dni[iso] = (e.dni[iso] || 0) + x[3][d];
      });
    });
  });
  return wynik;
}

/**
 * Widżety strony głównej: wschodzące (G3), debiuty (G4), puls (G5) – gotowe z Odbiornika (strona.json.gz, liczone po
 * przeliczeniu miesięcy całego radia i indeksu utworów); ostatnie alerty (G6) i stan danych (G8) na żywo.
 * Wcześniej panel liczył to sam z pełnego indeksu, metadanych i pliku roku – 14.11.2026 nie mieściło się w limitach.
 */
function strona() {
  return bezpiecznie_(function () {
    var kon = ostatniDzienDanych_();
    if (!kon) return { brakDanych: true };
    var s = agg_('_wszystkie', 'strona.json.gz');
    var obliczone = s ? { ostatni: s.ostatni, wschodzace: s.wschodzace || [], debiuty: s.debiuty || [], puls: s.puls || [], zbudowano: s.zbudowano || null }
      : { ostatni: kon, wschodzace: [], debiuty: [], puls: [], przygotowanie: true };
    obliczone.debiuty.forEach(function (d) { if (d.pierwszaStacja) d.pierwszaStacjaNazwa = nazwaJednostki_(d.pierwszaStacja); });
    var dz = czytajJsonPlik(folderAgg_(), 'dzis.json') || {}, godziny = {};
    Object.keys(dz.stacje || {}).forEach(function (st) {
      Object.keys(dz.stacje[st]).forEach(function (o) { dz.stacje[st][o].forEach(function (w) { var h = +w.g.slice(0, 2); godziny[h] = (godziny[h] || 0) + 1; }); });
    });
    obliczone.dzis = { data: dz.data || null, aktualizacja: dz.aktualizacja || null, godziny: godziny };
    obliczone.alerty = (czytajJsonPlik(folderAgg_(), 'alerty_log.json') || []).slice(0, 10);
    obliczone.stan = stanDanych_(s ? s.metadanych : null);
    return obliczone;
  });
}

/** G8: stan danych – stacje (od/do, doby), diagnostyka, liczba utworów z metadanymi (rok, kraj, język – z Odbiornika). */
function stanDanych_(metadanych) {
  var ind = indeksStacji_(), stacje = Object.keys(ind).map(function (s) {
    return { id: s, nazwa: nazwaJednostki_(s), pierwszy: ind[s].pierwszy, ostatni: ind[s].ostatni, dob: ind[s].dob, zrodlo: ind[s].zrodlo || 'odsluchane' };
  }).sort(function (a, b) { return (a.pierwszy || '9') < (b.pierwszy || '9') ? -1 : 1; });
  var st = czytajJsonPlik(folderAgg_(), 'stan_systemu.json') || {};
  return { stacje: stacje, diagnostyka: st.diagnostyka || null, problemy: st.problemy || [], metadanych: metadanych == null ? null : metadanych, zadania: dziennikZadan_() };
}

// ---------------- teraz na antenie (G1, S1) ----------------

/**
 * Co gra teraz na wskazanych stacjach: bieżące okno doby z odSluchane.eu (kilka stacji naraz, UrlFetchApp.fetchAll),
 * Radio Meteor z serwera Icecast. Wynik pamiętany 60 s, żeby kilka otwartych kart nie pytało serwisu wielokrotnie.
 */
function teraz(stacje) {
  return bezpiecznie_(function () {
    stacje = (stacje || []).slice(0, 12);
    // pamięć osobno dla każdej stacji (2 min): Start, odtwarzacz i profil stacji korzystają ze wspólnych wyników,
    // a panel pyta o każdą stację osobnym zapytaniem – najwolniejsze źródło nie blokuje pozostałych (F3)
    var c = CacheService.getScriptCache(), wynik = {}, brak = [], klucz = function (j) { return 'mb3:teraz1|' + j; };
    var zPam = {};
    try { zPam = c.getAll(stacje.map(klucz)); } catch (e) { /* bez pamięci */ }
    stacje.forEach(function (j) {
      var z = zPam[klucz(j)];
      if (z) { try { wynik[j] = JSON.parse(z); return; } catch (e) { /* uszkodzony wpis */ } }
      brak.push(j);
    });
    if (brak.length) {
      var nowe = terazPobierz_(brak);
      Object.keys(nowe).forEach(function (j) {
        wynik[j] = nowe[j];
        if (!nowe[j].blad) { try { c.put(klucz(j), JSON.stringify(nowe[j]), 120); } catch (e) { /* za duże */ } }
      });
    }
    return { kiedy: Utilities.formatDate(new Date(), 'Europe/Warsaw', 'HH:mm'), stacje: wynik };
  });
}

/** Ostatnie utwory stacji prosto ze źródeł (odSluchane, strony stacji, API) – równolegle przez fetchAll. */
function terazPobierz_(stacje) {
  var ind = indeksStacji_(), now = new Date();
  var data = Utilities.formatDate(now, 'Europe/Warsaw', 'dd-MM-yyyy'), h = +Utilities.formatDate(now, 'Europe/Warsaw', 'H');
  var okno = h < 10 ? [0, 10] : h < 20 ? [10, 20] : [20, 0];
  // w pierwszej godzinie okna (0:xx, 10:xx, 20:xx) także poprzednie okno – inaczej tuż po zmianie okna lista była pusta (B4)
  var poprz = null;
  if (h === 0) poprz = { data: Utilities.formatDate(new Date(now.getTime() - 864e5), 'Europe/Warsaw', 'dd-MM-yyyy'), okno: [20, 0] };
  else if (h === 10) poprz = { data: data, okno: [0, 10] };
  else if (h === 20) poprz = { data: data, okno: [10, 20] };
  var lista = [];
  stacje.forEach(function (j) { (SIECI[j] ? [SIECI[j].czlonkowie[0]] : [j]).forEach(function (s) { lista.push([j, s]); }); });
  var zapytania = [];
  var odsl = function (r, d, o) {
    return { url: 'https://www.odsluchane.eu/szukaj.php?r=' + r + '&date=' + d + '&time_from=' + o[0] + '&time_to=' + o[1], muteHttpExceptions: true,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MusicBase/1.0; prywatny panel)' } };
  };
  lista.forEach(function (x) {
    var s = x[1];
    if (s === 'radio_meteor') zapytania.push({ url: 'https://icecast.radiometeor.pl/status-json.xsl', muteHttpExceptions: true });
    else if (s === 'radio_357') zapytania.push({ url: 'https://radio357.pl/twoje-357/playlista/dzien/' + Utilities.formatDate(now, 'Europe/Warsaw', 'yyyy-MM-dd') + '/', muteHttpExceptions: true });
    else if (s === 'nowy_swiat') zapytania.push({ url: 'https://nowyswiat.online/api/oZeta/stat', muteHttpExceptions: true });
    else if (s === 'rmf24') zapytania.push({ url: 'https://api.rmfon.pl/stations/190/playlist', muteHttpExceptions: true });
    else if (ind[s] && ind[s].r) {
      zapytania.push(odsl(ind[s].r, data, okno));
      if (poprz) zapytania.push(odsl(ind[s].r, poprz.data, poprz.okno));
    }
  });
  var odp = zapytania.length ? UrlFetchApp.fetchAll(zapytania) : [];
  var wynik = {}, zebrane = {};
  // przypisanie odpowiedzi do celów: kolejność zapytań = kolejność cele po korekcie (poprzednie okno dopisane po bieżącym)
  var kolejnosc = [];
  lista.forEach(function (x) {
    var s = x[1];
    if (s === 'radio_meteor' || s === 'radio_357' || s === 'nowy_swiat' || s === 'rmf24') kolejnosc.push([x[0], s, 'biez']);
    else if (ind[s] && ind[s].r) { kolejnosc.push([x[0], s, 'biez']); if (poprz) kolejnosc.push([x[0], s, 'poprz']); }
  });
  odp.forEach(function (o, i) {
    var j = kolejnosc[i][0], s = kolejnosc[i][1], tekst = o.getContentText(), utwory = zebrane[j] = zebrane[j] || [];
    if (o.getResponseCode() !== 200) { if (kolejnosc[i][2] === 'biez') wynik[j] = { blad: 'HTTP ' + o.getResponseCode() }; return; }
    if (s === 'radio_meteor') {
      try {
        var src = (JSON.parse(tekst).icestats || {}).source || [];
        src = Array.isArray(src) ? src : [src];
        var t = (src.filter(function (x) { return x.title; })[0] || {}).title;
        if (t) { var p = String(t).indexOf(' - '); utwory.push({ g: Utilities.formatDate(now, 'Europe/Warsaw', 'HH:mm'), a: p > 0 ? t.slice(0, p) : t, t: p > 0 ? t.slice(p + 3) : '', teraz: true }); }
      } catch (e) { /* brak tytułu */ }
    } else if (s === 'radio_357') {
      tekst.split('class="programGroupSong').slice(1).forEach(function (blok) {
        var g = /class="songDate">\s*(\d{1,2}):(\d{2})/.exec(blok), ar = /class="songArtis">([\s\S]*?)<\//.exec(blok), ti = /class="songTitle">([\s\S]*?)<\//.exec(blok);
        if (g && ar && ti) utwory.push({ g: ('0' + g[1]).slice(-2) + ':' + g[2], a: htmlNaLinie_(ar[1]).join(' '), t: htmlNaLinie_(ti[1]).join(' ') });
      });
    } else if (s === 'nowy_swiat') {
      try {   // API podaje wykonawcę w polu „title”, a tytuł w polu „artist”
        var dns = JSON.parse(tekst).data || {};
        if (dns.title) utwory.push({ g: Utilities.formatDate(new Date((+dns.ts || 0) * 1000 || now), 'Europe/Warsaw', 'HH:mm'), a: String(dns.title), t: String(dns.artist || ''), teraz: true });
      } catch (e) { /* brak danych */ }
    } else if (s === 'rmf24') {
      try {
        JSON.parse(tekst).filter(function (x) { return x.order <= 0 && x.trackId > 0; }).forEach(function (x) {
          utwory.push({ g: Utilities.formatDate(new Date(x.timestamp * 1000), 'Europe/Warsaw', 'HH:mm'), a: x.author, t: x.title, teraz: x.order === 0 });
        });
      } catch (e) { /* brak danych */ }
    } else {
      var re = /<tr>\s*<td>(\d\d:\d\d)<\/td>\s*<td>([\s\S]*?)<\/td>/g, m;
      while ((m = re.exec(tekst))) {
        var txt = m[2].replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/\s+/g, ' ').trim();
        var q = txt.indexOf(' - ');
        // poprzednie okno przed północą: godziny 20–23 są „wcześniej” niż 00:xx – sortujemy z przesunięciem doby
        if (q > 0 && txt.slice(q + 3).trim()) utwory.push({ g: m[1], a: txt.slice(0, q).trim(), t: txt.slice(q + 3).trim(), wczoraj: kolejnosc[i][2] === 'poprz' && h === 0 });
      }
    }
  });
  Object.keys(zebrane).forEach(function (j) {
    if (wynik[j] && wynik[j].blad && !zebrane[j].length) return;
    var u = zebrane[j], widziane = {};
    u = u.filter(function (x) { var k = x.g + '|' + x.a + '|' + x.t; if (widziane[k]) return false; widziane[k] = 1; return true; });
    u.sort(function (a, b) { var ka = (a.wczoraj ? '0' : '1') + a.g, kb = (b.wczoraj ? '0' : '1') + b.g; return ka < kb ? 1 : -1; });
    wynik[j] = { utwory: u.slice(0, 6).map(function (x) { delete x.wczoraj; x.k = kluczUtworu(x.a, x.t); return x; }) };
  });
  return wynik;
}

// ---------------- tego dnia (G7) ----------------

/**
 * Najczęściej grane w oknie wokół daty odniesienia w kolejnych latach wstecz.
 * p = {data: "RRRR-MM-DD", okno: dni (1 = sama doba, 7 = tydzień kończący się tą datą…), lata: [1, 5, 10], jednostki: []}
 */
function tegoDnia(p) {
  return bezpiecznie_(function () {
    var okno = Math.max(1, Math.min(92, +p.okno || 1)), meta = metadane_();
    var lata = (p.lata || [1, 5, 10]).map(Number).filter(function (x) { return x > 0 && x < 30; }).slice(0, 6);
    return { okresy: lata.map(function (l) {
      var d = new Date(p.data + 'T12:00:00Z');
      d.setUTCFullYear(d.getUTCFullYear() - l);
      var doo = d.toISOString().slice(0, 10), od = dataPlus_(doo, -(okno - 1));
      var z = zbierzWiele_(p.jednostki || [], od, doo);
      var lista = Object.keys(z.u).map(function (k) { return wierszUtworu_(k, z.u[k], meta); }).sort(function (a, b) { return b.n - a.n; });
      return { lat: l, od: od, do: doo, emisji: z.emisji, dni: z.dni, top: lista.slice(0, 100) };
    }) };
  });
}

// ---------------- moje: ulubione stacje i utwory, tagi, notatki, raport ----------------

function moje() { return bezpiecznie_(function () { return moje_(); }); }

/** Zmiana moich ustawień: zmiana = {ulubionaStacja: [id, bool]} | {ulubionyUtwor: [k, bool]} | {tagi: [k, [..]]} | {notatka: [k, tekst]} | {raport: bool}. */
function zapiszMoje(zmiana) {
  return bezpiecznie_(function () {
    var m = czytajJsonPlik(folderAgg_(), 'moje.json') || {};
    m.ulubioneStacje = m.ulubioneStacje || []; m.ulubioneUtwory = m.ulubioneUtwory || {}; m.tagi = m.tagi || {}; m.notatki = m.notatki || {};
    if (zmiana.ulubionaStacja) {
      var id = zmiana.ulubionaStacja[0];
      m.ulubioneStacje = m.ulubioneStacje.filter(function (x) { return x !== id; });
      if (zmiana.ulubionaStacja[1]) m.ulubioneStacje.push(id);
    }
    if (Array.isArray(zmiana.kolejnoscUlubionych)) {   // nowa kolejność (i usunięcia) z menu ulubionych
      var wid = {};
      m.ulubioneStacje = zmiana.kolejnoscUlubionych.map(String).filter(function (x) { if (wid[x] || !/^[a-z0-9_]{1,40}$/.test(x)) return false; wid[x] = 1; return true; }).slice(0, 100);
    }
    if (zmiana.ulubionyUtwor) { if (zmiana.ulubionyUtwor[1]) m.ulubioneUtwory[zmiana.ulubionyUtwor[0]] = 1; else delete m.ulubioneUtwory[zmiana.ulubionyUtwor[0]]; }
    if (zmiana.tagi) { var t = (zmiana.tagi[1] || []).map(String).filter(Boolean).slice(0, 20); if (t.length) m.tagi[zmiana.tagi[0]] = t; else delete m.tagi[zmiana.tagi[0]]; }
    if (zmiana.notatka) { if (zmiana.notatka[1]) m.notatki[zmiana.notatka[0]] = String(zmiana.notatka[1]).slice(0, 2000); else delete m.notatki[zmiana.notatka[0]]; }
    if (zmiana.raport !== undefined) m.raport = !!zmiana.raport;
    if (zmiana.przypomnienie) {   // E2: [stacja, tytuł audycji, włącz?] – e-mail ok. godzinę przed każdą emisją
      var ps = String(zmiana.przypomnienie[0] || ''), pt = String(zmiana.przypomnienie[1] || '').slice(0, 200);
      m.przypomnienia = (m.przypomnienia || []).filter(function (x) { return !(x.s === ps && x.t.toLowerCase() === pt.toLowerCase()); });
      if (zmiana.przypomnienie[2] && /^[a-z0-9_]{1,40}$/.test(ps) && pt) m.przypomnienia.push({ s: ps, t: pt });
      m.przypomnienia = m.przypomnienia.slice(-30);
    }
    if (Array.isArray(zmiana.widoki)) m.widoki = zmiana.widoki.slice(0, 40).map(function (w) {   // O4: zapisane widoki
      return { id: String(w.id || Utilities.getUuid().slice(0, 8)), nazwa: String(w.nazwa || 'Widok').slice(0, 80), widok: String(w.widok || 'ranking').slice(0, 30), arg: w.arg == null ? null : String(w.arg).slice(0, 200),
        wybrane: (w.wybrane || []).slice(0, 60).map(String), preset: w.preset == null ? null : w.preset, od: w.od || null, do: w.do || null, przypiety: !!w.przypiety };
    });
    zapiszJsonPlik(folderAgg_(), 'moje.json', m);
    _PAM.moje = m;
    return m;
  });
}

/** Wyzwalacz w poniedziałki ok. 7:00 (W3): raport tygodniowy e-mailem, gdy włączony w ustawieniach. */
function raportTygodniowy() {
  var m = moje_();
  if (!m.raport) return;
  var s = strona();
  if (s.blad || s.brakDanych) return;
  var ul = (m.ulubioneStacje || []).slice(0, 5);
  var linie = ['Music Base – tydzień do ' + s.ostatni, '', 'Wschodzące (wzrost emisji wobec poprzedniego tygodnia):'];
  s.wschodzace.slice(0, 10).forEach(function (x, i) { linie.push((i + 1) + '. ' + x.a + ' – ' + x.t + ' (' + x.n + ', +' + x.wzrost + ')'); });
  linie.push('', 'Debiuty:');
  s.debiuty.slice(0, 10).forEach(function (x) { linie.push('• ' + x.a + ' – ' + x.t + ' – pierwsza: ' + (x.pierwszaStacjaNazwa || '?') + ', ' + x.pierwsza); });
  ul.forEach(function (j) {
    var r = ranking({ jednostki: [j], od: dataPlus_(s.ostatni, -6), do: s.ostatni, typ: 'utwory', limit: 5 });
    if (r.blad) return;
    linie.push('', 'Top 5 – ' + nazwaJednostki_(j) + ':');
    r.pozycje.forEach(function (x) { linie.push(x.miejsce + '. ' + x.a + ' – ' + x.t + ' (' + x.n + ')'); });
  });
  if (s.alerty.length) { linie.push('', 'Alerty z tygodnia:'); s.alerty.forEach(function (a) { linie.push('• ' + a.tekst); }); }
  try { linie = linie.concat(raportDyrektora_()); } catch (e) { /* D15: sekcje biura muzycznego – bez nich raport i tak wychodzi */ }
  linie.push('', 'Panel: ' + ScriptApp.getService().getUrl());
  MailApp.sendEmail(Session.getEffectiveUser().getEmail(), 'Music Base: podsumowanie tygodnia', linie.join('\n'));
  wyslijNtfyP_('Music Base: podsumowanie tygodnia', 'Raport tygodniowy jest w skrzynce e-mail.');
}

/** Uruchom raz w edytorze: wyzwalacze panelu – playlisty Spotify (codziennie ok. 6:00) i raport (poniedziałki ok. 7:00). */
function zainstalujPanel() {
  ScriptApp.getProjectTriggers().forEach(function (w) {
    if (['odswiezAutoPlaylisty', 'raportTygodniowy', 'odswiezRamowki'].indexOf(w.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(w);
  });
  // ramówki co godzinę do pliku (F4): ok. 25 stron stacji na dziś i jutro, kilka–kilkanaście sekund na uruchomienie
  ScriptApp.newTrigger('odswiezRamowki').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('odswiezAutoPlaylisty').timeBased().atHour(6).everyDays(1).create();
  ScriptApp.newTrigger('raportTygodniowy').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(7).create();
  odswiezRamowki();
  Logger.log('Panel: folder danych ' + folderGlowny_().getUrl() + '; playlisty codziennie ok. 6:00, raport w poniedziałki ok. 7:00, ramówki co godzinę.');
}

// ---------------- ramówki (EPG) ----------------

/**
 * Źródła ramówek (sprawdzone 11.11.2026 – strony stacji ładują je same z tych adresów):
 *   pr       – Polskie Radio: apipr.polskieradio.pl/api/schedule?Program=1..4&SelectedDate=RRRR-MM-DD
 *   rmf      – RMF FM: www.rmf.fm/cache/ramowka/PROG/RRRR/MM/DD.json (start_date_time, end_date_time, program, person)
 *   eurozet  – Radio ZET, Antyradio, Chillizet, Meloradio: player.radiozet.pl/api/<stacja>-radio/schedule-for-day/(day)/N/(station)/<stacja>
 *              N = dzień tygodnia od poniedziałku = 0; start/end w sekundach od północy; ramówka tygodniowa (bez dat)
 *   krakow   – Radio Kraków: radiokrakow.pl/api/schedule?date=RRRR-MM-DD (startsAt, endsAt, title, presenters)
 *   rmfmaxx  – RMF MAXX: www.rmfmaxx.pl/ramowka?format=json – tydzień, każda pozycja z datą najbliższej emisji
 * Bez źródła danych: m.in. Eska, Vox FM, Radio Plus, Radio Poznań, Radio Wrocław (strona ramówki nie istnieje albo jest
 * tylko obrazkiem/tekstem); Radio Białystok, Szczecin, PiK, Olsztyn, Luz, Off Radio Kraków mają ramówkę tylko jako HTML.
 */
var ZRODLA_RAMOWEK = {
  jedynka: { typ: 'pr', program: 1 }, dwojka: { typ: 'pr', program: 2 }, trojka: { typ: 'pr', program: 3 }, czworka: { typ: 'pr', program: 4 },
  rmf_fm: { typ: 'rmf' },
  radio_zet: { typ: 'eurozet', stacja: 'radiozet' }, antyradio: { typ: 'eurozet', stacja: 'antyradio' },
  chilli_zet: { typ: 'eurozet', stacja: 'chillizet' }, meloradio: { typ: 'eurozet', stacja: 'meloradio' },
  krakow: { typ: 'krakow' },
  rmf_maxxx: { typ: 'rmfmaxx' },
  // grupa Time / ZPR (Eska): ta sama strona „program” – dni + „od GG:MM”, tytuł, prowadzący (tydzień, bez godzin końca)
  eska: { typ: 'zpr', url: 'https://www.eska.pl/program/' }, eska_rock: { typ: 'zpr', url: 'https://www.eskarock.pl/program/' },
  vox_fm: { typ: 'zpr', url: 'https://www.voxfm.pl/program/' }, radio_wawa: { typ: 'zpr', url: 'https://www.radiowawa.pl/program/' },
  lodz: { typ: 'lodz' },
  weekend_fm: { typ: 'weekend' },
  mc_radio: { typ: 'mcradio' },
  radio_poznan: { typ: 'poznan' },
  luz: { typ: 'luz' },
  afera: { typ: 'afera' },
  radio_357: { typ: 'r357' },        // radio357.pl/ramowka/ – 7 dni (od 3 dni temu do 3 dni naprzód), sekcje w kolejności zakładek
  nowy_swiat: { typ: 'nowyswiat' },  // nowyswiat.online/ramowka – 10 dni z datami w zakładkach   // afera.com.pl/program – sekcje slide_1 (pon.) … slide_7 (niedz.); godziny po północy należą do nocy po tym dniu   // radioluz.pl/ramowka/ – bloki js-schedule-<dzień po angielsku>; T1/T2 = audycje co drugi tydzień   // radiopoznan.fm/playlist/ramowka – sekcje week_day_0 (pon.) … week_day_6 (niedz.)
  szczecin: { typ: 'szczecin', tylkoDzis: true },
  radio_meteor: { typ: 'plik' },   // z Meteor Analytics przez Odbiornik (ramowkaDoMusicBase, co noc): _agg/ramowki/radio_meteor.json
  bialystok: { typ: 'bialystok', tylkoDzis: true },
};

/**
 * Grupy stacji (filtr w ramówkach i na liście stacji). Przypisanie tylko tam, gdzie jest podstawa: nazwa/właściciel
 * oczywisty z nazwy albo wspólna platforma (te same API/strony: Eurozet – player.radiozet.pl, Time/ZPR – strony
 * „program” Eski), rozgłośnie regionalne Polskiego Radia – spółki regionalne radia publicznego. Reszta: „Pozostałe”.
 */
var GRUPY_STACJI = {
  'Polskie Radio': ['jedynka', 'dwojka', 'trojka', 'czworka'],
  'Regionalne radio publiczne': ['bialystok', 'krakow', 'off_radio_krakow', 'lodz', 'lodz_extra', 'olsztyn', 'opole', 'radio_poznan', 'szczecin', 'szczecin_extra', 'wroclaw', 'pik'],
  'Grupa RMF': ['rmf_fm', 'rmf_maxxx', 'rmf_classic', 'rmf24'],
  'Finansowane przez słuchaczy': ['radio_357', 'nowy_swiat'],
  'Eurozet': ['radio_zet', 'chilli_zet', 'antyradio', 'meloradio'],
  'Time / Eska': ['eska', 'eska_rock', 'vox_fm', 'radio_wawa', 'muzo_fm'],
  'Rozgłośnie akademickie': ['afera', 'kampus', 'luz', 'radiofonia', 'studenckie_radio_zak', 'radio_meteor'],
  'Sieci lokalne': ['siec_fama', 'siec_jura_90'],
  'Katolickie i diecezjalne': ['em_kielce', 'katolickie_radio_ciechanow', 'rdn_malopolska'],
};
function grupyStacji_() {
  var w = {}, info = infoStacji_();
  Object.keys(GRUPY_STACJI).forEach(function (g) { GRUPY_STACJI[g].forEach(function (s) { w[s] = g; }); });
  Object.keys(info).forEach(function (s) { if (info[s].grupa) w[s] = info[s].grupa; });   // grupa wpisana w profilu stacji wygrywa
  return w;
}

// ---------------- karta stacji (edycja w profilu) ----------------

/**
 * Dane wpisane w profilu stacji: _agg/stacje_info.json {slug: {pole: wartość}}. Wygrywają z danymi automatycznymi
 * (Wikidata/Wikipedia w przeglądarce, strona WWW z odSluchane). logo = data:image/… (zmniejszone w przeglądarce do 96 px).
 */
var POLA_STACJI = ['nazwa', 'logo', 'www', 'wiki', 'grupa', 'miasto', 'zalozona', 'format', 'gatunki', 'wlasciciel',
  'grupaDocelowa', 'udzial', 'sluchalnosc', 'zrodloSluchalnosci', 'bio'];
function infoStacji_() { return _PAM.info || (_PAM.info = czytajJsonPlik(folderAgg_(), 'stacje_info.json') || {}); }
function zapiszInfoStacji(slug, pola) {
  return bezpiecznie_(function () {
    if (!/^[a-z0-9_]{1,40}$/.test(slug || '')) throw new Error('Zła nazwa stacji.');
    var info = czytajJsonPlik(folderAgg_(), 'stacje_info.json') || {}, x = info[slug] || {};
    Object.keys(pola || {}).forEach(function (k) {
      if (POLA_STACJI.indexOf(k) < 0) return;
      var v = pola[k] === null || pola[k] === undefined ? '' : String(pola[k]).trim();
      if (k === 'logo' && v && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/=]+$/.test(v)) throw new Error('Logo musi być obrazkiem PNG, JPG albo WebP.');
      if (k === 'logo' && v.length > 120000) throw new Error('Logo jest za duże (po zmniejszeniu ponad 90 KB).');
      if (k === 'www' && v && !/^https?:\/\/[^\s]+$/.test(v)) throw new Error('Adres strony musi zaczynać się od http:// albo https://.');
      if (k !== 'logo' && v.length > (k === 'bio' ? 4000 : 300)) v = v.slice(0, k === 'bio' ? 4000 : 300);
      if (v) x[k] = v; else delete x[k];
    });
    if (Object.keys(x).length) info[slug] = x; else delete info[slug];
    zapiszJsonPlik(folderAgg_(), 'stacje_info.json', info);
    _PAM.info = info;
    return { info: info, grupy: grupyStacji_() };
  });
}

function adresRamowki_(z, data) {
  var d = data.split('-');
  if (z.typ === 'pr') return 'https://apipr.polskieradio.pl/api/schedule?Program=' + z.program + '&SelectedDate=' + data;
  if (z.typ === 'rmf') return 'https://www.rmf.fm/cache/ramowka/PROG/' + d[0] + '/' + d[1] + '/' + d[2] + '.json';
  if (z.typ === 'eurozet') {
    var tg = dzienTygodnia_(data);
    return 'https://player.radiozet.pl/api/' + z.stacja + '-radio/schedule-for-day/(day)/' + tg + '/(station)/' + z.stacja;
  }
  if (z.typ === 'krakow') return 'https://radiokrakow.pl/api/schedule?date=' + data;
  if (z.typ === 'rmfmaxx') return 'https://www.rmfmaxx.pl/ramowka?format=json&location=';
  if (z.typ === 'zpr') return z.url;
  if (z.typ === 'lodz') {
    var nazwy = ['poniedzialek', 'wtorek', 'sroda', 'czwartek', 'piatek', 'sobota', 'niedziela'];
    return 'https://radiolodz.pl/ramowka-radia-lodz-' + nazwy[dzienTygodnia_(data)] + '/';
  }
  if (z.typ === 'weekend') return 'https://weekendfm.pl/?n=108884';
  if (z.typ === 'mcradio') return 'https://www.mcradio.pl/public/data/program.json';
  if (z.typ === 'poznan') return 'https://radiopoznan.fm/playlist/ramowka';
  if (z.typ === 'luz') return 'https://radioluz.pl/ramowka/';
  if (z.typ === 'afera') return 'https://www.afera.com.pl/program';
  if (z.typ === 'r357') return 'https://radio357.pl/ramowka/';
  if (z.typ === 'nowyswiat') return 'https://nowyswiat.online/ramowka';
  if (z.typ === 'szczecin') return 'https://radioszczecin.pl/9,0,audycje&go=rowprogram';
  if (z.typ === 'bialystok') return 'https://www.radio.bialystok.pl/ramowka/index';
  return null;
}

/** Dzień tygodnia RRRR-MM-DD: 0 = poniedziałek … 6 = niedziela. */
function dzienTygodnia_(data) { var d = data.split('-'); return (new Date(Date.UTC(+d[0], +d[1] - 1, +d[2])).getUTCDay() + 6) % 7; }
var DNI_PL_ = ['poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota', 'niedziela'];

/** HTML → linie tekstu (bloki i odnośniki jako osobne linie, bez skryptów i stylów). */
function htmlNaLinie_(html) {
  var t = String(html)
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d|\/td|\/th|\/dt|\/dd|\/article|\/section|\/header|\/a|\/span|\/time|\/strong|\/b)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&ndash;|&#8211;/g, '–').replace(/&mdash;|&#8212;/g, '—').replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(+n); })
    .replace(/&[a-z]+;/g, ' ');
  return t.split('\n').map(function (l) { return l.replace(/\s+/g, ' ').trim(); }).filter(Boolean);
}
/** Data „DD.MM” bez roku → RRRR-MM-DD najbliżej daty odniesienia (przełom roku). */
function rokDlaDniaMiesiaca_(odniesienie, mies, dzien) {
  var r = +odniesienie.slice(0, 4), kand = [r - 1, r, r + 1].map(function (x) { return x + '-' + mies + '-' + dzien; });
  return kand.sort(function (a, b) { return Math.abs(roznicaDni_(odniesienie, a)) - Math.abs(roznicaDni_(odniesienie, b)); })[0];
}
function roznicaDni_(a, b) { return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5); }
function gg_(h, m) { return ('0' + h).slice(-2) + ':' + m; }
/** Pozycje {od: "GG:MM", do?, tytul, prowadzacy?, opis?} jednego dnia → format ramówki; brak końca = początek następnej. */
function dzienZPozycji_(data, poz) {
  poz = poz.filter(function (x) { return x.tytul; }).sort(function (a, b) { return a.od < b.od ? -1 : 1; });
  return poz.map(function (x, i) {
    var nast = poz.filter(function (y) { return y.od > x.od; })[0];
    var kon = x.do || (nast ? nast.od : '24:00');
    if (kon <= x.od) kon = x.od < '24:00' ? '24:00' : ('0' + (+x.od.slice(0, 2) + 1)).slice(-2) + x.od.slice(2, 5);   // ostatnia pozycja po północy: 1 h
    return { od: wDniu_(data, x.od), do: wDniu_(data, kon), tytul: x.tytul, opis: x.opis || '', prowadzacy: x.prowadzacy || '', foto: null, kategoria: '', link: x.link || null };
  });
}
/** Dni w zapisie stron Time/ZPR: „Pn i Wt | Czw i Pt”, „Pn - Pt”, „Sb i Ndz”, „Środa” → zbiór 0..6. */
function dniZpr_(tekst) {
  var skr = { pn: 0, pon: 0, wt: 1, wto: 1, sr: 2, śr: 2, czw: 3, pt: 4, pią: 4, pia: 4, sb: 5, sob: 5, nd: 6, ndz: 6, nie: 6 };
  var w = {}, t = tekst.toLowerCase();
  var nr = function (s) {
    s = s.trim().replace(/\.$/, '');
    var i = DNI_PL_.indexOf(s); if (i >= 0) return i;
    if (skr[s] !== undefined) return skr[s];
    return skr[s.slice(0, 3)] !== undefined ? skr[s.slice(0, 3)] : (skr[s.slice(0, 2)] !== undefined ? skr[s.slice(0, 2)] : -1);
  };
  t.split(/\s*(?:\||,|\bi\b)\s*/).forEach(function (cz) {
    var zakres = cz.split(/\s*[-–]\s*/);
    if (zakres.length === 2) { var a = nr(zakres[0]), b = nr(zakres[1]); if (a >= 0 && b >= 0) for (var k = a; k <= b; k++) w[k] = 1; }
    else { var n = nr(cz); if (n >= 0) w[n] = 1; }
  });
  return w;
}
var CZAS_LINIA_ = /^([01]?\d|2[0-4])[:.]([0-5]\d)$/;

function hhmm_(sekundy) {
  sekundy = Math.max(0, Math.min(86400, sekundy));
  var h = Math.floor(sekundy / 3600), m = Math.floor((sekundy % 3600) / 60);
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}
function nastepnyDzien_(data) { var d = new Date(data + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }
/** Godzina „HH:MM” w dniu data; 24:00 i więcej → następny dzień. */
function wDniu_(data, hm) { return +hm.slice(0, 2) >= 24 ? nastepnyDzien_(data) + 'T' + ('0' + (+hm.slice(0, 2) - 24)).slice(-2) + hm.slice(2, 5) : data + 'T' + hm.slice(0, 5); }

/** Odpowiedź źródła → [{od, do, tytul, opis, foto, kategoria, link, prowadzacy}] (od/do: „RRRR-MM-DDTGG:MM”, czas polski). */
function parsujRamowke_(z, data, tekst) {
  var d = JSON.parse(tekst), w = [];
  if (z.typ === 'pr') {
    (d.Schedule || []).forEach(function (x) {
      var foto = x.Photo ? (String(x.Photo).indexOf('//') === 0 ? 'https:' + x.Photo : x.Photo) : null;
      w.push({ od: String(x.StartHour).slice(0, 16), do: String(x.StopHour).slice(0, 16), tytul: x.Title, opis: x.Description || '',
        foto: /mobilezaslepka/.test(foto || '') ? null : foto, kategoria: (x.Category || {}).Name || '', link: x.ArticleLink ? 'https:' + x.ArticleLink : null,
        prowadzacy: (x.Leaders || []).map(function (l) { return l.Name || l; }).join(', ') });
    });
  } else if (z.typ === 'rmf') {
    d.forEach(function (x) {
      w.push({ od: String(x.start_date_time).replace(' ', 'T').slice(0, 16), do: String(x.end_date_time).replace(' ', 'T').slice(0, 16), tytul: x.program,
        opis: x.notes || '', prowadzacy: x.person || '', foto: null, kategoria: '', link: 'https://www.rmf.fm/ramowka.html' });
    });
  } else if (z.typ === 'eurozet') {
    d.forEach(function (x) {
      var p = x.program || {}, kon = +x.end > +x.start ? +x.end : 86400;
      w.push({ od: wDniu_(data, hhmm_(+x.start)), do: kon >= 86400 ? nastepnyDzien_(data) + 'T00:00' : wDniu_(data, hhmm_(kon)), tytul: p.name || '',
        opis: '', prowadzacy: (x.people || []).map(function (o) { return o.name; }).join(', '), foto: (p.image || {})['size-228x228'] || (p.image || {}).square || null,
        kategoria: '', link: null });
    });
  } else if (z.typ === 'krakow') {
    (d.schedule || []).forEach(function (x) {
      w.push({ od: String(x.startsAt).slice(0, 16), do: String(x.endsAt).slice(0, 16), tytul: x.title, opis: '',
        prowadzacy: (x.presenters || []).map(function (o) { return o.name; }).join(', '),
        foto: x.coverUrl ? 'https://radiokrakow.pl' + x.coverUrl : null, kategoria: '', link: x.url ? 'https://radiokrakow.pl' + x.url : null });
    });
  } else if (z.typ === 'rmfmaxx') {
    // tydzień: każda pozycja ma datę najbliższej emisji; dzień tygodnia tej daty = dzień tygodnia w ramówce
    var tg = new Date(data + 'T12:00:00Z').getUTCDay();
    (Array.isArray(d) ? d : [d]).forEach(function (dzien) {
      Object.keys(dzien || {}).forEach(function (k) {
        var x = dzien[k];
        if (!x || !x.najblizszy || new Date(x.najblizszy.slice(0, 10) + 'T12:00:00Z').getUTCDay() !== tg) return;
        var kon = String(x.godzina_koniec || '24:00').slice(0, 5);
        if (kon === '00:00' || kon <= String(x.godzina_poczatek).slice(0, 5)) kon = '24:00';
        w.push({ od: wDniu_(data, String(x.godzina_poczatek).slice(0, 5)), do: wDniu_(data, kon), tytul: (x.program_detale || {}).nazwa || '',
          opis: '', prowadzacy: (x.prowadzacy_detale || []).map(function (o) { return o.realname; }).join(', '),
          foto: (x.program_detale || {}).avatarUrl ? 'https://www.rmfmaxx.pl' + x.program_detale.avatarUrl : null, kategoria: '',
          link: (x.program_detale || {}).programUrl ? 'https://www.rmfmaxx.pl' + x.program_detale.programUrl : null });
      });
    });
  }
  else if (z.typ === 'mcradio') {
    dzienZPozycji_(data, (d[DNI_PL_[dzienTygodnia_(data)]] || []).map(function (x) {
      return { od: String(x.start).slice(0, 5), do: String(x.end).slice(0, 5) === '00:00' ? '24:00' : String(x.end).slice(0, 5), tytul: x.name, prowadzacy: x.presenter && x.presenter.charAt(0) !== '#' ? x.presenter : '', link: x.link ? 'https://www.mcradio.pl' + x.link : null };
    })).forEach(function (x) { w.push(x); });
  }
  return w.filter(function (x) { return x.tytul && x.od < x.do; }).sort(function (a, b) { return a.od < b.od ? -1 : 1; });
}

/** Ramówki ze zwykłych stron (HTML): Time/ZPR, Radio Łódź, Weekend FM, Radio Szczecin, Radio Białystok. */
function parsujRamowkeHtml_(z, data, html) {
  var L = htmlNaLinie_(html), tg = dzienTygodnia_(data), poz = [];
  if (z.typ === 'poznan') {
    var cz = String(html).split(/<div id="week_day_(\d)">/);   // [przed, nr, treść, nr, treść, …]
    for (var c = 1; c < cz.length; c += 2) {
      if (+cz[c] !== tg) continue;
      htmlNaLinie_(cz[c + 1].split('</ul>')[0]).forEach(function (l, i, LL) {
        var m = CZAS_LINIA_.exec(l);
        if (m && LL[i + 1] && !CZAS_LINIA_.test(LL[i + 1])) poz.push({ od: gg_(m[1], m[2]), tytul: LL[i + 1] });
      });
    }
  } else if (z.typ === 'luz') {
    var dniEn = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    String(html).split(/js-schedule-(?=monday|tuesday|wednesday|thursday|friday|saturday|sunday)/).slice(1).forEach(function (blok) {
      if (blok.indexOf(dniEn[tg]) !== 0) return;
      var t = /schedule__broadcast-p">\s*([01]?\d|2[0-3]):([0-5]\d)/.exec(blok), h = /schedule__broadcast-title">([^<]+)</.exec(blok);
      if (!t || !h) return;
      var tydz = /data-week="(T\d)"/.exec(blok);
      poz.push({ od: gg_(t[1], t[2]), tytul: htmlNaLinie_(h[1]).join(' '), opis: tydz ? 'Co drugi tydzień (' + tydz[1] + ' – strona nie podaje, który to tydzień)' : '' });
    });
  } else if (z.typ === 'r357') {
    // zakładki dni: „08.11”, „Wczoraj”, „Dzisiaj”, „Jutro” – sekcje #scheduleList w tej samej kolejności
    var naw = [], re1 = /class="scheduleDate">\s*([^<]+?)\s*</g, mm;
    while ((mm = re1.exec(html))) naw.push(mm[1]);
    var dzisW = Utilities.formatDate(new Date(), 'Europe/Warsaw', 'yyyy-MM-dd'), idx = -1;
    naw.forEach(function (et, i) {
      var d = /^(\d\d)\.(\d\d)$/.exec(et);
      var dd = et === 'Dzisiaj' ? dzisW : et === 'Wczoraj' ? dataPlus_(dzisW, -1) : et === 'Jutro' ? dataPlus_(dzisW, 1)
        : d ? rokDlaDniaMiesiaca_(data, d[2], d[1]) : null;
      if (dd === data) idx = i;
    });
    var lista = String(html).split('id="scheduleList"')[1] || '';
    var dniH = lista.split('<div class="swiper-slide">').slice(1);
    if (idx >= 0 && dniH[idx]) dniH[idx].split('class="podcastWrap"').slice(1).forEach(function (b) {
      var g = /podcastHour">\s*<span[^>]*>\s*(\d{1,2}):(\d\d)/.exec(b), t = /podcastSubTitle[^>]*>([\s\S]*?)<\/h3>/.exec(b), au = /podcastAuthor[^>]*>([\s\S]*?)<\/div>/.exec(b);
      var l = /<a href="([^"]+)"/.exec(b);
      if (g && t) poz.push({ od: gg_(g[1], g[2]), tytul: htmlNaLinie_(t[1]).join(' '), prowadzacy: au ? htmlNaLinie_(au[1]).join(' ') : '', link: l ? 'https://radio357.pl' + l[1] : null });
    });
  } else if (z.typ === 'nowyswiat') {
    var daty = [], re2 = /rns-week-switcher-date">\s*(\d\d)\.(\d\d)\s*</g, m3;
    while ((m3 = re2.exec(html))) daty.push(rokDlaDniaMiesiaca_(data, m3[2], m3[1]));
    var i2 = daty.indexOf(data), sek = String(html).split('<li class="rns-switcher-grid-element">').slice(1);
    if (i2 >= 0 && sek[i2]) sek[i2].split('<li class="rns-switcher-single').slice(1).forEach(function (b) {
      var g = /rns-switcher-time">\s*(\d{1,2}):(\d\d)/.exec(b), t = /rns-switcher-title">([\s\S]*?)<\/h2>/.exec(b), n = /rns-switcher-names">([\s\S]*?)<\/div>/.exec(b);
      var l = /rns-switcher-title">\s*<a href="([^"]+)"/.exec(b);
      if (!g || !t) return;
      var opis = n ? htmlNaLinie_(n[1]).join(' ').split('|').map(function (x) { return x.trim(); }).filter(Boolean) : [];
      poz.push({ od: gg_(g[1], g[2]), tytul: htmlNaLinie_(t[1]).join(' '), prowadzacy: opis[0] || '', opis: opis.slice(1).join(' · '), link: l ? l[1] : null });
    });
  } else if (z.typ === 'afera') {
    var sl = String(html).split(/<div class='slide_(\d) slide'>/);
    for (var c = 1; c < sl.length; c += 2) {
      if (+sl[c] !== tg + 1) continue;
      var re = /<p class='date'>\s*([01]?\d|2[0-3]):([0-5]\d)\s*<\/p>\s*<p class='name'[^>]*?(?:title="([^"]*)")?[^>]*>\s*(?:<a[^>]*href="([^"]*)"[^>]*>)?([^<]+)/g, m, ost = -1;
      while ((m = re.exec(sl[c + 1]))) {
        var h = +m[1];
        if (h * 60 + +m[2] < ost) h += 24;   // po północy
        ost = h * 60 + +m[2];
        poz.push({ od: gg_(h, m[2]), tytul: htmlNaLinie_(m[5]).join(' '), opis: m[3] ? htmlNaLinie_(m[3]).join(' ').slice(0, 300) : '', link: m[4] || null });
      }
    }
  } else if (z.typ === 'zpr') {
    L.forEach(function (l, i) {
      var m = /^(.+?)\s+od\s+([01]?\d|2[0-3]):([0-5]\d)$/.exec(l);
      if (!m || !dniZpr_(m[1])[tg]) return;
      var tytul = L[i + 1] || '', prow = L[i + 2] || '';
      if (/\sod\s+\d/.test(tytul)) return;
      if (/\sod\s+\d/.test(prow) || prow.length > 60 || prow === prow.toLowerCase()) prow = '';
      poz.push({ od: gg_(m[2], m[3]), tytul: tytul, prowadzacy: prow });
    });
  } else if (z.typ === 'lodz') {
    L.forEach(function (l) {   // tylko bloki z godziną początku i końca; pojedyncze godziny to punkty wewnątrz bloków
      var m = /^([01]?\d|2[0-3])[:.]([0-5]\d)\s*[-–—]\s*([01]?\d|2[0-4])[:.]([0-5]\d)\s+(.+)$/.exec(l);
      if (m) poz.push({ od: gg_(m[1], m[2]), do: gg_(m[3], m[4]), tytul: m[5] });
    });
    // pasmo powtórkowe w środku nocnego bloku zostawiamy jako osobną pozycję – siatka pokaże je na drugim torze
  } else if (z.typ === 'weekend') {
    if (tg >= 5) poz.push({ od: '00:00', do: '24:00', tytul: 'Weekend pełen muzyki w Weekend FM' });
    else {
      var i0 = L.indexOf('Pasma');
      L.slice(i0 >= 0 ? i0 : 0, (i0 >= 0 ? i0 : 0) + 12).forEach(function (l) {
        var m = /^(\d\d):(\d\d)-(\d\d):(\d\d)\s+-\s+(.+)$/.exec(l);
        if (!m) return;
        var od = m[1] + ':' + m[2], doo = m[3] + ':' + m[4];
        if (doo < od) { poz.push({ od: '00:00', do: doo, tytul: m[5] }); doo = '24:00'; }
        poz.push({ od: od, do: doo, tytul: m[5] });
      });
    }
  } else if (z.typ === 'szczecin' || z.typ === 'bialystok') {
    var bezPiosenek = z.typ === 'bialystok';
    L.forEach(function (l, i) {
      var m = CZAS_LINIA_.exec(l), tytul = null;
      if (m) tytul = L[i + 1];
      else if (bezPiosenek) { var m2 = /^([01]?\d|2[0-3])[:.]([0-5]\d)\s+(.+)$/.exec(l); if (m2) { m = m2; tytul = m2[3]; } }
      if (!m || !tytul || CZAS_LINIA_.test(tytul) || /^[-–]/.test(tytul) || /^(graliśmy|słuchaj teraz)$/i.test(tytul) || tytul.length > 120) return;
      var opis = !bezPiosenek && L[i + 2] && !CZAS_LINIA_.test(L[i + 2]) && L[i + 2].length > 20 ? L[i + 2] : '';
      poz.push({ od: gg_(m[1], m[2]), tytul: tytul, opis: opis });
    });
    // Szczecin pokazuje audycje od teraz (bez dat) – godziny malejące oznaczają następny dzień: ucinamy
    var w2 = [];
    for (var k = 0; k < poz.length; k++) { if (k && poz[k].od < poz[k - 1].od) break; w2.push(poz[k]); }
    poz = w2;
  }
  var wid = {};
  poz = poz.filter(function (x) { var k = x.od + '|' + x.tytul; if (wid[k]) return false; wid[k] = 1; return true; });
  return dzienZPozycji_(data, poz);
}

/** Ramówki wskazanych stacji (domyślnie wszystkich ze źródłem) na dzień RRRR-MM-DD: {stacja: [{od, do, tytul, opis, foto, kategoria, link}]}. */
/**
 * Ramówki dnia (F4): z pliku na Dysku (_agg/ramowki_dzien/RRRR-MM-DD.json, wszystkie stacje), ważnego 2 h dla dziś
 * i 12 h dla innych dni; plik odświeża co godzinę wyzwalacz odswiezRamowki (zainstalujPanel). Brak albo stary plik –
 * liczymy wszystkie stacje na żywo i zapisujemy. Wcześniej wynik nie mieścił się w pamięci serwera (limit 100 KB)
 * i każde otwarcie Ramówek pobierało ok. 25 stron.
 */
function ramowka(data, stacje) {
  return bezpiecznie_(function () {
    data = data || Utilities.formatDate(new Date(), 'Europe/Warsaw', 'yyyy-MM-dd');
    var dzis = Utilities.formatDate(new Date(), 'Europe/Warsaw', 'yyyy-MM-dd');
    var r = ramowkaDnia_(data, data === dzis ? 2 : 12);
    if (stacje && stacje.length) {
      var w = {};
      stacje.forEach(function (s) { if (r.stacje[s] !== undefined) w[s] = r.stacje[s]; });
      return { data: r.data, stacje: w, zrodla: r.zrodla, grupy: r.grupy, zapisano: r.zapisano };
    }
    return r;
  });
}
function ramowkaDnia_(data, waznoscGodzin) {
  var f = podfolder(folderAgg_(), 'ramowki_dzien', true), plik = czytajJsonPlik(f, data + '.json');
  if (plik && plik.stacje && Date.now() - Date.parse(plik.zapisano) < waznoscGodzin * 36e5) return plik;
  var r = ramowkaLicz_(data, null);
  r.zapisano = new Date().toISOString();
  try { zapiszJsonPlik(f, data + '.json', r); } catch (e) { /* zapis nieudany – zwracamy wynik bez pliku */ }
  return r;
}
/**
 * E2: e-mail o audycjach z listy przypomnień (moje.json), które zaczną się w ciągu najbliższych 75 minut
 * (wyzwalacz co godzinę – więc przypomnienie przychodzi 15–75 min przed). Każda emisja raz.
 */
function przypomnieniaAudycji_() {
  var m = czytajJsonPlik(folderAgg_(), 'moje.json') || {}, lista = m.przypomnienia || [];
  if (!lista.length) return;
  var teraz = Utilities.formatDate(new Date(), 'Europe/Warsaw', "yyyy-MM-dd'T'HH:mm"), za = Utilities.formatDate(new Date(Date.now() + 75 * 6e4), 'Europe/Warsaw', "yyyy-MM-dd'T'HH:mm");
  var wyslane = m.przypomnieniaWyslane || {}, nowe = [];
  [teraz.slice(0, 10), za.slice(0, 10)].filter(function (d, i, a) { return a.indexOf(d) === i; }).forEach(function (d) {
    var r = ramowkaDnia_(d, 12);
    lista.forEach(function (p) {
      var l = r.stacje[p.s];
      if (!Array.isArray(l)) return;
      l.forEach(function (a) {
        var k = p.s + '|' + a.od;
        if (a.od > teraz && a.od <= za && String(a.tytul).toLowerCase() === p.t.toLowerCase() && !wyslane[k]) { wyslane[k] = d; nowe.push({ s: p.s, a: a }); }
      });
    });
  });
  if (!nowe.length) return;
  MailApp.sendEmail(Session.getEffectiveUser().getEmail(), 'Music Base: ' + nowe.map(function (x) { return x.a.tytul; }).join(', ') + ' – niedługo na antenie',
    nowe.map(function (x) { return x.a.tytul + ' · ' + nazwaJednostki_(x.s) + ' · ' + x.a.od.slice(11) + '–' + x.a.do.slice(11) + (x.a.prowadzacy ? ' · ' + x.a.prowadzacy : ''); }).join('\n') +
    '\n\nPrzypomnienia zmienisz w panelu Music Base (szczegóły audycji w Ramówkach albo Alerty i ustawienia).');
  wyslijNtfyP_('Niedługo na antenie', nowe.map(function (x) { return x.a.tytul + ' · ' + nazwaJednostki_(x.s) + ' · ' + x.a.od.slice(11); }).join('\n'));
  var granica = dataPlus_(teraz.slice(0, 10), -3);
  Object.keys(wyslane).forEach(function (k) { if (wyslane[k] < granica) delete wyslane[k]; });
  m.przypomnieniaWyslane = wyslane;
  zapiszJsonPlik(folderAgg_(), 'moje.json', m);
}

/** Wyzwalacz co godzinę: ramówki na dziś i jutro do plików; usuwa pliki starsze niż 3 dni. */
function odswiezRamowki() {
  var dzis = Utilities.formatDate(new Date(), 'Europe/Warsaw', 'yyyy-MM-dd');
  [dzis, dataPlus_(dzis, 1)].forEach(function (d) { ramowkaDnia_(d, 0); });
  try { przypomnieniaAudycji_(); } catch (e) { console.log('przypomnienia: ' + e.message); }
  try { alertyRozszerzone_(); } catch (e) { console.log('alerty: ' + e.message); }
  var f = podfolder(folderAgg_(), 'ramowki_dzien', true), it = f.getFiles(), granica = dataPlus_(dzis, -3);
  while (it.hasNext()) { var p = it.next(); if (p.getName() < granica + '.json') p.setTrashed(true); }
}

function ramowkaLicz_(data, stacje) {
  return (function () {
    data = data || Utilities.formatDate(new Date(), 'Europe/Warsaw', 'yyyy-MM-dd');
    var dzis = Utilities.formatDate(new Date(), 'Europe/Warsaw', 'yyyy-MM-dd');
    // strony, które pokazują tylko bieżący dzień, nie mają ramówki na inne dni
    stacje = (stacje && stacje.length ? stacje : Object.keys(ZRODLA_RAMOWEK)).filter(function (s) { return ZRODLA_RAMOWEK[s] && (!ZRODLA_RAMOWEK[s].tylkoDzis || data === dzis); });
    return (function () {
      var zapytania = stacje.map(function (s) {
        if (ZRODLA_RAMOWEK[s].typ === 'plik') return null;
        return { url: adresRamowki_(ZRODLA_RAMOWEK[s], data), muteHttpExceptions: true,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MusicBase/1.0)', 'Accept': 'application/json' } };
      });
      // źródła z pliku na Dysku (bez zapytania sieciowego)
      var wynik = {}, zSieci = [];
      stacje.forEach(function (s, i) {
        if (ZRODLA_RAMOWEK[s].typ !== 'plik') { zSieci.push(i); return; }
        var f = podfolder(folderAgg_(), 'ramowki', false), plik = f && czytajJsonPlik(f, s + '.json');
        wynik[s] = !plik ? { blad: 'brak pliku ramówki (uruchom ramowkaDoMusicBase w Meteor Analytics)' }
          : plik.pozycje.filter(function (p) { return p.do > data + 'T00:00' && p.od < nastepnyDzien_(data) + 'T00:00'; })
            .map(function (p) { return { od: p.od, do: p.do, tytul: p.tytul, prowadzacy: p.prowadzacy || '', kategoria: p.kategoria || '', opis: '', foto: null, link: null }; });
      });
      zapytania = zSieci.map(function (i) { return zapytania[i]; });
      var stacjeSieci = zSieci.map(function (i) { return stacje[i]; });
      var odp = zapytania.length ? UrlFetchApp.fetchAll(zapytania) : [];
      odp.forEach(function (o, i) {
        if (o.getResponseCode() !== 200) { wynik[stacjeSieci[i]] = { blad: 'HTTP ' + o.getResponseCode() }; return; }
        var z = ZRODLA_RAMOWEK[stacjeSieci[i]];
        try { wynik[stacjeSieci[i]] = ['zpr', 'lodz', 'weekend', 'szczecin', 'bialystok', 'poznan', 'luz', 'afera', 'r357', 'nowyswiat'].indexOf(z.typ) >= 0 ? parsujRamowkeHtml_(z, data, o.getContentText()) : parsujRamowke_(z, data, o.getContentText()); }
        catch (e) { wynik[stacjeSieci[i]] = { blad: 'nieczytelna odpowiedź źródła' }; }
      });
      return { data: data, stacje: wynik, zrodla: Object.keys(ZRODLA_RAMOWEK), grupy: grupyStacji_() };
    })();
  })();
}


/**
 * N3: alerty liczone raz dziennie (pierwsze uruchomienie po 8:00) z gotowych agregatów, za dobę wczorajszą:
 *  - top10: utwór wchodzi do top 10 stacji (albo całego radia) z ostatnich 7 dni,
 *  - debiut3: nowy utwór (pierwsza emisja w bazie ≤ 7 dni temu) grany już na ≥ 3 stacjach,
 *  - powrot: wykonawca grany wczoraj po ≥ 90 dniach ciszy (wykonawcy z ≥ 30 emisjami w bazie albo wskazany).
 * Pierwsze sprawdzenie top 10 tylko zapamiętuje stan (bez e-maila), żeby nie wysłać całej listy naraz.
 */
var TYPY_ALERTOW_DZIENNYCH = { top10: 1, debiut3: 1, powrot: 1 };
function alertyRozszerzone_(wymus) {
  var fa = folderAgg_(), u = czytajJsonPlik(fa, 'ustawienia.json') || {};
  var al = (u.alerty || []).filter(function (a) { return TYPY_ALERTOW_DZIENNYCH[a.typ]; });
  if (!al.length) return { tresc: [] };
  var dzis = Utilities.formatDate(new Date(), 'Europe/Warsaw', 'yyyy-MM-dd'), godz = +Utilities.formatDate(new Date(), 'Europe/Warsaw', 'H');
  if (!wymus && (u.alertyDzien === dzis || godz < 8)) return { tresc: [] };
  var wczoraj = dataPlus_(dzis, -1), stan = u.alertyStan || {}, tresc = [];
  // emisje utworów jednostki w dniach [od, doo] z miesięcznych agregatów
  var emisjeDni = function (j, od, doo) {
    var w = {}, m = od.slice(0, 7);
    while (m <= doo.slice(0, 7)) {
      var g = agg_(j, m + '.json.gz');
      if (g && g.u) Object.keys(g.u).forEach(function (k) {
        var x = g.u[k];
        Object.keys(x[3] || {}).forEach(function (dd) {
          var d = m + '-' + dd;
          if (d >= od && d <= doo) { var e = w[k] = w[k] || [x[0], x[1], 0, {}]; e[2] += x[3][dd]; e[3][d] = 1; }
        });
      });
      m = dataPlus_(m + '-28', 7).slice(0, 7);
    }
    return w;
  };
  al.forEach(function (a) {
    if (a.typ !== 'top10') return;
    (a.stacje && a.stacje.length ? a.stacje : ['_wszystkie']).forEach(function (j) {
      var w = emisjeDni(j, dataPlus_(wczoraj, -6), wczoraj);
      var top = Object.keys(w).sort(function (x, y) { return w[y][2] - w[x][2]; }).slice(0, 10), kl = a.id + '|' + j, bylo = stan[kl];
      if (bylo) top.forEach(function (k, i) { if (bylo.indexOf(k) < 0) tresc.push('Nowy w top 10 (' + nazwaJednostki_(j) + ', 7 dni): ' + w[k][0] + ' – ' + w[k][1] + ' · miejsce ' + (i + 1) + ', ' + w[k][2] + ' emisji'); });
      if (top.length) stan[kl] = top;
    });
  });
  if (al.some(function (a) { return a.typ === 'debiut3'; })) {
    // debiuty z Odbiornika (debiuty.json.gz: k → [a, t, n, pierwsza, stacji, pierwsza jednostka]) zamiast pełnego indeksu
    var deb = agg_('_wszystkie', 'debiuty.json.gz'), du = (deb && deb.u) || {};
    var od7 = dataPlus_(dzis, -7), wys = stan.debiut3 || {};
    Object.keys(du).forEach(function (k) {
      var x = du[k];
      if (String(x[3]).slice(0, 10) >= od7 && x[4] >= 3 && !wys[k]) { wys[k] = dzis; tresc.push('Debiut na ' + x[4] + ' stacjach w tydzień: ' + x[0] + ' – ' + x[1] + ' (pierwsza emisja ' + String(x[3]).slice(0, 10) + ', ' + x[2] + ' emisji)'); }
    });
    Object.keys(wys).forEach(function (k) { if (wys[k] < dataPlus_(dzis, -30)) delete wys[k]; });
    stan.debiut3 = wys;
  }
  var pow = al.filter(function (a) { return a.typ === 'powrot'; });
  if (pow.length) {
    var tylko = {}, wszyscy = pow.some(function (a) { return a.klucz === '_powrot'; });
    pow.forEach(function (a) { if (a.klucz !== '_powrot') tylko[a.klucz] = 1; });
    var gr = emisjeDni('_wszystkie', dataPlus_(wczoraj, -91), wczoraj), wk = {};
    Object.keys(gr).forEach(function (k) {
      wykonawcyKlucz(gr[k][0]).forEach(function (a) {
        var e = wk[a] = wk[a] || { nazwa: gr[k][0], wczoraj: 0, przed: 0 };
        Object.keys(gr[k][3]).forEach(function (d) { if (d === wczoraj) e.wczoraj++; else e.przed++; });
      });
    });
    var kandydaci = Object.keys(wk).filter(function (a) { return wk[a].wczoraj && !wk[a].przed && (wszyscy || tylko[a]); });
    if (kandydaci.length) {
      // emisje kandydata sprzed 91 dni: utwory, w których jest pierwszym wykonawcą (paczka indeksu) albo gościem
      var granica = dataPlus_(wczoraj, -91), dawniej = {};
      kandydaci.slice(0, 300).forEach(function (a) {
        var p = indeksPaczki_(a + '|'), gp = agg_('_wszystkie', 'goscie_' + nazwaPaczki(paczkaUtworu(a)));
        Object.keys(p).forEach(function (k) { var x = p[k]; if (k.split('|')[0] === a && String(x[3]).slice(0, 10) < granica) dawniej[a] = (dawniej[a] || 0) + x[2]; });
        ((gp && gp[a]) || []).forEach(function (x) { if (String(x[4]).slice(0, 10) < granica) dawniej[a] = (dawniej[a] || 0) + x[3]; });
      });
      kandydaci.forEach(function (a) {
        if (dawniej[a] && (tylko[a] || dawniej[a] >= 30)) tresc.push('Powrót po ≥ 90 dniach przerwy: ' + wk[a].nazwa + ' (wczoraj ' + wk[a].wczoraj + ' utw., wcześniej ' + dawniej[a] + ' emisji w bazie)');
      });
    }
  }
  u = czytajJsonPlik(fa, 'ustawienia.json') || {};   // świeży odczyt: w międzyczasie ktoś mógł zmienić alerty
  u.alertyDzien = dzis; u.alertyStan = stan;
  zapiszJsonPlik(fa, 'ustawienia.json', u);
  if (tresc.length) {
    var log = czytajJsonPlik(fa, 'alerty_log.json') || [];
    zapiszJsonPlik(fa, 'alerty_log.json', tresc.map(function (t) { return { kiedy: new Date().toISOString(), tekst: t }; }).concat(log).slice(0, 200));
    if (!wymus) MailApp.sendEmail(Session.getEffectiveUser().getEmail(), 'Music Base: ' + tresc.length + ' ' + (tresc.length === 1 ? 'alert dzienny' : 'alerty dzienne'),
      tresc.slice(0, 100).join('\n') + '\n\nAlerty zmienisz w panelu Music Base (Alerty i ustawienia).');
    if (!wymus) wyslijNtfyP_('Music Base: alerty dzienne', tresc.slice(0, 15).join('\n'));
  }
  return { tresc: tresc };
}

// ---------------- O2: dziennik zadań GitHub Actions; O1: powiadomienia ntfy ----------------

/** Ostatnie uruchomienie każdego zadania (raporty z GitHub Actions w _agg/zadania/, scraper/raport_zadania.py). */
function dziennikZadan_() {
  var f = podfolder(folderAgg_(), 'zadania', false), wynik = [], bylo = {};
  if (!f) return wynik;
  var it = f.getFiles();
  while (it.hasNext()) {
    var p = it.next(), n = p.getName();
    if (p.isTrashed() || !/\.json$/.test(n) || bylo[n]) continue;
    bylo[n] = 1;
    var d = czytajJsonPlik(f, n);
    if (!d || !d.przebiegi || !d.przebiegi.length) continue;
    var o = d.przebiegi[0];
    wynik.push({ zadanie: d.zadanie, kiedy: o.kiedy, status: o.status, bledow: o.bledow, zostalo: o.zostalo, ostatnie: o.ostatnie || [], url: o.url,
      udanych: d.przebiegi.filter(function (x) { return x.status === 'success' && !x.bledow; }).length, przebiegow: d.przebiegi.length });
  }
  return wynik.sort(function (a, b) { return a.zadanie < b.zadanie ? -1 : 1; });
}

/** O1: powiadomienie ntfy (temat w _agg/ustawienia.json – ustawiany w panelu); bez tematu nic nie robi. */
function wyslijNtfyP_(tytul, tresc) {
  try {
    var u = czytajJsonPlik(folderAgg_(), 'ustawienia.json') || {};
    if (!u.ntfy) return false;
    var odp = UrlFetchApp.fetch('https:\/\/ntfy.sh/', { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ topic: u.ntfy, title: String(tytul).slice(0, 200), message: String(tresc).slice(0, 3900) }) });
    return odp.getResponseCode() < 300;
  } catch (e) { return false; }
}
/** Ustawienia ntfy z panelu: akcja 'stan' | 'wlacz' (nowy losowy temat) | 'test' | 'wylacz'. */
function ntfyUstawienia(akcja) {
  return bezpiecznie_(function () {
    var fa = folderAgg_(), u = czytajJsonPlik(fa, 'ustawienia.json') || {};
    if (akcja === 'wlacz') { u.ntfy = 'musicbase-' + Utilities.getUuid().replace(/-/g, '').slice(0, 20); zapiszJsonPlik(fa, 'ustawienia.json', u); }
    if (akcja === 'wylacz') { delete u.ntfy; zapiszJsonPlik(fa, 'ustawienia.json', u); }
    var test = akcja === 'test' ? wyslijNtfyP_('Music Base: test', 'Powiadomienia działają. ' + Utilities.formatDate(new Date(), 'Europe/Warsaw', 'HH:mm')) : null;
    return { temat: u.ntfy || null, test: test };
  });
}

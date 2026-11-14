/**
 * Music Base – Panel: Biuro muzyczne (plan rozwoju D1, D3–D7, D9–D15, O5; 14.11.2026).
 * Własna stacja (moje.mojaStacja, domyślnie Radio Meteor – playlista z mAirList, D2) na tle rynku, notowanie tygodniowe,
 * dodania („Most Added”), zmęczenie utworem, lista na spotkanie muzyczne, plan rotacji, kwota polska (art. 15),
 * separacje, eksport do mAirList i zestawienie do rozliczeń z OZZ, budowa godziny u konkurencji, wczesne sygnały.
 * Dane: małe pliki liczone przez Odbiornik (tygodnie_RRRR, dodania, zmeczenie, debiuty, debiuty_stacje) i podsumowania stacji.
 */

var DOMYSLNA_MOJA_STACJA = 'radio_meteor';
function mojaStacja_() { return moje_().mojaStacja || DOMYSLNA_MOJA_STACJA; }
function dzisP_() { return Utilities.formatDate(new Date(), 'Europe/Warsaw', 'yyyy-MM-dd'); }
function poniedzialekP_(iso) { var d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); }
function mediana_(l) { if (!l.length) return null; l = l.slice().sort(function (a, b) { return a - b; }); var p = l.length >> 1; return l.length % 2 ? l[p] : (l[p - 1] + l[p]) / 2; }
function dniRoznicy_(a, b) { return Math.round((Date.parse(String(b).slice(0, 10) + 'T12:00:00Z') - Date.parse(String(a).slice(0, 10) + 'T12:00:00Z')) / 864e5); }

/** Ustawienia biura: moja stacja (i lista stacji do wyboru). */
function biuroStart() {
  return bezpiecznie_(function () {
    var j = mojaStacja_();
    return { mojaStacja: j, nazwa: nazwaJednostki_(j), dzis: dzisP_(), rotacja: planRotacji_(j), decyzji: Object.keys(decyzje_().u || {}).length };
  });
}
function ustawMojaStacje(j) {
  return bezpiecznie_(function () {
    var fa = folderAgg_(), m = czytajJsonPlik(fa, 'moje.json') || {};
    m.mojaStacja = String(j || DOMYSLNA_MOJA_STACJA);
    zapiszJsonPlik(fa, 'moje.json', m);
    return { mojaStacja: m.mojaStacja };
  });
}

// ---------------- D4: notowanie tygodniowe z ruchem ----------------

/** Listy tygodniowe (300 najczęściej granych, Odbiornik) z podanych lat: {poniedziałek: {n, min, u: [[k, n, a, t]]}}. */
function tygodnie_(lata) {
  var w = {};
  lata.forEach(function (r) { var t = agg_('_wszystkie', 'tygodnie_' + r + '.json.gz'); if (t && t.w) Object.keys(t.w).forEach(function (pn) { w[pn] = t.w[pn]; }); });
  return w;
}
/** Miejsca w tygodniu: competition ranking (remis – to samo miejsce). */
function miejscaTygodnia_(w) {
  var l = w.u.slice().sort(function (a, b) { return b[1] - a[1]; }), m = {};
  l.forEach(function (x, i) { m[x[0]] = i && l[i - 1][1] === x[1] ? m[l[i - 1][0]] : i + 1; });
  return m;
}
function notowanie(pn, ile) {
  return bezpiecznie_(function () {
    ile = Math.max(10, Math.min(+ile || 100, 300));
    var rokT = +dzisP_().slice(0, 4), lata = [];
    for (var r = 2022; r <= rokT; r++) lata.push(r);
    var T = tygodnie_(lata), wszystkie = Object.keys(T).sort();
    var ostatniPelny = poniedzialekP_(dataPlus_(dzisP_(), -7));
    if (!pn || !T[pn]) pn = wszystkie.filter(function (x) { return x <= ostatniPelny; }).pop() || wszystkie.pop();
    if (!pn) return { blad: 'Listy tygodniowe liczy Odbiornik (pliki tygodnie_RRRR) – pojawią się po najbliższym przeliczeniu.' };
    var M = {};
    wszystkie.forEach(function (t) { if (t <= pn) M[t] = miejscaTygodnia_(T[t]); });
    var pop = dataPlus_(pn, -7), mPop = M[pop] || {}, nPop = {};
    ((T[pop] || {}).u || []).forEach(function (x) { nPop[x[0]] = x[1]; });
    var w = T[pn], mT = M[pn];
    var pozycje = w.u.filter(function (x) { return mT[x[0]] <= ile; }).sort(function (a, b) { return b[1] - a[1]; }).map(function (x) {
      var k = x[0], tyg = 0, naj = null;
      Object.keys(M).forEach(function (t) { var mm = M[t][k]; if (mm && mm <= ile) { tyg++; if (naj === null || mm < naj) naj = mm; } });
      return { k: k, a: x[2] || k.split('|')[0], t: x[3] || k.split('|')[1], n: x[1], miejsce: mT[k], poprzednio: mPop[k] && mPop[k] <= ile ? mPop[k] : null,
        nPoprzednio: nPop[k] == null ? null : nPop[k], tygodni: tyg, najwyzej: naj };
    });
    var meta = metadane_();
    pozycje.forEach(function (x) { var m = meta[x.k] || {}; x.y = m.y || null; x.c = m.c || null; x.w = m.w || null; });
    return { tydzien: pn, poprzedni: T[pop] ? pop : null, utworow: w.n, ile: ile, tygodnie: wszystkie.slice().reverse().slice(0, 156), pozycje: pozycje,
      wzrosty: pozycje.filter(function (x) { return x.nPoprzednio != null; }).sort(function (a, b) { return (b.n - b.nPoprzednio) - (a.n - a.nPoprzednio); }).slice(0, 10).map(function (x) { return x.k; }) };
  });
}

// ---------------- D3: dodania tygodnia („Most Added”) ----------------

function dodaniaTygodnia(pn) {
  return bezpiecznie_(function () {
    var d = agg_('_wszystkie', 'dodania.json.gz');
    if (!d || !d.tygodnie) return { blad: 'Dodania liczy Odbiornik z pierwszych emisji na każdej stacji – pojawią się po przeliczeniu (pierwszy raz zajmuje kilka godzin).' };
    var tyg = Object.keys(d.tygodnie).sort();
    if (!pn || !d.tygodnie[pn]) pn = tyg.filter(function (x) { return x <= poniedzialekP_(dataPlus_(dzisP_(), -7)); }).pop() || tyg.pop();
    var w = d.tygodnie[pn] || { stacje: {}, u: [] }, meta = metadane_();
    return { tydzien: pn, tygodnie: tyg.reverse(), zbudowano: d.zbudowano, dodan: w.dodan,
      stacje: Object.keys(w.stacje).map(function (j) { return { id: j, nazwa: nazwaJednostki_(j), n: w.stacje[j] }; }).sort(function (a, b) { return b.n - a.n; }),
      u: w.u.map(function (x) { var m = meta[x[0]] || {}; return { k: x[0], a: x[1], t: x[2], stacji: x[3], kto: x[4].map(function (p) { return { id: p[0], nazwa: nazwaJednostki_(p[0]), d: p[1] }; }), y: m.y || null, c: m.c || null, w: m.w || null }; }) };
  });
}

// ---------------- D7: zmęczenie utworem na rynku ----------------

function zmeczenieRynku() {
  return bezpiecznie_(function () {
    var z = agg_('_wszystkie', 'zmeczenie.json.gz');
    if (!z) return { blad: 'Zmęczenie liczy Odbiornik raz na dobę – pojawi się po najbliższym przeliczeniu.' };
    z.u.forEach(function (x) { x.wczesni.forEach(function (w) { w.nazwa = nazwaJednostki_(w.j); }); });
    return z;
  });
}

// ---------------- D1: moja stacja na tle rynku ----------------

/**
 * Okres do 92 dni: luki (utwory grane szeroko na rynku, których stacja nie grała), utwory grane tylko u nas, udział
 * polskich, tempo wchodzenia nowości (mediana dni od pierwszej emisji w bazie do pierwszej emisji u nas) i rotacja.
 */
function mojaStacjaNaTle(j, od, doo) {
  return bezpiecznie_(function () {
    j = j || mojaStacja_();
    if (dniRoznicy_(od, doo) > 92) od = dataPlus_(doo, -92);
    return zPamieci_('naTle1|' + j + '|' + od + '|' + doo, 3600, function () {
      var meta = metadane_(), moje = zbierz_(j, od, doo), rynek = {};
      var czlonkowie = SIECI[j] ? SIECI[j].czlonkowie : [j];
      miesiaceZakresu_(od, doo).forEach(function (m) {
        var g = agg_('_wszystkie', m + '.json.gz');
        if (!g) return;
        var pocz = od.slice(0, 7) === m ? od.slice(8, 10) : '01', kon = doo.slice(0, 7) === m ? doo.slice(8, 10) : '31';
        Object.keys(g.u).forEach(function (k) {
          var x = g.u[k], n = 0;
          Object.keys(x[3]).forEach(function (d) { if (d >= pocz && d <= kon) n += x[3][d]; });
          if (!n) return;
          var e = rynek[k] || (rynek[k] = { a: x[0], t: x[1], n: 0, st: {} });
          e.n += n;
          Object.keys(x[4]).forEach(function (s) { if (s !== j && czlonkowie.indexOf(s) < 0) e.st[s] = 1; });
        });
      });
      var wiersz = function (k, e) { var m = meta[k] || {}; return { k: k, a: e.a, t: e.t, n: e.n, stacji: Object.keys(e.st || {}).length, y: m.y || null, c: m.c || null, w: m.w || null, bpm: m.bpm || null }; };
      // „szeroko”: na ≥ 5 innych jednostkach (przy małej bazie – na co najmniej 1/3 z nich, minimum 2)
      var prog = Math.min(5, Math.max(2, Math.ceil(jednostkiGlowneP_().length / 3)));
      var luki = Object.keys(rynek).filter(function (k) { return !moje.u[k] && Object.keys(rynek[k].st).length >= prog; })
        .sort(function (a, b) { return rynek[b].n - rynek[a].n; }).slice(0, 150).map(function (k) { return wiersz(k, rynek[k]); });
      var tylkoU = Object.keys(moje.u).filter(function (k) { return !rynek[k] || !Object.keys(rynek[k].st).length; })
        .sort(function (a, b) { return moje.u[b][2] - moje.u[a][2]; }).slice(0, 150).map(function (k) { var x = moje.u[k]; return wiersz(k, { a: x[0], t: x[1], n: x[2] }); });
      var pl = function (u, nOf) { var z = 0, p = 0; Object.keys(u).forEach(function (k) { var c = (meta[k] || {}).c, n = nOf(u[k]); if (c) { z += n; if (c === 'PL') p += n; } }); return z ? p / z : null; };
      // nowości: debiuty (≤ 400 dni) zagrane u nas – po ilu dniach od pierwszej emisji w bazie
      var ds = (agg_('_wszystkie', 'debiuty_stacje.json.gz') || {}).u || {}, opoz = [], opozWszyscy = {};
      Object.keys(ds).forEach(function (k) {
        var st = ds[k], pierwsza = null;
        Object.keys(st).forEach(function (s) { if (!pierwsza || st[s] < pierwsza) pierwsza = st[s]; });
        Object.keys(st).forEach(function (s) { (opozWszyscy[s] = opozWszyscy[s] || []).push(dniRoznicy_(pierwsza, st[s])); });
      });
      var medStacji = Object.keys(opozWszyscy).filter(function (s) { return opozWszyscy[s].length >= 10; }).map(function (s) { return [s, mediana_(opozWszyscy[s])]; }).sort(function (a, b) { return a[1] - b[1]; });
      (opozWszyscy[j] || []).forEach(function (d) { opoz.push(d); });
      var lista = Object.keys(moje.u).map(function (k) { return moje.u[k][2]; }).sort(function (a, b) { return b - a; });
      var top20 = lista.slice(0, 20).reduce(function (s, x) { return s + x; }, 0);
      return {
        j: j, nazwa: nazwaJednostki_(j), od: od, do: doo, emisji: moje.emisji, utworow: lista.length, luki: luki, tylkoU: tylkoU,
        udzialPL: pl(moje.u, function (x) { return x[2]; }), udzialPLrynek: pl(rynek, function (x) { return x.n; }),
        nowosciMediana: mediana_(opoz), nowosciUtworow: opoz.length, nowosciMiejsce: medStacji.map(function (x) { return x[0]; }).indexOf(j) + 1 || null, nowosciStacji: medStacji.length,
        nowosciRynekMediana: mediana_(medStacji.map(function (x) { return x[1]; })),
        rotacjaTop20: moje.emisji ? top20 / moje.emisji : null,
      };
    });
  });
}

// ---------------- D5: lista na spotkanie muzyczne ----------------

function decyzje_() { return czytajJsonPlik(folderAgg_(), 'decyzje.json') || { u: {}, historia: [] }; }
/** Utwory kiedykolwiek grane na stacji: plik pierwszych emisji (Odbiornik), a bez niego ostatni rok. */
function graneNaStacji_(j) {
  var p = agg_(j, 'pierwsze.json.gz');
  if (p) return p;
  var z = zbierz_(j, dataPlus_(dzisP_(), -365), dzisP_()), w = {};
  Object.keys(z.u).forEach(function (k) { w[k] = 1; });
  return w;
}
function kandydaciSpotkania(j) {
  return bezpiecznie_(function () {
    j = j || mojaStacja_();
    var dzis = dzisP_(), grane = graneNaStacji_(j), meta = metadane_(), dec = decyzje_(), kand = {};
    var deb = (agg_('_wszystkie', 'debiuty.json.gz') || {}).u || {}, ds = (agg_('_wszystkie', 'debiuty_stacje.json.gz') || {}).u || {};
    var dodaj = function (k, a, t, n, powod) {
      if (grane[k]) return;
      var d = dec.u[k];
      if (d && (d.stan === 'dodaj' || d.stan === 'odrzuc')) return;
      if (d && d.stan === 'wroc' && d.wroc > dzis) return;
      var e = kand[k] || (kand[k] = { k: k, a: a, t: t, n: n, powody: [] });
      if (e.powody.indexOf(powod) < 0) e.powody.push(powod);
      if (n > e.n) e.n = n;
    };
    // debiuty z ostatnich 30 dni grane już na ≥ 3 stacjach
    Object.keys(deb).forEach(function (k) { var x = deb[k]; if (String(x[3]).slice(0, 10) >= dataPlus_(dzis, -30) && x[4] >= 3) dodaj(k, x[0], x[1], x[2], 'debiut na ' + x[4] + ' stacjach'); });
    // polskie nowości (≤ 90 dni, ≥ 5 emisji)
    Object.keys(deb).forEach(function (k) { var x = deb[k], m = meta[k] || {}; if (String(x[3]).slice(0, 10) >= dataPlus_(dzis, -90) && x[2] >= 5 && (m.c === 'PL' || m.j === 'pl')) dodaj(k, x[0], x[1], x[2], 'polska nowość'); });
    // rosnące na stacjach o podobnym formacie (14 dni wobec 14 poprzednich)
    var pod = podobneStacje(j, dataPlus_(dzis, -30), dzis), podobne = ((pod && pod.stacje) || []).slice(0, 5);
    podobne.forEach(function (s) {
      var teraz = zbierz_(s.id, dataPlus_(dzis, -13), dzis), wcz = zbierz_(s.id, dataPlus_(dzis, -27), dataPlus_(dzis, -14));
      Object.keys(teraz.u).forEach(function (k) {
        var n = teraz.u[k][2], p = wcz.u[k] ? wcz.u[k][2] : 0;
        if (n >= 4 && n >= 2 * p) dodaj(k, teraz.u[k][0], teraz.u[k][1], n, 'rośnie w ' + s.nazwa);
      });
    });
    var lista = Object.keys(kand).map(function (k) {
      var e = kand[k], m = meta[k] || {}, st = ds[k] || {};
      e.y = m.y || null; e.l = m.l || null; e.bpm = m.bpm || null; e.w = m.w || null; e.c = m.c || null; e.j = m.j || null;
      e.stacje = Object.keys(st).map(function (s) { return { id: s, nazwa: nazwaJednostki_(s), od: st[s].slice(0, 10) }; }).sort(function (a, b) { return a.od < b.od ? -1 : 1; });
      e.decyzja = dec.u[k] || null;
      e.ocena = e.powody.length * 10 + Math.min(e.stacje.length, 20) + Math.log(1 + e.n);
      return e;
    }).sort(function (a, b) { return b.ocena - a.ocena; }).slice(0, 150);
    return { j: j, nazwa: nazwaJednostki_(j), podobne: podobne.map(function (s) { return s.nazwa; }), kandydaci: lista,
      historia: (dec.historia || []).slice(0, 100) };
  });
}
/** Decyzja ze spotkania: stan dodaj | odrzuc | wroc (za 7 dni) | usun (cofnięcie), z notatką; historia zostaje. */
function zapiszDecyzje(k, stan, notatka, opis) {
  return bezpiecznie_(function () {
    var fa = folderAgg_(), d = decyzje_();
    d.historia = d.historia || [];
    if (stan === 'usun') delete d.u[k];
    else d.u[k] = { stan: stan, notatka: String(notatka || '').slice(0, 500), kiedy: dzisP_(), wroc: stan === 'wroc' ? dataPlus_(dzisP_(), 7) : null, a: opis && opis.a, t: opis && opis.t };
    d.historia.unshift({ k: k, stan: stan, notatka: String(notatka || '').slice(0, 500), kiedy: new Date().toISOString(), a: opis && opis.a, t: opis && opis.t });
    d.historia = d.historia.slice(0, 1000);
    zapiszJsonPlik(fa, 'decyzje.json', d);
    return { ok: true, decyzja: d.u[k] || null };
  });
}

// ---------------- D6: plan rotacji i kategorie własnej stacji ----------------

var KATEGORIE_DOMYSLNE = [
  { id: 'power', nazwa: 'Power', cel: 21, odstepH: 3 }, { id: 'current', nazwa: 'Current', cel: 10, odstepH: 6 },
  { id: 'recurrent', nazwa: 'Recurrent', cel: 4, odstepH: 24 }, { id: 'gold', nazwa: 'Gold', cel: 2, odstepH: 48 },
];
function planRotacji_(j) {
  var p = (czytajJsonPlik(folderAgg_(), 'rotacja.json') || {})[j] || {};
  return { kategorie: p.kategorie || KATEGORIE_DOMYSLNE, utwory: p.utwory || {} };
}
function zapiszPlanRotacji(j, plan) {
  return bezpiecznie_(function () {
    var fa = folderAgg_(), r = czytajJsonPlik(fa, 'rotacja.json') || {};
    r[j] = { kategorie: (plan.kategorie || KATEGORIE_DOMYSLNE).slice(0, 12), utwory: plan.utwory || {} };
    zapiszJsonPlik(fa, 'rotacja.json', r);
    return { ok: true };
  });
}
/** Plan wobec ostatnich 7 dni: emisje na tydzień wobec celu kategorii, najkrótszy odstęp, podpowiedzi przejść i zdjęć. */
function kontrolaRotacji(j) {
  return bezpiecznie_(function () {
    j = j || mojaStacja_();
    var plan = planRotacji_(j), dzis = dzisP_(), od = dataPlus_(dzis, -7), doo = dataPlus_(dzis, -1), meta = metadane_(), em = {};
    miesiaceJednostki_(j, od, doo, function (a, m, wZakresie) {
      Object.keys(a.u).forEach(function (k) {
        (a.u[k][6] || []).forEach(function (c) { if (wZakresie(c.slice(0, 2))) (em[k] = em[k] || { a: a.u[k][0], t: a.u[k][1], czasy: [] }).czasy.push(Date.parse(m + '-' + c.slice(0, 2) + 'T' + c.slice(3, 8) + ':00Z')); });
      });
    });
    var kat = {};
    plan.kategorie.forEach(function (x) { kat[x.id] = x; });
    var zm = {};
    ((agg_('_wszystkie', 'zmeczenie.json.gz') || {}).u || []).forEach(function (x) { zm[x.k] = x; });
    var wiersze = Object.keys(plan.utwory).map(function (k) {
      var kt = kat[plan.utwory[k]] || {}, e = em[k] || { czasy: [] }, cz = e.czasy.sort(function (a, b) { return a - b; }), odst = null;
      for (var i = 1; i < cz.length; i++) { var g = (cz[i] - cz[i - 1]) / 36e5; if (odst === null || g < odst) odst = g; }
      var m = meta[k] || {}, z = zm[k], uwagi = [];
      if (kt.cel && cz.length < kt.cel * 0.7) uwagi.push('za mało (' + cz.length + ' z ' + kt.cel + ')');
      if (kt.cel && cz.length > kt.cel * 1.3) uwagi.push('za dużo (' + cz.length + ' z ' + kt.cel + ')');
      if (kt.odstepH && odst !== null && odst < kt.odstepH) uwagi.push('za blisko (' + Math.round(odst * 10) / 10 + ' h)');
      if (plan.utwory[k] === 'current' && m.y && m.y <= +dzis.slice(0, 4) - 1) uwagi.push('do recurrent? (wydany ' + m.y + ')');
      if (z && z.odSzczytu !== null && z.odSzczytu < 0.5 && z.tygodni >= 10) uwagi.push('rynek zmęczony (' + Math.round(z.odSzczytu * 100) + '% szczytu)');
      return { k: k, a: e.a || k.split('|')[0], t: e.t || k.split('|')[1], kat: plan.utwory[k], emisji: cz.length, cel: kt.cel || null, odstepMinH: odst, uwagi: uwagi, y: m.y || null, bpm: m.bpm || null };
    });
    var bezKat = Object.keys(em).filter(function (k) { return !plan.utwory[k] && em[k].czasy.length >= 5; })
      .map(function (k) { return { k: k, a: em[k].a, t: em[k].t, emisji: em[k].czasy.length, y: (meta[k] || {}).y || null }; }).sort(function (a, b) { return b.emisji - a.emisji; }).slice(0, 50);
    return { j: j, nazwa: nazwaJednostki_(j), od: od, do: doo, kategorie: plan.kategorie, wiersze: wiersze, bezKategorii: bezKat };
  });
}

/**
 * Analiza rotacji (14.11.2026): dla każdego utworu stacji kategoria (z planu rotacji albo wyliczona z emisji), emisje
 * tydzień po tygodniu na stacji (6 pełnych tygodni) i sygnały z rynku (tygodniowe notowanie całego radia: miejsce,
 * % szczytu, trend 4 tygodni, tygodnie w notowaniu – plik zmeczenie.json.gz) → propozycja przeniesienia z powodami.
 * Reguły są heurystyką Music Base (nie standardem branżowym); progi w REGULY_ROTACJI.
 */
var REGULY_ROTACJI = { topPower: 40, topNowosc: 100, topPowrot: 60, zmeczony: 0.6, wypalony: 0.5, tygDojrzaly: 8, tygStary: 10, latGold: 3, wzrost: 0.1 };
var KAT_NAZWY_ = { power: 'Power', current: 'Current', nowosc: 'Nowość (light)', recurrent: 'Recurrent', gold: 'Gold', zdjac: 'Zdjąć z rotacji' };
function analizaRotacji(j) {
  return bezpiecznie_(function () {
    j = j || mojaStacja_();
    var R = REGULY_ROTACJI, plan = planRotacji_(j), dzis = dzisP_(), rok = +dzis.slice(0, 4);
    var pnOst = dataPlus_(dzis, -((new Date(dzis + 'T12:00:00Z').getUTCDay() + 6) % 7) - 7);   // poniedziałek ostatniego pełnego tygodnia
    var tyg = []; for (var i = 5; i >= 0; i--) tyg.push(dataPlus_(pnOst, -7 * i));
    var od = tyg[0], doo = dataPlus_(pnOst, 6), meta = metadane_(), em = {};
    miesiaceJednostki_(j, od, doo, function (a, m, wZakresie) {
      Object.keys(a.u).forEach(function (k) {
        (a.u[k][6] || []).forEach(function (c) {
          if (!wZakresie(c.slice(0, 2))) return;
          var d = m + '-' + c.slice(0, 2), t = Math.floor((Date.parse(d + 'T12:00:00Z') - Date.parse(od + 'T12:00:00Z')) / (7 * 864e5));
          if (t < 0 || t > 5) return;
          var e = em[k] = em[k] || { a: a.u[k][0], t: a.u[k][1], w: [0, 0, 0, 0, 0, 0] };
          e.w[t]++;
        });
      });
    });
    var rynek = {}, z = agg_('_wszystkie', 'zmeczenie.json.gz');
    ((z && z.u) || []).forEach(function (x, i) { rynek[x.k] = { miejsce: i + 1, odSzczytu: x.odSzczytu, trend4: x.trend4, tygodni: x.tygodni, szczyt: x.tydzienSzczytu }; });
    var cel = {};
    plan.kategorie.forEach(function (x) { cel[x.id] = x.cel; });
    var cP = cel.power || 21, cC = cel.current || 10, cR = cel.recurrent || 4;
    var wiersze = Object.keys(em).concat(Object.keys(plan.utwory).filter(function (k) { return !em[k]; })).map(function (k) {
      var e = em[k] || { a: k.split('|')[0], t: k.split('|')[1], w: [0, 0, 0, 0, 0, 0] }, m = meta[k] || {}, r = rynek[k] || null;
      var ost2 = (e.w[4] + e.w[5]) / 2, suma = e.w.reduce(function (p, q) { return p + q; }, 0);
      var pierwszyTyg = e.w.findIndex(function (n) { return n > 0; });
      var wiek = m.y ? rok - m.y : null;
      var zPlanu = plan.utwory[k] || null, kat = zPlanu;
      if (!kat) {
        if (ost2 >= (cP + cC) / 2) kat = 'power';
        else if (pierwszyTyg >= 3 && suma >= 2) kat = 'nowosc';
        else if (ost2 >= (cC + cR) / 2) kat = 'current';
        else if (wiek !== null && wiek >= R.latGold && !(r && r.miejsce <= R.topNowosc)) kat = 'gold';   // stary, ale grany na rynku – to nie Gold
        else kat = 'recurrent';
      }
      var cel2 = null, powody = [], pl = function (x) { return Math.round(x * 100) + '%'; };
      var opisR = r ? r.miejsce + '. miejsce w notowaniu, ' + pl(r.odSzczytu || 0) + ' szczytu' + (r.trend4 !== null && r.trend4 !== undefined ? ', trend 4 tyg. ' + (r.trend4 >= 0 ? '+' : '') + pl(r.trend4) : '') : 'poza pierwszą 300 notowania';
      var rosnie = r && r.trend4 !== null && r.trend4 > R.wzrost;
      if (kat === 'power') {
        if (!r) { cel2 = 'current'; powody.push('rynek już go prawie nie gra (' + opisR + ')'); }
        else if (r.odSzczytu < R.zmeczony && r.tygodni >= R.tygDojrzaly) { cel2 = 'current'; powody.push('rynek zmęczony: ' + opisR + ', ' + r.tygodni + ' tyg. w notowaniu'); }
      } else if (kat === 'current' || kat === 'nowosc') {
        if (r && r.miejsce <= R.topPower && (rosnie || r.odSzczytu >= 0.9)) { cel2 = 'power'; powody.push('mocny na rynku: ' + opisR); if (ost2 < cP) powody.push('u nas ' + fmt_(ost2) + ' emisji/tydz. wobec ' + cP + ' w Power'); }
        else if (kat === 'nowosc' && r && r.miejsce <= R.topNowosc && (rosnie || r.odSzczytu >= 0.9)) { cel2 = 'current'; powody.push('przyjął się na rynku: ' + opisR); }
        else if (kat === 'nowosc' && !r && pierwszyTyg <= 1 && suma > 0) { cel2 = 'zdjac'; powody.push('od ' + (6 - pierwszyTyg) + ' tyg. u nas, a rynek go nie podchwycił (' + opisR + ')'); }
        else if (kat === 'current' && (!r || (r.odSzczytu < R.wypalony && r.tygodni >= R.tygStary))) { cel2 = 'recurrent'; powody.push('po szczycie: ' + opisR + (r ? ', ' + r.tygodni + ' tyg. w notowaniu' : '')); }
        else if (kat === 'current' && !r && wiek !== null && wiek >= 1) { cel2 = 'recurrent'; powody.push('wydany ' + m.y + ', rynek go już nie gra'); }
      } else if (kat === 'recurrent') {
        if (r && r.miejsce <= R.topPowrot && rosnie) { cel2 = 'current'; powody.push((r.tygodni > 8 ? 'wraca na rynku: ' : 'rośnie na rynku: ') + opisR); }
        else if (wiek !== null && wiek >= R.latGold && !r) { cel2 = 'gold'; powody.push('wydany ' + m.y + ' (' + wiek + ' lat), poza notowaniem'); }
      } else if (kat === 'gold') {
        if (r && r.miejsce <= R.topPowrot) { cel2 = 'recurrent'; powody.push('stary utwór znów grany: ' + opisR); }
      }
      return { k: k, a: e.a, t: e.t, kat: kat, katZPlanu: !!zPlanu, propozycja: cel2, powody: powody, tygodnie: e.w, naTydz: ost2, rynek: r, y: m.y || null };
    }).filter(function (x) { return x.katZPlanu || x.tygodnie.reduce(function (p, q) { return p + q; }, 0) >= 2; });
    // na rynku rośnie, a u nas w ogóle nie grany – kandydaci na nowości
    var doDodania = ((z && z.u) || []).slice(0, 60).filter(function (x) { return !em[x.k] && !plan.utwory[x.k] && x.trend4 !== null && x.trend4 > R.wzrost; })
      .slice(0, 15).map(function (x) { return { k: x.k, a: x.a, t: x.t, propozycja: 'nowosc', rynek: rynek[x.k], powody: ['rośnie na rynku: ' + rynek[x.k].miejsce + '. miejsce, trend 4 tyg. +' + Math.round(x.trend4 * 100) + '%; u nas 0 emisji w 6 tyg.'] }; });
    var licz = {};
    wiersze.forEach(function (x) { licz[x.kat] = (licz[x.kat] || 0) + 1; });
    return { j: j, nazwa: nazwaJednostki_(j), tygodnie: tyg, rynekTydzien: z ? z.tydzien : null, reguly: R, nazwyKat: KAT_NAZWY_, kategorieStacji: licz,
      planUstawiony: Object.keys(plan.utwory).length,
      propozycje: wiersze.filter(function (x) { return x.propozycja; }).sort(function (a, b) { return (a.rynek ? a.rynek.miejsce : 999) - (b.rynek ? b.rynek.miejsce : 999); }),
      bezZmian: wiersze.filter(function (x) { return !x.propozycja; }).sort(function (a, b) { return b.naTydz - a.naTydz; }), doDodania: doDodania };
  });
}
function fmt_(x) { return String(Math.round(x * 10) / 10).replace('.', ','); }

// ---------------- D9: kwota polska – plan i rozliczenie (art. 15 ust. 2–2b ustawy o radiofonii i telewizji) ----------------

/**
 * Miesiąc stacji: czas utworów po polsku wobec czasu wszystkich utworów (≥ 33%), z tego w godz. 5–24 (≥ 60%), przy czym
 * utwór debiutanta w godz. 5–24 liczy się jako 200% (ust. 2a). Debiutant (ust. 2b): artysta lub zespół, który w ciągu
 * 18 miesięcy po raz pierwszy opublikował album albo singiel; utwór – nie minęło 18 miesięcy od pierwszego
 * rozpowszechnienia. Tu PRZYBLIŻENIE: pierwsza emisja utworu w bazie i najwcześniejsza emisja wykonawcy w bazie
 * w ciągu 18 miesięcy (baza od 2022 r.); oznaczenia można poprawić ręcznie (kwota.json → debiutanci).
 * Czas utworu: z mAirList (pole l w playliście Meteora) albo z metadanych (MusicBrainz). Język: lrclib.net.
 */
function kwotaMiesiaca(j, miesiac) {
  return bezpiecznie_(function () {
    j = j || mojaStacja_();
    miesiac = miesiac || dzisP_().slice(0, 7);
    var a = agg_(j, miesiac + '.json.gz');
    if (!a) return { blad: 'Brak danych stacji za ' + miesiac + '.' };
    var meta = metadane_(), dlug = {}, granica18 = dataPlus_(miesiac + '-01', -548);
    var fSt = SIECI[j] ? null : podfolder(folderGlowny_(), j, false);   // czas z mAirList (pole l w surowej playliście)
    if (fSt) czytajSurowyMiesiac(fSt, miesiac).forEach(function (w) { if (w.l) dlug[kluczUtworu(w.a, w.t)] = w.l; });
    var ust = czytajJsonPlik(folderAgg_(), 'kwota.json') || {}, recznie = ust.debiutanci || {};
    var pierwszaWyk = {};   // najwcześniejsza emisja wykonawcy w bazie (z pliku znane: pierwsze emisje utworów)
    var s = { muzyka: 0, znany: 0, pl: 0, plDzien: 0, plDzienBonus: 0, bezCzasu: 0, bezJezyka: 0, dni: Object.keys(a.dni).length, utwory: [] };
    Object.keys(a.u).forEach(function (k) {
      var x = a.u[k], m = meta[k] || {}, l = dlug[k] || m.l || null, czasy = x[6] || [];
      var dzien = czasy.filter(function (c) { var h = +c.slice(3, 5); return h >= 5; }).length;
      if (!l) { s.bezCzasu += x[2]; return; }
      s.muzyka += l * x[2];
      if (!m.j || m.j === 'instr') { s.bezJezyka += x[2]; return; }
      s.znany += l * x[2];
      if (m.j !== 'pl') return;
      var wk = k.split('|')[0], z = znany_(k), deb = recznie[wk];
      if (deb === undefined) {
        if (pierwszaWyk[wk] === undefined) {
          var p = indeksPaczki_(wk + '|'), naj = null;
          Object.keys(p).forEach(function (kk) { if (kk.split('|')[0] === wk && p[kk][3] && (!naj || p[kk][3] < naj)) naj = String(p[kk][3]).slice(0, 10); });
          pierwszaWyk[wk] = naj;
        }
        deb = !!(z && z.pierwsza >= granica18 && pierwszaWyk[wk] && pierwszaWyk[wk] >= granica18 && pierwszaWyk[wk] > '2022-12-31');
      }
      s.pl += l * x[2];
      s.plDzien += l * dzien;
      s.plDzienBonus += l * dzien * (deb ? 2 : 1);
      s.utwory.push({ k: k, a: x[0], t: x[1], n: x[2], wDzien: dzien, l: l, debiutant: deb, debiutantRecznie: recznie[wk] !== undefined, pierwszaWBazie: z ? z.pierwsza : null });
    });
    s.utwory.sort(function (p, q) { return q.n * q.l - p.n * p.l; });
    s.udzialPL = s.znany ? s.pl / s.znany : null;
    s.udzialDzien = s.pl ? Math.min(1, s.plDzienBonus / s.pl) : null;
    s.pokrycie = a.emisji ? 1 - (s.bezCzasu + s.bezJezyka) / a.emisji : 0;   // emisje z czasem i językiem
    s.dniMiesiaca = ostatniDzien_(miesiac);
    return { j: j, nazwa: nazwaJednostki_(j), miesiac: miesiac, wynik: s, progi: { pl: 0.33, dzien: 0.6 } };
  });
}
/** Ręczne oznaczenie wykonawcy jako debiutanta (true/false) albo usunięcie oznaczenia (null). */
function ustawDebiutanta(wk, wart) {
  return bezpiecznie_(function () {
    var fa = folderAgg_(), u = czytajJsonPlik(fa, 'kwota.json') || {};
    u.debiutanci = u.debiutanci || {};
    if (wart === null) delete u.debiutanci[wk]; else u.debiutanci[wk] = !!wart;
    zapiszJsonPlik(fa, 'kwota.json', u);
    return { ok: true };
  });
}

// ---------------- D10: separacje i zegary ----------------

function kontrolaSeparacji(j, dzien, reguly) {
  return bezpiecznie_(function () {
    j = j || mojaStacja_();
    dzien = dzien || dataPlus_(dzisP_(), -1);
    reguly = reguly || {};
    var minWyk = +reguly.wykonawcaMin || 60, maxUtw = +reguly.utworNaDobe || 3, minUtwH = +reguly.utworOdstepH || 3, skokBpm = +reguly.skokBpm || 35;
    var a = agg_(j, dzien.slice(0, 7) + '.json.gz');
    if (!a) return { blad: 'Brak danych stacji za ' + dzien + '.' };
    var meta = metadane_(), dd = dzien.slice(8, 10), em = [];
    Object.keys(a.u).forEach(function (k) {
      (a.u[k][6] || []).forEach(function (c) { if (c.slice(0, 2) === dd) em.push({ g: c.slice(3, 8), k: k, a: a.u[k][0], t: a.u[k][1] }); });
    });
    em.sort(function (x, y) { return x.g < y.g ? -1 : 1; });
    var min = function (g) { return +g.slice(0, 2) * 60 + +g.slice(3, 5); }, nar = [], ostWyk = {}, ostUtw = {}, ileUtw = {}, godz = {};
    em.forEach(function (e, i) {
      var m = meta[e.k] || {}, wk = e.k.split('|')[0], t = min(e.g), h = +e.g.slice(0, 2);
      var G = godz[h] || (godz[h] = { h: h, utworow: 0, pl: 0, znany: 0, sekund: 0, zCzasem: 0 });
      G.utworow++; if (m.j && m.j !== 'instr') { G.znany++; if (m.j === 'pl') G.pl++; } if (m.l) { G.sekund += m.l; G.zCzasem++; }
      if (ostWyk[wk] !== undefined && t - ostWyk[wk] < minWyk) nar.push({ g: e.g, typ: 'wykonawca', opis: e.a + ' znowu po ' + (t - ostWyk[wk]) + ' min', k: e.k });
      ostWyk[wk] = t;
      ileUtw[e.k] = (ileUtw[e.k] || 0) + 1;
      if (ileUtw[e.k] === maxUtw + 1) nar.push({ g: e.g, typ: 'utwór', opis: e.a + ' – ' + e.t + ': ' + (maxUtw + 1) + '. emisja tej doby', k: e.k });
      if (ostUtw[e.k] !== undefined && t - ostUtw[e.k] < minUtwH * 60) nar.push({ g: e.g, typ: 'odstęp', opis: e.a + ' – ' + e.t + ' po ' + Math.round((t - ostUtw[e.k]) / 6) / 10 + ' h', k: e.k });
      ostUtw[e.k] = t;
      var pop = em[i - 1], bp = pop && (meta[pop.k] || {}).bpm;
      if (pop && bp && m.bpm && Math.abs(m.bpm - bp) >= skokBpm) nar.push({ g: e.g, typ: 'tempo', opis: Math.round(bp) + ' → ' + Math.round(m.bpm) + ' BPM (' + pop.a + ' → ' + e.a + ')', k: e.k });
    });
    var godziny = Object.keys(godz).map(function (h) { var G = godz[h]; return { h: +h, utworow: G.utworow, udzialPL: G.znany ? G.pl / G.znany : null, minutMuzyki: G.zCzasem ? G.sekund / G.zCzasem * G.utworow / 60 : null }; }).sort(function (x, y) { return x.h - y.h; });
    return { j: j, nazwa: nazwaJednostki_(j), dzien: dzien, emisji: em.length, reguly: { wykonawcaMin: minWyk, utworNaDobe: maxUtw, utworOdstepH: minUtwH, skokBpm: skokBpm }, naruszenia: nar, godziny: godziny, emisje: em };
  });
}

// ---------------- D11 i D12: eksport do mAirList, zestawienie do rozliczeń z OZZ ----------------

function csvPole_(v) { v = v == null ? '' : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
function plikEksportu_(nazwa, wiersze) {
  var f = podfolder(DriveApp.getRootFolder(), 'Music Base – eksporty');
  // UTF-8 z BOM – mAirListDB wymaga go przy imporcie CSV w UTF-8 (wiki mAirList: „UTF-8 requires a valid BOM”)
  var tekst = '﻿' + wiersze.map(function (w) { return w.map(csvPole_).join(','); }).join('\r\n') + '\r\n';
  var plik = f.createFile(Utilities.newBlob(tekst, 'text/csv', nazwa.replace(/[\\/:*?"<>|]/g, '-') + '.csv'));
  return plik.getUrl();
}
/** Pełne metadane wielu utworów (paczki 1/16) – twórcy, ISRC, wytwórnia. */
function szczegolyWielu_(klucze) {
  var f = podfolder(folderAgg_(), 'metadane', false), wynik = {}, wgP = {};
  klucze.forEach(function (k) { (wgP[paczkaUtworu(k)] = wgP[paczkaUtworu(k)] || []).push(k); });
  Object.keys(wgP).forEach(function (pn) { var p = f ? czytajGz(f, nazwaPaczki(+pn)) || {} : {}; wgP[pn].forEach(function (k) { wynik[k] = p[k] || metadane_()[k] || {}; }); });
  return wynik;
}
/**
 * D11: CSV do importu w bibliotece mAirListDB (Baza → Import → CSV): Title, Artist, Duration (sekundy) + kolumny
 * atrybutów (wiki mAirList: kolumny spoza listy stałych trafiają do atrybutów; dopasowanie po wykonawcy i tytule,
 * gdy nie ma ID/ExternalID/Filename). Utwory grane na stacji w okresie albo podana lista kluczy.
 */
function eksportMairlist(j, od, doo, klucze) {
  return bezpiecznie_(function () {
    j = j || mojaStacja_();
    var lista = {};
    if (klucze && klucze.length) klucze.slice(0, 5000).forEach(function (k) { lista[k] = [k.split('|')[0], k.split('|')[1], 0]; });
    else { var z = zbierz_(j, od, doo); Object.keys(z.u).forEach(function (k) { lista[k] = z.u[k]; }); }
    var ks = Object.keys(lista), sz = szczegolyWielu_(ks), plan = planRotacji_(j).utwory;
    var JEZ = { pl: 'polski', en: 'angielski', inny: 'inny', instr: 'instrumentalny' };
    var wiersze = [['Title', 'Artist', 'Duration', 'Year', 'Tempo', 'Language', 'Category', 'Explicit', 'ISRC', 'Composer', 'Lyricist', 'Label', 'Plays']];
    ks.forEach(function (k) {
      var x = lista[k], m = sz[k] || {};
      wiersze.push([x[1], x[0], m.l ? m.l.toFixed(3) : '', m.y || '', m.bpm || '', JEZ[m.j] || '', plan[k] || '', m.w === 2 || m.ex === 1 ? 'tak' : '',
        [].concat(m.isrc || m.dzi || []).join(' '), [].concat(m.kp || [], m.au || []).join('; '), [].concat(m.as || [], m.au || []).join('; '), [].concat(m.wlab || []).join('; '), x[2] || '']);
    });
    return { url: plikEksportu_('mAirList – ' + nazwaJednostki_(j) + ' ' + (od || '') + ' ' + (doo || ''), wiersze), utworow: ks.length };
  });
}
/**
 * D12: miesięczny wykaz utworów stacji do rozliczeń z ZAiKS i innymi OZZ: emisje, łączny czas, kompozytor, autor słów,
 * wykonawca, wytwórnia, ISRC. Układ trzeba dopasować do umowy stacji (ZAiKS: brak przepisów o jednolitym raportowaniu).
 */
function zestawienieOzz(j, miesiac) {
  return bezpiecznie_(function () {
    j = j || mojaStacja_();
    var a = agg_(j, miesiac + '.json.gz');
    if (!a) return { blad: 'Brak danych stacji za ' + miesiac + '.' };
    var ks = Object.keys(a.u).sort(function (p, q) { return a.u[q][2] - a.u[p][2]; }), sz = szczegolyWielu_(ks), sekund = 0, bezCzasu = 0, bezTworcow = 0;
    var wiersze = [['Wykonawca', 'Tytuł', 'Emisji', 'Czas utworu (s)', 'Łączny czas (s)', 'Kompozytor', 'Autor słów', 'Wytwórnia', 'ISRC', 'Rok']];
    ks.forEach(function (k) {
      var x = a.u[k], m = sz[k] || {}, l = m.l || null;
      if (l) sekund += l * x[2]; else bezCzasu++;
      var komp = [].concat(m.kp || [], m.au || []).join('; '), slowa = [].concat(m.as || [], m.au || []).join('; ');
      if (!komp && !slowa) bezTworcow++;
      wiersze.push([x[0], x[1], x[2], l || '', l ? Math.round(l * x[2]) : '', komp, slowa, [].concat(m.wlab || []).join('; '), [].concat(m.isrc || m.dzi || []).join(' '), m.y || '']);
    });
    return { url: plikEksportu_('Zestawienie OZZ – ' + nazwaJednostki_(j) + ' ' + miesiac, wiersze), utworow: ks.length, emisji: a.emisji, sekund: sekund, bezCzasu: bezCzasu, bezTworcow: bezTworcow };
  });
}

// ---------------- D13: jak konkurencja buduje godzinę ----------------

/** Pory dnia × dni robocze/weekend: kategorie rotacji, udział polskich, średni rok, tempo, minuty muzyki na godzinę. */
function budowaGodziny(j, od, doo) {
  return bezpiecznie_(function () {
    if (dniRoznicy_(od, doo) > 92) od = dataPlus_(doo, -92);
    var meta = metadane_(), kat = {}, PORY = [['noc', 0, 5], ['rano', 6, 9], ['przedpołudnie', 10, 14], ['popołudnie', 15, 18], ['wieczór', 19, 23]];
    kategorieStacji_(j, od, doo).lista.forEach(function (e) { kat[e.k] = e.kat; });
    var kom = {}, dni = { rob: {}, wk: {} };
    miesiaceJednostki_(j, od, doo, function (a, m, wZakresie) {
      Object.keys(a.u).forEach(function (k) {
        var x = a.u[k], md = meta[k] || {};
        (x[6] || []).forEach(function (c) {
          var dd = c.slice(0, 2);
          if (!wZakresie(dd)) return;
          var iso = m + '-' + dd, tg = (new Date(iso + 'T12:00:00Z').getUTCDay() + 6) % 7, h = +c.slice(3, 5), typ = tg >= 5 ? 'wk' : 'rob';
          dni[typ][iso] = 1;
          var pora = PORY.filter(function (p) { return h >= p[1] && h <= p[2]; })[0][0], K = kom[typ + '|' + pora] || (kom[typ + '|' + pora] = { typ: typ, pora: pora, emisji: 0, kat: {}, znany: 0, pl: 0, rokS: 0, rokN: 0, bpmS: 0, bpmN: 0, sek: 0, zCzasem: 0 });
          K.emisji++;
          var kt = kat[k] || 'sporadyczne'; K.kat[kt] = (K.kat[kt] || 0) + 1;
          if (md.j && md.j !== 'instr') { K.znany++; if (md.j === 'pl') K.pl++; }
          if (md.y) { K.rokS += md.y; K.rokN++; }
          if (md.bpm) { K.bpmS += md.bpm; K.bpmN++; }
          if (md.l) { K.sek += md.l; K.zCzasem++; }
        });
      });
    });
    var wynik = Object.keys(kom).map(function (id) {
      var K = kom[id], p = PORY.filter(function (x) { return x[0] === K.pora; })[0], godzin = Object.keys(dni[K.typ]).length * (p[2] - p[1] + 1);
      var kategorie = {}; Object.keys(K.kat).forEach(function (kt) { kategorie[kt] = K.kat[kt] / K.emisji; });
      return { typ: K.typ, pora: K.pora, emisji: K.emisji, naGodzine: godzin ? K.emisji / godzin : null, kategorie: kategorie, udzialPL: K.znany ? K.pl / K.znany : null,
        sredniRok: K.rokN ? K.rokS / K.rokN : null, sredniBpm: K.bpmN ? K.bpmS / K.bpmN : null, minutMuzyki: K.zCzasem && godzin ? K.sek / K.zCzasem * K.emisji / godzin / 60 : null };
    });
    return { j: j, nazwa: nazwaJednostki_(j), od: od, do: doo, pory: PORY.map(function (p) { return p[0]; }), komorki: wynik };
  });
}

// ---------------- D14: wczesne sygnały przebojów ----------------

/** Apple Music Top Polska (I3), Deezer (I1), YouTube (I4), ListenBrainz (I2) wobec emisji w radiu z 30 dni. */
function wczesneSygnaly() {
  return bezpiecznie_(function () {
    var r30 = agg_('_wszystkie', 'ranking_30.json.gz'), nR = {};
    if (r30 && r30.w) r30.w[''].u.forEach(function (x) { nR[x[0]] = x[1]; });
    var meta = metadane_(), wiersz = function (k, a, t, extra) {
      var m = meta[k] || {}, z = znany_(k);
      return Object.assign({ k: k, a: a, t: t, radio30: nR[k] || 0, wBazie: z ? z.n : 0, pierwsza: z ? z.pierwsza : null, dzr: m.dzr || null, ytv: m.ytv || null, lbc: m.lbc || null, y: m.y || null, c: m.c || null }, extra || {});
    };
    var apple = [], ap = czytajJsonPlik(podfolder(folderAgg_(), 'zewnetrzne', false), 'apple_top_pl.json');
    var dniA = ap ? Object.keys(ap).sort() : [], ostA = dniA.length ? ap[dniA[dniA.length - 1]] : [], tydzA = dniA.length > 7 ? ap[dniA[dniA.length - 8]] : null, pozTydz = {};
    (tydzA || []).forEach(function (p) { pozTydz[p.k] = p.poz; });
    ostA.forEach(function (p) { apple.push(wiersz(p.k, p.a, p.t, { poz: p.poz, pozTydzien: pozTydz[p.k] || null, url: p.url })); });
    var deb = (agg_('_wszystkie', 'debiuty.json.gz') || {}).u || {}, deezer = [], yt = [];
    Object.keys(deb).forEach(function (k) {
      var m = meta[k] || {}, x = deb[k];
      if (m.dzr && String(x[3]).slice(0, 10) >= dataPlus_(dzisP_(), -180)) deezer.push(wiersz(k, x[0], x[1]));
      if (m.ytv && String(x[3]).slice(0, 10) >= dataPlus_(dzisP_(), -365)) yt.push(wiersz(k, x[0], x[1]));
    });
    var stosunek = function (x, pole) { return x[pole] / (1 + x.radio30); };
    deezer.sort(function (a, b) { return stosunek(b, 'dzr') - stosunek(a, 'dzr'); });
    yt.sort(function (a, b) { return stosunek(b, 'ytv') - stosunek(a, 'ytv'); });
    return { appleDzien: dniA[dniA.length - 1] || null, apple: apple, appleMaloWRadiu: apple.filter(function (x) { return x.radio30 < 20; }), deezer: deezer.slice(0, 100), youtube: yt.slice(0, 100) };
  });
}

// ---------------- D15: tygodniowy raport dyrektora muzycznego ----------------

/** Dodatkowe sekcje poniedziałkowego e-maila (raportTygodniowy): dodania, notowanie, kandydaci, zmęczenie, kwota. */
function raportDyrektora_() {
  var linie = [], j = mojaStacja_();
  try {
    var d = dodaniaTygodnia();
    if (!d.blad) { linie.push('', 'Najczęściej dodawane (tydzień od ' + d.tydzien + '):'); d.u.slice(0, 10).forEach(function (x, i) { linie.push((i + 1) + '. ' + x.a + ' – ' + x.t + ': ' + x.stacji + ' stacji (pierwsza: ' + x.kto[0].nazwa + ')'); }); }
  } catch (e) { /* sekcja pominięta */ }
  try {
    var n = notowanie(null, 100);
    if (!n.blad) {
      linie.push('', 'Notowanie airplay (tydzień od ' + n.tydzien + ') – top 10:');
      n.pozycje.slice(0, 10).forEach(function (x) { linie.push(x.miejsce + '. ' + x.a + ' – ' + x.t + ' (' + x.n + (x.poprzednio ? ', poprz. ' + x.poprzednio : ', nowość') + ')'); });
      var po = {}; n.pozycje.forEach(function (x) { po[x.k] = x; });
      linie.push('Największe wzrosty: ' + n.wzrosty.slice(0, 5).map(function (k) { var x = po[k]; return x.a + ' – ' + x.t + ' (+' + (x.n - x.nPoprzednio) + ')'; }).join('; '));
    }
  } catch (e) { /* sekcja pominięta */ }
  try {
    var k = kandydaciSpotkania(j);
    if (!k.blad) { linie.push('', 'Kandydaci na spotkanie muzyczne (' + k.nazwa + '): ' + k.kandydaci.length); k.kandydaci.slice(0, 8).forEach(function (x) { linie.push('• ' + x.a + ' – ' + x.t + ' – ' + x.powody.join(', ')); }); }
  } catch (e) { /* sekcja pominięta */ }
  try {
    var z = zmeczenieRynku();
    if (!z.blad) { var zm = z.u.filter(function (x) { return x.odSzczytu !== null && x.odSzczytu < 0.5 && x.tygodni >= 10; }).slice(0, 5); if (zm.length) { linie.push('', 'Zmęczone na rynku (poniżej połowy szczytu):'); zm.forEach(function (x) { linie.push('• ' + x.a + ' – ' + x.t + ' (' + Math.round(x.odSzczytu * 100) + '% szczytu, ' + x.tygodni + ' tyg.)'); }); } }
  } catch (e) { /* sekcja pominięta */ }
  try {
    var q = kwotaMiesiaca(j);
    if (!q.blad && q.wynik.udzialPL !== null) linie.push('', 'Kwota polska ' + q.nazwa + ' (' + q.miesiac + ', szacunek): ' + Math.round(q.wynik.udzialPL * 1000) / 10 + '% (próg 33%), z tego w 5–24: ' + Math.round((q.wynik.udzialDzien || 0) * 1000) / 10 + '% (próg 60%).');
  } catch (e) { /* sekcja pominięta */ }
  return linie;
}

// ---------------- O5: ręczne poprawki dopasowań utworów ----------------

/**
 * Poprawki w _agg/poprawki.json (dane surowe bez zmian; stosuje je Odbiornik przy przeliczaniu miesięcy):
 *  scal  – {z: klucz, na: klucz}: ten sam utwór pod różnymi tytułami/wykonawcami → jeden,
 *  nazwa – {k, a, t}: poprawiona wyświetlana nazwa wykonawcy i tytułu,
 *  rozdziel – {k, gdyWykonawca: tekst, na: nowy klucz}: wiersze z tym tekstem w surowym wykonawcy → osobny utwór.
 */
function poprawki() { return bezpiecznie_(function () { return czytajJsonPlik(folderAgg_(), 'poprawki.json') || { wersja: 0, lista: [] }; }); }
function zapiszPoprawke(p, usun) {
  return bezpiecznie_(function () {
    var fa = folderAgg_(), d = czytajJsonPlik(fa, 'poprawki.json') || { wersja: 0, lista: [] };
    if (usun) d.lista = d.lista.filter(function (x) { return x.id !== usun; });
    else {
      if (['scal', 'nazwa', 'rozdziel'].indexOf(p.typ) < 0) throw new Error('nieznany typ poprawki');
      if (p.typ === 'scal' && (!p.z || !p.na || p.z === p.na)) throw new Error('podaj dwa różne utwory');
      if (p.typ === 'rozdziel' && (!p.k || !p.gdyWykonawca)) throw new Error('podaj utwór i tekst wykonawcy');
      d.lista.push({ id: Utilities.getUuid().slice(0, 8), typ: p.typ, z: p.z || null, na: p.na || null, k: p.k || null, a: p.a || null, t: p.t || null,
        gdyWykonawca: p.gdyWykonawca || null, kiedy: new Date().toISOString() });
    }
    d.wersja = (d.wersja || 0) + 1;
    zapiszJsonPlik(fa, 'poprawki.json', d);
    return d;
  });
}

/* ---------------- D8: badanie słuchaczy (strona ankiety serwuje Odbiornik – OdbiornikAnkieta.gs) ---------------- */
function folderAnkietP_() { return podfolder(folderAgg_(), 'ankiety'); }
function adresAnkiety_(id) {
  var a = czytajJsonPlik(folderAnkietP_(), '_adres.json');
  return a && a.url ? a.url + '?akcja=ankieta&id=' + id : null;
}
/** Lista ankiet z liczbą odpowiedzi (scalonych) i odnośnikiem. */
function ankiety() {
  return bezpiecznie_(function () {
    var f = folderAnkietP_(), it = f.getFiles(), lista = [];
    while (it.hasNext()) {
      var p = it.next(), n = p.getName(), m = /^([a-z0-9]{6,40})\.json$/.exec(n);
      if (!m || p.isTrashed()) continue;
      var a = czytajJsonPlik(f, n), w = czytajJsonPlik(f, m[1] + '_wyniki.json');
      if (a) lista.push({ id: a.id, tytul: a.tytul, aktywna: !!a.aktywna, utworzono: a.utworzono, utworow: (a.utwory || []).length, odpowiedzi: w ? w.n : 0, adres: adresAnkiety_(a.id) });
    }
    lista.sort(function (x, y) { return x.utworzono < y.utworzono ? 1 : -1; });
    return { ankiety: lista, adresZnany: !!czytajJsonPlik(f, '_adres.json') };
  });
}
/** Nowa ankieta: tytuł, opis, klucze utworów (do 20); fragment z YouTube, gdy metadane mają identyfikator teledysku. */
function zapiszAnkiete(d) {
  return bezpiecznie_(function () {
    var klucze = (d.klucze || []).filter(function (k, i, t) { return k && t.indexOf(k) === i; }).slice(0, 20);
    if (!klucze.length) throw new Error('Dodaj co najmniej jeden utwór.');
    if (!String(d.tytul || '').trim()) throw new Error('Podaj tytuł ankiety.');
    var sz = szczegolyWielu_(klucze);
    var id = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
    var utwory = klucze.map(function (k) {
      var m = sz[k] || {}, x = indeksPaczki_(k)[k] || [], c = k.split('|');   // nazwy wyświetlane z indeksu utworów
      return { k: k, a: x[0] || c[0], t: x[1] || c[1], yt: m.yt || null, od: d.od ? +d.od : null };
    });
    var a = { id: id, tytul: String(d.tytul).trim().slice(0, 120), opis: String(d.opis || '').trim().slice(0, 500) || null, aktywna: true, utworzono: new Date().toISOString(), utwory: utwory };
    zapiszJsonPlik(folderAnkietP_(), id + '.json', a);
    a.adres = adresAnkiety_(id);
    return a;
  });
}
function zamknijAnkiete(id, otwarta) {
  return bezpiecznie_(function () {
    var f = folderAnkietP_(), a = czytajJsonPlik(f, id + '.json');
    if (!a) throw new Error('Nie ma takiej ankiety.');
    a.aktywna = !!otwarta;
    zapiszJsonPlik(f, id + '.json', a);
    return { id: id, aktywna: a.aktywna };
  });
}
/**
 * Wyniki: znajomość (% „znam” wśród odpowiadających na to pytanie), sympatia (średnia ocen 1–5), pozytywne (% ocen 4–5),
 * zmęczenie (% „mam dość” wśród znających), wskaźnik = pozytywne − zmęczenie (punkty procentowe; definicja własna Music Base).
 */
function wynikiAnkiety(id) {
  return bezpiecznie_(function () {
    var f = folderAnkietP_(), a = czytajJsonPlik(f, id + '.json');
    if (!a) throw new Error('Nie ma takiej ankiety.');
    var w = czytajJsonPlik(f, id + '_wyniki.json') || { n: 0, u: [] }, fo = podfolder(f, id, false), czeka = 0;
    if (fo) { var it = fo.getFiles(); while (it.hasNext()) if (!it.next().isTrashed()) czeka++; }
    var proc = function (x, y) { return y ? Math.round(1000 * x / y) / 10 : null; };
    var wiersze = (a.utwory || []).map(function (u, i) {
      var s = w.u[i] || { odp: 0, znam: 0, nieZnam: 0, oceny: [0, 0, 0, 0, 0], dosc: 0 };
      var ocen = s.oceny.reduce(function (p, q) { return p + q; }, 0), suma = s.oceny.reduce(function (p, q, j) { return p + q * (j + 1); }, 0);
      var poz = proc(s.oceny[3] + s.oceny[4], ocen), zm = proc(s.dosc, s.znam);
      return { k: u.k, a: u.a, t: u.t, yt: u.yt, odpowiedzi: s.odp, znajomosc: proc(s.znam, s.znam + s.nieZnam), sympatia: ocen ? Math.round(100 * suma / ocen) / 100 : null,
        ocen: ocen, oceny: s.oceny, pozytywne: poz, zmeczenie: zm, wskaznik: poz === null ? null : Math.round(10 * (poz - (zm || 0))) / 10 };
    });
    return { id: id, tytul: a.tytul, aktywna: a.aktywna, adres: adresAnkiety_(id), odpowiedzi: w.n, czekaNaScalenie: czeka, zaktualizowano: w.zaktualizowano || null, utwory: wiersze };
  });
}

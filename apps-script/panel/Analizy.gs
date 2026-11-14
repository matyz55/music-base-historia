/**
 * Music Base – Panel: narzędzia analizy (N1–N10) i rozszerzenia profilu stacji (S2–S8).
 * Wszystkie funkcje liczą na podsumowaniach z _agg/v2 i metadanych; zwracają {blad} zamiast wyjątku.
 */

function godzinaHw_(hw) { return (+hw) % 24; }
function lataZakresu_(od, doo) { var w = []; for (var r = +od.slice(0, 4); r <= +doo.slice(0, 4); r++) w.push(String(r)); return w; }

/** Dla każdego miesiąca zakresu: agregat miesiąca jednostki (z ograniczeniem dni w skrajnych miesiącach). */
function miesiaceJednostki_(j, od, doo, f) {
  // „wszystkie stacje łącznie”: miesiące każdej stacji/sieci głównej po kolei; f dostaje też id jednostki
  var jedn = j === '_wszystkie' ? jednostkiGlowneP_() : [j];
  miesiaceZakresu_(od, doo).forEach(function (m) {
    var pocz = od.slice(0, 7) === m ? od.slice(8, 10) : '01', kon = doo.slice(0, 7) === m ? doo.slice(8, 10) : '31';
    jedn.forEach(function (jj) {
      var a = agg_(jj, m + '.json.gz');
      if (a) f(a, m, function (dd) { return dd >= pocz && dd <= kon; }, jj);
    });
  });
}
/** Jednostki „główne” (stacja albo jej sieć, bez wykluczonych) – suma po nich to całe radio bez podwójnego liczenia sieci. */
function jednostkiGlowneP_() {
  var w = {};
  Object.keys(indeksStacji_()).forEach(function (s) { w[siecStacji(s) || s] = 1; });
  return Object.keys(w);
}
/** Wynik analizy „wszystkie stacje” (cięższy – czyta pliki każdej stacji) w pamięci serwera na 6 h. */
function lacznie_(nazwa, j, args, f) {
  return j === '_wszystkie' ? zPamieci_('lacznie|' + nazwa + '|' + JSON.stringify(args), 21600, f) : f();
}

// ---------------- N1: kwota polska ----------------

/**
 * Udział utworów w języku polskim (metadane j = 'pl', z tekstu w lrclib.net) w emisjach stacji: całość, 5–24 i noc 0–5.
 * Ustawa (art. 15): co najmniej 33% w języku polskim, z tego co najmniej 60% w godz. 5–24. To szacunek – liczymy
 * tylko utwory o znanym języku; pokrycie podane osobno.
 */
function kwotaPolska(jednostki, od, doo) {
  return bezpiecznie_(function () {
    var meta = metadane_(), lista = jednostki && jednostki.length ? jednostki : start().jednostki.map(function (j) { return j.id; });
    return { stacje: lista.map(function (j) {
      var r = { id: j, nazwa: nazwaJednostki_(j), emisji: 0, znany: 0, pl: 0, plDzien: 0, plNoc: 0, znanyDzien: 0, mies: {} };
      miesiaceJednostki_(j, od, doo, function (a, m, wZakresie) {
        Object.keys(a.u).forEach(function (k) {
          var x = a.u[k], jez = (meta[k] || {}).j;
          var n = 0;
          Object.keys(x[3]).forEach(function (d) { if (wZakresie(d)) n += x[3][d]; });
          if (!n) return;
          r.emisji += n;
          if (!jez || jez === 'instr') return;
          r.znany += n;
          var mm = r.mies[m] = r.mies[m] || { znany: 0, pl: 0 };
          mm.znany += n;
          // podział dzień/noc z rozkładu godzin całego miesiąca (proporcjonalnie do n w zakresie)
          var suma = 0, dzien = 0;
          Object.keys(x[4]).forEach(function (h) { suma += x[4][h]; if (godzinaHw_(h) >= 5) dzien += x[4][h]; });
          var nDzien = suma ? n * dzien / suma : n;
          r.znanyDzien += nDzien;
          if (jez === 'pl') { r.pl += n; mm.pl += n; r.plDzien += nDzien; r.plNoc += n - nDzien; }
        });
      });
      r.udzialPL = r.znany ? r.pl / r.znany : null;
      r.udzialPLwDzien = r.pl ? r.plDzien / r.pl : null;
      r.pokrycie = r.emisji ? r.znany / r.emisji : 0;
      return r;
    }).filter(function (r) { return r.emisji; }) };
  });
}

// ---------------- N2: rotacja i zmęczenie ----------------

/** Jak często stacja powtarza utwory: emisje, dni z emisją, maks. na dobę, średni i najkrótszy odstęp (godziny). */
function rotacja(j, od, doo) {
  return bezpiecznie_(function () { return lacznie_('rotacja', j, [od, doo], function () {
    var u = {}, meta = metadane_();
    miesiaceJednostki_(j, od, doo, function (a, m, wZakresie) {
      Object.keys(a.u).forEach(function (k) {
        var x = a.u[k];
        (x[6] || []).forEach(function (t) {
          if (!wZakresie(t.slice(0, 2))) return;
          (u[k] = u[k] || { a: x[0], t: x[1], czasy: [] }).czasy.push(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1, +t.slice(0, 2), +t.slice(3, 5), +t.slice(6, 8)));
        });
      });
    });
    var lista = Object.keys(u).map(function (k) {
      var c = u[k].czasy.sort(function (a, b) { return a - b; }), dni = {}, odstepy = [];
      c.forEach(function (t, i) { var d = new Date(t).toISOString().slice(0, 10); dni[d] = (dni[d] || 0) + 1; if (i) odstepy.push((t - c[i - 1]) / 36e5); });
      var maks = 0; Object.keys(dni).forEach(function (d) { maks = Math.max(maks, dni[d]); });
      return { k: k, a: u[k].a, t: u[k].t, n: c.length, dni: Object.keys(dni).length, maksDoba: maks,
        sredniOdstep: odstepy.length ? odstepy.reduce(function (s, x) { return s + x; }, 0) / odstepy.length : null,
        minOdstep: odstepy.length ? Math.min.apply(null, odstepy) : null, y: (meta[k] || {}).y || null };
    }).sort(function (p, q) { return q.n - p.n; });
    var emisji = lista.reduce(function (s, x) { return s + x.n; }, 0);
    return { nazwa: nazwaJednostki_(j), emisji: emisji, utworow: lista.length, top: lista.slice(0, 300),
      zajechane: lista.filter(function (x) { return x.n >= 20 && x.sredniOdstep !== null; }).sort(function (p, q) { return p.sredniOdstep - q.sredniOdstep; }).slice(0, 100) };
  }); });
}

// ---------------- N3: cykl życia hitu i stacje wyznaczające trendy ----------------

/**
 * Utwory, które zadebiutowały w zakresie (pierwsza emisja w całej bazie), z cyklem życia (szczyt, tygodnie na antenie)
 * oraz ranking stacji, które grają nowe utwory najwcześniej (średnie miejsce w kolejności pierwszych emisji).
 * Dane z Odbiornika: debiuty.json.gz (pierwsza emisja w ostatnich 400 dniach), debiuty_stacje.json.gz (pierwsza emisja
 * na każdej jednostce, utwory z ≥ 10 emisjami) i tygodnie_RRRR.json.gz (300 najczęściej granych w tygodniu).
 */
function cyklZycia(od, doo, minEmisji) {
  return bezpiecznie_(function () {
    minEmisji = +minEmisji || 30;
    var deb = agg_('_wszystkie', 'debiuty.json.gz'), dst = agg_('_wszystkie', 'debiuty_stacje.json.gz');
    if (!deb || !deb.u) return { blad: 'Debiuty liczy Odbiornik przy budowie indeksu utworów – pojawią się po najbliższym przeliczeniu (zwykle w ciągu kilku godzin).' };
    var du = deb.u, ds = (dst && dst.u) || {}, odEf = od < deb.od ? deb.od : od;
    var debiuty = Object.keys(du).filter(function (k) {
      var d = String(du[k][3] || '').slice(0, 10);
      return d >= odEf && d <= doo && du[k][2] >= minEmisji;
    }).sort(function (a, b) { return du[b][2] - du[a][2]; });
    // pierwsze emisje każdej jednostki
    var kolejnosc = {};
    debiuty.forEach(function (k) {
      var m = ds[k] || {};
      kolejnosc[k] = Object.keys(m).map(function (j) { return [j, m[j]]; }).sort(function (a, b) { return a[1] < b[1] ? -1 : 1; });
    });
    var trend = {};
    debiuty.forEach(function (k) {
      var o = kolejnosc[k];
      if (o.length < 5) return;
      o.forEach(function (p, i) {
        var t = trend[p[0]] = trend[p[0]] || { id: p[0], nazwa: nazwaJednostki_(p[0]), utworow: 0, sumaPercentyli: 0, pierwsza: 0, wTop3: 0, opoznienia: [] };
        t.utworow++;
        t.opoznienia.push((Date.parse(p[1].slice(0, 10) + 'T12:00:00Z') - Date.parse(o[0][1].slice(0, 10) + 'T12:00:00Z')) / 864e5);   // A5
        t.sumaPercentyli += i / (o.length - 1);
        if (i === 0) t.pierwsza++;
        if (i < 3) t.wTop3++;
      });
    });
    var dyfuzja = [];
    for (var tg = 0; tg <= 12; tg++) {
      var zDanymi = debiuty.filter(function (k) { return kolejnosc[k].length && Date.parse(kolejnosc[k][0][1].slice(0, 10)) + tg * 7 * 864e5 <= Date.now(); });
      if (zDanymi.length < 3) break;
      dyfuzja.push(zDanymi.reduce(function (s0, k) { var g = Date.parse(kolejnosc[k][0][1].slice(0, 10)) + (tg * 7 + 6) * 864e5; return s0 + kolejnosc[k].filter(function (p) { return Date.parse(p[1].slice(0, 10)) <= g; }).length; }, 0) / zDanymi.length);
    }
    var stacje = Object.keys(trend).map(function (j) {
      var t = trend[j], l = t.opoznienia.sort(function (a, b) { return a - b; }), p = l.length >> 1;
      t.srPercentyl = t.sumaPercentyli / t.utworow; t.medianaOpoznienia = l.length % 2 ? l[p] : (l[p - 1] + l[p]) / 2; delete t.opoznienia; return t;
    })
      .filter(function (t) { return t.utworow >= 3; }).sort(function (a, b) { return a.srPercentyl - b.srPercentyl; });
    // cykl życia 25 najczęściej granych debiutów: tygodnie, w których były w pierwszej 300 całego radia
    var top = debiuty.slice(0, 25), tyg = {}, wTop = {}, tygodnieWszystkie = {}, minTyg = {};
    var poniedzialek = function (iso) { var d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
    top.forEach(function (k) { wTop[k] = 1; });
    var rok0 = top.reduce(function (r, k) { return Math.min(r, +String(du[k][3]).slice(0, 4)); }, 9999), rokT = +doo.slice(0, 4);
    for (var r = rok0; r <= rokT && top.length; r++) {
      var plik = agg_('_wszystkie', 'tygodnie_' + r + '.json.gz');
      if (!plik || !plik.w) continue;
      Object.keys(plik.w).forEach(function (pn) {
        var w = plik.w[pn];
        tygodnieWszystkie[pn] = 1;
        minTyg[pn] = w.u.length >= w.n ? 0 : w.min;   // poza listą: najwyżej tyle emisji (0 – lista pełna)
        w.u.forEach(function (x) { if (wTop[x[0]]) (tyg[x[0]] = tyg[x[0]] || {})[pn] = x[1]; });
      });
    }
    var wszystkieTyg = Object.keys(tygodnieWszystkie).sort();
    var hity = top.map(function (k) {
      var w = tyg[k] || {}, tygodnie = Object.keys(w).sort(), szczyt = tygodnie.slice().sort(function (a, b) { return w[b] - w[a]; })[0];
      var debiut = String(du[k][3]).slice(0, 10);
      // A4 półtrwanie: tygodnie od szczytu do pierwszego tygodnia poniżej połowy szczytu (także tydzień poza pierwszą 300,
      // gdy 300. miejsce miało mniej niż połowę szczytu); null – jeszcze nie spadł albo nie wiadomo
      var polowa = null;
      if (szczyt) {
        var po = wszystkieTyg.filter(function (t) { return t > szczyt; });
        for (var i = 0; i < po.length; i++) {
          var t = po[i], n = w[t];
          if (n !== undefined ? n < w[szczyt] / 2 : minTyg[t] < w[szczyt] / 2) { polowa = Math.round((new Date(t) - new Date(szczyt)) / 6048e5); break; }
        }
      }
      return { k: k, a: du[k][0], t: du[k][1], n: du[k][2], debiut: du[k][3],
        pierwszaStacja: kolejnosc[k][0] ? nazwaJednostki_(kolejnosc[k][0][0]) : (du[k][5] ? nazwaJednostki_(du[k][5]) : null),
        stacji: kolejnosc[k].length || du[k][4], tygodniNaAntenie: tygodnie.length, szczyt: szczyt || null, emisjiWSzczycie: szczyt ? w[szczyt] : 0,
        dniDoSzczytu: szczyt ? Math.max(0, Math.round((new Date(szczyt) - new Date(poniedzialek(debiut))) / 864e5)) : null,
        polowaTrwaniaTyg: polowa, tygodnie: tygodnie.map(function (t) { return [t, w[t]]; }) };
    });
    return { debiutow: debiuty.length, hity: hity, stacje: stacje, dyfuzja: dyfuzja, odDebiutow: odEf > od ? deb.od : null, zTop: 300 };
  });
}

// ---------------- N4: wiek repertuaru ----------------

/** Średni rok wydania i udział dekad miesiąc po miesiącu dla stacji (z lat jednostek i metadanych). */
function wiekRepertuaru(jednostki, odRok, doRok) {
  return bezpiecznie_(function () {
    var meta = metadane_();
    return { stacje: (jednostki || []).slice(0, 6).map(function (j) {
      var mies = {};
      for (var r = +odRok; r <= +doRok; r++) {
        var a = agg_(j, r + '.json.gz');
        if (!a) continue;
        Object.keys(a.u).forEach(function (k) {
          // rok stacji: x[3] = {miesiąc: emisje}; rok całego radia: x[3] = {stacja: emisje}, x[4] = {miesiąc: emisje}
          var y = (meta[k] || {}).y, x = a.u[k], mm3 = j === '_wszystkie' ? x[4] : x[3];
          Object.keys(mm3).forEach(function (mm) {
            var e = mies[r + '-' + mm] = mies[r + '-' + mm] || { emisji: 0, zRokiem: 0, sumaLat: 0, dekady: {} };
            e.emisji += mm3[mm];
            if (!y) return;
            e.zRokiem += mm3[mm]; e.sumaLat += y * mm3[mm];
            var dek = Math.floor(y / 10) * 10;
            e.dekady[dek] = (e.dekady[dek] || 0) + mm3[mm];
          });
        });
      }
      return { id: j, nazwa: nazwaJednostki_(j), miesiace: Object.keys(mies).sort().map(function (m) {
        var e = mies[m];
        return { m: m, sredniRok: e.zRokiem ? e.sumaLat / e.zRokiem : null, pokrycie: e.emisji ? e.zRokiem / e.emisji : 0, dekady: e.dekady, zRokiem: e.zRokiem };
      }) };
    }) };
  });
}

// ---------------- N5 / S2: pory dnia i zegar formatu ----------------

/** Każda godzina doby: emisje, udział polskich wykonawców, nowości (wydane ≤ 1 rok przed końcem okresu), klasyków (≥ 20 lat), średni rok. */
function poryDnia(j, od, doo) {
  return bezpiecznie_(function () { return lacznie_('pory', j, [od, doo], function () {
    var meta = metadane_(), rokKon = +doo.slice(0, 4), godz = [];
    for (var h = 0; h < 24; h++) godz.push({ h: h, emisji: 0, zKrajem: 0, pl: 0, zRokiem: 0, nowosci: 0, klasyki: 0, sumaLat: 0 });
    miesiaceJednostki_(j, od, doo, function (a, m, wZakresie) {
      Object.keys(a.u).forEach(function (k) {
        var x = a.u[k], mt = meta[k] || {}, nZakres = 0;
        Object.keys(x[3]).forEach(function (d) { if (wZakresie(d)) nZakres += x[3][d]; });
        if (!nZakres) return;
        var suma = 0; Object.keys(x[4]).forEach(function (hw) { suma += x[4][hw]; });
        Object.keys(x[4]).forEach(function (hw) {
          var n = x[4][hw] * nZakres / suma, g = godz[godzinaHw_(hw)];
          g.emisji += n;
          if (mt.c) { g.zKrajem += n; if (mt.c === 'PL') g.pl += n; }
          if (mt.y) { g.zRokiem += n; g.sumaLat += mt.y * n; if (mt.y >= rokKon - 1) g.nowosci += n; if (mt.y <= rokKon - 20) g.klasyki += n; }
        });
      });
    });
    return { nazwa: nazwaJednostki_(j), godziny: godz.map(function (g) {
      return { h: g.h, emisji: Math.round(g.emisji), udzialPL: g.zKrajem ? g.pl / g.zKrajem : null, nowosci: g.zRokiem ? g.nowosci / g.zRokiem : null,
        klasyki: g.zRokiem ? g.klasyki / g.zRokiem : null, sredniRok: g.zRokiem ? g.sumaLat / g.zRokiem : null, pokrycie: g.emisji ? g.zRokiem / g.emisji : 0 };
    }) };
  }); });
}

// ---------------- N6: mapa podobieństwa stacji ----------------

/** Podobieństwo repertuaru wszystkich stacji (kosinus wektorów emisji) w zakresie – z miesięcy całego radia. */
/**
 * Stacje najbardziej podobne do j: kosinus wektorów emisji utworów (miesiące całego radia, do 13 ostatnich miesięcy
 * okresu) i liczba wspólnych utworów. Lekkie – czyta tylko pliki miesięcy całego radia.
 */
function podobneStacje(j, od, doo) {
  return bezpiecznie_(function () {
    return zPamieci_('podobneStacje|' + j + '|' + od + '|' + doo, 3600, function () {
      var wekt = {};
      miesiaceZakresu_(od, doo).slice(-13).forEach(function (m) {
        var g = agg_('_wszystkie', m + '.json.gz');
        if (!g) return;
        Object.keys(g.u).forEach(function (k) {
          var x = g.u[k];
          Object.keys(x[4]).forEach(function (s) { var v = wekt[s] = wekt[s] || {}; v[k] = (v[k] || 0) + x[4][s]; });
        });
      });
      var vj = wekt[j];
      if (!vj) return { stacje: [] };
      var norma = function (v) { return Math.sqrt(Object.keys(v).reduce(function (s, k) { return s + v[k] * v[k]; }, 0)); };
      var nj = norma(vj), lista = [];
      Object.keys(wekt).forEach(function (s) {
        if (s === j || Object.keys(wekt[s]).length < 30) return;
        var v = wekt[s], il = 0, wsp = 0;
        Object.keys(vj).forEach(function (k) { if (v[k]) { il += vj[k] * v[k]; wsp++; } });
        lista.push({ id: s, nazwa: nazwaJednostki_(s), pod: Math.round(il / (nj * norma(v) || 1) * 1000) / 1000, wspolnych: wsp, utworow: Object.keys(v).length });
      });
      lista.sort(function (a, b) { return b.pod - a.pod; });
      return { stacje: lista, utworow: Object.keys(vj).length };
    });
  });
}

function podobienstwoStacji(od, doo) {
  return bezpiecznie_(function () {
    var wekt = {};
    miesiaceZakresu_(od, doo).slice(-13).forEach(function (m) {
      var g = agg_('_wszystkie', m + '.json.gz');
      if (!g) return;
      Object.keys(g.u).forEach(function (k) {
        var x = g.u[k];
        Object.keys(x[4]).forEach(function (j) { var v = wekt[j] = wekt[j] || {}; v[k] = (v[k] || 0) + x[4][j]; });
      });
    });
    var ids = Object.keys(wekt).filter(function (j) { return Object.keys(wekt[j]).length >= 30; });
    var norma = {};
    ids.forEach(function (j) { norma[j] = Math.sqrt(Object.keys(wekt[j]).reduce(function (s, k) { return s + wekt[j][k] * wekt[j][k]; }, 0)); });
    var mac = {};
    ids.forEach(function (a) {
      mac[a] = {};
      ids.forEach(function (b) {
        if (a === b) { mac[a][b] = 1; return; }
        if (mac[b] && mac[b][a] !== undefined) { mac[a][b] = mac[b][a]; return; }
        var va = wekt[a], vb = wekt[b], il = 0;
        Object.keys(va).forEach(function (k) { if (vb[k]) il += va[k] * vb[k]; });
        mac[a][b] = il / (norma[a] * norma[b] || 1);
      });
    });
    // kolejność: łańcuch najbliższych sąsiadów (podobne stacje obok siebie)
    var kolej = [], pozostale = ids.slice();
    if (pozostale.length) {
      var start = pozostale.sort(function (a, b) { return Object.keys(wekt[b]).length - Object.keys(wekt[a]).length; })[0];
      kolej.push(start); pozostale.splice(pozostale.indexOf(start), 1);
      while (pozostale.length) {
        var ost = kolej[kolej.length - 1];
        pozostale.sort(function (a, b) { return mac[ost][b] - mac[ost][a]; });
        kolej.push(pozostale.shift());
      }
    }
    return { stacje: kolej.map(function (j) { return { id: j, nazwa: nazwaJednostki_(j) }; }), macierz: kolej.map(function (a) { return kolej.map(function (b) { return Math.round(mac[a][b] * 1000) / 1000; }); }) };
  });
}

// ---------------- N7: zmiany formatu ----------------

/** Podobieństwo repertuaru stacji miesiąc do miesiąca (wobec 3 poprzednich); spadki = możliwa zmiana formatu. */
function zmianyFormatu(j, odM, doM) {
  return bezpiecznie_(function () {
    var wekt = [];
    miesiaceZakresu_(odM + '-01', doM + '-28').forEach(function (m) {
      var a = agg_(j, m + '.json.gz');
      if (!a) return;
      var v = {}; Object.keys(a.u).forEach(function (k) { v[k] = a.u[k][2]; });
      wekt.push([m, v, Object.keys(a.u).length]);
    });
    var kos = function (a, b) {
      var il = 0, na = 0, nb = 0;
      Object.keys(a).forEach(function (k) { na += a[k] * a[k]; if (b[k]) il += a[k] * b[k]; });
      Object.keys(b).forEach(function (k) { nb += b[k] * b[k]; });
      return il / (Math.sqrt(na * nb) || 1);
    };
    var wynik = wekt.map(function (w, i) {
      if (i === 0) return { m: w[0], podobienstwo: null, utworow: w[2] };
      var ref = {};
      wekt.slice(Math.max(0, i - 3), i).forEach(function (p) { Object.keys(p[1]).forEach(function (k) { ref[k] = (ref[k] || 0) + p[1][k]; }); });
      return { m: w[0], podobienstwo: kos(w[1], ref), utworow: w[2] };
    });
    var war = wynik.filter(function (x) { return x.podobienstwo !== null; }).map(function (x) { return x.podobienstwo; });
    var sr = war.length ? war.reduce(function (s, x) { return s + x; }, 0) / war.length : 0;
    var odch = war.length ? Math.sqrt(war.reduce(function (s, x) { return s + (x - sr) * (x - sr); }, 0) / war.length) : 0;
    wynik.forEach(function (x) { x.zmiana = x.podobienstwo !== null && x.podobienstwo < sr - 2 * odch; });
    return { nazwa: nazwaJednostki_(j), miesiace: wynik, srednia: sr };
  });
}

// ---------------- N8: co leci po czym ----------------

/** Najczęstsze pary „utwór → następny utwór” na stacji (do 3 miesięcy, odstęp ≤ 15 min). */
function coPoCzym(j, od, doo) {
  return bezpiecznie_(function () { return lacznie_('copoczym', j, [od, doo], function () {
    if ((new Date(doo) - new Date(od)) / 864e5 > 93) return { blad: 'Wybierz okres do 3 miesięcy.' };
    var emisje = [];
    miesiaceJednostki_(j, od, doo, function (a, m, wZakresie, jj) {
      Object.keys(a.u).forEach(function (k) {
        (a.u[k][6] || []).forEach(function (t) { if (wZakresie(t.slice(0, 2))) emisje.push([m + '-' + t, k, a.u[k][0], a.u[k][1], jj]); });
      });
    });
    // pary tylko w obrębie jednej stacji (przy „wszystkie stacje” – sumy par wszystkich stacji)
    emisje.sort(function (a, b) { return a[4] < b[4] ? -1 : a[4] > b[4] ? 1 : a[0] < b[0] ? -1 : 1; });
    var pary = {}, nazwy = {};
    for (var i = 1; i < emisje.length; i++) {
      var p = emisje[i - 1], q = emisje[i];
      if (p[4] !== q[4]) continue;
      var dt = (new Date(q[0].replace(' ', 'T') + ':00Z') - new Date(p[0].replace(' ', 'T') + ':00Z')) / 6e4;
      if (dt > 15 || p[1] === q[1]) continue;
      var key = p[1] + '→' + q[1];
      pary[key] = (pary[key] || 0) + 1;
      nazwy[p[1]] = p[2] + ' – ' + p[3]; nazwy[q[1]] = q[2] + ' – ' + q[3];
    }
    var lista = Object.keys(pary).filter(function (k) { return pary[k] >= 2; }).sort(function (a, b) { return pary[b] - pary[a]; }).slice(0, 200).map(function (k) {
      var x = k.split('→');
      return { z: x[0], zNazwa: nazwy[x[0]], na: x[1], naNazwa: nazwy[x[1]], razy: pary[k] };
    });
    return { nazwa: nazwaJednostki_(j), emisji: emisje.length, pary: lista };
  }); });
}

// ---------------- N9: skoki wykonawców ----------------

/** Dni, w których wykonawca był grany w całym radiu znacznie częściej niż zwykle (wobec 28 poprzednich dni). */
function skokiWykonawcow(od, doo) {
  return bezpiecznie_(function () {
    if ((new Date(doo) - new Date(od)) / 864e5 > 186) return { blad: 'Wybierz okres do 6 miesięcy.' };
    var odT = dataPlus_(od, -28), dane = dzienneRadia_(odT, doo), wyk = {}, nazwy = {};
    Object.keys(dane).forEach(function (k) {
      var w = k.split('|')[0];
      nazwy[w] = nazwy[w] || String(dane[k].a).split(/\s+(?:\/|&|feat\.?|ft\.?|x)\s+/i)[0];
      var v = wyk[w] = wyk[w] || {};
      Object.keys(dane[k].dni).forEach(function (d) { v[d] = (v[d] || 0) + dane[k].dni[d]; });
    });
    var dni = []; for (var d = odT; d <= doo; d = dataPlus_(d, 1)) dni.push(d);
    var skoki = [];
    Object.keys(wyk).forEach(function (w) {
      var v = wyk[w];
      dni.forEach(function (d, i) {
        if (d < od || i < 28) return;
        var hist = dni.slice(i - 28, i).map(function (x) { return v[x] || 0; });
        var sr = hist.reduce(function (s, x) { return s + x; }, 0) / 28;
        var sd = Math.sqrt(hist.reduce(function (s, x) { return s + (x - sr) * (x - sr); }, 0) / 28);
        var n = v[d] || 0;
        if (n >= 15 && n > sr * 3 && n > sr + 4 * Math.max(sd, 1)) skoki.push({ wykonawca: nazwy[w], k: w, dzien: d, emisji: n, zwykle: Math.round(sr * 10) / 10 });
      });
    });
    skoki.sort(function (a, b) { return (b.emisji / (b.zwykle + 1)) - (a.emisji / (a.zwykle + 1)); });
    return { skoki: skoki.slice(0, 200) };
  });
}

// ---------------- N10: eksport zestawień ----------------

/** Dowolna tabela panelu jako CSV w folderze „Music Base – eksporty” na Dysku. */
function eksportCsv(nazwa, naglowki, wiersze) {
  return bezpiecznie_(function () {
    var f = podfolder(DriveApp.getRootFolder(), 'Music Base – eksporty');
    var esc = function (s) { s = s === null || s === undefined ? '' : String(s); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    var csv = '﻿' + [naglowki].concat(wiersze).map(function (w) { return w.map(esc).join(','); }).join('\n') + '\n';
    var plik = f.createFile(Utilities.newBlob(csv, 'text/csv', String(nazwa || 'zestawienie').replace(/[\\/:*?"<>|]/g, '-') + '.csv'));
    return { url: plik.getUrl() };
  });
}

// ---------------- S3, S5, S6, S7, S8: rozszerzenia profilu stacji ----------------

/** S3: miesiąc po miesiącu – emisje, różne utwory, rotacja (top 20), średni rok wydania, udział polskich. */
function zmianyJednostki(j, odRok, doRok) {
  return bezpiecznie_(function () {
    var meta = metadane_(), mies = [];
    for (var r = +odRok; r <= +doRok; r++) {
      var a = agg_(j, r + '.json.gz');
      if (!a) continue;
      var pm = {};
      Object.keys(a.u).forEach(function (k) { var x = a.u[k]; Object.keys(x[3]).forEach(function (mm) { (pm[mm] = pm[mm] || []).push([k, x[3][mm]]); }); });
      Object.keys(pm).sort().forEach(function (mm) {
        var l = pm[mm].sort(function (p, q) { return q[1] - p[1]; }), em = 0, lat = 0, zr = 0, pl = 0, zk = 0;
        l.forEach(function (p) { var m = meta[p[0]] || {}; em += p[1]; if (m.y) { lat += m.y * p[1]; zr += p[1]; } if (m.c) { zk += p[1]; if (m.c === 'PL') pl += p[1]; } });
        var top20 = l.slice(0, 20).reduce(function (s, p) { return s + p[1]; }, 0);
        mies.push({ m: r + '-' + mm, emisji: em, utworow: l.length, rotacja: em ? top20 / em : null, sredniRok: zr ? lat / zr : null, udzialPL: zk ? pl / zk : null, dni: (a.mies[mm] || {}).dni || 0 });
      });
    }
    return { nazwa: nazwaJednostki_(j), miesiace: mies };
  });
}

/** S5: evergreeny – utwory grane przez stację w największej liczbie różnych lat. */
function evergreeny(j) {
  return bezpiecznie_(function () {
    var u = {}, meta = metadane_(), fj = folderJ_(j), lata = [];
    if (fj) { var it = fj.getFiles(); while (it.hasNext()) { var p = it.next(); if (!p.isTrashed() && /^\d{4}\.json\.gz$/.test(p.getName())) lata.push(p.getName().slice(0, 4)); } }
    lata.filter(function (r, i) { return lata.indexOf(r) === i; }).sort().forEach(function (r) {
      var a = agg_(j, r + '.json.gz');
      if (a) Object.keys(a.u).forEach(function (k) { var e = u[k] = u[k] || { a: a.u[k][0], t: a.u[k][1], lata: [], n: 0 }; e.lata.push(+r); e.n += a.u[k][2]; });
    });
    var lista = Object.keys(u).map(function (k) { var e = u[k]; e.k = k; e.y = (meta[k] || {}).y || null; e.liczbaLat = e.lata.length; return e; })
      .filter(function (e) { return e.liczbaLat >= 3; }).sort(function (a, b) { return b.liczbaLat - a.liczbaLat || b.n - a.n; });
    return { nazwa: nazwaJednostki_(j), lat: lata.length, evergreeny: lista.slice(0, 200) };
  });
}

/** S6: sieć – w których godzinach stacje nadają wspólnie (udział powtórzeń wspólnych pasm w emisjach stacji). */
function pasmaSieci(j, od, doo) {
  return bezpiecznie_(function () {
    if (!SIECI[j]) return { blad: 'To nie jest sieć stacji.' };
    var sumaStacji = {}, siec = {};
    var dodajHw = function (cel, jedn) {
      miesiaceJednostki_(jedn, od, doo, function (a) {
        Object.keys(a.u).forEach(function (k) { var x = a.u[k][4]; Object.keys(x).forEach(function (h) { cel[h] = (cel[h] || 0) + x[h]; }); });
      });
    };
    SIECI[j].czlonkowie.forEach(function (s) { dodajHw(sumaStacji, s); });
    dodajHw(siec, j);
    var wspolne = {};
    Object.keys(sumaStacji).forEach(function (h) {
      var czl = SIECI[j].czlonkowie.length, s = sumaStacji[h], n = siec[h] || 0;
      // udział wspólnego programu: 0 = każda stacja gra co innego, 1 = wszystkie grają to samo
      wspolne[h] = czl > 1 && n ? Math.max(0, Math.min(1, (s - n) / (n * (czl - 1)))) : 0;
    });
    return { nazwa: SIECI[j].nazwa, wspolne: wspolne, stacji: SIECI[j].czlonkowie.length };
  });
}

/** S7: jakość danych – doby z danymi i liczba emisji na dobę dla stacji (lub każdej stacji sieci). */
function jakoscDanych(j) {
  return bezpiecznie_(function () {
    var stacje = SIECI[j] ? SIECI[j].czlonkowie : [j];
    return { stacje: stacje.map(function (s) {
      var f = podfolder(folderGlowny_(), s, false), st = f ? (czytajJsonPlik(f, 'stan.json') || {}) : {};
      return { id: s, nazwa: nazwaJednostki_(s), dni: st.dni || {}, pusteMiesiace: st.miesiace_puste || [] };
    }) };
  });
}

/** S8: wskaźniki stacji na tle wszystkich stacji (metryki roku z Odbiornika). */
function naTleRynku(j, rok) {
  return bezpiecznie_(function () {
    var m = czytajJsonPlik(folderJ_('_wszystkie'), 'metryki_' + rok + '.json');
    if (!m) return { blad: 'Brak metryk za ' + rok + ' (liczą się po przeliczeniu roku).' };
    var glowne = Object.keys(m).filter(function (x) { return !siecStacji(x); });
    var pola = ['naDobe', 'utworow', 'rotacja', 'sredniRok', 'udzialPL'];
    var med = {};
    pola.forEach(function (p) {
      var v = glowne.map(function (x) { return m[x][p]; }).filter(function (x) { return x !== null && x !== undefined; }).sort(function (a, b) { return a - b; });
      med[p] = v.length ? v[Math.floor(v.length / 2)] : null;
      med[p + '_min'] = v[0]; med[p + '_max'] = v[v.length - 1];
    });
    return { rok: rok, stacja: m[j] || null, mediana: med, stacji: glowne.length };
  });
}

/** S4: wyróżniki – utwory, których udział na stacji najbardziej przewyższa udział w całym radiu. */
function wyrozniki(j, od, doo) {
  return bezpiecznie_(function () {
    var zs = zbierz_(j, od, doo), zw = zbierz_('_wszystkie', od, doo), meta = metadane_();
    var lista = Object.keys(zs.u).filter(function (k) { return zs.u[k][2] >= 5; }).map(function (k) {
      var us = zs.u[k][2] / (zs.emisji || 1), uw = ((zw.u[k] || [0, 0, 0])[2]) / (zw.emisji || 1);
      return { k: k, a: zs.u[k][0], t: zs.u[k][1], n: zs.u[k][2], wszystkich: (zw.u[k] || [0, 0, 0])[2], wskaznik: uw ? us / uw : null, y: (meta[k] || {}).y || null };
    }).filter(function (x) { return x.wskaznik; }).sort(function (a, b) { return (b.wskaznik * Math.log(1 + b.n)) - (a.wskaznik * Math.log(1 + a.n)); });
    return { wyrozniki: lista.slice(0, 200) };
  });
}

// ---------------- A3: kategorie rotacji ----------------

/**
 * Rola utworów w playliście stacji w okresie (praktyka branżowa bez jednego standardu progów – progi z danych stacji):
 *  • power – górne 15% utworów w rotacji (≥ 1 emisja/tydz.) i co najmniej 3 emisje tygodniowo,
 *  • current / recurrent / gold – pozostałe w rotacji według wieku: rok wydania (≤ 1 rok / ≤ 3 lata / starsze);
 *    bez roku wydania – według pierwszej emisji w całej bazie (≤ 12 / ≤ 36 miesięcy / dawniej; baza od 04.2023),
 *  • sporadyczne – rzadziej niż raz w tygodniu.
 */
var KATEGORIE_ROTACJI = ['power', 'current', 'recurrent', 'gold', 'sporadyczne'];
function kategorieStacji_(j, od, doo) {
  var meta = metadane_(), u = {};
  var tyg = Math.max(1, ((Date.parse(doo) - Date.parse(od)) / 864e5 + 1) / 7);
  miesiaceJednostki_(j, od, doo, function (a, m, wZakresie) {
    Object.keys(a.u).forEach(function (k) {
      var x = a.u[k], n = 0;
      Object.keys(x[3]).forEach(function (d) { if (wZakresie(d)) n += x[3][d]; });
      if (!n) return;
      var e = u[k] = u[k] || { k: k, a: x[0], t: x[1], n: 0 };
      e.n += n;
    });
  });
  var rokKon = +doo.slice(0, 4), kon = Date.parse(doo);
  var lista = Object.keys(u).map(function (k) {
    var e = u[k], i = znany_(k);
    e.naTydzien = Math.round(e.n / tyg * 10) / 10;
    e.y = (meta[k] || {}).y || null;
    e.pierwsza = i ? i.pierwsza : null;
    return e;
  });
  var rot = lista.filter(function (e) { return e.naTydzien >= 1; }).sort(function (a, b) { return b.naTydzien - a.naTydzien; });
  var prog = rot.length ? Math.max(3, rot[Math.max(0, Math.ceil(rot.length * 0.15) - 1)].naTydzien) : Infinity;
  lista.forEach(function (e) {
    if (e.naTydzien < 1) { e.kat = 'sporadyczne'; return; }
    if (e.naTydzien >= prog) { e.kat = 'power'; return; }
    if (e.y) { e.kat = e.y >= rokKon - 1 ? 'current' : e.y >= rokKon - 3 ? 'recurrent' : 'gold'; e.wiek = 'rok wydania'; return; }
    var mies = e.pierwsza ? (kon - Date.parse(e.pierwsza)) / (30.44 * 864e5) : null;
    e.kat = mies === null || mies <= 12 ? 'current' : mies <= 36 ? 'recurrent' : 'gold';
    e.wiek = 'pierwsza emisja w bazie';
  });
  var emisji = lista.reduce(function (s, e) { return s + e.n; }, 0), podsum = {};
  KATEGORIE_ROTACJI.forEach(function (kt) {
    var l = lista.filter(function (e) { return e.kat === kt; });
    podsum[kt] = { utworow: l.length, emisji: l.reduce(function (s, e) { return s + e.n; }, 0) };
    podsum[kt].udzial = emisji ? podsum[kt].emisji / emisji : 0;
  });
  return { lista: lista, emisji: emisji, tygodni: Math.round(tyg * 10) / 10, progPower: prog === Infinity ? null : prog, podsum: podsum };
}
/** Jedna stacja: podsumowanie kategorii i wszystkie utwory z kategorią (do przeglądania i eksportu). */
function kategorieRotacji(j, od, doo) {
  return bezpiecznie_(function () {
    var r = kategorieStacji_(j, od, doo);
    r.lista.sort(function (a, b) { return b.n - a.n; });
    return { nazwa: nazwaJednostki_(j), emisji: r.emisji, tygodni: r.tygodni, progPower: r.progPower, podsum: r.podsum, utwory: r.lista };
  });
}
/** Zestawienie dla każdej stacji: udział kategorii w emisjach (pamięć serwera 6 h – czyta pliki wszystkich stacji). */
function kategorieRotacjiWszystkie(od, doo) {
  return bezpiecznie_(function () {
    return zPamieci_('kategorieWszystkie|' + od + '|' + doo, 21600, function () {
      return { stacje: jednostkiGlowneP_().map(function (j) {
        var r = kategorieStacji_(j, od, doo);
        return { id: j, nazwa: nazwaJednostki_(j), emisji: r.emisji, progPower: r.progPower, podsum: r.podsum };
      }).filter(function (x) { return x.emisji > 0; }).sort(function (a, b) { return b.emisji - a.emisji; }) };
    });
  });
}

// ---------------- A1–A14: wskaźniki stacji ----------------

/**
 * Jedno przejście po emisjach każdej stacji (stacja albo sieć główna) w okresie (najwyżej 92 dni wstecz od końca):
 *  A1 różnorodność – liczby Hilla: N1 = exp(entropia Shannona), N2 = 1 / Σp² (odwrotność wskaźnika Herfindahla–Hirschmana);
 *  A2 wymiana – 1 − |Top40(t) ∩ Top40(t−1)| / 40, średnio dla pełnych tygodni (pon.–niedz.);
 *  A7 kwota polska wg czasu – suma długości utworów po polsku / suma długości utworów o znanym języku i długości;
 *  A8 minuty muzyki na godzinę – suma długości emisji / liczba godzin z emisjami, przeskalowana przez pokrycie długością;
 *  A9 odstęp wykonawców – udział emisji, po których ten sam wykonawca wraca w ciągu 60 min, i mediana odstępu (min);
 *  A10 unikalność – udział emisji utworów, których w okresie nie grała żadna inna stacja główna;
 *  A11 wejście nowości – mediana dni od daty wydania (metadane, pełna data) do pierwszej emisji na stacji (wydane ≤ 365 dni przed okresem);
 *  A12 znajomość – średnia liczba emisji utworu w całej bazie (indeks), ważona emisjami stacji;
 *  A6 – dla 300 najczęściej granych utworów emisje na każdej stacji (zasięg liczy przeglądarka z udziałów Radio Track).
 * A14 (kompletność) liczona osobno – kompletnoscDanych().
 */
function wskazniki(od, doo) {
  return bezpiecznie_(function () {
    if (roznicaDniS_(od, doo) > 92) od = dataPlus_(doo, -92);
    return zPamieci_('wskazniki2|' + od + '|' + doo, 21600, function () {
      var meta = metadane_(), jedn = jednostkiGlowneP_(), naUtwor = {}, st = {}, nazwy = {};
      var minuty = function (m, t) { return Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1, +t.slice(0, 2)) / 6e4 + (+t.slice(3, 5)) * 60 + (+t.slice(6, 8)); };
      var poniedzialek = function (iso) { var d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
      jedn.forEach(function (j) {
        var s = st[j] = { id: j, nazwa: nazwaJednostki_(j), emisji: 0, n: {}, tyg: {}, czasy: [], pierwsza: {}, godziny: {} };
        miesiaceJednostki_(j, od, doo, function (a, m, wZakresie) {
          Object.keys(a.u).forEach(function (k) {
            var x = a.u[k], czasy = x[6] || [];
            if (!nazwy[k]) nazwy[k] = [x[0], x[1]];
            Object.keys(x[3]).forEach(function (dd) {
              if (!wZakresie(dd)) return;
              var t = poniedzialek(m + '-' + dd), w = s.tyg[t] = s.tyg[t] || {};
              w[k] = (w[k] || 0) + x[3][dd];
              s.n[k] = (s.n[k] || 0) + x[3][dd]; s.emisji += x[3][dd];
            });
            czasy.forEach(function (c) {
              if (!wZakresie(c.slice(0, 2))) return;
              var mi = minuty(m, c);
              s.czasy.push([mi, k]); s.godziny[Math.floor(mi / 60)] = 1;
              if (s.pierwsza[k] === undefined || mi < s.pierwsza[k]) s.pierwsza[k] = mi;
            });
          });
        });
        Object.keys(s.n).forEach(function (k) { naUtwor[k] = (naUtwor[k] || 0) + 1; });
      });
      var mediana = function (l) { if (!l.length) return null; l.sort(function (a, b) { return a - b; }); var p = l.length >> 1; return l.length % 2 ? l[p] : (l[p - 1] + l[p]) / 2; };
      var odMin = Date.parse(od + 'T00:00:00Z') / 6e4;
      var wynik = jedn.map(function (j) {
        var s = st[j], r = { id: j, nazwa: s.nazwa, emisji: s.emisji, utworow: Object.keys(s.n).length };
        if (s.emisji < 50) return r;
        // A1
        var H = 0, sp2 = 0;
        Object.keys(s.n).forEach(function (k) { var p = s.n[k] / s.emisji; H -= p * Math.log(p); sp2 += p * p; });
        r.hill1 = Math.exp(H); r.hill2 = 1 / sp2; r.hhi = sp2 * 10000;
        // A2: tylko pełne tygodnie wewnątrz okresu
        var tyg = Object.keys(s.tyg).sort().filter(function (t) { return t >= od && dataPlus_(t, 6) <= doo; }), wym = [];
        var top = function (t) { var w = s.tyg[t]; return Object.keys(w).sort(function (a, b) { return w[b] - w[a]; }).slice(0, 40); };
        for (var i = 1; i < tyg.length; i++) { var a = top(tyg[i - 1]), b = top(tyg[i]); if (b.length >= 40) wym.push(1 - b.filter(function (k) { return a.indexOf(k) >= 0; }).length / 40); }
        r.wymiana = wym.length ? wym.reduce(function (x, y) { return x + y; }, 0) / wym.length : null; r.tygodni = wym.length;
        // A7, A8
        var zDl = 0, sekund = 0, plS = 0, znanyS = 0, plDzienS = 0;
        Object.keys(s.n).forEach(function (k) {
          var mt = meta[k] || {}; if (!mt.l) return;
          zDl += s.n[k]; sekund += mt.l * s.n[k];
          if (mt.j) { znanyS += mt.l * s.n[k]; if (mt.j === 'pl') plS += mt.l * s.n[k]; }
        });
        s.czasy.forEach(function (c) { var mt = meta[c[1]] || {}; if (mt.l && mt.j === 'pl') { var h = Math.floor(((c[0] % 1440) + 1440) % 1440 / 60); if (h >= 5) plDzienS += mt.l; } });
        r.pokrycieDlugosci = zDl / s.emisji;
        var godzin = Object.keys(s.godziny).length;
        r.minutMuzykiNaGodz = zDl >= 30 && godzin ? sekund / r.pokrycieDlugosci / 60 / godzin : null;
        r.kwotaCzas = znanyS ? plS / znanyS : null; r.kwotaCzasDzien = plS ? plDzienS / plS : null; r.pokrycieKwotyCzas = znanyS ? znanyS / (sekund / (r.pokrycieDlugosci || 1)) : 0;
        // A9
        s.czasy.sort(function (a, b) { return a[0] - b[0]; });
        var ost = {}, powr = 0, odst = [];
        s.czasy.forEach(function (c) {
          // pierwszy wykonawca = początek klucza utworu (klucz liczony z wykonawców: kluczUtworu w Wspolne.gs)
          [c[1].split('|')[0]].forEach(function (w) {
            if (ost[w] !== undefined) { var g = c[0] - ost[w]; if (g > 3) { odst.push(g); if (g <= 60) powr++; } }
            ost[w] = c[0];
          });
        });
        r.powrotyWykonawcy60 = s.czasy.length ? powr / s.czasy.length : null; r.medianaOdstepuWykonawcy = mediana(odst);
        // A10
        var uni = 0; Object.keys(s.n).forEach(function (k) { if (naUtwor[k] === 1) uni += s.n[k]; });
        r.unikalnosc = uni / s.emisji;
        // A11
        var dni = [];
        Object.keys(s.pierwsza).forEach(function (k) {
          var d = (meta[k] || {}).d; if (!d || d.length < 10) return;
          var wyd = Date.parse(d.slice(0, 10) + 'T00:00:00Z') / 6e4;
          if (wyd < odMin - 365 * 1440 || wyd > s.pierwsza[k]) return;
          dni.push((s.pierwsza[k] - wyd) / 1440);
        });
        r.dniDoPremiery = mediana(dni); r.premier = dni.length;
        // A12
        var zn = 0, znN = 0; Object.keys(s.n).forEach(function (k) { var i = znany_(k); if (i) { zn += i.n * s.n[k]; znN += s.n[k]; } });
        r.znajomosc = znN ? zn / znN : null;
        return r;
      });
      // A6: 300 najczęściej granych utworów z emisjami na stacjach
      var suma = {}; jedn.forEach(function (j) { Object.keys(st[j].n).forEach(function (k) { suma[k] = (suma[k] || 0) + st[j].n[k]; }); });
      var top = Object.keys(suma).sort(function (a, b) { return suma[b] - suma[a]; }).slice(0, 300).map(function (k) {
        var na = {}; jedn.forEach(function (j) { if (st[j].n[k]) na[j] = st[j].n[k]; });
        var u = nazwy[k] || [];
        return { k: k, a: u[0] || k.split('|')[0], t: u[1] || k.split('|')[1], n: suma[k], na: na };
      });
      // A13: średnie podobieństwo (część wspólna / suma zbiorów utworów) wewnątrz grup i między grupami
      var gr = grupyStacji_(), wGrupach = {}, miedzy = [], jacc = function (a, b) { var w = 0, ka = Object.keys(st[a].n); ka.forEach(function (k) { if (st[b].n[k]) w++; }); var s2 = ka.length + Object.keys(st[b].n).length - w; return s2 ? w / s2 : 0; };
      var akt = jedn.filter(function (j) { return st[j].emisji >= 50; });
      for (var i = 0; i < akt.length; i++) for (var k = i + 1; k < akt.length; k++) {
        var ga = gr[akt[i]], gb = gr[akt[k]], v = jacc(akt[i], akt[k]);
        if (ga && ga === gb) (wGrupach[ga] = wGrupach[ga] || []).push(v); else miedzy.push(v);
      }
      var sr = function (l) { return l.length ? l.reduce(function (x, y) { return x + y; }, 0) / l.length : null; };
      var grupy = Object.keys(wGrupach).map(function (g) {
        return { grupa: g, stacji: akt.filter(function (j) { return gr[j] === g; }).map(function (j) { return st[j].nazwa; }), wewnatrz: sr(wGrupach[g]), par: wGrupach[g].length };
      }).sort(function (a, b) { return b.wewnatrz - a.wewnatrz; });
      return { od: od, do: doo, stacje: wynik, top: top, grupy: grupy, miedzyGrupami: sr(miedzy),
        zDlugoscia: Object.keys(meta).filter(function (k) { return meta[k].l; }).length };
    });
  });
}
function roznicaDniS_(a, b) { return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5); }

/**
 * A14: kompletność danych – dla ostatnich 7 dni okresu liczba emisji w każdej godzinie wobec oczekiwanej
 * (mediana tej samej godziny i dnia tygodnia z 4 wcześniejszych tygodni). Dziura: oczekiwane ≥ 4, faktyczne ≤ 25% oczekiwanych.
 */
function kompletnoscDanych(doo) {
  return bezpiecznie_(function () {
    var wczoraj = dataPlus_(Utilities.formatDate(new Date(), 'Europe/Warsaw', 'yyyy-MM-dd'), -1);
    if (doo > wczoraj) doo = wczoraj;   // bieżąca doba jest jeszcze niepełna
    return zPamieci_('kompletnosc2|' + doo, 3600, function () {
      var od = dataPlus_(doo, -34), od7 = dataPlus_(doo, -6), stacje = [], dziury = [], bezHistorii = [];
      jednostkiGlowneP_().forEach(function (j) {
        var licz = {}, dni = {};
        miesiaceJednostki_(j, od, doo, function (a, m, wZakresie) {
          Object.keys(a.u).forEach(function (k) { (a.u[k][6] || []).forEach(function (c) { if (wZakresie(c.slice(0, 2))) { var kl = m + '-' + c.slice(0, 2) + ' ' + c.slice(3, 5); licz[kl] = (licz[kl] || 0) + 1; dni[m + '-' + c.slice(0, 2)] = 1; } }); });
        });
        var ocz = 0, fakt = 0, dz = 0;
        for (var d = od7; d <= doo; d = dataPlus_(d, 1)) for (var h = 0; h < 24; h++) {
          // porównanie tylko z dniami, w których stacja w ogóle miała dane (co najmniej 3 z 4 poprzednich tygodni)
          var tyg = [1, 2, 3, 4].map(function (t) { return dataPlus_(d, -7 * t); }).filter(function (x) { return dni[x]; });
          if (tyg.length < 3) continue;
          var hh = (h < 10 ? '0' : '') + h, wcz = tyg.map(function (x) { return licz[x + ' ' + hh] || 0; }).sort(function (a, b) { return a - b; });
          wcz = wcz.length === 4 ? wcz : wcz.concat([wcz[1]]).sort(function (a, b) { return a - b; });
          var e = (wcz[1] + wcz[2]) / 2, f = licz[d + ' ' + hh] || 0;
          if (e < 1) continue;
          ocz += e; fakt += Math.min(f, e);
          if (e >= 4 && f <= 0.25 * e) { dz++; dziury.push({ id: j, nazwa: nazwaJednostki_(j), dzien: d, h: h, faktycznie: f, oczekiwane: e }); }
        }
        if (ocz) stacje.push({ id: j, nazwa: nazwaJednostki_(j), kompletnosc: fakt / ocz, dziurGodzin: dz });
        else if (Object.keys(dni).length) bezHistorii.push(nazwaJednostki_(j));
      });
      stacje.sort(function (a, b) { return a.kompletnosc - b.kompletnosc; });
      dziury.sort(function (a, b) { return a.nazwa.localeCompare(b.nazwa) || (a.dzien + a.h < b.dzien + b.h ? -1 : 1); });
      return { od: od7, do: doo, stacje: stacje, dziury: dziury.slice(0, 500), bezHistorii: bezHistorii };
    });
  });
}

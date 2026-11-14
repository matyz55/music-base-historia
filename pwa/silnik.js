/*
 * Music Base PWA – silnik (Web Worker): kod panelu Apps Script na lokalnej kopii danych.
 * Dane: dane/drzewo.json (spis plików i paczek) + dane/p/<paczka>.bin (folder × rok). Paczki trzymane w IndexedDB;
 * przy otwarciu aplikacji pobierane są tylko paczki, których skrót się zmienił. Bez sieci – to, co już jest na urządzeniu.
 */
'use strict';
importScripts('fflate.js', 'srodowisko.js', 'panel.js');
// cały silnik w osobnym zakresie: kod panelu ma własne funkcje globalne (np. start – ekran Start)
(function () {

var BAZA = null, DRZEWO = null, ZALADOWANE = new Set(), SYNCHRONIZACJA = null;
// funkcje, które zapisują dane albo wymagają kont (Spotify, e-mail) – tylko w panelu online
var TYLKO_ONLINE = /^(zapisz|ustaw|zamknij|ntfyUstawienia|spotify(?!Stan)|eksport|zestawienieOzz|przygotuj)/;

function otworzBaze() {
  if (BAZA) return Promise.resolve(BAZA);
  return new Promise(function (ok, zle) {
    var r = indexedDB.open('music-base', 1);
    r.onupgradeneeded = function () { r.result.createObjectStore('paczki'); r.result.createObjectStore('meta'); };
    r.onsuccess = function () { BAZA = r.result; ok(BAZA); };
    r.onerror = function () { zle(r.error); };
  });
}
function idb(magazyn, tryb, f) {
  return otworzBaze().then(function (db) {
    return new Promise(function (ok, zle) {
      var t = db.transaction(magazyn, tryb), w = f(t.objectStore(magazyn));
      t.oncomplete = function () { ok(w && 'result' in w ? w.result : undefined); };
      t.onerror = function () { zle(t.error); }; t.onabort = function () { zle(t.error || new Error('Przerwany zapis – brak miejsca na urządzeniu?')); };
    });
  });
}
var idbGet = function (m, k) { return idb(m, 'readonly', function (s) { return s.get(k); }); };
var idbPut = function (m, k, v) { return idb(m, 'readwrite', function (s) { s.put(v, k); }); };
var idbDel = function (m, k) { return idb(m, 'readwrite', function (s) { s.delete(k); }); };
var idbKlucze = function (m) { return idb(m, 'readonly', function (s) { return s.getAllKeys(); }); };

function status(o) { self.postMessage({ status: o }); }

/** Spis z sieci (gdy jest) albo z urządzenia; paczki ze zmienionym skrótem do pobrania od nowa. */
function wczytajSpis() {
  return idbGet('meta', 'drzewo').then(function (lok) {
    // redirect: 'manual' – wygasła sesja Cloudflare Access to przekierowanie do strony logowania, nie brak sieci
    return fetch('dane/drzewo.json', { cache: 'no-store', credentials: 'same-origin', redirect: 'manual' }).then(function (r) {
      var typ = r.headers.get('content-type') || '';
      if (r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400) || (r.ok && typ.indexOf('json') < 0)) throw new Error('zaloguj');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (nowe) {
      var stare = (lok && lok.paczki) || {}, doUsuniecia = Object.keys(stare).filter(function (id) { return !nowe.paczki[id] || nowe.paczki[id].h !== stare[id].h; });
      return Promise.all(doUsuniecia.map(function (id) { return idbDel('paczki', id); })).then(function () { return idbPut('meta', 'drzewo', nowe); })
        .then(function () { return { drzewo: nowe, online: true, zmienionych: doUsuniecia.length }; });
    }).catch(function (e) {
      if (!lok) throw new Error(e.message === 'zaloguj' ? 'Sesja Cloudflare wygasła – odśwież stronę i zaloguj się.' : 'Brak danych na urządzeniu i brak połączenia (' + e.message + ').');
      return { drzewo: lok, online: false, powod: e.message === 'zaloguj' ? 'sesja wygasła – odśwież i zaloguj się' : 'bez sieci' };
    });
  });
}
function rozpakuj(id, buf) {
  var dv = new DataView(buf), dl = dv.getUint32(0, true);
  var nagl = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, dl))), baza = 4 + dl;
  nagl.forEach(function (x) { MB.tresc.set(x[0], new Uint8Array(buf, baza + x[1], x[2])); });
  ZALADOWANE.add(id);
}
function pobierzPaczke(id) {
  return fetch('dane/p/' + id + '.bin', { credentials: 'same-origin', redirect: 'manual' }).then(function (r) {
    if (r.type === 'opaqueredirect' || (r.ok && (r.headers.get('content-type') || '').indexOf('html') >= 0)) throw new Error('Sesja Cloudflare wygasła – odśwież stronę i zaloguj się.');
    if (!r.ok) throw new Error('paczka ' + id + ': HTTP ' + r.status);
    return r.arrayBuffer();
  }).then(function (buf) { return idbPut('paczki', id, buf).then(function () { return buf; }); });
}
function zaladujPaczke(id) {
  if (ZALADOWANE.has(id)) return Promise.resolve();
  return idbGet('paczki', id).then(function (buf) { return buf || pobierzPaczke(id); }).then(function (buf) { rozpakuj(id, buf); });
}
/** W tle: wszystkie brakujące paczki (pierwsze uruchomienie – całość, potem tylko zmienione). */
function dociagnijWszystko() {
  return idbKlucze('paczki').then(function (sa) {
    var jest = new Set(sa), brak = Object.keys(DRZEWO.paczki).filter(function (id) { return !jest.has(id); });
    var razem = brak.reduce(function (s, id) { return s + DRZEWO.paczki[id].b; }, 0), zrobione = 0, i = 0;
    if (!brak.length) { status({ etap: 'gotowe', zbudowano: DRZEWO.zbudowano }); return; }
    var nastepna = function () {
      if (i >= brak.length) { status({ etap: 'gotowe', zbudowano: DRZEWO.zbudowano }); return; }
      var id = brak[i++];
      return pobierzPaczke(id).then(function () { zrobione += DRZEWO.paczki[id].b; status({ etap: 'pobieranie', zrobione: zrobione, razem: razem, paczek: i, z: brak.length }); return nastepna(); });
    };
    return nastepna();
  }).catch(function (e) { status({ etap: 'blad', tekst: e.message }); });
}
function start() {
  if (SYNCHRONIZACJA) return SYNCHRONIZACJA;
  SYNCHRONIZACJA = wczytajSpis().then(function (w) {
    DRZEWO = w.drzewo;
    MB.ustawSpis(DRZEWO.pliki);
    status({ etap: w.online ? 'spis' : 'offline', zbudowano: DRZEWO.zbudowano, powod: w.powod, zmienionych: w.zmienionych });
    if (w.online) dociagnijWszystko();
  });
  return SYNCHRONIZACJA;
}

/** Wywołanie funkcji panelu: przy brakującej paczce – dociągnięcie i ponowienie (jak nowe wykonanie w Apps Script). */
function wywolaj(fn, args) {
  return start().then(function () {
    if (typeof self[fn] !== 'function' || /_$/.test(fn)) throw new Error('Brak funkcji ' + fn);
    if (TYLKO_ONLINE.test(fn)) throw new Error('Zmiany zapisuje się w panelu online – aplikacja offline tylko odczytuje dane.');
    var proba = 0;
    var raz = function () {
      MB.braki.clear(); self._PAM = {};
      var w, blad = null;
      try { w = self[fn].apply(null, args); } catch (e) { blad = e; }
      if (MB.braki.size && proba++ < 80) return Promise.all(Array.from(MB.braki).map(zaladujPaczke)).then(raz);
      if (blad) throw blad;
      return w === undefined ? null : JSON.parse(JSON.stringify(w));
    };
    return raz();
  });
}

self.onmessage = function (e) {
  var d = e.data || {};
  if (d.start) { start().catch(function (er) { status({ etap: 'blad', tekst: er.message }); }); return; }
  if (d.miejsce) { idbKlucze('paczki').then(function (k) { status({ etap: 'miejsce', paczek: k.length }); }); return; }
  wywolaj(d.fn, d.args || []).then(function (w) { self.postMessage({ id: d.id, ok: w }); },
    function (er) { self.postMessage({ id: d.id, blad: String((er && er.message) || er) }); });
};
})();

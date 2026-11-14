/*
 * Music Base PWA – service worker: pliki aplikacji w pamięci podręcznej (działa bez sieci).
 * Aplikacja: najpierw sieć (nowa wersja po publikacji), bez sieci – kopia. Dane (dane/…) obsługuje silnik (IndexedDB).
 */
'use strict';
var WERSJA = 'mb-aplikacja-v1';
var PLIKI = ['./', 'index.html', 'silnik.js', 'srodowisko.js', 'panel.js', 'fflate.js', 'manifest.webmanifest', 'ikona-192.png', 'ikona-512.png', 'ikona-maskowalna-512.png'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(WERSJA).then(function (c) { return c.addAll(PLIKI); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (k) { return Promise.all(k.filter(function (x) { return x !== WERSJA; }).map(function (x) { return caches.delete(x); })); })
    .then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.indexOf('/dane/') >= 0) return;
  e.respondWith(fetch(e.request).then(function (r) {
    // logowanie Access (przekierowanie / strona HTML zamiast pliku) – nie nadpisujemy kopii
    if (r.ok && !r.redirected) { var k = r.clone(); caches.open(WERSJA).then(function (c) { c.put(e.request, k); }); }
    return r;
  }).catch(function () {
    return caches.match(e.request, { ignoreSearch: true }).then(function (r) { return r || caches.match('index.html'); });
  }));
});

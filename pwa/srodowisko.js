/*
 * Music Base PWA – usługi Google Apps Script w przeglądarce (Web Worker), na lokalnej kopii plików Dysku.
 * Ten sam kod panelu (Panel.gs, Start.gs, …) działa tu bez zmian, jak w atrapie testowej (tests/atrapa_google.mjs).
 *
 * Pliki: spis z drzewo.json (ścieżka → [bajty, zmieniono ms, paczka]); treść ładowana paczkami (folder × rok).
 * Odczyt pliku z niezaładowanej paczki: paczka trafia na listę MB.braki i rzucamy wyjątek – silnik dociąga paczki
 * i powtarza wywołanie (kod panelu czasem łapie wyjątki przy odczycie, dlatego decyduje lista, nie sam wyjątek).
 * Zapisy (pamięć podręczna panelu itp.) trafiają tylko do pamięci tej sesji.
 */
'use strict';
var MB = {
  pliki: {},          // ścieżka → [b, t, paczka]
  tresc: new Map(),   // ścieżka → Uint8Array (z paczek)
  zapisy: new Map(),  // ścieżka → { b: Uint8Array, t } (zapisy lokalne w tej sesji)
  usuniete: new Set(),
  foldery: new Set(['']),
  braki: new Set(),
  wlasciwosci: {},
  cache: new Map(),
  email: 'pwa@music-base',
};
MB.ustawSpis = function (pliki) {
  MB.pliki = pliki; MB.foldery = new Set(['']);
  Object.keys(pliki).forEach(function (s) { var cz = s.split('/'); for (var i = 1; i < cz.length; i++) MB.foldery.add(cz.slice(0, i).join('/')); });
};
var _tekstD = new TextDecoder('utf-8'), _tekstE = new TextEncoder();
function BlobMB(bytes, typ, nazwa) { this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []); this.typ = typ || ''; this.nazwa = nazwa || ''; }
BlobMB.prototype.getDataAsString = function () { return _tekstD.decode(this.bytes); };
BlobMB.prototype.getBytes = function () { return Array.from(this.bytes); };
BlobMB.prototype.setName = function (n) { this.nazwa = n; return this; };
BlobMB.prototype.getName = function () { return this.nazwa; };
BlobMB.prototype.setContentType = function (t) { this.typ = t; return this; };
BlobMB.prototype.getContentType = function () { return this.typ; };
function iterMB(a) { var i = 0; return { hasNext: function () { return i < a.length; }, next: function () { return a[i++]; } }; }
function sciezka(f, n) { return f ? f + '/' + n : n; }

function PlikMB(sc) { this.sc = sc; }
PlikMB.prototype.getName = function () { return this.sc.slice(this.sc.lastIndexOf('/') + 1); };
PlikMB.prototype.getId = function () { return 'p:' + this.sc; };
PlikMB.prototype.getUrl = function () { return ''; };
PlikMB.prototype.isTrashed = function () { return false; };
PlikMB.prototype.getSize = function () { var z = MB.zapisy.get(this.sc); return z ? z.b.length : (MB.pliki[this.sc] || [0])[0]; };
PlikMB.prototype.getLastUpdated = function () { var z = MB.zapisy.get(this.sc); return new Date(z ? z.t : (MB.pliki[this.sc] || [0, 0])[1]); };
PlikMB.prototype.getBlob = function () {
  var z = MB.zapisy.get(this.sc);
  if (z) return new BlobMB(z.b, '', this.getName());
  var t = MB.tresc.get(this.sc);
  if (t) return new BlobMB(t, '', this.getName());
  var w = MB.pliki[this.sc];
  if (w) { MB.braki.add(w[2]); throw new Error('MB_BRAK_PACZKI ' + w[2]); }
  throw new Error('Brak pliku ' + this.sc);
};
PlikMB.prototype.setTrashed = function (v) { if (v && !MB.braki.size) { MB.zapisy.delete(this.sc); MB.usuniete.add(this.sc); } };
PlikMB.prototype.setContent = function (t) { if (!MB.braki.size) MB.zapisy.set(this.sc, { b: _tekstE.encode(t), t: Date.now() }); };

function FolderMB(sc) { this.sc = sc; }
FolderMB.prototype.getName = function () { return this.sc === '' ? 'Music Base – dane' : this.sc.slice(this.sc.lastIndexOf('/') + 1); };
FolderMB.prototype.getId = function () { return 'f:' + this.sc; };
FolderMB.prototype.getUrl = function () { return ''; };
FolderMB.prototype._dzieci = function () {
  var pref = this.sc ? this.sc + '/' : '', w = [];
  MB.foldery.forEach(function (f) { if (f && f.indexOf(pref) === 0 && f.slice(pref.length).indexOf('/') < 0) w.push(f); });
  return w.sort();
};
FolderMB.prototype._pliki = function () {
  var pref = this.sc ? this.sc + '/' : '', w = {};
  var dodaj = function (s) { if (s.indexOf(pref) === 0 && s.slice(pref.length).indexOf('/') < 0 && !MB.usuniete.has(s)) w[s] = 1; };
  Object.keys(MB.pliki).forEach(dodaj);
  MB.zapisy.forEach(function (_, s) { dodaj(s); });
  return Object.keys(w).sort().map(function (s) { return new PlikMB(s); });
};
FolderMB.prototype.getFolders = function () { return iterMB(this._dzieci().map(function (f) { return new FolderMB(f); })); };
FolderMB.prototype.getFoldersByName = function (n) { var s = sciezka(this.sc, n); return iterMB(MB.foldery.has(s) ? [new FolderMB(s)] : []); };
FolderMB.prototype.getFiles = function () { return iterMB(this._pliki()); };
FolderMB.prototype.searchFiles = function () { return iterMB(this._pliki()); };
FolderMB.prototype.getFilesByName = function (n) { var s = sciezka(this.sc, n); return iterMB(this._pliki().filter(function (p) { return p.sc === s; })); };
FolderMB.prototype.createFolder = function (n) { var s = sciezka(this.sc, n); MB.foldery.add(s); return new FolderMB(s); };
FolderMB.prototype.createFile = function (b, tresc, typ) {
  var blob = typeof b === 'string' ? new BlobMB(_tekstE.encode(tresc || ''), typ, b) : b, s = sciezka(this.sc, blob.nazwa);
  if (!MB.braki.size) { MB.zapisy.set(s, { b: blob.bytes, t: Date.now() }); MB.usuniete.delete(s); }   // niepełne podejście – bez zapisu
  return new PlikMB(s);
};

function _formatData(d, tz, f) {
  var p = new Intl.DateTimeFormat('sv-SE', { timeZone: tz || 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(d);
  var dni = ['niedz', 'pon', 'wt', 'śr', 'czw', 'pt', 'sob'];
  var m = { 'yyyy-MM-dd': p.slice(0, 10), 'yyyy-MM': p.slice(0, 7), yyyy: p.slice(0, 4), dd: p.slice(8, 10), MM: p.slice(5, 7), 'HH:mm:ss': p.slice(11, 19), 'HH:mm': p.slice(11, 16),
    H: String(+p.slice(11, 13)), HH: p.slice(11, 13), 'dd-MM-yyyy': p.slice(8, 10) + '-' + p.slice(5, 7) + '-' + p.slice(0, 4), 'yyyy-MM-dd HH:mm': p.slice(0, 16), "yyyy-MM-dd'T'HH:mm:ss": p.slice(0, 10) + 'T' + p.slice(11, 19),
    'dd.MM.yyyy': p.slice(8, 10) + '.' + p.slice(5, 7) + '.' + p.slice(0, 4), 'dd.MM.yyyy HH:mm': p.slice(8, 10) + '.' + p.slice(5, 7) + '.' + p.slice(0, 4) + ' ' + p.slice(11, 16), u: String(((d.getUTCDay() + 6) % 7) + 1) };
  if (m[f] !== undefined) return m[f];
  throw new Error('Format daty „' + f + '” nieobsługiwany w aplikacji offline');
}
function _base64(bytes) { var s = ''; for (var i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768)); return btoa(s); }
function _zBase64(b64) { var s = atob(b64), a = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
function _bajty(x) { return x instanceof Uint8Array ? x : typeof x === 'string' ? _tekstE.encode(x) : Uint8Array.from((x || []).map(function (b) { return b & 255; })); }

var Utilities = {
  formatDate: _formatData,
  getUuid: function () { return crypto.randomUUID(); },
  newBlob: function (d, typ, nazwa) { return new BlobMB(_bajty(d), typ, nazwa); },
  gzip: function (b) { return new BlobMB(fflate.gzipSync(b.bytes), 'application/x-gzip', b.nazwa); },
  ungzip: function (b) { return new BlobMB(fflate.gunzipSync(b.bytes), '', b.nazwa); },
  base64Encode: function (b) { return _base64(_bajty(b)); },
  base64Decode: function (s) { return Array.from(_zBase64(s)); },
  base64EncodeWebSafe: function (b) { return _base64(_bajty(b)).replace(/\+/g, '-').replace(/\//g, '_'); },
  sleep: function () {},
  Charset: { UTF_8: 'UTF-8' },
};
var _korzen = new FolderMB('');
var DriveApp = {
  getRootFolder: function () { return _korzen; },
  getFoldersByName: function (n) { return iterMB(n === 'Music Base – dane' ? [_korzen] : []); },
  getFolderById: function (id) { var s = String(id).replace(/^f:/, ''); if (!MB.foldery.has(s)) throw new Error('Brak folderu ' + s); return new FolderMB(s); },
};
function _magazyn(pref) {
  return {
    getProperty: function (k) { var v = MB.wlasciwosci[pref + k]; return v === undefined ? null : v; },
    setProperty: function (k, v) { MB.wlasciwosci[pref + k] = String(v); return this; },
    setProperties: function (o) { Object.keys(o).forEach(function (k) { MB.wlasciwosci[pref + k] = String(o[k]); }); return this; },
    deleteProperty: function (k) { delete MB.wlasciwosci[pref + k]; return this; },
    getProperties: function () { var w = {}; Object.keys(MB.wlasciwosci).forEach(function (k) { if (k.indexOf(pref) === 0) w[k.slice(pref.length)] = MB.wlasciwosci[k]; }); return w; },
  };
}
var PropertiesService = { getScriptProperties: function () { return _magazyn('s:'); }, getUserProperties: function () { return _magazyn('u:'); } };
var CacheService = { getScriptCache: function () { return {
  get: function (k) { var e = MB.cache.get(k); return e && e.do > Date.now() ? e.v : null; },
  put: function (k, v, s) { if (!MB.braki.size) MB.cache.set(k, { v: String(v), do: Date.now() + 1000 * (s || 600) }); },   // podejście z brakującą paczką liczy niepełny wynik – nie zapamiętujemy go
  remove: function (k) { MB.cache.delete(k); }, removeAll: function (l) { (l || []).forEach(function (k) { MB.cache.delete(k); }); },
}; } };
var Session = { getEffectiveUser: function () { return { getEmail: function () { return MB.email; } }; }, getActiveUser: function () { return { getEmail: function () { return MB.email; } }; } };
var _online = function (co) { return function () { throw new Error(co + ' działa tylko w panelu online (Apps Script).'); }; };
var ScriptApp = { getService: function () { return { getUrl: function () { return self.location.origin + '/'; } }; }, getProjectTriggers: function () { return []; },
  newTrigger: _online('Wyzwalacze'), deleteTrigger: _online('Wyzwalacze'), WeekDay: {} };
var MailApp = { sendEmail: _online('Wysyłanie e-maili') };
var Logger = { log: function () { console.log.apply(console, arguments); } };
var LockService = { getScriptLock: function () { return { waitLock: function () {}, tryLock: function () { return true; }, releaseLock: function () {}, hasLock: function () { return true; } }; } };
var HtmlService = { createHtmlOutput: _online('HtmlService'), createTemplateFromFile: _online('HtmlService'), createHtmlOutputFromFile: _online('HtmlService'), XFrameOptionsMode: {} };
/** Zapytania sieciowe synchronicznie (w wątku roboczym wolno); bez sieci albo przy blokadzie CORS – kod 0. */
function _pobierz(url, o) {
  o = o || {};
  var x = new XMLHttpRequest();
  try {
    x.open((o.method || 'get').toUpperCase(), url, false);
    Object.keys(o.headers || {}).forEach(function (h) { if (!/^user-agent$/i.test(h)) x.setRequestHeader(h, o.headers[h]); });
    if (o.contentType) x.setRequestHeader('Content-Type', o.contentType);
    x.send(o.payload || null);
  } catch (e) { return { getContentText: function () { return ''; }, getResponseCode: function () { return 0; }, getHeaders: function () { return {}; }, getAllHeaders: function () { return {}; } }; }
  return { getContentText: function () { return x.responseText; }, getResponseCode: function () { return x.status; }, getHeaders: function () { return {}; }, getAllHeaders: function () { return {}; } };
}
var UrlFetchApp = { fetch: function (u, o) { var w = _pobierz(u, o); if (!w.getResponseCode() && !(o && o.muteHttpExceptions)) throw new Error('Brak połączenia: ' + u); return w; },
  fetchAll: function (l) { return l.map(function (r) { return _pobierz(typeof r === 'string' ? r : r.url, r); }); } };

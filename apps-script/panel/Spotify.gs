/**
 * Music Base – Spotify: logowanie (Authorization Code), zapis playlist, automatyczne playlisty „Top N”.
 *
 * Konfiguracja (jednorazowo, opisana w instrukcji): aplikacja na developer.spotify.com (tryb deweloperski
 * wymaga Spotify Premium właściciela), Redirect URI = adres tego panelu (…/exec). Client ID i Client Secret
 * wpisuje się w panelu – trafiają tylko do właściwości użytkownika tego skryptu.
 * Adresy API wg migracji z lutego 2026: POST /me/playlists, POST|PUT /playlists/{id}/items, wyszukiwanie limit ≤ 10.
 */

var SP_API = 'https://api.spotify.com/v1';

function spWl_() { return PropertiesService.getUserProperties(); }
function adresPanelu_() { return ScriptApp.getService().getUrl(); }

function spotifyStan() {
  var p = spWl_();
  return { skonfigurowany: !!(p.getProperty('SPOTIFY_ID') && p.getProperty('SPOTIFY_SECRET')), polaczony: !!p.getProperty('SPOTIFY_REFRESH'), redirect: adresPanelu_() };
}

function spotifyKonfiguruj(id, secret) {
  return bezpiecznie_(function () {
    if (!/^[0-9a-f]{32}$/i.test(String(id).trim()) || !/^[0-9a-f]{32}$/i.test(String(secret).trim())) {
      return { blad: 'Client ID i Client Secret to po 32 znaki (cyfry i litery a–f). Skopiuj je z panelu aplikacji na developer.spotify.com.' };
    }
    spWl_().setProperties({ SPOTIFY_ID: String(id).trim(), SPOTIFY_SECRET: String(secret).trim() });
    return spotifyStan();
  });
}

/** Adres logowania do Spotify (otwierany w nowej karcie). */
function spotifyAdres() {
  return bezpiecznie_(function () {
    var stan = Utilities.getUuid();
    spWl_().setProperty('SPOTIFY_STATE', stan);
    return {
      url: 'https://accounts.spotify.com/authorize?' + [
        'client_id=' + encodeURIComponent(spWl_().getProperty('SPOTIFY_ID')),
        'response_type=code',
        'redirect_uri=' + encodeURIComponent(adresPanelu_()),
        'scope=' + encodeURIComponent('playlist-modify-private playlist-modify-public'),
        'state=' + stan,
      ].join('&'),
    };
  });
}

/** Powrót ze Spotify (doGet z ?code=&state=): wymiana kodu na token odświeżania. */
function spotifyPowrot_(e) {
  var p = spWl_(), komunikat;
  if (e.parameter.state !== p.getProperty('SPOTIFY_STATE')) {
    komunikat = 'Nieprawidłowy parametr state – spróbuj połączyć ponownie z panelu.';
  } else {
    var odp = UrlFetchApp.fetch('https://accounts.spotify.com/api/token', {
      method: 'post', muteHttpExceptions: true,
      headers: { Authorization: 'Basic ' + Utilities.base64Encode(p.getProperty('SPOTIFY_ID') + ':' + p.getProperty('SPOTIFY_SECRET')) },
      payload: { grant_type: 'authorization_code', code: e.parameter.code, redirect_uri: adresPanelu_() },
    });
    var j = JSON.parse(odp.getContentText() || '{}');
    if (j.refresh_token) {
      p.setProperties({ SPOTIFY_REFRESH: j.refresh_token, SPOTIFY_ACCESS: j.access_token, SPOTIFY_WAZNY: String(Date.now() + (j.expires_in - 60) * 1000) });
      p.deleteProperty('SPOTIFY_STATE');
      komunikat = 'Połączono ze Spotify. Możesz zamknąć tę kartę i wrócić do panelu.';
    } else {
      komunikat = 'Spotify odrzucił logowanie: ' + (j.error_description || j.error || odp.getResponseCode());
    }
  }
  return HtmlService.createHtmlOutput('<p style="font:16px system-ui;padding:24px">' + komunikat +
    '</p><p style="font:16px system-ui;padding:0 24px"><a href="' + adresPanelu_() + '" target="_top">Wróć do panelu</a></p>').setTitle('Music Base – Spotify');
}

function spotifyRozlacz() {
  return bezpiecznie_(function () {
    ['SPOTIFY_REFRESH', 'SPOTIFY_ACCESS', 'SPOTIFY_WAZNY'].forEach(function (k) { spWl_().deleteProperty(k); });
    return spotifyStan();
  });
}

function spToken_() {
  var p = spWl_();
  if (p.getProperty('SPOTIFY_ACCESS') && Date.now() < +p.getProperty('SPOTIFY_WAZNY')) return p.getProperty('SPOTIFY_ACCESS');
  if (!p.getProperty('SPOTIFY_REFRESH')) throw new Error('Spotify nie jest połączony – połącz w zakładce Playlisty.');
  var odp = UrlFetchApp.fetch('https://accounts.spotify.com/api/token', {
    method: 'post', muteHttpExceptions: true,
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(p.getProperty('SPOTIFY_ID') + ':' + p.getProperty('SPOTIFY_SECRET')) },
    payload: { grant_type: 'refresh_token', refresh_token: p.getProperty('SPOTIFY_REFRESH') },
  });
  var j = JSON.parse(odp.getContentText() || '{}');
  if (!j.access_token) throw new Error('Nie udało się odświeżyć dostępu do Spotify: ' + (j.error_description || j.error || odp.getResponseCode()) + '. Połącz ponownie.');
  p.setProperties({ SPOTIFY_ACCESS: j.access_token, SPOTIFY_WAZNY: String(Date.now() + (j.expires_in - 60) * 1000) });
  if (j.refresh_token) p.setProperty('SPOTIFY_REFRESH', j.refresh_token);
  return j.access_token;
}

function spApi_(metoda, sciezka, cialo) {
  for (var proba = 0; proba < 4; proba++) {
    var odp = UrlFetchApp.fetch(sciezka.indexOf('http') === 0 ? sciezka : SP_API + sciezka, {
      method: metoda, muteHttpExceptions: true, contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + spToken_() },
      payload: cialo ? JSON.stringify(cialo) : undefined,
    });
    var kod = odp.getResponseCode();
    if (kod === 429) { Utilities.sleep(1000 * Math.min(10, +(odp.getHeaders()['Retry-After'] || 2))); continue; }
    if (kod >= 200 && kod < 300) return odp.getContentText() ? JSON.parse(odp.getContentText()) : {};
    throw new Error('Spotify ' + metoda.toUpperCase() + ' ' + sciezka.split('?')[0] + ': HTTP ' + kod + ' ' + odp.getContentText().slice(0, 200));
  }
  throw new Error('Spotify: zbyt wiele zapytań, spróbuj za chwilę.');
}

// pamięć znalezionych utworów: klucz → id Spotify albo '' (nie znaleziono)
function spotifyCache_() { return _PAM.spc || (_PAM.spc = czytajGz(folderAgg_(), 'spotify_cache.json.gz') || {}); }
function zapiszSpotifyCache_() { if (_PAM.spc) zapiszGz(folderAgg_(), 'spotify_cache.json.gz', _PAM.spc); }

/** Identyfikator utworu w Spotify: Songster (metadane) → pamięć → wyszukiwanie z dopasowaniem wykonawcy i tytułu. */
function znajdzWSpotify_(k, a, t) {
  var m = metadane_()[k];
  if (m && m.sp) return m.sp;
  var c = spotifyCache_();
  if (c[k] !== undefined) return c[k] || null;
  var glowny = String(a).split(/\s+(?:\/|&|feat\.?|ft\.?|x)\s+|\//i)[0];
  var q = 'track:' + String(t).replace(/\s*[([].*?[)\]]/g, '') + ' artist:' + glowny;
  var j = spApi_('get', '/search?type=track&limit=10&market=PL&q=' + encodeURIComponent(q));
  var items = (j.tracks && j.tracks.items) || [], tk = tytulKlucz(t), wk = wykonawcyKlucz(a), wynik = null;
  items.some(function (it) {
    var art = it.artists.map(function (x) { return wykonawcaKlucz(x.name); });
    var okArt = art.some(function (x) { return wk.indexOf(x) >= 0; });
    if (okArt && tytulKlucz(it.name) === tk) { wynik = it.id; return true; }
    return false;
  });
  if (!wynik) items.some(function (it) {
    var art = it.artists.map(function (x) { return wykonawcaKlucz(x.name); });
    if (art.some(function (x) { return wk.indexOf(x) >= 0; }) && tytulKlucz(it.name).indexOf(tk) === 0) { wynik = it.id; return true; }
    return false;
  });
  c[k] = wynik || '';
  return wynik;
}

/**
 * Zapis playlisty: wiersze [{k, a, t}] w kolejności. Bez playlistId – nowa (prywatna), z playlistId – zastąpienie zawartości.
 * Zwraca adres playlisty i listę utworów, których nie znaleziono w Spotify.
 */
function spotifyZapiszPlayliste(nazwa, opis, wiersze, playlistId) {
  return bezpiecznie_(function () { return zapiszPlaylisteSpotify_(nazwa, opis, wiersze, playlistId); });
}
function zapiszPlaylisteSpotify_(nazwa, opis, wiersze, playlistId, maxMs) {
  var t0 = Date.now(), uris = [], brak = [];
  wiersze.forEach(function (w) {
    if (Date.now() - t0 > (maxMs || 240000)) { brak.push(w.a + ' – ' + w.t + ' (przerwano: limit czasu)'); return; }
    var id = znajdzWSpotify_(w.k || kluczUtworu(w.a, w.t), w.a, w.t);
    if (id) uris.push('spotify:track:' + id); else brak.push(w.a + ' – ' + w.t);
  });
  zapiszSpotifyCache_();
  var pl;
  if (playlistId) {
    pl = { id: playlistId, external_urls: { spotify: 'https://open.spotify.com/playlist/' + playlistId } };
    spApi_('put', '/playlists/' + playlistId + '/items', { uris: uris.slice(0, 100) });
  } else {
    pl = spApi_('post', '/me/playlists', { name: nazwa, description: (opis || '').slice(0, 300), public: false });
    if (uris.length) spApi_('post', '/playlists/' + pl.id + '/items', { uris: uris.slice(0, 100) });
  }
  for (var i = 100; i < uris.length; i += 100) spApi_('post', '/playlists/' + pl.id + '/items', { uris: uris.slice(i, i + 100) });
  // prywatność: Spotify bywa, że tworzy playlistę jako publiczną mimo public: false (zgłoszenia na forum Spotify i w GitHub
  // spotify/web-api #903) – ustawiamy jeszcze raz przy każdym zapisie i sprawdzamy, co zwraca API
  var publiczna = null;
  try {
    spApi_('put', '/playlists/' + pl.id, { public: false });
    publiczna = !!(spApi_('get', '/playlists/' + pl.id + '?fields=public') || {}).public;
  } catch (e) { /* bez tego playlista i tak powstała */ }
  return { id: pl.id, url: pl.external_urls.spotify, dodano: uris.length, brak: brak, publiczna: publiczna };
}

// ---------------- automatyczne playlisty ----------------

function autoPlaylisty() {
  return bezpiecznie_(function () { return { lista: JSON.parse(spWl_().getProperty('AUTO_PLAYLISTY') || '[]') }; });
}
function zapiszAutoPlaylisty(lista) {
  return bezpiecznie_(function () {
    var stare = {};
    JSON.parse(spWl_().getProperty('AUTO_PLAYLISTY') || '[]').forEach(function (x) { stare[x.id] = x; });
    var nowa = (lista || []).map(function (x) {
      return { id: x.id || Utilities.getUuid(), jednostka: x.jednostka || '', dni: Math.max(1, Math.min(365, +x.dni || 30)), n: Math.max(5, Math.min(100, +x.n || 50)),
        playlistId: x.playlistId || (stare[x.id] && stare[x.id].playlistId) || null, odswiezona: (stare[x.id] && stare[x.id].odswiezona) || null };
    });
    spWl_().setProperty('AUTO_PLAYLISTY', JSON.stringify(nowa));
    return { lista: nowa };
  });
}

/**
 * Wyzwalacz codzienny (ok. 6:00): odświeża każdą automatyczną playlistę „Top N z D dni”.
 * Jedno uruchomienie Apps Script trwa najwyżej 6 min, a nowa playlista to do 100 wyszukiwań w Spotify – przy kilku
 * playlistach nie mieściło się (13.11.2026 nie powstały wszystkie). Teraz: najdłużej nieodświeżane najpierw, budżet
 * ok. 4,5 min, postęp zapisywany po każdej playliście, reszta w kolejnym uruchomieniu za minutę (jednorazowy wyzwalacz).
 */
function odswiezAutoPlaylisty() {
  var t0 = Date.now(), BUDZET = 270000;
  var lista = JSON.parse(spWl_().getProperty('AUTO_PLAYLISTY') || '[]');
  var wczoraj = Utilities.formatDate(new Date(Date.now() - 864e5), 'Europe/Warsaw', 'yyyy-MM-dd');
  var kolejka = lista.filter(function (x) { return x.odswiezona !== wczoraj; })
    .sort(function (a, b) { return String(a.odswiezona || '') < String(b.odswiezona || '') ? -1 : 1; });
  var zostalo = false;
  kolejka.forEach(function (x) {
    if (zostalo) return;
    var reszta = BUDZET - (Date.now() - t0);
    if (reszta < 60000) { zostalo = true; return; }
    try {
      var od = Utilities.formatDate(new Date(Date.now() - x.dni * 864e5), 'Europe/Warsaw', 'yyyy-MM-dd');
      // wszystkie stacje: 7, 30, 90 i 365 dni z gotowego zestawienia Odbiornika (okres do ostatniego dnia z danymi);
      // inne okresy liczą się na żywo (do 35 dni – dłuższe nie mieszczą się w limicie Apps Script)
      var preset = !x.jednostka && PRESETY_RANKINGU_[String(x.dni)] && String(x.dni) !== 'rok' ? String(x.dni) : null;
      var r = ranking({ jednostki: x.jednostka ? [x.jednostka] : [], od: od, do: wczoraj, preset: preset, typ: 'utwory', limit: x.n });
      if (r.blad) throw new Error(r.blad);
      var nazwa = nazwaJednostki_(x.jednostka || '_wszystkie') + ' – Top ' + x.n + ' z ' + x.dni + ' dni';
      var wynik = zapiszPlaylisteSpotify_(nazwa, 'Music Base: najczęściej grane ' + (r.od || od) + ' – ' + (r.do || wczoraj) + '. Odświeżana codziennie.', r.pozycje, x.playlistId, reszta - 40000);
      x.playlistId = wynik.id;
      x.url = wynik.url;
      x.publiczna = wynik.publiczna;
      x.brakow = wynik.brak.length;
      // przerwane wyszukiwanie (limit czasu) – dokończymy w następnym uruchomieniu; wyniki wyszukiwań są już w pamięci
      if (wynik.brak.some(function (b) { return b.indexOf('(przerwano') >= 0; })) zostalo = true;
      else x.odswiezona = wczoraj;
      x.blad = null;
    } catch (e) {
      x.blad = String(e.message || e);
    }
    // zapis po każdej playliście (lista mogła się zmienić w panelu – podmieniamy tylko ten wpis)
    var teraz = JSON.parse(spWl_().getProperty('AUTO_PLAYLISTY') || '[]').map(function (y) { return y.id === x.id ? x : y; });
    spWl_().setProperty('AUTO_PLAYLISTY', JSON.stringify(teraz));
  });
  ScriptApp.getProjectTriggers().forEach(function (w) { if (w.getHandlerFunction() === 'odswiezAutoPlaylistyDalej') ScriptApp.deleteTrigger(w); });
  if (zostalo) ScriptApp.newTrigger('odswiezAutoPlaylistyDalej').timeBased().after(60000).create();
}
/** Jednorazowa kontynuacja odświeżania (wyzwalacz tworzony przez odswiezAutoPlaylisty). */
function odswiezAutoPlaylistyDalej() { odswiezAutoPlaylisty(); }

/** Ręcznie z panelu: ustaw wszystkie automatyczne playlisty jako prywatne (public: false) i sprawdź stan. */
function spotifyPrywatne() {
  return bezpiecznie_(function () {
    var lista = JSON.parse(spWl_().getProperty('AUTO_PLAYLISTY') || '[]'), wynik = [];
    lista.forEach(function (x) {
      if (!x.playlistId) return;
      try {
        spApi_('put', '/playlists/' + x.playlistId, { public: false });
        x.publiczna = !!(spApi_('get', '/playlists/' + x.playlistId + '?fields=public') || {}).public;
      } catch (e) { x.blad = String(e.message || e); }
      wynik.push({ id: x.id, publiczna: x.publiczna });
    });
    spWl_().setProperty('AUTO_PLAYLISTY', JSON.stringify(lista));
    return { lista: lista, publicznych: wynik.filter(function (x) { return x.publiczna; }).length };
  });
}

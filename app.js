/*
 * Die 100 besten Serien – Frontend
 * Reines JavaScript ohne Framework und ohne Build-Schritt.
 *
 * Woher die Daten kommen:
 *   • data/data.json – alle Serien samt Streaming-Angeboten und Wertungen,
 *     erzeugt vom GitHub-Workflow (die API-Schlüssel kennt nur der Workflow).
 *   • Poster und Logos lädt der Browser von image.tmdb.org.
 *   • „Serie hinzufügen“ sucht bei TVmaze (api.tvmaze.com, ohne Schlüssel).
 *   • Die eigene Liste steht in data/eigene.json im GitHub-Repository. Die
 *     Website ändert sie über die GitHub-API mit einem Schlüssel, den du einmal
 *     pro Gerät einträgst. Danach holt der Workflow die Daten der neuen Serie.
 * Die Markierungen „Gesehen“ und „Uninteressant“ liegen nur im localStorage
 * dieses Browsers.
 */
(() => {
  'use strict';

  const DATEN_URL = 'data/data.json';
  const EIGENE_PFAD = 'data/eigene.json';
  const BILD_URL = 'https://image.tmdb.org/t/p/';
  const TVMAZE_URL = 'https://api.tvmaze.com';
  const GITHUB_API = 'https://api.github.com';

  const SPEICHER = {
    markierungen: 'serien-top100:markierungen',
    gesehenAlt: 'serien-top100:gesehen', // altes Format: nur Plätze der Top 100
    offen: 'serien-top100:eigene-offen',
    github: 'serien-top100:github',
    tab: 'serien-top100:tab',
  };

  const STATUS = ['gesehen', 'uninteressant'];
  const WARTEN_LANG_MS = 8 * 60_000; // ab dann „dauert länger als gedacht“
  const OFFEN_MAX_MS = 24 * 3_600_000; // nicht bestätigte Änderungen spätestens nach einem Tag vergessen
  const NACHLADEN_MS = 20_000;
  const NACHLADEN_MAX_MS = 15 * 60_000;
  const HINWEIS_DATEI =
    'Deine eigenen Serien für den Tab „Eigene Serien“, die neueste steht oben. Die Website trägt Serien hier selbst ein, wenn du sie hinzufügst. ' +
    'Von Hand geht es auch, z. B. { "tmdb_id": 1398, "titel": "Die Sopranos" } – die Zahl stammt aus der TMDB-Adresse (themoviedb.org/tv/1398-the-sopranos). ' +
    'Findet der Workflow eine Serie nicht, ergänze beim Eintrag "tmdb_id".';

  const ZAHL = new Intl.NumberFormat('de-DE');
  const EINE_STELLE = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const DATUM = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Berlin' });
  const DATUM_ZEIT = new Intl.DateTimeFormat('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Berlin',
  });
  let LAENDER = null;
  try {
    LAENDER = new Intl.DisplayNames(['de'], { type: 'region' });
  } catch {
    LAENDER = null;
  }

  const zustand = {
    daten: null,
    repo: null, // „besitzer/repo“ – dort liegt data/eigene.json
    top: [], // Einträge der Top 100
    topNachPlatz: new Map(),
    topNachSchluessel: new Map(),
    eigeneBasis: [], // eigene Serien laut data.json
    eigene: [], // Einträge des Tabs „Eigene Serien“ (Basis plus offene Änderungen)
    eigeneTop: new Set(), // Schlüssel der Top-100-Serien, die auch in „Eigene Serien“ stehen
    offen: [], // Änderungen, die data.json noch nicht enthält: { art: 'hinzu' | 'weg', schluessel, … }
    status: new Map(), // Schlüssel → 'gesehen' | 'uninteressant'
    tab: 'top',
    filter: { offen: true, gesehen: true, uninteressant: true },
    dienste: null, // Filter nach Streamingdienst: null = alle, sonst Set der markierten Dienste
    suche: '',
  };

  const $ = (selektor) => document.querySelector(selektor);

  // ---------------------------------------------------------------------------
  // Hilfsfunktionen
  // ---------------------------------------------------------------------------

  /** Für Suche und Vergleiche: ohne Akzente, Satzzeichen und Groß-/Kleinschreibung. */
  function normal(text) {
    return String(text ?? '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/ß/g, 'ss')
      .replace(/&/g, 'and')
      .replace(/[^a-z0-9]+/g, '');
  }

  /** Baut ein Element. Texte werden immer als Text eingefügt, nie als HTML. */
  function el(tag, attribute = {}, ...kinder) {
    const knoten = document.createElement(tag);
    for (const [name, wert] of Object.entries(attribute)) {
      if (wert === null || wert === undefined || wert === false) continue;
      if (name === 'class') knoten.className = wert;
      else knoten.setAttribute(name, wert === true ? '' : String(wert));
    }
    for (const kind of kinder.flat(Infinity)) {
      if (kind === null || kind === undefined || kind === false) continue;
      knoten.append(kind instanceof Node ? kind : String(kind));
    }
    return knoten;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SYMBOLE = {
    gesehen: [
      ['', 'M5.5 3.5h13a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2z'],
      ['haken', 'M7.8 12.4l2.9 2.9 5.6-6'],
    ],
    uninteressant: [
      ['', 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z'],
      ['', 'M6 18L18 6'],
    ],
    merken: [['', 'M6.6 3.5h10.8a1.1 1.1 0 0 1 1.1 1.1v16l-6.5-4.3-6.5 4.3v-16a1.1 1.1 0 0 1 1.1-1.1z']],
  };

  /** Inline-SVG-Symbol (dekorativ, für Screenreader unsichtbar). */
  function symbol(name, groesse = 20) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(groesse));
    svg.setAttribute('height', String(groesse));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('class', `symbol symbol-${name}`);
    for (const [klasse, d] of SYMBOLE[name]) {
      const pfad = document.createElementNS(SVG_NS, 'path');
      pfad.setAttribute('d', d);
      if (klasse) pfad.setAttribute('class', klasse);
      svg.append(pfad);
    }
    return svg;
  }

  const zahlText = (n) => (Number.isFinite(n) ? ZAHL.format(n) : '–');
  const istSicherUrl = (url) => typeof url === 'string' && /^https:\/\//.test(url);
  const heuteIso = () => new Date().toISOString().slice(0, 10);
  const positiv = (n) => Number.isInteger(n) && n > 0;
  const gueltigeImdbId = (id) => (typeof id === 'string' && /^tt\d{5,}$/.test(id) ? id : null);
  const serienWort = (n) => (n === 1 ? 'Serie' : 'Serien');

  function jahreText(jahre) {
    return String(jahre ?? '')
      .replace(/\s*-\s*/g, '–')
      .replace(/present/i, 'heute');
  }

  function standText(iso) {
    if (!iso) return 'noch keine Daten abgerufen';
    const datum = new Date(iso);
    return Number.isNaN(datum.getTime()) ? '–' : `${DATUM_ZEIT.format(datum)} Uhr`;
  }

  function heuteBeginn() {
    const jetzt = new Date();
    return new Date(Date.UTC(jetzt.getUTCFullYear(), jetzt.getUTCMonth(), jetzt.getUTCDate(), 0, 0, 0));
  }

  function lese(schluessel) {
    try {
      const roh = localStorage.getItem(schluessel);
      return roh ? JSON.parse(roh) : null;
    } catch {
      return null;
    }
  }

  function schreibe(schluessel, wert) {
    try {
      if (wert === null) localStorage.removeItem(schluessel);
      else localStorage.setItem(schluessel, JSON.stringify(wert));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fester Schlüssel eines eigenen Eintrags – genau wie in scripts/update.mjs.
   * Die TVmaze-Nummer hat Vorrang, damit sich der Schlüssel nicht ändert, wenn
   * später eine tmdb_id ergänzt wird.
   */
  function eigenerSchluessel(e) {
    if (positiv(e?.tvmaze)) return `tvmaze:${e.tvmaze}`;
    if (positiv(e?.tmdb_id)) return `tmdb:${e.tmdb_id}`;
    if (gueltigeImdbId(e?.imdb)) return `imdb:${e.imdb}`;
    if (positiv(e?.tvdb)) return `tvdb:${e.tvdb}`;
    return null;
  }

  const topSchluessel = (s) => s.schluessel || (Number.isInteger(s.tmdbId) ? `tmdb:${s.tmdbId}` : `platz:${s.platz}`);

  // ---------------------------------------------------------------------------
  // Meldungen
  // ---------------------------------------------------------------------------

  let meldungTimer = 0;

  function verbergeMeldung() {
    clearTimeout(meldungTimer);
    $('#meldung').hidden = true;
  }

  /**
   * Kurze Meldung unten am Rand, optional mit Knopf (z. B. „Rückgängig“).
   * Ist gerade ein Dialog mit eigener Meldezeile offen, erscheint sie dort.
   */
  function meldung(text, { aktion = null } = {}) {
    const dialog = [...document.querySelectorAll('dialog[open]')].pop();
    const zeile = dialog?.querySelector('.dialog-meldung');
    if (zeile) {
      zeile.textContent = text;
      return;
    }
    $('#meldung-text').textContent = text;
    const knopf = $('#meldung-aktion');
    knopf.hidden = !aktion;
    knopf.onclick = null;
    if (aktion) {
      knopf.textContent = aktion.text;
      knopf.onclick = () => {
        verbergeMeldung();
        aktion.beiKlick();
      };
    }
    $('#meldung').hidden = false;
    clearTimeout(meldungTimer);
    meldungTimer = setTimeout(verbergeMeldung, aktion ? 7000 : 4500);
  }

  // ---------------------------------------------------------------------------
  // Markierungen „Gesehen“ und „Uninteressant“ (localStorage)
  // ---------------------------------------------------------------------------

  const GUELTIGER_SCHLUESSEL = /^(?:tmdb|tvmaze|tvdb|platz):\d+$|^imdb:tt\d+$/;

  function ladeStatus() {
    const daten = lese(SPEICHER.markierungen);
    const status = new Map();
    const eintraege = daten && typeof daten.status === 'object' && daten.status ? Object.entries(daten.status) : [];
    for (const [schluessel, art] of eintraege) {
      if (GUELTIGER_SCHLUESSEL.test(schluessel) && STATUS.includes(art)) status.set(schluessel, art);
    }
    return status;
  }

  function speichereStatus() {
    const status = Object.fromEntries([...zustand.status].sort(([a], [b]) => a.localeCompare(b)));
    if (!schreibe(SPEICHER.markierungen, { version: 2, status })) {
      meldung('Speichern nicht möglich. Im privaten Modus oder bei blockiertem Speicher geht der Stand beim Schließen verloren.');
    }
  }

  /** Übernimmt einmalig den Gesehen-Stand aus dem alten Format (Plätze der Top 100). */
  function uebernimmAltenStand() {
    let schonNeu = false;
    try {
      schonNeu = localStorage.getItem(SPEICHER.markierungen) !== null;
    } catch {
      return;
    }
    if (schonNeu) return;
    const alt = lese(SPEICHER.gesehenAlt);
    const plaetze = Array.isArray(alt) ? alt : alt?.gesehen;
    if (!Array.isArray(plaetze) || plaetze.length === 0) return;
    for (const platz of plaetze) {
      const e = zustand.topNachPlatz.get(Number(platz));
      if (e) zustand.status.set(e.schluessel, 'gesehen');
    }
    speichereStatus();
  }

  const statusVon = (schluessel) => zustand.status.get(schluessel) || null;

  function setzeStatus(schluessel, art) {
    const vorher = statusVon(schluessel);
    if (vorher === art) zustand.status.delete(schluessel);
    else zustand.status.set(schluessel, art);
    zeigeStatus(schluessel);
    // Eine bestehende Markierung entfernt oder ersetzt (z. B. „Uninteressant“ statt „Gesehen“)?
    // Dann mit „Rückgängig“ melden – sonst geht ein Gesehen-Haken leicht aus Versehen verloren.
    if (vorher) {
      const jetzt = statusVon(schluessel);
      const titel = titelZu(schluessel) || 'Die Serie';
      meldung(jetzt ? `„${titel}“ ist jetzt ${jetzt} statt ${vorher}.` : `„${titel}“ ist nicht mehr als ${vorher} markiert.`, {
        aktion: {
          text: 'Rückgängig',
          beiKlick: () => {
            zustand.status.set(schluessel, vorher);
            zeigeStatus(schluessel);
          },
        },
      });
    }
  }

  /** Speichern und alle Karten der Serie, Fortschritt und Filter anpassen. */
  function zeigeStatus(schluessel) {
    speichereStatus();
    for (const karte of kartenZu(schluessel)) aktualisiereKarte(karte);
    aktualisiereFortschritt();
    if (!zustand.filter.offen || !zustand.filter.gesehen || !zustand.filter.uninteressant) wendeFilterAn();
  }

  function kartenZu(schluessel) {
    return document.querySelectorAll(`.karte[data-schluessel="${CSS.escape(schluessel)}"]`);
  }

  // ---------------------------------------------------------------------------
  // Karten
  // ---------------------------------------------------------------------------

  function anzeigeTitel(e) {
    if (e.serie) return e.serie.titelDe || e.serie.titel || e.titel || '–';
    return e.titel || '–';
  }

  function poster(e, index) {
    const s = e.serie;
    const titel = anzeigeTitel(e);
    const pfad = s?.poster;
    if (pfad) {
      return el('img', {
        class: 'poster',
        src: `${BILD_URL}w185${pfad}`,
        srcset: `${BILD_URL}w185${pfad} 185w, ${BILD_URL}w342${pfad} 342w`,
        sizes: '(min-width: 760px) 104px, 92px',
        width: 185,
        height: 278,
        loading: index < 3 ? 'eager' : 'lazy',
        decoding: 'async',
        alt: `Poster von ${titel}`,
      });
    }
    if (e.art === 'wartet' && istSicherUrl(e.bild)) {
      return el('img', { class: 'poster', src: e.bild, width: 210, height: 295, loading: 'lazy', decoding: 'async', alt: `Poster von ${titel}` });
    }
    return el('div', { class: 'poster poster-leer' }, e.art === 'wartet' ? 'Poster folgt' : 'Kein Poster');
  }

  function fakten(s) {
    const liste = el('dl', { class: 'fakten' });
    const paar = (begriff, wert, klasse) => liste.append(el('div', {}, el('dt', {}, begriff), el('dd', { class: klasse }, wert)));
    const statusKlasse = s.status === 'laufend' ? 'status-laufend' : null;
    if (s.staffel !== null && s.staffel !== undefined) {
      paar('Staffel', String(s.staffel));
      paar('Folgen', zahlText(s.folgen));
      paar('Serie', s.status || '–', statusKlasse);
    } else {
      paar('Staffeln', zahlText(s.staffeln));
      paar('Folgen', zahlText(s.folgen));
      paar('Status', s.status || '–', statusKlasse);
      if (s.status === 'laufend' && s.naechsteFolge) {
        const datum = new Date(`${s.naechsteFolge}T12:00:00Z`);
        if (!Number.isNaN(datum.getTime()) && datum >= heuteBeginn()) paar('Neue Folge', DATUM.format(datum));
      }
    }
    return liste;
  }

  function wertungen(s) {
    const imdbTitel = Number.isFinite(s.imdbStimmen) ? `IMDb-Wertung aus ${ZAHL.format(s.imdbStimmen)} Stimmen` : 'IMDb-Wertung';
    return el(
      'dl',
      { class: 'fakten wertungen' },
      el('div', { title: imdbTitel }, el('dt', {}, 'IMDb'), el('dd', {}, Number.isFinite(s.imdb) ? EINE_STELLE.format(s.imdb) : '–')),
      el(
        'div',
        { title: 'Rotten Tomatoes, Tomatometer: Anteil positiver Kritiken' },
        el('dt', {}, 'Rotten Tomatoes'),
        el('dd', {}, Number.isFinite(s.rt) ? `${s.rt} %` : '–'),
      ),
    );
  }

  function beschreibung(s) {
    const absatz = el('p', { class: 'beschreibung' });
    if (!s.beschreibung) {
      absatz.append('Keine Beschreibung vorhanden.');
      return absatz;
    }
    const kurz = s.kurz || s.beschreibung;
    const text = el('span', {}, kurz);
    if (s.beschreibungSprache === 'en') {
      absatz.append(el('span', { class: 'sprache', title: 'Keine deutsche Beschreibung vorhanden', lang: 'de' }, 'EN'));
      text.setAttribute('lang', 'en');
    }
    absatz.append(text);
    if (kurz !== s.beschreibung) {
      const knopf = el('button', { type: 'button', class: 'mehr', 'aria-expanded': 'false' }, 'mehr');
      knopf.addEventListener('click', () => {
        const offen = knopf.getAttribute('aria-expanded') === 'true';
        text.textContent = offen ? kurz : s.beschreibung;
        knopf.textContent = offen ? 'mehr' : 'weniger';
        knopf.setAttribute('aria-expanded', String(!offen));
      });
      absatz.append(' ', knopf);
    }
    return absatz;
  }

  function anbieterGruppe(ueberschrift, liste) {
    const gruppe = el('div', { class: 'gruppe' }, el('h3', {}, ueberschrift));
    if (!Array.isArray(liste) || liste.length === 0) {
      gruppe.append(el('p', { class: 'leer' }, '–'));
      return gruppe;
    }
    gruppe.append(
      el(
        'ul',
        { class: 'logos' },
        liste.map((p) => {
          const name = String(p.name || 'Unbekannter Dienst');
          const zusatz = [];
          if (p.art && p.art !== 'Abo') zusatz.push(p.art);
          if (Array.isArray(p.kanaele) && p.kanaele.length) {
            zusatz.push(`${p.direkt === false ? 'als' : 'auch als'} ${p.kanaele.join(' oder ')}`);
          }
          const beschriftung = zusatz.length ? `${name} (${zusatz.join(', ')})` : name;
          return el(
            'li',
            { title: beschriftung },
            p.logo
              ? el('img', { src: `${BILD_URL}w92${p.logo}`, width: 36, height: 36, loading: 'lazy', decoding: 'async', alt: beschriftung })
              : el('span', { class: 'logo-text' }, name),
          );
        }),
      ),
    );
    return gruppe;
  }

  function streaming(s) {
    const tmdbUrl = Number.isInteger(s.tmdbId)
      ? `https://www.themoviedb.org/tv/${s.tmdbId}${Number.isInteger(s.staffel) ? `/season/${s.staffel}` : ''}`
      : null;
    const imdbUrl = gueltigeImdbId(s.imdbId) ? `https://www.imdb.com/title/${s.imdbId}/` : null;
    return el(
      'div',
      { class: 'streaming' },
      anbieterGruppe('Abo oder kostenlos', s.abo),
      anbieterGruppe('Leihen oder kaufen', s.kaufen),
      el(
        'p',
        { class: 'quelle' },
        el('span', {}, 'Daten von JustWatch'),
        istSicherUrl(s.streamingLink) ? el('a', { href: s.streamingLink, target: '_blank', rel: 'noopener' }, 'Alle Angebote ansehen') : null,
        tmdbUrl ? el('a', { href: tmdbUrl, target: '_blank', rel: 'noopener' }, 'TMDB') : null,
        imdbUrl ? el('a', { href: imdbUrl, target: '_blank', rel: 'noopener' }, 'IMDb') : null,
      ),
    );
  }

  function kartenHinweis(e) {
    if (e.art === 'top') return el('p', { class: 'karte-hinweis' }, `Platz ${e.platz} der Top 100`);
    if (e.art === 'wartet') return el('p', { class: 'karte-hinweis' }, 'Wird hinzugefügt');
    if (e.art === 'fehlt') return el('p', { class: 'karte-hinweis hinweis-grau' }, 'Keine Daten gefunden');
    return el('p', { class: 'karte-hinweis hinweis-grau' }, 'Eigene Serie');
  }

  function warteText(e) {
    const lange = Date.now() - (e.seit || Date.now()) > WARTEN_LANG_MS;
    const box = el('div', { class: 'warten' });
    box.append(el('p', { class: 'warten-titel' }, el('span', { class: 'punkte', 'aria-hidden': 'true' }, el('span'), el('span'), el('span')), 'Daten werden geholt'));
    if (lange && zustand.repo) {
      box.append(
        el(
          'p',
          {},
          'Das dauert länger als gedacht. Unter ',
          el('a', { href: `https://github.com/${zustand.repo}/actions`, target: '_blank', rel: 'noopener' }, 'Actions'),
          ' im Repository siehst du, ob der letzte Lauf geklappt hat.',
        ),
      );
    } else {
      box.append(el('p', {}, 'Beschreibung, Wertungen und Streaming-Angebote erscheinen in 1 bis 2 Minuten.'));
    }
    return box;
  }

  function fehltText(e) {
    const text = Number.isInteger(e.serie?.tmdbId)
      ? 'TMDB liefert zu dieser Serie gerade keine Daten. Beim nächsten Lauf versucht es der Workflow erneut.'
      : 'Bei TMDB nicht gefunden. Du kannst die Serie entfernen oder in data/eigene.json beim Eintrag die passende „tmdb_id“ ergänzen.';
    return el('p', { class: 'warten' }, text);
  }

  function markierKnopf(art, beschriftung, karte) {
    const knopf = el('button', { type: 'button', class: `schalter schalter-${art}`, 'data-status': art, 'aria-pressed': 'false' }, symbol(art), beschriftung);
    knopf.addEventListener('click', () => setzeStatus(karte.dataset.schluessel, art));
    return knopf;
  }

  /**
   * Eine Karte. e = { schluessel, serie, platz, art, eigenerSchluessel, titel, bild, … }
   * art: 'top' (Serie der Top 100), 'eigen', 'wartet' (Daten folgen), 'fehlt' (keine TMDB-Daten)
   */
  function baueKarte(e, index, imTab) {
    const s = e.serie;
    const mitDaten = Boolean(s) && (e.art === 'top' || e.art === 'eigen');
    const karte = el('li', { class: 'karte', 'data-schluessel': e.schluessel, id: imTab === 'top' ? `platz-${e.platz}` : null });
    karte._eintrag = e;

    const merken = el('button', { type: 'button', class: 'merken', 'aria-pressed': 'false' }, symbol('merken', 22));
    merken.addEventListener('click', () => umschaltenEigene(karte._eintrag));

    const titel = s?.titelDe ? [s.titelDe, ' ', el('span', { class: 'titel-liste' }, `(${s.titel})`)] : anzeigeTitel(e);
    const jahre = s?.jahre ? jahreText(s.jahre) : e.info || null;

    const teile = [
      merken,
      el(
        'div',
        { class: 'karte-kopf' },
        poster(e, index),
        el(
          'div',
          { class: 'karte-text' },
          imTab === 'top' ? el('span', { class: 'platz' }, el('span', { class: 'sr-only' }, 'Platz '), String(e.platz)) : kartenHinweis(e),
          el('h2', { class: 'titel' }, titel),
          jahre ? el('p', { class: 'jahre' }, jahre) : null,
          mitDaten ? fakten(s) : null,
          mitDaten ? wertungen(s) : null,
          e.art === 'wartet' ? warteText(e) : null,
          e.art === 'fehlt' ? fehltText(e) : null,
        ),
      ),
      el(
        'div',
        { class: 'markieren', role: 'group', 'aria-label': `${anzeigeTitel(e)} markieren` },
        markierKnopf('gesehen', 'Gesehen', karte),
        markierKnopf('uninteressant', 'Uninteressant', karte),
      ),
      mitDaten ? beschreibung(s) : null,
      mitDaten ? streaming(s) : null,
    ];
    karte.append(...teile.filter(Boolean)); // append(null) würde „null“ als Text einfügen
    karte.classList.toggle('ist-wartend', e.art === 'wartet');
    aktualisiereKarte(karte);
    return karte;
  }

  /** Farbe, Markier-Knöpfe und Lesezeichen an den aktuellen Stand anpassen. */
  function aktualisiereKarte(karte) {
    const st = statusVon(karte.dataset.schluessel);
    karte.classList.toggle('ist-gesehen', st === 'gesehen');
    karte.classList.toggle('ist-uninteressant', st === 'uninteressant');
    for (const knopf of karte.querySelectorAll('.schalter')) knopf.setAttribute('aria-pressed', String(knopf.dataset.status === st));
    const e = karte._eintrag;
    const drin = istInEigenen(e);
    const merken = karte.querySelector('.merken');
    merken.setAttribute('aria-pressed', String(drin));
    const label = drin ? `${anzeigeTitel(e)} aus „Eigene Serien“ entfernen` : `${anzeigeTitel(e)} zu „Eigene Serien“ hinzufügen`;
    merken.setAttribute('aria-label', label);
    merken.title = drin ? 'Aus „Eigene Serien“ entfernen' : 'Zu „Eigene Serien“ hinzufügen';
  }

  function rendereTop() {
    const fragment = document.createDocumentFragment();
    zustand.top.forEach((e, index) => {
      e._karte = baueKarte(e, index, 'top');
      fragment.append(e._karte);
    });
    $('#liste-top').replaceChildren(fragment);
  }

  function rendereEigene() {
    berechneEigene();
    const fragment = document.createDocumentFragment();
    zustand.eigene.forEach((e, index) => {
      e._karte = baueKarte(e, index, 'eigene');
      fragment.append(e._karte);
    });
    $('#liste-eigene').replaceChildren(fragment);
    for (const e of zustand.top) if (e._karte) aktualisiereKarte(e._karte);
    $('#anzahl-eigene').textContent = String(zustand.eigene.length);
    if (zustand.tab === 'eigene') {
      baueDienstFilter();
      aktualisiereFortschritt();
      wendeFilterAn();
    }
  }

  // ---------------------------------------------------------------------------
  // Eigene Serien: Liste aus data.json plus noch offene Änderungen
  // ---------------------------------------------------------------------------

  function ladeOffen() {
    const liste = lese(SPEICHER.offen);
    if (!Array.isArray(liste)) return [];
    return liste.filter((o) => o && ['hinzu', 'weg'].includes(o.art) && typeof o.schluessel === 'string' && Number.isFinite(o.zeit));
  }

  function speichereOffen() {
    schreibe(SPEICHER.offen, zustand.offen.length ? zustand.offen : null);
  }

  /** Pro Serie gilt nur die letzte Änderung: Hinzufügen und Entfernen heben sich auf. */
  function setzeOffen(op) {
    zustand.offen = zustand.offen.filter((o) => o.schluessel !== op.schluessel).concat(op);
    speichereOffen();
  }

  function entferneOffen(schluessel) {
    zustand.offen = zustand.offen.filter((o) => o.schluessel !== schluessel);
    speichereOffen();
  }

  /** Vergisst Änderungen, die data.json inzwischen enthält (oder die zu alt sind). */
  function bereinigeOffen() {
    const basis = new Set(zustand.eigeneBasis.map((e) => e.schluessel));
    const jetzt = Date.now();
    const vorher = zustand.offen.length;
    zustand.offen = zustand.offen.filter((o) => {
      if (jetzt - o.zeit > OFFEN_MAX_MS) return false;
      return o.art === 'hinzu' ? !basis.has(o.schluessel) : basis.has(o.schluessel);
    });
    if (zustand.offen.length !== vorher) speichereOffen();
  }

  /**
   * Top-100-Serie, auf die ein Eintrag von data/eigene.json zeigt: gleiche TMDB-ID
   * und gleiche Staffel (ohne „staffel“ nur ganze Serien) – wie in scripts/update.mjs.
   */
  function topFuer(eintrag) {
    if (!positiv(eintrag?.tmdb_id)) return null;
    const staffel = Number.isInteger(eintrag.staffel) ? eintrag.staffel : null;
    return zustand.top.find((e) => e.serie.tmdbId === eintrag.tmdb_id && (e.serie.staffel ?? null) === staffel) || null;
  }

  /** So steht eine Serie der Top 100 in data/eigene.json. */
  const topAlsEintrag = (s) => ({ tmdb_id: s.tmdbId, staffel: Number.isInteger(s.staffel) ? s.staffel : null, titel: s.titel });

  function topEintragAnsicht(top, eigener, seit = null) {
    return { ...top, art: 'top', eigenerSchluessel: eigener, seit, _karte: null };
  }

  function berechneEigene() {
    const nachSchluessel = new Map(zustand.eigeneBasis.map((e) => [e.schluessel, e]));
    let reihenfolge = zustand.eigeneBasis.map((e) => e.schluessel);
    const offenNach = new Map(zustand.offen.map((o) => [o.schluessel, o]));
    for (const o of zustand.offen) {
      if (o.art === 'hinzu' && !reihenfolge.includes(o.schluessel)) {
        const stelle = Number.isInteger(o.position) ? Math.min(Math.max(o.position, 0), reihenfolge.length) : 0;
        reihenfolge.splice(stelle, 0, o.schluessel);
      } else if (o.art === 'weg') {
        reihenfolge = reihenfolge.filter((k) => k !== o.schluessel);
      }
    }

    const liste = [];
    for (const schluessel of reihenfolge) {
      const basis = nachSchluessel.get(schluessel);
      const op = offenNach.get(schluessel);
      if (basis?.top !== undefined && basis?.top !== null) {
        const top = zustand.topNachPlatz.get(basis.top);
        // Gibt es den Platz nicht mehr (Liste geändert), bleibt die Karte zum Entfernen sichtbar.
        liste.push(
          top
            ? topEintragAnsicht(top, schluessel)
            : { schluessel, serie: null, platz: null, art: 'fehlt', eigenerSchluessel: schluessel, titel: schluessel, _suchtext: '' },
        );
        continue;
      }
      if (basis && !basis.top) {
        const hatDaten = Boolean(basis.poster || basis.beschreibung || basis.status || basis.staffeln);
        const art = Number.isInteger(basis.tmdbId) && (hatDaten || !(basis.hinweise || []).length) ? 'eigen' : 'fehlt';
        liste.push({
          schluessel,
          serie: basis,
          platz: null,
          art,
          eigenerSchluessel: schluessel,
          _suchtext: normal([basis.titel, basis.titelDe].filter(Boolean).join(' ')),
        });
        continue;
      }
      if (op?.art === 'hinzu') {
        const top = topFuer(op.eintrag);
        if (top) {
          liste.push(topEintragAnsicht(top, schluessel, op.zeit));
          continue;
        }
        liste.push({
          schluessel,
          serie: null,
          platz: null,
          art: 'wartet',
          eigenerSchluessel: schluessel,
          titel: op.titel || op.eintrag?.titel || schluessel,
          info: op.info || null,
          bild: op.bild || null,
          seit: op.zeit,
          _suchtext: normal(op.titel || op.eintrag?.titel || ''),
        });
      }
    }
    // Dieselbe Serie nur einmal zeigen (z. B. über TVmaze und über die Top 100 eingetragen)
    const gesehen = new Set();
    zustand.eigene = liste.filter((e) => (gesehen.has(e.schluessel) ? false : gesehen.add(e.schluessel)));
    zustand.eigeneTop = new Set(zustand.eigene.filter((e) => e.art === 'top').map((e) => e.schluessel));
  }

  function istInEigenen(e) {
    if (!e) return false;
    if (e.eigenerSchluessel) return true;
    return zustand.eigeneTop.has(e.schluessel);
  }

  /** Lesezeichen auf einer Karte: in „Eigene Serien“ aufnehmen oder entfernen. */
  function umschaltenEigene(e) {
    if (e.eigenerSchluessel) {
      entferne(e.eigenerSchluessel);
      return;
    }
    const drin = zustand.eigene.find((x) => x.art === 'top' && x.schluessel === e.schluessel);
    if (drin) {
      entferne(drin.eigenerSchluessel);
      return;
    }
    if (!positiv(e.serie?.tmdbId)) {
      meldung('Diese Serie hat keine TMDB-ID und kann deshalb nicht übernommen werden.');
      return;
    }
    mitGithub(() => fuegeHinzu(topAlsEintrag(e.serie), { titel: anzeigeTitel(e) }));
  }

  // ---------------------------------------------------------------------------
  // Speichern in data/eigene.json über die GitHub-API
  // ---------------------------------------------------------------------------

  class GithubFehler extends Error {
    constructor(art, nachricht) {
      super(nachricht);
      this.art = art; // token | rechte | limit | netz | datei | server
    }
  }

  function ladeVerbindung() {
    const daten = lese(SPEICHER.github);
    return daten && typeof daten.token === 'string' && daten.token ? daten : null;
  }

  async function github(pfad, { method = 'GET', body, token } = {}) {
    const schluessel = token ?? ladeVerbindung()?.token;
    // Nur Kopfzeilen, die GitHub für Browser-Anfragen (CORS) erlaubt
    const headers = { Accept: 'application/vnd.github+json' };
    if (schluessel) headers.Authorization = `Bearer ${schluessel}`;
    if (body) headers['Content-Type'] = 'application/json';
    try {
      return await fetch(GITHUB_API + pfad, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    } catch {
      throw new GithubFehler('netz', 'Keine Verbindung zu GitHub. Bitte prüfe die Internetverbindung.');
    }
  }

  async function githubFehler(antwort) {
    let nachricht = '';
    try {
      nachricht = (await antwort.json())?.message || '';
    } catch {
      nachricht = '';
    }
    if (antwort.status === 401) {
      return new GithubFehler('token', 'GitHub nimmt den Schlüssel nicht an – er ist falsch oder abgelaufen. Bitte trage einen neuen ein.');
    }
    if (antwort.status === 429 || (antwort.status === 403 && antwort.headers.get('x-ratelimit-remaining') === '0')) {
      return new GithubFehler('limit', 'GitHub hat gerade zu viele Anfragen gezählt. Bitte versuche es später noch einmal.');
    }
    if (antwort.status === 403 || antwort.status === 404) {
      return new GithubFehler(
        'rechte',
        `Der Schlüssel darf in ${zustand.repo} nichts ändern. Erstelle ihn mit „Only select repositories“ für dieses Repository und mit der Berechtigung „Contents: Read and write“.`,
      );
    }
    return new GithubFehler('server', `GitHub meldet einen Fehler (${antwort.status}${nachricht ? `: ${nachricht}` : ''}). Bitte versuche es später noch einmal.`);
  }

  function zuBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binaer = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binaer += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binaer);
  }

  function ausBase64(text) {
    const binaer = atob(String(text).replace(/\s+/g, ''));
    return new TextDecoder().decode(Uint8Array.from(binaer, (z) => z.charCodeAt(0)));
  }

  /** Ein Eintrag pro Zeile – so bleibt die Datei auf GitHub gut lesbar. */
  function alsDateitext(json) {
    const zeile = (e) => `{ ${Object.entries(e).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')} }`;
    const teile = [];
    for (const [k, v] of Object.entries(json)) if (k !== 'serien') teile.push(`  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
    const serien = json.serien.map((e) => `    ${e && typeof e === 'object' && !Array.isArray(e) ? zeile(e) : JSON.stringify(e)}`);
    teile.push(`  "serien": [${serien.length ? `\n${serien.join(',\n')}\n  ` : ''}]`);
    return `{\n${teile.join(',\n')}\n}\n`;
  }

  async function ladeEigeneDatei() {
    const antwort = await github(`/repos/${zustand.repo}/contents/${EIGENE_PFAD}`);
    if (antwort.status === 404) return { sha: null, json: { _hinweis: HINWEIS_DATEI, serien: [] } };
    if (!antwort.ok) throw await githubFehler(antwort);
    const daten = await antwort.json();
    let json;
    try {
      json = JSON.parse(ausBase64(daten.content || ''));
    } catch {
      throw new GithubFehler('datei', 'data/eigene.json im Repository ist beschädigt (kein gültiges JSON). Bitte dort prüfen – die README hilft unter „Häufige Probleme“.');
    }
    if (Array.isArray(json)) json = { serien: json };
    if (!json || typeof json !== 'object' || !Array.isArray(json.serien)) {
      throw new GithubFehler('datei', 'data/eigene.json im Repository hat ein unerwartetes Format. Bitte dort prüfen.');
    }
    return { sha: daten.sha, json };
  }

  /** Änderungen nacheinander speichern, damit sie sich nicht in die Quere kommen. */
  let schreibKette = Promise.resolve();

  function schreibeEigene(aenderung, nachricht) {
    const auftrag = schreibKette.then(() => schreibeJetzt(aenderung, nachricht));
    schreibKette = auftrag.catch(() => {});
    return auftrag;
  }

  async function schreibeJetzt(aenderung, nachricht) {
    for (let versuch = 1; versuch <= 3; versuch++) {
      const datei = await ladeEigeneDatei();
      const neu = aenderung(datei.json);
      if (!neu) return false; // nichts zu ändern
      const body = { message: nachricht, content: zuBase64(alsDateitext(neu)) };
      if (datei.sha) body.sha = datei.sha;
      const antwort = await github(`/repos/${zustand.repo}/contents/${EIGENE_PFAD}`, { method: 'PUT', body });
      if (antwort.ok) return true;
      // Inzwischen auf einem anderen Gerät geändert? Dann neu lesen und noch einmal.
      if ((antwort.status === 409 || antwort.status === 422) && versuch < 3) continue;
      throw await githubFehler(antwort);
    }
    return false;
  }

  function zeigeGithubFehler(fehler) {
    const text = fehler?.message || 'Speichern hat nicht geklappt. Bitte versuche es noch einmal.';
    if (fehler?.art === 'token' || fehler?.art === 'rechte') oeffneGithubDialog({ fehlerText: text });
    else meldung(text);
  }

  /** Eintrag ohne leere Felder, wie er in data/eigene.json stehen soll. */
  function sauberEintrag(roh) {
    const eintrag = {};
    for (const feld of ['tvmaze', 'tmdb_id', 'staffel', 'imdb', 'tvdb', 'titel', 'jahr', 'hinzugefuegt']) {
      if (roh[feld] !== null && roh[feld] !== undefined && roh[feld] !== '') eintrag[feld] = roh[feld];
    }
    if (!eintrag.hinzugefuegt) eintrag.hinzugefuegt = heuteIso();
    return eintrag;
  }

  /**
   * Serie in „Eigene Serien“ aufnehmen. Die Karte erscheint sofort; gespeichert
   * wird im Hintergrund. Klappt das nicht, verschwindet sie wieder.
   */
  async function fuegeHinzu(roh, anzeige = {}) {
    const eintrag = sauberEintrag(roh);
    const schluessel = eigenerSchluessel(eintrag);
    const titel = anzeige.titel || eintrag.titel || schluessel;
    if (!schluessel) return false;
    if (zustand.eigene.some((e) => e.eigenerSchluessel === schluessel)) {
      meldung(`„${titel}“ steht schon in „Eigene Serien“.`);
      return false;
    }
    const vorher = zustand.offen.find((o) => o.schluessel === schluessel) || null;
    setzeOffen({
      art: 'hinzu',
      schluessel,
      eintrag,
      titel,
      info: anzeige.info || null,
      bild: istSicherUrl(anzeige.bild) ? anzeige.bild : null,
      position: Number.isInteger(anzeige.position) ? anzeige.position : null,
      zeit: Date.now(),
    });
    rendereEigene();
    aktualisiereHinzuTreffer();
    try {
      await schreibeEigene((json) => {
        if (json.serien.some((x) => eigenerSchluessel(x) === schluessel)) return null;
        const stelle = Number.isInteger(anzeige.position) ? Math.min(Math.max(anzeige.position, 0), json.serien.length) : 0;
        json.serien.splice(stelle, 0, eintrag);
        return json;
      }, `Eigene Serien: „${titel}“ hinzugefügt`);
      const sofort = Boolean(topFuer(eintrag));
      meldung(
        sofort ? `„${titel}“ steht jetzt in „Eigene Serien“.` : `„${titel}“ wird hinzugefügt. Die Daten kommen in 1 bis 2 Minuten.`,
        anzeige.ohneRueckgaengig ? {} : { aktion: { text: 'Rückgängig', beiKlick: () => entferne(schluessel, { rueckgaengig: false }) } },
      );
      starteNachladen();
      return true;
    } catch (fehler) {
      entferneOffen(schluessel);
      if (vorher) setzeOffen(vorher);
      rendereEigene();
      aktualisiereHinzuTreffer();
      zeigeGithubFehler(fehler);
      return false;
    }
  }

  async function entferne(schluessel, { rueckgaengig = true } = {}) {
    if (!zustand.repo || !ladeVerbindung()) {
      mitGithub(() => entferne(schluessel, { rueckgaengig }));
      return;
    }
    const ansicht = zustand.eigene.find((e) => e.eigenerSchluessel === schluessel);
    const titel = ansicht ? anzeigeTitel(ansicht) : schluessel;
    const vorher = zustand.offen.find((o) => o.schluessel === schluessel) || null;
    setzeOffen({ art: 'weg', schluessel, titel, zeit: Date.now() });
    rendereEigene();
    aktualisiereHinzuTreffer();
    let entfernt = null;
    try {
      await schreibeEigene((json) => {
        const stelle = json.serien.findIndex((x) => eigenerSchluessel(x) === schluessel);
        if (stelle < 0) return null;
        entfernt = { eintrag: json.serien[stelle], position: stelle };
        json.serien.splice(stelle, 1);
        return json;
      }, `Eigene Serien: „${titel}“ entfernt`);
      const wiederHer = () =>
        fuegeHinzu(entfernt.eintrag, {
          titel,
          info: ansicht?.info || (ansicht?.serie?.jahre ? jahreText(ansicht.serie.jahre) : null),
          bild: ansicht?.bild,
          position: entfernt.position,
          ohneRueckgaengig: true,
        });
      meldung(`„${titel}“ aus „Eigene Serien“ entfernt.`, rueckgaengig && entfernt ? { aktion: { text: 'Rückgängig', beiKlick: wiederHer } } : {});
      starteNachladen();
    } catch (fehler) {
      entferneOffen(schluessel);
      if (vorher) setzeOffen(vorher);
      rendereEigene();
      aktualisiereHinzuTreffer();
      zeigeGithubFehler(fehler);
    }
  }

  // ---------------------------------------------------------------------------
  // Verbindung zu GitHub (Schlüssel einmal pro Gerät)
  // ---------------------------------------------------------------------------

  let nachVerbindung = null;

  function tokenSeite() {
    const [besitzer, name] = (zustand.repo || '/').split('/');
    const parameter = new URLSearchParams({
      name: 'Serienliste',
      description: `Website ${name}: eigene Serien in data/eigene.json speichern`,
      expires_in: '366',
      contents: 'write',
    });
    if (besitzer) parameter.set('target_name', besitzer);
    return `https://github.com/settings/personal-access-tokens/new?${parameter}`;
  }

  /** Führt eine Aktion aus, die speichern muss – vorher bei Bedarf mit GitHub verbinden. */
  function mitGithub(aktion) {
    if (!zustand.repo) {
      meldung('Speichern ist erst möglich, wenn der Workflow einmal mit der neuen Version gelaufen ist. Bitte lade die Seite später neu.');
      return;
    }
    if (ladeVerbindung()) aktion();
    else oeffneGithubDialog({ danach: aktion });
  }

  function oeffneGithubDialog({ danach = null, fehlerText = '' } = {}) {
    const dialog = $('#github-dialog');
    nachVerbindung = danach;
    const verbindung = ladeVerbindung();
    $('#github-anlegen').href = tokenSeite();
    $('#github-repo-name').textContent = zustand.repo ? zustand.repo.split('/')[1] : 'dieses Repository';
    const status = $('#github-status');
    status.hidden = !verbindung;
    status.textContent = verbindung ? `Verbunden${verbindung.login ? ` als ${verbindung.login}` : ''}. Du kannst hier einen neuen Schlüssel eintragen.` : '';
    $('#github-trennen').hidden = !verbindung;
    $('#github-token').value = '';
    zeigeTokenFehler(fehlerText);
    $('#github-verbinden').disabled = false;
    $('#github-verbinden').textContent = 'Verbinden';
    if (!dialog.open) dialog.showModal();
  }

  function zeigeTokenFehler(text) {
    const feld = $('#github-fehler');
    feld.textContent = text || '';
    feld.hidden = !text;
  }

  async function verbinde() {
    const token = $('#github-token').value.trim();
    if (!/^[A-Za-z0-9_]{20,255}$/.test(token)) {
      zeigeTokenFehler('Bitte füge den kompletten Schlüssel ein. Er beginnt meist mit „github_pat_“.');
      return;
    }
    const knopf = $('#github-verbinden');
    knopf.disabled = true;
    knopf.textContent = 'Wird geprüft …';
    try {
      const antwort = await github('/user', { token });
      if (antwort.status === 401) throw new GithubFehler('token', 'GitHub kennt diesen Schlüssel nicht. Bitte prüfe, ob er vollständig kopiert ist.');
      if (!antwort.ok) throw await githubFehler(antwort);
      const nutzer = await antwort.json();
      if (!schreibe(SPEICHER.github, { token, login: String(nutzer?.login || ''), seit: new Date().toISOString() })) {
        throw new GithubFehler('datei', 'Der Browser lässt das Speichern nicht zu (privater Modus?).');
      }
      $('#github-dialog').close();
      aktualisiereVerbindung();
      const aktion = nachVerbindung;
      nachVerbindung = null;
      if (aktion) aktion();
      else meldung(`Mit GitHub verbunden${nutzer?.login ? ` als ${nutzer.login}` : ''}.`);
    } catch (fehler) {
      zeigeTokenFehler(fehler.message);
    } finally {
      knopf.disabled = false;
      knopf.textContent = 'Verbinden';
    }
  }

  function trenne() {
    schreibe(SPEICHER.github, null);
    $('#github-dialog').close();
    aktualisiereVerbindung();
    meldung('Die Verbindung zu GitHub ist auf diesem Gerät entfernt. Den Schlüssel selbst löschst du bei GitHub unter Settings → Developer settings.');
  }

  function aktualisiereVerbindung() {
    const zeile = $('#verbindung');
    const verbindung = ladeVerbindung();
    const knopf = el('button', { type: 'button', class: 'knopf-text' }, verbindung ? 'Ändern' : 'Mit GitHub verbinden');
    knopf.addEventListener('click', () => oeffneGithubDialog());
    if (!zustand.repo) {
      zeile.replaceChildren('Hinzufügen geht, sobald der Workflow einmal mit der neuen Version gelaufen ist.');
    } else if (verbindung) {
      zeile.replaceChildren(`Gespeichert wird in ${zustand.repo}${verbindung.login ? ` (verbunden als ${verbindung.login})` : ''}. `, knopf);
    } else {
      zeile.replaceChildren('Deine Liste wird in deinem GitHub-Repository gespeichert. Einmal pro Gerät verbinden: ', knopf);
    }
  }

  // ---------------------------------------------------------------------------
  // Serie hinzufügen: Suche in den Top 100 und bei TVmaze
  // ---------------------------------------------------------------------------

  const suche = { frage: '', ergebnisse: [], cache: new Map(), timer: 0, abbruch: null, laeuft: false, fehler: '' };

  function landName(code) {
    if (!code || !LAENDER) return code || null;
    try {
      return LAENDER.of(code) || code;
    } catch {
      return code;
    }
  }

  /** Treffer aus den Top 100 (auch über den deutschen Titel). */
  function topTreffer(frage) {
    const text = normal(frage);
    if (text.length < 2) return [];
    return zustand.top
      .filter((e) => e._suchtext.includes(text))
      .sort((a, b) => Number(!a._suchtext.startsWith(text)) - Number(!b._suchtext.startsWith(text)) || a.platz - b.platz)
      .slice(0, 4)
      .map((e) => ({ art: 'top', top: e }));
  }

  /** Ein TVmaze-Treffer, so weit wie nötig geprüft und gekürzt. */
  function ausTvmaze(show) {
    if (!show || !positiv(show.id) || typeof show.name !== 'string') return null;
    const imdb = gueltigeImdbId(show.externals?.imdb);
    const tvdb = positiv(show.externals?.thetvdb) ? show.externals.thetvdb : null;
    const start = /^(\d{4})/.exec(show.premiered || '')?.[1] || null;
    const ende = /^(\d{4})/.exec(show.ended || '')?.[1] || null;
    let jahre = start || '';
    if (start && show.status === 'Running') jahre = `seit ${start}`;
    else if (start && ende && ende !== start) jahre = `${start}–${ende}`;
    const sender = show.network?.name || show.webChannel?.name || null;
    const land = landName(show.network?.country?.code || show.webChannel?.country?.code || null);
    const bild = istSicherUrl(show.image?.medium) && /^https:\/\/static\.tvmaze\.com\//.test(show.image.medium) ? show.image.medium : null;
    // Dieselbe Serie wie in den Top 100? (nur ganze Serien, nicht „Staffel 1“-Einträge)
    const top = zustand.top.find(
      (e) =>
        (e.serie.staffel === null || e.serie.staffel === undefined) &&
        ((imdb && e.serie.imdbId === imdb) || (tvdb && e.serie.tvdbId === tvdb)),
    );
    return {
      art: top ? 'top' : 'tvmaze',
      top: top || null,
      eintrag: { tvmaze: show.id, imdb, tvdb, titel: show.name.trim().slice(0, 200), jahr: start ? Number(start) : null },
      info: [jahre, sender, land].filter(Boolean).join(' · '),
      bild,
    };
  }

  function istTrefferDrin(t) {
    if (t.art === 'top') return zustand.eigeneTop.has(t.top.schluessel);
    const schluessel = eigenerSchluessel(t.eintrag);
    if (zustand.eigene.some((e) => e.eigenerSchluessel === schluessel)) return true;
    // Schon auf anderem Weg in der Liste (gleiche IMDb-ID)?
    return Boolean(t.eintrag.imdb) && zustand.eigene.some((e) => e.serie?.imdbId === t.eintrag.imdb);
  }

  function trefferZeile(t) {
    const drin = istTrefferDrin(t);
    const s = t.top?.serie;
    const titel = s ? s.titelDe || s.titel : t.eintrag.titel;
    const bild = s?.poster
      ? el('img', { class: 'treffer-bild', src: `${BILD_URL}w92${s.poster}`, width: 92, height: 138, alt: '', loading: 'lazy', decoding: 'async' })
      : t.bild
        ? el('img', { class: 'treffer-bild', src: t.bild, width: 210, height: 295, alt: '', loading: 'lazy', decoding: 'async' })
        : el('span', { class: 'treffer-bild treffer-bild-leer', 'aria-hidden': 'true' });
    const knopf = el('button', { type: 'button', class: drin ? 'knopf treffer-knopf' : 'knopf treffer-knopf knopf-primaer', disabled: drin }, drin ? 'In deiner Liste' : 'Hinzufügen');
    knopf.setAttribute('aria-label', drin ? `${titel} ist in deiner Liste` : `${titel} hinzufügen`);
    knopf.addEventListener('click', () => {
      if (t.art === 'top') {
        mitGithub(() => fuegeHinzu(topAlsEintrag(s), { titel }));
      } else {
        mitGithub(() => fuegeHinzu(t.eintrag, { titel, info: t.info, bild: t.bild }));
      }
    });
    return el(
      'li',
      { class: 'treffer-zeile' },
      bild,
      el(
        'div',
        { class: 'treffer-text' },
        el('p', { class: 'treffer-titel' }, titel, s?.titelDe ? el('span', { class: 'titel-liste' }, ` (${s.titel})`) : null),
        el('p', { class: 'treffer-info' }, s ? jahreText(s.jahre) : t.info || '–'),
        s ? el('p', { class: 'treffer-top' }, `Platz ${s.platz} der Top 100`) : null,
      ),
      knopf,
    );
  }

  function aktualisiereHinzuTreffer({ meldungLassen = false } = {}) {
    const dialog = $('#hinzu-dialog');
    if (!dialog.open) return;
    const liste = suche.ergebnisse;
    const ziel = $('#hinzu-treffer');
    // Fokus auf einem Knopf der Liste beim Neuaufbau behalten
    const knoepfe = [...ziel.querySelectorAll('button')];
    const fokusStelle = knoepfe.indexOf(document.activeElement);
    ziel.replaceChildren(...liste.map(trefferZeile));
    if (fokusStelle >= 0) (ziel.querySelectorAll('button')[fokusStelle] || $('#hinzu-suche')).focus();
    if (meldungLassen) return;
    const zeile = $('#hinzu-meldung');
    const laenge = normal(suche.frage).length;
    if (laenge < 2) zeile.textContent = suche.frage ? 'Bitte mindestens zwei Buchstaben eingeben.' : '';
    else if (suche.laeuft) zeile.textContent = liste.length ? 'Suche bei TVmaze läuft …' : 'Suche läuft …';
    else if (suche.fehler) zeile.textContent = suche.fehler;
    else if (!liste.length) zeile.textContent = 'Nichts gefunden. Versuch es mit dem Original- oder englischen Titel.';
    else zeile.textContent = `${liste.length} Treffer`;
  }

  function fuehreZusammen(lokal, tvmaze) {
    const ergebnisse = [...lokal];
    const schonTop = new Set(lokal.map((t) => t.top.schluessel));
    for (const t of tvmaze) {
      if (t.art === 'top') {
        if (schonTop.has(t.top.schluessel)) continue;
        schonTop.add(t.top.schluessel);
      }
      ergebnisse.push(t);
    }
    return ergebnisse;
  }

  async function sucheSerien(frage) {
    suche.frage = frage;
    suche.fehler = '';
    clearTimeout(suche.timer);
    suche.abbruch?.abort();
    const text = normal(frage);
    const lokal = topTreffer(frage);
    if (text.length < 2) {
      suche.ergebnisse = [];
      suche.laeuft = false;
      aktualisiereHinzuTreffer();
      return;
    }
    const zwischengespeichert = suche.cache.get(text);
    if (zwischengespeichert) {
      suche.ergebnisse = fuehreZusammen(lokal, zwischengespeichert);
      suche.laeuft = false;
      aktualisiereHinzuTreffer();
      return;
    }
    suche.ergebnisse = lokal;
    suche.laeuft = true;
    aktualisiereHinzuTreffer();
    // Kurz warten, bis die Eingabe ruht – TVmaze erlaubt rund 20 Anfragen in 10 Sekunden.
    suche.timer = setTimeout(async () => {
      const abbruch = new AbortController();
      suche.abbruch = abbruch;
      try {
        let antwort = await fetch(`${TVMAZE_URL}/search/shows?q=${encodeURIComponent(frage.trim())}`, { signal: abbruch.signal });
        if (antwort.status === 429) {
          await new Promise((fertig) => setTimeout(fertig, 2500));
          antwort = await fetch(`${TVMAZE_URL}/search/shows?q=${encodeURIComponent(frage.trim())}`, { signal: abbruch.signal });
        }
        if (!antwort.ok) throw new Error(antwort.status === 429 ? 'TVmaze ist gerade ausgelastet. Bitte in ein paar Sekunden noch einmal suchen.' : `TVmaze antwortet nicht (HTTP ${antwort.status}).`);
        const daten = await antwort.json();
        const treffer = (Array.isArray(daten) ? daten : []).map((x) => ausTvmaze(x?.show)).filter(Boolean);
        suche.cache.set(text, treffer);
        if (suche.frage !== frage) return;
        suche.ergebnisse = fuehreZusammen(topTreffer(frage), treffer);
        suche.laeuft = false;
      } catch (fehler) {
        if (fehler.name === 'AbortError') return;
        if (suche.frage !== frage) return;
        suche.laeuft = false;
        suche.fehler = fehler instanceof TypeError ? 'Keine Verbindung zu TVmaze. Bitte prüfe die Internetverbindung.' : fehler.message;
      }
      aktualisiereHinzuTreffer();
    }, 350);
  }

  function oeffneHinzuDialog() {
    const dialog = $('#hinzu-dialog');
    if (typeof dialog.showModal !== 'function') {
      meldung('Dein Browser ist für diese Funktion zu alt.');
      return;
    }
    $('#hinzu-suche').value = suche.frage;
    $('#hinzu-meldung').textContent = '';
    dialog.showModal();
    aktualisiereHinzuTreffer();
  }

  // ---------------------------------------------------------------------------
  // Tabs, Fortschritt, Filter, Suche
  // ---------------------------------------------------------------------------

  const eintraegeImTab = () => (zustand.tab === 'top' ? zustand.top : zustand.eigene);

  function zeigeTab(tab, { fokus = false, merken = true } = {}) {
    zustand.tab = tab === 'eigene' ? 'eigene' : 'top';
    const istTop = zustand.tab === 'top';
    for (const knopf of document.querySelectorAll('.tab')) {
      const aktiv = knopf.id === (istTop ? 'tab-top' : 'tab-eigene');
      knopf.setAttribute('aria-selected', String(aktiv));
      knopf.tabIndex = aktiv ? 0 : -1;
      if (aktiv && fokus) knopf.focus();
    }
    $('#inhalt').setAttribute('aria-labelledby', istTop ? 'tab-top' : 'tab-eigene');
    $('#liste-top').hidden = !istTop;
    $('#liste-eigene').hidden = istTop;
    $('#eigene-kopf').hidden = istTop;
    // Die Suche gilt für die sichtbare Liste; Status- und Dienst-Filter bleiben.
    if (zustand.suche) {
      zustand.suche = '';
      $('#suche').value = '';
    }
    $('label[for="suche"]').textContent = istTop ? 'In den Top 100 suchen' : 'In deinen eigenen Serien suchen';
    if (merken) {
      schreibe(SPEICHER.tab, zustand.tab);
      const ziel = istTop ? `${location.pathname}${location.search}` : '#eigene';
      if (history.replaceState) history.replaceState(null, '', ziel);
    }
    schliesseDienstFilter();
    baueDienstFilter();
    aktualisiereFortschritt();
    wendeFilterAn();
  }

  function aktualisiereFortschritt() {
    const liste = eintraegeImTab();
    const gesamt = liste.length;
    let gesehen = 0;
    let uninteressant = 0;
    for (const e of liste) {
      const st = statusVon(e.schluessel);
      if (st === 'gesehen') gesehen++;
      else if (st === 'uninteressant') uninteressant++;
    }
    let text;
    if (gesamt === 0) text = zustand.tab === 'eigene' ? 'Noch keine eigenen Serien' : 'Keine Serien';
    else text = `${gesehen} von ${gesamt} gesehen${uninteressant ? `, ${uninteressant} uninteressant` : ''}`;
    $('#fortschritt-text').textContent = text;
    const balken = $('#fortschritt-balken');
    balken.style.setProperty('--anteil', `${gesamt ? (gesehen / gesamt) * 100 : 0}%`);
    balken.style.setProperty('--anteil-rot', `${gesamt ? (uninteressant / gesamt) * 100 : 0}%`);
    balken.setAttribute('aria-valuenow', String(gesehen));
    balken.setAttribute('aria-valuemax', String(gesamt));
    balken.setAttribute('aria-valuetext', text);
    $('#anzahl-offen').textContent = String(gesamt - gesehen - uninteressant);
    $('#anzahl-gesehen').textContent = String(gesehen);
    $('#anzahl-uninteressant').textContent = String(uninteressant);
  }

  function sucheKriterien() {
    const roh = zustand.suche.trim();
    return { text: normal(roh), platz: zustand.tab === 'top' && /^\d{1,3}$/.test(roh) ? Number(roh) : null };
  }

  /** Passt der Eintrag zu Suche, Markierungs-Filter und der Auswahl an Streamingdiensten? */
  function passt(e, dienste, suchKriterien) {
    if (!zustand.filter[statusVon(e.schluessel) || 'offen']) return false;
    if (!passtDienst(e, dienste)) return false;
    if (suchKriterien.text || suchKriterien.platz !== null) {
      if (suchKriterien.platz !== null && e.platz === suchKriterien.platz) return true;
      return suchKriterien.text !== '' && (e._suchtext || '').includes(suchKriterien.text);
    }
    return true;
  }

  const filterAktiv = () => !zustand.filter.offen || !zustand.filter.gesehen || !zustand.filter.uninteressant || Boolean(zustand.dienste) || Boolean(zustand.suche.trim());

  function wendeFilterAn() {
    const kriterien = sucheKriterien();
    const liste = eintraegeImTab();
    let sichtbar = 0;
    for (const e of liste) {
      const ja = passt(e, zustand.dienste, kriterien);
      if (e._karte) e._karte.hidden = !ja;
      if (ja) sichtbar++;
    }
    const gesamt = liste.length;
    $('#treffer').textContent = filterAktiv() ? `${sichtbar} von ${gesamt} ${serienWort(gesamt)}` : `${gesamt} ${serienWort(gesamt)}`;
    const leerEigene = zustand.tab === 'eigene' && gesamt === 0;
    $('#eigene-leer').hidden = !leerEigene;
    $('#treffer').hidden = leerEigene; // „0 Serien“ über dem Hinweis wäre doppelt
    $('#keine-treffer').hidden = sichtbar > 0 || gesamt === 0;
  }

  function aktualisiereStatusKnoepfe() {
    for (const knopf of document.querySelectorAll('.status-filter .chip')) {
      knopf.setAttribute('aria-pressed', String(Boolean(zustand.filter[knopf.dataset.status])));
    }
  }

  function setzeFilterZurueck() {
    zustand.filter = { offen: true, gesehen: true, uninteressant: true };
    zustand.dienste = null;
    zustand.suche = '';
    $('#suche').value = '';
    aktualisiereStatusKnoepfe();
    aktualisiereDienstKnopf();
    wendeFilterAn();
  }

  // ---------------------------------------------------------------------------
  // Filter nach Streamingdienst – funktioniert wie ein Spaltenfilter in Excel:
  // Markiert = wird angezeigt. Beim Öffnen ist alles markiert (kein Filter).
  // Eine Suche zeigt nur passende Dienste und markiert sie; „Übernehmen“ filtert
  // dann auf diese Treffer, außer „Aktuelle Auswahl zum Filter hinzufügen“ ist an.
  // Die Liste zeigt die Dienste des aktuellen Tabs; die Auswahl gilt für beide.
  // ---------------------------------------------------------------------------

  const OHNE_DIENST = 'ohne-dienst'; // Eintrag „(Kein Dienst)“: Serien ohne Abo- oder Gratis-Angebot
  const anbieterSchluessel = (p) => p?.dienst || normal(p?.name);

  const dienstFilter = {
    eintraege: [], // { schluessel, name, logo, anzahl, leer }
    namen: new Map(), // Schlüssel → Name, aus beiden Listen (für den Knopf)
    entwurf: new Set(), // Markierungen im geöffneten Filter
    suchtext: '',
    suchAuswahl: new Set(), // markierte Suchtreffer
    hinzufuegen: false, // „Aktuelle Auswahl zum Filter hinzufügen“
  };

  function passtDienst(e, dienste) {
    if (!dienste) return true;
    const abo = e.serie?.abo || [];
    if (abo.length === 0) return dienste.has(OHNE_DIENST);
    return abo.some((p) => dienste.has(anbieterSchluessel(p)));
  }

  function baueDienstFilter() {
    const zaehler = new Map();
    let ohneDienst = 0;
    for (const e of eintraegeImTab()) {
      const abo = e.serie?.abo || [];
      if (abo.length === 0) ohneDienst++;
      for (const p of abo) {
        const schluessel = anbieterSchluessel(p);
        if (!schluessel) continue;
        const eintrag = zaehler.get(schluessel) || { schluessel, name: String(p.name || schluessel), logo: p.logo || null, anzahl: 0 };
        eintrag.anzahl++;
        zaehler.set(schluessel, eintrag);
      }
    }
    for (const e of [...zustand.top, ...zustand.eigene]) {
      for (const p of e.serie?.abo || []) {
        const schluessel = anbieterSchluessel(p);
        if (schluessel && !dienstFilter.namen.has(schluessel)) dienstFilter.namen.set(schluessel, String(p.name || schluessel));
      }
    }
    dienstFilter.eintraege = [...zaehler.values()].sort((a, b) => b.anzahl - a.anzahl || a.name.localeCompare(b.name, 'de'));
    if (dienstFilter.eintraege.length && ohneDienst) {
      dienstFilter.eintraege.push({ schluessel: OHNE_DIENST, name: '(Kein Dienst)', logo: null, anzahl: ohneDienst, leer: true });
    }
    $('#dienst-knopf').disabled = dienstFilter.eintraege.length === 0 && !zustand.dienste;
    aktualisiereDienstKnopf();
  }

  const suchtModus = () => normal(dienstFilter.suchtext) !== '';
  const aktiveMarkierung = () => (suchtModus() ? dienstFilter.suchAuswahl : dienstFilter.entwurf);

  function sichtbareDienste() {
    const text = normal(dienstFilter.suchtext);
    return text ? dienstFilter.eintraege.filter((e) => normal(e.name).includes(text)) : dienstFilter.eintraege;
  }

  /** Die Auswahl, die „Übernehmen“ setzen würde. */
  function dienstErgebnis() {
    if (!suchtModus()) return new Set(dienstFilter.entwurf);
    const ergebnis = new Set(dienstFilter.suchAuswahl);
    if (dienstFilter.hinzufuegen) for (const schluessel of dienstFilter.entwurf) ergebnis.add(schluessel);
    return ergebnis;
  }

  /** Sind alle Dienste markiert, ist kein Filter aktiv (null). */
  function alsFilter(auswahl) {
    return dienstFilter.eintraege.every((e) => auswahl.has(e.schluessel)) ? null : auswahl;
  }

  function zaehleTreffer(dienste) {
    const kriterien = sucheKriterien();
    return eintraegeImTab().reduce((summe, e) => summe + (passt(e, dienste, kriterien) ? 1 : 0), 0);
  }

  function rendereDienstListe() {
    const sichtbar = sichtbareDienste();
    const markiert = aktiveMarkierung();
    $('#dienst-eintraege').replaceChildren(
      ...sichtbar.map((e) => {
        const box = el('input', { type: 'checkbox', value: e.schluessel });
        box.checked = markiert.has(e.schluessel);
        return el(
          'li',
          {},
          el(
            'label',
            { class: e.leer ? 'dienst-zeile ist-leer' : 'dienst-zeile' },
            box,
            e.logo
              ? el('img', { class: 'dienst-logo', src: `${BILD_URL}w92${e.logo}`, width: 24, height: 24, alt: '', loading: 'lazy', decoding: 'async' })
              : el('span', { class: 'dienst-logo dienst-logo-leer', 'aria-hidden': 'true' }),
            el('span', { class: 'dienst-name' }, e.name),
            el('span', { class: 'dienst-anzahl', title: `${e.anzahl} ${serienWort(e.anzahl)}` }, String(e.anzahl)),
          ),
        );
      }),
    );
    $('#dienst-leer').hidden = sichtbar.length > 0;
    $('#dienst-alle-zeile').hidden = sichtbar.length === 0;
    $('#dienst-alle-text').textContent = suchtModus() ? '(Alle Suchergebnisse auswählen)' : '(Alle auswählen)';
    $('#dienst-hinzu-zeile').hidden = !suchtModus();
    $('#dienst-hinzu').checked = dienstFilter.hinzufuegen;
    aktualisiereDienstPanel();
  }

  /** „(Alle auswählen)“ und den Knopf „Übernehmen“ an die Markierungen anpassen. */
  function aktualisiereDienstPanel() {
    const sichtbar = sichtbareDienste();
    const markiert = aktiveMarkierung();
    const anzahlMarkiert = sichtbar.filter((e) => markiert.has(e.schluessel)).length;
    const alle = $('#dienst-alle');
    alle.checked = sichtbar.length > 0 && anzahlMarkiert === sichtbar.length;
    alle.indeterminate = anzahlMarkiert > 0 && anzahlMarkiert < sichtbar.length;

    const ok = $('#dienst-ok');
    const ergebnis = dienstErgebnis();
    if (ergebnis.size === 0) {
      ok.disabled = true;
      ok.textContent = 'Nichts markiert';
    } else {
      const anzahl = zaehleTreffer(alsFilter(ergebnis));
      ok.disabled = false;
      ok.textContent = `${anzahl} ${serienWort(anzahl)} anzeigen`;
    }
    $('#dienst-loeschen').disabled = !zustand.dienste;
  }

  /** Höhe des Filters an den freien Platz im Fenster anpassen (auch bei Bildschirmtastatur). */
  function passeDienstPanelAn() {
    const panel = $('#dienst-panel');
    if (panel.hidden) return;
    const fenster = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    const frei = fenster - panel.getBoundingClientRect().top - 12;
    panel.style.maxHeight = `${Math.max(220, Math.min(540, frei))}px`;
  }

  function oeffneDienstFilter() {
    dienstFilter.entwurf = new Set(zustand.dienste || dienstFilter.eintraege.map((e) => e.schluessel));
    dienstFilter.suchtext = '';
    dienstFilter.suchAuswahl = new Set();
    dienstFilter.hinzufuegen = false;
    $('#dienst-suche').value = '';
    rendereDienstListe();
    const panel = $('#dienst-panel');
    panel.hidden = false;
    $('#dienst-knopf').setAttribute('aria-expanded', 'true');
    $('#dienst-eintraege').scrollTop = 0;
    // Zu wenig Platz unter der Leiste (z. B. am Handy ganz oben auf der Seite)? Dann die Leiste nach oben holen.
    const fenster = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    if (fenster - panel.getBoundingClientRect().top < 360) {
      window.scrollBy(0, $('.werkzeuge').getBoundingClientRect().top);
    }
    passeDienstPanelAn();
    if (window.matchMedia('(pointer: fine)').matches) $('#dienst-suche').focus();
    else panel.focus({ preventScroll: true });
  }

  function schliesseDienstFilter(fokusZurueck = false) {
    const panel = $('#dienst-panel');
    if (panel.hidden) return;
    panel.hidden = true;
    $('#dienst-knopf').setAttribute('aria-expanded', 'false');
    if (fokusZurueck) $('#dienst-knopf').focus();
  }

  function uebernehmeDienstFilter() {
    const ergebnis = dienstErgebnis();
    if (ergebnis.size === 0) return;
    zustand.dienste = alsFilter(ergebnis);
    schliesseDienstFilter(true);
    aktualisiereDienstKnopf();
    wendeFilterAn();
  }

  function loescheDienstFilter() {
    zustand.dienste = null;
    schliesseDienstFilter(true);
    baueDienstFilter();
    wendeFilterAn();
  }

  function aktualisiereDienstKnopf() {
    const knopf = $('#dienst-knopf');
    const text = $('#dienst-knopf-text');
    if (!zustand.dienste) {
      text.textContent = 'Alle Dienste';
      knopf.classList.remove('ist-aktiv');
      knopf.removeAttribute('title');
      return;
    }
    const namen = [...zustand.dienste].map((s) => (s === OHNE_DIENST ? 'Kein Dienst' : dienstFilter.namen.get(s) || s));
    text.textContent = namen.length <= 2 ? namen.join(', ') : `${namen.length} Dienste`;
    knopf.classList.add('ist-aktiv');
    knopf.title = `Gefiltert nach: ${namen.join(', ')}`;
  }

  function verbindeDienstFilter() {
    const bereich = $('#dienst-filter');
    const panel = $('#dienst-panel');
    $('#dienst-knopf').addEventListener('click', () => (panel.hidden ? oeffneDienstFilter() : schliesseDienstFilter()));
    $('#dienst-suche').addEventListener('input', (e) => {
      dienstFilter.suchtext = e.target.value;
      // Wie in Excel: Nach einer Suche sind zunächst alle Treffer markiert.
      dienstFilter.suchAuswahl = new Set(sichtbareDienste().map((x) => x.schluessel));
      rendereDienstListe();
    });
    $('#dienst-suche').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        uebernehmeDienstFilter();
      }
    });
    $('#dienst-eintraege').addEventListener('change', (e) => {
      const box = e.target;
      if (!(box instanceof HTMLInputElement)) return;
      const markiert = aktiveMarkierung();
      if (box.checked) markiert.add(box.value);
      else markiert.delete(box.value);
      aktualisiereDienstPanel();
    });
    $('#dienst-alle').addEventListener('change', () => {
      const sichtbar = sichtbareDienste();
      const markiert = aktiveMarkierung();
      const alleMarkiert = sichtbar.every((x) => markiert.has(x.schluessel));
      for (const x of sichtbar) {
        if (alleMarkiert) markiert.delete(x.schluessel);
        else markiert.add(x.schluessel);
      }
      rendereDienstListe();
    });
    $('#dienst-hinzu').addEventListener('change', (e) => {
      dienstFilter.hinzufuegen = e.target.checked;
      aktualisiereDienstPanel();
    });
    $('#dienst-ok').addEventListener('click', uebernehmeDienstFilter);
    $('#dienst-abbrechen').addEventListener('click', () => schliesseDienstFilter(true));
    $('#dienst-loeschen').addEventListener('click', loescheDienstFilter);
    bereich.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !panel.hidden) {
        e.preventDefault();
        schliesseDienstFilter(true);
      }
    });
    // Klick oder Fokus außerhalb schließt den Filter ohne Änderung – wie in Excel.
    // (Ein Klick, kein Antippen zum Scrollen: Wischen auf dem Handy schließt ihn nicht.)
    document.addEventListener('click', (e) => {
      if (!panel.hidden && !bereich.contains(e.target)) schliesseDienstFilter();
    });
    document.addEventListener('focusin', (e) => {
      if (!panel.hidden && !bereich.contains(e.target)) schliesseDienstFilter();
    });
    window.addEventListener('resize', passeDienstPanelAn);
    window.addEventListener('scroll', passeDienstPanelAn, { passive: true });
    window.visualViewport?.addEventListener('resize', passeDienstPanelAn);
  }

  // ---------------------------------------------------------------------------
  // Export und Import der Markierungen
  // ---------------------------------------------------------------------------

  function titelZu(schluessel) {
    const e = zustand.topNachSchluessel.get(schluessel) || zustand.eigene.find((x) => x.schluessel === schluessel);
    return e ? anzeigeTitel(e) : null;
  }

  function exportiere() {
    const markierungen = [...zustand.status]
      .map(([schluessel, status]) => ({ schluessel, status, titel: titelZu(schluessel) }))
      .sort((a, b) => a.status.localeCompare(b.status) || String(a.titel).localeCompare(String(b.titel), 'de'));
    const inhalt = { app: 'serien-top-100', version: 2, exportiert: new Date().toISOString(), markierungen };
    const datei = new Blob([`${JSON.stringify(inhalt, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(datei);
    const link = el('a', { href: url, download: `serien-markierungen-${heuteIso()}.json`, hidden: true });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    const g = markierungen.filter((m) => m.status === 'gesehen').length;
    const u = markierungen.length - g;
    meldung(`Exportiert: ${g} gesehen, ${u} uninteressant.`);
  }

  function zaehle(status) {
    let gesehen = 0;
    let uninteressant = 0;
    for (const art of status.values()) {
      if (art === 'gesehen') gesehen++;
      else if (art === 'uninteressant') uninteressant++;
    }
    return { gesehen, uninteressant };
  }

  function frageImportArt(datei) {
    const a = zaehle(datei);
    const b = zaehle(zustand.status);
    const text =
      `In der Datei: ${a.gesehen} gesehen, ${a.uninteressant} uninteressant. Auf diesem Gerät: ${b.gesehen} gesehen, ${b.uninteressant} uninteressant. ` +
      '„Ersetzen“ übernimmt genau den Stand aus der Datei. „Zusammenführen“ behält zusätzlich die Markierungen auf diesem Gerät.';
    const dialog = $('#import-dialog');
    if (!dialog || typeof dialog.showModal !== 'function') {
      return Promise.resolve(window.confirm(`${text}\n\nOK = Ersetzen, Abbrechen = nichts ändern`) ? 'ersetzen' : null);
    }
    $('#import-text').textContent = text;
    return new Promise((fertig) => {
      dialog.returnValue = '';
      dialog.addEventListener(
        'close',
        () => fertig(['ersetzen', 'zusammenfuehren'].includes(dialog.returnValue) ? dialog.returnValue : null),
        { once: true },
      );
      dialog.showModal();
    });
  }

  /** Liest eine Exportdatei: neues Format (Markierungen) und altes Format (gesehene Plätze). */
  function leseImport(inhalt) {
    const status = new Map();
    let uebersprungen = 0;
    if (Array.isArray(inhalt?.markierungen)) {
      for (const m of inhalt.markierungen) {
        if (m && GUELTIGER_SCHLUESSEL.test(m.schluessel) && STATUS.includes(m.status)) status.set(m.schluessel, m.status);
        else uebersprungen++;
      }
      return { status, uebersprungen };
    }
    const liste = Array.isArray(inhalt) ? inhalt : inhalt?.gesehen;
    if (!Array.isArray(liste)) return null;
    const nachTitel = new Map(zustand.top.map((e) => [normal(e.serie.titel), e]));
    for (const eintrag of liste) {
      let e = null;
      if (typeof eintrag === 'number') e = zustand.topNachPlatz.get(eintrag);
      else if (eintrag && typeof eintrag === 'object') {
        e = (eintrag.titel ? nachTitel.get(normal(eintrag.titel)) : null) || zustand.topNachPlatz.get(Number(eintrag.platz));
      }
      if (e) status.set(e.schluessel, 'gesehen');
      else uebersprungen++;
    }
    return { status, uebersprungen };
  }

  async function importiere(datei) {
    let inhalt;
    try {
      inhalt = JSON.parse(await datei.text());
    } catch {
      meldung('Import nicht möglich: Die Datei ist keine gültige JSON-Datei.');
      return;
    }
    const gelesen = leseImport(inhalt);
    if (!gelesen) {
      meldung('Import nicht möglich: In der Datei stehen keine Markierungen.');
      return;
    }
    const art = await frageImportArt(gelesen.status);
    if (!art) return;
    if (art === 'ersetzen') zustand.status = gelesen.status;
    else for (const [schluessel, st] of gelesen.status) zustand.status.set(schluessel, st);
    speichereStatus();
    aktualisiereAlleKarten();
    const zusatz = gelesen.uebersprungen ? ` ${gelesen.uebersprungen} unbekannte Einträge wurden übersprungen.` : '';
    const z = zaehle(zustand.status);
    meldung(`Importiert: Jetzt ${z.gesehen} gesehen und ${z.uninteressant} uninteressant.${zusatz}`);
  }

  function aktualisiereAlleKarten() {
    for (const karte of document.querySelectorAll('.karte')) aktualisiereKarte(karte);
    aktualisiereFortschritt();
    wendeFilterAn();
  }

  // ---------------------------------------------------------------------------
  // Daten laden und nachladen
  // ---------------------------------------------------------------------------

  function repoAusAdresse() {
    const host = /^([a-z0-9-]+)\.github\.io$/i.exec(location.hostname);
    const name = location.pathname.split('/').filter(Boolean)[0];
    return host && name ? `${host[1]}/${name}` : null;
  }

  async function holeDaten(frisch) {
    const url = frisch ? `${DATEN_URL}?t=${Date.now()}` : DATEN_URL;
    const antwort = await fetch(url, { cache: frisch ? 'no-store' : 'no-cache' });
    if (!antwort.ok) throw new Error(`HTTP ${antwort.status}`);
    const daten = await antwort.json();
    if (!Array.isArray(daten?.serien)) throw new Error('unerwartetes Format');
    return daten;
  }

  function uebernimmDaten(daten) {
    zustand.daten = daten;
    zustand.repo = /^[\w.-]+\/[\w.-]+$/.test(daten.repo || '') ? daten.repo : repoAusAdresse();
    zustand.top = daten.serien
      .filter((s) => Number.isInteger(s?.platz))
      .sort((a, b) => a.platz - b.platz)
      .map((s) => ({
        schluessel: topSchluessel(s),
        serie: s,
        platz: s.platz,
        art: 'top',
        eigenerSchluessel: null,
        _suchtext: normal([s.titel, s.titelDe].filter(Boolean).join(' ')),
        _karte: null,
      }));
    zustand.topNachPlatz = new Map(zustand.top.map((e) => [e.platz, e]));
    zustand.topNachSchluessel = new Map(zustand.top.map((e) => [e.schluessel, e]));
    zustand.eigeneBasis = (Array.isArray(daten.eigene) ? daten.eigene : []).filter((e) => e && typeof e.schluessel === 'string');
    const stand = standText(daten.stand);
    $('#stand').textContent = stand;
    $('#stand-fuss').textContent = stand;
  }

  let nachladeTimer = 0;
  let nachladeLaeuft = false;

  /** Solange Änderungen offen sind: data.json regelmäßig neu laden. */
  function starteNachladen() {
    clearTimeout(nachladeTimer);
    if (!zustand.offen.length) return;
    const juengste = Math.max(...zustand.offen.map((o) => o.zeit));
    if (Date.now() - juengste > NACHLADEN_MAX_MS) return;
    nachladeTimer = setTimeout(async () => {
      if (document.visibilityState === 'visible') await ladeNeu();
      starteNachladen();
    }, NACHLADEN_MS);
  }

  async function ladeNeu() {
    if (nachladeLaeuft || !zustand.daten) return;
    nachladeLaeuft = true;
    try {
      const daten = await holeDaten(true);
      if (daten.stand === zustand.daten.stand) return;
      const warteten = zustand.eigene.filter((e) => e.art === 'wartet').map((e) => e.schluessel);
      const topNeu = JSON.stringify(daten.serien) !== JSON.stringify(zustand.daten.serien);
      uebernimmDaten(daten);
      bereinigeOffen();
      if (topNeu) rendereTop();
      rendereEigene();
      baueDienstFilter();
      aktualisiereFortschritt();
      wendeFilterAn();
      const fertig = zustand.eigene.filter((e) => warteten.includes(e.schluessel) && e.art !== 'wartet');
      if (fertig.length === 1) meldung(`Die Daten für „${anzeigeTitel(fertig[0])}“ sind da.`);
      else if (fertig.length > 1) meldung(`Die Daten für ${fertig.length} Serien sind da.`);
    } catch {
      /* nächster Versuch beim nächsten Mal */
    } finally {
      nachladeLaeuft = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  function verbindeSteuerung() {
    // Tabs (Pfeiltasten wechseln wie bei Registerkarten üblich)
    const tabs = [...document.querySelectorAll('.tab')];
    for (const knopf of tabs) {
      knopf.addEventListener('click', () => zeigeTab(knopf.id === 'tab-eigene' ? 'eigene' : 'top'));
      knopf.addEventListener('keydown', (e) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        const ziel = e.key === 'Home' ? 'top' : e.key === 'End' ? 'eigene' : zustand.tab === 'top' ? 'eigene' : 'top';
        zeigeTab(ziel, { fokus: true });
      });
    }

    let suchTimer = 0;
    $('#suche').addEventListener('input', (e) => {
      clearTimeout(suchTimer);
      suchTimer = setTimeout(() => {
        zustand.suche = e.target.value;
        wendeFilterAn();
      }, 120);
    });
    for (const knopf of document.querySelectorAll('.status-filter .chip')) {
      knopf.addEventListener('click', () => {
        const art = knopf.dataset.status;
        zustand.filter[art] = !zustand.filter[art];
        aktualisiereStatusKnoepfe();
        wendeFilterAn();
      });
    }
    verbindeDienstFilter();
    $('#filter-zuruecksetzen').addEventListener('click', setzeFilterZurueck);
    $('#export-knopf').addEventListener('click', exportiere);
    $('#import-knopf').addEventListener('click', () => $('#import-datei').click());
    $('#import-datei').addEventListener('change', async (e) => {
      const datei = e.target.files && e.target.files[0];
      e.target.value = '';
      if (datei) await importiere(datei);
    });

    // Serie hinzufügen
    $('#hinzu-knopf').addEventListener('click', oeffneHinzuDialog);
    $('#hinzu-schliessen').addEventListener('click', () => $('#hinzu-dialog').close());
    $('#hinzu-suche').addEventListener('input', (e) => sucheSerien(e.target.value));
    $('#hinzu-suche').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.target.blur(); // schließt am Handy die Tastatur, damit alle Treffer zu sehen sind
      }
    });
    // Ein Tipp neben das Blatt schließt es
    $('#hinzu-dialog').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) e.currentTarget.close();
    });

    // GitHub-Verbindung
    $('#github-form').addEventListener('submit', (e) => {
      e.preventDefault();
      verbinde();
    });
    $('#github-abbrechen').addEventListener('click', () => {
      nachVerbindung = null;
      $('#github-dialog').close();
    });
    $('#github-trennen').addEventListener('click', trenne);
    $('#github-dialog').addEventListener('close', () => {
      nachVerbindung = null;
    });

    // Änderungen aus einem anderen Tab desselben Browsers übernehmen
    window.addEventListener('storage', (e) => {
      if (e.key === SPEICHER.markierungen) {
        zustand.status = ladeStatus();
        aktualisiereAlleKarten();
      } else if (e.key === SPEICHER.offen) {
        zustand.offen = ladeOffen();
        rendereEigene();
        starteNachladen();
      } else if (e.key === SPEICHER.github) {
        aktualisiereVerbindung();
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && zustand.offen.length) ladeNeu();
    });
  }

  /** Fehlt das TMDB-Logo, steht dort der Schriftzug „TMDB“. */
  function pruefeTmdbLogo() {
    const logo = $('#tmdb-logo');
    const ersatz = () => {
      logo.hidden = true;
      $('#tmdb-logo-text').hidden = false;
    };
    logo.addEventListener('error', ersatz);
    if (logo.complete && logo.naturalWidth === 0 && logo.getAttribute('src')) ersatz();
  }

  function zeigeLadefehler(fehler) {
    const box = $('#ladefehler');
    box.hidden = false;
    box.textContent =
      location.protocol === 'file:'
        ? 'Die Seite wurde direkt als Datei geöffnet. So darf der Browser data/data.json nicht laden. Öffne die Seite über GitHub Pages oder über einen lokalen Webserver (siehe README).'
        : `data/data.json konnte nicht geladen werden (${fehler.message}). Lade die Seite in ein paar Minuten neu. Bleibt der Fehler, prüfe im Repository unter „Actions“, ob der letzte Lauf erfolgreich war.`;
    $('#treffer').textContent = '';
    $('#fortschritt-text').textContent = 'Markierungen nicht verfügbar';
    $('#stand').textContent = '–';
  }

  function startTab() {
    if (location.hash === '#eigene') return 'eigene';
    if (/^#platz-\d+$/.test(location.hash)) return 'top';
    return lese(SPEICHER.tab) === 'eigene' ? 'eigene' : 'top';
  }

  async function start() {
    zustand.status = ladeStatus();
    zustand.offen = ladeOffen();
    verbindeSteuerung();
    pruefeTmdbLogo();
    try {
      uebernimmDaten(await holeDaten(false));
      uebernimmAltenStand();
      bereinigeOffen();
      rendereTop();
      rendereEigene();
      aktualisiereVerbindung();
      aktualisiereStatusKnoepfe();
      zeigeTab(startTab(), { merken: false });
      if (/^#platz-\d+$/.test(location.hash)) document.getElementById(location.hash.slice(1))?.scrollIntoView();
      starteNachladen();
    } catch (fehler) {
      zeigeLadefehler(fehler);
    }
  }

  start();
})();

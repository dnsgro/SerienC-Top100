/*
 * Die 100 besten Serien – Frontend
 * Reines JavaScript ohne Framework und ohne Build-Schritt.
 * Lädt ausschließlich data/data.json; Poster und Logos kommen von image.tmdb.org.
 * Der Gesehen-Stand liegt nur im localStorage dieses Browsers.
 */
(() => {
  'use strict';

  const DATEN_URL = 'data/data.json';
  const SPEICHER_KEY = 'serien-top100:gesehen';
  const BILD_URL = 'https://image.tmdb.org/t/p/';

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

  const zustand = {
    serien: [],
    gesehen: new Set(), // Plätze (1–100)
    filter: 'alle', // alle | gesehen | offen
    anbieter: '', // Schlüssel eines Streamingdienstes oder leer
    suche: '',
    karten: new Map(), // Platz → <li>
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

  const zahlText = (n) => (Number.isFinite(n) ? ZAHL.format(n) : '–');
  const istSicherUrl = (url) => typeof url === 'string' && /^https:\/\//.test(url);

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

  let meldungTimer = 0;
  function meldung(text) {
    const box = $('#meldung');
    box.textContent = text;
    box.hidden = false;
    clearTimeout(meldungTimer);
    meldungTimer = setTimeout(() => {
      box.hidden = true;
    }, 4500);
  }

  // ---------------------------------------------------------------------------
  // Gesehen-Stand im localStorage
  // ---------------------------------------------------------------------------

  function ladeGesehen() {
    try {
      const roh = localStorage.getItem(SPEICHER_KEY);
      if (!roh) return new Set();
      const daten = JSON.parse(roh);
      const liste = Array.isArray(daten) ? daten : daten?.gesehen;
      return new Set((Array.isArray(liste) ? liste : []).map(Number).filter(Number.isInteger));
    } catch {
      return new Set();
    }
  }

  function speichereGesehen() {
    try {
      const gesehen = [...zustand.gesehen].sort((a, b) => a - b);
      localStorage.setItem(SPEICHER_KEY, JSON.stringify({ version: 1, gesehen }));
      return true;
    } catch {
      meldung('Speichern nicht möglich. Im privaten Modus oder bei blockiertem Speicher geht der Stand beim Schließen verloren.');
      return false;
    }
  }

  function setzeGesehen(platz, istGesehen) {
    if (istGesehen) zustand.gesehen.add(platz);
    else zustand.gesehen.delete(platz);
    speichereGesehen();
    aktualisiereKarte(platz);
    aktualisiereFortschritt();
    if (zustand.filter !== 'alle') wendeFilterAn();
  }

  // ---------------------------------------------------------------------------
  // Karten
  // ---------------------------------------------------------------------------

  function poster(s, index) {
    const anzeigeTitel = s.titelDe || s.titel;
    if (!s.poster) return el('div', { class: 'poster poster-leer' }, 'Kein Poster');
    return el('img', {
      class: 'poster',
      src: `${BILD_URL}w185${s.poster}`,
      srcset: `${BILD_URL}w185${s.poster} 185w, ${BILD_URL}w342${s.poster} 342w`,
      sizes: '(min-width: 760px) 104px, 92px',
      width: 185,
      height: 278,
      loading: index < 3 ? 'eager' : 'lazy',
      decoding: 'async',
      alt: `Poster von ${anzeigeTitel}`,
    });
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
        el('dd', {}, Number.isFinite(s.rt) ? `${s.rt} %` : '–'),
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
          const beschriftung = p.art && p.art !== 'Abo' ? `${name} (${p.art})` : name;
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
      ),
    );
  }

  function baueKarte(s, index) {
    const box = el('input', { type: 'checkbox' });
    box.checked = zustand.gesehen.has(s.platz);
    box.addEventListener('change', () => setzeGesehen(s.platz, box.checked));

    const tmdbUrl = Number.isInteger(s.tmdbId)
      ? `https://www.themoviedb.org/tv/${s.tmdbId}${Number.isInteger(s.staffel) ? `/season/${s.staffel}` : ''}`
      : null;
    const imdbUrl = /^tt\d+$/.test(s.imdbId || '') ? `https://www.imdb.com/title/${s.imdbId}/` : null;

    const karte = el(
      'li',
      { class: 'karte', id: `platz-${s.platz}` },
      el(
        'div',
        { class: 'karte-kopf' },
        poster(s, index),
        el(
          'div',
          {},
          el('span', { class: 'platz' }, el('span', { class: 'sr-only' }, 'Platz '), String(s.platz)),
          el('h2', { class: 'titel' }, s.titelDe ? [s.titelDe, ' ', el('span', { class: 'titel-liste' }, `(${s.titel})`)] : s.titel),
          s.jahre ? el('p', { class: 'jahre' }, jahreText(s.jahre)) : null,
          fakten(s),
          wertungen(s),
        ),
      ),
      el(
        'div',
        { class: 'karte-aktionen' },
        el('label', { class: 'gesehen-schalter' }, box, el('span', {}, 'Gesehen')),
        el(
          'p',
          { class: 'links' },
          tmdbUrl ? el('a', { href: tmdbUrl, target: '_blank', rel: 'noopener' }, 'TMDB') : null,
          imdbUrl ? el('a', { href: imdbUrl, target: '_blank', rel: 'noopener' }, 'IMDb') : null,
        ),
      ),
      beschreibung(s),
      streaming(s),
    );
    karte.classList.toggle('ist-gesehen', box.checked);
    return karte;
  }

  function aktualisiereKarte(platz) {
    const karte = zustand.karten.get(platz);
    if (!karte) return;
    const gesehen = zustand.gesehen.has(platz);
    karte.classList.toggle('ist-gesehen', gesehen);
    const box = karte.querySelector('.gesehen-schalter input');
    if (box) box.checked = gesehen;
  }

  function rendereListe() {
    const liste = $('#liste');
    const fragment = document.createDocumentFragment();
    zustand.karten.clear();
    zustand.serien.forEach((s, index) => {
      const karte = baueKarte(s, index);
      zustand.karten.set(s.platz, karte);
      fragment.append(karte);
    });
    liste.replaceChildren(fragment);
  }

  // ---------------------------------------------------------------------------
  // Fortschritt, Filter, Suche
  // ---------------------------------------------------------------------------

  function anzahlGesehen() {
    return zustand.serien.reduce((summe, s) => summe + (zustand.gesehen.has(s.platz) ? 1 : 0), 0);
  }

  function aktualisiereFortschritt() {
    const gesamt = zustand.serien.length;
    const gesehen = anzahlGesehen();
    $('#fortschritt-text').textContent = `${gesehen} von ${gesamt} gesehen`;
    const balken = $('#fortschritt-balken');
    balken.style.setProperty('--anteil', `${gesamt ? (gesehen / gesamt) * 100 : 0}%`);
    balken.setAttribute('aria-valuenow', String(gesehen));
    balken.setAttribute('aria-valuemax', String(gesamt));
  }

  const anbieterSchluessel = (p) => normal(p?.name);

  function baueAnbieterFilter() {
    const zaehler = new Map();
    for (const s of zustand.serien) {
      for (const p of s.abo || []) {
        const schluessel = anbieterSchluessel(p);
        if (!schluessel) continue;
        const eintrag = zaehler.get(schluessel) || { name: p.name, anzahl: 0 };
        eintrag.anzahl++;
        zaehler.set(schluessel, eintrag);
      }
    }
    const auswahl = $('#filter-anbieter');
    auswahl.length = 1; // nur „Alle Dienste“ behalten
    const sortiert = [...zaehler.entries()].sort((a, b) => b[1].anzahl - a[1].anzahl || a[1].name.localeCompare(b[1].name, 'de'));
    for (const [schluessel, { name, anzahl }] of sortiert) {
      auswahl.append(el('option', { value: schluessel }, `${name} (${anzahl})`));
    }
    auswahl.disabled = sortiert.length === 0;
  }

  function wendeFilterAn() {
    const suche = normal(zustand.suche);
    const sucheZahl = /^\d{1,3}$/.test(zustand.suche.trim()) ? Number(zustand.suche.trim()) : null;
    let sichtbar = 0;
    for (const s of zustand.serien) {
      const gesehen = zustand.gesehen.has(s.platz);
      let passt = zustand.filter === 'alle' || (zustand.filter === 'gesehen' ? gesehen : !gesehen);
      if (passt && zustand.anbieter) passt = (s.abo || []).some((p) => anbieterSchluessel(p) === zustand.anbieter);
      if (passt && (suche || sucheZahl !== null)) passt = s.platz === sucheZahl || (suche !== '' && s._suchtext.includes(suche));
      zustand.karten.get(s.platz).hidden = !passt;
      if (passt) sichtbar++;
    }
    const gesamt = zustand.serien.length;
    const gefiltert = zustand.filter !== 'alle' || zustand.anbieter || zustand.suche.trim();
    $('#treffer').textContent = gefiltert ? `${sichtbar} von ${gesamt} Serien` : `${gesamt} Serien`;
    $('#keine-treffer').hidden = sichtbar > 0 || gesamt === 0;
  }

  function setzeFilterZurueck() {
    zustand.filter = 'alle';
    zustand.anbieter = '';
    zustand.suche = '';
    $('#suche').value = '';
    $('#filter-anbieter').value = '';
    document.querySelector('input[name="status"][value="alle"]').checked = true;
    wendeFilterAn();
  }

  // ---------------------------------------------------------------------------
  // Export und Import
  // ---------------------------------------------------------------------------

  function exportiere() {
    const gesehen = zustand.serien.filter((s) => zustand.gesehen.has(s.platz)).map((s) => ({ platz: s.platz, titel: s.titel }));
    const inhalt = {
      app: 'serien-top-100',
      version: 1,
      exportiert: new Date().toISOString(),
      gesehen,
    };
    const datei = new Blob([`${JSON.stringify(inhalt, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(datei);
    const heute = new Date().toISOString().slice(0, 10);
    const link = el('a', { href: url, download: `serien-gesehen-${heute}.json`, hidden: true });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    meldung(`Exportiert: ${gesehen.length} gesehene ${gesehen.length === 1 ? 'Serie' : 'Serien'}.`);
  }

  function frageImportArt(anzahlDatei) {
    const jetzt = zustand.gesehen.size;
    const text =
      `Die Datei enthält ${anzahlDatei} gesehene ${anzahlDatei === 1 ? 'Serie' : 'Serien'}, auf diesem Gerät sind es ${jetzt}. ` +
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

  async function importiere(datei) {
    let inhalt;
    try {
      inhalt = JSON.parse(await datei.text());
    } catch {
      meldung('Import nicht möglich: Die Datei ist keine gültige JSON-Datei.');
      return;
    }
    const liste = Array.isArray(inhalt) ? inhalt : inhalt?.gesehen;
    if (!Array.isArray(liste)) {
      meldung('Import nicht möglich: In der Datei steht kein Gesehen-Stand.');
      return;
    }
    const nachTitel = new Map(zustand.serien.map((s) => [normal(s.titel), s.platz]));
    const plaetze = new Set(zustand.serien.map((s) => s.platz));
    const neu = new Set();
    let uebersprungen = 0;
    for (const eintrag of liste) {
      let platz = null;
      if (typeof eintrag === 'number') platz = eintrag;
      else if (eintrag && typeof eintrag === 'object') {
        const perTitel = eintrag.titel ? nachTitel.get(normal(eintrag.titel)) : undefined;
        platz = perTitel ?? Number(eintrag.platz);
      }
      if (Number.isInteger(platz) && plaetze.has(platz)) neu.add(platz);
      else uebersprungen++;
    }
    const art = await frageImportArt(neu.size);
    if (!art) return;
    if (art === 'ersetzen') zustand.gesehen = neu;
    else for (const platz of neu) zustand.gesehen.add(platz);
    speichereGesehen();
    for (const s of zustand.serien) aktualisiereKarte(s.platz);
    aktualisiereFortschritt();
    wendeFilterAn();
    const zusatz = uebersprungen ? ` ${uebersprungen} unbekannte Einträge wurden übersprungen.` : '';
    meldung(`Importiert: Jetzt ${anzahlGesehen()} von ${zustand.serien.length} gesehen.${zusatz}`);
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  function verbindeSteuerung() {
    let suchTimer = 0;
    $('#suche').addEventListener('input', (e) => {
      clearTimeout(suchTimer);
      suchTimer = setTimeout(() => {
        zustand.suche = e.target.value;
        wendeFilterAn();
      }, 120);
    });
    for (const knopf of document.querySelectorAll('input[name="status"]')) {
      knopf.addEventListener('change', () => {
        zustand.filter = knopf.value;
        wendeFilterAn();
      });
    }
    $('#filter-anbieter').addEventListener('change', (e) => {
      zustand.anbieter = e.target.value;
      wendeFilterAn();
    });
    $('#filter-zuruecksetzen').addEventListener('click', setzeFilterZurueck);
    $('#export-knopf').addEventListener('click', exportiere);
    $('#import-knopf').addEventListener('click', () => $('#import-datei').click());
    $('#import-datei').addEventListener('change', async (e) => {
      const datei = e.target.files && e.target.files[0];
      e.target.value = '';
      if (datei) await importiere(datei);
    });
    // Änderungen aus einem anderen Tab desselben Browsers übernehmen
    window.addEventListener('storage', (e) => {
      if (e.key !== SPEICHER_KEY) return;
      zustand.gesehen = ladeGesehen();
      for (const s of zustand.serien) aktualisiereKarte(s.platz);
      aktualisiereFortschritt();
      wendeFilterAn();
    });
  }

  function zeigeLadefehler(fehler) {
    const box = $('#ladefehler');
    box.hidden = false;
    box.textContent =
      location.protocol === 'file:'
        ? 'Die Seite wurde direkt als Datei geöffnet. So darf der Browser data/data.json nicht laden. Öffne die Seite über GitHub Pages oder über einen lokalen Webserver (siehe README).'
        : `data/data.json konnte nicht geladen werden (${fehler.message}). Lade die Seite in ein paar Minuten neu. Bleibt der Fehler, prüfe im Repository unter „Actions“, ob der letzte Lauf erfolgreich war.`;
    $('#treffer').textContent = '';
    $('#fortschritt-text').textContent = 'Gesehen-Stand nicht verfügbar';
    $('#stand').textContent = '–';
  }

  async function start() {
    zustand.gesehen = ladeGesehen();
    verbindeSteuerung();
    try {
      const antwort = await fetch(DATEN_URL, { cache: 'no-cache' });
      if (!antwort.ok) throw new Error(`HTTP ${antwort.status}`);
      const daten = await antwort.json();
      if (!Array.isArray(daten?.serien)) throw new Error('unerwartetes Format');
      zustand.serien = daten.serien.filter((s) => Number.isInteger(s?.platz)).sort((a, b) => a.platz - b.platz);
      for (const s of zustand.serien) s._suchtext = normal([s.titel, s.titelDe].filter(Boolean).join(' '));
      const stand = standText(daten.stand);
      $('#stand').textContent = stand;
      $('#stand-fuss').textContent = stand;
      rendereListe();
      baueAnbieterFilter();
      aktualisiereFortschritt();
      wendeFilterAn();
      if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
    } catch (fehler) {
      zeigeLadefehler(fehler);
    }
  }

  start();
})();

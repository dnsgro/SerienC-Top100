#!/usr/bin/env node
/**
 * Update-Skript für „Die 100 besten Serien“
 * =========================================
 * Liest data/series.json (die Top 100) und data/eigene.json (deine eigenen
 * Serien) und holt für jede Serie aktuelle Daten:
 *   • TMDB (Sprache de-DE, Land DE): deutscher Titel, Poster, Beschreibung,
 *     Staffeln, Folgen, Status, IMDb-ID und Streaming-Angebote in Deutschland
 *     (diese Angebotsdaten stammen von JustWatch)
 *   • MDBList: IMDb-Wertung und Rotten-Tomatoes-Tomatometer
 * und schreibt alles mit Zeitstempel nach data/data.json.
 *
 * Eigene Serien trägt die Website über die Suche (TVmaze) ein. Sie kennt dann
 * die TVmaze-, IMDb- und TVDB-Nummer; die passende TMDB-Serie sucht dieses
 * Skript über TMDB („find“). Steht eine Serie schon in den Top 100, verweist
 * der Eintrag nur auf sie.
 *
 * Es werden keine Werte geschätzt: Was eine API nicht liefert, bleibt leer
 * (die Website zeigt dann „–“). Schlägt ein Abruf fehl, bleiben die Werte
 * vom letzten erfolgreichen Lauf stehen.
 *
 * Voraussetzung: Node.js 18 oder neuer. Es werden keine Pakete benötigt.
 *
 * Umgebungsvariablen (im Workflow kommen sie aus den GitHub Secrets):
 *   TMDB_TOKEN       TMDB „API Read Access Token“ (empfohlen) oder der kurze „API Key“
 *   MDBLIST_API_KEY  API-Key von mdblist.com
 *   FORCE_REFRESH    „true“ = Wertungen sofort neu laden (sonst höchstens alle 12 Stunden)
 *   WERTUNGEN_NUR_NEU „true“ = vorhandene Wertungen übernehmen und nur fehlende abfragen.
 *                    Setzt der Workflow bei Läufen nach einer Änderung, damit z. B. eine
 *                    neue eigene Serie schnell erscheint; neu abgefragt wird in der Nacht.
 *
 * Aufruf:
 *   TMDB_TOKEN=… MDBLIST_API_KEY=… node scripts/update.mjs
 *   node scripts/update.mjs --leer   (schreibt data.json nur aus den Listen, ohne API-Abruf)
 */

import { readFile, writeFile, appendFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (Number(process.versions.node.split('.')[0]) < 18) {
  console.error(`Node.js ${process.versions.node} ist zu alt – benötigt wird Version 18 oder neuer.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Einstellungen
// ---------------------------------------------------------------------------

const WURZEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERIEN_DATEI = path.join(WURZEL, 'data', 'series.json');
const EIGENE_DATEI = path.join(WURZEL, 'data', 'eigene.json');
const DATEN_DATEI = path.join(WURZEL, 'data', 'data.json');
const LOGO_DATEI = path.join(WURZEL, 'img', 'tmdb-logo.svg');

// Die drei *_URL-Variablen braucht man nur für Tests mit einem Ersatz-Server.
const TMDB_API = (process.env.TMDB_API_URL || 'https://api.themoviedb.org/3').replace(/\/+$/, '');
const MDBLIST_API = (process.env.MDBLIST_API_URL || 'https://api.mdblist.com').replace(/\/+$/, '');
const TMDB_LOGO_SEITE = process.env.TMDB_LOGO_SEITE_URL || 'https://www.themoviedb.org/about/logos-attribution';

const TMDB_ZUGANG = (process.env.TMDB_TOKEN || '').trim();
const MDBLIST_KEY = (process.env.MDBLIST_API_KEY || '').trim();
const ALLES_NEU = /^(1|true|yes|ja)$/i.test((process.env.FORCE_REFRESH || '').trim());
const NUR_NEUE_WERTUNGEN = /^(1|true|yes|ja)$/i.test((process.env.WERTUNGEN_NUR_NEU || '').trim());
const NUR_LEER = process.argv.includes('--leer');

const SPRACHE = 'de-DE';
const LAND = 'DE';
// MDBList-Wertungen höchstens so oft neu abfragen. Die nächtlichen Läufe liegen rund
// 24 Stunden auseinander – mit 12 Stunden fragt also jeder nächtliche Lauf neu ab.
const WERTUNG_MAX_STUNDEN = 12;
const TMDB_PAUSE_MS = 40; // TMDB erlaubt rund 40 Anfragen pro Sekunde
const IN_ACTIONS = process.env.GITHUB_ACTIONS === 'true';
const USER_AGENT = 'serien-top-100-update (privates, nicht-kommerzielles Projekt)';
// „besitzer/repo“ – im Workflow setzt GitHub die Variable. Die Website speichert
// eigene Serien in genau diesem Repository.
const REPO = /^[\w.-]+\/[\w.-]+$/.test(process.env.GITHUB_REPOSITORY || '') ? process.env.GITHUB_REPOSITORY : null;

// API Read Access Token (JWT, beginnt mit „eyJ“) → Bearer-Header; sonst alter v3-Key
const TMDB_IST_TOKEN = TMDB_ZUGANG.startsWith('eyJ') || TMDB_ZUGANG.split('.').length === 3;
let mdblistPauseMs = 1000; // kostenlose Konten: 1 Anfrage pro Sekunde

const HINWEIS_MDB_KEY = '❌ MDBList lehnt den API-Key ab – bitte das Secret `MDBLIST_API_KEY` prüfen. Die Wertungen vom letzten Lauf bleiben stehen.';
const HINWEIS_MDB_LIMIT = '⚠️ Das Tageslimit von MDBList ist erreicht – die übrigen Wertungen werden bei den nächsten Läufen aktualisiert.';

// ---------------------------------------------------------------------------
// Ausgabe (im GitHub-Workflow als Hinweise/Fehler in der Oberfläche sichtbar)
// ---------------------------------------------------------------------------

const escDaten = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escFeld = (s) => escDaten(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

function info(text) {
  console.log(text);
}
function warnung(text, titel = 'Hinweis') {
  if (IN_ACTIONS) console.log(`::warning title=${escFeld(titel)}::${escDaten(text)}`);
  else console.warn(`⚠️  ${titel}: ${text}`);
}
function fehler(text, titel = 'Fehler') {
  if (IN_ACTIONS) console.log(`::error title=${escFeld(titel)}::${escDaten(text)}`);
  else console.error(`❌ ${titel}: ${text}`);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

class HttpFehler extends Error {
  constructor(status, nachricht, daten = null) {
    super(nachricht);
    this.status = status;
    this.daten = daten;
  }
}

const pause = (ms) => new Promise((fertig) => setTimeout(fertig, ms));

/** Holt JSON. Wiederholt bei Netzwerkfehlern, HTTP 429 und 5xx. */
async function holeJson(url, { headers = {}, versuche = 4, quelle = 'API' } = {}) {
  let letzterFehler = null;
  for (let versuch = 1; versuch <= versuche; versuch++) {
    let antwort;
    try {
      antwort = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...headers },
        signal: AbortSignal.timeout(25_000),
      });
    } catch (e) {
      letzterFehler = new HttpFehler(0, `${quelle}: keine Verbindung (${e.cause?.code || e.name})`);
      if (versuch < versuche) await pause(1500 * versuch);
      continue;
    }
    const text = await antwort.text().catch(() => '');
    let daten = null;
    if (text) {
      try {
        daten = JSON.parse(text);
      } catch {
        daten = null;
      }
    }
    if (antwort.ok) return daten;

    const detail = (daten && (daten.status_message || daten.error || daten.message)) || '';
    letzterFehler = new HttpFehler(antwort.status, `${quelle}: HTTP ${antwort.status}${detail ? ` – ${detail}` : ''}`, daten);
    const wiederholbar = antwort.status === 429 || antwort.status >= 500;
    if (!wiederholbar || versuch === versuche) throw letzterFehler;
    const retryAfter = Number(antwort.headers.get('retry-after'));
    await pause(Math.min(30_000, retryAfter > 0 ? retryAfter * 1000 : 2000 * versuch));
  }
  throw letzterFehler;
}

async function tmdb(pfad, parameter = {}) {
  const url = new URL(TMDB_API + pfad);
  for (const [name, wert] of Object.entries(parameter)) {
    if (wert !== undefined && wert !== null && wert !== '') url.searchParams.set(name, String(wert));
  }
  const headers = {};
  if (TMDB_IST_TOKEN) headers.authorization = `Bearer ${TMDB_ZUGANG}`;
  else url.searchParams.set('api_key', TMDB_ZUGANG);
  const daten = await holeJson(url.href, { headers, quelle: 'TMDB' });
  await pause(TMDB_PAUSE_MS);
  return daten;
}

function mdblistUrl(pfad) {
  const url = new URL(MDBLIST_API + pfad);
  url.searchParams.set('apikey', MDBLIST_KEY);
  return url.href;
}

/** MDBList antwortet bei manchen Fehlern mit HTTP 200 und {"response": false, "error": "…"}. */
function pruefeMdblistAntwort(daten) {
  if (daten && typeof daten === 'object' && !Array.isArray(daten) && daten.response === false) {
    const meldung = String(daten.error || 'unbekannter Fehler');
    if (/limit/i.test(meldung)) throw new HttpFehler(429, `MDBList: ${meldung}`);
    if (/key|auth|token/i.test(meldung)) throw new HttpFehler(401, `MDBList: ${meldung}`);
    throw new HttpFehler(404, `MDBList: ${meldung}`);
  }
  return daten;
}

async function mdblistKonto() {
  const daten = pruefeMdblistAntwort(await holeJson(mdblistUrl('/user'), { quelle: 'MDBList', versuche: 2 }));
  return {
    unterstuetzer: Boolean(daten?.is_supporter),
    limit: zahl(daten?.api_requests),
    genutzt: zahl(daten?.api_requests_count),
  };
}

/** Wertungen einer Serie: erst per TMDB-ID, dann per IMDb-ID. */
async function mdblistWertung(tmdbId, imdbId) {
  const wege = [`/tmdb/show/${tmdbId}/`];
  if (imdbId) wege.push(`/imdb/show/${imdbId}/`);
  let letzterFehler = null;
  for (const weg of wege) {
    await pause(mdblistPauseMs);
    try {
      const daten = pruefeMdblistAntwort(await holeJson(mdblistUrl(weg), { quelle: 'MDBList', versuche: 2 }));
      const wertung = leseWertungen(daten);
      if (wertung) return wertung;
    } catch (e) {
      if ([401, 403, 429].includes(e.status)) throw e;
      letzterFehler = e;
    }
  }
  if (letzterFehler && letzterFehler.status !== 404) throw letzterFehler;
  return { imdb: null, imdbStimmen: null, rt: null, imdbIdMdblist: null };
}

function leseWertungen(daten) {
  if (!daten || typeof daten !== 'object' || Array.isArray(daten)) return null;
  const liste = Array.isArray(daten.ratings) ? daten.ratings : [];
  const finde = (quelle) => liste.find((r) => String(r?.source || '').toLowerCase() === quelle);
  const imdb = finde('imdb');
  const rt = finde('tomatoes'); // Tomatometer (Kritiker); „popcorn“ wäre das Publikum

  let imdbWert = zahl(imdb?.value);
  if (imdbWert !== null && (imdbWert <= 0 || imdbWert > 10)) imdbWert = null;

  let rtWert = zahl(rt?.value);
  if (rtWert === null) rtWert = zahl(rt?.score);
  if (rtWert !== null && (rtWert < 0 || rtWert > 100)) rtWert = null;
  if (rtWert === 0 && !(zahl(rt?.votes) > 0)) rtWert = null; // 0 ohne Kritiken = kein Wert

  const imdbId = daten.ids?.imdb || daten.imdbid || daten.imdb_id || null;
  return {
    imdb: imdbWert === null ? null : Math.round(imdbWert * 10) / 10,
    imdbStimmen: imdbWert === null ? null : zahl(imdb?.votes),
    rt: rtWert === null ? null : Math.round(rtWert),
    imdbIdMdblist: gueltigeImdbId(imdbId),
  };
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

function zahl(wert) {
  if (wert === null || wert === undefined || wert === '') return null;
  const n = typeof wert === 'string' ? Number(wert.replace(',', '.')) : Number(wert);
  return Number.isFinite(n) ? n : null;
}

function gueltigeImdbId(id) {
  return typeof id === 'string' && /^tt\d{5,}$/.test(id) ? id : null;
}

const positiv = (n) => Number.isInteger(n) && n > 0;

/**
 * Fester Schlüssel eines eigenen Eintrags. Die Website rechnet genauso (app.js,
 * eigenerSchluessel). Die TVmaze-Nummer hat Vorrang: So bleibt der Schlüssel –
 * und damit die Gesehen-Markierung – gleich, wenn du später eine tmdb_id ergänzt.
 */
function eigenerSchluessel(e) {
  if (positiv(e?.tvmaze)) return `tvmaze:${e.tvmaze}`;
  if (positiv(e?.tmdb_id)) return `tmdb:${e.tmdb_id}`;
  if (gueltigeImdbId(e?.imdb)) return `imdb:${e.imdb}`;
  if (positiv(e?.tvdb)) return `tvdb:${e.tvdb}`;
  return null;
}

/** Für Vergleiche: ohne Akzente, Satzzeichen und Groß-/Kleinschreibung. */
function normal(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '');
}

/** „The Office (U.S.)“ → „The Office“, „True Detective (Season 1)“ → „True Detective“ */
function grundTitel(titel) {
  return String(titel)
    .replace(/\s*\((?:U\.?\s?S\.?|U\.?\s?K\.?|Season\s+\d+|Staffel\s+\d+)\)\s*$/i, '')
    .trim();
}

function startJahr(jahre) {
  const treffer = String(jahre ?? '').match(/\d{4}/);
  return treffer ? Number(treffer[0]) : null;
}

function jahrAus(datum) {
  const treffer = /^(\d{4})/.exec(datum || '');
  return treffer ? Number(treffer[1]) : null;
}

/** Übersetzung einer Sprache mit nicht-leerem Feld, bevorzugt in der Länderreihenfolge. */
function waehleUebersetzung(liste, sprache, laender, feld) {
  const passend = liste.filter((t) => t?.iso_639_1 === sprache && String(t?.data?.[feld] ?? '').trim());
  for (const land of laender) {
    const treffer = passend.find((t) => t.iso_3166_1 === land);
    if (treffer) return treffer;
  }
  return passend[0] || null;
}

/** Nur ein echter deutscher Titel, der sich vom Listentitel/Originaltitel unterscheidet. */
function deutscherTitel(eintrag, serie, uebersetzungen) {
  const de = waehleUebersetzung(uebersetzungen, 'de', ['DE', 'AT', 'CH'], 'name');
  const name = de?.data?.name?.trim();
  if (!name) return null;
  const en = waehleUebersetzung(uebersetzungen, 'en', ['US', 'GB'], 'name');
  const gleich = new Set(
    [eintrag.titel, grundTitel(eintrag.titel), serie.original_name, en?.data?.name].map(normal).filter(Boolean),
  );
  return gleich.has(normal(name)) ? null : name;
}

/** Deutsche Beschreibung, sonst englische, sonst nichts. */
function beschreibung(serie, uebersetzungen) {
  const de = waehleUebersetzung(uebersetzungen, 'de', ['DE', 'AT', 'CH'], 'overview');
  if (de) return { text: de.data.overview.trim(), sprache: 'de' };
  if (typeof serie.overview === 'string' && serie.overview.trim()) {
    // Mit language=de-DE liefert TMDB hier nur Deutsch oder einen leeren Text.
    return { text: serie.overview.trim(), sprache: 'de' };
  }
  const en = waehleUebersetzung(uebersetzungen, 'en', ['US', 'GB'], 'overview');
  if (en) return { text: en.data.overview.trim(), sprache: 'en' };
  return { text: null, sprache: null };
}

const ABKUERZUNGEN = new Set([
  'bzw', 'ca', 'co', 'dr', 'etc', 'evtl', 'ff', 'fr', 'ggf', 'hr', 'inkl', 'jh', 'jr', 'mio', 'mr', 'mrd',
  'mrs', 'ms', 'nr', 'prof', 'sog', 'sr', 'st', 'str', 'usw', 'vgl', 'vs', 'bspw',
]);

/** Kurzfassung: höchstens 3 Sätze und rund 420 Zeichen. */
function kuerzen(text, maxSaetze = 3, maxZeichen = 420) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const saetze = [];
  let start = 0;
  const grenze = /[.!?…]+["»«“”'’)\]]*\s+(?=["„»«“'(\[]?[A-ZÄÖÜ0-9])/g;
  let treffer;
  while ((treffer = grenze.exec(t))) {
    const bisPunkt = t.slice(start, treffer.index + 1);
    const wort = (bisPunkt.match(/([A-Za-zÄÖÜäöüß]+)\.$/) || [])[1];
    if (wort && (wort.length === 1 || ABKUERZUNGEN.has(wort.toLowerCase()))) continue; // z. B., Dr., J. R.
    if (/(?:^|\s)\d{1,2}\.$/.test(bisPunkt)) continue; // „2. Staffel“, „19. Jahrhundert“
    const ende = treffer.index + treffer[0].length;
    saetze.push(t.slice(start, ende).trim());
    start = ende;
  }
  if (start < t.length) saetze.push(t.slice(start).trim());

  let kurz = '';
  for (const satz of saetze.slice(0, maxSaetze)) {
    if (kurz && kurz.length + 1 + satz.length > maxZeichen) break;
    kurz = kurz ? `${kurz} ${satz}` : satz;
  }
  if (kurz.length > maxZeichen + 80) {
    kurz = `${kurz.slice(0, maxZeichen).replace(/\s+\S*$/, '')} …`;
  }
  return kurz;
}

function statusText(status) {
  if (['Ended', 'Canceled', 'Cancelled'].includes(status)) return 'beendet';
  if (['Returning Series', 'In Production', 'Planned', 'Pilot'].includes(status)) return 'laufend';
  return null;
}

/** Laufzeit für eigene Serien aus den TMDB-Daten, z. B. „1999-2007“ oder „2014-present“. */
function jahreVonTmdb(serie) {
  const start = jahrAus(serie.first_air_date);
  if (!start) return null;
  const status = statusText(serie.status);
  if (status === 'laufend') return `${start}-present`;
  const ende = jahrAus(serie.last_air_date);
  if (status === 'beendet' && ende && ende !== start) return `${start}-${ende}`;
  return String(start);
}

/**
 * Bereits ausgestrahlte Staffeln und Folgen (ohne Specials/Staffel 0 und ohne
 * angekündigte Folgen). Fallback: number_of_seasons / number_of_episodes.
 */
function zaehleFolgen(serie) {
  const staffeln = (serie.seasons || []).filter((s) => Number(s?.season_number) > 0);
  const letzte = serie.last_episode_to_air;
  if (letzte && Number(letzte.season_number) > 0 && staffeln.length) {
    let anzahlStaffeln = 0;
    let anzahlFolgen = 0;
    for (const s of staffeln) {
      const nummer = Number(s.season_number);
      const folgen = Number(s.episode_count) || 0;
      if (nummer < letzte.season_number) {
        anzahlStaffeln++;
        anzahlFolgen += folgen;
      } else if (nummer === letzte.season_number) {
        anzahlStaffeln++;
        const bisher = Number(letzte.episode_number) || 0;
        anzahlFolgen += folgen ? Math.min(bisher, folgen) : bisher;
      }
    }
    if (anzahlStaffeln > 0) return { staffeln: anzahlStaffeln, folgen: anzahlFolgen };
  }
  return { staffeln: zahl(serie.number_of_seasons), folgen: zahl(serie.number_of_episodes) };
}

// ---------------------------------------------------------------------------
// Streamingdienste zusammenfassen
// ---------------------------------------------------------------------------
// JustWatch führt Kanäle anderer Plattformen („HBO Max Amazon Channel“) und
// Tarife mit Werbung („Netflix basic with Ads“) als eigene Anbieter. Auf der
// Website zählt der Dienst selbst: Jede Karte zeigt pro Dienst ein Logo.

/** Endung für Kanäle anderer Plattformen, z. B. „… Amazon Channel“, „… Apple TV channel“ */
const KANAL = /\s+(amazon|apple\s*tv|roku(?:\s+premium)?)\s+channels?$/i;
const KANAL_NAME = { amazon: 'Amazon Channel', appletv: 'Apple TV Channel', roku: 'Roku Channel', rokupremium: 'Roku Channel' };
const WERBETARIF = /\s+(?:(?:basic|standard)\s+)?with\s+ads$/i;

/**
 * Derselbe Dienst unter anderem Namen. Bei Bedarf ergänzen:
 * Schlüssel des Namens (klein, ohne Leer- und Sonderzeichen, „+“ als „plus“)
 * → [Schlüssel des Dienstes, Anzeigename]
 */
const GLEICHER_DIENST = new Map([
  ['wowfiction', ['wow', 'WOW']],
  ['rtlplusmax', ['rtlplus', 'RTL+']],
  ['joynplus', ['joyn', 'Joyn']],
  ['amazonprimevideofree', ['amazonprimevideo', 'Amazon Prime Video']],
]);

const ART_REIHENFOLGE = ['Abo', 'kostenlos', 'kostenlos mit Werbung', 'Leihen', 'Kaufen'];

/** „Paramount+“ und „Paramount Plus“ ergeben denselben Schlüssel. */
const dienstSchluessel = (name) => normal(String(name ?? '').replace(/\+/g, ' plus '));

/**
 * Zerlegt einen Anbieternamen in Dienst und Kanal.
 * rang: 0 = der Dienst selbst, 1 = anderer Name oder Werbetarif, 2 = Kanal einer anderen Plattform
 */
function dienstInfo(anbieterName) {
  let name = String(anbieterName || '').trim();
  let kanal = null;
  let rang = 0;
  const treffer = KANAL.exec(name);
  if (treffer) {
    kanal = KANAL_NAME[normal(treffer[1])] || 'Channel';
    name = name.slice(0, treffer.index).trim();
    rang = 2;
  }
  const ohneWerbung = name.replace(WERBETARIF, '').trim();
  if (ohneWerbung !== name) {
    name = ohneWerbung;
    rang = Math.max(rang, 1);
  }
  let schluessel = dienstSchluessel(name);
  const alias = GLEICHER_DIENST.get(schluessel);
  if (alias) {
    [schluessel, name] = alias;
    rang = Math.max(rang, 1);
  }
  return { schluessel, name, kanal, rang };
}

/** Fasst Anbieter (nach Priorität sortiert, je mit Angebotsart) zu Diensten zusammen. */
function fasseZusammen(eintraege) {
  const dienste = new Map();
  for (const { p, art } of eintraege) {
    const info = dienstInfo(p.provider_name);
    if (!info.schluessel) continue;
    let d = dienste.get(info.schluessel);
    if (!d) {
      d = { schluessel: info.schluessel, rang: Infinity, arten: new Set(), kanaele: new Set(), direkt: false };
      dienste.set(info.schluessel, d);
    }
    // Name und Logo vom Dienst selbst bevorzugen, nicht vom Kanal
    if (info.rang < d.rang) Object.assign(d, { id: p.provider_id, name: info.name, logo: p.logo_path || null, rang: info.rang });
    d.arten.add(art);
    if (info.kanal) d.kanaele.add(info.kanal);
    else d.direkt = true;
  }
  return [...dienste.values()].map((d) => ({
    id: d.id,
    dienst: d.schluessel,
    name: d.name,
    logo: d.logo,
    art: ART_REIHENFOLGE.filter((a) => d.arten.has(a)).join(' oder '),
    ...(d.kanaele.size ? { kanaele: [...d.kanaele], direkt: d.direkt } : {}),
  }));
}

/** Streaming-Angebote für Deutschland: Abo/kostenlos getrennt von Leihen/Kaufen. */
function streaming(daten) {
  const de = daten?.results?.[LAND];
  if (!de) return { abo: [], kaufen: [], streamingLink: null };
  const sammle = (quellen) =>
    quellen
      .flatMap(([feld, art]) => (Array.isArray(de[feld]) ? de[feld] : []).map((p) => ({ p, art })))
      .sort((a, b) => (a.p.display_priority ?? 999) - (b.p.display_priority ?? 999));

  const abo = fasseZusammen(
    sammle([
      ['flatrate', 'Abo'],
      ['free', 'kostenlos'],
      ['ads', 'kostenlos mit Werbung'],
    ]),
  );
  const kaufen = fasseZusammen(
    sammle([
      ['rent', 'Leihen'],
      ['buy', 'Kaufen'],
    ]),
  );
  const link = typeof de.link === 'string' && /^https:\/\//.test(de.link) ? de.link : null;
  return { abo, kaufen, streamingLink: link };
}

/** Einträge im alten Format (vor dem Zusammenfassen gespeichert) nachträglich zusammenfassen. */
function alsDienste(liste) {
  if (!Array.isArray(liste)) return [];
  if (liste.every((p) => p?.dienst)) return liste;
  return fasseZusammen(
    liste.flatMap((p, i) =>
      String(p?.art || 'Abo')
        .split(/\s+(?:\/|oder)\s+/)
        .map((art) => ({ p: { provider_id: p?.id, provider_name: p?.name, logo_path: p?.logo, display_priority: i }, art })),
    ),
  );
}

/**
 * Derselbe Dienst soll auf allen Karten gleich heißen und dasselbe Logo haben –
 * auch wenn eine Serie ihn nur als Kanal einer anderen Plattform anbietet.
 */
function vereinheitlicheDienste(serien) {
  for (const feld of ['abo', 'kaufen']) {
    const varianten = new Map(); // Dienst → Map(Name+Logo → Variante)
    for (const s of serien) {
      s[feld] = alsDienste(s[feld]);
      for (const p of s[feld]) {
        if (!varianten.has(p.dienst)) varianten.set(p.dienst, new Map());
        const proDienst = varianten.get(p.dienst);
        const schluessel = `${p.name}|${p.logo}`;
        const v = proDienst.get(schluessel) || { id: p.id, name: p.name, logo: p.logo, direkt: 0, anzahl: 0 };
        v.anzahl++;
        if (p.direkt !== false) v.direkt++;
        proDienst.set(schluessel, v);
      }
    }
    const bester = new Map();
    for (const [dienst, proDienst] of varianten) {
      const [v] = [...proDienst.values()].sort((a, b) => b.direkt - a.direkt || b.anzahl - a.anzahl);
      bester.set(dienst, v);
    }
    for (const s of serien) {
      for (const p of s[feld]) Object.assign(p, { id: bester.get(p.dienst).id, name: bester.get(p.dienst).name, logo: bester.get(p.dienst).logo });
    }
  }
}

/** Passt die TMDB-ID zum Eintrag? Vergleicht Titel und Startjahr (±1 Jahr). */
function pruefeZuordnung(eintrag, serie, uebersetzungen, tmdbJahr) {
  const meldungen = [];
  const soll = normal(grundTitel(eintrag.titel));
  const namen = [
    serie.name,
    serie.original_name,
    ...uebersetzungen.filter((t) => ['en', 'de'].includes(t?.iso_639_1)).map((t) => t?.data?.name),
  ]
    .map(normal)
    .filter((n) => n.length >= 2);
  const titelPasst = namen.some((n) => n === soll || (n.length >= 3 && (n.includes(soll) || soll.includes(n))));
  if (!titelPasst) meldungen.push(`Titel passt nicht: TMDB nennt die Serie „${serie.name || serie.original_name}“.`);

  const listenJahr = startJahr(eintrag.jahre);
  if (listenJahr && tmdbJahr && Math.abs(listenJahr - tmdbJahr) > 1) {
    meldungen.push(`Jahr passt nicht: bei TMDB ${tmdbJahr}, in der Liste ${listenJahr}.`);
  }
  return meldungen;
}

/** Vorschläge für eine bessere Zuordnung über die TMDB-Suche. */
async function sucheVorschlaege(eintrag) {
  const grund = grundTitel(eintrag.titel);
  const anfragen = [...new Set([grund, grund.split(':')[0].trim()])].filter(Boolean);
  const jahr = eintrag.staffel == null ? startJahr(eintrag.jahre) : null;
  for (const anfrage of anfragen) {
    for (const mitJahr of jahr ? [true, false] : [false]) {
      const antwort = await tmdb('/search/tv', {
        query: anfrage,
        language: 'en-US',
        first_air_date_year: mitJahr ? jahr : undefined,
      });
      const treffer = (antwort?.results || []).slice(0, 3);
      if (treffer.length) {
        return treffer.map((t) => ({ id: t.id, name: t.name || t.original_name, jahr: jahrAus(t.first_air_date) }));
      }
    }
  }
  return [];
}

/**
 * TMDB-ID für eine eigene Serie: über die IMDb- oder TVDB-Nummer aus der
 * TVmaze-Suche, notfalls über Titel und Startjahr (nur bei genau gleichem Titel).
 */
async function findeTmdbId(e) {
  const wege = [];
  if (e.imdb) wege.push([e.imdb, 'imdb_id']);
  if (e.tvdb) wege.push([String(e.tvdb), 'tvdb_id']);
  for (const [id, quelle] of wege) {
    const antwort = await tmdb(`/find/${encodeURIComponent(id)}`, { external_source: quelle });
    const treffer = (antwort?.tv_results || []).find((t) => positiv(t?.id));
    if (treffer) return treffer.id;
  }
  if (e.titel) {
    const antwort = await tmdb('/search/tv', { query: e.titel, language: 'en-US', first_air_date_year: e.jahr ?? undefined });
    const soll = normal(e.titel);
    const treffer = (antwort?.results || []).find((t) => {
      const jahr = jahrAus(t?.first_air_date);
      const titelGleich = [t?.name, t?.original_name].some((n) => normal(n) === soll);
      return positiv(t?.id) && titelGleich && (!e.jahr || !jahr || Math.abs(jahr - e.jahr) <= 1);
    });
    if (treffer) return treffer.id;
  }
  return null;
}

function leererEintrag(eintrag) {
  return {
    platz: eintrag.platz,
    schluessel: Number.isInteger(eintrag.tmdb_id) ? `tmdb:${eintrag.tmdb_id}` : `platz:${eintrag.platz}`,
    titel: eintrag.titel,
    jahre: eintrag.jahre ?? null,
    tmdbId: Number.isInteger(eintrag.tmdb_id) ? eintrag.tmdb_id : null,
    staffel: Number.isInteger(eintrag.staffel) ? eintrag.staffel : null,
    titelDe: null,
    poster: null,
    beschreibung: null,
    kurz: null,
    beschreibungSprache: null,
    staffeln: null,
    folgen: null,
    status: null,
    statusTmdb: null,
    naechsteFolge: null,
    abo: [],
    kaufen: [],
    streamingLink: null,
    imdbId: null,
    tvdbId: null,
    imdb: null,
    imdbStimmen: null,
    rt: null,
    wertungStand: null,
    hinweise: [],
  };
}

// ---------------------------------------------------------------------------
// Eine Serie laden
// ---------------------------------------------------------------------------

async function ladeSerie(eintrag) {
  const s = leererEintrag(eintrag);
  if (!s.tmdbId) {
    s.hinweise.push('Keine gültige TMDB-ID eingetragen.');
    return s;
  }

  const serie = await tmdb(`/tv/${s.tmdbId}`, { language: SPRACHE, append_to_response: 'translations,external_ids' });
  const anbieter = await tmdb(`/tv/${s.tmdbId}/watch/providers`);
  const uebersetzungen = serie?.translations?.translations || [];

  s.titelDe = deutscherTitel(eintrag, serie, uebersetzungen);
  s.poster = serie.poster_path || null;
  s.status = statusText(serie.status);
  s.statusTmdb = serie.status || null;
  const anzahl = zaehleFolgen(serie);
  s.staffeln = anzahl.staffeln;
  s.folgen = anzahl.folgen;
  s.naechsteFolge = serie.next_episode_to_air?.air_date || null;
  s.imdbId = gueltigeImdbId(serie.external_ids?.imdb_id);
  s.tvdbId = positiv(serie.external_ids?.tvdb_id) ? serie.external_ids.tvdb_id : null;
  Object.assign(s, streaming(anbieter));

  // Eigene Serien: Laufzeit von TMDB; fehlt der Titel, den englischen bzw. Originaltitel nehmen
  if (eintrag.eigen) {
    s.jahre = jahreVonTmdb(serie) ?? s.jahre;
    if (!s.titel) {
      const en = waehleUebersetzung(uebersetzungen, 'en', ['US', 'GB'], 'name');
      s.titel = en?.data?.name?.trim() || serie.original_name || serie.name || null;
    }
  }

  let text = beschreibung(serie, uebersetzungen);
  let vergleichsJahr = jahrAus(serie.first_air_date);

  // Einträge, die eine einzelne Staffel meinen: Poster, Beschreibung und
  // Folgenzahl dieser Staffel; Status, Streaming und Wertungen der ganzen Serie.
  if (s.staffel !== null) {
    try {
      const staffel = await tmdb(`/tv/${s.tmdbId}/season/${s.staffel}`, { language: SPRACHE });
      let staffelText = (staffel.overview || '').trim();
      let sprache = staffelText ? 'de' : null;
      if (!staffelText) {
        const staffelEn = await tmdb(`/tv/${s.tmdbId}/season/${s.staffel}`, { language: 'en-US' });
        staffelText = (staffelEn.overview || '').trim();
        sprache = staffelText ? 'en' : null;
      }
      if (staffelText) text = { text: staffelText, sprache };
      if (staffel.poster_path) s.poster = staffel.poster_path;
      s.folgen = Array.isArray(staffel.episodes) ? staffel.episodes.length : null;
      s.staffeln = null;
      s.naechsteFolge = null;
      vergleichsJahr = jahrAus(staffel.air_date) ?? vergleichsJahr;
    } catch (e) {
      if (e.status !== 404) throw e;
      s.hinweise.push(`Staffel ${s.staffel} gibt es bei TMDB nicht – angezeigt werden die Daten der ganzen Serie.`);
    }
  }

  s.beschreibung = text.text || null;
  s.beschreibungSprache = text.text ? text.sprache : null;
  s.kurz = text.text ? kuerzen(text.text) : null;

  if (!eintrag.geprueft) s.hinweise.push(...pruefeZuordnung(eintrag, serie, uebersetzungen, vergleichsJahr));
  return s;
}

// ---------------------------------------------------------------------------
// Dateien
// ---------------------------------------------------------------------------

async function leseListe() {
  let roh;
  try {
    roh = await readFile(SERIEN_DATEI, 'utf8');
  } catch {
    throw new Error('data/series.json wurde nicht gefunden.');
  }
  let json;
  try {
    json = JSON.parse(roh);
  } catch (e) {
    throw new Error(`data/series.json ist kein gültiges JSON (${e.message}). Meist fehlt ein Komma oder ein Anführungszeichen.`);
  }
  const liste = Array.isArray(json) ? json : json?.serien;
  if (!Array.isArray(liste) || liste.length === 0) throw new Error('data/series.json enthält keine Liste „serien“.');

  const plaetze = new Set();
  liste.forEach((e, i) => {
    const wo = `Eintrag ${i + 1}`;
    if (!e || typeof e !== 'object') throw new Error(`data/series.json, ${wo}: kein gültiger Eintrag.`);
    if (!Number.isInteger(e.platz) || e.platz < 1) throw new Error(`data/series.json, ${wo}: „platz“ muss eine ganze Zahl ab 1 sein.`);
    if (plaetze.has(e.platz)) throw new Error(`data/series.json: Platz ${e.platz} kommt doppelt vor.`);
    plaetze.add(e.platz);
    if (typeof e.titel !== 'string' || !e.titel.trim()) throw new Error(`data/series.json, Platz ${e.platz}: „titel“ fehlt.`);
    if (e.tmdb_id !== null && e.tmdb_id !== undefined && !Number.isInteger(e.tmdb_id)) {
      throw new Error(`data/series.json, Platz ${e.platz}: „tmdb_id“ muss eine Zahl ohne Anführungszeichen sein.`);
    }
    if (e.staffel !== undefined && e.staffel !== null && (!Number.isInteger(e.staffel) || e.staffel < 0)) {
      throw new Error(`data/series.json, Platz ${e.platz}: „staffel“ muss eine ganze Zahl sein.`);
    }
  });
  return [...liste].sort((a, b) => a.platz - b.platz);
}

/**
 * Liest data/eigene.json (neueste Serie zuerst). Die Website schreibt diese
 * Datei selbst; ein fehlerhafter Eintrag wird deshalb nur übersprungen.
 * Rückgabe null = Datei unlesbar → die eigenen Serien bleiben auf dem alten Stand.
 */
async function leseEigene() {
  let roh;
  try {
    roh = await readFile(EIGENE_DATEI, 'utf8');
  } catch {
    return []; // noch keine eigenen Serien
  }
  let json;
  try {
    json = JSON.parse(roh);
  } catch (e) {
    fehler(`data/eigene.json ist kein gültiges JSON (${e.message}). Die eigenen Serien bleiben auf dem letzten Stand.`, 'Eigene Serien');
    return null;
  }
  const liste = Array.isArray(json) ? json : json?.serien;
  if (!Array.isArray(liste)) {
    fehler('data/eigene.json enthält keine Liste „serien“. Die eigenen Serien bleiben auf dem letzten Stand.', 'Eigene Serien');
    return null;
  }
  const schluessel = new Set();
  const ergebnis = [];
  liste.forEach((e, i) => {
    const s = e && typeof e === 'object' ? eigenerSchluessel(e) : null;
    if (!s) {
      warnung(`data/eigene.json, Eintrag ${i + 1}: Es fehlt eine gültige Nummer (tvmaze, tmdb_id, imdb oder tvdb). Der Eintrag wird übersprungen.`, 'Eigene Serien');
      return;
    }
    if (schluessel.has(s)) return; // doppelt eingetragen
    schluessel.add(s);
    ergebnis.push({
      schluessel: s,
      tvmaze: positiv(e.tvmaze) ? e.tvmaze : null,
      tmdb_id: positiv(e.tmdb_id) ? e.tmdb_id : null,
      // Nur bei Einträgen, die eine einzelne Staffel meinen (z. B. aus den Top 100 übernommen)
      staffel: Number.isInteger(e.staffel) && e.staffel >= 0 ? e.staffel : null,
      imdb: gueltigeImdbId(e.imdb),
      tvdb: positiv(e.tvdb) ? e.tvdb : null,
      titel: typeof e.titel === 'string' ? e.titel.trim().slice(0, 200) : '',
      jahr: positiv(e.jahr) ? e.jahr : null,
      hinzugefuegt: typeof e.hinzugefuegt === 'string' ? e.hinzugefuegt.slice(0, 40) : null,
    });
  });
  return ergebnis;
}

async function leseAlteDaten() {
  try {
    const json = JSON.parse(await readFile(DATEN_DATEI, 'utf8'));
    return Array.isArray(json?.serien) ? json : null;
  } catch {
    return null;
  }
}

async function schreibeDaten({ stand, serien, eigene, pruefung }) {
  const daten = {
    version: 2,
    stand,
    sprache: SPRACHE,
    land: LAND,
    repo: REPO,
    quellen: {
      tmdb: 'https://www.themoviedb.org',
      streaming: 'JustWatch (über TMDB)',
      wertungen: 'IMDb und Rotten Tomatoes (über MDBList)',
    },
    serien,
    // Eigene Serien in der Reihenfolge von data/eigene.json. Steht eine Serie
    // schon in den Top 100, enthält der Eintrag nur „top“ (den Platz).
    eigene,
    pruefung,
  };
  await mkdir(path.dirname(DATEN_DATEI), { recursive: true });
  await writeFile(DATEN_DATEI, `${JSON.stringify(daten, null, 2)}\n`);
}

/** Lädt einmalig das offizielle TMDB-Logo von der TMDB-Logoseite. */
async function sichereTmdbLogo() {
  try {
    await access(LOGO_DATEI);
    return true; // schon vorhanden
  } catch {
    /* noch nicht vorhanden */
  }
  try {
    const seite = await fetch(TMDB_LOGO_SEITE, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(20_000) });
    if (!seite.ok) throw new Error(`Logoseite: HTTP ${seite.status}`);
    const html = await seite.text();
    const links = [...html.matchAll(/(?:https:\/\/www\.themoviedb\.org)?\/assets\/2\/v4\/logos\/v2\/[a-z0-9_]+-[0-9a-f]{16,}\.svg/g)].map(
      (t) => t[0],
    );
    const wahl = links.find((l) => l.includes('/blue_short-')) || links.find((l) => l.includes('short')) || links[0];
    if (!wahl) throw new Error('kein Logo-Link auf der Logoseite gefunden');
    const url = wahl.startsWith('http') ? wahl : new URL(wahl, TMDB_LOGO_SEITE).href;
    const antwort = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(20_000) });
    const svg = await antwort.text();
    if (!antwort.ok || !/<svg[\s>]/i.test(svg) || svg.length > 300_000) throw new Error('keine gültige SVG-Datei');
    if (/<script|\son[a-z]+\s*=/i.test(svg)) throw new Error('SVG enthält Skripte und wurde verworfen');
    await mkdir(path.dirname(LOGO_DATEI), { recursive: true });
    await writeFile(LOGO_DATEI, svg);
    info(`TMDB-Logo gespeichert (${url}).`);
    return true;
  } catch (e) {
    warnung(
      `Das offizielle TMDB-Logo konnte nicht automatisch geladen werden (${e.message}). Die Website zeigt so lange den Schriftzug „TMDB“. Abhilfe: siehe README, „Häufige Probleme“.`,
      'TMDB-Logo',
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Zusammenfassung (Konsole und GitHub-Job-Summary)
// ---------------------------------------------------------------------------

const DATUM_ZEIT = new Intl.DateTimeFormat('de-DE', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Berlin',
});

const md = (s) => String(s ?? '').replace(/\|/g, '\\|');

async function zusammenfassung({ stand, statistik, pruefung, eigene, hinweiseOben = [] }) {
  const zeilen = ['## Serien-Update', ''];
  if (stand) zeilen.push(`**Stand:** ${DATUM_ZEIT.format(new Date(stand))} Uhr`, '');
  for (const h of hinweiseOben) zeilen.push(`> ${h}`, '');
  if (statistik) {
    zeilen.push(
      '| | |',
      '|---|---|',
      `| TMDB | ${statistik.tmdbOk} von ${statistik.gesamt} Serien aktualisiert${statistik.tmdbAlt ? `, ${statistik.tmdbAlt} vom letzten Lauf übernommen` : ''}${statistik.tmdbFehler ? `, ${statistik.tmdbFehler} ohne Daten` : ''} |`,
    );
    if (eigene) {
      const e = eigene.statistik;
      const teile = [];
      if (e.top) teile.push(`${e.top} aus den Top 100`);
      if (e.ok) teile.push(`${e.ok} aktualisiert`);
      if (e.alt) teile.push(`${e.alt} vom letzten Lauf übernommen`);
      if (e.fehlt) teile.push(`${e.fehlt} ohne Daten`);
      zeilen.push(
        `| Eigene Serien | ${eigene.kaputt ? '⚠️ data/eigene.json ist fehlerhaft – alter Stand bleibt' : `${e.gesamt}${teile.length ? ` (${teile.join(', ')})` : ''}`} |`,
      );
    }
    zeilen.push(
      `| Wertungen (MDBList) | ${statistik.wertungNeu} neu abgerufen, ${statistik.wertungGespeichert} vom letzten Lauf übernommen${statistik.wertungFehlt ? `, ${statistik.wertungFehlt} ohne Wertung` : ''} |`,
      '',
    );
  }
  if (pruefung) {
    if (pruefung.length === 0) {
      zeilen.push('### ✅ Alle Zuordnungen sehen plausibel aus.');
    } else {
      zeilen.push(
        `### ⚠️ Bitte prüfen (${pruefung.length})`,
        '',
        '| Platz | Titel | TMDB-ID | Problem | Vorschläge (ID – Name – Jahr) |',
        '|---:|---|---:|---|---|',
        ...pruefung.map(
          (p) =>
            `| ${p.platz} | ${md(p.titel)} | ${p.tmdbId ?? '–'} | ${md(p.hinweise.join(' '))} | ${
              p.vorschlaege.length ? md(p.vorschlaege.map((v) => `${v.id} – ${v.name} – ${v.jahr ?? '?'}`).join('; ')) : '–'
            } |`,
        ),
        '',
        'So korrigierst du eine Zuordnung: `data/series.json` öffnen → Stift-Symbol → `tmdb_id` ändern → **Commit changes**. ' +
          'Stimmt die Zuordnung trotz Hinweis, setze `"geprueft": true`.',
      );
    }
  }
  if (eigene?.pruefung?.length) {
    zeilen.push(
      '',
      `### ⚠️ Eigene Serien prüfen (${eigene.pruefung.length})`,
      '',
      '| Titel | Eintrag | Problem |',
      '|---|---|---|',
      ...eigene.pruefung.map((p) => `| ${md(p.titel)} | \`${md(p.schluessel)}\` | ${md(p.hinweise.join(' '))} |`),
      '',
      'Abhilfe: `data/eigene.json` öffnen → Stift-Symbol → beim Eintrag `"tmdb_id": 12345` ergänzen (die Zahl aus der TMDB-Adresse) → **Commit changes**.',
    );
  }
  const text = `${zeilen.join('\n')}\n`;
  info(`\n${text}`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, text);
}

// ---------------------------------------------------------------------------
// Wertungen
// ---------------------------------------------------------------------------

/**
 * Wertungen (MDBList) einer Serie setzen: höchstens alle WERTUNG_MAX_STUNDEN
 * neu abfragen, sonst die vom letzten Lauf übernehmen.
 * lauf = { mdb, statistik, hinweiseOben } teilen sich alle Serien eines Laufs.
 */
async function setzeWertung(s, altWertung, lauf, bezeichnung) {
  const { mdb, statistik, hinweiseOben } = lauf;
  const alter = altWertung?.wertungStand ? Date.now() - Date.parse(altWertung.wertungStand) : Infinity;
  const uebernehmeAlt = () => {
    s.imdb = altWertung?.imdb ?? null;
    s.imdbStimmen = altWertung?.imdbStimmen ?? null;
    s.rt = altWertung?.rt ?? null;
    s.wertungStand = altWertung?.wertungStand ?? null;
    // Kannte TMDB keine IMDb-ID, stammt sie von MDBList – auch die bleibt erhalten.
    if (!s.imdbId && gueltigeImdbId(altWertung?.imdbId)) s.imdbId = altWertung.imdbId;
  };
  const nochFrisch = alter < WERTUNG_MAX_STUNDEN * 3_600_000 || NUR_NEUE_WERTUNGEN;
  if (altWertung?.wertungStand && nochFrisch && !ALLES_NEU) {
    uebernehmeAlt();
    statistik.wertungGespeichert++;
  } else if (mdb.aktiv) {
    try {
      const w = await mdblistWertung(s.tmdbId, s.imdbId);
      s.imdb = w.imdb;
      s.imdbStimmen = w.imdbStimmen;
      s.rt = w.rt;
      s.wertungStand = new Date().toISOString();
      if (!s.imdbId && w.imdbIdMdblist) s.imdbId = w.imdbIdMdblist;
      statistik.wertungNeu++;
    } catch (e) {
      if ([401, 403].includes(e.status)) {
        mdb.aktiv = false;
        fehler('MDBList lehnt den API-Key ab. Prüfe das Secret MDBLIST_API_KEY.', 'MDBList-Zugang ungültig');
        hinweiseOben.add(HINWEIS_MDB_KEY);
      } else if (e.status === 429) {
        mdb.aktiv = false;
        warnung('Das Tageslimit von MDBList ist erreicht – für die übrigen Serien bleiben die alten Wertungen stehen.', 'MDBList-Limit');
        hinweiseOben.add(HINWEIS_MDB_LIMIT);
      } else {
        warnung(`${bezeichnung}: Wertung nicht abrufbar (${e.message}).`, 'MDBList');
      }
      uebernehmeAlt();
      if (s.wertungStand) statistik.wertungGespeichert++;
    }
  } else {
    uebernehmeAlt();
    if (s.wertungStand) statistik.wertungGespeichert++;
  }
  if (s.imdb === null && s.rt === null) statistik.wertungFehlt++;
}

// ---------------------------------------------------------------------------
// Eigene Serien
// ---------------------------------------------------------------------------

/** Eigener Eintrag ohne TMDB-Daten – die Website zeigt dann „–“. */
function leererEigenerEintrag(e, tmdbId = null) {
  const s = leererEintrag({ platz: null, titel: e.titel || e.schluessel, jahre: e.jahr ? String(e.jahr) : null, tmdb_id: tmdbId });
  delete s.platz;
  return { ...s, schluessel: e.schluessel, tvmaze: e.tvmaze, hinzugefuegt: e.hinzugefuegt };
}

/** Verweis auf eine Serie der Top 100; deren Daten stehen schon unter „serien“. */
function topVerweis(e, platz, tmdbId) {
  return { schluessel: e.schluessel, tvmaze: e.tvmaze, hinzugefuegt: e.hinzugefuegt, top: platz, tmdbId };
}

/** Holt die Daten der eigenen Serien – genauso wie für die Top 100. */
async function ladeEigene(liste, { top, alt, lauf }) {
  const statistik = { gesamt: 0, top: 0, ok: 0, alt: 0, fehlt: 0 };
  const pruefung = [];
  const bisher = Array.isArray(alt?.eigene) ? alt.eigene : [];
  if (liste === null) {
    return { eigene: bisher, statistik: { ...statistik, gesamt: bisher.length }, pruefung, kaputt: true };
  }

  // Ein Eintrag verweist auf die Top 100, wenn Serie und Staffel übereinstimmen. Ohne „staffel“
  // zählen nur ganze Serien – „True Detective“ ist also nicht „True Detective (Season 1)“.
  const topFuer = (tmdbId, staffel) => top.find((s) => s.tmdbId === tmdbId && (s.staffel ?? null) === staffel) || null;
  const altNachSchluessel = new Map(bisher.filter((x) => x?.schluessel).map((x) => [x.schluessel, x]));
  const eigene = [];

  for (const e of liste) {
    statistik.gesamt++;
    const altEintrag = altNachSchluessel.get(e.schluessel) || null;
    const bezeichnung = `Eigene Serie „${e.titel || e.schluessel}“`;
    const melde = (s, hinweis) => {
      s.hinweise.push(hinweis);
      pruefung.push({ schluessel: e.schluessel, titel: s.titel || e.titel || e.schluessel, hinweise: s.hinweise });
      warnung(`${bezeichnung}: ${s.hinweise.join(' ')}`, 'Eigene Serien');
    };

    // 1. TMDB-ID: eingetragen, vom letzten Lauf bekannt oder über TMDB „find“
    let tmdbId = e.tmdb_id;
    if (!tmdbId && positiv(altEintrag?.tmdbId)) tmdbId = altEintrag.tmdbId;
    if (!tmdbId) {
      try {
        tmdbId = await findeTmdbId(e);
      } catch (fehlerTmdb) {
        const s = leererEigenerEintrag(e);
        melde(s, `Suche bei TMDB fehlgeschlagen: ${fehlerTmdb.message}`);
        eigene.push(s);
        statistik.fehlt++;
        continue;
      }
    }
    if (!tmdbId) {
      const s = leererEigenerEintrag(e);
      melde(s, 'Bei TMDB nicht gefunden.');
      eigene.push(s);
      statistik.fehlt++;
      continue;
    }

    // 2. Steht die Serie schon in den Top 100? Dann nur darauf verweisen.
    const topSerie = topFuer(tmdbId, e.staffel);
    if (topSerie) {
      eigene.push(topVerweis(e, topSerie.platz, tmdbId));
      statistik.top++;
      continue;
    }

    // 3. Daten holen
    const eintrag = { platz: null, titel: e.titel, jahre: e.jahr ? String(e.jahr) : null, tmdb_id: tmdbId, staffel: e.staffel, geprueft: true, eigen: true };
    const gleicheZuordnung = Boolean(altEintrag) && !altEintrag.top && altEintrag.tmdbId === tmdbId;
    let s;
    let wertungAbfragen = true;
    try {
      s = await ladeSerie(eintrag);
      statistik.ok++;
    } catch (fehlerTmdb) {
      if (fehlerTmdb.status === 404) {
        s = leererEigenerEintrag(e, tmdbId);
        melde(s, `TMDB kennt die ID ${tmdbId} nicht.`);
        statistik.fehlt++;
        wertungAbfragen = false;
      } else if (gleicheZuordnung && alt?.stand) {
        s = { ...leererEigenerEintrag(e, tmdbId), ...altEintrag, hinweise: [] };
        statistik.alt++;
        warnung(`${bezeichnung}: ${fehlerTmdb.message} – Daten vom letzten Lauf bleiben stehen.`, 'TMDB');
      } else {
        s = leererEigenerEintrag(e, tmdbId);
        melde(s, `Abruf fehlgeschlagen: ${fehlerTmdb.message}`);
        statistik.fehlt++;
      }
    }
    if (s.tmdbId && wertungAbfragen) await setzeWertung(s, gleicheZuordnung ? altEintrag : null, lauf, bezeichnung);

    delete s.platz;
    delete s.top;
    eigene.push({ ...s, schluessel: e.schluessel, tvmaze: e.tvmaze, hinzugefuegt: e.hinzugefuegt });
    info(`✓ eigen  ${s.titel}${s.titelDe ? ` → ${s.titelDe}` : ''}`);
  }
  return { eigene, statistik, pruefung, kaputt: false };
}

// ---------------------------------------------------------------------------
// Hauptprogramm
// ---------------------------------------------------------------------------

async function main() {
  const liste = await leseListe();
  const eigeneListe = await leseEigene();
  const alt = await leseAlteDaten();
  const altNachPlatz = new Map((alt?.serien || []).map((s) => [s.platz, s]));

  if (NUR_LEER) {
    const serien = liste.map(leererEintrag);
    const eigene = (eigeneListe || []).map((e) => {
      const top = e.tmdb_id ? liste.find((t) => t.tmdb_id === e.tmdb_id && (t.staffel ?? null) === e.staffel) : null;
      return top ? topVerweis(e, top.platz, e.tmdb_id) : leererEigenerEintrag(e, e.tmdb_id);
    });
    await schreibeDaten({ stand: null, serien, eigene, pruefung: [] });
    info(`data/data.json ohne API-Daten geschrieben (${serien.length} Serien, ${eigene.length} eigene).`);
    return;
  }

  const hinweiseOben = new Set();
  if (!(await sichereTmdbLogo())) {
    hinweiseOben.add('ℹ️ Das TMDB-Logo fehlt noch, die Website zeigt so lange den Schriftzug „TMDB“ (README, „Häufige Probleme“).');
  }

  if (!TMDB_ZUGANG) {
    warnung(
      'Das Secret TMDB_TOKEN fehlt. data.json bleibt unverändert. Lege das Secret an (README, Schritt 4) und starte den Workflow erneut.',
      'TMDB-Zugang fehlt',
    );
    if (!alt) await schreibeDaten({ stand: null, serien: liste.map(leererEintrag), eigene: [], pruefung: [] });
    await zusammenfassung({ hinweiseOben: ['⚠️ Secret `TMDB_TOKEN` fehlt – es wurden keine Daten abgerufen.', ...hinweiseOben] });
    return;
  }

  try {
    await tmdb('/configuration');
  } catch (e) {
    if (e.status === 401) {
      fehler(
        'TMDB lehnt den Zugang ab (HTTP 401). Prüfe im Secret TMDB_TOKEN, ob der „API Read Access Token“ vollständig und ohne Leerzeichen eingetragen ist.',
        'TMDB-Zugang ungültig',
      );
      process.exitCode = 1;
      return;
    }
    throw e;
  }

  const mdb = { aktiv: Boolean(MDBLIST_KEY) };
  if (!mdb.aktiv) {
    warnung('Das Secret MDBLIST_API_KEY fehlt – Wertungen werden nicht aktualisiert.', 'MDBList-Zugang fehlt');
    hinweiseOben.add('⚠️ Secret `MDBLIST_API_KEY` fehlt – die Wertungen wurden nicht aktualisiert.');
  } else {
    try {
      const konto = await mdblistKonto();
      mdblistPauseMs = konto.unterstuetzer ? 250 : 1000;
      if (konto.limit !== null) info(`MDBList: heute ${konto.genutzt ?? '?'} von ${konto.limit} Anfragen genutzt.`);
    } catch (e) {
      if ([401, 403].includes(e.status)) {
        mdb.aktiv = false;
        fehler('MDBList lehnt den API-Key ab. Prüfe das Secret MDBLIST_API_KEY. Alte Wertungen bleiben erhalten.', 'MDBList-Zugang ungültig');
        hinweiseOben.add(HINWEIS_MDB_KEY);
      } else if (e.status === 429) {
        mdb.aktiv = false;
        warnung('Das Tageslimit von MDBList ist erreicht. Alte Wertungen bleiben erhalten.', 'MDBList-Limit');
        hinweiseOben.add(HINWEIS_MDB_LIMIT);
      } else {
        warnung(`Das MDBList-Konto konnte nicht geprüft werden (${e.message}). Die Wertungen werden trotzdem abgefragt.`, 'MDBList');
      }
    }
  }

  const statistik = {
    gesamt: liste.length,
    tmdbOk: 0,
    tmdbAlt: 0,
    tmdbFehler: 0,
    wertungNeu: 0,
    wertungGespeichert: 0,
    wertungFehlt: 0,
  };
  const lauf = { mdb, statistik, hinweiseOben };
  const ergebnisse = [];
  const pruefung = [];

  for (const eintrag of liste) {
    const altEintrag = altNachPlatz.get(eintrag.platz);
    const gleicheZuordnung =
      Boolean(altEintrag) &&
      altEintrag.tmdbId === (eintrag.tmdb_id ?? null) &&
      (altEintrag.staffel ?? null) === (eintrag.staffel ?? null);

    let s;
    let wertungAbfragen = true;
    try {
      s = await ladeSerie(eintrag);
      statistik.tmdbOk++;
    } catch (e) {
      if (e.status === 404) {
        s = leererEintrag(eintrag);
        s.hinweise.push(`TMDB kennt die ID ${eintrag.tmdb_id} nicht.`);
        statistik.tmdbFehler++;
        wertungAbfragen = false;
      } else if (gleicheZuordnung && alt?.stand) {
        s = { ...leererEintrag(eintrag), ...altEintrag, hinweise: [] };
        statistik.tmdbAlt++;
        warnung(`Platz ${eintrag.platz} (${eintrag.titel}): ${e.message} – Daten vom letzten Lauf bleiben stehen.`, 'TMDB');
      } else {
        s = leererEintrag(eintrag);
        s.hinweise.push(`Abruf fehlgeschlagen: ${e.message}`);
        statistik.tmdbFehler++;
      }
    }

    // Wertungen (MDBList): höchstens alle WERTUNG_MAX_STUNDEN neu abfragen
    if (s.tmdbId && wertungAbfragen) {
      await setzeWertung(s, gleicheZuordnung ? altEintrag : null, lauf, `Platz ${s.platz} (${s.titel})`);
    }

    if (s.hinweise.length) {
      let vorschlaege = [];
      try {
        vorschlaege = await sucheVorschlaege(eintrag);
      } catch {
        vorschlaege = [];
      }
      pruefung.push({ platz: s.platz, titel: s.titel, tmdbId: s.tmdbId, hinweise: s.hinweise, vorschlaege });
      warnung(`Platz ${s.platz} (${s.titel}): ${s.hinweise.join(' ')}`, 'Zuordnung prüfen');
    }

    ergebnisse.push(s);
    info(`✓ ${String(s.platz).padStart(3)}  ${s.titel}${s.titelDe ? ` → ${s.titelDe}` : ''}`);
  }

  if (statistik.tmdbFehler > liste.length / 2) {
    fehler(
      `Bei ${statistik.tmdbFehler} von ${liste.length} Serien ist der TMDB-Abruf fehlgeschlagen. data.json wird zur Sicherheit nicht überschrieben.`,
      'Zu viele Fehler',
    );
    process.exitCode = 1;
    return;
  }

  const eigene = await ladeEigene(eigeneListe, { top: ergebnisse, alt, lauf });

  const stand = new Date().toISOString();
  vereinheitlicheDienste([...ergebnisse, ...eigene.eigene.filter((e) => !e.top)]);
  await schreibeDaten({ stand, serien: ergebnisse, eigene: eigene.eigene, pruefung });
  await zusammenfassung({ stand, statistik, pruefung, eigene, hinweiseOben: [...hinweiseOben] });
}

main().catch((e) => {
  fehler(e.message || String(e), 'Update fehlgeschlagen');
  process.exitCode = 1;
});

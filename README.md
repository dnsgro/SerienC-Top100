# Die 100 besten Serien

Eine statische Website für GitHub Pages. Sie zeigt deine Liste der 100 besten Serien mit Poster, deutscher Kurzbeschreibung, Staffeln und Folgen, Status, Streaming-Angeboten in Deutschland sowie den Wertungen von IMDb und Rotten Tomatoes. Gesehene Serien hakst du ab; der Stand bleibt in deinem Browser gespeichert und lässt sich zwischen Handy und PC übertragen.

**Kosten:** 0 €. GitHub Pages, TMDB und MDBList sind für private, nicht-kommerzielle Nutzung kostenlos.

## So funktioniert es

```
GitHub Actions (jede Nacht, per Knopfdruck oder nach jeder Änderung)
 └─ scripts/update.mjs
     ├─ TMDB-API     → deutscher Titel, Poster, Beschreibung, Staffeln, Folgen,
     │                 Status, IMDb-ID, Streaming-Angebote (Daten von JustWatch)
     └─ MDBList-API  → IMDb-Wertung und Rotten-Tomatoes-Tomatometer
 └─ schreibt data/data.json (mit Zeitstempel) und committet sie
 └─ veröffentlicht die Website auf GitHub Pages

Browser: index.html + style.css + app.js laden nur data/data.json
```

Die API-Keys liegen ausschließlich als verschlüsselte **GitHub Secrets** beim Workflow. Die Website selbst kennt keine Keys – auch nicht in einem öffentlichen Repository.

Nichts davon ist aus dem Gedächtnis eingetragen: Alle Wertungen, Streaming-Angebote, Staffel- und Folgenzahlen kommen per API. Liefert eine API einen Wert nicht, zeigt die Website „–“.

## Dateien

| Datei | Zweck |
|---|---|
| `index.html`, `style.css`, `app.js` | Die Website (reines HTML, CSS und JavaScript, kein Framework, kein Build-Schritt) |
| `fonts/archivo.woff2`, `fonts/OFL.txt` | Schrift „Archivo“ samt Lizenz, lokal eingebunden (keine Google-Fonts-Verbindung) |
| `data/series.json` | Deine Liste: Platz, Titel, Jahre und TMDB-ID – hier korrigierst du Zuordnungen |
| `data/data.json` | Wird vom Workflow erzeugt. Die Datei im Paket ist ein leerer Startstand. |
| `scripts/update.mjs` | Update-Skript (Node.js 18 oder neuer, keine Pakete nötig) |
| `.github/workflows/update.yml` | Zeitplan, Knopf zum Starten, Commit und Veröffentlichung |
| `img/tmdb-logo.svg` | Lädt der Workflow beim ersten Lauf automatisch von themoviedb.org |

## Einrichtung Schritt für Schritt

Plane etwa 20 Minuten ein. Am bequemsten geht es am PC.

### Schritt 1: TMDB-Zugang besorgen

1. Lege auf [themoviedb.org](https://www.themoviedb.org/signup) ein kostenloses Konto an und bestätige deine E-Mail-Adresse.
2. Klicke oben rechts auf dein Profilbild → **Einstellungen**.
3. Wähle in der linken Seitenleiste **API**.
4. Beantrage einen API-Schlüssel als **Developer** (persönliche Nutzung) und akzeptiere die Nutzungsbedingungen. Im Formular reichen zum Beispiel:
   - Anwendungsname: `Serien Top 100`
   - Website: deine spätere Adresse, z. B. `https://DEINNAME.github.io/serien-top100/`
   - Beschreibung: `Private, nicht-kommerzielle Website mit meiner Serienliste`
5. Danach stehen auf derselben Seite zwei Werte: der kurze **API Key** und der sehr lange **API Read Access Token** (beginnt mit `eyJ`). Kopiere den **API Read Access Token**.

Die Felder des Formulars ändert TMDB gelegentlich – wichtig ist am Ende nur der Token. (Notfalls funktioniert auch der kurze API Key.)

### Schritt 2: MDBList-API-Key besorgen

1. Öffne [mdblist.com](https://mdblist.com) und melde dich oben rechts an. Die Seite bietet mehrere Anmeldewege an, zum Beispiel über ein kostenloses Trakt-Konto.
2. Öffne im Menü oben rechts **Preferences**.
3. Erzeuge im Abschnitt **API** einen Key und kopiere ihn.

Das kostenlose Konto erlaubt 1.000 Anfragen pro Tag. Die Website braucht pro Tag rund 100.

### Schritt 3: Repository anlegen

1. Melde dich bei [GitHub](https://github.com) an (oder lege ein kostenloses Konto an).
2. Klicke oben rechts auf **+** → **New repository**.
3. Name: z. B. `serien-top100`. Sichtbarkeit: **Public**.
4. Setze den Haken bei **Add a README file** und klicke **Create repository**.

### Schritt 4: API-Keys als Secrets hinterlegen

1. Im Repository: **Settings** → links **Secrets and variables** → **Actions**.
2. **New repository secret** → Name `TMDB_TOKEN`, Wert: der API Read Access Token aus Schritt 1 → **Add secret**.
3. Noch einmal **New repository secret** → Name `MDBLIST_API_KEY`, Wert: der Key aus Schritt 2 → **Add secret**.

Die Namen müssen exakt so geschrieben sein. Secrets sind verschlüsselt; niemand kann sie später im Repository oder auf der Website lesen.

### Schritt 5: GitHub Pages einschalten

1. **Settings** → links **Pages**.
2. Unter **Build and deployment** bei **Source** die Option **GitHub Actions** wählen.

Wichtig: nicht „Deploy from a branch“. Bei dieser Einstellung würden die nächtlichen Commits des Workflows keine neue Veröffentlichung auslösen.

### Schritt 6: Dateien hochladen

1. Entpacke das ZIP.
2. Im Repository: **Add file** → **Upload files**. Ziehe aus dem entpackten Ordner diese Dateien und Ordner hinein: `index.html`, `style.css`, `app.js`, `README.md`, `.gitignore` sowie die Ordner `data`, `fonts` und `scripts`. Dann **Commit changes**.
3. Der Ordner `.github` ist auf vielen Rechnern versteckt und wird beim Ziehen oft übersprungen. Lege die Workflow-Datei deshalb so an: **Add file** → **Create new file**. Tippe ins Namensfeld genau `.github/workflows/update.yml` (die Schrägstriche legen die Ordner an). Kopiere den Inhalt der Datei `update.yml` aus dem ZIP hinein → **Commit changes**.

Sobald die Workflow-Datei da ist, startet GitHub den ersten Lauf automatisch.

### Schritt 7: Ersten Lauf starten und prüfen

1. Öffne den Tab **Actions**. Erscheint ein Hinweis, Workflows zu aktivieren, bestätige ihn.
2. Links **Daten aktualisieren** wählen → rechts **Run workflow** → Branch `main` → grüner Knopf **Run workflow**. (Läuft schon ein automatisch gestarteter Lauf, kannst du einfach diesen abwarten.)
3. Nach 3 bis 5 Minuten erscheint ein grüner Haken. Klicke auf den Lauf: Unten steht die **Zusammenfassung** mit allen Hinweisen und dem Prüfbericht zu den Zuordnungen.
4. Die Adresse deiner Website steht unter **Settings → Pages** („Your site is live at …“), meist `https://DEINNAME.github.io/serien-top100/`. Bei der allerersten Veröffentlichung kann es ein paar Minuten länger dauern.

Fertig. Ab jetzt aktualisiert sich alles von selbst.

## Zuordnungen prüfen und korrigieren

In `data/series.json` steht jede Serie in einer eigenen Zeile:

```json
{ "platz": 11, "titel": "The Office (U.S.)", "jahre": "2005-2013", "tmdb_id": 2316, "notiz": "US-Fassung; die britische Fassung ist 2996" }
```

- Alle 100 TMDB-IDs wurden am 18.10.2026 einzeln auf themoviedb.org geprüft. Zusätzlich vergleicht das Skript bei jedem Lauf Titel und Startjahr mit TMDB. Passt etwas nicht, steht es in der Zusammenfassung des Laufs unter **Bitte prüfen** – mit Vorschlägen aus der TMDB-Suche.
- **Korrigieren:** `data/series.json` auf GitHub öffnen → Stift-Symbol (Edit) → Zahl bei `tmdb_id` ändern → **Commit changes**. Der Workflow startet automatisch; nach wenigen Minuten ist die Website aktualisiert.
- **Die richtige ID finden:** Serie auf themoviedb.org suchen und öffnen. Die Zahl steht in der Adresse: `themoviedb.org/tv/1396-breaking-bad` → `1396`.
- `"staffel": 1` – der Eintrag meint nur diese Staffel (Platz 35, 47 und 71). Poster, Beschreibung und Folgenzahl kommen dann von dieser Staffel, Status, Streaming und Wertungen von der ganzen Serie.
- `"geprueft": true` – schaltet die automatische Prüfung für diesen Eintrag ab, wenn die Zuordnung trotz Hinweis stimmt.
- `"notiz"` – nur ein Merkzettel für dich, die Website zeigt ihn nicht an.

**Platz 85 – eine Entscheidung für dich:** TMDB führt „The Great British Bake Off“ doppelt: `87012` sind die Channel-4-Jahre ab 2017 (Show läuft noch, aktuelle Streaming-Daten), `34549` die BBC-Jahre 2010–2016 (beendet). Eingetragen ist `87012`. Wenn du die BBC-Jahre willst, trage `34549` ein.

## Gesehen-Stand

- Ein Haken bei **Gesehen** wird sofort im Browser gespeichert (localStorage) und bleibt nach dem Neuladen erhalten.
- Jeder Browser hat seinen eigenen Stand; es gibt keinen Server, der synchronisiert. Im privaten Modus geht der Stand beim Schließen verloren.
- **Auf ein anderes Gerät übertragen:**
  1. Auf Gerät A **Exportieren** antippen. Es entsteht eine Datei wie `serien-gesehen-2026-10-18.json`.
  2. Die Datei zu Gerät B bringen (Mail, Messenger, Cloud-Speicher).
  3. Auf Gerät B **Importieren** antippen und die Datei wählen. **Ersetzen** übernimmt genau den Stand aus der Datei, **Zusammenführen** vereint beide Stände.

## Aktualisierung

- **Automatisch** jede Nacht um 02:17 UTC (03:17 Uhr Winterzeit, 04:17 Uhr Sommerzeit). GitHub startet geplante Läufe manchmal etwas später.
- **Per Knopfdruck:** Actions → Daten aktualisieren → Run workflow. Mit dem Haken „Wertungen sofort neu laden“ fragt das Skript auch die Wertungen sofort neu ab; sonst geschieht das höchstens alle 20 Stunden, um das MDBList-Kontingent zu schonen.
- **Nach jeder Änderung** im Repository (z. B. an `series.json`) läuft der Workflow ebenfalls.
- **Schutz vor dem Abschalten:** GitHub deaktiviert Zeitpläne in öffentlichen Repositories nach 60 Tagen ohne Aktivität. Der Workflow committet jede Nacht eine neue `data.json` und schaltet seinen Zeitplan bei jedem geplanten Lauf zusätzlich per API wieder ein. Falls er trotzdem einmal deaktiviert sein sollte: Actions → Daten aktualisieren → **Enable workflow**.
- **Wenn etwas fehlschlägt:** Schlägt ein einzelner Abruf fehl, bleiben die Werte vom letzten erfolgreichen Lauf stehen. Scheitert mehr als die Hälfte, wird `data.json` gar nicht überschrieben.

## Häufige Probleme

| Problem | Lösung |
|---|---|
| Lauf rot: „TMDB lehnt den Zugang ab (HTTP 401)“ | Secret `TMDB_TOKEN` neu anlegen und den langen API Read Access Token vollständig einfügen, ohne Leerzeichen. |
| Hinweis „Secret … fehlt“ | Schritt 4 prüfen – die Namen müssen exakt `TMDB_TOKEN` und `MDBLIST_API_KEY` lauten. |
| Lauf rot bei „GitHub Pages vorbereiten“ oder „Website veröffentlichen“ | Schritt 5: Source muss **GitHub Actions** sein. Danach den Workflow neu starten. |
| Wertungen bleiben „–“ | In der Zusammenfassung des Laufs steht der Grund (Key falsch, Tageslimit erreicht). Manche Serien haben bei Rotten Tomatoes keinen Tomatometer-Wert. |
| Website zeigt alte Daten | Seite neu laden. Nach einem Lauf braucht GitHub Pages bis zu ein paar Minuten. |
| `index.html` per Doppelklick geöffnet → Fehlermeldung | Browser verbieten das Laden von `data.json` bei `file://`. Lokal testen: im Projektordner `python3 -m http.server 8000` ausführen und `http://localhost:8000` öffnen. |
| Lauf rot: „series.json ist kein gültiges JSON“ | Beim Bearbeiten fehlt meist ein Komma oder ein Anführungszeichen. Die Meldung nennt Zeile und Spalte. |
| Im Footer steht „TMDB“ statt des Logos | Das Skript lädt das Logo beim ersten Lauf von themoviedb.org. Klappt das nicht, lade auf [themoviedb.org/about/logos-attribution](https://www.themoviedb.org/about/logos-attribution) ein Logo als SVG herunter und lade es als `img/tmdb-logo.svg` ins Repository hoch. |

## Lokal ausführen (optional)

```bash
TMDB_TOKEN="dein-token" MDBLIST_API_KEY="dein-key" node scripts/update.mjs
python3 -m http.server 8000
```

Benötigt wird Node.js 18 oder neuer, Pakete sind nicht nötig. Mit `node scripts/update.mjs --leer` erzeugst du eine leere `data.json` nur aus `series.json`.

## Quellen, Regeln und Datenschutz

- **TMDB:** Die Nutzung ist für nicht-kommerzielle Projekte kostenlos. Pflicht ist die Quellenangabe mit TMDB-Logo und dem Hinweis, dass TMDB das Projekt nicht unterstützt oder zertifiziert – beides steht im Footer. Gespeicherte TMDB-Daten dürfen höchstens sechs Monate alt sein; die tägliche Aktualisierung hält das ein.
- **JustWatch:** Die Streaming-Angebote liefert TMDB von JustWatch. JustWatch muss als Quelle genannt werden – das steht in jeder Karte und im Footer.
- **MDBList:** Der kostenlose Zugang erlaubt 1.000 Anfragen pro Tag. Die Wertungen stammen von IMDb und Rotten Tomatoes; deren Logos werden bewusst nicht verwendet.
- **Datenschutz:** Poster und Dienst-Logos lädt der Browser direkt von den Servern von TMDB (`image.tmdb.org`). Die Website selbst liegt bei GitHub Pages. Der Gesehen-Stand verlässt deinen Browser nie, außer du exportierst ihn.

## Anpassen

- **Farben:** oben in `style.css` unter `:root` (hell) und im Block darunter (dunkel).
- **Uhrzeit des Laufs:** Zeile `cron` in `.github/workflows/update.yml` (Zeit in UTC).
- **Andere Liste:** `data/series.json` bearbeiten – Platz, Titel, Jahre und TMDB-ID.
- **Doppelte Streamingdienste:** Kanäle wie „HBO Max Amazon Channel“ oder „Paramount Plus Apple TV channel“ fasst das Skript automatisch mit dem Dienst zusammen; der Hinweis beim Logo nennt sie weiterhin. Taucht derselbe Dienst unter einem anderen Namen auf (z. B. „Wow Fiction“ statt „WOW“), ergänze ihn in `scripts/update.mjs` in der Liste `GLEICHER_DIENST`.

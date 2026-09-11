# Gruppenorganisator

Termine planen, zu-/absagen, kommentieren und abstimmen – für eure Gruppe, gehostet auf Netlify.
Daten liegen in **Netlify Blobs** (in Netlify eingebaut, kein externer Account nötig).

## Funktionen
- **Termine**: anlegen/bearbeiten, Zusage (Dabei / Vielleicht / Nein) mit Notiz, Kommentare, „Wer fehlt noch?“, Export in den Kalender (.ics), Teilen (z. B. WhatsApp), Kosten pro Termin
- **Umfragen**: freie Antworten oder **Terminfindung** (Datum + Uhrzeit), Einzel-/Mehrfachauswahl, eigene Optionen ergänzen, Frist, Beenden/Wieder öffnen, Gewinner-Termin mit einem Klick als Termin anlegen
- **Pinnwand**: Beiträge mit Text, Links und Fotos (werden automatisch verkleinert), Likes, Anpinnen
- **Kosten**: Ausgaben eintragen und auf Personen aufteilen (auf den Cent genau), Salden pro Person, Ausgleichsvorschläge mit möglichst wenigen Überweisungen, „Bezahlt“ markieren
- **App**: auf dem Handy installierbar (Android: „Installieren“-Banner, iPhone: Teilen → Zum Home-Bildschirm), startet auch offline mit dem letzten Stand
- Gruppen-Passwort + Name, Badges für offene Antworten/neue Beiträge, Auto-Aktualisierung, Hell/Dunkel-Modus

## Deploy (ca. 5 Minuten)
> Wichtig: Netlify „Drag & Drop“ unterstützt keine Functions – nutze Git **oder** die Netlify CLI.

**Variante A – GitHub**
1. Ordner in ein GitHub-Repo pushen.
2. Netlify → *Add new site* → *Import an existing project* → Repo wählen. Build-Einstellungen leer lassen (kommen aus `netlify.toml`).
3. *Site configuration → Environment variables*:
   - `GROUP_PASSWORD` = euer gemeinsames Passwort (**Pflicht**)
   - `GROUP_NAME` = z. B. „Stammtisch Freitag“ (optional)
4. *Deploys → Trigger deploy* (damit die Variablen greifen). Fertig – Link an die Gruppe schicken.

**Variante B – Netlify CLI**
```bash
npm install
npx netlify-cli login
npx netlify-cli init            # neue Site anlegen
npx netlify-cli env:set GROUP_PASSWORD "euer-passwort"
npx netlify-cli env:set GROUP_NAME "Unsere Gruppe"
npx netlify-cli deploy --prod
```

Lokal testen: `npx netlify-cli dev` (Blobs werden lokal emuliert; `GROUP_PASSWORD` in einer `.env` setzen).

## Struktur
```
public/index.html           Seite + Dialoge
public/app.js / app.css     App-Logik und Design
public/sw.js                Service Worker (Offline, App-Installation)
public/manifest.webmanifest App-Name, Farben, Icons
public/icons/               App-Icons
netlify/functions/api.mjs   API unter /api/* (Speichern in Netlify Blobs)
netlify.toml                Netlify-Konfiguration
```

## Hinweise
- Namen werden nicht verifiziert – wer das Passwort kennt, kann unter jedem Namen antworten. Für Freundesgruppen passt das, für mehr Sicherheit wären echte Logins nötig.
- Passwort ändern = Env-Variable ändern + neu deployen; alle müssen sich dann neu anmelden.
- Fotos sind über ihre zufällige Adresse (`/api/img/…`) abrufbar, damit sie in der App angezeigt werden können. Wer den genauen Link hat, sieht das Bild auch ohne Passwort.
- Nach einem Update lädt die installierte App die neue Version beim nächsten Öffnen automatisch.

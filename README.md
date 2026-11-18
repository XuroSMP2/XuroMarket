# XuroMarket

Markt-Website für XuroSMP: Auktionshaus, Orders, Durchschnittspreise, Vermögen, Handelsverlauf und RTP-Tracker.

| Seite | Inhalt |
|---|---|
| Übersicht | Kennzahlen, Umsatz 14 Tage, Schnäppchen im AH, gesuchte Items, letzte Trades |
| Auktionshaus | Alle aktiven Angebote, Suche, Sortierung, Vergleich mit dem Durchschnittspreis |
| Orders | Offene Kaufaufträge, Vergleich mit dem Shop-Verkaufspreis |
| Preise | Ø-Preis (gesamt und 7 Tage), 14-Tage-Trend, günstigstes AH, beste Order, Shop-Preise |
| Vermögen | Ranking nach Geld/Stars/Gems/Käufen/Verkäufen, Spielersuche mit gekauften und verkauften Items |
| Handel | Die letzten 200 Trades (Shop, Auktionshaus, Orders) |
| RTP-Tracker | Nutzung pro Dimension und Tag, häufigste Nutzer, letzte RTPs (ohne Koordinaten) |
| Mein Konto | Anmeldung mit dem Minecraft-Account (`/verify <Code>`), danach privates Inventar und Endertruhe |

## Einrichten (Netlify)
1. Netlify: **Add new site -> Import an existing project -> GitHub** -> dieses Repo. Die Einstellungen kommen aus `netlify.toml`.
2. Netlify -> **Environment variables**: `SMPCORE_API_KEY` = derselbe Key wie `web-api.api-key` im Plugin (min. 16 Zeichen).
3. Neu deployen.
4. Im Plugin (`plugins/SMPCore/config.yml`) unter `web-api.push` eintragen:
   ```yaml
   web-api:
     api-key: "DEIN_KEY"
     push:
       enabled: true
       market-url: "https://DEINE-MARKT-SEITE.netlify.app/api/ingest"
   ```
   Danach `/smpcore reload`. Das Plugin sendet die Daten alle 120 Sekunden per HTTPS. Es muss kein Port am Minecraft-Server offen sein.

Sind die Daten älter als 15 Minuten, zeigt die Seite einen Hinweis ("Server offline?").

## Mein Konto: Anmeldung per `/verify`
1. Auf der Seite **Mein Konto -> Mit Minecraft anmelden** klicken: es erscheint ein 6-stelliger Code (gilt 10 Minuten).
2. Im Spiel `/verify CODE` eingeben. Die Seite meldet automatisch an (Sitzung 7 Tage, httpOnly-Cookie).
3. Danach sind **nur für den Spieler selbst** Inventar, Rüstung, Zweithand, Endertruhe und Kontostand sichtbar.
4. `/verify logout` im Spiel beendet alle Sitzungen und löscht die Daten auf der Seite.

Sicherheit: Codes sind zufällig und einmalig, Bestätigung und Datenübertragung nur mit dem API-Key des Plugins, POSTs nur von der eigenen Seite (Origin-Prüfung), Anmelde-Limit pro IP, das Plugin sendet nur Daten verknüpfter Spieler. Das Inventar gibt es nie öffentlich.
Item-Bilder kommen standardmäßig von den kostenlosen Rendermite-Icons (Nodecraft), eingestellt in `public/config.js` (`XM_ICON_CSS`). Lassen sie sich nicht laden, erscheinen automatisch farbige Kacheln mit Kürzel. Alternativ eine eigene Bild-Adresse mit `{id}` bei `XM_ICON_URL` eintragen.

## Technik
- `netlify/functions/ingest.mjs` nimmt die Daten des Plugins entgegen (nur mit Key) und speichert sie in Netlify Blobs.
- `netlify/functions/market.mjs` liefert die Daten an die Seite (`/api/market`).
- `netlify/functions/account.mjs` regelt Anmeldung, Sitzungen und das private Inventar (`/api/auth/*`, `/api/verify`, `/api/revoke`, `/api/inventory`, `/api/me*`).
- `public/` ist die Seite (reines HTML/CSS/JS ohne Build). Alle Texte werden per `textContent` eingefügt.
- Aufgezeichnet wird erst ab dem Update des Plugins. Alte Käufe und Verkäufe fehlen, die Statistik füllt sich mit der Zeit.

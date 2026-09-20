# Monopoly – Entenhausen

Eine browserbasierte Online-Version von **Monopoly** zum Spielen mit Freunden – jede:r auf dem eigenen Handy/Tablet/PC, ein gemeinsamer Server übernimmt Würfeln, Bank, Karten, Auktionen und Miete. Die Straßen und Felder spielen auf **Entenhausen** an (Geldspeicher, Bruchbude, Panzerknacker-Knast, Gustavs Glückswiese, …).

Regelwerk: deutsche Hasbro-Edition 2017 (2–6 Spieler, 1.500 Taler Startkapital, kein Frei-Parken-Jackpot).

## Funktionen

- **Vollständiges Regelwerk** – 40 Felder, Pasch (dritter Pasch = Knast), Knast (Kaution, Freikarte, Pasch), 16 Ereignis- und 16 Gemeinschaftskarten, Steuern, LOS-Gehalt.
- **Kaufen oder Versteigern** – wer nicht kauft, löst eine Auktion aus (Mindestgebot 10 Taler, reihum bieten/passen).
- **Bauen** – gleichmäßiges Bauen, Häuser → Hotel, Bank-Vorrat von 32 Häusern und 12 Hotels, Verkauf zum halben Preis.
- **Hypotheken** – Aufnehmen, Tilgen (+10 % Zinsen), keine Miete auf beliehenen Feldern.
- **Handel** – Grundstücke, Geld und Freikarten tauschen (Gebäude vorher verkaufen); Gegenseite nimmt an oder lehnt ab.
- **Schulden & Pleite** – wer nicht zahlen kann, beschafft Geld oder gibt auf; Besitz geht an den Gläubiger oder wird (bei Bank-Schulden) versteigert.
- **Eigene Karten & Geld immer unten** – jede:r sieht am unteren Bildschirmrand das eigene Bargeld, Vermögen und alle eigenen Grundstücke (antippen für Miettabelle, Bauen, Beleihen). Alle Mitspieler mit Kontostand stehen neben dem Brett.
- **Bots** – füllen die Runde auf, kaufen, bieten, bauen, tauschen (untereinander) und beantworten Handelsangebote.
- Wiederverbindung nach Verbindungsabbruch/Neuladen (Sitzplatz und Besitz bleiben erhalten), getrennte Spieler werden von einem Bot vertreten, der Host kann nach 20 s „Überspringen“.
- Läuft komplett im Speicher – keine Datenbank nötig, ideal für einen Raspberry Pi.

## Dateien

| Datei | Inhalt |
|-------|--------|
| `public/board-data.js` | Felder, Namen, Preise, Mieten (Server **und** Browser nutzen dieselbe Datei) |
| `src/cards.js` | Ereignis- und Gemeinschaftskarten |
| `src/engine.js` | Regeln (reine Spiellogik) |
| `src/bots.js` | Bot-KI |
| `server.js` | Express + Socket.IO, Räume, Lobby, Wiederverbindung |
| `public/` | Oberfläche (Brett, Dock, Handel, Auktion), PWA-Icons |

## Entwicklung

```bash
npm install
npm start          # http://localhost:3000
npm test           # Regeln, 40 Bot-Partien mit Invarianten-Check, Socket-Ablauf
```

## Hausregeln (in der Lobby wählbar)

Der Host kann vor dem Start Regeln ein- oder ausschalten: Frei-Parken-Jackpot, doppeltes Gehalt auf LOS, Auktionen, Miete im Knast und gleichmäßiges Bauen (siehe RULE_DEFAULTS in src/engine.js).

## Spielregeln in der Lobby

Zug-Timer (automatisches Spielen nach 30 s bis 2 min), Spielende nach Zeit oder Runden (Sieger nach Vermögen) und Tempo (normal/schnell) stellt der Host oben bei den Spielregeln ein. Bots haben Charaktere (vorsichtig, mutig, Händler).

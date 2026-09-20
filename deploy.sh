#!/bin/bash
# Deploy-Skript für "Monopoly" auf dem Raspberry Pi (duckpi).
# Holt den neuesten Stand von GitHub und baut/startet die Docker-Container neu.
#
# Einmalig ausführbar machen:
#   chmod +x deploy.sh
#
# Aufruf (im Projektordner, z.B. ~/monopoly):
#   ./deploy.sh

set -e  # bei jedem Fehler sofort abbrechen

echo "==> Hole neuesten Stand von GitHub ..."
git pull --ff-only

echo "==> Baue und starte Container neu (laufende Partien werden dabei beendet, die Clients verbinden sich neu) ..."
docker compose up -d --build

echo "==> Räume alte Images auf ..."
docker image prune -f >/dev/null

echo "==> Fertig. Aktueller Status:"
docker compose ps

echo ""
echo "Logs ansehen mit: docker compose logs -f   (Beenden mit Strg+C)"

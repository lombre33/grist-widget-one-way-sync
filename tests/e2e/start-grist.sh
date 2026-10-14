#!/usr/bin/env bash
# Lance un Grist jetable (image officielle) pour le test d'intégration, crée un utilisateur de
# test, sa clé d'API et un site d'équipe (seul un site d'équipe accepte l'écriture anonyme par
# formulaire). Écrit l'adresse, la clé et l'équipe dans tests/e2e/.env.json.
# Usage : tests/e2e/start-grist.sh   (Docker requis)
set -euo pipefail
PORT=8484
CONTAINER=grist-sync-e2e
EMAIL=test@sync.local
HERE="$(cd "$(dirname "$0")" && pwd)"

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -p "$PORT:8484" \
  -e GRIST_SESSION_SECRET=e2e-only-not-a-secret \
  -e GRIST_IN_SERVICE=true -e GRIST_DEFAULT_EMAIL="$EMAIL" -e GRIST_TEST_LOGIN=1 -e GRIST_ORG_IN_PATH=true \
  -e APP_HOME_URL="http://localhost:$PORT" \
  -e ALLOWED_WEBHOOK_DOMAINS="localhost:$PORT" \
  gristlabs/grist:latest >/dev/null

JAR="$(mktemp)"
KEY=""
for _ in $(seq 1 60); do
  curl -sf -c "$JAR" -b "$JAR" -o /dev/null "http://localhost:$PORT/test/login?username=$EMAIL&name=Test&next=http://localhost:$PORT/" 2>/dev/null || { sleep 2; continue; }
  KEY=$(curl -s -b "$JAR" -X POST -H "X-Requested-With: XMLHttpRequest" "http://localhost:$PORT/api/profile/apiKey" || true)
  [[ "$KEY" =~ ^[0-9a-f]{40}$ ]] && break
  KEY=""; sleep 2
done
[ -n "$KEY" ] || { echo "Grist ne répond pas" >&2; exit 1; }

for _ in $(seq 1 30); do
  ORG=$(curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    "http://localhost:$PORT/api/orgs" -d '{"name":"Synchro test","domain":"synctest"}' || true)
  [[ "$ORG" =~ ^[0-9]+$ ]] && break
  sleep 2
done
printf '{"grist":"http://localhost:%s","apiKey":"%s","team":"synctest","email":"%s","container":"%s"}\n' \
  "$PORT" "$KEY" "$EMAIL" "$CONTAINER" > "$HERE/.env.json"
echo "Grist prêt sur http://localhost:$PORT (équipe synctest)"

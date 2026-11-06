#!/usr/bin/env bash
# Lance un Grist jetable (image officielle) pour le test d'intégration, crée un utilisateur de
# test, sa clé d'API et un site d'équipe (seul un site d'équipe accepte l'écriture anonyme par
# formulaire). Écrit l'adresse, la clé et l'équipe dans tests/e2e/.env.json.
# Usage : tests/e2e/start-grist.sh   (Docker requis ; GRIST_IMAGE=mirror.gcr.io/gristlabs/grist:latest
# si Docker Hub limite les téléchargements)
# Variante des tests de charge (tests/e2e/charge.mjs, CHAOS=1) : un second Grist derrière un mandataire qui
# fait échouer les envois à volonté ; il écoute sur INTERNAL_PORT et le mandataire sur PORT :
#   PORT=8494 INTERNAL_PORT=8493 CONTAINER=grist-sync-chaos ENV_FILE=.env-chaos.json tests/e2e/start-grist.sh
set -euo pipefail
PORT=${PORT:-8484}
INTERNAL_PORT=${INTERNAL_PORT:-$PORT}
CONTAINER=${CONTAINER:-grist-sync-e2e}
ENV_FILE=${ENV_FILE:-.env.json}
EMAIL=test@sync.local
HERE="$(cd "$(dirname "$0")" && pwd)"

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -p "$INTERNAL_PORT:8484" \
  -e GRIST_SESSION_SECRET=e2e-only-not-a-secret \
  -e GRIST_IN_SERVICE=true -e GRIST_DEFAULT_EMAIL="$EMAIL" -e GRIST_TEST_LOGIN=1 -e GRIST_ORG_IN_PATH=true \
  -e APP_HOME_URL="http://localhost:$PORT" \
  -e ALLOWED_WEBHOOK_DOMAINS="localhost:$PORT" \
  ${GRIST_IMAGE:-gristlabs/grist:latest} >/dev/null

# Avec un mandataire (PORT différent du port interne), les envois de webhooks visent http://localhost:$PORT depuis
# l'intérieur du conteneur, où rien n'écoute : un relais (node, déjà dans l'image) les renvoie vers l'hôte.
if [ "$PORT" != "$INTERNAL_PORT" ]; then
  GATEWAY=$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')
  docker exec -d "$CONTAINER" node -e "const n=require('net');n.createServer(c=>{const u=n.connect($PORT,'$GATEWAY');c.pipe(u);u.pipe(c);u.on('error',()=>c.destroy());c.on('error',()=>u.destroy())}).listen($PORT)"
fi

JAR="$(mktemp)"
KEY=""
for _ in $(seq 1 60); do
  curl -sf -c "$JAR" -b "$JAR" -o /dev/null "http://localhost:$INTERNAL_PORT/test/login?username=$EMAIL&name=Test&next=http://localhost:$PORT/" 2>/dev/null || { sleep 2; continue; }
  KEY=$(curl -s -b "$JAR" -X POST -H "X-Requested-With: XMLHttpRequest" "http://localhost:$INTERNAL_PORT/api/profile/apiKey" || true)
  [[ "$KEY" =~ ^[0-9a-f]{40}$ ]] && break
  KEY=""; sleep 2
done
[ -n "$KEY" ] || { echo "Grist ne répond pas" >&2; exit 1; }

for _ in $(seq 1 30); do
  ORG=$(curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    "http://localhost:$INTERNAL_PORT/api/orgs" -d '{"name":"Synchro test","domain":"synctest"}' || true)
  [[ "$ORG" =~ ^[0-9]+$ ]] && break
  sleep 2
done
printf '{"grist":"http://localhost:%s","apiKey":"%s","team":"synctest","email":"%s","container":"%s"}\n' \
  "$PORT" "$KEY" "$EMAIL" "$CONTAINER" > "$HERE/$ENV_FILE"
echo "Grist prêt sur http://localhost:$PORT (équipe synctest)"

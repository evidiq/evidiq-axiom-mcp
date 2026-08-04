#!/usr/bin/env bash
set -euo pipefail

# Production container deployment for EVIDIQ Axiom MCP (port 3022).
# Stateful service: the attestation ledger (receipts, observations, disputes)
# lives on the mounted volume at /data (AXIOM_DB_PATH=/data/axiom.db). The
# container publishes on 127.0.0.1 ONLY — Traefik reaches it over the coolify
# network; a 0.0.0.0 bind would expose the service to the internet directly.
CONTAINER_NAME="evidiq-axiom"
IMAGE_NAME="evidiq-axiom:latest"
ENV_FILE="/root/evidiq-axiom.env"
HOST_PORT="3022"
DATA_DIR="/root/evidiq-axiom-data"

echo "Deploying ${CONTAINER_NAME} on host port ${HOST_PORT}..."

if [ ! -f "${ENV_FILE}" ]; then
  echo "Error: Environment file ${ENV_FILE} not found!"
  exit 1
fi

if [ ! -d "${DATA_DIR}" ]; then
  mkdir -p "${DATA_DIR}"
  chmod 700 "${DATA_DIR}"
  echo "Created data volume ${DATA_DIR}"
fi

docker stop "${CONTAINER_NAME}" 2>/dev/null || true
docker rm "${CONTAINER_NAME}" 2>/dev/null || true

docker run -d \
  --name "${CONTAINER_NAME}" \
  --restart unless-stopped \
  --network coolify \
  --env-file "${ENV_FILE}" \
  -p "127.0.0.1:${HOST_PORT}:3022" \
  -v "${DATA_DIR}:/data" \
  -v "/root/.local/bin/onchainos:/host-bin/onchainos:ro" \
  -v "/root/.onchainos:/root/.onchainos:ro" \
  --label "traefik.enable=true" \
  --label "traefik.http.routers.axiom.rule=Host(\`mcp.evidiq.dev\`) && PathPrefix(\`/axiom\`)" \
  --label "traefik.http.routers.axiom.tls=true" \
  --label "traefik.http.routers.axiom.tls.certresolver=letsencrypt" \
  --label "traefik.http.routers.axiom.middlewares=axiom-strip" \
  --label "traefik.http.middlewares.axiom-strip.stripprefix.prefixes=/axiom" \
  --label "traefik.http.services.axiom.loadbalancer.server.port=3022" \
  "${IMAGE_NAME}"

echo "Started ${CONTAINER_NAME}."
echo "Data volume: ${DATA_DIR} -> /data (AXIOM_DB_PATH=/data/axiom.db)"

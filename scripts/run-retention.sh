#!/bin/bash
# Daily cron entrypoint for local media retention. Runs the retention job
# inside the already-running bridge container (same env vars, same
# filesystem view as the app), so this script needs no config of its own.
#
# Install (on the host, as the user that owns the docker-compose deploy):
#   crontab -e
#   0 3 * * * /opt/WhatsappOperation/scripts/run-retention.sh
set -uo pipefail

LOG_FILE="/var/log/whatsapp-retention.log"
CONTAINER="devaux-whatsapp"

{
  echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) retention run start ==="
  docker exec "$CONTAINER" node dist/retention.js
  status=$?
  echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) retention run end (exit $status) ==="
} >> "$LOG_FILE" 2>&1

exit "$status"

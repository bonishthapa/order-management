#!/usr/bin/env sh
# Restore a backup made by scripts/backup.sh. DESTROYS the current database contents.
#   scripts/restore.sh backups/erp-YYYYmmdd-HHMMSS.dump [backups/media-YYYYmmdd-HHMMSS.tar.gz]
set -eu
DUMP=${1:?usage: scripts/restore.sh <dump> [media.tar.gz]}
MEDIA=${2:-}
printf "This replaces the database with %s. Type RESTORE to continue: " "$DUMP"
read -r answer
[ "$answer" = "RESTORE" ] || { echo "Aborted."; exit 1; }
docker compose stop backend
docker compose exec -T db sh -c 'dropdb -U "$POSTGRES_USER" --if-exists --force "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error' < "$DUMP"
if [ -n "$MEDIA" ]; then
  docker compose start backend
  docker compose exec -T backend sh -c 'rm -rf /app/media/* && tar -xzf - -C /app' < "$MEDIA"
else
  docker compose start backend
fi
echo "Restore complete. Check: curl -s http://localhost:${HTTP_PORT:-8080}/health/ready/"

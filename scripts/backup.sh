#!/usr/bin/env sh
# Logical backup of the PostgreSQL database plus uploaded media.
#   scripts/backup.sh            -> backups/erp-YYYYmmdd-HHMMSS.dump and media-YYYYmmdd-HHMMSS.tar.gz
# Run from the repository root while the compose stack is up. Keep copies off the server.
set -eu
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p backups
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner' > "backups/erp-$STAMP.dump"
docker compose exec -T backend tar -czf - -C /app media > "backups/media-$STAMP.tar.gz"
# Verify the dump is readable before reporting success.
docker compose exec -T db pg_restore --list < "backups/erp-$STAMP.dump" > /dev/null
echo "Backup written: backups/erp-$STAMP.dump, backups/media-$STAMP.tar.gz"

# Backup and restore

## What to back up
1. The PostgreSQL database (all business data, audit trail, sequences).
2. The `media` volume (logos, product images, attachments).
3. Your `.env` (store secrets in a password manager, not with the backups).

## Backup
```bash
scripts/backup.sh
# → backups/erp-YYYYmmdd-HHMMSS.dump   (pg_dump custom format, verified with pg_restore --list)
# → backups/media-YYYYmmdd-HHMMSS.tar.gz
```
Schedule it (e.g. cron `30 1 * * *  cd /srv/erp && scripts/backup.sh`) and copy `backups/` off the server
(object storage with versioning or another host). Keep at least 14 daily and 12 monthly copies, and always one copy
taken right after each year-end close.

## Restore
```bash
scripts/restore.sh backups/erp-20261026-013000.dump backups/media-20261026-013000.tar.gz
```
The script asks you to type `RESTORE`, stops the backend, recreates the database, restores the dump (aborting on
the first error), restores media and restarts. Afterwards: `curl /health/ready/`, sign in, open the dashboard and
run the *Trial balance* report to confirm the totals agree.

## Restore drill (do this quarterly)
1. Start a throw-away stack on another host or with another project name: `docker compose -p erp-drill up -d db`.
2. Restore the latest dump into it (as in `restore.sh`).
3. Run `docker compose -p erp-drill run --rm backend python manage.py check --deploy` and compare the trial
   balance and inventory valuation with production for the same date.
4. Record the drill date and result.

## Point-in-time recovery
For a recovery point objective below one day, enable PostgreSQL WAL archiving (e.g. with pgBackRest or a managed
PostgreSQL service) in addition to the nightly logical dumps.

#!/bin/sh
# Nightly database dump + uploaded files (selfies), kept 14 days in ./backups.
# Also copy ./backups OFF this server (see DEPLOY.md, step 9).
set -eu
sleep 60
while true; do
  d=$(date +%F)
  pg_dump -h db -U postgres -d hxg_connect -Fc -f "/backups/db-$d.dump"
  tar -czf "/backups/uploads-$d.tar.gz" -C /uploads .
  find /backups -type f -mtime +14 -delete
  echo "backup $d done"
  sleep 86400
done

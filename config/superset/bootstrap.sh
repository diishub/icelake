#!/bin/sh
set -eu

superset db upgrade
superset fab create-admin \
  --username "${PSU_ADMIN_USERNAME}" \
  --firstname PSU \
  --lastname Administrator \
  --email psu-admin@localhost \
  --password "${PSU_ADMIN_PASSWORD}" || true
superset init

python /app/pythonpath/bootstrap_users.py
python /app/pythonpath/bootstrap_database.py

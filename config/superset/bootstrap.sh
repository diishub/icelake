#!/bin/sh
set -eu

superset db upgrade
superset init

python /app/pythonpath/bootstrap_users.py
python /app/pythonpath/bootstrap_database.py
python /app/pythonpath/bootstrap_ops_dashboard.py

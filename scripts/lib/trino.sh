# Shared Trino access for the helper scripts. Source it, do not run it.
#
# Trino authenticates now, over TLS with a self-signed certificate, so every
# caller needs three things it did not before: https, a credential, and
# --insecure. Keeping that in one place means swapping in a real certificate
# later is a single edit rather than a hunt through six scripts.
#
# The password reaches the CLI through TRINO_PASSWORD in the exec environment
# rather than on the command line, so it does not show up in a process list.

TRINO_SERVER="${TRINO_SERVER:-https://trino:8443}"

# Reads one credential out of .env by variable name. Callers pass the name,
# never the value, so a password is not sitting in a script argument.
trino_password_for() {
  grep "^$1=" .env | cut -d= -f2-
}

# trino_sql <user> <password> <sql> [extra CLI flags...]
trino_sql() {
  trino_sql_user="$1"
  trino_sql_password="$2"
  trino_sql_statement="$3"
  shift 3
  docker compose exec -T -e TRINO_PASSWORD="${trino_sql_password}" trino \
    trino --server "${TRINO_SERVER}" --insecure \
      --user "${trino_sql_user}" --password \
      "$@" --execute "${trino_sql_statement}" </dev/null 2>&1
}

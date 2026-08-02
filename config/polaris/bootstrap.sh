#!/bin/sh
set -u

log_file=/tmp/polaris-bootstrap.log

if java -jar /deployments/polaris-admin-tool.jar bootstrap \
  --realm="${POLARIS_REALM}" \
  --credential="${POLARIS_REALM},${POLARIS_CLIENT_ID},${POLARIS_CLIENT_SECRET}" \
  >"${log_file}" 2>&1; then
  cat "${log_file}"
  exit 0
else
  status=$?
fi

if grep -Fq 'already been bootstrapped' "${log_file}"; then
  echo "Realm ${POLARIS_REALM} is already bootstrapped"
  exit 0
fi

cat "${log_file}" >&2
exit "${status}"

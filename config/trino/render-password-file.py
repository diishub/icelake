"""Render the Trino password file from the development identities in .env.

Trino has had no authenticator at all until now: it believed whatever username
a client asserted, which is why the stack has been loopback-only and why it
could not be pointed at real data. This closes that.

Runs as a one-shot container on the Superset image, which is the only image in
this stack that already carries a bcrypt implementation. Adding a second image
just to hash six passwords would be a worse trade.

The rendered file lands in the git-ignored runtime directory next to the group
mapping, and no password is ever printed.
"""

import os
import sys

import bcrypt

OUTPUT_PATH = "/output/password.db"
# Trino rejects a bcrypt cost below 8. Ten keeps a login perceptibly cheap
# while leaving the margin the check asks for.
BCRYPT_ROUNDS = 10


def required(name):
    value = os.environ.get(name, "")
    if not value:
        print(f"{name} must be set to render the Trino password file", file=sys.stderr)
        sys.exit(1)
    return value


def identities():
    yield required("PSU_ADMIN_USERNAME"), required("PSU_ADMIN_PASSWORD")
    yield required("PSU_ANALYST_USERNAME"), required("PSU_ANALYST_PASSWORD")
    yield required("TRINO_INGESTION_USERNAME"), required("TRINO_INGESTION_PASSWORD")
    yield required("TRINO_MAINTENANCE_USERNAME"), required("TRINO_MAINTENANCE_PASSWORD")
    # Superset connects under its own name and then impersonates the signed-in
    # user; the policy allows impersonation for this identity alone.
    yield "superset", required("SUPERSET_TRINO_PASSWORD")

    viewer_count = int(required("PSU_VIEWER_COUNT"))
    for index in range(1, viewer_count + 1):
        yield (
            required(f"PSU_VIEWER_{index}_USERNAME"),
            required(f"PSU_VIEWER_{index}_PASSWORD"),
        )


lines = []
seen = set()
for username, password in identities():
    if username in seen:
        print(f"Trino identities must be distinct (duplicate: {username})", file=sys.stderr)
        sys.exit(1)
    seen.add(username)
    hashed = bcrypt.hashpw(
        password.encode("utf-8"), bcrypt.gensalt(rounds=BCRYPT_ROUNDS, prefix=b"2a")
    ).decode("ascii")
    lines.append(f"{username}:{hashed}")

temporary_path = f"{OUTPUT_PATH}.tmp"
with open(temporary_path, "w", encoding="utf-8") as handle:
    handle.write("\n".join(lines) + "\n")
os.chmod(temporary_path, 0o644)
os.replace(temporary_path, OUTPUT_PATH)

print(f"Rendered the Trino password file for {len(lines)} identities")

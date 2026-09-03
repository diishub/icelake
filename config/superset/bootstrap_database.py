import json
import os
from urllib.parse import quote

from superset.app import create_app

# Trino authenticates now, so Superset arrives with a credential of its own
# rather than simply asserting a username. It still impersonates the signed-in
# user for every query -- authentication proves who the connection is,
# impersonation is what decides whose permissions apply.
TRINO_PASSWORD = os.environ["SUPERSET_TRINO_PASSWORD"]

# The certificate is self-signed by this stack, so there is nothing to verify
# it against. The transport is unverified; the identity is not.
ENGINE_EXTRA = json.dumps(
    {"engine_params": {"connect_args": {"http_scheme": "https", "verify": False}}}
)

app = create_app()
with app.app_context():
    from superset import db
    from superset.models.core import Database

    database = (
        db.session.query(Database).filter_by(database_name="PSU Iceberg").one_or_none()
    )
    if database is None:
        database = Database(database_name="PSU Iceberg")
        db.session.add(database)

    database.sqlalchemy_uri = (
        f"trino://superset:{quote(TRINO_PASSWORD, safe='')}@trino:8443/polaris"
    )
    database.extra = ENGINE_EXTRA
    database.impersonate_user = True
    database.expose_in_sqllab = True
    database.allow_ctas = False
    database.allow_cvas = False
    database.allow_dml = False
    db.session.commit()

    print("Superset database PSU Iceberg is configured with user impersonation")

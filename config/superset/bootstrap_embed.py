"""Enable dashboard embedding for the portal's role-specific pages.

Two independent things, both idempotent, same style as bootstrap_users.py /
bootstrap_ops_dashboard.py:

1. Restrict which dashboard(s) may be embedded, and from which origin.
   SUPERSET_EMBED_DASHBOARD_SLUGS names one or more "key=slug" pairs (comma
   separated, e.g. "ops=psu-platform-operations,exec=psu-executive-overview")
   -- the key is what the portal asks for (GET /auth/embeds/<key>), the slug
   is the dashboard's own `dashboard.slug` in Superset. Adding a dashboard
   here later is an env-var edit and a rerun, never a new route in
   services/auth. Only the portal's own AUTH_PUBLIC_ORIGIN may embed any of
   them.
2. A dedicated Superset account used only to mint guest tokens
   (services/auth/src/supersetEmbed.ts calls /api/v1/security/login as this
   account, then /api/v1/security/guest_token/). It is granted exactly one
   permission -- can_grant_guest_token on SecurityRestApi -- and nothing
   else: it cannot read a dashboard, a dataset, or run a query itself. The
   actual data read happens later, impersonated as the *portal account's own*
   Trino identity inside the guest token itself, not as this service account.

This script prints "key=uuid" for each dashboard it enables -- copy those
lines, comma-joined, into SUPERSET_EMBED_DASHBOARDS in .env (see README §6.13).
"""

import os

from superset.app import create_app

EMBED_ROLE_NAME = "PsuGuestTokenIssuer"
PERMISSION_NAME = "can_grant_guest_token"
VIEW_MENU_NAME = "SecurityRestApi"

SERVICE_USERNAME = os.environ.get("SUPERSET_EMBED_SERVICE_USERNAME", "psu-embed")
SERVICE_PASSWORD = os.environ["SUPERSET_EMBED_SERVICE_PASSWORD"]
ALLOWED_ORIGIN = os.environ.get("AUTH_PUBLIC_ORIGIN", "http://localhost:8085")
DASHBOARD_SLUGS_RAW = os.environ.get(
    "SUPERSET_EMBED_DASHBOARD_SLUGS", "ops=psu-platform-operations"
)


def _parse_dashboard_slugs(raw: str) -> dict[str, str]:
    pairs = {}
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry:
            continue
        if "=" not in entry:
            raise RuntimeError(
                f"SUPERSET_EMBED_DASHBOARD_SLUGS entry {entry!r} must be key=slug"
            )
        key, slug = entry.split("=", 1)
        pairs[key.strip()] = slug.strip()
    if not pairs:
        raise RuntimeError("SUPERSET_EMBED_DASHBOARD_SLUGS named no dashboards")
    return pairs


def _ensure_issuer_role(security):
    role = security.find_role(EMBED_ROLE_NAME)
    if role is None:
        role = security.add_role(EMBED_ROLE_NAME)

    permission_view = security.find_permission_view_menu(PERMISSION_NAME, VIEW_MENU_NAME)
    if permission_view is None:
        raise RuntimeError(
            f"Permission {PERMISSION_NAME!r} on {VIEW_MENU_NAME!r} does not exist yet -- "
            "FEATURE_FLAGS['EMBEDDED_SUPERSET'] must be on and `superset init` must have "
            "run at least once (bootstrap.sh already does both before this script)."
        )
    if permission_view not in role.permissions:
        security.add_permission_role(role, permission_view)
    return role


def _ensure_service_account(security, role):
    user = security.find_user(username=SERVICE_USERNAME)
    if user is None:
        user = security.add_user(
            username=SERVICE_USERNAME,
            first_name="PSU",
            last_name="Embed service account",
            email=f"{SERVICE_USERNAME}@localhost",
            role=role,
            password=SERVICE_PASSWORD,
        )
        if user is None:
            raise RuntimeError(f"Could not create Superset account {SERVICE_USERNAME}")
        action = "Created"
    else:
        user.first_name = "PSU"
        user.last_name = "Embed service account"
        user.active = True
        user.roles = [role]
        if security.update_user(user) is False:
            raise RuntimeError(f"Could not update Superset account {SERVICE_USERNAME}")
        security.reset_password(user.id, SERVICE_PASSWORD)
        action = "Reconciled"

    if security.auth_user_db(SERVICE_USERNAME, SERVICE_PASSWORD) is None:
        raise RuntimeError(f"Could not authenticate reconciled account {SERVICE_USERNAME}")
    print(f"{action} Superset account {SERVICE_USERNAME} with role {EMBED_ROLE_NAME}")


def main() -> None:
    app = create_app()
    with app.app_context():
        from superset import db
        from superset.daos.dashboard import EmbeddedDashboardDAO
        from superset.models.dashboard import Dashboard

        security = app.appbuilder.sm

        role = _ensure_issuer_role(security)
        _ensure_service_account(security, role)

        results = []
        for key, slug in _parse_dashboard_slugs(DASHBOARD_SLUGS_RAW).items():
            dashboard = db.session.query(Dashboard).filter_by(slug=slug).one_or_none()
            if dashboard is None:
                # A slug named here but not yet created (e.g. a dashboard
                # whose own bootstrap_*.py hasn't run yet) is skipped rather
                # than failing the whole script -- the ones that do exist
                # should still get embedded.
                print(f"skipping {key!r} ({slug!r}): no such dashboard yet")
                continue
            embedded = EmbeddedDashboardDAO.upsert(dashboard, [ALLOWED_ORIGIN])
            db.session.commit()
            print(f"Dashboard {slug!r} embeddable as {key}={embedded.uuid} from {ALLOWED_ORIGIN!r}")
            results.append(f"{key}={embedded.uuid}")

        if results:
            print(f"SUPERSET_EMBED_DASHBOARDS={','.join(results)}")


if __name__ == "__main__":
    main()

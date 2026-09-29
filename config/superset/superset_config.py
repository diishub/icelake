import os

from flask_appbuilder.security.manager import AUTH_DB


SECRET_KEY = os.environ["SUPERSET_SECRET_KEY"]
SQLALCHEMY_DATABASE_URI = os.environ["SUPERSET_DATABASE_URI"]

# Keep the upstream application intact, but present it as the report workspace
# users expect after entering through PSU Data Hub.
APP_NAME = "PSU Reports"
LOGO_TOOLTIP = "PSU Reports"
LOGO_RIGHT_TEXT = "พื้นที่รายงานมหาวิทยาลัย"
WELCOME_PAGE_LAST_TAB = "all"

AUTH_TYPE = AUTH_DB
AUTH_USER_REGISTRATION = False

# ---------------------------------------------------------------------------
# PSU Passport sign-in
# ---------------------------------------------------------------------------
#
# Off unless SUPERSET_OAUTH_ENABLED is true, so a machine with no registered
# OIDC client keeps the local accounts and starts normally. When it is on,
# database login is replaced rather than added to: two ways in would mean two
# sets of credentials to govern for the same person.
#
# The redirect URI to register with PSU Passport is
#   <SUPERSET_PUBLIC_ORIGIN>/oauth-authorized/psu
# which is a different path from the portal's, so either register both on one
# client or use a second client. Both are normal.
SUPERSET_OAUTH_ENABLED = os.environ.get("SUPERSET_OAUTH_ENABLED", "false").lower() == "true"

if SUPERSET_OAUTH_ENABLED:
    from flask_appbuilder.security.manager import AUTH_OAUTH

    from psu_security_manager import PsuSecurityManager

    def _required(name: str) -> str:
        value = os.environ.get(name, "").strip()
        if not value:
            raise RuntimeError(f"{name} is required when SUPERSET_OAUTH_ENABLED is true")
        return value

    AUTH_TYPE = AUTH_OAUTH
    CUSTOM_SECURITY_MANAGER = PsuSecurityManager

    # A person who has never signed in has no Superset account, so registration
    # has to be on. The role it hands out is the read-only one; it grants no
    # data, because data access is decided by Trino and OPA from the grants in
    # identity.app_user, not by a Superset role.
    AUTH_USER_REGISTRATION = True
    AUTH_USER_REGISTRATION_ROLE = os.environ.get("SUPERSET_OAUTH_DEFAULT_ROLE", "Gamma")

    # Left off deliberately. With role sync on, every promotion an administrator
    # makes in Superset is reverted at the person's next sign-in, because the
    # mapping below is the only input. Turn it on only once PSU Passport
    # actually carries the roles this deployment uses.
    AUTH_ROLES_SYNC_AT_LOGIN = (
        os.environ.get("SUPERSET_OAUTH_ROLE_SYNC", "false").lower() == "true"
    )

    # Read only when role sync is on. The claim is a list of group names from
    # PSU Passport; anything unmapped falls back to the registration role.
    AUTH_ROLES_MAPPING = {
        os.environ.get("SUPERSET_OAUTH_ADMIN_GROUP", "psu-data-hub-admin"): ["Admin"],
        os.environ.get("SUPERSET_OAUTH_ANALYST_GROUP", "psu-data-hub-analyst"): ["Alpha"],
        os.environ.get("SUPERSET_OAUTH_VIEWER_GROUP", "psu-data-hub-viewer"): ["Gamma"],
    }

    OAUTH_PROVIDERS = [
        {
            "name": "psu",
            "icon": "fa-university",
            "token_key": "access_token",
            "remote_app": {
                "client_id": _required("SUPERSET_OAUTH_CLIENT_ID"),
                "client_secret": _required("SUPERSET_OAUTH_CLIENT_SECRET"),
                "server_metadata_url": _required("SUPERSET_OAUTH_ISSUER").rstrip("/")
                + "/.well-known/openid-configuration",
                "api_base_url": _required("SUPERSET_OAUTH_ISSUER").rstrip("/") + "/",
                "client_kwargs": {
                    "scope": os.environ.get("SUPERSET_OAUTH_SCOPE", "openid profile email"),
                    # PKCE on a confidential client costs nothing and removes
                    # code interception from the list of things to worry about.
                    "code_challenge_method": "S256",
                },
            },
        }
    ]

    # The session cookie is what an OAuth login leaves behind, so it gets the
    # same treatment as the portal's.
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    SESSION_COOKIE_SECURE = (
        os.environ.get("SUPERSET_COOKIE_SECURE", "true").lower() == "true"
    )

FEATURE_FLAGS = {
    "DASHBOARD_RBAC": True,
    "CACHE_IMPERSONATION": True,
    # Lets the portal mount a dashboard in an iframe via a short-lived guest
    # token instead of a second Superset login -- see config/superset/
    # bootstrap_embed.py and services/auth/src/supersetEmbed.ts.
    "EMBEDDED_SUPERSET": True,
}

# ---------------------------------------------------------------------------
# Embedded dashboards (guest tokens)
# ---------------------------------------------------------------------------
#
# A guest token names a real portal account's own psu_username as its
# impersonated Trino identity (services/auth/src/supersetEmbed.ts sets
# user.username to that), so an embedded dashboard reads exactly what that
# account's own OPA/Trino grants already allow -- never more. GUEST_ROLE_NAME
# only governs Superset-side UI visibility of the embedded chart, not the row
# data underneath it.
GUEST_TOKEN_JWT_SECRET = os.environ["SUPERSET_GUEST_TOKEN_SECRET"]
GUEST_ROLE_NAME = "Public"

# guest_token is called by services/auth (server to server) with a JWT Bearer
# access token, never a browser session cookie, so it isn't CSRF-able the
# same way a form/cookie-authenticated view is -- the same reasoning behind
# every other entry Superset's own default list already carries (SQL Lab's
# chart data endpoint, dashboard screenshotting, etc). Extends rather than
# replaces the base list, so a Superset upgrade's own additions are not lost.
from superset.config import WTF_CSRF_EXEMPT_LIST as _BASE_CSRF_EXEMPT_LIST  # noqa: E402

WTF_CSRF_EXEMPT_LIST = [*_BASE_CSRF_EXEMPT_LIST, "superset.security.api.guest_token"]

CACHE_CONFIG = {
    "CACHE_TYPE": "RedisCache",
    "CACHE_DEFAULT_TIMEOUT": 300,
    "CACHE_KEY_PREFIX": "psu_superset_",
    "CACHE_REDIS_HOST": "redis",
    "CACHE_REDIS_PORT": 6379,
    "CACHE_REDIS_DB": 1,
}
DATA_CACHE_CONFIG = CACHE_CONFIG

WTF_CSRF_ENABLED = True
TALISMAN_ENABLED = False

# Only trust X-Forwarded-* headers when actually deployed behind the Caddy
# reverse proxy (config/caddy/Caddyfile, "public" Compose profile). Off by
# default so a direct-loopback dev setup never trusts forwarded headers from
# whoever connects directly.
ENABLE_PROXY_FIX = os.environ.get("SUPERSET_BEHIND_PROXY", "false").lower() == "true"
if ENABLE_PROXY_FIX:
    PROXY_FIX_CONFIG = {"x_for": 1, "x_proto": 1, "x_host": 1, "x_port": 1, "x_prefix": 0}
    PREFERRED_URL_SCHEME = "https"
    SESSION_COOKIE_SECURE = True

# Local test mode only. Bind-mounted to localhost in Compose. Replace this with
# PSU SSO JWT validation before exposing MCP outside the workstation.
MCP_AUTH_ENABLED = False
MCP_DEV_USERNAME = os.environ.get("PSU_ANALYST_USERNAME", "analyst")

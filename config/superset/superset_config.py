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

FEATURE_FLAGS = {
    "DASHBOARD_RBAC": True,
    "CACHE_IMPERSONATION": True,
}

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

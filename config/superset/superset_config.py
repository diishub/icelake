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

# Local test mode only. Bind-mounted to localhost in Compose. Replace this with
# PSU SSO JWT validation before exposing MCP outside the workstation.
MCP_AUTH_ENABLED = False
MCP_DEV_USERNAME = os.environ.get("PSU_ANALYST_USERNAME", "analyst")

"""PSU Passport sign-in for Superset.

Flask-AppBuilder does the OAuth flow through Authlib; what it cannot know is
which claim carries a PSU username, or that this deployment treats the PSU
directory rather than the token as the authority on whether someone is a
student or staff. Both of those live here.

Nothing in this module decides what a person may *read*. Superset roles govern
the Superset UI; the data itself is governed by Trino and OPA, which read the
grants recorded in identity.app_user. A person who signs in without a grant can
open Superset and will be denied by Trino on the first query, which is the
intended order: authentication first, authorisation separately.
"""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
import urllib.error
import urllib.request

from superset.security import SupersetSecurityManager


logger = logging.getLogger(__name__)

# PSU usernames reach Trino as an identity and are rendered into a group file,
# so anything outside this shape is refused rather than sanitised.
USERNAME_PATTERN = re.compile(r"^[a-z0-9._-]{1,64}$")


def _claim(payload: dict, name: str) -> str:
    value = payload.get(name)
    if isinstance(value, str) and value.strip():
        return value.strip()
    if isinstance(value, (int, float)):
        return str(value)
    return ""


def _psu_username(raw: str) -> str:
    """The bare username. PSU Passport hands out the full address."""
    return raw.split("@")[0].strip().lower()


class PsuSecurityManager(SupersetSecurityManager):
    """Maps PSU Passport claims onto a Superset account."""

    def oauth_user_info(self, provider: str, response: dict | None = None) -> dict:
        if provider != "psu":
            return super().oauth_user_info(provider, response)

        # userinfo is requested rather than read from the id_token: the id_token
        # is minimal on some deployments, and the endpoint is authoritative.
        payload = self.appbuilder.sm.oauth_remotes[provider].userinfo()

        username_claim = os.environ.get("SUPERSET_OAUTH_USERNAME_CLAIM", "preferred_username")
        username = _psu_username(_claim(payload, username_claim) or _claim(payload, "sub"))

        if not USERNAME_PATTERN.match(username):
            # Refusing is the right end state: a username that cannot be
            # rendered into a Trino group would silently lose its grants.
            logger.warning("[psu-oauth] rejected a sign-in whose username is not in the expected shape")
            raise ValueError("the identity provider returned an unusable username")

        full_name = _claim(payload, os.environ.get("SUPERSET_OAUTH_NAME_CLAIM", "name"))
        first_name = _claim(payload, "given_name") or (full_name.split(" ")[0] if full_name else username)
        last_name = _claim(payload, "family_name") or (
            " ".join(full_name.split(" ")[1:]) if " " in full_name else "PSU"
        )

        return {
            "username": username,
            "email": _claim(payload, os.environ.get("SUPERSET_OAUTH_EMAIL_CLAIM", "email")),
            "first_name": first_name,
            "last_name": last_name,
        }

    def auth_user_oauth(self, userinfo: dict):
        """Signs the user in, then records the attempt without the payload."""
        user = super().auth_user_oauth(userinfo)
        if user is None:
            logger.warning("[psu-oauth] sign-in refused for a PSU Passport account")
        else:
            logger.info("[psu-oauth] sign-in accepted; roles resolved by Superset registration settings")
        return user


# ---------------------------------------------------------------------------
# Portal email-and-password sign-in, until PSU Passport is switched on
# ---------------------------------------------------------------------------

# Portal tier -> Superset role. Anything else is refused by psu-auth before it
# gets here; the mapping is repeated so this side fails closed on its own.
PORTAL_TIER_ROLES = {"analyst": "Alpha", "admin": "Admin"}


def _reserved_usernames() -> set[str]:
    """The platform's own Superset logins (bootstrap_users.py, bootstrap_embed.py)."""
    names = {"superset", os.environ.get("SUPERSET_EMBED_SERVICE_USERNAME", "psu-embed")}
    for variable in ("PSU_ADMIN_USERNAME", "PSU_ANALYST_USERNAME"):
        value = os.environ.get(variable, "").strip()
        if value:
            names.add(value)
    return names


def _verify_with_portal(email: str, password: str) -> dict | None:
    """Asks psu-auth whether this is a portal analyst's or admin's password.

    Returns {"username", "displayName", "accessTier"}, or None for any refusal
    or failure: an unreachable psu-auth means no portal sign-ins, never a
    fallback. Neither the email nor the reply is logged.
    """
    url = os.environ.get("PSU_AUTH_LOGIN_BRIDGE_URL", "").strip()
    secret = os.environ.get("SUPERSET_LOGIN_BRIDGE_SECRET", "").strip()
    if not url or not secret:
        return None
    request = urllib.request.Request(
        url,
        data=json.dumps({"email": email, "password": password}).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {secret}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            if response.status != 200:
                return None
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        # 401/403/429 are ordinary refusals; psu-auth recorded which one.
        logger.info("[psu-portal-login] portal sign-in refused (status %s)", error.code)
        return None
    except (urllib.error.URLError, TimeoutError, ValueError) as error:
        logger.error("[psu-portal-login] psu-auth login bridge unavailable: %s", type(error).__name__)
        return None
    return body if isinstance(body, dict) else None


class PsuPortalPasswordSecurityManager(SupersetSecurityManager):
    """Signs portal analysts and admins in with their portal email and password.

    A login name containing "@" is a portal email and is checked by psu-auth
    (services/auth/src/server.ts, the Superset login bridge), which keeps the
    hash and the rate limit. The Superset account is created on first sign-in
    under the portal account's psu_username -- the name the PSU Iceberg
    connection impersonates in Trino -- and its role is re-applied from the
    portal tier on every sign-in, so a tier change or a disabled account takes
    effect the next time that person signs in. It gets a random local password
    nobody knows, so the portal password is the only way in.

    Any other login name is one of the platform's own accounts and goes to
    Superset's own user table as before.
    """

    def auth_user_db(self, username, password):
        if not username or "@" not in username:
            return super().auth_user_db(username, password)

        verified = _verify_with_portal(username.strip(), password or "")
        if verified is None:
            return None

        psu_username = str(verified.get("username", ""))
        role_name = PORTAL_TIER_ROLES.get(str(verified.get("accessTier", "")))
        if role_name is None or not USERNAME_PATTERN.match(psu_username):
            logger.warning("[psu-portal-login] refused a portal sign-in with no usable tier or username")
            return None
        if psu_username in _reserved_usernames():
            logger.warning("[psu-portal-login] refused a portal sign-in that names a platform account")
            return None

        role = self.find_role(role_name)
        if role is None:
            logger.error("[psu-portal-login] Superset role %s does not exist", role_name)
            return None

        display_name = str(verified.get("displayName") or psu_username).strip()
        first_name, _, last_name = display_name.partition(" ")
        first_name, last_name = first_name[:64] or psu_username, last_name[:64] or "-"

        user = self.find_user(username=psu_username)
        if user is None:
            user = self.add_user(
                username=psu_username,
                first_name=first_name,
                last_name=last_name,
                # Not the portal email: Superset needs a unique address, and
                # this one keeps personal data out of its metadata database.
                email=f"{psu_username}@localhost",
                role=role,
                password=secrets.token_urlsafe(32),
            )
            if not user:
                logger.error("[psu-portal-login] could not create the Superset account")
                return None
        else:
            user.first_name = first_name
            user.last_name = last_name
            user.active = True
            user.roles = [role]
            if self.update_user(user) is False:
                logger.error("[psu-portal-login] could not update the Superset account")
                return None

        self.update_user_auth_stat(user, True)
        logger.info("[psu-portal-login] portal sign-in accepted with role %s", role_name)
        return user

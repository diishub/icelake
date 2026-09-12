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

import logging
import os
import re

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

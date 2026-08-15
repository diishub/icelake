"""Session management for the ThaiLLM source.

The repository sits behind Cloudflare and authenticates through **ThaiID**
(Thailand's national digital identity, OAuth2 via DOPA), which redirects to a
government identity provider and may require OTP / biometric / QR steps. That
cannot be automated headless, so the strategy is:

1. **One-time headed browser login** (:meth:`Session.login_via_browser`) --
   open a *visible* Chromium with Playwright at the login page, let the user
   complete the ThaiID flow by hand, poll ``GET /api/authentication/refresh``
   until it returns ``200`` with an ``access_token`` in the body, then export
   the refresh-cookie (HttpOnly) + the access_token to
   ``runtime/thaillm/session.json``.
2. **Bulk HTTP** (:meth:`Session.request` / :meth:`Session.download`) -- a
   ``curl-cffi`` session that impersonates Chrome's TLS fingerprint. It reuses
   the exported refresh-cookie to call ``GET /api/authentication/refresh``
   whenever the cached access_token is missing or near expiry, then sends
   ``Authorization: Bearer <access_token>``. On 401/403 it refreshes once and
   retries, falling back to a headed browser re-login only if refresh itself
   fails.

A manual fallback (:meth:`load_cookies_file`) accepts a cookie JSON exported
from a real browser (e.g. "EditThisCookie") for users who prefer to log in by
hand.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from typing import Optional

# UTF-8 for Thai on the Windows console
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SESSION_DIR = os.path.join(BASE_DIR, "runtime", "thaillm")
SESSION_FILE = os.path.join(SESSION_DIR, "session.json")

DEFAULT_LOGIN_URL = "https://data-repository.thaillm.or.th/login"
DEFAULT_ORIGIN = "https://data-repository.thaillm.or.th"

# localStorage keys that typically hold an access token in this kind of SPA.
_TOKEN_KEY_RE = re.compile(r"(token|access|jwt|auth)", re.IGNORECASE)


def _jwt_exp(token: str) -> int:
    """Decode the ``exp`` claim of a JWT (0 if unparseable)."""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)  # base64 padding
        import base64
        data = json.loads(base64.urlsafe_b64decode(payload).decode("utf-8"))
        return int(data.get("exp") or 0)
    except Exception:
        return 0


def _extract_cookie(res, name: str) -> Optional[str]:
    """Pull a cookie value out of a curl-cffi response (Set-Cookie header).

    Tries the parsed cookie jar first (``res.cookies``), then falls back to a
    case-insensitive regex over the raw ``Set-Cookie`` header -- needed because
    curl-cffi collapses multiple Set-Cookie lines and some builds don't surface
    HttpOnly cookies on ``res.cookies``.
    """
    try:
        v = res.cookies.get(name)
        if v:
            return v
    except Exception:
        pass
    try:
        raw = res.headers.get("set-cookie") or res.headers.get("Set-Cookie") or ""
    except Exception:
        raw = ""
    m = re.search(rf"{re.escape(name)}=([^;]+)", raw, re.IGNORECASE)
    return m.group(1) if m else None


class SessionExpired(Exception):
    """Raised when the session cannot be refreshed automatically."""


class Session:
    """Cookie + token carrier backed by ``curl-cffi`` for bulk requests."""

    def __init__(self, origin: str = DEFAULT_ORIGIN, verbose: bool = True):
        self.origin = origin.rstrip("/")
        self.verbose = verbose
        self.cookies: dict[str, str] = {}
        self.bearer_token: Optional[str] = None
        self._token_exp: int = 0  # JWT exp claim of bearer_token
        self.username: Optional[str] = None
        self._http = None  # lazily-created curl-cffi Session

    # ------------------------------------------------------------------ #
    # persistence
    # ------------------------------------------------------------------ #
    def save(self) -> None:
        os.makedirs(SESSION_DIR, exist_ok=True)
        with open(SESSION_FILE, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "origin": self.origin,
                    "cookies": self.cookies,
                    "bearer_token": self.bearer_token,
                    "token_exp": getattr(self, "_token_exp", 0),
                    "username": self.username,
                },
                f,
                ensure_ascii=False,
                indent=2,
            )
        if self.verbose:
            print(f"[session] saved -> {SESSION_FILE}")

    def load(self) -> bool:
        if not os.path.exists(SESSION_FILE):
            return False
        with open(SESSION_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        self.origin = data.get("origin", self.origin)
        self.cookies = data.get("cookies", {}) or {}
        self.bearer_token = data.get("bearer_token")
        # Recompute the JWT exp from the bearer itself rather than trusting
        # the stored token_exp field, which can drift stale (e.g. an older
        # login_via_browser path set bearer_token without updating _token_exp
        # before save()). A stale token_exp makes load() treat a still-valid
        # token as expired, triggering an unnecessary -- and, if the refresh
        # cookie is dead, failing -- re-login on every run.
        self._token_exp = _jwt_exp(self.bearer_token) if self.bearer_token else 0
        self.username = data.get("username")
        if self.verbose:
            n = len(self.cookies)
            print(f"[session] loaded ({n} cookie(s), bearer={'yes' if self.bearer_token else 'no'})")
        return bool(self.cookies) or bool(self.bearer_token)

    # ------------------------------------------------------------------ #
    # login strategies
    # ------------------------------------------------------------------ #
    def set_credentials(self, username: str = "", password: str = "") -> None:
        """ThaiID login does not use a site password; username is informational."""
        self.username = username or None

    def login_via_browser(self, login_url: str = DEFAULT_LOGIN_URL, timeout_s: int = 600) -> bool:
        """Open a *visible* Chromium and let the user log in via ThaiID.

        ThaiID may require OTP / biometric, so the flow cannot be automated;
        we launch headed, point the user at the login page, poll
        ``GET /api/authentication/refresh`` until it returns the access_token,
        then capture the refresh-cookie + access_token.

        Requires ``playwright`` (``pip install playwright && playwright install chromium``).
        """
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as e:
            raise RuntimeError(
                "Playwright is not installed. Run:\n"
                "  pip install playwright && playwright install chromium"
            ) from e

        os.makedirs(SESSION_DIR, exist_ok=True)
        print("=" * 60)
        print("A browser window will open. Please log in with ThaiID there")
        print("(handle any OTP / biometric prompt in the browser).")
        print("Then, if asked, accept the dataset usage form.")
        print(f"Waiting up to {timeout_s}s for authentication...")
        print("=" * 60)

        import time as _t

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=False)
            context = browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/124.0.0.0 Safari/537.36"
                )
            )
            page = context.new_page()
            page.goto(login_url, wait_until="domcontentloaded", timeout=60_000)

            # poll the authoritative auth signal: GET /api/authentication/refresh
            # returns 401 until the ThaiID OAuth callback lands a refresh-token
            # (HttpOnly) cookie, then 200 with a fresh access_token in the body.
            deadline = _t.time() + timeout_s
            ok = False
            while _t.time() < deadline:
                _t.sleep(3)
                token = self._poll_refresh_token(page)
                if token:
                    state = context.storage_state()
                    self._capture_cookies(state)
                    self.bearer_token = token
                    self._token_exp = _jwt_exp(token)
                    ok = True
                    break
            if not ok:
                # poll timed out -- still capture cookies, but do NOT keep a
                # stale bearer (the one loaded from disk is likely expired).
                # Only treat as success if we captured the refresh_token, which
                # is what bulk HTTP needs to mint new access tokens hourly.
                state = context.storage_state()
                self._capture_cookies(state)
                self.bearer_token = None  # drop any stale disk bearer
                self._token_exp = 0
                ok = "refresh_token" in self.cookies
            browser.close()

        if ok:
            # Verify the captured session actually works via bulk HTTP before
            # declaring success. The in-browser fetch passing isn't sufficient
            # proof: if the HttpOnly refresh_token cookie didn't survive into
            # curl-cffi's request, every hourly refresh 401s and long runs die
            # an hour in. Force a refresh here as the acceptance test.
            token = self._refresh_access_token()
            if token:
                self.save()
                print("[session] login OK -- /refresh works via bulk HTTP, session cached.")
            else:
                ok = False
                print("[session] login captured cookies but /refresh 401'd via bulk HTTP.")
                print("           Cookies captured:", list(self.cookies.keys()))
                print("           Try the manual cookie export fallback (Session.load_cookies_file).")
        else:
            print("[session] login did not detect an authenticated session.")
            print("           You can still export cookies manually and use")
            print("           Session.load_cookies_file() as a fallback.")
        return ok

    # ------------------------------------------------------------------ #
    # helpers for the ThaiID-aware login flow
    #
    # The ThaiID OAuth callback lands an HttpOnly refresh-token cookie at the
    # origin. The SPA never stores the access_token in localStorage; instead it
    # calls GET /api/authentication/refresh (with that cookie) which returns a
    # fresh short-lived access_token in the JSON body. We mirror that: the
    # browser login captures the refresh cookie + one access_token; bulk HTTP
    # re-calls /refresh whenever the cached token is missing or near expiry.
    # ------------------------------------------------------------------ #
    def _poll_refresh_token(self, page) -> Optional[str]:
        """GET /api/authentication/refresh from the page; return access_token or None.

        Only HTTP 200 with an ``access_token`` field counts as authenticated --
        the same signal the SPA itself uses. This avoids false positives from
        OAuth redirects (the URL leaves /login during the ThaiID redirect before
        the user is actually authenticated).
        """
        try:
            return page.evaluate(
                """async () => {
                    try {
                        const r = await fetch('/api/authentication/refresh',
                            {method:'GET', credentials:'include'});
                        if (r.status === 200) {
                            const j = await r.json();
                            return j && j.access_token ? j.access_token : null;
                        }
                    } catch (e) {}
                    return null;
                }"""
            )
        except Exception:
            return None

    def _capture_cookies(self, state: dict) -> None:
        """Pull cookies for our origin out of a Playwright storage_state dict.

        Uses proper cookie-domain semantics: a cookie set on ``thaillm.or.th``
        applies to ``data-repository.thaillm.or.th``, so we match the origin
        host or any of its parent domains -- not a brittle substring test that
        can drop the HttpOnly ``refresh_token`` (usually on ``.thaillm.or.th``)
        while keeping the Cloudflare ``cf_clearance`` on the exact host.
        """
        origin_host = self.origin.replace("https://", "").replace("http://", "").split("/")[0]
        captured = {}
        all_names: list[str] = []
        for c in state.get("cookies", []):
            domain = c.get("domain", "").lstrip(".")
            all_names.append(f"{c['name']}@{domain or '?'}")
            if origin_host == domain or origin_host.endswith("." + domain) or domain in origin_host:
                captured[c["name"]] = c["value"]
        self.cookies = captured
        if self.verbose:
            print(f"[session] browser cookies seen: {all_names}")
            print(f"[session] captured {len(captured)} for origin: {list(captured.keys())}")
            print(f"[session]   refresh_token present: {'refresh_token' in captured}")

    def _refresh_access_token(self) -> Optional[str]:
        """GET /api/authentication/refresh via bulk HTTP; return new access_token.

        Uses the cached refresh-cookie (HttpOnly, captured by the browser login).
        On success, caches the token and its JWT ``exp`` so callers need not
        refresh on every request.

        **Refresh-token rotation**: the server issues a *new* ``refresh_token``
        via ``Set-Cookie`` on every successful ``/refresh`` and **invalidates
        the old one**. If we only saved the new access_token and kept the old
        refresh_token, the *next* hourly refresh would 401 (using a dead token)
        -- which is exactly what blocked unattended long runs. So after each
        successful refresh we pull the rotated ``refresh_token`` out of the
        response cookies / ``Set-Cookie`` header, update ``self.cookies``, and
        persist it immediately.
        """
        if not self.cookies:
            return None
        try:
            res = self.http.get(
                f"{self.origin}/api/authentication/refresh",
                headers={"Cookie": "; ".join(f"{k}={v}" for k, v in self.cookies.items())},
                timeout=30,
            )
        except Exception:
            return None
        if res.status_code != 200:
            return None
        try:
            data = res.json()
        except Exception:
            return None
        token = data.get("access_token") if isinstance(data, dict) else None
        if token:
            self.bearer_token = token
            self._token_exp = _jwt_exp(token)
            # capture the rotated refresh_token so the NEXT refresh works
            new_rt = _extract_cookie(res, "refresh_token")
            if new_rt and new_rt != self.cookies.get("refresh_token"):
                self.cookies["refresh_token"] = new_rt
                self.save()
                if self.verbose:
                    print(f"[session] refreshed access_token (exp={self._token_exp}), "
                          f"rotated refresh_token persisted")
            elif self.verbose:
                print(f"[session] refreshed access_token (exp={self._token_exp})")
        return token

    def _ensure_access_token(self, *, force: bool = False) -> Optional[str]:
        """Return a live access_token, refreshing via the cookie if needed."""
        if self.bearer_token and not force:
            exp = getattr(self, "_token_exp", 0)
            if not exp or exp > time.time() + 30:
                return self.bearer_token
        return self._refresh_access_token()

    def load_cookies_file(self, path: str) -> bool:
        """Load cookies exported from a real browser (EditThisCookie JSON)."""
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and "cookies" in data:
            data = data["cookies"]
        self.cookies = {
            c["name"]: c["value"]
            for c in data
            if c.get("domain", "").lstrip(".") in self.origin
        }
        ok = bool(self.cookies)
        if ok:
            self.save()
        return ok

    # ------------------------------------------------------------------ #
    # bulk HTTP
    # ------------------------------------------------------------------ #
    @property
    def http(self):
        """Lazily create a curl-cffi session impersonating Chrome."""
        if self._http is None:
            try:
                from curl_cffi import requests as cffi_requests
            except ImportError:
                # fall back to stdlib requests if curl-cffi is missing
                import requests as cffi_requests  # type: ignore
            self._http = cffi_requests.Session(impersonate="chrome")
            self._http.headers.update({"Accept-Language": "th,en;q=0.8"})
        return self._http

    def _auth_headers(self) -> dict:
        h = {"Cookie": "; ".join(f"{k}={v}" for k, v in self.cookies.items())}
        if self.bearer_token:
            h["Authorization"] = f"Bearer {self.bearer_token}"
        return h

    def request(self, method: str, url: str, *, max_retries: int = 1, **kwargs):
        """Issue an authenticated request.

        Sends ``Authorization: Bearer <access_token>`` plus the refresh cookie.
        On 401/403, refreshes the token once (and, if that fails, falls back to a
        headed browser re-login) before retrying.
        """
        if url.startswith("/"):
            url = self.origin + url
        extra = kwargs.pop("headers", {}) or {}
        self._ensure_access_token()
        res = self.http.request(method, url, headers={**self._auth_headers(), **extra}, **kwargs)
        if res.status_code in (401, 403) and max_retries > 0:
            if self.verbose:
                print(f"[session] {res.status_code} on {url} -- refreshing token")
            if self._ensure_access_token(force=True) or self.login_via_browser():
                self._ensure_access_token()
                res = self.http.request(method, url, headers={**self._auth_headers(), **extra}, **kwargs)
        return res

    def get(self, url: str, **kwargs):
        return self.request("GET", url, **kwargs)

    def download(
        self,
        url: str,
        dest_path: str,
        *,
        expected_size: Optional[int] = None,
        chunk: int = 1 << 20,
    ) -> str:
        """Stream-download ``url`` to ``dest_path`` with resume support.

        If the file already exists with ``expected_size`` bytes, skip it.
        """
        if url.startswith("/"):
            url = self.origin + url
        # resume support via Range
        have = os.path.getsize(dest_path) if os.path.exists(dest_path) else 0
        if expected_size and have == expected_size:
            if self.verbose:
                print(f"[session] skip (complete): {os.path.basename(dest_path)}")
            return dest_path
        # one token refresh attempt before streaming; a 401 mid-stream is fatal
        # (Range resume handles re-entry on the next call).
        self._ensure_access_token()
        headers = self._auth_headers()
        if have:
            headers["Range"] = f"bytes={have}-"
        res = self.http.get(url, headers=headers, stream=True, timeout=None)
        if res.status_code in (401, 403):
            if self.verbose:
                print(f"[session] {res.status_code} downloading {url} -- refreshing token")
            if self._ensure_access_token(force=True):
                headers = self._auth_headers()
                if have:
                    headers["Range"] = f"bytes={have}-"
                res = self.http.get(url, headers=headers, stream=True, timeout=None)
        if res.status_code in (401, 403):
            raise SessionExpired(f"{res.status_code} downloading {url}")
        if res.status_code not in (200, 206):
            raise RuntimeError(f"download failed ({res.status_code}): {url}")
        mode = "ab" if have and res.status_code == 206 else "wb"
        if mode == "wb":
            have = 0
        os.makedirs(os.path.dirname(dest_path) or ".", exist_ok=True)
        written = have
        with open(dest_path, mode) as f:
            for buf in res.iter_content(chunk_size=chunk):
                if buf:
                    f.write(buf)
                    written += len(buf)
        if self.verbose:
            print(f"[session] downloaded {os.path.basename(dest_path)} ({written} bytes)")
        return dest_path

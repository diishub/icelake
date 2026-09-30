/*
 * Behaviour for the dedicated sign-in page.
 *
 * Two independent paths converge on the same session: PSU Passport (a
 * redirect to /auth/login, handled entirely by services/auth) and email and
 * password (a JSON POST to /auth/password/login, handled here). Neither path
 * is assumed to be available -- this file checks /auth/health first and
 * degrades the PSU Passport button rather than offering a link that 503s.
 */
(() => {
  "use strict";

  const i18n = window.PSU_I18N || {
    language: "th",
    t: (key) => key,
    apply: () => {},
    onChange: () => () => {},
  };
  const t = (key, replacements) => i18n.t(key, replacements);

  function currentNext() {
    const params = new URLSearchParams(window.location.search);
    const candidate = params.get("next");
    // Only a same-site path is ever accepted, matching the server-side rule
    // in services/auth/src/http.ts: a value naming a host is replaced with
    // the site root rather than "corrected".
    if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//")) {
      return "/";
    }
    if (/[\\r\n]/.test(candidate)) {
      return "/";
    }
    return candidate;
  }

  const next = currentNext();

  function setStatus(key, replacements) {
    const status = document.querySelector("#login-status");
    const forms = document.querySelector("#login-forms");
    if (!status) {
      return;
    }
    if (!key) {
      status.hidden = true;
      if (forms) {
        forms.hidden = false;
      }
      return;
    }
    status.textContent = t(key, replacements);
    status.hidden = false;
    if (forms) {
      forms.hidden = true;
    }
  }

  function showFormError(key, replacements) {
    const error = document.querySelector("#login-error");
    if (!error) {
      return;
    }
    error.textContent = t(key, replacements);
    error.hidden = false;
  }

  function clearFormError() {
    const error = document.querySelector("#login-error");
    if (error) {
      error.hidden = true;
      error.textContent = "";
    }
  }

  /**
   * Checks whether a session already exists and whether PSU Passport is
   * configured, in one round trip each. A signed-in visitor is sent straight
   * to "next" rather than shown a login form they no longer need.
   */
  async function checkAuthState() {
    setStatus("login.checking");

    let meResponse;
    try {
      meResponse = await fetch("/auth/me", { cache: "no-store", credentials: "same-origin" });
    } catch (_error) {
      setStatus(null);
      showFormError("login.serviceUnavailable");
      disableEmailForm();
      hidePsuPassportButton();
      return;
    }

    if (meResponse.ok) {
      const body = await meResponse.json().catch(() => ({}));
      if (body.authenticated) {
        setStatus("login.alreadySignedIn");
        window.location.replace(next);
        return;
      }
    }

    setStatus(null);
    await configurePsuPassportButton();
  }

  function hidePsuPassportButton() {
    const button = document.querySelector("#psu-passport-button");
    const divider = document.querySelector("#login-divider");
    if (button) {
      button.hidden = true;
    }
    if (divider) {
      divider.hidden = true;
    }
  }

  function disableEmailForm() {
    const form = document.querySelector("#login-form");
    if (!form) {
      return;
    }
    form.querySelectorAll("input, button").forEach((el) => {
      el.disabled = true;
    });
  }

  async function configurePsuPassportButton() {
    const button = document.querySelector("#psu-passport-button");
    const note = document.querySelector("#psu-passport-note");
    const divider = document.querySelector("#login-divider");
    if (!button) {
      return;
    }

    button.hidden = false;
    if (divider) {
      divider.hidden = false;
    }

    try {
      const response = await fetch("/auth/health", { cache: "no-store", credentials: "same-origin" });
      const body = response.ok ? await response.json() : { psuPassport: false };
      if (body.psuPassport) {
        button.href = `/auth/login?next=${encodeURIComponent(next)}`;
        if (note) {
          note.hidden = true;
        }
        return;
      }
    } catch (_error) {
      // Handled below
    }

    // When PSU Passport is not yet configured (e.g. localhost development):
    // Keep button visible like in dotblue, but handle click gracefully with a helpful message.
    button.href = "#";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      if (note) {
        note.hidden = false;
        note.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    });
  }

  function configureEmailForm() {
    const form = document.querySelector("#login-form");
    const submit = document.querySelector("#login-submit");
    if (!form || !submit) {
      return;
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      clearFormError();

      const email = document.querySelector("#login-email").value.trim();
      const password = document.querySelector("#login-password").value;
      if (!email || !password) {
        showFormError("login.errorInvalidRequest");
        return;
      }

      submit.disabled = true;
      const originalLabel = submit.textContent;
      submit.textContent = t("login.submitting");

      try {
        const response = await fetch("/auth/password/login", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password, next }),
        });

        if (response.ok) {
          const body = await response.json();
          window.location.assign(body.next || next);
          return;
        }

        const body = await response.json().catch(() => ({}));
        if (response.status === 429) {
          showFormError("login.errorRateLimited", { seconds: body.retryAfterSeconds ?? 60 });
        } else if (response.status === 403 && body.error === "account_disabled") {
          showFormError("login.errorAccountDisabled");
        } else if (response.status === 401) {
          showFormError("login.errorInvalidCredentials");
        } else if (response.status === 400) {
          showFormError("login.errorInvalidRequest");
        } else {
          showFormError("login.errorGeneric");
        }
      } catch (_error) {
        showFormError("login.serviceUnavailable");
      } finally {
        submit.disabled = false;
        submit.textContent = originalLabel;
      }
    });
  }

  function configureLanguageSwitch() {
    const button = document.querySelector("#lang-switch");
    if (button) {
      button.addEventListener("click", () => i18n.toggle());
    }
  }

  configureEmailForm();
  configureLanguageSwitch();
  void checkAuthState();
})();

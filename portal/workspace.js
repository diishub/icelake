/*
 * Shared header behaviour for the workspace pages (upload, review, publish,
 * reports): who is signed in, which workspace links apply to them, and sign
 * out. Each page still gates itself and psu-auth gates every route; hiding a
 * link here is only so a reader is not offered a page that will refuse them.
 */
(() => {
  "use strict";

  const i18n = window.PSU_I18N || {
    language: "th",
    t: (key) => key,
    onChange: () => () => {},
  };
  const t = (key, replacements) => i18n.t(key, replacements);

  // Mirrors the tier checks in services/auth/src/server.ts.
  const LINK_TIERS = {
    upload: ["steward"],
    review: ["analyst", "developer"],
    publish: ["analyst", "developer", "steward"],
    reports: ["viewer_exec", "analyst", "developer"],
    admin: ["developer"],
  };
  const KNOWN_TIERS = ["none", "viewer", "viewer_exec", "analyst", "steward", "developer"];

  let user = null;

  function renderAccount() {
    const card = document.querySelector("#ws-account");
    if (!card) {
      return;
    }
    card.hidden = !user;
    if (!user) {
      return;
    }
    document.querySelector("#ws-account-name").textContent =
      user.displayName || user.username || t("account.fallbackName");
    const tier = KNOWN_TIERS.includes(user.accessTier) ? user.accessTier : "none";
    const role = t(`tier.${tier}`);
    document.querySelector("#ws-account-role").textContent = user.orgUnit ? `${role} · ${user.orgUnit}` : role;
  }

  function renderLinks() {
    document.querySelectorAll("[data-ws-link]").forEach((link) => {
      if (link.getAttribute("aria-current") === "page") {
        return;
      }
      const tiers = LINK_TIERS[link.dataset.wsLink] || [];
      link.hidden = !user || !tiers.includes(user.accessTier);
    });
  }

  async function load() {
    try {
      const response = await fetch("/auth/me", { cache: "no-store", credentials: "same-origin" });
      const body = response.ok ? await response.json() : {};
      user = body.authenticated ? body.user || null : null;
    } catch (_error) {
      user = null;
    }
    renderAccount();
    renderLinks();
  }

  function configureSignOut() {
    const button = document.querySelector("#ws-signout");
    if (!button) {
      return;
    }
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const response = await fetch("/auth/logout", {
          method: "POST",
          cache: "no-store",
          credentials: "same-origin",
        });
        const body = response.ok ? await response.json() : null;
        if (body && body.endSessionUrl) {
          window.location.href = body.endSessionUrl;
          return;
        }
      } catch (_error) {
        // Falls through: the home page shows whether the session is gone.
      }
      window.location.href = "/";
    });
  }

  function init() {
    configureSignOut();
    i18n.onChange(renderAccount);
    void load();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

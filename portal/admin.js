/*
 * Platform-team page. Gated to the developer tier here for the reader's sake;
 * every tool behind these links has its own sign-in, and the commands listed
 * on the page run only on the host. Nothing here grants or checks access to
 * data.
 */
(() => {
  "use strict";

  const i18n = window.PSU_I18N || {
    language: "th",
    t: (key) => key,
    toggle: () => {},
  };
  const t = (key, replacements) => i18n.t(key, replacements);
  const config = window.PSU_PORTAL_CONFIG || { services: {} };

  // The tools listen on the host only (README: SSH tunnel is the access path),
  // so a link built from any other hostname would point at nothing.
  const localHostnames = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  const isLocalHost = localHostnames.has(window.location.hostname) || window.location.hostname.endsWith(".localhost");

  function setStatus(key) {
    const status = document.querySelector("#admin-status");
    const content = document.querySelector("#admin-content");
    if (!status || !content) {
      return;
    }
    status.hidden = !key;
    content.hidden = Boolean(key);
    if (key) {
      status.textContent = t(key);
    }
  }

  function buildServiceUrl(serviceName) {
    const service = config.services && config.services[serviceName];
    if (!service) {
      return null;
    }
    const url = new URL(window.location.href);
    url.protocol = service.protocol;
    url.port = service.port;
    url.pathname = service.path;
    url.search = "";
    url.hash = "";
    return url.toString();
  }

  function configureToolLinks() {
    const notice = document.querySelector("#admin-host-notice");
    if (notice) {
      notice.hidden = isLocalHost;
    }
    document.querySelectorAll("[data-service-link]").forEach((link) => {
      const url = isLocalHost ? buildServiceUrl(link.dataset.serviceLink) : null;
      if (!url) {
        link.removeAttribute("href");
        link.setAttribute("aria-disabled", "true");
        return;
      }
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener";
    });
  }

  async function checkAccess() {
    setStatus("admin.checking");
    let body = {};
    try {
      const response = await fetch("/auth/me", { cache: "no-store", credentials: "same-origin" });
      body = response.ok ? await response.json() : {};
    } catch (_error) {
      setStatus("login.serviceUnavailable");
      return;
    }
    if (!body.authenticated) {
      window.location.replace(`/login?next=${encodeURIComponent("/admin.html")}`);
      return;
    }
    if (!body.user || body.user.accessTier !== "developer") {
      setStatus("admin.forbidden");
      return;
    }
    setStatus(null);
    configureToolLinks();
  }

  function init() {
    const langSwitch = document.querySelector("#lang-switch");
    if (langSwitch) {
      langSwitch.addEventListener("click", () => i18n.toggle());
    }
    void checkAccess();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

/*
 * Dedicated report page for viewer_exec/analyst/developer accounts --
 * embeds a live Superset dashboard via a guest token (services/auth's
 * /auth/embeds/<key>), so seeing real data never requires a second Superset
 * login. Gated client-side for UX only; the real gate is server-side in
 * services/auth/src/server.ts's embedDashboard(), which checks the session
 * and accessTier itself.
 */
(() => {
  "use strict";

  const config = window.PSU_PORTAL_CONFIG || {};
  const i18n = window.PSU_I18N || {
    language: "th",
    t: (key) => key,
    apply: () => {},
    onChange: () => () => {},
  };
  const t = (key) => i18n.t(key);

  const ALLOWED_TIERS = new Set(["viewer_exec", "analyst", "developer"]);
  let embeddedDashboardMounted = false;

  // Same construction app.js's buildServiceUrl uses for every operator/BI
  // link -- duplicated in this small handful of lines rather than loading
  // the whole of app.js just for one helper.
  function buildServiceUrl(serviceName) {
    const service = config.services && config.services[serviceName];
    if (!service) {
      return "#help";
    }
    const url = new URL(window.location.href);
    url.protocol = service.protocol;
    url.port = service.port;
    url.pathname = service.path;
    url.search = "";
    url.hash = "";
    return url.toString();
  }

  function showChecking() {
    const status = document.querySelector("#reports-status");
    if (status) {
      status.textContent = t("reports.checking");
      status.hidden = false;
    }
  }

  function showForbidden() {
    const status = document.querySelector("#reports-status");
    const forbidden = document.querySelector("#reports-forbidden");
    const panel = document.querySelector("#reports-panel");
    if (status) status.hidden = true;
    if (panel) panel.hidden = true;
    if (forbidden) forbidden.hidden = false;
  }

  function showPanel() {
    const status = document.querySelector("#reports-status");
    const forbidden = document.querySelector("#reports-forbidden");
    const panel = document.querySelector("#reports-panel");
    if (status) status.hidden = true;
    if (forbidden) forbidden.hidden = true;
    if (panel) panel.hidden = false;
  }

  async function fetchEmbedGuestToken() {
    const key = config.embeddedDashboardKey || "ops";
    const response = await fetch(`/auth/embeds/${encodeURIComponent(key)}`, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) {
      throw new Error(`embeds/${key} returned ${response.status}`);
    }
    return response.json();
  }

  async function mountDashboard() {
    if (embeddedDashboardMounted) {
      return;
    }
    const status = document.querySelector("#embedded-dashboard-status");
    const mount = document.querySelector("#embedded-dashboard-mount");
    if (!mount) {
      return;
    }
    try {
      const first = await fetchEmbedGuestToken();
      if (!window.supersetEmbeddedSdk) {
        throw new Error("embedded SDK did not load");
      }
      embeddedDashboardMounted = true;
      if (status) {
        status.hidden = true;
      }
      await window.supersetEmbeddedSdk.embedDashboard({
        id: first.dashboardEmbedUuid,
        supersetDomain: first.supersetOrigin,
        mountPoint: mount,
        // Called again by the SDK as the short-lived token nears expiry.
        fetchGuestToken: async () => (await fetchEmbedGuestToken()).guestToken,
        dashboardUiConfig: {
          hideTitle: true,
          hideTab: true,
          hideChartControls: true,
          filters: { visible: false },
        },
      });
    } catch (_error) {
      if (status) {
        status.hidden = false;
        status.textContent = t("embed.error");
      }
    }
  }

  async function checkAccess() {
    showChecking();

    let response;
    try {
      response = await fetch("/auth/me", { cache: "no-store", credentials: "same-origin" });
    } catch (_error) {
      const status = document.querySelector("#reports-status");
      if (status) {
        status.textContent = t("login.serviceUnavailable");
      }
      return;
    }

    const body = response.ok ? await response.json().catch(() => ({})) : {};
    if (!body.authenticated) {
      window.location.replace(`/login?next=${encodeURIComponent("/reports.html")}`);
      return;
    }

    const tier = body.user && body.user.accessTier;
    if (!tier || !ALLOWED_TIERS.has(tier)) {
      showForbidden();
      return;
    }

    showPanel();
    const supersetLink = document.querySelector('[data-service-link="reports"]');
    if (supersetLink) {
      supersetLink.href = buildServiceUrl("reports");
    }
    void mountDashboard();
  }

  function configureLanguageSwitch() {
    const button = document.querySelector("#lang-switch");
    if (button) {
      button.addEventListener("click", () => i18n.toggle());
    }
  }

  configureLanguageSwitch();
  void checkAccess();
})();

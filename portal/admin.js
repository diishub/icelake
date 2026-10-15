/*
 * Platform-team page, for admin and developer accounts.
 *
 * Admins also get account administration: list accounts, create password
 * accounts, grant tiers, switch accounts off and reset passwords. psu-auth
 * refuses every /auth/admin/* call from any other tier, and the database
 * functions behind it re-check again (config/platform/022-admin-tier.sql);
 * what this script shows or hides is only so a reader is not offered an
 * action that will be refused. Every tool linked below has its own sign-in,
 * and the commands listed on the page run only on the host.
 */
(() => {
  "use strict";

  const i18n = window.PSU_I18N || {
    language: "th",
    t: (key) => key,
    toggle: () => {},
    onChange: () => () => {},
  };
  const t = (key, replacements) => i18n.t(key, replacements);
  const config = window.PSU_PORTAL_CONFIG || { services: {} };
  const $ = (selector) => document.querySelector(selector);

  const PAGE_TIERS = ["admin", "developer"];
  const KNOWN_TIERS = ["none", "viewer", "viewer_exec", "analyst", "steward", "developer", "admin"];
  const ORG_SCOPED_TIERS = ["viewer", "steward"];
  const PASSWORD_MIN_LENGTH = 12;
  // psu-auth error codes this page has a sentence for (admin.error.<code>).
  const KNOWN_ERRORS = [
    "invalid_request", "invalid_email", "display_name_required", "invalid_username",
    "password_too_short", "password_too_long", "password_mismatch", "tier_not_assignable",
    "invalid_org_unit", "org_unit_required", "email_taken", "username_taken", "not_admin",
    "self_change_forbidden", "target_is_developer", "account_not_found", "not_password_account",
    "tier_not_permitted", "not_authenticated",
  ];

  // The tools listen on the host only (README: SSH tunnel is the access path),
  // so a link built from any other hostname would point at nothing.
  const localHostnames = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  const isLocalHost = localHostnames.has(window.location.hostname) || window.location.hostname.endsWith(".localhost");

  let accounts = [];
  let events = [];
  let assignableTiers = [];
  let selfUserId = null;
  let activeAccount = null;

  function setStatus(key) {
    const status = $("#admin-status");
    const content = $("#admin-content");
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
    const notice = $("#admin-host-notice");
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

  // --- helpers ------------------------------------------------------------------

  function tierLabel(tier) {
    return t(`tier.${KNOWN_TIERS.includes(tier) ? tier : "none"}`);
  }

  function formatDate(isoString) {
    if (!isoString) return "—";
    try {
      return new Date(isoString).toLocaleString(i18n.language === "th" ? "th-TH" : "en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch (_error) {
      return isoString;
    }
  }

  function errorMessage(code) {
    const text = KNOWN_ERRORS.includes(code) ? t(`admin.error.${code}`) : "";
    return text || t("admin.error.generic", { code: code || "unknown" });
  }

  function showAlert(selector, message, kind) {
    const alert = $(selector);
    if (!alert) return;
    if (!message) {
      alert.hidden = true;
      return;
    }
    alert.textContent = message;
    alert.className = `modal-feedback-alert ${kind === "error" ? "alert-error" : "alert-success"}`;
    alert.hidden = false;
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  async function api(method, path, body) {
    const response = await fetch(path, {
      method,
      cache: "no-store",
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let payload = {};
    try {
      payload = await response.json();
    } catch (_error) {
      payload = {};
    }
    if (!response.ok) {
      const error = new Error(payload.error || `http_${response.status}`);
      error.code = payload.error || `http_${response.status}`;
      throw error;
    }
    return payload;
  }

  // --- accounts -------------------------------------------------------------------

  function fillTierSelects() {
    document.querySelectorAll("[data-tier-select]").forEach((select) => {
      const current = select.value;
      select.replaceChildren(
        ...assignableTiers.map((tier) => {
          const option = element("option", null, `${tierLabel(tier)} (${tier})`);
          option.value = tier;
          return option;
        }),
      );
      if (assignableTiers.includes(current)) select.value = current;
    });
  }

  function accountMatches(account, query) {
    if (!query) return true;
    return [account.displayName, account.email, account.username, account.orgUnit, account.accessTier]
      .some((value) => value && value.toLowerCase().includes(query));
  }

  function renderAccounts() {
    const tbody = $("#users-tbody");
    if (!tbody) return;
    const query = ($("#users-search").value || "").trim().toLowerCase();
    const visible = accounts.filter((account) => accountMatches(account, query));

    if (visible.length === 0) {
      const row = element("tr");
      const cell = element("td", "review-empty-state", t(accounts.length ? "admin.noMatch" : "admin.noUsers"));
      cell.colSpan = 6;
      row.append(cell);
      tbody.replaceChildren(row);
      return;
    }

    tbody.replaceChildren(
      ...visible.map((account) => {
        const row = element("tr", account.isActive ? "" : "admin-row-inactive");

        const who = element("td");
        who.append(element("strong", null, account.displayName || account.email || account.username || "—"));
        const meta = [account.email, account.username ? `trino: ${account.username}` : null]
          .filter(Boolean).join(" · ");
        who.append(element("span", "admin-account-meta", meta));
        const methods = [account.hasPassword ? t("admin.methodPassword") : null,
          account.hasPsuPassport ? t("admin.methodPassport") : null].filter(Boolean).join(" · ");
        who.append(element("span", "admin-account-meta", methods));
        if (account.userId === selfUserId) {
          who.append(element("span", "state-badge is-ready", t("admin.you")));
        }

        const tier = element("td");
        tier.append(element("span", "upload-status-badge", tierLabel(account.accessTier)));

        const status = element("td");
        status.append(element(
          "span",
          `state-badge ${account.isActive ? "is-published" : "is-withheld"}`,
          t(account.isActive ? "admin.statusActive" : "admin.statusInactive"),
        ));

        const actions = element("td", "admin-row-actions");
        const editable = account.userId !== selfUserId && account.accessTier !== "developer";
        const edit = element("button", "button button-ghost button-small", t("admin.edit"));
        edit.type = "button";
        edit.disabled = !editable;
        edit.title = editable ? "" : t(account.accessTier === "developer" ? "admin.error.target_is_developer" : "admin.error.self_change_forbidden");
        edit.addEventListener("click", () => openEdit(account.userId));
        actions.append(edit);
        if (account.hasPassword && account.accessTier !== "developer") {
          const reset = element("button", "button button-ghost button-small", t("admin.resetPassword"));
          reset.type = "button";
          reset.addEventListener("click", () => openReset(account.userId));
          actions.append(reset);
        }

        row.append(who, tier, element("td", null, account.orgUnit || "—"), status,
          element("td", null, formatDate(account.lastLoginAt)), actions);
        return row;
      }),
    );
  }

  function eventChange(event) {
    const detail = event.detail || {};
    const describe = (state) => {
      if (!state) return "";
      const parts = [tierLabel(state.access_tier)];
      if (state.org_unit) parts.push(state.org_unit);
      if (state.is_active === false) parts.push(t("admin.statusInactive"));
      return parts.join(" · ");
    };
    if (event.action === "account_updated") {
      return `${describe(detail.before)} → ${describe(detail.after)}`;
    }
    if (event.action === "account_created") {
      return describe(detail);
    }
    return "—";
  }

  function renderEvents() {
    const tbody = $("#events-tbody");
    if (!tbody) return;
    if (events.length === 0) {
      const row = element("tr");
      const cell = element("td", "review-empty-state", t("admin.noEvents"));
      cell.colSpan = 5;
      row.append(cell);
      tbody.replaceChildren(row);
      return;
    }
    tbody.replaceChildren(
      ...events.map((event) => {
        const row = element("tr");
        row.append(
          element("td", null, formatDate(event.occurredAt)),
          element("td", null, event.actorName || t("admin.actorHost")),
          element("td", null, t(`admin.action.${event.action}`)),
          element("td", null, event.targetName || "—"),
          element("td", null, eventChange(event)),
        );
        return row;
      }),
    );
  }

  async function loadAccounts() {
    showAlert("#users-alert", null);
    try {
      const [list, history] = await Promise.all([
        api("GET", "/auth/admin/users"),
        api("GET", "/auth/admin/events"),
      ]);
      accounts = list.accounts || [];
      assignableTiers = list.assignableTiers || [];
      selfUserId = list.self || null;
      events = history.events || [];
      fillTierSelects();
      renderAccounts();
      renderEvents();
    } catch (error) {
      showAlert("#users-alert", errorMessage(error.code), "error");
    }
  }

  // --- modals -----------------------------------------------------------------------

  function closeModals() {
    document.querySelectorAll(".review-modal-backdrop").forEach((backdrop) => {
      backdrop.hidden = true;
    });
    activeAccount = null;
    ["#create-password", "#create-password-confirm", "#reset-password", "#reset-password-confirm"]
      .forEach((selector) => {
        const input = $(selector);
        if (input) input.value = "";
      });
    window.PSU_PASSWORD_TOGGLE?.reset();
  }

  function syncOrgUnitRequirement(tierSelect, orgInput) {
    orgInput.required = ORG_SCOPED_TIERS.includes(tierSelect.value);
  }

  function openCreate() {
    $("#create-form").reset();
    fillTierSelects();
    $("#create-tier").value = "none";
    syncOrgUnitRequirement($("#create-tier"), $("#create-org-unit"));
    showAlert("#create-alert", null);
    $("#create-modal-backdrop").hidden = false;
    $("#create-email").focus();
  }

  function passwordInputProblem(password, confirm) {
    if (password.length < PASSWORD_MIN_LENGTH) return "password_too_short";
    if (password !== confirm) return "password_mismatch";
    return null;
  }

  async function submitCreate(event) {
    event.preventDefault();
    const password = $("#create-password").value;
    const problem = passwordInputProblem(password, $("#create-password-confirm").value);
    if (problem) {
      showAlert("#create-alert", errorMessage(problem), "error");
      return;
    }
    const submit = $("#create-submit");
    submit.disabled = true;
    try {
      const created = await api("POST", "/auth/admin/users", {
        email: $("#create-email").value.trim(),
        displayName: $("#create-name").value.trim(),
        username: $("#create-username").value.trim(),
        password,
        accessTier: $("#create-tier").value,
        orgUnit: $("#create-org-unit").value.trim(),
      });
      closeModals();
      await loadAccounts();
      showAlert("#users-alert", t("admin.created", { username: created.username }), "success");
    } catch (error) {
      showAlert("#create-alert", errorMessage(error.code), "error");
    } finally {
      submit.disabled = false;
    }
  }

  function openEdit(userId) {
    activeAccount = accounts.find((account) => account.userId === userId) || null;
    if (!activeAccount) return;
    fillTierSelects();
    $("#edit-subtitle").textContent = activeAccount.displayName || activeAccount.email || activeAccount.username || "";
    $("#edit-tier").value = assignableTiers.includes(activeAccount.accessTier) ? activeAccount.accessTier : "none";
    $("#edit-org-unit").value = activeAccount.orgUnit || "";
    $("#edit-active").checked = activeAccount.isActive;
    syncOrgUnitRequirement($("#edit-tier"), $("#edit-org-unit"));
    showAlert("#edit-alert", null);
    $("#edit-modal-backdrop").hidden = false;
    $("#edit-tier").focus();
  }

  async function submitEdit(event) {
    event.preventDefault();
    if (!activeAccount) return;
    const submit = $("#edit-submit");
    submit.disabled = true;
    try {
      await api("PUT", `/auth/admin/users/${encodeURIComponent(activeAccount.userId)}`, {
        accessTier: $("#edit-tier").value,
        orgUnit: $("#edit-org-unit").value.trim(),
        isActive: $("#edit-active").checked,
      });
      closeModals();
      await loadAccounts();
      showAlert("#users-alert", t("admin.saved"), "success");
    } catch (error) {
      showAlert("#edit-alert", errorMessage(error.code), "error");
    } finally {
      submit.disabled = false;
    }
  }

  function openReset(userId) {
    activeAccount = accounts.find((account) => account.userId === userId) || null;
    if (!activeAccount) return;
    $("#password-subtitle").textContent = activeAccount.displayName || activeAccount.email || "";
    showAlert("#password-alert", null);
    $("#password-modal-backdrop").hidden = false;
    $("#reset-password").focus();
  }

  async function submitReset(event) {
    event.preventDefault();
    if (!activeAccount) return;
    const password = $("#reset-password").value;
    const problem = passwordInputProblem(password, $("#reset-password-confirm").value);
    if (problem) {
      showAlert("#password-alert", errorMessage(problem), "error");
      return;
    }
    const submit = $("#password-submit");
    submit.disabled = true;
    try {
      await api("POST", `/auth/admin/users/${encodeURIComponent(activeAccount.userId)}/password`, { password });
      closeModals();
      await loadAccounts();
      showAlert("#users-alert", t("admin.passwordReset"), "success");
    } catch (error) {
      showAlert("#password-alert", errorMessage(error.code), "error");
    } finally {
      submit.disabled = false;
    }
  }

  function wireAccountAdministration() {
    $("#admin-users").hidden = false;
    $("#admin-events").hidden = false;
    $("#users-refresh-btn").addEventListener("click", () => void loadAccounts());
    $("#users-new-btn").addEventListener("click", openCreate);
    $("#users-search").addEventListener("input", renderAccounts);
    $("#create-form").addEventListener("submit", (event) => void submitCreate(event));
    $("#edit-form").addEventListener("submit", (event) => void submitEdit(event));
    $("#password-form").addEventListener("submit", (event) => void submitReset(event));
    $("#create-tier").addEventListener("change", () => syncOrgUnitRequirement($("#create-tier"), $("#create-org-unit")));
    $("#edit-tier").addEventListener("change", () => syncOrgUnitRequirement($("#edit-tier"), $("#edit-org-unit")));
    document.querySelectorAll("[data-close-modal]").forEach((button) => {
      button.addEventListener("click", closeModals);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeModals();
    });
    i18n.onChange(() => {
      fillTierSelects();
      renderAccounts();
      renderEvents();
    });
    void loadAccounts();
  }

  // --- page -------------------------------------------------------------------------

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
    if (!body.user || !PAGE_TIERS.includes(body.user.accessTier)) {
      setStatus("admin.forbidden");
      return;
    }
    setStatus(null);
    configureToolLinks();
    if (body.user.accessTier === "admin") {
      wireAccountAdministration();
    }
  }

  function init() {
    const langSwitch = $("#lang-switch");
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

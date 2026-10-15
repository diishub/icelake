/*
 * Dataset releases: an analyst asks for a curated table to be published, the
 * data owner for its org unit (or a developer or admin) approves or rejects it, and
 * psu-auth copies it into polaris.published. See
 * config/platform/021-dataset-release.sql.
 *
 * Every rule that matters -- who may ask, who may decide, that nobody decides
 * their own request -- is enforced by psu-auth and the database. This page only
 * shows the buttons the server says apply (release.canDecide, canRequest).
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

  const ALLOWED_TIERS = ["analyst", "developer", "steward", "admin"];
  const OPEN = ["requested", "approved"];
  const CLOSED = ["rejected", "failed"];
  // An approved release is copying in the background; poll until it settles.
  const POLL_MS = 4000;

  let releases = [];
  let canRequest = false;
  let currentFilter = "open";
  let activeRelease = null;
  let activePreview = null;
  let pollTimer = null;

  // Error codes psu-auth answers with that have their own sentence; anything
  // else is shown as the generic message with the code beside it.
  const KNOWN_ERRORS = [
    "not_authenticated", "tier_not_permitted", "publishing_not_configured", "trino_unavailable",
    "invalid_table_name", "title_required", "invalid_owner_org_unit", "invalid_domain",
    "invalid_tags", "invalid_text_field", "source_table_not_found", "release_already_open",
    "release_not_found", "self_approval_forbidden", "not_data_owner", "release_already_decided",
    "reason_required", "source_not_found", "source_has_no_snapshot", "copy_failed",
    "snapshot_read_failed", "interrupted",
  ];

  const $ = (selector) => document.querySelector(selector);

  function escapeHtml(text) {
    if (text === null || text === undefined) return "";
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function formatDate(isoString) {
    if (!isoString) return "—";
    try {
      const locale = i18n.language === "th" ? "th-TH" : "en-US";
      return new Date(isoString).toLocaleString(locale, {
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

  function formatNumber(value) {
    if (typeof value !== "number") return "—";
    return value.toLocaleString(i18n.language === "th" ? "th-TH" : "en-US");
  }

  function releaseTitle(release) {
    return i18n.language === "en" && release.titleEn ? release.titleEn : release.titleTh;
  }

  function releaseDescription(release) {
    return i18n.language === "en" && release.descriptionEn
      ? release.descriptionEn
      : release.descriptionTh;
  }

  function setStatus(key) {
    const status = $("#publish-status");
    const content = $("#publish-content-area");
    if (!status || !content) return;
    if (!key) {
      status.hidden = true;
      content.hidden = false;
      return;
    }
    status.textContent = t(key);
    status.hidden = false;
    content.hidden = true;
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

  /** A server error code as a sentence, falling back to the code itself rather than to nothing. */
  function errorMessage(code) {
    const text = KNOWN_ERRORS.includes(code) ? t(`publish.error.${code}`) : "";
    return text || t("publish.error.generic", { code });
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      cache: "no-store",
      credentials: "same-origin",
      ...options,
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
    });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, body };
  }

  // --- access -----------------------------------------------------------------

  async function checkAccess() {
    setStatus("review.checking");
    let response;
    try {
      response = await fetch("/auth/me", { cache: "no-store", credentials: "same-origin" });
    } catch (_error) {
      setStatus("login.serviceUnavailable");
      return;
    }
    const body = response.ok ? await response.json().catch(() => ({})) : {};
    if (!body.authenticated) {
      window.location.replace(`/login?next=${encodeURIComponent("/publish.html")}`);
      return;
    }
    if (!body.user || !ALLOWED_TIERS.includes(body.user.accessTier)) {
      setStatus("publish.forbidden");
      return;
    }
    setStatus(null);
    void loadReleases();
  }

  // --- list ---------------------------------------------------------------------

  async function loadReleases() {
    let result;
    try {
      result = await api("/auth/releases");
    } catch (_error) {
      result = { ok: false, body: {} };
    }
    const list = $("#publish-list-container");
    if (!result.ok) {
      if (list) {
        const code = result.body && result.body.error;
        list.innerHTML = `<p class="review-empty-state text-critical">${escapeHtml(
          code ? errorMessage(code) : t("login.serviceUnavailable")
        )}</p>`;
      }
      return;
    }

    releases = Array.isArray(result.body.releases) ? result.body.releases : [];
    canRequest = Boolean(result.body.canRequest);
    const newButton = $("#publish-new-btn");
    if (newButton) newButton.hidden = !canRequest;

    updateStats();
    renderList();
    schedulePoll();

    if (activeRelease) {
      const refreshed = releases.find((r) => r.releaseId === activeRelease.releaseId);
      if (refreshed) {
        activeRelease = refreshed;
        renderDetail();
      }
    }
  }

  function schedulePoll() {
    window.clearTimeout(pollTimer);
    if (releases.some((r) => r.status === "approved")) {
      pollTimer = window.setTimeout(() => void loadReleases(), POLL_MS);
    }
  }

  function updateStats() {
    const count = (statuses) => releases.filter((r) => statuses.includes(r.status)).length;
    const set = (selector, value) => {
      const el = $(selector);
      if (el) el.textContent = String(value);
    };
    set("#stat-open", count(OPEN));
    set("#badge-open", count(OPEN));
    set("#stat-published", count(["published"]));
    set("#stat-closed", count(CLOSED));
    set("#stat-total", releases.length);
  }

  function filtered() {
    if (currentFilter === "open") return releases.filter((r) => OPEN.includes(r.status));
    if (currentFilter === "published") return releases.filter((r) => r.status === "published");
    if (currentFilter === "closed") return releases.filter((r) => CLOSED.includes(r.status));
    return releases;
  }

  const STATUS_BADGE = {
    requested: "status-badge-pending",
    approved: "status-badge-progress",
    published: "status-badge-registered",
    rejected: "status-badge-rejected",
    failed: "status-badge-rejected",
  };

  function statusBadge(release) {
    const cls = STATUS_BADGE[release.status] || "status-badge-pending";
    return `<span class="upload-status-badge ${cls}">${escapeHtml(t(`publish.status.${release.status}`))}</span>`;
  }

  function renderList() {
    const list = $("#publish-list-container");
    if (!list) return;
    const rows = filtered();
    if (rows.length === 0) {
      list.innerHTML = `<p class="review-empty-state">${escapeHtml(t("publish.emptyList"))}</p>`;
      return;
    }
    list.innerHTML = `
      <table class="review-table">
        <thead>
          <tr>
            <th>${escapeHtml(t("publish.colDataset"))}</th>
            <th>${escapeHtml(t("review.colOrgUnit"))}</th>
            <th>${escapeHtml(t("publish.colRequester"))}</th>
            <th>${escapeHtml(t("publish.colRequestedAt"))}</th>
            <th>${escapeHtml(t("review.colStatus"))}</th>
            <th>${escapeHtml(t("review.colAction"))}</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (r) => `
            <tr class="review-table-row">
              <td>
                <div class="file-name-info">
                  <strong class="upload-filename">${escapeHtml(releaseTitle(r))}</strong>
                  <small class="upload-size"><code>published.${escapeHtml(r.tableName)}</code> · v${escapeHtml(r.version)}</small>
                </div>
              </td>
              <td><code>${escapeHtml(r.ownerOrgUnit)}</code></td>
              <td>${escapeHtml(r.requestedByName || "—")}</td>
              <td>${escapeHtml(formatDate(r.requestedAt))}</td>
              <td>${statusBadge(r)}</td>
              <td>
                <button class="button ${r.canDecide ? "button-primary" : "button-ghost"} button-small" type="button"
                        data-release-id="${escapeHtml(r.releaseId)}">
                  ${escapeHtml(t(r.canDecide ? "review.btnReview" : "review.btnView"))}
                </button>
              </td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>`;
    list.querySelectorAll("[data-release-id]").forEach((button) => {
      button.addEventListener("click", () => void openDetail(button.getAttribute("data-release-id")));
    });
  }

  // --- detail and decision ------------------------------------------------------

  function closeModals() {
    document.querySelectorAll(".review-modal-backdrop").forEach((backdrop) => {
      backdrop.hidden = true;
    });
    activeRelease = null;
    activePreview = null;
  }

  async function openDetail(releaseId) {
    activeRelease = releases.find((r) => r.releaseId === releaseId) || null;
    activePreview = null;
    if (!activeRelease) return;

    $("#detail-modal-backdrop").hidden = false;
    $("#detail-reject-drawer").hidden = true;
    showAlert("#detail-alert", null);
    renderDetail();

    const status = $("#detail-status");
    status.textContent = t("review.loading");
    status.hidden = false;
    try {
      const result = await api(`/auth/releases/${encodeURIComponent(releaseId)}/preview`);
      if (!result.ok) throw new Error((result.body && result.body.error) || `HTTP ${result.status}`);
      if (!activeRelease || activeRelease.releaseId !== releaseId) return;
      activeRelease = result.body.release || activeRelease;
      activePreview = result.body.preview || null;
      renderDetail();
    } catch (error) {
      showAlert("#detail-alert", errorMessage(error.message), "error");
    } finally {
      status.hidden = true;
    }
  }

  function renderDetail() {
    const r = activeRelease;
    if (!r) return;

    $("#detail-heading").textContent = releaseTitle(r);
    $("#detail-subtitle").textContent = `polaris.curated.${r.tableName} → polaris.published.${r.tableName} · v${r.version}`;

    const facts = [
      ["review.colStatus", null, statusBadge(r)],
      ["review.colOrgUnit", r.ownerOrgUnit],
      ["publish.fieldAccess", t(`publish.access.${r.accessLevel}`)],
      ["publish.fieldCadence", t(`publish.cadence.${r.refreshCadence}`)],
      ["publish.fieldDomain", r.domain ? t(`publish.domain.${r.domain}`) : t("publish.domainNone")],
      ["publish.fieldTags", r.tags && r.tags.length ? r.tags.join(", ") : "—"],
      ["publish.colRequester", `${r.requestedByName || "—"} · ${formatDate(r.requestedAt)}`],
    ];
    if (r.decidedAt) {
      facts.push(["review.reviewerLabel", `${r.decidedByName || "—"} · ${formatDate(r.decidedAt)}`]);
    }
    if (r.status === "published") {
      facts.push(["publish.rowsPublished", formatNumber(r.rowCount)]);
      facts.push(["publish.publishedAt", formatDate(r.publishedAt)]);
      facts.push(["publish.snapshot", r.publishedSnapshotId || "—"]);
    }
    if (r.status === "rejected") {
      facts.push(["review.rejectionReasonLabel", r.rejectionReason || "—"]);
    }
    if (r.status === "failed") {
      facts.push(["publish.failureLabel", errorMessage(r.failureCode || "copy_failed")]);
    }

    $("#detail-meta").innerHTML = facts
      .map(
        ([labelKey, text, html]) =>
          `<div><dt>${escapeHtml(t(labelKey))}</dt><dd>${html !== undefined ? html : escapeHtml(text)}</dd></div>`
      )
      .join("");

    const description = releaseDescription(r);
    $("#detail-description-box").hidden = !description;
    $("#detail-description").textContent = description || "";
    $("#detail-changelog-box").hidden = !r.changelog;
    $("#detail-changelog").textContent = r.changelog || "";

    const columnsSection = $("#detail-columns-section");
    if (activePreview && Array.isArray(activePreview.columns)) {
      columnsSection.hidden = false;
      $("#detail-row-count").textContent = t("publish.rowCount", { count: formatNumber(activePreview.rowCount) });
      $("#detail-columns-tbody").innerHTML = activePreview.columns
        .map((c) => `<tr><td><code>${escapeHtml(c.name)}</code></td><td>${escapeHtml(c.type)}</td></tr>`)
        .join("");
    } else {
      columnsSection.hidden = true;
    }

    $("#detail-actions").hidden = !r.canDecide;
  }

  async function decide(action, payload) {
    if (!activeRelease) return;
    const id = activeRelease.releaseId;
    const buttons = document.querySelectorAll("#detail-actions button, #detail-reject-drawer button");
    buttons.forEach((b) => (b.disabled = true));
    try {
      const result = await api(`/auth/releases/${encodeURIComponent(id)}/${action}`, {
        method: "POST",
        body: JSON.stringify(payload || {}),
      });
      if (!result.ok) {
        showAlert("#detail-alert", errorMessage(result.body.error || `http_${result.status}`), "error");
        return;
      }
      $("#detail-reject-drawer").hidden = true;
      showAlert(
        "#detail-alert",
        t(action === "approve" ? "publish.approvedNotice" : "publish.rejectedNotice"),
        "success"
      );
      if (result.body.release) activeRelease = result.body.release;
      await loadReleases();
    } catch (_error) {
      showAlert("#detail-alert", t("login.serviceUnavailable"), "error");
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  // --- new request ---------------------------------------------------------------

  async function openRequestForm() {
    const form = $("#request-form");
    form.reset();
    showAlert("#request-alert", null);
    $("#request-modal-backdrop").hidden = false;

    const select = $("#request-table");
    select.innerHTML = `<option value="">${escapeHtml(t("review.loading"))}</option>`;
    const result = await api("/auth/releases/sources").catch(() => ({ ok: false, body: {} }));
    if (!result.ok) {
      select.innerHTML = "";
      showAlert("#request-alert", errorMessage(result.body.error || "trino_unavailable"), "error");
      return;
    }
    const tables = Array.isArray(result.body.tables) ? result.body.tables : [];
    select.innerHTML =
      `<option value="">${escapeHtml(t(tables.length ? "publish.chooseTable" : "publish.noCuratedTables"))}</option>` +
      tables.map((name) => `<option value="${escapeHtml(name)}">curated.${escapeHtml(name)}</option>`).join("");
  }

  async function submitRequest(event) {
    event.preventDefault();
    const value = (selector) => $(selector).value.trim();
    const payload = {
      tableName: value("#request-table"),
      titleTh: value("#request-title-th"),
      titleEn: value("#request-title-en") || null,
      descriptionTh: value("#request-description-th") || null,
      descriptionEn: value("#request-description-en") || null,
      ownerOrgUnit: value("#request-owner").toLowerCase(),
      domain: value("#request-domain") || null,
      accessLevel: value("#request-access"),
      refreshCadence: value("#request-cadence"),
      tags: value("#request-tags")
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      changelog: value("#request-changelog") || null,
    };
    if (!payload.tableName) return showAlert("#request-alert", errorMessage("invalid_table_name"), "error");
    if (!payload.titleTh) return showAlert("#request-alert", errorMessage("title_required"), "error");
    if (!/^[a-z0-9_-]{1,64}$/.test(payload.ownerOrgUnit)) {
      return showAlert("#request-alert", errorMessage("invalid_owner_org_unit"), "error");
    }

    const submit = $("#request-submit");
    submit.disabled = true;
    try {
      const result = await api("/auth/releases", { method: "POST", body: JSON.stringify(payload) });
      if (!result.ok) {
        showAlert("#request-alert", errorMessage(result.body.error || `http_${result.status}`), "error");
        return;
      }
      closeModals();
      currentFilter = "open";
      syncTabs();
      await loadReleases();
    } catch (_error) {
      showAlert("#request-alert", t("login.serviceUnavailable"), "error");
    } finally {
      submit.disabled = false;
    }
  }

  // --- wiring ----------------------------------------------------------------------

  function syncTabs() {
    document.querySelectorAll(".review-tab").forEach((tab) => {
      tab.classList.toggle("is-active", tab.getAttribute("data-filter") === currentFilter);
    });
  }

  function setupEvents() {
    document.querySelectorAll(".review-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        currentFilter = tab.getAttribute("data-filter") || "open";
        syncTabs();
        renderList();
      });
    });
    const langSwitch = $("#lang-switch");
    if (langSwitch) langSwitch.addEventListener("click", () => i18n.toggle());
    $("#publish-refresh-btn").addEventListener("click", () => void loadReleases());
    $("#publish-new-btn").addEventListener("click", () => void openRequestForm());
    $("#request-form").addEventListener("submit", (event) => void submitRequest(event));
    document.querySelectorAll("[data-close-modal]").forEach((button) => {
      button.addEventListener("click", closeModals);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeModals();
    });

    $("#btn-approve-release").addEventListener("click", () => void decide("approve"));
    $("#btn-reject-release").addEventListener("click", () => {
      $("#detail-reject-drawer").hidden = false;
      $("#release-reject-reason").focus();
    });
    $("#btn-cancel-reject").addEventListener("click", () => {
      $("#detail-reject-drawer").hidden = true;
    });
    $("#btn-confirm-reject").addEventListener("click", () => {
      const reason = $("#release-reject-reason").value.trim();
      if (!reason) {
        showAlert("#detail-alert", errorMessage("reason_required"), "error");
        return;
      }
      void decide("reject", { reason });
    });

    i18n.onChange(() => {
      renderList();
      if (activeRelease) renderDetail();
    });
  }

  function init() {
    setupEvents();
    void checkAccess();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

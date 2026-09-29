/*
 * Analyst review and approval interface.
 * Allows analysts and developers to review staged uploads, classify CSV columns,
 * inspect document text, and bridge approved datasets into Iceberg.
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

  let currentUploads = [];
  let currentFilter = "pending";
  let activeUpload = null;
  let activePreview = null;
  let columnStates = [];

  const ALLOWED_TIERS = ["analyst", "developer"];
  const ALLOWED_TYPES = ["VARCHAR", "INTEGER", "BIGINT", "DOUBLE", "BOOLEAN", "DATE", "TIMESTAMP"];

  function setStatus(key) {
    const status = document.querySelector("#review-status");
    const contentArea = document.querySelector("#review-content-area");
    if (!status || !contentArea) return;

    if (!key) {
      status.hidden = true;
      contentArea.hidden = false;
      return;
    }
    status.textContent = t(key);
    status.hidden = false;
    contentArea.hidden = true;
  }

  function escapeHtml(text) {
    if (!text) return "";
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, i);
    return `${value >= 10 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
  }

  function formatDate(isoString) {
    if (!isoString) return "—";
    try {
      const date = new Date(isoString);
      const locale = i18n.language === "th" ? "th-TH" : "en-US";
      return date.toLocaleString(locale, {
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
      window.location.replace(`/login?next=${encodeURIComponent("/review.html")}`);
      return;
    }
    if (!body.user || !ALLOWED_TIERS.includes(body.user.accessTier)) {
      setStatus("review.forbidden");
      return;
    }

    setStatus(null);
    void loadUploads();
  }

  async function loadUploads() {
    const listEl = document.querySelector("#review-list-container");
    if (listEl) {
      listEl.innerHTML = `<p class="review-empty-state">${escapeHtml(t("review.loading"))}</p>`;
    }

    try {
      const res = await fetch("/auth/reviews", { cache: "no-store", credentials: "same-origin" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      currentUploads = Array.isArray(data.uploads) ? data.uploads : [];
      updateStats();
      renderList();
    } catch (err) {
      console.error("[review] load uploads failed:", err);
      if (listEl) {
        listEl.innerHTML = `<p class="review-empty-state text-critical">${escapeHtml(t("login.serviceUnavailable"))}</p>`;
      }
    }
  }

  function updateStats() {
    const total = currentUploads.length;
    const pending = currentUploads.filter((u) => u.status === "pending_review").length;
    const registered = currentUploads.filter((u) => u.status === "registered").length;
    const rejected = currentUploads.filter((u) => u.status === "rejected").length;

    const elTotal = document.querySelector("#stat-total");
    const elPending = document.querySelector("#stat-pending");
    const elReg = document.querySelector("#stat-registered");
    const elRej = document.querySelector("#stat-rejected");
    const badgePending = document.querySelector("#badge-pending");

    if (elTotal) elTotal.textContent = String(total);
    if (elPending) elPending.textContent = String(pending);
    if (elReg) elReg.textContent = String(registered);
    if (elRej) elRej.textContent = String(rejected);
    if (badgePending) badgePending.textContent = String(pending);
  }

  function renderList() {
    const listEl = document.querySelector("#review-list-container");
    if (!listEl) return;

    let filtered = currentUploads;
    if (currentFilter === "pending") {
      filtered = currentUploads.filter((u) => u.status === "pending_review");
    } else if (currentFilter === "registered") {
      filtered = currentUploads.filter((u) => u.status === "registered");
    } else if (currentFilter === "rejected") {
      filtered = currentUploads.filter((u) => u.status === "rejected");
    }

    if (filtered.length === 0) {
      listEl.innerHTML = `<p class="review-empty-state">${escapeHtml(t("review.emptyList"))}</p>`;
      return;
    }

    const tableHtml = `
      <table class="review-table">
        <thead>
          <tr>
            <th data-i18n="review.colFilename">${escapeHtml(t("review.colFilename"))}</th>
            <th data-i18n="review.colOrgUnit">${escapeHtml(t("review.colOrgUnit"))}</th>
            <th data-i18n="review.colUploader">${escapeHtml(t("review.colUploader"))}</th>
            <th data-i18n="review.colUploadedAt">${escapeHtml(t("review.colUploadedAt"))}</th>
            <th data-i18n="review.colStatus">${escapeHtml(t("review.colStatus"))}</th>
            <th data-i18n="review.colAction">${escapeHtml(t("review.colAction"))}</th>
          </tr>
        </thead>
        <tbody>
          ${filtered.map((item) => renderTableRow(item)).join("")}
        </tbody>
      </table>
    `;

    listEl.innerHTML = tableHtml;

    listEl.querySelectorAll("[data-action='open-review']").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-upload-id");
        if (id) void openReviewModal(id);
      });
    });
  }

  function renderTableRow(item) {
    const kind = (item.fileKind || "csv").toUpperCase();
    let statusClass = "status-badge-pending";
    let statusText = t("upload.statusPending");

    if (item.status === "registered") {
      statusClass = "status-badge-registered";
      statusText = t("upload.statusRegistered");
    } else if (item.status === "rejected") {
      statusClass = "status-badge-rejected";
      statusText = t("upload.statusRejected");
    }

    const uploader = item.uploaderDisplayName
      ? `${escapeHtml(item.uploaderDisplayName)} (${escapeHtml(item.uploaderUsername || "")})`
      : escapeHtml(item.uploaderUsername || item.userId);

    const isPending = item.status === "pending_review";
    const btnClass = isPending ? "button-primary" : "button-ghost";
    const btnText = isPending ? t("review.btnReview") : t("review.btnView");

    return `
      <tr class="review-table-row">
        <td>
          <div class="file-name-cell">
            <span class="upload-kind-badge upload-kind-${escapeHtml(item.fileKind)}">${escapeHtml(kind)}</span>
            <div class="file-name-info">
              <strong class="upload-filename">${escapeHtml(item.originalFilename)}</strong>
              <small class="upload-size">${escapeHtml(formatBytes(item.sizeBytes))}</small>
            </div>
          </div>
        </td>
        <td><code>${escapeHtml(item.orgUnit)}</code></td>
        <td>${uploader}</td>
        <td>${escapeHtml(formatDate(item.uploadedAt))}</td>
        <td>
          <span class="upload-status-badge ${statusClass}">${escapeHtml(statusText)}</span>
        </td>
        <td>
          <button class="button ${btnClass} button-small" type="button" data-action="open-review" data-upload-id="${escapeHtml(item.uploadId)}">
            ${escapeHtml(btnText)}
          </button>
        </td>
      </tr>
    `;
  }

  async function openReviewModal(uploadId) {
    const backdrop = document.querySelector("#review-modal-backdrop");
    const modalStatus = document.querySelector("#modal-status");
    const modalAlert = document.querySelector("#modal-alert");
    if (!backdrop) return;

    activeUpload = currentUploads.find((u) => u.uploadId === uploadId) || null;
    activePreview = null;
    columnStates = [];

    backdrop.hidden = false;
    if (modalStatus) {
      modalStatus.textContent = t("review.loading");
      modalStatus.hidden = false;
    }
    if (modalAlert) modalAlert.hidden = true;

    // Reset sections
    document.querySelector("#modal-decision-info").hidden = true;
    document.querySelector("#modal-table-config-section").hidden = true;
    document.querySelector("#modal-columns-section").hidden = true;
    document.querySelector("#modal-data-preview-section").hidden = true;
    document.querySelector("#modal-document-section").hidden = true;
    document.querySelector("#modal-pending-actions").hidden = true;

    try {
      const res = await fetch(`/auth/reviews/${encodeURIComponent(uploadId)}/preview`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      activeUpload = data.upload;
      activePreview = data.preview;

      if (modalStatus) modalStatus.hidden = true;
      populateModal();
    } catch (err) {
      console.error("[review] preview error:", err);
      if (modalStatus) {
        modalStatus.textContent = t("login.serviceUnavailable");
      }
    }
  }

  function populateModal() {
    if (!activeUpload) return;

    const subtitle = document.querySelector("#modal-subtitle");
    if (subtitle) {
      subtitle.textContent = `${activeUpload.originalFilename} (${formatBytes(activeUpload.sizeBytes)})`;
    }

    // Meta section
    const metaOrg = document.querySelector("#modal-meta-org");
    const metaUploader = document.querySelector("#modal-meta-uploader");
    const metaSize = document.querySelector("#modal-meta-size");
    const metaDate = document.querySelector("#modal-meta-date");
    const metaStatus = document.querySelector("#modal-meta-status");
    const metaId = document.querySelector("#modal-meta-id");

    if (metaOrg) metaOrg.textContent = activeUpload.orgUnit;
    if (metaUploader) {
      metaUploader.textContent = activeUpload.uploaderDisplayName
        ? `${activeUpload.uploaderDisplayName} (${activeUpload.uploaderUsername || ""})`
        : activeUpload.uploaderUsername || activeUpload.userId;
    }
    if (metaSize) metaSize.textContent = formatBytes(activeUpload.sizeBytes);
    if (metaDate) metaDate.textContent = formatDate(activeUpload.uploadedAt);
    if (metaId) metaId.textContent = activeUpload.uploadId;

    const stewardNoteBox = document.querySelector("#modal-steward-note-box");
    const stewardNote = document.querySelector("#modal-steward-note");
    if (stewardNoteBox && stewardNote) {
      if (activeUpload.uploaderNote) {
        stewardNote.textContent = activeUpload.uploaderNote;
        stewardNoteBox.hidden = false;
      } else {
        stewardNoteBox.hidden = true;
      }
    }

    if (metaStatus) {
      let statusClass = "status-badge-pending";
      let statusText = t("upload.statusPending");
      if (activeUpload.status === "registered") {
        statusClass = "status-badge-registered";
        statusText = t("upload.statusRegistered");
      } else if (activeUpload.status === "rejected") {
        statusClass = "status-badge-rejected";
        statusText = t("upload.statusRejected");
      }
      metaStatus.innerHTML = `<span class="upload-status-badge ${statusClass}">${escapeHtml(statusText)}</span>`;
    }

    // Check if already registered or rejected
    if (activeUpload.status === "registered" || activeUpload.status === "rejected") {
      renderDecisionInfo();
      return;
    }

    // Pending review flow
    const pendingActions = document.querySelector("#modal-pending-actions");
    if (pendingActions) pendingActions.hidden = false;

    if (activeUpload.fileKind === "csv") {
      setupCsvReview();
    } else {
      setupDocumentReview();
    }
  }

  function renderDecisionInfo() {
    const decisionSection = document.querySelector("#modal-decision-info");
    const registeredCard = document.querySelector("#decision-registered-card");
    const rejectedCard = document.querySelector("#decision-rejected-card");
    if (!decisionSection || !registeredCard || !rejectedCard) return;

    decisionSection.hidden = false;

    if (activeUpload.status === "registered") {
      registeredCard.hidden = false;
      rejectedCard.hidden = true;

      const reviewerEl = document.querySelector("#decision-reviewer");
      const reviewedAtEl = document.querySelector("#decision-reviewed-at");
      const tableNameEl = document.querySelector("#decision-table-name");
      const colsCountEl = document.querySelector("#decision-cols-count");
      const sqlSnippetEl = document.querySelector("#decision-sql-snippet");

      if (reviewerEl) reviewerEl.textContent = activeUpload.reviewedByUsername || "—";
      if (reviewedAtEl) reviewedAtEl.textContent = formatDate(activeUpload.reviewedAt);

      if (activeUpload.targetTable) {
        const fullTable = `polaris.raw."${activeUpload.targetTable}"`;
        if (tableNameEl) tableNameEl.textContent = fullTable;
        if (colsCountEl) {
          colsCountEl.textContent = `${t("review.summaryIncluded")} ${activeUpload.columnsIncluded ?? 0} | ${t("review.summaryExcluded")} ${activeUpload.columnsExcluded ?? 0}`;
        }
        if (sqlSnippetEl) {
          sqlSnippetEl.textContent = `SELECT * FROM ${fullTable} LIMIT 10;`;
        }
      } else {
        if (tableNameEl) tableNameEl.textContent = t("upload.documentApproved");
        if (colsCountEl) colsCountEl.textContent = "";
        const sqlBox = registeredCard.querySelector(".decision-sql-box");
        if (sqlBox) sqlBox.hidden = true;
      }
    } else {
      registeredCard.hidden = true;
      rejectedCard.hidden = false;

      const rejectedByEl = document.querySelector("#decision-rejected-by");
      const rejectedAtEl = document.querySelector("#decision-rejected-at");
      if (rejectedByEl) rejectedByEl.textContent = activeUpload.reviewedByUsername || "—";
      if (rejectedAtEl) rejectedAtEl.textContent = formatDate(activeUpload.reviewedAt);

      const reasonRow = document.querySelector("#decision-rejection-reason-row");
      const reasonEl = document.querySelector("#decision-rejection-reason");
      if (reasonRow && reasonEl) {
        if (activeUpload.rejectionReason) {
          reasonEl.textContent = activeUpload.rejectionReason;
          reasonRow.hidden = false;
        } else {
          reasonRow.hidden = true;
        }
      }
    }
  }

  function setupCsvReview() {
    const tableConfigSec = document.querySelector("#modal-table-config-section");
    const columnsSec = document.querySelector("#modal-columns-section");
    const dataPreviewSec = document.querySelector("#modal-data-preview-section");
    const approveBtn = document.querySelector("#btn-approve-upload");

    if (tableConfigSec) tableConfigSec.hidden = false;
    if (columnsSec) columnsSec.hidden = false;
    if (dataPreviewSec) dataPreviewSec.hidden = false;
    if (approveBtn) approveBtn.textContent = t("review.btnApprove");

    // Suggest default table suffix
    const suffixInput = document.querySelector("#review-table-suffix");
    const prefixLabel = document.querySelector("#target-table-prefix");
    const fullPreview = document.querySelector("#target-table-full-preview");

    const orgPrefix = `steward_${activeUpload.orgUnit}_`;
    if (prefixLabel) prefixLabel.textContent = `polaris.raw.${orgPrefix}`;

    let defaultSuffix = (activeUpload.originalFilename || "data")
      .replace(/\.csv$/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .replace(/^_+|_+$/g, "");
    if (!defaultSuffix || !/^[a-z]/.test(defaultSuffix)) {
      defaultSuffix = `dataset_${Date.now().toString(36)}`;
    }

    if (suffixInput) {
      suffixInput.value = defaultSuffix;
      suffixInput.oninput = () => updateTablePreview();
    }
    updateTablePreview();

    // Setup columns state
    const rawColumns = activePreview?.columns || [];
    columnStates = rawColumns.map((c) => ({
      name: c.name,
      originalName: c.originalName || c.name,
      type: c.type || "VARCHAR",
      classification: c.classification || "public",
    }));

    renderColumnsTable();
    renderSampleDataGrid();
    updateClassificationSummary();
  }

  function updateTablePreview() {
    const suffixInput = document.querySelector("#review-table-suffix");
    const fullPreview = document.querySelector("#target-table-full-preview");
    if (!suffixInput || !fullPreview || !activeUpload) return;

    const val = suffixInput.value.trim().toLowerCase();
    fullPreview.textContent = `polaris.raw."steward_${activeUpload.orgUnit}_${val || "..."}"`;
  }

  function renderColumnsTable() {
    const tbody = document.querySelector("#columns-tbody");
    if (!tbody) return;

    const sampleRows = activePreview?.sampleRows || [];

    tbody.innerHTML = columnStates
      .map((col, idx) => {
        const sampleVal = sampleRows[0]?.[idx] ?? "";
        return `
          <tr data-col-idx="${idx}">
            <td>
              <input type="text" class="column-name-input" value="${escapeHtml(col.name)}"
                     pattern="^[a-z][a-z0-9_]*$" required>
            </td>
            <td><span class="original-header-label">${escapeHtml(col.originalName)}</span></td>
            <td>
              <select class="column-type-select">
                ${ALLOWED_TYPES.map(
                  (ty) => `<option value="${ty}" ${ty === col.type ? "selected" : ""}>${ty}</option>`
                ).join("")}
              </select>
            </td>
            <td>
              <select class="column-class-select classification-${col.classification}">
                <option value="public" ${col.classification === "public" ? "selected" : ""}>${escapeHtml(t("review.classPublic"))}</option>
                <option value="internal" ${col.classification === "internal" ? "selected" : ""}>${escapeHtml(t("review.classInternal"))}</option>
                <option value="sensitive" ${col.classification === "sensitive" ? "selected" : ""}>${escapeHtml(t("review.classSensitive"))}</option>
              </select>
            </td>
            <td><code class="sample-value-cell">${escapeHtml(sampleVal)}</code></td>
          </tr>
        `;
      })
      .join("");

    tbody.querySelectorAll(".column-name-input").forEach((input, i) => {
      input.addEventListener("input", (e) => {
        columnStates[i].name = e.target.value.trim().toLowerCase();
      });
    });

    tbody.querySelectorAll(".column-type-select").forEach((select, i) => {
      select.addEventListener("change", (e) => {
        columnStates[i].type = e.target.value;
      });
    });

    tbody.querySelectorAll(".column-class-select").forEach((select, i) => {
      select.addEventListener("change", (e) => {
        const val = e.target.value;
        columnStates[i].classification = val;
        select.className = `column-class-select classification-${val}`;
        updateClassificationSummary();
      });
    });
  }

  function updateClassificationSummary() {
    const publicCount = columnStates.filter((c) => c.classification === "public").length;
    const excludedCount = columnStates.length - publicCount;

    const elPublic = document.querySelector("#summary-public-count");
    const elExcluded = document.querySelector("#summary-excluded-count");
    const guardAlert = document.querySelector("#guardrail-alert");
    const approveBtn = document.querySelector("#btn-approve-upload");

    if (elPublic) elPublic.textContent = String(publicCount);
    if (elExcluded) elExcluded.textContent = String(excludedCount);

    if (publicCount === 0) {
      if (guardAlert) guardAlert.hidden = false;
      if (approveBtn) approveBtn.disabled = true;
    } else {
      if (guardAlert) guardAlert.hidden = true;
      if (approveBtn) approveBtn.disabled = false;
    }
  }

  function renderSampleDataGrid() {
    const thead = document.querySelector("#sample-grid-thead");
    const tbody = document.querySelector("#sample-grid-tbody");
    if (!thead || !tbody) return;

    const columns = activePreview?.columns || [];
    const sampleRows = activePreview?.sampleRows || [];

    thead.innerHTML = `
      <tr>
        ${columns.map((c) => `<th>${escapeHtml(c.name)}</th>`).join("")}
      </tr>
    `;

    tbody.innerHTML = sampleRows
      .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
      .join("");
  }

  function setupDocumentReview() {
    const docSec = document.querySelector("#modal-document-section");
    const approveBtn = document.querySelector("#btn-approve-upload");
    const textContent = document.querySelector("#document-text-content");
    const noText = document.querySelector("#document-no-text");

    if (docSec) docSec.hidden = false;
    if (approveBtn) {
      approveBtn.textContent = t("review.btnApproveDoc");
      approveBtn.disabled = false;
    }

    const hasText = Boolean(activePreview?.hasExtractedText && activePreview?.extractedText);
    if (hasText) {
      if (textContent) {
        textContent.textContent = activePreview.extractedText;
        textContent.hidden = false;
      }
      if (noText) noText.hidden = true;
    } else {
      if (textContent) textContent.hidden = true;
      if (noText) noText.hidden = false;
    }
  }

  async function handleApprove() {
    if (!activeUpload) return;
    const alertEl = document.querySelector("#modal-alert");
    const approveBtn = document.querySelector("#btn-approve-upload");
    const rejectBtn = document.querySelector("#btn-reject-upload");

    if (alertEl) alertEl.hidden = true;

    let payload = {};
    if (activeUpload.fileKind === "csv") {
      const suffixInput = document.querySelector("#review-table-suffix");
      const suffix = suffixInput?.value.trim().toLowerCase();
      if (!suffix || !/^[a-z][a-z0-9_]*$/.test(suffix)) {
        if (alertEl) {
          alertEl.textContent = t("review.errorApprove") + " Invalid table suffix format (a-z0-9_)";
          alertEl.hidden = false;
        }
        return;
      }

      // Check column names
      for (const col of columnStates) {
        if (!/^[a-z][a-z0-9_]*$/.test(col.name)) {
          if (alertEl) {
            alertEl.textContent = `${t("review.errorApprove")} Invalid column name "${col.name}"`;
            alertEl.hidden = false;
          }
          return;
        }
      }

      payload = {
        tableSuffix: suffix,
        columns: columnStates.map((c) => ({
          name: c.name,
          type: c.type,
          classification: c.classification,
        })),
      };
    }

    if (approveBtn) {
      approveBtn.disabled = true;
      approveBtn.textContent = t("review.btnApproving");
    }
    if (rejectBtn) rejectBtn.disabled = true;

    try {
      const res = await fetch(`/auth/reviews/${encodeURIComponent(activeUpload.uploadId)}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "same-origin",
      });

      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.detail || body.error || `HTTP ${res.status}`);
      }

      // Reload list and re-open as registered
      await loadUploads();
      void openReviewModal(activeUpload.uploadId);
    } catch (err) {
      console.error("[review] approval error:", err);
      if (alertEl) {
        alertEl.textContent = `${t("review.errorApprove")} ${err.message || String(err)}`;
        alertEl.hidden = false;
      }
      if (approveBtn) {
        approveBtn.disabled = false;
        approveBtn.textContent = activeUpload.fileKind === "csv" ? t("review.btnApprove") : t("review.btnApproveDoc");
      }
      if (rejectBtn) rejectBtn.disabled = false;
    }
  }

  function toggleRejectDrawer(show) {
    const drawer = document.querySelector("#modal-reject-drawer");
    const input = document.querySelector("#reject-reason-input");
    if (!drawer) return;
    drawer.hidden = !show;
    if (show && input) {
      input.value = "";
      input.focus();
    }
  }

  async function handleConfirmReject() {
    if (!activeUpload) return;
    const alertEl = document.querySelector("#modal-alert");
    const approveBtn = document.querySelector("#btn-approve-upload");
    const rejectBtn = document.querySelector("#btn-confirm-reject");
    const reasonInput = document.querySelector("#reject-reason-input");
    const reason = reasonInput?.value.trim() || "";

    if (approveBtn) approveBtn.disabled = true;
    if (rejectBtn) {
      rejectBtn.disabled = true;
      rejectBtn.textContent = t("review.btnRejecting");
    }

    try {
      const res = await fetch(`/auth/reviews/${encodeURIComponent(activeUpload.uploadId)}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
        credentials: "same-origin",
      });

      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);

      toggleRejectDrawer(false);
      await loadUploads();
      void openReviewModal(activeUpload.uploadId);
    } catch (err) {
      console.error("[review] rejection error:", err);
      if (alertEl) {
        alertEl.textContent = `${t("review.errorReject")} ${err.message || String(err)}`;
        alertEl.hidden = false;
      }
      if (approveBtn) approveBtn.disabled = false;
      if (rejectBtn) {
        rejectBtn.disabled = false;
        rejectBtn.textContent = t("review.btnConfirmReject");
      }
    }
  }

  function setupEvents() {
    // Refresh button
    const refreshBtn = document.querySelector("#review-refresh-btn");
    if (refreshBtn) refreshBtn.addEventListener("click", () => void loadUploads());

    // Filter tabs
    document.querySelectorAll(".review-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".review-tab").forEach((t) => t.classList.remove("is-active"));
        tab.classList.add("is-active");
        currentFilter = tab.getAttribute("data-filter") || "all";
        renderList();
      });
    });

    // Modal close
    const closeModal = () => {
      const backdrop = document.querySelector("#review-modal-backdrop");
      if (backdrop) backdrop.hidden = true;
      activeUpload = null;
      activePreview = null;
    };

    const closeBtn = document.querySelector("#modal-close-btn");
    const footerCloseBtn = document.querySelector("#modal-close-footer-btn");
    if (closeBtn) closeBtn.addEventListener("click", closeModal);
    if (footerCloseBtn) footerCloseBtn.addEventListener("click", closeModal);

    // Modal action buttons
    const approveBtn = document.querySelector("#btn-approve-upload");
    const rejectBtn = document.querySelector("#btn-reject-upload");
    const cancelRejectBtn = document.querySelector("#btn-cancel-reject");
    const confirmRejectBtn = document.querySelector("#btn-confirm-reject");

    if (approveBtn) approveBtn.addEventListener("click", () => void handleApprove());
    if (rejectBtn) rejectBtn.addEventListener("click", () => toggleRejectDrawer(true));
    if (cancelRejectBtn) cancelRejectBtn.addEventListener("click", () => toggleRejectDrawer(false));
    if (confirmRejectBtn) confirmRejectBtn.addEventListener("click", () => void handleConfirmReject());

    // Copy SQL button
    const copySqlBtn = document.querySelector("#btn-copy-sql");
    if (copySqlBtn) {
      copySqlBtn.addEventListener("click", async () => {
        const text = document.querySelector("#decision-sql-snippet")?.textContent || "";
        if (navigator.clipboard) {
          await navigator.clipboard.writeText(text);
          copySqlBtn.textContent = t("review.textCopied");
          setTimeout(() => (copySqlBtn.textContent = t("review.copyText")), 2000);
        }
      });
    }

    // Copy document text button
    const copyDocBtn = document.querySelector("#btn-copy-doc-text");
    if (copyDocBtn) {
      copyDocBtn.addEventListener("click", async () => {
        const text = document.querySelector("#document-text-content")?.textContent || "";
        if (navigator.clipboard) {
          await navigator.clipboard.writeText(text);
          copyDocBtn.textContent = t("review.textCopied");
          setTimeout(() => (copyDocBtn.textContent = t("review.copyText")), 2000);
        }
      });
    }

    // i18n change listener
    i18n.onChange(() => {
      renderList();
      if (activeUpload) populateModal();
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

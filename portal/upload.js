/*
 * Steward-only upload page. Gated client-side for UX (redirect/message when
 * signed out or wrong tier); the real gate is server-side in
 * services/auth/src/server.ts's /auth/uploads, which checks the session and
 * accessTier itself and never trusts anything this file decides.
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

  let cachedUploads = [];
  let currentFilter = "all";
  let searchQuery = "";

  function setStatus(key) {
    const status = document.querySelector("#upload-status");
    const formArea = document.querySelector("#upload-form-area");
    if (!status || !formArea) {
      return;
    }
    if (!key) {
      status.hidden = true;
      formArea.hidden = false;
      return;
    }
    status.textContent = t(key);
    status.hidden = false;
    formArea.hidden = true;
  }

  function showFormError(key) {
    const error = document.querySelector("#upload-error");
    if (!error) {
      return;
    }
    error.textContent = t(key);
    error.hidden = false;
    error.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function clearFormError() {
    const error = document.querySelector("#upload-error");
    if (error) {
      error.hidden = true;
      error.textContent = "";
    }
  }

  async function checkAccess() {
    setStatus("upload.checking");

    let response;
    try {
      response = await fetch("/auth/me", { cache: "no-store", credentials: "same-origin" });
    } catch (_error) {
      setStatus("login.serviceUnavailable");
      return;
    }

    const body = response.ok ? await response.json().catch(() => ({})) : {};
    if (!body.authenticated) {
      window.location.replace(`/login?next=${encodeURIComponent("/upload.html")}`);
      return;
    }
    if (!body.user || body.user.accessTier !== "steward") {
      setStatus("upload.forbidden");
      return;
    }

    const orgUnit = document.querySelector("#upload-org-unit");
    if (orgUnit) {
      orgUnit.textContent = body.user.orgUnit || "—";
    }
    setStatus(null);
    void fetchUploadHistory();
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return "0 B";
    }
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, i);
    return `${value >= 10 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
  }

  function formatDate(isoString) {
    if (!isoString) {
      return "—";
    }
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

  function escapeHtml(text) {
    if (!text) return "";
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function updateMetricCounters(uploads) {
    const list = Array.isArray(uploads) ? uploads : [];
    let pendingCount = 0;
    let registeredCount = 0;
    let rejectedCount = 0;

    for (const item of list) {
      if (item.status === "pending") pendingCount++;
      else if (item.status === "registered") registeredCount++;
      else if (item.status === "rejected") rejectedCount++;
    }

    const pendingEl = document.querySelector("#steward-stat-pending");
    const registeredEl = document.querySelector("#steward-stat-registered");
    const rejectedEl = document.querySelector("#steward-stat-rejected");
    const totalEl = document.querySelector("#steward-stat-total");

    if (pendingEl) pendingEl.textContent = String(pendingCount);
    if (registeredEl) registeredEl.textContent = String(registeredCount);
    if (rejectedEl) rejectedEl.textContent = String(rejectedCount);
    if (totalEl) totalEl.textContent = String(list.length);
  }

  function renderUploadHistory(uploads) {
    const listEl = document.querySelector("#upload-history-list");
    if (!listEl) {
      return;
    }
    updateMetricCounters(uploads);

    if (!Array.isArray(uploads) || uploads.length === 0) {
      listEl.innerHTML = `
        <div class="upload-history-empty-state">
          <div class="empty-icon-circle" aria-hidden="true">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
              <line x1="12" y1="18" x2="12" y2="12"></line>
              <line x1="9" y1="15" x2="15" y2="15"></line>
            </svg>
          </div>
          <p class="upload-history-empty">${t("upload.emptyHistory")}</p>
        </div>
      `;
      return;
    }

    // Apply Filter Tab
    let filtered = uploads;
    if (currentFilter !== "all") {
      filtered = filtered.filter((u) => u.status === currentFilter);
    }

    // Apply Search Query
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      filtered = filtered.filter((u) => {
        const name = (u.originalFilename || "").toLowerCase();
        const note = (u.uploaderNote || "").toLowerCase();
        const rej = (u.rejectionReason || "").toLowerCase();
        const table = (u.targetTable || "").toLowerCase();
        return name.includes(q) || note.includes(q) || rej.includes(q) || table.includes(q);
      });
    }

    if (filtered.length === 0) {
      listEl.innerHTML = `
        <div class="upload-history-empty-state">
          <p class="upload-history-empty">${t("upload.noMatch")}</p>
        </div>
      `;
      return;
    }

    const itemsHtml = filtered.map((item) => {
      const kind = (item.fileKind || "csv").toUpperCase();
      let statusClass = "status-badge-pending";
      let statusText = t("upload.statusPending");
      let statusDetail = t("upload.pendingDetail");
      let statusIcon = `<span class="status-pulse-dot" aria-hidden="true"></span>`;

      if (item.status === "registered") {
        statusClass = "status-badge-registered";
        statusText = t("upload.statusRegistered");
        statusIcon = `<span class="status-check-icon" aria-hidden="true">&#10003;</span>`;
        statusDetail = item.targetTable
          ? `${t("upload.targetTablePrefix")} <code class="target-table-code" title="คลิกเพื่อคัดลอก">polaris.raw.${escapeHtml(item.targetTable)}</code>`
          : t("upload.documentApproved");
      } else if (item.status === "rejected") {
        statusClass = "status-badge-rejected";
        statusText = t("upload.statusRejected");
        statusIcon = `<span class="status-cross-icon" aria-hidden="true">&#10005;</span>`;
        statusDetail = item.reviewedByUsername
          ? `Reviewed by ${escapeHtml(item.reviewedByUsername)}`
          : "";
      }

      let rejectionHtml = "";
      if (item.status === "rejected") {
        const reasonText = item.rejectionReason || t("upload.noReasonProvided");
        rejectionHtml = `
          <div class="upload-rejection-box" role="alert">
            <div class="rejection-icon" aria-hidden="true">&#9888;</div>
            <div class="rejection-body">
              <span class="upload-rejection-label">${escapeHtml(t("upload.rejectionReasonLabel"))}:</span>
              <span class="upload-rejection-text">${escapeHtml(reasonText)}</span>
            </div>
          </div>
        `;
      }

      let noteHtml = "";
      if (item.uploaderNote) {
        noteHtml = `
          <div class="upload-note-box">
            <span class="note-quote-icon" aria-hidden="true">&#128172;</span>
            <div class="note-body">
              <span class="upload-note-label">${escapeHtml(t("upload.yourNoteLabel"))}:</span>
              <span class="upload-note-text">${escapeHtml(item.uploaderNote)}</span>
            </div>
          </div>
        `;
      }

      return `
        <article class="upload-item upload-item-card">
          <div class="upload-item-main">
            <div class="upload-item-file">
              <span class="upload-kind-badge upload-kind-${kind.toLowerCase()}">${kind}</span>
              <strong class="upload-filename" title="${escapeHtml(item.originalFilename)}">${escapeHtml(item.originalFilename)}</strong>
            </div>
            <div class="upload-item-meta">
              <span class="file-size-tag">${formatBytes(item.sizeBytes)}</span>
              <span class="meta-dot">&bull;</span>
              <time datetime="${escapeHtml(item.uploadedAt)}" class="upload-time">${formatDate(item.uploadedAt)}</time>
            </div>
            ${noteHtml}
            ${rejectionHtml}
          </div>
          <div class="upload-item-status">
            <span class="upload-status-badge ${statusClass}">
              ${statusIcon}
              <span>${statusText}</span>
            </span>
            ${statusDetail ? `<div class="upload-status-detail">${statusDetail}</div>` : ""}
          </div>
        </article>
      `;
    }).join("");

    listEl.innerHTML = itemsHtml;
  }

  async function fetchUploadHistory() {
    const refreshBtn = document.querySelector("#upload-refresh-btn");
    if (refreshBtn) {
      refreshBtn.disabled = true;
      refreshBtn.classList.add("is-spinning");
    }
    try {
      const response = await fetch("/auth/uploads", {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        cachedUploads = Array.isArray(data.uploads) ? data.uploads : [];
        renderUploadHistory(cachedUploads);
      }
    } catch (error) {
      console.error("[upload] fetch history failed", error);
    } finally {
      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.classList.remove("is-spinning");
      }
    }
  }

  function handleFileSelected(file) {
    const idleArea = document.querySelector("#dropzone-idle");
    const previewArea = document.querySelector("#dropzone-selected-file");
    const filenameEl = document.querySelector("#preview-filename");
    const filesizeEl = document.querySelector("#preview-filesize");
    const iconEl = document.querySelector("#preview-file-icon");

    if (!file) {
      if (idleArea) idleArea.hidden = false;
      if (previewArea) previewArea.hidden = true;
      return;
    }

    if (filenameEl) filenameEl.textContent = file.name;
    if (filesizeEl) filesizeEl.textContent = formatBytes(file.size);
    if (iconEl) {
      const ext = (file.name.split(".").pop() || "file").toUpperCase();
      iconEl.textContent = ext;
      iconEl.className = `selected-file-icon icon-${ext.toLowerCase()}`;
    }

    if (idleArea) idleArea.hidden = true;
    if (previewArea) previewArea.hidden = false;
  }

  function clearSelectedFile() {
    const fileInput = document.querySelector("#upload-file");
    if (fileInput) {
      fileInput.value = "";
    }
    handleFileSelected(null);
  }

  function configureDropzone() {
    const dropzone = document.querySelector("#upload-dropzone");
    const fileInput = document.querySelector("#upload-file");
    const removeBtn = document.querySelector("#btn-remove-file");

    if (!dropzone || !fileInput) {
      return;
    }

    if (removeBtn) {
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        clearSelectedFile();
      });
    }

    dropzone.addEventListener("click", (e) => {
      if (e.target && e.target.closest("#btn-remove-file")) {
        return;
      }
      fileInput.click();
    });

    dropzone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fileInput.click();
      }
    });

    fileInput.addEventListener("change", () => {
      clearFormError();
      const file = fileInput.files && fileInput.files[0];
      handleFileSelected(file);
    });

    ["dragenter", "dragover"].forEach((eventName) => {
      dropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.add("is-dragover");
      });
    });

    ["dragleave", "dragend"].forEach((eventName) => {
      dropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.remove("is-dragover");
      });
    });

    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove("is-dragover");
      clearFormError();

      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        fileInput.files = e.dataTransfer.files;
        handleFileSelected(e.dataTransfer.files[0]);
      }
    });
  }

  function configureNoteCharCounter() {
    const noteInput = document.querySelector("#upload-note");
    const counterEl = document.querySelector("#note-char-count");
    if (!noteInput || !counterEl) {
      return;
    }
    noteInput.addEventListener("input", () => {
      const len = noteInput.value.length;
      counterEl.textContent = `${len} / 1000`;
    });
  }

  function configureTrackerFilters() {
    const tabsContainer = document.querySelector("#tracker-tabs");
    if (tabsContainer) {
      tabsContainer.addEventListener("click", (e) => {
        const tabBtn = e.target.closest(".tracker-tab");
        if (!tabBtn) return;
        tabsContainer.querySelectorAll(".tracker-tab").forEach((t) => t.classList.remove("is-active"));
        tabBtn.classList.add("is-active");
        currentFilter = tabBtn.dataset.filter || "all";
        renderUploadHistory(cachedUploads);
      });
    }

    const searchInput = document.querySelector("#upload-search-input");
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        searchQuery = searchInput.value;
        renderUploadHistory(cachedUploads);
      });
    }
  }

  function configureForm() {
    const form = document.querySelector("#upload-form");
    const submit = document.querySelector("#upload-submit");
    const fileInput = document.querySelector("#upload-file");
    const success = document.querySelector("#upload-success");
    const refreshBtn = document.querySelector("#upload-refresh-btn");
    const submitLabel = document.querySelector("#upload-submit-label") || submit;

    if (!form || !submit || !fileInput) {
      return;
    }

    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => void fetchUploadHistory());
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      clearFormError();
      if (success) {
        success.hidden = true;
      }

      const file = fileInput.files && fileInput.files[0];
      if (!file) {
        showFormError("upload.errorNoFile");
        return;
      }

      submit.disabled = true;
      const originalLabel = submitLabel.textContent;
      submitLabel.textContent = t("upload.submitting");

      try {
        const formData = new FormData();
        formData.append("file", file);
        const noteInput = document.querySelector("#upload-note");
        if (noteInput && noteInput.value.trim()) {
          formData.append("note", noteInput.value.trim());
        }
        const response = await fetch("/auth/uploads", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          body: formData,
        });

        if (response.ok) {
          if (success) {
            success.hidden = false;
            success.scrollIntoView({ behavior: "smooth", block: "nearest" });
          }
          form.reset();
          clearSelectedFile();
          const counterEl = document.querySelector("#note-char-count");
          if (counterEl) counterEl.textContent = "0 / 1000";
          void fetchUploadHistory();
          return;
        }

        const body = await response.json().catch(() => ({}));
        if (response.status === 401) {
          window.location.replace(`/login?next=${encodeURIComponent("/upload.html")}`);
        } else if (response.status === 403) {
          showFormError("upload.forbidden");
        } else if (response.status === 413) {
          showFormError("upload.errorTooLarge");
        } else if (response.status === 400 && body.error === "unsupported_file_type") {
          showFormError("upload.errorWrongType");
        } else if (response.status === 503) {
          showFormError("upload.notConfigured");
        } else {
          showFormError("upload.errorGeneric");
        }
      } catch (_error) {
        showFormError("login.serviceUnavailable");
      } finally {
        submit.disabled = false;
        submitLabel.textContent = originalLabel;
      }
    });
  }

  function configureLanguageSwitch() {
    const button = document.querySelector("#lang-switch");
    if (button) {
      button.addEventListener("click", () => {
        i18n.toggle();
        renderUploadHistory(cachedUploads);
      });
    }
  }

  configureForm();
  configureDropzone();
  configureNoteCharCounter();
  configureTrackerFilters();
  configureLanguageSwitch();
  void checkAccess();
})();

(() => {
  "use strict";

  const fallbackConfig = {
    pilotLabel: "Pilot",
    publishedReportsReady: false,
    publishedStateMessage: null,
    supportMessage: null,
    services: {
      reports: { port: "8088", protocol: "http:", path: "/dashboard/list/" },
      analytics: { port: "8088", protocol: "http:", path: "/sqllab/" }
    }
  };

  // i18n.js is loaded before this file. The fallback keeps the page working if
  // it ever fails to load: every string still has readable Thai in the markup,
  // and a key that reaches the reader is better than an empty element.
  const i18n = window.PSU_I18N || {
    language: "th",
    t: (key) => key,
    apply: () => {},
    onChange: () => () => {}
  };
  const t = (key, replacements) => i18n.t(key, replacements);

  /**
   * Deployment copy may be a plain string or a per-language map. Both are
   * accepted so an operator can stay with one language without editing code.
   */
  const localized = (value) => {
    if (value && typeof value === "object") {
      return value[i18n.language] ?? value.th ?? Object.values(value)[0] ?? "";
    }
    return value ?? "";
  };

  const config = window.PSU_PORTAL_CONFIG || fallbackConfig;
  /**
   * Built when the button is pressed, not at load, so it is copied in the
   * language the reader is actually looking at.
   */
  const buildRequestTemplate = () => [
    t("form.title"),
    "",
    t("form.line1"),
    t("form.line2"),
    t("form.line3"),
    t("form.line4"),
    t("form.line5"),
    t("form.line6"),
    "",
    t("form.note")
  ].join("\n");

  function updatePortalCopy() {
    document.querySelectorAll("[data-pilot-label]").forEach((node) => {
      node.textContent = localized(config.pilotLabel);
    });

    const supportMessage = document.querySelector("[data-support-message]");
    if (supportMessage) {
      supportMessage.textContent = localized(config.supportMessage) || t("config.support");
    }
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.className = "clipboard-helper";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) {
      throw new Error("copy command was not available");
    }
  }

  function configureRequestCopy() {
    const button = document.querySelector("#copy-request");
    const feedback = document.querySelector("#copy-feedback");
    if (!button || !feedback) {
      return;
    }

    button.addEventListener("click", async () => {
      try {
        await copyText(buildRequestTemplate());
        feedback.textContent = t("request.copied");
        button.textContent = t("request.copyButtonDone");
      } catch (_error) {
        feedback.textContent = t("request.copyFailed");
      }
    });
  }

  function formatCheckTime() {
    try {
      return new Intl.DateTimeFormat(i18n.language === "en" ? "en-GB" : "th-TH", {
        hour: "2-digit",
        minute: "2-digit"
      }).format(new Date());
    } catch (_error) {
      return t("status.checkedNow");
    }
  }

  function setReportStatus(state, title, detail) {
    const status = document.querySelector("#report-status");
    if (!status) {
      return;
    }
    status.classList.remove("is-checking", "is-ready", "is-down");
    status.classList.add(state);
    status.querySelector("strong").textContent = title;
    status.title = detail;
  }

  async function checkReportHealth() {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 3000);

    try {
      const response = await fetch("/api/health/reports", {
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`health returned ${response.status}`);
      }
      setReportStatus("is-ready", t("status.ready"), t("status.checkedAt", { time: formatCheckTime() }));
    } catch (_error) {
      setReportStatus("is-down", t("status.down"), t("status.checkedAt", { time: formatCheckTime() }));
    } finally {
      window.clearTimeout(timeout);
    }
  }


  function configureBackToTop() {
    const button = document.querySelector(".to-top");
    if (!button) {
      return;
    }

    let ticking = false;
    const sync = () => {
      button.classList.toggle("is-visible", window.scrollY > window.innerHeight * 0.6);
      ticking = false;
    };

    window.addEventListener("scroll", () => {
      if (!ticking) {
        ticking = true;
        window.requestAnimationFrame(sync);
      }
    }, { passive: true });

    sync();
  }


  // --- Dataset catalogue ---------------------------------------------------
  //
  // The catalogue is a file written by scripts/publish-portal-catalog.sh, not
  // an API. The portal has no route to the control-plane database and is not
  // given one; this keeps the filtering in a single reviewable place and lets
  // search run in the page, which is faster than a round trip and still works
  // while the database is down.
  //
  // Everything below builds DOM with createElement and textContent. The values
  // come from our own publisher, but a catalogue is exactly the kind of file
  // that grows new fields from new sources, so nothing here is ever treated as
  // markup.

  const AVAILABILITY = ["published", "withheld", "pending", "retired"];
  const availabilityOf = (value) =>
    AVAILABILITY.includes(value) ? value : "pending";

  const catalogState = {
    datasets: [],
    domains: [],
    query: "",
    domain: null,
    // Kept so the figures can be redrawn in the other language without
    // refetching the file.
    document: null
  };

  function formatThaiDateTime(isoString) {
    if (!isoString) {
      return null;
    }
    const parsed = new Date(isoString);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    try {
      return new Intl.DateTimeFormat(i18n.language === "en" ? "en-GB" : "th-TH", {
        dateStyle: "medium",
        timeStyle: "short"
      }).format(parsed);
    } catch (_error) {
      return parsed.toISOString().slice(0, 16).replace("T", " ");
    }
  }

  // Age matters more than the timestamp for freshness, and "8 วันที่แล้ว" is
  // read faster than a date the reader has to subtract from today.
  function formatAge(isoString) {
    if (!isoString) {
      return t("age.never");
    }
    const parsed = new Date(isoString);
    if (Number.isNaN(parsed.getTime())) {
      return t("age.unknown");
    }
    const minutes = Math.round((Date.now() - parsed.getTime()) / 60000);
    if (minutes < 60) {
      return t("age.minutes", { count: Math.max(minutes, 0) });
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
      return t("age.hours", { count: hours });
    }
    return t("age.days", { count: Math.round(hours / 24) });
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined && text !== null) {
      node.textContent = String(text);
    }
    return node;
  }

  /** Title and description in the active language, falling back to Thai. */
  const datasetTitle = (dataset) =>
    (i18n.language === "en" ? dataset.title_en : dataset.title) || dataset.title;
  const datasetDescription = (dataset) =>
    (i18n.language === "en" ? dataset.description_en : dataset.description) || dataset.description;

  function matchesQuery(dataset, query) {
    if (!query) {
      return true;
    }
    // Both languages are searched whichever one is on screen, so an English
    // reader who knows the Thai name still finds the dataset.
    const haystack = [
      dataset.title,
      dataset.description,
      dataset.title_en,
      dataset.description_en,
      dataset.key,
      dataset.owner,
      dataset.source,
      (catalogState.domains.find((d) => d.key === dataset.domain) || {}).label,
      (catalogState.domains.find((d) => d.key === dataset.domain) || {}).label_en
    ].filter(Boolean).join(" ").toLowerCase();
    return query.toLowerCase().split(/\s+/).filter(Boolean)
      .every((term) => haystack.includes(term));
  }

  function buildDatasetItem(dataset) {
    const item = element("li", "catalog-item");
    const availability = availabilityOf(dataset.availability);
    const modifier = `is-${availability}`;
    item.classList.add(modifier);

    const head = element("div", "catalog-item-head");
    head.append(element("h3", null, datasetTitle(dataset)));
    head.append(element("span", `state-badge ${modifier}`, t(`availability.${availability}`)));
    item.append(head);

    item.append(element("p", "catalog-key", dataset.key));

    const description = datasetDescription(dataset);
    if (description) {
      item.append(element("p", "catalog-description", description));
    }

    const facts = element("dl", "catalog-facts");
    const addFact = (term, value) => {
      const row = element("div");
      row.append(element("dt", null, term), element("dd", null, value));
      facts.append(row);
    };

    const domain = catalogState.domains.find((d) => d.key === dataset.domain);
    if (domain) {
      addFact(t("catalog.domain"), domainLabel(domain));
    }
    addFact(t("catalog.owner"), dataset.owner);
    addFact(t("catalog.updated"), formatAge(dataset.last_success_at));

    if (typeof dataset.column_count === "number" && dataset.column_count > 0) {
      addFact(t("catalog.columns"), t("catalog.columnsValue", {
        safe: dataset.safe_column_count,
        total: dataset.column_count
      }));
    }

    addFact(t("catalog.loadMode"), t(`loadMode.${dataset.load_mode}`));
    item.append(facts);

    const action = element(
      "a",
      "text-link catalog-action",
      t(availability === "published" ? "catalog.openReport" : "catalog.requestAccess")
    );
    // /reports.html is the tier-gated page that embeds the live dashboard
    // (portal/reports.js); it does its own "not signed in yet" redirect with
    // the right destination, so this link does not need the generic
    // data-requires-auth rewrite (which would only know how to send an
    // anonymous visitor back to *this* page, not on to /reports.html).
    action.href = availability === "published" ? "/reports.html" : "#request-data";
    item.append(action);

    return item;
  }

  function renderCatalogList() {
    const list = document.querySelector("#catalog-list");
    const count = document.querySelector("#catalog-count");
    const empty = document.querySelector("#catalog-empty");
    const clear = document.querySelector("#catalog-clear");
    if (!list || !count) {
      return;
    }

    const visible = catalogState.datasets.filter((dataset) =>
      (!catalogState.domain || dataset.domain === catalogState.domain) &&
      matchesQuery(dataset, catalogState.query));

    list.replaceChildren(...visible.map(buildDatasetItem));

    const filtered = Boolean(catalogState.domain || catalogState.query);
    count.textContent = filtered
      ? t("catalog.countFiltered", { visible: visible.length, total: catalogState.datasets.length })
      : t("catalog.countAll", { total: catalogState.datasets.length });

    if (empty) {
      empty.hidden = visible.length > 0;
    }
    if (clear) {
      clear.hidden = !filtered;
    }

    // The list is rebuilt on every search, so the sign-in state has to be
    // reapplied here as well as when it loads; whichever finishes last wins.
    renderCatalogAuthActions();
  }

  const domainLabel = (domain) =>
    (i18n.language === "en" ? domain.label_en : domain.label) || domain.label;

  function renderDomains() {
    const grid = document.querySelector("#domain-grid");
    if (!grid) {
      return;
    }

    const option = (key, label, count) => {
      const button = element("button", "domain-card");
      button.type = "button";
      button.setAttribute("aria-pressed", String(catalogState.domain === key));
      button.append(element("strong", null, label), element("span", "domain-count", count));
      button.addEventListener("click", () => {
        catalogState.domain = key;
        renderDomains();
        renderCatalogList();
      });
      return button;
    };

    grid.replaceChildren(
      option(null, t("domains.all"), catalogState.datasets.length),
      ...catalogState.domains.map((domain) =>
        option(domain.key, domainLabel(domain), domain.dataset_count))
    );
  }

  function renderCatalogStats(catalog) {
    document.querySelectorAll("[data-catalog-stat]").forEach((node) => {
      const value = catalog.stats[node.dataset.catalogStat];
      node.textContent = typeof value === "number"
        ? value.toLocaleString(i18n.language === "en" ? "en-GB" : "th-TH")
        : "—";
    });

    const generated = document.querySelector("[data-catalog-generated]");
    if (generated) {
      const stamp = formatThaiDateTime(catalog.generated_at);
      generated.textContent = stamp
        ? t("stats.generatedAt", { time: stamp })
        : t("stats.generatedUnknown");
    }
  }

  function focusCatalog() {
    const section = document.querySelector("#catalog");
    if (section) {
      section.scrollIntoView({ block: "start" });
    }
  }

  function configureCatalogSearch() {
    const form = document.querySelector("#catalog-search-form");
    const input = document.querySelector("#catalog-search");
    const clear = document.querySelector("#catalog-clear");

    if (input) {
      let timer = 0;
      input.addEventListener("input", () => {
        window.clearTimeout(timer);
        // Debounced so a fast typist does not re-render on every keystroke,
        // short enough that the list still feels attached to the keyboard.
        timer = window.setTimeout(() => {
          catalogState.query = input.value.trim();
          renderCatalogList();
        }, 150);
      });
    }

    if (form) {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        catalogState.query = input ? input.value.trim() : "";
        renderCatalogList();
        focusCatalog();
      });
    }

    // The chip label is translated, so the term it searches for has to come
    // from the same dictionary rather than from the text on screen.
    document.querySelectorAll("[data-search-key]").forEach((chip) => {
      chip.addEventListener("click", () => {
        catalogState.query = t(chip.dataset.searchKey);
        if (input) {
          input.value = catalogState.query;
        }
        renderCatalogList();
        focusCatalog();
      });
    });

    if (clear) {
      clear.addEventListener("click", () => {
        catalogState.query = "";
        catalogState.domain = null;
        if (input) {
          input.value = "";
        }
        renderDomains();
        renderCatalogList();
      });
    }
  }

  // Releases approved through /publish.html appear here as soon as they are
  // published, without waiting for scripts/publish-portal-catalog.sh to run
  // again. psu-auth answers with metadata only (no account, no snapshot id),
  // and when it is not running the catalogue simply shows what the file has.
  async function mergePublishedReleases() {
    let releases;
    try {
      const response = await fetch("/auth/catalog/releases", { cache: "no-store" });
      if (!response.ok) {
        return;
      }
      const body = await response.json();
      releases = Array.isArray(body.releases) ? body.releases : [];
    } catch (_error) {
      return;
    }

    for (const release of releases) {
      const dataset = {
        key: `published.${release.tableName}`,
        title: release.titleTh,
        title_en: release.titleEn || release.titleTh,
        description: release.descriptionTh,
        description_en: release.descriptionEn || release.descriptionTh,
        domain: release.domain || "unsorted",
        availability: "published",
        // A release replaces the whole published table at a pinned snapshot.
        load_mode: "full_refresh",
        owner: release.ownerOrgUnit,
        last_success_at: release.publishedAt,
        rows: release.rowCount
      };
      const existing = catalogState.datasets.findIndex((item) => item.key === dataset.key);
      if (existing >= 0) {
        catalogState.datasets[existing] = dataset;
        continue;
      }
      catalogState.datasets.push(dataset);
      const domain = catalogState.domains.find((item) => item.key === dataset.domain);
      if (domain) {
        domain.dataset_count = (domain.dataset_count || 0) + 1;
        domain.published_count = (domain.published_count || 0) + 1;
      }
    }
  }

  async function loadCatalog() {
    const errorNote = document.querySelector("#catalog-error");
    const count = document.querySelector("#catalog-count");

    try {
      const response = await fetch("/data/catalog.json", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`catalogue returned ${response.status}`);
      }
      const catalog = await response.json();

      catalogState.document = catalog;
      catalogState.datasets = Array.isArray(catalog.datasets) ? catalog.datasets : [];
      catalogState.domains = Array.isArray(catalog.domains) ? catalog.domains : [];
      await mergePublishedReleases();

      renderCatalogStats(catalog);
      renderDomains();
      renderCatalogList();
    } catch (_error) {
      // A missing catalogue is a normal state on a freshly built machine, so
      // it is reported as a note beside the empty list rather than as a
      // failure that implies something is broken.
      if (errorNote) {
        errorNote.hidden = false;
      }
      if (count) {
        count.textContent = t("catalog.none");
      }
      const generated = document.querySelector("[data-catalog-generated]");
      if (generated) {
        generated.textContent = t("stats.notPublished");
      }
      const grid = document.querySelector("#domain-grid");
      if (grid) {
        grid.replaceChildren();
      }
    }
  }

  // --- PSU Passport sign-in ------------------------------------------------
  //
  // The portal holds no credential and runs no part of the OpenID flow: it
  // asks /auth/me who is signed in, and links to /auth/login to start. Both
  // are proxied same-origin to the psu-auth service, so the session cookie
  // stays HttpOnly and this file never sees a token.
  //
  // When psu-auth is not running, /auth/me fails and every control below stays
  // hidden. A sign-in button that cannot work is worse than none.

  const authState = {
    available: false,
    authenticated: false,
    user: null
  };

  function currentPath() {
    return `${window.location.pathname}${window.location.search}${window.location.hash}`;
  }

  function signInHref() {
    // The dedicated login page, not /auth/login directly: it offers PSU
    // Passport and email-and-password from one place, and knows how to
    // disable the PSU Passport option gracefully when that service is not
    // configured. It reads its own "next" from this query string.
    return `/login?next=${encodeURIComponent(currentPath())}`;
  }

  function renderAccount() {
    const container = document.querySelector("#account");
    const signIn = document.querySelector("#account-signin");
    const card = document.querySelector("#account-card");
    if (!container || !signIn || !card) {
      return;
    }

    container.hidden = !authState.available;
    signIn.hidden = authState.authenticated;
    card.hidden = !authState.authenticated;
    signIn.href = signInHref();

    if (authState.authenticated && authState.user) {
      const name = document.querySelector("#account-name");
      const role = document.querySelector("#account-role");
      if (name) {
        name.textContent = authState.user.displayName || authState.user.username;
      }
      if (role) {
        // The granted tier, as the workspace header shows it; a password
        // account has no directory record, so its user type is always unknown.
        const tiers = ["none", "viewer", "viewer_exec", "analyst", "steward", "developer", "admin"];
        const tier = tiers.includes(authState.user.accessTier) ? authState.user.accessTier : "none";
        const label = t(`tier.${tier}`);
        const unit = authState.user.facultyNameTh || authState.user.orgUnit || authState.user.campusNameTh;
        role.textContent = unit ? `${label} · ${unit}` : label;
      }
    }

    const uploadLink = document.querySelector("#account-upload-link");
    if (uploadLink) {
      uploadLink.hidden = !(
        authState.authenticated && authState.user && authState.user.accessTier === "steward"
      );
    }

    const reviewLink = document.querySelector("#account-review-link");
    if (reviewLink) {
      reviewLink.hidden = !(
        authState.authenticated &&
        authState.user &&
        ["analyst", "developer", "admin"].includes(authState.user.accessTier)
      );
    }

    const adminLink = document.querySelector("#account-admin-link");
    if (adminLink) {
      adminLink.hidden = !(
        authState.authenticated && authState.user && ["admin", "developer"].includes(authState.user.accessTier)
      );
    }

    // Analysts ask for releases; stewards approve their own unit's.
    const publishLink = document.querySelector("#account-publish-link");
    if (publishLink) {
      publishLink.hidden = !(
        authState.authenticated &&
        authState.user &&
        ["analyst", "developer", "steward", "admin"].includes(authState.user.accessTier)
      );
    }
  }

  // Embedded-dashboard mounting itself now lives on the dedicated
  // /reports.html page (portal/reports.js) -- viewer_exec/analyst/developer
  // accounts are sent there instead of seeing it inline on this page.

  // Catalogue actions follow the sign-in state: an anonymous reader is sent to
  // PSU Passport first and returned to this page, rather than to a reporting
  // system that would bounce them to a second login they did not expect.
  function renderCatalogAuthActions() {
    document.querySelectorAll("[data-requires-auth]").forEach((link) => {
      if (!authState.available || authState.authenticated) {
        return;
      }
      link.href = signInHref();
      const label = link.firstChild;
      if (label && label.nodeType === Node.TEXT_NODE) {
        label.textContent = t("catalog.signInToOpen");
      }
    });
  }

  async function loadAuthState() {
    try {
      const response = await fetch("/auth/me", { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) {
        throw new Error(`auth/me returned ${response.status}`);
      }
      const body = await response.json();
      authState.available = true;
      authState.authenticated = Boolean(body.authenticated);
      authState.user = body.user || null;
    } catch (_error) {
      // Sign-in is not configured on this deployment, or the service is down.
      authState.available = false;
      authState.authenticated = false;
      authState.user = null;
    }
    renderAccount();
    renderCatalogAuthActions();
  }

  function configureSignOut() {
    const button = document.querySelector("#account-signout");
    if (!button) {
      return;
    }
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const response = await fetch("/auth/logout", {
          method: "POST",
          cache: "no-store",
          credentials: "same-origin"
        });
        const body = response.ok ? await response.json() : null;
        if (body && body.endSessionUrl) {
          window.location.href = body.endSessionUrl;
          return;
        }
      } catch (_error) {
        // Falls through to a reload: the cookie is cleared server-side, and a
        // reload is what tells the reader whether that worked.
      }
      window.location.reload();
    });
  }

  // --- Language ------------------------------------------------------------
  //
  // i18n.js swaps everything that came from the markup. What is drawn from
  // data -- the catalogue, the role plan, the account chip, the status pill --
  // has to be drawn again, which is what this does. Redrawing rather than
  // reloading means a search in progress and a chosen filter both survive the
  // switch.

  function redrawTranslatedContent() {
    updatePortalCopy();
    renderAccount();
    if (catalogState.document) {
      renderCatalogStats(catalogState.document);
    }
    renderDomains();
    renderCatalogList();
    void checkReportHealth();
  }

  function configureLanguageSwitch() {
    const button = document.querySelector("#lang-switch");
    if (button) {
      button.addEventListener("click", () => i18n.toggle());
    }
    i18n.onChange(() => redrawTranslatedContent());
  }

  updatePortalCopy();
  configureRequestCopy();
  checkReportHealth();
  configureBackToTop();
  configureCatalogSearch();
  loadCatalog();
  configureSignOut();
  loadAuthState();
  configureLanguageSwitch();
})();

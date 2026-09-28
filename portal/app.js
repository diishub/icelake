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
  const localHostnames = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  const isLocalHost = localHostnames.has(window.location.hostname) || window.location.hostname.endsWith(".localhost");

  /**
   * Roles carry keys, not sentences: the plan is rendered through the
   * dictionary so switching language re-renders it with everything else,
   * rather than leaving one panel in the language it was first drawn in.
   */
  const roles = {
    // "reports" used to build a direct cross-port Superset URL here, which
    // sent a viewer_exec/analyst account straight past the portal entirely.
    // /reports.html is the dedicated, tier-gated page that embeds a live
    // Superset dashboard (portal/reports.js) -- every "go to my reports"
    // affordance on this page (this button, the homepage teaser card, each
    // published catalogue item) now points there, instead of each building
    // its own direct Superset link. SQL Lab has no in-portal equivalent, so
    // "analyst" still goes straight to Superset for that.
    viewer: { action: "anchor", target: "/reports.html" },
    analyst: { action: "service", target: "analytics" },
    steward: { action: "anchor", target: "#request-data" },
    operator: {
      action: "anchor",
      target: isLocalHost ? "#operator-tools" : "#help",
      actionKey: isLocalHost ? "role.operator.actionLocal" : "role.operator.actionRemote",
      footnoteKey: isLocalHost ? "role.operator.footnoteLocal" : "role.operator.footnoteRemote"
    }
  };

  let activeRole = "viewer";

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

  function configureServiceLinks() {
    document.querySelectorAll("[data-service-link]").forEach((link) => {
      const serviceName = link.dataset.serviceLink;
      const isOperatorService = !["reports", "analytics"].includes(serviceName);

      if (isOperatorService && !isLocalHost) {
        link.removeAttribute("href");
        link.setAttribute("aria-disabled", "true");
        return;
      }

      link.href = buildServiceUrl(serviceName);
    });
  }

  function updatePortalCopy() {
    document.querySelectorAll("[data-pilot-label]").forEach((node) => {
      node.textContent = localized(config.pilotLabel);
    });

    const supportMessage = document.querySelector("[data-support-message]");
    if (supportMessage) {
      supportMessage.textContent = localized(config.supportMessage) || t("config.support");
    }

    const stateBadge = document.querySelector("#published-state-badge");
    const stateMessage = document.querySelector("#published-state-message");
    if (stateBadge && stateMessage) {
      stateMessage.textContent =
        localized(config.publishedStateMessage) || t("config.publishedState");
      stateBadge.textContent = t(config.publishedReportsReady ? "reports.stateReady" : "reports.stateEmpty");
      stateBadge.classList.toggle("is-ready", Boolean(config.publishedReportsReady));
      stateBadge.classList.toggle("is-empty", !config.publishedReportsReady);
    }
  }

  function applyRole(roleName, shouldPersist = true) {
    const name = roles[roleName] ? roleName : "viewer";
    const role = roles[name];
    activeRole = name;

    document.querySelectorAll("[data-role]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.role === name));
    });

    document.querySelector("#role-plan-label").textContent = t(`role.${name}.label`);
    document.querySelector("#role-plan-title").textContent = t(`role.${name}.title`);
    document.querySelector("#role-plan-description").textContent = t(`role.${name}.description`);
    document.querySelector("#role-plan-footnote").textContent =
      t(role.footnoteKey || `role.${name}.footnote`);

    const steps = document.querySelector("#role-plan-steps");
    steps.replaceChildren(...[1, 2, 3].map((index) => {
      const item = document.createElement("li");
      item.textContent = t(`role.${name}.step${index}`);
      return item;
    }));

    const action = document.querySelector("#role-plan-action");
    action.textContent = t(role.actionKey || `role.${name}.action`);
    action.href = role.action === "service" ? buildServiceUrl(role.target) : role.target;

    if (shouldPersist) {
      try {
        window.localStorage.setItem("psu-data-hub-role", roleName);
      } catch (_error) {
        // The role choice is only a convenience; the page works without storage.
      }
    }
  }

  function restoreRole() {
    let savedRole = "viewer";
    try {
      const candidate = window.localStorage.getItem("psu-data-hub-role");
      if (candidate && roles[candidate]) {
        savedRole = candidate;
      }
    } catch (_error) {
      // Private browsing can disable storage. Default guidance remains usable.
    }
    applyRole(savedRole, false);
  }

  function showOperatorToolsOnHost() {
    const operatorTools = document.querySelector("#operator-tools");
    if (operatorTools && isLocalHost) {
      operatorTools.hidden = false;
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
    status.querySelector("small").textContent = detail;
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


  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  // Entrance animation. The attribute is added here rather than in the markup
  // so that a parse error or a blocked script can never leave the page
  // permanently invisible: with no JavaScript the sections simply stand still.
  function revealOnScroll() {
    const targets = document.querySelectorAll(
      ".hero-copy, .first-visit-card, .plain-language-strip, .section-heading, " +
      ".stat-grid, .domain-grid, .catalog-toolbar, " +
      ".role-picker, .role-plan, .real-report-card, .demo-report, " +
      ".governance-copy, .governance-rules, .request-copy, .request-template, .faq-list, .support-callout, .operator-grid"
    );

    if (prefersReducedMotion.matches || !("IntersectionObserver" in window)) {
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry, index) => {
        if (!entry.isIntersecting) {
          return;
        }
        // Staggering siblings by 80ms reads as one movement rather than as
        // several elements arriving at once.
        entry.target.style.transitionDelay = `${Math.min(index, 4) * 80}ms`;
        entry.target.dataset.reveal = "shown";
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.15, rootMargin: "0px 0px -60px 0px" });

    targets.forEach((target) => {
      target.dataset.reveal = "";
      observer.observe(target);
    });
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
      facts.append(element("dt", null, term));
      facts.append(element("dd", null, value));
    };

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
    action.append(element("span", null, "\u2192"));
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

  function renderDomains() {
    const grid = document.querySelector("#domain-grid");
    if (!grid) {
      return;
    }

    grid.replaceChildren(...catalogState.domains.map((domain) => {
      const button = element("button", "domain-card");
      button.type = "button";
      button.dataset.domain = domain.key;
      button.setAttribute("aria-pressed", String(catalogState.domain === domain.key));
      button.append(element("strong", null,
        (i18n.language === "en" ? domain.label_en : domain.label) || domain.label));
      button.append(element("span", "domain-count",
        t("domains.datasetCount", { count: domain.dataset_count })));
      button.append(element("small", null,
        t("domains.publishedCount", { count: domain.published_count })));
      button.append(element("span", "domain-arrow", "\u2192"));
      button.addEventListener("click", () => {
        catalogState.domain = catalogState.domain === domain.key ? null : domain.key;
        renderDomains();
        renderCatalogList();
        document.querySelector("#catalog").scrollIntoView({ block: "start" });
      });
      return button;
    }));
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
        const type = t(`userType.${authState.user.userType || "unknown"}`);
        const unit = authState.user.facultyNameTh || authState.user.campusNameTh;
        role.textContent = unit ? `${type} · ${unit}` : type;
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
        (authState.user.accessTier === "analyst" || authState.user.accessTier === "developer")
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
    applyRole(activeRole, false);
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

  document.querySelectorAll("[data-role]").forEach((button) => {
    button.addEventListener("click", () => applyRole(button.dataset.role));
  });

  configureServiceLinks();
  updatePortalCopy();
  showOperatorToolsOnHost();
  restoreRole();
  configureRequestCopy();
  checkReportHealth();
  revealOnScroll();
  configureBackToTop();
  configureCatalogSearch();
  loadCatalog();
  configureSignOut();
  loadAuthState();
  configureLanguageSwitch();
})();

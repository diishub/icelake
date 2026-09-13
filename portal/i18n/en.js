/*
 * English strings for the PSU Data Hub portal.
 *
 * Data only: this file declares one object and nothing else runs here. To add
 * or change wording, edit the value; to add a language, copy this file, change
 * the code below, and add it to the script tags in index.html and to the
 * SUPPORTED list in i18n/index.js.
 *
 * Every key must exist in every language file. scripts/test-portal-i18n.sh
 * fails the build when one is missing, because a key that only exists in one
 * language shows up as a single foreign line in the middle of a page and is
 * easy to miss in review.
 */
window.PSU_I18N_STRINGS = window.PSU_I18N_STRINGS || {};
window.PSU_I18N_STRINGS.en = {
  // --- Document ---
  "meta.description": "PSU Data Hub, the central data and reporting service of Prince of Songkla University",

  // --- Language switch ---
  "lang.switchTo": "ไทย",
  "lang.switchLabel": "Switch to Thai",

  // --- Skip link ---
  "skip": "Skip to main content",

  // --- Brand ---
  "brand.home": "PSU Data Hub home",
  "brand.tagline": "University data hub",

  // --- Navigation ---
  "nav.label": "Main menu",
  "nav.catalog": "Find data",
  "nav.start": "Get started",
  "nav.reports": "Reports",
  "nav.help": "Help",

  // --- Reporting service status ---
  "status.checking": "Checking the reporting service",
  "status.checkingDetail": "One moment",
  "status.ready": "Reporting service responding",
  "status.down": "Reporting service not responding",
  "status.checkedAt": "Checked {time}",
  "status.checkedNow": "just now",

  // --- Account ---
  "account.signIn": "Sign in",
  "account.signOut": "Sign out",
  "account.checking": "Checking access",
  "account.fallbackName": "Signed in",

  // --- Directory groups ---
  "userType.student": "Student",
  "userType.staff": "Staff",
  "userType.unknown": "Group not confirmed",

  // --- Hero ---
  "hero.eyebrow": "PSU DATA HUB",
  "hero.titleLine1": "The university's data,",
  "hero.titleLine2": "all in one place",
  "hero.lead": "The central dataset catalogue tells you what data exists, who owns it, when it was last updated, and how to ask for access.",

  // --- Search ---
  "search.label": "Search datasets",
  "search.placeholder": "try students, staff, courses",
  "search.submit": "Search",
  "search.hint": "Searches titles, descriptions, domains and data owners",
  "search.suggestionsLabel": "Common searches",
  "search.tryPrefix": "Try",
  "search.term1": "students",
  "search.term2": "staff",
  "search.term3": "courses",
  "search.term4": "enrolment",

  // --- First-visit card ---
  "firstVisit.kicker": "First time here",
  "firstVisit.title": "Three steps, no wrong turns",
  "firstVisit.step1": "Search the catalogue",
  "firstVisit.step1Detail": "See whether what you need already exists",
  "firstVisit.step2": "Check the owner and freshness",
  "firstVisit.step2Detail": "Know who is responsible and when it last landed",
  "firstVisit.step3": "Open a report, or request access",
  "firstVisit.step3Detail": "No access yet? Use the request form on this page",

  // --- Scope strip ---
  "strip.title": "This page is the main entrance for everyday users",
  "strip.detail": "The storage, processing and administration tools run behind it",
  "strip.side": "Access to real data is still checked against your account every time",

  // --- 01 Platform figures ---
  "stats.label": "Lakehouse status",
  "stats.title": "Real numbers, not marketing",
  "stats.lead": "Every figure below is read straight from the ingestion control plane. When there is nothing yet, it says so.",
  "stats.total": "Datasets in the catalogue",
  "stats.totalHint": "Including those not yet published",
  "stats.published": "Published",
  "stats.publishedHint": "At least one successful ingestion run",
  "stats.owners": "Data owners",
  "stats.ownersHint": "Who approved each source",
  "stats.withheld": "Columns withheld",
  "stats.withheldHint": "Classified as not public, so never ingested",
  "stats.reading": "Reading the catalogue…",
  "stats.generatedAt": "Catalogue last published {time} — the latest snapshot an administrator released, not a live figure",
  "stats.generatedUnknown": "Catalogue publication time unknown",
  "stats.notPublished": "The dataset catalogue has not been published yet",

  // --- 02 Domains ---
  "domains.label": "Browse by domain",
  "domains.title": "Central data sits in three domains",
  "domains.lead": "Select a domain to filter the catalogue below. Select it again to clear the filter.",
  "domains.groupLabel": "Filter by data domain",
  "domains.loading": "Reading domains…",
  "domains.datasetCount": "{count} datasets",
  "domains.publishedCount": "{count} published",

  // --- 03 Catalogue ---
  "catalog.label": "Dataset catalogue",
  "catalog.title": "What is in the lakehouse, and how fresh",
  "catalog.notFound": "Cannot find what you need",
  "catalog.loading": "Loading…",
  "catalog.clear": "Clear filters",
  "catalog.countAll": "{total} datasets",
  "catalog.countFiltered": "{visible} of {total} datasets",
  "catalog.none": "No catalogue yet",
  "catalog.empty": "No dataset matches that search. Try a broader term, or ask the data team to help you find it.",
  "catalog.errorPrefix": "The catalogue could not be read. The rest of this page still works. On a freshly built machine an administrator has to run",
  "catalog.errorSuffix": "once.",
  "catalog.owner": "Data owner",
  "catalog.updated": "Last updated",
  "catalog.columns": "Columns published",
  "catalog.columnsValue": "{safe} of {total} columns",
  "catalog.loadMode": "Ingestion",
  "catalog.openReport": "Open in the report workspace",
  "catalog.requestAccess": "Request this dataset",
  "catalog.signInToOpen": "Sign in to open reports",

  // --- Ingestion modes ---
  "loadMode.full_refresh": "Full reload each run",
  "loadMode.incremental": "Incremental",

  // --- Dataset availability ---
  "availability.published": "Published",
  "availability.withheld": "No publishable columns",
  "availability.pending": "Awaiting first run",
  "availability.retired": "Withdrawn",

  // --- Relative time ---
  "age.never": "Never ingested successfully",
  "age.unknown": "Time unknown",
  "age.minutes": "{count} minutes ago",
  "age.hours": "{count} hours ago",
  "age.days": "{count} days ago",

  // --- 04 Role picker ---
  "roles.label": "Start from your role",
  "roles.title": "What brings you here today?",
  "roles.lead": "This only tailors the guidance on this page. It does not add or remove any data access.",
  "roles.groupLabel": "Choose a role for tailored guidance",
  "roles.viewer": "Executive / report reader",
  "roles.viewerDetail": "Wants the numbers and a way to follow them",
  "roles.analyst": "Data analyst",
  "roles.analystDetail": "Wants to explore data and build reports",
  "roles.steward": "Data owner / coordinator",
  "roles.stewardDetail": "Wants to send or update a unit's data",
  "roles.operator": "Platform team",
  "roles.operatorDetail": "Looks after accounts, pipelines and system status",

  // --- Role plans ---
  "role.viewer.label": "Recommended start for report readers",
  "role.viewer.title": "Open the reports you have access to",
  "role.viewer.description": "Start from the list of reports opened to you. No need to build a chart or write a query.",
  "role.viewer.step1": "Sign in with your Pilot account",
  "role.viewer.step2": "Choose a report from the list you can open",
  "role.viewer.step3": "Check the data owner and the last update",
  "role.viewer.action": "Go to my reports",
  "role.viewer.footnote": "An empty list does not mean something is broken: it means no report has been published to this account yet.",
  "role.analyst.label": "Recommended start for analysts",
  "role.analyst.title": "Start from the data you are allowed to use",
  "role.analyst.description": "Check that the dataset you need exists first, then open the analysis workspace. Avoid making copies of data outside the platform.",
  "role.analyst.step1": "Confirm the question and the data owner",
  "role.analyst.step2": "Check your access to the datasets you need",
  "role.analyst.step3": "Open the workspace and save results you have checked",
  "role.analyst.action": "Open the analysis workspace",
  "role.analyst.footnote": "There are no sample tables in this first round. If you find nothing, talk to the data owner before writing a new query.",
  "role.steward.label": "Recommended start for data owners",
  "role.steward.title": "Prepare the data with an owner and a purpose",
  "role.steward.description": "Do not send files through this page yet. Start with the supporting information the platform team needs to take it on safely.",
  "role.steward.step1": "Name the dataset and who is responsible for it",
  "role.steward.step2": "Remove personal data that is not needed",
  "role.steward.step3": "Agree a transfer channel with the data team",
  "role.steward.action": "See what to prepare",
  "role.steward.footnote": "Do not send real files by email or chat until the transfer location and the approver are agreed.",
  "role.operator.label": "Recommended start for the platform team",
  "role.operator.title": "Check the user-facing side before the engine room",
  "role.operator.description": "Start from the reports users need to see and the state of the data, then open the technical tools only when there is a reason to.",
  "role.operator.step1": "Check that user reports actually open",
  "role.operator.step2": "Confirm access from the account, not from the choice on this page",
  "role.operator.step3": "Open the tools only from the host machine",
  "role.operator.actionLocal": "Go to the platform team area",
  "role.operator.actionRemote": "See the scope of support",
  "role.operator.footnoteLocal": "The tool links are shown on this machine for convenience, but each service still checks access on its own.",
  "role.operator.footnoteRemote": "Platform tools are limited to the host machine or the administrators' network, so they are not shown from here.",

  // --- 05 Reports ---
  "reports.label": "See the destination first",
  "reports.title": "Reports you can read the first time",
  "reports.helpLink": "What to do when a report does not load",
  "reports.myReports": "Reports my account can open",
  "reports.emptyTitle": "If you land on an empty page",
  "reports.emptyDetail": "Come back here. There is no need to try the technical menus: tell the data team which report or dataset you need.",
  "reports.enter": "Open the report workspace",
  "reports.stateReady": "Reports available",
  "reports.stateEmpty": "No published reports yet",

  // --- Sample report ---
  "demo.eyebrow": "Sample report",
  "demo.title": "Overview of data received from units",
  "demo.badge": "100% fictional data",
  "demo.metricsLabel": "Sample figures",
  "demo.metric1": "Units that have submitted",
  "demo.metric1Trend": "+2 this week",
  "demo.metric2": "Passed quality checks",
  "demo.metric2Trend": "target 95%",
  "demo.metric3": "Items to follow up",
  "demo.metric3Unit": "sets",
  "demo.metric3Trend": "check today",
  "demo.chartLabel": "Sample bar chart showing the share of data passing quality checks for three domains",
  "demo.chartTitle": "Share passing quality checks",
  "demo.chartUpdated": "Sample updated 29 Aug 2026",
  "demo.bar1": "Academic",
  "demo.bar2": "Students",
  "demo.bar3": "Staff",
  "demo.disclaimer": "Every figure here was invented to show how to read the screen. None of it is university data.",

  // --- 06 Governance ---
  "governance.label": "Why this data can be trusted",
  "governance.title": "Rules the pipeline enforces, not promises it makes",
  "governance.lead": "Every dataset in the lakehouse passed these three gates. When a gate cannot be answered, nothing is ingested and the reason is recorded instead.",
  "governance.cta": "See the whole catalogue",
  "governance.rule1": "The owner and the lawful basis are named first",
  "governance.rule1Detail": "The source registry rejects a row with no approver, lawful basis or retention period. That is a database constraint, not a field on a form.",
  "governance.rule2": "Columns are filtered by the classification the source publishes",
  "governance.rule2Before": "Only columns the data owner classified as public at level 0 are ingested. A label this platform has never seen is treated as not safe. Withheld so far:",
  "governance.rule2After": "columns",
  "governance.rule3": "The destination is checked before every connection",
  "governance.rule3Detail": "The pipeline checks the destination against an allowlist and a denylist before opening a connection. The denylist always wins, and when in doubt it does not connect.",

  // --- 07 Data request ---
  "request.label": "When the data is not ready yet",
  "request.title": "Describe what you need in a form the data team can act on",
  "request.lead": "This round deliberately has no fake “request sent” button, because identity and approval are not yet wired together. You can copy a complete request form and send it through your unit's internal channel right away.",
  "request.copy": "Copy the data request form",
  "request.copied": "Copied — paste it into your unit's internal channel",
  "request.copyButtonDone": "Copied ✓",
  "request.copyFailed": "The browser refused to copy automatically. Please copy from the form shown beside this.",
  "request.templateLabel": "Sample data request form",
  "request.templateTitle": "Short request form",
  "request.q1": "What data do you need",
  "request.a1": "A dataset name from the catalogue, or the question you need answered",
  "request.q2": "What will it be used for",
  "request.a2": "Which decision, report or piece of research",
  "request.q3": "Period and level of detail",
  "request.a3": "Only as much as you need. Avoid personal data.",
  "request.q4": "Likely data owner",
  "request.a4": "Faculty, office, centre or unit",
  "request.q5": "When do you need it",
  "request.a5": "The date, and why that deadline",

  // --- Request form copy (copied to the clipboard) ---
  "form.title": "PSU data request (short form)",
  "form.line1": "1. What data or question do you need:",
  "form.line2": "2. Which decision, report or research it supports:",
  "form.line3": "3. Period and level of detail required:",
  "form.line4": "4. Data owner you believe is involved:",
  "form.line5": "5. Date you need it by, and why:",
  "form.line6": "6. Requester and unit:",
  "form.note": "Note: please do not attach personal data or passwords to this message",

  // --- 08 Help ---
  "help.label": "If you get stuck",
  "help.title": "Short answers before you ask for help",
  "help.q1": "I found a dataset but it says it is not published",
  "help.a1": "It is registered but has not completed an ingestion run, or the owner has withdrawn it. The catalogue still shows the name and the owner so you can ask the right person, rather than having to guess whether it exists at all.",
  "help.q2": "Why do some datasets have fewer columns than the source?",
  "help.a2": "The pipeline selects only the columns the data owner classified as public. The rest are never copied out of the source at all. The “columns published” figure on each entry states the ratio directly.",
  "help.q3": "I signed in and the page is empty. What does that mean?",
  "help.a3": "Usually that no report has been published to your account yet, not that anything is broken. Come back here and tell the data team which data or question you need.",
  "help.q4": "Does choosing a role on this page change my access?",
  "help.a4": "No. The choice only tailors the guidance. Real access is checked against your account, your groups and the data policy every time.",
  "help.q5": "Can I upload a data file through this page?",
  "help.a5": "Not in this round, so that important files do not end up somewhere nobody owns. Data owners should agree a secure transfer channel with the data team first.",
  "help.stuckTitle": "Still stuck?",

  // --- Platform team area ---
  "operator.label": "Host machine only",
  "operator.title": "Platform team area",
  "operator.lead": "These links appear only when the portal is opened from the machine running the stack. Real access is still checked by each service.",
  "operator.ingestion": "Manage ingestion pipelines",
  "operator.ingestionDetail": "NiFi · administrators only",
  "operator.query": "Follow analytical queries",
  "operator.queryDetail": "Trino · administrators only",
  "operator.vectors": "Inspect the search index",
  "operator.vectorsDetail": "Qdrant · administrators only",
  "operator.storage": "Inspect object storage",
  "operator.storageDetail": "RustFS · never edit metadata directly",
  "operator.users": "Manage BI accounts and roles",
  "operator.usersDetail": "PSU Reports · admins only",

  // --- Footer ---
  "footer.tagline": "A friendly layer on an open-source data platform",
  "footer.meta": "No real personal data until the data governance team approves it",

  // --- Back to top ---
  "toTop": "Back to top",

  // --- No-JavaScript notice ---
  "noscript": "This page needs JavaScript to build the service links and read the dataset catalogue. Please enable JavaScript or ask an administrator for help.",

  // --- Fallbacks for deployment copy ---
  "config.publishedState": "No report has been published for the Pilot round yet",
  "config.support": "Contact the data team through your unit's internal channel. Never send a password.",

  // --- Login page ---
  "login.pageTitle": "Sign in · PSU Data Hub",
  "login.backHome": "Back to home",
  "login.heading": "Sign in",
  "login.subheading": "Sign in to open reports and manage your datasets",
  "login.checking": "Checking your sign-in status…",
  "login.alreadySignedIn": "Already signed in. Taking you where you were headed…",
  "login.psuPassportButton": "Sign in with PSU Passport",
  "login.psuPassportUnavailable": "PSU Passport is not enabled on this deployment. Use email and password below instead.",
  "login.serviceUnavailable": "Sign-in is not available right now. Please try again, or contact an administrator.",
  "login.divider": "or",
  "login.emailLabel": "Email",
  "login.emailPlaceholder": "you@psu.ac.th",
  "login.passwordLabel": "Password",
  "login.passwordPlaceholder": "Your password",
  "login.submit": "Sign in with email",
  "login.submitting": "Signing in…",
  "login.noAccountNote": "Email-and-password accounts are created by an administrator only. Contact the data team if you do not have one yet.",
  "login.errorInvalidRequest": "Please enter both an email and a password.",
  "login.errorInvalidCredentials": "Incorrect email or password.",
  "login.errorAccountDisabled": "This account has been disabled. Please contact an administrator.",
  "login.errorRateLimited": "Too many attempts. Please wait {seconds} seconds and try again.",
  "login.errorGeneric": "Sign-in failed. Please try again.",
};

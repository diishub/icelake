(() => {
  "use strict";

  const fallbackConfig = {
    pilotLabel: "Pilot",
    publishedReportsReady: false,
    publishedStateMessage: "ยังไม่มีรายงานที่ประกาศพร้อมใช้ในรอบ Pilot",
    supportMessage: "ติดต่อทีมข้อมูลผ่านช่องทางภายในที่หน่วยงานกำหนด โดยไม่ส่งรหัสผ่าน",
    services: {
      reports: { port: "8088", protocol: "http:", path: "/dashboard/list/" },
      analytics: { port: "8088", protocol: "http:", path: "/sqllab/" }
    }
  };

  const config = window.PSU_PORTAL_CONFIG || fallbackConfig;
  const localHostnames = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  const isLocalHost = localHostnames.has(window.location.hostname) || window.location.hostname.endsWith(".localhost");

  const roles = {
    viewer: {
      label: "ทางเริ่มต้นสำหรับผู้ใช้รายงาน",
      title: "เปิดรายงานที่ได้รับสิทธิ์",
      description: "เริ่มจากรายการรายงานที่เปิดให้คุณ ไม่ต้องเข้าเมนูสร้างกราฟหรือเขียนคำสั่งข้อมูล",
      steps: [
        "เข้าสู่ระบบด้วยบัญชี Pilot",
        "เลือกรายงานจากรายการที่เปิดได้",
        "ตรวจเจ้าของข้อมูลและวันที่ปรับปรุง"
      ],
      actionLabel: "ไปยังรายงานของฉัน",
      action: "service",
      target: "reports",
      footnote: "หากรายการว่าง ระบบไม่ได้เสีย แปลว่ายังไม่มีรายงานที่เผยแพร่ให้บัญชีนี้"
    },
    analyst: {
      label: "ทางเริ่มต้นสำหรับนักวิเคราะห์",
      title: "เริ่มจากข้อมูลที่ได้รับอนุญาต",
      description: "ตรวจว่ามีชุดข้อมูลที่ต้องใช้ก่อน แล้วจึงเปิดพื้นที่วิเคราะห์ หลีกเลี่ยงการสร้างสำเนาข้อมูลนอกระบบ",
      steps: [
        "ยืนยันคำถามและเจ้าของข้อมูล",
        "ตรวจสิทธิ์ชุดข้อมูลที่ต้องใช้",
        "เปิดพื้นที่วิเคราะห์และบันทึกผลที่ตรวจแล้ว"
      ],
      actionLabel: "เปิดพื้นที่วิเคราะห์",
      action: "service",
      target: "analytics",
      footnote: "รอบตั้งต้นยังไม่มีตารางตัวอย่าง หากไม่พบข้อมูลให้ประสานเจ้าของข้อมูลก่อนสร้างคำสั่งใหม่"
    },
    steward: {
      label: "ทางเริ่มต้นสำหรับเจ้าของข้อมูล",
      title: "เตรียมข้อมูลพร้อมเจ้าของและวัตถุประสงค์",
      description: "ยังไม่ควรส่งไฟล์เข้าหน้าเว็บโดยตรง ให้เริ่มจากข้อมูลประกอบที่ช่วยให้ทีมแพลตฟอร์มรับช่วงต่อได้อย่างปลอดภัย",
      steps: [
        "ระบุชื่อและผู้รับผิดชอบชุดข้อมูล",
        "ตัดข้อมูลส่วนบุคคลที่ไม่จำเป็น",
        "นัดช่องทางรับส่งกับทีมข้อมูล"
      ],
      actionLabel: "ดูรายการที่ต้องเตรียม",
      action: "anchor",
      target: "#request-data",
      footnote: "อย่าส่งไฟล์จริงผ่านอีเมลหรือแชตจนกว่าจะตกลงพื้นที่รับส่งและผู้อนุมัติแล้ว"
    },
    operator: {
      label: "ทางเริ่มต้นสำหรับทีมแพลตฟอร์ม",
      title: "ตรวจงานผู้ใช้ก่อนเปิดห้องเครื่อง",
      description: "เริ่มจากรายงานที่ผู้ใช้ต้องเห็นและสถานะข้อมูล จากนั้นจึงเข้าเครื่องมือด้านเทคนิคเมื่อมีเหตุจำเป็น",
      steps: [
        "ตรวจว่ารายงานผู้ใช้เปิดได้จริง",
        "ยืนยันสิทธิ์จากบัญชี ไม่ใช่จากตัวเลือกหน้านี้",
        "เปิดเครื่องมือเฉพาะจากเครื่องแม่ข่าย"
      ],
      actionLabel: isLocalHost ? "ไปยังพื้นที่ทีมแพลตฟอร์ม" : "ดูขอบเขตการช่วยเหลือ",
      action: "anchor",
      target: isLocalHost ? "#operator-tools" : "#help",
      footnote: isLocalHost
        ? "ลิงก์เครื่องมือแสดงบนเครื่องนี้เพื่อความสะดวก แต่แต่ละระบบยังต้องตรวจสิทธิ์ของตนเอง"
        : "เครื่องมือทีมแพลตฟอร์มจำกัดไว้ที่เครื่องแม่ข่ายหรือเครือข่ายผู้ดูแล จึงไม่แสดงจากเครื่องนี้"
    }
  };

  const requestTemplate = [
    "คำขอใช้ข้อมูล PSU (ฉบับย่อ)",
    "",
    "1. ต้องการข้อมูลหรือคำถามอะไร:",
    "2. นำไปใช้ตัดสินใจ/ทำรายงาน/วิจัยเรื่องใด:",
    "3. ช่วงเวลาและระดับรายละเอียดที่จำเป็น:",
    "4. หน่วยงานเจ้าของข้อมูลที่คาดว่าเกี่ยวข้อง:",
    "5. ต้องใช้ภายในวันที่ใด และเพราะเหตุใด:",
    "6. ผู้ขอและหน่วยงาน:",
    "",
    "หมายเหตุ: โปรดอย่าแนบข้อมูลส่วนบุคคลหรือรหัสผ่านมากับข้อความนี้"
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
      node.textContent = config.pilotLabel;
    });

    const supportMessage = document.querySelector("[data-support-message]");
    if (supportMessage) {
      supportMessage.textContent = config.supportMessage;
    }

    const stateBadge = document.querySelector("#published-state-badge");
    const stateMessage = document.querySelector("#published-state-message");
    if (stateBadge && stateMessage) {
      stateMessage.textContent = config.publishedStateMessage;
      stateBadge.textContent = config.publishedReportsReady ? "มีรายงานพร้อมใช้" : "ยังไม่มีรายงานจริง";
      stateBadge.classList.toggle("is-ready", Boolean(config.publishedReportsReady));
      stateBadge.classList.toggle("is-empty", !config.publishedReportsReady);
    }
  }

  function applyRole(roleName, shouldPersist = true) {
    const role = roles[roleName] || roles.viewer;

    document.querySelectorAll("[data-role]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.role === roleName));
    });

    document.querySelector("#role-plan-label").textContent = role.label;
    document.querySelector("#role-plan-title").textContent = role.title;
    document.querySelector("#role-plan-description").textContent = role.description;
    document.querySelector("#role-plan-footnote").textContent = role.footnote;

    const steps = document.querySelector("#role-plan-steps");
    steps.replaceChildren(...role.steps.map((stepText) => {
      const item = document.createElement("li");
      item.textContent = stepText;
      return item;
    }));

    const action = document.querySelector("#role-plan-action");
    action.textContent = role.actionLabel;
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
        await copyText(requestTemplate);
        feedback.textContent = "คัดลอกแล้ว — นำไปวางในช่องทางภายในของหน่วยงานได้เลย";
        button.textContent = "คัดลอกแล้ว ✓";
      } catch (_error) {
        feedback.textContent = "เบราว์เซอร์ไม่อนุญาตให้คัดลอกอัตโนมัติ กรุณาคัดลอกจากแบบคำขอด้านข้าง";
      }
    });
  }

  function formatCheckTime() {
    try {
      return new Intl.DateTimeFormat("th-TH", {
        hour: "2-digit",
        minute: "2-digit"
      }).format(new Date());
    } catch (_error) {
      return "ขณะนี้";
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
      setReportStatus("is-ready", "ระบบรายงานตอบสนอง", `ตรวจล่าสุด ${formatCheckTime()}`);
    } catch (_error) {
      setReportStatus("is-down", "ระบบรายงานยังไม่ตอบสนอง", `ตรวจล่าสุด ${formatCheckTime()}`);
    } finally {
      window.clearTimeout(timeout);
    }
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
})();

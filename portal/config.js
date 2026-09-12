/*
 * Deployment-facing copy only. Never place credentials or access tokens here:
 * every browser that opens the portal can read this file.
 *
 * Each string may be a plain string or a per-language map. A plain string is
 * shown in both languages, which is right for a deployment that runs in one
 * language; the map form is there so a site can say something different to
 * Thai and English readers without a code change.
 */
window.PSU_PORTAL_CONFIG = Object.freeze({
  pilotLabel: {
    th: "Pilot · ข้อมูลทดสอบเท่านั้น",
    en: "Pilot · test data only"
  },
  publishedReportsReady: false,
  publishedStateMessage: {
    th: "เครื่อง Pilot รอบตั้งต้นยังไม่มีชุดข้อมูลที่ประกาศเผยแพร่ จึงอาจพบรายการว่างหลังล็อกอิน",
    en: "The first Pilot round has no published datasets yet, so the list may be empty after you sign in."
  },
  supportMessage: {
    th: "ติดต่อทีมข้อมูลผ่านช่องทางภายในที่หน่วยงานกำหนด พร้อมแนบภาพหน้าจอและเวลาที่พบปัญหา โดยไม่ส่งรหัสผ่าน",
    en: "Contact the data team through your unit's internal channel with a screenshot and the time it happened. Never send a password."
  },
  services: Object.freeze({
    reports: Object.freeze({ port: "8088", protocol: "http:", path: "/dashboard/list/" }),
    analytics: Object.freeze({ port: "8088", protocol: "http:", path: "/sqllab/" }),
    users: Object.freeze({ port: "8088", protocol: "http:", path: "/users/list/" }),
    ingestion: Object.freeze({ port: "8443", protocol: "https:", path: "/nifi" }),
    query: Object.freeze({ port: "8086", protocol: "https:", path: "/" }),
    vectors: Object.freeze({ port: "6333", protocol: "http:", path: "/dashboard" }),
    storage: Object.freeze({ port: "9001", protocol: "http:", path: "/" })
  })
});

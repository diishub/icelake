/*
 * Deployment-facing copy only. Never place credentials or access tokens here:
 * every browser that opens the portal can read this file.
 */
window.PSU_PORTAL_CONFIG = Object.freeze({
  pilotLabel: "Pilot · ข้อมูลทดสอบเท่านั้น",
  publishedReportsReady: false,
  publishedStateMessage:
    "เครื่อง Pilot รอบตั้งต้นยังไม่มีชุดข้อมูลที่ประกาศเผยแพร่ จึงอาจพบรายการว่างหลังล็อกอิน",
  supportMessage:
    "ติดต่อทีมข้อมูลผ่านช่องทางภายในที่หน่วยงานกำหนด พร้อมแนบภาพหน้าจอและเวลาที่พบปัญหา โดยไม่ส่งรหัสผ่าน",
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

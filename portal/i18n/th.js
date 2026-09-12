/*
 * Thai strings for the PSU Data Hub portal.
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
window.PSU_I18N_STRINGS.th = {
  // --- Document ---
  "meta.description": "PSU Data Hub ศูนย์กลางข้อมูลและรายงานสำหรับมหาวิทยาลัยสงขลานครินทร์",

  // --- Language switch ---
  "lang.switchTo": "English",
  "lang.switchLabel": "เปลี่ยนเป็นภาษาอังกฤษ",

  // --- Skip link ---
  "skip": "ข้ามไปยังเนื้อหาหลัก",

  // --- Brand ---
  "brand.home": "PSU Data Hub หน้าแรก",
  "brand.tagline": "ศูนย์กลางข้อมูลมหาวิทยาลัย",

  // --- Navigation ---
  "nav.label": "เมนูหลัก",
  "nav.catalog": "ค้นหาข้อมูล",
  "nav.start": "เริ่มใช้งาน",
  "nav.reports": "รายงาน",
  "nav.help": "ความช่วยเหลือ",

  // --- Reporting service status ---
  "status.checking": "กำลังตรวจระบบรายงาน",
  "status.checkingDetail": "รอสักครู่",
  "status.ready": "ระบบรายงานตอบสนอง",
  "status.down": "ระบบรายงานยังไม่ตอบสนอง",
  "status.checkedAt": "ตรวจล่าสุด {time}",
  "status.checkedNow": "ขณะนี้",

  // --- Account ---
  "account.signIn": "เข้าสู่ระบบด้วย PSU Passport",
  "account.signOut": "ออกจากระบบ",
  "account.checking": "กำลังตรวจสิทธิ์",
  "account.fallbackName": "ผู้ใช้",

  // --- Directory groups ---
  "userType.student": "นักศึกษา",
  "userType.staff": "บุคลากร",
  "userType.unknown": "ยังไม่ยืนยันประเภทผู้ใช้",

  // --- Hero ---
  "hero.eyebrow": "PSU DATA HUB",
  "hero.titleLine1": "ข้อมูลของมหาวิทยาลัย",
  "hero.titleLine2": "ค้นจากที่เดียวได้เลย",
  "hero.lead": "บัญชีรายการชุดข้อมูลกลางของ ม.อ. บอกว่ามีข้อมูลอะไร ใครเป็นเจ้าของ ปรับปรุงล่าสุดเมื่อไร และขอใช้ได้อย่างไร",

  // --- Search ---
  "search.label": "ค้นหาชุดข้อมูล",
  "search.placeholder": "เช่น นักศึกษา บุคลากร รายวิชา",
  "search.submit": "ค้นหา",
  "search.hint": "ค้นจากชื่อชุดข้อมูล คำอธิบาย หมวด และเจ้าของข้อมูล",
  "search.suggestionsLabel": "คำค้นที่ใช้บ่อย",
  "search.tryPrefix": "ลองค้น",
  "search.term1": "นักศึกษา",
  "search.term2": "บุคลากร",
  "search.term3": "รายวิชา",
  "search.term4": "ลงทะเบียน",

  // --- First-visit card ---
  "firstVisit.kicker": "เข้ามาครั้งแรก",
  "firstVisit.title": "ทำตามนี้ก่อน ไม่หลงแน่นอน",
  "firstVisit.step1": "ค้นชุดข้อมูล",
  "firstVisit.step1Detail": "ดูว่ามีสิ่งที่ต้องการอยู่แล้วหรือยัง",
  "firstVisit.step2": "ดูเจ้าของและความสด",
  "firstVisit.step2Detail": "รู้ว่าใครรับผิดชอบและอัปเดตเมื่อไร",
  "firstVisit.step3": "เปิดรายงาน หรือขอใช้ข้อมูล",
  "firstVisit.step3Detail": "ถ้ายังไม่มีสิทธิ์ ใช้แบบคำขอในหน้านี้",

  // --- Scope strip ---
  "strip.title": "หน้านี้เป็นทางเข้าหลักสำหรับผู้ใช้ทั่วไป",
  "strip.detail": "เครื่องมือจัดเก็บ ประมวลผล และดูแลระบบทำงานอยู่เบื้องหลัง",
  "strip.side": "สิทธิ์ข้อมูลจริงยังตรวจจากบัญชีของคุณทุกครั้ง",

  // --- 01 Platform figures ---
  "stats.label": "สถานะคลังข้อมูลตอนนี้",
  "stats.title": "ตัวเลขจริง ไม่ใช่คำโฆษณา",
  "stats.lead": "ทุกจำนวนด้านล่างอ่านจากทะเบียนควบคุมของท่อนำเข้าโดยตรง ถ้ายังไม่มีข้อมูลก็จะแสดงว่ายังไม่มี",
  "stats.total": "ชุดข้อมูลในบัญชีรายการ",
  "stats.totalHint": "รวมชุดที่ยังไม่เผยแพร่",
  "stats.published": "เผยแพร่แล้ว",
  "stats.publishedHint": "นำเข้าสำเร็จอย่างน้อยหนึ่งรอบ",
  "stats.owners": "หน่วยงานเจ้าของข้อมูล",
  "stats.ownersHint": "ผู้อนุมัติการนำเข้าแต่ละแหล่ง",
  "stats.withheld": "คอลัมน์ที่ถูกกันไว้",
  "stats.withheldHint": "จัดชั้นแล้วไม่ใช่ข้อมูลสาธารณะ จึงไม่ถูกนำเข้า",
  "stats.reading": "กำลังอ่านบัญชีรายการ…",
  "stats.generatedAt": "บัญชีรายการปรับปรุงเมื่อ {time} — เป็นค่าล่าสุดที่ผู้ดูแลเผยแพร่ ไม่ใช่เวลาจริง",
  "stats.generatedUnknown": "ไม่ทราบเวลาที่ปรับปรุงบัญชีรายการ",
  "stats.notPublished": "ยังไม่ได้เผยแพร่บัญชีรายการชุดข้อมูล",

  // --- 02 Domains ---
  "domains.label": "เรียกดูตามหมวด",
  "domains.title": "ข้อมูลกลางแบ่งเป็นสามหมวด",
  "domains.lead": "กดหมวดเพื่อกรองบัญชีรายการด้านล่าง กดซ้ำเพื่อยกเลิกการกรอง",
  "domains.groupLabel": "กรองตามหมวดข้อมูล",
  "domains.loading": "กำลังอ่านหมวดข้อมูล…",
  "domains.datasetCount": "{count} ชุดข้อมูล",
  "domains.publishedCount": "เผยแพร่แล้ว {count} ชุด",

  // --- 03 Catalogue ---
  "catalog.label": "บัญชีรายการชุดข้อมูล",
  "catalog.title": "มีอะไรอยู่ในคลัง และสดแค่ไหน",
  "catalog.notFound": "ไม่เจอสิ่งที่ต้องการ",
  "catalog.loading": "กำลังโหลด…",
  "catalog.clear": "ล้างตัวกรอง",
  "catalog.countAll": "ทั้งหมด {total} ชุดข้อมูล",
  "catalog.countFiltered": "พบ {visible} จาก {total} ชุดข้อมูล",
  "catalog.none": "ยังไม่มีบัญชีรายการ",
  "catalog.empty": "ไม่พบชุดข้อมูลที่ตรงกับคำค้น ลองใช้คำกว้างขึ้น หรือส่งคำขอให้ทีมข้อมูลช่วยหา",
  "catalog.errorPrefix": "ยังอ่านบัญชีรายการไม่ได้ ส่วนอื่นของหน้านี้ยังใช้งานได้ตามปกติ ถ้าเพิ่งติดตั้งระบบใหม่ ผู้ดูแลต้องรัน",
  "catalog.errorSuffix": "หนึ่งครั้ง",
  "catalog.owner": "เจ้าของข้อมูล",
  "catalog.updated": "ปรับปรุงล่าสุด",
  "catalog.columns": "คอลัมน์ที่เผยแพร่",
  "catalog.columnsValue": "{safe} จาก {total} คอลัมน์",
  "catalog.loadMode": "วิธีนำเข้า",
  "catalog.openReport": "เปิดในระบบรายงาน",
  "catalog.requestAccess": "ขอใช้ข้อมูลชุดนี้",
  "catalog.signInToOpen": "เข้าสู่ระบบเพื่อเปิดรายงาน",

  // --- Ingestion modes ---
  "loadMode.full_refresh": "โหลดใหม่ทั้งตาราง",
  "loadMode.incremental": "นำเข้าเพิ่มทีละรอบ",

  // --- Dataset availability ---
  "availability.published": "เผยแพร่แล้ว",
  "availability.withheld": "ไม่มีคอลัมน์ที่เผยแพร่ได้",
  "availability.pending": "รอนำเข้ารอบแรก",
  "availability.retired": "ยกเลิกการเผยแพร่",

  // --- Relative time ---
  "age.never": "ยังไม่เคยนำเข้าสำเร็จ",
  "age.unknown": "ไม่ทราบเวลา",
  "age.minutes": "{count} นาทีที่แล้ว",
  "age.hours": "{count} ชั่วโมงที่แล้ว",
  "age.days": "{count} วันที่แล้ว",

  // --- 04 Role picker ---
  "roles.label": "เริ่มจากตัวคุณ",
  "roles.title": "วันนี้คุณเข้ามาทำอะไร?",
  "roles.lead": "เลือกเพื่อปรับคำแนะนำบนหน้านี้เท่านั้น การเลือกนี้ไม่เพิ่มหรือลดสิทธิ์ข้อมูลของคุณ",
  "roles.groupLabel": "เลือกบทบาทสำหรับคำแนะนำ",
  "roles.viewer": "ผู้บริหาร / ผู้ใช้รายงาน",
  "roles.viewerDetail": "ต้องการดูตัวเลขและติดตามสถานการณ์",
  "roles.analyst": "นักวิเคราะห์ข้อมูล",
  "roles.analystDetail": "ต้องการสำรวจข้อมูลและสร้างรายงาน",
  "roles.steward": "เจ้าของข้อมูล / ผู้ประสานงาน",
  "roles.stewardDetail": "ต้องการส่งหรือปรับปรุงข้อมูลของหน่วยงาน",
  "roles.operator": "ทีมแพลตฟอร์ม",
  "roles.operatorDetail": "ดูแลบัญชี ท่อนำเข้า และสถานะระบบ",

  // --- Role plans ---
  "role.viewer.label": "ทางเริ่มต้นสำหรับผู้ใช้รายงาน",
  "role.viewer.title": "เปิดรายงานที่ได้รับสิทธิ์",
  "role.viewer.description": "เริ่มจากรายการรายงานที่เปิดให้คุณ ไม่ต้องเข้าเมนูสร้างกราฟหรือเขียนคำสั่งข้อมูล",
  "role.viewer.step1": "เข้าสู่ระบบด้วยบัญชี Pilot",
  "role.viewer.step2": "เลือกรายงานจากรายการที่เปิดได้",
  "role.viewer.step3": "ตรวจเจ้าของข้อมูลและวันที่ปรับปรุง",
  "role.viewer.action": "ไปยังรายงานของฉัน",
  "role.viewer.footnote": "หากรายการว่าง ระบบไม่ได้เสีย แปลว่ายังไม่มีรายงานที่เผยแพร่ให้บัญชีนี้",
  "role.analyst.label": "ทางเริ่มต้นสำหรับนักวิเคราะห์",
  "role.analyst.title": "เริ่มจากข้อมูลที่ได้รับอนุญาต",
  "role.analyst.description": "ตรวจว่ามีชุดข้อมูลที่ต้องใช้ก่อน แล้วจึงเปิดพื้นที่วิเคราะห์ หลีกเลี่ยงการสร้างสำเนาข้อมูลนอกระบบ",
  "role.analyst.step1": "ยืนยันคำถามและเจ้าของข้อมูล",
  "role.analyst.step2": "ตรวจสิทธิ์ชุดข้อมูลที่ต้องใช้",
  "role.analyst.step3": "เปิดพื้นที่วิเคราะห์และบันทึกผลที่ตรวจแล้ว",
  "role.analyst.action": "เปิดพื้นที่วิเคราะห์",
  "role.analyst.footnote": "รอบตั้งต้นยังไม่มีตารางตัวอย่าง หากไม่พบข้อมูลให้ประสานเจ้าของข้อมูลก่อนสร้างคำสั่งใหม่",
  "role.steward.label": "ทางเริ่มต้นสำหรับเจ้าของข้อมูล",
  "role.steward.title": "เตรียมข้อมูลพร้อมเจ้าของและวัตถุประสงค์",
  "role.steward.description": "ยังไม่ควรส่งไฟล์เข้าหน้าเว็บโดยตรง ให้เริ่มจากข้อมูลประกอบที่ช่วยให้ทีมแพลตฟอร์มรับช่วงต่อได้อย่างปลอดภัย",
  "role.steward.step1": "ระบุชื่อและผู้รับผิดชอบชุดข้อมูล",
  "role.steward.step2": "ตัดข้อมูลส่วนบุคคลที่ไม่จำเป็น",
  "role.steward.step3": "นัดช่องทางรับส่งกับทีมข้อมูล",
  "role.steward.action": "ดูรายการที่ต้องเตรียม",
  "role.steward.footnote": "อย่าส่งไฟล์จริงผ่านอีเมลหรือแชตจนกว่าจะตกลงพื้นที่รับส่งและผู้อนุมัติแล้ว",
  "role.operator.label": "ทางเริ่มต้นสำหรับทีมแพลตฟอร์ม",
  "role.operator.title": "ตรวจงานผู้ใช้ก่อนเปิดห้องเครื่อง",
  "role.operator.description": "เริ่มจากรายงานที่ผู้ใช้ต้องเห็นและสถานะข้อมูล จากนั้นจึงเข้าเครื่องมือด้านเทคนิคเมื่อมีเหตุจำเป็น",
  "role.operator.step1": "ตรวจว่ารายงานผู้ใช้เปิดได้จริง",
  "role.operator.step2": "ยืนยันสิทธิ์จากบัญชี ไม่ใช่จากตัวเลือกหน้านี้",
  "role.operator.step3": "เปิดเครื่องมือเฉพาะจากเครื่องแม่ข่าย",
  "role.operator.actionLocal": "ไปยังพื้นที่ทีมแพลตฟอร์ม",
  "role.operator.actionRemote": "ดูขอบเขตการช่วยเหลือ",
  "role.operator.footnoteLocal": "ลิงก์เครื่องมือแสดงบนเครื่องนี้เพื่อความสะดวก แต่แต่ละระบบยังต้องตรวจสิทธิ์ของตนเอง",
  "role.operator.footnoteRemote": "เครื่องมือทีมแพลตฟอร์มจำกัดไว้ที่เครื่องแม่ข่ายหรือเครือข่ายผู้ดูแล จึงไม่แสดงจากเครื่องนี้",

  // --- 05 Reports ---
  "reports.label": "เห็นปลายทางก่อน",
  "reports.title": "รายงานที่เข้าใจได้ตั้งแต่ครั้งแรก",
  "reports.helpLink": "ถ้ารายงานไม่ขึ้น ต้องทำอย่างไร",
  "reports.myReports": "รายงานที่บัญชีของฉันเปิดได้",
  "reports.emptyTitle": "ถ้าเปิดแล้วเจอหน้าว่าง",
  "reports.emptyDetail": "กลับมาหน้านี้ได้เลย ไม่ต้องลองกดเมนูเทคนิค ให้แจ้งชื่อรายงานหรือข้อมูลที่ต้องการแก่ทีมข้อมูล",
  "reports.enter": "เข้าสู่ระบบรายงานจริง",
  "reports.stateReady": "มีรายงานพร้อมใช้",
  "reports.stateEmpty": "ยังไม่มีรายงานจริง",

  // --- Sample report ---
  "demo.eyebrow": "ตัวอย่างหน้ารายงาน",
  "demo.title": "ภาพรวมการรับข้อมูลจากหน่วยงาน",
  "demo.badge": "ข้อมูลสมมติ 100%",
  "demo.metricsLabel": "ตัวเลขตัวอย่าง",
  "demo.metric1": "หน่วยงานส่งแล้ว",
  "demo.metric1Trend": "+2 สัปดาห์นี้",
  "demo.metric2": "ผ่านการตรวจคุณภาพ",
  "demo.metric2Trend": "เป้าหมาย 95%",
  "demo.metric3": "รายการรอติดตาม",
  "demo.metric3Unit": "ชุด",
  "demo.metric3Trend": "ควรตรวจวันนี้",
  "demo.chartLabel": "กราฟแท่งตัวอย่าง แสดงสัดส่วนข้อมูลผ่านการตรวจคุณภาพของสามหมวดข้อมูล",
  "demo.chartTitle": "สัดส่วนที่ผ่านการตรวจ",
  "demo.chartUpdated": "อัปเดตตัวอย่าง 29 ส.ค. 2569",
  "demo.bar1": "วิชาการ",
  "demo.bar2": "นักศึกษา",
  "demo.bar3": "บุคลากร",
  "demo.disclaimer": "ตัวเลขทั้งหมดสร้างขึ้นเพื่อสอนวิธีอ่านหน้าจอ ไม่ใช่ข้อมูลของมหาวิทยาลัย",

  // --- 06 Governance ---
  "governance.label": "ข้อมูลนี้เชื่อถือได้เพราะอะไร",
  "governance.title": "กติกาที่ท่อนำเข้าบังคับเอง ไม่ใช่คำสัญญา",
  "governance.lead": "ทุกชุดข้อมูลที่อยู่ในคลังผ่านสามด่านนี้เสมอ ถ้าด่านใดตอบไม่ได้ ระบบจะไม่นำเข้าและบันทึกเหตุผลไว้แทน",
  "governance.cta": "ดูบัญชีรายการทั้งหมด",
  "governance.rule1": "เจ้าของข้อมูลและฐานทางกฎหมายต้องระบุก่อน",
  "governance.rule1Detail": "ทะเบียนแหล่งข้อมูลไม่ยอมรับแถวที่ไม่มีชื่อผู้อนุมัติ ฐานทางกฎหมาย และระยะเวลาเก็บรักษา เป็นข้อบังคับระดับฐานข้อมูล ไม่ใช่ระดับแบบฟอร์ม",
  "governance.rule2": "คัดคอลัมน์ตามชั้นความลับที่ต้นทางประกาศ",
  "governance.rule2Before": "เฉพาะคอลัมน์ที่เจ้าของข้อมูลจัดชั้นเป็นสาธารณะระดับ 0 เท่านั้นที่ไหลเข้ามา ป้ายกำกับที่ระบบไม่รู้จักถือว่าไม่ปลอดภัย ตอนนี้กันไว้แล้ว",
  "governance.rule2After": "คอลัมน์",
  "governance.rule3": "ตรวจปลายทางก่อนต่อทุกครั้ง",
  "governance.rule3Detail": "ท่อนำเข้าเทียบปลายทางกับบัญชีอนุญาตและบัญชีห้ามก่อนเปิดการเชื่อมต่อ บัญชีห้ามชนะเสมอ และเมื่อไม่แน่ใจระบบจะไม่ต่อ",

  // --- 07 Data request ---
  "request.label": "เมื่อข้อมูลยังไม่พร้อม",
  "request.title": "บอกความต้องการแบบที่ทีมข้อมูลทำงานต่อได้",
  "request.lead": "รอบนี้ยังไม่ทำปุ่ม “ส่งคำขอสำเร็จ” ปลอม ๆ เพราะระบบยืนยันตัวตนและผู้อนุมัติยังไม่เชื่อมกัน แต่คุณคัดลอกแบบคำขอที่ครบถ้วนไปใช้ในช่องทางภายในได้ทันที",
  "request.copy": "คัดลอกรูปแบบคำขอใช้ข้อมูล",
  "request.copied": "คัดลอกแล้ว — นำไปวางในช่องทางภายในของหน่วยงานได้เลย",
  "request.copyButtonDone": "คัดลอกแล้ว ✓",
  "request.copyFailed": "เบราว์เซอร์ไม่อนุญาตให้คัดลอกอัตโนมัติ กรุณาคัดลอกจากแบบคำขอด้านข้าง",
  "request.templateLabel": "ตัวอย่างรูปแบบคำขอใช้ข้อมูล",
  "request.templateTitle": "แบบคำขอฉบับย่อ",
  "request.q1": "ต้องการข้อมูลอะไร",
  "request.a1": "ชื่อชุดข้อมูลจากบัญชีรายการ หรือคำถามที่ต้องการตอบ",
  "request.q2": "นำไปใช้เพื่ออะไร",
  "request.a2": "การตัดสินใจ รายงาน หรืองานวิจัยใด",
  "request.q3": "ช่วงเวลา / รายละเอียด",
  "request.a3": "ระบุเท่าที่จำเป็น หลีกเลี่ยงข้อมูลส่วนบุคคล",
  "request.q4": "เจ้าของข้อมูลที่คาดว่าเกี่ยวข้อง",
  "request.a4": "คณะ สำนัก ศูนย์ หรือหน่วยงาน",
  "request.q5": "ต้องใช้เมื่อใด",
  "request.a5": "วันที่และเหตุผลของกำหนดเวลา",

  // --- Request form copy (copied to the clipboard) ---
  "form.title": "คำขอใช้ข้อมูล PSU (ฉบับย่อ)",
  "form.line1": "1. ต้องการข้อมูลหรือคำถามอะไร:",
  "form.line2": "2. นำไปใช้ตัดสินใจ/ทำรายงาน/วิจัยเรื่องใด:",
  "form.line3": "3. ช่วงเวลาและระดับรายละเอียดที่จำเป็น:",
  "form.line4": "4. หน่วยงานเจ้าของข้อมูลที่คาดว่าเกี่ยวข้อง:",
  "form.line5": "5. ต้องใช้ภายในวันที่ใด และเพราะเหตุใด:",
  "form.line6": "6. ผู้ขอและหน่วยงาน:",
  "form.note": "หมายเหตุ: โปรดอย่าแนบข้อมูลส่วนบุคคลหรือรหัสผ่านมากับข้อความนี้",

  // --- 08 Help ---
  "help.label": "ถ้าติดตรงไหน",
  "help.title": "คำตอบสั้น ๆ ก่อนร้องขอความช่วยเหลือ",
  "help.q1": "ค้นเจอชุดข้อมูลแล้ว แต่ขึ้นว่ายังไม่เผยแพร่",
  "help.a1": "แปลว่าชุดข้อมูลนั้นลงทะเบียนไว้แล้วแต่ยังไม่ผ่านการนำเข้าสำเร็จ หรือเจ้าของข้อมูลปิดการเผยแพร่ไว้ บัญชีรายการยังแสดงชื่อกับเจ้าของให้ เพื่อให้คุณส่งคำขอไปยังผู้รับผิดชอบได้ถูกคน แทนที่จะเดาว่ามีหรือไม่มี",
  "help.q2": "ทำไมบางชุดข้อมูลมีคอลัมน์น้อยกว่าที่ต้นทางมี?",
  "help.a2": "ท่อนำเข้าเลือกเฉพาะคอลัมน์ที่เจ้าของข้อมูลจัดชั้นเป็นสาธารณะ คอลัมน์ที่เหลือไม่ได้ถูกคัดลอกออกจากต้นทางเลย ตัวเลข “เผยแพร่กี่จากกี่คอลัมน์” บนแต่ละรายการบอกสัดส่วนนี้ตรง ๆ",
  "help.q3": "ล็อกอินแล้วเจอหน้าว่าง หมายความว่าอย่างไร?",
  "help.a3": "มักหมายถึงยังไม่มีรายงานที่เผยแพร่ให้บัญชีของคุณ ไม่ใช่ระบบเสีย ให้กลับมาหน้านี้แล้วแจ้งชื่อข้อมูลหรือคำถามที่ต้องการแก่ทีมข้อมูล",
  "help.q4": "การเลือกบทบาทบนหน้านี้ทำให้สิทธิ์เปลี่ยนไหม?",
  "help.a4": "ไม่เปลี่ยน การเลือกมีไว้จัดคำแนะนำเท่านั้น สิทธิ์จริงตรวจจากบัญชี กลุ่มผู้ใช้ และนโยบายข้อมูลของระบบทุกครั้ง",
  "help.q5": "ฉันส่งไฟล์ข้อมูลผ่านหน้านี้ได้เลยไหม?",
  "help.a5": "ยังไม่ได้ในรอบนี้ เพื่อไม่ให้ไฟล์สำคัญหลุดไปอยู่ในพื้นที่ที่ไม่มีผู้รับผิดชอบ ให้เจ้าของข้อมูลประสานทีมข้อมูลเพื่อกำหนดช่องทางรับส่งที่ปลอดภัยก่อน",
  "help.stuckTitle": "ยังไปต่อไม่ได้?",

  // --- Platform team area ---
  "operator.label": "สำหรับเครื่องแม่ข่ายเท่านั้น",
  "operator.title": "พื้นที่ทีมแพลตฟอร์ม",
  "operator.lead": "ลิงก์ชุดนี้ปรากฏเมื่อเปิด Portal จากเครื่องที่รันระบบเท่านั้น แต่สิทธิ์จริงยังตรวจที่แต่ละบริการ",
  "operator.ingestion": "จัดการท่อนำเข้าข้อมูล",
  "operator.ingestionDetail": "NiFi · ผู้ดูแลเท่านั้น",
  "operator.query": "ติดตามคำสั่งวิเคราะห์",
  "operator.queryDetail": "Trino · ผู้ดูแลเท่านั้น",
  "operator.vectors": "ตรวจสอบดัชนีค้นหา",
  "operator.vectorsDetail": "Qdrant · ผู้ดูแลเท่านั้น",
  "operator.storage": "ตรวจสอบพื้นที่จัดเก็บ",
  "operator.storageDetail": "RustFS · ห้ามแก้ metadata โดยตรง",
  "operator.users": "จัดการบัญชีและสิทธิ์ BI",
  "operator.usersDetail": "PSU Reports · Admin เท่านั้น",

  // --- Footer ---
  "footer.tagline": "ชั้นใช้งานที่เป็นมิตร บนแพลตฟอร์มข้อมูลแบบ Open Source",
  "footer.meta": "ห้ามใช้ข้อมูลส่วนบุคคลจริงจนกว่าทีมกำกับข้อมูลอนุมัติ",

  // --- Back to top ---
  "toTop": "กลับขึ้นด้านบน",

  // --- No-JavaScript notice ---
  "noscript": "หน้านี้ต้องใช้ JavaScript เพื่อสร้างลิงก์ระบบและอ่านบัญชีรายการชุดข้อมูล กรุณาเปิด JavaScript หรือขอความช่วยเหลือจากผู้ดูแล",

  // --- Fallbacks for deployment copy ---
  "config.publishedState": "ยังไม่มีรายงานที่ประกาศพร้อมใช้ในรอบ Pilot",
  "config.support": "ติดต่อทีมข้อมูลผ่านช่องทางภายในที่หน่วยงานกำหนด โดยไม่ส่งรหัสผ่าน",
};

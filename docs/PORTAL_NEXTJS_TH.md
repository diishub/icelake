# Portal (Next.js)

Portal ของ PSU Data Hub เขียนด้วย Next.js 16 (Pages Router) + React 19 + TypeScript
และ build เป็นไฟล์ static (`output: 'export'`) ให้ nginx เสิร์ฟเหมือนเดิม
ใน production ไม่มี Node process รันอยู่ Node ใช้เฉพาะตอน build image

## โครงสร้าง

```
portal/
  src/pages/           หน้าเว็บ 1 ไฟล์ต่อ 1 URL (/ /login /upload /review /publish /reports /admin)
  src/components/      layout ที่ใช้ร่วมกัน + component ของแต่ละหน้า (home/ upload/ review/ ...)
  src/lib/             auth (/auth/me), api (fetch ไป psu-auth), config, tiers
  src/i18n/            th.ts (ต้นฉบับ) en.ts (typed ตาม th.ts) index.tsx (useI18n)
  src/styles/          globals.css
  public/config.json   ค่าที่ deployment แก้ได้โดยไม่ต้อง build ใหม่ (ห้ามใส่ credential)
  public/data/         catalog.json ที่ scripts/publish-portal-catalog.sh สร้าง (ไม่ commit)
  scripts/check-export-csp.mjs   ตรวจว่า output ไม่มี inline script/style
  Dockerfile           build (node) -> serve (nginx)
```

## ทำไมเลือกแบบนี้

- **Static export + nginx:** nginx ยังเป็นตัวกำหนด CSP, cache header และ proxy `/auth/` ไป psu-auth
  (`config/portal/default.conf`) ทุกหน้าดึงข้อมูลฝั่ง client ผ่าน cookie session อยู่แล้ว จึงไม่ต้องมี server rendering
- **Pages Router ไม่ใช่ App Router:** App Router แบบ static export ใส่ข้อมูลหน้าเป็น inline `<script>`
  ซึ่ง CSP `script-src 'self'` ไม่ยอมรับ
- **build ด้วย webpack (`next build --webpack`):** Turbopack production build ใส่ inline bootstrap script
  `npm run build` จึงใช้ webpack แล้วรัน `check-export-csp.mjs` ต่อท้ายเสมอ
- **เปลี่ยนหน้าไม่โหลดใหม่ทั้งหน้า:** ลิงก์ใช้ `next/link` และ session/ภาษา/config อยู่ใน provider ของ `_app`
  จึงอ่านครั้งเดียวต่อ tab header ไม่กระพริบตอนเปลี่ยนเมนู

## กติกาที่ต้องรักษา

- ห้ามใช้ `style={...}`, `<style>`, inline script และ `dangerouslySetInnerHTML` เพราะ CSP จะบล็อก
  (`npm run build` จะ fail ถ้ามี) ถ้าต้องกำหนดขนาดแบบ dynamic ให้ใช้ class หรือตั้ง `ref.current.style` ใน effect
- ห้ามอ่าน `window`/`localStorage` หรือเรียก `fetch` ระหว่าง render ให้ทำใน `useEffect` หรือ handler
  เพราะหน้าถูก prerender ตอน build
- ข้อความที่ผู้ใช้เห็นต้องผ่าน `t('key')` เพิ่ม key ใน `th.ts` และ `en.ts` พร้อมกัน ถ้าลืมข้างใดข้างหนึ่ง type check จะ fail
- การซ่อนเมนูหรือหน้าตาม tier (`src/lib/tiers.ts`) มีไว้เพื่อ UX เท่านั้น psu-auth ตรวจสิทธิ์ทุก route ซ้ำอีกครั้งเสมอ
- PDPA: ห้าม log ข้อมูลส่วนบุคคล ห้ามใส่ใน URL หรือ localStorage/sessionStorage
  (ภาษาที่เลือกเป็นข้อมูลเดียวที่เก็บใน localStorage)

## พัฒนาบนเครื่อง

ต้องรัน stack (`docker compose --profile auth up -d`) ไว้ก่อน เพราะ dev server ส่ง `/auth/*` และ `/api/*`
ต่อไปที่ portal ที่ `http://localhost:8085` (เปลี่ยนได้ด้วย `PORTAL_DEV_BACKEND`)

```sh
cd portal
npm ci
npm run dev          # http://localhost:3000
npm run typecheck
npm run build        # out/ + ตรวจ CSP
```

หมายเหตุ: cookie session ของ psu-auth ตั้ง `Secure` ตามค่า `AUTH_COOKIE_SECURE` ถ้า login ผ่าน
`http://localhost:3000` ไม่ติด ให้ทดสอบผ่าน `http://localhost:8085` (image ที่ build แล้ว) แทน

## Deploy

```sh
docker compose --profile auth up -d --build psu-portal
```

- แก้ `portal/public/config.json` แล้ว reload หน้าได้เลย เพราะไฟล์ถูก mount เข้า container
- `scripts/publish-portal-catalog.sh` เขียน `portal/public/data/catalog.json` ซึ่งก็ถูก mount เช่นกัน
- URL เดิมแบบ `.html` (เช่น `/admin.html`) nginx redirect 301 ไป URL ใหม่ (`/admin`)

# CI: `.github/workflows/ci.yml`

เอกสารนี้อธิบายว่า CI ทำอะไร ครอบคลุมแค่ไหน และจงใจไม่ทำอะไรบ้าง

## สี่ job แยกกัน

```
policy           OPA rego test — ไม่ต้องมี stack, ไม่ต้องมี Docker network
auth-typecheck   TypeScript typecheck ของ services/auth — ไม่ต้องมี stack
guardrail        เทสต์ของ source guardrail เอง — ไม่ต้องมี stack
stack            ยก stack เต็มขึ้นจริง แล้วรันเทสต์ที่เหลือทั้งหมด
```

แยกเป็น 4 job เพราะ 3 อันแรกรันเสร็จในไม่กี่วินาที ไม่ต้องรอ job หนักที่ต้องยก
Postgres + RustFS + Polaris + Trino + OPA + NiFi + Superset ขึ้นมาพร้อมกัน (job
`stack` ใช้เวลาหลักนาที)

## `.env.ci` — ค่าใช้แล้วทิ้งสำหรับ CI เท่านั้น

commit ไว้ใน repo เพราะเป็นค่า **ปลอมทั้งหมด สร้างมาเฉพาะไฟล์นี้** ใช้แค่ใน
container ของ CI runner ที่ถูกทำลายทิ้งท้าย job เท่านั้น ไม่มีทางไปถึงระบบจริง
หรือคนจริงเลย — คนละแบบกับ `.env` จริงที่ห้าม commit เด็ดขาด

ไม่มีค่าไหนขึ้นต้นด้วย `change-me` เพราะ `bootstrap_users.py` และ
`scripts/create-password-account.sh` ปฏิเสธรหัสผ่านที่ขึ้นต้นแบบนั้นโดยเจตนา
(ดู "Superset password placeholder guard" ใน `docs/RUNBOOK.md`) ค่าใน CI จึงต้อง
"หน้าตาเหมือนรหัสจริง" แม้จะทิ้งได้เหมือนกัน

ถ้าเพิ่มตัวแปรใหม่ใน `.env.example` ต้องเพิ่มค่าที่ใช้ได้จริงใน `.env.ci` คู่กัน
ไม่งั้น stack ใน CI จะสตาร์ตไม่ขึ้นพร้อม error บอกชื่อตัวแปรที่ขาด

## จงใจไม่ทำ: `scripts/test-dotblue-dashboard.sh`

หัวไฟล์บอกเหตุผลไว้แล้ว: มันพิสูจน์ว่าการนำเข้าข้อมูลรอบหนึ่งไม่พาข้อมูลระบุตัวบุคคล
ออกจากฐานข้อมูล production จริง ซึ่งหมายความว่ามันต้องพึ่งไฟล์ใต้ `data/incoming`
ที่เป็นข้อมูลสกัดจริง **ห้าม commit เข้า repo หรือขึ้น CI runner เด็ดขาด** เทสต์ตัวนี้
รันด้วยมือโดยคนที่ดูแลการนำเข้าชุดนั้นโดยตรง ไม่ใช่ CI

## ลำดับใน job `stack`

1. คัดลอก `.env.ci` → `.env`
2. build image `psu-auth`
3. `docker compose --profile auth up -d`
4. รอ healthcheck ของ postgres, rustfs, polaris, redis, source-sim, trino,
   superset (อ่านค่า `docker inspect Health.Status` ตรง ๆ ใช้ healthcheck ที่มีอยู่แล้ว
   ใน `compose.yaml` แทนที่จะเขียนเช็คใหม่ — สำคัญเพราะ Trino ต้องยืนยันตัวตนจริง
   ตอนเช็ค `/v1/info` เขียนเช็คเองแบบไม่ auth จะไม่มีวันได้ 200)
5. รัน `platform-migrate`
6. reload nginx (รับ config proxy `/auth/` ที่มากับ checkout อยู่แล้ว)
7. รอ NiFi API (ไม่มี healthcheck ระดับ Docker ให้ใช้ ต้อง retry เอง — ใช้ call
   เดียวกับที่ `build-ingest-flow.container.sh` เรียกจริง ไม่ใช่ endpoint ที่เดาขึ้นมาเอง)
8. สร้าง flow นำเข้า + รันครั้งเดียว (`build-ingest-flow.sh`, `run-ingest-once.sh`)
   — สองสคริปต์นี้ต้องรันก่อน เพราะ `test-ingest-pipeline.sh` และ
   `test-maintenance.sh` อ่านตารางที่การนำเข้าสร้างขึ้นจริง (`polaris.raw.sim_hr_*`)
9. รันเทสต์ที่เหลือทั้งหมด ทีละสคริปต์เป็นคนละ step (เห็นใน GitHub ว่าตัวไหนพังชัดเจน
   ไม่ต้องไล่ log รวม)
10. dump log ถ้ามีอะไร fail, `docker compose down -v` เสมอ

## ความเสี่ยงที่ยังไม่ได้พิสูจน์

**ยังไม่เคย push ให้ GitHub Actions รันจริงสักครั้ง** — ตรวจแล้วว่า YAML
parse ผ่าน (`js-yaml`), ทุก script ที่อ้างถึงมีอยู่จริง, ทุก multi-line shell
block ผ่าน `bash -n`, และ endpoint/credential ที่ใช้ตรวจสอบแล้วว่าตรงกับของจริงใน
`compose.yaml` (ไม่ได้เดา) — แต่การรันจริงบน GitHub-hosted runner (RAM 7GB, 2
core) กับสแตกที่มี Postgres+RustFS+Polaris+Trino+OPA+NiFi+Superset พร้อมกันยัง
ไม่เคยพิสูจน์ ถ้า job `stack` fail แบบ container ถูก kill (ไม่ใช่ assertion
พัง) แปลว่าน่าจะชนเพดาน RAM ของ runner มาตรฐาน ทางแก้คือย้ายไป runner ที่แรงขึ้น
(`ubuntu-latest-4-cores` เป็นต้น) ไม่ใช่แก้โค้ด

## รันแบบเดียวกับ CI บนเครื่องตัวเอง

```sh
cp .env.ci .env
docker compose --profile auth build psu-auth
docker compose --profile auth up -d
docker compose run --rm platform-migrate
docker compose exec psu-portal nginx -s reload
./scripts/build-ingest-flow.sh
./scripts/run-ingest-once.sh
./scripts/test-platform-registry.sh   # ฯลฯ
```

ใช้ `.env.ci` ไม่ใช่ `.env` จริงของเครื่อง เพื่อไม่ให้ทดสอบไปกระทบ state จริงที่มี
อยู่ (เช่นบัญชี `identity.app_user` ที่มีอยู่แล้ว) — ทำเสร็จแล้วสลับกลับ `.env`
เดิมได้เลย ไม่มีอะไรถูกเขียนทับถาวร (`docker compose down -v` ลบ volume
ที่สร้างจาก `.env.ci` รอบนั้นทิ้งทั้งหมด)

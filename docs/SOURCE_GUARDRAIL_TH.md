# Guardrail กันการต่อ ingestion source ที่ไม่ได้รับอนุมัติ

สถานะ: บังคับใช้แล้วบน branch `feature/ingestion-framework`

## 1. ทำไมต้องมี

Stack นี้เป็น development บนเครื่องเดียว และยังขาดการควบคุมที่ข้อมูลส่วนบุคคลจริง
ต้องการ:

- Trino ยังไม่มี authenticator client ประกาศ username เองได้ OPA เป็นเพียง
  authorization layer ไม่ใช่ authentication layer
- ยังไม่มี PSU SSO บัญชีที่ใช้อยู่เป็น shared development personas
- ยังไม่มี TLS ระหว่าง service ภายใน
- ยังไม่เคยทดสอบ backup/restore ของ PostgreSQL + RustFS ให้ผ่านจริง
- ยังไม่มี audit trail ระดับบุคคลที่ตรวจย้อนหลังได้

ดังนั้นการต่อ pipeline เข้ากับระบบ production ที่เก็บข้อมูลบุคลากรหรือนักศึกษาจริง
ไม่ปลอดภัย ต่อให้กรอง column ที่อ่อนไหวออกถูกต้องก็ตาม เพราะชั้นป้องกันที่เหลือ
ยังไม่ครบ

Guardrail นี้บังคับข้อกำหนดนั้นด้วยโค้ด แทนที่จะพึ่งความจำของคนที่แก้ configuration

## 2. ทำงานอย่างไร

### 2.1 Allowlist (ตัวหลัก ทำงานแบบ fail closed)

`config/guardrail/allowed-source-hosts.txt` คือรายชื่อ host ที่ระบบได้รับอนุญาต
ให้เปิด database connection ไปหาได้ หนึ่งบรรทัดต่อหนึ่ง host

- `PSU_SOURCE_DB_HOST` ว่าง หมายถึงปิดการ ingest จาก database ถือว่าผ่าน
- ตั้งค่าแล้วแต่ไม่อยู่ในไฟล์นี้ ถูกปฏิเสธ ไม่ใช่ลองต่อดูก่อน
- `PSU_SOURCE_DB_HOST` ว่างแต่ตัวแปร `PSU_SOURCE_DB_*` ตัวอื่นยังมีค่า ถูกปฏิเสธ
  เพราะสถานะค้างครึ่ง ๆ คือสัญญาณของการตั้งค่าผิด ไม่ใช่การปิดใช้งาน

### 2.2 Denylist (ตัวสำรอง ชนะ allowlist เสมอ)

`config/guardrail/forbidden-source-hosts.txt` เทียบแบบ domain suffix และไม่สน
ตัวพิมพ์ใหญ่เล็ก ปัจจุบันมีรายการเดียวคือทั้งโดเมน `psu.ac.th` เพราะระบบจริงของ
มหาวิทยาลัยทุกตัวอยู่นอกขอบเขตของ stack นี้ การไล่ระบุทีละ host ป้องกันได้เฉพาะ
host ที่คนเขียนนึกออกแล้วเท่านั้น

host ที่ตรงกับไฟล์นี้ถูกปฏิเสธแม้จะถูกเพิ่มใน allowlist ด้วย ผลคือการจะต่อไปยัง
host ต้องห้ามได้ ต้องแก้ **สองไฟล์ที่อยู่ใน git** พร้อมกัน ซึ่งเห็นได้ชัดใน
code review ไม่ใช่การแก้ `.env` ของใครคนเดียวที่ไม่มีใครเห็น

### 2.3 บังคับตอนระบบสตาร์ท ไม่ใช่แค่ตอนมีคนนึกได้

Logic อยู่ที่ `config/guardrail/check-source.sh` ไฟล์เดียว ถูกเรียกจากสองทาง:

| ผู้เรียก | จังหวะที่ทำงาน |
|---|---|
| Compose service `source-guard` | ทุกครั้งที่ `docker compose up` — service `nifi` ประกาศ `depends_on: service_completed_successfully` ถ้า guard ไม่ผ่าน NiFi ไม่สตาร์ท |
| `scripts/validate-dev-env.sh` | ทุกครั้งที่ validate, seed หรือ verify |

ใช้ไฟล์เดียวกันทั้งสองทาง กฎจึงไม่มีทางเพี้ยนจากกัน

Container `source-guard` ไม่ได้รับ credential ของ source เลย ได้เพียง hostname
กับ flag ที่บอกว่ามีค่าอื่นถูกตั้งไว้หรือไม่ (`PSU_SOURCE_DB_CREDENTIALS_PRESENT`
สร้างจาก `${VAR:+...}` ใน `compose.yaml`) ตัว script ไม่พิมพ์ค่า configuration ใด
นอกจาก hostname ซึ่งไม่ใช่ความลับ และเป็นสิ่งที่ผู้ดูแลต้องเห็นเพื่อแก้ปัญหา

### 2.4 ตรวจ NiFi canvas ที่รันอยู่จริง

`.env` เป็นเพียงหนึ่งในสองทางที่ source ถูกตั้งค่าได้ connection URL ที่พิมพ์ตรง
ลง controller service ของ NiFi ไม่ผ่าน `.env` เลย guardrail ข้อ 2.1–2.3 จึงมองไม่เห็น

`scripts/check-nifi-sources.sh` ปิดช่องนี้ โดยดึง flow definition จาก NiFi ที่รัน
อยู่ผ่าน REST API แล้วตรวจทุก connection target ในนั้นกับ denylist เดียวกัน และ
บันทึกสำเนา flow ลง `runtime/nifi-flow-backups/` (git-ignored) ไปพร้อมกัน การ
export canvas จึงเป็นผลพลอยได้ของการตรวจ ไม่ใช่งานแยกที่ต้องจำก่อน recreate
container

`scripts/verify-dev-accounts.sh` เรียก script นี้ให้อยู่แล้ว

ข้อจำกัด: นี่เป็นการตรวจ ไม่ใช่การป้องกัน มันบอกได้ว่า canvas ชี้ไปที่ไหน แต่
ไม่ได้ห้าม NiFi เปิด connection ตอน runtime การป้องกันจริงต้องใช้ network-level
egress control ซึ่งยังไม่ได้ทำใน phase นี้

### 2.5 กันไม่ให้ connection target ต้องห้ามหลุดเข้า repository

`scripts/check-forbidden-strings.sh` ตรวจว่าไม่มี connection string ที่ชี้ไป host
ต้องห้ามถูก commit เข้ามา ไม่ว่าจะอยู่ใน flow definition, test fixture, เอกสาร
หรือ example

การเทียบตั้งใจให้แคบ: จับเฉพาะรูปแบบที่เป็นเป้าหมายการเชื่อมต่อจริง เช่น
`://host`, `host=`, `server=`, `jdbc:postgresql:` ข้อความทั่วไปหรืออีเมลที่บังเอิญ
มีชื่อโดเมนไม่ถูกจับ เพื่อให้ check เงียบพอที่คนจะไม่เรียนรู้ที่จะข้ามมัน
ผลลัพธ์ที่พิมพ์ออกมาเป็นเฉพาะส่วนที่ match และ mask ส่วน `user:password@` ทิ้ง

```bash
./scripts/check-forbidden-strings.sh              # ตรวจ staged changes
./scripts/check-forbidden-strings.sh --all        # ตรวจไฟล์ที่ tracked ทั้งหมด
./scripts/check-forbidden-strings.sh --file PATH  # ตรวจไฟล์เดียวบนดิสก์
```

ติดตั้งเป็น pre-commit hook บนเครื่องตัวเอง:

```bash
printf '#!/bin/sh\nexec ./scripts/check-forbidden-strings.sh\n' > .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

## 3. ขั้นตอนขอเพิ่ม host ใหม่เข้า allowlist

การเพิ่มบรรทัดใน allowlist เป็นการเปลี่ยนแปลงที่ต้อง review ไม่ใช่การปรับ config
ก่อนเปิด pull request ต้องระบุให้ครบ:

1. Data Owner ที่อนุมัติการดึงข้อมูล
2. ฐานทางกฎหมาย (lawful basis) ตาม PDPA และระยะเวลาเก็บรักษา (retention)
3. รายการ table และ column ขั้นต่ำที่จำเป็นจริง ๆ
4. ระดับความอ่อนไหวของ column และวิธีที่ pipeline จะกรองออก
5. ปลายทางที่ข้อมูลจะไปอยู่ และใครมีสิทธิ์อ่าน

ถ้าข้อใดยังไม่มีเจ้าของ ให้ถือว่ายังไม่พร้อมนำเข้า

การลบหรือทำให้ denylist แคบลง ไม่ใช่งานประจำ ต้องให้เจ้าของ platform และ Data
Owner ของระบบนั้นเห็นตรงกันเป็นลายลักษณ์อักษรว่า environment นี้มีมาตรการครบตามที่
ข้อมูลชุดนั้นต้องการแล้ว

## 4. สิ่งที่ guardrail นี้ไม่ครอบคลุม

ต้องบอกตรง ๆ เพื่อไม่ให้เข้าใจผิดว่าปลอดภัยเกินจริง:

| ช่องโหว่ที่เหลือ | สถานะ |
|---|---|
| มีคน export ข้อมูลจริงเป็นไฟล์แล้ววางใน `data/incoming/` | ตรวจจากเนื้อหาไฟล์ไม่ได้ กันด้วยกฎการทำงานและ audit log เท่านั้น |
| NiFi เปิด connection ออกไปเองตอน runtime | §2.4 ตรวจเจอ แต่ไม่ได้ห้าม ต้องมี network egress control จึงจะกันได้จริง |
| ต่อด้วย IP address ตรงแทน hostname | allowlist ปฏิเสธให้ (IP ไม่อยู่ในรายการ) แต่ denylist และ §2.4 เทียบด้วยชื่อโดเมน จึงไม่เห็น |
| มีคนรัน container เองด้วย `docker compose run` โดยข้าม `nifi` | guard ผูกกับ service `nifi` ไม่ได้ผูกกับทุก ad-hoc container |
| Credential ของระบบ production ที่ยังค้างอยู่ใน `.env` เดิม | guardrail ไม่ลบให้ ต้องล้างเองและแจ้ง rotate |
| ปลายทางที่ไม่ใช่ database เช่น API หรือ file share | ยังไม่ครอบคลุมใน phase นี้ |

## 5. คำสั่งทดสอบ

```bash
./scripts/test-source-guardrail.sh             # 10 กรณี ไม่แตะ .env และไม่แตะ stack
docker compose run --rm --no-deps source-guard # ตรวจค่าปัจจุบันจริงใน .env
./scripts/check-nifi-sources.sh                # ตรวจ canvas ที่รันอยู่ + export flow
./scripts/check-forbidden-strings.sh --all
```

`scripts/verify-dev-accounts.sh` เรียกทุกตัวข้างต้นให้อยู่แล้ว จึงไม่ต้องรันแยกใน
รอบ acceptance ปกติ

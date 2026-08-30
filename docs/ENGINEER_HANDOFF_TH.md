# คู่มือรับช่วงงาน PSU Open Lakehouse สำหรับ Engineer

สถานะรับมอบ: **Development บนเครื่องเดียว, local account, ยังไม่ต่อ SSO**

ตรวจรับล่าสุด: 30 สิงหาคม 2026

เอกสารนี้คือจุดเริ่มสำหรับ engineer ที่รับงานต่อ ส่วนรายละเอียดการใช้งานทั่วไป
อยู่ใน [README](../README.md), คำสั่งเดินระบบอยู่ใน
[RUNBOOK](RUNBOOK.md) และเป้าหมายรายงานชิ้นแรกอยู่ใน
[MVP_NEXT_WEEK_TH](MVP_NEXT_WEEK_TH.md)

## 1. สิ่งที่ส่งมอบแล้วและยังไม่ได้ส่งมอบ

ส่งมอบแล้ว:

- Compose stack ที่ใช้ Iceberg, Polaris, RustFS, Trino, OPA, Superset, NiFi,
  Qdrant, PostgreSQL และ Redis
- PSU Data Hub ภาษาไทยที่ <http://localhost:8085> พร้อมทางเดินสำหรับผู้ใช้ใหม่
- Superset branding เป็น **PSU Reports** และ deep link จาก Portal
- local Superset dev personas สามบัญชี พร้อม seed ที่ rerun ได้
- Trino group mapping ที่สร้างจาก `.env` และ OPA policy tests 13 กรณี
- acceptance script ที่ตรวจ identity/credential surface ทุกตัวโดยไม่พิมพ์ secret
- พอร์ตบน host จำกัดที่ `127.0.0.1` ระหว่างที่ยังไม่มี SSO/TLS perimeter

ยังไม่ได้ส่งมอบ:

- ไม่มีตารางข้อมูลจริง, NiFi ingestion flow, dataset หรือ dashboard จริง
- `portal/config.js` ยังประกาศว่า published report ไม่พร้อม
- ไม่มี named pilot accounts 10–20 คน; สามบัญชีปัจจุบันเป็น shared dev personas
- ไม่มี SSO, external reverse proxy, production TLS, HA หรือ production audit
- ไม่มี publisher role ที่แยกจาก admin และยังไม่มี backup/restore drill ที่ผ่านจริง

ดังนั้นคำว่า “ระบบขึ้น” ตอนนี้หมายถึง control plane และทางเดินผู้ใช้พร้อมสำหรับ
ทำงานพัฒนา ไม่ได้หมายความว่าพร้อมรับข้อมูลจริงหรือพร้อมเปิดใช้ทั้งมหาวิทยาลัย

## 2. รับ source และเปิดระบบครั้งแรก

ทำจาก root ของ repository นี้:

```bash
git switch main
git pull --ff-only origin main
test -f .env || cp .env.example .env
chmod 600 .env
```

สำหรับ clone ใหม่ ให้เปลี่ยน `change-me` ทุกค่าใน `.env` ก่อน validate สำหรับ
เครื่องเดิมห้าม copy `.env.example` ทับ `.env`; รับ secret เดิมผ่านช่องทางที่
อนุมัติเท่านั้น ไฟล์ Git ไม่มีบัญชีใน `runtime/postgres` หรือ generated group
file ของเครื่องเดิม จากนั้นรัน:

```bash
./scripts/validate-dev-env.sh
docker compose up -d --build
docker compose ps -a
./scripts/seed-dev-accounts.sh
./scripts/verify-dev-accounts.sh
```

รอบแรกอาจใช้เวลาหลายนาทีเพราะต้อง pull image และ build Superset ให้ถือว่าพร้อม
เมื่อ:

- `bucket-setup`, `polaris-bootstrap`, `polaris-setup`,
  `dev-identity-setup` และ `superset-init` เป็น `Exited (0)`
- service ระยะยาวเป็น `Up` และตัวที่มี healthcheck เป็น `healthy`
- บรรทัดสุดท้ายของ verifier เป็น
  `All configured development identity surfaces passed verification`

`Exited (0)` ของ one-shot container คือสำเร็จ ไม่ใช่ระบบล่ม

## 3. Development identity model — local auth, no SSO

คำว่า account ใน stack นี้มีหลายชนิด ห้ามถือว่าเป็น user database เดียวกัน:

| Surface | ชนิด identity | Source of truth | สิ่งที่ seed/verify ทำ |
|---|---|---|---|
| Superset | Human local login | username/password ใน `.env`; role ใน `bootstrap_users.py` | สร้างหรือ reconcile 3 personas, password และ role |
| NiFi | Human/operator single-user login | `NIFI_USERNAME/PASSWORD` | Compose ตั้งค่า; verifier ทดลองขอ token |
| Trino | Asserted logical username ไม่มี password store | `PSU_*_USERNAME` และ `TRINO_INGESTION_USERNAME` | สร้าง group file, ทดสอบ OPA และ query startup |
| RustFS | Shared service/root key pair | `RUSTFS_ACCESS_KEY/SECRET_KEY` | ตรวจสิทธิ์เข้าถึง bucket |
| Polaris | API client principal | `POLARIS_CLIENT_ID/SECRET` | ตรวจ token และ catalog setup |
| PostgreSQL | Shared metadata DB login | `POSTGRES_USER/PASSWORD` | ตรวจ TCP password login และ role |
| Qdrant | Global API key ไม่มี user | `QDRANT_API_KEY` | ตรวจ no-key = 401 และ valid-key = 200 |
| Superset MCP | ไม่มี login ใน dev phase | config ใน `superset_config.py` | ตรวจ anonymous initialize และ analyst dev identity |

Superset personas ปัจจุบัน:

| Persona variable | Superset role | Trino group | Data boundary |
|---|---|---|---|
| `PSU_ADMIN_USERNAME` | Admin | `psu_admin` | ทุก operation สำหรับงานดูแล dev |
| `PSU_ANALYST_USERNAME` | Alpha | `psu_analyst` | อ่าน `curated`, `published` |
| `PSU_VIEWER_USERNAME` | Gamma | `psu_viewer` | อ่าน `published` |
| `TRINO_INGESTION_USERNAME` | ไม่มี Superset login | `psu_ingestion` | ใช้กับ client ที่ส่ง query ผ่าน Trino เท่านั้น |

ข้อควรระวังสำคัญ:

- `TRINO_INGESTION_USERNAME` ต้องไม่ซ้ำกับสาม human personas; renderer บังคับ
  เงื่อนไขนี้เพื่อไม่ให้ ingestion identity รับสิทธิ์ admin โดยบังเอิญ
- username ทั้งสี่ใช้ได้เฉพาะ `[A-Za-z0-9._-]+`, ต้องไม่ซ้ำกัน และห้ามใช้ชื่อ
  `superset` ซึ่งสงวนให้ BI connection
- `NIFI_USERNAME` คือ login หน้า NiFi แต่ `TRINO_INGESTION_USERNAME` เป็นเพียง
  logical label สำหรับ authorization เป็นคนละเรื่องกัน
- Trino ยังไม่มี authenticator จึงเชื่อชื่อที่ client ส่งมา OPA เป็น
  authorization layer ไม่ใช่ authentication layer ห้าม expose Trino ออก network
- Superset role คุมความสามารถใน BI UI ส่วน Trino/OPA คุมขอบเขตข้อมูล ต้องผ่าน
  ทั้งสองชั้น
- Seed จะเขียน role ของสาม dev personas กลับเป็น Admin/Alpha/Gamma ทุกครั้ง
- ใน dev นี้ reader ใช้ `information_schema` เพื่อให้ Superset browse dataset ได้
  จึงอาจเห็นชื่อ schema/table นอกขอบเขตที่อ่านข้อมูลจริงได้
- MCP ไม่มี auth และรันเป็น analyst เฉพาะ dev; host port จึงเป็น loopback เท่านั้น
- NiFi ที่เขียน Iceberg ตรงผ่าน Polaris/RustFS ไม่ผ่าน Trino/OPA และยังไม่มี
  least-privilege Polaris/RustFS principal สำหรับ ingestion ห้ามใช้กับข้อมูลจริง

## 4. Seed และ acceptance gate

รัน seed ทุกครั้งหลังเปลี่ยน username, password หรือ role ของสาม Superset dev
personas:

```bash
./scripts/seed-dev-accounts.sh
./scripts/verify-dev-accounts.sh
```

Seed จะทำสามอย่างแบบ synchronous:

1. ตรวจ `.env`, placeholder และ Compose config โดยไม่พิมพ์ค่า
2. สร้าง `runtime/trino/groups.txt` ใหม่จาก identity variables
3. สร้างหรือ update สาม Superset personas ให้ active, มี role เดียวตามที่กำหนด
   และใช้ password ปัจจุบัน

Verifier ตรวจ Superset, group mapping, OPA tests, live Trino query, NiFi,
PostgreSQL, RustFS, Polaris, Qdrant และ MCP ถ้าขั้นใดไม่ผ่านให้ถือว่า seed ยังไม่
เสร็จ ห้ามแก้ด้วย `|| true`

ข้อจำกัดของ seed:

- ถ้าเปลี่ยน username จะสร้าง/reconcile ชื่อใหม่ แต่ไม่ deactivate ชื่อเก่า
  อัตโนมัติ ให้ verify ชื่อใหม่ก่อนแล้วปิดชื่อเก่าใน Superset UI
- Seed นี้ไม่ใช่ secret rotation ของ PostgreSQL, Polaris, RustFS หรือ NiFi ที่มี
  persistent state อยู่แล้ว ต้องใช้ procedure ของแต่ละ service
- ห้ามแก้ `runtime/trino/groups.txt` ด้วยมือ เพราะ seed รอบถัดไปเขียนทับ
- ห้าม commit `.env` หรือ `runtime/`

## 5. URL และ network boundary ปัจจุบัน

| URL/port | ผู้ใช้ | สถานะ host binding |
|---|---|---|
| <http://localhost:8085> | ผู้ใช้เริ่มต้น/ทีมพัฒนา | loopback |
| <http://localhost:8088> | Superset local users | loopback |
| <http://localhost:8086> | Trino operator | loopback |
| <https://localhost:8443/nifi> | ingestion operator | loopback, self-signed cert |
| <http://localhost:9001> | RustFS operator | loopback |
| <http://localhost:6333/dashboard> | Qdrant operator | loopback |
| <http://localhost:5008/mcp> | reviewed local AI client | loopback, no auth |

Process ภายใน container อาจ listen ที่ `0.0.0.0` แต่ Compose publish เฉพาะ
`127.0.0.1` ห้ามเปลี่ยนเป็น public binding เพื่อแก้ปัญหาเข้าเว็บจากเครื่องอื่น
ใน phase นี้ หากจะเปิด Pilot ผ่าน network ต้องมีงาน perimeter ที่อนุมัติแยก

## 6. ทางเดินข้อมูลและ owner ของแต่ละชั้น

```text
source -> NiFi -> Iceberg files in RustFS
                     + metadata in Polaris/PostgreSQL
       -> Trino -> OPA -> Superset -> PSU Data Hub user path
documents ---------> RustFS + rebuildable Qdrant index
```

- `raw`: เก็บข้อมูลรับเข้าและ lineage ขั้นต้น
- `curated`: นิยามกลาง การทำความสะอาด และการ join ที่ตรวจแล้ว
- `published`: data product ที่ Data Owner อนุมัติให้รายงานอ่าน
- `documents`: original/chunk metadata ที่ govern ได้
- Qdrant เป็น index ที่ rebuild ได้ ไม่ใช่สำเนาหลักของเอกสาร
- Portal เป็น guidance/navigation ไม่ได้ login และไม่ได้ให้สิทธิ์

## 7. งานถัดไปที่ควรทำตามลำดับ

เป้าหมายรอบถัดไปคือรายงานจริงเพียงหนึ่งชิ้นตาม
[แผนห้าวัน](MVP_NEXT_WEEK_TH.md) ไม่ใช่นำทุก silo เข้าพร้อมกัน:

1. ล็อกคำถามบริหารหนึ่งข้อ, Data Owner สองหน่วยงาน, นิยามตัวเลข 3–5 ค่า และ
   รอบเวลาอัปเดต
2. ทำข้อมูลสังเคราะห์สองแหล่งที่มี schema เหมือนจริง พร้อม data contract,
   sensitivity และ quality rules
3. ทำ NiFi flow ที่ rerun ได้, มี ingestion timestamp/source/run id และ
   failure path ก่อนแตะข้อมูลจริง
4. Export/version NiFi flow definition ก่อน recreate container ใด ๆ
5. สร้างเส้นทาง `raw -> curated -> published`, ตรวจ row count/null/duplicate และ
   ให้ Data Owner ยืนยันนิยาม
6. สร้าง Superset dashboard หนึ่งหน้า แล้วทดสอบ admin/analyst/viewer/direct URL
7. เปลี่ยน `publishedReportsReady` ใน `portal/config.js` เป็น `true` หลัง
   dashboard ผ่าน acceptance เท่านั้น
8. ก่อน Pilot ให้ provision named local accounts 10–20 คน แยกจาก shared dev
   personas พร้อมทดสอบ disable/logout; งานนี้ยังไม่ต้องรอ SSO

## 8. Known gaps ที่ห้ามกลบใน handoff ถัดไป

| Gap | ผลกระทบ | งานที่ต้องทำก่อนขยาย scope |
|---|---|---|
| ไม่มี named-account provisioner | shared accounts audit รายบุคคลไม่ได้ | ทำ local provision source/workflow หรือ SSO ภายหลัง |
| Trino ยังไม่ authenticate client | username เป็น asserted value | คง loopback; ทำ trusted proxy/auth ก่อน network exposure |
| NiFi `conf` ไม่ได้ mount | flow definition อาจไม่รอดการ recreate | export/version flow และทดสอบ restore |
| incoming mount เป็น read-only อย่างเดียว | ยังไม่มี archive/quarantine lifecycle | ออกแบบ landing, archive, reject และ retention |
| ไม่มี publisher identity | admin เป็นทางเดียวไป `published` | แยก publisher workflow พร้อม Data Owner approval |
| PostgreSQL login เดียวและเป็น superuser | blast radius สูง | แยก application roles และ migration plan |
| backup/restore ยังไม่ผ่าน drill | backup ที่ restore ไม่ได้ไม่มีค่า | ทดสอบ PostgreSQL + RustFS consistency และ Superset assets |
| Portal health ดู Superset เป็นหลัก | ไม่สะท้อน data freshness | เพิ่ม governed freshness/status contract |
| ไม่มี SSO/TLS/HA | ไม่ใช่ production | ทำเป็น phase แยกเมื่อ MVP พิสูจน์ value แล้ว |

ใช้ synthetic data เท่านั้นจนกว่า Data Owner, purpose, minimization, retention,
access list และช่องทางรับส่งได้รับอนุมัติ

## 9. คำสั่งดูแลประจำ

ดูสถานะและ log:

```bash
docker compose ps -a
docker compose logs --tail=200 trino opa superset superset-mcp
docker compose logs --tail=200 polaris nifi
```

แก้ OPA policy:

```bash
docker compose run --rm opa check /policies/trino.rego
docker compose run --rm opa test /policies --verbose
docker compose restart opa
./scripts/verify-dev-accounts.sh
```

แก้ Superset Python config หรือ bootstrap:

```bash
docker compose restart superset superset-mcp
./scripts/seed-dev-accounts.sh
./scripts/verify-dev-accounts.sh
```

แก้ Compose/image:

```bash
docker compose up -d --build
docker compose ps -a
./scripts/verify-dev-accounts.sh
```

หยุดโดยเก็บ state:

```bash
docker compose stop
```

ใช้ `docker compose down` ได้ต่อเมื่อยังไม่มี NiFi flow หรือ export/version flow
แล้ว เพราะ `down` ลบ container และ flow definition ยังไม่อยู่ใน mount ที่รับรอง
ห้ามใช้การลบ `runtime/` เป็นวิธีแก้ startup เพราะจะลบ metadata, table state,
dashboard, index และ repository state ที่ยังไม่ได้ backup

## 10. Rollback ที่ปลอดภัย

ถ้า code revision ล่าสุดมีปัญหา:

1. เก็บ `docker compose ps -a` และ log ที่เกี่ยวข้องโดยไม่เก็บ secret
2. Export NiFi flow ก่อน recreate NiFi ถ้ามีการสร้าง flow แล้ว
3. ใช้ `git revert <commit>` เพื่อสร้างประวัติ rollback ห้ามใช้
   `git reset --hard` กับ shared branch
4. รัน `docker compose up -d --build`
5. รัน seed และ verifier ใหม่

Code rollback ไม่ได้ rollback persistent data/schema อัตโนมัติ หาก revision มี
migration หรือเขียน Iceberg table ต้องมีแผน data rollback แยกก่อน deploy

## 11. Definition of done สำหรับ engineer คนถัดไป

ก่อนบอกว่างานรอบหนึ่งเสร็จ ต้องมีหลักฐานอย่างน้อย:

- `docker compose config --quiet` ผ่าน
- one-shot containers ที่เกี่ยวข้องเป็น `Exited (0)`
- `./scripts/verify-dev-accounts.sh` ผ่านครบ
- OPA check/test ผ่าน และมี test ใหม่เมื่อ policy เปลี่ยน
- portal health, Superset health และ Trino query ผ่าน
- ไม่มี secret, PII หรือ runtime state อยู่ใน staged diff
- เอกสารระบุสิ่งที่ทำจริง, สิ่งที่ยังไม่ทำ และ rollback path
- ถ้าเป็นรายงานแรก ต้องมี Data Owner acceptance และ role test ก่อนเปิด flag

อย่าเรียก stack นี้ว่า production-ready จนกว่า known gaps ข้างต้นจะถูกปิดด้วย
หลักฐานทดสอบ ไม่ใช่เพียงเพิ่มชื่อเครื่องมือใน architecture

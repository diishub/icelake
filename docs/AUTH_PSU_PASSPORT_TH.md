# เข้าสู่ระบบด้วย PSU Passport และอีเมล/รหัสผ่าน

เอกสารนี้อธิบายวิธีเปิดใช้การเข้าสู่ระบบของ portal ทั้งสองทาง — PSU Passport
(OIDC) และอีเมลกับรหัสผ่าน (สร้างบัญชีโดยผู้ดูแลเท่านั้น) — และบันทึกการประมวลผล
ข้อมูลส่วนบุคคลที่เกี่ยวข้อง

## ทำไมต้องมี service เพิ่ม

PSU Passport เป็น OpenID Connect provider การเข้าสู่ระบบจึงต้องใช้
confidential client ที่ถือ `client_secret` แลก authorization code เป็น token
และถือ session ไว้ฝั่งเซิร์ฟเวอร์

portal เป็นไฟล์ static หลัง nginx ทำสามอย่างนั้นไม่ได้เลย จึงมี service ชื่อ
`psu-auth` ทำหน้าที่นี้ และรับหน้าที่ตรวจอีเมล/รหัสผ่านด้วยในตัวเดียวกัน เพราะ
ทั้งสองทางต้องคุยกับฐานข้อมูล `identity` เดียวกันและออก session แบบเดียวกัน —
nginx proxy `/auth/*` ไปให้แบบ same-origin ผลคือ session cookie เป็น
`HttpOnly` อยู่บนโฮสต์เดียวกับ portal และไม่ต้องผ่อน Content-Security-Policy
เพิ่มแม้แต่บรรทัดเดียว

**สองทางนี้เป็นอิสระจากกัน** เครื่องที่ยังไม่ได้ลงทะเบียน OIDC client กับ
PSU Passport ยัง**สตาร์ต service ได้ปกติ** และให้เข้าสู่ระบบด้วยอีเมล/รหัสผ่านได้
ปุ่ม PSU Passport บนหน้า `/login` จะซ่อนตัวเองพร้อมข้อความอธิบายแทนที่จะเสนอ
ลิงก์ที่กดแล้วพัง (ตรวจจาก `/auth/health` ที่ตอบ `{"psuPassport": false}`)

## สิ่งที่ต้องเตรียมก่อน

**ถ้าต้องการเฉพาะอีเมล/รหัสผ่าน** ไม่ต้องเตรียมอะไรเพิ่มนอกจาก
`IDENTITY_DB_PASSWORD` (มีอยู่แล้วถ้ารัน `platform-migrate` ไปแล้ว) แล้วข้ามไป
หัวข้อ "เปิดใช้งาน" ได้เลย

**ถ้าต้องการ PSU Passport ด้วย:**

1. **ลงทะเบียน OIDC client กับผู้ดูแล PSU Passport** โดยระบุ redirect URI เป็น
   `AUTH_PUBLIC_ORIGIN` + `/auth/callback` เช่น `http://localhost:8085/auth/callback`
   สำหรับเครื่องพัฒนา จะได้ `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` มา
2. **ขอ API key ของ API gateway** สองตัว คือ `API_STUDENT_KEY` และ `API_STAFF_KEY`
   ใช้ตรวจว่าผู้ใช้เป็นนักศึกษาหรือบุคลากร
3. ใส่ค่าทั้งหมดใน `.env` ดูรายการเต็มและคำอธิบายในหัวข้อ
   `Portal sign-in (PSU Passport)` ของ `.env.example`

**ห้าม** นำค่าเหล่านี้ขึ้น git, ใส่ใน `config.js` ของ portal, หรือส่งต่อในแชต
ถ้าเผลอส่งไปแล้วให้ถือว่ารั่วและขอออกใหม่

## เปิดใช้งาน

```sh
docker compose run --rm platform-migrate        # สร้าง schema identity
docker compose --profile auth up -d psu-auth    # เปิด service เข้าสู่ระบบ
docker compose exec psu-portal nginx -s reload  # ให้ nginx รับ /auth/ proxy
```

`psu-auth` อยู่หลัง Compose profile เพื่อให้สแตกที่เหลือขึ้นได้ตามปกติบนเครื่องที่
ยังไม่ได้เปิดใช้การเข้าสู่ระบบเลย — เมื่อไม่ได้เปิด service นี้ `/auth/me` จะตอบ 502
และ portal จะ**ซ่อนปุ่มเข้าสู่ระบบ**แทนที่จะโชว์ปุ่มที่กดแล้วพัง

**ไม่จำเป็นต้องมี OIDC client ก่อนเปิด service นี้อีกต่อไป** — ถ้า `OIDC_ISSUER`,
`OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` ยังว่างอยู่ `psu-auth` จะสตาร์ตปกติ
พร้อมเข้าสู่ระบบด้วยอีเมล/รหัสผ่าน และ log แจ้งว่า PSU Passport ปิดอยู่:

```
[auth] OIDC_ISSUER/OIDC_CLIENT_ID/OIDC_CLIENT_SECRET not set;
PSU Passport sign-in is disabled, email-and-password sign-in still works
```

## ลำดับการทำงาน

1. ผู้ใช้กด **เข้าสู่ระบบด้วย PSU Passport** → `GET /auth/login?next=<หน้าปัจจุบัน>`
2. `psu-auth` สร้าง state, nonce และ PKCE verifier เก็บไว้ในหน่วยความจำ
   ส่ง handle กลับเป็น cookie อายุ 10 นาที แล้ว redirect ไป PSU Passport
3. ผู้ใช้ยืนยันตัวตนที่ PSU Passport แล้วถูกส่งกลับมาที่ `/auth/callback`
4. `psu-auth` แลก code เป็น token ด้วย `openid-client` ซึ่งตรวจ issuer, audience,
   ลายเซ็น, nonce และ state ให้ ถ้าไม่ผ่านจะไม่ออก session
5. ถามชื่อผู้ใช้จาก claim แล้วตัดเฉพาะส่วนหน้า `@` (gateway ใช้รูปแบบนี้)
6. **ยิง API gateway เพื่อตัดสินประเภทผู้ใช้**
   - ชื่อผู้ใช้ขึ้นต้นด้วยตัวเลข → ลอง `GET /regist/v3/student/:campus?studentId=`
     ไล่ตามรหัสวิทยาเขต ถ้าไม่พบจึงลองเป็นบุคลากร
   - อย่างอื่น → `GET /Personnel/GetStaffDetailsByUserName/:userName`
   - ทั้งสองส่ง header `credential: api_key=<key>`
   - **endpoint ที่ตอบเป็นตัวตัดสิน `user_type` ไม่ใช่รูปแบบของชื่อผู้ใช้**
7. ออก session token สุ่ม 256 บิต เก็บ **SHA-256 ของ token** ลงฐานข้อมูล
   ส่งตัว token เป็น cookie `HttpOnly; Secure; SameSite=Lax`
8. redirect กลับหน้าเดิม

## กฎที่บังคับไว้ในโค้ด

**ตรวจว่าคำตอบตรงคน** ถ้า gateway ตอบข้อมูลของรหัสนักศึกษาหรือชื่อผู้ใช้อื่น
ระบบจะทิ้งคำตอบนั้น ไม่เอามาแปะกับบัญชี การติดคณะของคนอื่นให้ผู้ใช้แย่กว่าการไม่รู้คณะเลย

**ไม่เดาประเภทผู้ใช้** เมื่อ gateway ล่มหรือไม่พบข้อมูล `user_type` จะเป็น `unknown`
และ portal ปฏิบัติกับ `unknown` เท่ากับไม่มีสิทธิ์เพิ่ม ไม่ใช่เดาจากชื่อผู้ใช้

**ไม่เขียนข้อมูลส่วนบุคคลลง log** log บันทึกเฉพาะชื่อ endpoint กับ HTTP status
เพราะ path และ query string มีรหัสนักศึกษาหรือชื่อผู้ใช้อยู่

**เก็บ hash ไม่เก็บ token** ตาราง `identity.user_session` เก็บ SHA-256 ของ cookie
ใครได้ dump ฐานข้อมูลไปจึงสวมรอย session ที่ยังไม่หมดอายุไม่ได้

**redirect กลับได้เฉพาะ path ภายใน** ค่า `next` ที่ขึ้นต้นด้วย `//` หรือระบุโฮสต์
จะถูกแทนด้วย `/` ไม่ใช่แก้ให้ถูก

## เข้าสู่ระบบด้วยอีเมลและรหัสผ่าน

หน้า `/login` เสนอสองทางเสมอ (ซ่อนปุ่ม PSU Passport เองถ้ายังไม่เปิดใช้งาน) —
อ้างอิงโครงจากหน้า login ของ dotBlue (ปุ่ม OIDC เด่นด้านบน, เส้นคั่น, ฟอร์ม
อีเมล/รหัสผ่านด้านล่าง) แต่ผูกกับฐานข้อมูล Postgres ชุดเดียวกับ PSU Passport
ไม่ใช่ MongoDB ของ dotBlue

**ไม่มีหน้าสมัครสมาชิก** `POST /auth/password/login` เป็น route เดียวที่เกี่ยวข้อง
กับรหัสผ่าน และเป็น route สำหรับ**ตรวจ**อย่างเดียว ไม่มี route ใดใน service นี้
ที่เขียน `password_hash` ได้ — บัญชีสร้างโดยผู้ดูแลผ่าน
`scripts/create-password-account.sh` เท่านั้น ซึ่งรันเป็น superuser ของฐานข้อมูล
(`psu`) เหมือน `config/platform/migrate.sh` ไม่ใช่ role `identity_app` ที่ service
ใช้ตอนรัน — แยกกันโดยสิ้นเชิงระดับสิทธิ์ฐานข้อมูล ไม่ใช่แค่ไม่มีปุ่มในหน้าเว็บ

### สร้างบัญชี

```sh
scripts/create-password-account.sh someone@psu.ac.th "ชื่อที่จะแสดงในระบบ"
```

สุ่มรหัสผ่านให้ (ไม่ให้ผู้ดูแลตั้งเอง เพราะมักตั้งรหัสอ่อนหรือใช้ซ้ำ) แล้วพิมพ์ออกมา
**ครั้งเดียว** ทางเทอร์มินัล ไม่เก็บไว้ที่ไหนอีก ผู้ดูแลนำไปส่งต่อผ่านช่องทางที่
หน่วยงานเชื่อถืออยู่แล้ว เหมือนการส่งต่อรหัสผ่านชุดอื่น ๆ

บัญชีเริ่มที่ `access_tier = 'none'` เหมือนบัญชี PSU Passport ทุกประการ —
เข้าสู่ระบบได้ไม่ได้แปลว่าอ่านข้อมูลได้ ต้องให้สิทธิ์แยกต่างหาก:

```sql
UPDATE identity.app_user SET access_tier = 'viewer', org_unit = '<unit>'
  WHERE lower(email) = lower('someone@psu.ac.th');
```
```sh
scripts/publish-trino-groups.sh
```

รันซ้ำด้วยอีเมลเดิมเพื่อ**ตั้งรหัสผ่านใหม่**ได้ (กรณีลืมรหัสผ่าน) — ไม่มีหน้า
"ลืมรหัสผ่าน" ที่ผู้ใช้กดเองได้ ต้องขอผู้ดูแล

### กฎที่บังคับไว้ในโค้ด (อีเมล/รหัสผ่าน)

**เดายากว่าใครมีบัญชีจริง** ไม่ว่าอีเมลจะไม่มีอยู่จริง รหัสผ่านผิด หรือบัญชีเป็น
PSU-Passport-only (ไม่มี `password_hash`) — ทั้งสามกรณีตอบ**ข้อความเดียวกัน**
(`401 invalid_credentials`) และรัน bcrypt compare **ต้นทุนเท่ากันเสมอ** โดยเทียบกับ
hash หลอกเมื่อไม่พบบัญชีจริง (`services/auth/src/password.ts`) กันไม่ให้ทั้งข้อความ
และเวลาตอบสนองบอกได้ว่าอีเมลนั้นมีอยู่ในระบบหรือไม่ — ปรับปรุงจากรูปแบบอ้างอิงของ
dotBlue เอง ซึ่งตอบข้อความต่างกันระหว่าง "Email does not exist" กับ
"Incorrect password"

**จำกัดจำนวนครั้งต่ออีเมล** ผิดเกิน `PASSWORD_LOGIN_MAX_ATTEMPTS` (ค่าเริ่มต้น 8)
ครั้งในหน้าต่าง `PASSWORD_LOGIN_WINDOW_SECONDS` (ค่าเริ่มต้น 900 วินาที) ตอบ
`429` พร้อม `Retry-After` ตัวนับอยู่ใน**หน่วยความจำของ service เอง** ไม่ใช่ฐานข้อมูล
จึงรีเซ็ตเมื่อ restart และไม่ใช้ร่วมกันถ้าวันหนึ่งขยายเป็นหลาย instance — จุดจำกัดที่
ต้องรู้ ไม่ใช่เรื่องซ่อน

**เก็บ hash ไม่เก็บรหัสผ่าน** `password_hash` เป็น bcrypt (cost factor ตั้งได้ผ่าน
`PASSWORD_LOGIN_BCRYPT_COST`) ไม่มีที่ใดในโค้ดเก็บรหัสผ่านตัวเดิม แม้แต่ชั่วคราว
เครื่องมือแฮชรหัส (`services/auth/src/tools/hash-password.ts`) พิมพ์ผลลัพธ์ไปที่
stdout อย่างเดียว ไม่เขียนไฟล์

**identity_app อ่าน `password_hash` ได้เพื่อตรวจ แต่เขียนไม่ได้เลย** migration
`013-password-login.sql` ไม่ให้สิทธิ์ INSERT/UPDATE บนคอลัมน์นี้แก่ role นี้ในทั้ง
สองทิศทาง — ต่อให้โค้ดของ service มีบั๊ก ก็ไม่มีทางเขียนรหัสผ่านลงบัญชีใครได้จาก
เส้นทางที่ผู้ใช้ทั่วไปเข้าถึง

## บันทึกการประมวลผลข้อมูลส่วนบุคคล (PDPA)

นี่เป็น schema แรกในสแตกนี้ที่เก็บข้อมูลบุคคลจริง ทุกอย่างที่เหลือเป็นข้อมูลสังเคราะห์

| หัวข้อ | รายละเอียด |
|---|---|
| วัตถุประสงค์ | ตัดสินว่าผู้ที่เข้าสู่ระบบเปิดอะไรได้บ้างใน portal และแสดงสังกัดของตนเอง |
| ฐานทางกฎหมาย | ภารกิจของรัฐเพื่อประโยชน์สาธารณะ PDPA มาตรา 24(4) — ควบคุมการเข้าถึงระบบสารสนเทศของมหาวิทยาลัยสำหรับบุคลากรและนักศึกษาของตนเอง |
| ข้อมูลที่เก็บ | OIDC subject (ถ้ามี), ชื่อผู้ใช้ PSU (ถ้ามี), ชื่อแสดงผล, อีเมล, bcrypt hash ของรหัสผ่าน (เฉพาะบัญชีที่ผู้ดูแลสร้าง), ประเภทผู้ใช้, วิทยาเขต, คณะ, ภาควิชา, สาขา, เวลาเข้าใช้ |
| ข้อมูลที่**ไม่**เก็บ | เลขประจำตัวประชาชน, วันเกิด, ที่อยู่, เบอร์โทร, สัญชาติ, สถานภาพการศึกษา — gateway ส่งมาด้วยแต่โค้ดไม่ประกาศ type ไว้ จึงอ่านหรือเก็บโดยบังเอิญไม่ได้ |
| log การเข้าถึง | บันทึกว่ามีการเข้าสู่ระบบและจบอย่างไร ด้วยรหัสเหตุผลชุดปิด ไม่มี IP ไม่มี user agent ไม่มี payload ของ claim |
| ระยะเก็บรักษา | session หมดอายุตามเวลา, login event 180 วัน, บัญชีที่ไม่ได้เข้าใช้ 24 เดือน — บังคับด้วย `identity.purge_expired()` ซึ่ง service เรียกทุกชั่วโมง ไม่ใช่รอคนมารัน |
| สิทธิ์ในฐานข้อมูล | role `identity_app` ไม่มี DELETE บนบัญชีและบน log การเข้าถึง ปิดบัญชีด้วย `is_active` และตัด log ได้ด้วยฟังก์ชัน retention ที่ลบตามอายุเท่านั้น role `platform_app` ของท่อนำเข้าอ่าน schema นี้ไม่ได้เลย |

## ทำให้ Superset ใช้ PSU Passport ด้วย

เมื่อเปิดส่วนนี้ ผู้ที่เข้าสู่ระบบที่ portal แล้วกด "เปิดในระบบรายงาน" จะไม่ถูกถาม
รหัสผ่านซ้ำ เพราะ PSU Passport จำ session ไว้แล้วและส่งกลับมาทันที

### เปิดใช้งาน

1. ลงทะเบียน redirect URI เพิ่มกับ PSU Passport:
   `<ที่อยู่ที่เบราว์เซอร์เข้าถึง Superset>/oauth-authorized/psu`
   เป็นคนละ path กับของ portal จึงต้องใส่ทั้งสองอันใน client เดียว
   หรือขอ client ที่สอง — ทำได้ทั้งคู่
2. ตั้งค่าใน `.env` หัวข้อ `Report workspace sign-in (Superset)`
   อย่างน้อยต้องมี `SUPERSET_OAUTH_ENABLED=true`, `SUPERSET_OAUTH_CLIENT_ID`,
   `SUPERSET_OAUTH_CLIENT_SECRET` และ `SUPERSET_OAUTH_ISSUER`
   (เว้นว่างได้ถ้าใช้ issuer เดียวกับ portal)
3. `docker compose up -d superset`

ปิดไว้เป็นค่าเริ่มต้น เครื่องที่ยังไม่ได้ลงทะเบียน client จึงยังใช้บัญชีท้องถิ่น
ที่ `bootstrap_users.py` สร้างได้ตามเดิม และถ้าเปิดสวิตช์แต่ไม่ใส่ client
Superset จะ**ไม่สตาร์ต**พร้อมบอกชื่อค่าที่ขาด ไม่ใช่เงียบ ๆ กลับไปโชว์ฟอร์มรหัสผ่าน

เมื่อเปิด OAuth แล้ว การเข้าสู่ระบบด้วยรหัสผ่านจะถูก**แทนที่** ไม่ใช่เพิ่มเข้ามา
เพราะสองทางเข้าสำหรับคนคนเดียวหมายถึงต้องกำกับ credential สองชุด

### เข้าสู่ระบบได้ ไม่ได้แปลว่าเห็นข้อมูล

นี่คือส่วนที่สำคัญที่สุดของการออกแบบนี้

การยืนยันตัวตนบอกว่า "คุณคือใคร" ไม่ได้บอกว่า "คุณอ่านอะไรได้" และสแตกนี้
**ไม่มี**ทางแปลงสังกัดจากไดเรกทอรี ม.อ. ไปเป็นค่า `org_unit` ที่ตารางเผยแพร่ใช้กรองแถว
ชื่อคณะภาษาไทยไม่ใช่คีย์ `org_unit`

บัญชีที่เพิ่งเข้าสู่ระบบครั้งแรกจึงอยู่ที่ `access_tier = 'none'`:

- เข้า Superset ได้ เห็นหน้าจอได้
- แต่คำสั่งใด ๆ ที่วิ่งไป Trino จะถูก OPA ปฏิเสธ เพราะบัญชีนั้นไม่อยู่ในกลุ่มใดเลย

ผู้ดูแลต้องบันทึกสิทธิ์ให้อย่างชัดเจนก่อน:

```sql
-- ผู้ใช้รายงานที่ผูกกับหน่วยงานหนึ่ง (ต้องมี org_unit เสมอ)
UPDATE identity.app_user
   SET access_tier = 'viewer', org_unit = 'eng'
 WHERE psu_username = '<username>';

-- ผู้บริหารที่เห็นทุกหน่วยงาน
UPDATE identity.app_user SET access_tier = 'viewer_exec' WHERE psu_username = '<username>';

-- นักวิเคราะห์
UPDATE identity.app_user SET access_tier = 'analyst' WHERE psu_username = '<username>';

-- เจ้าของข้อมูล ผูกกับหน่วยงานหนึ่งเสมอ (ต้องมี org_unit เหมือน viewer)
UPDATE identity.app_user
   SET access_tier = 'steward', org_unit = 'eng'
 WHERE psu_username = '<username>';

-- นักพัฒนา -- สิทธิ์เท่ากับ identity ผู้ดูแลแพลตฟอร์มทุกประการ ดูหัวข้อ
-- "ระดับสิทธิ์ทั้งหก" ด้านล่างก่อนใช้ tier นี้
UPDATE identity.app_user SET access_tier = 'developer' WHERE psu_username = '<username>';
```

แล้วสั่ง:

```sh
scripts/publish-trino-groups.sh
```

สคริปต์นี้เขียน `runtime/trino/groups.txt` ใหม่จากสองแหล่งรวมกัน คือ identity
สำหรับพัฒนาใน `.env` (ผ่าน `render-groups.sh` เดิม) และสิทธิ์ของบัญชี SSO จาก
`identity.v_trino_groups` Trino อ่านไฟล์นี้ใหม่ทุก 5 วินาที การให้สิทธิ์และ
การถอนสิทธิ์จึงมีผลโดยไม่ต้องรีสตาร์ต

**service เข้าสู่ระบบให้สิทธิ์ใครไม่ได้ รวมถึงตัวเอง** migration 008 เปลี่ยน
สิทธิ์ของ role `identity_app` จาก UPDATE ทั้งตารางเป็น UPDATE รายคอลัมน์
คอลัมน์ `access_tier` กับ `org_unit` ไม่อยู่ในรายการ การแยกนี้จึงอยู่ในโครงสร้าง
ไม่ใช่อยู่ที่ว่าโค้ดเขียนระวังพอหรือไม่

### ช่องโหว่ที่ปิดไประหว่างทาง

ตอนต่อ SSO พบว่า `psu_viewer` ที่ไม่มีกลุ่ม `psu_viewer_org_*` เลย อ่าน schema
`published` ได้**โดยไม่มี row filter** เพราะ rule ที่สร้าง filter ต้องวนจากเซ็ต
org unit ถ้าเซ็ตว่างก็ไม่เกิด filter — การไม่มีขอบเขตจึงให้สิทธิ์กว้างที่สุดแทนที่จะแคบที่สุด

เดิมไม่แสดงอาการเพราะ `render-groups.sh` ให้ viewer ทุกคนมีหน่วยงานหรือเป็น exec เสมอ
แต่บัญชี SSO มาถึงในสภาพไม่มีกลุ่มพอดี ตอนนี้ policy ปฏิเสธชุดนี้แล้ว และ
constraint `app_user_viewer_is_scoped` กันไม่ให้บันทึกสถานะนั้นลงฐานข้อมูลตั้งแต่แรก
ทดสอบไว้ที่ `test_unscoped_viewer_cannot_select_published`

### ระดับสิทธิ์ทั้งหก

`access_tier` รับได้ 6 ค่า (`config/platform/014-steward-developer-tiers.sql`):

| tier | ต้องมี org_unit | อ่าน | เขียน | Trino group |
|---|---|---|---|---|
| `none` | ไม่ | ไม่มีเลย | ไม่มีเลย | ไม่ปรากฏใน groups.txt |
| `viewer` | **ต้องมี** | `published` เฉพาะแถวของหน่วยงานตัวเอง | ไม่มี | `psu_viewer`, `psu_viewer_org_<unit>` |
| `viewer_exec` | ไม่ | `published` ทุกหน่วยงาน | ไม่มี | `psu_viewer`, `psu_viewer_exec` |
| `analyst` | ไม่ | `curated`+`published` ทุกหน่วยงาน | `curated`+`published` ทุกหน่วยงาน | `psu_analyst` |
| `steward` | **ต้องมี** | `curated`+`published` เฉพาะแถวของหน่วยงานตัวเอง | **ไม่มี — ดูเหตุผลด้านล่าง** | `psu_steward`, `psu_steward_org_<unit>` |
| `developer` | ไม่ | ทุกอย่าง ไม่มีข้อจำกัด | ทุกอย่าง ไม่มีข้อจำกัด | `psu_admin` (**กลุ่มเดียวกับ identity ผู้ดูแลแพลตฟอร์ม**) |

**ทำไม `steward` อ่านได้แต่เขียนไม่ได้** OPA/Trino บังคับ row filter ได้เฉพาะตอน
`SELECT` (`GetRowFilters`) เท่านั้น ไม่มีกลไกบังคับ "เขียนได้เฉพาะแถวของหน่วยงานตัวเอง"
สำหรับ `INSERT`/`UPDATE`/`DELETE` เลย ถ้าให้สิทธิ์เขียนตอนนี้ เท่ากับให้เขียนทับ
**ทุกแถว**ใน `curated`/`published` ไม่ใช่แค่ของหน่วยงานตัวเอง ซึ่งขัดกับความหมายของ
"เจ้าของข้อมูลของหน่วยงานตัวเอง" โดยตรง — รอเส้นทางเขียนที่ scope ได้จริงก่อน
(เช่น ผ่าน staging table เฉพาะหน่วยงาน หรือ workflow ตรวจสอบก่อน merge)
ตอนนี้เจ้าของข้อมูลยังส่งคำขอผ่านหัวข้อ "เมื่อข้อมูลยังไม่พร้อม" บนหน้า portal
เหมือนเดิม

**`developer` = สิทธิ์เท่า `psu_admin` ทุกประการ ไม่ใช่ "แอดมินอย่างอ่อน"**
OPA มีกฎ `allow if is_admin` แบบไม่มีเงื่อนไขต่อท้ายเลย (บรรทัดเดียวให้ผ่านทุก
operation ทุก schema) — บัญชี tier นี้จึงมีสิทธิ์เท่ากับ identity ที่ควบคุมทั้ง
แพลตฟอร์ม ไม่ใช่แค่ข้อมูล ให้ tier นี้เฉพาะทีมพัฒนาของตัวเอง ไม่ใช่ผู้ใช้ทั่วไป
ที่ "ขอสิทธิ์เยอะหน่อย"

**บัญชี email/รหัสผ่านต้องมี `psu_username` ก่อนรับ tier ใด ๆ ได้** ไม่ว่า tier
ไหน — คอลัมน์นี้คือชื่อที่ `identity.v_trino_groups` ใช้เขียนลง `groups.txt`
บัญชี PSU Passport ได้ค่านี้จากไดเรกทอรีอัตโนมัติตอน sync ครั้งแรก แต่บัญชี
รหัสผ่านไม่มีไดเรกทอรีให้ดึง จึง `scripts/create-password-account.sh` สร้างให้
อัตโนมัติจากส่วนหน้า `@` ของอีเมล (เช่น `somchai.k@psu.ac.th` → `somchai.k`)
เว้นแต่จะระบุเอง (พารามิเตอร์ตัวที่ 3) — บังคับด้วย constraint
`app_user_password_tier_needs_username` ไม่ใช่แค่ข้อตกลง ลองให้ tier บัญชีที่ไม่มี
`psu_username` จะถูกฐานข้อมูลปฏิเสธทันที

### ตรวจสอบ

```sh
scripts/test-superset-oauth.sh                                   # 6 เคส
docker compose run --rm --entrypoint /opa opa test /policies     # 50 เคส
scripts/test-identity.sh                                         # 23 เคส
```

## สิ่งที่ยังไม่ได้ทำ

**ยังไม่ได้ทดสอบกับ PSU Passport จริง** เพราะยังไม่มี OIDC client ที่ลงทะเบียนไว้
สิ่งที่ทดสอบแล้วคือ: service สตาร์ตไม่ขึ้นและบอกชื่อค่าที่ขาดเมื่อ config ไม่ครบ,
เชื่อมฐานข้อมูลด้วย role `identity_app` ได้จริง, การใช้งาน `openid-client` 6.1.7
ผ่าน typecheck กับ type definitions ของไลบรารีเอง, และข้อจำกัดทุกข้อของ schema
ใน `scripts/test-identity.sh`

**ยังไม่มีกฎอัตโนมัติว่านักศึกษากับบุคลากรเห็นต่างกันอย่างไร** ประเภทผู้ใช้ถูกเก็บไว้แล้ว
และสิทธิ์ให้ได้ทีละบัญชีผ่าน `access_tier` แต่ยังไม่มีนโยบายที่แปลงประเภทผู้ใช้
เป็นสิทธิ์โดยอัตโนมัติ ต้องออกแบบร่วมกับเจ้าของข้อมูลก่อน ไม่ควรให้ระบบเดาเอง

**อีเมล/รหัสผ่านยังไม่มีทางแก้เองสามอย่าง** — (1) ไม่มีหน้า "ลืมรหัสผ่าน" ที่ผู้ใช้กด
เองได้ ต้องขอผู้ดูแลรัน `create-password-account.sh` ซ้ำเพื่อออกรหัสใหม่
(2) ไม่มีหน้าเปลี่ยนรหัสผ่านหลัง login แล้ว (3) ไม่มีการบังคับเปลี่ยนรหัสผ่านในการ
เข้าสู่ระบบครั้งแรก ทั้งสามข้อทำได้ในเฟสถัดไปถ้าต้องการ

**ตัวจำกัดจำนวนครั้งของอีเมล/รหัสผ่านไม่ทนต่อการรีสตาร์ตหรือหลาย instance** เป็น
in-memory ต่อ process (`services/auth/src/password.ts`) เหมาะกับ deployment
เดียวที่รันอยู่ตอนนี้ ถ้าขยายเป็นหลาย instance ต้องย้ายไป Redis หรือฐานข้อมูล

**`steward` อ่านได้แต่เขียนไม่ได้** ตามที่อธิบายไว้ในหัวข้อ "ระดับสิทธิ์ทั้งหก"
ด้านบน — Trino/OPA บังคับ row-level ได้เฉพาะตอนอ่าน ยังไม่มีเส้นทางเขียนที่
scope ตามหน่วยงานได้จริง ต้องออกแบบเพิ่มถ้าจะเปิดให้เจ้าของข้อมูลเขียนเองโดยตรง

**ยังไม่มีบัญชีจริงสักบัญชีสำหรับ 4 บทบาทที่คุยกันไว้** ระดับสิทธิ์ทั้งหมดพร้อมใช้
ในโค้ดแล้ว (ทดสอบผ่าน `scripts/test-identity.sh` และ OPA policy ครบ) แต่ยังไม่มี
ผู้ดูแลรัน `scripts/create-password-account.sh` จริงสักครั้ง — `identity.app_user`
ยังมี 0 แถว ต้องสร้างบัญชีจริงเมื่อพร้อมใช้งาน

**ยังไม่ได้ทดสอบ PSU Passport กับ instance จริง** เพราะยังไม่มี OIDC client ที่
ลงทะเบียนไว้ สิ่งที่ทดสอบแล้วคือ: service สตาร์ตขึ้นได้ทั้งแบบมีและไม่มี OIDC client
(อีเมล/รหัสผ่านใช้งานได้ในทั้งสองกรณี), เชื่อมฐานข้อมูลด้วย role `identity_app` ได้จริง,
การใช้งาน `openid-client` 6.1.7 ผ่าน typecheck กับ type definitions ของไลบรารีเอง,
ข้อจำกัดทุกข้อของ schema ใน `scripts/test-identity.sh`, และเส้นทางอีเมล/รหัสผ่าน
ทั้งหมดทดสอบจริงผ่าน HTTP ใน `scripts/test-password-login.sh`

## ตรวจสอบ

```sh
scripts/test-identity.sh        # ข้อจำกัดและสิทธิ์ของ schema identity รวมบัญชีรหัสผ่าน
scripts/test-password-login.sh  # เข้าสู่ระบบด้วยอีเมล/รหัสผ่านจริงผ่าน HTTP (ข้าม ถ้า psu-auth ไม่ได้รัน)
scripts/test-superset-oauth.sh  # การเข้าสู่ระบบของ Superset และการให้สิทธิ์
docker compose logs psu-auth    # ไม่ควรมีอีเมล ชื่อผู้ใช้ รหัสผ่าน หรือรหัสนักศึกษาปรากฏ
```

# เข้าสู่ระบบด้วย PSU Passport

เอกสารนี้อธิบายวิธีเปิดใช้การเข้าสู่ระบบของ portal ผ่าน PSU Passport
และบันทึกการประมวลผลข้อมูลส่วนบุคคลที่เกี่ยวข้อง

## ทำไมต้องมี service เพิ่ม

PSU Passport เป็น OpenID Connect provider การเข้าสู่ระบบจึงต้องใช้
confidential client ที่ถือ `client_secret` แลก authorization code เป็น token
และถือ session ไว้ฝั่งเซิร์ฟเวอร์

portal เป็นไฟล์ static หลัง nginx ทำสามอย่างนั้นไม่ได้เลย จึงมี service ชื่อ
`psu-auth` ทำหน้าที่นี้อย่างเดียว และ nginx proxy `/auth/*` ไปให้แบบ same-origin
ผลคือ session cookie เป็น `HttpOnly` อยู่บนโฮสต์เดียวกับ portal และไม่ต้องผ่อน
Content-Security-Policy เพิ่มแม้แต่บรรทัดเดียว

## สิ่งที่ต้องเตรียมก่อน

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

`psu-auth` อยู่หลัง Compose profile เพราะไม่มี OIDC client แล้วมันสตาร์ตไม่ได้
สแตกที่เหลือจึงต้องขึ้นได้ตามปกติบนเครื่องที่ยังไม่ได้ลงทะเบียน client
เมื่อไม่ได้เปิด service นี้ `/auth/me` จะตอบ 502 และ portal จะ**ซ่อนปุ่มเข้าสู่ระบบ**
แทนที่จะโชว์ปุ่มที่กดแล้วพัง

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

## บันทึกการประมวลผลข้อมูลส่วนบุคคล (PDPA)

นี่เป็น schema แรกในสแตกนี้ที่เก็บข้อมูลบุคคลจริง ทุกอย่างที่เหลือเป็นข้อมูลสังเคราะห์

| หัวข้อ | รายละเอียด |
|---|---|
| วัตถุประสงค์ | ตัดสินว่าผู้ที่เข้าสู่ระบบเปิดอะไรได้บ้างใน portal และแสดงสังกัดของตนเอง |
| ฐานทางกฎหมาย | ภารกิจของรัฐเพื่อประโยชน์สาธารณะ PDPA มาตรา 24(4) — ควบคุมการเข้าถึงระบบสารสนเทศของมหาวิทยาลัยสำหรับบุคลากรและนักศึกษาของตนเอง |
| ข้อมูลที่เก็บ | OIDC subject, ชื่อผู้ใช้ PSU, ชื่อแสดงผล, อีเมล, ประเภทผู้ใช้, วิทยาเขต, คณะ, ภาควิชา, สาขา, เวลาเข้าใช้ |
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

### ตรวจสอบ

```sh
scripts/test-superset-oauth.sh                                   # 6 เคส
docker compose run --rm --entrypoint /opa opa test /policies     # 41 เคส
scripts/test-identity.sh                                         # 9 เคส
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

## ตรวจสอบ

```sh
scripts/test-identity.sh      # ข้อจำกัดและสิทธิ์ของ schema identity
scripts/test-superset-oauth.sh # การเข้าสู่ระบบของ Superset และการให้สิทธิ์
docker compose logs psu-auth  # ไม่ควรมีชื่อผู้ใช้หรือรหัสนักศึกษาปรากฏ
```

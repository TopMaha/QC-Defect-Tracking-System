# QC Defect Tracking System
### ระบบรายงานและติดตามปัญหาคุณภาพชิ้นงาน (Before / After)

เว็บแอป **PWA** สำหรับโรงงาน เพื่อ **แจ้ง → ติดตาม → ปิด** ปัญหาคุณภาพของชิ้นงาน ด้วยรูป Before/After
หัวใจของระบบคือหน้า **QC Monitor** ที่เปิดค้างบนจอคอม คอยเฝ้าดูงานที่ยังไม่ปิด เพื่อ *กันลืม / กันตกหล่น*

- **Frontend:** HTML + CSS + Vanilla JS (SPA, ติดตั้งเป็นแอปได้, รองรับ Light/Dark, ภาษาไทยทั้งหมด)
- **Backend:** Cloudflare **Workers**
- **ฐานข้อมูล:** Cloudflare **D1** (SQLite)
- **รูปภาพ:** Cloudflare **R2** (รูป Before/After/รูปเปรียบเทียบ)
- **แจ้งเตือน:** **LINE Messaging API** (Official Account — *ไม่ใช้ LINE Notify ที่ปิดบริการแล้ว มี.ค. 2025*)

> 💡 **โหมดสาธิต (Demo):** เปิด `public/index.html` ผ่านเว็บเซิร์ฟเวอร์ได้ทันที โดยไม่ต้องมี backend
> ระบบจะจำลองข้อมูลใน `localStorage` ลองล็อกอินด้วย `admin` / `qc01` / `op01`
> เมื่อ deploy แล้ว ค่อยใส่ URL ของ Worker ใน `public/config.js`

---

## 📁 โครงสร้างไฟล์

```
qc-defect/
├─ worker.js          # Cloudflare Worker: REST API + R2 + LINE webhook/push + cron
├─ schema.sql         # โครงสร้างฐานข้อมูล D1
├─ wrangler.toml      # คอนฟิก Cloudflare (D1 + R2 binding + assets)
├─ package.json       # สคริปต์ deploy
└─ public/            # หน้าเว็บ (เสิร์ฟผ่าน Worker assets)
   ├─ index.html
   ├─ styles.css
   ├─ app.js          # ลอจิก SPA ทั้งหมด (มี demo backend ในตัว)
   ├─ config.js       # ตั้งค่า apiBase (ปล่อยว่าง = โหมดสาธิต)
   ├─ manifest.json   # PWA
   ├─ sw.js           # Service worker (offline shell)
   └─ icon.svg
```

---

## 🗄️ โครงสร้างฐานข้อมูล (D1)

| ตาราง | หน้าที่ |
|---|---|
| `users` | รายชื่อ whitelist + สิทธิ์ (`qc_lead` / `qc` / `staff`) + `line_user_id` สำหรับ @mention |
| `defect_categories` | ประเภทปัญหาคุณภาพ (เพิ่ม/แก้/ลบได้โดยหัวหน้า QC) |
| `defects` | รายการปัญหา (NCR) — ข้อมูลชิ้นงาน, รูป Before/After/เปรียบเทียบ, สถานะ, ผู้เกี่ยวข้อง, due date |
| `defect_logs` | audit trail + comment ทุกขั้นตอน (ใครแจ้ง/แก้/ปิด + เวลา) |
| `line_groups` | Group ID ที่ดักได้จาก webhook (ไว้เลือกกลุ่มปลายทาง) |
| `line_members` | mapping LINE userId → ชื่อ (ไว้ map สำหรับ @mention) |
| `app_settings` | ค่าตั้งระบบ (เกณฑ์ aging, กลุ่ม LINE ปลายทาง) |

> หมายเหตุเรื่องชื่อตาราง: สเปกระบุ `line_config` — ในระบบนี้แยกเป็น `line_groups` + `line_members` + `app_settings`
> เพื่อรองรับหลายกลุ่ม/หลาย user และเก็บค่าตั้งอื่น ๆ ในที่เดียว (ครอบคลุมหน้าที่ของ `line_config` ครบถ้วน)

สถานะงาน (Kanban): `open` (รอแก้ไข) → `in_progress` (กำลังแก้ไข) → `pending_qc` (รอ QC ตรวจ) → `closed` (ปิดงาน)

---

## 🚀 ขั้นตอน Deploy บน Cloudflare

### 0) เตรียม
```bash
npm install            # ติดตั้ง wrangler
npx wrangler login     # ล็อกอิน Cloudflare
```

### 1) สร้าง D1
```bash
npx wrangler d1 create qc_defect
```
คัดลอก `database_id` ที่ได้ ไปวางใน `wrangler.toml` (`PUT-YOUR-D1-DATABASE-ID-HERE`)

สร้างตาราง + ข้อมูลตั้งต้น:
```bash
npm run db:init        # = wrangler d1 execute qc_defect --file=./schema.sql --remote
```

### 2) สร้าง R2 bucket
```bash
npx wrangler r2 bucket create qc-defect-images
```
(ชื่อ bucket ต้องตรงกับใน `wrangler.toml` → `bucket_name`)

### 3) ตั้ง Secret ของ LINE (ไม่ hardcode token ในโค้ด)
```bash
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put LINE_CHANNEL_SECRET        # ไว้ verify signature ของ webhook
```

### 4) Deploy
```bash
npm run deploy         # = wrangler deploy
```
จะได้ URL เช่น `https://qc-defect.<subdomain>.workers.dev`
หน้าเว็บ (จาก `public/`) ถูกเสิร์ฟจาก Worker เดียวกัน → เปิด URL นั้นได้เลย

> ถ้าจะ host หน้าเว็บแยก (เช่น GitHub Pages) ให้แก้ `public/config.js`:
> ```js
> window.QC_CONFIG = { apiBase: "https://qc-defect.<subdomain>.workers.dev" };
> ```

### 5) (แนะนำ) เปิด Cron แจ้งเตือนงานเกินกำหนดอัตโนมัติ
เพิ่มใน `wrangler.toml` แล้ว deploy ใหม่:
```toml
[triggers]
crons = ["0 * * * *"]   # ทุกชั่วโมง — push เตือนงานค้าง/เกินกำหนดเข้า LINE
```

---

## 💬 ตั้งค่า LINE Messaging API

### A) สร้าง Official Account + Channel
1. ไปที่ [LINE Developers Console](https://developers.line.biz/) → สร้าง **Provider**
2. สร้าง **Messaging API channel** (ระบบจะสร้าง LINE Official Account ให้)
3. แท็บ **Messaging API**:
   - **Channel access token (long-lived)** → กด *Issue* → คัดลอกไปตั้งเป็น secret `LINE_CHANNEL_ACCESS_TOKEN` (ข้อ 3 ด้านบน)
   - ปิด *Auto-reply* / *Greeting* ได้ตามต้องการ
4. แท็บ **Basic settings** → คัดลอก **Channel secret** → ตั้งเป็น `LINE_CHANNEL_SECRET`

### B) ตั้ง Webhook
1. แท็บ **Messaging API → Webhook settings**
2. ใส่ **Webhook URL** = `https://qc-defect.<subdomain>.workers.dev/api/line/webhook`
3. เปิด **Use webhook** = ON
4. เปิดสิทธิ์ให้บอทเข้ากลุ่มได้: **Allow bot to join group chats** = ON (อยู่ใน Console หรือ OA Manager → Settings)

### C) เชิญบอทเข้ากลุ่ม + ดัก Group ID อัตโนมัติ
1. เพิ่มเพื่อน Official Account นี้ แล้ว **เชิญเข้ากลุ่ม LINE** ที่ต้องการให้ส่งรายงาน
2. ทันทีที่บอทเข้ากลุ่ม (event `join`) หรือมีใครพิมพ์ข้อความในกลุ่ม (event `message`)
   → Worker จะ **บันทึก Group ID ลง D1 อัตโนมัติ** (ตาราง `line_groups`)
   พร้อมดึงชื่อกลุ่ม และเก็บ `userId`+ชื่อ ของคนที่พิมพ์ (ตาราง `line_members`) ไว้ทำ @mention
3. เข้าแอป → **ตั้งค่า → เชื่อมต่อ LINE** → เลือกกลุ่มปลายทางจาก dropdown → กด *บันทึกกลุ่ม*
4. กด **📨 ทดสอบส่งข้อความ** เพื่อยืนยันว่า token + groupId ถูกต้อง

### D) การใช้ @mention
- ในหน้าตั้งค่า **ผู้ใช้งาน** ใส่ `LINE userId` ให้แต่ละคน (ดูรายชื่อที่ดักได้จาก `line_members`)
- เมื่อกด **💬 ส่งเข้า LINE** จากรายการปัญหา ระบบจะ push ข้อความ + รูปเปรียบเทียบ Before/After
  และ @mention ผู้รับผิดชอบให้อัตโนมัติ (ถ้ามี `line_user_id`)

---

## 🔑 สิทธิ์ผู้ใช้ (Roles)

| Role | แจ้งปัญหา | ส่ง After | มอบหมาย | ปิด/ตีกลับงาน | ตั้งค่าระบบ |
|---|:--:|:--:|:--:|:--:|:--:|
| `staff` (ฝ่ายผลิต) | ✅ | ✅ | – | – | – |
| `qc` (QC) | ✅ | ✅ | ✅ | ✅ | – |
| `qc_lead` (หัวหน้า QC) | ✅ | ✅ | ✅ | ✅ | ✅ |

การยืนยันตัวตนใช้รหัสพนักงาน (whitelist) ส่งผ่าน header `x-emp-code`; Worker ตรวจสิทธิ์ฝั่งเซิร์ฟเวอร์ทุก action ที่ต้องการสิทธิ์

---

## 🔌 REST API (สรุป)

| Method & Path | หน้าที่ | สิทธิ์ |
|---|---|---|
| `POST /api/login` | ตรวจ whitelist | ทุกคน |
| `GET /api/bootstrap` | โหลด users/categories/settings/lineGroups | – |
| `GET /api/defects` | รายการทั้งหมด (join ชื่อ) | – |
| `POST /api/defects` | แจ้งปัญหา + อัปโหลดรูป Before | login |
| `GET /api/defects/:id` | รายละเอียด + logs | – |
| `POST /api/defects/:id/start` | เริ่มแก้ไข → in_progress | login |
| `POST /api/defects/:id/after` | ส่ง After + รูปเปรียบเทียบ → pending_qc | login |
| `POST /api/defects/:id/close` | อนุมัติ/ปิดงาน | qc, qc_lead |
| `POST /api/defects/:id/reopen` | ตีกลับ → open | qc, qc_lead |
| `POST /api/defects/:id/assign` | มอบหมาย/แก้ไข due/priority | qc, qc_lead |
| `POST /api/defects/:id/comment` | เพิ่มหมายเหตุ | login |
| `GET/POST/PUT/DELETE /api/categories` | จัดการประเภท | qc_lead |
| `GET/POST/PUT/DELETE /api/users` | จัดการผู้ใช้ | qc_lead |
| `POST /api/settings` | บันทึกค่าตั้ง (aging, กลุ่ม LINE) | qc_lead |
| `POST /api/line/test` | ทดสอบส่งข้อความ | qc, qc_lead |
| `POST /api/line/send/:id` | ส่งรายงาน + รูป + @mention เข้า LINE | qc, qc_lead |
| `POST /api/line/webhook` | รับ event (join/message) ดัก groupId/userId | LINE |
| `GET /img/:key` | เสิร์ฟรูปจาก R2 | – |

---

## ✨ ฟีเจอร์ตามสเปก (เช็คลิสต์)

- ✅ QC Monitor: Kanban 4 คอลัมน์, auto-refresh 8 วิ, สรุปตัวเลขใหญ่, aging เขียว→เหลือง→แดง, ป้าย Overdue, **TV/Fullscreen mode**
- ✅ แจ้งปัญหา (มือถือ): ฟอร์ม + กล้อง, **บีบอัดรูปก่อนอัปโหลด**, NCR No. รันอัตโนมัติ
- ✅ ส่ง After → **รวม Before/After เป็นรูปเดียวด้วย Canvas** (ป้าย + ชื่อชิ้นงาน + ประเภท + วันที่) → เก็บ R2
- ✅ QC ตรวจ → อนุมัติ/ปิด หรือ **ตีกลับพร้อมหมายเหตุ** + audit trail ครบทุกขั้น
- ✅ รายงาน (จอใหญ่): ตารางเต็ม + รูป Before/After ทุกแถว, กราฟสรุป, ค้นหา/กรองหลายเงื่อนไข, **Export CSV (Excel) + Print/PDF**
- ✅ Login whitelist + 3 สิทธิ์, ฟอร์ม animated (staggered/floating label/glow), จอใหญ่แบ่งทแยงมุม
- ✅ ตั้งค่า (หัวหน้า QC): ผู้ใช้, ประเภทปัญหา, เกณฑ์ aging, LINE
- ✅ LINE Messaging API: webhook ดัก group/user, push รายงาน + รูป + @mention, ปุ่มทดสอบ, cron เตือนงานเกินกำหนด
- ✅ UI: ฟ้า/ขาว/ดำ, Light/Dark จำค่า, Magic floating nav (indicator เลื่อนลื่น, active เด้งลอย), page/modal/toast transitions, ภาษาไทยทั้งหมด, PWA ติดตั้งได้

---

## 🧪 ลองในเครื่อง (โหมดสาธิต)
```bash
cd qc-defect
npx http-server ./public -p 4178
# เปิด http://localhost:4178  → ล็อกอิน admin / qc01 / op01
```
หรือใช้ `npx wrangler dev` เพื่อรันพร้อม D1/R2 จริงในเครื่อง

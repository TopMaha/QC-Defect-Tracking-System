-- ============================================================
-- QC Defect Tracking System — Cloudflare D1 schema
-- Apply:  wrangler d1 execute qc_defect --file=./schema.sql
-- ============================================================

PRAGMA foreign_keys = ON;

-- ---------- ผู้ใช้งาน (whitelist + สิทธิ์) ----------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  emp_code      TEXT NOT NULL UNIQUE,          -- รหัสพนักงาน (ใช้ login)
  name          TEXT NOT NULL,                 -- ชื่อแสดงผล
  role          TEXT NOT NULL DEFAULT 'staff', -- qc_lead | qc | staff
  line_user_id  TEXT,                          -- สำหรับ @mention (ดักจาก webhook)
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- ประเภทปัญหาคุณภาพ ----------
CREATE TABLE IF NOT EXISTS defect_categories (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL,
  sort      INTEGER NOT NULL DEFAULT 0,
  active    INTEGER NOT NULL DEFAULT 1
);

-- ---------- รายการปัญหา (NCR) ----------
CREATE TABLE IF NOT EXISTS defects (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ncr_no        TEXT NOT NULL UNIQUE,          -- NCR-YYMM-#### (รันอัตโนมัติ)
  category_id   INTEGER REFERENCES defect_categories(id),
  part_name     TEXT,                          -- ชื่อชิ้นงาน
  part_no       TEXT,                          -- Part No.
  lot_no        TEXT,                          -- Lot / Job No.
  qty_defect    INTEGER DEFAULT 0,             -- จำนวนของเสีย
  symptom       TEXT,                          -- อาการ/ลักษณะปัญหา
  cause         TEXT,                          -- สาเหตุ (ถ้ารู้)
  disposition   TEXT,                          -- rework | scrap | use_as_is
  priority      TEXT NOT NULL DEFAULT 'normal',-- low | normal | high | urgent
  status        TEXT NOT NULL DEFAULT 'open',  -- open | in_progress | pending_qc | closed
  before_img    TEXT,                          -- R2 key รูป Before
  after_img     TEXT,                          -- R2 key รูป After
  compare_img   TEXT,                          -- R2 key รูปเปรียบเทียบ (รวมแล้ว)
  reporter_id   INTEGER REFERENCES users(id),  -- ผู้แจ้ง
  assignee_id   INTEGER REFERENCES users(id),  -- ผู้รับผิดชอบแก้ไข
  due_at        TEXT,                          -- วันครบกำหนด
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at     TEXT,
  closed_by     INTEGER REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_defects_status   ON defects(status);
CREATE INDEX IF NOT EXISTS idx_defects_assignee ON defects(assignee_id);
CREATE INDEX IF NOT EXISTS idx_defects_created  ON defects(created_at);

-- ---------- บันทึก audit trail / comment ----------
CREATE TABLE IF NOT EXISTS defect_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  defect_id   INTEGER NOT NULL REFERENCES defects(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id),
  action      TEXT NOT NULL,   -- created|assigned|started|after_submitted|closed|reopened|comment|line_sent
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_logs_defect ON defect_logs(defect_id);

-- ---------- กลุ่ม LINE ที่ดักได้จาก webhook ----------
CREATE TABLE IF NOT EXISTS line_groups (
  group_id     TEXT PRIMARY KEY,
  group_name   TEXT,
  captured_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- สมาชิก LINE ที่ดักได้ (ไว้ map ชื่อ -> userId สำหรับ @mention) ----------
CREATE TABLE IF NOT EXISTS line_members (
  line_user_id  TEXT PRIMARY KEY,
  display_name  TEXT,
  captured_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- ตั้งค่าระบบ (key-value) ----------
CREATE TABLE IF NOT EXISTS app_settings (
  key    TEXT PRIMARY KEY,
  value  TEXT
);

-- ============================================================
-- ค่าเริ่มต้น
-- ============================================================
INSERT OR IGNORE INTO users (emp_code, name, role) VALUES
  ('admin', 'หัวหน้า QC', 'qc_lead'),
  ('qc01',  'สมชาย (QC)', 'qc'),
  ('op01',  'สมหญิง (ฝ่ายผลิต)', 'staff');

INSERT OR IGNORE INTO defect_categories (id, name, sort) VALUES
  (1, 'มิติ/ขนาดไม่ได้', 1),
  (2, 'ผิวงาน/ตำหนิ', 2),
  (3, 'การประกอบ', 3),
  (4, 'วัสดุ', 4),
  (5, 'ฟังก์ชันใช้งาน', 5);

INSERT OR IGNORE INTO app_settings (key, value) VALUES
  ('aging_warn_hours', '24'),   -- เขียว -> เหลือง เมื่อค้างเกิน (ชม.)
  ('aging_crit_hours', '48'),   -- เหลือง -> แดง เมื่อค้างเกิน (ชม.)
  ('line_group_id', ''),
  ('line_group_name', '');

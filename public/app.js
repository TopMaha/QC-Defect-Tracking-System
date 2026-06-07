/* ============================================================
   QC Defect Tracking System — frontend app (vanilla JS, SPA)
   ทำงานได้ทั้งโหมดสาธิต (Demo, localStorage) และโหมดจริง (Cloudflare Worker)
   ============================================================ */
(() => {
'use strict';

const CFG = window.QC_CONFIG || {};
const RAW = (CFG.apiBase || '').trim();
// โหมดสาธิต: ตั้ง apiBase = "demo" ชัดเจน หรือเปิดไฟล์ตรง ๆ แบบ file:// (ไม่มี backend)
const DEMO = RAW === 'demo' || (RAW === '' && location.protocol === 'file:');
// API_BASE = "" หมายถึง same-origin (กรณีเสิร์ฟจาก Worker เดียวกัน), หรือใส่ URL Worker เต็ม
const API_BASE = DEMO ? '' : RAW.replace(/\/$/, '');

/* ---------------- state ---------------- */
const state = {
  user: null, page: 'monitor',
  defects: [], users: [], categories: [], settings: {}, lineGroups: [], lineMembers: [],
  filters: {}, refreshTimer: null,
};

const ROLE_TH = { qc_lead: 'หัวหน้า QC', qc: 'QC', staff: 'ฝ่ายผลิต' };
const STATUS = { open: 'รอแก้ไข', in_progress: 'กำลังแก้ไข', pending_qc: 'รอ QC ตรวจ', closed: 'ปิดงาน' };
const PRIO = { low: 'ต่ำ', normal: 'ปกติ', high: 'สูง', urgent: 'ด่วนมาก' };
const DISP = { rework: 'Rework (แก้ไข)', scrap: 'Scrap (ทิ้ง)', use_as_is: 'Use-as-is (ใช้ได้)' };

/* ---------------- tiny helpers ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = n => (n || '?').trim().slice(0, 2);
function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + type; t.textContent = msg;
  $('#toasts').appendChild(t); setTimeout(() => t.remove(), 3100);
}
function fmtDate(iso, withTime = true) {
  if (!iso) return '-';
  const d = new Date(iso);
  const s = d.toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: '2-digit' });
  return withTime ? s + ' ' + d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : s;
}
function hoursSince(iso) { return (Date.now() - new Date(iso).getTime()) / 36e5; }
function imgUrl(v) {
  if (!v) return null;
  if (v.startsWith('data:') || v.startsWith('http')) return v;
  return (API_BASE || '') + '/img/' + v;
}
function ageClass(d) {
  if (d.status === 'closed') return 'age-g';
  const h = hoursSince(d.created_at);
  const warn = +state.settings.aging_warn_hours || 24;
  const crit = +state.settings.aging_crit_hours || 48;
  return h > crit ? 'age-r' : h > warn ? 'age-y' : 'age-g';
}
function ageText(d) {
  const h = hoursSince(d.created_at);
  if (h < 24) return Math.max(0, Math.round(h)) + ' ชม.';
  return Math.round(h / 24) + ' วัน';
}
function isOverdue(d) { return d.status !== 'closed' && d.due_at && new Date(d.due_at) < new Date(); }

/* ============================================================
   API layer
   ============================================================ */
async function api(path, { method = 'GET', body } = {}) {
  if (DEMO) return demoApi(path, method, body);
  const res = await fetch(API_BASE + '/api' + path, {
    method,
    headers: { 'content-type': 'application/json', ...(state.user ? { 'x-emp-code': state.user.emp_code } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

/* ============================================================
   DEMO backend (localStorage) — สะท้อน worker.js
   ============================================================ */
const DB_KEY = 'qc_demo_v1';
function svgImg(label, c1, c2) {
  const s = `<svg xmlns='http://www.w3.org/2000/svg' width='400' height='300'>
    <rect width='400' height='300' fill='${c1}'/>
    <circle cx='200' cy='150' r='70' fill='${c2}' opacity='.55'/>
    <text x='200' y='160' font-family='sans-serif' font-size='34' fill='#fff' text-anchor='middle' font-weight='bold'>${label}</text>
  </svg>`;
  return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(s)));
}
function seed() {
  const now = Date.now(), h = 36e5;
  const mk = (o) => Object.assign({ qty_defect: 1, priority: 'normal', logs: [] }, o);
  return {
    users: [
      { id: 1, emp_code: 'admin', name: 'หัวหน้า QC', role: 'qc_lead', line_user_id: null, active: 1 },
      { id: 2, emp_code: 'qc01', name: 'สมชาย (QC)', role: 'qc', line_user_id: null, active: 1 },
      { id: 3, emp_code: 'op01', name: 'สมหญิง (ฝ่ายผลิต)', role: 'staff', line_user_id: null, active: 1 },
      { id: 4, emp_code: 'op02', name: 'ประยุทธ (ช่างแก้ไข)', role: 'staff', line_user_id: null, active: 1 },
    ],
    categories: [
      { id: 1, name: 'มิติ/ขนาดไม่ได้', sort: 1, active: 1 },
      { id: 2, name: 'ผิวงาน/ตำหนิ', sort: 2, active: 1 },
      { id: 3, name: 'การประกอบ', sort: 3, active: 1 },
      { id: 4, name: 'วัสดุ', sort: 4, active: 1 },
      { id: 5, name: 'ฟังก์ชันใช้งาน', sort: 5, active: 1 },
    ],
    settings: { aging_warn_hours: '24', aging_crit_hours: '48', line_group_id: '', line_group_name: '' },
    lineGroups: [], lineMembers: [],
    seq: 5,
    defects: [
      mk({ id: 1, ncr_no: 'NCR-' + ym() + '-0001', category_id: 1, part_name: 'เพลาขับ', part_no: 'SH-1024', lot_no: 'L2406A', qty_defect: 5, symptom: 'เส้นผ่านศูนย์กลางเกิน +0.05mm', cause: 'ดอกกัดสึก', disposition: 'rework', priority: 'high', status: 'open', before_img: svgImg('BEFORE', '#b91c1c', '#7f1d1d'), reporter_id: 3, assignee_id: 4, due_at: new Date(now - 6 * h).toISOString(), created_at: new Date(now - 60 * h).toISOString(), updated_at: new Date(now - 60 * h).toISOString(), logs: [{ action: 'created', user_id: 3, note: 'แจ้งปัญหา', created_at: new Date(now - 60 * h).toISOString() }] }),
      mk({ id: 2, ncr_no: 'NCR-' + ym() + '-0002', category_id: 2, part_name: 'ฝาครอบ', part_no: 'CV-330', lot_no: 'L2406B', qty_defect: 12, symptom: 'ผิวเป็นรอยขีดข่วน', disposition: 'rework', status: 'in_progress', before_img: svgImg('BEFORE', '#b91c1c', '#7f1d1d'), reporter_id: 3, assignee_id: 4, due_at: new Date(now + 18 * h).toISOString(), created_at: new Date(now - 30 * h).toISOString(), updated_at: new Date(now - 5 * h).toISOString(), logs: [{ action: 'created', user_id: 3, created_at: new Date(now - 30 * h).toISOString() }, { action: 'started', user_id: 4, note: 'เริ่มขัดผิว', created_at: new Date(now - 5 * h).toISOString() }] }),
      mk({ id: 3, ncr_no: 'NCR-' + ym() + '-0003', category_id: 3, part_name: 'ชุดเฟือง', part_no: 'GR-77', lot_no: 'L2406B', qty_defect: 2, symptom: 'ประกอบไม่แน่น มีระยะคลอน', disposition: 'rework', status: 'pending_qc', before_img: svgImg('BEFORE', '#b91c1c', '#7f1d1d'), after_img: svgImg('AFTER', '#15803d', '#166534'), reporter_id: 3, assignee_id: 4, due_at: new Date(now + 5 * h).toISOString(), created_at: new Date(now - 14 * h).toISOString(), updated_at: new Date(now - 1 * h).toISOString(), logs: [{ action: 'created', user_id: 3, created_at: new Date(now - 14 * h).toISOString() }, { action: 'after_submitted', user_id: 4, note: 'แก้ไขเสร็จ', created_at: new Date(now - 1 * h).toISOString() }] }),
      mk({ id: 4, ncr_no: 'NCR-' + ym() + '-0004', category_id: 5, part_name: 'สวิตช์', part_no: 'SW-12', lot_no: 'L2405Z', qty_defect: 8, symptom: 'กดแล้วไม่ติด', disposition: 'scrap', status: 'closed', before_img: svgImg('BEFORE', '#b91c1c', '#7f1d1d'), after_img: svgImg('AFTER', '#15803d', '#166534'), reporter_id: 3, assignee_id: 4, created_at: new Date(now - 90 * h).toISOString(), updated_at: new Date(now - 70 * h).toISOString(), closed_at: new Date(now - 70 * h).toISOString(), closed_by: 2, logs: [{ action: 'created', user_id: 3, created_at: new Date(now - 90 * h).toISOString() }, { action: 'closed', user_id: 2, note: 'ตรวจผ่าน', created_at: new Date(now - 70 * h).toISOString() }] }),
    ],
  };
}
function ym() { return new Date().toISOString().slice(2, 7).replace('-', ''); }
function dbLoad() { try { return JSON.parse(localStorage.getItem(DB_KEY)) || seed(); } catch { return seed(); } }
function dbSave(db) { try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch {} }

async function demoApi(path, method, body) {
  await new Promise(r => setTimeout(r, 120)); // จำลอง latency
  const db = dbLoad();
  const seg = path.split('?')[0].split('/').filter(Boolean);
  const enrich = d => {
    const u = id => (db.users.find(x => x.id === id) || {}).name;
    return { ...d, category_name: (db.categories.find(c => c.id === d.category_id) || {}).name,
      reporter_name: u(d.reporter_id), assignee_name: u(d.assignee_id), closed_by_name: u(d.closed_by) };
  };
  const save = () => dbSave(db);

  if (path === '/login') {
    const u = db.users.find(x => x.emp_code === (body.emp_code || '').trim() && x.active);
    if (!u) throw new Error('ไม่พบรหัสพนักงานนี้ในระบบ');
    return { user: u };
  }
  if (path === '/bootstrap')
    return { users: db.users.filter(u => u.active), categories: db.categories.filter(c => c.active), settings: db.settings, lineGroups: db.lineGroups };

  if (seg[0] === 'defects') {
    if (seg.length === 1 && method === 'GET') return { defects: db.defects.map(enrich).sort((a, b) => b.created_at < a.created_at ? -1 : 1) };
    if (seg.length === 1 && method === 'POST') {
      const id = ++db.seq;
      const ncr = 'NCR-' + ym() + '-' + String(db.defects.filter(d => d.ncr_no.includes(ym())).length + 1).padStart(4, '0');
      const d = { id, ncr_no: ncr, ...body, before_img: body.before_image || null, status: 'open',
        reporter_id: state.user.id, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        logs: [{ action: 'created', user_id: state.user.id, note: 'แจ้งปัญหา ' + ncr, created_at: new Date().toISOString() }] };
      delete d.before_image; db.defects.push(d); save();
      return { ok: true, id, ncr_no: ncr };
    }
    const id = +seg[1]; const d = db.defects.find(x => x.id === id);
    if (!d) throw new Error('not found');
    if (seg.length === 2 && method === 'GET')
      return { defect: enrich(d), logs: (d.logs || []).map(l => ({ ...l, user_name: (db.users.find(u => u.id === l.user_id) || {}).name })) };
    const log = (action, note) => { (d.logs = d.logs || []).push({ action, note, user_id: state.user.id, created_at: new Date().toISOString() }); d.updated_at = new Date().toISOString(); };
    const act = seg[2];
    if (act === 'start') { d.status = 'in_progress'; log('started', body.note); save(); return { ok: true }; }
    if (act === 'after') { if (body.after_image) d.after_img = body.after_image; if (body.compare_image) d.compare_img = body.compare_image; d.status = 'pending_qc'; log('after_submitted', body.note || 'ส่งงานแก้ไข (After)'); save(); return { ok: true }; }
    if (act === 'close') { d.status = 'closed'; d.closed_at = new Date().toISOString(); d.closed_by = state.user.id; log('closed', body.note); save(); return { ok: true }; }
    if (act === 'reopen') { d.status = 'open'; d.closed_at = null; d.closed_by = null; log('reopened', body.note); save(); return { ok: true }; }
    if (act === 'comment') { log('comment', body.note); save(); return { ok: true }; }
    if (act === 'assign') { d.assignee_id = body.assignee_id; d.due_at = body.due_at; d.priority = body.priority || 'normal'; log('assigned', body.note); save(); return { ok: true }; }
    if (act === 'compare') { d.compare_img = body.image; save(); return { ok: true }; }
  }
  if (seg[0] === 'categories') {
    if (method === 'GET') return { categories: db.categories };
    if (method === 'POST') { db.categories.push({ id: ++db.seq, name: body.name, sort: +body.sort || 0, active: 1 }); save(); return { ok: true }; }
    const id = +seg[1]; const c = db.categories.find(x => x.id === id);
    if (method === 'PUT') { Object.assign(c, { name: body.name, sort: +body.sort || 0, active: body.active ?? 1 }); save(); return { ok: true }; }
    if (method === 'DELETE') { c.active = 0; save(); return { ok: true }; }
  }
  if (seg[0] === 'users') {
    if (method === 'GET') return { users: db.users };
    if (method === 'POST') { db.users.push({ id: ++db.seq, emp_code: body.emp_code, name: body.name, role: body.role, line_user_id: body.line_user_id || null, active: 1 }); save(); return { ok: true }; }
    const id = +seg[1]; const u = db.users.find(x => x.id === id);
    if (method === 'PUT') { Object.assign(u, { name: body.name, role: body.role, line_user_id: body.line_user_id || null, active: body.active ?? 1 }); save(); return { ok: true }; }
    if (method === 'DELETE') { u.active = 0; save(); return { ok: true }; }
  }
  if (path === '/settings' && method === 'POST') { Object.assign(db.settings, body); save(); return { ok: true }; }
  if (seg[0] === 'line') {
    if (seg[1] === 'members') return { members: db.lineMembers };
    return { ok: false, error: 'โหมดสาธิต: ไม่ได้เชื่อมต่อ LINE จริง (ต้อง deploy Worker + ตั้ง token)' };
  }
  throw new Error('demo route not found: ' + path);
}

/* ============================================================
   image utilities
   ============================================================ */
function pickImage() {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*'; inp.capture = 'environment';
    inp.onchange = () => {
      const f = inp.files[0]; if (!f) return resolve(null);
      const fr = new FileReader();
      fr.onload = () => {
        const im = new Image();
        im.onload = () => {
          const max = 1280, sc = Math.min(1, max / Math.max(im.width, im.height));
          const cv = document.createElement('canvas');
          cv.width = im.width * sc; cv.height = im.height * sc;
          cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height);
          resolve(cv.toDataURL('image/jpeg', 0.82));
        };
        im.src = fr.result;
      };
      fr.readAsDataURL(f);
    };
    inp.click();
  });
}
const loadImg = src => new Promise((res, rej) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = rej; i.src = src; });

/* รวมรูป Before|After เป็นรูปเดียว + ป้ายกำกับ (เก็บลง R2 / demo) */
async function mergeBeforeAfter(beforeSrc, afterSrc, meta) {
  const W = 1000, gap = 14, head = 96, cap = 40, half = (W - gap) / 2, imgH = 420;
  const H = head + imgH + cap;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const x = cv.getContext('2d');
  x.fillStyle = '#0f172a'; x.fillRect(0, 0, W, H);
  // header
  x.fillStyle = '#1d4ed8'; x.fillRect(0, 0, W, head);
  x.fillStyle = '#fff'; x.font = 'bold 30px Sarabun,sans-serif';
  x.fillText(meta.ncr_no || '', 20, 38);
  x.font = '20px Sarabun,sans-serif';
  x.fillText(`${meta.part_name || ''}  ·  ${meta.category_name || ''}  ·  ${fmtDate(new Date().toISOString(), false)}`, 20, 72);
  const drawHalf = async (src, dx, label, color) => {
    x.fillStyle = '#1e293b'; x.fillRect(dx, head, half, imgH);
    if (src) { try { const im = await loadImg(src); const r = Math.min(half / im.width, imgH / im.height); const w = im.width * r, h = im.height * r; x.drawImage(im, dx + (half - w) / 2, head + (imgH - h) / 2, w, h); } catch {} }
    x.fillStyle = color; x.fillRect(dx, head + imgH, half, cap);
    x.fillStyle = '#fff'; x.font = 'bold 22px Sarabun,sans-serif'; x.textAlign = 'center';
    x.fillText(label, dx + half / 2, head + imgH + 28); x.textAlign = 'left';
  };
  await drawHalf(beforeSrc, 0, 'BEFORE (ก่อนแก้ไข)', '#b91c1c');
  await drawHalf(afterSrc, half + gap, 'AFTER (หลังแก้ไข)', '#15803d');
  return cv.toDataURL('image/jpeg', 0.85);
}

/* ============================================================
   auth + shell
   ============================================================ */
async function init() {
  // theme
  const th = localStorage.getItem('qc_theme') || 'light';
  document.documentElement.dataset.theme = th;
  $('#themeBtn').textContent = th === 'dark' ? '☀️' : '🌙';
  if (!DEMO) $('#loginHint').classList.add('hidden');

  $('#loginForm').addEventListener('submit', onLogin);
  $('#themeBtn').onclick = toggleTheme;
  $('#logoutBtn').onclick = logout;
  $('#fullBtn').onclick = () => enterTV();
  $('#tvExit').onclick = exitTV;

  const saved = localStorage.getItem('qc_user');
  if (saved) { try { state.user = JSON.parse(saved); await enterApp(); } catch { localStorage.removeItem('qc_user'); } }
}
async function onLogin(e) {
  e.preventDefault();
  const code = $('#empCode').value.trim();
  if (!code) return;
  try {
    const { user } = await api('/login', { method: 'POST', body: { emp_code: code } });
    state.user = user; localStorage.setItem('qc_user', JSON.stringify(user));
    await enterApp();
    toast('ยินดีต้อนรับ ' + user.name, 'ok');
  } catch (err) { toast(err.message, 'err'); shake($('#empCode')); }
}
function shake(el) { el.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-8px)' }, { transform: 'translateX(8px)' }, { transform: 'translateX(0)' }], { duration: 300 }); }
function logout() { state.user = null; localStorage.removeItem('qc_user'); clearInterval(state.refreshTimer); $('#app').style.display = 'none'; $('#login').style.display = 'flex'; }
function toggleTheme() {
  const n = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = n; localStorage.setItem('qc_theme', n);
  $('#themeBtn').textContent = n === 'dark' ? '☀️' : '🌙';
}

async function enterApp() {
  $('#login').style.display = 'none';
  $('#app').style.display = 'block';
  renderWho(); buildNav();
  await refreshData();
  go(state.page);
  // auto-refresh
  clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(async () => {
    if (document.hidden) return;
    await refreshData();
    if (state.page === 'monitor') renderMonitor();
  }, 8000);
}
function renderWho() {
  const u = state.user;
  $('#whoBox').innerHTML = `<div class="av">${esc(initials(u.name))}</div>
    <div><div class="nm">${esc(u.name)}</div><div class="rl">${ROLE_TH[u.role] || u.role}</div></div>`;
}
async function refreshData() {
  try {
    const [boot, defs] = await Promise.all([api('/bootstrap'), api('/defects')]);
    state.users = boot.users; state.categories = boot.categories; state.settings = boot.settings;
    state.lineGroups = boot.lineGroups || []; state.defects = defs.defects;
  } catch (err) { toast('โหลดข้อมูลล้มเหลว: ' + err.message, 'err'); }
}

/* ---------------- navigation ---------------- */
const NAV = [
  { id: 'monitor', icon: '🖥️', label: 'MONITOR' },
  { id: 'list', icon: '🗂️', label: 'รายการ' },
  { id: 'new', icon: '📷', label: 'แจ้งปัญหา' },
  { id: 'report', icon: '📊', label: 'รายงาน' },
  { id: 'settings', icon: '⚙️', label: 'ตั้งค่า', role: ['qc_lead'] },
];
function buildNav() {
  const nav = $('#nav');
  nav.querySelectorAll('button').forEach(b => b.remove());
  NAV.filter(n => !n.role || n.role.includes(state.user.role)).forEach(n => {
    const b = document.createElement('button');
    b.dataset.page = n.id;
    b.innerHTML = `<span style="font-size:20px">${n.icon}</span><span class="lbl">${n.label}</span>`;
    b.onclick = () => go(n.id);
    nav.appendChild(b);
  });
}
function go(page) {
  if (page === 'settings' && state.user.role !== 'qc_lead') return;
  state.page = page;
  $$('#nav button').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  moveIndicator();
  const host = $('#page');
  host.classList.remove('page-enter'); void host.offsetWidth; host.classList.add('page-enter');
  ({ monitor: renderMonitor, list: renderList, new: renderNew, report: renderReport, settings: renderSettings }[page] || renderMonitor)();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function moveIndicator() {
  const ind = $('#navInd'); const act = $('#nav button.active'); if (!act || getComputedStyle(ind).display === 'none') return;
  ind.style.left = (act.offsetLeft + act.offsetWidth / 2 - 25) + 'px';
}

/* ============================================================
   PAGE: MONITOR (Kanban — หัวใจของระบบ)
   ============================================================ */
function summary() {
  const d = state.defects;
  return {
    openAll: d.filter(x => x.status !== 'closed').length,
    pending: d.filter(x => x.status === 'pending_qc').length,
    overdue: d.filter(isOverdue).length,
    closed: d.filter(x => x.status === 'closed').length,
  };
}
function renderMonitor() {
  const s = summary();
  const cols = [
    { k: 'open', cls: 'c-open', t: 'รอแก้ไข' },
    { k: 'in_progress', cls: 'c-prog', t: 'กำลังแก้ไข' },
    { k: 'pending_qc', cls: 'c-qc', t: 'รอ QC ตรวจ' },
    { k: 'closed', cls: 'c-closed', t: 'ปิดงานแล้ว' },
  ];
  const board = cols.map(c => {
    const items = state.defects.filter(d => d.status === c.k)
      .sort((a, b) => (isOverdue(b) - isOverdue(a)) || (new Date(a.created_at) - new Date(b.created_at)));
    return `<div class="col ${c.cls}">
      <h3><span class="dot"></span>${c.t}<span class="cnt">${items.length}</span></h3>
      ${items.map(cardHTML).join('') || '<div class="muted" style="text-align:center;padding:18px;font-size:13px">— ไม่มี —</div>'}
    </div>`;
  }).join('');

  $('#page').innerHTML = `
    <div class="page-head"><h2>🖥️ QC Monitor</h2><span class="muted" style="font-size:13px">อัปเดตอัตโนมัติทุก 8 วินาที</span>
      <span class="sp"></span><button class="btn ghost sm" onclick="QC.go('new')">+ แจ้งปัญหา</button></div>
    <div class="stats">
      <div class="stat s-open"><span class="bar"></span><div class="n">${s.openAll}</div><div class="t">ค้างทั้งหมด</div></div>
      <div class="stat s-pending"><span class="bar"></span><div class="n">${s.pending}</div><div class="t">รอ QC ตรวจ</div></div>
      <div class="stat s-over"><span class="bar"></span><div class="n">${s.overdue}</div><div class="t">เกินกำหนด</div></div>
      <div class="stat s-closed"><span class="bar"></span><div class="n">${s.closed}</div><div class="t">ปิดงานแล้ว</div></div>
    </div>
    <div class="board">${board}</div>`;
  bindCards();
}
function cardHTML(d) {
  const ac = ageClass(d);
  const b = imgUrl(d.before_img), a = imgUrl(d.after_img);
  const th = (src, lbl) => src ? `<div class="th"><img src="${src}" loading="lazy"><span>${lbl}</span></div>` : `<div class="th empty">${lbl}</div>`;
  return `<div class="card ${ac}" data-id="${d.id}">
    <div class="top">
      <span class="ncr">${esc(d.ncr_no)}</span>
      ${isOverdue(d) ? '<span class="overdue-flag">เกินกำหนด</span>' : ''}
      <span class="sp" style="flex:1"></span>
      <span class="age-badge ${ac}">${ageText(d)}</span>
    </div>
    <div class="thumbs">${th(b, 'B')}${th(a, 'A')}</div>
    <div class="ttl">${esc(d.part_name || '-')}</div>
    <div class="muted" style="font-size:12px">${esc(d.category_name || '-')} · ${esc(d.symptom || '')}</div>
    <div class="meta">
      <span class="who2">👤 ${esc(d.assignee_name || 'ยังไม่มอบหมาย')}</span>
      ${d.due_at ? `<span class="who2">📅 ${fmtDate(d.due_at, false)}</span>` : ''}
      ${d.priority && d.priority !== 'normal' ? `<span class="chip" style="background:var(--blue-soft);color:var(--blue)">${PRIO[d.priority]}</span>` : ''}
    </div>
  </div>`;
}
function bindCards() { $$('.card').forEach(c => c.onclick = () => openDetail(+c.dataset.id)); }

/* ============================================================
   PAGE: LIST (รายการปัญหา — การ์ด)
   ============================================================ */
function renderList() {
  const f = state.filters;
  let list = [...state.defects];
  if (f.status) list = list.filter(d => d.status === f.status);
  if (f.q) { const q = f.q.toLowerCase(); list = list.filter(d => (d.ncr_no + d.part_name + d.part_no + (d.symptom || '')).toLowerCase().includes(q)); }
  $('#page').innerHTML = `
    <div class="page-head"><h2>🗂️ รายการปัญหา</h2><span class="sp"></span>
      <button class="btn sm" onclick="QC.go('new')">+ แจ้งปัญหา</button></div>
    <div class="filters">
      <input id="fq" placeholder="🔍 ค้นหา NCR / ชิ้นงาน / อาการ" value="${esc(f.q || '')}">
      <select id="fstatus">
        <option value="">ทุกสถานะ</option>
        ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${f.status === k ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
    </div>
    <div class="board" style="grid-template-columns:repeat(auto-fill,minmax(260px,1fr))">
      ${list.map(cardHTML).join('') || '<div class="muted">ไม่พบรายการ</div>'}
    </div>`;
  $('#fq').oninput = e => { f.q = e.target.value; clearTimeout(f._t); f._t = setTimeout(renderList, 250); };
  $('#fstatus').onchange = e => { f.status = e.target.value; renderList(); };
  bindCards();
}

/* ============================================================
   PAGE: NEW (แจ้งปัญหา — มือถือ + กล้อง)
   ============================================================ */
let newBefore = null;
function renderNew() {
  newBefore = null;
  const cats = state.categories.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  const users = state.users.map(u => `<option value="${u.id}">${esc(u.name)} (${ROLE_TH[u.role]})</option>`).join('');
  $('#page').innerHTML = `
    <div class="page-head"><h2>📷 แจ้งปัญหาคุณภาพ</h2></div>
    <form id="newForm">
      <div class="panel">
        <h3>1. รูปจุดที่เป็นปัญหา (Before)</h3>
        <div class="photo-pick" id="beforePick"><div class="ic">📸</div><div style="margin-top:8px;font-weight:700">แตะเพื่อถ่าย/เลือกรูป</div><div class="muted" style="font-size:12px">บีบอัดอัตโนมัติก่อนอัปโหลด</div></div>
      </div>
      <div class="panel">
        <h3>2. รายละเอียดปัญหา</h3>
        <div class="grid2">
          <div class="inp"><label>ประเภทปัญหา *</label><select name="category_id" required>${cats}</select></div>
          <div class="inp"><label>ความเร่งด่วน</label><select name="priority">${Object.entries(PRIO).map(([k, v]) => `<option value="${k}" ${k === 'normal' ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
          <div class="inp"><label>ชื่อชิ้นงาน *</label><input name="part_name" required></div>
          <div class="inp"><label>Part No.</label><input name="part_no"></div>
          <div class="inp"><label>Lot / Job No.</label><input name="lot_no"></div>
          <div class="inp"><label>จำนวนของเสีย</label><input name="qty_defect" type="number" min="0" value="1"></div>
        </div>
        <div class="inp"><label>อาการ / ลักษณะปัญหา *</label><textarea name="symptom" required></textarea></div>
        <div class="grid2">
          <div class="inp"><label>สาเหตุ (ถ้ารู้)</label><input name="cause"></div>
          <div class="inp"><label>แนวทางจัดการ</label><select name="disposition">${Object.entries(DISP).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
        </div>
      </div>
      <div class="panel">
        <h3>3. มอบหมาย</h3>
        <div class="grid2">
          <div class="inp"><label>ผู้รับผิดชอบแก้ไข</label><select name="assignee_id"><option value="">— ยังไม่ระบุ —</option>${users}</select></div>
          <div class="inp"><label>วันครบกำหนด</label><input name="due_at" type="datetime-local"></div>
        </div>
      </div>
      <button class="btn green" type="submit" style="width:100%;padding:15px;font-size:16px">✓ บันทึกและแจ้งปัญหา</button>
    </form>`;

  $('#beforePick').onclick = async () => {
    const img = await pickImage(); if (!img) return;
    newBefore = img;
    $('#beforePick').classList.add('has');
    $('#beforePick').innerHTML = `<img src="${img}">`;
  };
  $('#newForm').onsubmit = submitNew;
}
async function submitNew(e) {
  e.preventDefault();
  if (!newBefore) return toast('กรุณาถ่าย/เลือกรูป Before ก่อน', 'err');
  const fd = Object.fromEntries(new FormData(e.target));
  const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = 'กำลังบันทึก...';
  try {
    const body = { ...fd, category_id: +fd.category_id || null, assignee_id: +fd.assignee_id || null,
      qty_defect: +fd.qty_defect || 0, due_at: fd.due_at ? new Date(fd.due_at).toISOString() : null, before_image: newBefore };
    const r = await api('/defects', { method: 'POST', body });
    await refreshData();
    toast('แจ้งปัญหาสำเร็จ: ' + r.ncr_no, 'ok');
    go('monitor');
  } catch (err) { toast(err.message, 'err'); btn.disabled = false; btn.textContent = '✓ บันทึกและแจ้งปัญหา'; }
}

/* ============================================================
   PAGE: REPORT (รายงาน — จอใหญ่ ตาราง + กราฟ + export)
   ============================================================ */
function renderReport() {
  const f = state.filters;
  let list = filterReport(state.defects, f);
  const s = summary();
  $('#page').innerHTML = `
    <div class="page-head"><h2>📊 รายงาน</h2><span class="sp"></span>
      <button class="btn ghost sm" onclick="QC.exportCSV()">⬇️ Excel/CSV</button>
      <button class="btn ghost sm" onclick="window.print()">🖨️ พิมพ์ / PDF</button></div>
    <div class="stats">
      <div class="stat s-open"><span class="bar"></span><div class="n">${s.openAll}</div><div class="t">ค้างทั้งหมด</div></div>
      <div class="stat s-pending"><span class="bar"></span><div class="n">${s.pending}</div><div class="t">รอ QC ตรวจ</div></div>
      <div class="stat s-over"><span class="bar"></span><div class="n">${s.overdue}</div><div class="t">เกินกำหนด</div></div>
      <div class="stat s-closed"><span class="bar"></span><div class="n">${s.closed}</div><div class="t">ปิดแล้ว</div></div>
    </div>
    <div class="charts noprint">
      <div class="panel"><h3>แยกตามประเภทปัญหา</h3>${barChart(byCategory())}</div>
      <div class="panel"><h3>แยกตามสถานะ</h3>${barChart(byStatus())}</div>
    </div>
    <div class="filters noprint">
      <input id="rq" placeholder="🔍 ค้นหา" value="${esc(f.q || '')}">
      <select id="rcat"><option value="">ทุกประเภท</option>${state.categories.map(c => `<option value="${c.id}" ${+f.cat === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <select id="rstatus"><option value="">ทุกสถานะ</option>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${f.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <select id="rassignee"><option value="">ทุกผู้รับผิดชอบ</option>${state.users.map(u => `<option value="${u.id}" ${+f.assignee === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>
      <input id="rfrom" type="date" value="${f.from || ''}"><input id="rto" type="date" value="${f.to || ''}">
    </div>
    <div class="table-wrap">
      <table class="rep"><thead><tr>
        <th>NCR</th><th>Before</th><th>After</th><th>ประเภท</th><th>ชิ้นงาน/Part</th><th>อาการ</th>
        <th>จำนวน</th><th>สถานะ</th><th>ผู้แจ้ง</th><th>ผู้รับผิดชอบ</th><th>ครบกำหนด</th><th>ปิดโดย</th><th>วันที่แจ้ง</th>
      </tr></thead><tbody>
        ${list.map(rowHTML).join('') || '<tr><td colspan="13" style="text-align:center;padding:24px" class="muted">ไม่พบข้อมูล</td></tr>'}
      </tbody></table>
    </div>
    <p class="muted" style="font-size:12px;margin-top:10px">รวม ${list.length} รายการ</p>`;
  const bind = (id, key, num) => { const el = $('#' + id); if (el) el.onchange = el.oninput = e => { f[key] = num ? e.target.value : e.target.value; clearTimeout(f._t); f._t = setTimeout(renderReport, 200); }; };
  bind('rq', 'q'); bind('rcat', 'cat'); bind('rstatus', 'status'); bind('rassignee', 'assignee'); bind('rfrom', 'from'); bind('rto', 'to');
  $$('.rep tbody tr[data-id]').forEach(tr => tr.onclick = () => openDetail(+tr.dataset.id));
}
function filterReport(arr, f) {
  return arr.filter(d => {
    if (f.q) { const q = f.q.toLowerCase(); if (!((d.ncr_no + d.part_name + d.part_no + (d.symptom || '')).toLowerCase().includes(q))) return false; }
    if (f.cat && +f.cat !== d.category_id) return false;
    if (f.status && f.status !== d.status) return false;
    if (f.assignee && +f.assignee !== d.assignee_id) return false;
    if (f.from && d.created_at.slice(0, 10) < f.from) return false;
    if (f.to && d.created_at.slice(0, 10) > f.to) return false;
    return true;
  });
}
function rowHTML(d) {
  const im = (src, lbl) => { const u = imgUrl(src); return u ? `<img class="mini" src="${u}" loading="lazy">` : `<span class="muted" style="font-size:11px">${lbl}</span>`; };
  return `<tr data-id="${d.id}" style="cursor:pointer">
    <td><b style="color:var(--blue)">${esc(d.ncr_no)}</b></td>
    <td>${im(d.before_img, '—')}</td><td>${im(d.after_img, '—')}</td>
    <td>${esc(d.category_name || '-')}</td>
    <td>${esc(d.part_name || '-')}<br><span class="muted" style="font-size:11px">${esc(d.part_no || '')}</span></td>
    <td style="max-width:200px">${esc(d.symptom || '-')}</td>
    <td>${d.qty_defect || 0}</td>
    <td><span class="st-badge st-${d.status}">${STATUS[d.status]}</span>${isOverdue(d) ? ' <span class="overdue-flag">เกิน</span>' : ''}</td>
    <td>${esc(d.reporter_name || '-')}</td><td>${esc(d.assignee_name || '-')}</td>
    <td>${d.due_at ? fmtDate(d.due_at, false) : '-'}</td>
    <td>${esc(d.closed_by_name || '-')}${d.closed_at ? '<br><span class="muted" style="font-size:11px">' + fmtDate(d.closed_at, false) + '</span>' : ''}</td>
    <td>${fmtDate(d.created_at, false)}</td>
  </tr>`;
}
function byCategory() {
  const m = {}; state.categories.forEach(c => m[c.name] = 0);
  state.defects.forEach(d => { const n = d.category_name || 'อื่นๆ'; m[n] = (m[n] || 0) + 1; });
  return Object.entries(m).filter(([, v]) => v > 0);
}
function byStatus() { return Object.entries(STATUS).map(([k, v]) => [v, state.defects.filter(d => d.status === k).length]); }
function barChart(data) {
  const max = Math.max(1, ...data.map(d => d[1]));
  return `<div style="display:flex;flex-direction:column;gap:9px">
    ${data.map(([k, v]) => `<div style="display:flex;align-items:center;gap:10px">
      <span style="width:120px;font-size:12.5px;text-align:right" class="muted">${esc(k)}</span>
      <div style="flex:1;background:var(--bg);border-radius:8px;overflow:hidden;height:22px">
        <div style="width:${(v / max * 100)}%;height:100%;background:linear-gradient(90deg,var(--blue),var(--blue-2));border-radius:8px;transition:width .6s"></div>
      </div><b style="width:32px">${v}</b></div>`).join('')}
  </div>`;
}
function exportCSV() {
  const list = filterReport(state.defects, state.filters);
  const cols = ['ncr_no', 'category_name', 'part_name', 'part_no', 'lot_no', 'qty_defect', 'symptom', 'cause', 'disposition', 'priority', 'status', 'reporter_name', 'assignee_name', 'due_at', 'closed_by_name', 'closed_at', 'created_at'];
  const head = ['NCR', 'ประเภท', 'ชิ้นงาน', 'PartNo', 'Lot', 'จำนวน', 'อาการ', 'สาเหตุ', 'แนวทาง', 'เร่งด่วน', 'สถานะ', 'ผู้แจ้ง', 'ผู้รับผิดชอบ', 'ครบกำหนด', 'ปิดโดย', 'วันปิด', 'วันแจ้ง'];
  const rows = list.map(d => cols.map(c => `"${String(d[c] ?? '').replace(/"/g, '""')}"`).join(','));
  const csv = '﻿' + head.join(',') + '\n' + rows.join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `QC-report-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  toast('ส่งออก ' + list.length + ' รายการ', 'ok');
}

/* ============================================================
   DETAIL modal
   ============================================================ */
async function openDetail(id) {
  const { defect: d, logs } = await api('/defects/' + id);
  const u = state.user, can = r => r.includes(u.role);
  const b = imgUrl(d.before_img), a = imgUrl(d.after_img), cmp = imgUrl(d.compare_img);
  const fig = (src, cls, cap) => src ? `<figure><img src="${src}"><figcaption class="${cls}">${cap}</figcaption></figure>` : `<figure><div class="empty">— ยังไม่มีรูป —</div><figcaption class="${cls}">${cap}</figcaption></figure>`;

  // ปุ่มตามสถานะ + สิทธิ์
  let actions = '';
  if (d.status === 'open') actions += `<button class="btn warn sm" data-act="start">▶ เริ่มแก้ไข</button>`;
  if (d.status === 'open' || d.status === 'in_progress') actions += `<button class="btn green sm" data-act="after">📷 ส่งงานแก้ไข (After)</button>`;
  if (d.status === 'pending_qc' && can(['qc', 'qc_lead'])) actions += `<button class="btn green sm" data-act="close">✓ อนุมัติ/ปิดงาน</button><button class="btn danger sm" data-act="reopen">↩ ตีกลับ</button>`;
  if (d.status === 'closed' && can(['qc', 'qc_lead'])) actions += `<button class="btn ghost sm" data-act="reopen">↩ เปิดใหม่</button>`;
  if (can(['qc', 'qc_lead'])) actions += `<button class="btn ghost sm" data-act="assign">👤 มอบหมาย/แก้ไข</button>`;
  if (can(['qc', 'qc_lead'])) actions += `<button class="btn ghost sm" data-act="line">💬 ส่งเข้า LINE</button>`;

  const host = $('#modalHost');
  host.innerHTML = `<div class="modal-bg"><div class="modal">
    <div class="mhead"><h3>${esc(d.ncr_no)} <span class="st-badge st-${d.status}">${STATUS[d.status]}</span></h3>
      <button class="iconbtn" id="mClose">✕</button></div>
    <div class="mbody">
      <div class="compare">${fig(b, 'cap-b', 'BEFORE (ก่อน)')}${fig(a, 'cap-a', 'AFTER (หลัง)')}</div>
      ${cmp ? `<div class="inp"><label>รูปเปรียบเทียบ (รวมแล้ว)</label><img src="${cmp}" style="width:100%;border-radius:12px;border:1px solid var(--line)"></div>` : ''}
      <div class="grid2">
        ${info('ประเภท', d.category_name)}${info('ความเร่งด่วน', PRIO[d.priority])}
        ${info('ชิ้นงาน', d.part_name)}${info('Part No.', d.part_no)}
        ${info('Lot/Job', d.lot_no)}${info('จำนวนของเสีย', d.qty_defect)}
        ${info('อาการ', d.symptom)}${info('สาเหตุ', d.cause)}
        ${info('แนวทางจัดการ', DISP[d.disposition] || d.disposition)}${info('ครบกำหนด', d.due_at ? fmtDate(d.due_at) : '-')}
        ${info('ผู้แจ้ง', d.reporter_name)}${info('ผู้รับผิดชอบ', d.assignee_name)}
        ${d.closed_by_name ? info('ปิดโดย', d.closed_by_name + ' · ' + fmtDate(d.closed_at)) : ''}
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin:16px 0">${actions}</div>
      <div class="inp"><label>เพิ่มหมายเหตุ / Comment</label>
        <div style="display:flex;gap:8px"><input id="cmt" placeholder="พิมพ์หมายเหตุ..." style="flex:1"><button class="btn sm" data-act="comment">ส่ง</button></div></div>
      <h3 style="font-size:14px;margin:18px 0 0">ประวัติการทำงาน (Audit Trail)</h3>
      <ul class="timeline">${(logs || []).slice().reverse().map(logHTML).join('') || '<li class="muted">ไม่มีบันทึก</li>'}</ul>
    </div>
  </div></div>`;

  const close = () => host.innerHTML = '';
  $('#mClose').onclick = close;
  host.querySelector('.modal-bg').onclick = e => { if (e.target.classList.contains('modal-bg')) close(); };
  host.querySelectorAll('[data-act]').forEach(btn => btn.onclick = () => doAction(btn.dataset.act, d, close));
}
function info(label, val) { return `<div class="inp" style="margin:0"><label>${label}</label><div style="padding:8px 0;font-weight:600">${esc(val ?? '-')}</div></div>`; }
function logHTML(l) {
  const A = { created: '📝 แจ้งปัญหา', started: '▶ เริ่มแก้ไข', after_submitted: '📷 ส่งงาน After', closed: '✅ ปิดงาน', reopened: '↩ ตีกลับ/เปิดใหม่', comment: '💬 หมายเหตุ', assigned: '👤 มอบหมาย', line_sent: '💬 ส่งเข้า LINE' };
  return `<li><div class="act">${A[l.action] || l.action}</div>
    <div class="tm">${esc(l.user_name || 'ระบบ')} · ${fmtDate(l.created_at)}</div>
    ${l.note ? `<div class="nt">${esc(l.note)}</div>` : ''}</li>`;
}
async function doAction(act, d, close) {
  try {
    if (act === 'comment') {
      const v = $('#cmt').value.trim(); if (!v) return;
      await api(`/defects/${d.id}/comment`, { method: 'POST', body: { note: v } });
      toast('บันทึกหมายเหตุแล้ว', 'ok'); await refreshData(); close(); openDetail(d.id); return;
    }
    if (act === 'start') {
      await api(`/defects/${d.id}/start`, { method: 'POST', body: {} });
      toast('เริ่มแก้ไขแล้ว', 'ok'); await reloadAfterAction(close, d.id); return;
    }
    if (act === 'after') return submitAfterFlow(d, close);
    if (act === 'close') {
      const note = prompt('หมายเหตุการปิดงาน (ถ้ามี):') ?? '';
      await api(`/defects/${d.id}/close`, { method: 'POST', body: { note } });
      toast('ปิดงานเรียบร้อย', 'ok'); await reloadAfterAction(close, d.id); return;
    }
    if (act === 'reopen') {
      const note = prompt('เหตุผลที่ตีกลับ:'); if (note === null) return;
      await api(`/defects/${d.id}/reopen`, { method: 'POST', body: { note } });
      toast('ตีกลับเป็นรอแก้ไข', 'ok'); await reloadAfterAction(close, d.id); return;
    }
    if (act === 'assign') return assignFlow(d, close);
    if (act === 'line') {
      const r = await api(`/line/send/${d.id}`, { method: 'POST', body: { origin: location.origin } });
      if (r.ok) toast('ส่งเข้า LINE แล้ว', 'ok'); else toast(r.error || 'ส่งไม่สำเร็จ', 'err');
      return;
    }
  } catch (err) { toast(err.message, 'err'); }
}
async function reloadAfterAction(close, id) { await refreshData(); if (state.page === 'monitor') renderMonitor(); else go(state.page); close(); openDetail(id); }

async function submitAfterFlow(d, close) {
  const after = await pickImage(); if (!after) return;
  toast('กำลังสร้างรูปเปรียบเทียบ...', '');
  const compare = await mergeBeforeAfter(imgUrl(d.before_img), after, d);
  await api(`/defects/${d.id}/after`, { method: 'POST', body: { after_image: after, compare_image: compare, note: 'ส่งงานแก้ไข (After)' } });
  toast('ส่งงานแก้ไขแล้ว — รอ QC ตรวจ', 'ok');
  await reloadAfterAction(close, d.id);
}
function assignFlow(d, close) {
  const host = $('#modalHost');
  const users = state.users.map(u => `<option value="${u.id}" ${u.id === d.assignee_id ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
  const due = d.due_at ? new Date(d.due_at).toISOString().slice(0, 16) : '';
  host.insertAdjacentHTML('beforeend', `<div class="modal-bg" id="assignBg"><div class="modal" style="max-width:440px">
    <div class="mhead"><h3>มอบหมาย / แก้ไข ${esc(d.ncr_no)}</h3><button class="iconbtn" id="aClose">✕</button></div>
    <div class="mbody">
      <div class="inp"><label>ผู้รับผิดชอบ</label><select id="aUser"><option value="">— ไม่ระบุ —</option>${users}</select></div>
      <div class="inp"><label>วันครบกำหนด</label><input id="aDue" type="datetime-local" value="${due}"></div>
      <div class="inp"><label>ความเร่งด่วน</label><select id="aPrio">${Object.entries(PRIO).map(([k, v]) => `<option value="${k}" ${k === d.priority ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <button class="btn" id="aSave" style="width:100%">บันทึก</button>
    </div></div></div>`);
  const bg = $('#assignBg'); const rm = () => bg.remove();
  $('#aClose').onclick = rm; bg.onclick = e => { if (e.target === bg) rm(); };
  $('#aSave').onclick = async () => {
    await api(`/defects/${d.id}/assign`, { method: 'POST', body: { assignee_id: +$('#aUser').value || null, due_at: $('#aDue').value ? new Date($('#aDue').value).toISOString() : null, priority: $('#aPrio').value } });
    toast('บันทึกการมอบหมายแล้ว', 'ok'); rm(); await reloadAfterAction(close, d.id);
  };
}

/* ============================================================
   PAGE: SETTINGS (หัวหน้า QC)
   ============================================================ */
async function renderSettings() {
  const [{ users }, { categories }] = await Promise.all([api('/users'), api('/categories')]);
  $('#page').innerHTML = `
    <div class="page-head"><h2>⚙️ ตั้งค่าระบบ</h2></div>

    <div class="panel"><h3>👥 ผู้ใช้งาน & สิทธิ์</h3>
      <div id="userList">${users.map(userRow).join('')}</div>
      <button class="btn sm" id="addUser">+ เพิ่มผู้ใช้</button>
    </div>

    <div class="panel"><h3>🏷️ ประเภทปัญหาคุณภาพ</h3>
      <div id="catList">${categories.filter(c => c.active).map(catRow).join('')}</div>
      <div style="display:flex;gap:8px;margin-top:8px"><input id="newCat" placeholder="ชื่อประเภทใหม่" style="flex:1;padding:9px 12px;border:1.5px solid var(--line);border-radius:10px;background:var(--bg-2);color:var(--ink)"><button class="btn sm" id="addCat">+ เพิ่ม</button></div>
    </div>

    <div class="panel"><h3>⏱️ เกณฑ์อายุงาน (เปลี่ยนสีเตือน)</h3>
      <div class="grid2">
        <div class="inp"><label>เขียว → เหลือง เมื่อค้างเกิน (ชั่วโมง)</label><input id="agWarn" type="number" value="${esc(state.settings.aging_warn_hours)}"></div>
        <div class="inp"><label>เหลือง → แดง เมื่อค้างเกิน (ชั่วโมง)</label><input id="agCrit" type="number" value="${esc(state.settings.aging_crit_hours)}"></div>
      </div>
      <button class="btn sm" id="saveAging">บันทึกเกณฑ์</button>
    </div>

    <div class="panel"><h3>💬 เชื่อมต่อ LINE (Messaging API)</h3>
      <p class="muted" style="font-size:13px;line-height:1.7">1) สร้าง LINE Official Account + Messaging API channel → คัดลอก <b>Channel access token</b> ไปตั้งเป็น secret ใน Worker (<code>wrangler secret put LINE_CHANNEL_ACCESS_TOKEN</code>)<br>
      2) ตั้ง Webhook URL = <code>${API_BASE || 'https://&lt;your-worker&gt;'}/api/line/webhook</code><br>
      3) เชิญบอทเข้ากลุ่ม LINE → ระบบจะดัก Group ID อัตโนมัติ แล้วแสดงให้เลือกด้านล่าง</p>
      <div class="inp"><label>กลุ่มปลายทาง (ดักจาก webhook)</label>
        <select id="lineGroup">
          <option value="">${state.lineGroups.length ? '— เลือกกลุ่ม —' : '— ยังไม่พบกลุ่ม (เชิญบอทเข้ากลุ่มก่อน) —'}</option>
          ${state.lineGroups.map(g => `<option value="${esc(g.group_id)}" ${state.settings.line_group_id === g.group_id ? 'selected' : ''}>${esc(g.group_name || g.group_id)}</option>`).join('')}
        </select></div>
      <div style="display:flex;gap:8px"><button class="btn sm" id="saveLine">บันทึกกลุ่ม</button><button class="btn ghost sm" id="testLine">📨 ทดสอบส่งข้อความ</button></div>
      ${DEMO ? '<p class="muted" style="font-size:12px;margin-top:10px">⚠️ โหมดสาธิต: ฟังก์ชัน LINE จะใช้ได้จริงหลัง deploy Worker</p>' : ''}
    </div>`;

  $('#addUser').onclick = () => editUser();
  $$('#userList [data-edit]').forEach(b => b.onclick = () => editUser(users.find(u => u.id === +b.dataset.edit)));
  $$('#userList [data-del]').forEach(b => b.onclick = async () => { if (confirm('ลบผู้ใช้นี้?')) { await api('/users/' + b.dataset.del, { method: 'DELETE' }); await refreshData(); renderSettings(); } });
  $('#addCat').onclick = async () => { const n = $('#newCat').value.trim(); if (!n) return; await api('/categories', { method: 'POST', body: { name: n, sort: 99 } }); await refreshData(); renderSettings(); };
  $$('#catList [data-delcat]').forEach(b => b.onclick = async () => { await api('/categories/' + b.dataset.delcat, { method: 'DELETE' }); await refreshData(); renderSettings(); });
  $$('#catList [data-editcat]').forEach(b => b.onclick = async () => { const n = prompt('แก้ชื่อประเภท:', b.dataset.name); if (n) { await api('/categories/' + b.dataset.editcat, { method: 'PUT', body: { name: n, sort: 0, active: 1 } }); await refreshData(); renderSettings(); } });
  $('#saveAging').onclick = async () => { await api('/settings', { method: 'POST', body: { aging_warn_hours: $('#agWarn').value, aging_crit_hours: $('#agCrit').value } }); await refreshData(); toast('บันทึกเกณฑ์แล้ว', 'ok'); };
  $('#saveLine').onclick = async () => { const sel = $('#lineGroup'); await api('/settings', { method: 'POST', body: { line_group_id: sel.value, line_group_name: sel.options[sel.selectedIndex]?.text || '' } }); await refreshData(); toast('บันทึกกลุ่ม LINE แล้ว', 'ok'); };
  $('#testLine').onclick = async () => { const r = await api('/line/test', { method: 'POST', body: { group_id: $('#lineGroup').value } }); if (r.ok) toast('ส่งข้อความทดสอบแล้ว', 'ok'); else toast(r.error || 'ส่งไม่สำเร็จ', 'err'); };
}
function userRow(u) {
  return `<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--line)">
    <div class="who" style="background:var(--bg)"><div class="av">${esc(initials(u.name))}</div><div><div class="nm">${esc(u.name)}</div><div class="rl">${esc(u.emp_code)} · ${ROLE_TH[u.role]}</div></div></div>
    <span class="sp" style="flex:1"></span>
    <button class="btn ghost sm" data-edit="${u.id}">แก้ไข</button>
    ${u.id === state.user.id ? '' : `<button class="btn danger sm" data-del="${u.id}">ลบ</button>`}
  </div>`;
}
function catRow(c) {
  return `<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--line)">
    <span style="flex:1">${esc(c.name)}</span>
    <button class="btn ghost sm" data-editcat="${c.id}" data-name="${esc(c.name)}">แก้</button>
    <button class="btn danger sm" data-delcat="${c.id}">ลบ</button></div>`;
}
function editUser(u) {
  const host = $('#modalHost');
  host.innerHTML = `<div class="modal-bg" id="euBg"><div class="modal" style="max-width:420px">
    <div class="mhead"><h3>${u ? 'แก้ไขผู้ใช้' : 'เพิ่มผู้ใช้'}</h3><button class="iconbtn" id="euClose">✕</button></div>
    <div class="mbody">
      <div class="inp"><label>รหัสพนักงาน *</label><input id="euCode" value="${esc(u?.emp_code || '')}" ${u ? 'disabled' : ''}></div>
      <div class="inp"><label>ชื่อ *</label><input id="euName" value="${esc(u?.name || '')}"></div>
      <div class="inp"><label>สิทธิ์</label><select id="euRole">${Object.entries(ROLE_TH).map(([k, v]) => `<option value="${k}" ${u?.role === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="inp"><label>LINE userId (สำหรับ @mention — ไม่บังคับ)</label><input id="euLine" value="${esc(u?.line_user_id || '')}"></div>
      <button class="btn" id="euSave" style="width:100%">บันทึก</button>
    </div></div></div>`;
  const bg = $('#euBg'); const rm = () => bg.remove();
  $('#euClose').onclick = rm; bg.onclick = e => { if (e.target === bg) rm(); };
  $('#euSave').onclick = async () => {
    const body = { emp_code: $('#euCode').value.trim(), name: $('#euName').value.trim(), role: $('#euRole').value, line_user_id: $('#euLine').value.trim() };
    if (!body.emp_code || !body.name) return toast('กรอกรหัสและชื่อ', 'err');
    try {
      if (u) await api('/users/' + u.id, { method: 'PUT', body: { ...body, active: 1 } });
      else await api('/users', { method: 'POST', body });
      toast('บันทึกแล้ว', 'ok'); rm(); await refreshData(); renderSettings();
    } catch (err) { toast(err.message, 'err'); }
  };
}

/* ============================================================
   TV / fullscreen mode
   ============================================================ */
function enterTV() {
  go('monitor'); document.body.classList.add('tv');
  if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
}
function exitTV() { document.body.classList.remove('tv'); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); }

window.addEventListener('resize', moveIndicator);

/* expose สำหรับ onclick ใน HTML */
window.QC = { go, exportCSV, openDetail };

init();
})();

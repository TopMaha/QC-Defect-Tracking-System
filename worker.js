/**
 * QC Defect Tracking System — Cloudflare Worker (API + R2 + LINE Messaging API)
 * ------------------------------------------------------------------------------
 * Bindings (wrangler.toml):
 *   DB      -> D1 database
 *   IMAGES  -> R2 bucket
 *   ASSETS  -> static assets (./public)
 * Secrets:
 *   LINE_CHANNEL_ACCESS_TOKEN  (push message / mention / get profile)
 *   LINE_CHANNEL_SECRET        (verify webhook signature)
 */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // CORS preflight (เผื่อเปิด frontend แยกโดเมนตอน dev)
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

    try {
      // ---- เสิร์ฟรูปจาก R2 ----
      if (pathname.startsWith('/img/')) return serveImage(request, env, pathname.slice(5));

      // ---- LINE webhook ----
      if (pathname === '/api/line/webhook' && request.method === 'POST')
        return lineWebhook(request, env, ctx);

      // ---- API ----
      if (pathname.startsWith('/api/')) return cors(await api(request, env, url));

      // ---- static assets (index.html ฯลฯ) ----
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response('Not found', { status: 404 });
    } catch (err) {
      return cors(json({ error: String(err && err.message || err) }, 500));
    }
  },

  // Cron (ตั้งใน wrangler) — แจ้งเตือนงานเกินกำหนด/ค้างนานเข้า LINE
  async scheduled(event, env, ctx) {
    ctx.waitUntil(notifyOverdue(env));
  },
};

/* ============================ helpers ============================ */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });
}
function cors(res) {
  const h = new Headers(res.headers);
  h.set('access-control-allow-origin', '*');
  h.set('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
  h.set('access-control-allow-headers', 'content-type,x-emp-code');
  return new Response(res.body, { status: res.status, headers: h });
}
const nowISO = () => new Date().toISOString();

async function getUser(request, env) {
  const code = request.headers.get('x-emp-code');
  if (!code) return null;
  return env.DB.prepare('SELECT * FROM users WHERE emp_code=? AND active=1').bind(code).first();
}
function requireRole(user, roles) {
  return user && roles.includes(user.role);
}

/* ============================ R2 images ============================ */
async function serveImage(request, env, key) {
  const obj = await env.IMAGES.get(decodeURIComponent(key));
  if (!obj) return new Response('Not found', { status: 404 });
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set('etag', obj.httpEtag);
  h.set('cache-control', 'public, max-age=31536000, immutable');
  return new Response(obj.body, { headers: h });
}

async function uploadImage(env, dataUrl, prefix = 'img') {
  // dataUrl: "data:image/jpeg;base64,...."
  const m = /^data:(image\/\w+);base64,(.+)$/s.exec(dataUrl || '');
  if (!m) throw new Error('invalid image data');
  const type = m[1];
  const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
  const ext = type.split('/')[1] || 'jpg';
  const key = `${prefix}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  await env.IMAGES.put(key, bytes, { httpMetadata: { contentType: type } });
  return key;
}

/* ============================ API router ============================ */
async function api(request, env, url) {
  const p = url.pathname.replace(/^\/api/, '');
  const method = request.method;
  const seg = p.split('/').filter(Boolean); // e.g. ['defects','12','close']
  const body = method === 'POST' || method === 'PUT'
    ? await request.json().catch(() => ({})) : {};
  const user = await getUser(request, env);

  // ----- login (whitelist) -----
  if (p === '/login' && method === 'POST') {
    const u = await env.DB.prepare('SELECT * FROM users WHERE emp_code=? AND active=1')
      .bind((body.emp_code || '').trim()).first();
    if (!u) return json({ error: 'ไม่พบรหัสพนักงานนี้ในระบบ' }, 401);
    return json({ user: publicUser(u) });
  }

  // ----- bootstrap (ข้อมูลตั้งต้นของแอป) -----
  if (p === '/bootstrap' && method === 'GET') {
    const [users, cats, settings, groups] = await Promise.all([
      env.DB.prepare('SELECT * FROM users WHERE active=1 ORDER BY role,name').all(),
      env.DB.prepare('SELECT * FROM defect_categories WHERE active=1 ORDER BY sort,id').all(),
      env.DB.prepare('SELECT * FROM app_settings').all(),
      env.DB.prepare('SELECT * FROM line_groups ORDER BY captured_at DESC').all(),
    ]);
    return json({
      users: users.results.map(publicUser),
      categories: cats.results,
      settings: kv(settings.results),
      lineGroups: groups.results,
    });
  }

  /* ---------------- defects ---------------- */
  if (seg[0] === 'defects') {
    // list
    if (seg.length === 1 && method === 'GET') {
      const rows = await env.DB.prepare(
        `SELECT d.*, c.name AS category_name,
                r.name AS reporter_name, a.name AS assignee_name, cb.name AS closed_by_name
         FROM defects d
         LEFT JOIN defect_categories c ON c.id=d.category_id
         LEFT JOIN users r  ON r.id=d.reporter_id
         LEFT JOIN users a  ON a.id=d.assignee_id
         LEFT JOIN users cb ON cb.id=d.closed_by
         ORDER BY d.created_at DESC`).all();
      return json({ defects: rows.results });
    }
    // create
    if (seg.length === 1 && method === 'POST') {
      if (!user) return json({ error: 'unauthorized' }, 401);
      return json(await createDefect(env, user, body));
    }
    const id = Number(seg[1]);
    // detail (+logs)
    if (seg.length === 2 && method === 'GET') {
      const d = await env.DB.prepare('SELECT * FROM defects WHERE id=?').bind(id).first();
      if (!d) return json({ error: 'not found' }, 404);
      const logs = await env.DB.prepare(
        `SELECT l.*, u.name AS user_name FROM defect_logs l
         LEFT JOIN users u ON u.id=l.user_id WHERE defect_id=? ORDER BY l.created_at ASC`)
        .bind(id).all();
      return json({ defect: d, logs: logs.results });
    }
    if (!user) return json({ error: 'unauthorized' }, 401);
    const action = seg[2];
    // start rework (open -> in_progress)
    if (action === 'start' && method === 'POST') {
      await setStatus(env, id, 'in_progress', user, 'started', body.note);
      return json({ ok: true });
    }
    // submit after image (-> pending_qc)
    if (action === 'after' && method === 'POST') return json(await submitAfter(env, user, id, body));
    // close (QC)
    if (action === 'close' && method === 'POST') {
      if (!requireRole(user, ['qc', 'qc_lead'])) return json({ error: 'ต้องเป็น QC' }, 403);
      await env.DB.prepare('UPDATE defects SET status=?,closed_at=?,closed_by=?,updated_at=? WHERE id=?')
        .bind('closed', nowISO(), user.id, nowISO(), id).run();
      await addLog(env, id, user.id, 'closed', body.note);
      return json({ ok: true });
    }
    // reopen / ตีกลับ (-> open)
    if (action === 'reopen' && method === 'POST') {
      if (!requireRole(user, ['qc', 'qc_lead'])) return json({ error: 'ต้องเป็น QC' }, 403);
      await env.DB.prepare('UPDATE defects SET status=?,closed_at=NULL,closed_by=NULL,updated_at=? WHERE id=?')
        .bind('open', nowISO(), id).run();
      await addLog(env, id, user.id, 'reopened', body.note);
      return json({ ok: true });
    }
    // comment
    if (action === 'comment' && method === 'POST') {
      await addLog(env, id, user.id, 'comment', body.note || '');
      return json({ ok: true });
    }
    // assign / edit fields
    if (action === 'assign' && method === 'POST') {
      await env.DB.prepare('UPDATE defects SET assignee_id=?,due_at=?,priority=?,updated_at=? WHERE id=?')
        .bind(body.assignee_id || null, body.due_at || null, body.priority || 'normal', nowISO(), id).run();
      await addLog(env, id, user.id, 'assigned', body.note);
      return json({ ok: true });
    }
    // save merged compare image
    if (action === 'compare' && method === 'POST') {
      const key = await uploadImage(env, body.image, 'compare');
      await env.DB.prepare('UPDATE defects SET compare_img=?,updated_at=? WHERE id=?')
        .bind(key, nowISO(), id).run();
      return json({ ok: true, key });
    }
  }

  /* ---------------- categories (qc_lead) ---------------- */
  if (seg[0] === 'categories') {
    if (method === 'GET') {
      const r = await env.DB.prepare('SELECT * FROM defect_categories ORDER BY sort,id').all();
      return json({ categories: r.results });
    }
    if (!requireRole(user, ['qc_lead'])) return json({ error: 'forbidden' }, 403);
    if (method === 'POST') {
      await env.DB.prepare('INSERT INTO defect_categories (name,sort,active) VALUES (?,?,1)')
        .bind(body.name, body.sort || 0).run();
      return json({ ok: true });
    }
    const id = Number(seg[1]);
    if (method === 'PUT') {
      await env.DB.prepare('UPDATE defect_categories SET name=?,sort=?,active=? WHERE id=?')
        .bind(body.name, body.sort || 0, body.active ?? 1, id).run();
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      await env.DB.prepare('UPDATE defect_categories SET active=0 WHERE id=?').bind(id).run();
      return json({ ok: true });
    }
  }

  /* ---------------- users (qc_lead) ---------------- */
  if (seg[0] === 'users') {
    if (!requireRole(user, ['qc_lead'])) return json({ error: 'forbidden' }, 403);
    if (method === 'GET') {
      const r = await env.DB.prepare('SELECT * FROM users ORDER BY role,name').all();
      return json({ users: r.results.map(publicUser) });
    }
    if (method === 'POST') {
      await env.DB.prepare('INSERT INTO users (emp_code,name,role,line_user_id,active) VALUES (?,?,?,?,1)')
        .bind(body.emp_code, body.name, body.role || 'staff', body.line_user_id || null).run();
      return json({ ok: true });
    }
    const id = Number(seg[1]);
    if (method === 'PUT') {
      await env.DB.prepare('UPDATE users SET name=?,role=?,line_user_id=?,active=? WHERE id=?')
        .bind(body.name, body.role, body.line_user_id || null, body.active ?? 1, id).run();
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      await env.DB.prepare('UPDATE users SET active=0 WHERE id=?').bind(id).run();
      return json({ ok: true });
    }
  }

  /* ---------------- settings (qc_lead) ---------------- */
  if (p === '/settings' && method === 'POST') {
    if (!requireRole(user, ['qc_lead'])) return json({ error: 'forbidden' }, 403);
    for (const [k, v] of Object.entries(body)) {
      await env.DB.prepare('INSERT INTO app_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .bind(k, String(v)).run();
    }
    return json({ ok: true });
  }

  /* ---------------- LINE ---------------- */
  if (seg[0] === 'line') {
    if (seg[1] === 'members' && method === 'GET') {
      const r = await env.DB.prepare('SELECT * FROM line_members ORDER BY captured_at DESC').all();
      return json({ members: r.results });
    }
    if (!requireRole(user, ['qc', 'qc_lead'])) return json({ error: 'forbidden' }, 403);
    if (seg[1] === 'test' && method === 'POST') {
      const gid = body.group_id || await getSetting(env, 'line_group_id');
      const r = await linePush(env, gid, [{ type: 'text', text: '✅ ทดสอบการเชื่อมต่อ QC Defect Tracking System สำเร็จ' }]);
      return json(r);
    }
    if (seg[1] === 'send' && method === 'POST') {
      return json(await sendDefectToLine(env, Number(seg[2]), body));
    }
  }

  return json({ error: 'route not found' }, 404);
}

/* ============================ domain logic ============================ */
function publicUser(u) {
  return { id: u.id, emp_code: u.emp_code, name: u.name, role: u.role, line_user_id: u.line_user_id, active: u.active };
}
function kv(rows) { const o = {}; for (const r of rows) o[r.key] = r.value; return o; }
async function getSetting(env, key) {
  const r = await env.DB.prepare('SELECT value FROM app_settings WHERE key=?').bind(key).first();
  return r ? r.value : null;
}
async function addLog(env, defectId, userId, action, note) {
  await env.DB.prepare('INSERT INTO defect_logs (defect_id,user_id,action,note) VALUES (?,?,?,?)')
    .bind(defectId, userId || null, action, note || null).run();
}
async function setStatus(env, id, status, user, action, note) {
  await env.DB.prepare('UPDATE defects SET status=?,updated_at=? WHERE id=?').bind(status, nowISO(), id).run();
  await addLog(env, id, user.id, action, note);
}

async function nextNcrNo(env) {
  const ym = new Date().toISOString().slice(2, 7).replace('-', ''); // YYMM
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM defects WHERE ncr_no LIKE ?`).bind(`NCR-${ym}-%`).first();
  const seq = String((row.c || 0) + 1).padStart(4, '0');
  return `NCR-${ym}-${seq}`;
}

async function createDefect(env, user, b) {
  const ncr = await nextNcrNo(env);
  let beforeKey = null;
  if (b.before_image) beforeKey = await uploadImage(env, b.before_image, 'before');
  const r = await env.DB.prepare(
    `INSERT INTO defects
     (ncr_no,category_id,part_name,part_no,lot_no,qty_defect,symptom,cause,disposition,
      priority,status,before_img,reporter_id,assignee_id,due_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,'open',?,?,?,?)`).bind(
    ncr, b.category_id || null, b.part_name || null, b.part_no || null, b.lot_no || null,
    b.qty_defect || 0, b.symptom || null, b.cause || null, b.disposition || null,
    b.priority || 'normal', beforeKey, user.id, b.assignee_id || null, b.due_at || null
  ).run();
  const id = r.meta.last_row_id;
  await addLog(env, id, user.id, 'created', `แจ้งปัญหา ${ncr}`);
  return { ok: true, id, ncr_no: ncr };
}

async function submitAfter(env, user, id, b) {
  let afterKey = null, compareKey = null;
  if (b.after_image) afterKey = await uploadImage(env, b.after_image, 'after');
  if (b.compare_image) compareKey = await uploadImage(env, b.compare_image, 'compare');
  await env.DB.prepare(
    'UPDATE defects SET after_img=COALESCE(?,after_img),compare_img=COALESCE(?,compare_img),status=?,updated_at=? WHERE id=?')
    .bind(afterKey, compareKey, 'pending_qc', nowISO(), id).run();
  await addLog(env, id, user.id, 'after_submitted', b.note || 'ส่งงานแก้ไข (After)');
  return { ok: true, after_img: afterKey, compare_img: compareKey };
}

/* ============================ LINE Messaging API ============================ */
async function linePush(env, to, messages) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return { error: 'ยังไม่ได้ตั้ง LINE_CHANNEL_ACCESS_TOKEN' };
  if (!to) return { error: 'ยังไม่ได้เลือกกลุ่มปลายทาง (group id)' };
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ to, messages }),
  });
  if (!res.ok) return { error: `LINE error ${res.status}: ${await res.text()}` };
  return { ok: true };
}

async function sendDefectToLine(env, id, opts) {
  const d = await env.DB.prepare(
    `SELECT d.*, c.name AS category_name, a.name AS assignee_name, a.line_user_id AS assignee_line
     FROM defects d LEFT JOIN defect_categories c ON c.id=d.category_id
     LEFT JOIN users a ON a.id=d.assignee_id WHERE d.id=?`).bind(id).first();
  if (!d) return { error: 'not found' };
  const gid = opts.group_id || await getSetting(env, 'line_group_id');
  const origin = opts.origin || '';
  const statusLabel = { open: 'รอแก้ไข', in_progress: 'กำลังแก้ไข', pending_qc: 'รอ QC ตรวจ', closed: 'ปิดงาน' }[d.status];

  // ข้อความ (รองรับ @mention ถ้ามี assignee_line)
  const base = `📋 ${d.ncr_no}\nประเภท: ${d.category_name || '-'}\nชิ้นงาน: ${d.part_name || '-'} (${d.part_no || '-'})\nอาการ: ${d.symptom || '-'}\nสถานะ: ${statusLabel}`;
  const messages = [];
  if (d.assignee_line) {
    // textV2 + substitution: ใช้ placeholder {u} แทนตำแหน่ง @mention
    messages.push({
      type: 'textV2',
      text: `${base}\nผู้รับผิดชอบ: {u} `,
      substitution: { u: { type: 'mention', mentionee: { type: 'user', userId: d.assignee_line } } },
    });
  } else {
    messages.push({ type: 'text', text: `${base}\nผู้รับผิดชอบ: ${d.assignee_name || '-'}` });
  }
  // แนบรูปเปรียบเทียบ
  const imgKey = d.compare_img || d.before_img;
  if (imgKey && origin) {
    const u = `${origin}/img/${imgKey}`;
    messages.push({ type: 'image', originalContentUrl: u, previewImageUrl: u });
  }
  const r = await linePush(env, gid, messages);
  if (r.ok) await addLog(env, id, null, 'line_sent', 'ส่งรายงานเข้า LINE');
  return r;
}

async function notifyOverdue(env) {
  const warn = Number(await getSetting(env, 'aging_crit_hours') || 48);
  const rows = await env.DB.prepare(
    `SELECT d.*, c.name AS category_name FROM defects d LEFT JOIN defect_categories c ON c.id=d.category_id
     WHERE d.status!='closed'
       AND ( (d.due_at IS NOT NULL AND d.due_at < ?) OR
             ((julianday('now')-julianday(d.created_at))*24 > ?) )`)
    .bind(nowISO(), warn).all();
  if (!rows.results.length) return;
  const gid = await getSetting(env, 'line_group_id');
  const lines = rows.results.map(d => `• ${d.ncr_no} ${d.part_name || ''} (${d.category_name || '-'})`).join('\n');
  await linePush(env, gid, [{ type: 'text', text: `⚠️ งานค้าง/เกินกำหนด ${rows.results.length} รายการ\n${lines}` }]);
}

/* ============================ LINE webhook ============================ */
async function lineWebhook(request, env, ctx) {
  const bodyText = await request.text();
  // verify signature (ถ้ามี secret)
  if (env.LINE_CHANNEL_SECRET) {
    const sig = request.headers.get('x-line-signature') || '';
    const ok = await verifyLineSignature(env.LINE_CHANNEL_SECRET, bodyText, sig);
    if (!ok) return new Response('bad signature', { status: 403 });
  }
  const data = JSON.parse(bodyText || '{}');
  ctx.waitUntil(handleEvents(env, data.events || []));
  return new Response('OK');
}

async function handleEvents(env, events) {
  for (const ev of events) {
    const src = ev.source || {};
    // ดัก group id (ตอนถูกเชิญเข้ากลุ่ม หรือมีข้อความในกลุ่ม)
    if (src.groupId) {
      let gname = null;
      try {
        if (env.LINE_CHANNEL_ACCESS_TOKEN) {
          const res = await fetch(`https://api.line.me/v2/bot/group/${src.groupId}/summary`,
            { headers: { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` } });
          if (res.ok) gname = (await res.json()).groupName;
        }
      } catch (_) {}
      await env.DB.prepare(
        'INSERT INTO line_groups (group_id,group_name) VALUES (?,?) ON CONFLICT(group_id) DO UPDATE SET group_name=COALESCE(excluded.group_name,group_name)')
        .bind(src.groupId, gname).run();
    }
    // ดัก userId + ชื่อ (ไว้ map @mention)
    if (src.userId) {
      let dname = null;
      try {
        if (env.LINE_CHANNEL_ACCESS_TOKEN) {
          const url = src.groupId
            ? `https://api.line.me/v2/bot/group/${src.groupId}/member/${src.userId}`
            : `https://api.line.me/v2/bot/profile/${src.userId}`;
          const res = await fetch(url, { headers: { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` } });
          if (res.ok) dname = (await res.json()).displayName;
        }
      } catch (_) {}
      await env.DB.prepare(
        'INSERT INTO line_members (line_user_id,display_name) VALUES (?,?) ON CONFLICT(line_user_id) DO UPDATE SET display_name=COALESCE(excluded.display_name,display_name)')
        .bind(src.userId, dname).run();
    }
  }
}

async function verifyLineSignature(secret, body, signature) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return b64 === signature;
}

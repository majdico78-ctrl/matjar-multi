/*
  منصة المتاجر — خادم الموقع المستقل (عدة متاجر في خادم واحد)
  كل متجر عزلة كاملة: منتجاته وطلبياته وأرصدته ورموز ورقم صاحبه بملفات منفصلة
    داخل data/stores/<معرّف المتجر>/.

  الروابط:
    /                → دفتر المتاجر (قائمة المتاجر + تسجيل متجر جديد)
    /s/<معرّف>       → واجهة متجر معين (هذا الرابط يُشارك للزبائن)
    /s/<معرّف>/v1/x/… → مسارات بيانات هذا المتجر

  مسارات البيانات (لكل متجر على حدة، تُخدم تحت /s/<معرّف>):
    /v1/x/matjar-orders    (GET/POST/PATCH/DELETE) — الطلبيات
    /v1/x/matjar-products  (GET/POST)              — قائمة المنتجات وصورها
    /v1/x/matjar-wallet    (GET/POST)              — أرصدة الزبائن
    /v1/x/matjar-messages  (GET/POST)              — رسائل الدكان للزبائن
    /v1/x/matjar-tiles     (GET)                   — بلاطات الخارطة (مشتركة بين الجميع)
    /v1/x/matjar-pin(-check)                       — رمز دخول لوحة المتجر (لكل متجر رمزه)
    /v1/x/matjar-phone(-check)                     — رقم صاحب الدكان (لكل متجر رقمه وسرّه)

  إدارة المنصة:
    GET  /v1/x/stores                — قائمة المتاجر (عامة)
    POST /v1/x/stores                — تسجيل متجر جديد (يتطلب رمز المنصة MASTER_CODE)
    DELETE /v1/x/stores?id=&code=    — إغلاق متجر (يتطلب رمز المنصة) — لا يُستعمل إلا عند الطلب

  ⚠️ الأسرار تُغيَّر من هنا فقط:
*/
const MASTER_CODE = "9178";     // رمز المنصة — يُطلب عند تسجيل متجر جديد أو إغلاقه
const DEFAULT_PIN = "1234";     // رمز دخول لوحة أي متجر جديد — يتغير من لوحة المتجر نفسها
const PHONE_SECRET = "9178";    // الرقم السري لخانة رقم صاحب الدكان (نفس نظام المتجر الأول)

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "30mb" }));

const DATA = path.join(__dirname, "data");
const SDIR = path.join(DATA, "stores");
const ensureData = () => fs.mkdirSync(DATA, { recursive: true });
const normPhone = (p) => (p || "").replace(/\D/g, "");
const STORES_FILE = path.join(DATA, "stores.json");

/* ---------- سجلّ المتاجر ---------- */
function listStores() {
  try { const v = JSON.parse(fs.readFileSync(STORES_FILE, "utf-8")); if (Array.isArray(v)) return v; } catch (e) {}
  return [];
}
function saveStores(v) { ensureData(); fs.writeFileSync(STORES_FILE, JSON.stringify(v, null, 2)); }
const findStore = (id) => listStores().find((s) => s.id === id);
const slugOk = (id) => /^[a-z0-9][a-z0-9-]{1,23}$/.test(id);

/* ---------- تخزين لكل متجر ---------- */
function sdir(id) { const d = path.join(SDIR, id); fs.mkdirSync(d, { recursive: true }); return d; }
function sload(id, f) { try { return JSON.parse(fs.readFileSync(path.join(SDIR, id, f), "utf-8")); } catch (e) { return []; } }
function ssave(id, f, x) { fs.mkdirSync(path.join(SDIR, id), { recursive: true }); fs.writeFileSync(path.join(SDIR, id, f), JSON.stringify(x, null, 2)); }

// عند كل إقلاع: كل متجر مسجّل له رمز لوحة جاهز (1234) إذا ما فيه — الخطة المجانية تمسح البيانات مع كل نشر
function bootPins() {
  for (const s of listStores()) {
    const f = path.join(SDIR, s.id, "matjar-pin.json");
    try { const v = JSON.parse(fs.readFileSync(f, "utf-8")); if (v && v.pin) continue; } catch (e) {}
    fs.mkdirSync(path.join(SDIR, s.id), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ pin: s.pin || DEFAULT_PIN }));
  }
}

/* ---------- أرشيف الطلبيات المسلَّمة (ملف يومي، لكل متجر) ---------- */
const ammanDay = (d = new Date()) => new Date(d.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);
function archiveOrder(id, o, day) {
  const a0 = sload(id, "matjar-delivered.json");
  const a = (a0 && typeof a0 === "object" && !Array.isArray(a0) && Object.keys(a0).length) ? a0 : {};
  const k = day || ammanDay();
  if (!a[k]) a[k] = [];
  if (!a[k].some((x) => x.id === o.id)) {
    a[k].unshift({ ...o, deliveredAt: new Date().toISOString(), deliveredDay: k });
    ssave(id, "matjar-delivered.json", a);
  }
}

/* ---------- مسارات كل متجر: مثبتة تحت /s/:store ---------- */
const api = express.Router();

api.get("/v1/x/matjar-delivered", (req, res) => {
  const id = req.STORE.id;
  const a0 = sload(id, "matjar-delivered.json");
  const a = (a0 && typeof a0 === "object" && !Array.isArray(a0)) ? a0 : {};
  let changed = false;
  for (const o of sload(id, "matjar-orders.json")) {
    if (!["تم الاستلام", "سُلّمت"].includes(o.status || "")) continue;
    if (Object.values(a).some((arr) => arr.some((x) => x.id === o.id))) continue;
    const k = ammanDay();
    if (!a[k]) a[k] = [];
    a[k].unshift({ ...o, deliveredDay: k });
    changed = true;
  }
  if (changed) ssave(id, "matjar-delivered.json", a);
  res.json(a);
});

/* ---------- رقم صاحب الدكان (لكل متجر) ---------- */
const ownerPhone = (id) => {
  try { return sload(id, "matjar-phone.json").phone || ""; } catch (e) { return ""; }
};
const isStorePhone = (id, p) => {
  const cur = ownerPhone(id);
  const c = normPhone(p);
  return c === cur || c === cur.replace(/^0/, "962");
};
api.get("/v1/x/matjar-phone", (req, res) => res.json({ phone: ownerPhone(req.STORE.id) }));
api.post("/v1/x/matjar-phone-check", (req, res) => {
  try { res.json({ ok: String((req.body || {}).code || "").trim() === PHONE_SECRET }); }
  catch { res.status(400).json({ ok: false }); }
});
api.post("/v1/x/matjar-phone", (req, res) => {
  const id = req.STORE.id;
  // تغيير رقم الدكان محميّ بالرقم السري — لا يُقبل من دونها حتى لو فُتحت اللوحة
  if (String((req.body || {}).code || "").trim() !== PHONE_SECRET) return res.status(403).json({ error: "الرقم السري غلط أو ناقص" });
  try {
    const p = String((req.body || {}).phone || "").replace(/\D/g, "");
    if (!/^(07\d{8}|9627\d{8})$/.test(p)) return res.status(400).json({ error: "رقم أردني غير صالح — صيغته 07XXXXXXXX" });
    const clean = p.startsWith("962") ? "0" + p.slice(3) : p;
    ssave(id, "matjar-phone.json", { phone: clean });
    res.json({ ok: true, phone: clean });
  } catch { res.status(400).json({ error: "طلب غير صالح" }); }
});

/* ---------- رمز دخول لوحة المتجر (لكل متجر رمزه) ---------- */
const loadPin = (id) => {
  const v = sload(id, "matjar-pin.json");
  if (v && v.pin) return v;
  return { pin: DEFAULT_PIN };
};
api.get("/v1/x/matjar-pin", (req, res) => {
  const id = req.STORE.id;
  const phone = req.query.phone || "";
  if (!phone) return res.status(403).json({ error: "الرمز سري — التحقق من /v1/x/matjar-pin-check والاستعادة برقم المحل" });
  if (isStorePhone(id, phone)) return res.json({ pin: loadPin(id).pin });
  return res.status(403).json({ error: "الرقم ما هو رقم المحل" });
});
api.post("/v1/x/matjar-pin-check", (req, res) => {
  try { res.json({ ok: String((req.body || {}).pin || "").trim() === loadPin(req.STORE.id).pin }); }
  catch { res.status(400).json({ ok: false }); }
});
api.post("/v1/x/matjar-pin", (req, res) => {
  const id = req.STORE.id;
  try {
    const { phone, newPin } = req.body || {};
    if (!isStorePhone(id, phone)) return res.status(403).json({ error: "الرقم ما هو رقم المحل" });
    const pin = String(newPin || "").trim();
    if (pin.length < 4) return res.status(400).json({ error: "الرمز ٤ خانات على الأقل — أرقام وحروف ورموز" });
    ssave(id, "matjar-pin.json", { pin });
    res.json({ ok: true, pin });
  } catch { res.status(400).json({ error: "طلب غير صالح" }); }
});

/* ---------- الطلبيات (لكل متجر) ---------- */
api.get("/v1/x/matjar-orders", (req, res) => res.json(sload(req.STORE.id, "matjar-orders.json")));

api.post("/v1/x/matjar-orders", (req, res) => {
  const id = req.STORE.id;
  try {
    const order = { id: "o" + Date.now(), ...req.body };
    if (typeof order.total !== "number")
      order.total = (order.items || []).reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.qty) || 0), 0);
    const all = sload(id, "matjar-orders.json");
    all.unshift(order);
    ssave(id, "matjar-orders.json", all);
    res.status(201).json(order);
  } catch (e) { res.status(400).json({ error: "طلب غير صالح" }); }
});

api.patch("/v1/x/matjar-orders", (req, res) => {
  const id = req.STORE.id;
  const { id: orderId, status, fee, total } = req.body || {};
  if (!orderId || !status) return res.status(400).json({ error: "id وstatus مطلوبان" });
  const all = sload(id, "matjar-orders.json");
  const o = all.find((x) => x.id === orderId);
  if (!o) return res.status(404).json({ error: "الطلب غير موجود" });
  o.status = status;
  if (typeof fee === "number") o.fee = fee;
  if (typeof total === "number") o.total = total;
  ssave(id, "matjar-orders.json", all);
  if (["تم الاستلام", "سُلّمت"].includes(status)) archiveOrder(id, o);
  res.json(o);
});

api.delete("/v1/x/matjar-orders", (req, res) => {
  const id = req.STORE.id;
  const orderId = req.query.id;
  if (!orderId) return res.status(400).json({ error: "id مطلوب" });
  ssave(id, "matjar-orders.json", sload(id, "matjar-orders.json").filter((o) => o.id !== orderId));
  res.json({ ok: true });
});

/* ---------- المنتجات (كل متجر قائمته) ---------- */
api.get("/v1/x/matjar-products", (req, res) => res.json({ products: sload(req.STORE.id, "matjar-products.json") }));
api.post("/v1/x/matjar-products", (req, res) => {
  const p = req.body && req.body.products;
  if (!Array.isArray(p)) return res.status(400).json({ error: "products مطلوبة" });
  ssave(req.STORE.id, "matjar-products.json", p);
  res.json({ ok: true, count: p.length });
});

/* ---------- أرصدة الزبائن (لكل متجر) ---------- */
api.get("/v1/x/matjar-wallet", (req, res) => {
  const id = req.STORE.id;
  const all = sload(id, "matjar-wallet.json");
  const ph = normPhone(req.query.phone || "");
  if (ph) {
    const rows = all.filter((r) => normPhone(r.phone) === ph);
    const balance = rows.reduce((s, r) => s + (r.kind === "شحن" ? r.amount : -r.amount), 0);
    return res.json({ phone: ph, balance, history: rows.reverse() });
  }
  const map = {};
  for (const r of all) {
    const k = normPhone(r.phone);
    if (!k) continue;
    if (!map[k]) map[k] = { name: r.name || "", balance: 0, count: 0 };
    map[k].balance += r.kind === "شحن" ? r.amount : -r.amount;
    map[k].count++;
    if (r.name) map[k].name = r.name;
  }
  res.json(Object.entries(map).map(([phone, v]) => ({ phone, ...v })));
});
api.post("/v1/x/matjar-wallet", (req, res) => {
  const id = req.STORE.id;
  const b = req.body || {};
  const phone = normPhone(b.phone || "");
  const amount = Math.round(Number(b.amount) * 100) / 100;
  const kind = b.kind === "خصم" ? "خصم" : "شحن";
  if (!/^07\d{8}$/.test(phone)) return res.status(400).json({ error: "رقم موبايل غير صالح" });
  if (!amount || amount <= 0) return res.status(400).json({ error: "مبلغ غير صالح" });
  const row = { id: "w" + Date.now(), phone, name: (b.name || "").trim(), amount, kind, note: (b.note || "").trim(), at: new Date().toLocaleString("ar-JO") };
  const all = sload(id, "matjar-wallet.json"); all.push(row); ssave(id, "matjar-wallet.json", all);
  res.status(201).json(row);
});

/* ---------- رسائل الدكان للزبائن (لكل متجر) ---------- */
api.get("/v1/x/matjar-messages", (req, res) => {
  const id = req.STORE.id;
  const oid = (req.query.orderId || "").trim();
  const all = sload(id, "matjar-messages.json");
  res.json(oid ? all.filter((m) => m.orderId === oid) : all);
});
api.post("/v1/x/matjar-messages", (req, res) => {
  const id = req.STORE.id;
  const b = req.body || {};
  if (!b.orderId || !b.text) return res.status(400).json({ error: "orderId و text مطلوبان" });
  const row = { id: "m" + Date.now(), orderId: b.orderId, phone: normPhone(b.phone || "") || undefined, text: String(b.text), total: Number(b.total) || undefined, at: new Date().toLocaleString("ar-JO") };
  const all = sload(id, "matjar-messages.json"); all.push(row); ssave(id, "matjar-messages.json", all);
  res.status(201).json(row);
});

/* ---------- بلاطات الخارطة (مشتركة بين كل المتاجر) ---------- */
const UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
const mem = new Map();
async function grab(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error(String(r.status));
  const buf = Buffer.from(await r.arrayBuffer());
  return { buf, ct: r.headers.get("content-type") || "image/jpeg" };
}
function sendTile(res, got) {
  res.set("Content-Type", got.ct);
  res.set("Cache-Control", "public, max-age=86400");
  res.send(got.buf);
}
api.get("/v1/x/matjar-tiles", async (req, res) => {
  const clamp = (v, n) => Math.max(0, Math.min(n - 1, v));
  const z = Math.max(0, Math.min(20, parseInt(req.query.z) || 16));
  const n = Math.pow(2, z);
  const x = clamp(parseInt(req.query.x) || 0, n);
  const y = clamp(parseInt(req.query.y) || 0, n);
  const s = req.query.s === "m" ? "m" : "g";
  const fmt = req.query.fmt === "b64" ? "b64" : "bin";
  const key = `${s}/${z}/${x}/${y}`;
  const hit = mem.get(key);
  if (hit) {
    if (fmt === "b64") return res.json({ b64: hit.buf.toString("base64") });
    return sendTile(res, hit);
  }
  try {
    const got = await grab(`https://mt1.google.com/vt/lyrs=${s === "m" ? "m" : "y"}&hl=ar&x=${x}&y=${y}&z=${z}&s=Galileo`, { "User-Agent": UA });
    if (mem.size > 600) mem.clear();
    mem.set(key, got);
    if (fmt === "b64") return res.json({ b64: got.buf.toString("base64") });
    return sendTile(res, got);
  } catch (e) {
    try {
      const got = await grab(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`, { "User-Agent": "MatjarPlatform/1.0" });
      if (mem.size > 600) mem.clear();
      mem.set(key, got);
      if (fmt === "b64") return res.json({ b64: got.buf.toString("base64") });
      return sendTile(res, got);
    } catch (e2) {
      res.status(502).send("no tile");
    }
  }
});

/* ---------- تركيب مسارات المتاجر مع التحقق من وجود المتجر ---------- */
app.use("/s/:store", (req, res, next) => {
  const st = findStore(req.params.store);
  if (!st) return res.status(404).json({ error: "لا يوجد متجر بهذا الرابط" });
  req.STORE = st;
  next();
}, api);

/* ---------- إدارة المنصة: سجلّ المتاجر ---------- */
app.get("/v1/x/stores", (req, res) => res.json(listStores().map(({ id, name, note }) => ({ id, name, note }))));

app.post("/v1/x/stores", (req, res) => {
  const b = req.body || {};
  if (String(b.code || "").trim() !== MASTER_CODE) return res.status(403).json({ error: "رمز المنصة غلط أو ناقص" });
  const name = String(b.name || "").trim();
  if (!name || name.length > 60) return res.status(400).json({ error: "اكتب اسم المتجر (حتى ٦٠ حرفاً)" });
  let id = String(b.id || "").trim().toLowerCase().replace(/\s+/g, "-");
  if (!id) {
    // معرّف آلي: حروف إنكليزية قصيرة من الوقت — يُعدَّل لاحقاً إن أردت
    id = "s" + Date.now().toString(36);
  }
  if (!slugOk(id)) return res.status(400).json({ error: "معرّف الرابط: حروف إنكليزية صغيرة وأرقام وشرطة فقط (٢–٢٤ محرفاً)" });
  if (findStore(id)) return res.status(400).json({ error: "المعرّف مستعمل — اختر غيره" });
  const store = { id, name, note: String(b.note || "").trim().slice(0, 120) || undefined, createdAt: new Date().toISOString() };
  saveStores([...listStores(), store]);
  bootPins();
  res.status(201).json({ ok: true, store: { id, name }, link: "/s/" + id });
});

app.delete("/v1/x/stores", (req, res) => {
  if (String(req.query.code || "").trim() !== MASTER_CODE) return res.status(403).json({ error: "رمز المنصة غلط أو ناقص" });
  const id = req.query.id || "";
  if (!findStore(id)) return res.status(404).json({ error: "لا يوجد متجر بهذا المعرّف" });
  saveStores(listStores().filter((s) => s.id !== id));
  res.json({ ok: true, note: "سُجلت بيانات المتجر كما هي داخل data/stores — الحذف من السجلّ فقط" });
});

/* ---------- الصفحات: دفتر المتاجر + واجهة كل متجر مع حقن الجسر ---------- */
const PUBLIC = path.join(__dirname, "public");
const INDEX_RAW = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf-8");

function storeIndex(st) {
  let html = INDEX_RAW;
  const shim = `<script>
window.STORE_ID = ${JSON.stringify(st.id)};
window.STORE_NAME = ${JSON.stringify(st.name || "المتجر")};
window.vellum = {
  fetch: (url, opts) => fetch("/s/${st.id}" + url, opts),
  asset: (p) => fetch(p).then(r => r.blob()),
  notify: (m) => console.log("notify:", m)
};
</script>`;
  html = html.replace("<body>", "<body>" + shim);
  return html;
}

function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

function directoryPage() {
  const stores = listStores();
  const cards = stores.map((s) => `
    <a class="st-card" href="/s/${esc(s.id)}">
      <span class="st-ico">🏪</span>
      <span class="st-name">${esc(s.name)}</span>
      ${s.note ? `<span class="st-note">${esc(s.note)}</span>` : ""}
    </a>`).join("");
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>المتاجر</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { font-family: system-ui, sans-serif; background: #f6f1e7; min-height: 100vh; padding: 24px 16px; }
  h1 { text-align: center; color: #1b5e20; margin: 12px 0 4px; font-size: 22px; }
  p.sub { text-align: center; color: #6b6b5f; font-size: 13px; margin-bottom: 20px; }
  .wrap { max-width: 560px; margin: 0 auto; }
  .st-card { display: flex; flex-direction: column; gap: 2px; background: #fff; border: 1px solid #e2ddcf; border-radius: 14px; padding: 16px; margin-bottom: 12px; text-decoration: none; color: #222; box-shadow: 0 1px 4px rgba(0,0,0,.06); }
  .st-ico { font-size: 22px; }
  .st-name { font-weight: 700; font-size: 17px; color: #1b5e20; }
  .st-note { font-size: 13px; color: #777; }
  .empty { text-align: center; color: #888; padding: 30px 0; }
  details { background: #fff; border: 1px solid #e2ddcf; border-radius: 14px; padding: 14px 16px; margin-top: 26px; }
  summary { cursor: pointer; color: #1b5e20; font-weight: 700; font-size: 14px; }
  input { width: 100%; padding: 11px 12px; border: 1px solid #d8d2c2; border-radius: 10px; font-size: 15px; margin: 8px 0; font-family: inherit; }
  button { width: 100%; padding: 12px; background: #1b5e20; color: #fff; border: 0; border-radius: 10px; font-size: 15px; font-weight: 700; margin-top: 6px; font-family: inherit; }
  .msg { margin-top: 10px; font-size: 14px; text-align: center; min-height: 20px; }
  .ok { color: #1b5e20; font-weight: 700; } .err { color: #b00020; }
</style></head><body><div class="wrap">
<h1>🏪 المتاجر</h1>
<p class="sub">اختر المتجر — كل متجر له وصلته الخاصة</p>
${cards || '<div class="empty">ما انشر متاجر بعد</div>'}
<details>
  <summary>➕ تسجيل متجر جديد (لأصحاب المحلات)</summary>
  <input id="sname" placeholder="اسم المتجر — مثال: بقالة الأمل" />
  <input id="sid" dir="ltr" placeholder="معرّف الرابط (اختياري) — إنكليزي/أرقام، مثل: alamal" />
  <input id="scode" dir="ltr" placeholder="رمز المنصة — يُطلب مرة التسجيل" />
  <button onclick="reg()">تسجيل المتجر ✚</button>
  <div id="m" class="msg"></div>
</details>
</div>
<script>
async function reg() {
  const m = document.getElementById("m");
  m.className = "msg"; m.textContent = "جارٍ التسجيل…";
  try {
    const r = await fetch("/v1/x/stores", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: sname.value.trim(), id: sid.value.trim(), code: scode.value.trim() }) });
    const v = await r.json();
    if (r.ok && v.ok) {
      m.className = "msg ok";
      m.innerHTML = "تم تسجيل «" + sname.value.trim() + "」✓ — رابط المتجر: <a href='/s/" + v.store.id + "' style='font-weight:700'>/s/" + v.store.id + "</a> — انسخه وابعثه لصاحب المحل";
    } else { m.className = "msg err"; m.textContent = v.error || "ما نجح التسجيل"; }
  } catch (e) { m.className = "msg err"; m.textContent = "ما نجح الاتصال — تأكد من النت"; }
}
</script>
</body></html>`;
}

app.get("/", (req, res) => { res.set("Content-Type", "text/html; charset=utf-8"); res.set("Cache-Control", "no-cache"); res.send(directoryPage()); });

// واجهة المتجر: كل مسار /s/<id> يخدم الواجهة والجسر موصول بمتجره
app.get("/s/:store", (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8");
  res.set("Cache-Control", "no-cache");
  res.send(storeIndex(req.STORE));
});

app.use(express.static(PUBLIC, { index: false, maxAge: "1h" }));
// أي مسار غير معروف: لو كان تحت /s/<id> يرجع واجهة المتجر، وإلا الدفتر
app.use((req, res, next) => {
  const m = req.path.match(/^\/s\/([a-z0-9][a-z0-9-]{1,23})/);
  const st = m ? findStore(m[1]) : null;
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(st ? storeIndex(st) : directoryPage());
});

const PORT = process.env.PORT || 3000;
ensureData();
bootPins();
app.listen(PORT, () => console.log(`منصة المتاجر تعمل على المنفذ ${PORT} — المتاجر المسجلة: ${listStores().length}`));

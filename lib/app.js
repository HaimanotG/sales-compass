// Sales Compass — API logic shared by the local Bun server and Vercel functions.
import { all, get, run, ready, DEFAULT_TEMPLATE } from "./db.js";

const STATUSES = ["new", "enriched", "monitoring", "sent", "follow_up_1", "follow_up_2", "replied", "trial", "won", "dead"];

// ---- local-date helpers (all dates are local calendar dates, yyyy-mm-dd) ----
function fmt(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function todayLocal() {
  return fmt(new Date());
}
function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  return fmt(new Date(y, m - 1, d + n));
}

// ---- settings ----
async function getSettings() {
  const rows = await all("SELECT key, value FROM settings");
  const s = {};
  for (const r of rows) s[r.key] = r.value;
  let presets = {};
  try { presets = JSON.parse(s.competitor_presets || "{}"); } catch {}
  return {
    daily_target: Math.max(1, parseInt(s.daily_target, 10) || 10),
    vertical_focus: s.vertical_focus || "",
    price_mo: s.price_mo === "" || s.price_mo == null ? null : Number(s.price_mo),
    mrr_goal: Number(s.mrr_goal) || 300,
    copy_template: s.copy_template || DEFAULT_TEMPLATE,
    competitor_presets: presets,
  };
}

// ---- actions / streak ----
async function logAction(leadId, kind) {
  await run("INSERT INTO actions (lead_id, kind, date, created_at) VALUES (?, ?, ?, ?)",
    [leadId, kind, todayLocal(), new Date().toISOString()]);
}
async function actionsToday() {
  return (await get("SELECT COUNT(*) AS c FROM actions WHERE date = ?", [todayLocal()])).c;
}
async function computeStreak(target) {
  const rows = await all("SELECT date, COUNT(*) AS c FROM actions GROUP BY date");
  const met = new Set(rows.filter((r) => r.c >= target).map((r) => r.date));
  let day = todayLocal();
  if (!met.has(day)) day = addDays(day, -1); // streak may end today or yesterday
  let streak = 0;
  while (met.has(day)) {
    streak++;
    day = addDays(day, -1);
  }
  return streak;
}

// ---- leads ----
const LEAD_FIELDS = [
  "brand", "url", "vertical", "founder_name", "contact", "size_estimate", "source",
  "competitor_1", "competitor_2", "competitor_3", "monitoring_started_at",
  "pain_signal", "personalization_note", "status", "sent_at", "follow_up_due_at",
  "replied_at", "reply", "reply_sentiment", "deal_value_mo", "notes",
];

function getLead(id) {
  return get("SELECT * FROM leads WHERE id = ?", [id]);
}

async function currentMRR(settings) {
  const won = await all("SELECT deal_value_mo FROM leads WHERE status = 'won'");
  let sum = 0;
  for (const w of won) {
    const v = w.deal_value_mo != null ? Number(w.deal_value_mo) : settings.price_mo;
    sum += v || 0;
  }
  return sum;
}

async function createLead(body) {
  const brand = String(body.brand || "").trim();
  const vertical = String(body.vertical || "").trim().toLowerCase();
  if (!brand) throw new ApiError("brand is required");
  if (!vertical) throw new ApiError("vertical is required");
  const status = STATUSES.includes(body.status) ? body.status : "new";
  const lead = {
    brand, vertical, status,
    url: str(body.url), founder_name: str(body.founder_name), contact: str(body.contact),
    size_estimate: str(body.size_estimate), source: str(body.source),
    competitor_1: str(body.competitor_1), competitor_2: str(body.competitor_2), competitor_3: str(body.competitor_3),
    monitoring_started_at: dateOrNull(body.monitoring_started_at),
    pain_signal: str(body.pain_signal), personalization_note: str(body.personalization_note),
    sent_at: dateOrNull(body.sent_at), follow_up_due_at: dateOrNull(body.follow_up_due_at),
    replied_at: dateOrNull(body.replied_at), reply: str(body.reply),
    reply_sentiment: ["positive", "neutral", "negative"].includes(body.reply_sentiment) ? body.reply_sentiment : null,
    deal_value_mo: body.deal_value_mo === "" || body.deal_value_mo == null ? null : Number(body.deal_value_mo),
    notes: str(body.notes),
    created_at: body.created_at || new Date().toISOString(),
  };
  if (lead.status === "monitoring" && !lead.monitoring_started_at) lead.monitoring_started_at = todayLocal();
  const cols = Object.keys(lead);
  const placeholders = cols.map(() => "?").join(", ");
  const res = await run(`INSERT INTO leads (${cols.join(", ")}) VALUES (${placeholders})`, cols.map((c) => lead[c]));
  return getLead(res.lastInsertRowid);
}

function str(v) {
  return v == null ? "" : String(v).trim();
}
function dateOrNull(v) {
  const s = str(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

class ApiError extends Error {}

async function updateLead(id, body) {
  const lead = await getLead(id);
  if (!lead) throw new ApiError("lead not found");
  const updates = {};
  for (const f of LEAD_FIELDS) {
    if (!(f in body)) continue;
    let v = body[f];
    if (f === "brand" || f === "vertical") {
      v = String(v || "").trim();
      if (f === "vertical") v = v.toLowerCase();
      if (!v) throw new ApiError(`${f} is required`);
    } else if (f === "status") {
      if (!STATUSES.includes(v)) throw new ApiError("invalid status");
    } else if (["monitoring_started_at", "sent_at", "follow_up_due_at", "replied_at"].includes(f)) {
      v = dateOrNull(v);
    } else if (f === "deal_value_mo") {
      v = v === "" || v == null ? null : Number(v);
    } else if (f === "reply_sentiment") {
      v = ["positive", "neutral", "negative"].includes(v) ? v : null;
    } else {
      v = str(v);
    }
    updates[f] = v;
  }

  // status automation on manual edits
  if ("status" in updates && updates.status !== lead.status) {
    if (updates.status === "monitoring") {
      const started = "monitoring_started_at" in updates ? updates.monitoring_started_at : lead.monitoring_started_at;
      if (!started) updates.monitoring_started_at = todayLocal();
    }
    if (updates.status === "won" || updates.status === "dead") {
      await logAction(id, updates.status); // counts toward the daily target
    }
  }

  if (Object.keys(updates).length) {
    const setSql = Object.keys(updates).map((k) => `${k} = ?`).join(", ");
    await run(`UPDATE leads SET ${setSql} WHERE id = ?`, [...Object.values(updates), id]);
  }
  return getLead(id);
}

// ---- status automation transitions (the discipline engine) ----
async function transition(id, action, body = {}) {
  const lead = await getLead(id);
  if (!lead) throw new ApiError("lead not found");
  const today = todayLocal();

  if (action === "sent") {
    if (["sent", "follow_up_1", "follow_up_2", "replied", "trial", "won", "dead"].includes(lead.status)) {
      throw new ApiError(`cannot mark sent from status "${lead.status}"`);
    }
    await run("UPDATE leads SET status = 'sent', sent_at = ?, follow_up_due_at = ? WHERE id = ?",
      [today, addDays(today, 3), id]);
    await logAction(id, "sent");
  } else if (action === "follow_up") {
    if (lead.status === "sent") {
      await run("UPDATE leads SET status = 'follow_up_1', follow_up_due_at = ? WHERE id = ?",
        [addDays(today, 4), id]);
    } else if (lead.status === "follow_up_1") {
      await run("UPDATE leads SET status = 'follow_up_2', follow_up_due_at = NULL WHERE id = ?", [id]);
    } else {
      throw new ApiError(`cannot complete follow-up from status "${lead.status}"`);
    }
    await logAction(id, "follow_up");
  } else if (action === "reply") {
    if (!["sent", "follow_up_1", "follow_up_2"].includes(lead.status)) {
      throw new ApiError(`cannot log reply from status "${lead.status}"`);
    }
    await run("UPDATE leads SET status = 'replied', replied_at = ?, follow_up_due_at = NULL, reply = ?, reply_sentiment = ? WHERE id = ?",
      [today, str(body.reply), ["positive", "neutral", "negative"].includes(body.reply_sentiment) ? body.reply_sentiment : null, id]);
    await logAction(id, "reply");
  } else {
    throw new ApiError("unknown action");
  }
  return getLead(id);
}

// ---- CSV import (columns: brand, domain, vertical, size_estimate, source) ----
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\n") {
      row.push(field); field = "";
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

async function importCSV(csvText) {
  const rows = parseCSV(csvText);
  if (!rows.length) throw new ApiError("empty CSV");
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (name) => header.indexOf(name);
  if (idx("brand") === -1 || idx("vertical") === -1) {
    throw new ApiError("CSV must have a header row with at least: brand, vertical (plus optional domain, size_estimate, source)");
  }
  let imported = 0, skipped = 0;
  for (const r of rows.slice(1)) {
    const cell = (name) => (idx(name) === -1 ? "" : str(r[idx(name)]));
    const brand = cell("brand");
    const vertical = cell("vertical").toLowerCase();
    if (!brand || !vertical) { skipped++; continue; }
    await createLead({
      brand, vertical,
      url: cell("domain") || cell("url"),
      size_estimate: cell("size_estimate"),
      source: cell("source"),
      status: "new",
    });
    imported++;
  }
  return { imported, skipped };
}

// ---- state payload ----
async function statePayload() {
  const settings = await getSettings();
  return {
    today: todayLocal(),
    leads: await all("SELECT * FROM leads ORDER BY created_at ASC, id ASC"),
    settings,
    actions_today: await actionsToday(),
    streak: await computeStreak(settings.daily_target),
    mrr: await currentMRR(settings),
  };
}

// ---- API router (shared by Bun server and Vercel function) ----
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function handleApi(req) {
  const url = new URL(req.url);
  const path = url.pathname;
  try {
    await ready();

    if (path === "/api/state" && req.method === "GET") return json(await statePayload());

    if (path === "/api/leads" && req.method === "POST") {
      const lead = await createLead(await req.json());
      return json({ lead, state: await statePayload() });
    }

    const leadMatch = path.match(/^\/api\/leads\/(\d+)$/);
    if (leadMatch && req.method === "PATCH") {
      const lead = await updateLead(Number(leadMatch[1]), await req.json());
      return json({ lead, state: await statePayload() });
    }
    if (leadMatch && req.method === "DELETE") {
      await run("DELETE FROM leads WHERE id = ?", [Number(leadMatch[1])]);
      return json({ state: await statePayload() });
    }

    const transMatch = path.match(/^\/api\/leads\/(\d+)\/transition$/);
    if (transMatch && req.method === "POST") {
      const body = await req.json();
      const lead = await transition(Number(transMatch[1]), body.action, body);
      return json({ lead, state: await statePayload() });
    }

    if (path === "/api/settings" && req.method === "POST") {
      const body = await req.json();
      const allowed = ["daily_target", "vertical_focus", "price_mo", "mrr_goal", "copy_template", "competitor_presets"];
      for (const k of allowed) {
        if (!(k in body)) continue;
        let v = body[k];
        if (k === "competitor_presets" && typeof v !== "string") v = JSON.stringify(v);
        await run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          [k, String(v ?? "")]);
      }
      return json({ state: await statePayload() });
    }

    if (path === "/api/import" && req.method === "POST") {
      const body = await req.json();
      const result = await importCSV(String(body.csv || ""));
      return json({ ...result, state: await statePayload() });
    }

    return json({ error: "not found" }, 404);
  } catch (e) {
    if (e instanceof ApiError) return json({ error: e.message }, 400);
    console.error(e);
    return json({ error: "server error" }, 500);
  }
}

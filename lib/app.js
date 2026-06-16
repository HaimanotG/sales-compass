// Sales Compass — API logic shared by the local Bun server and Vercel functions.
import { all, get, run, ready, DEFAULT_TEMPLATE, SIGNAL_TEMPLATES } from "./db.js";

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
  let templates = [];
  try {
    const parsed = JSON.parse(s.copy_templates || "[]");
    if (Array.isArray(parsed)) {
      templates = parsed
        .filter((t) => t && typeof t.name === "string" && typeof t.text === "string" && t.name.trim() && t.text.trim())
        .map((t) => {
          const out = { name: t.name.trim(), text: t.text };
          if (typeof t.subject === "string" && t.subject.trim()) out.subject = t.subject.trim();
          return out;
        });
    }
  } catch {}
  // Ensure the built-in signal variants are always present, even on existing DBs
  // whose copy_templates predates them. A user variant of the same name wins.
  const userNames = new Set(templates.map((t) => t.name));
  for (const t of SIGNAL_TEMPLATES) {
    if (!userNames.has(t.name)) templates.push({ name: t.name, text: t.text, subject: t.subject });
  }
  return {
    daily_target: Math.max(1, parseInt(s.daily_target, 10) || 10),
    vertical_focus: s.vertical_focus || "",
    price_mo: s.price_mo === "" || s.price_mo == null ? null : Number(s.price_mo),
    mrr_goal: Number(s.mrr_goal) || 300,
    copy_template: s.copy_template || DEFAULT_TEMPLATE,
    copy_templates: templates,
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
  "competitor_1", "competitor_2", "competitor_3",
  "competitor_1_url", "competitor_2_url", "competitor_3_url", "competitor_urls_verified",
  "monitoring_started_at",
  "pain_signal", "personalization_note", "status", "sent_at", "follow_up_due_at",
  "replied_at", "reply", "reply_sentiment", "trial_started_at", "breakup_sent_at",
  "template_used", "deal_value_mo", "notes",
];
// Written only by the Beaconmon sync script (scripts/sync-events.js), never via the
// API, so they are deliberately absent from LEAD_FIELDS:
//   latest_competitor_change, latest_change_detected_at, last_event_synced_at

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
    competitor_1_url: normUrl(body.competitor_1_url), competitor_2_url: normUrl(body.competitor_2_url), competitor_3_url: normUrl(body.competitor_3_url),
    competitor_urls_verified: body.competitor_urls_verified === 1 || body.competitor_urls_verified === "1" || body.competitor_urls_verified === true ? 1 : 0,
    monitoring_started_at: dateOrNull(body.monitoring_started_at),
    pain_signal: str(body.pain_signal), personalization_note: str(body.personalization_note),
    sent_at: dateOrNull(body.sent_at), follow_up_due_at: dateOrNull(body.follow_up_due_at),
    replied_at: dateOrNull(body.replied_at), reply: str(body.reply),
    reply_sentiment: ["positive", "neutral", "negative"].includes(body.reply_sentiment) ? body.reply_sentiment : null,
    trial_started_at: dateOrNull(body.trial_started_at), breakup_sent_at: dateOrNull(body.breakup_sent_at),
    template_used: str(body.template_used),
    deal_value_mo: body.deal_value_mo === "" || body.deal_value_mo == null ? null : Number(body.deal_value_mo),
    notes: str(body.notes),
    created_at: body.created_at || new Date().toISOString(),
  };
  if (lead.status === "monitoring" && !lead.monitoring_started_at) lead.monitoring_started_at = todayLocal();
  if (lead.status === "trial" && !lead.trial_started_at) lead.trial_started_at = todayLocal();
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
    } else if (["monitoring_started_at", "sent_at", "follow_up_due_at", "replied_at", "trial_started_at", "breakup_sent_at"].includes(f)) {
      v = dateOrNull(v);
    } else if (f === "deal_value_mo") {
      v = v === "" || v == null ? null : Number(v);
    } else if (f === "reply_sentiment") {
      v = ["positive", "neutral", "negative"].includes(v) ? v : null;
    } else if (["competitor_1_url", "competitor_2_url", "competitor_3_url"].includes(f)) {
      v = normUrl(v); // store bare hostname so it matches Beaconmon competitor domains
    } else if (f === "competitor_urls_verified") {
      v = v === 1 || v === "1" || v === true ? 1 : 0;
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
    if (updates.status === "trial") {
      const started = "trial_started_at" in updates ? updates.trial_started_at : lead.trial_started_at;
      if (!started) updates.trial_started_at = todayLocal();
    }
    if (updates.status === "won" || updates.status === "dead") {
      if (!("follow_up_due_at" in updates)) updates.follow_up_due_at = null; // closed leads owe no follow-up
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
    const template = str(body.template) || lead.template_used || "default";
    // Cadence (days from each touch): first follow-up at +3, then +7, then +14,
    // then a +21 breakup window. Slower than the original 3/4/7/5 ramp.
    await run("UPDATE leads SET status = 'sent', sent_at = ?, follow_up_due_at = ?, template_used = ? WHERE id = ?",
      [today, addDays(today, 3), template, id]);
    await logAction(id, "sent");
  } else if (action === "follow_up") {
    if (lead.status === "sent") {
      await run("UPDATE leads SET status = 'follow_up_1', follow_up_due_at = ? WHERE id = ?",
        [addDays(today, 7), id]);
      await logAction(id, "follow_up");
    } else if (lead.status === "follow_up_1") {
      // follow-up 2 becomes due two weeks after follow-up 1
      await run("UPDATE leads SET status = 'follow_up_2', follow_up_due_at = ? WHERE id = ?",
        [addDays(today, 14), id]);
      await logAction(id, "follow_up");
    } else if (lead.status === "follow_up_2") {
      if (lead.breakup_sent_at) throw new ApiError("breakup already sent — log a reply or mark the lead dead");
      // last touch: give the breakup 21 days, then the queue suggests marking it dead
      await run("UPDATE leads SET breakup_sent_at = ?, follow_up_due_at = ? WHERE id = ?",
        [today, addDays(today, 21), id]);
      await logAction(id, "breakup");
    } else {
      throw new ApiError(`cannot complete follow-up from status "${lead.status}"`);
    }
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

function normBrand(s) {
  return String(s || "").trim().toLowerCase();
}
function normUrl(s) {
  return String(s || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
}

// Fields an existing-brand row may update. Workflow/status fields are excluded on
// purpose: a re-import must never touch where a lead sits in the pipeline.
const IMPORT_UPDATE_FIELDS = [
  "contact", "founder_name", "url", "size_estimate", "source",
  "competitor_1", "competitor_2", "competitor_3",
  "competitor_1_url", "competitor_2_url", "competitor_3_url", "competitor_urls_verified",
];

async function importCSV(csvText) {
  const rows = parseCSV(csvText);
  if (!rows.length) throw new ApiError("empty CSV");
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (name) => header.indexOf(name);
  if (idx("brand") === -1) {
    throw new ApiError("CSV must have a header row with at least: brand (plus optional vertical, domain/url/website, size_estimate, source, founder, contact, comp1, comp2, comp3)");
  }
  // Match existing leads by normalized brand so re-imports upsert instead of skip.
  // Load id plus every updatable column so a match can be diffed and updated in
  // place without overwriting unchanged values. url still guards new inserts.
  const existing = await all(`SELECT id, brand, url, contact, founder_name, size_estimate, source, competitor_1, competitor_2, competitor_3, competitor_1_url, competitor_2_url, competitor_3_url, competitor_urls_verified FROM leads`);
  const byBrand = new Map(existing.map((l) => [normBrand(l.brand), l]));
  const seenUrls = new Set(existing.map((l) => normUrl(l.url)).filter(Boolean));
  const seenInFile = new Set(); // within-CSV dedupe, so a brand twice in one file runs once
  let imported = 0, updated = 0, skipped = 0, duplicates = 0, missingVertical = 0;
  const looksLikeDomain = (v) => /^[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());
  for (const r of rows.slice(1)) {
    const cell = (name) => (idx(name) === -1 ? "" : str(r[idx(name)]));
    const brand = cell("brand");
    if (!brand) { skipped++; continue; }
    const nb = normBrand(brand);
    if (seenInFile.has(nb)) { duplicates++; continue; }
    seenInFile.add(nb);
    const vertical = cell("vertical").toLowerCase();
    const url = cell("domain") || cell("url") || cell("website");
    // competitor_N is the display label; competitor_N_url is the bare host that
    // matches Beaconmon. Fall back to the label when it is already a domain, so
    // CSVs that only carry resolved domains in competitor_N still seed the sync.
    const compName = (n) => cell(`competitor_${n}`) || cell(`comp${n}`);
    const compUrl = (n) => cell(`competitor_${n}_url`) || (looksLikeDomain(compName(n)) ? compName(n) : "");

    const match = byBrand.get(nb);
    if (match) {
      // Existing brand: update only the fields this row actually provides as
      // non-empty, so a blank CSV cell never wipes a stored value.
      const provided = {
        contact: cell("contact"),
        founder_name: cell("founder_name") || cell("founder"),
        url: normUrl(url),
        size_estimate: cell("size_estimate"),
        source: cell("source"),
        competitor_1: compName(1), competitor_2: compName(2), competitor_3: compName(3),
        competitor_1_url: compUrl(1), competitor_2_url: compUrl(2), competitor_3_url: compUrl(3),
        competitor_urls_verified: cell("competitor_urls_verified"),
      };
      const updates = {};
      for (const f of IMPORT_UPDATE_FIELDS) {
        const v = provided[f];
        if (v === "" || v == null) continue; // blank cell never overwrites
        if (f === "competitor_urls_verified") {
          const iv = v === "1" || v === 1 || v === true ? 1 : 0;
          if (iv !== (match[f] ?? 0)) updates[f] = iv;
        } else if (String(v) !== String(match[f] ?? "")) {
          updates[f] = v;
        }
      }
      if (Object.keys(updates).length) {
        const setSql = Object.keys(updates).map((k) => `${k} = ?`).join(", ");
        await run(`UPDATE leads SET ${setSql} WHERE id = ?`, [...Object.values(updates), match.id]);
        if (normUrl(updates.url)) seenUrls.add(normUrl(updates.url));
        updated++;
      } else {
        duplicates++; // matched but nothing to change
      }
      continue;
    }

    // New brand: insert. A new lead still requires vertical.
    if (!vertical) { skipped++; missingVertical++; continue; }
    if (normUrl(url) && seenUrls.has(normUrl(url))) { duplicates++; continue; }
    if (normUrl(url)) seenUrls.add(normUrl(url));
    const lead = await createLead({
      brand, vertical, url,
      size_estimate: cell("size_estimate"),
      source: cell("source"),
      founder_name: cell("founder_name") || cell("founder"),
      contact: cell("contact"),
      competitor_1: compName(1), competitor_2: compName(2), competitor_3: compName(3),
      competitor_1_url: compUrl(1), competitor_2_url: compUrl(2), competitor_3_url: compUrl(3),
      competitor_urls_verified: cell("competitor_urls_verified"),
      status: "new",
    });
    byBrand.set(nb, lead); // guards seenUrls update above; in-file dup already caught by seenInFile
    imported++;
  }
  return { imported, updated, skipped, duplicates, ...(missingVertical ? { missingVertical } : {}) };
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
      const allowed = ["daily_target", "vertical_focus", "price_mo", "mrr_goal", "copy_template", "copy_templates", "competitor_presets"];
      for (const k of allowed) {
        if (!(k in body)) continue;
        let v = body[k];
        if ((k === "competitor_presets" || k === "copy_templates") && typeof v !== "string") v = JSON.stringify(v);
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

    if (path === "/api/dedupe" && req.method === "POST") {
      // Keep the earliest-imported row for each normalized brand; delete the rest.
      const dupes = await all(`
        SELECT id FROM leads
        WHERE id NOT IN (
          SELECT MIN(id) FROM leads GROUP BY LOWER(TRIM(brand))
        )
      `);
      const count = dupes.length;
      if (count > 0) {
        const ids = dupes.map((r) => r.id);
        await run(`DELETE FROM leads WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
        await run(`DELETE FROM actions WHERE lead_id IN (${ids.map(() => "?").join(",")})`, ids);
      }
      return json({ removed: count, state: await statePayload() });
    }

    return json({ error: "not found" }, 404);
  } catch (e) {
    if (e instanceof ApiError) return json({ error: e.message }, 400);
    console.error(e);
    return json({ error: "server error" }, 500);
  }
}

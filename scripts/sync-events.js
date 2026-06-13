#!/usr/bin/env bun
// Pull fresh Beaconmon competitor_events for each monitoring lead's competitor domains and
// surface the newest change onto the lead (latest_competitor_change + timestamps). Bumps the
// lead into the "competitor change detected" Today tier. Never touches pain_signal or
// personalization_note. Idempotent via the per-lead last_event_synced_at watermark.
//
//   BEACONMON_DATABASE_URL=postgres://...  BEACONMON_TEAM_ID=...  bun scripts/sync-events.js
import { all, run, ready } from "../lib/db.js";
import pg from "pg";

const { Pool } = pg;

const DATABASE_URL = process.env.BEACONMON_DATABASE_URL;
const TEAM_ID = process.env.BEACONMON_TEAM_ID;
if (!DATABASE_URL || !TEAM_ID) {
  console.error("BEACONMON_DATABASE_URL and BEACONMON_TEAM_ID are required.");
  process.exit(1);
}

const SLOTS = [1, 2, 3];

function normHost(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
}

function money(v, currency) {
  if (v == null || v === "") return "";
  const n = Number(v);
  const amount = Number.isFinite(n) ? n.toFixed(2) : String(v);
  return currency && currency !== "USD" ? `${amount} ${currency}` : `$${amount}`;
}

// One-line human summary from a competitor_events row. Page-check events (the only kind our
// not_applicable single-page competitors produce) carry diffSummary when AI is on, else null.
function summarize(type, payload, domain) {
  const p = payload || {};
  switch (type) {
    case "price_changed":
      return `${domain}: price ${money(p.oldPrice, p.currency)} -> ${money(p.newPrice, p.currency)}`.trim();
    case "promo_detected":
    case "sale_started":
      return p.diffSummary ? `${domain}: ${p.diffSummary}` : `${domain}: promo / pricing change detected`;
    case "sale_ended":
      return `${domain}: sale ended`;
    case "product_added":
      return p.title ? `${domain}: new product — ${p.title}` : `${domain}: new product added`;
    case "product_removed":
      return p.title ? `${domain}: product removed — ${p.title}` : `${domain}: product removed`;
    case "out_of_stock":
      return p.productHandle ? `${domain}: out of stock — ${p.productHandle}` : `${domain}: product out of stock`;
    case "back_in_stock":
      return p.productHandle ? `${domain}: back in stock — ${p.productHandle}` : `${domain}: product back in stock`;
    case "stock_changed":
      return `${domain}: stock changed`;
    case "site_changed":
      return p.diffSummary ? `${domain}: ${p.diffSummary}` : `${domain}: content changed`;
    default:
      return `${domain}: ${String(type).replace(/_/g, " ")}`;
  }
}

async function main() {
  await ready();
  const leads = await all(`
    SELECT * FROM leads
    WHERE status = 'monitoring' AND competitor_urls_verified = 1
      AND (IFNULL(competitor_1_url, '') <> ''
        OR IFNULL(competitor_2_url, '') <> ''
        OR IFNULL(competitor_3_url, '') <> '')
  `);
  if (!leads.length) {
    console.log("No monitoring leads with verified competitor URLs. Nothing to sync.");
    return;
  }

  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();
  let updated = 0;
  try {
    // domain -> competitor ids in this team (one query, reused across all leads)
    const compRows = await client.query(
      `SELECT id, lower(domain) AS domain FROM competitors WHERE team_id = $1 AND deleted_at IS NULL`,
      [TEAM_ID]
    );
    const domainToCompIds = new Map();
    for (const r of compRows.rows) {
      if (!domainToCompIds.has(r.domain)) domainToCompIds.set(r.domain, []);
      domainToCompIds.get(r.domain).push(r.id);
    }

    for (const lead of leads) {
      const compIds = [];
      const compIdToDomain = new Map();
      for (const n of SLOTS) {
        const host = normHost(lead[`competitor_${n}_url`]);
        if (!host) continue;
        for (const id of domainToCompIds.get(host) || []) {
          compIds.push(id);
          compIdToDomain.set(id, host);
        }
      }
      if (!compIds.length) continue;

      // detected_at is timestamp(3) WITHOUT time zone (UTC wall time); render it as a clean
      // UTC ISO string in SQL to dodge node-pg's local-time parsing of bare timestamps.
      const watermark = lead.last_event_synced_at || "1970-01-01T00:00:00.000Z";
      const evRes = await client.query(
        `SELECT competitor_id, type, payload,
                to_char(detected_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS detected_iso
         FROM competitor_events
         WHERE team_id = $1 AND competitor_id = ANY($2::text[]) AND detected_at > $3::timestamp
         ORDER BY detected_at DESC
         LIMIT 1`,
        [TEAM_ID, compIds, watermark]
      );
      if (!evRes.rowCount) continue;

      const ev = evRes.rows[0];
      const domain = compIdToDomain.get(ev.competitor_id) || "competitor";
      const summary = summarize(ev.type, ev.payload, domain);

      await run(
        `UPDATE leads
         SET latest_competitor_change = ?, latest_change_detected_at = ?, last_event_synced_at = ?
         WHERE id = ?`,
        [summary, ev.detected_iso, ev.detected_iso, lead.id]
      );
      updated++;
      console.log(`  ${lead.brand}: ${summary} (${ev.detected_iso})`);
    }
  } finally {
    client.release();
    await pool.end();
  }
  console.log(`Done. Updated ${updated} lead(s).`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});

#!/usr/bin/env bun
// Generate the "competitor snapshot" conversion asset for one lead — the deliverable
// sent when a prospect replies "yes, send it" to the cold-email offer. Pulls every
// usable competitor change (same noise filter as sync-events) over a recent window,
// grouped by competitor and ordered by significance, then renders the snapshot-template
// skeleton with the factual dated bullets filled in. The founder fills the one-line
// "short version" and each "Why it matters" before sending (these are human judgment in
// the prospect's language, not something to fabricate).
//
//   BEACONMON_DATABASE_URL=postgres://...  BEACONMON_TEAM_ID=...  \
//     bun scripts/full-report.js "Endura Flap" [--days 7] [--max 6]
import { all, ready } from "../lib/db.js";
import { USABLE_EVENT_SQL, normHost, describeChange, priceMovePct } from "../lib/competitor-events.js";
import pg from "pg";

const { Pool } = pg;

const DATABASE_URL = process.env.BEACONMON_DATABASE_URL;
const TEAM_ID = process.env.BEACONMON_TEAM_ID;
if (!DATABASE_URL || !TEAM_ID) {
  console.error("BEACONMON_DATABASE_URL and BEACONMON_TEAM_ID are required.");
  process.exit(1);
}

const SLOTS = [1, 2, 3];

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DAYS = Number(arg("--days", "7"));
const MAX_PER_COMPETITOR = Number(arg("--max", "6"));
// The brand is the positional args (everything that is not a flag or flag value).
const BRAND = process.argv
  .slice(2)
  .filter((a, i, arr) => !a.startsWith("--") && (i === 0 || arr[i - 1] !== "--days") && arr[i - 1] !== "--max")
  .join(" ")
  .trim();

if (!BRAND) {
  console.error('Usage: bun scripts/full-report.js "Brand Name" [--days 7] [--max 6]');
  process.exit(1);
}

function firstName(founder) {
  return String(founder || "").trim().split(/\s+/)[0] || "there";
}

function fmtDate(iso) {
  // iso like 2026-06-11T... -> "June 11"
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

function dateRange(days) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const f = (d) => d.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
  return `${f(start)} to ${f(end)}, ${end.getUTCFullYear()}`;
}

async function main() {
  await ready();
  const matches = await all(
    `SELECT * FROM leads WHERE lower(brand) = lower(?) LIMIT 5`,
    [BRAND]
  );
  if (!matches.length) {
    console.error(`No lead found with brand "${BRAND}".`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`Multiple leads match "${BRAND}": ${matches.map((m) => `#${m.id}`).join(", ")}. Be more specific.`);
    process.exit(1);
  }
  const lead = matches[0];

  // domain -> display label (the operator-entered competitor name, falling back to domain)
  const domains = [];
  const domainLabel = new Map();
  for (const n of SLOTS) {
    const host = normHost(lead[`competitor_${n}_url`]);
    if (!host) continue;
    domains.push(host);
    domainLabel.set(host, (lead[`competitor_${n}`] || host).trim());
  }
  if (!domains.length) {
    console.error(`Lead "${lead.brand}" has no competitor URLs set.`);
    process.exit(1);
  }

  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();
  const byDomain = new Map(); // domain -> [{date, type, payload, significance}]
  try {
    const compRows = await client.query(
      `SELECT id, lower(domain) AS domain FROM competitors WHERE team_id = $1 AND deleted_at IS NULL AND lower(domain) = ANY($2::text[])`,
      [TEAM_ID, domains]
    );
    const idToDomain = new Map(compRows.rows.map((r) => [r.id, r.domain]));
    if (!idToDomain.size) {
      console.error(`None of this lead's competitors (${domains.join(", ")}) are seeded in Beaconmon yet.`);
      process.exit(1);
    }

    // All usable events in the window, most significant + most recent first. significance
    // ordering: high > medium > null. Cap per competitor is applied after grouping.
    const evRes = await client.query(
      `SELECT competitor_id, type, payload,
              to_char(detected_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS detected_iso
       FROM competitor_events
       WHERE team_id = $1 AND competitor_id = ANY($2::text[])
         AND detected_at >= now() - ($3 || ' days')::interval
         AND ${USABLE_EVENT_SQL}
       ORDER BY (CASE significance WHEN 'high' THEN 2 WHEN 'medium' THEN 1 ELSE 0 END) DESC,
                detected_at DESC`,
      [TEAM_ID, [...idToDomain.keys()], String(DAYS)]
    );
    for (const r of evRes.rows) {
      const dom = idToDomain.get(r.competitor_id);
      if (!byDomain.has(dom)) byDomain.set(dom, []);
      byDomain.get(dom).push(r);
    }
  } finally {
    client.release();
    await pool.end();
  }

  // ---- Render the snapshot skeleton ----
  const out = [];
  out.push(`**${lead.brand} competitor snapshot. Week of ${dateRange(DAYS)}.**`);
  out.push("");
  out.push(`Hi ${firstName(lead.founder_name)}, here is what your competitors did this week. I pulled this by hand so you can see what Beaconmon watches for you.`);
  out.push("");
  out.push(`**The short version:** [FILL IN: lead with the single biggest move, the price drop or the promo below.]`);
  out.push("");
  out.push("---");

  let totalEvents = 0;
  // Render competitors in the order they were entered on the lead, skipping silent ones.
  for (const host of domains) {
    const events = (byDomain.get(host) || []).slice(0, MAX_PER_COMPETITOR);
    if (!events.length) continue;
    out.push("");
    out.push(`**${domainLabel.get(host)}**`);
    out.push("");
    for (const e of events) {
      totalEvents++;
      // AI diffSummaries already end in sentence punctuation; only add a period if missing.
      const change = describeChange(e.type, e.payload).trim();
      const dot = /[.!?]$/.test(change) ? "" : ".";
      out.push(`- ${fmtDate(e.detected_iso)}: ${change}${dot}`);
      out.push(`  Why it matters: [FILL IN: one sentence, in their language, about their revenue or shopper.]`);
    }
  }

  out.push("");
  out.push("---");
  out.push("");
  const named = domains.map((h) => domainLabel.get(h)).join(", ");
  out.push(`**This took me about an hour to compile.** Beaconmon does it automatically and drops it in your inbox every morning, the day each change happens, not a week later. Want me to switch on live tracking for ${named} so this lands for you every day? It takes two minutes to start and the first week is free.`);
  out.push("");
  out.push("Haimanot");

  if (totalEvents === 0) {
    console.error(`No usable competitor events for "${lead.brand}" in the last ${DAYS} days. Try a wider --days window.`);
    process.exit(2);
  }

  console.log(out.join("\n"));
  console.error(`\n[generated from ${totalEvents} usable events across ${[...byDomain.keys()].filter((d) => (byDomain.get(d) || []).length).length} competitor(s), last ${DAYS} days]`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});

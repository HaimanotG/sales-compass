#!/usr/bin/env bun
// Seed verified competitor domains into Beaconmon as single-page, daily-interval
// competitors. Reads Sales Compass leads (Turso/local via lib/db.js) and writes to
// Beaconmon Postgres (pg). Idempotent: domains already present in the team are skipped.
//
//   BEACONMON_DATABASE_URL=postgres://...  BEACONMON_TEAM_ID=...  bun scripts/seed-beaconmon.js
//
// Load-safety choices baked in (see the integration plan): discovery_state='not_applicable'
// (no Shopify catalog sync), a single homepage per competitor, interval_seconds=86400
// (daily), and next_check_at jittered across the next 24h to avoid a thundering herd.
import { all, ready } from "../lib/db.js";
import pg from "pg";

const { Pool } = pg;

const DATABASE_URL = process.env.BEACONMON_DATABASE_URL;
const TEAM_ID = process.env.BEACONMON_TEAM_ID;
if (!DATABASE_URL || !TEAM_ID) {
  console.error("BEACONMON_DATABASE_URL and BEACONMON_TEAM_ID are required.");
  process.exit(1);
}

const SLOTS = [1, 2, 3];
const DAY_SECONDS = 86400;

// Prisma @default(cuid()) is generated in the app layer, so raw SQL inserts must supply
// an id. Any collision-resistant string works for a PK/FK we own; this is cuid-shaped.
function cuid() {
  const ts = Date.now().toString(36);
  const rand = Array.from({ length: 18 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
  return `c${ts}${rand}`.slice(0, 25);
}

function normHost(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
}

async function main() {
  await ready();
  const leads = await all(`
    SELECT competitor_1, competitor_2, competitor_3,
           competitor_1_url, competitor_2_url, competitor_3_url
    FROM leads
    WHERE competitor_urls_verified = 1
  `);

  // Dedupe by domain. First competitor name seen for a domain becomes its Beaconmon name.
  const domainName = new Map();
  for (const lead of leads) {
    for (const n of SLOTS) {
      const host = normHost(lead[`competitor_${n}_url`]);
      if (!host) continue;
      if (!domainName.has(host)) {
        const name = String(lead[`competitor_${n}`] || "").trim() || host;
        domainName.set(host, name);
      }
    }
  }

  if (!domainName.size) {
    console.log("No verified competitor domains to seed. Confirm some leads first.");
    return;
  }

  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();
  let created = 0;
  let skipped = 0;
  try {
    for (const [domain, name] of domainName) {
      const existing = await client.query(
        `SELECT id FROM competitors WHERE team_id = $1 AND lower(domain) = $2 AND deleted_at IS NULL LIMIT 1`,
        [TEAM_ID, domain]
      );
      if (existing.rowCount > 0) {
        skipped++;
        continue;
      }

      const competitorId = cuid();
      const pageId = cuid();
      // Jitter the first check uniformly across the next 24h (anti-thundering-herd).
      const nextCheckAt = new Date(Date.now() + Math.floor(Math.random() * DAY_SECONDS) * 1000);

      await client.query("BEGIN");
      try {
        await client.query(
          `INSERT INTO competitors (id, team_id, name, domain, platform, discovery_state, is_active, updated_at)
           VALUES ($1, $2, $3, $4, 'other', 'not_applicable', true, now())`,
          [competitorId, TEAM_ID, name, domain]
        );
        await client.query(
          `INSERT INTO competitor_pages (id, competitor_id, team_id, label, url, interval_seconds, is_active, next_check_at, updated_at)
           VALUES ($1, $2, $3, 'Home', $4, $5, true, $6, now())`,
          [pageId, competitorId, TEAM_ID, `https://${domain}/`, DAY_SECONDS, nextCheckAt]
        );
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
      created++;
      console.log(`  seeded ${domain} (competitor ${competitorId}, next check ${nextCheckAt.toISOString()})`);
    }
  } finally {
    client.release();
    await pool.end();
  }
  console.log(`Done. Seeded ${created} new competitor(s); skipped ${skipped} already present.`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});

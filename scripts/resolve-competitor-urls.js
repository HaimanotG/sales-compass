#!/usr/bin/env bun
// Resolve free-text competitor names -> candidate domains via Brave Search.
// Writes competitor_N_url and leaves competitor_urls_verified = 0; the operator
// confirms the candidates in the lead editor (unverified badge) before seeding.
//
//   BRAVE_API_KEY=...  bun scripts/resolve-competitor-urls.js
//
// Accuracy is imperfect by design — the manual confirm pass is the safety net.
import { all, run, ready } from "../lib/db.js";

const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
if (!BRAVE_API_KEY) {
  console.error("BRAVE_API_KEY is required. Create one at https://brave.com/search/api/");
  process.exit(1);
}

const SLOTS = [1, 2, 3];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hostnameFromUrl(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

// Top organic result's hostname for a brand-name query. Returns "" on miss/failure.
async function braveTopHostname(query, retried = false) {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", "5");
  const res = await fetch(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": BRAVE_API_KEY },
  });
  if (res.status === 429 && !retried) {
    // Free tier is roughly 1 query/sec — back off once and retry.
    await sleep(1500);
    return braveTopHostname(query, true);
  }
  if (!res.ok) {
    console.warn(`  brave search failed (${res.status}) for "${query}"`);
    return "";
  }
  const data = await res.json();
  const first = data?.web?.results?.[0]?.url;
  return first ? hostnameFromUrl(first) : "";
}

async function main() {
  await ready();
  // Leads with a competitor name in some slot but no resolved URL for that slot yet.
  const leads = await all(`
    SELECT * FROM leads
    WHERE (competitor_1 <> '' AND IFNULL(competitor_1_url, '') = '')
       OR (competitor_2 <> '' AND IFNULL(competitor_2_url, '') = '')
       OR (competitor_3 <> '' AND IFNULL(competitor_3_url, '') = '')
  `);
  if (!leads.length) {
    console.log("No competitor names awaiting resolution. Nothing to do.");
    return;
  }

  console.log(`Resolving competitor domains for ${leads.length} lead(s)...`);
  let resolved = 0;
  for (const lead of leads) {
    const updates = {};
    for (const n of SLOTS) {
      const name = String(lead[`competitor_${n}`] || "").trim();
      const existing = String(lead[`competitor_${n}_url`] || "").trim();
      if (!name || existing) continue;
      const host = await braveTopHostname(name);
      await sleep(1100); // gentle pacing for the free tier (~1 req/s)
      if (host) {
        updates[`competitor_${n}_url`] = host;
        resolved++;
        console.log(`  ${lead.brand}: ${name} -> ${host}`);
      } else {
        console.log(`  ${lead.brand}: ${name} -> (no result)`);
      }
    }
    if (Object.keys(updates).length) {
      updates.competitor_urls_verified = 0; // newly resolved URLs always need a confirm
      const setSql = Object.keys(updates).map((k) => `${k} = ?`).join(", ");
      await run(`UPDATE leads SET ${setSql} WHERE id = ?`, [...Object.values(updates), lead.id]);
    }
  }
  console.log(
    `Done. Resolved ${resolved} domain(s). Confirm them in the lead editor (unverified badge), then run seed-beaconmon.`
  );
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});

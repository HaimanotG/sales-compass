#!/usr/bin/env bun
// Mark one or more leads as sent after a manual Zoho send. Thin CLI wrapper over the
// same transition('sent') the UI uses (status='sent', sent_at=today, follow_up_due_at
// at +3, template_used, plus the actions streak-log), so the cadence and streak can
// never drift from the app path. Identify a lead by its brand OR its founder name,
// exactly as they appear in the skill's outreach/drafts/*.md table, so you can copy
// either column. Leads-only: reads Turso from .env.local, no SSH tunnel needed.
//
//   bun scripts/mark-sent.js "Arrae" "Siff Haider" [--template "name"] [--dry-run]
import { all, ready } from "../lib/db.js";
import { transition } from "../lib/app.js";

const DRY_RUN = process.argv.includes("--dry-run");

function flagValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const TEMPLATE = flagValue("--template");

// Positional args = every token that is not a flag or a flag's value.
const names = process.argv.slice(2).filter((a, i, arr) => {
  if (a.startsWith("--")) return false;
  if (arr[i - 1] === "--template") return false;
  return true;
});

if (!names.length) {
  console.error('Usage: bun scripts/mark-sent.js "Brand or Founder" [more...] [--template "name"] [--dry-run]');
  process.exit(1);
}

// Statuses you cannot mark sent from. Mirrors the guard inside transition('sent') in
// lib/app.js; checked here first so dry-run can preview and a real run reports a clean
// "skipped" instead of throwing. A lead is sendable only from new/enriched/monitoring.
const ALREADY_PROGRESSED = ["sent", "follow_up_1", "follow_up_2", "replied", "trial", "won", "dead"];

async function resolveLead(name) {
  const key = name.trim().toLowerCase();
  // Match on brand OR founder name; bound params (Turso reads double quotes as identifiers).
  return all(
    `SELECT id, brand, founder_name, status, sent_at FROM leads
     WHERE lower(brand) = ? OR lower(trim(founder_name)) = ?`,
    [key, key]
  );
}

function describe(lead) {
  return `${lead.brand}${lead.founder_name ? ` (${lead.founder_name})` : ""} #${lead.id}`;
}

async function main() {
  await ready();
  const results = [];

  for (const name of names) {
    const rows = await resolveLead(name);

    if (rows.length === 0) {
      results.push({ label: name, outcome: "NOT FOUND (no brand or founder matches)" });
      continue;
    }
    if (rows.length > 1) {
      results.push({ label: name, outcome: `AMBIGUOUS: ${rows.map(describe).join(", ")}` });
      continue;
    }

    const lead = rows[0];
    const label = describe(lead);

    if (ALREADY_PROGRESSED.includes(lead.status)) {
      results.push({ label, outcome: `skipped (already ${lead.status}${lead.sent_at ? `, sent ${lead.sent_at}` : ""})` });
      continue;
    }
    if (DRY_RUN) {
      results.push({ label, outcome: "[dry] would mark sent" });
      continue;
    }
    try {
      await transition(lead.id, "sent", TEMPLATE ? { template: TEMPLATE } : {});
      results.push({ label, outcome: "marked sent", marked: true });
    } catch (e) {
      results.push({ label, outcome: `ERROR: ${e.message}` });
    }
  }

  for (const r of results) console.log(`  ${r.label}: ${r.outcome}`);
  const marked = results.filter((r) => r.marked).length;
  console.log(
    `\n${DRY_RUN ? "Dry run." : "Done."} ${marked} marked sent, ${results.length - marked} skipped/unmatched.${DRY_RUN ? " (no writes)" : ""}`
  );
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});

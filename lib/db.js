// Data layer: Turso (libSQL) when TURSO_DATABASE_URL is set, local file otherwise.
const remoteUrl = process.env.TURSO_DATABASE_URL || "";
// COMPASS_DB_FILE overrides the local sqlite path (used by tests). Ignored when a
// remote Turso URL is set, so production is never affected.
const localFile = process.env.COMPASS_DB_FILE || new URL("../compass.db", import.meta.url).pathname;
const url = remoteUrl || `file:${localFile}`;

// The web client is pure fetch (no native binding) — use it for remote DBs so
// serverless deploys don't need the platform-specific libsql binary.
const { createClient } = remoteUrl
  ? await import("@libsql/client/web")
  : await import("@libsql/client");

const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand TEXT NOT NULL,
  url TEXT DEFAULT '',
  vertical TEXT NOT NULL,
  founder_name TEXT DEFAULT '',
  contact TEXT DEFAULT '',
  size_estimate TEXT DEFAULT '',
  source TEXT DEFAULT '',
  competitor_1 TEXT DEFAULT '',
  competitor_2 TEXT DEFAULT '',
  competitor_3 TEXT DEFAULT '',
  competitor_1_url TEXT DEFAULT '',
  competitor_2_url TEXT DEFAULT '',
  competitor_3_url TEXT DEFAULT '',
  competitor_urls_verified INTEGER DEFAULT 0,
  latest_competitor_change TEXT DEFAULT '',
  latest_change_detected_at TEXT,
  last_event_synced_at TEXT,
  monitoring_started_at TEXT,
  pain_signal TEXT DEFAULT '',
  personalization_note TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  sent_at TEXT,
  follow_up_due_at TEXT,
  replied_at TEXT,
  reply TEXT DEFAULT '',
  reply_sentiment TEXT,
  trial_started_at TEXT,
  breakup_sent_at TEXT,
  template_used TEXT DEFAULT '',
  deal_value_mo REAL,
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER,
  kind TEXT NOT NULL,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Founder-to-founder default — works without competitor event data; uses only
// competitor_1/competitor_2 which are common on every lead.
export const DEFAULT_TEMPLATE = [
  "Hi {founder_first},",
  "I'm the founder of Beaconmon. I've been monitoring {competitor_1} and {competitor_2} and have a week's worth of changes—stockouts, pricing moves, and new launches.",
  "Thought it might be useful before I offered this to anyone else in the space.",
  "Happy to send it over. No pitch, just the data.\n\nHaimanot",
].join("\n\n");

// Signal-typed variants that lead with the synced competitor change. Each carries
// its own short, internal-looking subject and a body. The opener is a bracketed
// hand-finish hook holding the parsed raw material ({change_competitor} and
// {change_detail}, both derived from latest_competitor_change in renderTemplate):
// the sender always rewrites one human sentence, but never has to look up data.
// Empty slots render away cleanly via renderTemplate().
// These always reflect the latest code version — see getSettings() merge logic.
export const SIGNAL_TEMPLATES = [
  {
    name: "stockout — demand window",
    subject: "{change_competitor} out of stock",
    text: [
      "Hi {founder_first},",
      "[hook, rewrite into one human line: {change_competitor} {change_detail}]. That's usually a 3–5 day window where their search traffic and social mentions don't have anywhere to go.",
      "I'm monitoring {competitor_1}, {competitor_2}, and {competitor_3} in near real-time for Shopify brands like yours. Happy to send over what moved this week.",
      "Worth a look?\n\nHaimanot\nBeaconmon",
    ].join("\n\n"),
  },
  {
    name: "weekly brief",
    subject: "what changed on {competitor_1} this week",
    text: [
      "Hi {founder_first},",
      "[hook, rewrite into 2–3 lines: this week on {change_competitor} — {change_detail}]",
      "I built Beaconmon to surface exactly this—competitor stockouts, pricing moves, promos, and launches—for Shopify brands tracking their market.",
      "Want me to send the full summary?\n\nHaimanot\nBeaconmon",
    ].join("\n\n"),
  },
  {
    name: "founder to founder",
    subject: "built a monitor for {brand}",
    text: [
      "Hi {founder_first},",
      "I'm the founder of Beaconmon. I've been monitoring {competitor_1} and {competitor_2} and have a week's worth of changes—stockouts, pricing moves, and new launches.",
      "Thought it might be useful before I offered this to anyone else in the space.",
      "Happy to send it over. No pitch, just the data.\n\nHaimanot",
    ].join("\n\n"),
  },
  {
    name: "pricing drop",
    subject: "{change_competitor} price drop",
    text: [
      "Hi {founder_first},",
      "[hook, rewrite into one human line: {change_competitor} {change_detail}]",
      "I track pricing moves like this across {competitor_1}, {competitor_2}, and {competitor_3} for Shopify brands in your space.",
      "Worth knowing if your own pricing is still competitive?\n\nHaimanot\nBeaconmon",
    ].join("\n\n"),
  },
  {
    name: "OOS — lost demand",
    subject: "{change_competitor} went OOS",
    text: [
      "Hi {founder_first},",
      "[hook, rewrite into one human line: {change_competitor} {change_detail}]. When that happens, their customers are searching—and landing somewhere.",
      "Knowing the exact moment a competitor goes out of stock is what separates brands that capture that demand from the ones that find out a week later.",
      "I'm monitoring this for you. Want the weekly summary?\n\nHaimanot\nBeaconmon",
    ].join("\n\n"),
  },
];

export const DEFAULT_SETTINGS = {
  daily_target: "10",
  vertical_focus: "",
  price_mo: "",
  mrr_goal: "300",
  copy_template: DEFAULT_TEMPLATE,
  copy_templates: JSON.stringify(SIGNAL_TEMPLATES), // extra named variants: [{ name, text, subject? }]
  competitor_presets: "{}", // { vertical: [c1, c2, c3] }
};

// Columns added after the first release; ALTER is a no-op error on DBs that already have them.
const MIGRATIONS = [
  "ALTER TABLE leads ADD COLUMN trial_started_at TEXT",
  "ALTER TABLE leads ADD COLUMN breakup_sent_at TEXT",
  "ALTER TABLE leads ADD COLUMN template_used TEXT DEFAULT ''",
  // Beaconmon competitor-change integration: resolved competitor domains, a
  // confirm flag, and the surfaced latest change + per-lead sync watermark.
  "ALTER TABLE leads ADD COLUMN competitor_1_url TEXT DEFAULT ''",
  "ALTER TABLE leads ADD COLUMN competitor_2_url TEXT DEFAULT ''",
  "ALTER TABLE leads ADD COLUMN competitor_3_url TEXT DEFAULT ''",
  "ALTER TABLE leads ADD COLUMN competitor_urls_verified INTEGER DEFAULT 0",
  "ALTER TABLE leads ADD COLUMN latest_competitor_change TEXT DEFAULT ''",
  "ALTER TABLE leads ADD COLUMN latest_change_detected_at TEXT",
  "ALTER TABLE leads ADD COLUMN last_event_synced_at TEXT",
];

let readyPromise = null;
export function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      // Use batch() instead of executeMultiple(): @libsql/client/web (the Turso/Vercel path) does not expose executeMultiple().
      const schemaSqls = SCHEMA.split(";").map((s) => s.trim()).filter(Boolean);
      await client.batch(schemaSqls.map((sql) => ({ sql, args: [] })), "write");
      for (const sql of MIGRATIONS) {
        try { await client.execute(sql); } catch { /* column already exists */ }
      }
      await client.batch(
        Object.entries(DEFAULT_SETTINGS).map(([k, v]) => ({
          sql: "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
          args: [k, v],
        })),
        "write"
      );
    })();
  }
  return readyPromise;
}

function toObjects(rs) {
  return rs.rows.map((row) => {
    const o = {};
    rs.columns.forEach((c, i) => { o[c] = row[i]; });
    return o;
  });
}

export async function all(sql, args = []) {
  return toObjects(await client.execute({ sql, args }));
}
export async function get(sql, args = []) {
  return (await all(sql, args))[0];
}
export async function run(sql, args = []) {
  const rs = await client.execute({ sql, args });
  return { lastInsertRowid: rs.lastInsertRowid == null ? null : Number(rs.lastInsertRowid) };
}

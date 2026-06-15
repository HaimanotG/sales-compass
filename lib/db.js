// Data layer: Turso (libSQL) when TURSO_DATABASE_URL is set, local file otherwise.
const remoteUrl = process.env.TURSO_DATABASE_URL || "";
const url = remoteUrl || `file:${new URL("../compass.db", import.meta.url).pathname}`;

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

export const DEFAULT_TEMPLATE = `Hi — I noticed {pain_signal}. I've been watching {competitor_1} and {competitor_2} for the last few days and {personalization_note}. I run a tool that tracks competitor price/promo changes for brands like {brand} — want me to send over what I've found?`;

// Signal-typed variants that lead with the synced competitor change. Each carries
// its own short, internal-looking subject and a body. {latest_competitor_change}
// auto-populates from the Beaconmon sync; empty competitor slots render away
// cleanly via renderTemplate(). These are merged in at read time (getSettings) so
// they appear on existing DBs without a reseed, while users can still override a
// variant by defining one of the same name in copy_templates.
export const SIGNAL_TEMPLATES = [
  {
    name: "price drop / promo",
    subject: "{competitor_1} pricing",
    text: [
      "Hi {founder_name}, {competitor_1} just {latest_competitor_change}. Figured you'd want to see it before your customers do.",
      "I run Beaconmon. It watches your competitors' prices, promos, and stock and flags changes the morning they happen, not weeks later. I'm already tracking {competitor_1}, {competitor_2}, and {competitor_3} for you.",
      "Want me to send the full snapshot of what's moved this week?",
    ].join("\n\n"),
  },
  {
    name: "competitor stockout",
    subject: "competitor stockout",
    text: [
      "Hi {founder_name}, {competitor_1} just {latest_competitor_change}. Usually a short window to catch their demand before they restock.",
      "Beaconmon flags exactly these moments across your competitors (stockouts, price changes, new drops, promos) same-day. I'm already watching {competitor_1} and {competitor_2}.",
      "Worth me sending what else shifted this week?",
    ].join("\n\n"),
  },
  {
    name: "promo / sale launch",
    subject: "competitor promo",
    text: [
      "Hi {founder_name}, {competitor_1} just {latest_competitor_change}. The kind of thing that quietly pulls sales if you don't see it early.",
      "I built Beaconmon so changes like this from {competitor_1}, {competitor_2}, and {competitor_3} hit your inbox the day they go live. Already tracking them for you.",
      "Want this week's full change snapshot?",
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

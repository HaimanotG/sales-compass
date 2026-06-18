// Shared helpers for reading Beaconmon competitor_events: the usable-event filter
// and the human-readable event summarizer. Imported by scripts/sync-events.js (the
// one-line lead hook) and scripts/full-report.js (the conversion snapshot). Keeping
// these in one place means the noise filter can never drift between the two.

// Minimum relative price move for a price_changed event to count as a usable hook.
// Catalog-tier competitors (esp. spot-priced stores like jewelry) emit a flood of
// sub-1% price flicker: ~87% of price_changed events are <1% and pure noise. Real
// merchandising moves cluster at >=10%, with almost nothing in the 5-10% band, so 5%
// is a safe floor. Only price_changed is filtered; every other event type (including
// site_changed, the sole signal for the limited/not_applicable cohort) passes through.
export const MIN_PRICE_MOVE = 0.05;

// SQL predicate: keep an event if it is NOT a price_changed, OR it is a price_changed
// with a parseable old/new price and an absolute move >= MIN_PRICE_MOVE.
export const USABLE_EVENT_SQL = `(
  type <> 'price_changed'
  OR (
    payload->>'oldPrice' ~ '^[0-9]+(\\.[0-9]+)?$'
    AND payload->>'newPrice' ~ '^[0-9]+(\\.[0-9]+)?$'
    AND (payload->>'oldPrice')::numeric > 0
    AND abs((payload->>'newPrice')::numeric - (payload->>'oldPrice')::numeric)
        / (payload->>'oldPrice')::numeric >= ${MIN_PRICE_MOVE}
  )
)`;

export function normHost(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
}

export function money(v, currency) {
  if (v == null || v === "") return "";
  const n = Number(v);
  const amount = Number.isFinite(n) ? n.toFixed(2) : String(v);
  return currency && currency !== "USD" ? `${amount} ${currency}` : `$${amount}`;
}

// Relative price move as a rounded whole-percent string, or null if not computable.
export function priceMovePct(payload) {
  const p = payload || {};
  const oldP = Number(p.oldPrice);
  const newP = Number(p.newPrice);
  if (!Number.isFinite(oldP) || !Number.isFinite(newP) || oldP <= 0) return null;
  return Math.round((Math.abs(newP - oldP) / oldP) * 100);
}

// One-line description of a competitor_events row WITHOUT a domain prefix. Page-check
// events (the only kind limited/not_applicable single-page competitors produce) carry
// diffSummary when AI is on, else null.
export function describeChange(type, payload) {
  const p = payload || {};
  switch (type) {
    case "price_changed": {
      const pct = priceMovePct(p);
      const dir = Number(p.newPrice) < Number(p.oldPrice) ? "dropped" : "rose";
      const move = pct != null ? `price ${dir} ${pct}%` : "price changed";
      return `${move}, ${money(p.oldPrice, p.currency)} to ${money(p.newPrice, p.currency)}`.trim();
    }
    case "promo_detected":
    case "sale_started":
      return p.diffSummary ? p.diffSummary : "promo / pricing change detected";
    case "sale_ended":
      return "sale ended";
    case "product_added":
      return p.title ? `new product: ${p.title}` : "new product added";
    case "product_removed":
      return p.title ? `product removed: ${p.title}` : "product removed";
    case "out_of_stock":
      return p.productHandle ? `out of stock: ${p.productHandle}` : "product out of stock";
    case "back_in_stock":
      return p.productHandle ? `back in stock: ${p.productHandle}` : "product back in stock";
    case "stock_changed":
      return "stock changed";
    case "site_changed":
      return p.diffSummary ? p.diffSummary : "content changed";
    default:
      return String(type).replace(/_/g, " ");
  }
}

// One-line summary prefixed with the competitor domain (used for the lead hook).
export function summarize(type, payload, domain) {
  return `${domain}: ${describeChange(type, payload)}`;
}

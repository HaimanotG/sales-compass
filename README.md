# Sales Compass

Single-user, no-auth sales companion for Beaconmon outreach. An execution tool: do disciplined daily outreach, hit $300 MRR.

## Run locally

```sh
bun install
bun server.js
# → http://localhost:4848
```

With no env vars set, data persists in a local `compass.db` file (created on first run).

## Database

The data layer is libSQL (`@libsql/client`):

- **Local (default):** `file:compass.db` next to `server.js`.
- **Managed (Turso):** set `TURSO_DATABASE_URL` (e.g. `libsql://sales-compass-<org>.turso.io`) and `TURSO_AUTH_TOKEN`. Schema is created automatically on first request.

## Deploy to Vercel

The repo is Vercel-ready with no build step: static frontend in `public/`, the API as a single function in `api/index.js` (all `/api/*` requests are rewritten to it via `vercel.json`), and a password gate in `middleware.js`.

1. Create the database: [turso.tech](https://turso.tech) → create a DB → copy its URL and create an auth token (`turso db tokens create <db>`).
2. Push this repo to GitHub and import it on [vercel.com](https://vercel.com/new) (framework preset: **Other**).
3. Set three environment variables in the Vercel project:
   - `TURSO_DATABASE_URL` — the `libsql://…` URL
   - `TURSO_AUTH_TOKEN` — the token
   - `APP_PASSWORD` — any password; the browser prompts for it once per device (any username)
4. Deploy. Each git push redeploys.

Without `APP_PASSWORD` the deployed app is open to anyone with the URL — set it.

## Screens

- **Today** — the daily loop. Prioritized queue (follow-ups due → monitoring ripe → fresh leads), daily action target + streak, MRR progress, quick-add, copy-outreach helper.
- **Pipeline** — all leads grouped by status, vertical filter, inline status edits, CSV import.
- **Stats** — sends, replies, reply rate by vertical, funnel (sent → replied → trial → won), current MRR.
- **Settings** — daily target, vertical-of-the-week, price, MRR goal, copy template, per-vertical competitor presets.

## Status automation

- **Mark sent** (from new/enriched/monitoring): `status=sent`, `sent_at=today`, `follow_up_due_at=today+3`.
- **Complete follow-up** while `sent` → `follow_up_1`, due `today+4`; while `follow_up_1` → `follow_up_2`, due cleared.
- **Log reply** (from sent/follow_up_1/follow_up_2) → `replied`, `replied_at=today`, due cleared.
- Setting status to `monitoring` auto-sets `monitoring_started_at` if blank.
- `won` / `trial` / `dead` are manual edits on the Pipeline screen; won/dead count as daily actions.

An "action" = any status-advancing event logged today (sent, follow-up, reply, won/dead). Streak = consecutive days (ending today or yesterday) at target.

## CSV import

Header row required: `brand,domain,vertical,size_estimate,source`. Rows import as `status=new`.

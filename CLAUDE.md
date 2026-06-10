# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
bun install        # install deps (@libsql/client is the only dependency)
bun server.js      # run locally → http://localhost:4848
```

There is no build step, no linter, and no test suite. The frontend is plain HTML/CSS/JS served as static files; verify changes by running the server and exercising the UI.

## What this is

Single-user, no-auth sales outreach companion ("Sales Compass") for Beaconmon. Tracks leads through a status pipeline, enforces a daily action target with streaks, and measures MRR progress. Four screens: Today (prioritized daily queue), Pipeline, Stats, Settings.

## Architecture

The same API code runs in two environments, which is the key constraint to preserve:

- **Local:** `server.js` is a Bun server that serves `public/` and routes everything else to `handleApi`.
- **Vercel:** static files come from `public/`, every `/api/*` request is rewritten (in `vercel.json`) to the single function `api/index.js`, which receives the original URL, and `middleware.js` (Edge Middleware) adds Basic-auth when `APP_PASSWORD` is set. No build step (`vercel.json` sets an empty buildCommand).

Both entry points delegate to **`lib/app.js`**, which contains all API logic: the router (`handleApi`, web-standard Request → Response), validation, status-transition automation, CSV import, streak computation, and the `statePayload` builder. Keep new API logic here, not in the entry points, so it works in both environments.

**`lib/db.js`** is the data layer: Turso (libSQL) when `TURSO_DATABASE_URL` is set, local `file:compass.db` otherwise. It deliberately imports `@libsql/client/web` (pure fetch, no native binary) for remote DBs so serverless deploys work. Schema is created lazily on first request via `ready()`. New columns go in **both** the `SCHEMA` string (fresh DBs) and the `MIGRATIONS` list of `ALTER TABLE … ADD COLUMN` statements (existing DBs; each runs in a try/catch so re-runs are no-ops).

**`public/app.js`** is the entire frontend: vanilla JS, no framework, no modules. It holds a single global `state` object; every mutating API response includes a fresh `state` payload, and the client re-renders everything from it (`renderAll`). When adding endpoints, return `{ ..., state: await statePayload() }` to keep this pattern working.

## Conventions and invariants

- All calendar dates are **local** `yyyy-mm-dd` strings (not UTC ISO timestamps) — see the date helpers duplicated in `lib/app.js` and `public/app.js`. Only `created_at` is a full ISO timestamp.
- Lead statuses (ordered pipeline): `new, enriched, monitoring, sent, follow_up_1, follow_up_2, replied, trial, won, dead`. The `STATUSES` list is duplicated in `lib/app.js` and `public/app.js` — keep them in sync.
- Status automation lives in `transition()` (`lib/app.js`): "sent" sets `follow_up_due_at = today+3` and records `template_used`; follow-up advances sent → follow_up_1 (due +4) → follow_up_2 (breakup due +7) → breakup (sets `breakup_sent_at`, due +5 as the "mark it dead" review date). Reply requires sent/follow_up_* . Invalid transitions throw `ApiError`. `won`/`dead` are manual edits via PATCH but still log a daily action and clear `follow_up_due_at`; PATCHing to `trial`/`monitoring` auto-fills `trial_started_at`/`monitoring_started_at`.
- The Today queue (`buildQueue` in `public/app.js`) has a hot tier above follow-ups: all `replied` and `trial` leads, closed via PATCH status buttons (start trial / won / dead).
- CSV import dedupes against existing leads (and within the file) by normalized brand or url; duplicates are reported separately from bad rows.
- Copy templates: `copy_template` is the "default" variant; extra named variants live in the `copy_templates` setting (JSON array of `{name, text}`). Stats compares reply rates per template via `leads.template_used`.
- An "action" = a row in the `actions` table dated today; the streak counts consecutive days meeting `daily_target`, allowed to end today or yesterday.
- `ApiError` → 400 with `{ error }`; anything else → 500. Throw `ApiError` for user-facing validation messages.
- Vertical names are normalized to lowercase on write.
- Settings are stored as strings in a key/value table; `getSettings()` parses/defaults them. New settings need a default in `DEFAULT_SETTINGS` (`db.js`) and the `allowed` list in the settings endpoint (`app.js`).

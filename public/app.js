/* Sales Compass — frontend */
"use strict";

const STATUSES = ["new", "enriched", "monitoring", "sent", "follow_up_1", "follow_up_2", "replied", "trial", "won", "dead"];
const STATUS_LABELS = {
  new: "new", enriched: "enriched", monitoring: "monitoring", sent: "sent",
  follow_up_1: "follow-up 1", follow_up_2: "follow-up 2", replied: "replied",
  trial: "trial", won: "won", dead: "dead",
};
const PRE_SEND = ["new", "enriched", "monitoring"];

let state = null; // { today, leads, settings, actions_today, streak, mrr }

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- api ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "request failed");
  if (data.state) state = data.state;
  else if (path === "/api/state") state = data;
  return data;
}

async function refresh() {
  await api("/api/state");
  renderAll();
}

// ---------- date helpers (local calendar dates, yyyy-mm-dd strings) ----------
function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}
function fmtDate(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ---------- toast ----------
let toastTimer;
function toast(msg, isErr = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("err", isErr);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

// ---------- copy template ----------
// latest_competitor_change is stored as "<mover domain>: <change detail>". Split it
// into the two render-only keys the signal templates need, so the same hook can name
// the competitor that actually moved (which is rarely competitor_1). No separator
// means the whole string is the detail and there is no mover domain to name.
function changeParts(lead) {
  const raw = String((lead && lead.latest_competitor_change) || "").trim();
  const i = raw.indexOf(": ");
  if (i === -1) return { change_competitor: "", change_detail: raw };
  return { change_competitor: raw.slice(0, i).trim(), change_detail: raw.slice(i + 2).trim() };
}

function renderTemplate(tpl, lead) {
  const ctx = { ...lead, ...changeParts(lead) };
  ctx.founder_first = String(ctx.founder_name || "").trim().split(/\s+/)[0] || "";
  const get = (k) => String(ctx[k] || "").trim();
  let out = tpl;
  // triple join: {a}, {b} and {c} → join whichever are present
  out = out.replace(/\{(\w+)\}\s*,\s*\{(\w+)\}\s*(?:,\s*)?(?:and\s*)?\{(\w+)\}/g, (m, a, b, c) => {
    const vals = [get(a), get(b), get(c)].filter(Boolean);
    if (!vals.length) return "";
    if (vals.length === 1) return vals[0];
    return vals.slice(0, -1).join(", ") + " and " + vals[vals.length - 1];
  });
  // pair join: {a} and {b} / {a}, {b} → drop the connector if one side is empty
  out = out.replace(/\{(\w+)\}(\s*(?:and|,)\s*)\{(\w+)\}/g, (m, a, sep, b) => {
    const va = get(a), vb = get(b);
    if (va && vb) return va + sep + vb;
    return va || vb || "";
  });
  // remaining single placeholders
  out = out.replace(/\{(\w+)\}/g, (m, k) => get(k));
  // cleanup: no dangling "and", no doubled spaces, no space before punctuation
  out = out
    .replace(/\s+and\s*([.,!?;])/g, "$1")
    .replace(/(^|[.!?]\s+)and\s+/g, "$1")
    .replace(/[ \t]+/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/\.\s*\./g, ".")
    .trim();
  return out;
}

// named template variants: "default" is the main template, extras live in settings.copy_templates
// (each extra may carry an optional `subject` used by the Email action).
function allTemplates() {
  return [{ name: "default", text: state.settings.copy_template }, ...(state.settings.copy_templates || [])];
}
function templateObj(name) {
  return allTemplates().find((t) => t.name === name) || { name: "default", text: state.settings.copy_template };
}
function templateText(name) {
  return templateObj(name).text;
}
function selectedTemplate(leadId) {
  const sel = $(`select[data-tpl-for="${leadId}"]`);
  if (sel) return sel.value;
  const lead = findLead(leadId);
  return (lead && lead.template_used) || "default";
}

async function copyOutreach(lead) {
  const tplName = selectedTemplate(lead.id);
  const text = renderTemplate(templateText(tplName), lead);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast(`Copied outreach for ${lead.brand}`);
  // remember which variant was used so Stats can compare reply rates
  if (tplName !== (lead.template_used || "default")) {
    api(`/api/leads/${lead.id}`, { method: "PATCH", body: { template_used: tplName } }).catch(() => {});
  }
}

// Short, internal-looking subject. If the chosen variant defines one, use it (run
// through the same {field} substitution as the body). Otherwise fall back to the
// competitor_1 domain plus " update" (e.g. "petsafe.com update"), never a markety line.
// The signal-variant subjects are built around {change_competitor}; when that derived
// key is empty (no separator in latest_competitor_change) the substitution would leave
// a bare leftover like "pricing", so we treat a referenced-but-empty {change_competitor}
// as no usable subject and drop to the fallback.
function outreachSubject(lead, tpl) {
  if (tpl && tpl.subject && tpl.subject.trim()) {
    const refsChangeCompetitor = /\{change_competitor\}/.test(tpl.subject);
    const hasChangeCompetitor = !!changeParts(lead).change_competitor;
    if (!refsChangeCompetitor || hasChangeCompetitor) {
      const s = renderTemplate(tpl.subject, lead).trim();
      if (s) return s;
    }
  }
  const comp = String(lead.competitor_1_url || lead.competitor_1 || "").trim().toLowerCase();
  return comp ? `${comp} update` : "quick one";
}

function emailOutreach(lead) {
  const tpl = templateObj(selectedTemplate(lead.id));
  const text = renderTemplate(tpl.text, lead);
  const subject = outreachSubject(lead, tpl);
  location.href = `mailto:${encodeURIComponent(lead.contact.trim())}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
}

function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
}

// ---------- queue (the product) ----------
function buildQueue() {
  const { leads, settings, today } = state;
  const ripeCutoff = addDays(today, -3);

  // hot: replies waiting on you + open trials — closest to money, always on top
  const tier0 = [
    ...leads.filter((l) => l.status === "replied")
      .sort((a, b) => String(a.replied_at || "").localeCompare(String(b.replied_at || ""))),
    ...leads.filter((l) => l.status === "trial")
      .sort((a, b) => String(a.trial_started_at || "").localeCompare(String(b.trial_started_at || ""))),
  ];

  // change-detected: pre-send leads whose competitor moved in the last week (synced from
  // Beaconmon). Sits just below Hot — a fresh change is the trigger to fire the first email.
  const changeCutoff = addDays(today, -7);
  const tierChange = leads
    .filter((l) =>
      PRE_SEND.includes(l.status) &&
      l.latest_change_detected_at &&
      String(l.latest_change_detected_at).slice(0, 10) >= changeCutoff
    )
    .sort((a, b) => String(b.latest_change_detected_at).localeCompare(String(a.latest_change_detected_at)));
  const changeIds = new Set(tierChange.map((l) => l.id));

  const tier1 = leads
    .filter((l) => ["sent", "follow_up_1", "follow_up_2"].includes(l.status) && l.follow_up_due_at && l.follow_up_due_at <= today)
    .sort((a, b) => a.follow_up_due_at.localeCompare(b.follow_up_due_at));

  const tier2 = leads
    .filter((l) => l.status === "monitoring" && !changeIds.has(l.id) && l.monitoring_started_at && l.monitoring_started_at <= ripeCutoff)
    .sort((a, b) => a.monitoring_started_at.localeCompare(b.monitoring_started_at));

  const tier3 = leads
    .filter((l) =>
      ["new", "enriched"].includes(l.status) &&
      !changeIds.has(l.id) &&
      String(l.pain_signal || "").trim() !== "" &&
      (!settings.vertical_focus || l.vertical === settings.vertical_focus.toLowerCase())
    )
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  return { tier0, tierChange, tier1, tier2, tier3 };
}

function compsHTML(lead) {
  const comps = [lead.competitor_1, lead.competitor_2, lead.competitor_3].filter((c) => c && c.trim());
  if (!comps.length) return `<div class="lead-comps"><span class="watch">WATCHING</span> <span class="comp">no competitors set</span></div>`;
  return `<div class="lead-comps"><span class="watch">WATCHING</span> ${comps.map((c) => `<span class="comp">${esc(c)}</span>`).join("")}</div>`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function daysBetween(a, b) {
  return Math.round((toDate(b) - toDate(a)) / 86400000);
}

function tplPickerHTML(lead) {
  const templates = allTemplates();
  if (templates.length < 2) return "";
  const current = lead.template_used && templates.some((t) => t.name === lead.template_used) ? lead.template_used : "default";
  return `<select class="input select tpl-select" data-tpl-for="${lead.id}" title="copy template variant">
    ${templates.map((t) => `<option value="${esc(t.name)}" ${t.name === current ? "selected" : ""}>${esc(t.name)}</option>`).join("")}
  </select>`;
}

function leadCardHTML(lead, tier) {
  const today = state.today;
  const overdue = tier === 1 && lead.follow_up_due_at < today;
  let meta = "", buttons = "";
  const id = lead.id;

  if (tier === 0) {
    if (lead.status === "replied") {
      const days = lead.replied_at ? daysBetween(lead.replied_at, today) : 0;
      const ago = days <= 0 ? "today" : `${days}d ago`;
      meta = `<span class="lead-due">replied ${ago}${lead.reply_sentiment ? " · " + esc(lead.reply_sentiment) : ""} — respond / book the demo</span>`;
      buttons = `
        <button class="btn btn-primary" data-act="start_trial" data-id="${id}">→ Start trial</button>
        <button class="btn" data-act="won" data-id="${id}">✓ Mark won</button>
        <button class="btn btn-ghost" data-act="dead" data-id="${id}">✗ Dead</button>`;
    } else {
      const day = lead.trial_started_at ? daysBetween(lead.trial_started_at, today) + 1 : null;
      meta = `<span class="lead-due">${day ? `trial day ${day}` : "on trial"} — check in / ask for the close</span>`;
      buttons = `
        <button class="btn btn-primary" data-act="won" data-id="${id}">✓ Mark won</button>
        <button class="btn btn-ghost" data-act="dead" data-id="${id}">✗ Mark dead</button>`;
    }
  } else if (tier === 1) {
    if (lead.status === "follow_up_2" && lead.breakup_sent_at) {
      const days = daysBetween(lead.breakup_sent_at, today);
      meta = `<span class="lead-due">no reply ${days}d after breakup — call it</span>`;
      buttons = `
        <button class="btn btn-primary" data-act="dead" data-id="${id}">✗ Mark dead</button>
        <button class="btn" data-act="reply" data-id="${id}">↩ Log reply</button>`;
    } else {
      const which = lead.status === "sent" ? "follow-up 1" : lead.status === "follow_up_1" ? "follow-up 2" : "breakup email";
      meta = `<span class="lead-due">${which} ${overdue ? "OVERDUE — was due " + fmtDate(lead.follow_up_due_at) : "due today"}</span>`;
      const label = lead.status === "follow_up_2" ? "✓ Sent breakup" : "✓ Complete follow-up";
      buttons = `
        <button class="btn btn-primary" data-act="follow_up" data-id="${id}">${label}</button>
        <button class="btn" data-act="reply" data-id="${id}">↩ Log reply</button>`;
    }
  } else if (tier === "change") {
    const when = lead.latest_change_detected_at ? String(lead.latest_change_detected_at).slice(0, 10) : today;
    const days = daysBetween(when, today);
    const ago = days <= 0 ? "today" : `${days}d ago`;
    meta = `<span class="lead-due" style="color:var(--beacon)">competitor change ${ago} — reach out now</span>`;
    buttons = `<button class="btn btn-primary" data-act="sent" data-id="${id}">→ Mark sent</button>`;
  } else {
    if (tier === 2) {
      const days = daysBetween(lead.monitoring_started_at, today);
      meta = `<span class="lead-due" style="color:var(--beacon)">monitoring ${days}d — demo data ready</span>`;
    }
    buttons = `<button class="btn btn-primary" data-act="sent" data-id="${id}">→ Mark sent</button>`;
  }

  const pain = String(lead.pain_signal || "").trim();
  const reply = String(lead.reply || "").trim();
  const note = tier === 0 && reply
    ? `<div class="lead-pain">“${esc(reply)}”</div>`
    : `<div class="lead-pain ${pain ? "" : "empty"}">${pain ? esc(pain) : "no pain signal yet — click brand to enrich"}</div>`;
  const emailBtn = isEmail(lead.contact)
    ? `<button class="btn btn-ghost" data-act="email" data-id="${id}">✉ Email</button>` : "";
  const change = String(lead.latest_competitor_change || "").trim();
  const changeHTML = change
    ? `<div class="lead-change">⚡ ${esc(change)}</div>`
    : "";
  return `
  <div class="lead-card ${overdue ? "overdue" : ""} ${tier === "change" ? "lead-card-change" : ""}">
    <div class="lead-top">
      <span class="lead-brand" data-edit="${id}">${esc(lead.brand)}</span>
      <span class="lead-vertical">${esc(lead.vertical)}</span>
      ${meta}
    </div>
    ${note}
    ${changeHTML}
    ${compsHTML(lead)}
    <div class="lead-actions">
      ${buttons}
      ${tplPickerHTML(lead)}
      <button class="btn btn-ghost btn-copy" data-act="copy" data-id="${id}">⧉ Copy outreach</button>
      ${emailBtn}
    </div>
  </div>`;
}

function toDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

function renderQueue() {
  const { tier0, tierChange, tier1, tier2, tier3 } = buildQueue();
  const root = $("#queue");
  const tiers = [
    { n: "★", cls: 0, title: "Hot — replies & trials, close these first", items: tier0 },
    { n: "⚡", cls: "change", title: "Competitor change detected — strike while it's fresh", items: tierChange },
    { n: 1, cls: 1, title: "Follow-ups due", items: tier1, empty: "No follow-ups due. The inbox owes you nothing." },
    { n: 2, cls: 2, title: "Monitoring ripe — enough demo data, reach out", items: tier2, empty: "Nothing ripe yet. Beacons still gathering." },
    { n: 3, cls: 3, title: state.settings.vertical_focus ? `Fresh leads · ${esc(state.settings.vertical_focus)}` : "Fresh leads · all verticals", items: tier3, empty: "No fresh leads with a pain signal. Add some or enrich what's in the pipeline." },
  ];
  const total = tier0.length + tierChange.length + tier1.length + tier2.length + tier3.length;
  if (!total) {
    root.innerHTML = `<div class="queue-empty">
      <div class="big">Queue clear.</div>
      Quick-add leads, enrich pain signals, or set leads to monitoring — the queue fills itself.
    </div>`;
    return;
  }
  root.innerHTML = tiers
    .map((t) => {
      if (!t.items.length) return "";
      return `<div class="tier tier-${t.cls}">
        <div class="tier-rail"><div class="tier-num">${t.n}</div><div class="tier-line"></div></div>
        <div class="tier-body">
          <div class="tier-title">${t.title} <span class="count">· ${t.items.length}</span></div>
          ${t.items.map((l) => leadCardHTML(l, t.cls)).join("")}
        </div>
      </div>`;
    })
    .join("");
}

// ---------- dashboard ----------
function renderDash() {
  const s = state.settings;
  const target = s.daily_target;
  const done = state.actions_today;
  $("#actions-count").textContent = done;
  $("#actions-target").textContent = target;
  const pct = Math.min(100, (done / target) * 100);
  const bar = $("#target-bar");
  bar.style.width = pct + "%";
  bar.classList.toggle("done", done >= target);
  $("#target-foot").textContent =
    done >= target ? "Target hit. Keep the streak alive tomorrow." : `${target - done} more to hit today's target`;

  $("#streak-count").textContent = state.streak;
  $("#streak-flames").textContent = state.streak > 0 ? "▮".repeat(Math.min(state.streak, 30)) : "—";
  const weekAgo = addDays(state.today, -6);
  const repliesWeek = state.leads.filter((l) => l.replied_at && l.replied_at >= weekAgo).length;
  $("#streak-foot").textContent = `consecutive days at target · ${repliesWeek} repl${repliesWeek === 1 ? "y" : "ies"} this week`;

  $("#mrr-current").textContent = Math.round(state.mrr);
  $("#mrr-goal").textContent = s.mrr_goal;
  const mrrPct = Math.min(100, (state.mrr / s.mrr_goal) * 100);
  $("#mrr-bar").style.width = mrrPct + "%";
  $("#mrr-foot").textContent =
    state.mrr >= s.mrr_goal ? "GOAL HIT. Raise the goal." : `$${Math.max(0, s.mrr_goal - state.mrr).toFixed(0)} to go`;

  $("#focus-value").textContent = s.vertical_focus || "all verticals";
  $("#pace-line").textContent = paceLine();
}

// pace to goal, from actual win rate: "N wins ≈ M sends ≈ hit goal by <date>"
function paceLine() {
  const s = state.settings;
  const leads = state.leads;
  const remaining = Math.max(0, s.mrr_goal - state.mrr);
  if (!remaining) return "Goal hit — raise it in Settings and keep climbing.";
  const won = leads.filter((l) => l.status === "won");
  const dealValues = won.map((l) => (l.deal_value_mo != null ? Number(l.deal_value_mo) : s.price_mo)).filter((v) => v > 0);
  const avgDeal = dealValues.length
    ? dealValues.reduce((a, b) => a + b, 0) / dealValues.length
    : s.price_mo;
  if (!avgDeal) return "Set your price in Settings to see the pace to goal.";
  const needWins = Math.ceil(remaining / avgDeal);
  const sends = leads.filter((l) => l.sent_at).length;
  if (!won.length || !sends) {
    return `$${remaining.toFixed(0)} to go ≈ ${needWins} win${needWins === 1 ? "" : "s"} at $${Math.round(avgDeal)}/mo. No win-rate data yet — every send sharpens the forecast.`;
  }
  const sendsPerWin = sends / won.length;
  const needSends = Math.ceil(needWins * sendsPerWin);
  const days = Math.max(1, Math.ceil(needSends / s.daily_target));
  const eta = addDays(state.today, days);
  return `$${remaining.toFixed(0)} to go ≈ ${needWins} win${needWins === 1 ? "" : "s"} ≈ ${needSends} sends at your 1-in-${Math.round(sendsPerWin)} win rate — on pace for ${fmtDate(eta)} at ${s.daily_target}/day.`;
}

// ---------- pipeline ----------
function renderPipeline() {
  const filter = $("#pipeline-vertical-filter").value;
  const root = $("#pipeline-groups");
  const leads = state.leads.filter((l) => !filter || l.vertical === filter);
  if (!leads.length) {
    root.innerHTML = `<div class="queue-empty"><div class="big">Pipeline empty.</div>Quick-add a lead or import a CSV to get rolling.</div>`;
    return;
  }
  root.innerHTML = STATUSES.map((st) => {
    const group = leads.filter((l) => l.status === st);
    if (!group.length) return "";
    return `<div class="status-group">
      <div class="status-group-head">
        <span class="status-chip" data-s="${st}">${STATUS_LABELS[st]}</span>
        <span class="status-group-count">${group.length}</span>
      </div>
      <table class="table"><thead><tr>
        <th>Brand</th><th>Vertical</th><th>Contact</th><th>Pain signal</th>
        <th>Sent</th><th>Due</th><th class="num">$/mo</th><th>Status</th>
      </tr></thead><tbody>
        ${group.map((l) => `<tr>
          <td class="td-brand" data-edit="${l.id}">${esc(l.brand)}${l.url ? ` <span class="td-dim mono" style="font-size:11px">${esc(l.url)}</span>` : ""}</td>
          <td class="td-dim">${esc(l.vertical)}</td>
          <td class="td-dim">${esc(l.contact) || "—"}</td>
          <td>${esc(l.pain_signal) || '<span class="td-dim">—</span>'}</td>
          <td class="td-date">${fmtDate(l.sent_at)}</td>
          <td class="td-date">${fmtDate(l.follow_up_due_at)}</td>
          <td class="num td-dim">${l.deal_value_mo != null ? "$" + l.deal_value_mo : "—"}</td>
          <td><select class="status-select" data-status-for="${l.id}">
            ${STATUSES.map((o) => `<option value="${o}" ${o === l.status ? "selected" : ""}>${STATUS_LABELS[o]}</option>`).join("")}
          </select></td>
        </tr>`).join("")}
      </tbody></table>
    </div>`;
  }).join("");
}

function renderVerticalOptions() {
  const verticals = [...new Set([
    ...state.leads.map((l) => l.vertical),
    ...Object.keys(state.settings.competitor_presets || {}),
  ])].filter(Boolean).sort();

  $("#vertical-list").innerHTML = verticals.map((v) => `<option value="${esc(v)}">`).join("");

  const sel = $("#pipeline-vertical-filter");
  const current = sel.value;
  sel.innerHTML = `<option value="">All verticals</option>` +
    verticals.map((v) => `<option value="${esc(v)}" ${v === current ? "selected" : ""}>${esc(v)}</option>`).join("");
}

// ---------- stats ----------
// stage checks tolerate manual status edits: a dead lead that replied still counts as a reply
function didReply(l) {
  return !!l.replied_at || ["replied", "trial", "won"].includes(l.status);
}
function didTrial(l) {
  return !!l.trial_started_at || ["trial", "won"].includes(l.status);
}

// funnel counts grouped by a lead attribute, sent leads only, sorted by send volume
function funnelBy(leads, keyFn) {
  const groups = {};
  for (const l of leads) {
    if (!l.sent_at) continue;
    const k = keyFn(l) || "—";
    const g = (groups[k] ??= { sends: 0, replies: 0, trials: 0, wins: 0 });
    g.sends++;
    if (didReply(l)) g.replies++;
    if (didTrial(l)) g.trials++;
    if (l.status === "won") g.wins++;
  }
  return Object.entries(groups).sort((a, b) => b[1].sends - a[1].sends);
}

function funnelRowsHTML(rows, emptyMsg, cols) {
  if (!rows.length) return `<tr><td colspan="${cols}" class="td-dim">${emptyMsg}</td></tr>`;
  const full = cols > 4;
  return rows.map(([key, g]) => `<tr>
      <td>${esc(key)}</td>
      <td class="num">${g.sends}</td>
      <td class="num">${g.replies}</td>
      <td class="num">${Math.round((g.replies / g.sends) * 100)}%</td>
      ${full ? `<td class="num">${g.trials}</td><td class="num">${g.wins}</td>` : ""}
    </tr>`).join("");
}

function renderStats() {
  const leads = state.leads;
  const sends = leads.filter((l) => l.sent_at).length;
  const replies = leads.filter((l) => l.replied_at).length;
  const trials = leads.filter(didTrial).length;
  const wins = leads.filter((l) => l.status === "won").length;
  const rate = sends ? Math.round((replies / sends) * 100) : 0;

  $("#stats-cards").innerHTML = [
    { label: "Sends", value: sends, color: "var(--beacon)" },
    { label: "Replies", value: replies, color: "#d9a4ff" },
    { label: "Reply rate", value: rate + "%", color: "var(--signal-blue)" },
    { label: "Current MRR", value: "$" + Math.round(state.mrr), color: "var(--signal-green)" },
  ].map((c) => `<div class="dash-card">
      <div class="dash-label">${c.label}</div>
      <div class="dash-big" style="color:${c.color}">${c.value}</div>
    </div>`).join("");

  const maxF = Math.max(sends, 1);
  $("#funnel").innerHTML = [
    { key: "sent", label: "sent", v: sends },
    { key: "replied", label: "replied", v: replies },
    { key: "trial", label: "trial", v: trials },
    { key: "won", label: "won", v: wins },
  ].map((f) => `<div class="funnel-row f-${f.key}">
      <div class="funnel-label">${f.label}</div>
      <div class="funnel-bar"><div class="funnel-fill" style="width:${(f.v / maxF) * 100}%"></div></div>
      <div class="funnel-count">${f.v}</div>
    </div>`).join("");

  $("#vertical-table tbody").innerHTML = funnelRowsHTML(
    funnelBy(leads, (l) => l.vertical),
    "No sends yet — funnel by vertical appears once you start sending.", 6);
  $("#source-table tbody").innerHTML = funnelRowsHTML(
    funnelBy(leads, (l) => l.source),
    "No sends yet — funnel by source appears once you start sending.", 6);
  $("#template-table tbody").innerHTML = funnelRowsHTML(
    funnelBy(leads, (l) => l.template_used || "default"),
    "No sends yet — add template variants in Settings and compare reply rates here.", 4);
}

// ---------- settings ----------
function renderSettings() {
  // don't clobber the form while the user is editing it
  if ($("#screen-settings").contains(document.activeElement)) return;
  const s = state.settings;
  $("#set-daily-target").value = s.daily_target;
  $("#set-vertical-focus").value = s.vertical_focus;
  $("#set-price").value = s.price_mo ?? "";
  $("#set-mrr-goal").value = s.mrr_goal;
  $("#set-template").value = s.copy_template;
  renderTemplateRows(s.copy_templates);
  renderPresetRows(s.competitor_presets);
}

function renderTemplateRows(templates) {
  $("#tpl-rows").innerHTML = (templates || []).map((t) => tplRowHTML(t.name, t.text, t.subject)).join("");
}
function tplRowHTML(name = "", text = "", subject = "") {
  return `<div class="tpl-row">
    <div class="tpl-row-head">
      <input class="input t-name" placeholder="variant name (e.g. blunt)" value="${esc(name)}">
      <button type="button" class="btn btn-ghost t-remove" title="remove">✕</button>
    </div>
    <input class="input t-subject" placeholder="email subject (optional, supports {fields})" value="${esc(subject || "")}">
    <textarea class="input textarea t-text" rows="4" spellcheck="false" placeholder="Alternate outreach copy — same placeholders as the main template.">${esc(text)}</textarea>
  </div>`;
}
function collectTemplates() {
  const out = [];
  const seen = new Set(["default"]);
  for (const row of $$(".tpl-row")) {
    const name = $(".t-name", row).value.trim();
    const text = $(".t-text", row).value;
    if (!name || !text.trim() || seen.has(name)) continue;
    seen.add(name);
    const subjEl = $(".t-subject", row);
    const subject = subjEl ? subjEl.value.trim() : "";
    const tpl = { name, text };
    if (subject) tpl.subject = subject;
    out.push(tpl);
  }
  return out;
}

function renderPresetRows(presets) {
  const root = $("#presets-rows");
  const entries = Object.entries(presets || {});
  root.innerHTML = entries.map(([vert, comps], i) => presetRowHTML(vert, comps)).join("");
}
function presetRowHTML(vert = "", comps = ["", "", ""]) {
  return `<div class="preset-row">
    <input class="input p-vertical" placeholder="vertical" value="${esc(vert)}">
    <input class="input p-c1" placeholder="competitor 1" value="${esc(comps[0] || "")}">
    <input class="input p-c2" placeholder="competitor 2" value="${esc(comps[1] || "")}">
    <input class="input p-c3" placeholder="competitor 3" value="${esc(comps[2] || "")}">
    <button type="button" class="btn btn-ghost p-remove" title="remove">✕</button>
  </div>`;
}
function collectPresets() {
  const presets = {};
  for (const row of $$(".preset-row")) {
    const vert = $(".p-vertical", row).value.trim().toLowerCase();
    if (!vert) continue;
    presets[vert] = [$(".p-c1", row).value.trim(), $(".p-c2", row).value.trim(), $(".p-c3", row).value.trim()];
  }
  return presets;
}

async function saveSettings() {
  try {
    await api("/api/settings", {
      method: "POST",
      body: {
        daily_target: $("#set-daily-target").value || "10",
        vertical_focus: $("#set-vertical-focus").value.trim().toLowerCase(),
        price_mo: $("#set-price").value,
        mrr_goal: $("#set-mrr-goal").value || "300",
        copy_template: $("#set-template").value,
        copy_templates: collectTemplates(),
        competitor_presets: collectPresets(),
      },
    });
    $("#settings-saved").textContent = "saved ✓";
    setTimeout(() => ($("#settings-saved").textContent = ""), 2000);
    renderAll();
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------- lead modal ----------
let editingId = null;

function openLeadModal(lead = null) {
  editingId = lead ? lead.id : null;
  const form = $("#lead-form");
  form.reset();
  $("#lead-modal-title").textContent = lead ? `Edit · ${lead.brand}` : "Quick add lead";
  $("#btn-save-lead").textContent = lead ? "Save changes" : "Add lead";
  $$(".edit-only").forEach((el) => (el.style.display = lead ? "" : "none"));
  $("#lead-more").open = !!lead;

  const statusSel = form.elements.status;
  statusSel.innerHTML = STATUSES.map((s) => `<option value="${s}">${STATUS_LABELS[s]}</option>`).join("");

  if (lead) {
    for (const el of form.elements) {
      if (!el.name) continue;
      el.value = lead[el.name] ?? "";
    }
  }
  // "unverified" badge: resolver-seeded domains awaiting the operator's confirm
  const badge = $("#comp-url-badge");
  if (badge) {
    const hasUrls = lead && [lead.competitor_1_url, lead.competitor_2_url, lead.competitor_3_url].some((u) => u && String(u).trim());
    badge.hidden = !(lead && hasUrls && Number(lead.competitor_urls_verified) === 0);
  }
  $("#lead-modal").showModal();
  form.elements.brand.focus();
}

async function submitLeadForm(e) {
  e.preventDefault();
  const form = $("#lead-form");
  const body = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (!editingId && ["status", "monitoring_started_at", "sent_at", "follow_up_due_at", "replied_at", "trial_started_at", "reply", "reply_sentiment"].includes(el.name)) continue;
    body[el.name] = el.value;
  }
  // Saving an edited lead that carries competitor domains confirms them (verified -> 1),
  // which is what graduates the lead into Beaconmon seeding.
  if (editingId && ["competitor_1_url", "competitor_2_url", "competitor_3_url"].some((k) => String(body[k] || "").trim())) {
    body.competitor_urls_verified = 1;
  }
  try {
    if (editingId) {
      await api(`/api/leads/${editingId}`, { method: "PATCH", body });
      toast(`Saved ${body.brand}`);
    } else {
      await api("/api/leads", { method: "POST", body });
      toast(`Added ${body.brand} to the pipeline`);
    }
    $("#lead-modal").close();
    renderAll();
  } catch (err) {
    toast(err.message, true);
  }
}

// pre-fill competitors from vertical preset on quick add
function maybeApplyPreset() {
  if (editingId) return;
  const form = $("#lead-form");
  const vert = form.elements.vertical.value.trim().toLowerCase();
  const preset = (state.settings.competitor_presets || {})[vert];
  if (!preset) return;
  ["competitor_1", "competitor_2", "competitor_3"].forEach((f, i) => {
    if (!form.elements[f].value.trim()) form.elements[f].value = preset[i] || "";
  });
  if (preset.some(Boolean)) $("#lead-more").open = true;
}

// ---------- reply modal ----------
let replyLeadId = null;
function openReplyModal(lead) {
  replyLeadId = lead.id;
  $("#reply-modal-title").textContent = `Log reply · ${lead.brand}`;
  $("#reply-form").reset();
  $("#reply-modal").showModal();
}
async function submitReply(e) {
  e.preventDefault();
  const form = $("#reply-form");
  try {
    await api(`/api/leads/${replyLeadId}/transition`, {
      method: "POST",
      body: { action: "reply", reply: form.elements.reply.value, reply_sentiment: form.elements.reply_sentiment.value },
    });
    $("#reply-modal").close();
    toast("Reply logged — nice signal.");
    renderAll();
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- transitions ----------
async function doTransition(id, action) {
  try {
    const wasFu2 = findLead(id)?.status === "follow_up_2";
    const body = { action };
    if (action === "sent") body.template = selectedTemplate(id);
    await api(`/api/leads/${id}/transition`, { method: "POST", body });
    const verb = action === "sent"
      ? "Marked sent — follow-up queued in 3 days"
      : wasFu2 ? "Breakup sent — if no reply in 21 days, call it" : "Follow-up logged";
    toast(verb);
    renderAll();
  } catch (err) {
    toast(err.message, true);
  }
}

async function changeStatus(id, status) {
  try {
    await api(`/api/leads/${id}`, { method: "PATCH", body: { status } });
    toast(`Status → ${STATUS_LABELS[status]}`);
    renderAll();
  } catch (err) {
    toast(err.message, true);
    renderAll();
  }
}

// ---------- import ----------
async function submitImport(e) {
  e.preventDefault();
  let csv = $("#import-text").value.trim();
  const file = $("#import-file").files[0];
  if (file) csv = await file.text();
  if (!csv) return toast("Choose a file or paste CSV first", true);
  try {
    const res = await api("/api/import", { method: "POST", body: { csv } });
    $("#import-modal").close();
    $("#import-form").reset();
    toast(`Imported ${res.imported} lead${res.imported === 1 ? "" : "s"}${res.duplicates ? ` · ${res.duplicates} duplicate${res.duplicates === 1 ? "" : "s"} skipped` : ""}${res.skipped ? ` · ${res.skipped} bad row${res.skipped === 1 ? "" : "s"}` : ""}`);
    renderAll();
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- nav ----------
function showScreen(name) {
  if (!["today", "pipeline", "stats", "settings"].includes(name)) name = "today";
  $$(".screen").forEach((s) => s.classList.remove("active"));
  $(`#screen-${name}`).classList.add("active");
  $$("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.screen === name));
}

// ---------- render ----------
function renderAll() {
  renderDash();
  renderQueue();
  renderVerticalOptions();
  renderPipeline();
  renderStats();
  renderSettings();
  const [y, m, d] = state.today.split("-").map(Number);
  $("#topbar-date").textContent = new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

// ---------- wiring ----------
function findLead(id) {
  return state.leads.find((l) => l.id === Number(id));
}

document.addEventListener("click", (e) => {
  const actBtn = e.target.closest("[data-act]");
  if (actBtn) {
    const lead = findLead(actBtn.dataset.id);
    if (!lead) return;
    const act = actBtn.dataset.act;
    if (act === "copy") copyOutreach(lead);
    else if (act === "email") emailOutreach(lead);
    else if (act === "reply") openReplyModal(lead);
    else if (act === "start_trial") changeStatus(lead.id, "trial");
    else if (act === "won" || act === "dead") changeStatus(lead.id, act);
    else doTransition(lead.id, act);
    return;
  }
  const editEl = e.target.closest("[data-edit]");
  if (editEl) {
    const lead = findLead(editEl.dataset.edit);
    if (lead) openLeadModal(lead);
    return;
  }
  if (e.target.closest(".p-remove")) {
    e.target.closest(".preset-row").remove();
  }
  if (e.target.closest(".t-remove")) {
    e.target.closest(".tpl-row").remove();
  }
});

document.addEventListener("change", (e) => {
  const sel = e.target.closest("[data-status-for]");
  if (sel) changeStatus(Number(sel.dataset.statusFor), sel.value);
});

window.addEventListener("hashchange", () => showScreen(location.hash.slice(1)));

function init() {
  $("#btn-quick-add").addEventListener("click", () => openLeadModal());
  $("#btn-add-pipeline").addEventListener("click", () => openLeadModal());
  $("#btn-close-modal").addEventListener("click", () => $("#lead-modal").close());
  $("#lead-form").addEventListener("submit", submitLeadForm);
  $("#lead-form").elements.vertical.addEventListener("change", maybeApplyPreset);
  $("#btn-delete-lead").addEventListener("click", async () => {
    if (!editingId) return;
    if (!confirm("Delete this lead for good?")) return;
    await api(`/api/leads/${editingId}`, { method: "DELETE" });
    $("#lead-modal").close();
    toast("Lead deleted");
    renderAll();
  });

  $("#btn-close-reply").addEventListener("click", () => $("#reply-modal").close());
  $("#reply-form").addEventListener("submit", submitReply);

  $("#btn-import").addEventListener("click", () => $("#import-modal").showModal());
  $("#btn-close-import").addEventListener("click", () => $("#import-modal").close());
  $("#import-form").addEventListener("submit", submitImport);

  $("#btn-save-settings").addEventListener("click", saveSettings);
  $("#set-template").addEventListener("blur", saveSettings);
  $("#btn-reset-template").addEventListener("click", () => {
    $("#set-template").value = "Hi — I noticed {pain_signal}. I've been watching {competitor_1} and {competitor_2} for the last few days and {personalization_note}. I run a tool that tracks competitor price/promo changes for brands like {brand} — want me to send over what I've found?";
    saveSettings();
  });
  $("#btn-add-preset").addEventListener("click", () => {
    $("#presets-rows").insertAdjacentHTML("beforeend", presetRowHTML());
  });
  $("#btn-dedupe").addEventListener("click", async () => {
    const btn = $("#btn-dedupe");
    btn.disabled = true;
    try {
      const res = await api("/api/dedupe", { method: "POST" });
      const msg = res.removed === 0 ? "no duplicates found" : `removed ${res.removed} duplicate${res.removed === 1 ? "" : "s"}`;
      $("#dedupe-result").textContent = msg;
      setTimeout(() => ($("#dedupe-result").textContent = ""), 3000);
    } finally {
      btn.disabled = false;
    }
  });
  $("#btn-add-template").addEventListener("click", () => {
    $("#tpl-rows").insertAdjacentHTML("beforeend", tplRowHTML());
  });
  $("#pipeline-vertical-filter").addEventListener("change", renderPipeline);

  showScreen(location.hash.slice(1) || "today");
  refresh().catch((e) => toast("Could not reach server: " + e.message, true));

  // keep "today" fresh if the tab stays open across midnight
  setInterval(() => refresh().catch(() => {}), 5 * 60 * 1000);
}

init();

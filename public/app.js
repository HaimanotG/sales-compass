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
function renderTemplate(tpl, lead) {
  const get = (k) => String(lead[k] || "").trim();
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

async function copyOutreach(lead) {
  const text = renderTemplate(state.settings.copy_template, lead);
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
}

// ---------- queue (the product) ----------
function buildQueue() {
  const { leads, settings, today } = state;
  const ripeCutoff = addDays(today, -3);

  const tier1 = leads
    .filter((l) => ["sent", "follow_up_1"].includes(l.status) && l.follow_up_due_at && l.follow_up_due_at <= today)
    .sort((a, b) => a.follow_up_due_at.localeCompare(b.follow_up_due_at));

  const tier2 = leads
    .filter((l) => l.status === "monitoring" && l.monitoring_started_at && l.monitoring_started_at <= ripeCutoff)
    .sort((a, b) => a.monitoring_started_at.localeCompare(b.monitoring_started_at));

  const tier3 = leads
    .filter((l) =>
      ["new", "enriched"].includes(l.status) &&
      String(l.pain_signal || "").trim() !== "" &&
      (!settings.vertical_focus || l.vertical === settings.vertical_focus.toLowerCase())
    )
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  return { tier1, tier2, tier3 };
}

function compsHTML(lead) {
  const comps = [lead.competitor_1, lead.competitor_2, lead.competitor_3].filter((c) => c && c.trim());
  if (!comps.length) return `<div class="lead-comps"><span class="watch">WATCHING</span> <span class="comp">no competitors set</span></div>`;
  return `<div class="lead-comps"><span class="watch">WATCHING</span> ${comps.map((c) => `<span class="comp">${esc(c)}</span>`).join("")}</div>`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function leadCardHTML(lead, tier) {
  const today = state.today;
  const overdue = tier === 1 && lead.follow_up_due_at < today;
  let meta = "";
  if (tier === 1) {
    const which = lead.status === "sent" ? "follow-up 1" : "follow-up 2";
    meta = `<span class="lead-due">${which} ${overdue ? "OVERDUE — was due " + fmtDate(lead.follow_up_due_at) : "due today"}</span>`;
  } else if (tier === 2) {
    const days = Math.round((toDate(today) - toDate(lead.monitoring_started_at)) / 86400000);
    meta = `<span class="lead-due" style="color:var(--beacon)">monitoring ${days}d — demo data ready</span>`;
  }
  const pain = String(lead.pain_signal || "").trim();
  const primaryBtn =
    tier === 1
      ? `<button class="btn btn-primary" data-act="follow_up" data-id="${lead.id}">✓ Complete follow-up</button>`
      : `<button class="btn btn-primary" data-act="sent" data-id="${lead.id}">→ Mark sent</button>`;
  const replyBtn = tier === 1 ? `<button class="btn" data-act="reply" data-id="${lead.id}">↩ Log reply</button>` : "";
  return `
  <div class="lead-card ${overdue ? "overdue" : ""}">
    <div class="lead-top">
      <span class="lead-brand" data-edit="${lead.id}">${esc(lead.brand)}</span>
      <span class="lead-vertical">${esc(lead.vertical)}</span>
      ${meta}
    </div>
    <div class="lead-pain ${pain ? "" : "empty"}">${pain ? esc(pain) : "no pain signal yet — click brand to enrich"}</div>
    ${compsHTML(lead)}
    <div class="lead-actions">
      ${primaryBtn}
      ${replyBtn}
      <button class="btn btn-ghost btn-copy" data-act="copy" data-id="${lead.id}">⧉ Copy outreach</button>
    </div>
  </div>`;
}

function toDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

function renderQueue() {
  const { tier1, tier2, tier3 } = buildQueue();
  const root = $("#queue");
  const tiers = [
    { n: 1, title: "Follow-ups due", items: tier1, empty: "No follow-ups due. The inbox owes you nothing." },
    { n: 2, title: "Monitoring ripe — enough demo data, reach out", items: tier2, empty: "Nothing ripe yet. Beacons still gathering." },
    { n: 3, title: state.settings.vertical_focus ? `Fresh leads · ${esc(state.settings.vertical_focus)}` : "Fresh leads · all verticals", items: tier3, empty: "No fresh leads with a pain signal. Add some or enrich what's in the pipeline." },
  ];
  const total = tier1.length + tier2.length + tier3.length;
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
      return `<div class="tier tier-${t.n}">
        <div class="tier-rail"><div class="tier-num">${t.n}</div><div class="tier-line"></div></div>
        <div class="tier-body">
          <div class="tier-title">${t.title} <span class="count">· ${t.items.length}</span></div>
          ${t.items.map((l) => leadCardHTML(l, t.n)).join("")}
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

  $("#mrr-current").textContent = Math.round(state.mrr);
  $("#mrr-goal").textContent = s.mrr_goal;
  const mrrPct = Math.min(100, (state.mrr / s.mrr_goal) * 100);
  $("#mrr-bar").style.width = mrrPct + "%";
  $("#mrr-foot").textContent =
    state.mrr >= s.mrr_goal ? "GOAL HIT. Raise the goal." : `$${Math.max(0, s.mrr_goal - state.mrr).toFixed(0)} to go`;

  $("#focus-value").textContent = s.vertical_focus || "all verticals";
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
function renderStats() {
  const leads = state.leads;
  const sends = leads.filter((l) => l.sent_at).length;
  const replies = leads.filter((l) => l.replied_at).length;
  const trials = leads.filter((l) => ["trial", "won"].includes(l.status)).length;
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

  const byVertical = {};
  for (const l of leads) {
    if (!byVertical[l.vertical]) byVertical[l.vertical] = { sends: 0, replies: 0 };
    if (l.sent_at) byVertical[l.vertical].sends++;
    if (l.replied_at) byVertical[l.vertical].replies++;
  }
  const rows = Object.entries(byVertical)
    .filter(([, v]) => v.sends > 0)
    .sort((a, b) => b[1].sends - a[1].sends);
  $("#vertical-table tbody").innerHTML = rows.length
    ? rows.map(([vert, v]) => `<tr>
        <td>${esc(vert)}</td>
        <td class="num">${v.sends}</td>
        <td class="num">${v.replies}</td>
        <td class="num">${v.sends ? Math.round((v.replies / v.sends) * 100) : 0}%</td>
      </tr>`).join("")
    : `<tr><td colspan="4" class="td-dim">No sends yet — reply rates appear once you start sending.</td></tr>`;
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
  renderPresetRows(s.competitor_presets);
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
  $("#lead-modal").showModal();
  form.elements.brand.focus();
}

async function submitLeadForm(e) {
  e.preventDefault();
  const form = $("#lead-form");
  const body = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (!editingId && ["status", "monitoring_started_at", "sent_at", "follow_up_due_at", "replied_at", "reply", "reply_sentiment"].includes(el.name)) continue;
    body[el.name] = el.value;
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
    await api(`/api/leads/${id}/transition`, { method: "POST", body: { action } });
    const verb = action === "sent" ? "Marked sent — follow-up queued in 3 days" : "Follow-up logged";
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
    toast(`Imported ${res.imported} lead${res.imported === 1 ? "" : "s"}${res.skipped ? ` · skipped ${res.skipped}` : ""}`);
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
    else if (act === "reply") openReplyModal(lead);
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
  $("#pipeline-vertical-filter").addEventListener("change", renderPipeline);

  showScreen(location.hash.slice(1) || "today");
  refresh().catch((e) => toast("Could not reach server: " + e.message, true));

  // keep "today" fresh if the tab stays open across midnight
  setInterval(() => refresh().catch(() => {}), 5 * 60 * 1000);
}

init();

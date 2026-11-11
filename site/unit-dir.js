/* Unit page, no unit picked: the Units directory, every unit the page can open (data/unit_index.json.gz,
   pipeline/unit_index.py) with its CDR name, county, zone, decision maker, QSE, ERCOT type and how it behaves in the DAM (share
   of its last 90 DAM days in quick-start standby, self-committed, with a three-part offer, awarded and on outage), filtered
   by technology, by the dropdowns (type, group, zone, QSE), by the DAM behavior chips (each Any, Yes or No; Yes means at
   least the "On at least" share of days, No less than it; every chip narrows) and by the text in the panel's Search box,
   sorted by any column. The filters are kept in the address (?tech=&type=&group=&zone=&qse=&qs=yes&dam=no&min=0.25) so a
   view can be shared; the older ?commit=qs,self links read as those chips set to Yes.
   The dropdowns and chips sit behind "More filters", which shows how many are set and opens by itself when a link sets any.
   Enter in the Search box opens the first unit listed. */
(() => {
"use strict";
const { setCSV, esc, unitIndex, findUnits, tryJSON } = window.CX;
const $ = (id) => document.getElementById(id);
const TECHS = [
  { id: "all", label: "All" }, { id: "nuclear", label: "Nuclear" }, { id: "coal", label: "Coal & lignite" },
  { id: "combined_cycle", label: "Combined cycle" }, { id: "gas_steam", label: "Gas steam" },
  { id: "combustion_turbine", label: "Combustion turbine and recip" }, { id: "wind", label: "Wind" }, { id: "solar", label: "Solar" },
  { id: "storage", label: "Battery storage" },
];
const TECH_LABEL = Object.fromEntries(TECHS.map((t) => [t.id, t.label]));
const GROUP_SHORT = { never: "Always on when available", seasonal: "Seasonal", multiday: "Off for days at a time", daily1: "Cycles daily, under once a week", daily2: "Cycles daily, 1 to 2 times a week", daily3: "Cycles daily, over twice a week", never_on: "Never on", ungrouped: "Not yet grouped" };
const GROUP_ORDER = Object.keys(GROUP_SHORT);
const COMMIT = [{ k: "qs", label: "Quick-start standby" }, { k: "self", label: "Self-committed" }, { k: "offer", label: "Three-part offer" },
  { k: "dam", label: "Day-ahead award" }, { k: "out", label: "On outage" }];
// quick links: common questions as chip settings
const PRESETS = [
  { label: "Sitting out of the DAM", chips: { dam: "no", offer: "no", self: "no", out: "no" }, min: 0 },
  { label: "Self-committed, no award", chips: { self: "yes", dam: "no" }, min: 0.5 },
  { label: "Quick-start", chips: { qs: "yes" }, min: 0 },
  { label: "Long outage", chips: { out: "yes" }, min: 0.5 },
];
const MINS = [[0, "any day"], [0.1, "10% of days"], [0.25, "25% of days"], [0.5, "50% of days"], [0.75, "75% of days"], [0.9, "90% of days"]];
const pct = (v) => (v == null ? "–" : v === 0 ? "0%" : v < 0.01 ? "<1%" : d3.format(".0%")(v));
const shareCol = (c) => ({ k: c.k, h: `${c.label}, % of DAM days`, f: (u) => (u[c.k] == null ? "–" : `<span title="${Math.round(u[c.k] * u.dam_days)} of ${u.dam_days} DAM days">${pct(u[c.k])}</span>`), opt: 1 });
const COLS = [
  { k: "unit", h: "Unit", t: 1, f: (u) => `<a href="unit.html?unit=${encodeURIComponent(u.unit)}">${esc(u.unit)}</a>` },
  { k: "tech", h: "Technology", t: 1, f: (u) => TECH_LABEL[u.tech] || esc(u.tech) },
  { k: "type", h: "ERCOT type", t: 1, f: (u) => esc(u.type || "–"), opt: 1 },
  { k: "group", h: "Group", t: 1, f: (u) => (u.group ? GROUP_SHORT[u.group] || esc(u.group) : "–") },
  { k: "mw", h: "Capacity (MW)", f: (u) => (u.mw == null ? "–" : d3.format(",")(u.mw)) },
  ...COMMIT.map(shareCol),
  { k: "shut_chg", h: "Shut rate where shutting paid", show: () => S.shut && (S.tech === "all" || S.tech === "combined_cycle" || S.tech === "gas_steam"), f: (u) => shutCell(u) },
  { k: "plant", h: "Name (CDR)", t: 1, f: (u) => (u.plant ? esc(u.plant) + (u.match === "site" ? ' <span class="tag" title="Matched by plant, not by unit">plant</span>' : "") : "–") +
    (u.aliases?.length ? `<br><span class="muted">also ${esc(u.aliases.join(", "))}</span>` : "") },
  { k: "county", h: "County", t: 1, f: (u) => esc(u.county || "–") },
  { k: "zone", h: "Zone", t: 1, f: (u) => esc(u.zone || "–") },
  { k: "dme", h: "Offers decided by", t: 1, f: (u) => esc(u.dme || "–") + (u.owner && u.owner !== u.dme ? `<br><span class="muted">owner ${esc(u.owner)}</span>` : ""), opt: 1 },
  { k: "qse", h: "QSE", t: 1, f: (u) => (u.qse_name ? esc(u.qse_name) + `<br><span class="muted">${esc(u.qse)}</span>` : esc(u.qse || "–")), opt: 1 },
  { k: "sp", h: "Settlement point", t: 1, f: (u) => esc(u.sp || "–") },
  { k: "configs", h: "Configurations", t: 1, f: (u) => (u.configs.length ? esc(u.configs.join(", ")) : "") },
];
// each CC and gas steam unit's shut rate where shutting paid (goal.json.gz q3.units rows: [train, tech, year, windows, share
// shut, LSL]), averaged over the base years and over 2024 on, years with at least q3.unit_min windows only; the same
// numbers as the Unit page's year-by-year strip (unit.js drawDecYears)
function shutRates(G) {
  const q = G?.q3;
  if (!q?.units?.length) return null;
  const min = q.unit_min, b0 = q.base_years[0], b1 = q.base_years.at(-1), by = new Map();
  for (const r of q.units) { if (r[3] < min) continue; if (!by.has(r[0])) by.set(r[0], []); by.get(r[0]).push(r); }
  const out = new Map();
  for (const [u, rs] of by) {
    const avg = (f) => { const v = rs.filter((r) => f(r[2])).map((r) => r[4]); return v.length ? d3.mean(v) : null; };
    const early = avg((y) => y >= b0 && y <= b1), late = avg((y) => y >= 2024);
    out.set(u, { early, late, chg: early != null && late != null ? late - early : null });
  }
  out.min = min;
  out.base = b0 === b1 ? `${b0}` : `${b0}–${String(b1).slice(2)}`;
  return out;
}
const shutCell = (u) => {
  const r = S.shut?.get(u.unit);
  if (!r || (r.early == null && r.late == null)) return "–";
  const pt = (v) => (v == null ? "–" : `${Math.round(100 * v)}%`);
  return `<span title="Turned off for ${pt(r.early)} of stretches where shutting paid in ${S.shut.base}, ${pt(r.late)} from 2024 on">${pt(r.early)} → ${pt(r.late)}` +
    (r.chg != null ? ` <span class="muted">(${r.chg > 0 ? "+" : r.chg < 0 ? "−" : "±"}${Math.abs(Math.round(100 * r.chg))})</span>` : "") + "</span>";
};
const S = { units: null, shut: null, tech: "all", sort: "unit", dir: 1, shown: [], f: { type: "", group: "", zone: "", qse: "" }, chip: {}, min: 0 };
const chipsOn = () => COMMIT.filter((c) => S.chip[c.k] === "yes" || S.chip[c.k] === "no");
const SELECTS = ["type", "group", "zone", "qse"];
const qseOf = (u) => u.qse || "";
const sortVal = (u, k) => (k === "shut_chg" ? S.shut?.get(u.unit)?.chg ?? null : k === "group" ? (u.group ? GROUP_ORDER.indexOf(u.group) : null) : k === "configs" ? u.configs.length : k === "qse" ? u.qse_name || u.qse : u[k]);

// every filter but the text search; each dropdown lists only values present under the other filters
function passes(u, skip) {
  if (S.tech !== "all" && u.tech !== S.tech) return false;
  for (const k of SELECTS) if (k !== skip && S.f[k] && (k === "qse" ? qseOf(u) : u[k] || "") !== S.f[k]) return false;
  for (const c of chipsOn()) {
    const v = u[c.k];
    if (v == null) return false;                          // no DAM days (or not thermal): no answer either way
    if ((S.min ? v >= S.min : v > 0) !== (S.chip[c.k] === "yes")) return false;
  }
  return true;
}
const moreSet = () => SELECTS.filter((k) => S.f[k]).length + chipsOn().length;     // filters behind "More filters"
const filtered = () => S.tech !== "all" || moreSet() || !!$("dir-search").value.trim();
function rows() {
  const q = $("dir-search").value.trim();
  let us = S.units.filter((u) => passes(u));
  if (q) { const hit = new Set(findUnits(us, q, Infinity)); us = us.filter((u) => hit.has(u)); }
  const k = S.sort;
  return us.sort((a, b) => { const p = sortVal(a, k), q2 = sortVal(b, k); if (p == null) return q2 == null ? 0 : 1; if (q2 == null) return -1;
    return (typeof p === "string" ? p.localeCompare(q2) : p - q2) * S.dir || a.unit.localeCompare(b.unit); });
}
function draw() {
  const el = $("dir-table");
  if (!S.units) return;
  if (!S.units.length) { el.innerHTML = `<p class="empty">The unit list is not available.</p>`; return; }
  const us = S.shown = rows();
  const cols = COLS.filter((c) => (c.show ? c.show() : !c.opt || S.units.some((u) => u[c.k])));      // QSE and decision maker only once the data has them
  const q = $("dir-search").value.trim(), of = S.units.filter((u) => S.tech === "all" || u.tech === S.tech).length;
  const more = SELECTS.some((k) => S.f[k]) || chipsOn().length;
  $("dir-note").textContent = (q || more ? `${us.length} of ${of}` : `${of}`) + (S.tech === "all" ? " units" : ` ${TECH_LABEL[S.tech].toLowerCase()} units`) +
    (more ? " with these filters" : "") + (q ? ` matching “${q}”` : "");
  fillSelects(); writeURL();
  el.innerHTML = us.length ? `<table class="data"><thead><tr>${cols.map((c) => `<th class="sortable${c.t ? " t" : ""}" data-k="${c.k}">${c.h}${S.sort === c.k ? (S.dir < 0 ? " ▾" : " ▴") : ""}</th>`).join("")}</tr></thead><tbody>` +
    us.map((u) => `<tr>${cols.map((c) => `<td${c.t ? ' class="t"' : ""}>${c.f(u)}</td>`).join("")}</tr>`).join("") + "</tbody></table>"
    : `<p class="empty">No unit matches. Try part of the name or the settlement point.</p>`;
  el.querySelectorAll("th[data-k]").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.k; if (S.sort === k) S.dir = -S.dir; else if (k === "shut_chg") { S.sort = k; S.dir = 1; } else { S.sort = k; S.dir = ["mw", "configs", "qs", "self", "offer", "dam", "out"].includes(k) ? -1 : 1; }
    draw();
  }));
  setCSV(el, ["unit", "technology", "ercot_type", "group", "capacity_mw", "quick_start_share", "self_committed_share", "three_part_offer_share", "dam_award_share", "outage_share", "dam_days", "cdr_name", "cdr_match", "other_names", "county", "zone", "decision_maker", "owner", "qse", "qse_name", "settlement_point", "configurations", "shut_rate_base_years", "shut_rate_2024_on", "shut_rate_change"],
    us.map((u) => { const r = S.shut?.get(u.unit); return [u.unit, u.tech, u.type, u.group, u.mw, u.qs, u.self, u.offer, u.dam, u.out, u.dam_days, u.plant, u.match, (u.aliases || []).join("; "), u.county, u.zone, u.dme, u.owner, u.qse, u.qse_name, u.sp, u.configs.join(" "), r?.early ?? "", r?.late ?? "", r?.chg ?? ""]; }), "Units");
}

// the dropdowns: values present among the units passing every other filter, with counts; a picked value always stays listed
const LABEL = { group: (v) => GROUP_SHORT[v] || v, zone: (v) => v, type: (v) => v, qse: (v) => v };
function fillSelects() {
  for (const k of SELECTS) {
    const n = new Map(), names = new Map();
    for (const u of S.units) {
      if (!passes(u, k)) continue;
      const v = k === "qse" ? qseOf(u) : u[k];
      if (!v) continue;
      n.set(v, (n.get(v) || 0) + 1);
      if (k === "qse" && u.qse_name) names.set(v, u.qse_name);
    }
    if (S.f[k] && !n.has(S.f[k])) n.set(S.f[k], 0);
    const vals = [...n.keys()].sort(k === "group" ? (a, b) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b)
      : k === "qse" ? (a, b) => (names.get(a) || a).localeCompare(names.get(b) || b) : (a, b) => String(a).localeCompare(String(b)));
    const lab = (v) => (k === "qse" && names.get(v) ? `${names.get(v)} (${v})` : LABEL[k](v));
    $(`dir-${k}`).innerHTML = `<option value="">All</option>` + vals.map((v) => `<option value="${esc(v)}"${v === S.f[k] ? " selected" : ""}>${esc(lab(v))} · ${n.get(v)}</option>`).join("");
  }
  $("dir-min-ctl").hidden = !chipsOn().length;
  $("dir-clear").hidden = !filtered();
  const n = moreSet();
  $("dir-more").textContent = n ? `More filters (${n})` : "More filters";
}
function readURL() {
  const p = new URLSearchParams(location.search);
  if (TECHS.some((t) => t.id === p.get("tech"))) S.tech = p.get("tech");
  for (const k of SELECTS) S.f[k] = p.get(k) || "";
  S.chip = {};
  for (const k of (p.get("commit") || "").split(",")) if (COMMIT.some((c) => c.k === k)) S.chip[k] = "yes";   // older links
  for (const c of COMMIT) if (["yes", "no"].includes(p.get(c.k))) S.chip[c.k] = p.get(c.k);
  const m = +p.get("min"); S.min = MINS.some(([v]) => v === m) ? m : 0;
}
function writeURL() {
  if (!$("unit-empty") || $("unit-empty").hidden) return;     // a unit's own page keeps its own address
  const p = new URLSearchParams(location.search);
  const set = (k, v) => (v ? p.set(k, v) : p.delete(k));
  set("tech", S.tech === "all" ? "" : S.tech);
  for (const k of SELECTS) set(k, S.f[k]);
  p.delete("commit");
  for (const c of COMMIT) set(c.k, chipsOn().includes(c) ? S.chip[c.k] : "");
  set("min", chipsOn().length && S.min ? String(S.min) : "");
  const s = p.toString(), at = location.pathname + (s ? "?" + s : "") + location.hash;
  if (at !== location.pathname + location.search + location.hash) history.replaceState(null, "", at);
}

async function boot() {
  // a unit in the link: unit.js shows its page, or shows this panel again if the name is unknown
  if (new URLSearchParams(location.search).get("unit")) $("unit-empty").hidden = true;
  else {
    $("unit-title").textContent = "Units"; document.title = "Units · ERCOT Bids";
    $("unit-meta").textContent = "Every unit the site follows. Open one for its turn-off decisions and the loss it rides through, when it ran, how it bids, and what it earned.";
  }
  readURL();
  const seg = $("dir-tech");
  seg.innerHTML = TECHS.map((t) => `<button type="button" role="radio" data-v="${t.id}" aria-checked="${t.id === S.tech}">${t.label}</button>`).join("");
  seg.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; S.tech = b.dataset.v;
    seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x === b))); draw(); });
  for (const k of SELECTS) $(`dir-${k}`).addEventListener("change", (e) => { S.f[k] = e.target.value; draw(); });
  const cm = $("dir-commit");
  cm.innerHTML = COMMIT.map((c) => `<div class="chip" role="radiogroup" aria-label="${c.label}"><span class="chip-l">${c.label}</span><span class="seg seg-sm">` +
    ["any", "yes", "no"].map((v) => `<button type="button" role="radio" data-k="${c.k}" data-v="${v}">${v[0].toUpperCase() + v.slice(1)}</button>`).join("") + "</span></div>").join("");
  const paintCommit = () => cm.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String((S.chip[x.dataset.k] || "any") === x.dataset.v)));
  cm.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.v === "any") delete S.chip[b.dataset.k]; else S.chip[b.dataset.k] = b.dataset.v; paintCommit(); draw(); });
  $("dir-presets").innerHTML = PRESETS.map((q, i) => `<button type="button" class="dir-preset" data-i="${i}">${q.label}</button>`).join("");
  $("dir-presets").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return;
    const q = PRESETS[+b.dataset.i]; S.chip = { ...q.chips }; S.min = q.min; $("dir-min").value = String(S.min); paintCommit(); draw(); });
  $("dir-min").innerHTML = MINS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
  $("dir-min").value = String(S.min);
  $("dir-min").addEventListener("change", (e) => { S.min = +e.target.value; draw(); });
  $("dir-clear").addEventListener("click", () => {
    S.tech = "all"; S.chip = {}; S.min = 0; $("dir-min").value = "0"; for (const k of SELECTS) S.f[k] = ""; $("dir-search").value = "";
    seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x.dataset.v === "all"))); paintCommit(); draw();
  });
  paintCommit();
  const more = $("dir-more"), body = $("dir-more-body");
  const openMore = (on) => { body.hidden = !on; more.setAttribute("aria-expanded", String(on)); };
  more.addEventListener("click", () => openMore(body.hidden));
  openMore(moreSet() > 0);                                     // a shared link with filters set shows them
  const pick = $("dir-search");
  pick.addEventListener("input", draw);
  pick.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || $("unit-empty").hidden || !S.shown.length || !pick.value.trim()) return;
    e.preventDefault();
    const q = pick.value.trim(), hit = S.shown.find((u) => u.unit === q) || S.shown[0];   // an exact name, else the first row
    location.href = `unit.html?unit=${encodeURIComponent(hit.unit)}`;
  });
  S.units = (await unitIndex()) || [];
  if (unitIndex.cdr) $("dir-cdr").textContent = ` (${unitIndex.cdr})`;
  const w = unitIndex.commitWindow;
  if (w) $("dir-window").textContent = ` (${w[0]} to ${w[1]})`;
  // before the pipeline writes the new columns, hide the controls that need them
  const has = (k) => S.units.some((u) => u[k] != null);
  $("dir-commit-ctl").hidden = !has("qs");
  for (const c of COMMIT) if (!has(c.k)) { cm.querySelector(`[data-k="${c.k}"]`).closest(".chip").hidden = true; delete S.chip[c.k]; }   // shares the next update adds
  $("dir-presets").querySelectorAll("button").forEach((b) => { b.hidden = Object.keys(PRESETS[+b.dataset.i].chips).some((k) => !has(k)); }); $("dir-type").closest(".ctl").hidden = !has("type");
  draw();
  // the shut-rate column: the goal page's data, after the table is up
  S.shut = shutRates(await tryJSON("data/goal.json.gz"));
  if (S.shut) { COLS.find((c) => c.k === "shut_chg").h = `Shut rate where shutting paid, ${S.shut.base} → 2024 on`; $("dir-shut-base").textContent = S.shut.base; $("dir-shut-min").textContent = S.shut.min; draw(); }
}
boot();
})();

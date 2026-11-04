/* Unit page, no unit picked: the Units directory, every unit the page can open (data/unit_index.json.gz,
   pipeline/unit_index.py) with its CDR name, county, zone, decision maker, QSE, ERCOT type and how it is committed (share of
   its last 90 DAM days in quick-start standby, self-committed and awarded), filtered by technology, by the dropdowns (type,
   group, zone, QSE, commitment style with a minimum share) and by the text in the page's Unit box, sorted by any column.
   The filters are kept in the address (?tech=&type=&group=&zone=&qse=&commit=qs,self&min=0.25) so a view can be shared.
   Enter in the Unit box opens the first unit listed. */
(() => {
"use strict";
const { setCSV, esc, unitIndex, findUnits } = window.CX;
const $ = (id) => document.getElementById(id);
const TECHS = [
  { id: "all", label: "All" }, { id: "nuclear", label: "Nuclear" }, { id: "coal", label: "Coal & lignite" },
  { id: "combined_cycle", label: "Combined cycle" }, { id: "gas_steam", label: "Gas steam" },
  { id: "combustion_turbine", label: "Combustion turbine and recip" }, { id: "wind", label: "Wind" }, { id: "solar", label: "Solar" },
  { id: "storage", label: "Battery storage" },
];
const TECH_LABEL = Object.fromEntries(TECHS.map((t) => [t.id, t.label]));
const GROUP_SHORT = { never: "Always on when available", seasonal: "Seasonal", multiday: "Multi-day", daily1: "Daily, under once a week", daily2: "Daily, 1 to 2 a week", daily3: "Daily, over 2 a week", never_on: "Never on", ungrouped: "Not yet grouped" };
const GROUP_ORDER = Object.keys(GROUP_SHORT);
const COMMIT = [{ k: "qs", label: "Quick-start" }, { k: "self", label: "Self-committed" }, { k: "dam", label: "DAM award" }];
const MINS = [[0, "Any day"], [0.1, "10% of days"], [0.25, "25% of days"], [0.5, "50% of days"], [0.75, "75% of days"], [0.9, "90% of days"]];
const pct = (v) => (v == null ? "–" : v === 0 ? "0%" : v < 0.01 ? "<1%" : d3.format(".0%")(v));
const shareCol = (c) => ({ k: c.k, h: c.label, f: (u) => (u[c.k] == null ? "–" : `<span title="${Math.round(u[c.k] * u.dam_days)} of ${u.dam_days} DAM days">${pct(u[c.k])}</span>`), opt: 1 });
const COLS = [
  { k: "unit", h: "Unit", t: 1, f: (u) => `<a href="unit.html?unit=${encodeURIComponent(u.unit)}">${esc(u.unit)}</a>` },
  { k: "tech", h: "Technology", t: 1, f: (u) => TECH_LABEL[u.tech] || esc(u.tech) },
  { k: "type", h: "ERCOT type", t: 1, f: (u) => esc(u.type || "–"), opt: 1 },
  { k: "group", h: "Group", t: 1, f: (u) => (u.group ? GROUP_SHORT[u.group] || esc(u.group) : "–") },
  { k: "mw", h: "Capacity (MW)", f: (u) => (u.mw == null ? "–" : d3.format(",")(u.mw)) },
  ...COMMIT.map(shareCol),
  { k: "plant", h: "Name (CDR)", t: 1, f: (u) => (u.plant ? esc(u.plant) + (u.match === "site" ? ' <span class="tag" title="Matched by plant, not by unit">plant</span>' : "") : "–") +
    (u.aliases?.length ? `<br><span class="muted">also ${esc(u.aliases.join(", "))}</span>` : "") },
  { k: "county", h: "County", t: 1, f: (u) => esc(u.county || "–") },
  { k: "zone", h: "Zone", t: 1, f: (u) => esc(u.zone || "–") },
  { k: "dme", h: "Decides offers", t: 1, f: (u) => esc(u.dme || "–") + (u.owner && u.owner !== u.dme ? `<br><span class="muted">owner ${esc(u.owner)}</span>` : ""), opt: 1 },
  { k: "qse", h: "QSE", t: 1, f: (u) => (u.qse_name ? esc(u.qse_name) + `<br><span class="muted">${esc(u.qse)}</span>` : esc(u.qse || "–")), opt: 1 },
  { k: "sp", h: "Settlement point", t: 1, f: (u) => esc(u.sp || "–") },
  { k: "configs", h: "Configurations", t: 1, f: (u) => (u.configs.length ? esc(u.configs.join(", ")) : "") },
];
const S = { units: null, tech: "all", sort: "unit", dir: 1, shown: [], f: { type: "", group: "", zone: "", qse: "" }, commit: new Set(), min: 0 };
const SELECTS = ["type", "group", "zone", "qse"];
const qseOf = (u) => u.qse || "";
const sortVal = (u, k) => (k === "group" ? (u.group ? GROUP_ORDER.indexOf(u.group) : null) : k === "configs" ? u.configs.length : k === "qse" ? u.qse_name || u.qse : u[k]);

// every filter but the text search; each dropdown lists only values present under the other filters
function passes(u, skip) {
  if (S.tech !== "all" && u.tech !== S.tech) return false;
  for (const k of SELECTS) if (k !== skip && S.f[k] && (k === "qse" ? qseOf(u) : u[k] || "") !== S.f[k]) return false;
  if (skip !== "commit" && S.commit.size && ![...S.commit].some((k) => u[k] != null && (S.min ? u[k] >= S.min : u[k] > 0))) return false;
  return true;
}
const filtered = () => S.tech !== "all" || S.commit.size || SELECTS.some((k) => S.f[k]);
function rows() {
  const q = $("unit-pick").value.trim();
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
  const cols = COLS.filter((c) => !c.opt || S.units.some((u) => u[c.k]));      // QSE and decision maker only once the data has them
  const q = $("unit-pick").value.trim(), of = S.units.filter((u) => S.tech === "all" || u.tech === S.tech).length;
  const more = SELECTS.some((k) => S.f[k]) || S.commit.size;
  $("dir-note").textContent = (q || more ? `${us.length} of ${of}` : `${of}`) + (S.tech === "all" ? " units" : ` ${TECH_LABEL[S.tech].toLowerCase()} units`) +
    (more ? " with these filters" : "") + (q ? ` matching “${q}”` : "");
  fillSelects(); writeURL();
  el.innerHTML = us.length ? `<table class="data"><thead><tr>${cols.map((c) => `<th class="sortable${c.t ? " t" : ""}" data-k="${c.k}">${c.h}${S.sort === c.k ? (S.dir < 0 ? " ▾" : " ▴") : ""}</th>`).join("")}</tr></thead><tbody>` +
    us.map((u) => `<tr>${cols.map((c) => `<td${c.t ? ' class="t"' : ""}>${c.f(u)}</td>`).join("")}</tr>`).join("") + "</tbody></table>"
    : `<p class="empty">No unit matches. Try part of the name or the settlement point.</p>`;
  el.querySelectorAll("th[data-k]").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.k; if (S.sort === k) S.dir = -S.dir; else { S.sort = k; S.dir = ["mw", "configs", "qs", "self", "dam"].includes(k) ? -1 : 1; }
    draw();
  }));
  setCSV(el, ["unit", "technology", "ercot_type", "group", "capacity_mw", "quick_start_share", "self_committed_share", "dam_award_share", "dam_days", "cdr_name", "cdr_match", "other_names", "county", "zone", "decision_maker", "owner", "qse", "qse_name", "settlement_point", "configurations"],
    us.map((u) => [u.unit, u.tech, u.type, u.group, u.mw, u.qs, u.self, u.dam, u.dam_days, u.plant, u.match, (u.aliases || []).join("; "), u.county, u.zone, u.dme, u.owner, u.qse, u.qse_name, u.sp, u.configs.join(" ")]), "Units");
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
  $("dir-min-ctl").hidden = !S.commit.size;
  $("dir-clear").hidden = !filtered();
}
function readURL() {
  const p = new URLSearchParams(location.search);
  if (TECHS.some((t) => t.id === p.get("tech"))) S.tech = p.get("tech");
  for (const k of SELECTS) S.f[k] = p.get(k) || "";
  S.commit = new Set((p.get("commit") || "").split(",").filter((k) => COMMIT.some((c) => c.k === k)));
  const m = +p.get("min"); S.min = MINS.some(([v]) => v === m) ? m : 0;
}
function writeURL() {
  if (!$("unit-empty") || $("unit-empty").hidden) return;     // a unit's own page keeps its own address
  const p = new URLSearchParams(location.search);
  const set = (k, v) => (v ? p.set(k, v) : p.delete(k));
  set("tech", S.tech === "all" ? "" : S.tech);
  for (const k of SELECTS) set(k, S.f[k]);
  set("commit", [...S.commit].join(",")); set("min", S.commit.size && S.min ? String(S.min) : "");
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
  const paintCommit = () => cm.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(S.commit.has(x.dataset.v))));
  cm.innerHTML = COMMIT.map((c) => `<button type="button" data-v="${c.k}" aria-pressed="false">${c.label}</button>`).join("");
  cm.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return;
    S.commit.has(b.dataset.v) ? S.commit.delete(b.dataset.v) : S.commit.add(b.dataset.v); paintCommit(); draw(); });
  $("dir-min").innerHTML = MINS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
  $("dir-min").value = String(S.min);
  $("dir-min").addEventListener("change", (e) => { S.min = +e.target.value; draw(); });
  $("dir-clear").addEventListener("click", () => {
    S.tech = "all"; S.commit.clear(); S.min = 0; $("dir-min").value = "0"; for (const k of SELECTS) S.f[k] = "";
    seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x.dataset.v === "all"))); paintCommit(); draw();
  });
  paintCommit();
  const pick = $("unit-pick");
  pick.addEventListener("input", draw);
  pick.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || $("unit-empty").hidden || !S.shown.length) return;
    if (S.shown.some((u) => u.unit === pick.value.trim())) return;    // an exact name: unit.js opens it
    e.preventDefault();
    pick.value = S.shown[0].unit;
    pick.dispatchEvent(new Event("change"));
  });
  S.units = (await unitIndex()) || [];
  if (unitIndex.cdr) $("dir-cdr").textContent = ` (${unitIndex.cdr})`;
  const w = unitIndex.commitWindow;
  if (w) $("dir-window").textContent = ` (${w[0]} to ${w[1]})`;
  // before the pipeline writes the new columns, hide the controls that need them
  const has = (k) => S.units.some((u) => u[k] != null);
  $("dir-commit-ctl").hidden = !has("qs"); $("dir-type").closest(".ctl").hidden = !has("type");
  draw();
}
boot();
})();

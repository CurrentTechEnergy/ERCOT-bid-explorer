/* Unit page, no unit picked: the Units directory, every unit the page can open (data/unit_index.json.gz,
   pipeline/unit_index.py) with its CDR name, county, zone, decision maker and QSE, filtered by technology and by the text
   in the page's Unit box, sorted by any column. Enter in the Unit box opens the first unit listed. */
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
const COLS = [
  { k: "unit", h: "Unit", t: 1, f: (u) => `<a href="unit.html?unit=${encodeURIComponent(u.unit)}">${esc(u.unit)}</a>` },
  { k: "tech", h: "Technology", t: 1, f: (u) => TECH_LABEL[u.tech] || esc(u.tech) },
  { k: "group", h: "Group", t: 1, f: (u) => (u.group ? GROUP_SHORT[u.group] || esc(u.group) : "–") },
  { k: "mw", h: "Capacity (MW)", f: (u) => (u.mw == null ? "–" : d3.format(",")(u.mw)) },
  { k: "plant", h: "Name (CDR)", t: 1, f: (u) => (u.plant ? esc(u.plant) + (u.match === "site" ? ' <span class="tag" title="Matched by plant, not by unit">plant</span>' : "") : "–") +
    (u.aliases?.length ? `<br><span class="muted">also ${esc(u.aliases.join(", "))}</span>` : "") },
  { k: "county", h: "County", t: 1, f: (u) => esc(u.county || "–") },
  { k: "zone", h: "Zone", t: 1, f: (u) => esc(u.zone || "–") },
  { k: "dme", h: "Decides offers", t: 1, f: (u) => esc(u.dme || "–") + (u.owner && u.owner !== u.dme ? `<br><span class="muted">owner ${esc(u.owner)}</span>` : ""), opt: 1 },
  { k: "qse", h: "QSE", t: 1, f: (u) => (u.qse_name ? esc(u.qse_name) + `<br><span class="muted">${esc(u.qse)}</span>` : esc(u.qse || "–")), opt: 1 },
  { k: "sp", h: "Settlement point", t: 1, f: (u) => esc(u.sp || "–") },
  { k: "configs", h: "Configurations", t: 1, f: (u) => (u.configs.length ? esc(u.configs.join(", ")) : "") },
];
const S = { units: null, tech: "all", sort: "unit", dir: 1, shown: [] };
const sortVal = (u, k) => (k === "group" ? (u.group ? GROUP_ORDER.indexOf(u.group) : null) : k === "configs" ? u.configs.length : k === "qse" ? u.qse_name || u.qse : u[k]);

function rows() {
  const q = $("unit-pick").value.trim();
  let us = S.units.filter((u) => S.tech === "all" || u.tech === S.tech);
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
  $("dir-note").textContent = (q ? `${us.length} of ${of}` : `${of}`) + (S.tech === "all" ? " units" : ` ${TECH_LABEL[S.tech].toLowerCase()} units`) + (q ? ` matching “${q}”` : "");
  el.innerHTML = us.length ? `<table class="data"><thead><tr>${cols.map((c) => `<th class="sortable${c.t ? " t" : ""}" data-k="${c.k}">${c.h}${S.sort === c.k ? (S.dir < 0 ? " ▾" : " ▴") : ""}</th>`).join("")}</tr></thead><tbody>` +
    us.map((u) => `<tr>${cols.map((c) => `<td${c.t ? ' class="t"' : ""}>${c.f(u)}</td>`).join("")}</tr>`).join("") + "</tbody></table>"
    : `<p class="empty">No unit matches. Try part of the name or the settlement point.</p>`;
  el.querySelectorAll("th[data-k]").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.k; if (S.sort === k) S.dir = -S.dir; else { S.sort = k; S.dir = ["mw", "configs"].includes(k) ? -1 : 1; }
    draw();
  }));
  setCSV(el, ["unit", "technology", "group", "capacity_mw", "cdr_name", "cdr_match", "other_names", "county", "zone", "decision_maker", "owner", "qse", "qse_name", "settlement_point", "configurations"],
    us.map((u) => [u.unit, u.tech, u.group, u.mw, u.plant, u.match, (u.aliases || []).join("; "), u.county, u.zone, u.dme, u.owner, u.qse, u.qse_name, u.sp, u.configs.join(" ")]), "Units");
}

async function boot() {
  // a unit in the link: unit.js shows its page, or shows this panel again if the name is unknown
  if (new URLSearchParams(location.search).get("unit")) $("unit-empty").hidden = true;
  else {
    $("unit-title").textContent = "Units"; document.title = "Units · ERCOT Bids";
    $("unit-meta").textContent = "Every unit the site follows. Open one for its turn-off decisions and the loss it rides through, when it ran, how it bids, and what it earned.";
  }
  const seg = $("dir-tech");
  seg.innerHTML = TECHS.map((t) => `<button type="button" role="radio" data-v="${t.id}" aria-checked="${t.id === S.tech}">${t.label}</button>`).join("");
  seg.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; S.tech = b.dataset.v;
    seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x === b))); draw(); });
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
  draw();
}
boot();
})();

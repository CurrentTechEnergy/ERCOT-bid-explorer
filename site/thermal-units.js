/* Thermal page, the 60-day days: every thermal unit's revenue, running cost and margin on the cost and
   revenue basis chosen (one unit's economics are on unit.html, unit-econ.js), and run hours and starts
   by year for the chosen technology. Reads data/econ_index.json.gz and data/econ/<tech>.json.gz
   (pipeline/econ.py). Costs are computed here from the chosen basis, so the inputs can be changed
   without rebuilding the data. Owns the page's technology picker (#tech) and tells thermal-years.js
   when it changes ("thermal-tech" event). The across-the-years panels are thermal-years.js. */
(() => {
"use strict";

const TECHS = [
  { id: "combined_cycle", label: "Combined cycle", color: "--c1" },
  { id: "combustion_turbine", label: "Combustion turbine and recip", color: "--c2" },
  { id: "gas_steam", label: "Gas steam", color: "--c6" },
  { id: "coal", label: "Coal & lignite", color: "--c8" },
  { id: "nuclear", label: "Nuclear", color: "--c5" },
];
const FUEL = { combined_cycle: "gas", combustion_turbine: "gas", gas_steam: "gas", coal: "coal", nuclear: "nuclear" };
// EIA Electric Power Annual, table 8.2 (average tested heat rates, 2024), MMBtu per MWh
const EIA_HR = { combined_cycle: 7.548, combustion_turbine: 10.999, gas_steam: 10.337, coal: 10.018, nuclear: 10.443 };
// generic defaults: heat rate (MMBtu/MWh), variable O&M ($/MWh), hot, intermediate and cold start ($,
// the site's GENERIC_COSTS; a start is intermediate after more than 8 hours offline, cold after 24), fuel price for
// non-gas fuels ($/MMBtu). Edit them in the Cost assumptions panel.
const DEFAULTS = {
  combined_cycle: { hr: 7.0, vom: 3.0, start: 15000, start_inter: 25000, start_cold: 40000 },
  combustion_turbine: { hr: 11.0, vom: 5.0, start: 3000, start_inter: 4000, start_cold: 5000 },
  gas_steam: { hr: 10.5, vom: 4.0, start: 10000, start_inter: 20000, start_cold: 30000 },
  coal: { hr: 10.5, vom: 5.0, start: 30000, start_inter: 60000, start_cold: 90000 },
  nuclear: { hr: 10.4, vom: 2.5, start: 0, start_inter: 0, start_cold: 0 },
};
const FUEL_PRICE = { coal: 2.0, nuclear: 0.7 };     // $/MMBtu, user-editable
const COST_NOTES = {
  meas: "Fuel cost = each hour's output × the unit's own heat rate at that output × its fuel price, plus variable O&M per MWh. The heat rate runs in a straight line from the unit's measured heat rate at minimum output to its full-load one, both from EPA hourly stack data against its ERCOT net output. A cogeneration unit uses its plant's EIA-923 fuel for electricity with the steam host's share taken out; a unit with no measurement takes its technology's median. Gas is the unit's own hub price plus the adder (or Henry Hub if chosen); coal is the plant's delivered EIA-923 price; nuclear uses the EIA heat rate. Each start costs the unit's own day-ahead start offer for its class (hot after 8 hours offline or fewer, intermediate up to 24, cold beyond, timed run by run), else the generic cost below.",
  eia: "Fuel = output × the EIA average tested heat rate for the technology × the fuel price (the chosen gas price plus the adder for gas; the $/MMBtu set here for coal and nuclear), plus variable O&M per MWh. Each start costs the unit's own DAM start offer for its class (hot, intermediate or cold by hours offline) where it has one, else the generic cost.",
  offer: "Energy cost = the area under the unit's own DAM energy offer curve up to each hour's output; where the unit offered no curve, its minimum-energy offer × output; where it submitted no three-part offer at all, the generic basis. Each start costs its DAM start offer for its class (hot, intermediate or cold by hours offline), else the generic cost.",
  inc: "Energy cost = each hour's output × the price the unit's own DAM energy offer curve puts on that output level (its incremental offer, read as its marginal cost), ignoring the minimum-energy price that units set low to get committed. Units with no DAM curve use the generic basis and are counted as estimated. Each start costs its DAM start offer for its class (hot, intermediate or cold by hours offline), else the generic cost.",
  generic: "Fuel = output × the heat rate set here × the fuel price (the chosen gas price plus the adder for gas; the $/MMBtu set here for coal and nuclear), plus variable O&M per MWh and the hot, intermediate or cold start cost per start by hours offline.",
};
const { tryJSON, setCSV, esc } = window.CX;
const $ = (id) => document.getElementById(id);
const fmt0 = d3.format(",.0f"), fmt1 = d3.format(",.1f"), fmtPct = d3.format(".0%");
const fmt$k = (v) => {      // compact money: $12k, $1.2M, $3.4B
  if (v == null || isNaN(v)) return "–";
  const a = Math.abs(v), sign = v < 0 ? "−" : "";
  return sign + "$" + (a >= 1e9 ? d3.format(",.2f")(a / 1e9) + "B" : a >= 1e6 ? d3.format(",.1f")(a / 1e6) + "M" : a >= 1e3 ? fmt0(a / 1e3) + "k" : fmt0(a));
};
const fmt$2 = (v) => (v == null || isNaN(v) ? "–" : (v < 0 ? "−" : "") + "$" + d3.format(",.2f")(Math.abs(v)));
const parseDate = (d) => new Date(d + "T12:00:00");

// gas price used for gas-fired fuel cost: "unit", each unit's own fuel hub (Waha or Houston Ship
// Channel, from pipeline/fuel_hub.py), costed in the pipeline (econ.py gas_own) because the hub
// prices are licensed and not published; or "hh", Henry Hub from the EIA
const HUBS = { hsc: "Houston Ship Channel", waha: "Waha", hh: "Henry Hub" };
const HUB_CHOICES = { unit: "each unit's own hub", hh: HUBS.hh };
const S = { tech: "combined_cycle", cost: "meas", rev: "two", hub: "unit", adder: 0, sort: "margin", dir: -1, q: "",
  params: JSON.parse(JSON.stringify(DEFAULTS)), fuel: { ...FUEL_PRICE }, idx: null, data: {} };
const VIEW_KEYS = { tech: "tech", cost: "cost", rev: "rev", gas: "hub", adder: "adder", sort: "sort" };
function saveView() { window.CX.writeHash({ ...window.CX.readHash(), ...Object.fromEntries(Object.entries(VIEW_KEYS).map(([k, sk]) => [k, S[sk]])) }); }
function loadView() { const v = window.CX.readHash(); Object.entries(VIEW_KEYS).forEach(([k, sk]) => { if (v[k] != null) S[sk] = k === "adder" ? +v[k] : v[k]; }); }
function setSeg(id, value) { $(id).querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === value))); }
function bindSeg(id, key, after) {
  $(id).addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; S[key] = b.dataset.v; setSeg(id, S[key]); after(); saveView(); });
}
function emptyMsg(el, msg) { el.innerHTML = `<p class="empty">${msg}</p>`; }

// ---- economics of one unit on the chosen bases -------------------------------------
// returns per-day arrays: energy, as, fuel (fuel + VOM), starts (start cost), margin, and flags
// gas: the Henry Hub series, or null to cost gas at the unit's own hub from its gas_own (the day's gas
// bill per 1 MMBtu/MWh of heat rate, built by the pipeline, which does not publish the hub prices)
function unitEcon(u, D, gas) {
  const t = S.tech, p = S.params[t] || {}, fuelKind = FUEL[t];
  // the day's fuel bill at heat rate hr ($, before variable O&M), or null with no fuel price
  const fuelBill = (i, mwh, hr) => {
    if (fuelKind !== "gas") return mwh * hr * (fuelKind ? S.fuel[fuelKind] : 0);
    if (!gas) return u.gas_own[i] == null ? null : u.gas_own[i] * hr + mwh * hr * S.adder;
    return gas[i] == null ? null : mwh * hr * (gas[i] + S.adder);
  };
  const out = { energy: [], as: [], fuel: [], starts: [], margin: [], lamDays: 0, missing: 0, est: 0 };
  for (let i = 0; i < D; i++) {
    const mwh = u.mwh[i];
    if (mwh == null) { ["energy", "as", "fuel", "starts", "margin"].forEach((k) => out[k].push(null)); continue; }
    let energy;
    const two = u.rev_da[i] != null && u.rev_rt[i] != null && u.rev_da_rt[i] != null ? u.rev_da[i] + u.rev_rt[i] - u.rev_da_rt[i] : null;
    if (S.rev === "two" && two != null) energy = two;
    else if (S.rev !== "lam" && u.rev_rt[i] != null) energy = u.rev_rt[i];
    else { energy = u.rev_lam[i]; if (S.rev !== "lam") out.lamDays++; }
    const as = u.rev_as[i] || 0;
    let fuel = 0, starts = 0, estimated = false;
    if (fuelKind) {
      const sc = (useOwn) => window.CX.startCost(u, i, p, useOwn);
      if (S.cost === "offer" || S.cost === "inc") {
        const own_cost = S.cost === "inc" ? u.cost_inc[i] : u.cost_off[i];
        if (own_cost != null) fuel = own_cost;
        else if (S.cost === "offer" && u.mingen[i] != null) fuel = mwh * u.mingen[i];
        else { const b = fuelBill(i, mwh, p.hr); fuel = b == null ? null : b + mwh * p.vom; estimated = b != null; }
        starts = sc(true).cost;
      } else if (S.cost === "meas" && u.mmbtu && u.mmbtu[i] != null && (fuelKind === "gas" || fuelKind === "coal")) {
        // the pipeline's burn on the unit's measured heat-rate curve (econ.py mmbtu), priced at its
        // own hub (fuel_meas: the hub prices are not published) or Henry Hub, or its plant's coal price
        const b = fuelKind === "coal" ? (u.fuel_meas ? u.fuel_meas[i] : null)
          : gas ? (gas[i] == null ? null : u.mmbtu[i] * (gas[i] + S.adder))
          : (u.fuel_meas && u.fuel_meas[i] != null ? u.fuel_meas[i] + u.mmbtu[i] * S.adder : null);
        fuel = b == null ? null : b + mwh * p.vom;
        const st = sc(true);
        starts = st.cost;
        if (st.estimated) estimated = true;
      } else {
        // EIA (and measured where the unit has no burn: nuclear, or a day without it), or generic
        const eia = S.cost === "eia" || S.cost === "meas";
        const hr = eia ? EIA_HR[t] : p.hr;
        const b = fuelBill(i, mwh, hr);
        fuel = b == null ? null : b + mwh * p.vom;
        const st = sc(eia);
        starts = st.cost;
        if ((st.n && sc(true).estimated) || (S.cost === "meas" && fuelKind !== "nuclear")) estimated = true;
      }
    }
    if (fuel == null) { out.missing++; out.energy.push(energy); out.as.push(as); out.fuel.push(null); out.starts.push(starts); out.margin.push(null); continue; }
    if (estimated) out.est++;
    out.energy.push(energy); out.as.push(as); out.fuel.push(fuel); out.starts.push(starts);
    out.margin.push(energy + as - fuel - starts);
  }
  return out;
}
const sum = (a) => d3.sum(a.filter((v) => v != null));

const COST_NAME = { meas: "each unit's measured heat rate", eia: "the EIA average heat rate", offer: "each unit's own day-ahead offer", inc: "each unit's incremental day-ahead offer", generic: "the generic heat rate set below" };
const REV_NAME = { two: "on the two-settlement basis", rt: "at the real-time node price", lam: "at system lambda" };

// ---- panels --------------------------------------------------------------------------
let ECON = {};     // unit name -> unitEcon result, for the current tech and bases
// the gas series for a unit under the current choice: null (its own hub, from gas_own) or Henry Hub
const ownHub = (u) => S.hub === "unit" && !!u.gas_own;
const gasFor = (T, u) => (ownHub(u) ? null : T.gas);
function gasLabel(T) {
  if (S.hub !== "unit") return HUBS.hh;
  const us = Object.values(T.units), n = us.filter((u) => u.gas_hub === "waha").length;
  if (!us.some((u) => u.gas_own)) return `${HUBS.hh} (no own-hub costs in this data)`;
  return `each unit's own hub (${n} on Waha, the rest Houston Ship Channel)`;
}
function compute() {
  const T = S.data[S.tech];
  ECON = {};
  if (!T) return;
  const D = T.dates.length;
  Object.entries(T.units).forEach(([name, u]) => { ECON[name] = unitEcon(u, D, gasFor(T, u)); });
}

// the units panel's caption: what the table holds on the bases chosen, with the technology's totals
function drawTotals() {
  const T = S.data[S.tech], t = TECHS.find((x) => x.id === S.tech);
  if (!T) { window.CX.setNote($("tot-note"), "No economics data yet. It is built by the data update workflow."); return; }
  const D = T.dates.length, names = Object.keys(ECON);
  const tot = (k) => d3.sum(names, (n) => sum(ECON[n][k]));
  const E = tot("energy"), A = tot("as"), F = tot("fuel"), ST = tot("starts"), M = tot("margin");
  const MWH = d3.sum(names, (n) => sum(T.units[n].mwh));
  const lamDays = d3.sum(names, (n) => ECON[n].lamDays), missing = d3.sum(names, (n) => ECON[n].missing);
  const nodeDays = S.idx.has_nodes.filter(Boolean).length;
  const fd = (d) => d3.timeFormat("%b %-d, %Y")(parseDate(d));
  window.CX.setNote($("tot-note"), `Which ${t.label.toLowerCase()} units made money over the 60-day days, ${fd(T.dates[0])} to ${fd(T.dates[D - 1])}: what each earned (energy ${REV_NAME[S.rev] || ""} plus day-ahead ancillary awards), the average price it got, and what it cost to run (fuel and variable O&M on ${COST_NAME[S.cost] || "the chosen basis"}, plus start-ups). ` +
    `Together they earned ${fmt$k(E + A)} at an average ${MWH ? fmt$2(E / MWH) : "–"}/MWh and spent ${fmt$k(F + ST)}, a margin of ${fmt$k(M)} (${MWH ? fmt$2(M / MWH) + "/MWh" : "–"}). Margin is before fixed costs. Change the basis under "Cost and revenue basis"; click a column to sort, a unit to open it.`,
    `Energy revenue on the two-settlement basis = day-ahead award × day-ahead node price + (output − award) × real-time node price; days without a node price fall back to real-time at the node, then to system lambda (node prices on ${nodeDays} days` +
    (lamDays ? `; ${fmt0(lamDays)} unit-days priced at system lambda, counted in the table's last column` : "") + `). Average price is energy revenue over energy. Running cost is fuel and variable O&M plus start-ups, on the basis chosen.` +
    (FUEL[S.tech] === "gas" && (S.cost === "eia" || S.cost === "generic" || S.cost === "meas") ? ` Gas is priced at ${gasLabel(T)}.` : "") +
    (missing ? ` ${fmt0(missing)} unit-days before the first gas price have no fuel cost.` : "") +
    ` Units that produced nothing over the period are left out of the table.`);
}

function drawInputs() {
  const t = S.tech, p = S.params[t], fuelKind = FUEL[t], el = $("inputs");
  $("cost-note").textContent = COST_NOTES[S.cost];
  if (!fuelKind) { el.innerHTML = `<p class="empty">No fuel or start cost is applied to ${TECHS.find((x) => x.id === t).label.toLowerCase()}; margin is revenue.</p>`; return; }
  const row = (label, key, val, step, unit, disabled) => `<span class="t">${label}</span><input type="number" data-k="${key}" value="${val}" step="${step}" ${disabled ? "disabled" : ""}><span class="lbl">${unit}</span><span></span>`;
  el.innerHTML = `<span class="lbl">Input</span><span class="lbl">Value</span><span></span><span></span>` +
    (S.cost === "meas" && t !== "nuclear" ? `<span class="t">Heat rate</span><span class="lbl">each unit's own</span><span class="lbl">measured, minimum to full load</span><span></span>`
      : row("Heat rate", "hr", S.cost === "eia" || S.cost === "meas" ? EIA_HR[t] : p.hr, 0.1, "MMBtu/MWh" + (S.cost === "eia" || S.cost === "meas" ? " (EIA 2024)" : ""), S.cost !== "generic")) +
    row("Variable O&M", "vom", p.vom, 0.5, "$/MWh", S.cost === "offer" || S.cost === "inc") +
    row("Hot start", "start", p.start, 500, "$ per start, off 8 h or less" + (S.cost !== "generic" ? " (where no DAM offer)" : ""), false) +
    row("Intermediate start", "start_inter", p.start_inter, 500, "$ per start, off 8 to 24 h" + (S.cost !== "generic" ? " (where no DAM offer)" : ""), false) +
    row("Cold start", "start_cold", p.start_cold, 500, "$ per start, off over 24 h" + (S.cost !== "generic" ? " (where no DAM offer)" : ""), false) +
    (fuelKind !== "gas" ? row("Fuel price", "fuel", S.fuel[fuelKind], 0.1, "$/MMBtu", false) : "");
  el.querySelectorAll("input").forEach((inp) => inp.addEventListener("change", () => {
    const v = +inp.value; if (isNaN(v)) return;
    if (inp.dataset.k === "fuel") S.fuel[fuelKind] = v; else S.params[t][inp.dataset.k] = v;
    redraw();
  }));
}

const ALL_COLS = [
  { k: "unit", h: "Unit", t: true, f: (r) => `<a href="unit.html?unit=${encodeURIComponent(r.unit)}">${esc(r.unit)}</a>` + (r.configs ? ` <span class="h-note">${r.configs} config${r.configs === 1 ? "" : "s"}</span>` : "") },
  { k: "hub", h: "Fuel hub", t: true, gas: true, f: (r) => (r.hub ? esc(HUBS[r.hub]) + (r.fuel < 0 ? " †" : "") : "–") },
  { k: "mwh", h: "Energy, GWh", f: (r) => fmt1(r.mwh / 1000) },
  { k: "cf", h: "Capacity factor", f: (r) => (r.cf == null ? "–" : fmtPct(r.cf)) },
  { k: "earned", h: "Earned", f: (r) => fmt$k(r.earned) },
  { k: "price", h: "Average price, $/MWh", f: (r) => (r.price == null ? "–" : fmt$2(r.price)) },
  { k: "cost", h: "Running cost", f: (r) => fmt$k(r.cost) },
  { k: "nstarts", h: "Starts", f: (r) => fmt0(r.nstarts) },
  { k: "margin", h: "Margin", f: (r) => `<span class="${r.margin < 0 ? "neg" : ""}">${fmt$k(r.margin)}</span>` },
  { k: "mpm", h: "Margin, $/MWh", f: (r) => (r.mpm == null ? "–" : fmt$2(r.mpm)) },
  { k: "lamDays", h: "Days priced at lambda", lam: true, f: (r) => r.lamDays || "" },
];
function unitRows() {
  const T = S.data[S.tech];
  if (!T) return [];
  const D = T.dates.length;
  return Object.entries(T.units).map(([name, u]) => {
    const e = ECON[name], mwh = sum(u.mwh), days = u.mwh.filter((v) => v != null).length;
    const energy = sum(e.energy), as = sum(e.as), fuel = sum(e.fuel), starts = sum(e.starts), margin = sum(e.margin);
    return { unit: name, sp: u.sp, hub: u.fuel_hub || null, configs: u.configs ? u.configs.length : 0, mwh, cf: u.hsl && days ? mwh / (u.hsl * 24 * days) : null,
      energy, as, fuel, starts, earned: energy + as, price: mwh ? energy / mwh : null, cost: fuel + starts,
      nstarts: sum(u.starts), margin, mpm: mwh ? margin / mwh : null, lamDays: e.lamDays, est: e.est, days };
  });
}
function drawUnits() {
  const all = unitRows(), ran = all.filter((r) => r.mwh > 0), idle = all.length - ran.length;
  const el = $("units-table"), rows = ran.filter((r) => !S.q || r.unit.toLowerCase().includes(S.q) || (r.sp || "").toLowerCase().includes(S.q));
  const COLS = ALL_COLS.filter((c) => (!c.gas || FUEL[S.tech] === "gas") && (!c.lam || rows.some((r) => r.lamDays)));
  $("units-note").textContent = rows.length ? `${rows.length} units${idle ? `, ${idle} that did not run left out` : ""}` : "";
  if (!rows.length) return emptyMsg(el, "No units.");
  rows.sort((a, b) => { const x = a[S.sort], y = b[S.sort]; if (x == null) return 1; if (y == null) return -1; return (typeof x === "string" ? x.localeCompare(y) : x - y) * S.dir; });
  el.innerHTML = `<table class="data"><thead><tr>${COLS.map((c) => `<th class="sortable${c.t ? " t" : ""}" data-k="${c.k}">${c.h}${S.sort === c.k ? (S.dir < 0 ? " ▾" : " ▴") : ""}</th>`).join("")}</tr></thead><tbody>` +
    rows.map((r) => `<tr>${COLS.map((c) => `<td${c.t ? ' class="t"' : ""}>${c.f(r)}</td>`).join("")}</tr>`).join("") + "</tbody></table>";
  el.querySelectorAll("th[data-k]").forEach((th) => th.addEventListener("click", () => { const k = th.dataset.k; if (S.sort === k) S.dir = -S.dir; else { S.sort = k; S.dir = k === "unit" || k === "sp" ? 1 : -1; } drawUnits(); saveView(); }));
  const negFuel = rows.filter((r) => r.fuel < 0).length;
  if (negFuel) el.insertAdjacentHTML("beforeend", `<p class="note">† ${negFuel} unit${negFuel === 1 ? " shows" : "s show"} a negative fuel cost: Waha gas traded below $0/MMBtu on many days in the period, so ${negFuel === 1 ? "it was" : "they were"} paid to burn it, and ${negFuel === 1 ? "its" : "their"} margin per MWh sits above what the power price alone paid.</p>`);
  setCSV(el, COLS.map((c) => c.k), rows.map((r) => COLS.map((c) => (c.k === "unit" ? r.unit : r[c.k]))), "Unit economics");
}

async function loadTech() {
  if (!S.data[S.tech] && S.data[S.tech] !== null) S.data[S.tech] = await tryJSON(`data/econ/${S.tech}.json.gz`);
}
// ---- run hours and starts by year, 2019 on, for the chosen technology (data/wear.json.gz, pipeline/wear.py):
// wear and tear, with starts after a shutdown by choice apart from returns from an outage
async function drawWear() {
  const t = S.tech, box = $("wear-panel");
  if (!["combined_cycle", "combustion_turbine", "gas_steam", "coal"].includes(t)) { box.hidden = true; return; }
  if (S.WEAR === undefined) S.WEAR = await tryJSON("data/wear.json.gz");
  if (S.tech !== t) return;
  const W = S.WEAR;
  if (!W?.rows?.length) { box.hidden = true; return; }
  box.hidden = false;
  const ci = Object.fromEntries(W.columns.map((c, i) => [c, i]));
  const rows = W.rows.filter((r) => r[ci.tech] === t && r[ci.run_h] > 0);
  const by = d3.group(rows, (r) => r[ci.year]), years = [...by.keys()].sort((a, b) => b - a);
  const thru = W.through || "", part = (y) => +thru.slice(0, 4) === y && thru.slice(5) !== "12-31";
  const fmtN = d3.format(","), med = (rs, k) => d3.median(rs, (r) => r[ci[k]]), tot = (rs, k) => d3.sum(rs, (r) => r[ci[k]]);
  const Y = years.map((y) => { const rs = by.get(y), st = tot(rs, "starts");
    return { y, n: rs.length, run: med(rs, "run_h"), stm: med(rs, "starts"), st, hot: tot(rs, "hot") / (st || 1), inter: tot(rs, "inter") / (st || 1), cold: tot(rs, "cold") / (st || 1), back: tot(rs, "returns"), out: med(rs, "out_h"), perStart: st ? tot(rs, "run_h") / st : null }; });
  const label = TECHS.find((x) => x.id === t).label;
  $("wear-title").textContent = label;
  $("wear-table").innerHTML = `<table class="data"><thead><tr><th class="t">Year</th><th>Units that ran</th><th>Hours online, median unit</th><th>Starts by choice, median unit</th><th>Starts by choice, all units</th><th>Hot</th><th>Intermediate</th><th>Cold</th><th>Returns from outage, all units</th><th>Hours on outage, median unit</th><th>Run hours per start</th></tr></thead><tbody>` +
    Y.map((r) => `<tr><td class="t">${r.y}${part(r.y) ? "*" : ""}</td><td>${r.n}</td><td>${fmtN(Math.round(r.run))}</td><td><b>${fmtN(Math.round(r.stm))}</b></td><td>${fmtN(r.st)}</td><td>${fmtPct(r.hot)}</td><td>${fmtPct(r.inter)}</td><td>${fmtPct(r.cold)}</td><td>${fmtN(r.back)}</td><td>${fmtN(Math.round(r.out))}</td><td>${r.perStart == null ? "–" : fmtN(Math.round(r.perStart))}</td></tr>`).join("") + `</tbody></table>`;
  const full = Y.filter((r) => !part(r.y)), a = full.at(-1), b = full[0];
  window.CX.setNote($("wear-note"), `Wear and tear for ${label.toLowerCase()} units, year by year: hours online and starts, with starts after a shutdown by choice counted apart from returns from an outage. Open a unit for its own rows.` +
    (a && b && a !== b ? ` The median unit ran ${fmtN(Math.round(b.run))} hours and started ${fmtN(Math.round(b.stm))} times by choice in ${b.y}, against ${fmtN(Math.round(a.run))} hours and ${fmtN(Math.round(a.stm))} starts in ${a.y}.` : "") +
    (years.some(part) ? ` * Part year, to ${thru}.` : ""),
    `Each ${t === "combined_cycle" ? "combined-cycle train (its configurations merged, online when any is)" : "unit"} that ran that year, from its hourly states (history files from 2019, the 60-day data after Nov 2025). The site's outage rule comes first: OFF hours reported around an outage (an off spell that is mostly outage, or has fewer than ${W.out_min_h} OFF hours around one${t === "coal" ? "; for coal, any outage hour in the spell" : ""}) count as outage. ` +
    `A start by choice ends an off spell with at least ${W.out_min_h} OFF hours: hot after ${W.hot_h} hours off or fewer, intermediate up to ${W.inter_h}, cold beyond. A return from an outage ends an off spell that is outage. Starts inside one hour are not seen, so the counts can sit below the run-by-run starts the units table prices.`);
  setCSV($("wear-table"), ["year", "units_ran", "median_hours_online", "median_starts_by_choice", "starts_by_choice", "hot_share", "intermediate_share", "cold_share", "returns_from_outage", "median_hours_on_outage"],
    Y.map((r) => [r.y, r.n, r.run, r.stm, r.st, +r.hot.toFixed(3), +r.inter.toFixed(3), +r.cold.toFixed(3), r.back, r.out]), `${label} run hours and starts by year`);
}

function redraw() { compute(); drawTotals(); drawInputs(); drawUnits(); drawWear(); }
async function changeTech() { $("status").textContent = "Loading…"; await loadTech(); status(); redraw(); }
function status() {
  const I = S.idx, D = I.dates;
  const fd = (d) => d3.utcFormat("%b %-d, %Y")(new Date(d + "T00:00:00Z"));
  $("status").textContent = `60-day data: ${D.length} days, ${fd(D[0])} to ${fd(D[D.length - 1])} · node prices on ${I.has_nodes.filter(Boolean).length} days · day-ahead awards on ${I.has_dam.filter(Boolean).length} days · Henry Hub gas on ${I.gas_days} days`;
}

async function boot() {
  S.idx = await tryJSON("data/econ_index.json.gz");
  if (!S.idx) { $("status").textContent = "No economics data yet. It is built by the data update workflow."; return; }
  loadView();
  $("tech").innerHTML = TECHS.map((t) => `<option value="${t.id}">${t.label}</option>`).join("");
  if (!TECHS.some((t) => t.id === S.tech)) S.tech = "combined_cycle";
  $("tech").value = S.tech;
  $("tech").onchange = (e) => { S.tech = e.target.value; changeTech(); saveView(); document.dispatchEvent(new CustomEvent("thermal-tech", { detail: S.tech })); };
  setSeg("cost", S.cost); bindSeg("cost", "cost", redraw);
  setSeg("rev", S.rev); bindSeg("rev", "rev", redraw);
  if (!HUB_CHOICES[S.hub]) S.hub = "unit";
  setSeg("hub", S.hub); bindSeg("hub", "hub", redraw);
  $("gas-adder").value = S.adder;
  $("gas-adder").addEventListener("change", (e) => { S.adder = +e.target.value || 0; redraw(); saveView(); });
  $("unit-search").addEventListener("input", (e) => { S.q = e.target.value.trim().toLowerCase(); drawUnits(); });
  await loadTech();
  status();
  redraw();
  window.CX.init();
}
boot();
})();

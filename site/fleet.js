/* ERCOT Fleet Economics: Plant economics' technology totals and units table, without the inline unit
   panel (one unit's economics are on unit.html, unit-econ.js). Reads data/econ_index.json.gz and
   data/econ/<tech>.json.gz (pipeline/econ.py). Costs are computed here from the chosen basis, so the
   inputs can be changed without rebuilding the data. The wind and solar section below is
   fleet-renew.js, which keeps its own keys in the address bar. */
(() => {
"use strict";

const TECHS = [
  { id: "combined_cycle", label: "Combined cycle", color: "--c1" },
  { id: "combustion_turbine", label: "Peakers (CT and recip)", color: "--c2" },
  { id: "gas_steam", label: "Gas steam", color: "--c6" },
  { id: "coal", label: "Coal & lignite", color: "--c8" },
  { id: "nuclear", label: "Nuclear", color: "--c5" },
  { id: "wind", label: "Wind", color: "--c3" },
  { id: "solar", label: "Solar", color: "--c4" },
  { id: "storage", label: "Storage (ESR)", color: "--c-other" },
  { id: "hydro", label: "Hydro", color: "--c-other" },
  { id: "other", label: "Other", color: "--c-other" },
];
const FUEL = { combined_cycle: "gas", combustion_turbine: "gas", gas_steam: "gas", coal: "coal", nuclear: "nuclear" };
// EIA Electric Power Annual, table 8.2 (average tested heat rates, 2024), MMBtu per MWh
const EIA_HR = { combined_cycle: 7.548, combustion_turbine: 10.999, gas_steam: 10.337, coal: 10.018, nuclear: 10.443 };
// generic defaults: heat rate (MMBtu/MWh), variable O&M ($/MWh), hot start ($), fuel price for
// non-gas fuels ($/MMBtu). Edit them in the Cost assumptions panel.
const DEFAULTS = {
  combined_cycle: { hr: 7.0, vom: 3.0, start: 15000 },
  combustion_turbine: { hr: 11.0, vom: 5.0, start: 3000 },
  gas_steam: { hr: 10.5, vom: 4.0, start: 10000 },
  coal: { hr: 10.5, vom: 5.0, start: 30000 },
  nuclear: { hr: 10.4, vom: 2.5, start: 0 },
};
const FUEL_PRICE = { coal: 2.0, nuclear: 0.7 };     // $/MMBtu, user-editable
const COST_NOTES = {
  eia: "Fuel = output × the EIA average tested heat rate for the technology × the fuel price (the chosen gas price plus the adder for gas; the $/MMBtu set here for coal and nuclear), plus variable O&M per MWh. Starts cost the unit's own DAM hot-start offer where it has one, else the generic start cost.",
  offer: "Energy cost = the area under the unit's own DAM energy offer curve up to each hour's output; where the unit offered no curve, its minimum-energy offer × output; where it submitted no three-part offer at all, the generic basis. Starts cost its DAM hot-start offer, else the generic start cost.",
  inc: "Energy cost = each hour's output × the price the unit's own DAM energy offer curve puts on that output level (its incremental offer, read as its marginal cost), ignoring the minimum-energy price that units set low to get committed. Units with no DAM curve use the generic basis and are counted as estimated. Starts cost the DAM hot-start offer, else the generic start cost.",
  generic: "Fuel = output × the heat rate set here × the fuel price (the chosen gas price plus the adder for gas; the $/MMBtu set here for coal and nuclear), plus variable O&M per MWh and the start cost per start.",
};
const { getJSON, tryJSON, showTip, hideTip, setCSV, css, esc, axisFmt, fmtKind } = window.CX;
const $ = (id) => document.getElementById(id);
const fmt0 = d3.format(",.0f"), fmt1 = d3.format(",.1f"), fmtPct = d3.format(".0%");
const fmt$ = (v) => (v == null || isNaN(v) ? "–" : (v < 0 ? "−" : "") + "$" + fmt0(Math.abs(v)));
const fmt$k = (v) => {      // compact money: $12k, $1.2M, $3.4B
  if (v == null || isNaN(v)) return "–";
  const a = Math.abs(v), sign = v < 0 ? "−" : "";
  return sign + "$" + (a >= 1e9 ? d3.format(",.2f")(a / 1e9) + "B" : a >= 1e6 ? d3.format(",.1f")(a / 1e6) + "M" : a >= 1e3 ? fmt0(a / 1e3) + "k" : fmt0(a));
};
// axis labels: compact money keeps one unit ($k or $M) across the whole axis
const yKind = (f) => (f === fmt$k ? "$k" : fmtKind(f));
const fmt$2 = (v) => (v == null || isNaN(v) ? "–" : (v < 0 ? "−" : "") + "$" + d3.format(",.2f")(Math.abs(v)));
const parseDate = (d) => new Date(d + "T12:00:00");
const fmtDate = d3.timeFormat("%a %b %-d, %Y");

// gas price used for gas-fired fuel cost: Houston Ship Channel and Waha from OilPriceAPI, Henry Hub
// from the EIA, or "unit": each unit's own fuel hub (Waha or Houston Ship Channel, from
// pipeline/fuel_hub.py). A hub with no prices in the loaded data falls back to Henry Hub.
const HUBS = { hsc: "Houston Ship Channel", waha: "Waha", hh: "Henry Hub" };
const HUB_CHOICES = { unit: "each unit's own hub", ...HUBS };
const S = { tech: "combined_cycle", cost: "eia", rev: "two", hub: "unit", adder: 0, sort: "margin", dir: -1, q: "",
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
function unitEcon(u, D, gas) {
  const t = S.tech, p = S.params[t] || {}, fuelKind = FUEL[t];
  const gasPrice = (i) => (gas[i] == null ? null : gas[i] + S.adder);
  const fuelPrice = (i) => (fuelKind === "gas" ? gasPrice(i) : fuelKind ? S.fuel[fuelKind] : 0);
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
      const fp = fuelPrice(i);
      const n = u.starts[i] || 0;
      const own = u.start_hot[i] != null ? u.start_hot[i] : null;
      if (S.cost === "offer" || S.cost === "inc") {
        const own_cost = S.cost === "inc" ? u.cost_inc[i] : u.cost_off[i];
        if (own_cost != null) fuel = own_cost;
        else if (S.cost === "offer" && u.mingen[i] != null) fuel = mwh * u.mingen[i];
        else if (fp != null) { fuel = mwh * (p.hr * fp + p.vom); estimated = true; }
        else fuel = null;
        starts = n * (own != null ? own : p.start);
      } else {
        const hr = S.cost === "eia" ? EIA_HR[t] : p.hr;
        fuel = fp == null ? null : mwh * (hr * fp + p.vom);
        starts = n * (own != null && S.cost === "eia" ? own : p.start);
        if (own == null && n) estimated = true;
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

// ---- charts --------------------------------------------------------------------------
function lineChart(el, dstr, series, opts) {
  const dates = dstr.map(parseDate), w = Math.max(280, el.clientWidth || 600), H = opts.H || 260, m = { t: 16, r: 16, b: 26, l: 70 };
  const x = d3.scaleTime().domain(d3.extent(dates)).range([m.l, w - m.r]);
  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  if (!all.length) return emptyMsg(el, opts.empty || "No data.");
  const y = d3.scaleLinear().domain([Math.min(0, d3.min(all)), Math.max(1, d3.max(all))]).nice().range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(w < 560 ? 4 : 8).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y), 5, yKind(opts.yFmt)).tickSizeOuter(0));
  if (y.domain()[0] < 0) svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(0)).attr("y2", y(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text(opts.title);
  const line = d3.line().defined((v) => v != null).x((v, i) => x(dates[i])).y((v) => y(v));
  series.forEach((s) => {
    svg.append("path").attr("fill", "none").attr("stroke", css(s.color)).attr("stroke-width", s.width || 2).attr("stroke-dasharray", s.dash || null).attr("d", line(s.values));
    svg.append("g").selectAll("circle").data(s.values.map((v, i) => [v, i]).filter(([v]) => v != null)).join("circle")
      .attr("cx", ([, i]) => x(dates[i])).attr("cy", ([v]) => y(v)).attr("r", 1.5).attr("fill", css(s.color));
  });
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", H - m.b).style("display", "none");
  const tf = opts.tipFmt || opts.yFmt || fmt0;
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const t = x.invert(d3.pointer(ev)[0]), i = d3.minIndex(dates, (d) => Math.abs(d - t));
      cross.style("display", null).attr("x1", x(dates[i])).attr("x2", x(dates[i]));
      const rows = series.filter((s) => s.values[i] != null);
      showTip(ev, `<h4>${fmtDate(dates[i])}${opts.tipNote ? opts.tipNote(i) : ""}</h4><table>` + rows.map((s) =>
        `<tr><td><span class="sw" style="background:var(${s.color})"></span></td><td>${s.label}</td><td class="n">${tf(s.values[i])}</td></tr>`).join("") + "</table>");
    })
    .on("pointerleave", () => { cross.style("display", "none"); hideTip(); });
  el.replaceChildren(svg.node());
  setCSV(el, ["date", ...series.map((s) => s.label)], dstr.map((d, i) => [d, ...series.map((s) => s.values[i])]), opts.title);
}

// stacked bars of revenue (up) and cost (down) per day, with a margin line
function barChart(el, dstr, up, down, lineS, opts) {
  const dates = dstr.map(parseDate), w = Math.max(280, el.clientWidth || 600), H = opts.H || 280, m = { t: 16, r: 16, b: 26, l: 70 };
  const n = dstr.length, bw = Math.max(1, (w - m.l - m.r) / n - 1);
  const x = d3.scaleTime().domain(d3.extent(dates)).range([m.l + bw / 2, w - m.r - bw / 2]);
  const top = d3.max(dstr, (_, i) => d3.sum(up, (s) => s.values[i] || 0)) || 0;
  const bot = d3.max(dstr, (_, i) => d3.sum(down, (s) => s.values[i] || 0)) || 0;
  const lineVals = lineS ? lineS.values.filter((v) => v != null) : [];
  const y = d3.scaleLinear().domain([-Math.max(bot, -(d3.min(lineVals) || 0)), Math.max(top, d3.max(lineVals) || 0, 1)]).nice().range([H - m.b, m.t]);
  if (!top && !bot) return emptyMsg(el, opts.empty || "No data.");
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(6).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(w < 560 ? 4 : 8).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y), 6, yKind(opts.yFmt)).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text(opts.title);
  dstr.forEach((_, i) => {
    let acc = 0;
    up.forEach((s) => { const v = s.values[i]; if (v) { svg.append("rect").attr("x", x(dates[i]) - bw / 2).attr("width", bw).attr("y", y(Math.max(acc, acc + v))).attr("height", Math.abs(y(acc) - y(acc + v))).attr("fill", css(s.color)); acc += v; } });
    acc = 0;
    down.forEach((s) => { const v = s.values[i]; if (v) { svg.append("rect").attr("x", x(dates[i]) - bw / 2).attr("width", bw).attr("y", y(acc)).attr("height", Math.abs(y(acc) - y(acc - v))).attr("fill", css(s.color)); acc -= v; } });
  });
  svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(0)).attr("y2", y(0));
  if (lineS) svg.append("path").attr("fill", "none").attr("stroke", css(lineS.color)).attr("stroke-width", 2)
    .attr("d", d3.line().defined((v) => v != null).x((v, i) => x(dates[i])).y((v) => y(v))(lineS.values));
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", H - m.b).style("display", "none");
  const all = [...up, ...down, ...(lineS ? [lineS] : [])];
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const t = x.invert(d3.pointer(ev)[0]), i = d3.minIndex(dates, (d) => Math.abs(d - t));
      cross.style("display", null).attr("x1", x(dates[i])).attr("x2", x(dates[i]));
      showTip(ev, `<h4>${fmtDate(dates[i])}${opts.tipNote ? opts.tipNote(i) : ""}</h4><table>` + all.filter((s) => s.values[i] != null).map((s) =>
        `<tr><td><span class="sw" style="background:var(${s.color})"></span></td><td>${s.label}</td><td class="n">${fmt$(s.values[i])}</td></tr>`).join("") + "</table>");
    })
    .on("pointerleave", () => { cross.style("display", "none"); hideTip(); });
  el.replaceChildren(svg.node());
  setCSV(el, ["date", ...all.map((s) => s.label)], dstr.map((d, i) => [d, ...all.map((s) => s.values[i])]), opts.title);
}

const REV_SERIES = [{ k: "energy", label: "Energy revenue", color: "--c1" }, { k: "as", label: "Ancillary services", color: "--c4" }];
const COST_SERIES = [{ k: "fuel", label: "Fuel & variable cost", color: "--c8" }, { k: "starts", label: "Start-up cost", color: "--c2" }];
const MARGIN = { label: "Margin", color: "--c5" };
function legendHTML(el) {
  el.innerHTML = [...REV_SERIES, ...COST_SERIES, MARGIN].map((s) => `<span><span class="sw" style="background:var(${s.color})"></span>${s.label}</span>`).join("");
}

// ---- panels --------------------------------------------------------------------------
let ECON = {};     // unit name -> unitEcon result, for the current tech and bases
// the gas price series for one hub in this tech's data and its label; Henry Hub when the hub has none
function hubSeries(T, hub) {
  const h = T.hubs && T.hubs[hub];
  if (hub !== "hh" && h && h.some((v) => v != null)) return { values: h, label: HUBS[hub] };
  return { values: T.gas, label: HUBS.hh + (hub !== "hh" ? ` (no ${HUBS[hub]} prices loaded)` : "") };
}
// the hub a unit is costed at under the current choice: its own fuel hub, else Houston Ship Channel
const unitHub = (u) => (S.hub === "unit" ? u.fuel_hub || "hsc" : S.hub);
function gasLabel(T) {
  if (S.hub !== "unit") return hubSeries(T, S.hub).label;
  const n = Object.values(T.units).filter((u) => u.fuel_hub === "waha").length;
  return `each unit's own hub (${n} on Waha, the rest Houston Ship Channel)`;
}
function compute() {
  const T = S.data[S.tech];
  ECON = {};
  if (!T) return;
  const D = T.dates.length;
  Object.entries(T.units).forEach(([name, u]) => { ECON[name] = unitEcon(u, D, hubSeries(T, unitHub(u)).values); });
}

function drawTotals() {
  const T = S.data[S.tech], el = $("tot-chart"), mel = $("margin-chart"), t = TECHS.find((x) => x.id === S.tech);
  $("tot-title").textContent = `${t.label}: all units`;
  legendHTML($("tot-legend"));
  if (!T) { emptyMsg(el, "No economics data yet. It is built by the data update workflow."); mel.innerHTML = ""; $("kpis").innerHTML = ""; return; }
  const D = T.dates.length, names = Object.keys(ECON);
  const tot = (k) => T.dates.map((_, i) => { const vs = names.map((n) => ECON[n][k][i]).filter((v) => v != null); return vs.length ? d3.sum(vs) : null; });
  const energy = tot("energy"), as = tot("as"), fuel = tot("fuel"), starts = tot("starts"), margin = tot("margin");
  const mwh = T.dates.map((_, i) => d3.sum(names, (n) => T.units[n].mwh[i] || 0));
  const E = sum(energy), A = sum(as), F = sum(fuel), ST = sum(starts), M = sum(margin), MWH = d3.sum(mwh);
  const lamDays = d3.sum(names, (n) => ECON[n].lamDays), missing = d3.sum(names, (n) => ECON[n].missing);
  $("kpis").innerHTML = [["Energy revenue", fmt$k(E)], ["Ancillary services", fmt$k(A)], ["Fuel & variable", fmt$k(F)], ["Start-ups", fmt$k(ST)],
    ["Margin", fmt$k(M), M < 0], ["Margin per MWh", MWH ? fmt$2(M / MWH) : "–", M < 0], ["Energy", fmt0(MWH / 1000) + " GWh"]]
    .map(([k, v, neg]) => `<div class="kpi"><span class="v${neg ? " neg" : ""}">${v}</span><span class="k">${k}</span></div>`).join("");
  const nodeDays = S.idx.has_nodes.filter(Boolean).length;
  window.CX.setNote($("tot-note"), `${names.length} units over ${D} days. Revenue up, cost down, then the running margin.`, `Node prices on ${nodeDays} days` +
    (lamDays ? ` · ${fmt0(lamDays)} unit-days priced at system lambda for want of a node price` : "") +
    (missing ? ` · ${fmt0(missing)} unit-days with no fuel price (before the first gas price)` : "") +
    (FUEL[S.tech] === "gas" && (S.cost === "eia" || S.cost === "generic") ? ` · gas at ${gasLabel(T)}` : ""));
  barChart(el, T.dates, REV_SERIES.map((s) => ({ ...s, values: { energy, as }[s.k] })), COST_SERIES.map((s) => ({ ...s, values: { fuel, starts }[s.k] })),
    { ...MARGIN, values: margin }, { title: "Revenue (up) and cost (down) per day, $, all units", yFmt: fmt$k });
  let cum = 0;
  const cumv = margin.map((v) => (v == null ? null : (cum += v)));
  lineChart(mel, T.dates, [{ label: "Cumulative margin", color: "--c5", values: cumv }], { H: 200, title: "Cumulative margin ($)", yFmt: fmt$k, tipFmt: fmt$ });
  lineChart($("mpm-chart"), T.dates, [{ label: "Margin per MWh", color: "--c1", values: margin.map((v, i) => (v == null || !mwh[i] ? null : v / mwh[i])) }],
    { H: 180, title: "Daily margin per MWh produced ($/MWh)", yFmt: fmt$, tipFmt: fmt$2 });
}

function drawInputs() {
  const t = S.tech, p = S.params[t], fuelKind = FUEL[t], el = $("inputs");
  $("cost-note").textContent = COST_NOTES[S.cost];
  if (!fuelKind) { el.innerHTML = `<p class="empty">No fuel or start cost is applied to ${TECHS.find((x) => x.id === t).label.toLowerCase()}; margin is revenue.</p>`; return; }
  const row = (label, key, val, step, unit, disabled) => `<span class="t">${label}</span><input type="number" data-k="${key}" value="${val}" step="${step}" ${disabled ? "disabled" : ""}><span class="lbl">${unit}</span><span></span>`;
  el.innerHTML = `<span class="lbl">Input</span><span class="lbl">Value</span><span></span><span></span>` +
    row("Heat rate", "hr", S.cost === "eia" ? EIA_HR[t] : p.hr, 0.1, "MMBtu/MWh" + (S.cost === "eia" ? " (EIA 2024)" : ""), S.cost !== "generic") +
    row("Variable O&M", "vom", p.vom, 0.5, "$/MWh", S.cost === "offer" || S.cost === "inc") +
    row("Start cost", "start", p.start, 500, "$ per start" + (S.cost !== "generic" ? " (where no DAM offer)" : ""), false) +
    (fuelKind !== "gas" ? row("Fuel price", "fuel", S.fuel[fuelKind], 0.1, "$/MMBtu", false) : "");
  el.querySelectorAll("input").forEach((inp) => inp.addEventListener("change", () => {
    const v = +inp.value; if (isNaN(v)) return;
    if (inp.dataset.k === "fuel") S.fuel[fuelKind] = v; else S.params[t][inp.dataset.k] = v;
    redraw();
  }));
}

const ALL_COLS = [
  { k: "unit", h: "Unit", t: true, f: (r) => `<a href="unit.html?unit=${encodeURIComponent(r.unit)}">${esc(r.unit)}</a>` + (r.configs ? ` <span class="h-note">${r.configs} configs</span>` : "") },
  { k: "sp", h: "Settlement point", t: true, f: (r) => esc(r.sp || "–") },
  { k: "hub", h: "Fuel hub", t: true, gas: true, f: (r) => (r.hub ? esc(HUBS[r.hub]) : "–") },
  { k: "mwh", h: "GWh", f: (r) => fmt1(r.mwh / 1000) },
  { k: "cf", h: "Capacity factor", f: (r) => (r.cf == null ? "–" : fmtPct(r.cf)) },
  { k: "energy", h: "Energy revenue", f: (r) => fmt$k(r.energy) },
  { k: "as", h: "Ancillary", f: (r) => fmt$k(r.as) },
  { k: "fuel", h: "Fuel & variable", f: (r) => fmt$k(r.fuel) },
  { k: "starts", h: "Starts", f: (r) => `${r.nstarts} · ${fmt$k(r.starts)}` },
  { k: "margin", h: "Margin", f: (r) => `<span class="${r.margin < 0 ? "neg" : ""}">${fmt$k(r.margin)}</span>` },
  { k: "mpm", h: "Margin $/MWh", f: (r) => (r.mpm == null ? "–" : fmt$2(r.mpm)) },
  { k: "lamDays", h: "Days at lambda", f: (r) => r.lamDays || "" },
];
function unitRows() {
  const T = S.data[S.tech];
  if (!T) return [];
  const D = T.dates.length;
  return Object.entries(T.units).map(([name, u]) => {
    const e = ECON[name], mwh = sum(u.mwh), days = u.mwh.filter((v) => v != null).length;
    const energy = sum(e.energy), as = sum(e.as), fuel = sum(e.fuel), starts = sum(e.starts), margin = sum(e.margin);
    return { unit: name, sp: u.sp, hub: u.fuel_hub || null, configs: u.configs ? u.configs.length : 0, mwh, cf: u.hsl && days ? mwh / (u.hsl * 24 * days) : null,
      energy, as, fuel, starts, nstarts: sum(u.starts), margin, mpm: mwh ? margin / mwh : null, lamDays: e.lamDays, est: e.est, days };
  });
}
function drawUnits() {
  const COLS = ALL_COLS.filter((c) => !c.gas || FUEL[S.tech] === "gas");
  const el = $("units-table"), rows = unitRows().filter((r) => !S.q || r.unit.toLowerCase().includes(S.q) || (r.sp || "").toLowerCase().includes(S.q));
  $("units-note").textContent = rows.length ? `${rows.length} units` : "";
  if (!rows.length) return emptyMsg(el, "No units.");
  rows.sort((a, b) => { const x = a[S.sort], y = b[S.sort]; if (x == null) return 1; if (y == null) return -1; return (typeof x === "string" ? x.localeCompare(y) : x - y) * S.dir; });
  el.innerHTML = `<table class="data"><thead><tr>${COLS.map((c) => `<th class="sortable${c.t ? " t" : ""}" data-k="${c.k}">${c.h}${S.sort === c.k ? (S.dir < 0 ? " ▾" : " ▴") : ""}</th>`).join("")}</tr></thead><tbody>` +
    rows.map((r) => `<tr>${COLS.map((c) => `<td${c.t ? ' class="t"' : ""}>${c.f(r)}</td>`).join("")}</tr>`).join("") + "</tbody></table>";
  el.querySelectorAll("th[data-k]").forEach((th) => th.addEventListener("click", () => { const k = th.dataset.k; if (S.sort === k) S.dir = -S.dir; else { S.sort = k; S.dir = k === "unit" || k === "sp" ? 1 : -1; } drawUnits(); saveView(); }));
  setCSV(el, COLS.map((c) => c.k), rows.map((r) => COLS.map((c) => (c.k === "unit" ? r.unit : r[c.k]))), "Unit economics");
}

async function loadTech() {
  if (!S.data[S.tech] && S.data[S.tech] !== null) S.data[S.tech] = await tryJSON(`data/econ/${S.tech}.json.gz`);
}
function redraw() { compute(); drawTotals(); drawInputs(); drawUnits(); }
async function changeTech() { $("status").textContent = "Loading…"; await loadTech(); status(); redraw(); }
function status() {
  const I = S.idx, D = I.dates;
  $("status").textContent = `60-day data: ${D.length} days, ${D[0]} to ${D[D.length - 1]} · node prices on ${I.has_nodes.filter(Boolean).length} days · DAM on ${I.has_dam.filter(Boolean).length} · gas prices on ${I.gas_days} days (Henry Hub)` +
    Object.entries(I.hub_days || {}).map(([h, n]) => `, ${n} (${HUBS[h] || h})`).join("");
}

async function boot() {
  S.idx = await tryJSON("data/econ_index.json.gz");
  if (!S.idx) { $("status").textContent = "No economics data yet. It is built by the data update workflow."; return; }
  loadView();
  $("tech").innerHTML = TECHS.map((t) => `<option value="${t.id}">${t.label}</option>`).join("");
  if (!TECHS.some((t) => t.id === S.tech)) S.tech = "combined_cycle";
  $("tech").value = S.tech;
  $("tech").onchange = (e) => { S.tech = e.target.value; changeTech(); saveView(); };
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
  let tm; window.addEventListener("resize", () => { clearTimeout(tm); tm = setTimeout(drawTotals, 150); });
}
boot();
})();

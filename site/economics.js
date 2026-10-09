/* ERCOT Plant Economics. Reads data/econ_index.json.gz and data/econ/<tech>.json.gz
   (pipeline/econ.py). Costs are computed here from the chosen basis, so the inputs can be changed
   without rebuilding the data. */
(() => {
"use strict";

const TECHS = [
  { id: "combined_cycle", label: "Combined cycle", color: "--c1" },
  { id: "combustion_turbine", label: "Combustion turbine", color: "--c2" },
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
  eia: "Fuel = output × the EIA average tested heat rate for the technology × the fuel price (Henry Hub plus the adder for gas; the $/MMBtu set here for coal and nuclear), plus variable O&M per MWh. Starts cost the unit's own DAM hot-start offer where it has one, else the generic start cost.",
  offer: "Energy cost = the area under the unit's own DAM energy offer curve up to each hour's output; where the unit offered no curve, its minimum-energy offer × output; where it submitted no three-part offer at all, the generic basis. Starts cost its DAM hot-start offer, else the generic start cost.",
  generic: "Fuel = output × the heat rate set here × the fuel price (Henry Hub plus the adder for gas; the $/MMBtu set here for coal and nuclear), plus variable O&M per MWh and the start cost per start.",
};
const { getJSON, tryJSON, showTip, hideTip, setCSV, css, esc } = window.CX;
const $ = (id) => document.getElementById(id);
const fmt0 = d3.format(",.0f"), fmt1 = d3.format(",.1f"), fmtPct = d3.format(".0%");
const fmt$ = (v) => (v == null || isNaN(v) ? "–" : (v < 0 ? "−" : "") + "$" + fmt0(Math.abs(v)));
const fmt$k = (v) => {      // compact money: $12k, $1.2M, $3.4B
  if (v == null || isNaN(v)) return "–";
  const a = Math.abs(v), sign = v < 0 ? "−" : "";
  return sign + "$" + (a >= 1e9 ? d3.format(",.2f")(a / 1e9) + "B" : a >= 1e6 ? d3.format(",.1f")(a / 1e6) + "M" : a >= 1e3 ? fmt0(a / 1e3) + "k" : fmt0(a));
};
const fmt$2 = (v) => (v == null || isNaN(v) ? "–" : (v < 0 ? "−" : "") + "$" + d3.format(",.2f")(Math.abs(v)));
const parseDate = (d) => new Date(d + "T12:00:00");
const fmtDate = d3.timeFormat("%a %b %-d, %Y");

const S = { tech: "combined_cycle", cost: "eia", rev: "two", adder: 0, sort: "margin", dir: -1, unit: null, q: "",
  params: JSON.parse(JSON.stringify(DEFAULTS)), fuel: { ...FUEL_PRICE }, idx: null, data: {} };
const VIEW_KEYS = { tech: "tech", cost: "cost", rev: "rev", adder: "adder", unit: "unit", sort: "sort" };
function saveView() { window.CX.writeHash(Object.fromEntries(Object.entries(VIEW_KEYS).map(([k, sk]) => [k, S[sk]]))); }
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
      if (S.cost === "offer") {
        if (u.cost_off[i] != null) fuel = u.cost_off[i];
        else if (u.mingen[i] != null) fuel = mwh * u.mingen[i];
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
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickFormat(opts.yFmt || fmt0).tickSizeOuter(0));
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
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(6).tickFormat(opts.yFmt || fmt0).tickSizeOuter(0));
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
function compute() {
  const T = S.data[S.tech];
  ECON = {};
  if (!T) return;
  const D = T.dates.length;
  Object.entries(T.units).forEach(([name, u]) => { ECON[name] = unitEcon(u, D, T.gas); });
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
  $("tot-note").textContent = `${names.length} units over ${D} days · node prices on ${nodeDays} days` +
    (lamDays ? ` · ${fmt0(lamDays)} unit-days priced at system lambda for want of a node price` : "") +
    (missing ? ` · ${fmt0(missing)} unit-days with no fuel price (before the first gas price)` : "") + ` · ${COST_NOTES[S.cost].split(".")[0]}.`;
  barChart(el, T.dates, REV_SERIES.map((s) => ({ ...s, values: { energy, as }[s.k] })), COST_SERIES.map((s) => ({ ...s, values: { fuel, starts }[s.k] })),
    { ...MARGIN, values: margin }, { title: "Revenue (up) and cost (down) per day, $, all units", yFmt: (v) => fmt$k(v) });
  let cum = 0;
  const cumv = margin.map((v) => (v == null ? null : (cum += v)));
  lineChart(mel, T.dates, [{ label: "Cumulative margin", color: "--c5", values: cumv }], { H: 200, title: "Cumulative margin ($)", yFmt: (v) => fmt$k(v), tipFmt: fmt$ });
  lineChart($("mpm-chart"), T.dates, [{ label: "Margin per MWh", color: "--c1", values: margin.map((v, i) => (v == null || !mwh[i] ? null : v / mwh[i])) }],
    { H: 180, title: "Daily margin per MWh produced ($/MWh)", yFmt: (v) => fmt$(v), tipFmt: fmt$2 });
}

function drawInputs() {
  const t = S.tech, p = S.params[t], fuelKind = FUEL[t], el = $("inputs");
  $("cost-note").textContent = COST_NOTES[S.cost];
  if (!fuelKind) { el.innerHTML = `<p class="empty">No fuel or start cost is applied to ${TECHS.find((x) => x.id === t).label.toLowerCase()}; margin is revenue.</p>`; return; }
  const row = (label, key, val, step, unit, disabled) => `<span class="t">${label}</span><input type="number" data-k="${key}" value="${val}" step="${step}" ${disabled ? "disabled" : ""}><span class="lbl">${unit}</span><span></span>`;
  el.innerHTML = `<span class="lbl">Input</span><span class="lbl">Value</span><span></span><span></span>` +
    row("Heat rate", "hr", S.cost === "eia" ? EIA_HR[t] : p.hr, 0.1, "MMBtu/MWh" + (S.cost === "eia" ? " (EIA 2024)" : ""), S.cost !== "generic") +
    row("Variable O&M", "vom", p.vom, 0.5, "$/MWh", S.cost === "offer") +
    row("Start cost", "start", p.start, 500, "$ per start" + (S.cost !== "generic" ? " (where no DAM offer)" : ""), false) +
    (fuelKind !== "gas" ? row("Fuel price", "fuel", S.fuel[fuelKind], 0.1, "$/MMBtu", false) : "");
  el.querySelectorAll("input").forEach((inp) => inp.addEventListener("change", () => {
    const v = +inp.value; if (isNaN(v)) return;
    if (inp.dataset.k === "fuel") S.fuel[fuelKind] = v; else S.params[t][inp.dataset.k] = v;
    redraw();
  }));
}

const COLS = [
  { k: "unit", h: "Unit", t: true, f: (r) => esc(r.unit) + (r.configs ? ` <span class="h-note">${r.configs} configs</span>` : "") },
  { k: "sp", h: "Settlement point", t: true, f: (r) => esc(r.sp || "–") },
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
    return { unit: name, sp: u.sp, configs: u.configs ? u.configs.length : 0, mwh, cf: u.hsl && days ? mwh / (u.hsl * 24 * days) : null,
      energy, as, fuel, starts, nstarts: sum(u.starts), margin, mpm: mwh ? margin / mwh : null, lamDays: e.lamDays, days };
  });
}
function drawUnits() {
  const el = $("units-table"), rows = unitRows().filter((r) => !S.q || r.unit.toLowerCase().includes(S.q) || (r.sp || "").toLowerCase().includes(S.q));
  $("units-note").textContent = rows.length ? `${rows.length} units` : "";
  if (!rows.length) return emptyMsg(el, "No units.");
  rows.sort((a, b) => { const x = a[S.sort], y = b[S.sort]; if (x == null) return 1; if (y == null) return -1; return (typeof x === "string" ? x.localeCompare(y) : x - y) * S.dir; });
  el.innerHTML = `<table class="data"><thead><tr>${COLS.map((c) => `<th class="sortable${c.t ? " t" : ""}" data-k="${c.k}">${c.h}${S.sort === c.k ? (S.dir < 0 ? " ▾" : " ▴") : ""}</th>`).join("")}</tr></thead><tbody>` +
    rows.map((r) => `<tr data-unit="${esc(r.unit)}" style="cursor:pointer${S.unit === r.unit ? ";background:var(--accent-soft)" : ""}">${COLS.map((c) => `<td${c.t ? ' class="t"' : ""}>${c.f(r)}</td>`).join("")}</tr>`).join("") + "</tbody></table>";
  el.querySelectorAll("th[data-k]").forEach((th) => th.addEventListener("click", () => { const k = th.dataset.k; if (S.sort === k) S.dir = -S.dir; else { S.sort = k; S.dir = k === "unit" || k === "sp" ? 1 : -1; } drawUnits(); saveView(); }));
  el.querySelectorAll("tr[data-unit]").forEach((tr) => tr.addEventListener("click", () => { S.unit = tr.dataset.unit; drawUnit(); drawUnits(); saveView(); $("unit-detail").scrollIntoView({ behavior: "smooth", block: "start" }); }));
  setCSV(el, COLS.map((c) => c.k), rows.map((r) => COLS.map((c) => (c.k === "unit" ? r.unit : r[c.k]))), "Unit economics");
}

function drawUnit() {
  const T = S.data[S.tech], box = $("unit-detail");
  const u = T && T.units[S.unit], e = u && ECON[S.unit];
  if (!u) { box.hidden = true; return; }
  box.hidden = false;
  const r = unitRows().find((x) => x.unit === S.unit);
  $("unit-title").textContent = `${S.unit}${u.sp ? ` · ${u.sp}` : ""}${u.hsl ? ` · ${fmt0(u.hsl)} MW` : ""}`;
  const own = u.start_hot.filter((v) => v != null).length, curves = u.cost_off.filter((v) => v != null).length, mg = u.mingen.filter((v) => v != null);
  $("unit-note").textContent = `${r.days} days · ${fmt1(r.mwh / 1000)} GWh · ${r.nstarts} starts · margin ${fmt$(r.margin)} (${r.mpm == null ? "–" : fmt$2(r.mpm)} per MWh)` +
    (own ? ` · DAM three-part offer on ${own} days (hot start ${fmt$(d3.median(u.start_hot.filter((v) => v != null)))}, minimum-energy ${fmt$2(d3.median(mg))}/MWh, energy curve on ${curves})` : " · no DAM three-part offer on any loaded day") +
    (u.configs ? ` · configurations ${u.configs.join(", ")}` : "");
  legendHTML($("unit-legend"));
  barChart($("unit-chart"), T.dates, REV_SERIES.map((s) => ({ ...s, values: e[s.k] })), COST_SERIES.map((s) => ({ ...s, values: e[s.k] })),
    { ...MARGIN, values: e.margin }, { title: "Revenue (up) and cost (down) per day, $", yFmt: (v) => fmt$k(v),
      tipNote: (i) => `<br>${fmt0(u.mwh[i] || 0)} MWh${u.da_mwh[i] != null ? `, DA award ${fmt0(u.da_mwh[i])} MWh` : ""}${u.rev_rt[i] == null ? ", priced at lambda" : ""}${u.starts[i] ? `, ${u.starts[i]} start(s)` : ""}` });
  let cum = 0;
  lineChart($("unit-cum"), T.dates, [{ label: "Cumulative margin", color: "--c5", values: e.margin.map((v) => (v == null ? null : (cum += v))) }],
    { H: 180, title: "Cumulative margin ($)", yFmt: (v) => fmt$k(v), tipFmt: fmt$ });
}

async function loadTech() {
  if (!S.data[S.tech] && S.data[S.tech] !== null) S.data[S.tech] = await tryJSON(`data/econ/${S.tech}.json.gz`);
}
function redraw() { compute(); drawTotals(); drawInputs(); drawUnits(); drawUnit(); }
async function changeTech() { $("status").textContent = "Loading…"; await loadTech(); status(); if (!(S.data[S.tech] || {}).units?.[S.unit]) S.unit = null; redraw(); }
function status() {
  const I = S.idx, D = I.dates;
  $("status").textContent = `60-day data: ${D.length} days, ${D[0]} to ${D[D.length - 1]} · node prices on ${I.has_nodes.filter(Boolean).length} days · DAM on ${I.has_dam.filter(Boolean).length} · gas prices on ${I.gas_days}`;
}

async function boot() {
  S.idx = await tryJSON("data/econ_index.json.gz");
  if (!S.idx) { $("status").textContent = "No economics data yet. It is built by the data update workflow."; return; }
  loadView();
  $("tech").innerHTML = TECHS.map((t) => `<option value="${t.id}">${t.label}</option>`).join("");
  if (!TECHS.some((t) => t.id === S.tech)) S.tech = "combined_cycle";
  $("tech").value = S.tech;
  $("tech").onchange = (e) => { S.tech = e.target.value; S.unit = null; changeTech(); saveView(); };
  setSeg("cost", S.cost); bindSeg("cost", "cost", redraw);
  setSeg("rev", S.rev); bindSeg("rev", "rev", redraw);
  $("gas-adder").value = S.adder;
  $("gas-adder").addEventListener("change", (e) => { S.adder = +e.target.value || 0; redraw(); saveView(); });
  $("unit-search").addEventListener("input", (e) => { S.q = e.target.value.trim().toLowerCase(); drawUnits(); });
  await loadTech();
  status();
  redraw();
  window.CX.init();
  let tm; window.addEventListener("resize", () => { clearTimeout(tm); tm = setTimeout(() => { drawTotals(); drawUnit(); }, 150); });
}
boot();
})();

/* Unit page, revenue and cost: the Plant economics unit detail (economics.js) for the unit
   unit.js has selected, on that page's defaults: costs at the EIA average heat rate and the unit's
   own fuel hub, energy revenue settled two-settlement (DA award at the DA price plus the
   real-time deviation). Reads data/econ/<tech>.json.gz (pipeline/econ.py). */
(() => {
"use strict";

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
const { tryJSON, showTip, hideTip, setCSV, css, esc, axisFmt, fmtKind } = window.CX;
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

const HUBS = { hsc: "Houston Ship Channel", waha: "Waha", hh: "Henry Hub" };
const HUB_METHOD = { offers: "its offers follow that price", location: "by its node's location", default: "no signal, default" };
// the Plant economics page's default bases; that page lets you change them
const S = { tech: null, cost: "eia", rev: "two", hub: "unit", adder: 0, params: JSON.parse(JSON.stringify(DEFAULTS)), fuel: { ...FUEL_PRICE }, data: {} };
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

function hubSeries(T, hub) {
  const h = T.hubs && T.hubs[hub];
  if (hub !== "hh" && h && h.some((v) => v != null)) return { values: h, label: HUBS[hub] };
  return { values: T.gas, label: HUBS.hh + (hub !== "hh" ? ` (no ${HUBS[hub]} prices loaded)` : "") };
}
const unitHub = (u) => (S.hub === "unit" ? u.fuel_hub || "hsc" : S.hub);

async function draw() {
  const U = window.UNIT, box = $("econ-panel");
  if (!U) return;
  S.tech = U.tech;
  if (!(S.tech in S.data)) S.data[S.tech] = U.econ !== undefined ? U.econ : await tryJSON(`data/econ/${S.tech}.json.gz`);
  if (window.UNIT !== U) return;
  const T = S.data[S.tech], u = T && T.units[U.name];
  box.hidden = !u;
  if (!u) return;
  const D = T.dates.length, e = unitEcon(u, D, FUEL[S.tech] === "gas" ? hubSeries(T, unitHub(u)).values : []);
  const days = u.mwh.filter((v) => v != null).length, mwh = sum(u.mwh), nst = sum(u.starts), margin = sum(e.margin);
  const own = u.start_hot.filter((v) => v != null).length, mg = u.mingen.filter((v) => v != null);
  const fuelNote = FUEL[S.tech] ? ` Costs: fuel at the EIA average heat rate for the technology (${EIA_HR[S.tech]} MMBtu/MWh)` +
    (FUEL[S.tech] === "gas" ? ` × ${HUBS[unitHub(u)]} gas${u.fuel_hub ? ` (its hub: ${HUB_METHOD[u.fuel_hub_method] || u.fuel_hub_method})` : ""}` : ` × $${S.fuel[FUEL[S.tech]]}/MMBtu`) +
    ` plus $${S.params[S.tech].vom}/MWh variable O&M, and starts at its own DAM hot-start offer where it has one, else $${fmt0(S.params[S.tech].start)}.`
    : S.tech === "storage" ? " Charging is in energy revenue as a negative (MWh bought at the same prices), so energy revenue is the arbitrage margin and there is no separate fuel cost." : " No fuel cost for wind and solar.";
  $("econ-note").innerHTML = `${days} days, ${fmt1(mwh / 1000)} GWh${S.tech === "storage" ? ` discharged, ${fmt1(sum(u.chg) / 1000)} GWh charged` : `, ${fmt0(nst)} starts`}. Margin ${fmt$(margin)}${mwh ? ` (${fmt$2(margin / mwh)} per MWh)` : ""}. ` +
    `Revenue is settled two-settlement: the DA award at the DA price plus the real-time deviation at its node.` + fuelNote +
    (own ? ` DAM three-part offer on ${own} days (hot start ${fmt$(d3.median(u.start_hot.filter((v) => v != null)))}, minimum-energy ${fmt$2(d3.median(mg))}/MWh).` : "") +
    (e.est ? ` ${e.est} day${e.est === 1 ? "" : "s"} use generic start costs.` : "") +
    ` <a href="fleet.html#tech=${S.tech}">Compare it with its technology on Fleet economics</a>, where the cost and revenue bases can be changed.`;
  legendHTML($("econ-legend"));
  barChart($("econ-chart"), T.dates, REV_SERIES.map((s) => ({ ...s, values: e[s.k] })), COST_SERIES.map((s) => ({ ...s, values: e[s.k] })),
    { ...MARGIN, values: e.margin }, { title: "Revenue (up) and cost (down) per day, $", yFmt: fmt$k,
      tipNote: (i) => `<br>${fmt0(u.mwh[i] || 0)} MWh${u.da_mwh[i] != null ? `, DA award ${fmt0(u.da_mwh[i])} MWh` : ""}${u.rev_rt[i] == null ? ", priced at lambda" : ""}${u.starts[i] ? `, ${u.starts[i]} start(s)` : ""}` });
  let cum = 0;
  lineChart($("econ-cum"), T.dates, [{ label: "Cumulative margin", color: "--c5", values: e.margin.map((v) => (v == null ? null : (cum += v))) }],
    { H: 180, title: "Cumulative margin ($)", yFmt: fmt$k, tipFmt: fmt$ });
}
window.addEventListener("unitchange", draw);
window.addEventListener("unitresize", draw);
if (window.UNIT) draw();
})();

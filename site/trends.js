/* ERCOT Bidding Trends — long-term view. Reads data/trends_60d.json.gz (pipeline/trends.py),
   data/curve_trends.json.gz (pipeline/curve_trends.py) and data/marginal_*.json.gz (pipeline/marginal.py). */
(() => {
"use strict";

// Colors are fixed per technology and match the day view.
const TECHS = [
  { id: "combined_cycle", keys: ["combined_cycle"], label: "Combined cycle", color: "--c1" },
  { id: "combustion_turbine", keys: ["combustion_turbine"], label: "Combustion turbine", color: "--c2" },
  { id: "wind", keys: ["wind"], label: "Wind", color: "--c3" },
  { id: "solar", keys: ["solar"], label: "Solar", color: "--c4" },
  { id: "nuclear", keys: ["nuclear"], label: "Nuclear", color: "--c5" },
  { id: "gas_steam", keys: ["gas_steam"], label: "Gas steam", color: "--c6" },
  { id: "coal", keys: ["coal"], label: "Coal & lignite", color: "--c8" },
  { id: "other", keys: ["hydro", "other"], label: "Other (hydro, diesel, biomass)", color: "--c-other" },
];
const THERMAL = ["nuclear", "coal", "combined_cycle", "gas_steam", "combustion_turbine"];
const FLOOR_TECHS = TECHS.filter((s) => !["wind", "solar"].includes(s.id));   // wind and solar have their own chart
const FLOOR_NOTES = {
  floor_sced: "MW priced at the −$250 floor (or −$249.99) in the curves SCED dispatched against, averaged over each day. This includes minimum output, which ERCOT places at the floor whatever the generator offered, and units running on an output schedule with no offer.",
  floor_submitted: "MW the generators themselves priced at the −$250 floor in the offer curves they submitted, averaged over each day.",
  le0_submitted: "MW the generators themselves priced at or below $0 in the offer curves they submitted, averaged over each day.",
};
// wind and solar offer price bands (pipeline/curve_trends.py), ordered from cheapest
const BANDS = [
  { id: "floor", label: "At the floor (−$250)", color: "--c8" },
  { id: "ptc", label: "Below −$20 (tax-credit range)", color: "--c2" },
  { id: "neg", label: "−$20 to −$1", color: "--c4" },
  { id: "zero", label: "About $0 (−$1 to $0)", color: "--c-other" },
  { id: "pos", label: "Above $0", color: "--c1" },
];
// capacity by status (needs the per-unit status data from the reprocessing run)
const STATUS = [
  { id: "self", label: "Running, self-committed", color: "--c1" },
  { id: "ruc", label: "Running, committed by ERCOT (RUC)", color: "--c4" },
  { id: "off", label: "Offline but available", color: "--c-other" },
  { id: "out", label: "On outage", color: "--c8" },
];
// marginal supply series per report; storage is split into charging (demand) and discharging
const MSERIES = {
  "60d": [
    ...TECHS.filter((s) => s.id !== "other"),
    { id: "storage_discharging", keys: ["storage_discharging"], label: "Storage discharging", color: "--c7" },
    TECHS.find((s) => s.id === "other"),
  ],
  "2d": [
    { id: "non_irr", keys: ["non_irr"], label: "Thermal & other (non-IRR)", color: "--c1" },
    { id: "wind", keys: ["wind"], label: "Wind", color: "--c3" },
    { id: "solar", keys: ["solar"], label: "Solar", color: "--c4" },
    { id: "storage_discharging", keys: ["storage_discharging"], label: "Storage discharging", color: "--c7" },
  ],
};
const CHARGING = { id: "storage_charging", keys: ["storage_charging"], label: "Storage charging (bids to buy)", color: "--c7-soft" };
const MBP_BINS = [
  [-Infinity, -5, "< −$5"], [-5, 0, "−$5–0"], [0, 5, "$0–5"], [5, 10, "$5–10"], [10, 15, "$10–15"], [15, 20, "$15–20"],
  [20, 25, "$20–25"], [25, 30, "$25–30"], [30, 40, "$30–40"], [40, 50, "$40–50"], [50, 75, "$50–75"],
  [75, 100, "$75–100"], [100, 200, "$100–200"], [200, Infinity, "≥ $200"],
];
const SIG_FMT = { le0: (v) => d3.format(".0%")(v), noff: (v) => d3.format(".0%")(v), rel: (v) => (v >= 0 ? "+" : "−") + d3.format("$,.0f")(Math.abs(v)) };

const S = { T: null, C: null, M: {}, floorMode: "floor_sced", hidden: { floor: new Set(), partial: new Set() },
  pqTech: "coal", capTech: "coal", scTech: "coal", scX: "week", mSrc: "60d", mView: "smooth", mDays: "all",
  chgTech: "all", chgSig: "all", unit: null,
  I: null, UH: null, idx: null, summ60: null, cheapTech: "all", cheapThr: "0", shutTech: "combined_cycle", shutPrice: "any",
  heatMeasure: "offer", heatTech: "combined_cycle", heatThr: "0", heatScale: "zero",
  stTech: "all", stThr: "0", stSort: "off", stUnit: "mw", stBase: null, stripScale: null };
const { getJSON, tryJSON, showTip, hideTip, setCSV } = window.CX;
const $ = (id) => document.getElementById(id);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const fmtMW = d3.format(",.0f");
const fmtPct = d3.format(".0%");
const fmtPrice = (v) => (v == null || isNaN(v) ? "–" : d3.format("$,.2f")(v));
const fmtPrice0 = (v) => d3.format("$,.0f")(v);
const parseDate = (d) => new Date(d + "T12:00:00");
const fmtDate = d3.timeFormat("%a %b %-d, %Y");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function setSeg(id, value) { $(id).querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === value))); }
function bindSeg(id, key, after) {
  $(id).addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    S[key] = b.dataset.v; setSeg(id, S[key]); after(); saveView();
  });
}
function bindSelect(id, key, options, after) {
  $(id).innerHTML = options.map((s) => `<option value="${s.id}">${s.label}</option>`).join("");
  if (!options.some((s) => s.id === S[key])) S[key] = options[0].id;
  $(id).value = S[key];
  $(id).onchange = (e) => { S[key] = e.target.value; after(); saveView(); };
}
function emptyMsg(el, msg) { el.innerHTML = `<p class="empty">${msg}</p>`; }
function staticLegend(el, list) { el.innerHTML = list.map((s) => `<span><span class="sw" style="background:var(${s.color})"></span>${s.label}</span>`).join(""); }

function legend(el, list, hidden, redraw) {
  el.innerHTML = list.map((s) => `<button type="button" data-id="${s.id}" aria-pressed="${!hidden.has(s.id)}"><span class="sw" style="background:var(${s.color})"></span>${s.label}</button>`).join("");
  el.onclick = (e) => {
    const b = e.target.closest("button[data-id]");
    if (!b) return;
    hidden.has(b.dataset.id) ? hidden.delete(b.dataset.id) : hidden.add(b.dataset.id);
    legend(el, list, hidden, redraw); redraw();
  };
}

// daily value for a technology series (sums component keys; null when every part is missing)
function techDaily(s, stat) {
  const D = S.T.daily;
  return S.T.dates.map((_, i) => {
    const parts = s.keys.map((k) => D[k] && D[k][stat] && D[k][stat][i]).filter((v) => v != null);
    return parts.length ? d3.sum(parts) : null;
  });
}
const hasStat = (stat) => THERMAL.some((t) => (S.T.daily[t]?.[stat] || []).some((v) => v != null));

// ---- time-series chart with hover crosshair ---------------------------------------
// series: [{ label, color, values, dash?, width? }]
// opts: { title, yFmt, tipFmt, H, markers, dots, dates (defaults to the 60-day dates), stack (100% areas), yScale }
function timeChart(el, series, opts) {
  const dstr = opts.dates || S.T.dates, dates = dstr.map(parseDate);
  const w = Math.max(280, el.clientWidth || 600);
  const H = opts.H || 260, m = { t: 16, r: 16, b: 26, l: 64 };
  const x = d3.scaleTime().domain(d3.extent(dates)).range([m.l, w - m.r]);
  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  if (!all.length) return emptyMsg(el, opts.empty || "No data.");
  let y;
  if (opts.stack) y = d3.scaleLinear().domain([0, opts.stackMax || 1]).range([H - m.b, m.t]);
  else if (opts.yScale === "symlog") y = d3.scaleSymlog().constant(10).domain([Math.min(0, d3.min(all)), d3.max(all)]).range([H - m.b, m.t]);
  else y = d3.scaleLinear().domain([Math.min(0, d3.min(all)), Math.max(opts.yMin || 1, d3.max(all))]).nice().range([H - m.b, m.t]);
  const yTicks = opts.yTicks ? opts.yTicks.filter((v) => v >= y.domain()[0] && v <= y.domain()[1]) : null;
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  const yAxis = () => (yTicks ? d3.axisLeft(y).tickValues(yTicks) : d3.axisLeft(y).ticks(5));
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(yAxis().tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(w < 560 ? 4 : 8).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(yAxis().tickFormat(opts.yFmt || d3.format(",.0f")).tickSizeOuter(0));
  if (y.domain()[0] < 0) svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(0)).attr("y2", y(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text(opts.title);
  // markers: dates, or { d, color } to color each line
  (opts.markers || []).forEach((mk) => {
    const xm = x(parseDate(mk.d || mk));
    svg.append("line").attr("class", "crosshair").attr("x1", xm).attr("x2", xm).attr("y1", m.t).attr("y2", H - m.b).style("stroke", css(mk.color || "--accent"));
  });
  if (opts.stack) {
    // stacked areas in series order; a day missing from every series is a gap
    const ok = dates.map((_, i) => series.some((s) => s.values[i] != null));
    let base = dates.map(() => 0);
    series.forEach((s) => {
      const lo = base, hi = lo.map((b, i) => b + (s.values[i] || 0));
      svg.append("path").attr("fill", css(s.color))
        .attr("d", d3.area().defined((_, i) => ok[i]).x((_, i) => x(dates[i])).y0((_, i) => y(lo[i])).y1((_, i) => y(hi[i]))(dates));
      base = hi;
    });
  } else {
    const line = d3.line().defined((v) => v != null).x((v, i) => x(dates[i])).y((v) => y(v));
    series.forEach((s) => svg.append("path").attr("fill", "none").attr("stroke", css(s.color)).attr("stroke-width", s.width || 2)
      .attr("stroke-dasharray", s.dash || null).attr("d", line(s.values)));
    // single days between gaps draw no line segment, so mark every point when asked
    if (opts.dots) series.forEach((s) => svg.append("g").selectAll("circle").data(s.values.map((v, i) => [v, i]).filter(([v]) => v != null))
      .join("circle").attr("cx", ([, i]) => x(dates[i])).attr("cy", ([v]) => y(v)).attr("r", 2).attr("fill", css(s.color)));
  }
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", H - m.b).style("display", "none");
  const tf = opts.tipFmt || opts.yFmt || fmtMW;
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const t = x.invert(d3.pointer(ev)[0]);
      const i = d3.minIndex(dates, (d) => Math.abs(d - t));
      cross.style("display", null).attr("x1", x(dates[i])).attr("x2", x(dates[i]));
      const rows = series.filter((s) => s.values[i] != null);
      if (!opts.stack) rows.sort((a, b) => b.values[i] - a.values[i]);
      showTip(ev, `<h4>${fmtDate(dates[i])}${opts.tipNote ? opts.tipNote(i) : ""}</h4><table>` + (opts.stack ? [...rows].reverse() : rows).map((s) =>
        `<tr><td><span class="sw" style="background:var(${s.color})"></span></td><td>${s.label}</td><td class="n">${tf(s.values[i])}</td></tr>`).join("") + "</table>");
    })
    .on("pointerleave", () => { cross.style("display", "none"); hideTip(); });
  el.replaceChildren(svg.node());
  setCSV(el, ["date", ...series.map((s) => s.label)], dstr.map((d, i) => [d, ...series.map((s) => s.values[i])]), opts.title);
}

// ---- panels ----------------------------------------------------------------------
function drawFloor() {
  $("floor-note").textContent = FLOOR_NOTES[S.floorMode];
  const list = FLOOR_TECHS.filter((s) => !S.hidden.floor.has(s.id));
  timeChart($("floor-chart"), list.map((s) => ({ ...s, values: techDaily(s, S.floorMode) })), { title: "MW, daily average", H: 280 });
  timeChart($("floor-price"), [{ label: "System lambda", color: "--price", values: S.T.lambda }],
    { title: "System lambda ($/MWh), daily average", H: 140, yFmt: d3.format("$,.0f"), tipFmt: fmtPrice, yMin: 10 });
}

function drawRenewBands() {
  const rs = S.C && S.C.rs;
  ["wind", "solar"].forEach((t) => {
    const el = $(`rs-${t}`);
    if (!rs) return emptyMsg(el, "No curve trends yet. They are built by the data update workflow.");
    timeChart(el, BANDS.map((b) => ({ ...b, values: rs[t][b.id] })), {
      dates: rs.dates, stack: true, H: 220, yFmt: fmtPct, tipFmt: d3.format(".1%"),
      title: `${t === "wind" ? "Wind" : "Solar"}: share of offered MW in each price band`,
      tipNote: (i) => ` · ${rs.src[i] === "2d" ? "2-day" : "60-day"} curves`,
    });
  });
}

const CURT = [
  { id: "wind", label: "Wind", color: "--c3" },
  { id: "solar", label: "Solar", color: "--c4" },
];
function drawCurtailment() {
  const c = S.C && S.C.curt, el = $("curt-daily"), pel = $("curt-price");
  staticLegend($("curt-legend"), CURT);
  if (!c || !c.dates.length) { emptyMsg(el, "No curtailment data yet. It is built by the data update workflow."); pel.innerHTML = ""; return; }
  const gwh = (v) => (v == null ? null : v / 1000);
  const has2d = CURT.some((t) => c[t.id].c2d.some((v) => v != null));
  timeChart(el, CURT.flatMap((t) => [
    { label: `${t.label}, 60-day`, color: t.color, values: c[t.id].c60.map(gwh) },
    ...(has2d ? [{ label: `${t.label}, 2-day`, color: t.color, values: c[t.id].c2d.map(gwh), dash: "5 3", width: 1.5 }] : []),
  ]), { dates: c.dates, H: 240, title: "Curtailed energy (GWh per day)", yFmt: d3.format(",.0f"), tipFmt: d3.format(",.1f"),
    tipNote: (i) => {
      const share = CURT.map((t) => { const k = c[t.id].c60[i] != null ? "60" : "2d"; const a = c[t.id]["a" + k][i], v = c[t.id]["c" + k][i]; return a ? `${t.label} ${fmtPct(v / a)}` : null; }).filter(Boolean);
      return share.length ? ` · share of available: ${share.join(", ")}` : "";
    } });

  // hourly curtailed MW grouped by system lambda
  const ci = Object.fromEntries(c.hours.columns.map((k, i) => [k, i]));
  const rows = c.hours.rows;
  const bins = MBP_BINS.map(([lo, hi, label]) => {
    const hrs = rows.filter((r) => r[ci.lambda] >= lo && r[ci.lambda] < hi);
    const mean = (k) => (hrs.length ? d3.mean(hrs, (r) => r[ci[k]] || 0) : 0);
    return { label, n: hrs.length, wind: mean("wind"), solar: mean("solar"), wa: mean("wind_avail"), sa: mean("solar_avail") };
  });
  const w = Math.max(280, pel.clientWidth || 600), narrow = w < 560, H = 260, m = { t: 18, r: 12, b: narrow ? 74 : 58, l: 56 };
  const x = d3.scaleBand().domain(bins.map((b) => b.label)).range([m.l, w - m.r]).paddingInner(0.18);
  const y = d3.scaleLinear().domain([0, Math.max(100, d3.max(bins, (b) => b.wind + b.solar))]).nice().range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickFormat(d3.format(",.0f")).tickSizeOuter(0));
  const xa = svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickSizeOuter(0));
  if (narrow) xa.selectAll("text").attr("transform", "rotate(-45)").attr("text-anchor", "end").attr("dx", "-0.4em").attr("dy", "0.5em");
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text("Average curtailed MW in hours at each system lambda");
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", H - 2).attr("text-anchor", "end").text("Hour's average system lambda ($/MWh)");
  bins.forEach((b) => {
    const cx = x(b.label), bw = x.bandwidth(), op = b.n < 24 ? 0.45 : 1;
    let acc = 0;
    CURT.forEach((t) => {
      const v = b[t.id];
      if (v > 0) svg.append("rect").attr("x", cx).attr("width", bw).attr("y", y(acc + v)).attr("height", Math.max(0, y(acc) - y(acc + v) - 1)).attr("fill", css(t.color)).attr("opacity", op);
      acc += v;
    });
    if (!narrow) svg.append("text").attr("class", "axis-title").attr("x", cx + bw / 2).attr("y", H - m.b + 32).attr("text-anchor", "middle").text(`${b.n.toLocaleString()} h`);
    svg.append("rect").attr("x", cx - 2).attr("width", bw + 4).attr("y", m.t).attr("height", H - m.t - m.b).attr("fill", "transparent")
      .on("pointermove", (ev) => showTip(ev, `<h4>System lambda ${b.label}</h4>${b.n.toLocaleString()} hours${b.n && b.n < 24 ? " (few hours: read with care)" : ""}<table>` +
        CURT.map((t) => { const a = t.id === "wind" ? b.wa : b.sa; return `<tr><td><span class="sw" style="background:var(${t.color})"></span></td><td>${t.label}</td><td class="n">${fmtMW(b[t.id])} MW</td><td class="n">${a > 0 ? fmtPct(b[t.id] / a) + " of available" : ""}</td></tr>`; }).join("") + "</table>"))
      .on("pointerleave", hideTip);
  });
  pel.replaceChildren(svg.node());
  setCSV(pel, ["lambda_group", "hours", "wind_curtailed_mw", "solar_curtailed_mw", "wind_available_mw", "solar_available_mw"],
    bins.map((b) => [b.label, b.n, b.wind, b.solar, b.wa, b.sa]), "Curtailment by price");
}

function drawPriceQuantiles() {
  const pq = S.C && S.C.pq, el = $("pq-chart");
  if (!pq || !pq[S.pqTech]) return emptyMsg(el, "No curve trends yet. They are built by the data update workflow.");
  const s = TECHS.find((t) => t.id === S.pqTech), q = pq[S.pqTech];
  // the daily lambda on the same dates, for reference
  const lamBy = Object.fromEntries(S.T.dates.map((d, i) => [d, S.T.lambda[i]]));
  timeChart(el, [
    { label: "90% of offered MW at or below", color: s.color, values: q.p90, dash: "6 3", width: 1.5 },
    { label: "50% (median MW)", color: s.color, values: q.p50, width: 2.5 },
    { label: "25% of offered MW at or below", color: s.color, values: q.p25, dash: "2 3", width: 1.5 },
    { label: "System lambda, daily average", color: "--price", values: pq.dates.map((d) => lamBy[d] ?? null), width: 1 },
  ], { dates: pq.dates, H: 280, yScale: "symlog", yTicks: [-250, -50, 0, 10, 25, 50, 100, 250, 1000, 5000], yFmt: fmtPrice0, tipFmt: fmtPrice,
    title: `${s.label}: offer price at which 25%, 50% and 90% of submitted MW is available ($/MWh)` });
}

// capacity by status from the intraday file (pipeline/intraday.py status_group)
const STATUS6 = [
  { id: "offer", label: "Running on an offer", color: "--c1" },
  { id: "schedule", label: "Running on an output schedule", color: "--c4" },
  { id: "ruc", label: "Committed by ERCOT (RUC)", color: "--c8" },
  { id: "other_on", label: "Other online states (testing, emergency, starting, stopping)", color: "--c7-soft" },
  { id: "off", label: "Offline but available", color: "--c-other" },
  { id: "out", label: "On outage", color: "--ink-2" },
];
function drawCapacity() {
  const el = $("cap-chart"), s = TECHS.find((t) => t.id === S.capTech);
  const C = S.I && S.I.tech[S.capTech];
  if (C && C.cap_offer) {
    $("cap-note").textContent = "MW of capacity (HSL) by unit status, averaged over each day's SCED runs, from the per-unit 60-day data. \"Offline but available\" is the economic choice not to run; outages are not. Units on an output schedule run at the MW their QSE scheduled, with no offer curve. RUC is ERCOT committing a unit for reliability, which is rare.";
    staticLegend($("cap-legend"), STATUS6);
    const series = STATUS6.map((g) => ({ ...g, values: C["cap_" + g.id] }));
    return timeChart(el, series, { stack: true, dates: S.I.dates,
      stackMax: d3.max(S.I.dates, (_, i) => d3.sum(series, (x) => x.values[i] || 0)) || 1,
      H: 280, title: `${s.label}: capacity by status (MW)`, yFmt: d3.format(",.0f") });
  }
  if (!hasStat("mw_off")) {
    $("cap-note").textContent = "Status detail (running, ERCOT-committed, offline but available, on outage) fills in after the 60-day data is reprocessed. Until then this shows units online.";
    $("cap-legend").innerHTML = "";
    return timeChart(el, [{ ...s, values: techDaily(s, "n_online") }], { title: `${s.label}: units online, daily average`, tipFmt: d3.format(",.1f") });
  }
  $("cap-note").textContent = "MW of capacity (HSL) by status, daily average. Only \"offline but available\" is an economic choice not to run; outages are not.";
  staticLegend($("cap-legend"), STATUS);
  const on = techDaily(s, "mw_on"), ruc = techDaily(s, "mw_onruc");
  timeChart(el, [
    { ...STATUS[0], values: on.map((v, i) => (v == null ? null : Math.max(0, v - (ruc[i] || 0)))) },
    { ...STATUS[1], values: ruc },
    { ...STATUS[2], values: techDaily(s, "mw_off") },
    { ...STATUS[3], values: techDaily(s, "mw_out") },
  ], { stack: true, stackMax: d3.max(S.T.dates, (_, i) => d3.sum(["mw_on", "mw_off", "mw_out"], (k) => techDaily(s, k)[i] || 0)) || 1,
    H: 280, title: `${s.label}: capacity by status (MW)`, yFmt: d3.format(",.0f") });
}

function drawScatter() {
  const el = $("sc-chart");
  const s = TECHS.find((t) => t.id === S.scTech);
  // with status data: share of the available fleet that ran; without it: units online
  const status = hasStat("mw_off");
  const on = techDaily(s, status ? "mw_on" : "n_online"), off = status ? techDaily(s, "mw_off") : null;
  const yv = status ? on.map((v, i) => (v == null || off[i] == null || v + off[i] <= 0 ? null : v / (v + off[i]))) : on;
  const lam = S.T.lambda;
  const xv = lam.map((v, i) => {
    if (S.scX === "day") return v;
    const prev = lam.slice(Math.max(0, i - 7), i).filter((p) => p != null);
    return prev.length >= 4 ? d3.mean(prev) : null;   // needs most of the previous week
  });
  const pts = S.T.dates.map((d, i) => ({ d, x: xv[i], y: yv[i] })).filter((p) => p.x != null && p.y != null);
  if (!pts.length) return emptyMsg(el, "No data.");
  const w = Math.max(280, el.clientWidth || 600);
  const H = 320, m = { t: 30, r: 16, b: 38, l: 56 };
  // clip extreme prices so the bulk of days stays readable; they still count in the bands
  const xmax = Math.min(d3.max(pts, (p) => p.x), d3.quantile(pts.map((p) => p.x).sort(d3.ascending), 0.98) * 1.2);
  const x = d3.scaleLinear().domain([Math.min(0, d3.min(pts, (p) => p.x)), xmax]).nice().range([m.l, w - m.r]);
  const shown = pts.filter((p) => p.x <= x.domain()[1]), offN = pts.length - shown.length;
  const y = d3.scaleLinear().domain([0, status ? 1 : d3.max(pts, (p) => p.y)]).nice().range([H - m.b, m.t]);
  const yFmt = status ? fmtPct : d3.format(",.0f");
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(w < 560 ? 4 : 8).tickFormat(d3.format("$,.0f")).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickFormat(yFmt).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10)
    .text(status ? `${s.label}: share of available capacity running, daily average` : `${s.label}: units online, daily average`);
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", H - 4).attr("text-anchor", "end")
    .text(S.scX === "day" ? "System lambda that day ($/MWh)" : "Average system lambda over the previous 7 days ($/MWh)");
  if (offN) svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 24)
    .text(`${offN} day${offN === 1 ? "" : "s"} above ${d3.format("$,.0f")(x.domain()[1])} not shown`);
  svg.append("g").selectAll("circle").data(shown).join("circle").attr("cx", (p) => x(p.x)).attr("cy", (p) => y(p.y)).attr("r", 4)
    .attr("fill", css(s.color)).attr("fill-opacity", 0.55).attr("stroke", css("--surface")).attr("stroke-width", 1)
    .on("pointermove", (ev, p) => showTip(ev, `<h4>${fmtDate(parseDate(p.d))}</h4>${status ? fmtPct(p.y) + " of available capacity running" : d3.format(",.1f")(p.y) + " units online"}<br>Lambda ${fmtPrice(p.x)}`))
    .on("pointerleave", hideTip);
  // median per $5 band (bands with at least 3 days)
  const bands = d3.groups(pts, (p) => Math.floor(p.x / 5) * 5).filter(([, g]) => g.length >= 3)
    .map(([b, g]) => ({ x: b + 2.5, y: d3.median(g, (p) => p.y), n: g.length })).sort((a, b) => a.x - b.x);
  svg.append("path").attr("fill", "none").attr("stroke", css("--ink")).attr("stroke-width", 2)
    .attr("d", d3.line().defined((b) => b.x <= x.domain()[1]).x((b) => x(b.x)).y((b) => y(b.y))(bands));
  el.replaceChildren(svg.node());
  setCSV(el, ["date", S.scX === "day" ? "lambda_same_day" : "lambda_prev_7_days", status ? "share_of_available_capacity_running" : "units_online"], pts.map((p) => [p.d, p.x, p.y]), "Units online vs price");
}

function drawPartial() {
  const exact = hasStat("starts");
  $("partial-title").textContent = exact ? "Starts per day" : "Units online for only part of the day";
  $("partial-note").textContent = exact
    ? "Number of times units of each technology came online (OFF to ON) each day, counted from per-unit status changes. Two starts in a day means a unit cycled off and back on."
    : "Units online between 1 and 22 hours of the day: a stand-in for cycling and two-shifting. It cannot tell a unit that shut down overnight and restarted from one that started once and stayed on. An exact count of starts fills in after the 60-day data is reprocessed.";
  const list = TECHS.filter((s) => THERMAL.includes(s.id) && !S.hidden.partial.has(s.id));
  timeChart($("partial-chart"), list.map((s) => ({ ...s, values: techDaily(s, exact ? "starts" : "partial_units") })),
    { title: exact ? "Unit starts per day" : "Units online 1–22 hours of the day" });
}

function drawFlips() {
  const el = $("flip-table"), flips = S.T.flips;
  if (!flips) { el.innerHTML = `<p class="empty">Fills in after the 60-day data is reprocessed with per-unit offer curves.</p>`; return; }
  let rows = flips;
  if (S.chgTech !== "all") rows = rows.filter((f) => f[1] === S.chgTech);
  rows = [...rows].reverse();
  const byUnit = d3.rollups(flips, (v) => v.length, (f) => f[0]).sort((a, b) => b[1] - a[1]).slice(0, 10);
  el.innerHTML = (byUnit.length ? `<p class="note">Most frequent: ${byUnit.map(([u, n]) => `${esc(u)} (${n} day${n === 1 ? "" : "s"})`).join(", ")}.</p>` : "") +
    (rows.length ? `<div class="units-wrap"><table class="data"><thead><tr><th class="t">Date</th><th class="t">Unit</th><th class="t">Technology</th><th>Switches</th><th>First switch</th><th>Hours offering ≤ $0</th></tr></thead><tbody>` +
      rows.map((f) => `<tr data-unit="${esc(f[0])}" style="cursor:pointer"><td class="t">${f[2]}</td><td class="t">${esc(f[0])}</td><td class="t">${TECHS.find((t) => t.id === f[1])?.label || f[1]}</td><td>${f[3]}</td><td>${f[4] ?? "–"}</td><td>${f[5] == null ? "–" : d3.format(",.1f")(f[5])}</td></tr>`).join("") +
      "</tbody></table></div>" : `<p class="empty">No units switched within a day.</p>`);
}

// ---- marginal supply by settled price ----------------------------------------------
async function drawMarginal() {
  const el = $("mbp-chart"), src = S.mSrc;
  const list = MSERIES[src];
  staticLegend($("mbp-legend"), [...list, CHARGING]);
  if (!S.M[src]) S.M[src] = await tryJSON(`data/marginal_${src}.json.gz`);
  const data = S.M[src];
  if (src !== S.mSrc) return;
  if (!data || !data.rows.length) return emptyMsg(el, "No marginal data yet. It is built by the data update workflow.");
  const ci = Object.fromEntries(data.columns.map((c, i) => [c, i]));
  let rows = data.rows.filter((r) => r[2] != null);
  const last = rows[rows.length - 1][0];
  if (S.mDays !== "all") {
    const from = d3.timeFormat("%Y-%m-%d")(d3.timeDay.offset(parseDate(last), -(+S.mDays - 1)));
    rows = rows.filter((r) => r[0] >= from);
  }
  $("mbp-title-note").textContent = `${src === "60d" ? "60-day" : "2-day"} data · ${rows.length ? rows[0][0] : ""} to ${last} · ${rows.length.toLocaleString()} hours`;
  // per hour: supply MW per series, and charging MW that stops in the hour's price window
  const H = rows.map((r) => ({ p: r[2], v: list.map((s) => d3.sum(s.keys, (k) => r[ci[k]] || 0)), c: r[ci.storage_charging] || 0 }))
    .filter((h) => d3.sum(h.v) + h.c > 0).sort((a, b) => a.p - b.p);
  if (H.length < 30) return emptyMsg(el, "Too few hours for this view.");
  const w = Math.max(280, el.clientWidth || 600), narrow = w < 560;
  if (S.mView === "smooth") drawMarginalSmooth(el, H, list, w, narrow);
  else drawMarginalGroups(el, H, list, w, narrow);
}

function marginalAxes(svg, y, x, w, H, m, xTitle, xAxis) {
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(6).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(6).tickFormat((v) => fmtPct(Math.abs(v))).tickSizeOuter(0));
  const xa = svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(xAxis.tickSizeOuter(0));
  svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(0)).attr("y2", y(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text("Share of marginal supply (above) · battery charging that stops (below)");
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", H - 2).attr("text-anchor", "end").text(xTitle);
  return xa;
}

// each point blends the K hours nearest that price, so it rests on the same amount of data everywhere
function drawMarginalSmooth(el, H, list, w, narrow) {
  const K = Math.min(200, Math.floor(H.length / 4)), n = H.length;
  const cum = [list.map(() => 0)], cc = [0];
  H.forEach((h, i) => { cum.push(cum[i].map((c, j) => c + h.v[j])); cc.push(cc[i] + h.c); });
  const step = Math.max(1, Math.floor(n / 400)), pts = [];
  for (let i = 0; i + K <= n; i += step) {
    const a = i, b = i + K, v = list.map((_, j) => cum[b][j] - cum[a][j]), sup = d3.sum(v), c = cc[b] - cc[a];
    pts.push({ p: H[a + (K >> 1)].p, lo: H[a].p, hi: H[b - 1].p, sh: v.map((t) => (sup ? t / sup : 0)), c: sup + c ? c / (sup + c) : 0 });
  }
  const Hh = 400, HS = 60, m = { t: 18, r: 16, b: 30, l: 50 };
  const x = d3.scaleSymlog().constant(10).domain(d3.extent(pts, (d) => d.p)).range([m.l, w - m.r]);
  const y = d3.scaleLinear().domain([-0.5, 1]).range([Hh - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${Hh + HS + 30}`);
  const ticks = (narrow ? [0, 20, 50, 100] : [-20, -5, 0, 10, 20, 30, 50, 100, 200, 500]).filter((t) => t >= x.domain()[0] && t <= x.domain()[1]);
  marginalAxes(svg, y, x, w, Hh, m, "System lambda, hourly average ($/MWh, compressed scale)", d3.axisBottom(x).tickValues(ticks).tickFormat(fmtPrice0));
  let base = pts.map(() => 0);
  list.forEach((s, j) => {
    const lo = base, hi = lo.map((b, i) => b + pts[i].sh[j]);
    svg.append("path").attr("fill", css(s.color)).attr("d", d3.area().curve(d3.curveMonotoneX).x((d) => x(d.p)).y0((d, i) => y(lo[i])).y1((d, i) => y(hi[i]))(pts));
    base = hi;
  });
  svg.append("path").attr("fill", css(CHARGING.color)).attr("d", d3.area().curve(d3.curveMonotoneX).x((d) => x(d.p)).y0(y(0)).y1((d) => y(-d.c))(pts));
  svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(0)).attr("y2", y(0));
  // how many hours sit at each price
  const g = svg.append("g").attr("transform", `translate(0,${Hh + 16})`);
  const inDom = H.filter((h) => h.p >= x.domain()[0] && h.p <= x.domain()[1]).map((h) => h.p);
  const bins = d3.bin().thresholds(d3.range(60).map((i) => x.invert(m.l + ((w - m.l - m.r) * i) / 60))).domain(x.domain())(inDom);
  const yh = d3.scaleLinear().domain([0, d3.max(bins, (b) => b.length) || 1]).range([HS, 0]);
  g.selectAll("rect").data(bins).join("rect").attr("x", (b) => x(b.x0) + 0.5).attr("width", (b) => Math.max(0, x(b.x1) - x(b.x0) - 1))
    .attr("y", (b) => yh(b.length)).attr("height", (b) => HS - yh(b.length)).attr("fill", css("--muted")).attr("opacity", 0.45);
  g.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", -3).text(`Hours at each price (${n.toLocaleString()} hours; the line stops where fewer than ${K / 2} hours lie beyond)`);
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", Hh - m.b).style("display", "none");
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", Hh - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const p = x.invert(d3.pointer(ev)[0]), d = pts[d3.minIndex(pts, (q) => Math.abs(q.p - p))];
      cross.style("display", null).attr("x1", x(d.p)).attr("x2", x(d.p));
      showTip(ev, `<h4>Around ${fmtPrice(d.p)}</h4><table>` + list.map((s, j) => [s, d.sh[j]]).filter(([, v]) => v > 0.005).sort((a, b) => b[1] - a[1])
        .map(([s, v]) => `<tr><td><span class="sw" style="background:var(${s.color})"></span></td><td>${s.label}</td><td class="n">${fmtPct(v)}</td></tr>`).join("") +
        `<tr><td><span class="sw" style="background:var(${CHARGING.color})"></span></td><td>Battery charging (of all moving MW)</td><td class="n">${fmtPct(d.c)}</td></tr></table>` +
        `<p class="tip-body">Blends the ${K} hours with lambda from ${fmtPrice(d.lo)} to ${fmtPrice(d.hi)}.</p>`);
    })
    .on("pointerleave", () => { cross.style("display", "none"); hideTip(); });
  el.replaceChildren(svg.node());
  setCSV(el, ["lambda_usd_mwh", "window_low", "window_high", ...list.map((s) => `${s.label} share of marginal supply`), "battery charging share of all moving MW"],
    pts.map((d) => [d.p, d.lo, d.hi, ...d.sh, d.c]), "Marginal supply by settled price");
}

function drawMarginalGroups(el, H, list, w, narrow) {
  const bins = MBP_BINS.map(([lo, hi, label]) => {
    const hrs = H.filter((h) => h.p >= lo && h.p < hi);
    const v = list.map((_, j) => d3.sum(hrs, (h) => h.v[j])), sup = d3.sum(v), c = d3.sum(hrs, (h) => h.c);
    return { label, n: hrs.length, sh: v.map((t) => (sup ? t / sup : 0)), c: sup + c ? c / (sup + c) : 0 };
  });
  const Hh = 360, m = { t: 18, r: 12, b: narrow ? 74 : 58, l: 50 };
  const x = d3.scaleBand().domain(bins.map((b) => b.label)).range([m.l, w - m.r]).paddingInner(0.18);
  const y = d3.scaleLinear().domain([-0.5, 1]).range([Hh - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${Hh}`);
  const xa = marginalAxes(svg, y, x, w, Hh, m, "Hour's average system lambda ($/MWh)", d3.axisBottom(x));
  if (narrow) xa.selectAll("text").attr("transform", "rotate(-45)").attr("text-anchor", "end").attr("dx", "-0.4em").attr("dy", "0.5em");
  bins.forEach((b) => {
    const cx = x(b.label), bw = x.bandwidth(), op = b.n < 24 ? 0.45 : 1;   // groups with few hours are faded
    let acc = 0;
    if (b.n) list.forEach((s, j) => {
      const v = b.sh[j];
      if (v <= 0) return;
      svg.append("rect").attr("x", cx).attr("width", bw).attr("y", y(acc + v)).attr("height", Math.max(0, y(acc) - y(acc + v) - 1)).attr("fill", css(s.color)).attr("opacity", op);
      acc += v;
    });
    if (b.c > 0) svg.append("rect").attr("x", cx).attr("width", bw).attr("y", y(0) + 1).attr("height", Math.max(0, y(-b.c) - y(0) - 1)).attr("fill", css(CHARGING.color)).attr("opacity", op);
    if (!narrow) svg.append("text").attr("class", "axis-title").attr("x", cx + bw / 2).attr("y", Hh - m.b + 32).attr("text-anchor", "middle").text(`${b.n.toLocaleString()} h`);
    svg.append("rect").attr("x", cx - 2).attr("width", bw + 4).attr("y", m.t).attr("height", Hh - m.t - m.b).attr("fill", "transparent")
      .on("pointermove", (ev) => showTip(ev, `<h4>System lambda ${b.label}</h4>${b.n.toLocaleString()} hours${b.n && b.n < 24 ? " (few hours: read with care)" : ""}` +
        (b.n ? `<table>` + list.map((s, j) => [s, b.sh[j]]).filter(([, v]) => v > 0).sort((p, q) => q[1] - p[1]).map(([s, v]) =>
          `<tr><td><span class="sw" style="background:var(${s.color})"></span></td><td>${s.label}</td><td class="n">${fmtPct(v)}</td></tr>`).join("") +
          `<tr><td><span class="sw" style="background:var(${CHARGING.color})"></span></td><td>Battery charging (of all moving MW)</td><td class="n">${fmtPct(b.c)}</td></tr></table>` : "")))
      .on("pointerleave", hideTip);
  });
  el.replaceChildren(svg.node());
  setCSV(el, ["lambda_group", "hours", ...list.map((s) => `${s.label} share of marginal supply`), "battery charging share of all moving MW"],
    bins.map((b) => [b.label, b.n, ...b.sh, b.c]), "Marginal supply by settled price");
}

// ---- bidding-approach changes -----------------------------------------------------
function drawChanges() {
  const T = S.T, techOf = Object.fromEntries(T.units.map((u) => [u.unit, u]));
  $("chg-note").textContent = `A change is a shift that holds: the median over the ${T.window} online days after a day differs from the median over the ${T.window} online days before by at least 25 percentage points of MW offered at or below $0, half the day running without an offer, or $10 in first offer price above $0 relative to that day's median for its peers (which removes moves in fuel price). Peers are units of the same ERCOT resource type (for example CCGT90 or SCLE90) when at least 8 of them have a price that day, otherwise the same technology. Thermal units only. Click a row to see the unit.`;
  // summary: units per technology, how many changed
  const sum = THERMAL.map((t) => {
    const us = T.units.filter((u) => u.tech === t);
    const ch = us.filter((u) => u.n_changes > 0);
    return { s: TECHS.find((x) => x.id === t), n: us.length, changed: ch.length, changes: d3.sum(ch, (u) => u.n_changes) };
  });
  $("chg-summary").innerHTML = `<table class="data"><thead><tr><th class="t">Technology</th><th>Units</th><th>Kept one approach</th><th>Changed at least once</th><th>Changes</th></tr></thead><tbody>` +
    sum.map((r) => `<tr><td class="t"><span class="sw" style="background:var(${r.s.color});margin-right:6px"></span>${r.s.label}</td><td>${r.n}</td><td>${r.n - r.changed}</td><td>${r.changed}</td><td>${r.changes}</td></tr>`).join("") + "</tbody></table>";

  let rows = T.changes;
  if (S.chgTech !== "all") rows = rows.filter((c) => c[1] === S.chgTech);
  if (S.chgSig !== "all") rows = rows.filter((c) => c[3] === S.chgSig);
  rows = [...rows].reverse();
  $("chg-table").innerHTML = rows.length ? `<table class="data"><thead><tr><th class="t">Date</th><th class="t">Unit</th><th class="t">Technology</th><th class="t">Change</th><th>Before</th><th>After</th></tr></thead><tbody>` +
    rows.map((c) => {
      const s = TECHS.find((x) => x.id === c[1]);
      return `<tr data-unit="${esc(c[0])}" style="cursor:pointer"><td class="t">${c[2]}</td><td class="t">${esc(c[0])}</td><td class="t">${s ? s.label : c[1]}</td><td class="t">${T.signals[c[3]]}</td><td>${SIG_FMT[c[3]](c[4])}</td><td>${SIG_FMT[c[3]](c[5])}</td></tr>`;
    }).join("") + "</tbody></table>" : `<p class="empty">No changes match.</p>`;
  drawFlips();
  if (S.unit && techOf[S.unit]) drawUnit(techOf[S.unit]);
}

// each kind of bidding change has its own marker color
const SIG_COLOR = { le0: "--c8", noff: "--c7", rel: "--c4" };
function drawUnit(u) {
  const T = S.T, s = TECHS.find((x) => x.id === u.tech);
  const ch = T.changes.filter((c) => c[0] === u.unit);
  const marks = ch.map((c) => ({ d: c[2], color: SIG_COLOR[c[3]] }));
  $("unit-detail").hidden = false;
  $("unit-pick").value = u.unit;
  $("unit-title").textContent = `${u.unit} · ${s.label} (${u.type})`;
  $("unit-note").innerHTML = (ch.length ? `${ch.length} bidding change${ch.length === 1 ? "" : "s"} detected, marked on every chart by a line colored by the kind of change: ` +
    Object.entries(T.signals).map(([k, l]) => `<span class="mk" style="border-color:var(${SIG_COLOR[k]})"></span>${l}`).join(", ") + "." : "No bidding changes detected.") + " Days offline are gaps in the line charts.";
  $("unit-changes").innerHTML = ch.length ? `<table class="data"><thead><tr><th class="t">Date</th><th class="t">Change</th><th>Before</th><th>After</th></tr></thead><tbody>` +
    ch.map((c) => `<tr><td class="t">${c[2]}</td><td class="t"><span class="mk" style="border-color:var(${SIG_COLOR[c[3]]})"></span>${T.signals[c[3]]}</td><td>${SIG_FMT[c[3]](c[4])}</td><td>${SIG_FMT[c[3]](c[5])}</td></tr>`).join("") + "</tbody></table>" : "";
  drawUnitStrip(u, s, marks);
  const median = u.first.map((v, i) => (v == null || u.rel[i] == null ? null : v - u.rel[i]));
  timeChart($("unit-price"), [
    { label: "First offer price above $0", color: s.color, values: u.first },
    { label: "Peer median", color: "--muted", values: median, dash: "4 3", width: 1.5 },
  ], { title: "First offer price above $0 ($/MWh), and the median of its peers", H: 170, yFmt: d3.format("$,.0f"), tipFmt: fmtPrice, markers: marks, dots: true,
    tipNote: (i) => (u.peer && u.peer[i] != null ? ` · peers: ${u.peer[i] ? `${u.type} units` : `all ${s.label.toLowerCase()}`}` : "") });
  timeChart($("unit-share"), [
    { label: "MW offered ≤ $0", color: s.color, values: u.le0 },
    { label: "Share of day with no offer", color: "--muted", values: u.noff, dash: "4 3", width: 1.5 },
  ], { title: "MW offered ≤ $0, and day with no offer (share)", H: 150, yFmt: d3.format(".0%"), markers: marks, dots: true });
}

// day × hour state of one unit: offline, at minimum, above minimum; negative-price hours marked
const STRIP_STATES = { "0": "Offline", o: "On outage", m: "Running at minimum", a: "Running above minimum" };
async function drawUnitStrip(u, s, marks) {
  const el = $("unit-strip");
  if (!S.UH) {
    el.innerHTML = `<p class="empty">Loading hourly data…</p>`;
    S.UH = (await tryJSON("data/unit_hours_60d.json.gz")) || { dates: [], units: {} };
    if (S.unit !== u.unit) return;
  }
  const str = S.UH.units[u.unit];
  const lam = S.I ? S.I.lambda : null;
  $("unit-strip-legend").innerHTML = [["--grid", 1, "Offline"], ["--ink-2", 0.35, "On outage"], [s.color, 0.4, "Running at minimum (LSL)"], [s.color, 1, "Running above minimum"]]
    .map(([c, o, l]) => `<span><span class="sw" style="background:var(${c});opacity:${o}"></span>${l}</span>`).join("") +
    `<span><span class="sw sw-neg"></span>Hour with lambda below $0</span>`;
  if (!str) return emptyMsg(el, "No hourly data for this unit.");
  const dstr = S.UH.dates, dates = dstr.map(parseDate), D = dstr.length;
  const w = Math.max(280, el.clientWidth || 600), m = { t: 16, r: 16, b: 26, l: 64 }, ch = 7, H = m.t + m.b + ch * 24;
  const x = d3.scaleTime().domain(d3.extent(dates)).range([m.l, w - m.r]);
  const cw = (w - m.l - m.r) / Math.max(1, D - 1);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  const col = { "0": css("--grid"), o: css("--ink-2"), m: css(s.color), a: css(s.color) };
  const g = svg.append("g");
  for (let i = 0; i < D; i++) for (let h = 0; h < 24; h++) {
    const c = str[i * 24 + h];
    if (c === "-" || c === undefined) continue;
    g.append("rect").attr("x", x(dates[i]) - cw / 2).attr("y", m.t + h * ch).attr("width", cw + 0.3).attr("height", ch - 0.5)
      .attr("fill", col[c]).attr("fill-opacity", c === "m" ? 0.4 : c === "o" ? 0.35 : 1);
  }
  // negative-price hours: a dark tick in the cell
  if (lam) {
    const li = new Map(S.I.dates.map((d, i) => [d, i]));
    const t = svg.append("g");
    dstr.forEach((d, i) => {
      const L = lam[li.get(d)];
      if (L) L.forEach((v, h) => { if (v != null && v < 0) t.append("rect").attr("x", x(dates[i]) - 0.75).attr("y", m.t + h * ch + 1.5).attr("width", 1.5).attr("height", ch - 3.5).attr("fill", css("--ink")); });
    });
  }
  const y = d3.scaleBand().domain(d3.range(24)).range([m.t, m.t + ch * 24]);
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l - 4},0)`).call(d3.axisLeft(y).tickValues([0, 5, 11, 17, 23]).tickFormat((h) => `HE ${h + 1}`).tickSize(0)).select(".domain").remove();
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(w < 560 ? 4 : 8).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text("Hour by hour: offline, at minimum or above minimum");
  marks.forEach((mk) => svg.append("line").attr("class", "crosshair").attr("x1", x(parseDate(mk.d))).attr("x2", x(parseDate(mk.d))).attr("y1", m.t).attr("y2", H - m.b).style("stroke", css(mk.color)));
  svg.append("rect").attr("x", m.l - cw / 2).attr("y", m.t).attr("width", w - m.l - m.r + cw).attr("height", ch * 24).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const [px, py] = d3.pointer(ev);
      const i = d3.minIndex(dates, (d) => Math.abs(d - x.invert(px))), h = Math.max(0, Math.min(23, Math.floor((py - m.t) / ch)));
      const c = str[i * 24 + h], li = S.I ? S.I.dates.indexOf(dstr[i]) : -1, L = li >= 0 ? S.I.lambda[li][h] : null;
      showTip(ev, `<h4>${fmtDate(dates[i])} · HE ${h + 1}</h4>${STRIP_STATES[c] || "No data"}<br>Lambda ${fmtPrice(L)}`);
    })
    .on("pointerleave", hideTip);
  el.replaceChildren(svg.node());
  drawUnitStretch(u, s, { x, w, m, dates });
  setCSV(el, ["date", "hour_ending", "state"], dstr.flatMap((d, i) => d3.range(24).map((h) => [d, h + 1, STRIP_STATES[str[i * 24 + h]] || ""])), `${u.unit} hourly state`);
}

function showUnit(name) {
  const u = S.T.units.find((x) => x.unit === name);
  if (!u) return;
  S.unit = name; drawUnit(u); saveView();
  $("unit-panel").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---- intraday: thermal output in cheap hours ---------------------------------------
// stacked bars, one per day. series: [{ label, color, opacity?, values }]
function dayBars(el, dstr, series, opts) {
  const dates = dstr.map(parseDate);
  const w = Math.max(280, el.clientWidth || 600), H = opts.H || 240, m = { t: 16, r: 16, b: 26, l: 64 };
  const tot = dstr.map((_, i) => (series.some((s) => s.values[i] != null) ? d3.sum(series, (s) => s.values[i] || 0) : null));
  if (!tot.some((v) => v != null)) return emptyMsg(el, opts.empty || "No data.");
  const x = d3.scaleTime().domain(d3.extent(dates)).range([m.l, w - m.r]);
  const y = d3.scaleLinear().domain([0, Math.max(1, d3.max(tot))]).nice().range([H - m.b, m.t]);
  const bw = Math.max(1, ((w - m.l - m.r) / Math.max(1, dstr.length - 1)) * 0.75);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(w < 560 ? 4 : 8).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickFormat(opts.yFmt || fmtMW).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text(opts.title);
  let base = dstr.map(() => 0);
  series.forEach((s) => {
    const lo = base;
    svg.append("g").selectAll("rect").data(dstr.map((_, i) => i).filter((i) => s.values[i])).join("rect")
      .attr("x", (i) => x(dates[i]) - bw / 2).attr("width", bw)
      .attr("y", (i) => y(lo[i] + s.values[i])).attr("height", (i) => y(lo[i]) - y(lo[i] + s.values[i]))
      .attr("fill", css(s.color)).attr("fill-opacity", s.opacity || 1);
    base = lo.map((b, i) => b + (s.values[i] || 0));
  });
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", H - m.b).style("display", "none");
  const tf = opts.tipFmt || opts.yFmt || fmtMW;
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const t = x.invert(d3.pointer(ev)[0]);
      const i = d3.minIndex(dates, (d) => Math.abs(d - t));
      cross.style("display", null).attr("x1", x(dates[i])).attr("x2", x(dates[i]));
      if (tot[i] == null) return showTip(ev, `<h4>${fmtDate(dates[i])}</h4>${opts.none || "No data"}`);
      showTip(ev, `<h4>${fmtDate(dates[i])}${opts.tipNote ? opts.tipNote(i) : ""}</h4><table>` + [...series].reverse().map((s) =>
        `<tr><td><span class="sw" style="background:var(${s.color});opacity:${s.opacity || 1}"></span></td><td>${s.label}</td><td class="n">${tf(s.values[i] || 0)}</td></tr>`).join("") + "</table>");
    })
    .on("pointerleave", () => { cross.style("display", "none"); hideTip(); });
  el.replaceChildren(svg.node());
  setCSV(el, ["date", ...series.map((s) => s.label)], dstr.map((d, i) => [d, ...series.map((s) => s.values[i])]), opts.title);
}

const ALL_THERMAL = { id: "all", label: "All thermal", color: "--c1" };
const techsOf = (id) => (id === "all" ? THERMAL : [id]);
const unitRows = (rows, cols) => `<table class="data"><thead><tr>${cols.map((c) => `<th${c.t ? ' class="t"' : ""}>${c.h}</th>`).join("")}</tr></thead><tbody>` +
  rows.map((r) => `<tr data-unit="${esc(r.unit)}" style="cursor:pointer">${cols.map((c) => `<td${c.t ? ' class="t"' : ""}>${c.f(r)}</td>`).join("")}</tr>`).join("") + "</tbody></table>";
const techLabel = (t) => TECHS.find((x) => x.id === t)?.label || t;

function drawCheap() {
  const I = S.I, el = $("cheap-chart");
  if (!I) return emptyMsg(el, "Fills in after the data update builds the intraday file.");
  const thr = +S.cheapThr, ts = techsOf(S.cheapTech), s = S.cheapTech === "all" ? ALL_THERMAL : TECHS.find((x) => x.id === S.cheapTech);
  const hrs = I.dates.map((_, i) => d3.range(24).filter((h) => I.lambda[i][h] != null && I.lambda[i][h] < thr && I.tech[ts[0]].at_min[i]));
  // nuclear runs flat out whatever its reported LSL, so with all thermal it is its own segment
  const split = S.cheapTech === "all", flex = split ? ts.filter((t) => t !== "nuclear") : ts;
  const avg = (list, k) => I.dates.map((_, i) => (hrs[i].length ? d3.mean(hrs[i], (h) => d3.sum(list, (t) => d3.sum(k, (kk) => I.tech[t][kk][i][h]))) : null));
  const atMin = avg(flex, ["at_min"]), above = avg(flex, ["above"]), n = avg(ts, ["n"]);
  const series = [
    ...(split ? [{ label: "Nuclear (all output)", color: "--c5", values: avg(["nuclear"], ["at_min", "above"]) }] : []),
    { label: split ? "Other thermal at minimum (up to LSL)" : "At minimum (up to LSL)", color: s.color, opacity: 0.45, values: atMin },
    { label: split ? "Other thermal above minimum" : "Above minimum", color: s.color, values: above },
  ];
  $("cheap-legend").innerHTML = series.map((x) => `<span><span class="sw" style="background:var(${x.color});opacity:${x.opacity || 1}"></span>${x.label}</span>`).join("");
  const nDays = hrs.filter((h) => h.length).length;
  $("cheap-note").textContent = `Average MW of ${s.label.toLowerCase()} output in the hours each day when system lambda was below ${fmtPrice0(thr)} (${nDays} of ${I.dates.length} days had such hours), split into output up to each running unit's minimum (LSL) and output above it. A unit counts as at minimum when its output is no more than ${fmtPct(I.above_eps)} of its HSL above its LSL. Output at minimum is what the unit cannot shed without shutting down. Nuclear reports a low LSL but runs flat out, so with all thermal selected it is shown whole, and on its own nearly all of it shows as above minimum.`;
  dayBars(el, I.dates, series, { title: `${s.label}: average MW in hours with lambda below ${fmtPrice0(thr)}`, none: `No hours with lambda below ${fmtPrice0(thr)}`,
    tipNote: (i) => ` · ${hrs[i].length} h, ${d3.format(",.0f")(n[i])} units running` });
  // units above minimum (nuclear left out: it always is)
  const rows = I.above_units.filter((r) => r[2] === thr && r[1] !== "nuclear" && ts.includes(r[1]) && r[4] > 0)
    .map((r) => ({ unit: r[0], tech: r[1], run: r[3], above: r[4], mwh: r[5] })).sort((a, b) => b.mwh - a.mwh);
  $("cheap-units-note").textContent = `All days together, nuclear left out. ${rows.length} unit${rows.length === 1 ? "" : "s"} ran above minimum in at least one hour with lambda below ${fmtPrice0(thr)}; the top 30 by energy above minimum are listed. Cogeneration and units carrying ancillary services are likely here. Click a row to see the unit.`;
  $("cheap-units").innerHTML = rows.length ? unitRows(rows.slice(0, 30), [
    { h: "Unit", t: 1, f: (r) => esc(r.unit) }, { h: "Technology", t: 1, f: (r) => techLabel(r.tech) },
    { h: `Hours running below ${fmtPrice0(thr)}`, f: (r) => r.run }, { h: "Hours above minimum", f: (r) => r.above },
    { h: "Share", f: (r) => fmtPct(r.above / r.run) }, { h: "Avg MW above minimum", f: (r) => fmtMW(r.mwh / r.above) },
    { h: "MWh above minimum", f: (r) => fmtMW(r.mwh) },
  ]) : `<p class="empty">No units ran above minimum in those hours.</p>`;
}

// ---- intraday: shutdowns and two-shifting ------------------------------------------
function drawShut() {
  const I = S.I, el = $("shut-chart");
  if (!I) return emptyMsg(el, "Fills in after the data update builds the intraday file.");
  const ts = techsOf(S.shutTech), s = S.shutTech === "all" ? ALL_THERMAL : TECHS.find((x) => x.id === S.shutTech);
  const thr = S.shutPrice === "any" ? null : +S.shutPrice;
  // spells: [unit, tech, date, "HH:MM", hours off, lambda first 4 h, lambda while off, outage]
  const sp = I.spells.filter((r) => ts.includes(r[1]) && !r[7] && !(r[4] != null && r[4] < 1) && (thr == null || (r[5] != null && r[5] < thr)));
  const di = new Map(I.dates.map((d, i) => [d, i]));
  const two = I.dates.map(() => 0), long = I.dates.map(() => 0);
  sp.forEach((r) => { const i = di.get(r[2]); if (i == null) return; (r[4] != null && r[4] < 24 ? two : long)[i]++; });
  const has = I.dates.map((_, i) => I.tech[ts[0]].n[i] != null);
  const series = [
    { label: "Back online within 24 hours (two-shifting)", color: s.color, values: two.map((v, i) => (has[i] ? v : null)) },
    { label: "Off longer, or not back before the data ends", color: s.color, opacity: 0.4, values: long.map((v, i) => (has[i] ? v : null)) },
  ];
  $("shut-legend").innerHTML = series.map((x) => `<span><span class="sw" style="background:var(${x.color});opacity:${x.opacity || 1}"></span>${x.label}</span>`).join("");
  const priceTxt = thr == null ? "" : ` where system lambda averaged below ${fmtPrice0(thr)} over the ${I.next_h} hours after the unit went off`;
  $("shut-note").textContent = `Each bar counts ${s.label.toLowerCase()} units that went from online to off on that day${priceTxt}. Units that went on outage while off are left out, as are spells shorter than an hour (mostly combined-cycle configuration changes). The lower chart shows, for the units back within 24 hours, the hours of the day they were off, as an average number of units per day, with the average lambda for each hour across all days as a dashed line (right axis).`;
  dayBars(el, I.dates, series, { title: `${s.label}: shutdowns per day`, yFmt: d3.format(",.0f") });
  // hour-of-day profile of short spells
  const off = new Array(24).fill(0);
  const short = sp.filter((r) => r[4] != null && r[4] < 24);
  short.forEach((r) => {
    const [hh, mm] = r[3].split(":").map(Number), start = hh * 60 + mm;
    for (let t = 0; t < r[4] * 60; t += 60) off[Math.floor(((start + t) % 1440) / 60)] += 1;
  });
  const nd = has.filter(Boolean).length || 1;
  const lamH = d3.range(24).map((h) => d3.mean(I.lambda, (L) => L[h]));
  drawHourProfile($("shut-hours"), off.map((v) => v / nd), lamH, s,
    `${s.label}: units off in a two-shift, by hour (avg per day)`);
  // table by unit
  const rows = d3.rollups(sp, (g) => ({ unit: g[0][0], tech: g[0][1], n: g.length, two: g.filter((r) => r[4] != null && r[4] < 24).length,
    off: d3.median(g.filter((r) => r[4] != null), (r) => r[4]), l4: d3.median(g, (r) => r[5]), lo: d3.median(g, (r) => r[6]) }), (r) => r[0])
    .map(([, v]) => v).sort((a, b) => b.n - a.n);
  $("shut-units").innerHTML = rows.length ? unitRows(rows.slice(0, 30), [
    { h: "Unit", t: 1, f: (r) => esc(r.unit) }, { h: "Technology", t: 1, f: (r) => techLabel(r.tech) },
    { h: "Shutdowns", f: (r) => r.n }, { h: "Back within 24 h", f: (r) => r.two },
    { h: "Median hours off", f: (r) => (r.off == null ? "–" : d3.format(",.1f")(r.off)) },
    { h: `Median lambda, first ${I.next_h} h off`, f: (r) => fmtPrice(r.l4) }, { h: "Median lambda while off", f: (r) => fmtPrice(r.lo) },
  ]) : `<p class="empty">No shutdowns match.</p>`;
}

// ---- cheap stretches: who turns off ------------------------------------------------
// From the hourly unit strips. A combined-cycle train is registered as one resource per
// configuration (only one online at a time), so configurations are merged into their train:
// in each hour the train takes the "most running" state of its configurations.
const ST_LEAD = 6;                       // hours before a stretch a unit must already be running
const ST_RESP = [
  { id: "B", label: `Turned off in the ${ST_LEAD} h before`, color: "--c8", o: 1 },
  { id: "D", label: "Turned off during the stretch", color: "--c8", o: 0.45 },
  { id: "M", label: "Ran at minimum", color: null, o: 0.4 },
  { id: "A", label: "Ran above minimum", color: null, o: 1 },
];
const ST_GROUPS = [
  { id: "never", label: "Never shut down", note: "no shutdown in the period" },
  { id: "rare", label: "Shuts down, no two-shifts", note: "shut down, but never back within 24 h" },
  { id: "some", label: "Two-shifts 1–2 times", note: "off and back within 24 h once or twice" },
  { id: "cycler", label: "Two-shifts 3+ times", note: "off and back within 24 h at least 3 times" },
];
const ST_FLEET = [...ST_RESP, { id: "N", label: "Not running going in", color: "--grid", o: 1 }];
const ST_RANK = { a: 4, m: 3, "0": 2, o: 1, "-": 0 };
const trainOf = (u) => { const m = /^(.*_CC\d+)_/.exec(u); return m ? m[1] : u; };

function stretchBase() {
  if (S.stBase) return S.stBase;
  const UH = S.UH, I = S.I, info = new Map(S.T.units.map((u) => [u.unit, u]));
  const dstr = UH.dates, day0 = parseDate(dstr[0]);
  const dayNo = dstr.map((d) => Math.round((parseDate(d) - day0) / 864e5)), N = (dayNo.at(-1) + 1) * 24;
  const lam = new Float64Array(N).fill(NaN), li = new Map(I.dates.map((d, i) => [d, i]));
  dstr.forEach((d, i) => { const L = I.lambda[li.get(d)]; if (L) L.forEach((v, h) => { if (v != null) lam[dayNo[i] * 24 + h] = v; }); });
  // merged hourly state per unit (train for combined cycles)
  const units = new Map();
  for (const [name, str] of Object.entries(UH.units)) {
    const u = info.get(name);
    if (!u || u.tech === "nuclear") continue;
    const key = u.tech === "combined_cycle" ? trainOf(name) : name;
    let e = units.get(key);
    if (!e) { e = { unit: key, tech: u.tech, st: new Array(N).fill("-"), configs: [], mw: 0 }; units.set(key, e); }
    let run = 0;
    dstr.forEach((_, i) => { for (let h = 0; h < 24; h++) {
      const c = str[i * 24 + h] || "-", k = dayNo[i] * 24 + h;
      if (ST_RANK[c] > ST_RANK[e.st[k]]) e.st[k] = c;
      if (c === "m" || c === "a") run++;
    } });
    e.configs.push({ name, run });
    e.mw = Math.max(e.mw, (UH.hsl || {})[name] || 0);
  }
  // off spells: offline hours between two running hours, with no outage or missing data.
  // A single offline hour inside a combined-cycle train is a configuration change, not a shutdown.
  for (const e of units.values()) {
    const st = e.st; e.off = []; e.shut = 0;
    if (e.tech === "combined_cycle") for (let k = 1; k < N - 1; k++)
      if (st[k] === "0" && "ma".includes(st[k - 1]) && "ma".includes(st[k + 1])) st[k] = "m";
    let k = 0;
    while (k < N) {
      if (st[k] === "0" && k > 0 && (st[k - 1] === "m" || st[k - 1] === "a")) {
        let j = k, bad = false;
        while (j < N && (st[j] === "0" || st[j] === "o" || st[j] === "-")) { if (st[j] !== "0") bad = true; j++; }
        if (!bad || j === N) e.shut++;
        if (!bad && j < N) e.off.push(j - k);
        k = j;
      } else k++;
    }
    const two = e.off.filter((h) => h < 24).length;
    e.group = two >= 3 ? "cycler" : two > 0 ? "some" : e.shut > 0 ? "rare" : "never";
    e.pick = e.configs.sort((a, b) => b.run - a.run)[0].name;   // config shown in Unit detail
    e.ran = st.some((c) => c === "m" || c === "a");
    const o = e.off.slice().sort(d3.ascending);
    e.offMin = o.length ? o[0] : null; e.offP10 = o.length ? d3.quantile(o, 0.1) : null; e.offMed = o.length ? d3.median(o) : null;
  }
  return (S.stBase = { N, lam, units, day0 });
}

function stretchResponses(thr) {
  const B = stretchBase();
  B.resp = B.resp || {};
  if (B.resp[thr]) return B.resp[thr];
  const { N, lam } = B, eps = [];
  for (let k = 0; k < N;) {
    if (lam[k] < thr) { let j = k; while (j < N && lam[j] < thr) j++; eps.push([k, j]); k = j; } else k++;
  }
  const rows = [];
  for (const [a, b] of eps) {
    if (a < ST_LEAD) continue;
    for (const e of B.units.values()) {
      const st = e.st, s0 = st[a - ST_LEAD];
      if (s0 !== "m" && s0 !== "a") continue;
      let pre0 = false, dur0 = false, bad = false, na = 0;
      for (let k = a - ST_LEAD; k < b; k++) {
        const c = st[k];
        if (c === "o" || c === "-") { bad = true; break; }
        if (c === "0") (k < a ? (pre0 = true) : (dur0 = true));
        if (k >= a && c === "a") na++;
      }
      if (bad) continue;
      let run = 0;
      for (let k = a - ST_LEAD; k >= 0 && (st[k] === "m" || st[k] === "a"); k--) run++;
      rows.push({ unit: e.unit, tech: e.tech, group: e.group, mw: e.mw, a, len: b - a, run,
        r: pre0 ? "B" : dur0 ? "D" : na / (b - a) > 0.5 ? "A" : "M" });
    }
  }
  return (B.resp[thr] = { rows, n: eps.length });
}

// each bar is a group's whole fleet: every unit's capacity (HSL) split by what it did across
// all cheap stretches (including stretches it was not running into); share = the same / group MW
function fleetBars(el, groups, s, title) {
  const mw = S.stUnit === "mw", w = Math.max(280, el.clientWidth || 500), H = 262, m = { t: 22, r: 8, b: 60, l: mw ? 56 : 44 };
  const x = d3.scaleBand().domain(groups.map((g) => g.label)).range([m.l, w - m.r]).padding(w > 900 ? 0.45 : 0.22);
  const val = (g, id) => (mw ? g.mw[id] : g.total ? g.mw[id] / g.total : 0);
  const top = mw ? d3.max(groups, (g) => g.total) || 1 : 1;
  const y = d3.scaleLinear().domain([0, top]).nice().range([H - m.b, m.t]);
  const yFmt = mw ? d3.format(",.0f") : fmtPct;
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickFormat(yFmt).tickSizeOuter(0));
  // tick labels on two lines when they would collide
  const ax = svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickSizeOuter(0));
  ax.selectAll(".tick text").each(function (t) {
    if (t.length * 6.5 < x.step()) return;
    const sp = t.includes(", ") ? t.indexOf(", ") + 1 : t.lastIndexOf(" ", Math.ceil(t.length / 2) + 2);
    const el = d3.select(this).text(null);
    el.append("tspan").attr("x", 0).attr("dy", "0.71em").text(t.slice(0, sp).trim());
    el.append("tspan").attr("x", 0).attr("dy", "1.1em").text(t.slice(sp).trim());
  });
  const two = ax.selectAll(".tick text tspan").size() > 0;
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text(title);
  groups.forEach((g) => {
    svg.append("text").attr("class", "axis-title").attr("x", x(g.label) + x.bandwidth() / 2).attr("y", H - m.b + (two ? 42 : 30)).attr("text-anchor", "middle")
      .text(`${g.n} units · ${d3.format(",.0f")(g.total)} MW`);
    let y0 = 0;
    ST_FLEET.forEach((r) => {
      const v = val(g, r.id);
      svg.append("rect").attr("x", x(g.label)).attr("width", x.bandwidth()).attr("y", y(y0 + v)).attr("height", y(y0) - y(y0 + v))
        .attr("fill", css(r.color || s.color)).attr("fill-opacity", r.o)
        .on("pointermove", (ev) => showTip(ev, `<h4>${g.label}</h4>${r.label}: ${d3.format(",.0f")(g.mw[r.id])} MW (${fmtPct(g.total ? g.mw[r.id] / g.total : 0)} of the group's ${d3.format(",.0f")(g.total)} MW)`))
        .on("pointerleave", hideTip);
      y0 += v;
    });
  });
  el.replaceChildren(svg.node());
}

const ST_MIN_N = 5;                      // stretches needed before a unit's shares are shown
const ST_SORT = [
  { id: "off", label: "Share turned off", f: (a, b) => d3.descending(a.offShare ?? -1, b.offShare ?? -1) },
  { id: "p10", label: "Minimum hours off (10th pct)", f: (a, b) => d3.ascending(a.offP10 ?? 1e9, b.offP10 ?? 1e9) },
  { id: "n", label: "Stretches running into", f: (a, b) => d3.descending(a.n, b.n) },
];
async function drawStretch() {
  const el = $("st-group");
  if (!S.I) return emptyMsg(el, "Fills in after the data update builds the intraday file.");
  if (!S.UH) {
    el.innerHTML = `<p class="empty">Loading hourly data…</p>`;
    S.UH = (await tryJSON("data/unit_hours_60d.json.gz")) || { dates: [], units: {} };
  }
  if (!S.UH.dates.length) return emptyMsg(el, "No hourly data.");
  const thr = +S.stThr, ts = techsOf(S.stTech).filter((t) => t !== "nuclear");
  const s = S.stTech === "all" ? ALL_THERMAL : TECHS.find((x) => x.id === S.stTech);
  const { rows: all, n: nEps } = stretchResponses(thr), rows = all.filter((r) => ts.includes(r.tech));
  $("st-legend").innerHTML = ST_FLEET.map((r) => `<span><span class="sw" style="background:var(${r.color || s.color});opacity:${r.o}"></span>${r.label}</span>`).join("");
  const fmtD = d3.timeFormat("%b %-d, %Y"), period = `${fmtD(parseDate(S.UH.dates[0]))} to ${fmtD(parseDate(S.UH.dates.at(-1)))}`;
  const B = stretchBase(), by = d3.group(rows, (r) => r.unit);
  // units that never ran in the period (mothballed, long outage) are left out
  const fleet = [...B.units.values()].filter((e) => ts.includes(e.tech) && e.mw > 0 && e.ran);
  const groups = ST_GROUPS.map((g) => {
    const us = fleet.filter((e) => e.group === g.id), out = { label: g.label, n: us.length, total: d3.sum(us, (e) => e.mw), mw: {} };
    ST_FLEET.forEach((r) => (out.mw[r.id] = 0));
    us.forEach((e) => {
      const mine = by.get(e.unit) || [];
      ST_RESP.forEach((r) => (out.mw[r.id] += (e.mw * mine.filter((z) => z.r === r.id).length) / nEps));
      out.mw.N += (e.mw * (nEps - mine.length)) / nEps;
    });
    return out;
  });
  $("st-note").textContent = `A cheap stretch is a run of consecutive hours with system lambda below ${fmtPrice0(thr)}. There were ${nEps} from ${period}. ` +
    `Each bar is the total capacity (HSL) of one group of ${S.stTech === "all" ? "coal and gas" : s.label.toLowerCase()} units, grouped by how they ran over the whole period: ${ST_GROUPS.map((g) => `${g.label.toLowerCase()} (${g.note})`).join("; ")}. ` +
    `Each unit's capacity is split by what it did across the ${nEps} stretches: turned off in the ${ST_LEAD} hours before, turned off during, ran at minimum or above minimum (when it was already running ${ST_LEAD} hours before the stretch began), or not running going in (offline, on outage or no data). Units that never ran in the period are left out. ` +
    `Each combined-cycle train counts as one unit, so switching configuration is not a shutdown. Nuclear is left out. Lambda is the system price; a unit's own nodal price can differ.`;
  fleetBars(el, groups, s, S.stUnit === "mw" ? "Capacity of each group, MW, split by what it did in cheap stretches" : "Share of each group's capacity, by what it did in cheap stretches");
  // unit table
  const list = [...B.units.values()].filter((e) => ts.includes(e.tech) && (by.has(e.unit) || e.shut > 0)).map((e) => {
    const g = by.get(e.unit) || [], n = g.length, c = (id) => (n >= ST_MIN_N ? g.filter((r) => r.r === id).length / n : null);
    return { ...e, n, offShare: n >= ST_MIN_N ? c("B") + c("D") : null, minShare: c("M"), aboveShare: c("A") };
  }).sort(ST_SORT.find((x) => x.id === S.stSort).f);
  const gl = (id) => ST_GROUPS.find((g) => g.id === id).label, hrs = (v) => (v == null ? "–" : d3.format(",.0f")(v)), pc = (v) => (v == null ? "–" : fmtPct(v));
  $("st-units-note").textContent = `${list.length} units. "Stretches" counts the cheap stretches a unit was already running into; the next three columns say what it did in them (shown once a unit has at least ${ST_MIN_N}). ` +
    `"Shutdowns" and hours off cover every shutdown in the period, cheap or not, in whole hours, leaving out outages; for a combined-cycle train a single offline hour is taken as a configuration change. ` +
    `The 10th percentile of hours off is a steadier guide to a unit's real minimum down time than its single shortest spell, which can be a trip and quick restart. Click a unit to open its detail.`;
  const cols = [
    { h: "Unit", t: 1, f: (r) => esc(r.name) }, { h: "Technology", t: 1, f: (r) => techLabel(r.tech) }, { h: "Group", t: 1, f: (r) => gl(r.group) }, { h: "MW", f: (r) => d3.format(",.0f")(r.mw) },
    { h: "Stretches", f: (r) => r.n }, { h: "Turned off", f: (r) => pc(r.offShare) }, { h: "At min", f: (r) => pc(r.minShare) }, { h: "Above min", f: (r) => pc(r.aboveShare) },
    { h: "Shutdowns", f: (r) => r.shut }, { h: "Shortest off (h)", f: (r) => hrs(r.offMin) }, { h: "Min off, 10th pct (h)", f: (r) => hrs(r.offP10) }, { h: "Median off (h)", f: (r) => hrs(r.offMed) },
  ];
  $("st-units").innerHTML = list.length ? unitRows(list.map((r) => ({ ...r, name: r.unit, unit: r.pick })), cols)
    : `<p class="empty">No units match.</p>`;
  setCSV(el, ["unit", "technology", "group", "stretches_running_into", "share_turned_off", "share_at_minimum", "share_above_minimum", "shutdowns", "shortest_hours_off", "p10_hours_off", "median_hours_off", "mw"],
    list.map((r) => [r.unit, r.tech, r.group, r.n, r.offShare, r.minShare, r.aboveShare, r.shut, r.offMin, r.offP10, r.offMed, r.mw]), `Cheap stretches, lambda below ${thr}`);
  if (S.unit && S.T.units.find((u) => u.unit === S.unit) && !$("unit-detail").hidden) {
    const u = S.T.units.find((x) => x.unit === S.unit); drawUnitStretch(u, TECHS.find((x) => x.id === u.tech), S.stripScale);
  }
}

// under the unit strip: one mark per cheap stretch the unit (or its train) ran into
function drawUnitStretch(u, s, sc) {
  const el = $("unit-stretch");
  S.stripScale = sc;
  if (!sc || !S.I || !S.UH || u.tech === "nuclear") { el.replaceChildren(); return; }
  const thr = +S.stThr, key = u.tech === "combined_cycle" ? trainOf(u.unit) : u.unit;
  const { rows } = stretchResponses(thr), mine = rows.filter((r) => r.unit === key), B = stretchBase();
  const { x, w, m } = sc, H = 74, top = 22;
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  const e = B.units.get(key), cnt = d3.rollup(mine, (g) => g.length, (r) => r.r);
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 12)
    .text(`${key === u.unit ? "" : `Train ${key} · `}ran into ${mine.length} cheap stretch${mine.length === 1 ? "" : "es"} below ${fmtPrice0(thr)}` +
      (mine.length ? " · " + ST_RESP.map((r) => `${r.label.toLowerCase()} ${cnt.get(r.id) || 0}`).join(", ") : "") + (e ? ` · ${ST_GROUPS.find((g) => g.id === e.group).label.toLowerCase()}` : ""));
  const t0 = B.day0.getTime() - 12 * 3600e3;    // day0 is noon
  const xt = (k) => x(new Date(t0 + k * 3600e3));
  svg.append("line").attr("x1", m.l).attr("x2", w - m.r).attr("y1", top + 20).attr("y2", top + 20).attr("stroke", css("--grid"));
  mine.forEach((r) => {
    const rr = ST_RESP.find((z) => z.id === r.r), x0 = xt(r.a), x1 = Math.max(x0 + 3, xt(r.a + r.len));
    svg.append("rect").attr("x", x0).attr("y", top + 4).attr("width", x1 - x0).attr("height", 32).attr("fill", css(rr.color || s.color)).attr("fill-opacity", rr.o)
      .on("pointermove", (ev) => showTip(ev, `<h4>${fmtDate(new Date(t0 + r.a * 3600e3))} · from HE ${(r.a % 24) + 1}</h4>${r.len} h below ${fmtPrice0(thr)}<br>${rr.label}<br>Running ${r.run} h before the ${ST_LEAD} h lead-in`))
      .on("pointerleave", hideTip);
  });
  el.replaceChildren(svg.node());
}

// bars by hour of day with the average lambda line on a right axis
function drawHourProfile(el, vals, lamH, s, title) {
  const w = Math.max(280, el.clientWidth || 600), H = 170, m = { t: 16, r: 52, b: 26, l: 64 };
  const x = d3.scaleBand().domain(d3.range(24)).range([m.l, w - m.r]).paddingInner(0.15);
  const y = d3.scaleLinear().domain([0, Math.max(0.1, d3.max(vals))]).nice().range([H - m.b, m.t]);
  const yl = d3.scaleLinear().domain([Math.min(0, d3.min(lamH)), d3.max(lamH)]).nice().range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickValues([0, 5, 11, 17, 23]).tickFormat((h) => `HE ${h + 1}`).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickFormat(d3.format(",.2~f")).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${w - m.r},0)`).call(d3.axisRight(yl).ticks(4).tickFormat(d3.format("$,.0f")).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text(title);
  svg.append("g").selectAll("rect").data(vals).join("rect").attr("x", (_, h) => x(h)).attr("width", x.bandwidth())
    .attr("y", (v) => y(v)).attr("height", (v) => y(0) - y(v)).attr("fill", css(s.color));
  svg.append("path").attr("fill", "none").attr("stroke", css("--ink")).attr("stroke-width", 1.5).attr("stroke-dasharray", "4 3")
    .attr("d", d3.line().x((_, h) => x(h) + x.bandwidth() / 2).y((v) => yl(v))(lamH));
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const h = Math.max(0, Math.min(23, Math.floor((d3.pointer(ev)[0] - m.l) / x.step())));
      showTip(ev, `<h4>HE ${h + 1}</h4>${d3.format(",.2f")(vals[h])} units off per day<br>Average lambda ${fmtPrice(lamH[h])}`);
    })
    .on("pointerleave", hideTip);
  el.replaceChildren(svg.node());
  setCSV(el, ["hour_ending", "units_off_per_day", "avg_lambda"], vals.map((v, h) => [h + 1, v, lamH[h]]), title);
}

// ---- across days: day × hour heatmap -----------------------------------------------
const HEAT_MEASURES = [
  { id: "offer", label: "MW offered at or below a price" },
  { id: "running", label: "Thermal output (MW)" },
  { id: "above", label: "Thermal output above minimum (MW)" },
  { id: "lambda", label: "System lambda" },
];
async function drawHeat() {
  const el = $("heatmap"), scaleEl = $("heat-scale"), I = S.I, meas = S.heatMeasure;
  const offer = meas === "offer", thermal = meas === "running" || meas === "above";
  $("heat-thr").hidden = $("heat-thr-lbl").hidden = !offer;
  $("heat-scale-mode").hidden = meas === "lambda";
  $("heat-tech").hidden = $("heat-tech-lbl").hidden = meas === "lambda";
  const techOpts = offer ? [...TECHS.filter((t) => t.id !== "other"), { id: "storage", keys: ["storage"], label: "Storage (ESR)", color: "--c7" }, TECHS.find((t) => t.id === "other")]
    : [ALL_THERMAL, ...TECHS.filter((t) => THERMAL.includes(t.id))];
  bindSelect("heat-tech", "heatTech", techOpts, drawHeat);
  let dstr, val;
  if (offer) {
    if (!S.summ60) {
      el.innerHTML = `<p class="empty">Loading offer summaries…</p>`;
      [S.idx, S.summ60] = await Promise.all([tryJSON("data/index.json"), tryJSON("data/summary_60d.json.gz")]);
      S.summ60 = S.summ60 || {};
      if (S.heatMeasure !== "offer") return;
    }
    const th = (S.idx && S.idx.thresholds) || [0];
    bindSelect("heat-thr", "heatThr", th.map((t) => ({ id: String(t), label: t === -249 ? "Price floor (−$250)" : fmtPrice0(t) })), drawHeat);
    const ti = th.indexOf(+S.heatThr), s = techOpts.find((t) => t.id === S.heatTech);
    dstr = Object.keys(S.summ60).sort();
    val = (i, h) => {
      const c = S.summ60[dstr[i]] && S.summ60[dstr[i]].curves;
      if (!c) return null;
      const parts = s.keys.map((k) => c[k] && c[k][h] && c[k][h][ti]).filter((v) => v != null);
      return parts.length ? d3.sum(parts) : null;
    };
    $("heat-note").textContent = `MW of ${s.label.toLowerCase()} offered at or below ${+S.heatThr === -249 ? "the price floor" : fmtPrice0(+S.heatThr)} in each hour, from the 60-day curves as used in SCED. Click a cell to open that day and hour in the Day view.`;
  } else {
    if (!I) return emptyMsg(el, "Fills in after the data update builds the intraday file.");
    dstr = I.dates;
    const ts = techsOf(S.heatTech), s = S.heatTech === "all" ? ALL_THERMAL : TECHS.find((x) => x.id === S.heatTech);
    if (meas === "lambda") val = (i, h) => I.lambda[i][h];
    else val = (i, h) => (I.tech[ts[0]].n[i] ? d3.sum(ts, (t) => I.tech[t].above[i][h] + (meas === "running" ? I.tech[t].at_min[i][h] : 0)) : null);
    $("heat-note").textContent = meas === "lambda" ? "Hourly system lambda. Negative hours are red. Click a cell to open that day and hour in the Day view."
      : `${meas === "running" ? "Output" : "Output above minimum (LSL)"} of running ${s.label.toLowerCase()} units, from the 60-day disclosure. Click a cell to open that day and hour in the Day view.`;
  }
  const cells = [];
  dstr.forEach((d, i) => { for (let h = 0; h < 24; h++) { const v = val(i, h); if (v != null) cells.push({ d, h, v }); } });
  if (!cells.length) { emptyMsg(el, "No data."); scaleEl.innerHTML = ""; return; }
  const cw = Math.max(4, Math.min(36, ((el.clientWidth || 600) - 70) / dstr.length)), chh = 10;
  const m = { t: 8, r: 8, b: 44, l: 52 };
  const w = Math.max(el.clientWidth || 300, m.l + m.r + cw * dstr.length), H = m.t + m.b + chh * 24;
  const x = d3.scaleBand().domain(dstr).range([m.l, m.l + cw * dstr.length]).paddingInner(cw > 6 ? 0.08 : 0);
  const y = d3.scaleBand().domain(d3.range(24)).range([m.t, m.t + chh * 24]).paddingInner(0.08);
  let color, lo, hi;
  const vs = cells.map((c) => c.v).sort(d3.ascending);
  if (meas === "lambda") {
    lo = Math.min(-1, vs[0]); hi = Math.max(1, d3.quantile(vs, 0.98));
    const pos = d3.interpolateRgb(css("--seq-lo"), css("--seq-hi")), neg = d3.interpolateRgb(css("--seq-lo"), css("--c8"));
    color = (v) => (v < 0 ? neg(Math.min(1, v / lo)) : pos(Math.min(1, v / hi)));
  } else {
    // MW scales start at zero, so the color shows each hour's size and not just its rank;
    // "Fit to data" stretches the scale over the observed range to bring out small differences
    lo = S.heatScale === "fit" ? vs[0] : Math.min(0, vs[0]); hi = vs.at(-1); if (lo === hi) hi = lo + 1;
    color = d3.scaleSequential(d3.interpolateRgb(css("--seq-lo"), css("--seq-hi"))).domain([lo, hi]);
  }
  const fmtV = meas === "lambda" ? fmtPrice : (v) => `${fmtMW(v)} MW`;
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`).style("width", w + "px").style("max-width", "none").attr("data-nopin", "");
  svg.append("g").selectAll("rect").data(cells).join("rect")
    .attr("x", (c) => x(c.d)).attr("y", (c) => y(c.h)).attr("width", x.bandwidth()).attr("height", y.bandwidth()).attr("rx", cw > 6 ? 2 : 0)
    .attr("fill", (c) => color(c.v)).style("cursor", "pointer")
    .on("pointermove", (ev, c) => showTip(ev, `<h4>${fmtDate(parseDate(c.d))} · HE ${c.h + 1}</h4><b>${fmtV(c.v)}</b><br><span class="tip-pin-note">Click to open in the Day view</span>`))
    .on("pointerleave", hideTip)
    .on("click", (ev, c) => { location.href = `index.html#date=${c.d}&he=${c.h + 1}`; });
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l - 2},0)`)
    .call(d3.axisLeft(y).tickValues([0, 5, 11, 17, 23]).tickFormat((h) => `HE ${h + 1}`).tickSize(0)).select(".domain").remove();
  const every = Math.ceil(dstr.length / Math.max(1, Math.floor((cw * dstr.length) / 70)));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${m.t + chh * 24 + 2})`)
    .call(d3.axisBottom(x).tickValues(dstr.filter((d, i) => i % every === 0)).tickFormat((d) => d3.timeFormat("%b %-d")(parseDate(d))).tickSize(0))
    .select(".domain").remove();
  el.replaceChildren(svg.node());
  setCSV(el, ["date", "hour_ending", HEAT_MEASURES.find((q) => q.id === meas).label], cells.map((c) => [c.d, c.h + 1, c.v]), "Across days");
  const ramp = meas === "lambda" ? `${css("--c8")},${css("--seq-lo")} ${(100 * -lo / (hi - lo)).toFixed(0)}%,${css("--seq-hi")}` : `${css("--seq-lo")},${css("--seq-hi")}`;
  scaleEl.innerHTML = `<span>${fmtV(lo)}</span><span class="ramp" style="background:linear-gradient(90deg,${ramp})"></span><span>${fmtV(hi)}${meas === "lambda" ? " (98th pct.)" : ""}</span>` +
    (meas !== "lambda" && S.heatScale === "fit" ? `<span>Scale fitted to the data: small differences look large</span>` : "");
}

// ---- links ------------------------------------------------------------------------
const VIEW_KEYS = { stu: "stUnit", stt: "stTech", stp: "stThr", sts: "stSort", cht: "cheapTech", chthr: "cheapThr", sht: "shutTech", shp: "shutPrice", hm: "heatMeasure", ht: "heatTech", hthr: "heatThr", hs: "heatScale", f: "floorMode", pq: "pqTech", cap: "capTech", sc: "scTech", scx: "scX", ms: "mSrc", mv: "mView", md: "mDays", ct: "chgTech", cs: "chgSig", unit: "unit" };
function saveView() { window.CX.writeHash(Object.fromEntries(Object.entries(VIEW_KEYS).map(([k, sk]) => [k, S[sk]]))); }
function loadView() { const v = window.CX.readHash(); Object.entries(VIEW_KEYS).forEach(([k, sk]) => { if (v[k] != null) S[sk] = v[k]; }); }

// ---- boot ---------------------------------------------------------------------------
function drawAll() { drawFloor(); drawRenewBands(); drawCurtailment(); drawPriceQuantiles(); drawCapacity(); drawScatter(); drawPartial(); drawCheap(); drawShut(); drawStretch(); if (heatSeen) drawHeat(); drawMarginal(); drawChanges(); }
let heatSeen = false;

async function boot() {
  [S.T, S.C, S.I] = await Promise.all([tryJSON("data/trends_60d.json.gz"), tryJSON("data/curve_trends.json.gz"), tryJSON("data/intraday_60d.json.gz")]);
  if (!S.T) { $("status").textContent = "No trends data yet. It is built by the data update workflow."; return; }
  const D = S.T.dates;
  $("status").textContent = `60-day data: ${D.length} days, ${D[0]} to ${D[D.length - 1]} · ${S.T.units.length} thermal units` +
    (S.C ? ` · wind and solar offers through ${S.C.rs.dates.at(-1)}` : "");
  loadView();
  const thermal = TECHS.filter((s) => THERMAL.includes(s.id));
  [["floor-mode", "floorMode", drawFloor], ["sc-x", "scX", drawScatter], ["mbp-src", "mSrc", drawMarginal], ["mbp-view", "mView", drawMarginal], ["mbp-days", "mDays", drawMarginal]]
    .forEach(([id, key, fn]) => { setSeg(id, S[key]); bindSeg(id, key, fn); });
  legend($("floor-legend"), FLOOR_TECHS, S.hidden.floor, drawFloor);
  legend($("partial-legend"), thermal, S.hidden.partial, drawPartial);
  staticLegend($("rs-legend"), BANDS);
  bindSelect("pq-tech", "pqTech", thermal.filter((s) => s.id !== "nuclear"), drawPriceQuantiles);
  bindSelect("cap-tech", "capTech", thermal, drawCapacity);
  bindSelect("sc-tech", "scTech", thermal, drawScatter);
  bindSelect("chg-tech", "chgTech", [{ id: "all", label: "All" }, ...thermal], drawChanges);
  bindSelect("chg-sig", "chgSig", [{ id: "all", label: "All" }, ...Object.entries(S.T.signals).map(([id, label]) => ({ id, label }))], drawChanges);
  [["cheap-thr", "cheapThr", drawCheap], ["shut-price", "shutPrice", drawShut], ["heat-scale-mode", "heatScale", drawHeat]].forEach(([id, key, fn]) => { setSeg(id, S[key]); bindSeg(id, key, fn); });
  bindSelect("cheap-tech", "cheapTech", [ALL_THERMAL, ...thermal], drawCheap);
  bindSelect("shut-tech", "shutTech", [ALL_THERMAL, ...thermal], drawShut);
  bindSelect("st-tech", "stTech", [ALL_THERMAL, ...thermal.filter((t) => t.id !== "nuclear")], drawStretch);
  bindSelect("st-sort", "stSort", ST_SORT, drawStretch);
  setSeg("st-thr", S.stThr); bindSeg("st-thr", "stThr", drawStretch);
  setSeg("st-unit", S.stUnit); bindSeg("st-unit", "stUnit", drawStretch);
  bindSelect("heat-measure", "heatMeasure", HEAT_MEASURES, drawHeat);
  // the offer summaries are large: draw the heatmap once it is about to scroll into view
  new IntersectionObserver((es, ob) => { if (es.some((e) => e.isIntersecting)) { heatSeen = true; drawHeat(); ob.disconnect(); } }, { rootMargin: "400px" })
    .observe($("heatmap"));
  $("unit-list").innerHTML = S.T.units.map((u) => `<option value="${esc(u.unit)}">${techLabel(u.tech)}</option>`).join("");
  $("unit-pick").addEventListener("change", (e) => showUnit(e.target.value.trim()));
  $("unit-pick").addEventListener("input", (e) => { if (S.T.units.some((u) => u.unit === e.target.value)) showUnit(e.target.value); });
  ["chg-table", "flip-table", "cheap-units", "shut-units", "st-units"].forEach((id) => $(id).addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-unit]");
    if (tr) showUnit(tr.dataset.unit);
  }));
  drawAll();
  saveView();
  window.CX.init();
  let t, lastW = 0;
  new ResizeObserver((e) => { const w = Math.round(e[0].contentRect.width); if (w === lastW) return; lastW = w; clearTimeout(t); t = setTimeout(drawAll, 120); }).observe(document.querySelector("main"));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", drawAll);
}
boot();
})();

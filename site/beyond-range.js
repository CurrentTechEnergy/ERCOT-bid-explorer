/* Beyond baseload, across days: offers against fuel (thermal offer-price quantiles, gas hubs and
   implied heat rate), marginal supply by settled price, marginality at the node and changes in
   bidding approach, lifted from trends.js. Reads data/trends_60d.json.gz, data/curve_trends.json.gz,
   data/gas.json.gz, data/gas_hubs.json.gz, data/marginal_*.json.gz, data/marginal_nodes.json.gz and
   data/summary_prices.json.gz.
   The one-day panels on the same page are beyond-day.js, which also owns the status line and the
   shared chart controls (CX.init). */
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
  le20_sced: "MW priced at or below −$20 in the curves SCED dispatched against, hour by hour. In those curves ERCOT fills in prices a unit didn't offer. Units that offer have the MW below their first offered point, usually minimum output, at −$20 (−$50 for some units). Units with no offer curve sit at −$250 with the rest of their output schedule at −$249.99 if they are nuclear or hydro, and at −$20 or −$50 otherwise. This counts all of that, plus anything generators themselves offered at or below −$20. Storage below zero is charging bid at or below −$20.",
  floor_sced: "MW priced at the −$250 floor (or −$249.99) in the curves SCED dispatched against, hour by hour. ERCOT puts only units with no offer curve there, mostly nuclear and hydro. Minimum output of units that offer sits at −$20 (−$50 for some units), so it is counted under ≤ −$20, as used, not here. Storage below zero is charging bid at the floor.",
  floor_submitted: "MW the generators themselves priced at the −$250 floor in the offer curves they submitted, hour by hour.",
  le0_sub_lsl: "MW above minimum output (LSL) that the generators themselves priced at or below $0 in the offer curves they submitted, averaged over each hour's SCED runs. Thermal technologies only. Minimum output is left out because SCED cannot dispatch below it: many curves start at 0 MW at −$250 and climb to the unit's real price, which puts MW at or below $0 by interpolation, all of it below LSL.",
};
// floor chart grouped by shutdown behaviour: nuclear on its own (no offer curve, never moves),
// the other thermal units by the groups of the cheap-stretches panel (ST_GROUPS, from the
// hourly unit strips). Only the "≤ −$20, as used" measure has per-unit values (units[i].le20).
const FLOOR_GROUPS = [
  { id: "nuclear", label: "Nuclear (no offer curve)", color: "--c5" },
  { id: "never", label: "Never off", color: "--c1" },
  { id: "seasonal", label: "Seasonal: off a week or more", color: "--c6" },
  { id: "multiday", label: "Multi-day: off 1–7 days", color: "--c2" },
  { id: "daily1", label: "Daily, under 1 shutdown a week", color: "--c8" },
  { id: "daily2", label: "Daily, 1–2 a week", color: "--c3" },
  { id: "daily3", label: "Daily, over 2 a week", color: "--c4" },
];
const FLOOR_GROUP_NOTE = "MW priced at or below −$20 in the curves SCED dispatched against, summed over thermal units grouped by how they ran over the whole period (the groups of the cheap-stretches panel below; nuclear separately, since it has no offer curve and its whole output sits at the floor). For units that offer, this is almost entirely minimum output (LSL) at ERCOT's placeholder price, so the chart tracks how much minimum load is committed: day-to-day movement is which units are online: the daily groups drive the day-to-day swing and the seasonal group the slow one. Storage, hydro and other resources are left out. Each unit's MW at or below −$20 is its average over the runs it was online that day, counted in the hours it ran.";
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

const S = { T: null, C: null, M: {}, floorMode: "le20_sced", floorGroup: "tech", floorHours: "all", hidden: { floor: new Set(), floorG: new Set(), partial: new Set() },
  pqTech: "coal", capTech: "coal", scTech: "coal", scX: "week", mSrc: "60d", mView: "smooth", mDays: "all",
  chgTech: "all", chgSig: "all", unit: null, mnMeasure: "units", mnDays: "all",
  I: null, UH: null, idx: null, summ60: null, cheapTech: "all", cheapThr: "0", shutTech: "combined_cycle", shutPrice: "any",
  heatMeasure: "offer", heatTech: "combined_cycle", heatThr: "0", heatScale: "zero", HC: null, leanRank: "fossil", leanMonth: "all", leanPer: "day",
  stTech: "all", stThr: "0", stSort: "off", stUnit: "mw", stBase: null, stripScale: null };
const { getJSON, tryJSON, showTip, hideTip, setCSV, tickFormat, fmtKind, axisFmt } = window.CX;
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

const techLabel = (t) => TECHS.find((x) => x.id === t)?.label || t;
const HOUR_MS = 36e5;
const hourTime = (d, h) => new Date(parseDate(d).getTime() + (h - 11.5) * HOUR_MS);   // middle of hour ending h + 1
const heLabel = (h) => `HE ${String(h + 1).padStart(2, "0")}`;

// ---- shared date range --------------------------------------------------------------
// S.span: first and last day of any daily series on the page (set in init). Every daily chart
// uses the same x scale, padded half a day each side so the end days (and bars) sit fully inside.
function dateX(w, m) {
  const a = parseDate(S.span[0]), b = parseDate(S.span[1]);
  return d3.scaleTime().domain([d3.timeHour.offset(a, -12), d3.timeHour.offset(b, 12)]).range([m.l, w - m.r]);
}
// bottom date axis, plus a light band over the days after the last 60-day report
function dateAxis(svg, x, w, H, m) {
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(w < 560 ? 4 : 8).tickSizeOuter(0));
  if (!S.last60 || S.last60 >= S.span[1]) return;
  const x0 = x(d3.timeHour.offset(parseDate(S.last60), 12)), x1 = w - m.r;
  svg.insert("rect", ":first-child").attr("class", "no60").attr("x", x0).attr("y", m.t).attr("width", x1 - x0).attr("height", H - m.t - m.b)
    .attr("fill", css("--grid")).attr("fill-opacity", 0.35);
  if (x1 - x0 > 70) svg.append("text").attr("class", "axis-title").attr("x", x1 - 4).attr("y", m.t + 10).attr("text-anchor", "end").text("No 60-day data yet");
}

// ---- time-series chart with hover crosshair ---------------------------------------
// series: [{ label, color, values, dash?, width?, opacity? }]
// opts: { title, yFmt, tipFmt, H, markers, dots, dates (defaults to the 60-day dates), stack (100% areas), yScale,
//         hourly (values are one per hour of each date: dates.length * 24) }
// Every chart shares the page's date range (dateX); days outside it are dropped.
function timeChart(el, series, opts) {
  let dstr = opts.dates || S.T.dates;
  const per = opts.hourly ? 24 : 1;
  const keep = dstr.map((d) => d >= S.span[0] && d <= S.span[1]);
  if (keep.includes(false)) {
    dstr = dstr.filter((_, i) => keep[i]);
    series = series.map((s) => ({ ...s, values: s.values.filter((_, i) => keep[Math.floor(i / per)]) }));
  }
  const dates = opts.hourly ? dstr.flatMap((d) => d3.range(24).map((h) => hourTime(d, h))) : dstr.map(parseDate);
  const w = Math.max(280, el.clientWidth || 600);
  const H = opts.H || 260, m = { t: 16, r: 16, b: 26, l: 64 };
  const x = dateX(w, m);
  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  if (!all.length) return emptyMsg(el, opts.empty || "No data.");
  let y;
  if (opts.stack) y = d3.scaleLinear().domain([0, opts.stackMax || 1]).range([H - m.b, m.t]);
  else if (opts.yScale === "symlog") y = d3.scaleSymlog().constant(10).domain([Math.min(0, d3.min(all)), d3.max(all)]).range([H - m.b, m.t]);
  else y = d3.scaleLinear().domain([Math.min(0, d3.min(all)), Math.max(opts.yMin || 1, d3.max(all))]).nice().range([H - m.b, m.t]);
  const yTicks = opts.yTicks ? opts.yTicks.filter((v) => v >= y.domain()[0] && v <= y.domain()[1]) : y.ticks(5);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  const yAxis = () => d3.axisLeft(y).tickValues(yTicks);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(yAxis().tickSize(-(w - m.l - m.r)).tickFormat(""));
  dateAxis(svg, x, w, H, m);
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(yAxis().tickFormat(tickFormat(yTicks, fmtKind(opts.yFmt))).tickSizeOuter(0));
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
    series.forEach((s) => svg.append("path").attr("fill", "none").attr("stroke", css(s.color)).attr("stroke-width", s.width || (opts.hourly ? 1 : 2))
      .attr("stroke-opacity", s.opacity ?? null).attr("stroke-dasharray", s.dash || null).attr("d", line(s.values)));
    // single points between gaps draw no line segment, so mark every point when asked (hourly
    // charts mark the lone hours)
    if (opts.dots || opts.hourly) series.forEach((s) => {
      const lone = s.values.map((v, i) => [v, i]).filter(([v, i]) => v != null && (opts.dots || (s.values[i - 1] == null && s.values[i + 1] == null)));
      svg.append("g").selectAll("circle").data(lone).join("circle").attr("cx", ([, i]) => x(dates[i])).attr("cy", ([v]) => y(v))
        .attr("r", opts.hourly ? 1.2 : 2).attr("fill", css(s.color));
    });
  }
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", H - m.b).style("display", "none");
  const tf = opts.tipFmt || opts.yFmt || fmtMW;
  const when = (i) => opts.hourly ? `${fmtDate(parseDate(dstr[Math.floor(i / 24)]))} · ${heLabel(i % 24)}` : fmtDate(dates[i]);
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const t = x.invert(d3.pointer(ev)[0]);
      const i = d3.minIndex(dates, (d) => Math.abs(d - t));
      cross.style("display", null).attr("x1", x(dates[i])).attr("x2", x(dates[i]));
      const rows = series.filter((s) => s.values[i] != null);
      if (!opts.stack) rows.sort((a, b) => b.values[i] - a.values[i]);
      showTip(ev, `<h4>${when(i)}${opts.tipNote ? opts.tipNote(i) : ""}</h4><table>` + (opts.stack ? [...rows].reverse() : rows).map((s) =>
        `<tr><td><span class="sw" style="background:var(${s.color})"></span></td><td>${s.label}</td><td class="n">${tf(s.values[i])}</td></tr>`).join("") + "</table>");
    })
    .on("pointerleave", () => { cross.style("display", "none"); hideTip(); });
  el.replaceChildren(svg.node());
  if (opts.hourly) setCSV(el, ["date", "hour_ending", ...series.map((s) => s.label)], dates.map((_, i) => [dstr[Math.floor(i / 24)], i % 24 + 1, ...series.map((s) => s.values[i])]), opts.title);
  else setCSV(el, ["date", ...series.map((s) => s.label)], dstr.map((d, i) => [d, ...series.map((s) => s.values[i])]), opts.title);
}

// ---- natural gas ----------------------------------------------------------------------
// Henry Hub from the EIA (gas.json.gz); Houston Ship Channel and Waha from OilPriceAPI (gas_hubs.json.gz)
const GAS_LINES = [
  { key: "hsc", label: "Houston Ship Channel", color: "--c1" },
  { key: "waha", label: "Waha", color: "--c3" },
  { key: "hh", label: "Henry Hub", color: "--c2", dash: "6 3" },
];
function gasSources() {
  const out = {};
  if (S.G && S.G.dates && S.G.dates.length) out.hh = { dates: S.G.dates, value: S.G.value };
  const H = (S.GH && S.GH.hubs) || {};
  Object.entries(H).forEach(([k, v]) => { if (v.dates && v.dates.length) out[k] = v; });
  return out;
}
function drawGas() {
  const src = gasSources(), el = $("gas-chart"), hel = $("gas-hr");
  if (!Object.keys(src).length) { emptyMsg(el, "No gas prices yet. The data update workflow fetches Henry Hub from the EIA when an EIA_API_KEY secret is set, and Houston Ship Channel and Waha from OilPriceAPI when an OILPRICEAPI_KEY secret is set."); hel.innerHTML = ""; $("gas-legend").innerHTML = ""; return; }
  // all series on one date axis: every date any of them has, each carrying no value where it has none
  const dates = [...new Set(Object.values(src).flatMap((g) => g.dates))].sort();
  const on = (g) => { const by = new Map(g.dates.map((d, i) => [d, g.value[i]])); return dates.map((d) => (by.has(d) ? by.get(d) : null)); };
  const lines = GAS_LINES.filter((l) => src[l.key]);
  staticLegend($("gas-legend"), lines);
  $("gas-note").textContent = lines.map((l) => `${l.label} through ${src[l.key].dates.at(-1)}`).join(" · ");
  timeChart(el, lines.map((l) => ({ label: l.label, color: l.color, dash: l.dash, values: on(src[l.key]) })),
    { dates, H: 220, title: "Natural gas daily prices ($/MMBtu)", yFmt: d3.format("$,.2f"), tipFmt: d3.format("$,.2f") });
  const T = S.T;
  if (!T || !T.units) { hel.innerHTML = ""; return; }
  // implied heat rate divides by Houston Ship Channel (Henry Hub when it isn't loaded): the price
  // closest to what most ERCOT gas units burn. Gas on each trend day: last trading day on or before it.
  const G = src.hsc || src.hh;
  const gasBy = new Map(G.dates.map((d, i) => [d, G.value[i]]));
  let last = null;
  const gasOn = {};
  const all = [...new Set([...G.dates, ...T.dates])].sort();
  all.forEach((d) => { if (gasBy.has(d)) last = gasBy.get(d); gasOn[d] = last; });
  // Each unit's first offer price above $0 at or above LSL (skips minimum output, which SCED
  // cannot back down, and blocks priced at or below $0) divided by gas on the day it offered. On each day a unit uses its latest value
  // from the last HR_CARRY_DAYS, so the median covers the fleet, not just the units that ran
  // that day. Blank when fewer than HR_MIN_UNITS units have a value.
  const HR_MIN_UNITS = 10, HR_CARRY_DAYS = 14, DAY_MS = 864e5;
  const t0 = T.dates.map((d) => parseDate(d).getTime());
  const hr = (t) => {
    const us = T.units.filter((u) => u.tech === t);
    const lastHr = us.map(() => null), lastT = us.map(() => -Infinity);
    return T.dates.map((d, i) => {
      const v = [];
      us.forEach((u, k) => {
        const p = u.first[i], g = gasOn[d];
        if (p != null && g > 0) { lastHr[k] = p / g; lastT[k] = t0[i]; }
        if (lastHr[k] != null && t0[i] - lastT[k] <= HR_CARRY_DAYS * DAY_MS) v.push(lastHr[k]);
      });
      return v.length >= HR_MIN_UNITS ? d3.median(v) : null;
    });
  };
  timeChart(hel, [
    { label: "Combined cycle", color: "--c1", values: hr("combined_cycle") },
    { label: "Combustion turbine", color: "--c2", values: hr("combustion_turbine") },
    { label: "Gas steam", color: "--c6", values: hr("gas_steam") },
  ], { dates: T.dates, H: 220, title: `Implied heat rate: median unit's first offer price above $0 at or above LSL ÷ ${src.hsc ? "Houston Ship Channel" : "Henry Hub"} gas (MMBtu per MWh)`, yFmt: d3.format(",.1f"), tipFmt: d3.format(",.2f"), yTicks: [0, 5, 7, 10, 15, 20] });
}

function drawPriceQuantiles() {
  const pq = S.C && S.C.pq, el = $("pq-chart");
  if (!pq || !pq[S.pqTech]) return emptyMsg(el, "No curve trends yet. They are built by the data update workflow.");
  const s = TECHS.find((t) => t.id === S.pqTech), q = pq[S.pqTech];
  // hourly lambda on the same dates, for reference: each day's offer price repeats over its hours
  // from the price summary, a raw-source file that stays (intraday_60d.json.gz is Trends-only)
  const lamBy = new Map(Object.entries(S.SP || {}).map(([d, e]) => [d, e.lambda]));
  const hours = (v) => v.flatMap((x) => d3.range(24).map(() => x));
  timeChart(el, [
    { label: "System lambda, hourly", color: "--price", values: pq.dates.flatMap((d) => d3.range(24).map((h) => lamBy.get(d)?.[h] ?? null)), width: 0.6, opacity: 0.25 },
    { label: "90% of offered MW at or below", color: s.color, values: hours(q.p90), dash: "6 3", width: 1.5 },
    { label: "50% (median MW)", color: s.color, values: hours(q.p50), width: 2.5 },
    { label: "25% of offered MW at or below", color: s.color, values: hours(q.p25), dash: "2 3", width: 1.5 },
  ], { dates: pq.dates, hourly: true, H: 280, yScale: "symlog", yTicks: [-250, -50, 0, 10, 25, 50, 100, 250, 1000, 5000], yFmt: fmtPrice0, tipFmt: fmtPrice,
    title: `${s.label}: offer price at which 25%, 50% and 90% of submitted MW above LSL is available ($/MWh)${pq.full && pq.full.length ? ` · ${pq.full.length} day${pq.full.length === 1 ? "" : "s"} not yet reprocessed use the whole curves` : ""}` });
}

// capacity by status from the intraday file (pipeline/intraday.py status_group)
const STATUS6 = [
  { id: "offer", label: "Running on an offer", color: "--c1" },
  { id: "schedule", label: "Running without an offer curve", color: "--c4" },
  { id: "ruc", label: "Committed by ERCOT (RUC)", color: "--c8" },
  { id: "other_on", label: "Other online states (testing, emergency, starting, stopping)", color: "--c7-soft" },
  { id: "off", label: "Offline but available", color: "--c-other" },
  { id: "out", label: "On outage", color: "--ink-2" },
];
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
  const full = src === "60d" ? (data.full_curve_days || []).filter((d) => !rows.length || d >= rows[0][0]).length : 0;
  $("mbp-title-note").textContent = `${src === "60d" ? "60-day" : "2-day"} data · ${rows.length ? rows[0][0] : ""} to ${last} · ${rows.length.toLocaleString()} hours` +
    (src === "60d" ? (full ? ` · ${full} day${full === 1 ? "" : "s"} not yet reprocessed still include minimum output` : " · MW above minimum output (LSL)") : "");
  // per hour: supply MW per series, and charging MW that stops in the hour's price window
  const H = rows.map((r) => ({ p: r[2], v: list.map((s) => d3.sum(s.keys, (k) => r[ci[k]] || 0)), c: r[ci.storage_charging] || 0 }))
    .filter((h) => d3.sum(h.v) + h.c > 0).sort((a, b) => a.p - b.p);
  if (H.length < 30) return emptyMsg(el, "Too few hours for this view.");
  const w = Math.max(280, el.clientWidth || 600), narrow = w < 560;
  drawMarginalSmooth(el, H, list, w, narrow);
}

function marginalAxes(svg, y, x, w, H, m, xTitle, xAxis) {
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(6).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y), 6, "%", true).tickSizeOuter(0));
  const xa = svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(xAxis.tickSizeOuter(0));
  svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(0)).attr("y2", y(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text("Share of marginal supply (above) · battery charging that stops (below)");
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", H - 2).attr("text-anchor", "end").text(xTitle);
  return xa;
}

// smoothed: each point blends the MBP_K hours nearest that price, so it rests on the same amount of data
// everywhere; exact: each $1 band of lambda on its own hours
const MBP_K = 100, MBP_MIN_H = 5;
function drawMarginalSmooth(el, H, list, w, narrow) {
  if (S.mView !== "exact") S.mView = "smooth";   // old links may say "groups"
  const exact = S.mView === "exact";
  const K = Math.min(MBP_K, Math.floor(H.length / 4)), n = H.length;
  const pts = [];
  if (exact) {
    // each $1 band of lambda on its own hours, as flat steps; thin bands are left blank
    const bands = d3.groups(H, (h) => Math.floor(h.p)).sort((a, b) => a[0] - b[0]);
    let prev = null;
    bands.forEach(([b, hs]) => {
      if (hs.length < MBP_MIN_H) return;
      const v = list.map((_, j) => d3.sum(hs, (h) => h.v[j])), sup = d3.sum(v), c = d3.sum(hs, (h) => h.c);
      const d = { lo: b, hi: b + 1, nh: hs.length, sh: v.map((t) => (sup ? t / sup : 0)), c: sup ? c / sup : 0 };
      if (prev != null && b !== prev + 1) pts.push({ ...d, p: b, gap: true });
      pts.push({ ...d, p: b }, { ...d, p: b + 1 });
      prev = b;
    });
    if (!pts.length) return emptyMsg(el, "Too few hours for this view.");
  } else {
    const cum = [list.map(() => 0)], cc = [0];
    H.forEach((h, i) => { cum.push(cum[i].map((c, j) => c + h.v[j])); cc.push(cc[i] + h.c); });
    const step = Math.max(1, Math.floor(n / 400));
    for (let i = 0; i + K <= n; i += step) {
      const a = i, b = i + K, v = list.map((_, j) => cum[b][j] - cum[a][j]), sup = d3.sum(v), c = cc[b] - cc[a];
      pts.push({ p: H[a + (K >> 1)].p, lo: H[a].p, hi: H[b - 1].p, sh: v.map((t) => (sup ? t / sup : 0)), c: sup ? c / sup : 0 });
    }
  }
  const area = () => d3.area().defined((d) => !d.gap).curve(exact ? d3.curveLinear : d3.curveMonotoneX);
  const Hh = 400, HS = 60, m = { t: 18, r: 16, b: 30, l: 50 };
  const x = d3.scaleSymlog().constant(10).domain(d3.extent(pts, (d) => d.p)).range([m.l, w - m.r]);
  // charging as a share of supply can pass 100%; it is drawn no deeper than 100% (the readout gives the value)
  const y = d3.scaleLinear().domain([-Math.min(1, Math.max(0.5, d3.max(pts, (d) => d.c) || 0)), 1]).nice().range([Hh - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${Hh + HS + 30}`);
  const ticks = (narrow ? [0, 20, 50, 100] : [-20, -5, 0, 10, 20, 30, 50, 100, 200, 500]).filter((t) => t >= x.domain()[0] && t <= x.domain()[1]);
  marginalAxes(svg, y, x, w, Hh, m, "System lambda, hourly average ($/MWh, compressed scale)", d3.axisBottom(x).tickValues(ticks).tickFormat(fmtPrice0));
  let base = pts.map(() => 0);
  list.forEach((s, j) => {
    const lo = base, hi = lo.map((b, i) => b + pts[i].sh[j]);
    svg.append("path").attr("fill", css(s.color)).attr("d", area().x((d) => x(d.p)).y0((d, i) => y(lo[i])).y1((d, i) => y(hi[i]))(pts));
    base = hi;
  });
  svg.append("path").attr("fill", css(CHARGING.color)).attr("d", area().x((d) => x(d.p)).y0(y(0)).y1((d) => y(-Math.min(d.c, -y.domain()[0])))(pts));
  svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(0)).attr("y2", y(0));
  // how many hours sit at each price
  const g = svg.append("g").attr("transform", `translate(0,${Hh + 16})`);
  const inDom = H.filter((h) => h.p >= x.domain()[0] && h.p <= x.domain()[1]).map((h) => h.p);
  const bins = d3.bin().thresholds(d3.range(60).map((i) => x.invert(m.l + ((w - m.l - m.r) * i) / 60))).domain(x.domain())(inDom);
  const yh = d3.scaleLinear().domain([0, d3.max(bins, (b) => b.length) || 1]).range([HS, 0]);
  g.selectAll("rect").data(bins).join("rect").attr("x", (b) => x(b.x0) + 0.5).attr("width", (b) => Math.max(0, x(b.x1) - x(b.x0) - 1))
    .attr("y", (b) => yh(b.length)).attr("height", (b) => HS - yh(b.length)).attr("fill", css("--muted")).attr("opacity", 0.45);
  g.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", -3).text(exact ? `Hours at each price (${n.toLocaleString()} hours; $1 bands with fewer than ${MBP_MIN_H} hours are left blank)` : `Hours at each price (${n.toLocaleString()} hours; the line stops where fewer than ${K / 2} hours lie beyond)`);
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", Hh - m.b).style("display", "none");
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", Hh - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const p = x.invert(d3.pointer(ev)[0]), d = exact ? pts.find((q) => !q.gap && p >= q.lo && p < q.hi) : pts[d3.minIndex(pts, (q) => Math.abs(q.p - p))];
      if (!d) { cross.style("display", "none"); hideTip(); return; }
      cross.style("display", null).attr("x1", x(d.p)).attr("x2", x(d.p));
      showTip(ev, `<h4>Around ${fmtPrice0(Math.round(d.p) || 0)}</h4><table>` + list.map((s, j) => [s, d.sh[j]]).filter(([, v]) => v > 0.005).sort((a, b) => b[1] - a[1])
        .map(([s, v]) => `<tr><td><span class="sw" style="background:var(${s.color})"></span></td><td>${s.label}</td><td class="n">${fmtPct(v)}</td></tr>`).join("") +
        `<tr><td><span class="sw" style="background:var(${CHARGING.color})"></span></td><td>Storage charging (bids to buy)</td><td class="n">${fmtPct(d.c)} of supply</td></tr></table>` +
        (exact ? `<p class="tip-body">${d.nh} hours with lambda from ${fmtPrice0(d.lo)} to ${fmtPrice0(d.hi)}.</p>` : ""));
    })
    .on("pointerleave", () => { cross.style("display", "none"); hideTip(); });
  el.replaceChildren(svg.node());
  setCSV(el, ["lambda_usd_mwh", "window_low", "window_high", ...list.map((s) => `${s.label} share of marginal supply`), "storage charging as share of supply"],
    pts.map((d) => [d.p, d.lo, d.hi, ...d.sh, d.c]), "Marginal supply by settled price");
}

// ---- marginality at the node ---------------------------------------------------------
const MN_TECHS = TECHS.filter((s) => s.id !== "other").concat([{ id: "other", keys: ["other", "hydro"], label: "Other (hydro, diesel, biomass)", color: "--c-other" }]);
const MN_SPLIT = [
  { id: "at", label: "At lambda (sets the system price)", color: "--c1" },
  { id: "below", label: "Below lambda (behind an export constraint)", color: "--c4" },
  { id: "above", label: "Above lambda (node dearer than the system)", color: "--c8" },
];
const mnHatchId = (t) => `mn-hatch-${t}`;
function mnDefs(svg) {
  const defs = svg.append("defs");
  MN_TECHS.forEach((t) => defs.append("pattern").attr("id", mnHatchId(t.id)).attr("patternUnits", "userSpaceOnUse").attr("width", 6).attr("height", 6).attr("patternTransform", "rotate(45)")
    .call((p) => { p.append("rect").attr("width", 6).attr("height", 6).attr("fill", css(t.color)).attr("opacity", 0.25); p.append("line").attr("x1", 0).attr("x2", 0).attr("y1", 0).attr("y2", 6).attr("stroke", css(t.color)).attr("stroke-width", 2.5); }));
}
function drawNodeMarginal() {
  const D = S.MN, el = $("mn-hourly"), del = $("mn-daily"), uel = $("mn-units"), vel = $("mn-valid");
  $("mn-legend").innerHTML = MN_TECHS.map((t) => `<span><span class="sw" style="background:var(${t.color})"></span>${t.label}</span>`).join("") +
    `<span><span class="sw" style="background:var(--ink);opacity:.45"></span>below lambda</span><span><span class="sw" style="background:repeating-linear-gradient(45deg,var(--ink) 0 2px,transparent 2px 5px)"></span>above lambda</span>`;
  staticLegend($("mn-split-legend"), MN_SPLIT);
  if (!D || !D.hours.rows.length) { emptyMsg(el, "No node marginality data yet. It is built by the data update workflow."); del.innerHTML = uel.innerHTML = vel.innerHTML = $("mn-valid-note").textContent = ""; return; }
  const ci = Object.fromEntries(D.hours.columns.map((c, i) => [c, i]));
  const mw = S.mnMeasure === "mw", K = mw ? ["mw_at", "mw_below", "mw_above"] : ["n_at", "n_below", "n_above"];
  let rows = D.hours.rows;
  const last = D.dates.at(-1);
  if (S.mnDays !== "all") {
    const from = d3.timeFormat("%Y-%m-%d")(d3.timeDay.offset(parseDate(last), -(+S.mnDays - 1)));
    rows = rows.filter((r) => r[ci.date] >= from);
  }
  const days = new Set(rows.map((r) => r[ci.date])), nDays = Math.max(1, days.size);
  const tot = [0, 0, 0];
  rows.forEach((r) => K.forEach((k, j) => { tot[j] += r[ci[k]] || 0; }));
  const totAll = d3.sum(tot) || 1;
  const nExact = (D.exact || []).filter((e, i) => e && days.has(D.dates[i])).length;
  const nNet = (D.as_netted || []).filter((e, i) => e && days.has(D.dates[i])).length;
  $("mn-note").textContent = `${nDays} days (${nExact} with per-run base points, ${nNet} net of ancillary service awards) · ${fmtMW(d3.sum(rows, (r) => r[ci.n_at] + r[ci.n_below] + r[ci.n_above]))} marginal unit-hours · ${fmtPct(tot[0] / totAll)} at lambda, ${fmtPct(tot[1] / totAll)} below, ${fmtPct(tot[2] / totAll)} above`;

  // by hour of day: mean per day of each technology's marginal units (or base point MW), split at / below / above
  const techOf = (t) => MN_TECHS.find((s) => s.keys.includes(t)) || MN_TECHS.at(-1);
  const H = d3.range(24).map(() => Object.fromEntries(MN_TECHS.map((t) => [t.id, [0, 0, 0]])));
  rows.forEach((r) => { const a = H[r[ci.hour]][techOf(r[ci.tech]).id]; K.forEach((k, j) => { a[j] += (r[ci[k]] || 0) / nDays; }); });
  const w = Math.max(280, el.clientWidth || 600), narrow = w < 560, Hh = 300, m = { t: 18, r: 12, b: 34, l: 56 };
  const x = d3.scaleBand().domain(d3.range(24)).range([m.l, w - m.r]).paddingInner(0.2);
  const y = d3.scaleLinear().domain([0, Math.max(1, d3.max(H, (h) => d3.sum(MN_TECHS, (t) => d3.sum(h[t.id]))))]).nice().range([Hh - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${Hh}`);
  mnDefs(svg);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y), 5).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${Hh - m.b})`).call(d3.axisBottom(x).tickValues(narrow ? d3.range(0, 24, 3) : d3.range(24)).tickFormat((h) => h + 1).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text(mw ? "Base point MW of the units on the margin, average day" : "Units on the margin, average day");
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", Hh - 2).attr("text-anchor", "end").text("Hour ending");
  H.forEach((h, i) => {
    const cx = x(i), bw = x.bandwidth();
    let acc = 0;
    MN_TECHS.forEach((t) => h[t.id].forEach((v, j) => {
      if (v <= 0) return;
      const r = svg.append("rect").attr("x", cx).attr("width", bw).attr("y", y(acc + v)).attr("height", Math.max(0, y(acc) - y(acc + v) - 0.5));
      if (j === 2) r.attr("fill", `url(#${mnHatchId(t.id)})`); else r.attr("fill", css(t.color)).attr("opacity", j === 1 ? 0.45 : 1);
      acc += v;
    }));
    svg.append("rect").attr("x", cx - 1).attr("width", bw + 2).attr("y", m.t).attr("height", Hh - m.t - m.b).attr("fill", "transparent")
      .on("pointermove", (ev) => showTip(ev, `<h4>Hour ending ${i + 1}</h4><table><tr><th></th><th></th><th class="n">at</th><th class="n">below</th><th class="n">above</th></tr>` +
        MN_TECHS.filter((t) => d3.sum(h[t.id]) > 0).map((t) => `<tr><td><span class="sw" style="background:var(${t.color})"></span></td><td>${t.label}</td>` + h[t.id].map((v) => `<td class="n">${mw ? fmtMW(v) : d3.format(".1f")(v)}</td>`).join("") + "</tr>").join("") + "</table>"))
      .on("pointerleave", hideTip);
  });
  el.replaceChildren(svg.node());
  setCSV(el, ["hour_ending", ...MN_TECHS.flatMap((t) => ["at", "below", "above"].map((k) => `${t.label} ${k} lambda`))], H.map((h, i) => [i + 1, ...MN_TECHS.flatMap((t) => h[t.id])]), "Marginality at the node by hour");

  // daily split: share of marginal unit-hours (or MW) at, below and above lambda
  const byDay = new Map();
  rows.forEach((r) => { const a = byDay.get(r[ci.date]) || [0, 0, 0]; K.forEach((k, j) => { a[j] += r[ci[k]] || 0; }); byDay.set(r[ci.date], a); });
  const dts = D.dates.filter((d) => byDay.has(d));
  timeChart(del, MN_SPLIT.map((s, j) => ({ ...s, values: dts.map((d) => { const a = byDay.get(d), t = d3.sum(a.map(Math.abs)); return t ? Math.abs(a[j]) / t : null; }) })),
    { dates: dts, stack: true, H: 200, yFmt: fmtPct, tipFmt: d3.format(".1%"), title: mw ? "Share of marginal base point MW by where the implied price sat" : "Share of marginal unit-hours by where the implied price sat" });

  // units most often marginal away from lambda
  const urows = D.units.map((r) => ({ unit: r[0], tech: r[1], sp: r[2], on: r[3], at: r[4], below: r[5], above: r[6], implied: r[7], node: r[8], nn: r[9], hsl: r[10] }));
  const cols = [
    { h: "Unit", t: true, f: (r) => esc(r.unit) }, { h: "Technology", t: true, f: (r) => techLabel(r.tech) }, { h: "Settlement point", t: true, f: (r) => esc(r.sp || "–") },
    { h: "Mean HSL", f: (r) => fmtMW(r.hsl) }, { h: "Hours online", f: (r) => fmtMW(r.on) }, { h: "Marginal at lambda", f: (r) => fmtMW(r.at) },
    { h: "Below lambda", f: (r) => fmtMW(r.below) }, { h: "Above lambda", f: (r) => fmtMW(r.above) },
    { h: "Mean implied price", f: (r) => fmtPrice(r.implied) }, { h: "Mean node price, same runs", f: (r) => (r.nn ? fmtPrice(r.node) : "–") }, { h: "Runs with node price", f: (r) => r.nn.toLocaleString() },
  ];
  uel.innerHTML = `<p class="note">Units most often on the margin away from lambda, over all days.</p><table class="data"><thead><tr>${cols.map((c) => `<th${c.t ? ' class="t"' : ""}>${c.h}</th>`).join("")}</tr></thead><tbody>` +
    urows.map((r) => `<tr>${cols.map((c) => `<td${c.t ? ' class="t"' : ""}>${c.f(r)}</td>`).join("")}</tr>`).join("") + "</tbody></table>";
  setCSV(uel, ["unit", "technology", "settlement_point", "mean_hsl", "hours_online", "hours_at_lambda", "hours_below", "hours_above", "mean_implied_price", "mean_node_price", "hours_with_node_price"],
    urows.map((r) => [r.unit, r.tech, r.sp, r.hsl, r.on, r.at, r.below, r.above, r.implied, r.node, r.nn]), "Units marginal away from lambda");

  // implied price against the published node price
  const V = D.valid;
  if (!V || !V.n) { $("mn-valid-note").textContent = ""; emptyMsg(vel, "No node prices yet to check the implied prices against."); return; }
  const pts = V.sample, W = Math.max(280, vel.clientWidth || 600), VH = 360, vm = { t: 18, r: 16, b: 34, l: 56 };
  const ext = d3.extent(pts.flatMap((p) => [p[0], p[1]]));
  const sx = d3.scaleSymlog().constant(10).domain(ext).range([vm.l, W - vm.r]), sy = d3.scaleSymlog().constant(10).domain(ext).range([VH - vm.b, vm.t]);
  const ticks = [-250, -50, -20, -5, 0, 5, 20, 50, 200, 1000, 5000].filter((t) => t >= ext[0] && t <= ext[1]);
  const vs = d3.create("svg").attr("viewBox", `0 0 ${W} ${VH}`);
  vs.append("g").attr("class", "gridline").attr("transform", `translate(${vm.l},0)`).call(d3.axisLeft(sy).tickValues(ticks).tickSize(-(W - vm.l - vm.r)).tickFormat(""));
  vs.append("g").attr("class", "axis").attr("transform", `translate(${vm.l},0)`).call(d3.axisLeft(sy).tickValues(ticks).tickFormat(fmtPrice0).tickSizeOuter(0));
  vs.append("g").attr("class", "axis").attr("transform", `translate(0,${VH - vm.b})`).call(d3.axisBottom(sx).tickValues(ticks).tickFormat(fmtPrice0).tickSizeOuter(0));
  vs.append("line").attr("class", "zero").attr("x1", sx(ext[0])).attr("x2", sx(ext[1])).attr("y1", sy(ext[0])).attr("y2", sy(ext[1]));
  const bc = V.by_class || {}, cls = (k, lb) => (bc[k] && bc[k].n ? `${lb}: ${bc[k].n.toLocaleString()} runs, median gap ${fmtPrice(bc[k].median_abs)}, ${fmtPct(bc[k].within5)} within $5` : null);
  $("mn-valid-note").textContent = `Check against ERCOT's published node prices, ${V.n.toLocaleString()} marginal runs on days with node prices: median gap ${fmtPrice(V.median_abs)}, ${fmtPct(V.within5)} within $5 and ${fmtPct(V.within10)} within $10. ` +
    [cls("at", "At lambda"), cls("below", "below"), cls("above", "above")].filter(Boolean).join("; ") + ". A gap means the unit was not really on the margin at that price, which on days without per-run base points is usually a unit moving between its limits inside the hour.";
  vs.append("text").attr("class", "axis-title").attr("x", vm.l).attr("y", 10).text("Published node price ($/MWh, compressed scale) against the price the unit's curve implies");
  vs.append("text").attr("class", "axis-title").attr("x", W - vm.r).attr("y", VH - 2).attr("text-anchor", "end").text("Implied price from the offer curve ($/MWh, compressed scale)");
  vs.append("g").selectAll("circle").data(pts).join("circle").attr("cx", (p) => sx(p[0])).attr("cy", (p) => sy(p[1])).attr("r", 2.5).attr("fill", (p) => css(techOf(p[2]).color)).attr("opacity", 0.45)
    .on("pointermove", (ev, p) => showTip(ev, `<h4>${techOf(p[2]).label}</h4>implied ${fmtPrice(p[0])} · node ${fmtPrice(p[1])}${p.length > 3 ? ` · lambda ${fmtPrice(p[3])} · ${MN_SPLIT[p[4]].label.split(" (")[0].toLowerCase()}` : ""}`)).on("pointerleave", hideTip);
  vel.replaceChildren(vs.node());
  setCSV(vel, ["implied_price", "node_price", "technology", "lambda", "class"], pts.map((p) => [p[0], p[1], p[2], p[3], p[4] == null ? "" : ["at", "below", "above"][p[4]]]), "Implied against node price");
}

// ---- bidding-approach changes -----------------------------------------------------
function drawChanges() {
  const T = S.T, techOf = Object.fromEntries(T.units.map((u) => [u.unit, u]));
  $("chg-note").textContent = `A change is a shift that holds: the median over the ${T.window} online days after a day differs from the median over the ${T.window} online days before by at least 25 percentage points of the dispatchable range (above LSL) offered at or below $0, half the day running without an offer curve, or $10 in first offer price above $0 (at or above LSL) relative to that day's median for its peers (which removes moves in fuel price). Peers are units of the same ERCOT resource type (for example CCGT90 or SCLE90) when at least 8 of them have a price that day, otherwise the same technology. Thermal units only. Click a row to open the unit.`;
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
}

// ---- units open on their own page ---------------------------------------------------
function showUnit(name) { location.href = `trends.html#unit=${encodeURIComponent(name)}&p=unit-panel`; }

// ---- links ------------------------------------------------------------------------
// the one-day panels (beyond-day.js) keep their own keys in the same address bar
const VIEW_KEYS = { pq: "pqTech", ms: "mSrc", mv: "mView", md: "mDays", mnm: "mnMeasure", mnd: "mnDays", ct: "chgTech", cs: "chgSig" };
function saveView() { window.CX.writeHash({ ...window.CX.readHash(), ...Object.fromEntries(Object.entries(VIEW_KEYS).map(([k, sk]) => [k, S[sk]])) }); }
function loadView() { const v = window.CX.readHash(); Object.entries(VIEW_KEYS).forEach(([k, sk]) => { if (v[k] != null) S[sk] = v[k]; }); }

// ---- boot ---------------------------------------------------------------------------
function drawAll() { drawPriceQuantiles(); drawGas(); drawMarginal(); drawNodeMarginal(); drawChanges(); }

async function boot() {
  [S.T, S.C, S.G, S.GH, S.MN, S.SP] = await Promise.all([tryJSON("data/trends_60d.json.gz"), tryJSON("data/curve_trends.json.gz"),
    tryJSON("data/gas.json.gz"), tryJSON("data/gas_hubs.json.gz"), tryJSON("data/marginal_nodes.json.gz"),
    tryJSON("data/summary_prices.json.gz")]);
  if (!S.T) { $("range-status").textContent = "No across-days data yet. It is built by the data update workflow."; return; }
  const D = S.T.dates;
  // one date range for every daily chart (gas is trimmed to it)
  const spans = [D, S.C?.pq?.dates].filter((d) => d && d.length);
  S.span = [d3.min(spans, (d) => d[0]), d3.max(spans, (d) => d.at(-1))];
  S.last60 = D.at(-1);
  $("range-status").textContent = `Across days: 60-day data ${D[0]} to ${D.at(-1)}, ${S.T.units.length} thermal units.`;
  loadView();
  const thermal = TECHS.filter((s) => THERMAL.includes(s.id));
  [["mbp-src", "mSrc", drawMarginal], ["mbp-view", "mView", drawMarginal], ["mbp-days", "mDays", drawMarginal],
   ["mn-measure", "mnMeasure", drawNodeMarginal], ["mn-days", "mnDays", drawNodeMarginal]]
    .forEach(([id, key, fn]) => { setSeg(id, S[key]); bindSeg(id, key, fn); });
  bindSelect("pq-tech", "pqTech", thermal.filter((s) => s.id !== "nuclear"), drawPriceQuantiles);
  bindSelect("chg-tech", "chgTech", [{ id: "all", label: "All" }, ...thermal], drawChanges);
  bindSelect("chg-sig", "chgSig", [{ id: "all", label: "All" }, ...Object.entries(S.T.signals).map(([id, label]) => ({ id, label }))], drawChanges);
  ["chg-table", "flip-table"].forEach((id) => $(id).addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-unit]");
    if (tr) showUnit(tr.dataset.unit);
  }));
  drawAll();
  saveView();
  let t, lastW = 0;
  new ResizeObserver((e) => { const w = Math.round(e[0].contentRect.width); if (w === lastW) return; lastW = w; clearTimeout(t); t = setTimeout(drawAll, 120); }).observe(document.querySelector("main"));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", drawAll);
}
boot();
})();

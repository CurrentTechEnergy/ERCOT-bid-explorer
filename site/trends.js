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
  chgTech: "all", chgSig: "all", unit: null };
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
  (opts.markers || []).forEach((d) => svg.append("line").attr("class", "crosshair").attr("x1", x(parseDate(d))).attr("x2", x(parseDate(d))).attr("y1", m.t).attr("y2", H - m.b).style("stroke", css("--accent")));
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

function drawCapacity() {
  const el = $("cap-chart"), s = TECHS.find((t) => t.id === S.capTech);
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
  $("chg-note").textContent = `A change is a shift that holds: the median over the ${T.window} online days after a day differs from the median over the ${T.window} online days before by at least 25 percentage points of MW offered at or below $0, half the day running without an offer, or $10 in first offer price relative to that day's median for the technology (which removes moves in fuel price). Thermal units only. Click a row to see the unit.`;
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

function drawUnit(u) {
  const T = S.T, s = TECHS.find((x) => x.id === u.tech);
  const marks = T.changes.filter((c) => c[0] === u.unit).map((c) => c[2]);
  $("unit-detail").hidden = false;
  $("unit-title").textContent = `${u.unit} · ${s.label} (${u.type})`;
  $("unit-note").textContent = `${marks.length} change${marks.length === 1 ? "" : "s"} detected, marked with vertical lines. Days offline are gaps.`;
  const median = u.first.map((v, i) => (v == null || u.rel[i] == null ? null : v - u.rel[i]));
  timeChart($("unit-price"), [
    { label: "First offer price", color: s.color, values: u.first },
    { label: `${s.label} median`, color: "--muted", values: median, dash: "4 3", width: 1.5 },
  ], { title: "First offer price ($/MWh)", H: 170, yFmt: d3.format("$,.0f"), tipFmt: fmtPrice, markers: marks, dots: true });
  timeChart($("unit-share"), [
    { label: "MW offered ≤ $0", color: s.color, values: u.le0 },
    { label: "Share of day with no offer", color: "--muted", values: u.noff, dash: "4 3", width: 1.5 },
  ], { title: "MW offered ≤ $0, and day with no offer (share)", H: 150, yFmt: d3.format(".0%"), markers: marks, dots: true });
  timeChart($("unit-hours"), [{ label: "Hours online", color: s.color, values: u.hours }, ...(u.starts ? [{ label: "Starts", color: "--muted", values: u.starts, dash: "4 3", width: 1.5 }] : [])],
    { title: u.starts ? "Hours online, and starts" : "Hours online", H: 130, yFmt: d3.format(",.0f"), tipFmt: d3.format(",.1f"), markers: marks });
}

function showUnit(name) {
  const u = S.T.units.find((x) => x.unit === name);
  if (!u) return;
  S.unit = name; drawUnit(u); saveView();
  $("unit-detail").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---- links ------------------------------------------------------------------------
const VIEW_KEYS = { f: "floorMode", pq: "pqTech", cap: "capTech", sc: "scTech", scx: "scX", ms: "mSrc", mv: "mView", md: "mDays", ct: "chgTech", cs: "chgSig", unit: "unit" };
function saveView() { window.CX.writeHash(Object.fromEntries(Object.entries(VIEW_KEYS).map(([k, sk]) => [k, S[sk]]))); }
function loadView() { const v = window.CX.readHash(); Object.entries(VIEW_KEYS).forEach(([k, sk]) => { if (v[k] != null) S[sk] = v[k]; }); }

// ---- boot ---------------------------------------------------------------------------
function drawAll() { drawFloor(); drawRenewBands(); drawPriceQuantiles(); drawCapacity(); drawScatter(); drawPartial(); drawMarginal(); drawChanges(); }

async function boot() {
  [S.T, S.C] = await Promise.all([tryJSON("data/trends_60d.json.gz"), tryJSON("data/curve_trends.json.gz")]);
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
  ["chg-table", "flip-table"].forEach((id) => $(id).addEventListener("click", (e) => {
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

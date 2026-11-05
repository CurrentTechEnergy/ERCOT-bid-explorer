/* Commitment: which thermal units stay on when power is cheap, and why (site layout plan section
   2.2). One day of the 60-day data: the turn-off points by unit, the groups with their cutoffs, and what each
   unit online going in did, from data/decisions.json.gz. Across days: who turns off for cheap
   stretches with the inflexibility tracker, capacity by state, thermal output in cheap hours and
   the leanest thermal hours, lifted from trends.js (data/trends_60d.json.gz, intraday_60d.json.gz, unit_hours_60d.json.gz, groups_60d.json.gz,
   hourly_context_60d.json.gz, decisions.json.gz); what the decision cost (data/stayon_60d.json.gz);
   and one row per unit. Rows open the Unit page. */
(() => {
"use strict";

const TECHS = [
  { id: "combined_cycle", keys: ["combined_cycle"], label: "Combined cycle", color: "--c1" },
  { id: "combustion_turbine", keys: ["combustion_turbine"], label: "Combustion turbine and recip", color: "--c2" },
  { id: "wind", keys: ["wind"], label: "Wind", color: "--c3" },
  { id: "solar", keys: ["solar"], label: "Solar", color: "--c4" },
  { id: "nuclear", keys: ["nuclear"], label: "Nuclear", color: "--c5" },
  { id: "gas_steam", keys: ["gas_steam"], label: "Gas steam", color: "--c6" },
  { id: "coal", keys: ["coal"], label: "Coal & lignite", color: "--c8" },
  { id: "other", keys: ["hydro", "other"], label: "Other (hydro, biomass)", color: "--c-other" },
];
const THERMAL = ["nuclear", "coal", "combined_cycle", "gas_steam", "combustion_turbine"];
// group colours for the tables: nuclear on its own (no offer curve, never moves), the other
// thermal units by the groups of the cheap-stretches panel (ST_GROUPS, from the hourly unit strips)
const FLOOR_GROUPS = [
  { id: "nuclear", label: "Nuclear (no offer curve)", color: "--c5" },
  { id: "never", label: "Always on when available", color: "--c1" },
  { id: "multiday", label: "Off for days at a time", color: "--c2" },
  { id: "daily1", label: "Daily, under once a week", color: "--c8" },
  { id: "daily2", label: "Daily, 1 to 2 times a week", color: "--c3" },
  { id: "daily3", label: "Daily, over twice a week", color: "--c4" },
];


// capacity by status from the intraday file (pipeline/intraday.py status_group)
const STATUS6 = [
  { id: "offer", label: "Running on an offer curve", color: "--c1" },
  { id: "schedule", label: "Running on a schedule (no offer curve)", color: "--c4" },
  { id: "ruc", label: "Committed by ERCOT (RUC)", color: "--c7" },     // purple wherever RUC is marked (CX.rucRing)
  { id: "other_on", label: "Other online states (testing, held, starting, stopping)", color: "--c7-soft" },
  { id: "quick", label: "Offline, quick start", color: "--c2" },
  { id: "off", label: "Offline but available", color: "--c-other" },
  { id: "emr", label: "Emergency only", color: "--c5" },
  { id: "out", label: "On outage", color: "--ink-2" },
];

const S = { OC: null, OSC: null, scTech: "combined_cycle", scCell: "all", F: null, FIT: null, FI: null, SC: null, T: null, TH: null, I: null, UH: null, G: null, HC: null, DEC: null, SO: null, days: [], date: null,
  hidden: { runs: new Set(["combustion_turbine"]) },
  capTech: "coal", cheapTech: "all", cheapThr: "0", leanRank: "fossil", leanMonth: "all", leanPer: "day",
  stTech: "all", stThr: "0", stUnit: "mw", stBase: null, costThr: "0", uTech: "all", uGroup: "all", uSort: "mw", uDir: "desc", uSeen: false };

const { getJSON, tryJSON, showTip, hideTip, setCSV, tickFormat, fmtKind, axisFmt } = window.CX;
const $ = (id) => document.getElementById(id);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const fmtMW = d3.format(",.0f");
const fmtPct = d3.format(".0%");
const fmtPrice = (v) => (v == null || isNaN(v) ? "–" : d3.format("$,.2f")(v));
const fmtPrice0 = (v) => d3.format("$,.0f")(v);
const parseDate = (d) => new Date(d + "T12:00:00");
const fmtDate = d3.timeFormat("%a %b %-d, %Y");
const fmtMonth = (m) => d3.timeFormat("%b %Y")(parseDate(m + "-01"));
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

// ---- panels ----------------------------------------------------------------------

function drawCapacity() {
  const el = $("cap-chart"), s = TECHS.find((t) => t.id === S.capTech);
  const C = S.I && S.I.tech[S.capTech];
  if (C && C.cap_offer) {
    const avgOf = (k) => d3.mean(C["cap_" + k] || [], (v) => v) || 0;
    const run = avgOf("offer") + avgOf("schedule") + avgOf("ruc") + avgOf("other_on");
    window.CX.setNote($("cap-note"), `How much of the ${s.label.toLowerCase()} fleet's capacity (HSL) was running each day, and how much sat offline though it could have run. Offline but available is capacity whose owner chose not to run, so its size against the running bands is the day's commitment decision in one picture; outages are not a choice. Over these days ${s.label.toLowerCase()} averaged ${fmtGW(avgOf("off"))} offline but available, against ${fmtGW(run)} running.`, "MW of capacity (HSL) by unit status, averaged over each day's SCED runs, from the per-unit 60-day data. \"Offline but available\" is the economic choice not to run; outages are not. Units running without an offer curve (status ONOS) are held to the MW their QSE scheduled; units testing without one are under Other online states. RUC is ERCOT committing a unit for reliability, which is rare. Quick start (OFFQS) is offline capacity SCED can start within the hour; emergency only (EMR, EMRSWGR) is kept for emergencies or can be switched to another grid, so it is not economic capacity.");
    staticLegend($("cap-legend"), STATUS6);
    const series = STATUS6.filter((g) => C["cap_" + g.id]).map((g) => ({ ...g, values: C["cap_" + g.id] }));
    return timeChart(el, series, { stack: true, dates: S.I.dates,
      stackMax: d3.max(S.I.dates, (_, i) => d3.sum(series, (x) => x.values[i] || 0)) || 1,
      H: 280, title: `${s.label}: capacity by status (MW)`, yFmt: d3.format(",.0f") });
  }
  emptyMsg(el, "No capacity data yet. It is built by the data update workflow.");
}



// ---- intraday: thermal output in cheap hours ---------------------------------------
// stacked bars, one per day. series: [{ label, color, opacity?, values }]
function dayBars(el, dstr, series, opts) {
  const dates = dstr.map(parseDate);
  const w = Math.max(280, el.clientWidth || 600), H = opts.H || 240, m = { t: 16, r: 16, b: 26, l: 64 };
  const tot = dstr.map((_, i) => (series.some((s) => s.values[i] != null) ? d3.sum(series, (s) => s.values[i] || 0) : null));
  if (!tot.some((v) => v != null)) return emptyMsg(el, opts.empty || "No data.");
  const x = dateX(w, m);
  const y = d3.scaleLinear().domain([0, Math.max(1, d3.max(tot))]).nice().range([H - m.b, m.t]);
  const bw = Math.max(1, (x(d3.timeDay.offset(x.domain()[0], 1)) - x(x.domain()[0])) * 0.75);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
  dateAxis(svg, x, w, H, m);
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y), 5, fmtKind(opts.yFmt)).tickSizeOuter(0));
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
// the Peaker tag (how the unit runs, common.js peakerTag) for a unit or a CC configuration's train
const pTag = (n) => window.CX.peakerTag(S.G, S.G?.units?.[n] ? n : trainOf(n));

function drawCheap() {
  const I = S.I, el = $("cheap-chart");
  if (!I) return emptyMsg(el, "No data for this panel yet.");
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
  const pm = (v) => d3.mean(v.filter((x) => x != null)) || 0;
  const nucAvg = split ? pm(series[0].values) : 0;
  window.CX.setNote($("cheap-note"), `When cheap prices come, how much thermal output is online, and how much of it runs above minimum? Each bar is a day with hours of real-time system lambda below ${fmtPrice0(thr)}/MWh: the average ${S.cheapTech === "all" ? "thermal" : s.label.toLowerCase()} output in those hours, split into the part at minimum output (which cannot back down without a shutdown) and the part above minimum (running by choice at these prices). ` +
    `Across the ${nDays} days with such hours, ${split ? `nuclear averaged ${fmtGW(nucAvg)}, other thermal ${fmtGW(pm(atMin))} at minimum and only ${fmtGW(pm(above))} above it` : `${fmtGW(pm(atMin))} ran at minimum and ${fmtGW(pm(above))} above it`}.`, `Average MW of ${s.label.toLowerCase()} output in the hours each day when system lambda was below ${fmtPrice0(thr)} (${nDays} of ${I.dates.length} days had such hours), split into output up to each running unit's minimum (LSL) and output above it. A unit counts as at minimum when its output is no more than ${fmtPct(I.above_eps)} of its HSL above its LSL. Output at minimum is what the unit cannot shed without shutting down. Nuclear reports a low LSL but runs flat out, so with all thermal selected it is shown whole, and on its own nearly all of it shows as above minimum.`);
  dayBars(el, I.dates, series, { title: `${s.label}: average MW in hours with lambda below ${fmtPrice0(thr)}`, none: `No hours with lambda below ${fmtPrice0(thr)}`,
    tipNote: (i) => ` · ${hrs[i].length} h, ${d3.format(",.0f")(n[i])} units running` });
}


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
// Groups by the finest timescale a unit has shown it will shut down on: its shortest off spell.
const ST_NEVER_ON_DAYS = 120;              // never on needs this many days of hourly states with no running hour
const ST_GROUPS = [
  { id: "never", label: "Always on when available", note: "no shutdown on price in the period; off only for outages" },
  { id: "multiday", label: "Off for days at a time", note: "shortest off spell a day or more" },
  { id: "daily1", label: "Daily, under once a week", note: "at least two off spells under 24 h, fewer than one shutdown a week" },
  { id: "daily2", label: "Daily, 1 to 2 times a week", note: "one to two shutdowns a week" },
  { id: "daily3", label: "Daily, over twice a week", note: "more than two shutdowns a week" },
  { id: "never_on", label: "Never on", note: `no running hour in ${ST_NEVER_ON_DAYS}+ days of states` },
];
const ST_OUT_MIN_H = 2;                  // an off spell with fewer OFF hours than this, or more OUT than OFF, is an outage
const ST_OUT_ANY = new Set(["coal"]);    // for these any outage hour makes the spell an outage (pipeline/groups.py OUT_ANY_TECHS)
const ST_FLEET = [...ST_RESP, { id: "N", label: "Not running going in", color: "--grid", o: 1 }];
const ST_RANK = { a: 4, m: 3, "0": 2, o: 1, "-": 0 };
const trainOf = (u) => { const m = /^(.*_CC\d+)_/.exec(u); return m ? m[1] : u; };

// hourly per-unit strips and the timescale groups (pipeline/groups.py), loaded together
async function loadUnitHours() {
  const [uh, g] = await Promise.all([tryJSON("data/unit_hours_60d.json.gz"), tryJSON("data/groups_60d.json.gz")]);
  S.UH = uh || { dates: [], units: {} };
  S.G = g && g.units ? g : null;
  S._ruc = S._opSum = null;
  if (S.date && S.UH.ruc) drawDay();     // the day charts mark RUC from this file
}
// hours of `d` ERCOT had a unit (a CC train: any configuration) committed by RUC (unit_hours_60d "ruc",
// pipeline/intraday.py); 0 until the file is loaded.  RUC days are left out of the "called right" counts.
function rucOn(unit, d) {
  if (!S.UH?.ruc) return 0;
  if (!S._ruc) {
    S._ruc = new Map();
    for (const [n, days] of Object.entries(S.UH.ruc)) for (const [dd, hs] of days) {
      const k = `${trainOf(n)}|${dd}`;
      S._ruc.set(k, new Set([...(S._ruc.get(k) || []), ...hs]));
    }
  }
  return S._ruc.get(`${unit}|${d}`)?.size || 0;
}

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
  // Any non-running spell that is mostly outage, or turns into one within ST_OUT_MIN_H hours, is
  // an outage throughout (a unit returning from a refuelling outage can report OFF for days): its
  // OFF hours are rewritten to "o". Off spells are then the offline hours after a running hour:
  // shutdowns, outage hours inside them included (a maintenance window slotted into an economic
  // shutdown), with at least ST_OUT_MIN_H hours OFF and no more missing hours than OFF hours (a
  // missing hour inside a spell is usually the spring clock change). A single offline
  // hour inside a combined-cycle train is a configuration change, not a shutdown. A spell still
  // open at the end of the period counts once it is a day long.
  for (const e of units.values()) {
    const st = e.st; e.off = []; e.shut = 0;
    if (e.tech === "combined_cycle") for (let k = 1; k < N - 1; k++)
      if (st[k] === "0" && "ma".includes(st[k - 1]) && "ma".includes(st[k + 1])) st[k] = "m";
    for (let k = 0; k < N;) {
      if (st[k] === "m" || st[k] === "a") { k++; continue; }
      let j = k, off = 0, out = 0;
      while (j < N && st[j] !== "m" && st[j] !== "a") { if (st[j] === "0") off++; else if (st[j] === "o") out++; j++; }
      if (out && (off < ST_OUT_MIN_H || out > off || ST_OUT_ANY.has(e.tech))) for (let i = k; i < j; i++) if (st[i] === "0") st[i] = "o";
      k = j;
    }
    let k = 0, short = 0, long = [];
    while (k < N) {
      if (st[k] === "0" && k > 0 && (st[k - 1] === "m" || st[k - 1] === "a")) {
        let j = k, off = 0, out = 0, gap = 0;
        while (j < N && (st[j] === "0" || st[j] === "o" || st[j] === "-")) { if (st[j] === "0") off++; else if (st[j] === "o") out++; else gap++; j++; }
        if (gap <= off && off >= ST_OUT_MIN_H && (j < N || j - k >= 24)) {
          e.shut++; e.off.push(j - k);
          if (j - k >= 24) long.push(j - k); else if (!out) short++;
        }
        k = j;
      } else k++;
    }
    // an off stretch open at the window start is not a shutdown, but a week or more of it makes a
    // unit that started late multi-day rather than always-on
    { let j = 0, off = 0, gap = 0;
      while (j < N && (st[j] === "0" || st[j] === "o" || st[j] === "-")) { if (st[j] === "0") off++; else if (st[j] === "-") gap++; j++; }
      if (j >= 168 && gap <= off && off >= ST_OUT_MIN_H) long.push(j); }
    // daily needs two pure OFF spells under 24 h (one can be a trip and restart) and is split by
    // shutdowns per week over the period; a lone short spell does not place a unit
    const perWeek = e.shut / (N / 168);
    e.ran = st.some((c) => c === "m" || c === "a");
    // never on needs a long record: an idle peaker a few months into the window looks the same
    e.group = !e.ran && st.filter((c) => c !== "-").length >= ST_NEVER_ON_DAYS * 24 ? "never_on" : short >= 2 ? (perWeek < 1 ? "daily1" : perWeek <= 2 ? "daily2" : "daily3")
      : long.length ? "multiday" : "never";
    e.pick = e.configs.sort((a, b) => b.run - a.run)[0].name;   // config shown in Unit detail
    const o = e.off.slice().sort(d3.ascending);
    e.offMin = o.length ? o[0] : null; e.offP10 = o.length ? d3.quantile(o, 0.1) : null; e.offMed = o.length ? d3.median(o) : null;
    // the pipeline's groups (pipeline/groups.py, the same rules) are the shared definition, also
    // used by the Commitment page; the lines above only cover a site deployed before that file
    const g = S.G && S.G.units[e.unit];
    if (g) [, e.group, , e.shut, e.offMin, e.offP10, e.offMed, e.pick] = g;
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
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y), 5, fmtKind(yFmt)).tickSizeOuter(0));
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
const ST_MIN_CHEAP_H = 10;               // cheap hours a unit must be available for in a month to be judged
const ST_WINDOW = 3;                     // tested months in each window of the "changed" comparison
const ST_CHANGE = 0.4;                   // change in run-through share between windows that is flagged

// Month by month, the share of cheap hours (lambda below thr) each unit kept running through
// while it was available. From the merged hourly strips (outage-like off spells already rewritten
// to "o" in stretchBase): running = "m"/"a", available but off = "0"; outage and missing hours
// are left out. Months with fewer than ST_MIN_CHEAP_H cheap hours available are untested (null).
function monthShares(thr) {
  const B = stretchBase();
  B.months = B.months || {};
  if (B.months[thr]) return B.months[thr];
  const { N, lam, units, day0 } = B;
  const monthOf = new Array(N), months = [];
  for (let k = 0; k < N; k++) {
    const m = d3.timeFormat("%Y-%m")(new Date(day0.getTime() + k * 3600e3));
    if (months.at(-1) !== m) months.push(m);
    monthOf[k] = months.length - 1;
  }
  const cheapH = months.map(() => 0);
  for (let k = 0; k < N; k++) if (lam[k] < thr) cheapH[monthOf[k]]++;
  const rows = new Map();
  for (const e of units.values()) {
    const st = e.st;
    const run = months.map(() => 0), avail = months.map(() => 0);
    for (let k = 0; k < N; k++) {
      if (!(lam[k] < thr)) continue;
      const c = st[k];
      if (c === "m" || c === "a") { run[monthOf[k]]++; avail[monthOf[k]]++; } else if (c === "0") avail[monthOf[k]]++;
    }
    rows.set(e.unit, { run, avail, share: months.map((_, i) => (avail[i] >= ST_MIN_CHEAP_H ? run[i] / avail[i] : null)) });
  }
  return (B.months[thr] = { months, cheapH, rows });
}

// the two most recent windows of ST_WINDOW tested months each: run-through share in each
function monthChange(r) {
  const tested = r.share.map((v, i) => (v == null ? null : i)).filter((i) => i != null);
  if (tested.length < 2 * ST_WINDOW) return null;
  const late = tested.slice(-ST_WINDOW), early = tested.slice(-2 * ST_WINDOW, -ST_WINDOW);
  const sh = (ix) => d3.sum(ix, (i) => r.run[i]) / d3.sum(ix, (i) => r.avail[i]);
  return { early: sh(early), late: sh(late), earlyIx: early, lateIx: late };
}

function drawMonths(fleet, s, thr) {
  const el = $("st-months"), M = monthShares(thr), fmtM = (m) => d3.timeFormat("%b %y")(parseDate(m + "-15"));
  const gl = (id) => ST_GROUPS.find((g) => g.id === id).label;
  const units = fleet.map((e) => ({ e, r: M.rows.get(e.unit) })).filter((x) => x.r && x.r.share.some((v) => v != null))
    .sort((a, b) => d3.ascending(ST_GROUPS.findIndex((g) => g.id === a.e.group), ST_GROUPS.findIndex((g) => g.id === b.e.group)) || d3.descending(a.e.mw, b.e.mw));
  const tested = M.months.map((_, i) => M.cheapH[i] >= ST_MIN_CHEAP_H);
  const bi = d3.maxIndex(M.cheapH), atAll = units.filter((x) => x.r.share[bi] != null), at100 = atAll.filter((x) => x.r.share[bi] >= 0.999).length;
  window.CX.setNote($("st-month-note"), `For each unit and month, the share of the hours with real-time lambda below ${fmtPrice0(thr)}/MWh that it kept running while it was available. Dark cells rode through nearly every cheap hour; light cells turned off for most; blank cells had too few cheap hours (under ${ST_MIN_CHEAP_H}) to judge. Rows are sorted by group, then capacity.` +
    (atAll.length ? ` In ${d3.timeFormat("%B %Y")(parseDate(M.months[bi] + "-15"))}, the month with most cheap hours (${M.cheapH[bi]}), ${at100} of ${atAll.length} judged units ran through every one of them.` : ""), `Each cell is the share of hours with system lambda below ${fmtPrice0(thr)} that month in which the unit kept running, out of the hours it was available (running or off but not on outage). ` +
    `Dark means it rode through, light means it turned off. Blank cells are untested: fewer than ${ST_MIN_CHEAP_H} cheap hours while the unit was available, or the unit on outage. ` +
    `A unit's own month can be untested in a month with cheap hours if it was on outage for them. Rows are sorted by group, then capacity. Click a row to open the unit.`);
  // units whose share moved between the two most recent windows of tested months
  const changed = units.map((x) => ({ ...x, c: monthChange(x.r) })).filter((x) => x.c && Math.abs(x.c.late - x.c.early) >= ST_CHANGE)
    .sort((a, b) => d3.descending(Math.abs(b.c.late - b.c.early), Math.abs(a.c.late - a.c.early)));
  const win = (ix) => `${fmtM(M.months[ix[0]])}–${fmtM(M.months[ix.at(-1)])}`;
  $("st-changed").innerHTML = changed.length
    ? `<p class="note">Changed behavior: units whose run-through share moved by ${Math.round(ST_CHANGE * 100)} percentage points or more between their two most recent windows of ${ST_WINDOW} tested months.</p>` +
      unitRows(changed.map((x) => ({ ...x.e, unit: x.e.pick, c: x.c })), [
        { h: "Unit", t: 1, f: (r) => esc(r.unit === r.pick ? r.unit : `${r.unit} (${r.unit})`) }, { h: "Technology", t: 1, f: (r) => techLabel(r.tech) }, { h: "Group", t: 1, f: (r) => gl(r.group) + pTag(r.unit) },
        { h: "MW", f: (r) => fmtMW(r.mw) }, { h: "Earlier window", t: 1, f: (r) => win(r.c.earlyIx) }, { h: "Ran through", f: (r) => fmtPct(r.c.early) },
        { h: "Latest window", t: 1, f: (r) => win(r.c.lateIx) }, { h: "Ran through", f: (r) => fmtPct(r.c.late) },
        { h: "Change, points", f: (r) => (r.c.late >= r.c.early ? "+" : "−") + Math.round(Math.abs(r.c.late - r.c.early) * 100) },
      ])
    : `<p class="note">No unit changed its behavior between its two most recent windows of ${ST_WINDOW} tested months (a change is ${Math.round(ST_CHANGE * 100)} percentage points or more in the share of cheap hours it ran through).</p>`;
  if (!units.length) return emptyMsg(el, "No units match.");
  const base = d3.color(css(s.color));
  const cell = (v) => {
    if (v == null) return `<td class="st-na" title="Untested"></td>`;
    const c = base.copy({ opacity: 0.08 + 0.92 * v });
    return `<td style="background:${c.formatRgb()};color:${v > 0.55 ? "#fff" : "inherit"}">${fmtPct(v)}</td>`;
  };
  el.innerHTML = `<table class="data st-grid"><thead><tr><th class="t">Unit</th><th class="t">Group</th><th>MW</th>` +
    M.months.map((m, i) => `<th${tested[i] ? "" : ' class="st-na"'} title="${M.cheapH[i]} hour${M.cheapH[i] === 1 ? "" : "s"} below ${fmtPrice0(thr)}/MWh">${fmtM(m)}<br><span class="muted">${M.cheapH[i]} h</span></th>`).join("") + "</tr></thead><tbody>" +
    units.map((x) => `<tr data-unit="${esc(x.e.pick)}" style="cursor:pointer"><td class="t">${esc(x.e.unit)}</td><td class="t">${gl(x.e.group)}</td><td>${fmtMW(x.e.mw)}</td>${x.r.share.map(cell).join("")}</tr>`).join("") +
    "</tbody></table>";
  setCSV(el, ["unit", "technology", "group", "mw", ...M.months.map((m) => `${m}_share_ran_through`), ...M.months.map((m) => `${m}_cheap_hours_available`)],
    units.map((x) => [x.e.unit, x.e.tech, x.e.group, Math.round(x.e.mw), ...x.r.share.map((v) => (v == null ? "" : v.toFixed(3))), ...x.r.avail]), `cheap-hours-month-by-month-${thr}`);
}
// pipeline/decisions.py: a unit's shutdown decisions scored day-ahead (see decisionOf)
const DEC_F = { tech: 0, lsl: 1, mingen: 2, hot: 3, est: 4, days: 5, shut: 6, award: 7, base: 8, cutoff: 9, acc: 10, stayMax: 11, shutMin: 12, accNew: 13 };
// acc is scored on the days the cutoff was chosen from; accNew leaves each day out of its own
// cutoff (pipeline/decisions.py), the figure to expect on a new day, so the pages show it when present
const decisionOf = (key) => {
  const u = S.DEC?.units?.[key];
  if (!u) return null;
  const d = Object.fromEntries(Object.entries(DEC_F).map(([k, i]) => [k, u[i]]));
  if (d.accNew != null) d.acc = d.accNew;
  return d;
};
const fmtK = (v) => (v == null ? "–" : (v < 0 ? "−" : "") + "$" + d3.format(",.0f")(Math.abs(v) / 1e3) + "k");
async function drawStretch() {
  const el = $("st-group");
  if (!S.I) return emptyMsg(el, "No data for this panel yet.");
  if (!S.UH) {
    el.innerHTML = `<p class="empty">Loading hourly data…</p>`;
    await loadUnitHours();
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
  const shown = groups.filter((g) => g.n);
  const runIn = d3.sum(shown, (g) => g.total - g.mw.N), rode = d3.sum(shown, (g) => g.mw.M + g.mw.A);
  const onG = groups.find((g, i) => ST_GROUPS[i].id === "never"), rodeOn = onG ? onG.mw.M + onG.mw.A : 0;
  window.CX.setNote($("st-note"), `When the real-time price fell below ${fmtPrice0(thr)}/MWh for a run of hours (${nEps} such stretches, ${period}), what did the coal and gas fleet do: turn off in the ${ST_LEAD} hours before, turn off during, run at minimum output, or keep running above minimum? Units are grouped by how often they have shut down on price, so the bars show how much capacity sits in the groups that never respond. ` +
    (runIn > 0 ? `Of the capacity running into these stretches, ${fmtPct(rode / runIn)} rode through${rodeOn ? `, and ${fmtPct(rodeOn / rode)} of that was in the always-on group` : ""}.` : ""), `A cheap stretch is a run of consecutive hours with system lambda below ${fmtPrice0(thr)}. There were ${nEps} from ${period}. ` +
    `Each bar is the total capacity (HSL) of one group of ${S.stTech === "all" ? "coal and gas" : s.label.toLowerCase()} units, grouped by how they ran over the whole period: ${ST_GROUPS.map((g) => `${g.label.toLowerCase()} (${g.note})`).join("; ")}. ` +
    `Each unit's capacity is split by what it did across the ${nEps} stretches: turned off in the ${ST_LEAD} hours before, turned off during, ran at minimum or above minimum (when it was already running ${ST_LEAD} hours before the stretch began), or not running going in (offline, on outage or no data). Units that never ran in the period are left out. ` +
    `Each combined-cycle train counts as one unit, so switching configuration is not a shutdown. Nuclear is left out. Lambda is the system price; a unit's own nodal price can differ.`);
  fleetBars(el, groups.filter((g) => g.n), s, S.stUnit === "mw" ? "Capacity of each group, MW, split by what it did in cheap stretches" : "Share of each group's capacity, by what it did in cheap stretches");
  drawMonths(fleet, s, thr);
  // the per-unit columns (stretches, shutdowns, hours off, cutoff) are in the units table at the foot of the page
  setCSV(el, ["group", "units", "capacity_mw", ...ST_FLEET.map((r) => r.label)], groups.map((g) => [g.label, g.n, Math.round(g.total), ...ST_FLEET.map((r) => Math.round(g.mw[r.id]))]), `Cheap stretches, lambda below ${thr}`);
}

// ---- leanest thermal hours: the hours with the least thermal output, with what else ran --
const FOSSIL = THERMAL.filter((t) => t !== "nuclear");
const LEAN_N = 25;
function drawLean() {
  const I = S.I, HC = S.HC, el = $("lean-table");
  if (!I) return emptyMsg(el, "No data for this panel yet.");
  const fossil = S.leanRank === "fossil", ci = new Map((HC?.dates || []).map((d, i) => [d, i]));
  const months = [...new Set(I.dates.map((d) => d.slice(0, 7)))];
  bindSelect("lean-month", "leanMonth", [{ id: "all", label: "All months" },
    ...months.reverse().map((m) => ({ id: m, label: d3.timeFormat("%b %Y")(parseDate(m + "-15")) }))], drawLean);
  // all output: running units plus units starting up, shutting down or online for under half the hour
  const transit = (t, i, h) => I.tech[t].transit?.[i]?.[h] || 0;
  const out = (t, i, h) => I.tech[t].at_min[i][h] + I.tech[t].above[i][h] + transit(t, i, h);
  let rows = [];
  I.dates.forEach((d, i) => {
    if (I.tech.coal.n[i] == null || (S.leanMonth !== "all" && !d.startsWith(S.leanMonth))) return;
    for (let h = 0; h < 24; h++) {
      if (I.tech.coal.at_min[i][h] == null) continue;
      const r = { d, h, nuc: out("nuclear", i, h), lam: I.lambda[i][h] };
      FOSSIL.forEach((t) => { r[t] = out(t, i, h); });
      r.fossil = d3.sum(FOSSIL, (t) => r[t]);
      r.above = d3.sum(FOSSIL, (t) => I.tech[t].above[i][h]);
      r.transit = d3.sum(FOSSIL, (t) => transit(t, i, h));
      r.v = fossil ? r.fossil : r.fossil + r.nuc;
      if (!r.v) continue;   // the hour skipped at the spring DST change
      const c = ci.get(d);
      ["wind", "solar", "storage", "hub"].forEach((k) => { r[k] = c == null ? null : HC[k][c][h]; });
      rows.push(r);
    }
  });
  rows.sort((a, b) => a.v - b.v);
  if (S.leanPer === "day") { const seen = new Set(); rows = rows.filter((r) => !seen.has(r.d) && seen.add(r.d)); }
  const top = rows.slice(0, LEAN_N);
  const mw = (v) => (v == null ? "–" : fmtMW(v));
  const cols = [
    { h: "Date", t: 1, k: "date", f: (r) => d3.timeFormat("%a %b %-d, %Y")(parseDate(r.d)) }, { h: "HE", k: "hour_ending", f: (r) => r.h + 1 },
    { h: fossil ? "Fossil, MW" : "Thermal, MW", k: fossil ? "fossil_mw" : "thermal_mw", f: (r) => `<b>${mw(r.v)}</b>` },
    { h: "Fossil above minimum, MW", k: "fossil_above_min_mw", f: (r) => mw(r.above) },
    { h: "Fossil starting or stopping, MW", k: "fossil_starting_stopping_mw", f: (r) => mw(r.transit) },
    { h: "Coal, MW", k: "coal_mw", f: (r) => mw(r.coal) }, { h: "Combined cycle, MW", k: "combined_cycle_mw", f: (r) => mw(r.combined_cycle) },
    { h: "Gas steam, MW", k: "gas_steam_mw", f: (r) => mw(r.gas_steam) }, { h: "Combustion turbine, MW", k: "combustion_turbine_mw", f: (r) => mw(r.combustion_turbine) },
    { h: "Nuclear, MW", k: "nuclear_mw", f: (r) => mw(r.nuc) }, { h: "Wind, MW", k: "wind_mw", f: (r) => mw(r.wind) }, { h: "Solar, MW", k: "solar_mw", f: (r) => mw(r.solar) },
    { h: "Storage (net), MW", k: "storage_mw", f: (r) => mw(r.storage) }, { h: "RT lambda, $/MWh", k: "lambda", f: (r) => fmtPrice(r.lam) }, { h: "Hub average, $/MWh", k: "hub_avg", f: (r) => fmtPrice(r.hub) },
  ];
  const val = (r) => [r.d, r.h + 1, r.v, r.above, r.transit, r.coal, r.combined_cycle, r.gas_steam, r.combustion_turbine, r.nuc, r.wind, r.solar, r.storage, r.lam, r.hub];
  const scope = S.leanMonth === "all" ? "all days" : d3.timeFormat("%B %Y")(parseDate(S.leanMonth + "-15"));
  window.CX.setNote($("lean-note"), `How far will the ${fossil ? "fossil" : "thermal"} fleet back down? The ${top.length} hours${S.leanPer === "day" ? " (one per day)" : ""} with the least ${fossil ? "coal and gas" : "thermal"} output, with what else was on the system. "Above minimum" is the fossil output still running by choice; the lambda column is the price it took to get there.` +
    (top.length ? ` In these hours ${fossil ? "fossil" : "thermal"} output ran from ${fmtGW(top[0].v)} to ${fmtGW(top.at(-1).v)}, with on average ${fmtGW(d3.mean(top, (r) => r.above))} of fossil output above minimum.` : "") + ` Click a row to open that hour on the Real-time offers page.`, `The ${top.length} hours with the least ${fossil ? "fossil (coal, combined cycle, gas steam and combustion turbine)" : "thermal (fossil and nuclear)"} output, ${scope}` +
    `${S.leanPer === "day" ? ", one per day" : ""}, from the 60-day disclosure. Output counts every unit's telemetered MW, including units starting up, shutting down or online for under half the hour ("starting or stopping"). ` +
    `"Above minimum" is output above each running unit's LSL; the rest of the running units' output is what they could not shed without shutting down. ` +
    `Storage is net output (negative while charging); hub avg is the HB_HUBAVG settlement point price. Click a row to open that hour on the Real-time offers page.`);
  if (!top.length) { el.innerHTML = `<p class="empty">No hours in this range.</p>`; setCSV(el, [], [], "Leanest thermal hours"); return; }
  el.innerHTML = `<table class="data"><thead><tr>${cols.map((c) => `<th${c.t ? ' class="t"' : ""}>${c.h}</th>`).join("")}</tr></thead><tbody>` +
    top.map((r) => `<tr data-href="beyond.html#date=${r.d}&he=${r.h + 1}&p=curves-panel" style="cursor:pointer">${cols.map((c) => `<td${c.t ? ' class="t"' : ""}>${c.f(r)}</td>`).join("")}</tr>`).join("") + "</tbody></table>";
  setCSV(el, cols.map((c) => c.k), top.map(val), "Leanest thermal hours");
}

// ==== one day: turn-off points, groups and turn-off points, what each unit did ============
// The units online going into a 60-day day and what they did come from data/decisions.json.gz
// (pipeline/decisions.py). Each CC train's and gas steam unit's turn-off point that day comes from
// the operator model (data/operator/cutoffs.json.gz, pipeline/models/operator_cutoffs.py):
// how much being off would have to save before the model's day call turns it off. Coal is
// drawn flat: it does not cycle within a day.
const GROUP_LABEL = Object.fromEntries([...ST_GROUPS.map((g) => [g.id, g.label]), ["ungrouped", "Not yet grouped"]]);
const DID = { off: "Turned off", on: "Stayed on" };
// the day-ahead award in the day: none, some hours, every hour (operator_cutoffs "award")
const AWARD = [{ id: 0, label: "No day-ahead award that day", color: "--c1" }, { id: 1, label: "Awarded some hours", color: "--c3" }, { id: 2, label: "Awarded every hour", color: "--c2" }];
const fmt$ = (v) => (v == null || isNaN(v) ? "–" : (v < 0 ? "−" : "") + "$" + d3.format(",.0f")(Math.abs(v)));
const fmtPerMW = (v) => (v == null || isNaN(v) ? "–" : (v < 0 ? "−" : "") + "$" + d3.format(",.1f")(Math.abs(v)));
const fmtGW = (v) => d3.format(",.1f")(v / 1e3) + " GW";
const unitHref = (u) => `unit.html?unit=${encodeURIComponent(trainOf(u))}`;   // a combined-cycle configuration opens its train
const SAVING_NOTE = "Loss from staying on: for each stretch of the day at least as long as the unit's minimum down time (its shortest off spell before the month, 2 hours at least), the cost of running at minimum output on its day-ahead minimum-energy offer, less what the day-ahead price at its node would have paid for that output. The worst such stretch is the loss, shown per MW of minimum output (LSL) so units of every size compare, and before any restart cost. Negative means staying on paid. The stretch cannot run past HE 24, because the next day's prices are not known when the operator decides.";

// decisions.json day rows: [train, date, loss, first hour ending, hours, award share, shut, hours off]
const DAY_F = { unit: 0, date: 1, loss: 2, he: 3, hours: 4, award: 5, shut: 6, hoff: 7 };
function decisionDays() {
  if (S.byDate || !S.DEC) return S.byDate || new Map();
  S.byDate = d3.group(S.DEC.days, (r) => r[DAY_F.date]);
  return S.byDate;
}
// operator_cutoffs rows for a day, by unit: [unit, tech, lsl, award, saving, turn_off, off, min_down]
function opDay(d) {
  const rows = S.OC?.days?.[d];
  return rows ? new Map(rows.map((r) => [r[0], r])) : null;
}
// the units online going into the day that the turn-off chart and the groups table's turn-off rows
// cover: coal, gas steam and combined cycles. Combustion turbines mostly start rather than stay on,
// so they have their own rows (ctDay)
function dayUnits(d) {
  const rows = decisionDays().get(d) || [], op = opDay(d);
  return rows.map((r) => {
    const dec = decisionOf(r[DAY_F.unit]);
    if (!dec || !(dec.lsl > 0) || dec.tech === "combustion_turbine") return null;
    const group = S.G?.units?.[r[DAY_F.unit]]?.[1] || "ungrouped";
    const o = op?.get(r[DAY_F.unit]), modelled = ["combined_cycle", "gas_steam"].includes(dec.tech);
    return {
      unit: r[DAY_F.unit], tech: dec.tech, group, lsl: o ? o[2] : dec.lsl, he: r[DAY_F.he], hours: r[DAY_F.hours],
      did: (o ? o[6] : r[DAY_F.shut]) ? "off" : "on", hoff: r[DAY_F.hoff],
      award: o ? o[3] : null, md: o ? o[7] : null,
      // "cut": a turn-off point; "flat": on at any saving in this chart (the model says it rides
      // through anything tested, or it is coal); "none": a CC or gas steam
      // unit without a model row that day (its own grey band)
      kind: o ? (o[5] != null ? "cut" : "flat") : modelled ? "none" : "flat",
      c: o ? o[5] : null, l: o ? o[4] : null,
    };
  }).filter(Boolean);
}

function drawDay() { drawCutUnits(); drawCtUnits(); drawGroups(); }

// the saving axis of the turn-off chart
const CUT_M = { l: 64, r: 16 };
function cutDomain(U) {
  const cs = U.filter((u) => u.kind === "cut").map((u) => u.c), ls = U.filter((u) => u.l != null).map((u) => u.l).sort(d3.ascending);
  const lo = Math.min(0, d3.min(cs) ?? 0, ls.length ? d3.quantile(ls, 0.02) : 0);
  return [lo * 1.08, Math.max(50, d3.max(cs) ?? 0, ls.length ? d3.quantile(ls, 0.95) : 0) * 1.08];
}
const cutTicks = (x0, x1, narrow) => (narrow ? [-250, -50, 0, 10, 50, 250, 1000] : [-500, -250, -100, -25, 0, 10, 25, 50, 100, 250, 500, 1000, 2500]).filter((v) => v >= x0 && v <= x1);

// one row per unit the model covers, grouped by how often it turns off: a diamond at its turn-off
// point (coloured by its day-ahead award), a circle at the day's saving (hollow where it turned
// off), joined in red where the unit did the opposite of what the model expected
function drawCutUnits() {
  const el = $("cut-units");
  const U = dayUnits(S.date).filter((u) => u.l != null).map((u) => ({ ...u, ruc: rucOn(u.unit, S.date) }));
  const rowsG = ST_GROUPS.filter((g) => U.some((u) => u.group === g.id)).concat(U.some((u) => u.group === "ungrouped") ? [{ id: "ungrouped", label: GROUP_LABEL.ungrouped }] : []);
  $("cut-title-note").textContent = fmtDate(parseDate(S.date));
  if (!rowsG.length) { $("cut-units-stayed").textContent = ""; $("cut-units-note").textContent = ""; $("cut-units-legend").innerHTML = "";
    return emptyMsg(el, S.OC && !opDay(S.date) ? `The operator model's turn-off points run ${Object.keys(S.OC.days)[0]} to ${Object.keys(S.OC.days).at(-1)}; pick a day in that range.` : "No unit with a turn-off point was online going into this day."); }
  const going = d3.sum(U, (u) => u.lsl), stayed = d3.sum(U.filter((u) => u.did === "on"), (u) => u.lsl);
  $("cut-units-stayed").textContent = ` · ${fmtMW(stayed)} of ${fmtMW(going)} MW of minimum output stayed on`;
  const past = (u) => u.kind === "cut" && u.l > u.c, n = (f) => U.filter(f).length, surprise = (u) => !u.ruc && past(u) !== (u.did === "off");
  const nRuc = n((u) => u.ruc), nJ = U.length - nRuc;
  const nOff = n((u) => u.did === "off"), right = n((u) => !u.ruc && past(u) === (u.did === "off"));
  const nPast = n(past), nPastOn = n((u) => past(u) && u.did === "on");
  window.CX.setNote($("cut-units-note"), `Did the combined-cycle and gas steam units that faced a loss turn off? Each row is a unit online going into the day. The circle is how much it stood to lose per MW of minimum output by staying on through the day's worst stretch; the diamond is the loss at which the operator model expects it to shut down instead. A circle right of its diamond is a unit the model expected to turn off; a filled one there rode through anyway. ` +
    `On ${fmtDate(parseDate(S.date))}, ${U.length} units were online going in and ${nOff} turned off; ${nPast} faced a loss past their turn-off point and ${nPastOn} of those stayed on. The model called ${right} of ${nJ} right.${window.CX.rucNote(nRuc, nRuc === 1 ? "unit" : "units")} Hover a row for its numbers; click to open the unit.`, `${U.length} combined-cycle trains (CC) and gas steam units were online going into the day. The diamond is each unit's turn-off point that day from the operator model, coloured by its day-ahead award; the circle is the loss from staying on it actually faced, and the line between them is red where the unit did the opposite of the model: stayed on past its turn-off point, or turned off short of it. The turn-off point is found by moving the day's day-ahead prices up or down by the same amount until the model's call for the day first flips to off; the loss at that shift is the turn-off point. An arrow at the right edge is a unit no shift turned off (a day-ahead award in every hour holds a unit on). ` +
    `A filled circle stayed on through the day; a hollow one was offline in some hour (outages aside). Read at its own loss, the model called ${right} of ${nJ} units right.${window.CX.rucNote(nRuc, nRuc === 1 ? "unit" : "units")} ${SAVING_NOTE} Losses beyond the edges are drawn at the edge. Click a unit to open it.`);
  $("cut-units-legend").innerHTML = AWARD.map((a) => `<span><span class="sw" style="background:var(${a.color});transform:rotate(45deg) scale(0.8)"></span>Turn-off point, ${["no day-ahead award", "awarded some hours", "awarded every hour"][a.id]}</span>`).join("") +
    `<span>→ No turn-off point: the model keeps it on at any loss tried</span>` + window.CX.onOffLegend("Loss that day, stayed on", "Loss that day, turned off") +
    `<span><span class="sw" style="background:var(--c8);height:3px"></span>Surprise: did the opposite of the model</span>` + (nRuc ? window.CX.rucLegend() : "");
  const [x0, x1] = cutDomain(U);
  const w = Math.max(280, el.clientWidth || 600), narrow = w < 560, lane = 8, rowGap = 26;
  const per = rowsG.map((g) => U.filter((u) => u.group === g.id).sort((a, b) => (a.kind === "cut" ? a.c : Infinity) - (b.kind === "cut" ? b.c : Infinity) || a.l - b.l));
  const m = { t: 8, b: 30, ...CUT_M }, H = m.t + m.b + d3.sum(per, (us) => rowGap + us.length * lane);
  const x = d3.scaleSymlog().constant(10).domain([x0, x1]).range([m.l, w - m.r]).clamp(true);
  const xT = cutTicks(x0, x1, narrow);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`).attr("data-nopin", "");
  svg.append("g").attr("class", "gridline").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickValues(xT).tickSize(-(H - m.t - m.b)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickValues(xT).tickFormat(fmtPrice0).tickSizeOuter(0));
  const diamond = d3.symbol(d3.symbolDiamond, 34)();
  let top = m.t;
  rowsG.forEach((g, gi) => {
    const us = per[gi];
    if (gi) svg.append("line").attr("x1", m.l).attr("x2", w - m.r).attr("y1", top).attr("y2", top).attr("stroke", css("--line"));
    svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", top + 14).text(g.label.replace("Daily, ", "Daily: "));
    us.forEach((u, k) => {
      const yy = top + rowGap - 4 + k * lane + lane / 2, col = css(AWARD[u.award ?? 0].color);
      const gU = svg.append("g").style("cursor", "pointer")
        .on("pointermove", (ev) => showTip(ev, `<h4>${esc(u.unit)}</h4>${techLabel(u.tech)} · ${g.label}${window.CX.isPeaker(S.G, u.unit) ? " · Peaker" : ""}<br>LSL ${fmtMW(u.lsl)} MW, minimum down time ${u.md} h<br>` +
          `${AWARD[u.award ?? 0].label}<br>Loss from staying on that day ${fmtPerMW(u.l)}/MW (${fmt$(u.l * u.lsl)})<br>` +
          (u.kind === "cut" ? `The model turns it off once the loss passes ${fmtPerMW(u.c)}/MW (${fmt$(u.c * u.lsl)})` : "The model keeps it on at any loss tried") +
          `<br><b>${DID[u.did]}</b>${u.ruc ? `<br>Committed by ERCOT (RUC) ${u.ruc} h: not counted for or against the model` : ""}<br><span class="tip-pin-note">Click to open the unit</span>`))
        .on("pointerleave", hideTip)
        .on("click", () => { location.href = unitHref(u.unit); });
      const end = u.kind === "cut" ? u.c : x1;
      gU.append("line").attr("x1", x(Math.min(end, u.l))).attr("x2", x(Math.max(end, u.l))).attr("y1", yy).attr("y2", yy).attr("stroke", css(surprise(u) ? "--c8" : "--line")).attr("stroke-width", surprise(u) ? 1.8 : 1.2);
      if (u.kind === "cut") gU.append("path").attr("d", diamond).attr("transform", `translate(${x(u.c)},${yy})`).attr("fill", col);
      else gU.append("path").attr("d", `M${x(x1) - 12},${yy}h10m-4,-3l4,3l-4,3`).attr("fill", "none").attr("stroke", col).attr("stroke-width", 1.5);
      window.CX.onOffDot(gU.append("circle").attr("cx", x(u.l)).attr("cy", yy), u.did !== "off");
      if (u.ruc) window.CX.rucRing(gU.append("circle").attr("cx", x(u.l)).attr("cy", yy), 6);
    });
    top += rowGap + us.length * lane;
  });
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", H - 2).attr("text-anchor", "end").text("Loss from staying on, $ per MW of minimum output (LSL)");
  el.replaceChildren(svg.node());
  setCSV(el, ["unit", "technology", "group", "lsl_mw", "min_down_h", "award", "saving_usd_per_mw_lsl", "turn_off_usd_per_mw_lsl", "did", "ruc_hours"],
    U.map((u) => [u.unit, u.tech, u.group, u.lsl, u.md, ["none", "some hours", "every hour"][u.award ?? 0], u.l, u.c, u.did, u.ruc]), `Turn-off points ${S.date}`);
}

// one row per combustion turbine (and recip engine) that went into some hour of the day offline
// (data/peaker/oi.json.gz, pipeline/models/peaker_oi.py), grouped by how often it turns off: a
// diamond at the day's highest day-ahead node price at which the operator model starts it,
// a circle at the day's actual highest (filled started, hollow stayed off), joined in red where it
// did the opposite of the model; turn_on null (no shift tested starts it) drawn at the right edge
const CT_NOTE = "The model is refitted each month on all earlier days, recent days weighted most (a day 30 days back counts half). It estimates the chance that a turbine offline in the hour before starts in a given hour, from what its operator knew beforehand: the day-ahead price at its node that hour and the highest over the next four, its day-ahead award and status, day-ahead system lambda, the real-time price at its node in the hours before and how far it ran above or below day-ahead, the hour of day, and how long it has been off. Each turbine's own readiness to start is fitted as its own offset. Hours ERCOT committed it by RUC (a reliability commitment), and the hour after, are left out.\n\n";
function drawCtUnits() {
  const el = $("ct-units"), P = S.POI, rows = P?.days?.[S.date];
  if (!rows || !rows.length) { $("ct-units-note").textContent = ""; $("ct-units-legend").innerHTML = "";
    return emptyMsg(el, P ? `The combustion turbine model's turn-on points run ${Object.keys(P.days)[0]} to ${Object.keys(P.days).at(-1)}; pick a day in that range.` : "No combustion turbine model loaded."); }
  const C = Object.fromEntries(P.columns.map((c, i) => [c, i]));
  const U = rows.map((r) => ({ unit: r[C.unit], s: r[C.turn_on], p: r[C.peak], ran: !!r[C.started], on: r[C.hours_on], av: r[C.hours_avail], off: r[C.hours_off], win: r[C.window],
    group: S.G?.units?.[r[C.unit]]?.[1] || "ungrouped", ruc: rucOn(r[C.unit], S.date) }));
  const says = (u) => u.s != null && u.s <= u.p, surprise = (u) => !u.ruc && says(u) !== u.ran;
  const rowsG = ST_GROUPS.filter((g) => U.some((u) => u.group === g.id)).concat(U.some((u) => u.group === "ungrouped") ? [{ id: "ungrouped", label: GROUP_LABEL.ungrouped }] : []);
  const nRuc = U.filter((u) => u.ruc).length, rn = window.CX.rucNote(nRuc, nRuc === 1 ? "unit" : "units");
  const nRan = U.filter((u) => u.ran).length, right = U.filter((u) => !u.ruc && !surprise(u)).length;
  window.CX.setNote($("ct-units-note"), `Combustion turbines mostly sit off and start for a few high-priced hours, so for them the question is the price that gets them going, not the loss that turns them off. Each row is a turbine that was offline going into some hour of the day. The diamond is the peak day-ahead price at its node that the operator model needs before it expects a start; the circle is the peak that actually came (filled: it started; hollow: it stayed off). A filled circle right of its diamond is the model and the operator agreeing. ` +
    `On ${fmtDate(parseDate(S.date))}, ${nRan} of ${U.length} started; the model called ${right} of ${U.length - nRuc} right.${rn} Click a unit to open it.`,
    `${U.length} combustion turbines were available and offline going into some hour of the day (Peaker marks the ones that run like peakers). ${CT_NOTE}` +
    `To find the diamond, every price at the unit's node (day-ahead and real-time) is raised or lowered by the same amount until the model gives a 50% chance of a start in at least one of the hours the unit was offline going into; the diamond is the day's peak day-ahead price at that shift. The circle is the day's actual peak day-ahead price at its node. A diamond left of the circle means the model starts it that day; a diamond at the right edge means no shift up to $5,000/MWh produced a start.\n\n` +
    `Hour by hour the model is weak: over Mar to Aug 2026 it caught about 15% of starts in the hour they came, and about 60% of the starts it called happened (the real-time fit it replaced caught more, but called four false starts for every real one). Over a whole day it does better: over Feb to Aug 2026 it called 45% of the days a unit started, and on about 80% of the days it called a start the unit did start. Prices beyond the edges are drawn at the edge.`);
  $("ct-units-legend").innerHTML = `<span><span class="sw" style="background:var(--c1);transform:rotate(45deg) scale(0.8)"></span>Model starts it above this day-ahead price</span>` +
    window.CX.onOffLegend("Day's highest day-ahead price, started", "Day's highest day-ahead price, stayed off") +
    `<span><span class="sw" style="background:var(--c8);height:3px"></span>Surprise: the unit did the opposite of the model</span>` + (nRuc ? window.CX.rucLegend() : "");
  const vals = U.flatMap((u) => (u.s == null ? [u.p] : [u.s, u.p]));
  const x0 = Math.min(0, d3.quantile(vals.sort(d3.ascending), 0.01)), x1 = Math.max(100, d3.quantile(vals, 0.99));
  const w = Math.max(280, el.clientWidth || 600), lane = 6, rowGap = 26;
  const per = rowsG.map((g) => U.filter((u) => u.group === g.id).sort((a, b) => (a.s ?? Infinity) - (b.s ?? Infinity)));
  const m = { t: 8, b: 30, ...CUT_M }, H = m.t + m.b + d3.sum(per, (us) => rowGap + us.length * lane);
  const x = d3.scaleSymlog().constant(10).domain([x0, x1]).range([m.l, w - m.r]).clamp(true);
  const xT = [-100, -25, 0, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000].filter((v) => v >= x0 && v <= x1);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`).attr("data-nopin", "");
  svg.append("g").attr("class", "gridline").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickValues(xT).tickSize(-(H - m.t - m.b)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickValues(w < 560 ? xT.filter((v, i) => i % 2 === 0) : xT).tickFormat(fmtPrice0).tickSizeOuter(0));
  const diamond = d3.symbol(d3.symbolDiamond, 26)();
  let top = m.t;
  rowsG.forEach((g, gi) => {
    const us = per[gi];
    if (gi) svg.append("line").attr("x1", m.l).attr("x2", w - m.r).attr("y1", top).attr("y2", top).attr("stroke", css("--line"));
    svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", top + 14).text(g.label.replace("Daily, ", "Daily: "));
    us.forEach((u, k) => {
      const yy = top + rowGap - 4 + k * lane + lane / 2, bad = surprise(u);
      const gU = svg.append("g").style("cursor", "pointer")
        .on("pointermove", (ev) => showTip(ev, `<h4>${esc(u.unit)}</h4>${g.label}${window.CX.isPeaker(S.G, u.unit) ? " · Peaker" : ""}<br>${u.s == null ? "No shift up to $5,000/MWh starts it" : `Model starts it once the day's highest day-ahead node price reaches ${fmt$(u.s)}/MWh`} (fitted on ${u.win} days)<br>` +
          `Day's highest day-ahead price at its node ${fmt$(u.p)}/MWh<br><b>${u.ran ? `Started; online ${u.on} of ${u.av} hours judged` : `Stayed off (${u.off} hours offline going in)`}</b>${bad ? "<br>Did the opposite of the model" : ""}${u.ruc ? `<br>Committed by ERCOT (RUC) ${u.ruc} h: not counted for or against the model` : ""}<br><span class="tip-pin-note">Click to open the unit</span>`))
        .on("pointerleave", hideTip)
        .on("click", () => { location.href = unitHref(u.unit); });
      const xs = u.s == null ? w - m.r : x(u.s);
      gU.append("line").attr("x1", Math.min(xs, x(u.p))).attr("x2", Math.max(xs, x(u.p))).attr("y1", yy).attr("y2", yy).attr("stroke", css(bad ? "--c8" : "--line")).attr("stroke-width", bad ? 1.8 : 1.2);
      gU.append("path").attr("d", diamond).attr("transform", `translate(${xs},${yy})`).attr("fill", css("--c1"));
      window.CX.onOffDot(gU.append("circle").attr("cx", x(u.p)).attr("cy", yy), u.ran, 3);
      if (u.ruc) window.CX.rucRing(gU.append("circle").attr("cx", x(u.p)).attr("cy", yy), 5.5);
    });
    top += rowGap + us.length * lane;
  });
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", H - 2).attr("text-anchor", "end").text("Day-ahead price at the unit's node, $/MWh");
  el.replaceChildren(svg.node());
  setCSV(el, ["unit", "group", "turn_on_usd_mwh", "day_peak_da_usd_mwh", "started", "hours_on", "hours_judged", "hours_off_going_in", "fit_days", "ruc_hours"],
    U.map((u) => [u.unit, u.group, u.s, u.p, u.ran ? 1 : 0, u.on, u.av, u.off, u.win, u.ruc]), `Peaker turn-on points ${S.date}`);
}

// the combustion turbines on the day: those online going in (data/decisions.json.gz) and those with a
// turn-on point (data/peaker/oi.json.gz, the chart above), each with its group
function ctDay(d) {
  const M = new Map(), P = S.POI, rows = P?.days?.[d] || [];
  const at = (u) => M.get(u) || M.set(u, { unit: u, group: S.G?.units?.[u]?.[1] || "ungrouped", ruc: rucOn(u, d) }).get(u);
  (decisionDays().get(d) || []).forEach((r) => {
    const dec = decisionOf(r[DAY_F.unit]);
    if (!dec || !(dec.lsl > 0) || dec.tech !== "combustion_turbine") return;
    Object.assign(at(r[DAY_F.unit]), { going: true, lsl: dec.lsl, did: r[DAY_F.shut] ? "off" : "on" });
  });
  if (P) {
    const C = Object.fromEntries(P.columns.map((c, i) => [c, i]));
    rows.forEach((r) => Object.assign(at(r[C.unit]), { fit: true, s: r[C.turn_on], p: r[C.peak], ran: !!r[C.started] }));
  }
  return [...M.values()];
}

// the groups on the day: the coal, gas steam and CC units online going in and what they did, with the
// model's turn-off points and how many of its calls that day were right; then the combustion turbines
// with the model's turn-on points; then all thermal on the columns the two share
function drawGroups() {
  const el = $("groups-table"), U = dayUnits(S.date), V = ctDay(S.date);
  if (!U.length && !V.length) { $("groups-note").textContent = ""; return emptyMsg(el, "No decision data for this day."); }
  const ids = (byG) => [...ST_GROUPS.map((g) => g.id), "ungrouped"].filter((g) => byG.has(g));
  const shared = (us) => { const on = us.filter((u) => u.going !== false), off = on.filter((u) => u.did === "off");
    return { n: on.length, lsl: d3.sum(on, (u) => u.lsl), nOff: off.length, lslOff: d3.sum(off, (u) => u.lsl) }; };
  const byU = d3.group(U, (u) => u.group);
  const rows = ids(byU).map((g) => {
    const us = byU.get(g), mod = us.filter((u) => u.l != null), cut = mod.filter((u) => u.kind === "cut");
    return { b: "turn_off", g, ...shared(us), nMod: mod.length,
      medCut: cut.length ? d3.median(cut, (u) => u.c) : null, medSave: mod.length ? d3.median(mod, (u) => u.l) : null,
      right: mod.filter((u) => !rucOn(u.unit, S.date) && (u.kind === "cut" && u.l > u.c) === (u.did === "off")).length,
      nJudged: mod.filter((u) => !rucOn(u.unit, S.date)).length };
  });
  const byV = d3.group(V, (u) => u.group);
  const ctRows = ids(byV).map((g) => {
    const us = byV.get(g), fit = us.filter((u) => u.fit), judged = fit.filter((u) => !u.ruc);
    return { b: "combustion_turbine", g, ...shared(us.filter((u) => u.going)), nFit: fit.length, nRan: fit.filter((u) => u.ran).length,
      medStart: fit.some((u) => u.s != null) ? d3.median(fit.filter((u) => u.s != null), (u) => u.s) : null, medPeak: fit.length ? d3.median(fit, (u) => u.p) : null,
      right: judged.filter((u) => (u.s != null && u.s <= u.p) === u.ran).length, nJudged: judged.length };
  });
  const sum = (rs, k) => d3.sum(rs, (r) => r[k]);
  const nAny = V.filter((u) => u.fit).length;
  $("groups-title-note").textContent = fmtDate(parseDate(S.date));
  const lslAll = sum(rows, "lsl"), onRow = rows.find((r) => r.g === "never");
  window.CX.setNote($("groups-note"), `The two charts above rolled up by flexibility group (how often a unit has shut down on price), to show which groups hold the day's minimum output and whether the model's calls hold up within each. ` +
    (onRow && lslAll ? `On ${fmtDate(parseDate(S.date))} the always-on group held ${fmtMW(onRow.lsl)} of the ${fmtMW(lslAll)} MW of coal, gas steam and combined-cycle minimum output online going in (${fmtPct(onRow.lsl / lslAll)}), and ${onRow.nOff ? `${onRow.nOff} of its units turned off` : "none of it turned off"}. ` : "") +
    `The first block covers coal, gas steam and combined cycles (turn-off points); the second covers combustion turbines, which mostly start from off and so get turn-on points.`, `Thermal units by how often they have turned off on price over the ${S.G ? S.G.dates.length : ""} days of 60-day data (pipeline/groups.py). Minimum output is the unit's LSL; online going in and turned off count units online going into the day and offline in some hour of it (combined-cycle configurations merged into their train). ` +
    `The turn-off rows cover coal, gas steam and combined cycles; their model columns cover the CC trains and gas steam units with a turn-off point that day: the median turn-off point and the median loss from staying on they faced, per MW of LSL, and how many the model called right (off when the loss was past its turn-off point), leaving out units ERCOT committed by RUC that day. ${SAVING_NOTE} ` +
    `Combustion turbines mostly start from off rather than stay on, so instead of a turn-off point their rows count the ${nAny} offline going into some hour of the day and how many started, the median of the operator model's turn-on points and of the day's highest day-ahead price at their nodes, and how many the model called right (RUC left out), as in the turn-on chart above. Some units that run like peakers are gas steam or combined cycles; they stay in the turn-off rows.`);
  const tdG = (r) => `<td class="t"><span class="sw" style="background:var(${FLOOR_GROUPS.find((f) => f.id === r.g)?.color || "--c-other"});margin-right:6px"></span>${GROUP_LABEL[r.g]}<br><span class="muted">${ST_GROUPS.find((g) => g.id === r.g)?.note || "too little history to place"}</span></td>`;
  const tdS = (r) => `<td>${r.n || "–"}</td><td>${r.n ? fmtMW(r.lsl) : "–"}</td><td>${r.n ? r.nOff : "–"}</td><td>${r.n ? fmtMW(r.lslOff) : "–"}</td>`;
  const b = (v) => `<b>${v}</b>`;
  const tot = (label, rs, rest) => `<tr><td class="t">${b(label)}</td><td>${b(sum(rs, "n"))}</td><td>${b(fmtMW(sum(rs, "lsl")))}</td><td>${b(sum(rs, "nOff"))}</td><td>${b(fmtMW(sum(rs, "lslOff")))}</td>${rest}</tr>`;
  const head = (cols) => cols.map((c, i) => `<th${i ? "" : ' class="t"'} style="position:static">${c}</th>`).join("");
  const SH = ["Online going in", "Minimum output (LSL), MW", "Turned off", "LSL turned off, MW"];
  el.innerHTML = `<table class="data"><thead><tr>${head(["Coal, gas steam and CC", ...SH, "With a turn-off point", "Median turn-off point, $/MW of LSL", "Median loss from staying on, $/MW of LSL", "Model right"])}</tr></thead><tbody>` +
    rows.map((r) => `<tr>${tdG(r)}${tdS(r)}<td>${r.nMod || "–"}</td><td>${fmtPerMW(r.medCut)}</td><td>${fmtPerMW(r.medSave)}</td><td>${r.nMod ? `${r.right} of ${r.nJudged}` : "–"}</td></tr>`).join("") +
    tot("Coal, gas steam and CC", rows, `<td>${b(sum(rows, "nMod") || "–")}</td><td></td><td></td><td>${b(sum(rows, "nJudged") ? `${sum(rows, "right")} of ${sum(rows, "nJudged")}` : "–")}</td>`) +
    (ctRows.length ? `<tr>${head(["Combustion turbines (start on price)", ...SH, "Offline in some hour · started", "Median turn-on point, $/MWh", "Median day's peak day-ahead price, $/MWh", "Model right"])}</tr>` +
      ctRows.map((r) => `<tr>${tdG(r)}${tdS(r)}<td>${r.nFit ? `${r.nFit} · ${r.nRan} started` : "–"}</td><td>${r.nFit ? fmt$(r.medStart) : "–"}</td><td>${r.nFit ? fmt$(r.medPeak) : "–"}</td><td>${r.nJudged ? `${r.right} of ${r.nJudged}` : "–"}</td></tr>`).join("") +
      tot("Combustion turbines", ctRows, `<td>${b(sum(ctRows, "nFit") ? `${sum(ctRows, "nFit")} · ${sum(ctRows, "nRan")} started` : "–")}</td><td></td><td></td><td>${b(sum(ctRows, "nJudged") ? `${sum(ctRows, "right")} of ${sum(ctRows, "nJudged")}` : "–")}</td>`) : "") +
    tot("All thermal", rows.concat(ctRows), `<td></td><td></td><td></td><td></td>`) + `</tbody></table>`;
  setCSV(el, ["block", "group", "online_going_in", "lsl_mw", "turned_off", "lsl_turned_off_mw", "units_modelled", "median_turn_off_usd_per_mw_lsl", "median_saving_usd_per_mw_lsl", "model_right",
    "offline_some_hour", "started", "median_turn_on_usd_mwh", "median_day_peak_da_usd_mwh", "model_right"],
    rows.map((r) => [r.b, r.g, r.n, r.lsl, r.nOff, r.lslOff, r.nMod, r.medCut, r.medSave, r.right, null, null, null, null, null])
      .concat(ctRows.map((r) => [r.b, r.g, r.n, r.lsl, r.nOff, r.lslOff, null, null, null, null, r.nFit, r.nRan, r.medStart, r.medPeak, r.right])), `Groups ${S.date}`);
}

// ==== the operator model's scorecard (data/operator/scores.json.gz, pipeline/models/operator_scores.py) ====
// one row per period: the months of the 60-day fits, then each year before them, judged by the
// reduced fits on the thermal history and its day-ahead resource status; combustion turbines from
// the peaker model's own scores (data/peaker/oi.json.gz, pipeline/models/peaker_oi.py), same columns
function drawScores() {
  const ct = S.scTech === "combustion_turbine";
  const el = $("sc-table"), sc = ct ? (S.POI ? { rows: S.POI.scores, columns: S.POI.score_columns, cheap: 10, live_from: S.OSC?.live_from } : null) : S.OSC;
  if (!sc || !sc.rows?.length) { $("sc-note").textContent = ""; return emptyMsg(el, "No scorecard yet. It is built by the data update workflow."); }
  setSeg("sc-cell", S.scCell);
  const ci = Object.fromEntries(sc.columns.map((c, i) => [c, i]));
  const liveM = (sc.live_from || "0000-00").slice(0, 7);
  const period = (m) => (ct ? m : m >= liveM ? "live" : m.slice(0, 4));     // combustion turbines: month by month
  const keep = (r) => r[ci.model] === "operator" && r[ci.tech] === S.scTech && (S.scCell === "all" || (S.scCell === "cheap" ? r[ci.cheap] === 1 : S.scCell === "noaward" ? r[ci.award] === 0 : r[ci.start] === S.scCell));
  const T = new Map();
  sc.rows.filter(keep).forEach((r) => {
    const k = period(r[ci.month]);
    if (!T.has(k)) T.set(k, { months: [] });
    const t = T.get(k);
    t.months.push(r[ci.month]);
    sc.columns.slice(6).forEach((c) => { t[c] = (t[c] || 0) + (r[ci[c]] || 0); });
  });
  const keys = [...T.keys()].sort((a, b) => (a === "live" ? -1 : b === "live" ? 1 : b.localeCompare(a)));
  const span = (t) => { const ms = t.months.sort(); return ms[0] === ms.at(-1) ? fmtMonth(ms[0]) : `${fmtMonth(ms[0])} to ${fmtMonth(ms.at(-1))}`; };
  const label = (k) => (ct ? fmtMonth(k) : k === "live" ? `${span(T.get(k))}, 60-day fits` : new Set(T.get(k).months).size < 12 ? span(T.get(k)) : k);
  const pct = (a, b) => (b ? d3.format(".1%")(a / b) : "–");
  const ev = (t, k) => (t[`${k}_n`] ? `${d3.format(",")(t[`${k}_caught`])} of ${d3.format(",")(t[`${k}_n`])}` : "–");
  const fl = (t, k) => (t[`${k}_n`] != null ? d3.format(",")(t[`${k}_false`] || 0) : "–");
  const nRuc = d3.sum([...T.values()], (t) => t.ruc_hours || 0);
  if (ct) window.CX.setNote($("sc-note"), `A check on the model behind the turbine chart above: month by month, how often its on/off call for each hour matched what the turbine did, and how many actual starts and stops it caught against the calls it made that never happened. "Hours right" is flattered, because a unit that simply stays as it was is right about 97% of the time; the caught and false columns are the real test.`, `Every hour of every combustion turbine (and recip engine) that was online or offline in SCED both in it and the hour before, with its day-ahead record and the three real-time hours before at its node, scored against what it did. Unlike the CC and gas steam rows, each hour is judged from the true state before it, the decision its operator faced that hour: the call is a start (from offline) or a stop (from online) when the model's chance of one is 50% or more, and it is caught only in the hour it happened. ${CT_NOTE}${nRuc ? `${d3.format(",")(nRuc)} RUC hours in the rows shown are left out. ` : ""}Staying as it was would get about 97% of hours right and catch nothing, so the turn-ons and turn-offs are the test. "Cheap" is an hour with day-ahead system lambda at $${sc.cheap}/MWh or less; "Unit was on" and "Unit was off" are its state before the hour. Brier is the mean squared error of the model's chance online (lower is better).`);
  else window.CX.setNote($("sc-note"), `A check on the model behind the turn-off chart above. For every scored hour, whether the model's on/off call matched what the unit did; and for every actual shutdown and start, whether the model called it within an hour, against how many calls it made that never happened. "Hours right" is flattered, because a unit that simply stays as it was is right about 97% of the time; the caught and false columns are the real test. The months of the 60-day fits come first, then each year before them.`, `Every hour of every CC train or gas steam unit on a day with an operator day file, scored against what it did (outage and unknown hours left out, and days a unit went into on outage). Hours ERCOT had the unit committed by RUC are ERCOT's call, not the operator's: they are left out of the fits and of every column here, and a switch into or out of one counts neither as caught nor as false${nRuc ? ` (${d3.format(",")(nRuc)} RUC hours in the rows shown; ERCOT's unit status before Dec 2025 isn't kept, so earlier years can't leave them out)` : ""}. The model's call is on when its chance online is 50% or more; it is fitted monthly on earlier days only. From ${fmtDate(parseDate(sc.live_from || liveM + "-01"))} it is fitted on the 60-day data since Dec 2025. Before that, each month is fitted on the 12 months before it from the thermal history files and the day-ahead resource status (read from our own copies of the 60-day DAM disclosure), with Henry Hub standing in for the unit's own gas hub (Ship Channel or Waha) where none is stored. A turn-off or turn-on is caught when the call switches the same way within 1 hour of the actual switch; a call's switch that matches none is false. "Cheap" is an hour with day-ahead system lambda at $${sc.cheap}/MWh or less, and for a switch, any such hour within 3 hours of it. (Day-ahead lambda here, because that is what the operator knew; the across-days panels below use real-time lambda.) Brier is the mean squared error of the model's chance (lower is better).`);
  el.innerHTML = `<table class="data"><thead><tr><th class="t">Period</th><th>Hours right</th><th>Turn-offs caught</th><th>False turn-offs</th><th>Turn-ons caught</th><th>False turn-ons</th><th>Brier score (lower is better)</th></tr></thead><tbody>` +
    keys.map((k) => { const t = T.get(k); return `<tr><td class="t">${label(k)}</td><td>${pct(t.right, t.hours)}</td><td>${ev(t, "off")}</td><td>${fl(t, "off")}</td><td>${ev(t, "on")}</td><td>${fl(t, "on")}</td><td>${t.hours ? d3.format(".3f")(t.brier / t.hours) : "–"}</td></tr>`; }).join("") + `</tbody></table>`;
  setCSV(el, ["period", "hours", "hours_right", "off_n", "off_caught", "off_false", "on_n", "on_caught", "on_false", "brier_sum"],
    keys.map((k) => { const t = T.get(k); return [k === "live" ? span(t) : k, t.hours, t.right, t.off_n, t.off_caught, t.off_false, t.on_n, t.on_caught, t.on_false, t.brier]; }), `Operator model scorecard ${S.scTech} ${S.scCell}`);
  // years between the first and last listed that have no rows: say so, rather than leave a gap that reads as a bug
  const yrs = keys.filter((k) => /^\d{4}$/.test(k)).map(Number);
  const gap = !ct && yrs.length && d3.range(d3.min(yrs), new Date().getUTCFullYear()).some((y) => !keys.includes(String(y)) && !(T.get("live")?.months || []).some((m) => m.startsWith(String(y))));
  if (gap) el.insertAdjacentHTML("beforeend", `<p class="note">Years not listed have no scored hours for this technology yet.</p>`);
}

// ==== across days: what the decision cost ==================================================
// pipeline/stayon.py: each ride-through of a cheap stretch, what it lost at its own real-time node
// price against its minimum-energy cost, and the restart a shutdown would have needed instead
// (px 0: no node price for the ride, priced at system lambda)
const RIDE = { unit: 0, tech: 1, thr: 2, stretch: 3, mwh: 4, rev: 5, cost: 6, loss: 7, start: 8, saves: 9, est: 10, px: 11 };
function ridesBy(thr) {
  const SO = S.SO;
  if (!SO) return null;
  const ti = SO.cheap.indexOf(thr);
  const out = new Map();
  for (const r of SO.rides) {
    if (r[RIDE.thr] !== ti || r[RIDE.tech] === "nuclear") continue;
    const key = r[RIDE.tech] === "combined_cycle" ? trainOf(r[RIDE.unit]) : r[RIDE.unit];
    let e = out.get(key);
    if (!e) out.set(key, (e = { unit: key, tech: r[RIDE.tech], n: 0, mwh: 0, loss: 0, start: 0, saves: 0, paid: 0, est: 0, lam: 0 }));
    e.n++; e.mwh += r[RIDE.mwh]; e.loss += r[RIDE.loss]; e.start += r[RIDE.start]; e.saves += r[RIDE.saves];
    if (r[RIDE.saves] > 0) e.paid++;
    if (r[RIDE.est]) e.est++;
    if (r[RIDE.px] === 0) e.lam++;
  }
  return out;
}
function drawCost() {
  const el = $("cost-chart"), thr = +S.costThr, by = ridesBy(thr);
  if (!by) { $("cost-note").textContent = ""; return emptyMsg(el, "No data for this panel yet."); }
  const groupOf = (k) => S.G?.units?.[k]?.[1] || "ungrouped";
  const ids = [...ST_GROUPS.map((g) => g.id), "ungrouped"];
  const rows = ids.map((g) => {
    const us = [...by.values()].filter((e) => groupOf(e.unit) === g);
    const sum = (k) => d3.sum(us, (e) => e[k]);
    return { g, units: us.length, n: sum("n"), mwh: sum("mwh"), loss: sum("loss"), start: sum("start"), saves: sum("saves"), paid: sum("paid"), est: sum("est"), lam: sum("lam") };
  }).filter((r) => r.n);
  const nStretch = S.SO.stretches[String(thr)]?.length || 0;
  const fM = (v) => (v < 0 ? "−" : "") + "$" + d3.format(",.1f")(Math.abs(v) / 1e6) + "M";
  const tL = d3.sum(rows, (r) => r.loss), tS = d3.sum(rows, (r) => r.start), tN = d3.sum(rows, (r) => r.n), tP = d3.sum(rows, (r) => r.paid);
  window.CX.setNote($("cost-note"), `Did staying on pay? Every time a coal or gas unit kept running through a stretch of real-time lambda below ${fmtPrice0(thr)}/MWh, what its output lost (its minimum-energy cost less what the real-time price at its node paid), set against what shutting down and restarting would have cost instead. Where the red bar is taller than the blue, staying on was the dearer choice. ` +
    (tN ? `Over ${nStretch} stretches, ${d3.format(",")(tN)} ride-throughs lost ${fM(tL)} against ${fM(tS)} of restarts avoided; shutting down would have paid in ${fmtPct(tP / tN)} of them.` : ""), `Every time a coal or gas unit ran through a stretch of hours with system lambda below ${fmtPrice0(thr)} (${nStretch} stretches of ${S.SO.min_hours} hours or more), what its output lost at its own real-time node price against its own minimum-energy cost, and what a shutdown and restart would have cost instead (hot start for stretches up to ${S.SO.hot_h} hours, intermediate up to ${S.SO.inter_h}, cold beyond). ` +
    `Where the loss is bigger than the restart cost, shutting down would have paid; the difference is the loss above restart cost. Costs are the unit's own day-ahead three-part offer (capped by ERCOT's cost verification, so an upper bound), its latest within ${S.SO.cost_days} days, or a generic value for the technology. Revenue is at the unit's own node, so a unit behind congestion is credited what its energy was worth where it sits; ${(() => { const n = d3.sum(rows, (r) => r.n), l = d3.sum(rows, (r) => r.lam); return l ? `${fmtPct(l / n)} of ride-throughs had no node price and are valued at system lambda` : "every ride-through here has a node price"; })()}. ` +
    `A unit with a turn-off point that keeps riding through stretches where shutting down would have paid may hold contracts, ancillary service obligations or start costs these numbers do not see; the units table at the foot of the page puts each unit's loss above restart cost beside its turn-off point.`);
  const S2 = [
    { id: "loss", label: "Loss from staying on (cost less revenue at its node)", color: "--c8" },
    { id: "start", label: "Restart cost", color: "--c1" },
  ];
  staticLegend($("cost-legend"), S2);
  const w = Math.max(280, el.clientWidth || 600), H = 260, m = { t: 22, r: 16, b: 60, l: 64 };
  const x = d3.scaleBand().domain(rows.map((r) => r.g)).range([m.l, w - m.r]).padding(0.25);
  const xi = d3.scaleBand().domain(S2.map((s) => s.id)).range([0, x.bandwidth()]).padding(0.08);
  const lo = Math.min(0, d3.min(rows, (r) => Math.min(r.loss, r.start))), hi = Math.max(1, d3.max(rows, (r) => Math.max(r.loss, r.start)));
  const y = d3.scaleLinear().domain([lo, hi]).nice().range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y), 5, "$k").tickSizeOuter(0));
  const ax = svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickFormat((g) => GROUP_LABEL[g]).tickSizeOuter(0));
  ax.selectAll(".tick text").each(function (g) {
    const t = GROUP_LABEL[g];
    if (t.length * 6.5 < x.step()) return;
    const sp = t.includes(", ") ? t.indexOf(", ") + 1 : t.includes(": ") ? t.indexOf(": ") + 1 : t.lastIndexOf(" ", Math.ceil(t.length / 2) + 2);
    const tx = d3.select(this).text(null);
    tx.append("tspan").attr("x", 0).attr("dy", "0.71em").text(t.slice(0, sp).trim());
    tx.append("tspan").attr("x", 0).attr("dy", "1.1em").text(t.slice(sp).trim());
  });
  if (lo < 0) svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(0)).attr("y2", y(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text(`Total over all ride-throughs of stretches below ${fmtPrice0(thr)}/MWh, by group`);
  rows.forEach((r) => S2.forEach((s) => {
    const v = r[s.id];
    svg.append("rect").attr("x", x(r.g) + xi(s.id)).attr("width", xi.bandwidth()).attr("y", y(Math.max(0, v))).attr("height", Math.abs(y(v) - y(0)))
      .attr("fill", css(s.color))
      .on("pointermove", (ev) => showTip(ev, `<h4>${GROUP_LABEL[r.g]}</h4>${r.n} ride-throughs by ${r.units} units, ${fmtMW(r.mwh)} MWh<br>Loss from staying on ${fmt$(r.loss)}<br>Restart cost ${fmt$(r.start)}<br>` +
        `<b>${r.saves > 0 ? `Shutting down would have paid by ${fmt$(r.saves)}` : `Staying on was cheaper by ${fmt$(-r.saves)}`}</b><br>Shutting down would have paid in ${fmtPct(r.paid / r.n)} of ride-throughs`))
      .on("pointerleave", hideTip);
  }));
  el.replaceChildren(svg.node());
  $("cost-groups").innerHTML = `<table class="data"><thead><tr><th class="t">Group</th><th>Units</th><th>Ride-throughs</th><th>MWh</th><th>Loss from staying on, $M</th><th>Loss per MWh, $/MWh</th><th>Restart cost, $M</th><th>Loss above restart cost, $M</th><th>Share where shutting down paid</th><th>Share with estimated costs</th></tr></thead><tbody>` +
    rows.map((r) => `<tr><td class="t">${GROUP_LABEL[r.g]}</td><td>${r.units}</td><td>${r.n}</td><td>${fmtMW(r.mwh)}</td><td>${fM(r.loss)}</td><td>${fmtPrice(r.mwh ? r.loss / r.mwh : null)}</td><td>${fM(r.start)}</td><td>${fM(r.saves)}</td><td>${fmtPct(r.paid / r.n)}</td><td>${fmtPct(r.est / r.n)}</td></tr>`).join("") + "</tbody></table>";
  setCSV(el, ["group", "units", "ride_throughs", "mwh", "loss_usd", "start_usd", "saves_usd", "share_shutdown_paid", "share_estimated_costs"],
    rows.map((r) => [r.g, r.units, r.n, Math.round(r.mwh), Math.round(r.loss), Math.round(r.start), Math.round(r.saves), +(r.paid / r.n).toFixed(3), +(r.est / r.n).toFixed(3)]), `What the decision cost, lambda below ${thr}`);
}

// ==== how long units stay on once started (data/min_run_60d.json.gz, pipeline/min_run.py) ======
// each coal and gas unit or train at its typical shortest completed run (10th percentile), with a
// line to its median run, by technology and by plant (units grouped on the site code before the
// first underscore, named from the unit index's CDR plant name). Units with too few completed runs
// are listed in a collapsed table. Dots and rows open the Unit page.
const RUN_TECHS = ["combined_cycle", "gas_steam", "coal", "combustion_turbine"].map((id) => TECHS.find((t) => t.id === id));
const RUN_TICKS = [1, 2, 4, 8, 12, 24, 48, 168, 720];
const fmtRunH = (h) => (h == null ? "–" : h >= 48 ? `${d3.format(h >= 240 ? ",.0f" : ".1f")(h / 24)} d` : `${d3.format(".1f")(h)} h`);
const runTick = (h) => (h === 168 ? "1 wk" : h === 720 ? "30 d" : `${h} h`);
const plantKey = (u) => u.split("_")[0];
function plantName(raw, key) {
  if (!raw) return key;
  const n = raw.replace(/\s*\(.*\)$/, "").replace(/\s+(STG|U|CTG|CT|GT|UNIT|G)\s*\w*$/i, "").trim();
  return n.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) || key;
}
async function runUnits() {
  if (S._runs) return S._runs;
  if (S.UIX === undefined) S.UIX = await window.CX.unitIndex();
  const names = new Map((S.UIX || []).map((u) => [u.unit, u.plant]));
  const MR = S.MR, byPlant = new Map();
  const list = Object.entries(MR.units).map(([unit, v]) => {
    const p = plantKey(unit);
    if (!byPlant.has(p)) byPlant.set(p, []);
    byPlant.get(p).push(names.get(unit));
    return { unit, plant: p, tech: v[0], mw: v[1], p10: v[2], med: v[3], n: v[4], trips: v[5], on: v[6], runs: v[7], s: v[7].length ? v[7][0] : null };
  });
  // the plant's name: the commonest cleaned CDR name among its units
  const pname = new Map([...byPlant].map(([p, ns]) => {
    const c = d3.rollup(ns.map((n) => plantName(n, p)), (v) => v.length, (n) => n);
    return [p, [...c].sort((a, b) => b[1] - a[1])[0][0]];
  }));
  list.forEach((u) => { u.pname = pname.get(u.plant); });
  return (S._runs = list);
}
function runTip(u) {
  return `<h4>${esc(u.unit)}</h4>${esc(u.pname)} · ${techLabel(u.tech)}${u.mw ? ` · ${fmtMW(u.mw)} MW` : ""}<br>` +
    `${u.n} completed run${u.n === 1 ? "" : "s"}, ${u.trips} more ended in an outage<br>` +
    (u.p10 != null ? `Typical shortest run <b>${fmtRunH(u.p10)}</b> · median ${fmtRunH(u.med)} · single shortest ${fmtRunH(u.s)}` : `Too few completed runs to judge (fewer than ${S.MR.min_runs})`) +
    `<br>Click to open the unit`;
}
function runAxis(svg, x, top, bot) {
  const g = svg.append("g").attr("class", "axis"), narrow = x.range()[1] - x.range()[0] < 360;
  for (const t of narrow ? [1, 4, 12, 48, 168] : RUN_TICKS) {
    g.append("line").attr("x1", x(t)).attr("x2", x(t)).attr("y1", top).attr("y2", bot).attr("stroke", css("--grid"));
    g.append("text").attr("x", x(t)).attr("y", bot + 14).attr("text-anchor", "middle").attr("fill", css("--muted")).style("font", "11px var(--font-data)").text(runTick(t));
  }
}
async function drawRuns() {
  const el = $("runs-tech"), pel = $("runs-plant");
  if (!S.MR || !S.MR.units) { emptyMsg(el, "No data for this panel yet."); pel.innerHTML = ""; return; }
  const all = await runUnits(), on = RUN_TECHS.filter((t) => !S.hidden.runs.has(t.id));
  legend($("runs-legend"), RUN_TECHS, S.hidden.runs, drawRuns);
  const D = S.MR.dates, period = `${fmtDate(parseDate(D[0]))} to ${fmtDate(parseDate(D.at(-1)))}`;
  const pct = S.MR.pct, minN = S.MR.min_runs;
  const meds = on.map((t) => [t, d3.median(all.filter((u) => u.tech === t.id && u.p10 != null), (u) => u.p10)]).filter((r) => r[1] != null);
  window.CX.setNote($("runs-note"), `Each coal and gas unit's minimum run time, as its own behavior shows it: the typical shortest run it has made, from start to a shutdown on price (the 10th percentile of its completed runs). A unit that has shown it will run for 6 hours can start for the evening peak and sit out a midday price dip; one that never runs under a day has to ride through. ` +
    (meds.length ? `Median by technology: ${meds.map(([t, m]) => `${t.label.replace(" and recip", "").toLowerCase()} ${fmtRunH(m)}`).join(", ")}. ` : "") + "Click a dot to open the unit.",
    `Each dot is one unit (a combined-cycle train counts as one) at the ${pct}th percentile of its completed runs over ${period} (${D.length} days of 60-day data, up to the last year). ` +
    `A run is a stretch of hours online (at minimum or above) that starts from offline or outage and ends with the unit offline but available. Runs that end in an outage are left out as likely trips, and so are runs cut by missing data or by either end of the period. ` +
    `In a combined-cycle train a single offline hour between hours online is a configuration change, not a shutdown. The ${pct}th percentile is used rather than the single shortest run, which is often an abandoned start or a test; units need ${minN} completed runs to be shown. ` +
    `ERCOT does not publish registered minimum up times, so this is the floor the unit has chosen, not its registered limit: a unit that never ran shorter than 8 hours may be allowed 4. ` +
    `Hourly states round each run to whole hours, so a run can read up to an hour long or short. That matters most for combustion turbines, whose minimum run is often under an hour; they start hidden. The thick line is the median across the technology's units.`);
  // ---- by technology: a jittered strip per technology on a log hours axis
  const w = Math.max(300, el.clientWidth || 600), narrow = w < 560, m = { t: 6, r: 16, b: 24, l: narrow ? 92 : 190 }, rowH = 56;
  const H = m.t + m.b + on.length * rowH;
  const x = d3.scaleLog().domain([0.8, 1500]).range([m.l, w - m.r]).clamp(true);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  runAxis(svg, x, m.t, H - m.b);
  on.forEach((t, i) => {
    const y0 = m.t + i * rowH, us = all.filter((u) => u.tech === t.id && u.p10 != null), nr = all.filter((u) => u.tech === t.id && u.p10 == null).length;
    svg.append("text").attr("x", 0).attr("y", y0 + rowH / 2 - 4).attr("fill", css("--ink")).style("font", "500 12px var(--font-ui)").text(narrow ? t.label.replace(" and recip", "").replace("Combustion turbine", "CT") : t.label.replace(" and recip", ""));
    svg.append("text").attr("x", 0).attr("y", y0 + rowH / 2 + 11).attr("fill", css("--muted")).style("font", "11px var(--font-ui)").text(`${us.length} unit${us.length === 1 ? "" : "s"}${narrow ? "" : ` · ${nr} with too few runs to judge`}`);
    us.forEach((u, j) => {
      const jit = (((j * 0.618) % 1) - 0.5) * (rowH - 22);
      svg.append("circle").attr("cx", x(u.p10)).attr("cy", y0 + rowH / 2 - 6 + jit).attr("r", 4).attr("fill", css(t.color)).attr("fill-opacity", 0.8)
        .attr("stroke", css("--surface")).attr("stroke-width", 1.5).style("cursor", "pointer")
        .on("pointermove", (ev) => showTip(ev, runTip(u))).on("pointerleave", hideTip).on("click", () => { location.href = unitHref(u.unit); });
    });
    const md = d3.median(us, (u) => u.p10);
    if (md != null) {
      svg.append("line").attr("x1", x(md)).attr("x2", x(md)).attr("y1", y0 + 4).attr("y2", y0 + rowH - 12).attr("stroke", css("--ink")).attr("stroke-width", 2).style("pointer-events", "none");
      svg.append("text").attr("x", x(md) + 5).attr("y", y0 + rowH - 12).attr("fill", css("--ink")).attr("paint-order", "stroke").attr("stroke", css("--surface")).attr("stroke-width", 4)
        .style("font", "500 11px var(--font-data)").style("pointer-events", "none").text(`median ${fmtRunH(md)}`);
    }
  });
  if (!on.length) emptyMsg(el, "Pick a technology above."); else el.replaceChildren(svg.node());
  const shown = all.filter((u) => u.p10 != null && on.some((t) => t.id === u.tech));
  setCSV(el, ["unit", "plant", "technology", "capacity_mw", `p${pct}_run_h`, "median_run_h", "shortest_run_h", "completed_runs", "runs_ended_in_outage", "online_share_of_available_hours"],
    shown.map((u) => [u.unit, u.pname, u.tech, u.mw, u.p10, u.med, u.s, u.n, u.trips, u.on]), "Typical shortest run by unit");
  drawRunPlants(all, on, x, period);
  drawRunsHidden(all, on);
}
function drawRunPlants(all, on, x0, period) {
  const el = $("runs-plant"), pct = S.MR.pct;
  const ids = new Set(on.map((t) => t.id));
  $("runs-plant-legend").innerHTML = `<span><svg width="14" height="10"><circle cx="7" cy="5" r="4" fill="${css("--ink-2")}"/></svg>Typical shortest run (${pct}th percentile)</span>` +
    `<span><svg width="24" height="10"><line x1="1" x2="23" y1="5" y2="5" stroke="${css("--ink-2")}" stroke-width="2" stroke-opacity="0.45"/></svg>On to the median run</span>` +
    `<span><svg width="8" height="12"><line x1="4" x2="4" y1="1" y2="11" stroke="${css("--muted")}" stroke-width="1.5"/></svg>Single shortest run</span>`;
  const byP = d3.group(all.filter((u) => ids.has(u.tech) && u.p10 != null), (u) => u.plant);
  const ti = Object.fromEntries(RUN_TECHS.map((t, i) => [t.id, i]));
  let ps = [...byP].map(([p, us]) => ({ p, name: us[0].pname, us: us.sort((a, b) => a.p10 - b.p10), min: d3.min(us, (u) => u.p10), mw: d3.sum(us, (u) => u.mw || 0), t: us[0].tech }));
  const sort = $("runs-sort").value;
  ps.sort(sort === "name" ? (a, b) => a.name.localeCompare(b.name) : sort === "mw" ? (a, b) => b.mw - a.mw : (a, b) => a.min - b.min || ti[a.t] - ti[b.t] || a.name.localeCompare(b.name));
  const n = d3.sum(ps, (p) => p.us.length);
  window.CX.setNote($("runs-plant-note"), `The same units grouped by plant, to see whether sister units are run alike. ${ps.length} plants, ${n} units; hover for the numbers, click a row to open the unit.`, `Units are grouped by the site code at the start of their ERCOT resource name, named from ERCOT's Capacity, Demand and Reserves report. ` +
    `The dot is the unit's ${pct}th-percentile completed run over ${period}, the line runs on to its median run, and the tick marks its single shortest run when that is shorter. A plant can mix technologies.`);
  if (!n) { emptyMsg(el, "No units to show for these technologies."); return; }
  const w = Math.max(300, el.clientWidth || 600), narrow = w < 560, m = { t: 6, r: 16, b: 24, l: narrow ? 120 : 250 }, rh = 17, gapP = 6;
  const H = m.t + m.b + n * rh + ps.length * gapP;
  const x = d3.scaleLog().domain(x0.domain()).range([m.l, w - m.r]).clamp(true);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  runAxis(svg, x, m.t, H - m.b);
  let y = m.t + 2;
  for (const P of ps) {
    svg.append("line").attr("x1", 0).attr("x2", w - m.r).attr("y1", y - 3).attr("y2", y - 3).attr("stroke", css("--line"));
    P.us.forEach((u, i) => {
      const cy = y + rh / 2, col = css(TECHS.find((t) => t.id === u.tech).color);
      if (i === 0) svg.append("text").attr("x", 0).attr("y", cy + 4).attr("fill", css("--ink")).style("font", "12px var(--font-ui)").text(P.name.length > (narrow ? 15 : 26) ? P.name.slice(0, narrow ? 14 : 25) + "…" : P.name);
      if (!narrow) svg.append("text").attr("x", m.l - 8).attr("y", cy + 4).attr("text-anchor", "end").attr("fill", css("--muted")).style("font", "10px var(--font-data)").text(u.unit.slice(P.p.length + 1, P.p.length + 13) || u.unit);
      svg.append("line").attr("x1", x(u.p10)).attr("x2", x(u.med)).attr("y1", cy).attr("y2", cy).attr("stroke", col).attr("stroke-width", 2).attr("stroke-opacity", 0.45);
      if (u.s != null && u.s < u.p10) svg.append("line").attr("x1", x(u.s)).attr("x2", x(u.s)).attr("y1", cy - 5).attr("y2", cy + 5).attr("stroke", css("--muted")).attr("stroke-width", 1.5);
      svg.append("circle").attr("cx", x(u.p10)).attr("cy", cy).attr("r", 4.5).attr("fill", col).attr("stroke", css("--surface")).attr("stroke-width", 1.5);
      svg.append("rect").attr("x", 0).attr("y", y).attr("width", w - m.r).attr("height", rh).attr("fill", "transparent").style("cursor", "pointer")
        .on("pointermove", (ev) => showTip(ev, runTip(u))).on("pointerleave", hideTip).on("click", () => { location.href = unitHref(u.unit); });
      y += rh;
    });
    y += gapP;
  }
  el.replaceChildren(svg.node());
  setCSV(el, ["plant", "unit", "technology", "capacity_mw", `p${pct}_run_h`, "median_run_h", "shortest_run_h", "completed_runs", "runs_ended_in_outage"],
    ps.flatMap((P) => P.us.map((u) => [P.name, u.unit, u.tech, u.mw, u.p10, u.med, u.s, u.n, u.trips])), "Typical shortest run by plant");
}
function drawRunsHidden(all, on) {
  const ids = new Set(on.map((t) => t.id)), minN = S.MR.min_runs;
  const list = all.filter((u) => ids.has(u.tech) && u.p10 == null).sort((a, b) => (b.on ?? -1) - (a.on ?? -1));
  $("runs-nr-count").textContent = `${list.length} unit${list.length === 1 ? "" : "s"}`;
  $("runs-nr-note").textContent = `Units with fewer than ${minN} completed runs in the period. Most stay on whenever they are available, so the data never shows how short a run they would accept. Click a row to open the unit.`;
  const el = $("runs-nr-table");
  el.innerHTML = list.length ? `<table class="data"><thead><tr><th class="t">Unit</th><th class="t">Plant</th><th class="t">Technology</th><th>Capacity MW</th><th>Completed runs</th><th>Ended in outage</th><th>Online, share of available hours</th></tr></thead><tbody>` +
    list.map((u) => `<tr data-unit="${esc(u.unit)}" style="cursor:pointer"><td class="t">${esc(u.unit)}</td><td class="t">${esc(u.pname)}</td><td class="t">${techLabel(u.tech)}</td><td>${u.mw ? fmtMW(u.mw) : "–"}</td><td>${u.n}</td><td>${u.trips}</td><td>${u.on == null ? "–" : fmtPct(u.on)}</td></tr>`).join("") + "</tbody></table>"
    : `<p class="empty">None for these technologies.</p>`;
  setCSV(el, ["unit", "plant", "technology", "capacity_mw", "completed_runs", "runs_ended_in_outage", "online_share_of_available_hours"], list.map((u) => [u.unit, u.pname, u.tech, u.mw, u.n, u.trips, u.on]), "Minimum run: too few runs to tell");
}

// ==== the units table ======================================================================
// one row per coal and gas unit or train: its group and its operator-informed turn-off point, how its hours
// split between states, what it did in cheap stretches and what riding through them cost,
// and what it did on the chosen day. Rows open the Unit page.
const STATE_KEYS = [["a", "Above min"], ["m", "At min"], ["0", "Off"], ["o", "Outage"]];
const UNIT_COLS = [
  { k: "unit", h: "Unit", t: 1, f: (r) => esc(r.unit) },
  { k: "tech", h: "Technology", t: 1, f: (r) => techLabel(r.tech) },
  { k: "gi", h: "Group", t: 1, f: (r) => (GROUP_LABEL[r.group] || "–") + pTag(r.unit) },
  { k: "mw", h: "Capacity, MW", f: (r) => fmtMW(r.mw) },
  { k: "lsl", h: "Minimum output (LSL), MW", f: (r) => (r.lsl == null ? "–" : fmtMW(r.lsl)) },
  ...["no award", "award some hours", "award every hour"].map((h, a) => ({ k: "c" + a, h: `Turn-off point, ${h}, $/MW of LSL`, f: (r) => (r["c" + a] === Infinity ? "never" : r["c" + a] == null ? `<span title="No days under this condition">–</span>` : fmtPerMW(r["c" + a])) })),
  { k: "hs", h: "Hot start offer, $/MW of LSL", f: (r) => fmtPerMW(r.hs) + (r.hs != null && r.est === 2 ? "*" : "") },
  { k: "acc", h: "Model right", f: (r) => (r.acc == null ? "–" : `${fmtPct(r.acc)} (${r.nOp} days)`) },
  { k: "days", h: "Decision days · turned off", f: (r) => (r.days == null ? "–" : `${r.days} · ${r.dshut}`) },
  ...STATE_KEYS.map(([s, h]) => ({ k: "st" + s, h: `${h}, share of hours`, f: (r) => (r["st" + s] == null ? "–" : fmtPct(r["st" + s])) })),
  { k: "shut", h: "Shutdowns", f: (r) => r.shut ?? "–" },
  { k: "offP10", h: "Shortest off spell, h (10th pct)", f: (r) => (r.offP10 == null ? "–" : d3.format(",.0f")(r.offP10)) },
  { k: "offShare", h: "Turned off in cheap stretches", f: (r) => (r.offShare == null ? "–" : fmtPct(r.offShare)) },
  { k: "rides", h: "Ride-throughs", f: (r) => r.rides || "–" },
  { k: "saves", h: "Loss above restart cost, $", f: (r) => (r.rides ? `<span title="Loss from staying on ${fmt$(r.rLoss)}, restart cost ${fmt$(r.rStart)}">${fmt$(r.saves)}</span>` : "–") },
  { k: "vi", h: "On the day", t: 1, f: (r) => (r.did ? DID[r.did] : "–") },
];
// each unit's operator-informed turn-off point, one median per day-ahead condition (no award, some
// hours, every hour; riding through when most of its days have none), and how often the model's day call was right
function operatorSummary() {
  if (S._opSum) return S._opSum;
  const out = new Map(), C = S.OC ? Object.fromEntries(S.OC.columns.map((c, i) => [c, i])) : null;
  if (C) for (const [d, rows] of Object.entries(S.OC.days)) for (const r of rows) {
    const u = r[C.unit];
    if (!out.has(u)) out.set(u, { t: [[], [], []], n: 0, right: 0 });
    const o = out.get(u), cut = r[C.turn_off];
    o.t[r[C.award]]?.push(cut == null ? Infinity : cut);
    if (rucOn(u, d)) continue;      // ERCOT's call, not the operator's: not counted for or against the model
    o.n++;
    if ((cut != null && r[C.saving] > cut) === !!r[C.off]) o.right++;
  }
  for (const o of out.values()) o.med = o.t.map((t) => (t.length ? d3.median(t) : null));   // one per day-ahead condition, never pooled
  return (S._opSum = out);
}
async function drawUnits() {
  const el = $("units-table");
  if (!S.I) return emptyMsg(el, "No data for this panel yet.");
  if (!S.UH) { emptyMsg(el, "Loading hourly data…"); await loadUnitHours(); }
  if (!S.UH.dates.length) return emptyMsg(el, "No hourly data.");
  const B = stretchBase(), { rows: resp } = stretchResponses(+S.stThr), by = d3.group(resp, (r) => r.unit);
  const rides = ridesBy(+S.costThr) || new Map();
  // what each unit did on the day, by the turn-off chart's rule: the operator model's flag (offline in
  // any hour, outages aside) where it has a row, else the 2-hour shutdown flag (coal, turbines)
  const opD = opDay(S.date);
  const today = new Map((decisionDays().get(S.date) || []).map((r) => { const o = opD?.get(r[DAY_F.unit]); return [r[DAY_F.unit], (o ? o[6] : r[DAY_F.shut]) ? "off" : "on"]; }));
  let list = [...B.units.values()].filter((e) => e.ran && e.mw > 0).map((e) => {
    const dec = decisionOf(e.unit), g = by.get(e.unit) || [], n = g.length, ri = rides.get(e.unit), did = today.get(e.unit), op = operatorSummary().get(e.unit);
    const cnt = { a: 0, m: 0, "0": 0, o: 0 };
    for (const c of e.st) if (c in cnt) cnt[c]++;
    const nh = cnt.a + cnt.m + cnt["0"] + cnt.o;
    return { unit: e.unit, pick: e.pick, tech: e.tech, group: e.group, gi: ST_GROUPS.findIndex((x) => x.id === e.group), mw: e.mw,
      lsl: dec?.lsl ?? null, c0: op?.med[0] ?? null, c1: op?.med[1] ?? null, c2: op?.med[2] ?? null,
      hs: dec?.hot && dec.lsl ? dec.hot / dec.lsl : null, est: dec?.est ?? null,
      acc: op?.n ? op.right / op.n : null, nOp: op?.n ?? 0,
      days: dec?.days ?? null, dshut: dec?.shut ?? null,
      ...Object.fromEntries(STATE_KEYS.map(([s]) => ["st" + s, nh ? cnt[s] / nh : null])),
      shut: e.shut, offP10: e.offP10, offShare: n >= ST_MIN_N ? g.filter((z) => z.r === "B" || z.r === "D").length / n : null,
      rides: ri?.n || 0, saves: ri ? ri.saves : null, rLoss: ri ? ri.loss : null, rStart: ri ? ri.start : null, did, vi: did ? ["off", "on"].indexOf(did) : null };
  });
  if (S.uTech !== "all") list = list.filter((r) => r.tech === S.uTech);
  if (S.uGroup !== "all") list = list.filter((r) => r.group === S.uGroup);
  const col = UNIT_COLS.find((c) => c.k === S.uSort) || UNIT_COLS[3], dir = S.uDir === "asc" ? 1 : -1;
  list.sort((a, b) => {
    const va = a[col.k], vb = b[col.k];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * dir;
  });
  window.CX.setNote($("units-note"), "One row per coal and gas unit (combined-cycle trains merged): its flexibility group, the model's turn-off point under each day-ahead award condition, how its hours split between states, what it did in cheap stretches, and what riding through them cost. Click a column to sort, a row to open the unit.", `${list.length} coal and gas units, combined-cycle configurations merged into their train, over the ${S.UH.dates.length} days of 60-day data. ` +
    `Turn-off point is the operator model's, as in the chart at the top of the page: the loss from staying on, per MW of LSL, at which the model turns the unit off, the median over its days online going in, kept separate for days with no day-ahead award, an award some hours and an award every hour ("never" when the model keeps it on at any loss tried on most of them; "–" when it had no such days). Model right is how often the model's call at the unit's own loss matched what it did, over its days online going in, leaving out days ERCOT committed it by RUC. CC trains and gas steam units only. ` +
    `Hot start is the start cost in the unit's latest day-ahead offer per MW of LSL, for comparison only (* marks a generic value for the technology); no model uses it. ` +
    `Hours are split between running above minimum, at minimum, offline but available and on outage (an off spell that is mostly outage counts as outage). "Turned off in cheap stretches" is the share of the stretches with lambda below ${fmtPrice0(+S.stThr)} it was running into that it turned off for (shown once it ran into ${ST_MIN_N}), as in the panel above; ride-throughs and the loss above restart cost are from What the decision cost, at lambda below ${fmtPrice0(+S.costThr)}. ` +
    `"On the day" is what the unit did on the chosen day if it was online going in: turned off (offline in some hour of the day, outages aside; for units without an operator model row, coal and combustion turbines, a shutdown of 2 hours or more starting that day), or stayed on, as in the turn-off chart. Click a column to sort, a row to open the unit.`);
  el.innerHTML = `<table class="data"><thead><tr>${UNIT_COLS.map((c) => `<th class="sortable${c.t ? " t" : ""}" data-k="${c.k}" aria-sort="${c.k === col.k ? (dir > 0 ? "ascending" : "descending") : "none"}">${c.h}${c.k === col.k ? (dir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead><tbody>` +
    list.map((r) => `<tr data-href="${unitHref(r.pick)}" style="cursor:pointer">${UNIT_COLS.map((c) => `<td${c.t ? ' class="t"' : ""}>${c.f(r)}</td>`).join("")}</tr>`).join("") + "</tbody></table>";
  setCSV(el, ["unit", "technology", "group", "capacity_mw", "lsl_mw", "turn_off_usd_per_mw_lsl_no_award", "turn_off_usd_per_mw_lsl_award_some_hours", "turn_off_usd_per_mw_lsl_award_every_hour", "hot_start_usd_per_mw_lsl", "model_right", "model_days", "decision_days", "decision_shutdowns",
    "share_above_min", "share_at_min", "share_off", "share_outage", "shutdowns", "p10_hours_off", "share_turned_off_cheap", "ride_throughs", "net_shutdown_saves_usd", "on_the_day"],
    list.map((r) => [r.unit, r.tech, r.group, Math.round(r.mw), r.lsl, ...[r.c0, r.c1, r.c2].map((c) => (c == null ? null : c === Infinity ? "rides through" : +c.toFixed(2))), r.hs == null ? null : +r.hs.toFixed(2), r.acc == null ? null : +r.acc.toFixed(3), r.nOp, r.days, r.dshut,
      ...STATE_KEYS.map(([s]) => (r["st" + s] == null ? null : +r["st" + s].toFixed(3))), r.shut, r.offP10, r.offShare == null ? null : +r.offShare.toFixed(3), r.rides, r.saves == null ? null : Math.round(r.saves), r.did]), "Commitment units");
}

// ==== controls, links, boot ================================================================
// d: a day from the picker, or any day (the picker settles it on the nearest listed day on or before it)
function setDate(d) {
  S.date = S.picker.set(d);
  $("source-note").textContent = "From the 60-day disclosures: each unit's day-ahead award, its loss from staying on, and whether it turned off.";
  saveView();
  drawDay();
  if (S.uSeen) drawUnits();
}
const VIEW_KEYS = { stt: "stTech", stp: "stThr", stu: "stUnit", cht: "cheapTech", chthr: "cheapThr",
  sct: "scTech", scc: "scCell", lr: "leanRank", lm: "leanMonth", lp: "leanPer", cap: "capTech", ct: "costThr", ut: "uTech", ug: "uGroup", us: "uSort", ud: "uDir" };
function saveView() { window.CX.writeHash({ ...window.CX.readHash(), date: S.date, ...Object.fromEntries(Object.entries(VIEW_KEYS).map(([k, sk]) => [k, S[sk]])) }); }
function loadView() { const v = window.CX.readHash(); Object.entries(VIEW_KEYS).forEach(([k, sk]) => { if (v[k] != null) S[sk] = v[k]; }); return v; }

function drawRange() { drawStretch(); drawCapacity(); drawCheap(); drawLean(); drawCost(); drawRuns(); if (S.uSeen) drawUnits(); }
function drawAll() { drawDay(); drawScores(); drawRange(); }

async function boot() {
  [S.T, S.I, S.HC, S.DEC, S.SO, S.IX, S.OC, S.OSC, S.POI] = await Promise.all([tryJSON("data/trends_60d.json.gz"), tryJSON("data/intraday_60d.json.gz"), tryJSON("data/hourly_context_60d.json.gz"),
    tryJSON("data/decisions.json.gz"), tryJSON("data/stayon_60d.json.gz"), tryJSON("data/index.json"), tryJSON("data/operator/cutoffs.json.gz"), tryJSON("data/operator/scores.json.gz"), tryJSON("data/peaker/oi.json.gz")]);
  S.MR = await tryJSON("data/min_run_60d.json.gz");
  // the groups are small and every panel reads them, so they load up front; the hourly strips follow
  const g = await tryJSON("data/groups_60d.json.gz");
  S.G = g && g.units ? g : null;
  // the one-day panels cover the decision days: 60-day days with a DAM file and hourly unit states
  S.days = S.DEC?.dates || [];
  if (!S.days.length || !S.T) { $("status").textContent = "No 60-day data yet. It is built by the data update workflow."; return; }
  const D = S.T.dates;
  S.span = [D[0], D.at(-1)];
  S.last60 = D.at(-1);
  $("status").textContent = `60-day data: ${D.length} days, ${d3.timeFormat("%b %-d, %Y")(parseDate(D[0]))} to ${d3.timeFormat("%b %-d, %Y")(parseDate(D.at(-1)))}`;
  $("range-status").textContent = `${fmtDate(parseDate(D[0]))} to ${fmtDate(parseDate(D.at(-1)))}, the days with 60-day data. Cheap hours in these panels are judged on ERCOT's real-time system price (SCED lambda), not each unit's node price; each panel sets the threshold ($0 or $10/MWh).`;
  const v = loadView();
  S.picker = window.CX.dayPicker("date", { days: S.days, main: true, onChange: setDate });
  const thermal = TECHS.filter((s) => THERMAL.includes(s.id));
  [["cheap-thr", "cheapThr", drawCheap], ["lean-rank", "leanRank", drawLean], ["lean-per", "leanPer", drawLean],
   ["st-thr", "stThr", () => { drawStretch(); if (S.uSeen) drawUnits(); }], ["st-unit", "stUnit", drawStretch],
   ["cost-thr", "costThr", () => { drawCost(); if (S.uSeen) drawUnits(); }], ["sc-cell", "scCell", drawScores]].forEach(([id, key, fn]) => { setSeg(id, S[key]); bindSeg(id, key, fn); });
  bindSelect("cap-tech", "capTech", thermal, drawCapacity);
  bindSelect("sc-tech", "scTech", thermal.filter((t) => ["combined_cycle", "gas_steam", "combustion_turbine"].includes(t.id)), drawScores);
  bindSelect("cheap-tech", "cheapTech", [ALL_THERMAL, ...thermal], drawCheap);
  bindSelect("st-tech", "stTech", [ALL_THERMAL, ...thermal.filter((t) => t.id !== "nuclear")], drawStretch);
  bindSelect("u-tech", "uTech", [{ id: "all", label: "All" }, ...thermal.filter((t) => t.id !== "nuclear")], drawUnits);
  bindSelect("u-group", "uGroup", [{ id: "all", label: "All" }, ...ST_GROUPS.map((x) => ({ id: x.id, label: x.label }))], drawUnits);
  $("units-table").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-k]");
    if (th) { S.uDir = S.uSort === th.dataset.k && S.uDir === "desc" ? "asc" : "desc"; S.uSort = th.dataset.k; saveView(); return drawUnits(); }
    const tr = e.target.closest("tr[data-href]");
    if (tr) location.href = tr.dataset.href;
  });
  $("lean-table").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-href]"); if (tr) location.href = tr.dataset.href; });
  $("runs-sort").onchange = drawRuns;
  ["st-changed", "st-months", "runs-nr-table"].forEach((id) => $(id).addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-unit]");
    if (tr) location.href = unitHref(tr.dataset.unit);
  }));
  // the units table needs the hourly strips: draw it once it is about to scroll into view
  new IntersectionObserver((es, ob) => { if (es.some((e) => e.isIntersecting)) { S.uSeen = true; drawUnits(); ob.disconnect(); } }, { rootMargin: "400px" })
    .observe($("units-table"));
  setDate(v.date || await window.CX.latest60() || S.days.at(-1));
  drawScores();
  drawRange();
  window.CX.init();
  window.CX.panelFromLink?.();
  let t, lastW = 0;
  new ResizeObserver((e) => { const w = Math.round(e[0].contentRect.width); if (w === lastW) return; lastW = w; clearTimeout(t); t = setTimeout(drawAll, 120); }).observe(document.querySelector("main"));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", drawAll);
}
boot();
})();

/* Commitment: which thermal units stay on when power is cheap, and why (site layout plan section
   2.2). One day: the cutoff curve, the six groups with their cutoffs, and the forecast against the
   2-day fit and the 60-day answer, from the day's forecast file (data/forecast/<date>.json.gz,
   index.json.gz, scores.json.gz) and data/fit/<date>.json.gz. Across days: who turns off for cheap
   stretches with the inflexibility tracker, capacity by state, floor-priced MW, thermal output in
   cheap hours and the leanest thermal hours, lifted from trends.js (data/trends_60d.json.gz,
   trends_hourly_60d.json.gz, intraday_60d.json.gz, unit_hours_60d.json.gz, groups_60d.json.gz,
   hourly_context_60d.json.gz, decisions.json.gz); what the decision cost (data/stayon_60d.json.gz);
   and one row per unit. Rows open the Unit page. */
(() => {
"use strict";

const TECHS = [
  { id: "combined_cycle", keys: ["combined_cycle"], label: "Combined cycle", color: "--c1" },
  { id: "combustion_turbine", keys: ["combustion_turbine"], label: "Peakers (CT and recip)", color: "--c2" },
  { id: "wind", keys: ["wind"], label: "Wind", color: "--c3" },
  { id: "solar", keys: ["solar"], label: "Solar", color: "--c4" },
  { id: "nuclear", keys: ["nuclear"], label: "Nuclear", color: "--c5" },
  { id: "gas_steam", keys: ["gas_steam"], label: "Gas steam", color: "--c6" },
  { id: "coal", keys: ["coal"], label: "Coal & lignite", color: "--c8" },
  { id: "other", keys: ["hydro", "other"], label: "Other (hydro, biomass)", color: "--c-other" },
];
const THERMAL = ["nuclear", "coal", "combined_cycle", "gas_steam", "combustion_turbine"];
const FLOOR_TECHS = TECHS.filter((s) => !["wind", "solar"].includes(s.id));   // wind and solar have their own chart
const FLOOR_CAPTIONS = {
  le20_sced: "MW offered at −$20 or below, by technology. For thermal this is almost all minimum output, so it tracks how much is committed.",
  floor_sced: "MW at the −$250 floor in the curves SCED used: mostly nuclear and hydro, which submit no offer curve.",
  floor_submitted: "MW the generators themselves offered at the −$250 floor.",
  le0_sub_lsl: "MW above minimum output that the generators themselves offered at $0 or below.",
};
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
const FLOOR_GROUP_NOTE = "MW priced at or below −$20 in the curves SCED dispatched against, summed over thermal units grouped by how they ran over the whole period (the groups of the cutoff curve and the cheap-stretches panel above; nuclear separately, since it has no offer curve and its whole output sits at the floor). For units that offer, this is almost entirely minimum output (LSL) at ERCOT's placeholder price, so the chart tracks how much minimum load is committed: day-to-day movement is which units are online: the daily groups drive the day-to-day swing and the seasonal group the slow one. Storage, hydro and other resources are left out. Each unit's MW at or below −$20 is its average over the runs it was online that day, counted in the hours it ran.";

// capacity by status from the intraday file (pipeline/intraday.py status_group)
const STATUS6 = [
  { id: "offer", label: "Running on an offer", color: "--c1" },
  { id: "schedule", label: "Running without an offer curve", color: "--c4" },
  { id: "ruc", label: "Committed by ERCOT (RUC)", color: "--c8" },
  { id: "other_on", label: "Other online states (testing, held, starting, stopping)", color: "--c7-soft" },
  { id: "quick", label: "Offline, quick start", color: "--c2" },
  { id: "off", label: "Offline but available", color: "--c-other" },
  { id: "emr", label: "Emergency only", color: "--c5" },
  { id: "out", label: "On outage", color: "--ink-2" },
];

const S = { F: null, FIT: null, FI: null, SC: null, T: null, TH: null, I: null, UH: null, G: null, HC: null, DEC: null, SO: null, days: [], date: null,
  cutBy: "group", floorMode: "le20_sced", floorGroup: "behaviour", floorHours: "all", hidden: { floor: new Set(), floorG: new Set() },
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

// hourly series of a technology group from trends_hourly_60d ([day][24] per key), flattened to
// one value per hour (null when every part is missing)
function techHours(s, src) {
  return S.TH.dates.flatMap((_, i) => d3.range(24).map((h) => {
    const parts = s.keys.map((k) => src[k]?.[i]?.[h]).filter((v) => v != null);
    return parts.length ? d3.sum(parts) : null;
  }));
}
// hourly system lambda on the same days, flattened
const lamHours = () => { const by = new Map(S.I.dates.map((d, i) => [d, S.I.lambda[i]])); return S.TH.dates.flatMap((d) => d3.range(24).map((h) => by.get(d)?.[h] ?? null)); };
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
// hours the floor chart shows: all, or only those with system lambda below a price
const floorKeep = () => { const lam = lamHours(), thr = S.floorHours === "all" ? null : +S.floorHours; return lam.map((v) => thr == null || (v != null && v < thr)); };
async function drawFloor() {
  const byGroup = S.floorGroup === "behaviour";
  $("floor-mode").querySelectorAll("button").forEach((b) => (b.disabled = byGroup && b.dataset.v !== "le20_sced"));
  // all hours: a line per hour; a price filter: one stacked bar per day, averaged over that day's hours below it
  const floorPlot = (el, list, what) => {
    if (S.floorHours === "all") return timeChart(el, list, { title: `${what}, hourly`, H: 280, dates: S.TH.dates, hourly: true });
    const keep = floorKeep(), D = S.TH.dates, thr = fmtPrice0(+S.floorHours);
    const hrs = D.map((_, i) => d3.range(24).filter((h) => keep[i * 24 + h]));
    const day = (vals) => D.map((_, i) => { const v = hrs[i].map((h) => vals[i * 24 + h]).filter((x) => x != null); return v.length ? d3.mean(v) : null; });
    dayBars(el, D, list.map((s) => ({ ...s, values: day(s.values) })), { H: 280, title: `${what}, average over each day's hours with lambda below ${thr}`,
      none: `No hours with lambda below ${thr}`, tipNote: (i) => ` · ${hrs[i].length} hour${hrs[i].length === 1 ? "" : "s"}` });
  };
  const el = $("floor-chart");
  if (byGroup) {
    window.CX.setNote($("floor-note"), "MW offered at −$20 or below, by cycling pattern. For thermal this is almost all minimum output, so it tracks how much is committed.", FLOOR_GROUP_NOTE);
    legend($("floor-legend"), FLOOR_GROUPS, S.hidden.floorG, drawFloor);
    if (!S.I || !S.T.units.some((u) => u.le20)) return emptyMsg(el, "Not built yet. It fills in with the next data update.");
    if (!S.UH) {
      emptyMsg(el, "Loading hourly data…");
      await loadUnitHours();
      if (S.floorGroup !== "behaviour") return;
    }
    // each unit's MW while online, in every hour it ran (unit_hours_60d), summed by group
    const B = stretchBase(), D = S.TH.dates, uh = new Map(S.UH.dates.map((d, i) => [d, i]));
    const ti = new Map(S.T.dates.map((d, i) => [d, i]));
    const sums = new Map(FLOOR_GROUPS.map((g) => [g.id, D.flatMap((d) => d3.range(24).map(() => (S.T.has_units[ti.get(d)] && uh.has(d) ? 0 : null)))]));
    for (const u of S.T.units) {
      const g = u.tech === "nuclear" ? "nuclear" : B.units.get(u.tech === "combined_cycle" ? trainOf(u.unit) : u.unit)?.group;
      const acc = g && sums.get(g), str = S.UH.units[u.unit];
      if (!acc || !u.le20 || !str) continue;
      D.forEach((d, i) => {
        const v = u.le20[ti.get(d)], j = uh.get(d);
        if (v == null || j == null) return;
        for (let h = 0; h < 24; h++) { const c = str[j * 24 + h]; if ((c === "m" || c === "a") && acc[i * 24 + h] != null) acc[i * 24 + h] += v; }
      });
    }
    const list = FLOOR_GROUPS.filter((g) => !S.hidden.floorG.has(g.id)).map((g) => ({ ...g, values: sums.get(g.id).map((v) => (v == null ? null : Math.round(v))) }));
    floorPlot(el, list, "MW at or below −$20 as used, by group");
  } else {
    window.CX.setNote($("floor-note"), FLOOR_CAPTIONS[S.floorMode], FLOOR_NOTES[S.floorMode]);
    legend($("floor-legend"), FLOOR_TECHS, S.hidden.floor, drawFloor);
    const src = S.TH && S.TH.floor[S.floorMode];
    if (!src) return emptyMsg(el, "Not built yet. It fills in with the next data update.");
    const list = FLOOR_TECHS.filter((s) => !S.hidden.floor.has(s.id) && s.keys.some((k) => src[k]));
    floorPlot(el, list.map((s) => ({ ...s, values: techHours(s, src) })), "MW");
  }
  const thr = S.floorHours === "all" ? null : +S.floorHours;
  timeChart($("floor-price"), [{ label: "System lambda", color: "--price", values: lamHours() }],
    { title: `System lambda ($/MWh), hourly${thr == null ? "" : `; the chart above averages the hours below ${fmtPrice0(thr)}`}`, H: 160, dates: S.TH.dates, hourly: true,
      yScale: "symlog", yTicks: [-250, -50, -10, 0, 10, 25, 50, 100, 250, 1000, 5000], yFmt: fmtPrice0, tipFmt: fmtPrice });
}

function drawCapacity() {
  const el = $("cap-chart"), s = TECHS.find((t) => t.id === S.capTech);
  const C = S.I && S.I.tech[S.capTech];
  if (C && C.cap_offer) {
    window.CX.setNote($("cap-note"), "Capacity by unit status each day. Offline but available is the economic choice not to run; outages are not.", "MW of capacity (HSL) by unit status, averaged over each day's SCED runs, from the per-unit 60-day data. \"Offline but available\" is the economic choice not to run; outages are not. Units running without an offer curve (status ONOS) are held to the MW their QSE scheduled; units testing without one are under Other online states. RUC is ERCOT committing a unit for reliability, which is rare. Quick start (OFFQS) is offline capacity SCED can start within the hour; emergency only (EMR, EMRSWGR) is kept for emergencies or can be switched to another grid, so it is not economic capacity.");
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
  window.CX.setNote($("cheap-note"), `Thermal output in hours with lambda below ${fmtPrice0(thr)}, split into minimum output and output above it.`, `Average MW of ${s.label.toLowerCase()} output in the hours each day when system lambda was below ${fmtPrice0(thr)} (${nDays} of ${I.dates.length} days had such hours), split into output up to each running unit's minimum (LSL) and output above it. A unit counts as at minimum when its output is no more than ${fmtPct(I.above_eps)} of its HSL above its LSL. Output at minimum is what the unit cannot shed without shutting down. Nuclear reports a low LSL but runs flat out, so with all thermal selected it is shown whole, and on its own nearly all of it shows as above minimum.`);
  dayBars(el, I.dates, series, { title: `${s.label}: average MW in hours with lambda below ${fmtPrice0(thr)}`, none: `No hours with lambda below ${fmtPrice0(thr)}`,
    tipNote: (i) => ` · ${hrs[i].length} h, ${d3.format(",.0f")(n[i])} units running` });
  // units above minimum (nuclear left out: it always is)
  const rows = I.above_units.filter((r) => r[2] === thr && r[1] !== "nuclear" && ts.includes(r[1]) && r[4] > 0)
    .map((r) => ({ unit: r[0], tech: r[1], run: r[3], above: r[4], mwh: r[5] })).sort((a, b) => b.mwh - a.mwh);
  window.CX.setNote($("cheap-units-note"), `Units that ran above minimum when lambda was below ${fmtPrice0(thr)}, top 30 by energy. Click a row to open the unit.`, `All days together, nuclear left out. ${rows.length} unit${rows.length === 1 ? "" : "s"} ran above minimum in at least one hour with lambda below ${fmtPrice0(thr)}; the top 30 by energy above minimum are listed. Cogeneration and units carrying ancillary services are likely here. Click a row to see the unit.`);
  $("cheap-units").innerHTML = rows.length ? unitRows(rows.slice(0, 30), [
    { h: "Unit", t: 1, f: (r) => esc(r.unit) }, { h: "Technology", t: 1, f: (r) => techLabel(r.tech) },
    { h: `Hours running below ${fmtPrice0(thr)}`, f: (r) => r.run }, { h: "Hours above minimum", f: (r) => r.above },
    { h: "Share", f: (r) => fmtPct(r.above / r.run) }, { h: "Avg MW above minimum", f: (r) => fmtMW(r.mwh / r.above) },
    { h: "MWh above minimum", f: (r) => fmtMW(r.mwh) },
  ]) : `<p class="empty">No units ran above minimum in those hours.</p>`;
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
const ST_GROUPS = [
  { id: "never", label: "Never off", note: "no shutdown in the period" },
  { id: "seasonal", label: "Seasonal: off a week or more", note: "every off spell lasted 7 days or more" },
  { id: "multiday", label: "Multi-day: off 1–7 days", note: "shortest off spell between 24 h and 7 days" },
  { id: "daily1", label: "Daily, under 1 shutdown a week", note: "at least two off spells under 24 h, fewer than one shutdown a week" },
  { id: "daily2", label: "Daily, 1–2 a week", note: "one to two shutdowns a week" },
  { id: "daily3", label: "Daily, over 2 a week", note: "more than two shutdowns a week" },
];
const ST_OUT_MIN_H = 4;                  // an off spell with fewer OFF hours than this, or more OUT than OFF, is an outage
const ST_FLEET = [...ST_RESP, { id: "N", label: "Not running going in", color: "--grid", o: 1 }];
const ST_RANK = { a: 4, m: 3, "0": 2, o: 1, "-": 0 };
const trainOf = (u) => { const m = /^(.*_CC\d+)_/.exec(u); return m ? m[1] : u; };

// hourly per-unit strips and the timescale groups (pipeline/groups.py), loaded together
async function loadUnitHours() {
  const [uh, g] = await Promise.all([tryJSON("data/unit_hours_60d.json.gz"), tryJSON("data/groups_60d.json.gz")]);
  S.UH = uh || { dates: [], units: {} };
  S.G = g && g.units ? g : null;
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
      if (out && (off < ST_OUT_MIN_H || out > off)) for (let i = k; i < j; i++) if (st[i] === "0") st[i] = "o";
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
    // unit that never started seasonal rather than never-off
    { let j = 0, off = 0, gap = 0;
      while (j < N && (st[j] === "0" || st[j] === "o" || st[j] === "-")) { if (st[j] === "0") off++; else if (st[j] === "-") gap++; j++; }
      if (j >= 168 && gap <= off && off >= ST_OUT_MIN_H) long.push(j); }
    // daily needs two pure OFF spells under 24 h (one can be a trip and restart) and is split by
    // shutdowns per week over the period; a lone short spell does not place a unit
    const perWeek = e.shut / (N / 168);
    e.group = short >= 2 ? (perWeek < 1 ? "daily1" : perWeek <= 2 ? "daily2" : "daily3")
      : long.length ? (d3.min(long) < 168 ? "multiday" : "seasonal") : "never";
    e.pick = e.configs.sort((a, b) => b.run - a.run)[0].name;   // config shown in Unit detail
    e.ran = st.some((c) => c === "m" || c === "a");
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
  window.CX.setNote($("st-month-note"), `Share of each month's hours with lambda below ${fmtPrice0(thr)} that each unit kept running. Dark rode through, light turned off, blank is untested.`, `Each cell is the share of hours with system lambda below ${fmtPrice0(thr)} that month in which the unit kept running, out of the hours it was available (running or off but not on outage). ` +
    `Dark means it rode through, light means it turned off. Blank cells are untested: fewer than ${ST_MIN_CHEAP_H} cheap hours while the unit was available, or the unit on outage. ` +
    `A unit's own month can be untested in a month with cheap hours if it was on outage for them. Rows are sorted by group, then capacity. Click a row to open the unit.`);
  // units whose share moved between the two most recent windows of tested months
  const changed = units.map((x) => ({ ...x, c: monthChange(x.r) })).filter((x) => x.c && Math.abs(x.c.late - x.c.early) >= ST_CHANGE)
    .sort((a, b) => d3.descending(Math.abs(b.c.late - b.c.early), Math.abs(a.c.late - a.c.early)));
  const win = (ix) => `${fmtM(M.months[ix[0]])}–${fmtM(M.months[ix.at(-1)])}`;
  $("st-changed").innerHTML = changed.length
    ? `<p class="note">Changed behaviour: units whose run-through share moved by ${fmtPct(ST_CHANGE)} or more between their two most recent windows of ${ST_WINDOW} tested months.</p>` +
      unitRows(changed.map((x) => ({ ...x.e, unit: x.e.pick, c: x.c })), [
        { h: "Unit", t: 1, f: (r) => esc(r.unit === r.pick ? r.unit : `${r.unit} (${r.unit})`) }, { h: "Technology", t: 1, f: (r) => techLabel(r.tech) }, { h: "Group", t: 1, f: (r) => gl(r.group) },
        { h: "MW", f: (r) => fmtMW(r.mw) }, { h: "Earlier window", t: 1, f: (r) => win(r.c.earlyIx) }, { h: "Ran through", f: (r) => fmtPct(r.c.early) },
        { h: "Latest window", t: 1, f: (r) => win(r.c.lateIx) }, { h: "Ran through", f: (r) => fmtPct(r.c.late) },
        { h: "Change", f: (r) => (r.c.late >= r.c.early ? "+" : "−") + fmtPct(Math.abs(r.c.late - r.c.early)) },
      ])
    : `<p class="note">No unit changed its behaviour between its two most recent windows of ${ST_WINDOW} tested months (a change is ${fmtPct(ST_CHANGE)} or more in the share of cheap hours it ran through).</p>`;
  if (!units.length) return emptyMsg(el, "No units match.");
  const base = d3.color(css(s.color));
  const cell = (v) => {
    if (v == null) return `<td class="st-na" title="Untested"></td>`;
    const c = base.copy({ opacity: 0.08 + 0.92 * v });
    return `<td style="background:${c.formatRgb()};color:${v > 0.55 ? "#fff" : "inherit"}">${fmtPct(v)}</td>`;
  };
  el.innerHTML = `<table class="data st-grid"><thead><tr><th class="t">Unit</th><th class="t">Group</th><th>MW</th>` +
    M.months.map((m, i) => `<th${tested[i] ? "" : ' class="st-na"'} title="${M.cheapH[i]} hours below ${fmtPrice0(thr)}">${fmtM(m)}<br><span class="muted">${M.cheapH[i]} h</span></th>`).join("") + "</tr></thead><tbody>" +
    units.map((x) => `<tr data-unit="${esc(x.e.pick)}" style="cursor:pointer"><td class="t">${esc(x.e.unit)}</td><td class="t">${gl(x.e.group)}</td><td>${fmtMW(x.e.mw)}</td>${x.r.share.map(cell).join("")}</tr>`).join("") +
    "</tbody></table>";
  setCSV(el, ["unit", "technology", "group", "mw", ...M.months.map((m) => `${m}_share_ran_through`), ...M.months.map((m) => `${m}_cheap_hours_available`)],
    units.map((x) => [x.e.unit, x.e.tech, x.e.group, Math.round(x.e.mw), ...x.r.share.map((v) => (v == null ? "" : v.toFixed(3))), ...x.r.avail]), `cheap-hours-month-by-month-${thr}`);
}
// pipeline/decisions.py: a unit's shutdown decisions scored day-ahead (see decisionOf)
const DEC_F = { tech: 0, lsl: 1, mingen: 2, hot: 3, est: 4, days: 5, shut: 6, award: 7, base: 8, cutoff: 9, acc: 10, stayMax: 11, shutMin: 12 };
const decisionOf = (key) => { const u = S.DEC?.units?.[key]; return u ? Object.fromEntries(Object.entries(DEC_F).map(([k, i]) => [k, u[i]])) : null; };
const fmtK = (v) => (v == null ? "–" : (v < 0 ? "−" : "") + "$" + d3.format(",.0f")(Math.abs(v) / 1e3) + "k");
async function drawStretch() {
  const el = $("st-group");
  if (!S.I) return emptyMsg(el, "Fills in after the data update builds the intraday file.");
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
  window.CX.setNote($("st-note"), `Coal and gas capacity by what it did across the ${nEps} stretches of lambda below ${fmtPrice0(thr)}: turned off before or during, or ran through.`, `A cheap stretch is a run of consecutive hours with system lambda below ${fmtPrice0(thr)}. There were ${nEps} from ${period}. ` +
    `Each bar is the total capacity (HSL) of one group of ${S.stTech === "all" ? "coal and gas" : s.label.toLowerCase()} units, grouped by how they ran over the whole period: ${ST_GROUPS.map((g) => `${g.label.toLowerCase()} (${g.note})`).join("; ")}. ` +
    `Each unit's capacity is split by what it did across the ${nEps} stretches: turned off in the ${ST_LEAD} hours before, turned off during, ran at minimum or above minimum (when it was already running ${ST_LEAD} hours before the stretch began), or not running going in (offline, on outage or no data). Units that never ran in the period are left out. ` +
    `Each combined-cycle train counts as one unit, so switching configuration is not a shutdown. Nuclear is left out. Lambda is the system price; a unit's own nodal price can differ.`);
  fleetBars(el, groups, s, S.stUnit === "mw" ? "Capacity of each group, MW, split by what it did in cheap stretches" : "Share of each group's capacity, by what it did in cheap stretches");
  drawMonths(fleet, s, thr);
  // the per-unit columns (stretches, shutdowns, hours off, cutoff) are in the units table at the foot of the page
  const gl = (id) => ST_GROUPS.find((g) => g.id === id).label;
  setCSV(el, ["group", "units", "capacity_mw", ...ST_FLEET.map((r) => r.label)], groups.map((g) => [g.label, g.n, Math.round(g.total), ...ST_FLEET.map((r) => Math.round(g.mw[r.id]))]), `Cheap stretches, lambda below ${thr}`);
  drawFlags(B, ts, gl);
}

// Shutdowns that broke a unit's pattern (pipeline/decisions.py flags): the first after a month
// or more without one, or one over a window its DAM award covered in full.
const FLAG_KIND = { new: "First in a month or more", award: "Despite a DAM award" };
function drawFlags(B, ts, gl) {
  const el = $("st-flags"), DEC = S.DEC;
  if (!DEC?.flags) { $("st-flags-note").textContent = ""; return emptyMsg(el, "Fills in after the data update builds the decisions file."); }
  const rows = DEC.flags.map((f) => ({ unit: f[0], date: f[1], kind: f[2], loss: f[3], off: f[4], since: f[5], award: f[6], e: B.units.get(f[0]) }))
    .filter((r) => r.e && ts.includes(r.e.tech)).map((r) => ({ ...r, pick: r.e.pick, tech: r.e.tech, group: r.e.group, mw: r.e.mw }));
  const n = (k) => rows.filter((r) => r.kind === k).length;
  window.CX.setNote($("st-flags-note"), "Shutdowns that broke a unit's usual pattern, newest first. Click a unit to open it.", `Every shutdown on a decision day that was the unit's first in ${DEC.new_days} days or more (with at least ${DEC.new_days} days of data before it), or came over a window its DAM energy award covered in full: ` +
    `a unit that normally rides through starting to cycle, a seasonal layup beginning, or a unit dropping an award it held. ${n("new")} first-in-a-month and ${n("award")} despite-an-award shutdowns, newest first. ` +
    `"Loss" is what riding through the day's worst window would have cost at its node's day-ahead price; "hours off" counts to the end of the spell, so a long one is a layup or an undeclared outage. Click a unit to open its detail.`);
  if (!rows.length) return emptyMsg(el, "No flagged shutdowns for these units.");
  el.innerHTML = unitRows(rows.map((r) => ({ ...r, name: r.unit, unit: r.pick })), [
    { h: "Date", t: 1, f: (r) => r.date }, { h: "Unit", t: 1, f: (r) => esc(r.name) }, { h: "Technology", t: 1, f: (r) => techLabel(r.tech) }, { h: "Group", t: 1, f: (r) => gl(r.group) }, { h: "MW", f: (r) => fmtMW(r.mw) },
    { h: "Why flagged", t: 1, f: (r) => FLAG_KIND[r.kind] }, { h: "Days since last shutdown", f: (r) => (r.since == null ? "none in data" : r.since) }, { h: "Loss riding through", f: (r) => fmtK(r.loss) },
    { h: "Award over window", f: (r) => fmtPct(r.award) }, { h: "Hours off", f: (r) => fmtMW(r.off) },
  ]);
  setCSV(el, ["date", "unit", "technology", "group", "mw", "kind", "days_since_last_shutdown", "loss_usd", "award_share", "hours_off"],
    rows.map((r) => [r.date, r.unit, r.tech, r.group, r.mw, r.kind, r.since, r.loss, r.award, r.off]), "Shutdowns that broke a pattern");
}

// ---- leanest thermal hours: the hours with the least thermal output, with what else ran --
const FOSSIL = THERMAL.filter((t) => t !== "nuclear");
const LEAN_N = 25;
function drawLean() {
  const I = S.I, HC = S.HC, el = $("lean-table");
  if (!I) return emptyMsg(el, "Fills in after the data update builds the intraday file.");
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
    { h: fossil ? "Fossil MW" : "Thermal MW", k: fossil ? "fossil_mw" : "thermal_mw", f: (r) => `<b>${mw(r.v)}</b>` },
    { h: "Fossil above min.", k: "fossil_above_min_mw", f: (r) => mw(r.above) },
    { h: "Fossil starting/stopping", k: "fossil_starting_stopping_mw", f: (r) => mw(r.transit) },
    { h: "Coal", k: "coal_mw", f: (r) => mw(r.coal) }, { h: "Comb. cycle", k: "combined_cycle_mw", f: (r) => mw(r.combined_cycle) },
    { h: "Gas steam", k: "gas_steam_mw", f: (r) => mw(r.gas_steam) }, { h: "CT", k: "combustion_turbine_mw", f: (r) => mw(r.combustion_turbine) },
    { h: "Nuclear", k: "nuclear_mw", f: (r) => mw(r.nuc) }, { h: "Wind", k: "wind_mw", f: (r) => mw(r.wind) }, { h: "Solar", k: "solar_mw", f: (r) => mw(r.solar) },
    { h: "Storage", k: "storage_mw", f: (r) => mw(r.storage) }, { h: "Lambda", k: "lambda", f: (r) => fmtPrice(r.lam) }, { h: "Hub avg", k: "hub_avg", f: (r) => fmtPrice(r.hub) },
  ];
  const val = (r) => [r.d, r.h + 1, r.v, r.above, r.transit, r.coal, r.combined_cycle, r.gas_steam, r.combustion_turbine, r.nuc, r.wind, r.solar, r.storage, r.lam, r.hub];
  const scope = S.leanMonth === "all" ? "all days" : d3.timeFormat("%B %Y")(parseDate(S.leanMonth + "-15"));
  window.CX.setNote($("lean-note"), `The ${top.length} hours with the least ${fossil ? "fossil" : "thermal"} output. Click a row to open that hour on the Offers page.`, `The ${top.length} hours with the least ${fossil ? "fossil (coal, combined cycle, gas steam and combustion turbine)" : "thermal (fossil and nuclear)"} output, ${scope}` +
    `${S.leanPer === "day" ? ", one per day" : ""}, from the 60-day disclosure. Output counts every unit's telemetered MW, including units starting up, shutting down or online for under half the hour ("starting/stopping"). ` +
    `"Above min." is output above each running unit's LSL; the rest of the running units' output is what they could not shed without shutting down. ` +
    `Storage is net output (negative while charging); hub avg is the HB_HUBAVG settlement point price. Click a row to open that hour on the Offers page.`);
  if (!top.length) { el.innerHTML = `<p class="empty">No hours in this range.</p>`; setCSV(el, [], [], "Leanest thermal hours"); return; }
  el.innerHTML = `<table class="data"><thead><tr>${cols.map((c) => `<th${c.t ? ' class="t"' : ""}>${c.h}</th>`).join("")}</tr></thead><tbody>` +
    top.map((r) => `<tr data-href="beyond.html#date=${r.d}&he=${r.h + 1}&p=curves-panel" style="cursor:pointer">${cols.map((c) => `<td${c.t ? ' class="t"' : ""}>${c.f(r)}</td>`).join("")}</tr>`).join("") + "</tbody></table>";
  setCSV(el, cols.map((c) => c.k), top.map(val), "Leanest thermal hours");
}

// ==== one day: the cutoff curve, groups and cutoffs, the forecast scored ==================
// Every figure here is read from the day's forecast file (data/forecast/<date>.json.gz,
// pipeline/models/thermal_cutoff.py) or the score and fit files beside it; the page only sums.
const NOCUT = { id: "nocut", label: "No cutoff yet (too few decision days)", color: "--c-other" };
const CUT_TECHS = ["nuclear", "coal", "gas_steam", "combined_cycle", "combustion_turbine"].map((id) => TECHS.find((t) => t.id === id));
const GROUP_LABEL = Object.fromEntries([...ST_GROUPS.map((g) => [g.id, g.label]), ["ungrouped", "Not yet grouped"]]);
const VERDICT = { on: "Expected on", off: "Expected off", maybe: "Maybe: off on its loss, but often holds a day-ahead award", nocut: "No cutoff yet", outage: "On outage", peaker: "Peaker" };
const fmt$ = (v) => (v == null || isNaN(v) ? "–" : (v < 0 ? "−" : "") + "$" + d3.format(",.0f")(Math.abs(v)));
const fmtPerMW = (v) => (v == null || isNaN(v) ? "–" : (v < 0 ? "−" : "") + "$" + d3.format(",.1f")(Math.abs(v)));
const fmtGW = (v) => d3.format(",.1f")(v / 1e3) + " GW";
const unitHref = (u) => `unit.html?unit=${encodeURIComponent(trainOf(u))}`;   // a combined-cycle configuration opens its train

// rows of the day's forecast that the cutoff curve is about: thermal units judged on the day
// (peakers start rather than stay on, so they are left off) with a minimum output
function dayUnits(F) {
  const cols = F.units.columns;
  return F.units.rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])))
    .filter((r) => r.verdict !== "peaker" && r.lsl > 0)
    .map((r) => ({
      ...r,
      // "cut": leaves at its own cutoff; "flat": on at any loss (nuclear, never off, seasonal and
      // multi-day units judged on for the month, units without a cutoff yet); "off": judged off
      // for the month; "out": on outage
      kind: r.verdict === "outage" ? "out" : r.cutoff != null ? "cut" : r.verdict === "off" ? "off" : "flat",
      band: r.tech === "nuclear" ? "nuclear" : r.verdict === "nocut" ? "nocut" : r.group,
      c: r.cutoff != null ? r.cutoff / r.lsl : null,
      l: r.loss != null ? r.loss / r.lsl : null,
    }));
}

async function loadDay() {
  const d = S.date;
  S.F = await tryJSON(`data/forecast/${d}.json.gz`);
  if (S.date !== d) return;
  const sc = S.SC?.days?.[d];
  // the 2-day fit, from the score file once the day is scored, else from its own file
  S.FIT = sc?.fit ? null : await tryJSON(`data/fit/${d}.json.gz`);
  if (S.date !== d) return;
  drawDay();
}
function drawDay() { drawCutoff(); drawCutUnits(); drawGroups(); drawRecord(); }

// the loss axis both cutoff charts share, so a dollar loss sits at the same place in each
const CUT_M = { l: 64, r: 16 };
function cutDomain(U) {
  const cs = U.filter((u) => u.kind === "cut").map((u) => u.c), ls = U.filter((u) => u.kind === "cut" && u.l != null).map((u) => u.l).sort(d3.ascending);
  return [Math.min(0, d3.min(cs) ?? 0), Math.max(50, d3.max(cs) ?? 0, ls.length ? d3.quantile(ls, 0.9) : 0) * 1.08];
}

function drawCutoff() {
  // a surface-coloured outline so chart labels read over the stacked bands
  const halo = (t) => t.attr("paint-order", "stroke").attr("stroke", css("--surface")).attr("stroke-width", 3).attr("stroke-linejoin", "round");
  const el = $("cut-chart"), F = S.F, byTech = S.cutBy === "tech";
  setSeg("cut-by", S.cutBy);
  if (!F) { $("cut-note").textContent = ""; $("cut-legend").innerHTML = ""; return emptyMsg(el, "No forecast file for this day."); }
  const U = dayUnits(F), on = U.filter((u) => u.kind === "cut" || u.kind === "flat");
  // units without a cutoff yet are their own grey band in both views, as on the Overview
  const bandOf = (u) => (u.band === "nocut" ? "nocut" : byTech ? u.tech : u.band);
  const bands = (byTech ? CUT_TECHS : FLOOR_GROUPS).filter((b) => on.some((u) => bandOf(u) === b.id))
    .concat(on.some((u) => u.band === "nocut") ? [NOCUT] : []);
  const cuts = on.filter((u) => u.kind === "cut");
  const cs = cuts.map((u) => u.c), [x0, x1] = cutDomain(U);
  // MW of each band still on when every unit faces a loss of x per MW of LSL: flat units always,
  // a unit with a cutoff while x is at or below it (just above its cutoff it turns off)
  const xs = [x0, ...[...new Set(cs)].filter((c) => c > x0 && c < x1).sort(d3.ascending), x1];
  const stay = (u, x, i) => u.kind === "flat" || (i === 0 ? u.c >= x : u.c > x);
  const vals = bands.map((b) => xs.map((x, i) => d3.sum(on, (u) => (bandOf(u) === b.id && stay(u, x, i) ? u.lsl : 0))));
  const tot = xs.map((_, i) => d3.sum(vals, (v) => v[i]));
  // the day's expected committed minimum: each unit's LSL times its chance of being on
  const today = d3.sum(U.filter((u) => u.kind !== "out"), (u) => u.lsl * (u.p_on ?? 0));
  const lw = U.filter((u) => u.kind === "cut" && u.l != null);
  const typical = lw.length ? d3.quantile(lw.map((u) => u.l).sort(d3.ascending), 0.5) : null;
  const outMW = d3.sum(U.filter((u) => u.kind === "out"), (u) => u.lsl), offMW = d3.sum(U.filter((u) => u.kind === "off"), (u) => u.lsl);
  $("cut-title-note").textContent = fmtDate(parseDate(F.date));
  window.CX.setNote($("cut-note"), "Minimum output (MW) that stays on as the cost of staying on rises. Each daily unit drops off at the cost it usually turns off above.", `Thermal minimum output (LSL, MW) that stays on as the stay-on loss rises. The loss is what riding through the day's worst contiguous stretch at minimum output costs a unit at its own node's day-ahead price (minimum-energy cost less price, times the hours), before any start cost, divided by its LSL so units of every size compare. ` +
    `Each daily unit leaves the curve at its own cutoff: the loss per MW above which it has turned off on days without a day-ahead award, fitted on its decision days before this one. Nuclear and the never-off group stay on at any loss, so they are the flat floor. ` +
    `Seasonal and multi-day units are judged on the month's price level, not a day loss, so they sit flat at the day's verdict (${fmtMW(offMW)} MW of their minimum output is judged off for the month and is not drawn). Daily units with too few decision days for a cutoff are the grey band, drawn flat. ${fmtMW(outMW)} MW on outage and peakers (they start rather than stay on) are left off. ` +
    `Every unit faces its own loss at its own node, so the day is not one point on the axis: the dashed line is the day's expected committed minimum (each unit's LSL times its chance of being on, the Overview's figure without peakers), and the dotted line is the median loss per MW the daily units faced. The chart below places every unit.`);
  staticLegend($("cut-legend"), bands);
  const w = Math.max(280, el.clientWidth || 600), H = 320, m = { t: 22, b: 40, ...CUT_M };
  const x = d3.scaleSymlog().constant(10).domain([x0, x1]).range([m.l, w - m.r]);
  const y = d3.scaleLinear().domain([0, Math.max(today, d3.max(tot) || 1)]).nice().range([H - m.b, m.t]);
  const xT = (w < 560 ? [0, 10, 50, 250, 1000] : [0, 5, 10, 25, 50, 100, 250, 500, 1000, 2500]).filter((v) => v >= x0 && v <= x1);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickValues(xT).tickFormat(fmtPrice0).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y), 5).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text("Minimum output that stays on (MW)");
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", H - 6).attr("text-anchor", "end").text("Stay-on loss over the day's worst stretch, $ per MW of LSL");
  let base = xs.map(() => 0);
  const area = d3.area().curve(d3.curveStepAfter).x((_, i) => x(xs[i]));
  vals.forEach((v, bi) => {
    const lo = base, hi = lo.map((b, i) => b + v[i]);
    svg.append("path").attr("fill", css(bands[bi].color)).attr("fill-opacity", bands[bi].id === "nocut" ? 0.55 : 0.9)
      .attr("d", area.y0((_, i) => y(lo[i])).y1((_, i) => y(hi[i]))(xs));
    base = hi;
  });
  svg.append("line").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(today)).attr("y2", y(today)).attr("stroke", css("--ink")).attr("stroke-width", 1.5).attr("stroke-dasharray", "6 4");
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r - 4).attr("y", y(today) - 5).attr("text-anchor", "end").call(halo).text(`Expected committed minimum: ${fmtMW(today)} MW`);
  if (typical != null && typical >= x0 && typical <= x1) {
    svg.append("line").attr("x1", x(typical)).attr("x2", x(typical)).attr("y1", m.t).attr("y2", H - m.b).attr("stroke", css("--ink")).attr("stroke-dasharray", "2 3");
    const flip = x(typical) > w - m.r - (w < 560 ? 130 : 200);
    svg.append("text").attr("class", "axis-title").attr("x", x(typical) + (flip ? -4 : 4)).attr("y", m.t + 10).attr("text-anchor", flip ? "end" : "start").call(halo)
      .text(`${w < 560 ? "Median loss" : "Median daily unit's loss"}: ${fmtPerMW(typical)}/MW`);
  }
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", H - m.b).style("display", "none");
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const xv = x.invert(d3.pointer(ev)[0]), i = Math.max(0, d3.bisectRight(xs, xv) - 1);
      cross.style("display", null).attr("x1", x(xv)).attr("x2", x(xv));
      const left = cuts.filter((u) => u.c > xv).length;
      showTip(ev, `<h4>Loss of ${fmtPerMW(xv)} per MW of LSL</h4><table>` + [...bands].reverse().map((b, k) => {
        const v = vals[bands.length - 1 - k][i];
        return `<tr><td><span class="sw" style="background:var(${b.color})"></span></td><td>${b.label}</td><td class="n">${fmtMW(v)} MW</td></tr>`;
      }).join("") + `<tr><td></td><td><b>Total</b></td><td class="n"><b>${fmtMW(tot[i])} MW</b></td></tr></table>${left} of ${cuts.length} units with a cutoff still on`);
    })
    .on("pointerleave", () => { cross.style("display", "none"); hideTip(); });
  el.replaceChildren(svg.node());
  setCSV(el, ["loss_usd_per_mw_lsl", ...bands.map((b) => b.label), "total_mw"], xs.map((xv, i) => [+xv.toFixed(2), ...vals.map((v) => Math.round(v[i])), Math.round(tot[i])]), `Cutoff curve ${F.date}`);
}

// one row per daily group: each unit with a cutoff as a dot at its cutoff, joined to a tick at
// the day's loss; the join is red where the loss is past the cutoff (expected off or maybe)
function drawCutUnits() {
  const el = $("cut-units"), F = S.F;
  if (!F) { $("cut-units-note").textContent = ""; $("cut-units-legend").innerHTML = ""; return el.replaceChildren(); }
  const U = dayUnits(F).filter((u) => u.kind === "cut");
  const rowsG = ST_GROUPS.filter((g) => U.some((u) => u.group === g.id));
  if (!rowsG.length) { $("cut-units-note").textContent = ""; return emptyMsg(el, "No unit has a cutoff on this day."); }
  const n = (v) => U.filter((u) => u.verdict === v).length;
  window.CX.setNote($("cut-units-note"), `${U.length} units: ${n("on")} likely on, ${n("off")} likely off, ${n("maybe")} toss-ups. The dot is the cost a unit usually turns off above; the tick is today's cost to stay on. Click a unit to open it.`, `${U.length} units with a cutoff: ${n("on")} expected on, ${n("off")} expected off and ${n("maybe")} maybe. Each dot is a unit's cutoff, sized by its LSL; the tick is the loss per MW it faced on the day at its own node, and the line between them is red where the loss is past the cutoff. ` +
    `Losses beyond the right edge are drawn at the edge. "Maybe" is a unit past its cutoff that has held a day-ahead award over its loss window on half or more of its days, since the award is not public until the 60-day disclosure. Click a unit to open it.`);
  $("cut-units-legend").innerHTML = rowsG.map((g) => `<span><span class="sw" style="background:var(${FLOOR_GROUPS.find((f) => f.id === g.id).color})"></span>${g.label}</span>`).join("") +
    `<span><span class="sw" style="background:var(--c8);height:3px"></span>Loss past the cutoff</span><span><span class="sw" style="background:var(--muted);height:3px"></span>Loss within it</span>`;
  const [x0, x1] = cutDomain(U);
  // same margins and loss axis as the cutoff curve above; each group's name sits above its row
  const w = Math.max(280, el.clientWidth || 600), narrow = w < 560, lane = 7, lanes = 5, rowH = lane * lanes + 32;
  const m = { t: 8, b: 30, ...CUT_M }, H = m.t + m.b + rowH * rowsG.length;
  const x = d3.scaleSymlog().constant(10).domain([x0, x1]).range([m.l, w - m.r]).clamp(true);
  const xT = (narrow ? [0, 10, 50, 250, 1000] : [0, 5, 10, 25, 50, 100, 250, 500, 1000, 2500]).filter((v) => v >= x0 && v <= x1);
  const r = d3.scaleSqrt().domain([0, d3.max(U, (u) => u.lsl)]).range([1.5, 6]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`).attr("data-nopin", "");
  svg.append("g").attr("class", "gridline").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickValues(xT).tickSize(-(H - m.t - m.b)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickValues(xT).tickFormat(fmtPrice0).tickSizeOuter(0));
  rowsG.forEach((g, gi) => {
    const top = m.t + gi * rowH, col = css(FLOOR_GROUPS.find((f) => f.id === g.id).color);
    const lbl = g.label.replace("Daily, ", "Daily: ");
    svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", top + 12).text(lbl);
    const us = U.filter((u) => u.group === g.id).sort((a, b) => a.c - b.c);
    us.forEach((u, k) => {
      const yy = top + 23 + (k % lanes) * lane + lane / 2, past = u.l != null && u.l > u.c;
      const gU = svg.append("g").style("cursor", "pointer")
        .on("pointermove", (ev) => showTip(ev, `<h4>${esc(u.unit)}</h4>${techLabel(u.tech)} · ${g.label}<br>LSL ${fmtMW(u.lsl)} MW<br>` +
          `Cutoff ${fmt$(u.cutoff)} (${fmtPerMW(u.c)}/MW)<br>Loss on the day ${fmt$(u.loss)} (${fmtPerMW(u.l)}/MW)<br>` +
          `<b>${VERDICT[u.verdict] || u.verdict}</b>` +
          (u.reason ? `<br><span class="muted">${esc(u.reason)}</span>` : "") + `<br><span class="tip-pin-note">Click to open the unit</span>`))
        .on("pointerleave", hideTip)
        .on("click", () => { location.href = unitHref(u.unit); });
      if (u.l != null) {
        gU.append("line").attr("x1", x(u.c)).attr("x2", x(u.l)).attr("y1", yy).attr("y2", yy).attr("stroke", css(past ? "--c8" : "--muted")).attr("stroke-width", 1.5);
        gU.append("line").attr("x1", x(u.l)).attr("x2", x(u.l)).attr("y1", yy - 3).attr("y2", yy + 3).attr("stroke", css("--ink")).attr("stroke-width", 1.5);
      }
      gU.append("circle").attr("cx", x(u.c)).attr("cy", yy).attr("r", r(u.lsl)).attr("fill", col).attr("stroke", css("--surface")).attr("stroke-width", 0.5);
    });
    if (gi) svg.append("line").attr("x1", m.l).attr("x2", w - m.r).attr("y1", top).attr("y2", top).attr("stroke", css("--line"));
  });
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", H - 2).attr("text-anchor", "end").text("$ per MW of LSL");
  el.replaceChildren(svg.node());
  setCSV(el, ["unit", "technology", "group", "lsl_mw", "cutoff_usd", "cutoff_usd_per_mw", "loss_usd", "loss_usd_per_mw", "verdict"],
    U.map((u) => [u.unit, u.tech, u.group, u.lsl, u.cutoff, u.c == null ? null : +u.c.toFixed(2), u.loss, u.l == null ? null : +u.l.toFixed(2), u.verdict]), `Unit cutoffs ${F.date}`);
}

// the six groups on the day (forecast capacity) with how well the daily units' cutoffs fit their
// history (decisions.json: share of decision days the cutoff rule called, against the base rate)
function drawGroups() {
  const el = $("groups-table"), F = S.F;
  if (!F) { $("groups-note").textContent = ""; return emptyMsg(el, "No forecast file for this day."); }
  const C = F.capacity.group, ids = [...ST_GROUPS.map((g) => g.id), "ungrouped"].filter((g) => C[g]);
  const decBy = d3.group(Object.entries(S.DEC?.units || {}).map(([k, u]) => ({ k, ...decisionOf(k) })).filter((u) => u.cutoff != null), (u) => S.G?.units?.[u.k]?.[1] || "ungrouped");
  const rows = ids.map((g) => {
    const c = C[g], d = decBy.get(g) || [], days = d3.sum(d, (u) => u.days);
    return { g, ...c, n: c.n_on + c.n_off + c.n_out + c.n_unknown, nCut: d.length,
      medCut: d.length ? d3.median(d.filter((u) => u.lsl > 0), (u) => u.cutoff / u.lsl) : null,
      acc: days ? d3.sum(d, (u) => u.acc * u.days) / days : null, base: days ? d3.sum(d, (u) => u.base * u.days) / days : null };
  });
  $("groups-title-note").textContent = fmtDate(parseDate(F.date));
  window.CX.setNote($("groups-note"), "Coal and gas units grouped by how often they turn off on price, with the day's expected output and minimum output online.", `Every coal and gas unit (combined-cycle configurations merged into their train) by how often it has turned off on price over the ${S.G ? S.G.dates.length : ""} days of 60-day data (pipeline/groups.py), with nuclear in the never-off group as on the Overview. Units, capacity (HSL), committed minimum (LSL of the units expected on, weighted by their chance of being on) and expected output are the day's forecast and include peakers, so they match the Overview. ` +
    `The cutoff columns cover units with enough decision days for a cutoff (${S.DEC ? `${S.DEC.min_days} days with at least ${S.DEC.min_each} shutdowns and ${S.DEC.min_each} stays` : ""}): the median cutoff per MW of LSL, and how often the rule "off when no award covers the window and the loss is above the cutoff, else on" matched what the units did, weighted by decision days, against the base rate of each unit's commoner outcome. A rule well above its base rate says the day economics decide; near it, something else does. Seasonal and multi-day units are judged on the month's price level instead, and the inflexibility tracker below shows them month by month.`);
  el.innerHTML = `<table class="data"><thead><tr><th class="t">Group</th><th>Units</th><th>Capacity MW</th><th>On / off / outage</th><th>Committed minimum MW</th><th>Expected output MW</th><th>Units with a cutoff</th><th>Median cutoff $/MW LSL</th><th>Cutoff rule right</th><th>Base rate</th></tr></thead><tbody>` +
    rows.map((r) => `<tr><td class="t"><span class="sw" style="background:var(${FLOOR_GROUPS.find((f) => f.id === r.g)?.color || "--c-other"});margin-right:6px"></span>${GROUP_LABEL[r.g]}<br><span class="muted">${ST_GROUPS.find((g) => g.id === r.g)?.note || "too little history to place"}</span></td>` +
      `<td>${r.n}</td><td>${fmtMW(r.cap)}</td><td>${r.n_on} / ${r.n_off} / ${r.n_out}${r.n_unknown ? ` (+${r.n_unknown} unknown)` : ""}</td>` +
      `<td>${fmtMW(r.min)}</td><td>${fmtMW(r.exp)}</td><td>${r.nCut || "–"}</td><td>${fmtPerMW(r.medCut)}</td><td>${r.acc == null ? "–" : fmtPct(r.acc)}</td><td>${r.base == null ? "–" : fmtPct(r.base)}</td></tr>`).join("") +
    `<tr><td class="t"><b>All thermal</b></td><td><b>${d3.sum(rows, (r) => r.n)}</b></td><td><b>${fmtMW(d3.sum(rows, (r) => r.cap))}</b></td><td></td><td><b>${fmtMW(d3.sum(rows, (r) => r.min))}</b></td><td><b>${fmtMW(d3.sum(rows, (r) => r.exp))}</b></td><td><b>${d3.sum(rows, (r) => r.nCut)}</b></td><td></td><td></td><td></td></tr></tbody></table>`;
  setCSV(el, ["group", "units", "capacity_mw", "units_on", "units_off", "units_out", "units_unknown", "committed_min_mw", "expected_mw", "units_with_cutoff", "median_cutoff_usd_per_mw_lsl", "cutoff_rule_right", "base_rate"],
    rows.map((r) => [r.g, r.n, r.cap, r.n_on, r.n_off, r.n_out, r.n_unknown, r.min, r.exp, r.nCut, r.medCut, r.acc, r.base]), `Groups ${F.date}`);
}

// plan layer 1 against layers 2 and 3: the committed minimum the forecast expected, the one the
// 2-day fit inferred from the aggregate curve, and the 60-day answer, by group; and the thermal
// output the forecast expected against the 60-day output (pipeline/forecast/score.py)
function drawRecord() {
  const el = $("record-table"), d = S.date, sc = S.SC?.days?.[d];
  $("record-title-note").textContent = fmtDate(parseDate(d));
  const fit = sc?.fit, fg = fit?.group || S.FIT?.groups, six = sc?.sixty_day, sg = six?.group;
  window.CX.setNote($("record-note"), "The forecast's minimum output online against the 2-day estimate and the 60-day actual, by group.", `The forecast's committed minimum (LSL of the units it expected on), the minimum the 2-day fit inferred two days after the day by adjusting which units were on until their summed offer curves matched ERCOT's 2-day thermal curve, and the hourly average actually online in the 60-day disclosure, by group; then the thermal output the forecast expected over the day against the 60-day output. ` +
    `The fit is reported by group because units with similar curves are interchangeable in it. Fit errors by group show where the cutoffs are wrong: a group the fit and the 60-day answer both put below the forecast has units staying off that their cutoffs call on. The fit holds nuclear fixed and fits peakers as one fleet share by hour, so its columns leave both out and sit below the Groups table's committed minimum, which includes them. Some days have no fit (the 2-day report or the curve snapshot it needs was missing).`);
  if (!fg && !sg) {
    $("record-summary").textContent = "";
    return emptyMsg(el, "Not scored yet: the 2-day fit arrives two days after the operating day, and the 60-day answer about sixty days after.");
  }
  const ids = [...ST_GROUPS.map((g) => g.id), "ungrouped"].filter((g) => fg?.[g] || sg?.[g]);
  const rows = ids.map((g) => ({ g, fc: fg?.[g]?.lsl_fc ?? null, fit: fg?.[g]?.lsl_fit ?? null, act: fg?.[g]?.lsl_act_mean ?? null,
    eg: sg?.[g]?.exp_gwh ?? null, ag: sg?.[g]?.act_gwh ?? null }));
  const mw = (v, none = "–") => (v == null ? none : fmtMW(v)), gwh = (v) => (v == null ? "–" : d3.format(",.1f")(v));
  const err = (a, b) => (a == null || b == null ? "–" : (a - b >= 0 ? "+" : "−") + fmtMW(Math.abs(a - b)));
  const tot = (k) => (rows.some((r) => r[k] != null) ? d3.sum(rows, (r) => r[k]) : null);
  // a day without a fit (its 2-day report or curve snapshot was missing) shows the output columns only
  const cols = [
    ...(fg ? [{ h: "Committed minimum: forecast MW", k: "fc", f: mw }, { h: "2-day fit MW", k: "fit", f: mw }, { h: "60-day actual MW", k: "act", f: (v) => mw(v, "pending") },
      { h: "Forecast error", f: (r) => err(r.fc, r.act) }, { h: "Fit error", f: (r) => err(r.fit, r.act) }] : []),
    ...(sg ? [{ h: "Output: forecast GWh", k: "eg", f: gwh }, { h: "60-day actual GWh", k: "ag", f: gwh }] : []),
  ];
  const cell = (c, r) => (c.k ? c.f(r[c.k]) : c.f(r));
  el.innerHTML = (fg ? "" : `<p class="note">No 2-day fit for this day, so only the output the forecast expected is scored.</p>`) +
    `<table class="data"><thead><tr><th class="t">Group</th>${cols.map((c) => `<th>${c.h}</th>`).join("")}</tr></thead><tbody>` +
    rows.map((r) => `<tr><td class="t"><span class="sw" style="background:var(${FLOOR_GROUPS.find((f) => f.id === r.g)?.color || "--c-other"});margin-right:6px"></span>${GROUP_LABEL[r.g]}</td>` +
      cols.map((c) => `<td>${cell(c, r)}</td>`).join("") + "</tr>").join("") +
    `<tr><td class="t"><b>All thermal</b></td>${cols.map((c) => `<td><b>${c.k ? c.f(tot(c.k)) : ""}</b></td>`).join("")}</tr></tbody></table>`;
  setCSV(el, ["group", "forecast_lsl_mw", "fit_lsl_mw", "actual_lsl_mw", "forecast_output_gwh", "actual_output_gwh"], rows.map((r) => [r.g, r.fc, r.fit, r.act, r.eg, r.ag]), `Forecast against fit ${d}`);
  const sum = S.SC?.summary ? Object.values(S.SC.summary).at(-1) : null;
  $("record-summary").textContent = (fit ? `Over the day, the forecast's committed minimum came to ${d3.format(",.0f")(fit.lsl_fc_gwh)} GWh, the fit's ${d3.format(",.0f")(fit.lsl_fit_gwh)} GWh and the actual ${d3.format(",.0f")(fit.lsl_act_gwh)} GWh. ` : "") +
    (six ? `Unit by unit, the forecast's on or off call was right for ${fmtPct(six.unit_hit)} of the ${six.n_judged} units it judged. ` : "The 60-day answer for this day is not out yet. ") +
    (sum?.unit_hit != null ? `Across every scored day of this model version, ${fmtPct(sum.unit_hit)} of ${d3.format(",")(sum.n_judged)} unit calls were right.` : "");
}

// ==== across days: what the decision cost ==================================================
// pipeline/stayon.py: each ride-through of a cheap stretch, what it lost against system lambda
// at the unit's minimum-energy cost, and the restart a shutdown would have needed instead
const RIDE = { unit: 0, tech: 1, thr: 2, stretch: 3, mwh: 4, rev: 5, cost: 6, loss: 7, start: 8, saves: 9, est: 10 };
function ridesBy(thr) {
  const SO = S.SO;
  if (!SO) return null;
  const ti = SO.cheap.indexOf(thr);
  const out = new Map();
  for (const r of SO.rides) {
    if (r[RIDE.thr] !== ti || r[RIDE.tech] === "nuclear") continue;
    const key = r[RIDE.tech] === "combined_cycle" ? trainOf(r[RIDE.unit]) : r[RIDE.unit];
    let e = out.get(key);
    if (!e) out.set(key, (e = { unit: key, tech: r[RIDE.tech], n: 0, mwh: 0, loss: 0, start: 0, saves: 0, paid: 0, est: 0 }));
    e.n++; e.mwh += r[RIDE.mwh]; e.loss += r[RIDE.loss]; e.start += r[RIDE.start]; e.saves += r[RIDE.saves];
    if (r[RIDE.saves] > 0) e.paid++;
    if (r[RIDE.est]) e.est++;
  }
  return out;
}
function drawCost() {
  const el = $("cost-chart"), thr = +S.costThr, by = ridesBy(thr);
  if (!by) { $("cost-note").textContent = ""; return emptyMsg(el, "Fills in after the data update builds the stay-on file."); }
  const groupOf = (k) => S.G?.units?.[k]?.[1] || "ungrouped";
  const ids = [...ST_GROUPS.map((g) => g.id), "ungrouped"];
  const rows = ids.map((g) => {
    const us = [...by.values()].filter((e) => groupOf(e.unit) === g);
    const sum = (k) => d3.sum(us, (e) => e[k]);
    return { g, units: us.length, n: sum("n"), mwh: sum("mwh"), loss: sum("loss"), start: sum("start"), saves: sum("saves"), paid: sum("paid"), est: sum("est") };
  }).filter((r) => r.n);
  const nStretch = S.SO.stretches[String(thr)]?.length || 0;
  window.CX.setNote($("cost-note"), `Each time a coal or gas unit ran through hours with lambda below ${fmtPrice0(thr)}: what it lost, against what a shutdown and restart would have cost.`, `Every time a coal or gas unit ran through a stretch of hours with system lambda below ${fmtPrice0(thr)} (${nStretch} stretches of ${S.SO.min_hours} hours or more), what its output lost against lambda at its own minimum-energy cost, and what a shutdown and restart would have cost instead (hot start for stretches up to ${S.SO.hot_h} hours, intermediate up to ${S.SO.inter_h}, cold beyond). ` +
    `Where the loss is bigger than the restart, shutting down would have paid. Costs are the unit's own day-ahead three-part offer (capped by ERCOT's cost verification, so an upper bound), its latest within ${S.SO.cost_days} days, or a generic value for the technology; lambda is the system price, so congestion at the unit's node is not in these numbers, unlike the cutoffs, which use the node's day-ahead price. ` +
    `A unit with a cutoff that keeps riding through stretches where shutting down would have paid may hold contracts, ancillary service obligations or start costs these numbers do not see; the units table puts each unit's net beside its cutoff.`);
  const S2 = [
    { id: "loss", label: "Lost riding through (cost less revenue at lambda)", color: "--c8" },
    { id: "start", label: "Restart avoided by staying on", color: "--c1" },
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
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text(`All ride-throughs of stretches below ${fmtPrice0(thr)}, by group ($)`);
  rows.forEach((r) => S2.forEach((s) => {
    const v = r[s.id];
    svg.append("rect").attr("x", x(r.g) + xi(s.id)).attr("width", xi.bandwidth()).attr("y", y(Math.max(0, v))).attr("height", Math.abs(y(v) - y(0)))
      .attr("fill", css(s.color))
      .on("pointermove", (ev) => showTip(ev, `<h4>${GROUP_LABEL[r.g]}</h4>${r.n} ride-throughs by ${r.units} units, ${fmtMW(r.mwh)} MWh<br>Lost riding through ${fmt$(r.loss)}<br>Restart avoided ${fmt$(r.start)}<br>` +
        `<b>Shutting down would have ${r.saves > 0 ? `saved ${fmt$(r.saves)}` : `cost ${fmt$(-r.saves)} more`}</b><br>Shutting down would have paid in ${fmtPct(r.paid / r.n)} of ride-throughs`))
      .on("pointerleave", hideTip);
  }));
  el.replaceChildren(svg.node());
  $("cost-groups").innerHTML = `<table class="data"><thead><tr><th class="t">Group</th><th>Units</th><th>Ride-throughs</th><th>MWh</th><th>Lost riding through</th><th>Lost per MWh</th><th>Restart avoided</th><th>Net: shutting down would have saved</th><th>Ride-throughs where shutting down paid</th><th>Estimated costs</th></tr></thead><tbody>` +
    rows.map((r) => `<tr><td class="t">${GROUP_LABEL[r.g]}</td><td>${r.units}</td><td>${r.n}</td><td>${fmtMW(r.mwh)}</td><td>${fmt$(r.loss)}</td><td>${fmtPrice(r.mwh ? r.loss / r.mwh : null)}</td><td>${fmt$(r.start)}</td><td>${fmt$(r.saves)}</td><td>${fmtPct(r.paid / r.n)}</td><td>${fmtPct(r.est / r.n)}</td></tr>`).join("") + "</tbody></table>";
  setCSV(el, ["group", "units", "ride_throughs", "mwh", "loss_usd", "start_usd", "saves_usd", "share_shutdown_paid", "share_estimated_costs"],
    rows.map((r) => [r.g, r.units, r.n, Math.round(r.mwh), Math.round(r.loss), Math.round(r.start), Math.round(r.saves), +(r.paid / r.n).toFixed(3), +(r.est / r.n).toFixed(3)]), `What the decision cost, lambda below ${thr}`);
}

// ==== the units table ======================================================================
// one row per coal and gas unit or train: its group and the cutoff behind it, how its hours
// split between states, what it did in cheap stretches and what riding through them cost,
// and its verdict on the chosen day. Rows open the Unit page.
const STATE_KEYS = [["a", "Above min"], ["m", "At min"], ["0", "Off"], ["o", "Outage"]];
const UNIT_COLS = [
  { k: "unit", h: "Unit", t: 1, f: (r) => esc(r.unit) },
  { k: "tech", h: "Technology", t: 1, f: (r) => techLabel(r.tech) },
  { k: "gi", h: "Group", t: 1, f: (r) => GROUP_LABEL[r.group] || "–" },
  { k: "mw", h: "Capacity MW", f: (r) => fmtMW(r.mw) },
  { k: "lsl", h: "LSL MW", f: (r) => (r.lsl == null ? "–" : fmtMW(r.lsl)) },
  { k: "c", h: "Cutoff $/MW LSL", f: (r) => fmtPerMW(r.c) },
  { k: "hs", h: "Hot start offered $/MW LSL", f: (r) => fmtPerMW(r.hs) + (r.hs != null && r.est === 2 ? "*" : "") },
  { k: "lift", h: "Rule right / base", f: (r) => (r.acc == null ? "–" : `${fmtPct(r.acc)} / ${fmtPct(r.base)}`) },
  { k: "days", h: "Decision days (off)", f: (r) => (r.days == null ? "–" : `${r.days} (${r.dshut})`) },
  ...STATE_KEYS.map(([s, h]) => ({ k: "st" + s, h: `${h}, share of hours`, f: (r) => (r["st" + s] == null ? "–" : fmtPct(r["st" + s])) })),
  { k: "shut", h: "Shutdowns", f: (r) => r.shut ?? "–" },
  { k: "offP10", h: "Min off, 10th pct (h)", f: (r) => (r.offP10 == null ? "–" : d3.format(",.0f")(r.offP10)) },
  { k: "offShare", h: "Turned off in cheap stretches", f: (r) => (r.offShare == null ? "–" : fmtPct(r.offShare)) },
  { k: "rides", h: "Ride-throughs", f: (r) => r.rides || "–" },
  { k: "saves", h: "Net: shutting down would have saved", f: (r) => (r.rides ? fmt$(r.saves) : "–") },
  { k: "vi", h: "Verdict on the day", t: 1, f: (r) => (r.verdict ? VERDICT[r.verdict] || r.verdict : "–") },
];
async function drawUnits() {
  const el = $("units-table");
  if (!S.I) return emptyMsg(el, "Fills in after the data update builds the intraday file.");
  if (!S.UH) { emptyMsg(el, "Loading hourly data…"); await loadUnitHours(); }
  if (!S.UH.dates.length) return emptyMsg(el, "No hourly data.");
  const B = stretchBase(), { rows: resp } = stretchResponses(+S.stThr), by = d3.group(resp, (r) => r.unit);
  const rides = ridesBy(+S.costThr) || new Map();
  const fc = new Map(S.F ? S.F.units.rows.map((r) => [r[0], Object.fromEntries(S.F.units.columns.map((c, i) => [c, r[i]]))]) : []);
  let list = [...B.units.values()].filter((e) => e.ran && e.mw > 0).map((e) => {
    const dec = decisionOf(e.unit), g = by.get(e.unit) || [], n = g.length, ri = rides.get(e.unit), f = fc.get(e.unit);
    const cnt = { a: 0, m: 0, "0": 0, o: 0 };
    for (const c of e.st) if (c in cnt) cnt[c]++;
    const nh = cnt.a + cnt.m + cnt["0"] + cnt.o;
    return { unit: e.unit, pick: e.pick, tech: e.tech, group: e.group, gi: ST_GROUPS.findIndex((x) => x.id === e.group), mw: e.mw,
      lsl: dec?.lsl ?? null, cutoff: dec?.cutoff ?? null, c: dec?.cutoff != null && dec.lsl ? dec.cutoff / dec.lsl : null,
      hs: dec?.hot && dec.lsl ? dec.hot / dec.lsl : null, est: dec?.est ?? null,
      acc: dec?.cutoff != null ? dec.acc : null, base: dec?.cutoff != null ? dec.base : null, lift: dec?.cutoff != null ? dec.acc - dec.base : null,
      days: dec?.days ?? null, dshut: dec?.shut ?? null,
      ...Object.fromEntries(STATE_KEYS.map(([s]) => ["st" + s, nh ? cnt[s] / nh : null])),
      shut: e.shut, offP10: e.offP10, offShare: n >= ST_MIN_N ? g.filter((z) => z.r === "B" || z.r === "D").length / n : null,
      rides: ri?.n || 0, saves: ri ? ri.saves : null, verdict: f?.verdict || null, vi: f ? ["off", "maybe", "on", "nocut", "outage", "peaker"].indexOf(f.verdict) : null };
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
  window.CX.setNote($("units-note"), "Every coal and gas unit with its cycling pattern, usual turn-off cost and hours in each state. Click a row to open the unit.", `${list.length} coal and gas units, combined-cycle configurations merged into their train, over the ${S.UH.dates.length} days of 60-day data. ` +
    `Cutoff is the stay-on loss per MW of LSL above which the unit has turned off on days without a day-ahead award (the cutoff curve's), with how often that rule matched what it did against the base rate of its commoner outcome. ` +
    `Hot start is the start cost in the unit's latest day-ahead offer per MW of LSL, for comparison only (* marks a generic value for the technology); no model uses it. ` +
    `Hours are split between running above minimum, at minimum, offline but available and on outage (an off spell that is mostly outage counts as outage). "Turned off in cheap stretches" is the share of the stretches with lambda below ${fmtPrice0(+S.stThr)} it was running into that it turned off for (shown once it ran into ${ST_MIN_N}), as in the panel above; ride-throughs and the net are from the decision-cost panel at lambda below ${fmtPrice0(+S.costThr)}. ` +
    `The verdict is the chosen day's forecast. Click a column to sort, a row to open the unit.`);
  el.innerHTML = `<table class="data"><thead><tr>${UNIT_COLS.map((c) => `<th class="sortable${c.t ? " t" : ""}" data-k="${c.k}" aria-sort="${c.k === col.k ? (dir > 0 ? "ascending" : "descending") : "none"}">${c.h}${c.k === col.k ? (dir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead><tbody>` +
    list.map((r) => `<tr data-href="${unitHref(r.pick)}" style="cursor:pointer">${UNIT_COLS.map((c) => `<td${c.t ? ' class="t"' : ""}>${c.f(r)}</td>`).join("")}</tr>`).join("") + "</tbody></table>";
  setCSV(el, ["unit", "technology", "group", "capacity_mw", "lsl_mw", "cutoff_usd", "cutoff_usd_per_mw_lsl", "hot_start_usd_per_mw_lsl", "rule_accuracy", "base_rate", "decision_days", "decision_shutdowns",
    "share_above_min", "share_at_min", "share_off", "share_outage", "shutdowns", "p10_hours_off", "share_turned_off_cheap", "ride_throughs", "net_shutdown_saves_usd", "verdict"],
    list.map((r) => [r.unit, r.tech, r.group, Math.round(r.mw), r.lsl, r.cutoff, r.c == null ? null : +r.c.toFixed(2), r.hs == null ? null : +r.hs.toFixed(2), r.acc, r.base, r.days, r.dshut,
      ...STATE_KEYS.map(([s]) => (r["st" + s] == null ? null : +r["st" + s].toFixed(3))), r.shut, r.offP10, r.offShare == null ? null : +r.offShare.toFixed(3), r.rides, r.saves == null ? null : Math.round(r.saves), r.verdict]), "Commitment units");
}

// ==== controls, links, boot ================================================================
function setDate(d) {
  const days = S.days;
  if (!days.includes(d)) d = days.at(-1);
  S.date = d; $("date").value = d;
  const di = days.indexOf(d);
  $("date-prev").disabled = di <= 0;
  $("date-next").disabled = di >= days.length - 1;
  const fi = S.SC?.days?.[d];
  $("source-note").textContent = fi?.sixty_day ? "Forecast, 2-day fit and 60-day answer" : fi?.two_day ? "Forecast and 2-day fit; 60-day answer pending" : "Forecast; scored once the 2-day report is out";
  saveView();
  loadDay().then(() => { if (S.uSeen) drawUnits(); });
}
const VIEW_KEYS = { cb: "cutBy", fg: "floorGroup", fh: "floorHours", f: "floorMode", stt: "stTech", stp: "stThr", stu: "stUnit", cht: "cheapTech", chthr: "cheapThr",
  lr: "leanRank", lm: "leanMonth", lp: "leanPer", cap: "capTech", ct: "costThr", ut: "uTech", ug: "uGroup", us: "uSort", ud: "uDir" };
function saveView() { window.CX.writeHash({ ...window.CX.readHash(), date: S.date, ...Object.fromEntries(Object.entries(VIEW_KEYS).map(([k, sk]) => [k, S[sk]])) }); }
function loadView() { const v = window.CX.readHash(); Object.entries(VIEW_KEYS).forEach(([k, sk]) => { if (v[k] != null) S[sk] = v[k]; }); return v; }

function drawRange() { drawStretch(); drawCapacity(); drawFloor(); drawCheap(); drawLean(); drawCost(); if (S.uSeen) drawUnits(); }
function drawAll() { drawDay(); drawRange(); }

async function boot() {
  [S.FI, S.SC, S.T, S.TH, S.I, S.HC, S.DEC, S.SO] = await Promise.all([tryJSON("data/forecast/index.json.gz"), tryJSON("data/forecast/scores.json.gz"),
    tryJSON("data/trends_60d.json.gz"), tryJSON("data/trends_hourly_60d.json.gz"), tryJSON("data/intraday_60d.json.gz"), tryJSON("data/hourly_context_60d.json.gz"),
    tryJSON("data/decisions.json.gz"), tryJSON("data/stayon_60d.json.gz")]);
  // the groups are small and every panel reads them, so they load up front; the hourly strips follow
  const g = await tryJSON("data/groups_60d.json.gz");
  S.G = g && g.units ? g : null;
  S.days = S.FI?.days || [];
  if (!S.days.length || !S.T) { $("status").textContent = "No forecast or 60-day data yet. It is built by the data update workflow."; return; }
  const D = S.T.dates;
  S.span = [D[0], D.at(-1)];
  S.last60 = D.at(-1);
  $("status").textContent = `Forecasts for ${S.days.length} days, ${S.days[0]} to ${S.days.at(-1)} · 60-day data: ${D.length} days to ${D.at(-1)}`;
  $("range-status").textContent = `${fmtDate(parseDate(D[0]))} to ${fmtDate(parseDate(D.at(-1)))}, the days with 60-day data`;
  const v = loadView();
  if (!FLOOR_NOTES[S.floorMode]) S.floorMode = "le20_sced";
  if (!["all", "10", "0"].includes(S.floorHours)) S.floorHours = "all";
  $("date").innerHTML = [...S.days].reverse().map((d) => `<option value="${d}">${fmtDate(parseDate(d))}</option>`).join("");
  $("date").onchange = (e) => setDate(e.target.value);
  const step = (k) => { const i = S.days.indexOf(S.date) + k; if (i >= 0 && i < S.days.length) setDate(S.days[i]); };
  $("date-prev").onclick = () => step(-1);
  $("date-next").onclick = () => step(1);
  const thermal = TECHS.filter((s) => THERMAL.includes(s.id));
  [["cut-by", "cutBy", drawDay], ["floor-mode", "floorMode", drawFloor], ["floor-hours", "floorHours", drawFloor], ["floor-group", "floorGroup", drawFloor],
   ["cheap-thr", "cheapThr", drawCheap], ["lean-rank", "leanRank", drawLean], ["lean-per", "leanPer", drawLean],
   ["st-thr", "stThr", () => { drawStretch(); if (S.uSeen) drawUnits(); }], ["st-unit", "stUnit", drawStretch],
   ["cost-thr", "costThr", () => { drawCost(); if (S.uSeen) drawUnits(); }]].forEach(([id, key, fn]) => { setSeg(id, S[key]); bindSeg(id, key, fn); });
  bindSelect("cap-tech", "capTech", thermal, drawCapacity);
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
  ["cheap-units", "st-changed", "st-months", "st-flags"].forEach((id) => $(id).addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-unit]");
    if (tr) location.href = unitHref(tr.dataset.unit);
  }));
  // the units table needs the hourly strips: draw it once it is about to scroll into view
  new IntersectionObserver((es, ob) => { if (es.some((e) => e.isIntersecting)) { S.uSeen = true; drawUnits(); ob.disconnect(); } }, { rootMargin: "400px" })
    .observe($("units-table"));
  setDate(v.date || S.days.at(-1));
  drawRange();
  window.CX.init();
  window.CX.panelFromLink?.();
  let t, lastW = 0;
  new ResizeObserver((e) => { const w = Math.round(e[0].contentRect.width); if (w === lastW) return; lastW = w; clearTimeout(t); t = setTimeout(drawAll, 120); }).observe(document.querySelector("main"));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", drawAll);
}
boot();
})();

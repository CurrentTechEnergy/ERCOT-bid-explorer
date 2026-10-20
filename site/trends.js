/* ERCOT Bidding Trends — long-term view. Reads data/trends_60d.json.gz and data/trends_hourly_60d.json.gz (pipeline/trends.py),
   data/curve_trends.json.gz (pipeline/curve_trends.py) and data/marginal_*.json.gz (pipeline/marginal.py). */
(() => {
"use strict";

// Colors are fixed per technology and match the day view.
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
    $("floor-note").textContent = FLOOR_GROUP_NOTE;
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
    $("floor-note").textContent = FLOOR_NOTES[S.floorMode];
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

function drawRenewBands() {
  const rs = S.C && S.C.rs;
  ["wind", "solar"].forEach((t) => {
    const el = $(`rs-${t}`);
    if (!rs) return emptyMsg(el, "No curve trends yet. They are built by the data update workflow.");
    timeChart(el, BANDS.filter((b) => rs[t][b.id]).map((b) => ({ ...b, values: rs[t][b.id] })), {
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
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y), 5).tickSizeOuter(0));
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

// ---- curtailment priced at the node ------------------------------------------------
const NC_SERIES = [
  { id: "wind_cong", tech: "wind", key: "cong", label: "Wind, congestion", color: "--c3" },
  { id: "wind_over", tech: "wind", key: "over", label: "Wind, oversupply", color: "--c3", dash: "5 3" },
  { id: "wind_dir", tech: "wind", key: "directed", label: "Wind, operator-directed", color: "--c3", dash: "1 3", width: 1.5 },
  { id: "solar_cong", tech: "solar", key: "cong", label: "Solar, congestion", color: "--c4" },
  { id: "solar_over", tech: "solar", key: "over", label: "Solar, oversupply", color: "--c4", dash: "5 3" },
  { id: "solar_dir", tech: "solar", key: "directed", label: "Solar, operator-directed", color: "--c4", dash: "1 3", width: 1.5 },
];
function drawNodeCurtail() {
  const N = S.N, el = $("nc-daily"), vel = $("nc-value"), bel = $("nc-bins"), uel = $("nc-units");
  $("nc-legend").innerHTML = NC_SERIES.map((s) => `<span><span class="sw" style="background:var(${s.color});${s.dash ? "opacity:.5" : ""}"></span>${s.label}</span>`).join("");
  if (!N || !N.dates.length) { emptyMsg(el, "No node-priced curtailment yet. It is built by the data update workflow once node prices are loaded."); vel.innerHTML = bel.innerHTML = uel.innerHTML = ""; return; }
  const nNodes = N.has_nodes.filter(Boolean).length, nOv = (N.has_overrides || []).filter(Boolean).length;
  $("nc-note").textContent = `${nNodes} of ${N.dates.length} days have node prices · ${nOv} have operator override data · ${N.n_units.wind.mapped + N.n_units.solar.mapped} units matched, ${N.n_units.wind.unmapped + N.n_units.solar.unmapped} not`;
  const gwh = (v) => (v == null ? null : v / 1000);
  timeChart(el, NC_SERIES.filter((s) => N.daily[s.tech][s.key]).map((s) => ({ label: s.label, color: s.color, dash: s.dash, width: s.width, values: N.daily[s.tech][s.key].map(gwh) })),
    { dates: N.dates, H: 240, title: "Curtailed energy by what it was worth at the node (GWh per day)", yFmt: d3.format(",.1f"), tipFmt: d3.format(",.1f"), dots: true,
      tipNote: (i) => { const u = (N.daily.wind.unmapped[i] || 0) + (N.daily.solar.unmapped[i] || 0); return u ? ` · ${fmtMW(u)} MWh unmatched` : ""; } });
  // value of the curtailed energy: at the node against at system lambda
  const k$ = (v) => (v == null ? null : v / 1000);
  timeChart(vel, [
    { label: "Wind, at the node", color: "--c3", values: N.daily.wind.value.map(k$) },
    { label: "Wind, at system lambda", color: "--c3", dash: "5 3", values: N.daily.wind.value_lam.map(k$) },
    { label: "Solar, at the node", color: "--c4", values: N.daily.solar.value.map(k$) },
    { label: "Solar, at system lambda", color: "--c4", dash: "5 3", values: N.daily.solar.value_lam.map(k$) },
  ], { dates: N.dates, H: 240, title: "What the curtailed energy would have earned ($ thousand per day; negative when the price was below zero)", yFmt: d3.format(",.0f"), tipFmt: d3.format(",.1f"), dots: true });

  // curtailed MWh by node price bin
  const labels = N.bins.labels, w = Math.max(280, bel.clientWidth || 600), narrow = w < 560, H = 260, m = { t: 18, r: 12, b: narrow ? 74 : 58, l: 56 };
  const tot = labels.map((_, i) => N.bins.wind.mwh[i] + N.bins.solar.mwh[i]);
  const x = d3.scaleBand().domain(labels).range([m.l, w - m.r]).paddingInner(0.18);
  const y = d3.scaleLinear().domain([0, Math.max(1, d3.max(tot) / 1000)]).nice().range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y), 5).tickSizeOuter(0));
  const xa = svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickSizeOuter(0));
  if (narrow) xa.selectAll("text").attr("transform", "rotate(-45)").attr("text-anchor", "end").attr("dx", "-0.4em").attr("dy", "0.5em");
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text("Curtailed energy by the price at the unit's node (GWh, days with node prices)");
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", H - 2).attr("text-anchor", "end").text("Node price when curtailed ($/MWh)");
  labels.forEach((lb, i) => {
    const cx = x(lb), bw = x.bandwidth();
    let acc = 0;
    CURT.forEach((t) => {
      const v = N.bins[t.id].mwh[i] / 1000;
      if (v > 0) svg.append("rect").attr("x", cx).attr("width", bw).attr("y", y(acc + v)).attr("height", Math.max(0, y(acc) - y(acc + v) - 1)).attr("fill", css(t.color));
      acc += v;
    });
    svg.append("rect").attr("x", cx - 2).attr("width", bw + 4).attr("y", m.t).attr("height", H - m.t - m.b).attr("fill", "transparent")
      .on("pointermove", (ev) => showTip(ev, `<h4>Node price ${lb}</h4><table>` + CURT.map((t) => `<tr><td><span class="sw" style="background:var(${t.color})"></span></td><td>${t.label}</td><td class="n">${d3.format(",.1f")(N.bins[t.id].mwh[i] / 1000)} GWh</td><td class="n">${N.bins[t.id].uh[i].toLocaleString()} unit-hours</td></tr>`).join("") + "</table>"))
      .on("pointerleave", hideTip);
  });
  bel.replaceChildren(svg.node());
  setCSV(bel, ["node_price_bin", "wind_gwh", "solar_gwh", "wind_unit_hours", "solar_unit_hours"],
    labels.map((lb, i) => [lb, N.bins.wind.mwh[i] / 1000, N.bins.solar.mwh[i] / 1000, N.bins.wind.uh[i], N.bins.solar.uh[i]]), "Curtailment by node price");

  // most curtailed units
  const rows = N.units.map((r) => ({ unit: r[0], tech: r[1], sp: r[2], curt: r[3], cong: r[4], value: r[5], node: r[6], avail: r[7], days: r[8], dir: r[9] }));
  const cols = [
    { h: "Unit", t: true, f: (r) => esc(r.unit) }, { h: "Technology", t: true, f: (r) => techLabel(r.tech) }, { h: "Settlement point", t: true, f: (r) => esc(r.sp || "–") },
    { h: "Curtailed GWh", f: (r) => d3.format(",.1f")(r.curt / 1000) }, { h: "Of available", f: (r) => (r.avail ? fmtPct(r.curt / r.avail) : "–") },
    { h: "Congestion share", f: (r) => (r.cong != null && r.curt ? fmtPct(r.cong / r.curt) : "–") },
    { h: "Operator-directed", f: (r) => (r.dir != null && r.curt ? fmtPct(r.dir / r.curt) : "–") },
    { h: "Mean node price when curtailed", f: (r) => fmtPrice(r.node) }, { h: "Worth at the node", f: (r) => (r.value == null ? "–" : fmtPrice0(r.value)) }, { h: "Days priced", f: (r) => r.days },
  ];
  uel.innerHTML = rows.length ? `<table class="data"><thead><tr>${cols.map((c) => `<th${c.t ? ' class="t"' : ""}>${c.h}</th>`).join("")}</tr></thead><tbody>` +
    rows.map((r) => `<tr>${cols.map((c) => `<td${c.t ? ' class="t"' : ""}>${c.f(r)}</td>`).join("")}</tr>`).join("") + "</tbody></table>" : "";
  setCSV(uel, ["unit", "technology", "settlement_point", "curtailed_mwh", "available_mwh", "congestion_mwh", "directed_mwh", "value_at_node", "mean_node_price", "days"],
    rows.map((r) => [r.unit, r.tech, r.sp, r.curt, r.avail, r.cong, r.dir, r.value, r.node, r.days]), "Most curtailed units");
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
    { label: "Peakers (CT and recip)", color: "--c2", values: hr("combustion_turbine") },
    { label: "Gas steam", color: "--c6", values: hr("gas_steam") },
  ], { dates: T.dates, H: 220, title: `Implied heat rate: median unit's first offer price above $0 at or above LSL ÷ ${src.hsc ? "Houston Ship Channel" : "Henry Hub"} gas (MMBtu per MWh)`, yFmt: d3.format(",.1f"), tipFmt: d3.format(",.2f"), yTicks: [0, 5, 7, 10, 15, 20] });
}

function drawPriceQuantiles() {
  const pq = S.C && S.C.pq, el = $("pq-chart");
  if (!pq || !pq[S.pqTech]) return emptyMsg(el, "No curve trends yet. They are built by the data update workflow.");
  const s = TECHS.find((t) => t.id === S.pqTech), q = pq[S.pqTech];
  // hourly lambda on the same dates, for reference: each day's offer price repeats over its hours
  const lamBy = new Map(S.I.dates.map((d, i) => [d, S.I.lambda[i]]));
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
  { id: "other_on", label: "Other online states (testing, held, starting, stopping)", color: "--c7-soft" },
  { id: "quick", label: "Offline, quick start", color: "--c2" },
  { id: "off", label: "Offline but available", color: "--c-other" },
  { id: "emr", label: "Emergency only", color: "--c5" },
  { id: "out", label: "On outage", color: "--ink-2" },
];
function drawCapacity() {
  const el = $("cap-chart"), s = TECHS.find((t) => t.id === S.capTech);
  const C = S.I && S.I.tech[S.capTech];
  if (C && C.cap_offer) {
    $("cap-note").textContent = "MW of capacity (HSL) by unit status, averaged over each day's SCED runs, from the per-unit 60-day data. \"Offline but available\" is the economic choice not to run; outages are not. Units running without an offer curve (status ONOS) are held to the MW their QSE scheduled; units testing without one are under Other online states. RUC is ERCOT committing a unit for reliability, which is rare. Quick start (OFFQS) is offline capacity SCED can start within the hour; emergency only (EMR, EMRSWGR) is kept for emergencies or can be switched to another grid, so it is not economic capacity.";
    staticLegend($("cap-legend"), STATUS6);
    const series = STATUS6.filter((g) => C["cap_" + g.id]).map((g) => ({ ...g, values: C["cap_" + g.id] }));
    return timeChart(el, series, { stack: true, dates: S.I.dates,
      stackMax: d3.max(S.I.dates, (_, i) => d3.sum(series, (x) => x.values[i] || 0)) || 1,
      H: 280, title: `${s.label}: capacity by status (MW)`, yFmt: d3.format(",.0f") });
  }
  emptyMsg(el, "No capacity data yet. It is built by the data update workflow.");
}

function drawScatter() {
  const el = $("sc-chart");
  const s = TECHS.find((t) => t.id === S.scTech), R = S.TH && S.TH.run[S.scTech];
  if (!R) return emptyMsg(el, "Not built yet. It fills in with the next data update.");
  // per hour: share of available capacity running, against that hour's lambda or the mean of the previous 168 hours
  const D = S.TH.dates, lam = lamHours();
  const yv = D.flatMap((_, i) => d3.range(24).map((h) => { const on = R.on[i]?.[h], off = R.off[i]?.[h]; return on == null || off == null || on + off <= 0 ? null : on / (on + off); }));
  const xv = S.scX === "hour" ? lam : (() => {
    const out = [], win = 168; let sum = 0, n = 0;
    lam.forEach((v, i) => {
      out.push(n >= win * 0.6 ? sum / n : null);      // needs most of the previous week
      if (v != null) { sum += v; n++; }
      const old = lam[i - win];
      if (i >= win && old != null) { sum -= old; n--; }
    });
    return out;
  })();
  const pts = xv.map((x, i) => ({ d: D[Math.floor(i / 24)], h: i % 24, x, y: yv[i] })).filter((p) => p.x != null && p.y != null);
  if (!pts.length) return emptyMsg(el, "No data.");
  const w = Math.max(280, el.clientWidth || 600);
  const H = 320, m = { t: 30, r: 16, b: 38, l: 56 };
  // clip extreme prices so the bulk of hours stays readable; they still count in the bands
  const xmax = Math.min(d3.max(pts, (p) => p.x), d3.quantile(pts.map((p) => p.x).sort(d3.ascending), 0.98) * 1.2);
  const x = d3.scaleLinear().domain([Math.min(0, d3.min(pts, (p) => p.x)), xmax]).nice().range([m.l, w - m.r]);
  const shown = pts.filter((p) => p.x <= x.domain()[1]), offN = pts.length - shown.length;
  const y = d3.scaleLinear().domain([0, 1]).range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(axisFmt(d3.axisBottom(x), w < 560 ? 4 : 8, "$").tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y), 5, fmtKind(fmtPct)).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text(`${s.label}: share of available capacity running, by hour`);
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", H - 4).attr("text-anchor", "end")
    .text(S.scX === "hour" ? "System lambda that hour ($/MWh)" : "Average system lambda over the previous 7 days ($/MWh)");
  if (offN) svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 24)
    .text(`${offN.toLocaleString()} hour${offN === 1 ? "" : "s"} above ${d3.format("$,.0f")(x.domain()[1])} not shown`);
  svg.append("g").selectAll("circle").data(shown).join("circle").attr("cx", (p) => x(p.x)).attr("cy", (p) => y(p.y)).attr("r", 2)
    .attr("fill", css(s.color)).attr("fill-opacity", 0.3)
    .on("pointermove", (ev, p) => showTip(ev, `<h4>${fmtDate(parseDate(p.d))} · ${heLabel(p.h)}</h4>${fmtPct(p.y)} of available capacity running<br>Lambda ${fmtPrice(p.x)}`))
    .on("pointerleave", hideTip);
  // median per $5 band (bands with at least 12 hours)
  const bands = d3.groups(pts, (p) => Math.floor(p.x / 5) * 5).filter(([, g]) => g.length >= 12)
    .map(([b, g]) => ({ x: b + 2.5, y: d3.median(g, (p) => p.y), n: g.length })).sort((a, b) => a.x - b.x);
  svg.append("path").attr("fill", "none").attr("stroke", css("--ink")).attr("stroke-width", 2)
    .attr("d", d3.line().defined((b) => b.x <= x.domain()[1]).x((b) => x(b.x)).y((b) => y(b.y))(bands));
  el.replaceChildren(svg.node());
  setCSV(el, ["date", "hour_ending", S.scX === "hour" ? "lambda_same_hour" : "lambda_prev_7_days", "share_of_available_capacity_running"], pts.map((p) => [p.d, p.h + 1, p.x, p.y]), "Running vs price");
}

function drawPartial() {
  const list = TECHS.filter((s) => THERMAL.includes(s.id) && !S.hidden.partial.has(s.id));
  timeChart($("partial-chart"), list.map((s) => ({ ...s, values: S.T.starts[s.id] || [] })), { title: "Unit starts per day" });
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
const MN_TECHS = TECHS.filter((s) => s.id !== "other").concat([{ id: "other", keys: ["other", "hydro"], label: "Other (hydro, biomass)", color: "--c-other" }]);
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

// ---- mitigation ------------------------------------------------------------------------
function drawMitigation() {
  const D = S.MIT, del = $("mit-daily"), uel = $("mit-units");
  $("mit-legend").innerHTML = MN_TECHS.map((t) => `<span><span class="sw" style="background:var(${t.color})"></span>${t.label}</span>`).join("");
  const nCov = D ? D.covered.filter(Boolean).length : 0;
  if (!D || !nCov) {
    $("mit-note").textContent = "";
    $("mit-check").textContent = "";
    uel.innerHTML = "";
    return emptyMsg(del, "No mitigation data yet. It needs per-unit files with the SCED2 curve (format 6), written for new days by the update workflow and for older days by a reprocess.");
  }
  const ci = Object.fromEntries(D.days.columns.map((c, i) => [c, i]));
  const techOf = (t) => MN_TECHS.find((s) => s.keys.includes(t)) || MN_TECHS.at(-1);
  const dts = D.dates.filter((d, i) => D.covered[i]);
  const byDay = new Map(dts.map((d) => [d, Object.fromEntries(MN_TECHS.map((t) => [t.id, 0]))]));
  let hMit = 0, hBp = 0, hSet = 0, imp = 0;
  D.days.rows.forEach((r) => {
    const a = byDay.get(r[ci.date]);
    if (a) a[techOf(r[ci.tech]).id] += r[ci.h_mit] || 0;
    hMit += r[ci.h_mit] || 0; hBp += r[ci.h_mit_bp] || 0; hSet += r[ci.h_set] || 0; imp += r[ci.impact_sum] || 0;
  });
  $("mit-note").textContent = `${nCov} days · ${D.n_mitigated} of ${D.n_units} units mitigated at least once · ${fmtMW(hMit)} mitigated unit-hours, ${fmtMW(hBp)} at the base point, ${fmtMW(hSet)} setting the price` +
    (hSet ? ` (LMP lowered by ${fmtPrice(imp / hSet)} on average)` : "");
  const series = MN_TECHS.map((t) => ({ ...t, values: dts.map((d) => byDay.get(d)[t.id]) })).filter((s) => d3.sum(s.values) > 0);
  timeChart(del, series, { dates: dts, stack: true, stackMax: Math.max(1, d3.max(dts, (d) => d3.sum(Object.values(byDay.get(d))))), H: 220,
    yFmt: d3.format(",.0f"), tipFmt: d3.format(",.1f"), title: "Mitigated unit-hours per day" });
  const C = D.check;
  $("mit-check").textContent = C && C.n ? `Check against ERCOT's published node prices, ${C.n.toLocaleString()} runs where a mitigated unit set the price: the mitigated price is within $5 of the node price in ${fmtPct(C.within5_mitigated)} of them, the price the unit offered in ${fmtPct(C.within5_offered)}.` : "";
  const uc = Object.fromEntries(D.units.columns.map((c, i) => [c, i]));
  const urows = D.units.rows;
  const g = (r, k) => r[uc[k]];
  const cols = [
    { h: "Unit", t: true, f: (r) => esc(g(r, "unit")) }, { h: "Technology", t: true, f: (r) => techLabel(g(r, "tech")) },
    { h: "Hours online", f: (r) => fmtMW(g(r, "hours_online")) },
    { h: "Hours mitigated", f: (r) => `${d3.format(",.1f")(g(r, "h_mit"))} (${fmtPct(g(r, "h_mit") / (g(r, "hours_online") || 1))})` },
    { h: "Days mitigated", f: (r) => g(r, "days_mitigated") },
    { h: "At the base point", f: (r) => d3.format(",.1f")(g(r, "h_mit_bp")) },
    { h: "Mean cut at base point", f: (r) => fmtPrice(g(r, "mean_cut_bp")) }, { h: "Largest cut", f: (r) => fmtPrice(g(r, "max_cut")) },
    { h: "Hours setting the price", f: (r) => d3.format(",.1f")(g(r, "h_set")) }, { h: "Mean LMP lowered by", f: (r) => fmtPrice(g(r, "mean_impact")) },
    { h: "Node within $5: mitigated / offered", f: (r) => (g(r, "n_checked") ? `${fmtPct(g(r, "within5_mitigated"))} / ${fmtPct(g(r, "within5_offered"))}` : "–") },
  ];
  uel.innerHTML = `<p class="note">Units most often mitigated. Cuts are in $/MWh.</p><table class="data"><thead><tr>${cols.map((c) => `<th${c.t ? ' class="t"' : ""}>${c.h}</th>`).join("")}</tr></thead><tbody>` +
    urows.map((r) => `<tr>${cols.map((c) => `<td${c.t ? ' class="t"' : ""}>${c.f(r)}</td>`).join("")}</tr>`).join("") + "</tbody></table>";
  setCSV(uel, D.units.columns, urows, "Mitigated units");
}

// ---- bidding-approach changes -----------------------------------------------------
function drawChanges() {
  const T = S.T, techOf = Object.fromEntries(T.units.map((u) => [u.unit, u]));
  $("chg-note").textContent = `A change is a shift that holds: the median over the ${T.window} online days after a day differs from the median over the ${T.window} online days before by at least 25 percentage points of the dispatchable range (above LSL) offered at or below $0, half the day running without an offer curve, or $10 in first offer price above $0 (at or above LSL) relative to that day's median for its peers (which removes moves in fuel price). Peers are units of the same ERCOT resource type (for example CCGT90 or SCLE90) when at least 8 of them have a price that day, otherwise the same technology. Thermal units only. Click a row to see the unit.`;
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
    { label: "First offer price above $0, at or above LSL", color: s.color, values: u.first },
    { label: "Peer median", color: "--muted", values: median, dash: "4 3", width: 1.5 },
  ], { title: "First offer price above $0 at or above LSL ($/MWh), and the median of its peers", H: 170, yFmt: d3.format("$,.0f"), tipFmt: fmtPrice, markers: marks, dots: true,
    tipNote: (i) => (u.peer && u.peer[i] != null ? ` · peers: ${u.peer[i] ? `${u.type} units` : `all ${s.label.toLowerCase()}`}` : "") });
  timeChart($("unit-share"), [
    { label: "Share of MW above LSL offered ≤ $0", color: s.color, values: u.le0 },
    { label: "Share of day without an offer curve", color: "--muted", values: u.noff, dash: "4 3", width: 1.5 },
  ], { title: "Share of MW above LSL offered ≤ $0, and share of day without an offer curve", H: 150, yFmt: d3.format(".0%"), markers: marks, dots: true });
}

// day × hour state of one unit: offline, at minimum, above minimum; negative-price hours marked
const STRIP_STATES = { "0": "Offline", o: "On outage", m: "Running at minimum", a: "Running above minimum" };
async function drawUnitStrip(u, s, marks) {
  const el = $("unit-strip");
  if (!S.UH) {
    el.innerHTML = `<p class="empty">Loading hourly data…</p>`;
    await loadUnitHours();
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
  const x = dateX(w, m);
  const cw = x(d3.timeDay.offset(x.domain()[0], 1)) - x(x.domain()[0]);
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
  dateAxis(svg, x, w, H, m);
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text("Hour by hour: offline, at minimum or above minimum");
  marks.forEach((mk) => svg.append("line").attr("class", "crosshair").attr("x1", x(parseDate(mk.d))).attr("x2", x(parseDate(mk.d))).attr("y1", m.t).attr("y2", H - m.b).style("stroke", css(mk.color)));
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", ch * 24).attr("fill", "transparent")
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
  $("shut-note").textContent = `Each bar counts ${s.label.toLowerCase()} units that went from online to off on that day${priceTxt}. Combined-cycle configurations are merged into their train, so a train that keeps running in another configuration does not count as shut down. Units that went on outage while off are left out, as are spells shorter than an hour. The lower chart shows, for the units back within 24 hours, the hours of the day they were off, as an average number of units per day, with the average lambda for each hour across all days as a dashed line (right axis).`;
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
  $("st-month-note").textContent = `Each cell is the share of hours with system lambda below ${fmtPrice0(thr)} that month in which the unit kept running, out of the hours it was available (running or off but not on outage). ` +
    `Dark means it rode through, light means it turned off. Blank cells are untested: fewer than ${ST_MIN_CHEAP_H} cheap hours while the unit was available, or the unit on outage. ` +
    `A unit's own month can be untested in a month with cheap hours if it was on outage for them. Rows are sorted by group, then capacity. Click a row to open the unit.`;
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
const ST_SORT = [
  { id: "off", label: "Share turned off", f: (a, b) => d3.descending(a.offShare ?? -1, b.offShare ?? -1) },
  { id: "p10", label: "Minimum hours off (10th pct)", f: (a, b) => d3.ascending(a.offP10 ?? 1e9, b.offP10 ?? 1e9) },
  { id: "n", label: "Stretches running into", f: (a, b) => d3.descending(a.n, b.n) },
  { id: "cutoff", label: "Day-ahead cutoff", f: (a, b) => d3.ascending(a.dec?.cutoff ?? 1e12, b.dec?.cutoff ?? 1e12) },
  { id: "lift", label: "Cutoff rule over base rate", f: (a, b) => d3.descending(a.dec ? a.dec.acc - a.dec.base : -1, b.dec ? b.dec.acc - b.dec.base : -1) },
];
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
  $("st-note").textContent = `A cheap stretch is a run of consecutive hours with system lambda below ${fmtPrice0(thr)}. There were ${nEps} from ${period}. ` +
    `Each bar is the total capacity (HSL) of one group of ${S.stTech === "all" ? "coal and gas" : s.label.toLowerCase()} units, grouped by how they ran over the whole period: ${ST_GROUPS.map((g) => `${g.label.toLowerCase()} (${g.note})`).join("; ")}. ` +
    `Each unit's capacity is split by what it did across the ${nEps} stretches: turned off in the ${ST_LEAD} hours before, turned off during, ran at minimum or above minimum (when it was already running ${ST_LEAD} hours before the stretch began), or not running going in (offline, on outage or no data). Units that never ran in the period are left out. ` +
    `Each combined-cycle train counts as one unit, so switching configuration is not a shutdown. Nuclear is left out. Lambda is the system price; a unit's own nodal price can differ.`;
  fleetBars(el, groups, s, S.stUnit === "mw" ? "Capacity of each group, MW, split by what it did in cheap stretches" : "Share of each group's capacity, by what it did in cheap stretches");
  drawMonths(fleet, s, thr);
  // unit table
  const list = [...B.units.values()].filter((e) => ts.includes(e.tech) && (by.has(e.unit) || e.shut > 0)).map((e) => {
    const g = by.get(e.unit) || [], n = g.length, c = (id) => (n >= ST_MIN_N ? g.filter((r) => r.r === id).length / n : null);
    return { ...e, n, offShare: n >= ST_MIN_N ? c("B") + c("D") : null, minShare: c("M"), aboveShare: c("A"), dec: decisionOf(e.unit) };
  }).sort(ST_SORT.find((x) => x.id === S.stSort).f);
  const DEC = S.DEC || {};
  const gl = (id) => ST_GROUPS.find((g) => g.id === id).label, hrs = (v) => (v == null ? "–" : d3.format(",.0f")(v)), pc = (v) => (v == null ? "–" : fmtPct(v));
  $("st-units-note").textContent = `${list.length} units. "Stretches" counts the cheap stretches a unit was already running into; the next three columns say what it did in them (shown once a unit has at least ${ST_MIN_N}). ` +
    `"Shutdowns" and hours off cover every shutdown in the period, cheap or not, in whole hours. An offline spell that is mostly on declared outage, or has under 4 hours OFF before the outage, is an outage, not a shutdown; a shutdown with some outage hours inside it counts whole. For a combined-cycle train a single offline hour is taken as a configuration change. ` +
    `The 10th percentile of hours off is a steadier guide to a unit's real minimum down time than its single shortest spell, which can be a trip and quick restart. ` +
    (DEC.units ? `The last four columns score the decision day-ahead (${DEC.dates.length} days): on every day the unit started online, what riding through the day's worst window of hours would have lost at its own node's day-ahead price (minimum-energy cost minus price, times LSL, before any start cost), and whether it shut down for ${DEC.out_min_h} hours or more. ` +
      `"Cutoff" is the loss above which it turned off on days with no DAM award covering that window, chosen to separate its shutdowns from its stays best (once it has ${DEC.min_days} decision days with at least ${DEC.min_each} of each; a $0 cutoff means it turned off whenever riding through lost anything). ` +
      `"Rule right" is how often "off when no award and the loss is above the cutoff, else on" matched what it did, against "base", the share of its commoner outcome; a rule no better than base says the price was not what decided it. "Awarded" is the share of its days with an award over the window. ` : "") +
    `Click a unit to open its detail.`;
  const cols = [
    { h: "Unit", t: 1, f: (r) => esc(r.name) }, { h: "Technology", t: 1, f: (r) => techLabel(r.tech) }, { h: "Group", t: 1, f: (r) => gl(r.group) }, { h: "MW", f: (r) => d3.format(",.0f")(r.mw) },
    { h: "Stretches", f: (r) => r.n }, { h: "Turned off", f: (r) => pc(r.offShare) }, { h: "At min", f: (r) => pc(r.minShare) }, { h: "Above min", f: (r) => pc(r.aboveShare) },
    { h: "Shutdowns", f: (r) => r.shut }, { h: "Shortest off (h)", f: (r) => hrs(r.offMin) }, { h: "Min off, 10th pct (h)", f: (r) => hrs(r.offP10) }, { h: "Median off (h)", f: (r) => hrs(r.offMed) },
    ...(DEC.units ? [
      { h: "Decision days", f: (r) => (r.dec ? `${r.dec.days} (${r.dec.shut} off)` : "–") }, { h: "Cutoff, no award", f: (r) => fmtK(r.dec?.cutoff) },
      { h: "Rule right", f: (r) => pc(r.dec?.cutoff != null ? r.dec.acc : null) }, { h: "Base", f: (r) => pc(r.dec?.base) }, { h: "Awarded", f: (r) => pc(r.dec?.award) },
    ] : []),
  ];
  $("st-units").innerHTML = list.length ? unitRows(list.map((r) => ({ ...r, name: r.unit, unit: r.pick })), cols)
    : `<p class="empty">No units match.</p>`;
  setCSV(el, ["unit", "technology", "group", "stretches_running_into", "share_turned_off", "share_at_minimum", "share_above_minimum", "shutdowns", "shortest_hours_off", "p10_hours_off", "median_hours_off", "mw",
    "decision_days", "decision_shutdowns", "cutoff_no_award_usd", "rule_accuracy", "base_rate", "award_share"],
    list.map((r) => [r.unit, r.tech, r.group, r.n, r.offShare, r.minShare, r.aboveShare, r.shut, r.offMin, r.offP10, r.offMed, r.mw,
      r.dec?.days, r.dec?.shut, r.dec?.cutoff, r.dec?.cutoff != null ? r.dec.acc : null, r.dec?.base, r.dec?.award]), `Cheap stretches, lambda below ${thr}`);
  drawNext(B, ts, gl);
  drawFlags(B, ts, gl);
  if (S.unit && S.T.units.find((u) => u.unit === S.unit) && !$("unit-detail").hidden) {
    const u = S.T.units.find((x) => x.unit === S.unit); drawUnitStretch(u, TECHS.find((x) => x.id === u.tech), S.stripScale);
  }
}

// Tomorrow's expected turn-offs: the latest day with day-ahead node prices, each unit's worst
// loss window at its node against its cutoff (pipeline/decisions.py). The award for that day is
// not public yet, so a unit that often holds one over its window is "maybe" rather than "off".
const NEXT_VERDICT = { off: "Off", maybe: "Maybe: often awarded", on: "On" };
function drawNext(B, ts, gl) {
  const el = $("st-next"), DEC = S.DEC, tm = DEC?.tomorrow;
  if (!tm) { $("st-next-note").textContent = ""; return emptyMsg(el, "Fills in once the data update has fetched day-ahead node prices (NP4-190-CD) for a coming day."); }
  const rows = tm.rows.filter((r) => ts.includes(r[1]) && r[8]).map((r) => {
    const e = B.units.get(r[0]);
    return { unit: r[0], pick: e?.pick || r[0], tech: r[1], group: e?.group, lsl: r[2], loss: r[3], he: r[4], h: r[5], cutoff: r[6], award: r[7], v: r[8] };
  }).sort((a, b) => d3.ascending(["off", "maybe", "on"].indexOf(a.v), ["off", "maybe", "on"].indexOf(b.v)) || d3.descending(a.loss, b.loss));
  const noRule = tm.rows.filter((r) => ts.includes(r[1]) && !r[8]).length;
  const mw = (v) => d3.sum(rows.filter((r) => r.v === v), (r) => r.lsl);
  // how the verdicts have done on days whose 60-day data has since arrived
  const sc = DEC.scored || [], known = sc.length;
  const hit = (v, s) => sc.filter((x) => x[2] === v && x[3] === s).length;
  const fmtD = d3.timeFormat("%A %b %-d");
  $("st-next-note").textContent = `Day-ahead prices for ${fmtD(parseDate(tm.date))} at each unit's own node, against its latest minimum-energy cost and LSL: the worst window of hours and what riding through it at minimum would lose, before any start cost. ` +
    `Units with a cutoff get a verdict: off when the loss is above it, on when at or below, "maybe" when above it but the unit held a DAM award over its window on half or more of its days (tomorrow's awards are not public until the 60-day disclosure). ` +
    `${rows.filter((r) => r.v === "off").length} units expected off (${fmtMW(mw("off"))} MW of LSL), ${rows.filter((r) => r.v === "maybe").length} maybe (${fmtMW(mw("maybe"))} MW), ${rows.filter((r) => r.v === "on").length} on (${fmtMW(mw("on"))} MW); ${noRule} units have no cutoff. ` +
    `Whether a unit is online going into the day is not known either: these are the units that had decision days in the period. ` +
    (known ? `Verdicts checked so far against days whose 60-day data has arrived: ${known}; "off" was right ${hit("off", 1)} of ${hit("off", 1) + hit("off", 0)} times, "on" ${hit("on", 0)} of ${hit("on", 0) + hit("on", 1)}, "maybe" turned off ${hit("maybe", 1)} of ${hit("maybe", 1) + hit("maybe", 0)} times.` : "No verdict has a known outcome yet: the 60-day data for a scored day arrives two months later.");
  if (!rows.length) return emptyMsg(el, "No units with a cutoff match.");
  el.innerHTML = unitRows(rows.map((r) => ({ ...r, name: r.unit, unit: r.pick })), [
    { h: "Verdict", t: 1, f: (r) => NEXT_VERDICT[r.v] }, { h: "Unit", t: 1, f: (r) => esc(r.name) }, { h: "Technology", t: 1, f: (r) => techLabel(r.tech) }, { h: "Group", t: 1, f: (r) => (r.group ? gl(r.group) : "–") },
    { h: "LSL MW", f: (r) => fmtMW(r.lsl) }, { h: "Worst window", t: 1, f: (r) => (r.h ? `HE ${r.he}–${r.he + r.h - 1} (${r.h} h)` : "none: profitable all day") }, { h: "Loss riding through", f: (r) => fmtK(r.loss) },
    { h: "Cutoff", f: (r) => fmtK(r.cutoff) }, { h: "Awarded", f: (r) => fmtPct(r.award) },
  ]);
  setCSV(el, ["date", "verdict", "unit", "technology", "group", "lsl_mw", "window_first_he", "window_hours", "loss_usd", "cutoff_usd", "award_share"],
    rows.map((r) => [tm.date, r.v, r.unit, r.tech, r.group, r.lsl, r.he, r.h, r.loss, r.cutoff, r.award]), `Expected turn-offs ${tm.date}`);
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
  $("st-flags-note").textContent = `Every shutdown on a decision day that was the unit's first in ${DEC.new_days} days or more (with at least ${DEC.new_days} days of data before it), or came over a window its DAM energy award covered in full: ` +
    `a unit that normally rides through starting to cycle, a seasonal layup beginning, or a unit dropping an award it held. ${n("new")} first-in-a-month and ${n("award")} despite-an-award shutdowns, newest first. ` +
    `"Loss" is what riding through the day's worst window would have cost at its node's day-ahead price; "hours off" counts to the end of the spell, so a long one is a layup or an undeclared outage. Click a unit to open its detail.`;
  if (!rows.length) return emptyMsg(el, "No flagged shutdowns for these units.");
  el.innerHTML = unitRows(rows.map((r) => ({ ...r, name: r.unit, unit: r.pick })), [
    { h: "Date", t: 1, f: (r) => r.date }, { h: "Unit", t: 1, f: (r) => esc(r.name) }, { h: "Technology", t: 1, f: (r) => techLabel(r.tech) }, { h: "Group", t: 1, f: (r) => gl(r.group) }, { h: "MW", f: (r) => fmtMW(r.mw) },
    { h: "Why flagged", t: 1, f: (r) => FLAG_KIND[r.kind] }, { h: "Days since last shutdown", f: (r) => (r.since == null ? "none in data" : r.since) }, { h: "Loss riding through", f: (r) => fmtK(r.loss) },
    { h: "Award over window", f: (r) => fmtPct(r.award) }, { h: "Hours off", f: (r) => fmtMW(r.off) },
  ]);
  setCSV(el, ["date", "unit", "technology", "group", "mw", "kind", "days_since_last_shutdown", "loss_usd", "award_share", "hours_off"],
    rows.map((r) => [r.date, r.unit, r.tech, r.group, r.mw, r.kind, r.since, r.loss, r.award, r.off]), "Shutdowns that broke a pattern");
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
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y), 4).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${w - m.r},0)`).call(axisFmt(d3.axisRight(yl), 4, "$").tickSizeOuter(0));
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
    $("heat-note").textContent = `MW of ${s.label.toLowerCase()} offered at or below ${+S.heatThr === -249 ? "the price floor" : fmtPrice0(+S.heatThr)} in each hour, from the 60-day curves as used in SCED. Click a cell to open that day and hour on Beyond baseload.`;
  } else {
    if (!I) return emptyMsg(el, "Fills in after the data update builds the intraday file.");
    dstr = I.dates;
    const ts = techsOf(S.heatTech), s = S.heatTech === "all" ? ALL_THERMAL : TECHS.find((x) => x.id === S.heatTech);
    if (meas === "lambda") val = (i, h) => I.lambda[i][h];
    else val = (i, h) => (I.tech[ts[0]].n[i] ? d3.sum(ts, (t) => I.tech[t].above[i][h] + (meas === "running" ? I.tech[t].at_min[i][h] : 0)) : null);
    $("heat-note").textContent = meas === "lambda" ? "Hourly system lambda. Negative hours are red. Click a cell to open that day and hour on Beyond baseload."
      : `${meas === "running" ? "Output" : "Output above minimum (LSL)"} of running ${s.label.toLowerCase()} units, from the 60-day disclosure. Click a cell to open that day and hour on Beyond baseload.`;
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
    .on("pointermove", (ev, c) => showTip(ev, `<h4>${fmtDate(parseDate(c.d))} · HE ${c.h + 1}</h4><b>${fmtV(c.v)}</b><br><span class="tip-pin-note">Click to open on Beyond baseload</span>`))
    .on("pointerleave", hideTip)
    .on("click", (ev, c) => { location.href = `beyond.html#date=${c.d}&he=${c.h + 1}&p=curves-panel`; });
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
  $("lean-note").textContent = `The ${top.length} hours with the least ${fossil ? "fossil (coal, combined cycle, gas steam and combustion turbine)" : "thermal (fossil and nuclear)"} output, ${scope}` +
    `${S.leanPer === "day" ? ", one per day" : ""}, from the 60-day disclosure. Output counts every unit's telemetered MW, including units starting up, shutting down or online for under half the hour ("starting/stopping"). ` +
    `"Above min." is output above each running unit's LSL; the rest of the running units' output is what they could not shed without shutting down. ` +
    `Storage is net output (negative while charging); hub avg is the HB_HUBAVG settlement point price. Click a row to open that hour on Beyond baseload.`;
  if (!top.length) { el.innerHTML = `<p class="empty">No hours in this range.</p>`; setCSV(el, [], [], "Leanest thermal hours"); return; }
  el.innerHTML = `<table class="data"><thead><tr>${cols.map((c) => `<th${c.t ? ' class="t"' : ""}>${c.h}</th>`).join("")}</tr></thead><tbody>` +
    top.map((r) => `<tr data-href="beyond.html#date=${r.d}&he=${r.h + 1}&p=curves-panel" style="cursor:pointer">${cols.map((c) => `<td${c.t ? ' class="t"' : ""}>${c.f(r)}</td>`).join("")}</tr>`).join("") + "</tbody></table>";
  setCSV(el, cols.map((c) => c.k), top.map(val), "Leanest thermal hours");
}

// ---- links ------------------------------------------------------------------------
const VIEW_KEYS = { fg: "floorGroup", fh: "floorHours", stu: "stUnit", stt: "stTech", stp: "stThr", sts: "stSort", cht: "cheapTech", chthr: "cheapThr", sht: "shutTech", shp: "shutPrice", hm: "heatMeasure", ht: "heatTech", hthr: "heatThr", hs: "heatScale", lr: "leanRank", lm: "leanMonth", lp: "leanPer", f: "floorMode", pq: "pqTech", cap: "capTech", sc: "scTech", scx: "scX", ms: "mSrc", mv: "mView", md: "mDays", mnm: "mnMeasure", mnd: "mnDays", ct: "chgTech", cs: "chgSig", unit: "unit" };
function saveView() { window.CX.writeHash(Object.fromEntries(Object.entries(VIEW_KEYS).map(([k, sk]) => [k, S[sk]]))); }
function loadView() { const v = window.CX.readHash(); Object.entries(VIEW_KEYS).forEach(([k, sk]) => { if (v[k] != null) S[sk] = v[k]; }); }

// ---- boot ---------------------------------------------------------------------------
function drawAll() { drawFloor(); drawRenewBands(); drawCurtailment(); drawNodeCurtail(); drawPriceQuantiles(); drawGas(); drawCapacity(); drawScatter(); drawPartial(); drawCheap(); drawShut(); drawStretch(); if (heatSeen) drawHeat(); drawLean(); drawMarginal(); drawNodeMarginal(); drawMitigation(); drawChanges(); }
let heatSeen = false;

async function boot() {
  [S.T, S.TH, S.C, S.I, S.N, S.G, S.GH, S.MN, S.MIT, S.HC, S.DEC] = await Promise.all([tryJSON("data/trends_60d.json.gz"), tryJSON("data/trends_hourly_60d.json.gz"), tryJSON("data/curve_trends.json.gz"), tryJSON("data/intraday_60d.json.gz"),
    tryJSON("data/curtail_nodes.json.gz"), tryJSON("data/gas.json.gz"), tryJSON("data/gas_hubs.json.gz"), tryJSON("data/marginal_nodes.json.gz"), tryJSON("data/mitigation.json.gz"),
    tryJSON("data/hourly_context_60d.json.gz"), tryJSON("data/decisions.json.gz")]);
  if (!S.T) { $("status").textContent = "No trends data yet. It is built by the data update workflow."; return; }
  const D = S.T.dates;
  // one date range for every daily chart: all the bid and curtailment data (gas is trimmed to it)
  const spans = [D, S.C?.rs?.dates, S.C?.curt?.dates, S.C?.pq?.dates, S.N?.dates, S.I?.dates].filter((d) => d && d.length);
  S.span = [d3.min(spans, (d) => d[0]), d3.max(spans, (d) => d.at(-1))];
  S.last60 = D.at(-1);
  $("status").textContent = `60-day data: ${D.length} days, ${D[0]} to ${D[D.length - 1]} · ${S.T.units.length} thermal units` +
    (S.C ? ` · wind and solar offers through ${S.C.rs.dates.at(-1)}` : "");
  loadView();
  if (!FLOOR_NOTES[S.floorMode]) S.floorMode = "le20_sced";    // a measure from an older saved view
  if (!["all", "10", "0"].includes(S.floorHours)) S.floorHours = "all";
  if (S.scX === "day") S.scX = "hour";                             // the scatter was daily before it went hourly
  const thermal = TECHS.filter((s) => THERMAL.includes(s.id));
  [["floor-mode", "floorMode", drawFloor], ["floor-hours", "floorHours", drawFloor], ["sc-x", "scX", drawScatter], ["mbp-src", "mSrc", drawMarginal], ["mbp-view", "mView", drawMarginal], ["mbp-days", "mDays", drawMarginal],
   ["mn-measure", "mnMeasure", drawNodeMarginal], ["mn-days", "mnDays", drawNodeMarginal]]
    .forEach(([id, key, fn]) => { setSeg(id, S[key]); bindSeg(id, key, fn); });
  setSeg("floor-group", S.floorGroup); bindSeg("floor-group", "floorGroup", drawFloor);
  legend($("partial-legend"), thermal, S.hidden.partial, drawPartial);
  staticLegend($("rs-legend"), BANDS);
  bindSelect("pq-tech", "pqTech", thermal.filter((s) => s.id !== "nuclear"), drawPriceQuantiles);
  bindSelect("cap-tech", "capTech", thermal, drawCapacity);
  bindSelect("sc-tech", "scTech", thermal, drawScatter);
  bindSelect("chg-tech", "chgTech", [{ id: "all", label: "All" }, ...thermal], drawChanges);
  bindSelect("chg-sig", "chgSig", [{ id: "all", label: "All" }, ...Object.entries(S.T.signals).map(([id, label]) => ({ id, label }))], drawChanges);
  [["cheap-thr", "cheapThr", drawCheap], ["shut-price", "shutPrice", drawShut], ["heat-scale-mode", "heatScale", drawHeat],
   ["lean-rank", "leanRank", drawLean], ["lean-per", "leanPer", drawLean]].forEach(([id, key, fn]) => { setSeg(id, S[key]); bindSeg(id, key, fn); });
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
  $("lean-table").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-href]"); if (tr) location.href = tr.dataset.href; });
  ["chg-table", "flip-table", "cheap-units", "shut-units", "st-units", "st-changed", "st-months", "st-next", "st-flags"].forEach((id) => $(id).addEventListener("click", (e) => {
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

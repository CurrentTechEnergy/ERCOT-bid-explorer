/* Unit page: everything about one unit, reached from any unit row (unit.html?unit=NAME).
   This file: the unit picker, the header with the latest forecast's verdict and the decision
   history behind the unit's cutoff (data/decisions.json.gz, data/forecast/), hours online and
   starts (data/unit_hours_60d.json.gz), one day by hour (data/60d-units/) and the thermal bidding charts (data/trends_60d.json.gz),
   lifted from trends.js. unit-econ.js draws revenue and cost and unit-renew.js the wind and
   solar hedge formula and bidding history; both redraw on the "unitchange" event this file sends. */
(() => {
"use strict";

// Colors are fixed per technology and match the other pages.
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
const TECH_OF = Object.fromEntries(TECHS.map((t) => [t.id, t]));
const techLabel = (t) => (TECH_OF[t] ? TECH_OF[t].label : t === "storage" ? "Storage (ESR)" : t === "hydro" ? "Hydro" : t || "–");
const SIG_FMT = { le0: (v) => d3.format(".0%")(v), noff: (v) => d3.format(".0%")(v), rel: (v) => (v >= 0 ? "+" : "−") + d3.format("$,.0f")(Math.abs(v)) };
const GROUP_SHORT = { never: "Never off", seasonal: "Seasonal", multiday: "Multi-day", daily1: "Daily, under once a week", daily2: "Daily, 1 to 2 a week", daily3: "Daily, over 2 a week", ungrouped: "Not yet grouped" };
const VERDICT = { on: "expected on", off: "expected off", maybe: "maybe: off on its loss but often holds a day-ahead award", nocut: "no cutoff yet (too few decision days)", outage: "on outage", peaker: "peaker: judged by its history at this price and hour" };
const S = { econ: {}, day: null, T: null, DEC: null, UH: null, SP: null, FI: null, FC: null, PPA: null, list: new Map(), unit: null, cfg: null, span: null, last60: null };
const { tryJSON, showTip, hideTip, setCSV, tickFormat, fmtKind, axisFmt, css, esc } = window.CX;
const $ = (id) => document.getElementById(id);
const fmtMW = d3.format(",.0f");
const fmtPct = d3.format(".0%");
const fmtPrice = (v) => (v == null || isNaN(v) ? "–" : d3.format("$,.2f")(v));
const fmtPrice0 = (v) => d3.format("$,.0f")(v);
const fmt$ = (v) => (v == null || isNaN(v) ? "–" : (v < 0 ? "−" : "") + "$" + d3.format(",.0f")(Math.abs(v)));
const parseDate = (d) => new Date(d + "T12:00:00");
const fmtDate = d3.timeFormat("%a %b %-d, %Y");
const HOUR_MS = 36e5;
const hourTime = (d, h) => new Date(parseDate(d).getTime() + (h - 11.5) * HOUR_MS);
const heLabel = (h) => `HE ${String(h + 1).padStart(2, "0")}`;
const trainOf = (u) => { const m = /^(.*_CC\d+)_/.exec(u); return m ? m[1] : u; };
function emptyMsg(el, msg) { el.innerHTML = `<p class="empty">${msg}</p>`; }

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

// ---- the unit list: thermal trains (a combined-cycle train with its configurations), wind and solar --
function buildList() {
  const add = (name, tech, cfg) => {
    const e = S.list.get(name) || { name, tech, configs: [] };
    if (!e.tech && tech) e.tech = tech;
    if (cfg && !e.configs.includes(cfg)) e.configs.push(cfg);
    S.list.set(name, e);
  };
  (S.T?.units || []).forEach((u) => add(u.tech === "combined_cycle" ? trainOf(u.unit) : u.unit, u.tech, u.unit));
  Object.entries(S.DEC?.units || {}).forEach(([n, r]) => add(n, r[0]));
  if (S.FC) S.FC.units.rows.forEach((r) => add(r[0], r[1]));
  (S.PPA?.units || []).forEach((u) => add(u.name, u.tech));
  S.list.forEach((e) => e.configs.sort());
  $("unit-list").innerHTML = [...S.list.values()].sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => `<option value="${esc(e.name)}">${techLabel(e.tech)}</option>`).join("");
}

// ---- header: what the unit is and the latest forecast's verdict --------------------------
function fcRow(name) {
  if (!S.FC) return null;
  const c = S.FC.units.columns, r = S.FC.units.rows.find((x) => x[0] === name);
  return r ? Object.fromEntries(c.map((k, i) => [k, r[i]])) : null;
}
function drawHead(e) {
  $("unit-title").textContent = e.name;
  const f = fcRow(e.name), ppa = (S.PPA?.units || []).find((u) => u.name === e.name);
  const bits = [techLabel(e.tech)];
  if (e.configs.length > 1) bits.push(`${e.configs.length} configurations: ${e.configs.join(", ")}`);
  if (f) bits.push(`${fmtMW(f.hsl)} MW maximum, ${fmtMW(f.lsl)} MW minimum (day-ahead)`);
  if (ppa && ppa.sp) bits.push(`node ${ppa.sp}`);
  $("unit-meta").textContent = bits.join(" · ");
  const v = $("unit-verdict");
  if (!f) { v.textContent = THERMAL.includes(e.tech) ? "Not in the latest forecast." : ""; return; }
  const g = GROUP_SHORT[f.group] || f.group;
  v.innerHTML = `Forecast for <b>${esc(S.FC.date)}</b>: <b>${esc(VERDICT[f.verdict] || f.verdict)}</b>` +
    (f.p_on != null ? ` (chance of running ${fmtPct(f.p_on)})` : "") + `. Group: <b>${esc(g)}</b>.` +
    (f.loss != null ? ` Riding through the day's worst stretch would lose it ${fmt$(f.loss)} at its own node` : "") +
    (f.cutoff != null ? `, against its own cutoff of ${fmt$(f.cutoff)}.` : f.loss != null ? "." : "") +
    (f.off_from ? ` Expected off for ${f.off_hours} h from HE ${f.off_from}.` : "") +
    (f.reason && f.loss == null ? ` <span class="muted">${esc(f.reason)}.</span>` : "") +
    ` <a href="overview.html#date=${esc(S.FC.date)}">Overview for that day</a>.`;
}

// ---- decision history: every day the unit started online, its loss and what it did ----------
// data/decisions.json.gz days rows: [train, date, loss, first HE of the window, hours, award share, shut, hours off]
const DEC_U = { tech: 0, lsl: 1, mingen: 2, hot: 3, est: 4, days: 5, shut: 6, award: 7, base: 8, cutoff: 9, acc: 10, stayMax: 11, shutMin: 12 };
function drawDecisions(e) {
  const el = $("dec-chart"), D = S.DEC, u = D && D.units[e.name];
  const rows = D ? D.days.filter((r) => r[0] === e.name && r[2] != null) : [];
  $("dec-panel").hidden = !THERMAL.includes(e.tech) || e.tech === "nuclear";
  if ($("dec-panel").hidden) return;
  if (!u || !rows.length) { $("dec-note").textContent = ""; return emptyMsg(el, "No decision days for this unit in the loaded 60-day data."); }
  const g = (k) => u[DEC_U[k]];
  $("dec-note").textContent = `${g("days")} decision days, ${g("shut")} shutdowns, a day-ahead award over the window on ${fmtPct(g("award") || 0)} of them. ` +
    (g("cutoff") != null ? `Cutoff ${fmt$(g("cutoff"))}: off when no award covers the window and the loss is above it. That rule calls ${fmtPct(g("acc"))} of its days right, against ${fmtPct(g("base"))} for always guessing its commoner outcome. ` +
      `Highest loss it stayed on through: ${fmt$(g("stayMax"))}; lowest it shut on: ${fmt$(g("shutMin"))}.`
      : "No cutoff yet: it needs 15 decision days with at least 3 shutdowns and 3 stays.") +
    (g("est") === 2 ? " Costs are the technology's generic costs (no three-part offer of its own in the window)." : "");
  const w = Math.max(280, el.clientWidth || 600), H = 240, m = { t: 18, r: 16, b: 26, l: 70 };
  const pts = rows.map((r) => ({ d: r[1], t: parseDate(r[1]), loss: r[2], he: r[3], h: r[4], aw: r[5], shut: r[6], off: r[7] }));
  const x = d3.scaleTime().domain([d3.timeHour.offset(parseDate(D.dates[0]), -12), d3.timeHour.offset(parseDate(D.dates.at(-1)), 12)]).range([m.l, w - m.r]);
  const vals = pts.map((p) => p.loss).concat(g("cutoff") != null ? [g("cutoff")] : []);
  const y = d3.scaleLinear().domain([Math.min(0, d3.min(vals)), Math.max(1, d3.max(vals))]).nice().range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(w < 560 ? 4 : 8).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y), 5, "$k").tickSizeOuter(0));
  if (y.domain()[0] < 0) svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(0)).attr("y2", y(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text("Day-ahead loss of staying on through the day's worst stretch ($)");
  if (g("cutoff") != null) {
    svg.append("line").attr("class", "price-rule").attr("stroke-dasharray", "5 3").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(g("cutoff"))).attr("y2", y(g("cutoff")));
    svg.append("text").attr("class", "axis-title").attr("x", w - m.r - 4).attr("y", y(g("cutoff")) - 5).attr("text-anchor", "end")
      .attr("paint-order", "stroke").attr("stroke", css("--surface")).attr("stroke-width", 3).text(`cutoff ${fmt$(g("cutoff"))}`);
  }
  const shape = (p) => (p.aw >= 0.5 ? d3.symbolSquare : d3.symbolCircle);
  svg.append("g").selectAll("path").data(pts).join("path")
    .attr("transform", (p) => `translate(${x(p.t)},${y(p.loss)})`).attr("d", (p) => d3.symbol(shape(p), 34)())
    .attr("fill", (p) => (p.shut ? css("--c8") : css("--surface"))).attr("stroke", (p) => (p.shut ? css("--surface") : css("--c1"))).attr("stroke-width", 1.2);
  const ts = pts.map((p) => p.t);
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const [px, py] = d3.pointer(ev);
      const i = d3.minIndex(pts, (p) => Math.hypot(x(p.t) - px, (y(p.loss) - py) / 3)), p = pts[i];
      showTip(ev, `<h4>${fmtDate(p.t)}</h4><table><tr><td>Loss of staying on</td><td class="n">${fmt$(p.loss)}</td></tr>` +
        `<tr><td>Worst stretch</td><td class="n">${p.h} h from HE ${p.he}</td></tr><tr><td>Day-ahead award over it</td><td class="n">${fmtPct(p.aw)}</td></tr>` +
        `<tr><td>What it did</td><td class="n">${p.shut ? `shut down, off ${p.off} h` : "stayed on"}</td></tr></table>`);
    })
    .on("pointerleave", hideTip);
  el.replaceChildren(svg.node());
  setCSV(el, ["date", "loss_usd", "window_first_he", "window_hours", "award_share", "shut", "hours_off"], pts.map((p) => [p.d, p.loss, p.he, p.h, p.aw, p.shut, p.off]), `${e.name} decision days`);
  $("dec-legend").innerHTML = `<span><span class="sw" style="background:var(--surface);border:1.5px solid var(--c1);border-radius:50%"></span>Stayed on</span>` +
    `<span><span class="sw" style="background:var(--c8);border-radius:50%"></span>Shut down</span><span><span class="sw" style="background:var(--ink-2)"></span>Square: a day-ahead award covered the stretch</span>` +
    (g("cutoff") != null ? `<span><span class="sw sw-line"></span>Its cutoff</span>` : "");
}

// ---- hours: hour by hour online, at minimum or above, with starts --------------------------
// A combined-cycle train is online when any of its configurations is (the rule decisions.py uses).
const STRIP_STATES = { "0": "Offline", o: "On outage", m: "Running at minimum", a: "Running above minimum" };
const RANK = { a: 4, m: 3, "0": 2, o: 1, "-": 0 };
function trainStrip(e) {
  const U = S.UH.units, parts = (e.configs.length ? e.configs : [e.name]).map((c) => U[c]).filter(Boolean);
  if (!parts.length) return U[e.name] || null;
  if (parts.length === 1) return parts[0];
  return [...parts[0]].map((_, k) => parts.map((p) => p[k] || "-").reduce((a, b) => (RANK[b] > RANK[a] ? b : a))).join("");
}
function drawHours(e) {
  const el = $("hours-strip"), s = TECH_OF[e.tech] || { color: "--c-other" };
  $("hours-panel").hidden = !THERMAL.includes(e.tech);
  if ($("hours-panel").hidden) return;
  if (!S.UH) return emptyMsg(el, "No hourly data loaded.");
  const str = trainStrip(e);
  $("hours-legend").innerHTML = [["--grid", 1, "Offline"], ["--ink-2", 0.35, "On outage"], [s.color, 0.4, "Running at minimum (LSL)"], [s.color, 1, "Running above minimum"]]
    .map(([c, o, l]) => `<span><span class="sw" style="background:var(${c});opacity:${o}"></span>${l}</span>`).join("") +
    `<span><span class="sw sw-neg"></span>Hour with lambda below $0</span>`;
  if (!str) { $("hours-note").textContent = ""; return emptyMsg(el, "No hourly data for this unit."); }
  const dstr = S.UH.dates, dates = dstr.map(parseDate), D = dstr.length;
  // starts per day from data/econ/<tech> (pipeline/econ.py): telemetered status moving from not
  // online to on, run by run, with a combined-cycle train counted whole so configuration switches
  // are not starts; the same counts Revenue and cost prices
  const E = S.econ[e.tech], eu = E && E.units[e.name], ei = E ? new Map(E.dates.map((d, i) => [d, i])) : new Map();
  const startsByDay = dstr.map((d) => (eu && ei.has(d) ? eu.starts[ei.get(d)] || 0 : 0));
  const nStarts = d3.sum(startsByDay), twoShift = startsByDay.filter((n) => n >= 2).length;
  const hrs = (c) => [...str].filter((x) => x === c).length;
  $("hours-note").textContent = `Over ${D} days: ${fmtMW(hrs("a") + hrs("m"))} hours online (${fmtMW(hrs("m"))} of them at minimum), ${fmtMW(hrs("0"))} offline, ${fmtMW(hrs("o"))} on outage. ` +
    `${nStarts} start${nStarts === 1 ? "" : "s"}${twoShift ? `, with two or more starts on ${twoShift} day${twoShift === 1 ? "" : "s"} (two-shifting)` : ""}.` +
    (e.configs.length > 1 ? " Configurations are merged: the train counts as online when any of them is." : "");
  const lam = new Map(Object.entries(S.SP || {}).map(([d, v]) => [d, v.lambda]));
  const w = Math.max(280, el.clientWidth || 600), m = { t: 16, r: 16, b: 26, l: 64 }, ch = 7, H = m.t + m.b + ch * 24;
  const x = d3.scaleTime().domain([d3.timeHour.offset(dates[0], -12), d3.timeHour.offset(dates[D - 1], 12)]).range([m.l, w - m.r]);
  const cw = x(d3.timeDay.offset(x.domain()[0], 1)) - x(x.domain()[0]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  const col = { "0": css("--grid"), o: css("--ink-2"), m: css(s.color), a: css(s.color) };
  const gg = svg.append("g");
  for (let i = 0; i < D; i++) for (let h = 0; h < 24; h++) {
    const c = str[i * 24 + h];
    if (c === "-" || c === undefined) continue;
    gg.append("rect").attr("x", x(dates[i]) - cw / 2).attr("y", m.t + h * ch).attr("width", cw + 0.3).attr("height", ch - 0.5)
      .attr("fill", col[c]).attr("fill-opacity", c === "m" ? 0.4 : c === "o" ? 0.35 : 1);
  }
  const t = svg.append("g");
  dstr.forEach((d, i) => (lam.get(d) || []).forEach((v, h) => {
    if (v != null && v < 0) t.append("rect").attr("x", x(dates[i]) - 0.75).attr("y", m.t + h * ch + 1.5).attr("width", 1.5).attr("height", ch - 3.5).attr("fill", css("--ink"));
  }));
  const y = d3.scaleBand().domain(d3.range(24)).range([m.t, m.t + ch * 24]);
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l - 4},0)`).call(d3.axisLeft(y).tickValues([0, 5, 11, 17, 23]).tickFormat((h) => `HE ${h + 1}`).tickSize(0)).select(".domain").remove();
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(w < 560 ? 4 : 8).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text("Hour by hour: offline, at minimum or above minimum");
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", ch * 24).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const [px, py] = d3.pointer(ev);
      const i = d3.minIndex(dates, (d) => Math.abs(d - x.invert(px))), h = Math.max(0, Math.min(23, Math.floor((py - m.t) / ch)));
      const L = (lam.get(dstr[i]) || [])[h];
      showTip(ev, `<h4>${fmtDate(dates[i])} · HE ${h + 1}</h4>${STRIP_STATES[str[i * 24 + h]] || "No data"}<br>Lambda ${fmtPrice(L)}` +
        (startsByDay[i] ? `<br>${startsByDay[i]} start${startsByDay[i] === 1 ? "" : "s"} this day` : ""));
    })
    .on("pointerleave", hideTip);
  el.replaceChildren(svg.node());
  setCSV(el, ["date", "hour_ending", "state"], dstr.flatMap((d, i) => d3.range(24).map((h) => [d, h + 1, STRIP_STATES[str[i * 24 + h]] || ""])), `${e.name} hourly state`);
}

// ---- one day by hour: output, base point and limits, with lambda (data/60d-units/<date>) ----
const dayCache = new Map();
const loadDayUnits = (d) => { if (!dayCache.has(d)) dayCache.set(d, tryJSON(`data/60d-units/${d}.json.gz`)); return dayCache.get(d); };
function defaultDay(e) {
  const str = S.UH && trainStrip(e), D = S.UH ? S.UH.dates : [];
  for (let i = D.length - 1; str && i >= 0; i--) if (/[ma]/.test(str.slice(i * 24, i * 24 + 24))) return D[i];
  return D.at(-1);
}
async function drawDay(e) {
  const el = $("day-chart");
  $("day-panel").hidden = !THERMAL.includes(e.tech) && e.tech !== "wind" && e.tech !== "solar";
  if ($("day-panel").hidden || !S.UH) return;
  const dates = S.UH.dates;
  if (!S.day || !dates.includes(S.day)) S.day = defaultDay(e);
  $("day-pick").innerHTML = dates.slice().reverse().map((d) => `<option${d === S.day ? " selected" : ""}>${d}</option>`).join("");
  const day = S.day, f = await loadDayUnits(day);
  if (S.unit !== e.name || S.day !== day) return;
  if (!f) { $("day-note").textContent = ""; return emptyMsg(el, `No hourly unit file for ${day}.`); }
  const names = new Set(e.configs.length ? e.configs : [e.name]), ci = Object.fromEntries(f.columns.map((c, i) => [c, i + 2]));
  const idx = new Set(f.units.map((u, i) => (names.has(u[0]) ? i : -1)).filter((i) => i >= 0));
  // a combined-cycle train sums its configurations (only one is online in an hour, bar a changeover)
  const H = d3.range(24).map((h) => ({ h, out: null, bp: null, hsl: null, lsl: null, n: 0 }));
  f.rows.forEach((r) => {
    if (!idx.has(r[0])) return;
    const x = H[r[1] - 1];
    ["out", "bp", "hsl", "lsl"].forEach((k, j) => { const v = r[ci[["output", "base_point", "hsl", "lsl"][j]]]; if (v != null) x[k] = (x[k] || 0) + v; });
    x.n++;
  });
  const lam = (S.SP && S.SP[day] && S.SP[day].lambda) || [];
  const on = H.filter((x) => x.n);
  $("day-note").textContent = on.length ? `Online ${on.length} of 24 hours on ${fmtDate(parseDate(day))}: ${fmtMW(d3.sum(on, (x) => x.out || 0))} MWh` + (THERMAL.includes(e.tech) ? `, against ${fmtMW(d3.sum(on, (x) => x.lsl || 0))} MWh at minimum. ` : ". ") +
    `Hourly means over the SCED runs it was online; telemetered output, the base point SCED sent, and its limits.` : `Offline all day on ${fmtDate(parseDate(day))}.`;
  const s = TECH_OF[e.tech] || { color: "--c-other" };
  const w = Math.max(280, el.clientWidth || 600), Hh = 230, Hp = 110, m = { t: 18, r: 16, b: 26, l: 64 };
  const x = d3.scaleBand().domain(d3.range(24)).range([m.l, w - m.r]).padding(0.15);
  const top = d3.max(H, (v) => Math.max(v.hsl || 0, v.out || 0, v.bp || 0)) || 1;
  const y = d3.scaleLinear().domain([Math.min(0, d3.min(H, (v) => v.out) || 0), top]).nice().range([Hh - m.b, m.t]);
  const lv = lam.filter((v) => v != null);
  const yp = d3.scaleLinear().domain([Math.min(0, d3.min(lv) || 0), Math.max(10, d3.max(lv) || 0)]).nice().range([Hh + Hp - m.b, Hh + m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${Hh + Hp}`);
  const tickH = w < 560 ? [0, 5, 11, 17, 23] : d3.range(0, 24, 2);
  [[y, 0], [yp, Hh]].forEach(([sc]) => svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(sc).ticks(4).tickSize(-(w - m.l - m.r)).tickFormat("")));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y), 4, "MW").tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(yp), 3, "$").tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${Hh + Hp - m.b})`).call(d3.axisBottom(x).tickValues(tickH).tickFormat((h) => `HE ${h + 1}`).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text("Output, base point and limits (MW)");
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", Hh + 10).text("System lambda ($/MWh)");
  const bw = x.bandwidth();
  // band between minimum and maximum output while online
  H.forEach((v) => {
    if (!v.n || v.hsl == null) return;
    svg.append("rect").attr("x", x(v.h)).attr("width", bw).attr("y", y(v.hsl)).attr("height", Math.max(0, y(v.lsl || 0) - y(v.hsl))).attr("fill", css(s.color)).attr("fill-opacity", 0.14);
    svg.append("line").attr("x1", x(v.h)).attr("x2", x(v.h) + bw).attr("y1", y(v.lsl || 0)).attr("y2", y(v.lsl || 0)).attr("stroke", css(s.color)).attr("stroke-width", 1).attr("stroke-dasharray", "3 2");
    svg.append("rect").attr("x", x(v.h) + bw * 0.2).attr("width", bw * 0.6).attr("y", y(Math.max(0, v.out || 0))).attr("height", Math.abs(y(0) - y(v.out || 0))).attr("fill", css(s.color));
    if (v.bp != null) svg.append("line").attr("x1", x(v.h)).attr("x2", x(v.h) + bw).attr("y1", y(v.bp)).attr("y2", y(v.bp)).attr("stroke", css("--ink")).attr("stroke-width", 1.5);
  });
  if (yp.domain()[0] < 0) svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", yp(0)).attr("y2", yp(0));
  lam.forEach((v, h) => { if (v != null) svg.append("rect").attr("x", x(h) + bw * 0.2).attr("width", bw * 0.6).attr("y", yp(Math.max(0, v))).attr("height", Math.abs(yp(0) - yp(v))).attr("fill", css(v < 0 ? "--c8" : "--ink-2")); });
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", Hh + Hp - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const px = d3.pointer(ev)[0], h = Math.max(0, Math.min(23, Math.floor((px - m.l) / x.step()))), v = H[h];
      showTip(ev, `<h4>${fmtDate(parseDate(day))} · HE ${h + 1}</h4><table>` + (v.n ? `<tr><td>Output</td><td class="n">${fmtMW(v.out)} MW</td></tr><tr><td>Base point</td><td class="n">${v.bp == null ? "–" : fmtMW(v.bp) + " MW"}</td></tr>` +
        `<tr><td>Minimum to maximum</td><td class="n">${fmtMW(v.lsl)} to ${fmtMW(v.hsl)} MW</td></tr>` : `<tr><td colspan="2">Offline</td></tr>`) + `<tr><td>Lambda</td><td class="n">${fmtPrice(lam[h])}</td></tr></table>`);
    })
    .on("pointerleave", hideTip);
  el.replaceChildren(svg.node());
  setCSV(el, ["hour_ending", "output_mw", "base_point_mw", "lsl_mw", "hsl_mw", "lambda"], H.map((v) => [v.h + 1, v.out, v.bp, v.lsl, v.hsl, lam[v.h] ?? null]), `${e.name} ${day} by hour`);
  $("day-legend").innerHTML = `<span><span class="sw" style="background:var(${s.color})"></span>Output</span><span><span class="sw sw-line" style="border-top-color:var(--ink)"></span>Base point</span>` +
    `<span><span class="sw" style="background:var(${s.color});opacity:0.25"></span>Minimum to maximum output</span><span><span class="sw" style="background:var(--c8)"></span>Lambda below $0</span>`;
}

// ---- bidding (thermal, per configuration), lifted from the Trends unit detail -------------
const SIG_COLOR = { le0: "--c8", noff: "--c7", rel: "--c4" };
function drawUnit(u) {
  const T = S.T, s = TECHS.find((x) => x.id === u.tech);
  const ch = T.changes.filter((c) => c[0] === u.unit);
  const marks = ch.map((c) => ({ d: c[2], color: SIG_COLOR[c[3]] }));
  $("bid-title-note").textContent = `${u.unit} · ${u.type}`;
  $("bid-note").innerHTML = (ch.length ? `${ch.length} bidding change${ch.length === 1 ? "" : "s"} detected, marked on every chart by a line colored by the kind of change: ` +
    Object.entries(T.signals).map(([k, l]) => `<span class="mk" style="border-color:var(${SIG_COLOR[k]})"></span>${l}`).join(", ") + "." : "No bidding changes detected.") + " Days offline are gaps in the line charts.";
  $("bid-changes").innerHTML = ch.length ? `<table class="data"><thead><tr><th class="t">Date</th><th class="t">Change</th><th>Before</th><th>After</th></tr></thead><tbody>` +
    ch.map((c) => `<tr><td class="t">${c[2]}</td><td class="t"><span class="mk" style="border-color:var(${SIG_COLOR[c[3]]})"></span>${T.signals[c[3]]}</td><td>${SIG_FMT[c[3]](c[4])}</td><td>${SIG_FMT[c[3]](c[5])}</td></tr>`).join("") + "</tbody></table>" : "";
  const median = u.first.map((v, i) => (v == null || u.rel[i] == null ? null : v - u.rel[i]));
  timeChart($("bid-price"), [
    { label: "First offer price above $0, at or above LSL", color: s.color, values: u.first },
    { label: "Peer median", color: "--muted", values: median, dash: "4 3", width: 1.5 },
  ], { title: "First offer price above $0 at or above LSL ($/MWh), and the median of its peers", H: 170, yFmt: d3.format("$,.0f"), tipFmt: fmtPrice, markers: marks, dots: true,
    tipNote: (i) => (u.peer && u.peer[i] != null ? ` · peers: ${u.peer[i] ? `${u.type} units` : `all ${s.label.toLowerCase()}`}` : "") });
  timeChart($("bid-share"), [
    { label: "Share of MW above LSL offered ≤ $0", color: s.color, values: u.le0 },
    { label: "Share of day without an offer curve", color: "--muted", values: u.noff, dash: "4 3", width: 1.5 },
  ], { title: "Share of MW above LSL offered ≤ $0, and share of day without an offer curve", H: 150, yFmt: d3.format(".0%"), markers: marks, dots: true });
}

function drawBidding(e) {
  const thermal = THERMAL.includes(e.tech) && e.tech !== "nuclear";
  $("bid-panel").hidden = !thermal;
  if (!thermal) return;
  const cfgs = e.configs.filter((c) => S.T.units.some((u) => u.unit === c));
  if (!cfgs.length) { $("bid-cfg").innerHTML = ""; $("bid-title-note").textContent = ""; $("bid-note").textContent = "";
    ["bid-price", "bid-share"].forEach((id) => emptyMsg($(id), "No offer data for this unit in the loaded 60-day days.")); $("bid-changes").innerHTML = ""; return; }
  // default to the configuration with the most days of offers
  const days = (c) => S.T.units.find((u) => u.unit === c).first.filter((v) => v != null).length;
  if (!cfgs.includes(S.cfg)) S.cfg = cfgs.reduce((a, b) => (days(b) > days(a) ? b : a));
  $("bid-cfg").innerHTML = cfgs.length > 1 ? `<label class="lbl inline" for="cfg">Configuration</label><select id="cfg">${cfgs.map((c) => `<option${c === S.cfg ? " selected" : ""}>${esc(c)}</option>`).join("")}</select>` : "";
  if ($("cfg")) $("cfg").onchange = (ev) => { S.cfg = ev.target.value; saveView(); drawBidding(e); };
  drawUnit(S.T.units.find((u) => u.unit === S.cfg));
}

// ---- page ------------------------------------------------------------------------------
// the unit goes in the query (unit.html?unit=NAME, the link other pages make), the view in the hash
function saveView() {
  const q = S.unit ? `?unit=${encodeURIComponent(S.unit)}` : "";
  if (q !== location.search) history.replaceState(null, "", q + location.hash);
  window.CX.writeHash({ cfg: S.cfg && S.list.get(S.unit)?.configs.length > 1 ? S.cfg : null, day: S.day });
}
function draw() {
  const e = S.list.get(S.unit);
  $("unit-empty").hidden = !!e;
  if (!e) return;
  document.title = `${e.name} · ERCOT Bid Stack Explorer`;
  drawHead(e); drawDecisions(e); drawHours(e); drawDay(e); drawBidding(e);
}
async function select(name, cfg, keepDay) {
  if (!S.list.has(name)) return;
  S.unit = name; S.cfg = cfg || null;
  if (!keepDay) S.day = null;
  $("unit-pick").value = name;
  const e = S.list.get(name);
  if (!(e.tech in S.econ)) S.econ[e.tech] = await tryJSON(`data/econ/${e.tech}.json.gz`);
  if (S.unit !== name) return;
  window.UNIT = { ...e, econ: S.econ[e.tech] };
  draw(); saveView();
  window.dispatchEvent(new CustomEvent("unitchange", { detail: window.UNIT }));
}

async function boot() {
  const v = window.CX.readHash();
  [S.T, S.DEC, S.UH, S.SP, S.FI, S.PPA] = await Promise.all([tryJSON("data/trends_60d.json.gz"), tryJSON("data/decisions.json.gz"),
    tryJSON("data/unit_hours_60d.json.gz"), tryJSON("data/summary_prices.json.gz"), tryJSON("data/forecast/index.json.gz"), tryJSON("data/ppa.json.gz")]);
  S.FC = S.FI && S.FI.days.length ? await tryJSON(`data/forecast/${S.FI.days.at(-1)}.json.gz`) : null;
  if (S.T) { S.span = [S.T.dates[0], S.T.dates.at(-1)]; S.last60 = S.T.dates.at(-1); }
  buildList();
  $("status").textContent = `${S.list.size} units · 60-day data ${S.T ? `${S.T.dates[0]} to ${S.T.dates.at(-1)}` : "not loaded"}` + (S.FC ? ` · forecast ${S.FC.date}` : "");
  const pick = $("unit-pick");
  pick.addEventListener("change", () => select(pick.value.trim()));
  pick.addEventListener("input", () => { if (S.list.has(pick.value)) select(pick.value); });
  window.CX.init();
  $("day-pick").addEventListener("change", (ev) => { S.day = ev.target.value; saveView(); drawDay(S.list.get(S.unit)); });
  const want = new URLSearchParams(location.search).get("unit") || v.unit;
  S.day = v.day || null;
  if (want && S.list.has(want)) select(want, v.cfg, true); else draw();
  let t, lastW = 0;
  new ResizeObserver((en) => { const w = Math.round(en[0].contentRect.width); if (w === lastW) return; lastW = w; clearTimeout(t); t = setTimeout(() => { draw(); window.dispatchEvent(new CustomEvent("unitresize")); }, 150); }).observe(document.querySelector("main"));
}
boot();
})();

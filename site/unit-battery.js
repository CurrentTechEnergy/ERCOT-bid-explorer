/* Unit page, batteries: one day by hour (base point against the day-ahead award, state of charge,
   offer prices against the day-ahead price at its node) from data/storage/<date>.json.gz, and its
   history across days from data/storage/units.json.gz (pipeline/storage.py). Shown only for
   storage; redraws on unit.js's "unitchange" event. */
(() => {
"use strict";

const { tryJSON, showTip, hideTip, setCSV, tickFormat, fmtKind, css } = window.CX;
const $ = (id) => document.getElementById(id);
const S = { U: null, day: null, idx: null };
const fmtMW = d3.format(",.0f");
const fmt1 = d3.format(",.1f");
const fmtPrice = (v) => (v == null || isNaN(v) ? "–" : d3.format("$,.2f")(v));
const parseDate = (d) => new Date(d + "T12:00:00");
const fmtDate = d3.timeFormat("%a %b %-d, %Y");
const heLabel = (h) => `HE ${String(h + 1).padStart(2, "0")}`;
const HOURS = d3.range(24);
const dayCache = new Map();
const loadDay = (d) => { if (!dayCache.has(d)) dayCache.set(d, tryJSON(`data/storage/${d}.json.gz`)); return dayCache.get(d); };
function emptyMsg(el, msg) { el.innerHTML = `<p class="empty">${msg}</p>`; }
function legend(el, list) {
  el.innerHTML = list.map((s) => `<span><span class="sw" style="background:var(${s.color});${s.dash ? "opacity:.55" : ""}"></span>${s.label}</span>`).join("");
}

// hourly chart: bars (signed, one series each side) and lines; opts { title, H, yFmt, tipFmt, price }
function hourChart(el, bars, lines, opts) {
  const w = Math.max(280, el.clientWidth || 600), H = opts.H || 240, m = { t: 18, r: 14, b: 28, l: 64 };
  const x = d3.scaleLinear().domain([0.5, 24.5]).range([m.l, w - m.r]);
  const all = [...bars, ...lines].flatMap((s) => s.values).filter((v) => v != null);
  if (!all.length) return emptyMsg(el, opts.empty || "No data for this day.");
  const y = opts.price
    ? d3.scaleSymlog().constant(10).domain([Math.min(-10, d3.min(all)), Math.max(50, d3.max(all))]).range([H - m.b, m.t])
    : d3.scaleLinear().domain([Math.min(0, d3.min(all)), Math.max(opts.yMin || 0, d3.max(all))]).nice().range([H - m.b, m.t]);
  const yt = opts.price ? [-250, -50, -10, 0, 10, 25, 50, 100, 250, 500, 1000, 2000].filter((v) => v >= y.domain()[0] && v <= y.domain()[1]) : y.ticks(5);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).tickValues(yt).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).tickValues(yt).tickFormat(tickFormat(yt, fmtKind(opts.yFmt))).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`)
    .call(d3.axisBottom(x).tickValues(w < 560 ? [1, 6, 12, 18, 24] : d3.range(1, 25)).tickFormat(d3.format("d")).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text(opts.title);
  if (y.domain()[0] < 0) svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(0)).attr("y2", y(0));
  const bw = Math.max(2, (x(2) - x(1)) * 0.72);
  bars.forEach((b) => b.values.forEach((v, h) => {
    if (!v) return;
    svg.append("rect").attr("x", x(h + 1) - bw / 2).attr("width", bw).attr("y", y(Math.max(0, v))).attr("height", Math.abs(y(0) - y(v))).attr("fill", css(b.color));
  }));
  const line = d3.line().defined((v) => v != null).x((_, h) => x(h + 1)).y((v) => y(v));
  lines.forEach((s) => {
    svg.append("path").attr("fill", "none").attr("stroke", css(s.color)).attr("stroke-width", s.width || 2).attr("stroke-dasharray", s.dash || null).attr("d", line(s.values));
    s.values.forEach((v, h) => { if (v != null && s.values[h - 1] == null && s.values[h + 1] == null) svg.append("circle").attr("cx", x(h + 1)).attr("cy", y(v)).attr("r", 2.2).attr("fill", css(s.color)); });
  });
  const tf = opts.tipFmt || fmtMW;
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", H - m.b).style("display", "none");
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const h = Math.max(0, Math.min(23, Math.round(x.invert(d3.pointer(ev)[0])) - 1));
      cross.style("display", null).attr("x1", x(h + 1)).attr("x2", x(h + 1));
      showTip(ev, `<h4>${heLabel(h)}</h4><table>` + [...bars, ...lines].filter((s) => s.values[h] != null).map((s) =>
        `<tr><td><span class="sw" style="background:var(${s.color})"></span></td><td>${s.label}</td><td class="n">${tf(s.values[h])}</td></tr>`).join("") + "</table>");
    })
    .on("pointerleave", () => { cross.style("display", "none"); hideTip(); });
  el.replaceChildren(svg.node());
  const cols = [...bars, ...lines];
  setCSV(el, ["hour_ending", ...cols.map((s) => s.label)], HOURS.map((h) => [h + 1, ...cols.map((s) => s.values[h])]), opts.csv);
}

// one day of the battery from the storage day file
async function drawDay(name) {
  const day = S.day, f = await loadDay(day);
  if (!S.U || S.U.name !== name || S.day !== day) return;
  const u = f && f.units[name], els = ["batt-day-chart", "batt-soc-chart", "batt-offer-chart"].map($);
  if (!u) { $("batt-day-note").textContent = ""; els.forEach((el, i) => (i ? (el.innerHTML = "") : emptyMsg(el, `No data for this battery on ${day}.`))); return; }
  const neg = (a) => (a ? a.map((v) => (v == null ? null : -v)) : HOURS.map(() => null));
  const bp = u.bp || HOURS.map(() => null);
  const bars = [
    { label: "Discharging", color: "--c7", values: bp.map((v) => (v != null && v > 0 ? v : null)) },
    { label: "Charging", color: "--c7-soft", values: bp.map((v) => (v != null && v < 0 ? v : null)) },
  ];
  // a DAM row with no award in an hour is no award: draw it at zero
  const lines = u.dam ? [{ label: "Day-ahead award", color: "--c2", dash: "5 3", values: u.dam.map((v) => v ?? 0) }] : [];
  legend($("batt-day-legend"), [...bars, ...lines]);
  hourChart(els[0], bars, lines, { title: "Base point by hour (MW; charging below zero)", yFmt: fmtMW, tipFmt: (v) => `${fmt1(v)} MW`, csv: `${name} ${day} by hour` });
  const dis = d3.sum(bp, (v) => Math.max(0, v || 0)), chg = d3.sum(bp, (v) => Math.max(0, -(v || 0)));
  const dam = u.dam ? [d3.sum(u.dam, (v) => Math.max(0, v || 0)), d3.sum(u.dam, (v) => Math.max(0, -(v || 0)))] : null;
  $("batt-day-note").textContent = `${fmtDate(parseDate(day))} · ${fmtMW(chg)} MWh charged, ${fmtMW(dis)} MWh discharged` +
    (dam ? ` · day-ahead ${fmtMW(dam[1])} and ${fmtMW(dam[0])}` : " · no day-ahead energy award");
  if (u.soc) {
    const flat = (v) => HOURS.map(() => v);
    hourChart(els[1], [], [
      { label: "State of charge", color: "--c7", values: u.soc },
      { label: "Maximum", color: "--c-other", dash: "4 3", width: 1.2, values: flat(u.soc_max) },
      { label: "Minimum", color: "--c-other", dash: "1 3", width: 1.2, values: flat(u.soc_min) },
    ], { title: `State of charge (MWh)${u.soc_max && u.hsl ? ` · about ${fmt1(u.soc_max / u.hsl)} hours at full output` : ""}`, H: 170, yFmt: fmtMW, tipFmt: (v) => `${fmt1(v)} MWh`, csv: `${name} ${day} state of charge` });
  } else emptyMsg(els[1], "No state of charge reported this day.");
  const offers = [
    { label: "Half the charging", color: "--c1", dash: "5 3", values: u.chg50 },
    { label: "Charging stops", color: "--c1", values: u.chg0 },
    { label: "Discharge starts", color: "--c7", values: u.dis0 },
    { label: "Half the discharge", color: "--c7", dash: "5 3", values: u.dis50 },
    { label: "Day-ahead price at its node", color: "--c-other", width: 1.5, values: u.spp },
  ].filter((s) => s.values);
  legend($("batt-offer-legend"), offers);
  hourChart(els[2], [], offers, { title: "Offer prices by hour ($/MWh; log scale above $10)", price: true, H: 260, yFmt: d3.format("$,.0f"), tipFmt: fmtPrice, csv: `${name} ${day} offer prices`,
    empty: "No submitted offer curve this day." });
}

// across days from data/storage/units.json.gz
function dayChart(el, dates, series, opts) {
  const D = dates.map(parseDate);
  const w = Math.max(280, el.clientWidth || 600), H = opts.H || 220, m = { t: 18, r: 14, b: 26, l: 64 };
  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  if (!all.length) return emptyMsg(el, "No data.");
  const x = d3.scaleTime().domain([d3.timeHour.offset(D[0], -12), d3.timeHour.offset(D.at(-1), 12)]).range([m.l, w - m.r]);
  const y = opts.price
    ? d3.scaleSymlog().constant(10).domain([Math.min(-10, d3.min(all)), Math.max(50, d3.max(all))]).range([H - m.b, m.t])
    : d3.scaleLinear().domain([Math.min(0, d3.min(all)), d3.max(all)]).nice().range([H - m.b, m.t]);
  const yt = opts.price ? [-250, -50, -10, 0, 10, 25, 50, 100, 250, 500, 1000, 2000].filter((v) => v >= y.domain()[0] && v <= y.domain()[1]) : y.ticks(5);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).tickValues(yt).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).tickValues(yt).tickFormat(tickFormat(yt, fmtKind(opts.yFmt))).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(w < 560 ? 4 : 8).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text(opts.title);
  if (y.domain()[0] < 0) svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(0)).attr("y2", y(0));
  if (S.day) { const xm = x(parseDate(S.day)); svg.append("line").attr("class", "crosshair").attr("x1", xm).attr("x2", xm).attr("y1", m.t).attr("y2", H - m.b).style("stroke", css("--accent")); }
  const line = d3.line().defined((v) => v != null).x((_, i) => x(D[i])).y((v) => y(v));
  series.forEach((s) => svg.append("path").attr("fill", "none").attr("stroke", css(s.color)).attr("stroke-width", s.width || 1.6).attr("stroke-dasharray", s.dash || null).attr("d", line(s.values)));
  const tf = opts.tipFmt || fmtMW;
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", H - m.b).style("display", "none");
  const at = (ev) => d3.minIndex(D, (d) => Math.abs(d - x.invert(d3.pointer(ev)[0])));
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const i = at(ev);
      cross.style("display", null).attr("x1", x(D[i])).attr("x2", x(D[i]));
      showTip(ev, `<h4>${fmtDate(D[i])}</h4><table>` + series.filter((s) => s.values[i] != null).map((s) =>
        `<tr><td><span class="sw" style="background:var(${s.color})"></span></td><td>${s.label}</td><td class="n">${tf(s.values[i])}</td></tr>`).join("") + "</table><p class=\"tip-body\">Click to show this day above.</p>");
    })
    .on("click", (ev) => { setDay(dates[at(ev)]); })
    .on("pointerleave", () => { cross.style("display", "none"); hideTip(); });
  el.replaceChildren(svg.node());
  setCSV(el, ["date", ...series.map((s) => s.label)], dates.map((d, i) => [d, ...series.map((s) => s.values[i])]), opts.title);
}
function drawDays(name) {
  const B = S.idx, u = B && B.units[name];
  if (!u) { emptyMsg($("batt-mwh-chart"), "No history for this battery."); $("batt-price-chart").innerHTML = ""; $("batt-days-note").textContent = ""; return; }
  // from the first day the battery appears
  const first = u.hsl.findIndex((v) => v != null), dates = B.dates.slice(first), cut = (a) => a.slice(first);
  const mwh = [
    { label: "Charged (MWh)", color: "--c7-soft", values: cut(u.chg) },
    { label: "Discharged (MWh)", color: "--c7", values: cut(u.dis) },
    { label: "Day-ahead charging award (MWh)", color: "--c1", dash: "4 3", values: cut(u.dam_chg) },
    { label: "Day-ahead discharge award (MWh)", color: "--c2", dash: "4 3", values: cut(u.dam_dis) },
    { label: "Maximum state of charge (MWh)", color: "--c-other", width: 1.2, values: cut(u.soc_max) },
  ];
  legend($("batt-mwh-legend"), mwh);
  dayChart($("batt-mwh-chart"), dates, mwh, { title: "Energy each day (MWh)", tipFmt: (v) => `${fmtMW(v)} MWh` });
  const prices = [
    { label: "Charging stops, HE 10 to 16 average", color: "--c1", values: cut(u.chg0) },
    { label: "Discharge starts, cheapest hour", color: "--c7", values: cut(u.dis0) },
  ];
  legend($("batt-price-legend"), prices);
  dayChart($("batt-price-chart"), dates, prices, { title: "Offer prices each day ($/MWh; log scale above $10)", price: true, yFmt: d3.format("$,.0f"), tipFmt: fmtPrice, H: 200 });
  const n = u.dis.slice(first).filter((v) => v != null).length;
  const cyc = d3.sum(cut(u.dis)) / (d3.median(cut(u.soc_max).filter((v) => v)) || NaN);
  const da = d3.sum(cut(u.dam_dis)) / (d3.sum(cut(u.dis)) || NaN);
  $("batt-days-note").textContent = `${n} days from ${dates[0]}` + (isFinite(cyc) ? ` · about ${fmt1(cyc / n)} full cycles a day` : "") +
    (isFinite(da) ? ` · day-ahead awards cover ${d3.format(".0%")(da)} of its discharge` : "");
}

function setDay(d) {
  S.day = d; $("batt-day").value = d;
  window.CX.writeHash({ ...window.CX.readHash(), bday: d });
  drawDay(S.U.name); drawDays(S.U.name);
}

async function draw() {
  const U = window.UNIT, show = !!U && U.tech === "storage";
  ["batt-day-panel", "batt-days-panel"].forEach((id) => { $(id).hidden = !show; });
  if (!show) return;
  S.U = U;
  if (!S.idx) S.idx = (await tryJSON("data/storage/index.json.gz")) || { days: [] };
  if (!S.units) { S.units = await tryJSON("data/storage/units.json.gz"); S.idx.dates = S.units ? S.units.dates : []; S.idx.units = S.units ? S.units.units : {}; }
  if (window.UNIT !== U) return;
  const days = (S.idx.days || []).filter((d) => S.idx.n_units && S.idx.n_units[d]);
  if (!days.length) { emptyMsg($("batt-day-chart"), "No battery data yet. It is built by the data update workflow."); return; }
  const u = S.idx.units && S.idx.units[U.name];
  // default to the last day the battery did anything
  const want = window.CX.readHash().bday;
  if (!days.includes(S.day)) {
    let last = days.at(-1);
    if (u) for (let i = S.idx.dates.length - 1; i >= 0; i--) if ((u.dis[i] || 0) + (u.chg[i] || 0) > 0) { last = S.idx.dates[i]; break; }
    S.day = days.includes(want) ? want : last;
  }
  $("batt-day").innerHTML = days.slice().reverse().map((d) => `<option${d === S.day ? " selected" : ""}>${d}</option>`).join("");
  $("batt-day").onchange = (ev) => setDay(ev.target.value);
  drawDay(U.name); drawDays(U.name);
}
window.addEventListener("unitchange", draw);
window.addEventListener("unitresize", () => { if (S.U && S.day && window.UNIT && window.UNIT.tech === "storage") { drawDay(S.U.name); drawDays(S.U.name); } });
})();

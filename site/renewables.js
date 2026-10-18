/* Renewables: one day's curtailment by hour, wind and solar offer prices, curtailment (one panel:
   daily by cause, by price at lambda or at the node, value, units) and fleet economics. Lifted from
   trends.js (drawRenewBands, drawCurtailment, drawNodeCurtail) and app.js (drawCurtail). Reads
   data/curve_trends.json.gz, data/curtail_nodes.json.gz, data/econ/wind and solar
   (pipeline/econ.py) and data/renew/sig-YYYY.json.gz. The hedge signals on the same page are
   renewables-hedge.js. This file owns the status line and the shared chart controls (CX.init). */
(() => {
"use strict";

const TECHS = [
  { id: "wind", keys: ["wind"], label: "Wind", color: "--c3" },
  { id: "solar", keys: ["solar"], label: "Solar", color: "--c4" },
];
const techLabel = (t) => TECHS.find((x) => x.id === t)?.label || t;
// wind and solar offer price bands (pipeline/curve_trends.py), ordered from cheapest
const BANDS = [
  { id: "deep", label: "−$250 to −$50", color: "--c2" },
  { id: "ptc_mid", label: "−$50 to −$35", color: "--c6" },
  { id: "ptc_low", label: "−$35 to −$20 (shallow tax-credit bids)", color: "--c7" },
  { id: "neg", label: "−$20 to −$1", color: "--c4" },
  { id: "zero", label: "About $0 (−$1 to $0)", color: "--c-other" },
  { id: "pos", label: "Above $0", color: "--c1" },
];
const S = { C: null, N: null, E: {}, SIG: [], cday: null, span: null, last60: null, ecoTech: "all", ecoSort: "pmwh", ecoDir: -1, ecoAll: false, ncAll: false, pbasis: "lambda" };
const { tryJSON, showTip, hideTip, setCSV, tickFormat, fmtKind, axisFmt, css, esc } = window.CX;
const $ = (id) => document.getElementById(id);
const fmtMW = d3.format(",.0f");
const fmtPct = d3.format(".0%");
const fmtPrice = (v) => (v == null || isNaN(v) ? "–" : d3.format("$,.2f")(v));
const fmtPrice0 = (v) => d3.format("$,.0f")(v);
const parseDate = (d) => new Date(d + "T12:00:00");
const fmtDate = d3.timeFormat("%a %b %-d, %Y");

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
  $("nc-legend").innerHTML = NC_SERIES.map((s) => `<span><span class="sw" style="background:var(${s.color});${s.dash ? "opacity:.5" : ""}"></span>${s.label}</span>`).join("") +
    `<span><span class="sw" style="background:var(--muted);opacity:.5"></span>Total, 2-day estimate (days with no 60-day data yet)</span>`;
  staticLegend($("nc-bins-legend"), CURT);
  if (!N || !N.dates.length) { emptyMsg(el, "No node-priced curtailment yet. It is built by the data update workflow once node prices are loaded."); vel.innerHTML = bel.innerHTML = uel.innerHTML = ""; return; }
  const nNodes = N.has_nodes.filter(Boolean).length, nOv = (N.has_overrides || []).filter(Boolean).length;
  $("nc-note").textContent = `${nNodes} of ${N.dates.length} days have node prices · ${nOv} have operator override data · ${N.n_units.wind.mapped + N.n_units.solar.mapped} units matched, ${N.n_units.wind.unmapped + N.n_units.solar.unmapped} not`;
  const gwh = (v) => (v == null ? null : v / 1000);
  // daily split on the full curtailment axis: 60-day days carry the node split, later days with only
  // the 2-day reports carry a dashed total
  const c = S.C && S.C.curt, dates = c && c.dates.length ? c.dates : N.dates, ni = new Map(N.dates.map((d, i) => [d, i]));
  const onAxis = (arr) => dates.map((d) => { const i = ni.get(d); return i == null ? null : gwh(arr[i]); });
  const est = c ? CURT.map((t) => ({ label: `${t.label}, total (2-day estimate)`, color: t.color, dash: "2 2", width: 1.5,
    values: c.dates.map((d, i) => (ni.has(d) && N.daily[t.id].curt[ni.get(d)] != null ? null : gwh(c[t.id].c2d[i]))) })).filter((s) => s.values.some((v) => v != null)) : [];
  timeChart(el, [...NC_SERIES.filter((s) => N.daily[s.tech][s.key]).map((s) => ({ label: s.label, color: s.color, dash: s.dash, width: s.width, values: onAxis(N.daily[s.tech][s.key]) })), ...est],
    { dates, H: 240, title: "Curtailed energy by what it was worth at the node (GWh per day)", yFmt: d3.format(",.1f"), tipFmt: d3.format(",.1f"), dots: true,
      tipNote: (i) => { const j = ni.get(dates[i]); if (j == null) return " · 2-day estimate"; const u = (N.daily.wind.unmapped[j] || 0) + (N.daily.solar.unmapped[j] || 0);
        const share = c ? CURT.map((t) => { const k = c.dates.indexOf(dates[i]), a = k < 0 ? null : c[t.id].a60[k], v = N.daily[t.id].curt[j]; return a ? `${t.label} ${fmtPct(v / a)}` : null; }).filter(Boolean) : [];
        return (share.length ? ` · of available: ${share.join(", ")}` : "") + (u ? ` · ${fmtMW(u)} MWh unmatched` : ""); } });
  // value of the curtailed energy: at the node against at system lambda
  const k$ = (v) => (v == null ? null : v / 1000);
  timeChart(vel, [
    { label: "Wind, at the node", color: "--c3", values: N.daily.wind.value.map(k$) },
    { label: "Wind, at system lambda", color: "--c3", dash: "5 3", values: N.daily.wind.value_lam.map(k$) },
    { label: "Solar, at the node", color: "--c4", values: N.daily.solar.value.map(k$) },
    { label: "Solar, at system lambda", color: "--c4", dash: "5 3", values: N.daily.solar.value_lam.map(k$) },
  ], { dates: N.dates, H: 240, title: "What the curtailed energy would have earned ($ thousand per day; negative when the price was below zero)", yFmt: d3.format(",.0f"), tipFmt: d3.format(",.1f"), dots: true });

  drawCurtPrice();

  // most curtailed units (the file holds every unit, most curtailed first)
  const rows = N.units.slice(0, S.ncAll ? undefined : 40).map((r) => ({ unit: r[0], tech: r[1], sp: r[2], curt: r[3], cong: r[4], value: r[5], node: r[6], avail: r[7], days: r[8], dir: r[9], bid: bidWhenCurtailed(r[0], N.dates) }));
  const cols = [
    { h: "Unit", t: true, f: (r) => `<a href="unit.html?unit=${encodeURIComponent(r.unit)}">${esc(r.unit)}</a>` }, { h: "Technology", t: true, f: (r) => techLabel(r.tech) }, { h: "Settlement point", t: true, f: (r) => esc(r.sp || "–") },
    { h: "Curtailed GWh", f: (r) => d3.format(",.1f")(r.curt / 1000) }, { h: "Of available", f: (r) => (r.avail ? fmtPct(r.curt / r.avail) : "–") },
    { h: "Congestion share", f: (r) => (r.cong != null && r.curt ? fmtPct(r.cong / r.curt) : "–") },
    { h: "Operator-directed", f: (r) => (r.dir != null && r.curt ? fmtPct(r.dir / r.curt) : "–") },
    { h: "Mean node price when curtailed", f: (r) => fmtPrice(r.node) },
    { h: "Average offer on curtailed days", f: (r) => (r.bid === undefined ? "…" : fmtPrice(r.bid)) }, { h: "Worth at the node", f: (r) => (r.value == null ? "–" : fmtPrice0(r.value)) }, { h: "Days priced", f: (r) => r.days },
  ];
  $("nc-more").hidden = S.ncAll || N.units.length <= 40;
  $("nc-more").textContent = `Show all ${N.units.length}`;
  uel.innerHTML = rows.length ? `<table class="data"><thead><tr>${cols.map((c) => `<th${c.t ? ' class="t"' : ""}>${c.h}</th>`).join("")}</tr></thead><tbody>` +
    rows.map((r) => `<tr>${cols.map((c) => `<td${c.t ? ' class="t"' : ""}>${c.f(r)}</td>`).join("")}</tr>`).join("") + "</tbody></table>" : "";
  setCSV(uel, ["unit", "technology", "settlement_point", "curtailed_mwh", "available_mwh", "congestion_mwh", "directed_mwh", "value_at_node", "mean_node_price", "avg_offer_curtailed_days", "days"],
    N.units.map((r) => [r[0], r[1], r[2], r[3], r[7], r[4], r[9], r[5], r[6], bidWhenCurtailed(r[0], N.dates) ?? null, r[8]]), "Curtailed units");
}


// curtailed energy by price band, priced at system lambda or at the unit's node. Both use the node
// file's bands and days; the lambda view reads curve_trends' hourly rows (every hour, curtailed or
// not), so it can also give the average curtailed MW over the hours at each lambda.
function drawCurtPrice() {
  const N = S.N, bel = $("nc-bins"), node = S.pbasis === "node";
  setSeg("nc-basis", S.pbasis);
  if (!N || !N.dates.length) { bel.innerHTML = ""; return; }
  const labels = N.bins.labels, ed = N.bins.edges.map((e, i) => (e == null ? (i ? Infinity : -Infinity) : e));
  let bins;
  if (node) bins = labels.map((lb, i) => ({ label: lb, wind: N.bins.wind.mwh[i], solar: N.bins.solar.mwh[i], uh: { wind: N.bins.wind.uh[i], solar: N.bins.solar.uh[i] } }));
  else {
    const c = S.C && S.C.curt;
    if (!c) { emptyMsg(bel, "No hourly curtailment data yet."); return; }
    const ci = Object.fromEntries(c.hours.columns.map((k, i) => [k, i])), days = new Set(N.dates.filter((_, i) => N.has_nodes[i]));
    bins = labels.map((lb) => ({ label: lb, wind: 0, solar: 0, wa: 0, sa: 0, n: 0 }));
    c.hours.rows.forEach((r) => {
      const l = r[ci.lambda];
      if (l == null || !days.has(r[ci.date])) return;
      const b = bins[d3.bisectRight(ed, l) - 1];
      if (!b) return;
      b.n++; b.wind += r[ci.wind] || 0; b.solar += r[ci.solar] || 0; b.wa += r[ci.wind_avail] || 0; b.sa += r[ci.solar_avail] || 0;
    });
  }
  const w = Math.max(280, bel.clientWidth || 600), narrow = w < 560, H = 260, m = { t: 18, r: 12, b: narrow ? 74 : 58, l: 56 };
  const x = d3.scaleBand().domain(labels).range([m.l, w - m.r]).paddingInner(0.18);
  const y = d3.scaleLinear().domain([0, Math.max(1, d3.max(bins, (b) => b.wind + b.solar) / 1000)]).nice().range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y), 5).tickSizeOuter(0));
  const xa = svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickSizeOuter(0));
  if (narrow) xa.selectAll("text").attr("transform", "rotate(-45)").attr("text-anchor", "end").attr("dx", "-0.4em").attr("dy", "0.5em");
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text(node ? "Curtailed energy by the price at the unit's node (GWh)" : "Curtailed energy by the hour's system lambda (GWh)");
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", H - 2).attr("text-anchor", "end").text(node ? "Node price when curtailed ($/MWh)" : "Hour's average system lambda ($/MWh)");
  const gw = d3.format(",.1f");
  bins.forEach((b) => {
    const cx = x(b.label), bw = x.bandwidth(), op = !node && b.n < 24 ? 0.45 : 1;
    let acc = 0;
    CURT.forEach((t) => {
      const v = b[t.id] / 1000;
      if (v > 0) svg.append("rect").attr("x", cx).attr("width", bw).attr("y", y(acc + v)).attr("height", Math.max(0, y(acc) - y(acc + v) - 1)).attr("fill", css(t.color)).attr("opacity", op);
      acc += v;
    });
    if (!node && !narrow) svg.append("text").attr("class", "axis-title").attr("x", cx + bw / 2).attr("y", H - m.b + 32).attr("text-anchor", "middle").text(`${b.n.toLocaleString()} h`);
    const tip = node
      ? `<h4>Node price ${b.label}</h4><table>` + CURT.map((t) => `<tr><td><span class="sw" style="background:var(${t.color})"></span></td><td>${t.label}</td><td class="n">${gw(b[t.id] / 1000)} GWh</td><td class="n">${b.uh[t.id].toLocaleString()} unit-hours</td></tr>`).join("") + "</table>"
      : `<h4>System lambda ${b.label}</h4>${b.n.toLocaleString()} hours${b.n && b.n < 24 ? " (few hours: read with care)" : ""}<table><tr><td></td><td></td><td class="n">GWh</td><td class="n">Average MW</td><td class="n">Of available</td></tr>` +
        CURT.map((t) => { const a = t.id === "wind" ? b.wa : b.sa; return `<tr><td><span class="sw" style="background:var(${t.color})"></span></td><td>${t.label}</td><td class="n">${gw(b[t.id] / 1000)}</td><td class="n">${b.n ? fmtMW(b[t.id] / b.n) : "–"}</td><td class="n">${a > 0 ? fmtPct(b[t.id] / a) : "–"}</td></tr>`; }).join("") + "</table>";
    svg.append("rect").attr("x", cx - 2).attr("width", bw + 4).attr("y", m.t).attr("height", H - m.t - m.b).attr("fill", "transparent")
      .on("pointermove", (ev) => showTip(ev, tip)).on("pointerleave", hideTip);
  });
  bel.replaceChildren(svg.node());
  if (node) setCSV(bel, ["node_price_bin", "wind_gwh", "solar_gwh", "wind_unit_hours", "solar_unit_hours"],
    bins.map((b) => [b.label, b.wind / 1000, b.solar / 1000, b.uh.wind, b.uh.solar]), "Curtailment by node price");
  else setCSV(bel, ["lambda_bin", "hours", "wind_gwh", "solar_gwh", "wind_avg_mw", "solar_avg_mw", "wind_available_mwh", "solar_available_mwh"],
    bins.map((b) => [b.label, b.n, b.wind / 1000, b.solar / 1000, b.n ? b.wind / b.n : null, b.n ? b.solar / b.n : null, b.wa, b.sa]), "Curtailment by system lambda");
}

// one day by hour, lifted from the Day view (app.js drawCurtail). The hours come from
// curve_trends' hourly rows, which already pick the 60-day disclosure where the day has it and the
// 2-day estimate otherwise, so the day needs no day file of its own.
function drawCurtail() {
  const el = $("curt-chart"), c = S.C && S.C.curt;
  $("curt-day-legend").innerHTML = CURT.map((s) => `<span><span class="sw" style="background:var(${s.color})"></span>${s.label}</span>`).join("");
  if (!c) return emptyMsg(el, "No curtailment data yet. It is built by the data update workflow.");
  const ci = Object.fromEntries(c.hours.columns.map((k, i) => [k, i]));
  const rows = c.hours.rows.filter((r) => r[ci.date] === S.cday);
  const byH = new Map(rows.map((r) => [r[ci.hour], r]));
  const by = { main: CURT.map((t) => d3.range(24).map((h) => { const r = byH.get(h); return r && r[ci[t.id]] != null ? { c: r[ci[t.id]], a: r[ci[t.id + "_avail"]] } : null; })) };
  const main = "main";
  const src = rows.length ? rows[0][ci.src] : null;
  const srcName = { "60d": "60-day disclosure", "2d": "2-day reports, estimated" };
  $("curt-title-note").textContent = rows.length ? `${S.cday} · ${srcName[src] || src}` : "";
  if (!rows.length) return emptyMsg(el, "No curtailment data for this day yet. The 2-day generation summary fills in recent days once the data update has fetched it.");
  const hp = d3.range(24).map((h) => { const r = byH.get(h); return r ? { mean: r[ci.lambda] } : null; });
  const pname = "System lambda";
  const w = Math.max(280, el.clientWidth || 600);
  const m = { t: 14, r: 16, b: 26, l: 64 }, H = 200;
  const x = d3.scaleBand().domain(d3.range(1, 25)).range([m.l, w - m.r]).paddingInner(0.15);
  const xc = d3.scaleLinear().domain([1, 24]).range([x(1) + x.bandwidth() / 2, x(24) + x.bandwidth() / 2]);
  const tot = d3.range(24).map((h) => d3.sum(by[main], (r) => (r && r[h] ? r[h].c : 0)));
  const y = d3.scaleLinear().domain([0, Math.max(100, d3.max(tot))]).nice().range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickValues([1, 4, 8, 12, 16, 20, 24]).tickFormat((d) => "HE" + d).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y), 4).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text("Curtailed MW, hourly average");
  d3.range(24).forEach((h) => {
    let acc = 0;
    CURT.forEach((t, j) => {
      const r = by[main][j] && by[main][j][h];
      if (!r || !r.c) return;
      svg.append("rect").attr("x", x(h + 1)).attr("width", x.bandwidth()).attr("y", y(acc + r.c)).attr("height", Math.max(0, y(acc) - y(acc + r.c) - 1))
        .attr("fill", css(t.color));
      acc += r.c;
    });
  });
  const row = (k, j, h) => { const r = by[k][j] && by[k][j][h]; return r ? `${fmtMW(r.c)} MW <span class="muted">of ${fmtMW(r.a)} (${r.a > 0 ? fmtPct(r.c / r.a) : "–"})</span>` : "–"; };
  hoverHours(svg, xc, m, H, (h) => `<h4>${heLabel(h)}</h4>${pname}: ${hp[h] && hp[h].mean != null ? fmtPrice(hp[h].mean) : "–"}<table>` +
    CURT.map((t, j) => `<tr><td><span class="sw" style="background:var(${t.color})"></span></td><td>${t.label}</td><td class="n">${row(main, j, h)}</td></tr>`).join("") + "</table>" +
    (src === "2d" ? `<p class="tip-body">Estimated from the 2-day reports until this day's 60-day disclosure is out.</p>` : ""));
  el.replaceChildren(svg.node());
  const cols = ["hour_ending", `${pname} mean`];
  CURT.forEach((t) => cols.push(`${t.label} curtailed MW (${src})`, `${t.label} available MW (${src})`));
  setCSV(el, cols, d3.range(24).map((h) => [h + 1, hp[h]?.mean, ...CURT.flatMap((t, j) => {
    const r = by[main][j] && by[main][j][h]; return [r ? r.c : null, r ? r.a : null];
  })]), `Wind and solar curtailment ${S.cday}`);
}

function hoverHours(svg, x, m, H, htmlFor) {
  const w = +svg.attr("viewBox").split(" ")[2];
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", H - m.b).style("display", "none");
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const i = Math.max(0, Math.min(23, Math.round(x.invert(d3.pointer(ev)[0])) - 1));
      cross.style("display", null).attr("x1", x(i + 1)).attr("x2", x(i + 1));
      showTip(ev, htmlFor(i));
    })
    .on("pointerleave", () => { cross.style("display", "none"); hideTip(); });
}


// ---- fleet economics -------------------------------------------------------------------
// Energy revenue as on Plant economics' default: two-settlement (the DA award at the DA price plus
// the real-time deviation) where the unit has DA data, real-time at its node otherwise, and system
// lambda where the node price is missing; plus ancillary services.
function dayRevenue(u, i) {
  const two = u.rev_da[i] != null && u.rev_rt[i] != null && u.rev_da_rt[i] != null ? u.rev_da[i] + u.rev_rt[i] - u.rev_da_rt[i] : null;
  const e = two != null ? two : u.rev_rt[i] != null ? u.rev_rt[i] : u.rev_lam[i];
  return e == null ? null : e + (u.rev_as[i] || 0);
}
// a unit's average offer on the days it was curtailed: the mean of its daily median offer while
// online (data/renew/sig-YYYY, "md") over the days in the window with a curtailed share above 0.5%;
// undefined until the bidding-history files have loaded
function bidWhenCurtailed(name, dates) {
  if (!S.SIG.length) return undefined;
  const lo = dates[0], hi = dates.at(-1), v = [];
  S.SIG.forEach((f) => { const u = f && f.units[name]; if (!u) return; f.dates.forEach((d, i) => { if (d >= lo && d <= hi && u.md[i] != null && u.cur[i] > 0.005) v.push(u.md[i]); }); });
  return v.length ? d3.mean(v) : null;
}
let ECO = null;
function computeEco() {
  // curtailed share of available energy (HSL), exact per unit from curtail_nodes
  const units = [], months = new Map(), cs = new Map((S.N?.units || []).map((r) => [r[0], r[7] ? r[3] / r[7] : null]));
  ["wind", "solar"].forEach((t) => {
    const E = S.E[t];
    if (!E) return;
    Object.entries(E.units).forEach(([name, u]) => {
      let rev = 0, mwh = 0, days = 0;
      E.dates.forEach((d, i) => {
        const r = dayRevenue(u, i), q = u.mwh[i];
        if (r == null || q == null) return;
        rev += r; mwh += q; days++;
        const mo = d.slice(0, 7), k = `${mo}|${t}`, m = months.get(k) || { mo, t, rev: 0, mwh: 0 };
        m.rev += r; m.mwh += q; months.set(k, m);
      });
      if (mwh > 0) units.push({ name, tech: t, sp: u.sp, hsl: u.hsl, rev, mwh, pmwh: rev / mwh, cf: u.hsl ? mwh / (u.hsl * 24 * days) : null, curt: cs.get(name) ?? null, days });
    });
  });
  ECO = { units, months: [...months.values()] };
}
function drawEcoMonths() {
  const el = $("eco-months"), N = S.N;
  if (!ECO.months.length) return emptyMsg(el, "No economics data yet.");
  const mos = [...new Set(ECO.months.map((m) => m.mo))].sort();
  // curtailed energy and what it would have earned at the node, by month (curtail_nodes daily)
  const cm = new Map();
  if (N) N.dates.forEach((d, i) => ["wind", "solar"].forEach((t) => {
    const k = `${d.slice(0, 7)}|${t}`, a = cm.get(k) || { mwh: 0, value: 0 };
    a.mwh += N.daily[t].curt[i] || 0; a.value += N.daily[t].value[i] || 0; cm.set(k, a);
  }));
  const get = (mo, t) => ECO.months.find((m) => m.mo === mo && m.t === t) || { rev: 0, mwh: 0 };
  const w = Math.max(280, el.clientWidth || 600), H = 240, m = { t: 18, r: 16, b: 26, l: 64 };
  const x = d3.scaleBand().domain(mos).range([m.l, w - m.r]).paddingInner(0.2);
  const y = d3.scaleLinear().domain([0, d3.max(mos, (mo) => get(mo, "wind").rev + get(mo, "solar").rev) / 1e6 || 1]).nice().range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y), 5, "$").tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickFormat((mo) => d3.timeFormat(w < 560 ? "%b" : "%b %y")(new Date(mo + "-15T12:00:00"))).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text("Revenue by month ($ million)");
  mos.forEach((mo) => {
    let acc = 0;
    TECHS.forEach((t) => { const v = get(mo, t.id).rev / 1e6; if (v > 0) svg.append("rect").attr("x", x(mo)).attr("width", x.bandwidth()).attr("y", y(acc + v)).attr("height", Math.max(0, y(acc) - y(acc + v) - 1)).attr("fill", css(t.color)); acc += v; });
    svg.append("rect").attr("x", x(mo)).attr("width", x.bandwidth()).attr("y", m.t).attr("height", H - m.t - m.b).attr("fill", "transparent")
      .on("pointermove", (ev) => showTip(ev, `<h4>${d3.timeFormat("%B %Y")(new Date(mo + "-15T12:00:00"))}</h4><table><tr><td></td><td></td><td class="n">Revenue</td><td class="n">$/MWh</td><td class="n">Curtailed</td><td class="n">Worth at node</td></tr>` +
        TECHS.map((t) => { const g = get(mo, t.id), c = cm.get(`${mo}|${t.id}`); return `<tr><td><span class="sw" style="background:var(${t.color})"></span></td><td>${t.label}</td><td class="n">$${d3.format(",.1f")(g.rev / 1e6)}M</td><td class="n">${g.mwh ? fmtPrice(g.rev / g.mwh) : "–"}</td><td class="n">${c ? d3.format(",.0f")(c.mwh / 1000) + " GWh" : "–"}</td><td class="n">${c ? "$" + d3.format(",.1f")(c.value / 1e6) + "M" : "–"}</td></tr>`; }).join("") + "</table>"))
      .on("pointerleave", hideTip);
  });
  el.replaceChildren(svg.node());
  setCSV(el, ["month", "wind_revenue", "wind_mwh", "solar_revenue", "solar_mwh", "wind_curtailed_mwh", "wind_curtailed_value_at_node", "solar_curtailed_mwh", "solar_curtailed_value_at_node"],
    mos.map((mo) => [mo, get(mo, "wind").rev, get(mo, "wind").mwh, get(mo, "solar").rev, get(mo, "solar").mwh, cm.get(`${mo}|wind`)?.mwh, cm.get(`${mo}|wind`)?.value, cm.get(`${mo}|solar`)?.mwh, cm.get(`${mo}|solar`)?.value]), "Wind and solar revenue by month");
  // curtailed energy by month, and what it would have earned at the node
  const tick = (mo) => d3.timeFormat(w < 560 ? "%b" : "%b %y")(new Date(mo + "-15T12:00:00"));
  const grouped = (gel, key, k, title, tipF) => {
    if (!N) return emptyMsg(gel, "No node-priced curtailment yet.");
    const vals = mos.flatMap((mo) => TECHS.map((t) => (cm.get(`${mo}|${t.id}`)?.[key] || 0) / k));
    const gy = d3.scaleLinear().domain([Math.min(0, d3.min(vals)), Math.max(0, d3.max(vals)) || 1]).nice().range([H - m.b, m.t]);
    const g = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
    g.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(gy).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
    g.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(gy), 5).tickSizeOuter(0));
    g.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickFormat(tick).tickSizeOuter(0));
    g.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text(title);
    if (gy.domain()[0] < 0) g.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", gy(0)).attr("y2", gy(0));
    const bw = x.bandwidth() / 2;
    mos.forEach((mo) => TECHS.forEach((tt, j) => {
      const v = (cm.get(`${mo}|${tt.id}`)?.[key] || 0) / k;
      g.append("rect").attr("x", x(mo) + j * bw).attr("width", bw - 1).attr("y", gy(Math.max(0, v))).attr("height", Math.abs(gy(0) - gy(v))).attr("fill", css(tt.color));
    }));
    g.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
      .on("pointermove", (ev) => {
        const px = d3.pointer(ev)[0], mo = mos[Math.max(0, Math.min(mos.length - 1, Math.floor((px - m.l) / x.step())))];
        showTip(ev, `<h4>${d3.timeFormat("%B %Y")(new Date(mo + "-15T12:00:00"))}</h4><table>` + TECHS.map((tt) => { const c = cm.get(`${mo}|${tt.id}`); return `<tr><td><span class="sw" style="background:var(${tt.color})"></span></td><td>${tt.label}</td><td class="n">${c ? tipF(c[key]) : "–"}</td></tr>`; }).join("") + "</table>");
      })
      .on("pointerleave", hideTip);
    gel.replaceChildren(g.node());
    setCSV(gel, ["month", `wind_${key}`, `solar_${key}`], mos.map((mo) => [mo, cm.get(`${mo}|wind`)?.[key], cm.get(`${mo}|solar`)?.[key]]), title);
  };
  grouped($("eco-curt"), "mwh", 1000, "Curtailed energy by month (GWh)", (v) => d3.format(",.0f")(v / 1000) + " GWh");
  grouped($("eco-curt-value"), "value", 1e6, "What the curtailed energy would have earned at the node ($ million; negative when the node price was below zero)", (v) => (v < 0 ? "−" : "") + "$" + d3.format(",.2f")(Math.abs(v) / 1e6) + "M");
}
const ECO_COLS = [
  { k: "rank", h: "#", f: (u, i) => i + 1 },
  { k: "name", h: "Unit", t: 1, f: (u) => `<a href="unit.html?unit=${encodeURIComponent(u.name)}">${esc(u.name)}</a>` },
  { k: "tech", h: "Tech", t: 1, f: (u) => techLabel(u.tech) },
  { k: "sp", h: "Settlement point", t: 1, f: (u) => esc(u.sp || "–") },
  { k: "pmwh", h: "Realised $/MWh", f: (u) => fmtPrice(u.pmwh) },
  { k: "mwh", h: "GWh", f: (u) => d3.format(",.1f")(u.mwh / 1000) },
  { k: "rev", h: "Revenue", f: (u) => "$" + d3.format(",.2f")(u.rev / 1e6) + "M" },
  { k: "cf", h: "Capacity factor", f: (u) => (u.cf == null ? "–" : fmtPct(u.cf)) },
  { k: "curt", h: "Curtailed share", f: (u) => (u.curt == null ? "–" : d3.format(".1%")(u.curt)) },
];
function drawEcoUnits() {
  const el = $("eco-table"), hel = $("eco-hist");
  // units with under 1 GWh over the loaded days (new, retired or barely running) price a handful of
  // hours and would crowd both ends of the ranking
  const all = ECO.units.filter((u) => S.ecoTech === "all" || u.tech === S.ecoTech);
  let us = all.filter((u) => u.mwh >= 1000);
  const E0 = S.E.wind || S.E.solar;
  $("eco-note").textContent = E0 ? `${E0.dates[0]} to ${E0.dates.at(-1)} (every loaded 60-day day), ${us.length} units` + (all.length > us.length ? `, leaving out ${all.length - us.length} with under 1 GWh` : "") : "";
  if (!us.length) { emptyMsg(el, "No units."); hel.innerHTML = ""; return; }
  // distribution: units by realised $/MWh, wind and solar side by side
  const vals = us.map((u) => u.pmwh), lo = Math.floor(d3.quantile([...vals].sort(d3.ascending), 0.005) / 2) * 2, hi = Math.ceil(d3.quantile([...vals].sort(d3.ascending), 0.995) / 2) * 2;
  const bin = d3.bin().domain([lo, hi]).thresholds(d3.range(lo, hi + 0.001, Math.max(1, Math.round((hi - lo) / 30))));
  const w = Math.max(280, hel.clientWidth || 600), H = 220, m = { t: 18, r: 16, b: 34, l: 48 };
  const groups = TECHS.filter((t) => S.ecoTech === "all" || t.id === S.ecoTech).map((t) => ({ t, b: bin(us.filter((u) => u.tech === t.id).map((u) => Math.max(lo, Math.min(hi - 1e-9, u.pmwh)))) }));
  const x = d3.scaleLinear().domain([lo, hi]).range([m.l, w - m.r]);
  const y = d3.scaleLinear().domain([0, d3.max(groups, (g) => d3.max(g.b, (b) => b.length)) || 1]).nice().range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickFormat(d3.format(",d")).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(axisFmt(d3.axisBottom(x), w < 560 ? 5 : 10, "$").tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text("Units by realised revenue per MWh");
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", H - 2).attr("text-anchor", "end").text("$/MWh over the loaded days");
  groups.forEach((g, j) => g.b.forEach((b) => {
    const bw = (x(b.x1) - x(b.x0)) / groups.length;
    if (b.length) svg.append("rect").attr("x", x(b.x0) + j * bw).attr("width", Math.max(1, bw - 1)).attr("y", y(b.length)).attr("height", y(0) - y(b.length)).attr("fill", css(g.t.color));
  }));
  groups.forEach((g) => { const md = d3.median(us.filter((u) => u.tech === g.t.id), (u) => u.pmwh); if (md == null) return;
    svg.append("line").attr("x1", x(md)).attr("x2", x(md)).attr("y1", m.t).attr("y2", H - m.b).attr("stroke", css(g.t.color)).attr("stroke-dasharray", "4 3").attr("stroke-width", 1.5);
  });
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const v = x.invert(d3.pointer(ev)[0]);
      showTip(ev, `<table>` + groups.map((g) => { const b = g.b.find((b) => v >= b.x0 && v < b.x1); return b ? `<tr><td><span class="sw" style="background:var(${g.t.color})"></span></td><td>${g.t.label}, ${fmtPrice0(b.x0)} to ${fmtPrice0(b.x1)}</td><td class="n">${b.length} units</td></tr>` : ""; }).join("") +
        groups.map((g) => `<tr><td></td><td>${g.t.label} median</td><td class="n">${fmtPrice(d3.median(us.filter((u) => u.tech === g.t.id), (u) => u.pmwh))}</td></tr>`).join("") + "</table>");
    })
    .on("pointerleave", hideTip);
  hel.replaceChildren(svg.node());
  setCSV(hel, ["unit", "tech", "realised_usd_per_mwh"], us.map((u) => [u.name, u.tech, u.pmwh]), "Realised $/MWh distribution");
  // ranked table
  const k = S.ecoSort === "rank" ? "pmwh" : S.ecoSort;
  us = [...us].sort((a, b) => { const p = a[k], q = b[k]; if (p == null) return 1; if (q == null) return -1; return (typeof p === "string" ? p.localeCompare(q) : p - q) * S.ecoDir; });
  const shown = S.ecoAll ? us : us.slice(0, 50);
  el.innerHTML = `<table class="data"><thead><tr>${ECO_COLS.map((c) => `<th class="sortable${c.t ? " t" : ""}" data-k="${c.k}">${c.h}${S.ecoSort === c.k ? (S.ecoDir < 0 ? " ▾" : " ▴") : ""}</th>`).join("")}</tr></thead><tbody>` +
    shown.map((u, i) => `<tr>${ECO_COLS.map((c) => `<td${c.t ? ' class="t"' : ""}>${c.f(u, i)}</td>`).join("")}</tr>`).join("") + "</tbody></table>";
  $("eco-more").hidden = S.ecoAll || us.length <= 50;
  $("eco-more").textContent = `Show all ${us.length}`;
  el.querySelectorAll("th[data-k]").forEach((th) => th.addEventListener("click", () => {
    const kk = th.dataset.k; if (S.ecoSort === kk) S.ecoDir = -S.ecoDir; else { S.ecoSort = kk; S.ecoDir = ["name", "tech", "sp"].includes(kk) ? 1 : -1; }
    drawEcoUnits(); saveView();
  }));
  setCSV(el, ["unit", "tech", "settlement_point", "realised_usd_per_mwh", "mwh", "revenue", "capacity_factor", "curtailed_share", "days"], us.map((u) => [u.name, u.tech, u.sp, u.pmwh, u.mwh, u.rev, u.cf, u.curt, u.days]), "Wind and solar realised revenue");
}

// ---- links ------------------------------------------------------------------------
// the hedge-signal panels (renewables-hedge.js) keep their own keys in the same address bar
const VIEW_KEYS = { cday: "cday", et: "ecoTech", es: "ecoSort", pb: "pbasis" };
function saveView() { window.CX.writeHash({ ...window.CX.readHash(), ...Object.fromEntries(Object.entries(VIEW_KEYS).map(([k, sk]) => [k, S[sk]])), ed: S.ecoDir < 0 ? null : 1 }); }
function loadView() { const v = window.CX.readHash(); Object.entries(VIEW_KEYS).forEach(([k, sk]) => { if (v[k] != null) S[sk] = v[k]; }); if (v.ed === "1") S.ecoDir = 1; }

// ---- boot ---------------------------------------------------------------------------
function drawAll() { drawRenewBands(); drawCurtail(); drawNodeCurtail(); if (ECO) { drawEcoMonths(); drawEcoUnits(); } }

async function boot() {
  [S.C, S.N] = await Promise.all([tryJSON("data/curve_trends.json.gz"), tryJSON("data/curtail_nodes.json.gz")]);
  if (!S.C) { $("status").textContent = "No renewables data yet. It is built by the data update workflow."; return; }
  const spans = [S.C?.rs?.dates, S.C?.curt?.dates, S.N?.dates].filter((d) => d && d.length);
  S.span = [d3.min(spans, (d) => d[0]), d3.max(spans, (d) => d.at(-1))];
  S.last60 = S.N ? S.N.dates.at(-1) : null;
  $("status").textContent = `Wind and solar offers and curtailment ${S.span[0]} to ${S.span[1]} · 60-day data through ${S.last60 || "–"}`;
  loadView();
  staticLegend($("rs-legend"), BANDS);
  const cdays = S.C.curt.dates.slice().reverse();
  if (!cdays.includes(S.cday)) S.cday = cdays[0];
  $("cday").innerHTML = cdays.map((d) => `<option>${d}</option>`).join("");
  $("cday").value = S.cday;
  const step = (k) => { const i = cdays.indexOf(S.cday) - k; if (i >= 0 && i < cdays.length) { S.cday = cdays[i]; $("cday").value = S.cday; drawCurtail(); saveView(); } };
  $("cday").onchange = (e) => { S.cday = e.target.value; drawCurtail(); saveView(); };
  $("cday-prev").onclick = () => step(-1); $("cday-next").onclick = () => step(1);
  setSeg("eco-tech", S.ecoTech); bindSeg("eco-tech", "ecoTech", drawEcoUnits);
  $("eco-more").onclick = () => { S.ecoAll = true; drawEcoUnits(); };
  bindSeg("nc-basis", "pbasis", drawCurtPrice);
  $("nc-more").onclick = () => { S.ncAll = true; drawNodeCurtail(); };
  drawAll();
  window.CX.init();
  saveView();
  // fleet economics needs the economics and bidding-history files: load them after the rest
  const lastY = +S.C.curt.dates.at(-1).slice(0, 4);
  [S.E.wind, S.E.solar, ...S.SIG] = await Promise.all([tryJSON("data/econ/wind.json.gz"), tryJSON("data/econ/solar.json.gz"), tryJSON(`data/renew/sig-${lastY - 1}.json.gz`), tryJSON(`data/renew/sig-${lastY}.json.gz`)]);
  computeEco(); drawEcoMonths(); drawEcoUnits(); drawNodeCurtail();
  let t, lastW = 0;
  new ResizeObserver((e) => { const w = Math.round(e[0].contentRect.width); if (w === lastW) return; lastW = w; clearTimeout(t); t = setTimeout(drawAll, 120); }).observe(document.querySelector("main"));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", drawAll);
}
boot();
})();

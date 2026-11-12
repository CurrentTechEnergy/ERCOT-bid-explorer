/* Renewables, across the years: wind and solar fleet size, energy and curtailment, the price they
   captured against the average at their nodes, and the share of their output in hours priced at
   $0 or below. Monthly from 2019 or daily since the 60-day data starts. Reads
   data/renewables/years.json.gz (pipeline/renew_years.py). renewables.js owns the status line and
   the shared chart controls (CX.init). */
(() => {
"use strict";

const { tryJSON, showTip, hideTip, setCSV, css, axisFmt, fmtKind } = window.CX;
const $ = (id) => document.getElementById(id);
const fmtPct = d3.format(".0%"), fmtPrice = (v) => (v == null || isNaN(v) ? "–" : d3.format("$,.2f")(v));
const TECHS = [["wind", "Wind", "--c3"], ["solar", "Solar", "--c4"]];
const S = { Y: null, by: "month", cu: "pct" };

function emptyMsg(el, msg) { el.innerHTML = `<p class="empty">${msg}</p>`; }
function staticLegend(el, list) {
  el.innerHTML = list.filter((s) => !s.hide).map((s) => `<span><span class="sw" style="background:var(${s.color});${s.dash || s.faint ? "opacity:.55" : ""}"></span>${s.label}</span>`).join("");
}
function setSeg(id, value) { $(id).querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === value))); }

// periods: {keys (YYYY-MM or YYYY-MM-DD), dates, label}
function periods() {
  const Y = S.Y;
  if (S.by === "day") return { keys: Y.dates, dates: Y.dates.map((d) => new Date(d + "T12:00:00")), fmt: d3.timeFormat("%a %b %-d, %Y"), unit: "day" };
  return { keys: Y.months, dates: Y.months.map((m) => new Date(m + "-15T12:00:00")), fmt: d3.timeFormat("%B %Y"), unit: "month" };
}
const data = (t) => (S.by === "day" ? S.Y.daily : S.Y.monthly)[t];

// lines (series) over stacked bars (opts.bars) on a time axis; values past opts.yMax / yMin run
// off the chart and keep their real value in the tooltip
function yearChart(el, series, opts) {
  const P = periods(), dates = P.dates, bars = opts.bars || [];
  const w = Math.max(280, el.clientWidth || 600), H = opts.H || 220, m = { t: 18, r: 14, b: 26, l: 60 };
  const half = P.unit === "day" ? 12 * 36e5 : 15 * 864e5;
  const x = d3.scaleTime().domain([new Date(+dates[0] - half), new Date(+dates.at(-1) + half)]).range([m.l, w - m.r]);
  const tops = dates.map((_, i) => d3.sum(bars, (b) => b.values[i] || 0));
  const all = series.filter((s) => !s.hide).flatMap((s) => s.values).concat(bars.length ? tops : []).filter((v) => v != null);
  if (!all.length) return emptyMsg(el, "No data.");
  const lo = Math.min(0, opts.yMin != null ? Math.max(opts.yMin, d3.min(all)) : d3.min(all));
  const y = d3.scaleLinear().domain([lo, opts.yMax != null ? Math.min(opts.yMax, d3.max(all)) : d3.max(all)]).nice().range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y), 5, fmtKind(opts.yFmt)).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(w < 560 ? 4 : 8).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text(opts.title);
  if (y.domain()[0] < 0) svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(0)).attr("y2", y(0));
  if (opts.ref != null) svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(opts.ref)).attr("y2", y(opts.ref)).style("stroke-dasharray", "3 3");
  const bw = Math.max(1, (w - m.l - m.r) / dates.length - 1);
  bars.forEach((b, j) => dates.forEach((d, i) => {
    const v = b.values[i];
    if (v == null || v <= 0) return;
    const base = d3.sum(bars.slice(0, j), (o) => Math.max(0, o.values[i] || 0));
    const y0 = y(Math.min(base, y.domain()[1])), y1 = y(Math.min(base + v, y.domain()[1]));
    svg.append("rect").attr("x", x(d) - bw / 2).attr("width", bw).attr("y", y1).attr("height", Math.max(0, y0 - y1)).attr("fill", css(b.color));
  }));
  // lines past the scale run off the chart (opts.overrun, clipped to the plot) or flatten at its edge
  const clamp = (v) => (v == null ? null : opts.overrun ? v : Math.max(y.domain()[0], Math.min(y.domain()[1], v)));
  const line = d3.line().defined((v) => v != null).x((_, i) => x(dates[i])).y((v) => y(clamp(v)));
  const clipId = `clip-${el.id}`;
  if (opts.overrun) svg.append("clipPath").attr("id", clipId).append("rect").attr("x", m.l).attr("y", m.t - 2).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b + 2);
  const runs = (s) => (s.groups ? d3.groups(d3.range(s.values.length), (i) => s.groups[i]).map(([, idx]) => idx) : [d3.range(s.values.length)]);
  series.filter((s) => !s.hide).forEach((s) => runs(s).forEach((idx) => svg.append("path").attr("fill", "none").attr("stroke", css(s.color)).attr("stroke-width", s.width || 2)
    .attr("stroke-dasharray", s.dash || null).attr("stroke-opacity", s.faint ? 0.45 : 1)
    .attr("clip-path", opts.overrun ? `url(#${clipId})` : null).attr("d", d3.line().defined((i) => s.values[i] != null).x((i) => x(dates[i])).y((i) => y(clamp(s.values[i])))(idx))));
  const shown = bars.concat(series), tf = opts.tipFmt || d3.format(",.1f");
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", H - m.b).style("display", "none");
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const t = x.invert(d3.pointer(ev)[0]), i = d3.minIndex(dates, (d) => Math.abs(d - t));
      cross.style("display", null).attr("x1", x(dates[i])).attr("x2", x(dates[i]));
      showTip(ev, `<h4>${P.fmt(dates[i])}</h4><table>` + shown.filter((s) => s.values[i] != null).map((s) =>
        `<tr><td><span class="sw" style="background:var(${s.color})"></span></td><td>${s.label}</td><td class="n">${(s.fmt || tf)(s.values[i])}</td></tr>`).join("") + "</table>");
    })
    .on("pointerleave", () => { cross.style("display", "none"); hideTip(); });
  el.replaceChildren(svg.node());
  setCSV(el, [P.unit, ...shown.map((s) => s.label)], P.keys.map((k, i) => [k, ...shown.map((s) => s.values[i])]), opts.title);
}

// trailing mean of the periods with a value across `n` periods
const rollMean = (a, n) => a.map((_, i) => {
  const w = a.slice(Math.max(0, i - n + 1), i + 1).filter((v) => v != null);
  return w.length ? d3.mean(w) : null;
});

// annual averages for the monthly view: sum(value x weight) / sum(weight) over each calendar year,
// repeated on every month of it (drawn as one flat segment a year)
function annual(values, weights) {
  const ys = S.Y.months.map((m) => m.slice(0, 4)), acc = new Map();
  values.forEach((v, i) => {
    const w = weights[i];
    if (v == null || w == null) return;
    const a = acc.get(ys[i]) || [0, 0];
    a[0] += v * w; a[1] += w; acc.set(ys[i], a);
  });
  return { groups: ys, values: ys.map((y) => (acc.get(y) && acc.get(y)[1] ? acc.get(y)[0] / acc.get(y)[1] : null)) };
}

function draw() {
  if (!S.Y) return;
  const day = S.by === "day", per = day ? "day" : "month", D = Object.fromEntries(TECHS.map(([t]) => [t, data(t)]));
  const gw = (v) => `${d3.format(",.1f")(v)} GW`;
  // monthly, the first months have under a year of HSL behind them: drawn dotted, up to the first full one
  const gm = !day && S.Y.gw_months, short = (i) => gm && gm[i] != null && gm[i] < 12;
  const full = (a) => a.map((v, i) => (short(i) ? null : v)), part = (a) => a.map((v, i) => (short(i) || (i > 0 && short(i - 1)) ? v : null));
  const size = TECHS.flatMap(([t, label, color]) => [
    { label, color, values: full(D[t].gw), fmt: gw },
    { label: `${label}, under a year of data`, color, dash: "2 3", width: 1.6, values: part(D[t].gw), fmt: gw, hide: !gm || !D[t].gw.some((_, i) => short(i)) },
    { label: `${label} nameplate (ERCOT CDR)`, color, faint: true, width: 1.4, values: D[t].nameplate || [], fmt: gw, hide: !D[t].nameplate },
  ]);
  const both = D.wind.gw.map((v, i) => (v == null || D.solar.gw[i] == null ? null : v + D.solar.gw[i]));
  size.push({ label: "Wind and solar", color: "--c-other", dash: "5 4", width: 1.4, values: both, fmt: gw });
  staticLegend($("yr-size-legend"), size);
  yearChart($("yr-size"), size, { title: `Fleet size, GW: each unit's highest hourly HSL over the last 12 months, summed; faint: installed capacity (ERCOT CDR${S.Y.cdr_edition ? ", " + S.Y.cdr_edition : ""})`, yFmt: d3.format(",.0f"), tipFmt: gw });

  const scale = day ? 1 : 1e3, eu = day ? "GWh" : "TWh", fe = (v) => `${d3.format(",.1f")(v)} ${eu}`;
  const k = (a) => a.map((v) => (v == null ? null : v / scale));
  const curt = D.wind.curt.map((v, i) => (v == null && D.solar.curt[i] == null ? null : (v || 0) + (D.solar.curt[i] || 0)));
  const bars = [
    ...TECHS.map(([t, label, color]) => ({ label: `${label} generated`, color, values: k(D[t].gen), fmt: fe })),
    { label: "Curtailed (wind and solar)", color: "--c8", values: k(curt), fmt: fe },
  ];
  staticLegend($("yr-energy-legend"), bars);
  yearChart($("yr-energy"), [], { bars, title: `Energy each ${per}, ${eu}`, yFmt: d3.format(",.0f"), tipFmt: fe });

  // capture rate (real-time): output-weighted price at each unit's node over the hub average
  // weighted by each hour's ERCOT generation, i.e. against what the average MWh sold earned at the
  // hub (the fleet's timing and the units' location); daily, 7-day means first
  const sm = (a) => (day ? rollMean(a, 7) : a);
  const rate = (c, a) => c.map((v, i) => (v == null || !a[i] || a[i] <= 0 ? null : v / a[i]));
  const hub = sm(D.wind.hub_rt_gen), usd = S.cu === "usd";
  const cap = TECHS.flatMap(([t, label, color]) => {
    const c = sm(D[t].rt_capture), out = [
      { label: day ? label : `${label}, monthly`, color, faint: !day, width: day ? 2 : 1.4, values: usd ? c : rate(c, hub), fmt: usd ? fmtPrice : fmtPct },
    ];
    if (!day) {
      // the year: (wind or solar revenue / its MWh) / (all ERCOT generation's hub revenue / all MWh)
      // over the whole year; the two sides weight months differently, so a year can sit outside its
      // months (Uri, Feb 2021: ERCOT's MWh caught it more than solar's did). The $/MWh view draws
      // the two sides themselves.
      const e = annual(D[t].rt_capture, D[t].gen), h = annual(D[t].hub_rt_gen, D[t].sys_gen);
      out.push({ label: `${label}, year`, color, width: 2.6, groups: e.groups, values: usd ? e.values : rate(e.values, h.values), fmt: usd ? fmtPrice : fmtPct });
    }
    if (!usd) out.push({ label: `${label} earned`, color, hide: true, values: c, fmt: fmtPrice });
    else out.push({ label: `${label} capture rate`, color, hide: true, values: rate(c, hub), fmt: fmtPct });
    return out;
  });
  if (usd) {
    cap.push({ label: day ? "Average MWh at the hub" : "Average MWh at the hub, monthly", color: "--c-other", faint: !day, width: day ? 2 : 1.4, dash: "5 4", values: hub, fmt: fmtPrice });
    if (!day) { const h = annual(D.wind.hub_rt_gen, D.wind.sys_gen); cap.push({ label: "Average MWh at the hub, year", color: "--c-other", width: 2.6, dash: "5 4", groups: h.groups, values: h.values, fmt: fmtPrice }); }
  } else cap.push({ label: "Average MWh at the hub", color: "--c-other", hide: true, values: hub, fmt: fmtPrice });
  staticLegend($("yr-capture-legend"), cap);
  yearChart($("yr-capture"), cap, usd
    ? { title: `Price earned, $/MWh; grey: the average MWh's hub price${day ? " (7-day)" : ""}; scale cut at $150`,
      yMin: 0, yMax: 150, overrun: true, yFmt: d3.format("$,.0f"), tipFmt: fmtPrice, H: 200 }
    : { title: `Capture rate, %: price earned per MWh ÷ the average MWh's hub price${day ? " (7-day)" : ""}; scale cut at 150%`,
      yMin: 0, yMax: 1.5, ref: 1, overrun: true, yFmt: d3.format(".0%"), tipFmt: fmtPct, H: 200 });

  const neg = TECHS.flatMap(([t, label, color]) => (day ? [{ label, color, values: D[t].neg, fmt: fmtPct }] : [
    { label: `${label}, each month`, color, faint: true, width: 1.4, values: D[t].neg, fmt: fmtPct },
    { label: `${label}, calendar year`, color, width: 2.6, ...annual(D[t].neg, D[t].gen), fmt: fmtPct },
  ]));
  staticLegend($("yr-neg-legend"), neg);
  yearChart($("yr-neg"), neg, { title: `Share of output in hours whose day-ahead price at the unit's node was $0 or below, each ${per}`, yFmt: d3.format(".0%"), tipFmt: fmtPct, H: 200 });

  const Y = S.Y, mi = Y.months.length - 1, first = Y.months[0];
  const at = (t, f, i) => Y.monthly[t][f][i];
  const m0 = d3.timeFormat("%b %Y")(new Date(first + "-15")), m1 = d3.timeFormat("%b %Y")(new Date(Y.months[mi] + "-15"));
  const [w0, w1] = window.CX.fmtPair([at("wind", "gw", 0), at("wind", "gw", mi)], "GW"), [s0, s1] = window.CX.fmtPair([at("solar", "gw", 0), at("solar", "gw", mi)], "GW");
  $("yr-note").textContent = `Between ${m0} and ${m1}, wind grew from ${w0} to ${w1} and solar from ${s0} to ${s1}.`;
}

async function boot() {
  S.Y = await tryJSON("data/renewables/years.json.gz");
  if (!S.Y || !S.Y.months.length) {
    ["yr-size", "yr-energy", "yr-capture", "yr-neg"].forEach((id) => emptyMsg($(id), "Not built yet. It is built by the data update workflow."));
    return;
  }
  const v = window.CX.readHash();
  if (v.yby === "day" || v.yby === "month") S.by = v.yby;
  if (v.ycu === "usd") S.cu = "usd";
  setSeg("yr-by", S.by); setSeg("yr-cu", S.cu);
  $("yr-cu").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    S.cu = b.dataset.v; setSeg("yr-cu", S.cu); draw();
    window.CX.writeHash({ ...window.CX.readHash(), ycu: S.cu });
  });
  $("yr-by").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    S.by = b.dataset.v; setSeg("yr-by", S.by); draw();
    window.CX.writeHash({ ...window.CX.readHash(), yby: S.by });
  });
  draw();
  let t, lastW = 0;
  new ResizeObserver((e) => { const w = Math.round(e[0].contentRect.width); if (w === lastW) return; lastW = w; clearTimeout(t); t = setTimeout(draw, 120); }).observe(document.querySelector("main"));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", draw);
}
boot();
})();

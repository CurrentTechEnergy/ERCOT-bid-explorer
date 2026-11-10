/* Thermal page, across the years: what each thermal technology earned, the average price it got, what
   it cost to run and the margin left, for a chosen year or the last 12 months; that margin split by
   the kind of day it was made on; and price earned and margin year by year (or month by month) from
   2019. Reads data/thermal/years.json.gz (pipeline/thermal_years.py), and data/renewables/years.json.gz
   (pipeline/renew_years.py) for the average MWh's hub price and wind and solar beside thermal.
   thermal-units.js owns the technology picker and the status line. */
(() => {
"use strict";

const { tryJSON, showTip, hideTip, setCSV, css, axisFmt, fmtKind, esc } = window.CX;
const $ = (id) => document.getElementById(id);
const TECHS = [
  ["nuclear", "Nuclear", "--c5"],
  ["coal", "Coal & lignite", "--c8"],
  ["combined_cycle", "Combined cycle", "--c1"],
  ["gas_steam", "Gas steam", "--c6"],
  ["combustion_turbine", "Combustion turbine and recip", "--c2"],
];
const LABEL = Object.fromEntries(TECHS.map(([t, l]) => [t, l]));
// kinds of day by the day's average real-time ERCOT hub price (HB_HUBAVG), drawn on the site's
// sequential ramp (light = cheap, dark = expensive) so they don't borrow a technology's color
const KINDS = [
  { k: "cheap", label: "Under $20", lo: -Infinity, hi: 20, t: 0.25 },
  { k: "normal", label: "$20 to $40", lo: 20, hi: 40, t: 0.5 },
  { k: "firm", label: "$40 to $100", lo: 40, hi: 100, t: 0.75 },
  { k: "scarce", label: "$100 and up", lo: 100, hi: Infinity, t: 1 },
];
const kindColor = (k) => d3.interpolateLab(css("--seq-lo"), css("--seq-hi"))(k.t);
const S = { Y: null, R: null, period: "12m", by: "year", tech: "combined_cycle" };

const fmt$k = (v) => {      // compact money: $12k, $1.2M, $3.4B
  if (v == null || isNaN(v)) return "–";
  const a = Math.abs(v), sign = v < 0 ? "−" : "";
  return sign + "$" + (a >= 1e9 ? d3.format(",.2f")(a / 1e9) + "B" : a >= 1e6 ? d3.format(",.0f")(a / 1e6) + "M" : a >= 1e3 ? d3.format(",.0f")(a / 1e3) + "k" : d3.format(",.0f")(a));
};
const fmt$2 = (v) => (v == null || isNaN(v) ? "–" : (v < 0 ? "−" : "") + "$" + d3.format(",.2f")(Math.abs(v)));
const fmtTWh = (v) => (v == null ? "–" : d3.format(",.1f")(v / 1e6) + " TWh");
const fmtPct = d3.format(".0%");
const fdate = (d) => d3.timeFormat("%b %-d, %Y")(new Date(d + "T12:00:00"));
function emptyMsg(el, msg) { el.innerHTML = `<p class="empty">${msg}</p>`; }
function setSeg(id, value) { $(id).querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === value))); }
function staticLegend(el, list) {
  el.innerHTML = list.filter((s) => !s.hide).map((s) => `<span><span class="sw" style="background:var(${s.color});${s.faint ? "opacity:.55" : ""}"></span>${s.label}</span>`).join("");
}

// ---- sums over a set of day indices --------------------------------------------------
// {gen, rev, as, fuel, starts, start, margin} for technology t over the days in idx
function totals(t, idx) {
  const f = S.Y.techs[t], o = { gen: 0, rev: 0, as: 0, fuel: 0, starts: 0, start: 0 };
  for (const i of idx) if (f.gen[i] != null) for (const k in o) o[k] += f[k][i] || 0;
  o.margin = o.rev + o.as - o.fuel - o.start;
  o.earned = o.rev + o.as;
  o.cost = o.fuel + o.start;
  o.price = o.gen ? o.rev / o.gen : null;
  o.mpm = o.gen ? o.margin / o.gen : null;
  return o;
}
function periodDays(p) {
  const D = S.Y.dates;
  if (p === "12m") {
    const last = new Date(D.at(-1) + "T12:00:00"), from = d3.timeFormat("%Y-%m-%d")(d3.timeDay.offset(d3.timeYear.offset(last, -1), 1));
    return d3.range(D.length).filter((i) => D[i] >= from);
  }
  return d3.range(D.length).filter((i) => D[i].startsWith(p));
}
function periodLabel(p, idx) {
  const D = S.Y.dates, a = D[idx[0]], b = D[idx.at(-1)];
  if (p === "12m") return { short: "the last 12 months", range: `${fdate(a)} to ${fdate(b)}` };
  const part = !b.endsWith("-12-31") || !a.endsWith("-01-01");
  return { short: part ? `${p} to ${d3.timeFormat("%b %-d")(new Date(b + "T12:00:00"))}` : p, range: `${fdate(a)} to ${fdate(b)}` };
}

// ---- panel 1: what thermal earned -----------------------------------------------------
function drawHead() {
  const idx = periodDays(S.period), L = periodLabel(S.period, idx);
  $("ty-head-period").textContent = L.range;
  const rows = TECHS.map(([t, label]) => ({ t, label, ...totals(t, idx) }));
  const all = { t: "all", label: "All thermal" };
  ["gen", "rev", "as", "fuel", "starts", "start", "margin", "earned", "cost"].forEach((k) => { all[k] = d3.sum(rows, (r) => r[k]); });
  all.price = all.gen ? all.rev / all.gen : null; all.mpm = all.gen ? all.margin / all.gen : null;
  const neg = (v) => `<span class="${v < 0 ? "neg" : ""}">${fmt$k(v)}</span>`;
  const tr = (r) => `<tr${r.t === S.tech ? ' class="sel"' : ""}><td class="t">${r.t === S.tech ? `<b>${esc(r.label)}</b>` : esc(r.label)}</td><td>${fmtTWh(r.gen)}</td><td>${fmt$k(r.earned)}</td><td><b>${fmt$2(r.price)}</b></td><td>${fmt$k(r.cost)}</td><td>${neg(r.margin)}</td><td>${fmt$2(r.mpm)}</td><td>${d3.format(",")(r.starts)}</td></tr>`;
  $("ty-head-table").innerHTML = `<table class="data"><thead><tr><th class="t">Technology</th><th>Energy</th><th>Earned</th><th>Average price, $/MWh</th><th>Running cost</th><th>Margin</th><th>Margin, $/MWh</th><th>Starts</th></tr></thead><tbody>` +
    rows.map(tr).join("") + `</tbody><tfoot>${tr(all).replace("<tr", '<tr class="total"')}</tfoot></table>`;
  setCSV($("ty-head-table"), ["technology", "mwh", "energy_revenue", "ancillary", "fuel_and_vom", "start_cost", "margin", "average_price", "margin_per_mwh", "starts"],
    [...rows, all].map((r) => [r.label, Math.round(r.gen), Math.round(r.rev), Math.round(r.as), Math.round(r.fuel), Math.round(r.start), Math.round(r.margin), r.price && +r.price.toFixed(2), r.mpm && +r.mpm.toFixed(2), r.starts]), `Thermal earned, ${L.range}`);
  const s = rows.find((r) => r.t === S.tech), top = d3.greatest(rows, (r) => r.earned);
  window.CX.setNote($("ty-head-note"), `What each thermal technology earned over ${L.short}, the average price it got per MWh, and what was left after fuel, variable O&M and start-ups. ` +
    `${s.label} earned ${fmt$k(s.earned)} at an average ${fmt$2(s.price)}/MWh and kept ${fmt$k(s.margin)} (${fmt$2(s.mpm)}/MWh) after running costs.` +
    (top.t !== s.t ? ` ${top.label} earned the most, ${fmt$k(top.earned)}.` : "") + ` Pick another period or technology above.`,
    `Earned is energy revenue on the two-settlement basis (day-ahead award × day-ahead node price + output beyond it × real-time node price) plus day-ahead ancillary service awards. Average price is energy revenue over energy, so ancillary services are left out of it. ` +
    `Running cost: each unit's fuel at its measured heat rate from minimum to full load × its own hub's gas price (Henry Hub plus the month's basis where the hub has no price) or its plant's EIA-923 coal price, nuclear at the EIA heat rate × $${S.Y.nuc_fuel}/MMBtu; variable O&M of ${TECHS.map(([t]) => `$${S.Y.vom[t]}`).join(", ")}/MWh (${TECHS.map(([, l]) => l.toLowerCase()).join(", ")}); and each start at the unit's own day-ahead start offer, else the site's generic cost. ` +
    `Margin is what is left for fixed costs, debt and profit. It is the same basis as the units table below on its default settings, carried back to 2019 with ERCOT's hourly 60-day archive (before Dec 2025, intermediate and cold starts take the generic cost, as the archive keeps only the hot-start offer).`);
}

// ---- panel 2: margin by kind of day ---------------------------------------------------
function kindOf(p) { return p == null ? null : KINDS.find((k) => p >= k.lo && p < k.hi); }
function drawKinds() {
  const idx = periodDays(S.period), L = periodLabel(S.period, idx), el = $("ty-kinds");
  $("ty-kinds-period").textContent = L.range;
  const by = Object.fromEntries(KINDS.map((k) => [k.k, []]));
  idx.forEach((i) => { const k = kindOf(S.Y.hub_rt[i]); if (k) by[k.k].push(i); });
  $("ty-kinds-legend").innerHTML = KINDS.map((k) => `<span><span class="sw" style="background:${kindColor(k)}"></span>${k.label} (${by[k.k].length} day${by[k.k].length === 1 ? "" : "s"})</span>`).join("");
  const rows = TECHS.map(([t, label]) => ({ t, label, total: totals(t, idx), parts: KINDS.map((k) => ({ ...k, days: by[k.k].length, ...totals(t, by[k.k]) })) }));
  const w = Math.max(300, el.clientWidth || 600), narrow = w < 560, rowH = 34, m = { t: 22, r: 16, b: 26, l: narrow ? 110 : 200 };
  const H = m.t + m.b + rowH * rows.length;
  const lo = d3.min(rows, (r) => d3.sum(r.parts, (p) => Math.min(0, p.margin))), hi = d3.max(rows, (r) => d3.sum(r.parts, (p) => Math.max(0, p.margin)));
  const x = d3.scaleLinear().domain([Math.min(0, lo), Math.max(1, hi)]).nice().range([m.l, w - m.r]);
  const y = d3.scaleBand().domain(rows.map((r) => r.t)).range([m.t, H - m.b]).padding(0.28);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(narrow ? 4 : 7).tickSize(-(H - m.t - m.b)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(axisFmt(d3.axisBottom(x), narrow ? 4 : 7, "$k").tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text("Margin by kind of day, $ (losses left of zero)");
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).tickFormat((t) => (narrow ? LABEL[t].replace("Combustion turbine and recip", "CT and recip") : LABEL[t])).tickSize(0).tickPadding(6))
    .selectAll("text").style("font-weight", (t) => (t === S.tech ? 600 : null));
  rows.forEach((r) => {
    let pos = 0, neg = 0;
    r.parts.forEach((p) => {
      if (!p.margin) return;
      const a = p.margin > 0 ? pos : neg, b = a + p.margin;
      if (p.margin > 0) pos = b; else neg = b;
      svg.append("rect").attr("x", x(Math.min(a, b))).attr("width", Math.max(0.5, Math.abs(x(b) - x(a)))).attr("y", y(r.t)).attr("height", y.bandwidth()).attr("fill", kindColor(p))
        .on("pointermove", (ev) => showTip(ev, `<h4>${esc(r.label)}: days averaging ${p.label}</h4><table>` +
          `<tr><td>Days</td><td class="n">${p.days}</td></tr><tr><td>Margin</td><td class="n">${fmt$k(p.margin)}</td></tr>` +
          `<tr><td>Share of the period's margin</td><td class="n">${r.total.margin > 0 ? fmtPct(p.margin / r.total.margin) : "–"}</td></tr>` +
          `<tr><td>Average price earned</td><td class="n">${fmt$2(p.price)}/MWh</td></tr><tr><td>Margin per MWh</td><td class="n">${fmt$2(p.mpm)}</td></tr>` +
          `<tr><td>Energy</td><td class="n">${fmtTWh(p.gen)}</td></tr></table>`))
        .on("pointerleave", hideTip);
    });
  });
  svg.append("line").attr("class", "zero").attr("x1", x(0)).attr("x2", x(0)).attr("y1", m.t).attr("y2", H - m.b);
  el.replaceChildren(svg.node());
  setCSV(el, ["technology", "kind_of_day", "days", "margin", "average_price", "margin_per_mwh", "mwh"],
    rows.flatMap((r) => r.parts.map((p) => [r.label, p.label, p.days, Math.round(p.margin), p.price && +p.price.toFixed(2), p.mpm && +p.mpm.toFixed(2), Math.round(p.gen)])), `Margin by kind of day, ${L.range}`);
  const s = rows.find((r) => r.t === S.tech), hiK = s.parts.filter((p) => p.k === "firm" || p.k === "scarce"), cheap = s.parts[0];
  const hiM = d3.sum(hiK, (p) => p.margin), hiD = d3.sum(hiK, (p) => p.days);
  window.CX.setNote($("ty-kinds-note"), `How much of each technology's margin over ${L.short} came from expensive days and how much cheap days cost it, with days sorted by ERCOT's average real-time hub price that day. ` +
    (!hiD ? `${s.label} had no days averaging $40 or more` :
      s.total.margin > 0 && hiM <= s.total.margin ? `${s.label} made ${fmtPct(Math.max(0, hiM) / s.total.margin)} of its margin on the ${hiD} days (${fmtPct(hiD / idx.length)} of the period) averaging $40 or more`
      : `${s.label} made ${fmt$k(hiM)} on the ${hiD} days (${fmtPct(hiD / idx.length)} of the period) averaging $40 or more, ${s.total.margin > 0 ? `more than its ${fmt$k(s.total.margin)} margin over the whole period` : `against a margin of ${fmt$k(s.total.margin)} over the whole period`}`) +
    `; on the ${cheap.days} days under $20 it ${cheap.margin < 0 ? "lost" : "made"} ${fmt$k(Math.abs(cheap.margin))}${cheap.gen ? `, earning an average ${fmt$2(cheap.price)}/MWh` : ""}.`,
    `Each day goes in one bucket by the day's average real-time ERCOT hub price (HB_HUBAVG, the mean of its hours). A bar is the technology's margin, as in the table above, added up over the days in each bucket: gains right of zero, losses left. A day's average hides its hours, so a cheap day can still hold an expensive evening, and an expensive day can hold cheap midday hours. Hover a segment for its days, average price and margin per MWh.`);
}

// ---- panel 3: across the years ----------------------------------------------------------
// periods (years or months) -> {keys, dates (mid-period), idx: [[day index]], part: [bool]}
function periods() {
  const D = S.Y.dates, g = d3.group(d3.range(D.length), (i) => (S.by === "year" ? D[i].slice(0, 4) : D[i].slice(0, 7)));
  const keys = [...g.keys()].sort(), last = D.at(-1);
  return {
    keys, idx: keys.map((k) => g.get(k)),
    dates: keys.map((k) => new Date(S.by === "year" ? `${k}-07-01T12:00:00` : `${k}-15T12:00:00`)),
    part: keys.map((k, i) => (i === keys.length - 1 && (S.by === "year" ? !last.endsWith("-12-31") : +last.slice(8) < new Date(+k.slice(0, 4), +k.slice(5, 7), 0).getDate()))
      || (i === 0 && !D[0].endsWith(S.by === "year" ? "-01-01" : "-01"))),
    fmt: (k) => (S.by === "year" ? k : d3.timeFormat("%B %Y")(new Date(k + "-15T12:00:00"))),
  };
}
// the renewables file's monthly series summed into the same periods: weighted price (sum of v x w / sum w)
function renewPeriod(P, field, wfield, tech) {
  const R = S.R;
  if (!R || !R.months) return null;
  const f = R.monthly[tech] || R.monthly.wind;
  return P.keys.map((k) => {
    let a = 0, b = 0;
    R.months.forEach((m, i) => {
      if (!(S.by === "year" ? m.startsWith(k) : m === k)) return;
      const v = f[field][i], wt = (R.monthly[wfield[0]] || f)[wfield[1]][i];
      if (v == null || wt == null) return;
      a += v * wt; b += wt;
    });
    return b ? a / b : null;
  });
}
function lineChart(el, P, series, opts) {
  const dates = P.dates, w = Math.max(280, el.clientWidth || 600), H = opts.H || 240, m = { t: 18, r: 14, b: 26, l: 62 };
  const half = S.by === "year" ? 182 * 864e5 : 15 * 864e5;
  const x = d3.scaleTime().domain([new Date(+dates[0] - half), new Date(+dates.at(-1) + half)]).range([m.l, w - m.r]);
  const bars = opts.bars || [];
  const vals = series.filter((s) => !s.hide).flatMap((s) => s.values).concat(bars.flatMap((b) => b.values)).filter((v) => v != null);
  if (!vals.length) return emptyMsg(el, "No data.");
  const top = opts.yMax != null ? Math.min(opts.yMax, d3.max(vals)) : d3.max(vals);
  const y = d3.scaleLinear().domain([Math.min(0, d3.min(vals)), top]).nice().range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y), 5, opts.kind || fmtKind(opts.yFmt)).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call((S.by === "year" ? d3.axisBottom(x).tickValues(dates.filter((_, i) => w >= 560 || (dates.length - 1 - i) % 2 === 0)).tickFormat(d3.timeFormat("%Y")) : d3.axisBottom(x).ticks(w < 560 ? 4 : 8)).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text(opts.title);
  if (y.domain()[0] < 0) svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(0)).attr("y2", y(0));
  const clipId = `clip-${el.id}`;
  svg.append("clipPath").attr("id", clipId).append("rect").attr("x", m.l).attr("y", m.t - 2).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b + 2);
  const g = svg.append("g").attr("clip-path", `url(#${clipId})`);
  // grouped bars (yearly margin): one bar per series in each period
  if (bars.length) {
    const slot = (x(dates[1] || dates[0]) - x(dates[0])) || (w - m.l - m.r), bw = Math.max(1, (slot * 0.8) / bars.length);
    bars.forEach((b, j) => b.values.forEach((v, i) => {
      if (v == null) return;
      const x0 = x(dates[i]) - (bw * bars.length) / 2 + j * bw;
      g.append("rect").attr("x", x0).attr("width", Math.max(1, bw - 1)).attr("y", y(Math.max(0, v))).attr("height", Math.abs(y(v) - y(0)))
        .attr("fill", css(b.color)).attr("fill-opacity", P.part[i] ? 0.45 : (b.faint ? 0.5 : 1));
    }));
  }
  series.filter((s) => !s.hide).forEach((s) => {
    g.append("path").attr("fill", "none").attr("stroke", css(s.color)).attr("stroke-width", s.width || 2).attr("stroke-dasharray", s.dash || null).attr("stroke-opacity", s.faint ? 0.45 : 1)
      .attr("d", d3.line().defined((v) => v != null).x((_, i) => x(dates[i])).y((v) => y(v))(s.values));
    if (S.by === "year") g.append("g").selectAll("circle").data(s.values.map((v, i) => [v, i]).filter(([v]) => v != null)).join("circle")
      .attr("cx", ([, i]) => x(dates[i])).attr("cy", ([v]) => y(v)).attr("r", s.faint ? 2 : 3)
      .attr("fill", ([, i]) => (P.part[i] ? css("--surface") : css(s.color))).attr("stroke", css(s.color)).attr("stroke-opacity", s.faint ? 0.45 : 1);
  });
  // values past the scale: a marker with the real value at the top edge
  if (opts.yMax != null) {
    [...bars, ...series.filter((s) => !s.hide && !s.faint)].forEach((s, j) => s.values.forEach((v, i) => {
      if (v == null || v <= y.domain()[1]) return;
      const bw = bars.length ? Math.max(1, ((x(dates[1] || dates[0]) - x(dates[0])) * 0.8) / bars.length) : 0;
      const cx = bars.includes(s) ? x(dates[i]) - (bw * bars.length) / 2 + j * bw + bw / 2 : x(dates[i]);
      svg.append("text").attr("class", "axis-title").attr("x", cx).attr("y", m.t + 8 + (j % 3) * 10).attr("text-anchor", "middle").style("fill", css(s.color)).text("↑");
    }));
  }
  const shown = [...bars, ...series].filter((s) => !s.noTip), tf = opts.tipFmt;
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", H - m.b).style("display", "none");
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const t = x.invert(d3.pointer(ev)[0]), i = d3.minIndex(dates, (d) => Math.abs(d - t));
      cross.style("display", null).attr("x1", x(dates[i])).attr("x2", x(dates[i]));
      const D = S.Y.dates, a = D[P.idx[i][0]], b = D[P.idx[i].at(-1)];
      showTip(ev, `<h4>${P.fmt(P.keys[i])}${P.part[i] ? ` (${fdate(a)} to ${fdate(b)})` : ""}</h4><table>` + shown.filter((s) => s.values[i] != null).map((s) =>
        `<tr><td><span class="sw" style="background:var(${s.color})"></span></td><td>${s.label}</td><td class="n">${tf(s.values[i])}</td></tr>`).join("") + "</table>");
    })
    .on("pointerleave", () => { cross.style("display", "none"); hideTip(); });
  el.replaceChildren(svg.node());
  setCSV(el, [S.by, ...shown.map((s) => s.label)], P.keys.map((k, i) => [k, ...shown.map((s) => (s.values[i] == null ? null : +s.values[i].toFixed(2)))]), opts.title);
}
function drawYears() {
  const P = periods();
  const tot = Object.fromEntries(TECHS.map(([t]) => [t, P.idx.map((idx) => totals(t, idx))]));
  // average price earned: thermal technologies; the average MWh's hub price and wind and solar from the renewables file
  const hub = renewPeriod(P, "hub_rt_gen", ["wind", "sys_gen"], "wind");
  const price = TECHS.map(([t, label, color]) => ({ label, color, width: t === S.tech ? 3.2 : 1.8, values: tot[t].map((o) => o.price) }));
  const contrast = [
    { label: "Wind (real-time at its node)", color: "--c3", faint: true, width: 1.4, values: renewPeriod(P, "rt_capture", ["wind", "gen"], "wind") || [] },
    { label: "Solar (real-time at its node)", color: "--c4", faint: true, width: 1.4, values: renewPeriod(P, "rt_capture", ["solar", "gen"], "solar") || [] },
    { label: "Average MWh at the hub", color: "--c-other", dash: "5 4", width: 1.6, values: hub || [] },
  ].filter((s) => s.values.some((v) => v != null));
  const pAll = [...price, ...contrast];
  const pMax = S.by === "year" ? 150 : 250;
  staticLegend($("ty-price-legend"), pAll);
  lineChart($("ty-price"), P, pAll, { title: `Average price earned, $/MWh: energy revenue over energy, each ${S.by}; scale cut at $${pMax}`, yFmt: (v) => `$${d3.format(",.0f")(v)}`, kind: "$", tipFmt: (v) => `${fmt$2(v)}/MWh`, yMax: pMax });
  // margin: yearly grouped bars, monthly lines; the scale stops short of a period far above the rest
  const mv = TECHS.map(([t, label, color]) => ({ label, color, width: t === S.tech ? 3 : 1.6, values: tot[t].map((o) => o.margin) }));
  const peaks = P.keys.map((_, i) => d3.max(mv, (s) => s.values[i])), order = d3.sort(d3.range(peaks.length), (i) => -peaks[i]);
  const cut = peaks.length > 2 && peaks[order[0]] > 2.5 * peaks[order[1]] ? peaks[order[1]] * 1.25 : null;
  staticLegend($("ty-margin-legend"), mv);
  lineChart($("ty-margin"), P, S.by === "year" ? [] : mv, { bars: S.by === "year" ? mv : [], title: `Margin after running costs, $, each ${S.by}${cut ? `; scale cut at ${fmt$k(cut)} (↑ runs off the top)` : ""}`,
    yFmt: (v) => fmt$k(v), kind: "$k", tipFmt: fmt$k, yMax: cut, H: 260 });
  const off = cut ? P.keys.filter((_, i) => peaks[i] > cut) : [];
  const yrs = P.keys.filter((_, i) => !P.part[i]);
  const s = tot[S.tech], a = yrs.length ? P.keys.indexOf(yrs[0]) : 0, b = yrs.length ? P.keys.indexOf(yrs.at(-1)) : P.keys.length - 1;
  window.CX.setNote($("ty-years-note"), `How the price thermal units earn and the margin they keep have moved since 2019, against the average MWh's hub price and the price wind and solar earned (from Renewables). ` +
    `${LABEL[S.tech]} earned an average ${fmt$2(s[a].price)}/MWh in ${P.fmt(P.keys[a])} and ${fmt$2(s[b].price)}/MWh in ${P.fmt(P.keys[b])}, keeping ${fmt$k(s[a].margin)} and ${fmt$k(s[b].margin)}.` +
    (off.length ? ` ${off.map(P.fmt).join(", ")} run${off.length === 1 ? "s" : ""} off the margin scale${off.some((k) => k.startsWith("2021")) ? " (Winter Storm Uri, Feb 2021)" : ""}; hover for the value.` : "") +
    (P.part.some(Boolean) ? ` Hollow points and pale bars are part ${S.by}s.` : ""),
    `The thermal figures are those of the table above, added up by ${S.by}. Wind and solar are the price they earned at their own nodes in real time (Renewables' "Across the years"), not two-settlement, so they compare by level rather than to the cent. The average MWh at the hub is ERCOT's real-time hub average weighted by each hour's ERCOT generation: what the average MWh sold earned. The selected technology is drawn thicker.`);
}

function draw() {
  if (!S.Y) return;
  drawHead(); drawKinds(); drawYears();
}

async function boot() {
  [S.Y, S.R] = await Promise.all([tryJSON("data/thermal/years.json.gz"), tryJSON("data/renewables/years.json.gz")]);
  if (!S.Y || !S.Y.dates?.length) {
    ["ty-head-table", "ty-kinds", "ty-price", "ty-margin"].forEach((id) => emptyMsg($(id), "Not built yet. It is built by the data update workflow."));
    return;
  }
  const v = window.CX.readHash();
  if (v.tech && LABEL[v.tech]) S.tech = v.tech;
  if (v.tyby === "year" || v.tyby === "month") S.by = v.tyby;
  const years = [...new Set(S.Y.dates.map((d) => d.slice(0, 4)))].sort().reverse();
  if (v.ty && (v.ty === "12m" || years.includes(v.ty))) S.period = v.ty;
  $("ty-period").innerHTML = [["12m", "Last 12 months"], ...years.map((y) => [y, periodLabel(y, periodDays(y)).short])].map(([k, l]) => `<option value="${k}">${l}</option>`).join("");
  $("ty-period").value = S.period;
  $("ty-period").onchange = (e) => { S.period = e.target.value; drawHead(); drawKinds(); window.CX.writeHash({ ...window.CX.readHash(), ty: S.period }); };
  setSeg("ty-by", S.by);
  $("ty-by").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    S.by = b.dataset.v; setSeg("ty-by", S.by); drawYears();
    window.CX.writeHash({ ...window.CX.readHash(), tyby: S.by });
  });
  document.addEventListener("thermal-tech", (e) => { S.tech = e.detail; draw(); });
  const D = S.Y.dates, h = S.Y.src.indexOf("s");
  $("status-years").textContent = `Across the years: ${D.length.toLocaleString()} days, ${fdate(D[0])} to ${fdate(D.at(-1))}` +
    (h > 0 ? ` · ERCOT's hourly 60-day archive to ${fdate(D[h - 1])}, the loaded 60-day days after` : "");
  draw();
  let t, lastW = 0;
  new ResizeObserver((e) => { const w = Math.round(e[0].contentRect.width); if (w === lastW) return; lastW = w; clearTimeout(t); t = setTimeout(draw, 120); }).observe(document.querySelector("main"));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", draw);
}
boot();
})();

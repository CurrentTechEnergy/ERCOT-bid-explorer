/* Renewables, what wind and solar earned: energy, revenue, average price, capture rate and curtailed
   share for a chosen year or the last 12 months, with thermal beside them; and how their output and
   revenue split across kinds of day (cheap to scarce, as on the Thermal page). Reads
   data/renewables/earned.json.gz (pipeline/renew_earned.py) and data/thermal/years.json.gz
   (pipeline/thermal_years.py). renewables.js owns the status line and CX.init. */
(() => {
"use strict";

const { tryJSON, showTip, hideTip, setCSV, css, axisFmt, esc } = window.CX;
const $ = (id) => document.getElementById(id);
// the Thermal page's kinds of day (thermal-years.js): the day's average real-time ERCOT hub price
const KINDS = [
  { k: "cheap", label: "Under $20", lo: -Infinity, hi: 20, t: 0.25 },
  { k: "normal", label: "$20 to $40", lo: 20, hi: 40, t: 0.5 },
  { k: "firm", label: "$40 to $100", lo: 40, hi: 100, t: 0.75 },
  { k: "scarce", label: "$100 and up", lo: 100, hi: Infinity, t: 1 },
];
const kindColor = (k) => d3.interpolateLab(css("--seq-lo"), css("--seq-hi"))(k.t);
const RENEW = [["wind", "Wind"], ["solar", "Solar"]];
const THERMAL = [["coal", "Coal & lignite"], ["combined_cycle", "Combined cycle"], ["nuclear", "Nuclear"]];
const S = { E: null, T: null, period: "12m" };

const fmt$k = (v) => {
  if (v == null || isNaN(v)) return "–";
  const a = Math.abs(v), sign = v < 0 ? "−" : "";
  return sign + "$" + (a >= 1e9 ? d3.format(",.2f")(a / 1e9) + "B" : a >= 1e6 ? d3.format(",.0f")(a / 1e6) + "M" : a >= 1e3 ? d3.format(",.0f")(a / 1e3) + "k" : d3.format(",.0f")(a));
};
const fmt$2 = (v) => (v == null || isNaN(v) ? "–" : (v < 0 ? "−" : "") + "$" + d3.format(",.2f")(Math.abs(v)));
const fmtTWh = (v) => (v == null ? "–" : d3.format(",.1f")(v / 1e6) + " TWh");
const fmtPct = (v) => (v == null || isNaN(v) ? "–" : d3.format(".0%")(v));
const fdate = (d) => d3.timeFormat("%b %-d, %Y")(new Date(d + "T12:00:00"));
function emptyMsg(el, msg) { el.innerHTML = `<p class="empty">${msg}</p>`; }

// day indices of a period ("12m" or a year) in a dates array
function periodIdx(dates, p, last) {
  if (p === "12m") {
    const end = new Date(last + "T12:00:00"), from = d3.timeFormat("%Y-%m-%d")(d3.timeDay.offset(d3.timeYear.offset(end, -1), 1));
    return d3.range(dates.length).filter((i) => dates[i] >= from && dates[i] <= last);
  }
  return d3.range(dates.length).filter((i) => dates[i].startsWith(p) && dates[i] <= last);
}
// the last day both files cover, so wind and thermal compare over the same days
const lastDay = () => d3.min([S.E.dates.at(-1), S.T ? S.T.dates.at(-1) : S.E.dates.at(-1)]);
function label(p, idx) {
  const D = S.E.dates, a = D[idx[0]], b = D[idx.at(-1)];
  if (p === "12m") return { short: "the last 12 months", range: `${fdate(a)} to ${fdate(b)}` };
  const part = !b.endsWith("-12-31") || !a.endsWith("-01-01");
  return { short: part ? `${p} to ${d3.timeFormat("%b %-d")(new Date(b + "T12:00:00"))}` : p, range: `${fdate(a)} to ${fdate(b)}` };
}
function sumE(t, idx) {
  const f = S.E.techs[t], o = { gen: 0, rev: 0, as: 0, curt: 0 };
  for (const i of idx) if (f.gen[i] != null) for (const k in o) o[k] += f[k][i] || 0;
  return o;
}
function sumT(t, idx) {
  const f = S.T.techs[t], o = { gen: 0, rev: 0, as: 0 };
  for (const i of idx) if (f.gen[i] != null) for (const k in o) o[k] += f[k][i] || 0;
  return o;
}
// what the average MWh earned at the hub over the days: ERCOT generation's hub revenue / its MWh
function hubAvg(idx) {
  let r = 0, g = 0;
  for (const i of idx) if (S.E.sys_gen[i] != null && S.E.sys_rev[i] != null) { r += S.E.sys_rev[i]; g += S.E.sys_gen[i]; }
  return g ? r / g : null;
}
// the thermal file's day indices for the same dates
const tIdx = (idx) => { const m = new Map(S.T.dates.map((d, i) => [d, i])); return idx.map((i) => m.get(S.E.dates[i])).filter((i) => i != null); };

function rows(idx) {
  const hub = hubAvg(idx), out = [];
  const add = (key, lab, o, renew) => {
    const price = o.gen ? o.rev / o.gen : null;
    out.push({ key, label: lab, renew, gen: o.gen, earned: o.rev + o.as, price, capture: price != null && hub ? price / hub : null,
      curt: renew && o.gen + o.curt ? o.curt / (o.gen + o.curt) : null });
  };
  RENEW.forEach(([t, l]) => add(t, l, sumE(t, idx), true));
  const both = ["gen", "rev", "as", "curt"].reduce((o, k) => ({ ...o, [k]: d3.sum(RENEW, ([t]) => sumE(t, idx)[k]) }), {});
  add("renew", "Wind and solar", both, true);
  if (S.T) {
    const ti = tIdx(idx);
    THERMAL.forEach(([t, l]) => add(t, l, sumT(t, ti), false));
    const all = ["gen", "rev", "as"].reduce((o, k) => ({ ...o, [k]: d3.sum(Object.keys(S.T.techs), (t) => sumT(t, ti)[k]) }), {});
    add("thermal", "All thermal", all, false);
  }
  return { rows: out, hub };
}

function drawHead() {
  const idx = periodIdx(S.E.dates, S.period, lastDay()), L = label(S.period, idx), { rows: R, hub } = rows(idx);
  $("re-head-period").textContent = L.range;
  const tr = (r) => `<tr${r.key === "renew" || r.key === "thermal" ? ' class="total"' : ""}><td class="t">${r.renew ? esc(r.label) : `<span class="muted">${esc(r.label)}</span>`}</td><td>${fmtTWh(r.gen)}</td><td>${fmt$k(r.earned)}</td><td><b>${fmt$2(r.price)}</b></td><td>${fmtPct(r.capture)}</td><td>${r.curt == null ? "–" : d3.format(".1%")(r.curt)}</td></tr>`;
  const ren = R.filter((r) => r.renew), th = R.filter((r) => !r.renew);
  $("re-head-table").innerHTML = `<table class="data"><thead><tr><th class="t">Technology</th><th>Energy</th><th>Earned</th><th>Average price, $/MWh</th><th>Capture rate</th><th>Curtailed share</th></tr></thead><tbody>` +
    ren.map(tr).join("") + (th.length ? `<tr><td class="t" colspan="6"><span class="h-note">Thermal, for contrast (from the <a href="thermal.html">Thermal</a> page)</span></td></tr>` + th.map(tr).join("") : "") + `</tbody></table>`;
  setCSV($("re-head-table"), ["technology", "mwh", "earned", "average_price", "capture_rate", "curtailed_share"],
    R.map((r) => [r.label, Math.round(r.gen), Math.round(r.earned), r.price && +r.price.toFixed(2), r.capture && +r.capture.toFixed(3), r.curt && +r.curt.toFixed(4)]), `Wind and solar earned, ${L.range}`);
  const w = R.find((r) => r.key === "wind"), s = R.find((r) => r.key === "solar"), c = R.find((r) => r.key === "coal");
  window.CX.setNote($("re-head-note"), `What wind and solar earned over ${L.short} and the average price they got per MWh, beside thermal on the same basis. ` +
    `Wind earned ${fmt$k(w.earned)} at an average ${fmt$2(w.price)}/MWh and solar ${fmt$k(s.earned)} at ${fmt$2(s.price)}/MWh` +
    (c ? `, against ${fmt$2(c.price)}/MWh for coal` : "") + (hub ? ` and ${fmt$2(hub)}/MWh for the average MWh at the hub.` : ".") + ` Pick another period at the right.`,
    `Earned is energy revenue on the two-settlement basis (day-ahead award × day-ahead node price + output beyond it × real-time node price, real-time at the node for units with no day-ahead position) plus day-ahead ancillary services, which the history before Dec 2025 does not carry for wind and solar (a few tenths of a percent of their revenue). ` +
    `Average price is energy revenue over energy. Capture rate is that average over what the average MWh earned at the hub: ERCOT's real-time hub average weighted by each hour's ERCOT generation, as in "Across the years" below. Curtailed share is curtailed energy (HSL above base point) over output plus curtailment. ` +
    `Thermal rows are the Thermal page's figures over the same days; there is no fuel cost on the wind and solar side, so their revenue is their margin before fixed costs. From ERCOT's hourly 60-day archive back to 2019, and the loaded 60-day days after Nov 2025.`);
}

function drawKinds() {
  const idx = periodIdx(S.E.dates, S.period, lastDay()), L = label(S.period, idx), el = $("re-kinds");
  $("re-kinds-period").textContent = L.range;
  const kindOf = (p) => (p == null ? null : KINDS.find((k) => p >= k.lo && p < k.hi));
  const by = Object.fromEntries(KINDS.map((k) => [k.k, []]));
  idx.forEach((i) => { const k = kindOf(S.E.hub_rt[i]); if (k) by[k.k].push(i); });
  $("re-kinds-legend").innerHTML = KINDS.map((k) => `<span><span class="sw" style="background:${kindColor(k)}"></span>${k.label} (${by[k.k].length} day${by[k.k].length === 1 ? "" : "s"})</span>`).join("");
  // a group per technology: its output and its revenue split by kind of day, as shares of the period's total
  const groups = RENEW.map(([t, lab]) => {
    const parts = KINDS.map((k) => ({ ...k, days: by[k.k].length, ...sumE(t, by[k.k]) }));
    return { t, lab, parts };
  });
  if (S.T) {
    const parts = KINDS.map((k) => { const ti = tIdx(by[k.k]); return { ...k, days: by[k.k].length, ...["gen", "rev", "as"].reduce((o, f) => ({ ...o, [f]: d3.sum(Object.keys(S.T.techs), (t) => sumT(t, ti)[f]) }), {}) }; });
    groups.push({ t: "thermal", lab: "All thermal", parts });
  }
  const bars = groups.flatMap((g) => {
    const G = d3.sum(g.parts, (p) => p.gen), Rv = d3.sum(g.parts, (p) => p.rev);
    return [
      { g, kind: "Output", vals: g.parts.map((p) => (G ? p.gen / G : 0)) },
      { g, kind: "Revenue", vals: g.parts.map((p) => (Rv ? p.rev / Rv : 0)) },
    ];
  });
  const w = Math.max(300, el.clientWidth || 600), narrow = w < 560, rowH = 26, gap = 14, m = { t: 22, r: 16, b: 26, l: narrow ? 120 : 190 };
  const H = m.t + m.b + bars.length * rowH + groups.length * gap;
  const lo = Math.min(0, d3.min(bars, (b) => d3.sum(b.vals, (v) => Math.min(0, v)))), hi = Math.max(1, d3.max(bars, (b) => d3.sum(b.vals, (v) => Math.max(0, v))));
  const x = d3.scaleLinear().domain([lo, hi]).range([m.l, w - m.r]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(narrow ? 4 : 6).tickSize(-(H - m.t - m.b)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(axisFmt(d3.axisBottom(x), narrow ? 4 : 6, "%").tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", narrow ? 0 : m.l).attr("y", 10).text(narrow ? "Share of output and revenue, by kind of day" : "Share of the period's output and revenue, by kind of day");
  let yy = m.t;
  bars.forEach((b, bi) => {
    if (bi % 2 === 0) yy += gap;
    const y0 = yy, bh = rowH - 6;
    svg.append("text").attr("class", "axis-title").attr("x", m.l - 8).attr("y", y0 + bh / 2 + 4).attr("text-anchor", "end")
      .style("font-weight", bi % 2 === 0 ? 600 : null).text(bi % 2 === 0 ? `${b.g.lab}: output` : "revenue");
    let pos = 0, neg = 0;
    b.vals.forEach((v, j) => {
      if (!v) return;
      const a = v > 0 ? pos : neg, e = a + v;
      if (v > 0) pos = e; else neg = e;
      const p = b.g.parts[j];
      svg.append("rect").attr("x", x(Math.min(a, e))).attr("width", Math.max(0.5, Math.abs(x(e) - x(a)))).attr("y", y0).attr("height", bh).attr("fill", kindColor(p))
        .on("pointermove", (ev) => showTip(ev, `<h4>${esc(b.g.lab)}: days averaging ${p.label}</h4><table>` +
          `<tr><td>Days</td><td class="n">${p.days}</td></tr><tr><td>Share of output</td><td class="n">${fmtPct(bars[bi - (bi % 2)].vals[j])}</td></tr>` +
          `<tr><td>Share of revenue</td><td class="n">${fmtPct(bars[bi - (bi % 2) + 1].vals[j])}</td></tr>` +
          `<tr><td>Energy</td><td class="n">${fmtTWh(p.gen)}</td></tr><tr><td>Revenue</td><td class="n">${fmt$k(p.rev)}</td></tr>` +
          `<tr><td>Average price earned</td><td class="n">${p.gen ? fmt$2(p.rev / p.gen) + "/MWh" : "–"}</td></tr></table>`))
        .on("pointerleave", hideTip);
    });
    yy += rowH;
  });
  svg.append("line").attr("class", "zero").attr("x1", x(0)).attr("x2", x(0)).attr("y1", m.t).attr("y2", H - m.b);
  el.replaceChildren(svg.node());
  setCSV(el, ["technology", "kind_of_day", "days", "mwh", "revenue", "share_of_output", "share_of_revenue"],
    groups.flatMap((g) => { const G = d3.sum(g.parts, (p) => p.gen), Rv = d3.sum(g.parts, (p) => p.rev);
      return g.parts.map((p) => [g.lab, p.label, p.days, Math.round(p.gen), Math.round(p.rev), G ? +(p.gen / G).toFixed(4) : null, Rv ? +(p.rev / Rv).toFixed(4) : null]); }), `Where wind and solar revenue comes from, ${L.range}`);
  const wg = groups[0], G = d3.sum(wg.parts, (p) => p.gen), Rv = d3.sum(wg.parts, (p) => p.rev), ch = wg.parts[0];
  const sg = groups[1], sG = d3.sum(sg.parts, (p) => p.gen), sR = d3.sum(sg.parts, (p) => p.rev), sc = sg.parts[0];
  window.CX.setNote($("re-kinds-note"), `How much of wind's and solar's output lands on cheap days and how little it earns there, with days sorted by ERCOT's average real-time hub price that day, as on the Thermal page. ` +
    (G && ch.days ? `Over ${L.short}, wind made ${fmtPct(ch.gen / G)} of its energy on the ${ch.days} days averaging under $20 and earned ${fmtPct(ch.rev / Rv)} of its revenue there (${fmt$2(ch.rev / (ch.gen || 1))}/MWh); solar made ${fmtPct(sc.gen / sG)} and earned ${fmtPct(sc.rev / sR)}.` : "") +
    ` Thermal is drawn below for contrast; its losses on those days are on the Thermal page.`,
    `Each day goes in one bucket by the day's average real-time ERCOT hub price (HB_HUBAVG, the mean of its hours). For each technology the top bar splits the period's output across the buckets and the bottom bar its energy revenue (ancillary services left out); a share left of zero is revenue lost on those days, when the price at the units' nodes went negative. A day's average hides its hours: solar's midday output can sit in cheap hours of an expensive day. Hover a segment for its days, energy, revenue and average price.`);
}

function draw() { if (S.E) { drawHead(); drawKinds(); } }

async function boot() {
  [S.E, S.T] = await Promise.all([tryJSON("data/renewables/earned.json.gz"), tryJSON("data/thermal/years.json.gz")]);
  if (!S.E || !S.E.dates?.length) {
    ["re-head-table", "re-kinds"].forEach((id) => emptyMsg($(id), "Not built yet. It is built by the data update workflow."));
    return;
  }
  const v = window.CX.readHash(), last = lastDay();
  const years = [...new Set(S.E.dates.filter((d) => d <= last).map((d) => d.slice(0, 4)))].sort().reverse();
  if (v.rep && (v.rep === "12m" || years.includes(v.rep))) S.period = v.rep;
  $("re-period").innerHTML = [["12m", "Last 12 months"], ...years.map((y) => [y, label(y, periodIdx(S.E.dates, y, last)).short])].map(([k, l]) => `<option value="${k}">${l}</option>`).join("");
  $("re-period").value = S.period;
  $("re-period").onchange = (e) => { S.period = e.target.value; draw(); window.CX.writeHash({ ...window.CX.readHash(), rep: S.period }); };
  draw();
  let t, lastW = 0;
  new ResizeObserver((e) => { const w = Math.round(e[0].contentRect.width); if (w === lastW) return; lastW = w; clearTimeout(t); t = setTimeout(draw, 120); }).observe(document.querySelector("main"));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", draw);
}
boot();
})();

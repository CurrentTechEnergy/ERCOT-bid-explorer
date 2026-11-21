/* Load: ERCOT's day-ahead load forecast against actual load, net load three ways, and the
   forecast's bias by real-time price, from data/load_page.json.gz (pipeline/load_page.py).
   The page only reads and draws what the file holds. */
(() => {
const CX = window.CX;
const { tryJSON, showTip, hideTip, setCSV, css, esc } = CX;
const $ = (id) => document.getElementById(id);
const S = { P: null, day: null, win: "90", picker: null };
const CHEAP = 10;                                   // $/MWh: the site's cheap-hour cut
const BANDS = [["≤ $0", -Infinity, 0], ["$0–10", 0, 10], ["$10–40", 10, 40], ["> $40", 40, Infinity]];
const HOURS = d3.range(1, 25);

const gw = (v) => (v == null ? "–" : d3.format(",.1f")(v / 1000) + " GW");
const mw = (v, sign) => (v == null ? "–" : (sign && v > 0 ? "+" : v < 0 ? "−" : "") + d3.format(",.0f")(Math.abs(v)) + " MW");
const sub = (a, b) => (a == null || b == null ? null : a - b);
const sum = (...xs) => (xs.some((x) => x == null) ? null : xs.reduce((s, x) => s + x, 0));
const width = (el) => Math.max(300, el.clientWidth || 640);
function frame(el, W, H, m) {
  el.innerHTML = "";
  const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${W} ${H}`);
  return { svg, g: svg.append("g").attr("transform", `translate(${m.l},${m.t})`), w: W - m.l - m.r, h: H - m.t - m.b };
}
const tipRows = (rows) => `<table>${rows.map(([sw, k, v, dash]) => `<tr><td>${sw ? `<span class="sw" style="background:${sw}${dash ? ";opacity:.6" : ""}"></span> ` : ""}${esc(k)}</td><td class="n">${v}</td></tr>`).join("")}</table>`;
const legend = (el, items) => { $(el).innerHTML = items.map(([c, t, k]) => `<span style="color:${c}"><i class="${k || ""}" style="${k === "area" ? `background:${c};opacity:.35` : ""}"></i><span style="color:var(--ink-2)">${esc(t)}</span></span>`).join(""); };
const kpis = (el, items) => { $(el).innerHTML = items.map(([v, k]) => `<div class="kpi"><span class="v">${v}</span><span class="k">${esc(k)}</span></div>`).join(""); };

function day() { return S.P.days[S.day] || {}; }
function net(d) {
  const at = (a, i) => (a ? a[i] : null);
  return HOURS.map((h) => {
    const i = h - 1;
    const fc = sub(at(d.fc, i), sum(at(d.wfc, i), at(d.sfc, i)));
    const pot = sub(at(d.act, i), sum(at(d.whsl, i), at(d.shsl, i)));
    const srv = sub(at(d.act, i), sum(at(d.wact, i), at(d.sact, i)));
    return { h, fc, pot, srv, cur: pot == null || srv == null ? null : Math.max(0, srv - pot) };
  });
}

// A one-day hourly chart: lines over hour ending, plus optional shaded bands between pairs of series
function hourChart(el, series, bands, tip, csv) {
  const W = width(el), H = Math.round(Math.min(380, Math.max(260, W * 0.36)));
  const m = { l: 56, r: 14, t: 18, b: 34 }, { g, w, h, svg } = frame(el, W, H, m);
  const vals = series.flatMap((s) => s.v).filter((v) => v != null);
  if (!vals.length) { el.innerHTML = `<p class="note">No data for this day yet.</p>`; return; }
  const x = d3.scaleLinear().domain([1, 24]).range([0, w]);
  const y = d3.scaleLinear().domain(d3.extent(vals)).nice().range([h, 0]);
  g.append("g").attr("class", "gridline").call(d3.axisLeft(y).ticks(5).tickSize(-w).tickFormat(""));
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5).tickFormat((v) => d3.format(",")(v / 1000)).tickSizeOuter(0));
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`).call(d3.axisBottom(x).ticks(w < 500 ? 6 : 12).tickFormat((v) => v).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 12).text("GW");
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", H - 4).text("Hour ending (Central) →");
  (bands || []).forEach((band) => {
    const pts = HOURS.map((hh, i) => [hh, band.a[i], band.b[i]]).filter((p) => p[1] != null && p[2] != null);
    g.append("path").attr("d", d3.area().x((p) => x(p[0])).y0((p) => y(p[1])).y1((p) => y(p[2])).curve(d3.curveMonotoneX)(pts))
      .attr("fill", band.color).attr("opacity", 0.28);
  });
  series.forEach((s) => {
    const pts = HOURS.map((hh, i) => [hh, s.v[i]]).filter((p) => p[1] != null);
    g.append("path").attr("d", d3.line().x((p) => x(p[0])).y((p) => y(p[1])).curve(d3.curveMonotoneX)(pts))
      .attr("fill", "none").attr("stroke", s.color).attr("stroke-width", 2).attr("stroke-dasharray", s.dash ? "6 4" : null);
  });
  const vl = g.append("line").attr("class", "crosshair").attr("y1", 0).attr("y2", h).attr("visibility", "hidden");
  g.append("rect").attr("width", w).attr("height", h).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const hh = Math.max(1, Math.min(24, Math.round(x.invert(d3.pointer(ev)[0]))));
      vl.attr("x1", x(hh)).attr("x2", x(hh)).attr("visibility", "visible");
      showTip(ev, tip(hh));
    })
    .on("pointerleave", () => { vl.attr("visibility", "hidden"); hideTip(); });
  setCSV(el, csv[0], csv[1], csv[2]);
}

function drawLoad() {
  const d = day(), price = (i) => (d.lam ? d.lam[i] : null);
  const err = HOURS.map((h) => sub(d.fc?.[h - 1], d.act?.[h - 1]));
  const have = err.filter((v) => v != null);
  const cheap = HOURS.filter((h) => price(h - 1) != null && price(h - 1) <= CHEAP && err[h - 1] != null);
  kpis("load-kpis", [
    [have.length ? mw(d3.mean(have), true) : "–", "average error (forecast − actual)"],
    [have.length ? mw(d3.mean(have, Math.abs)) : "–", "average size of the miss"],
    [cheap.length ? mw(d3.mean(cheap, (h) => err[h - 1]), true) : "–", cheap.length ? `average error in the ${cheap.length} hour${cheap.length > 1 ? "s" : ""} with DA system lambda at $${CHEAP} or less` : `no hours with DA system lambda at $${CHEAP} or less`],
  ]);
  const cF = css("--muted"), cA = css("--ink"), cHi = css("--c2"), cLo = css("--c1");
  const fc = d.fc || [], act = d.act || [];
  const clamp = (f) => HOURS.map((h) => (fc[h - 1] == null || act[h - 1] == null ? null : f(fc[h - 1], act[h - 1])));
  legend("load-legend", [[cF, "Forecast as of the day-ahead market", "dash"], [cA, "Actual load"], [cHi, "Forecast too high", "area"], [cLo, "Forecast too low", "area"]]);
  hourChart($("load-chart"), [{ v: fc, color: cF, dash: true }, { v: act, color: cA }],
    [{ a: act, b: clamp(Math.max), color: cHi }, { a: act, b: clamp(Math.min), color: cLo }],
    (h) => `<h4>${CX.dayLabel(S.day)}, HE ${h}</h4>` + tipRows([[cF, "Forecast", gw(d.fc?.[h - 1]), 1], [cA, "Actual", gw(d.act?.[h - 1])], [null, "Forecast − actual", mw(err[h - 1], true)], [null, "DA system lambda", price(h - 1) == null ? "–" : "$" + price(h - 1).toFixed(2)]]),
    [["hour_ending", "load_forecast_mw", "load_actual_mw", "forecast_minus_actual_mw", "da_system_lambda_usd_mwh"], HOURS.map((h) => [h, d.fc?.[h - 1], d.act?.[h - 1], err[h - 1], price(h - 1)]), `Load forecast and actual ${S.day}`]);
  $("load-note").textContent = "ERCOT's load forecast as posted before the day-ahead market, against actual load, ERCOT total." +
    (d.act ? "" : " Actual load for this day is not posted yet.");
}

function drawNet() {
  const d = day(), N = net(d), hasPot = N.some((r) => r.pot != null);
  const cF = css("--c2"), cP = css("--c3"), cS = css("--thermal"), cC = css("--c4");
  const curMWh = d3.sum(N, (r) => r.cur || 0);
  const miss = N.filter((r) => r.fc != null && r.pot != null).map((r) => r.fc - r.pot);
  kpis("net-kpis", [
    [hasPot ? d3.format(",.1f")(curMWh / 1000) + " GWh" : "–", hasPot ? "wind and solar curtailed (potential − served)" : "curtailment shows when the 60-day data arrives"],
    [miss.length ? mw(d3.mean(miss), true) : "–", "true net-load forecast miss (forecast − potential), average"],
  ]);
  legend("net-legend", [[cF, "Forecast net load", "dash"], [cP, "Potential: had no wind or solar been curtailed"], [cS, "Served by thermal and batteries"], [cC, "Curtailed wind and solar", "area"]]);
  const series = [{ v: N.map((r) => r.fc), color: cF, dash: true }, { v: N.map((r) => r.srv), color: cS }];
  if (hasPot) series.splice(1, 0, { v: N.map((r) => r.pot), color: cP });
  hourChart($("net-chart"), series, hasPot ? [{ a: N.map((r) => r.pot), b: N.map((r) => r.srv), color: cC }] : null,
    (h) => { const r = N[h - 1]; return `<h4>${CX.dayLabel(S.day)}, HE ${h}</h4>` + tipRows([[cF, "Forecast", gw(r.fc), 1], [cP, "Potential", gw(r.pot)], [cS, "Served", gw(r.srv)], [cC, "Curtailed", r.cur == null ? "–" : mw(r.cur)], [null, "Forecast − potential", mw(sub(r.fc, r.pot), true)]]); },
    [["hour_ending", "net_load_forecast_mw", "net_load_potential_mw", "net_load_served_mw", "curtailed_mw"], N.map((r) => [r.h, r.fc, r.pot, r.srv, r.cur]), `Net load ${S.day}`]);
  $("net-note").textContent = "Net load is load less wind and solar. Forecast: the load forecast less ERCOT's wind and solar forecasts, all as of the day-ahead market. " +
    "Potential: actual load less what wind and solar could have produced (their HSL in the 60-day data). Served: actual load less what they did produce. " +
    "The gap between potential and served is curtailment; forecast against potential is the forecast's real miss. Comparing forecast with served would count curtailment as forecast error." +
    (hasPot ? "" : " This day is too recent for the 60-day data, so potential and curtailment are not shown yet.");
}

function windowDays() {
  const ds = S.P.dates.filter((d) => S.P.days[d].lam && S.P.days[d].fc && S.P.days[d].act);
  return S.win === "all" ? ds : ds.slice(-Number(S.win));
}
function barChart(el, rows, label, tip, csv, opt = {}) {
  const W = width(el), H = Math.round(Math.min(300, Math.max(220, W * 0.5)));
  const m = { l: 56, r: 10, t: 18, b: 40 }, { g, w, h, svg } = frame(el, W, H, m);
  const ok = rows.filter((r) => r.v != null);
  if (!ok.length) { el.innerHTML = `<p class="note">No hours in this period.</p>`; return; }
  const x = d3.scaleBand().domain(rows.map((r) => r.k)).range([0, w]).padding(0.25);
  const ext = d3.extent([0, ...ok.map((r) => r.v)]);
  const y = d3.scaleLinear().domain(ext).nice().range([h, 0]);
  g.append("g").attr("class", "gridline").call(d3.axisLeft(y).ticks(5).tickSize(-w).tickFormat(""));
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5).tickFormat(d3.format(",")).tickSizeOuter(0));
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`).call(d3.axisBottom(x).tickValues(rows.length > 12 && w < 500 ? rows.filter((r, i) => i % 3 === 0).map((r) => r.k) : rows.map((r) => r.k)).tickSizeOuter(0));
  g.append("line").attr("class", "zero").attr("x1", 0).attr("x2", w).attr("y1", y(0)).attr("y2", y(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 12).text(opt.ylab || "MW, + = forecast too high");
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", H - 4).text(label);
  const up = css("--c2"), dn = css("--c1");
  g.selectAll("rect.b").data(ok).join("rect").attr("class", "b").attr("x", (r) => x(r.k)).attr("width", x.bandwidth())
    .attr("y", (r) => y(Math.max(0, r.v))).attr("height", (r) => Math.abs(y(r.v) - y(0))).attr("rx", 2).attr("fill", (r) => opt.color || (r.v >= 0 ? up : dn))
    .on("pointermove", (ev, r) => showTip(ev, tip(r))).on("pointerleave", hideTip);
  setCSV(el, csv[0], csv[1], csv[2]);
}
function drawBias() {
  const ds = windowDays(), rows = [];
  ds.forEach((dd) => { const d = S.P.days[dd]; HOURS.forEach((h) => { const p = d.lam[h - 1], e = sub(d.fc[h - 1], d.act[h - 1]); if (p != null && e != null) rows.push({ h, p, e }); }); });
  const band = BANDS.map(([k, lo, hi]) => { const r = rows.filter((x) => x.p > lo && x.p <= hi); return { k: `${k} (${d3.format(",")(r.length)} h)`, v: r.length ? d3.mean(r, (x) => x.e) : null, n: r.length, hi: r.length ? d3.mean(r, (x) => (x.e > 0 ? 1 : 0)) : null, mae: r.length ? d3.mean(r, (x) => Math.abs(x.e)) : null }; });
  barChart($("bias-band"), band, "DA system lambda",
    (r) => `<h4>Lambda ${esc(r.k)}</h4>` + tipRows([[null, "Hours", d3.format(",")(r.n)], [null, "Average error", mw(r.v, true)], [null, "Average size of miss", mw(r.mae)], [null, "Hours forecast too high", d3.format(".0%")(r.hi)]]),
    [["da_lambda_band", "hours", "mean_error_mw", "mean_abs_error_mw", "share_forecast_high"], band.map((r) => [r.k, r.n, r.v, r.mae, r.hi]), `Load forecast bias by price ${S.win}`]);
  const cheap = rows.filter((x) => x.p <= CHEAP);
  const hr = HOURS.map((h) => { const r = cheap.filter((x) => x.h === h); return { k: h, v: r.length >= 3 ? d3.mean(r, (x) => x.e) : null, n: r.length }; });
  barChart($("bias-hour"), hr, "Hour ending (Central)",
    (r) => `<h4>HE ${r.k}, lambda at $${CHEAP} or less</h4>` + tipRows([[null, "Hours", d3.format(",")(r.n)], [null, "Average error", mw(r.v, true)]]),
    [["hour_ending", "cheap_hours", "mean_error_mw"], hr.map((r) => [r.k, r.n, r.v]), `Cheap-hour load forecast bias by hour ${S.win}`]);
  drawThermal(ds);
  $("bias-hour-h").textContent = `Hours with DA system lambda at $${CHEAP} or less: mean error by hour`;
  $("bias-note").textContent = `Each hour's load forecast error (forecast minus actual), grouped by that hour's day-ahead system lambda. Bars are the mean error in each group; orange means the forecast was too high. ${d3.format(",")(rows.length)} hours, ${CX.dayLabel(ds[0])} to ${CX.dayLabel(ds.at(-1))}.`;
}

// Extra thermal minimum output (LSL) online in cheap hours, by how far the load forecast missed,
// after adjusting for served net load: residual of a straight-line fit of LSL on net load.
const ERR_BINS = [["Low by 1 GW+", -Infinity, -1000], ["Low by 0–1 GW", -1000, 0], ["High by 0–1 GW", 0, 1000], ["High by 1–2 GW", 1000, 2000], ["High by 2 GW+", 2000, Infinity]];
function drawThermal(ds) {
  const rows = [];
  ds.forEach((dd) => {
    const d = S.P.days[dd];
    if (!d.thlsl || !d.wact || !d.sact) return;
    HOURS.forEach((h) => {
      const i = h - 1, p = d.lam[i], e = sub(d.fc[i], d.act[i]);
      if (p == null || p > CHEAP || e == null || d.thlsl[i] == null || d.wact[i] == null || d.sact[i] == null) return;
      rows.push({ e, y: d.thlsl[i], n: d.act[i] - d.wact[i] - d.sact[i] });
    });
  });
  let fit = null;
  if (rows.length >= 20) {
    const mn = d3.mean(rows, (q) => q.n), my = d3.mean(rows, (q) => q.y);
    const vx = d3.sum(rows, (q) => (q.n - mn) ** 2), b = vx ? d3.sum(rows, (q) => (q.n - mn) * (q.y - my)) / vx : 0;
    fit = { mn, my, b };
    rows.forEach((q) => { q.r = q.y - (my + b * (q.n - mn)); });
  }
  const bins = ERR_BINS.map(([k, lo, hi]) => { const r = fit ? rows.filter((q) => q.e > lo && q.e <= hi) : []; return { k, v: r.length >= 5 ? d3.mean(r, (q) => q.r) : null, n: r.length, y: r.length ? d3.mean(r, (q) => q.y) : null }; });
  barChart($("bias-thermal"), bins, "Load forecast against actual",
    (r) => `<h4>Forecast ${esc(r.k.toLowerCase())}</h4>` + tipRows([[null, "Cheap hours", d3.format(",")(r.n)], [null, "Extra minimum output online", mw(r.v, true)], [null, "Thermal minimum output online", mw(r.y)]]),
    [["load_forecast_error_bin", "cheap_hours", "thermal_lsl_online_mw", "extra_lsl_adjusted_for_net_load_mw"], bins.map((r) => [r.k, r.n, r.y, r.v]), `Extra thermal minimum output in cheap hours ${S.win}`],
    { ylab: "MW of minimum output online, adjusted for net load" });
  $("bias-thermal-note").textContent = fit
    ? `Thermal minimum output (LSL) online, compared with what the hour's net load would predict. ${d3.format(",")(rows.length)} hours with DA system lambda at $${CHEAP} or less.`
    : "Too few cheap hours with 60-day data in this period.";
}

function drawAll() { drawLoad(); drawNet(); drawBias(); }
function setDay(d) { S.day = d; drawLoad(); drawNet(); }
function bindSeg(id, key, fn) {
  const el = $(id);
  const sync = () => el.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === S[key])));
  el.addEventListener("click", (ev) => { const b = ev.target.closest("button"); if (!b) return; S[key] = b.dataset.v; sync(); fn(); });
  sync();
}

async function boot() {
  S.P = await tryJSON("data/load_page.json.gz");
  if (!S.P || !S.P.dates.length) { $("status").textContent = "No load data yet. It is built by the data update workflow."; return; }
  const dates = CX.fromStart(S.P.dates);
  const last = [...dates].reverse().find((d) => S.P.days[d].act) || dates.at(-1);
  $("status").textContent = `Load forecast and actual ${CX.dayLabel(dates[0])} to ${CX.dayLabel(dates.at(-1))} · potential net load through ${CX.dayLabel([...dates].reverse().find((d) => S.P.days[d].whsl) || dates[0])}`;
  S.picker = CX.dayPicker("lday", { days: dates, main: true, value: last, onChange: setDay });
  S.day = S.picker.get();
  bindSeg("c-win", "win", drawBias);
  drawAll();
  CX.init();
  let t, lastW = 0;
  new ResizeObserver((e) => { const w = Math.round(e[0].contentRect.width); if (w === lastW) return; lastW = w; clearTimeout(t); t = setTimeout(drawAll, 120); }).observe(document.querySelector("main"));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", drawAll);
}
boot();
})();

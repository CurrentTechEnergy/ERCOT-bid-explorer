/* Overview: who is expected to run on a day. Reads the forecast files written by the pipeline
   (data/forecast/<date>.json.gz, index.json.gz, scores.json.gz) and, for the day's reports once
   they exist, the 2-day generation summary, the 60-day day file and its per-unit hours. The page
   sums and takes shares; it computes no model. */
(() => {
"use strict";
const { getJSON, tryJSON, showTip, hideTip, setCSV, css, esc, axisFmt } = window.CX;
const $ = (id) => document.getElementById(id);
const HRS = d3.range(24);
const heLabel = (h) => `HE ${h + 1}`;
const fmtMW = d3.format(",.0f");
const fmtGW = (mw) => (mw == null ? "–" : d3.format(",.1f")(mw / 1000));
const fmtGWh = (gwh) => (gwh == null ? "–" : d3.format(",.0f")(gwh));
const fmtPrice = (v) => (v == null || isNaN(v) ? "–" : d3.format("$,.2f")(v));
const fmtPrice0 = (v) => (v == null || isNaN(v) ? "–" : d3.format("$,.0f")(v));
const fmtPct = d3.format(".0%");
const dayLabel = (d) => d3.timeFormat("%a %b %-d, %Y")(new Date(d + "T12:00:00"));

// ---- series: colours are fixed per group, technology and category -----------------------
const GROUP_COLORS = { never: "--g1", seasonal: "--g2", multiday: "--g3", daily1: "--g4", daily2: "--g5", daily3: "--g6", ungrouped: "--c-other" };
const GROUP_NOTES = {
  never: "has never turned off on price, plus nuclear", seasonal: "off for a week or more at a time", multiday: "shortest time off is 1 to 7 days",
  daily1: "turns off within a day, under once a week", daily2: "turns off within a day, 1 to 2 a week", daily3: "turns off within a day, over 2 a week",
  ungrouped: "no hourly history yet",
};
const GROUP_SHORT = { never: "Never off", seasonal: "Seasonal", multiday: "Multi-day", daily1: "Daily, under once a week", daily2: "Daily, 1 to 2 a week", daily3: "Daily, over 2 a week", ungrouped: "Not yet grouped" };
const TECHS = [
  ["nuclear", "Nuclear", "--c5"], ["coal", "Coal & lignite", "--c8"], ["combined_cycle", "Combined cycle", "--c1"],
  ["gas_steam", "Gas steam", "--c6"], ["combustion_turbine", "Combustion turbine", "--c2"],
];
const TECH_LABEL = Object.fromEntries(TECHS.map(([id, l]) => [id, l]));
const TECH_COLOR = Object.fromEntries(TECHS.map(([id, , c]) => [id, c]));
const CATS = [
  ["baseload", "Baseload", "--g1", "Units that never turn off on price, plus nuclear"],
  ["price_sensitive", "Price-sensitive", "--g4", "Units that turn off when staying on costs too much"],
  ["peakers", "Peakers", "--c2", "Combustion turbines outside the never-off group, from how often they ran at this price and hour"],
];
const WIND = { id: "wind", label: "Wind", color: "--c3" }, SOLAR = { id: "solar", label: "Solar", color: "--c4" };
const STORAGE = { id: "storage", label: "Batteries", color: "--c7" };
const BAND_LABEL = { low: "low", medium: "medium", high: "high" };
const BAND_COLOR = { low: "--c3", medium: "--c4", high: "--c8" };
// the 2-day generation summary's thermal total: non-IRR plus "remaining resources" (nuclear and
// the rest); before this date the summary folded storage into non-IRR, so storage is taken back
// out (the same rule pipeline/forecast/score.py applies)
const ESR_SPLIT_DATE = "2026-06-22";
const PAGE_ROWS = 150;

// ---------------------------------------------------------------- state ---
const S = {
  fc: null, index: null, scores: null, hubs: null, dalam: null,
  date: null, day: null, gen: null, day60: null, units60: null, prices: null,
  unit: "gw", hour: 12, unitView: "day", unitTech: "all", unitSearch: "", unitSort: { key: "hsl", dir: -1 }, unitShowAll: false,
  hidden: new Set(),
};

// ---------------------------------------------------------------- helpers ---
function emptyMsg(el, msg) { el.innerHTML = `<p class="empty">${msg}</p>`; }
function size(el) { return Math.max(280, el.clientWidth || el.parentElement.clientWidth || 600); }
function setSeg(id, value) { $(id).querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === value))); }
function bindSeg(id, key, after) {
  $(id).addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;
    S[key] = b.dataset.v; setSeg(id, S[key]); after(); saveView();
  });
}
const has = (k, d = S.date) => !!(S.index && (S.index.days[k] || []).includes(d));
// the day's score entry, if the day has been scored
const dayScore = () => (S.scores && S.scores.days && S.scores.days[S.date]) || null;
// the score summary for the model versions the index names
function trackRecord() {
  if (!S.scores || !S.scores.summary) return null;
  const key = Object.entries(S.fc.models || {}).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).sort().join(" ");
  return S.scores.summary[key] || S.scores.summary[Object.keys(S.scores.summary)[0]] || null;
}
// today's operating day in Central time, and whether the day-ahead market has posted (about 1:30 pm)
function centralDays() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date()).map((p) => [p.type, p.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const afterDam = +parts.hour * 60 + +parts.minute >= 13 * 60 + 30;
  const t = new Date(today + "T12:00:00"); t.setDate(t.getDate() + 1);
  return { today, tomorrow: t.toISOString().slice(0, 10), afterDam };
}
function defaultDate(days) {
  const { today, tomorrow, afterDam } = centralDays();
  if (afterDam && days.includes(tomorrow)) return tomorrow;
  if (days.includes(today)) return today;
  return days.at(-1);
}
// the day's price by hour: the day-ahead system lambda, from the forecast file when it carries
// it, else from the lambda file; the hub average only if neither is there
function dayPrice() {
  const H = S.day && S.day.headline;
  if (!H) return null;
  const dal = (S.dalam && S.dalam.days && S.dalam.days[S.date]) || null;
  const lam = H.lambda || dal;
  return lam ? { vals: lam, label: "Day-ahead system lambda", avg: H.lambda ? H.hub_avg : d3.mean(lam.filter((v) => v != null)) }
    : { vals: H.hub, label: "Day-ahead hub average", avg: H.hub_avg };
}
// which data leads the page for this day: the 60-day disclosure, the 2-day summary, or the forecast
function lead() { return S.a60 ? "60d" : genHourly() ? "2d" : "fc"; }
// the day's cheap stretch: the longest run of hours whose price is in the low band
function cheapStretch(hub, edges) {
  if (!hub || !edges) return null;
  let best = null, cur = null;
  hub.forEach((p, h) => {
    if (p != null && p <= edges[0]) { cur = cur ? { from: cur.from, to: h } : { from: h, to: h }; if (!best || cur.to - cur.from > best.to - best.from) best = cur; }
    else cur = null;
  });
  if (!best) return null;
  const ps = hub.slice(best.from, best.to + 1);
  return { ...best, min: d3.min(ps), max: d3.max(ps) };
}
// the 2-day generation summary's hourly thermal, wind, solar and storage (MW)
function genHourly() {
  const g = S.gen && S.gen.hourly;
  if (!g) return null;
  const v = (k) => (g[k] || []).map((x) => (x == null ? null : x));
  const thermal = HRS.map((h) => {
    const a = v("sum_base_point_non_irr")[h], b = v("sum_base_point_remaining_res")[h];
    if (a == null || b == null) return null;
    const esr = S.date < ESR_SPLIT_DATE ? v("sum_base_point_esr")[h] || 0 : 0;
    return a + b - esr;
  });
  return { thermal, wind: v("sum_base_point_wgr"), solar: v("sum_base_point_pvgr"),
    charging: v("sum_base_point_esr_charging"), discharging: v("sum_base_point_esr_discharging") };
}
// 60-day actual output by group and technology, hour by hour, from the per-unit hours and the
// forecast's unit list (sums only)
function actual60() {
  const f = S.units60;
  if (!f || !S.day) return null;
  const ci = Object.fromEntries(f.columns.map((c, i) => [c, i + 2]));
  const group = {}, tech = {};
  S.day.units.rows.forEach((r) => { group[r[0]] = r[2]; });
  const byG = {}, byT = {}, byC = {}, online = {};
  // a combined-cycle train is one resource per configuration in the 60-day data (NAME_CC1_2);
  // the forecast judges the train (NAME_CC1), as pipeline/forecast/score.py does
  const trainOf = (name, t) => (t === "combined_cycle" ? (name.match(/^(.*_CC\d+)_/) || [])[1] || name : name);
  // the forecast's categories (pipeline/forecast/build.py category): nuclear and the never-off
  // group are baseload, other combustion turbines are peakers, the rest is price-sensitive
  const catOf = (t, g) => (t === "nuclear" || g === "never" ? "baseload" : t === "combustion_turbine" ? "peakers" : "price_sensitive");
  const zero = () => HRS.map(() => 0);
  // batteries: discharging (positive) and charging (negative) summed separately so both show
  const dis = zero(), chg = zero();
  const onHour = {};
  f.rows.forEach((r) => {
    const [name0, , t] = f.units[r[0]], h = r[1] - 1, out = r[ci.output] || 0, name = trainOf(name0, t);
    if (h < 0 || h > 23) return;
    (byT[t] = byT[t] || zero())[h] += out;
    if (t === "storage") (out >= 0 ? dis : chg)[h] += out;
    const g = group[name];
    if (g) { (byG[g] = byG[g] || zero())[h] += out; (byC[catOf(t, g)] = byC[catOf(t, g)] || zero())[h] += out; }
    if ((r[ci.online_share] || 0) >= 0.5) (onHour[name] = onHour[name] || new Set()).add(h);
  });
  Object.entries(onHour).forEach(([name, hs]) => (online[name] = hs.size));
  return { group: byG, tech: byT, cat: byC, dis, chg, online, trainOf };
}

// ---------------------------------------------------------------- headline ---
function drawHeadline() {
  const D = S.day, H = D && D.headline;
  const el = $("lede");
  if (!D || !H || H.hub_avg == null) {
    el.innerHTML = `${esc(dayLabel(S.date))} has no day-ahead prices loaded yet.`;
    $("lede-sub").textContent = ""; $("expect").innerHTML = ""; $("track").textContent = ""; return;
  }
  const band = H.band, e = H.band_edges, P = dayPrice(), stretch = cheapStretch(P.vals, e);
  const cd = centralDays();
  const when = S.date === cd.today ? "Today" : S.date === cd.tomorrow ? "Tomorrow" : dayLabel(S.date);
  el.innerHTML = `${esc(when)} in ERCOT is <span class="lvl" style="background:var(${BAND_COLOR[band] || "--c-other"})">${esc(BAND_LABEL[band] || band || "?")}</span> priced.`;
  const place = band === "low" ? "in the bottom quarter of the last twelve months" : band === "high" ? "in the top quarter of the last twelve months" : "in the middle half of the last twelve months";
  const minH = d3.minIndex(P.vals.map((p) => (p == null ? Infinity : p)));
  const sc = dayScore(), td = sc && sc.two_day, L = lead(), a60 = S.a60;
  $("lede-sub").innerHTML = `${P.label} <b>${fmtPrice0(P.avg)}/MWh</b>, ${place} (bottom quarter under ${fmtPrice0(e[0])}, top quarter above ${fmtPrice0(e[1])}, ${H.band_window.n} days). `
    + (stretch ? `The cheapest stretch is hours ending ${stretch.from + 1} to ${stretch.to + 1} at ${fmtPrice0(stretch.min)} to ${fmtPrice0(stretch.max)}.`
      : `No hour is priced in the low band; the cheapest is hour ending ${minH + 1} at ${fmtPrice0(P.vals[minH])}.`)
    + (td && td.thermal_gwh_act != null ? ` Thermal and other ran <b>${fmtGWh(td.thermal_gwh_act)} GWh</b> over the day against ${fmtGWh(td.thermal_gwh_exp)} GWh expected (2-day summary).` : "");
  const tr = trackRecord();
  // each tile leads with what ran when the day has its data, and the forecast sits beneath
  const tiles = CATS.map(([k, label, color, note]) => {
    const c = H[k];
    if (!c) return "";
    const act = a60 && a60.cat[k] ? d3.sum(a60.cat[k]) / 1000 : null;
    return `<li><div class="k"><i class="sw" style="background:var(${color})"></i>${label}</div>` +
      (act != null
        ? `<div class="v">${fmtGWh(act)} GWh</div><div class="w"><b>${fmtGW(act / 24 * 1000)} GW</b> on average over the day (60-day disclosure)</div><div class="w">Forecast: ${fmtGWh(c.gwh)} GWh, ${fmtGW(c.exp)} GW of ${fmtGW(c.cap)} GW · ${c.n_on} of ${c.n_units} units on</div>`
        : `<div class="v">${c.share != null ? fmtPct(c.share) : "–"}</div><div class="w"><b>${fmtGW(c.exp)} GW</b> expected output of ${fmtGW(c.cap)} GW · ${c.n_on} of ${c.n_units} units on</div><div class="w"><b>${fmtGWh(c.gwh)} GWh</b> over the day</div>`) +
      `<div class="w2">${note}</div></li>`;
  });
  [WIND, SOLAR].forEach((s) => {
    const r = H[s.id], act = td ? td[`${s.id}_gwh_act`] : null;
    const head = `<li><div class="k"><i class="sw" style="background:var(${s.color})"></i>${s.label}</div>`;
    if (act != null) {
      tiles.push(head + `<div class="v">${fmtGWh(act)} GWh</div><div class="w"><b>${fmtGW(act / 24 * 1000)} GW</b> on average over the day (2-day summary)</div>` +
        (r ? `<div class="w">Forecast: ${fmtGWh(r.disp_gwh)} GWh dispatched of ${fmtGWh(r.avail_gwh)} GWh available, ${fmtGWh(r.curt_gwh)} GWh curtailed on price</div>` : `<div class="w">No ${s.label.toLowerCase()} forecast for this day</div>`) +
        `<div class="w2">${r ? `${r.n_units} units, ${fmtGW(r.nameplate)} GW nameplate` : ""}</div></li>`);
      return;
    }
    tiles.push(r ? head + `<div class="v">${r.avail ? fmtPct(r.disp / r.avail) : "–"}</div>` +
      `<div class="w"><b>${fmtGW(r.disp)} GW</b> dispatched of ${fmtGW(r.avail)} GW available, on average</div><div class="w"><b>${fmtGWh(r.disp_gwh)} of ${fmtGWh(r.avail_gwh)} GWh</b>, ${fmtGWh(r.curt_gwh)} GWh curtailed on price</div><div class="w2">Curtailed on price: offered above its own node's day-ahead price · ${r.n_units} units, ${fmtGW(r.nameplate)} GW nameplate</div></li>`
      : head + `<div class="v">–</div><div class="w">No ${s.label.toLowerCase()} forecast loaded for this day</div><div class="w2">ERCOT's forecast posting is fetched by the update run for the days ahead</div></li>`);
  });
  const gh = genHourly();
  const hs = H.storage, ghOk = gh && gh.discharging.some((v) => v != null);
  const fcNote = hs ? `The fleet's usual pattern over recent weeks, shaped by the day's prices${hs.capped ? " · held to the fleet's energy" : ""}` : "No battery forecast for this day: fewer than a week of 2-day battery actuals before it";
  const fcLine = hs ? `<div class="w">Forecast: <b>${fmtGWh(hs.gwh_dis)} GWh</b> discharged, <b>${fmtGWh(hs.gwh_chg)} GWh</b> charged; peaks ${fmtGW(hs.peak_dis)} and ${fmtGW(hs.peak_chg)} GW</div>` : `<div class="w">No battery forecast for this day</div>`;
  let st;
  if (a60) {
    const d = d3.sum(a60.dis) / 1000, c = -d3.sum(a60.chg) / 1000;
    st = `<div class="v">${fmtGW(d3.max(a60.dis))} GW</div><div class="w"><b>${fmtGW(d3.max(a60.dis))} GW</b> discharging at the peak hour, <b>${fmtGW(-d3.min(a60.chg))} GW</b> charging at most (60-day disclosure)</div><div class="w"><b>${fmtGWh(d)} GWh</b> discharged, <b>${fmtGWh(c)} GWh</b> charged over the day</div>` + fcLine;
  } else if (ghOk) {
    st = `<div class="v">${fmtGW(d3.max(gh.discharging))} GW</div><div class="w"><b>${fmtGW(d3.max(gh.discharging))} GW</b> discharging at the peak hour, <b>${fmtGW(-d3.min(gh.charging))} GW</b> charging at most (2-day summary)</div><div class="w"><b>${fmtGWh(d3.sum(gh.discharging) / 1000)} GWh</b> discharged, <b>${fmtGWh(-d3.sum(gh.charging) / 1000)} GWh</b> charged over the day</div>` + fcLine;
  } else if (hs) {
    st = `<div class="v">${fmtGW(hs.peak_dis)} GW</div><div class="w"><b>${fmtGW(hs.peak_dis)} GW</b> discharging at the peak hour, <b>${fmtGW(hs.peak_chg)} GW</b> charging at most</div><div class="w"><b>${fmtGWh(hs.gwh_dis)} GWh</b> discharged, <b>${fmtGWh(hs.gwh_chg)} GWh</b> charged over the day</div>`;
  } else st = `<div class="v">–</div><div class="w">Awaiting battery data</div>`;
  tiles.push(`<li><div class="k"><i class="sw" style="background:var(${STORAGE.color})"></i>${STORAGE.label}</div>${st}<div class="w2">${fcNote}</div></li>`);
  $("expect").innerHTML = tiles.join("");
  $("headline-note").textContent = `${S.date} · ${L === "60d" ? "60-day disclosure, forecast beneath" : L === "2d" ? "2-day summary, forecast beneath" : "forecast"}`;
  $("track").innerHTML = tr
    ? `<b>Track record</b>, last ${tr.n} days: unit on/off calls right ${fmtPct(tr.unit_hit)} of the time; thermal energy within ${fmtPct(S.scores.headline_tol)} of actual on ${fmtPct(tr.headline_hit)} of days. ` +
      `<details class="how"><summary>Full record</summary><p class="note">` + `Thermal energy over the day within ${fmtPct(S.scores.headline_tol)} of the 2-day summary on ${fmtPct(tr.headline_hit)} of ${tr.n_two_day} days; each unit's on or off call right on ${fmtPct(tr.unit_hit)} of ${d3.format(",")(tr.n_judged)} unit-days against the 60-day disclosure (${tr.n_sixty_day} days); thermal output off by ${fmtGW(tr.thermal_mae)} GW on average, wind by ${fmtGW(tr.wind_mae)} GW, solar by ${fmtGW(tr.solar_mae)} GW` +
      (tr.by_band && tr.by_band[band] ? `. On ${band} days: thermal within tolerance ${fmtPct(tr.by_band[band].headline_hit)} of ${tr.by_band[band].n_two_day} days, unit calls right ${fmtPct(tr.by_band[band].unit_hit)}.` : ".") +
      (tr.storage_dis_mae != null ? ` <b>Batteries</b> (${tr.n_storage} days): fleet discharging off by ${fmtGW(tr.storage_dis_mae)} GW an hour on average, charging by ${fmtGW(tr.storage_chg_mae)} GW${tr.storage_peak_bias != null ? `; the peak hour ${tr.storage_peak_bias < 0 ? "under" : "over"} by ${fmtGW(Math.abs(tr.storage_peak_bias))} GW` : ""}.` : "") +
      (tr.fit && tr.fit.lsl_mae_fit != null ? ` <b>2-day fit</b> (${tr.fit.version}, ${tr.fit.n_sixty_day} days): the committed minimum is off by ${fmtGW(tr.fit.lsl_mae_fc)} GW in the forecast and ${fmtGW(tr.fit.lsl_mae_fit)} GW after the fit; unit calls right ${fmtPct(tr.fit.unit_hit_fc)} and ${fmtPct(tr.fit.unit_hit_fit)}${tr.fit.config_hit != null ? `, combined-cycle configuration right ${fmtPct(tr.fit.config_hit)}` : ""}.` : "") +
      ` Models: ${esc(Object.entries(S.fc.models).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(", "))}.</p></details>`
    : "No scores yet.";
}

// ---- the small price and mix charts beside the headline -----------------------------------
function drawSpark() {
  const el = $("spark"), H = S.day && S.day.headline;
  if (!H || !dayPrice().vals) return emptyMsg(el, "No day-ahead prices for this day.");
  const w = size(el), Hh = 190, m = { t: 12, r: 12, b: 26, l: 48 };
  const lam = S.prices && S.prices.lambda ? S.prices.lambda.hourly_mean : null;
  const P = dayPrice(), da = P.vals;
  $("spark-title").textContent = lam ? "System lambda by hour ending ($/MWh): day-ahead solid, real-time dashed" : `${P.label} by hour ending ($/MWh)`;
  const e = H.band_edges || [0, 0];
  const vals = [...da, ...(lam || []), e[1] * 1.15].filter((v) => v != null);
  const x = d3.scaleLinear().domain([1, 24]).range([m.l, w - m.r]);
  const y = d3.scaleLinear().domain([Math.min(0, d3.min(vals)), d3.max(vals)]).nice().range([Hh - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${Hh}`);
  const bandRect = (y0, y1, col, label, ly) => {
    svg.append("rect").attr("x", m.l).attr("width", w - m.l - m.r).attr("y", y(y1)).attr("height", Math.max(0, y(y0) - y(y1))).attr("fill", css(col)).attr("opacity", 0.1);
    svg.append("text").attr("class", "bandlbl").attr("x", w - m.r - 6).attr("y", ly).attr("text-anchor", "end").attr("fill", css(col)).text(label);
  };
  bandRect(y.domain()[0], e[0], "--c3", `low · under ${fmtPrice0(e[0])}`, y(e[0]) + 13);
  bandRect(e[0], e[1], "--c4", "medium", y(e[1]) + 13);
  bandRect(e[1], y.domain()[1], "--c8", `high · over ${fmtPrice0(e[1])}`, m.t + 13);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y), 4, "$").tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${Hh - m.b})`).call(d3.axisBottom(x).tickValues([1, 6, 12, 18, 24]).tickFormat((d) => "HE" + d).tickSizeOuter(0));
  if (y.domain()[0] < 0) svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(0)).attr("y2", y(0));
  const line = d3.line().defined((v) => v != null).x((v, i) => x(i + 1)).y((v) => y(v));
  if (lam) svg.append("path").attr("fill", "none").attr("stroke", css("--ink")).attr("stroke-width", 1.5).attr("stroke-dasharray", "4 3").attr("opacity", 0.7).attr("d", line(lam));
  svg.append("path").attr("fill", "none").attr("stroke", css("--accent")).attr("stroke-width", 2).attr("d", line(da));
  const st = cheapStretch(da, e);
  if (st) svg.append("rect").attr("x", x(st.from + 1)).attr("width", x(st.to + 1) - x(st.from + 1)).attr("y", m.t).attr("height", Hh - m.t - m.b).attr("class", "price-band");
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", Hh - m.b).style("display", "none");
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", Hh - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const h = Math.max(0, Math.min(23, Math.round(x.invert(d3.pointer(ev)[0])) - 1));
      cross.style("display", null).attr("x1", x(h + 1)).attr("x2", x(h + 1));
      showTip(ev, `<h4>${heLabel(h)}</h4><table><tr><td>${P.label}</td><td class="n">${fmtPrice(da[h])}</td></tr>` +
        (lam ? `<tr><td>Real-time system lambda</td><td class="n">${fmtPrice(lam[h])}</td></tr>` : "") + `</table>`);
    }).on("pointerleave", () => { cross.style("display", "none"); hideTip(); })
    .on("click", (ev) => pickHour(Math.round(x.invert(d3.pointer(ev)[0])) - 1)).style("cursor", "pointer");
  el.replaceChildren(svg.node());
  setCSV(el, ["hour_ending", "da_lambda", "rt_lambda"], HRS.map((h) => [h + 1, da[h], lam ? lam[h] : null]), `Day-ahead price ${S.date}`);
  $("spark-note").textContent = `Bands are the low, middle and high quarters of the last twelve months' daily averages.` + (lam ? " The dashed line is the real-time system lambda, averaged by hour." : "");
}

function miniSeries() {
  const h = S.day && S.day.hourly;
  if (!h || !h.category) return null;
  const out = CATS.map(([k, label, color]) => ({ id: k, label, color, vals: h.category[k].exp }));
  [WIND, SOLAR].forEach((s) => { if (h[s.id]) out.push({ ...s, vals: h[s.id].disp }); });
  return out;
}
function drawMini() {
  const el = $("mini"), ser = miniSeries();
  if (!ser) { $("mini-legend").innerHTML = ""; return emptyMsg(el, "No forecast for this day."); }
  const w = size(el), Hh = 150, m = { t: 10, r: 12, b: 26, l: 48 };
  const x = d3.scaleLinear().domain([1, 24]).range([m.l, w - m.r]);
  const tops = HRS.map((i) => d3.sum(ser, (s) => s.vals[i] || 0));
  const y = d3.scaleLinear().domain([0, d3.max(tops)]).nice().range([Hh - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${Hh}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(3).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(3).tickFormat((v) => d3.format(",")(v / 1000)).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${Hh - m.b})`).call(d3.axisBottom(x).tickValues([1, 6, 12, 18, 24]).tickFormat((d) => "HE" + d).tickSizeOuter(0));
  const base = HRS.map(() => 0);
  ser.forEach((s) => {
    const top = s.vals.map((v, i) => base[i] + (v || 0));
    svg.append("path").attr("fill", css(s.color)).attr("stroke", css("--surface")).attr("stroke-width", 0.5)
      .attr("d", d3.area().x((d, i) => x(i + 1)).y0((d, i) => y(base[i])).y1((d, i) => y(top[i]))(HRS));
    HRS.forEach((i) => (base[i] = top[i]));
  });
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", Hh - m.b).style("display", "none");
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", Hh - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const h = Math.max(0, Math.min(23, Math.round(x.invert(d3.pointer(ev)[0])) - 1));
      cross.style("display", null).attr("x1", x(h + 1)).attr("x2", x(h + 1));
      showTip(ev, `<h4>${heLabel(h)} · expected</h4><table>` + ser.map((s) => `<tr><td><span class="sw" style="background:var(${s.color})"></span></td><td>${s.label}</td><td class="n">${fmtGW(s.vals[h])} GW</td></tr>`).join("") +
        `<tr><td></td><td>Total</td><td class="n">${fmtGW(tops[h])} GW</td></tr></table>`);
    }).on("pointerleave", () => { cross.style("display", "none"); hideTip(); })
    .on("click", (ev) => pickHour(Math.round(x.invert(d3.pointer(ev)[0])) - 1)).style("cursor", "pointer");
  el.replaceChildren(svg.node());
  $("mini-legend").innerHTML = ser.map((s) => `<span><span class="sw" style="background:var(${s.color})"></span>${s.label}</span>`).join("");
  setCSV(el, ["hour_ending", ...ser.map((s) => `${s.id}_mw`)], HRS.map((h) => [h + 1, ...ser.map((s) => s.vals[h])]), `Expected mix ${S.date}`);
}

// ---------------------------------------------------------------- who runs: bars ---
const CAP_KEYS = ["cap", "on", "off", "out", "unknown", "min", "exp", "gwh", "n_on", "n_off", "n_out", "n_unknown"];
const HATCH = "background:var(--track);background-image:repeating-linear-gradient(135deg,transparent 0 3px,var(--axis) 3px 4px)";
function barLegend(col) {
  return `<span><span class="sw" style="background:var(${col})"></span>Online, minimum output (LSL)</span><span><span class="sw" style="background:var(${col});opacity:0.45"></span>Online, up to maximum (HSL)</span>` +
    `<span><span class="sw sw-neg"></span>Expected output</span><span><span class="sw" style="background:var(--track)"></span>Expected off</span>` +
    `<span><span class="sw" style="${HATCH}"></span>On outage</span><span><span class="sw" style="background:var(--axis)"></span>Too few days to judge</span>` +
    `<span><span class="sw sw-act"></span>Actual (60-day)</span>`;
}
// one capacity bar: c is a capacity entry {cap,on,off,out,unknown,min,exp,gwh,n_*}; act is the
// actual GWh when the day has its 60-day answer
function barRow(name, note, color, c, why, act) {
  const gwh = S.unit === "gwh", k = gwh ? 24 / 1000 : 1 / 1000;      // MW -> GWh over the day, or GW
  const cap = c.cap || 0, w = (v) => (cap ? (v / cap) * 100 : 0);
  const exp = gwh ? c.gwh : c.exp / 1000, u = gwh ? "GWh" : "GW", f = d3.format(gwh ? ",.0f" : ",.1f");
  const expPct = cap ? ((gwh ? c.gwh / (cap * 24 / 1000) : c.exp / cap) * 100) : 0;
  const actPct = act != null && cap ? (act / (cap * 24 / 1000)) * 100 : null;
  const tip = `<h4>${esc(name)}</h4><p class="tip-body">${c.n_on} units expected on with output of ${f(exp)} ${u} (minimum ${f(c.min * k)} ${u}, maximum ${f(c.on * k)} ${u})` +
    (why ? ` [${esc(why)}]` : "") + `, ${f(c.off * k)} ${u} expected off (${c.n_off} units), ${f(c.out * k)} ${u} on outage (${c.n_out})` +
    (c.unknown ? `, ${f(c.unknown * k)} ${u} not yet judged (${c.n_unknown} units)` : "") +
    (act != null ? `. Actual over the day: ${fmtGWh(act)} GWh (${fmtGW(act / 24 * 1000)} GW on average)` : "") + `</p>`;
  return `<div class="lab"><span class="sw" style="background:var(${color})"></span><div>${esc(name)}<small>${esc(note)}</small></div></div>` +
    `<div class="bar" data-tip-html="${esc(tip)}">` +
    `<i style="left:0;width:${w(c.on)}%;background:var(${color});opacity:0.45"></i><i style="left:0;width:${w(c.min)}%;background:var(${color})"></i>` +
    (c.out ? `<i style="left:${w(c.on + c.off)}%;width:${w(c.out)}%;${HATCH}"></i>` : "") +
    (c.unknown ? `<i style="left:${w(c.on + c.off + c.out)}%;width:${w(c.unknown)}%;background:var(--axis)"></i>` : "") +
    `<i class="tick" style="left:calc(${expPct}% - 1.5px)"></i>` + (actPct != null ? `<i class="act" style="left:calc(${actPct}% - 1.5px)"></i>` : "") + `</div>` +
    `<div class="val"><b>${f(exp)} ${u}</b> expected<br>of ${f(cap * k)} ${u} max` + (act != null ? `<br>${gwh ? fmtGWh(act) : fmtGW(act / 24 * 1000)} ${u} actual` : "") + `</div>`;
}
function drawGroups() {
  const el = $("group-rows"), D = S.day;
  $("bar-legend").innerHTML = barLegend("--g3");
  if (!D) return emptyMsg(el, "No forecast for this day.");
  const sc = dayScore(), act = (g) => (sc && sc.sixty_day && sc.sixty_day.group[g] ? sc.sixty_day.group[g].act_gwh : null);
  let html = `<div class="sect">Thermal · ${S.unit === "gwh" ? "GWh over the day" : "GW"} · by how often it turns off on price</div>`;
  S.fc.groups.forEach((g) => {
    const c = D.capacity.group[g];
    if (!c || !c.cap) return;
    const n = c.n_on + c.n_off + c.n_out + c.n_unknown;
    html += barRow(GROUP_SHORT[g] || g, `${GROUP_NOTES[g] || S.fc.group_labels[g]} (${n} units)`, GROUP_COLORS[g] || "--c-other", c, null, act(g));
  });
  el.innerHTML = html;
  setCSV(el, ["group", ...CAP_KEYS, "actual_gwh"], S.fc.groups.filter((g) => D.capacity.group[g]).map((g) => [GROUP_SHORT[g] || g, ...CAP_KEYS.map((k) => D.capacity.group[g][k]), act(g)]), `Expected to run by group ${S.date}`);
}
// the reasons behind a technology's verdicts, counted from the units table
function techWhy(t) {
  const rows = S.day.units.rows.filter((r) => r[1] === t);
  const n = (v) => rows.filter((r) => r[5] === v).length;
  const parts = [];
  if (n("on")) parts.push(`${n("on")} likely on`);
  if (n("maybe")) parts.push(`${n("maybe")} toss-up`);
  if (n("off")) parts.push(`${n("off")} likely off`);
  if (n("peaker")) parts.push(`${n("peaker")} peakers, called hour by hour`);
  if (n("nocut")) parts.push(`${n("nocut")} with too few days to call`);
  if (n("outage")) parts.push(`${n("outage")} on outage`);
  return parts.join("; ");
}
function drawTechs() {
  const el = $("tech-rows"), D = S.day;
  $("tech-legend").innerHTML = barLegend("--c1") + `<span><span class="sw" style="background:var(--c3);opacity:0.45"></span>Available, curtailed on price</span><span><span class="sw" style="${HATCH}"></span>Not available from the weather</span>`;
  if (!D) return emptyMsg(el, "No forecast for this day.");
  const sc = dayScore(), act = (t) => (sc && sc.sixty_day && sc.sixty_day.tech[t] ? sc.sixty_day.tech[t].act_gwh : null);
  const gwh = S.unit === "gwh", u = gwh ? "GWh" : "GW";
  let html = `<div class="sect">Thermal · ${gwh ? "GWh over the day" : "GW"} · by technology</div>`;
  TECHS.forEach(([t, label, color]) => {
    const c = D.capacity.tech[t];
    if (!c || !c.cap) return;
    const n = c.n_on + c.n_off + c.n_out + c.n_unknown;
    html += barRow(label, `${n} units`, color, c, techWhy(t), act(t));
  });
  html += `<div class="sect">Wind and solar · full bar is nameplate</div>`;
  [WIND, SOLAR].forEach((s) => {
    const r = D.headline[s.id];
    if (!r) { html += `<div class="lab"><span class="sw" style="background:var(${s.color})"></span><div>${s.label}<small>no forecast loaded for this day</small></div></div><div class="bar"></div><div class="val">–</div>`; return; }
    const k = gwh ? 24 / 1000 : 1 / 1000, f = d3.format(gwh ? ",.0f" : ",.1f");
    const np = r.nameplate || 1, w = (v) => (v / np) * 100;
    const disp = gwh ? r.disp_gwh : r.disp / 1000, avail = gwh ? r.avail_gwh : r.avail / 1000, curt = gwh ? r.curt_gwh : (r.avail - r.disp) / 1000;
    const out = r.out || 0, outV = gwh ? (r.out_gwh || 0) : out / 1000;
    const a2 = sc && sc.two_day ? sc.two_day[`${s.id}_gwh_act`] : null;
    const tip = `<h4>${s.label}</h4><p class="tip-body">${f(disp)} ${u} expected dispatched of ${f(avail)} ${u} available${gwh ? "" : " on average"}, ${f(curt)} ${u} curtailed on price` + (r.out != null ? `, ${f(outV)} ${u} on outage (ERCOT's outage report)` : "") +
      `, ${f(Math.max(0, np * k - avail - outV))} ${u} not available from the weather · ${r.n_units} units` +
      (a2 != null ? `. Actual over the day (2-day summary): ${fmtGWh(a2)} GWh` : "") + `</p>`;
    html += `<div class="lab"><span class="sw" style="background:var(${s.color})"></span><div>${s.label}<small>${s.id === "wind" ? "the weather sets what is available; the offer sets what runs" : "same, over the daylight hours"}</small></div></div>` +
      `<div class="bar" data-tip-html="${esc(tip)}"><i style="left:0;width:${w(r.avail)}%;background:var(${s.color});opacity:0.45"></i><i style="left:0;width:${w(r.disp)}%;background:var(${s.color})"></i>` +
      (out ? `<i style="left:${w(r.avail)}%;width:${w(out)}%;${HATCH}"></i>` : "") +
      (a2 != null ? `<i class="act" style="left:calc(${(a2 / (np * 24 / 1000)) * 100}% - 1.5px)"></i>` : "") + `</div>` +
      `<div class="val"><b>${f(disp)} ${u}</b> expected<br>of ${f(avail)} ${u} available` + (a2 != null ? `<br>${gwh ? fmtGWh(a2) : fmtGW(a2 / 24 * 1000)} ${u} actual` : "") + `</div>`;
  });
  const csv = TECHS.filter(([t]) => D.capacity.tech[t]).map(([t, label]) => [label, ...CAP_KEYS.map((k) => D.capacity.tech[t][k]), act(t), null, null, null]);
  [WIND, SOLAR].forEach((s) => { const r = D.headline[s.id]; if (r) csv.push([s.label, r.nameplate, ...CAP_KEYS.slice(1).map(() => null), sc && sc.two_day ? sc.two_day[`${s.id}_gwh_act`] : null, r.avail_gwh, r.disp_gwh, r.curt_gwh, r.out_gwh]); });
  setCSV(el, ["technology", ...CAP_KEYS, "actual_gwh", "avail_gwh", "disp_gwh", "priced_out_gwh", "outage_gwh"], csv, `Expected to run by technology ${S.date}`);
  const hs = D.headline.storage;
  html += `<div class="sect">Storage</div><div class="lab"><span class="sw" style="background:var(${STORAGE.color})"></span><div>Batteries<small>${hs ? "the fleet's recent habit by hour, nudged by the day's price shape" : "no battery forecast for this day"}</small></div></div><div class="bar"></div>` +
    `<div class="val">${hs ? `<b>${fmtGWh(hs.gwh_dis)} GWh</b> discharged<br><b>${fmtGWh(hs.gwh_chg)} GWh</b> charged<br>peaks ${fmtGW(hs.peak_dis)} / ${fmtGW(hs.peak_chg)} GW` + (hs.out ? `<br>${fmtGW(hs.out)} GW on outage` : "") : "–"}</div>`;
  el.innerHTML = html;
}

// ---------------------------------------------------------------- expected generation by hour ---
function hourlySeries() {
  const h = S.day && S.day.hourly;
  if (!h) return null;
  const out = S.fc.groups.filter((g) => h.group[g]).map((g) => ({ id: g, label: GROUP_SHORT[g] || g, color: GROUP_COLORS[g] || "--c-other", vals: h.group[g].exp, kind: "thermal" }));
  [WIND, SOLAR].forEach((s) => { if (h[s.id]) out.push({ ...s, vals: h[s.id].disp, kind: "renew" }); });
  if (h.storage) out.push({ ...STORAGE, id: "storage_dis", label: "Batteries discharging", vals: h.storage.dis, kind: "storage" });
  return out;
}
// a line drawn over the bands: ink with a halo of the page background, so it reads on any band
function haloLine(svg, d, color, width, dash, opacity) {
  svg.append("path").attr("fill", "none").attr("stroke", css("--surface")).attr("stroke-width", width + 2.5).attr("opacity", 0.8).attr("d", d);
  svg.append("path").attr("fill", "none").attr("stroke", css(color)).attr("stroke-width", width).attr("stroke-dasharray", dash).attr("opacity", opacity == null ? 1 : opacity).attr("d", d);
}
// a stacked area chart by hour: `areas` stack upward from zero, `below` stack downward from zero
// (load, such as batteries charging), `lines` are drawn over them; legend buttons toggle any of
// them through S.hidden under the chart's own prefix
function areaChart({ el, legendEl, areas, below = [], lines = [], prefix, tipTitle, tipRows, csvName, csvExtra = [] }) {
  const key = (s) => `${prefix}:${s.id}`, shownOf = (xs) => xs.filter((s) => !S.hidden.has(key(s)));
  const btn = (s, line) => `<button type="button" data-id="${key(s)}" aria-pressed="${!S.hidden.has(key(s))}"><span class="sw${line ? " sw-line" : ""}" style="${line ? `border-color:var(${s.color});border-style:${s.dash ? (s.dash.startsWith("1 ") || s.dash.startsWith("2 ") ? "dotted" : "dashed") : "solid"}` : `background:var(${s.color})`}"></span>${s.label}</button>`;
  legendEl.innerHTML = areas.map((s) => btn(s)).join("") + below.map((s) => btn(s)).join("") + lines.map((l) => btn(l, true)).join("");
  const shown = shownOf(areas), shownBelow = shownOf(below), shownLines = shownOf(lines);
  const w = size(el), Hh = 340, m = { t: 16, r: 16, b: 30, l: 56 };
  const x = d3.scaleLinear().domain([1, 24]).range([m.l, w - m.r]);
  const tops = HRS.map((i) => d3.sum(shown, (s) => s.vals[i] || 0)), bottoms = HRS.map((i) => d3.sum(shownBelow, (s) => Math.min(0, s.vals[i] || 0)));
  const lineVals = shownLines.flatMap((l) => l.vals.filter((v) => v != null));
  const ymax = d3.max([...tops, ...lineVals]) || 1, ymin = Math.min(0, d3.min([...bottoms, ...lineVals]) || 0);
  const y = d3.scaleLinear().domain([ymin, ymax]).nice().range([Hh - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${Hh}`);
  const H = S.day.headline, P = dayPrice(), st = cheapStretch(P.vals, H.band_edges);
  if (st) {
    svg.append("rect").attr("class", "price-band").attr("x", x(st.from + 1)).attr("width", x(st.to + 1) - x(st.from + 1)).attr("y", m.t).attr("height", Hh - m.t - m.b);
    svg.append("text").attr("class", "axis-title").attr("x", (x(st.from + 1) + x(st.to + 1)) / 2).attr("y", m.t + 12).attr("text-anchor", "middle").text(`cheap stretch · ${fmtPrice0(st.min)} to ${fmtPrice0(st.max)}`);
  }
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(6).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(6).tickFormat((v) => d3.format(",")(v / 1000)).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${Hh - m.b})`).call(d3.axisBottom(x).tickValues([1, 4, 8, 12, 16, 20, 24]).tickFormat((d) => "HE" + d).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l - 44).attr("y", m.t - 4).text("GW");
  const stack = (series, sign) => {
    const base = HRS.map(() => 0);
    series.forEach((s) => {
      const top = s.vals.map((v, i) => base[i] + sign * Math.max(0, sign * (v || 0)));
      svg.append("path").attr("fill", css(s.color)).attr("stroke", css("--surface")).attr("stroke-width", 0.75)
        .attr("d", d3.area().x((d, i) => x(i + 1)).y0((d, i) => y(base[i])).y1((d, i) => y(top[i]))(HRS));
      HRS.forEach((i) => (base[i] = top[i]));
    });
  };
  stack(shown, 1); stack(shownBelow, -1);
  if (ymin < 0) svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(0)).attr("y2", y(0));
  const line = d3.line().defined((v) => v != null).x((v, i) => x(i + 1)).y((v) => y(v));
  shownLines.forEach((l) => haloLine(svg, line(l.vals), l.color, l.width || 2, l.dash, l.opacity));
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", Hh - m.b).style("display", "none");
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", Hh - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const h = Math.max(0, Math.min(23, Math.round(x.invert(d3.pointer(ev)[0])) - 1));
      cross.style("display", null).attr("x1", x(h + 1)).attr("x2", x(h + 1));
      showTip(ev, `<h4>${heLabel(h)} · ${tipTitle(h)}</h4><table>` +
        [...shown].reverse().map((s) => `<tr><td><span class="sw" style="background:var(${s.color})"></span></td><td>${s.label}</td><td class="n">${fmtGW(s.vals[h])} GW</td></tr>`).join("") +
        shownBelow.map((s) => `<tr><td><span class="sw" style="background:var(${s.color})"></span></td><td>${s.label}</td><td class="n">${fmtGW(s.vals[h])} GW</td></tr>`).join("") +
        (tipRows ? tipRows(h, shown) : "") +
        shownLines.map((l) => `<tr><td></td><td>${l.label.replace(/ \(.*\)/, "")}</td><td class="n">${fmtGW((l.own || l.vals)[h])} GW</td></tr>`).join("") + `</table>`);
    }).on("pointerleave", () => { cross.style("display", "none"); hideTip(); })
    .on("click", (ev) => pickHour(Math.round(x.invert(d3.pointer(ev)[0])) - 1)).style("cursor", "pointer");
  el.replaceChildren(svg.node());
  const all = [...areas, ...below];
  setCSV(el, ["hour_ending", "da_price", ...csvExtra.map((c) => c[0]), ...all.map((s) => `${s.id}_mw`), ...lines.map((l) => `${l.id}_mw`)],
    HRS.map((h) => [h + 1, P.vals[h], ...csvExtra.map((c) => c[1][h]), ...all.map((s) => s.vals[h]), ...lines.map((l) => (l.own || l.vals)[h])]), csvName);
}
// the forecast by hour, with the actuals drawn over it once they are in
function drawHourly() {
  const el = $("hourly-chart"), ser = hourlySeries();
  if (!ser) { $("hourly-legend").innerHTML = ""; return emptyMsg(el, "No forecast for this day."); }
  const gh = genHourly(), lines = [], below = [];
  const minLine = S.day.hourly.fleet.min;
  lines.push({ id: "min", label: "Committed thermal minimum (stays on at any price)", color: "--ink", vals: minLine, dash: "4 3", width: 1.5, opacity: 0.8 });
  if (gh) {
    // the actual lines are stacked the same way as the forecast (thermal, then wind on top, then
    // solar), so each line reads against the top of the matching band; all in ink, told apart by stroke
    const add = (a, b) => HRS.map((h) => (a[h] == null || b[h] == null ? null : a[h] + b[h]));
    const tw = add(gh.thermal, gh.wind);
    lines.push({ id: "act_thermal", label: "2-day actual: thermal and other", color: "--ink", vals: gh.thermal, dash: null, own: gh.thermal });
    lines.push({ id: "act_wind", label: "2-day actual: wind (stacked on thermal)", color: "--ink", vals: tw, dash: "6 3", own: gh.wind });
    lines.push({ id: "act_solar", label: "2-day actual: solar (stacked on wind)", color: "--ink", vals: add(tw, gh.solar), dash: "2 3", own: gh.solar });
  }
  // batteries charging is load, not supply: stacked below zero rather than on the supply
  if (S.day.hourly.storage) below.push({ ...STORAGE, id: "storage_chg", label: "Batteries charging (load)", vals: S.day.hourly.storage.chg });
  if (gh && gh.charging.some((v) => v != null)) lines.push({ id: "act_chg", label: "2-day actual: batteries charging", color: STORAGE.color, vals: gh.charging, dash: "6 3" });
  // the 2-day fit's committed minimum: the online LSL of the units the fit says were on, two days after
  // the day (pipeline/models/two_day_fit); drawn as a line like the forecast's minimum
  const fitLsl = S.fit && S.fit.hourly && S.fit.hourly.lsl_fit;
  if (fitLsl) lines.push({ id: "fit_lsl", label: "2-day fit: committed minimum", color: "--c-other", vals: fitLsl, dash: "2 3" });
  areaChart({ el, legendEl: $("hourly-legend"), areas: ser, below, lines, prefix: "fc", csvName: `Expected generation ${S.date}`,
    tipTitle: (h) => `${dayPrice().label.replace("Day-ahead ", "")} ${fmtPrice(dayPrice().vals[h])}`,
    tipRows: (h, shown) => `<tr><td></td><td>Thermal expected</td><td class="n">${fmtGW(d3.sum(shown.filter((s) => s.kind === "thermal"), (s) => s.vals[h] || 0))} GW</td></tr>` });
  $("hourly-note").textContent = `${S.date} · GW · ${S.day.hourly.model.fleet ? "models " + S.day.hourly.model.fleet : ""}`;
}
// what ran by hour, from ERCOT's data: the 60-day disclosure by group when it is in, else the
// 2-day summary's thermal, wind, solar and batteries; the forecast's total drawn over it
function actualSeries() {
  const L = lead(), a60 = S.a60, gh = genHourly();
  if (L === "fc") return null;
  const areas = [], below = [], lines = [];
  if (L === "60d") {
    S.fc.groups.filter((g) => a60.group[g]).forEach((g) => areas.push({ id: g, label: GROUP_SHORT[g] || g, color: GROUP_COLORS[g] || "--c-other", vals: a60.group[g], kind: "thermal" }));
    ["hydro", "other"].forEach((t) => { if (a60.tech[t]) areas.push({ id: t, label: t === "hydro" ? "Hydro" : "Other", color: "--c-other", vals: a60.tech[t], kind: "thermal" }); });
    [WIND, SOLAR].forEach((s) => { if (a60.tech[s.id]) areas.push({ ...s, vals: a60.tech[s.id], kind: "renew" }); });
    if (a60.tech.storage) { areas.push({ ...STORAGE, id: "storage_dis", label: "Batteries discharging", vals: a60.dis, kind: "storage" }); below.push({ ...STORAGE, id: "storage_chg", label: "Batteries charging (load)", vals: a60.chg }); }
  } else {
    areas.push({ id: "thermal", label: "Thermal and other", color: "--g3", vals: gh.thermal, kind: "thermal" });
    areas.push({ ...WIND, vals: gh.wind, kind: "renew" }); areas.push({ ...SOLAR, vals: gh.solar, kind: "renew" });
    if (gh.discharging.some((v) => v != null)) { areas.push({ ...STORAGE, id: "storage_dis", label: "Batteries discharging", vals: gh.discharging, kind: "storage" }); below.push({ ...STORAGE, id: "storage_chg", label: "Batteries charging (load)", vals: gh.charging }); }
  }
  const fc = hourlySeries();
  if (fc) {
    const total = HRS.map((h) => d3.sum(fc, (s) => s.vals[h] || 0));
    lines.push({ id: "fc_total", label: "Forecast: total supply", color: "--ink", vals: total, dash: "6 3" });
    const th = HRS.map((h) => d3.sum(fc.filter((s) => s.kind === "thermal"), (s) => s.vals[h] || 0));
    lines.push({ id: "fc_thermal", label: "Forecast: thermal", color: "--ink", vals: th, dash: null, width: 1.5 });
    lines.push({ id: "fc_min", label: "Forecast: committed minimum", color: "--ink", vals: S.day.hourly.fleet.min, dash: "2 3", width: 1.5, opacity: 0.8 });
  }
  return { areas, below, lines, L };
}
function drawActual() {
  const panel = $("actual-panel"), el = $("actual-chart"), A = actualSeries();
  panel.hidden = !A;
  if (!A) return;
  areaChart({ el, legendEl: $("actual-legend"), areas: A.areas, below: A.below, lines: A.lines, prefix: "act", csvName: `What ran ${S.date}`,
    tipTitle: (h) => `${dayPrice().label.replace("Day-ahead ", "")} ${fmtPrice(dayPrice().vals[h])}`,
    tipRows: (h, shown) => `<tr><td></td><td>Total supply</td><td class="n">${fmtGW(d3.sum(shown, (s) => s.vals[h] || 0))} GW</td></tr>` });
  $("actual-note").textContent = `${S.date} · GW · ${A.L === "60d" ? "60-day disclosure" : "2-day summary"}`;
  $("actual-sub").textContent = A.L === "60d"
    ? "Each unit's output from the 60-day disclosure, summed by the forecast's groups. Batteries are drawn on top while discharging and below zero while charging. The dashed line is the forecast's total supply, the solid line its thermal, the dotted line its committed minimum."
    : "ERCOT's 2-day generation summary: thermal in total, wind, solar and batteries. Batteries are drawn on top while discharging and below zero while charging. The dashed line is the forecast's total supply, the solid line its thermal, the dotted line its committed minimum.";
}
// what ran over the day, as bars: the bar is the actual, the tick the forecast
function actRow(name, note, color, cap, act, fc, tip) {
  const gwh = S.unit === "gwh", f = d3.format(gwh ? ",.0f" : ",.1f"), u = gwh ? "GWh" : "GW";
  const v = (x) => (x == null ? null : gwh ? x : x / 24 * 1000 / 1000);   // GWh over the day -> GW on average
  const capG = cap ? cap * 24 / 1000 : Math.max(act || 0, fc || 0) * 1.25 || 1;   // full bar: capacity over the day, else a little above the larger
  const pct = (x) => (x == null ? null : Math.min(100, (x / capG) * 100));
  return `<div class="lab"><span class="sw" style="background:var(${color})"></span><div>${esc(name)}<small>${esc(note)}</small></div></div>` +
    `<div class="bar" data-tip-html="${esc(`<h4>${esc(name)}</h4><p class="tip-body">${tip}</p>`)}">` +
    (act != null ? `<i style="left:0;width:${pct(act)}%;background:var(${color})"></i>` : "") +
    (fc != null ? `<i class="fc" style="left:calc(${pct(fc)}% - 1.5px)"></i>` : "") + `</div>` +
    `<div class="val"><b>${act != null ? f(v(act)) + " " + u : "–"}</b> ran` + (fc != null ? `<br>${f(v(fc))} ${u} expected` : "") + (cap ? `<br>of ${f(gwh ? capG : cap / 1000)} ${u} max` : "") + `</div>`;
}
function drawActualBars() {
  const panel = $("actual-bars-panel"), el = $("actual-rows"), L = lead(), D = S.day, sc = dayScore();
  panel.hidden = L === "fc";
  if (L === "fc") return;
  const gwh = S.unit === "gwh", unit = gwh ? "GWh over the day" : "GW on average";
  $("actual-bar-legend").innerHTML = `<span><span class="sw" style="background:var(--g3)"></span>What ran</span><span><span class="sw sw-fc"></span>Forecast</span>`;
  const H = D.headline, td = sc && sc.two_day, sd = sc && sc.sixty_day, csv = [];
  const gwhOf = (mw) => d3.sum(mw) / 1000;
  let html = "";
  const push = (sect, name, note, color, cap, act, fc, tipExtra = "") => {
    const tip = `${act != null ? `${fmtGWh(act)} GWh ran (${fmtGW(act / 24 * 1000)} GW on average)` : "no data"}${fc != null ? `; the forecast expected ${fmtGWh(fc)} GWh (${fmtGW(fc / 24 * 1000)} GW)` : ""}${cap ? `; ${fmtGW(cap)} GW capacity` : ""}${tipExtra}`;
    html += actRow(name, note, color, cap, act, fc, tip); csv.push([sect, name, cap, act, fc]);
  };
  if (L === "60d") {
    const a60 = S.a60;
    html += `<div class="sect">Thermal · ${unit} · by how often it turns off on price (60-day disclosure)</div>`;
    S.fc.groups.forEach((g) => {
      const c = D.capacity.group[g]; if (!c || !c.cap) return;
      const act = sd && sd.group[g] ? sd.group[g].act_gwh : a60.group[g] ? gwhOf(a60.group[g]) : null;
      push("group", GROUP_SHORT[g] || g, `${GROUP_NOTES[g] || S.fc.group_labels[g]}`, GROUP_COLORS[g] || "--c-other", c.cap, act, c.gwh);
    });
    html += `<div class="sect">Thermal · ${unit} · by technology</div>`;
    TECHS.forEach(([t, label, color]) => {
      const c = D.capacity.tech[t]; if (!c || !c.cap) return;
      const act = sd && sd.tech[t] ? sd.tech[t].act_gwh : a60.tech[t] ? gwhOf(a60.tech[t]) : null;
      push("tech", label, "", color, c.cap, act, c.gwh);
    });
  } else {
    html += `<div class="sect">Thermal · ${unit} (2-day summary, reported in total)</div>`;
    const cap = d3.sum(S.fc.groups, (g) => (D.capacity.group[g] ? D.capacity.group[g].cap : 0)), fcG = d3.sum(S.fc.groups, (g) => (D.capacity.group[g] ? D.capacity.group[g].gwh : 0));
    push("thermal", "Thermal and other", "non-IRR plus remaining resources; the forecast's thermal fleet", "--g3", cap, td ? td.thermal_gwh_act : gwhOf(genHourly().thermal), fcG, "; by-group output arrives with the 60-day disclosure");
  }
  html += `<div class="sect">Wind and solar · ${unit} · full bar is nameplate (2-day summary)</div>`;
  const gh = genHourly();
  [WIND, SOLAR].forEach((s) => {
    const r = H[s.id], act = td ? td[`${s.id}_gwh_act`] : gh ? gwhOf(gh[s.id]) : null;
    push(s.id, s.label, r ? `${fmtGWh(r.avail_gwh)} GWh was available from the weather` : "no forecast for this day", s.color, r ? r.nameplate : null, act, r ? r.disp_gwh : null);
  });
  const hs = H.storage, a60 = S.a60;
  const dis = a60 ? gwhOf(a60.dis) : gh && gh.discharging.some((v) => v != null) ? gwhOf(gh.discharging) : null;
  const chg = a60 ? -gwhOf(a60.chg) : gh && gh.charging.some((v) => v != null) ? -gwhOf(gh.charging) : null;
  if (dis != null) {
    html += `<div class="sect">Batteries · ${unit} (${a60 ? "60-day disclosure" : "2-day summary"})</div>`;
    push("storage", "Discharged", "supply", STORAGE.color, null, dis, hs ? hs.gwh_dis : null);
    push("storage", "Charged", "load", STORAGE.color, null, chg, hs ? hs.gwh_chg : null);
  }
  el.innerHTML = html;
  $("actual-bars-note").textContent = `${S.date} · ${L === "60d" ? "60-day disclosure" : "2-day summary"}`;
  setCSV(el, ["section", "name", "cap_mw", "actual_gwh", "forecast_gwh"], csv, `What ran ${S.date}`);
}
// the 2-day fit's committed set by group and technology against the forecast's
// (pipeline/models/two_day_fit): MW of minimum and maximum output of the units each says were on
function drawFit() {
  const panel = $("fit-panel"), el = $("fit-rows"), F = S.fit, D = S.day;
  panel.hidden = !F || !D;
  if (panel.hidden) return;
  $("fit-legend").innerHTML = `<span><span class="sw" style="background:var(--g3)"></span>Fitted on, minimum output (LSL)</span><span><span class="sw" style="background:var(--g3);opacity:0.45"></span>Fitted on, up to maximum (HSL)</span><span><span class="sw sw-fc"></span>Forecast's maximum on</span>`;
  const csv = [];
  const row = (sect, name, note, color, cap, e) => {
    if (!e || !cap) return "";
    const w = (v) => Math.min(100, (v / cap) * 100), flips = [];
    if (e.n_on_added) flips.push(`${e.n_on_added} switched on`);
    if (e.n_off_added) flips.push(`${e.n_off_added} switched off`);
    if (e.n_reconfigured) flips.push(`${e.n_reconfigured} reconfigured`);
    const tip = `<h4>${esc(name)}</h4><p class="tip-body">The fit has ${e.n_fit} of ${e.n} units on: ${fmtGW(e.lsl_fit)} GW minimum, ${fmtGW(e.hsl_fit)} GW maximum. The forecast had ${e.n_fc} on: ${fmtGW(e.lsl_fc)} GW minimum, ${fmtGW(e.hsl_fc)} GW maximum${flips.length ? ". " + flips.join(", ") : ""}.</p>`;
    csv.push([sect, name, cap, e.n, e.n_fc, e.lsl_fc, e.hsl_fc, e.n_fit, e.lsl_fit, e.hsl_fit, e.n_on_added, e.n_off_added, e.n_reconfigured]);
    return `<div class="lab"><span class="sw" style="background:var(${color})"></span><div>${esc(name)}<small>${esc(note)}</small></div></div>` +
      `<div class="bar" data-tip-html="${esc(tip)}"><i style="left:0;width:${w(e.hsl_fit)}%;background:var(${color});opacity:0.45"></i><i style="left:0;width:${w(e.lsl_fit)}%;background:var(${color})"></i><i class="fc" style="left:calc(${w(e.hsl_fc)}% - 1.5px)"></i></div>` +
      `<div class="val"><b>${fmtGW(e.hsl_fit)} GW</b> on in the fit (${e.n_fit} units)<br>${fmtGW(e.hsl_fc)} GW in the forecast (${e.n_fc})${flips.length ? `<br>${flips.join(", ")}` : ""}</div>`;
  };
  let html = `<div class="sect">Thermal · GW · by how often it turns off on price</div>`;
  S.fc.groups.forEach((g) => { const c = D.capacity.group[g]; if (c) html += row("group", GROUP_SHORT[g] || g, GROUP_NOTES[g] || S.fc.group_labels[g] || "", GROUP_COLORS[g] || "--c-other", c.cap, F.groups[g]); });
  html += `<div class="sect">Thermal · GW · by technology (nuclear is fixed on; peakers are fitted by the hour)</div>`;
  TECHS.forEach(([t, label, color]) => { const c = D.capacity.tech[t]; if (c) html += row("tech", label, "", color, c.cap, F.tech[t]); });
  el.innerHTML = html;
  const I = F.inputs || {}, fleet = (k) => d3.sum(Object.values(F.groups), (e) => e[k] || 0);
  $("fit-note").textContent = `${S.date} · fit ${F.version || ""} · ${fmtGW(fleet("hsl_fit"))} GW on against ${fmtGW(fleet("hsl_fc"))} GW in the forecast${I.n_changed != null ? ` · ${I.n_changed} of ${I.n_candidates} candidate units changed` : ""}`;
  setCSV(el, ["section", "name", "cap_mw", "n_units", "n_on_forecast", "lsl_forecast_mw", "hsl_forecast_mw", "n_on_fit", "lsl_fit_mw", "hsl_fit_mw", "n_switched_on", "n_switched_off", "n_reconfigured"], csv, `2-day fit ${S.date}`);
}
// the estimates heading sits over the forecast panels once the day has its data
function drawEstimates() {
  const L = lead();
  $("estimates-head").hidden = L === "fc";
  if (L !== "fc") $("estimates-note").textContent = `The forecast made the day before, kept below ERCOT's ${L === "60d" ? "60-day disclosure" : "2-day summary"} for comparison. Ticks and lines on the estimates mark what actually ran.`;
}

// ---------------------------------------------------------------- how the day went ---
function drawScore() {
  const sc = dayScore(), el = $("score-table"), panel = $("score-panel");
  panel.hidden = !sc || (!sc.two_day && !sc.sixty_day && !sc.fit);
  if (panel.hidden) return;
  const rows = [], csv = [];
  const row = (what, exp, act, extra = "") => {
    const err = exp != null && act ? (exp - act) / act : null;
    rows.push(`<tr><td class="t">${what}</td><td>${exp == null ? "–" : fmtGWh(exp)}</td><td>${act == null ? "–" : fmtGWh(act)}</td><td>${err == null ? "–" : (err > 0 ? "+" : "") + d3.format(".0%")(err)}</td><td class="t">${extra}</td></tr>`);
    csv.push([what, exp, act, err]);
  };
  const td = sc.two_day;
  if (td) {
    row("Thermal and other, 2-day summary", td.thermal_gwh_exp, td.thermal_gwh_act, td.headline_hit ? "within tolerance" : "outside tolerance");
    const H = S.day && S.day.headline;
    row("Wind, 2-day summary", H && H.wind ? H.wind.disp_gwh : null, td.wind_gwh_act);
    row("Solar, 2-day summary", H && H.solar ? H.solar.disp_gwh : null, td.solar_gwh_act);
    if (td.storage_dis_gwh_act != null) {
      row("Batteries discharging, 2-day summary", td.storage_dis_gwh_exp, td.storage_dis_gwh_act, td.storage_dis_mae != null ? `off by ${fmtGW(td.storage_dis_mae)} GW per hour on average; peak hour ${td.storage_dis_peak_err >= 0 ? "+" : ""}${fmtGW(td.storage_dis_peak_err)} GW` : "");
      row("Batteries charging, 2-day summary", td.storage_chg_gwh_exp, td.storage_chg_gwh_act, td.storage_chg_mae != null ? `off by ${fmtGW(td.storage_chg_mae)} GW per hour on average` : "");
    }
  }
  const fs = sc.fit;
  if (fs && fs.lsl_act_gwh != null) {
    row("Committed minimum (online LSL), forecast", fs.lsl_fc_gwh, fs.lsl_act_gwh, `off by ${fmtGW(fs.lsl_mae_fc)} GW per hour on average; unit calls right ${fmtPct(fs.unit_hit_fc)} of ${fs.n_judged}`);
    row("Committed minimum (online LSL), 2-day fit", fs.lsl_fit_gwh, fs.lsl_act_gwh, `off by ${fmtGW(fs.lsl_mae_fit)} GW; unit calls right ${fmtPct(fs.unit_hit_fit)}${fs.config_hit != null ? `; combined-cycle configuration right ${fmtPct(fs.config_hit)} of ${fs.n_config}` : ""}`);
  }
  const sd = sc.sixty_day;
  if (sd) {
    row("Thermal fleet, 60-day disclosure", sd.fleet.exp_gwh, sd.fleet.act_gwh, `unit on/off calls right ${fmtPct(sd.unit_hit)} of ${sd.n_judged}; peakers online ${fmtPct(sd.peaker_online_share)} of unit-hours against ${fmtPct(sd.peaker_p_on)} expected`);
    S.fc.groups.forEach((g) => { if (sd.group[g]) row(`· ${GROUP_SHORT[g] || g}`, sd.group[g].exp_gwh, sd.group[g].act_gwh); });
    TECHS.forEach(([t, label]) => { if (sd.tech[t]) row(`· ${label}`, sd.tech[t].exp_gwh, sd.tech[t].act_gwh); });
  }
  el.innerHTML = `<table class="data"><thead><tr><th class="t">Energy over the day</th><th>Forecast (GWh)</th><th>Actual (GWh)</th><th>Error</th><th class="t"></th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
  $("score-note").textContent = `${S.date} · ${sc.band} day · scored against ${[td && "the 2-day summary", sd && "the 60-day disclosure"].filter(Boolean).join(" and ")}${fs ? " · 2-day fit " + (fs.version || "") : ""}`;
  setCSV(el, ["what", "forecast_gwh", "actual_gwh", "error"], csv, `Score ${S.date}`);
}

// ---------------------------------------------------------------- drill-down: mix ---
function mixRows(h) {
  const D = S.day;
  if (!D) return null;
  const a60 = S.a60, gh = genHourly();
  const rows = TECHS.map(([t, label, color]) => ({ id: t, label, color, mw: D.hourly.tech[t] ? D.hourly.tech[t].exp[h] : 0, act: a60 && a60.tech[t] ? a60.tech[t][h] : null }));
  // the 2-day summary reports thermal in total, so on a 2-day day the total row carries the actual
  // and the technology rows beneath it are the forecast's split (not counted twice in the totals)
  if (!a60 && gh && gh.thermal[h] != null) {
    rows.forEach((r) => { r.sub = true; r.label = `· ${r.label}`; });
    rows.unshift({ id: "thermal", label: "Thermal and other", color: "--g3", mw: d3.sum(rows, (r) => r.mw || 0), act: gh.thermal[h] });
  }
  [WIND, SOLAR].forEach((s) => rows.push({ ...s, mw: D.hourly[s.id] ? D.hourly[s.id].disp[h] : null, act: a60 && a60.tech[s.id] ? a60.tech[s.id][h] : gh ? gh[s.id][h] : null }));
  // batteries, net: forecast discharging less charging in the hour; the actual from the 60-day
  // units or the 2-day summary the same way
  const hs = D.hourly.storage, stFc = hs ? (hs.dis[h] || 0) + (hs.chg[h] || 0) : null;
  const stAct = a60 && a60.tech.storage ? a60.tech.storage[h] : gh && gh.discharging[h] != null ? gh.discharging[h] + gh.charging[h] : null;
  if (stFc != null || stAct != null) rows.push({ id: "storage", label: "Batteries, net", color: "--c7", mw: stFc, act: stAct, legs: hs ? { dis: hs.dis[h], chg: hs.chg[h] } : null });
  if (a60) ["hydro", "other"].forEach((t) => { if (a60.tech[t]) rows.push({ id: t, label: t === "hydro" ? "Hydro" : "Other", color: "--c-other", mw: null, act: a60.tech[t][h] }); });
  return rows;
}
function drawMix() {
  const el = $("mix-chart"), tel = $("mix-table"), h = S.hour;
  $("mix-title-note").textContent = S.date ? `${S.date} · ${heLabel(h)}` : "";
  let rows = mixRows(h);
  if (!rows) { tel.innerHTML = ""; return emptyMsg(el, "No forecast for this day."); }
  const main = rows.filter((r) => !r.sub);
  const total = d3.sum(main, (r) => Math.max(0, r.mw || 0)), totalAct = main.some((r) => r.act != null) ? d3.sum(main, (r) => Math.max(0, r.act || 0)) : null;
  rows.forEach((r) => { r.share = r.mw != null && total > 0 ? r.mw / total : null; r.actShare = r.act != null && totalAct > 0 && r.act > 0 ? r.act / totalAct : null; });
  // once the day has its data the bar is what ran and the tick is the forecast; before that the
  // bar is the forecast. Forecast-only rows (the technology split under a 2-day thermal total) keep
  // the forecast as their bar
  const actLead = lead() !== "fc";
  const barOf = (r) => (actLead && !r.sub ? r.act : r.mw), tickOf = (r) => (actLead && !r.sub ? r.mw : r.act);
  // sort the main rows by their bar; a technology split stays under its total, sorted the same way
  const rank = (r) => (barOf(r) ?? tickOf(r) ?? 0), subs = rows.filter((r) => r.sub).sort((a, b) => rank(b) - rank(a));
  rows = main.sort((a, b) => rank(b) - rank(a)).flatMap((r) => (r.id === "thermal" ? [r, ...subs] : [r]));
  const w = size(el), narrow = w < 560, bh = 22, lab = narrow ? 18 : 0, gap = 8 + lab, m = { t: 8 + lab, r: narrow ? 120 : 170, b: 26, l: narrow ? 8 : 180 };
  const Hh = m.t + m.b + rows.length * (bh + gap) - gap;
  const x = d3.scaleLinear().domain([Math.min(0, d3.min(rows, (r) => Math.min(r.mw ?? 0, r.act ?? 0))), Math.max(1, d3.max(rows, (r) => Math.max(r.mw ?? 0, r.act ?? 0)))]).nice().range([m.l, w - m.r]);
  const y = d3.scaleBand().domain(rows.map((r) => r.id)).range([m.t, Hh - m.b]).paddingInner(gap / (bh + gap));
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${Hh}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(0,${Hh - m.b})`).call(d3.axisBottom(x).ticks(narrow ? 3 : 6).tickSize(-(Hh - m.t - m.b)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${Hh - m.b})`).call(d3.axisBottom(x).ticks(narrow ? 3 : 6).tickFormat((v) => d3.format(",")(v / 1000) + " GW").tickSizeOuter(0));
  rows.forEach((r) => {
    const y0 = y(r.id), g = svg.append("g");
    const bar = barOf(r), tick = tickOf(r);
    if (bar != null && Math.abs(x(bar) - x(0)) > 0.5) g.append("rect").attr("x", Math.min(x(0), x(bar))).attr("y", y0).attr("width", Math.abs(x(bar) - x(0))).attr("height", bh).attr("fill", css(r.color)).attr("rx", 3);
    if (tick != null) g.append("line").attr("x1", x(tick)).attr("x2", x(tick)).attr("y1", y0 - 3).attr("y2", y0 + bh + 3).attr("stroke", css("--ink")).attr("stroke-width", 3);
    g.append("text").attr("class", "mix-label").attr("x", narrow ? m.l : m.l - 10).attr("y", narrow ? y0 - 5 : y0 + bh / 2).attr("dy", narrow ? 0 : "0.35em").attr("text-anchor", narrow ? "start" : "end").text(r.label);
    const val = actLead && !r.sub
      ? (r.act != null ? `${fmtMW(r.act)} MW` + (r.actShare != null ? ` · ${fmtPct(r.actShare)}` : "") : "no data") + (r.mw != null ? ` · expected ${fmtMW(r.mw)}` : "")
      : r.sub ? (r.mw != null ? `${fmtMW(r.mw)} MW expected` : "no forecast")
      : (r.mw != null ? `${fmtMW(r.mw)} MW` + (r.share != null ? ` · ${fmtPct(r.share)}` : "") : "no forecast") + (r.act != null ? ` · actual ${fmtMW(r.act)}` : "");
    g.append("text").attr("class", "mix-value").attr("x", Math.max(x(0), x(r.mw ?? 0), x(r.act ?? 0)) + 6).attr("y", y0 + bh / 2).attr("dy", "0.35em").text(val);
    g.append("rect").attr("x", 0).attr("y", y0 - gap + 4).attr("width", w).attr("height", bh + gap).attr("fill", "transparent")
      .on("pointermove", (ev) => showTip(ev, `<h4>${r.label} · ${heLabel(h)}</h4><table>` +
        (r.act != null ? `<tr><td>Actual output</td><td class="n">${fmtMW(r.act)} MW</td></tr><tr><td>Share of actual</td><td class="n">${r.actShare != null ? d3.format(".1%")(r.actShare) : "–"}</td></tr>` : "") +
        `<tr><td>Expected output</td><td class="n">${r.mw != null ? fmtMW(r.mw) + " MW" : "–"}</td></tr><tr><td>Share of expected generation</td><td class="n">${r.share != null ? d3.format(".1%")(r.share) : "–"}</td></tr>` +
        (r.legs ? `<tr><td>Expected discharging</td><td class="n">${fmtMW(r.legs.dis || 0)} MW</td></tr><tr><td>Expected charging</td><td class="n">${fmtMW(-(r.legs.chg || 0))} MW</td></tr>` : "") + `</table>`))
      .on("pointerleave", hideTip);
  });
  if (x.domain()[0] < 0) svg.append("line").attr("class", "zero").attr("x1", x(0)).attr("x2", x(0)).attr("y1", m.t).attr("y2", Hh - m.b);
  el.replaceChildren(svg.node());
  el.insertAdjacentHTML("beforeend", `<p class="note">` + (actLead
    ? `Generation ${fmtMW(totalAct)} MW in the hour from the ${S.a60 ? "60-day disclosure (output averaged over the hour's SCED runs)" : "2-day summary (base points)"}; the forecast expected ${fmtMW(total)} MW. Ticks are the forecast.`
    : `Expected generation ${fmtMW(total)} MW in the hour.`) +
    (rows.some((r) => r.sub) ? " The 2-day summary reports thermal in total; the technology rows under it are the forecast's split." : "") + `</p>`);
  tel.innerHTML = `<table class="data"><thead><tr><th class="t">Technology</th><th>Expected (MW)</th><th>Share</th><th>Actual (MW)</th><th>Share</th></tr></thead><tbody>` +
    rows.map((r) => `<tr><td class="t">${r.label}</td><td>${r.mw != null ? fmtMW(r.mw) : "–"}</td><td>${r.share != null && !r.sub ? d3.format(".1%")(r.share) : "–"}</td><td>${r.act != null ? fmtMW(r.act) : "–"}</td><td>${r.actShare != null ? d3.format(".1%")(r.actShare) : "–"}</td></tr>`).join("") +
    `<tr><td class="t"><b>Total</b></td><td><b>${fmtMW(total)}</b></td><td></td><td><b>${totalAct != null ? fmtMW(totalAct) : "–"}</b></td><td></td></tr></tbody></table>`;
  setCSV(el, ["technology", "expected_mw", "share", "actual_mw", "actual_share"], rows.map((r) => [r.label, r.mw, r.share, r.act, r.actShare]), `Generation mix ${S.date} ${heLabel(h)}`);
}

// ---------------------------------------------------------------- drill-down: units ---
const VERDICT_LABEL = { on: "Likely on", off: "Likely off", maybe: "Toss-up", nocut: "Too few days to call", outage: "Outage", peaker: "Peaker (by hour)", window: "On outside its off window" };
const UNIT_COLS = [
  ["unit", "Unit", "t"], ["tech", "Technology", "tech"], ["group", "Group", "group"], ["hsl", "HSL (MW)"], ["lsl", "LSL (MW)"],
  ["verdict", "Call", "verdict"], ["p_on", "Odds on", "pct"], ["loss", "Cost to stay on ($)", "$"], ["cutoff", "Usually turns off above ($)", "$"],
  ["off_hours", "Hours off"], ["reason", "Reason", "t"], ["fit", "2-day fit", "fitv"], ["online_h", "Online hours (60-day)"], ["hit", "Call right?", "t"],
];
// once the 60-day data is in, what was observed leads: online hours and whether the call was right
// come right after the unit's size, then the forecast's columns
const UNIT_COLS_OBSERVED = ["unit", "tech", "group", "hsl", "lsl", "online_h", "hit", "verdict", "fit", "p_on", "loss", "cutoff", "off_hours", "reason"];
const UNIT_TIPS = {
  verdict: "Likely on, toss-up or likely off, from what staying on through the day's cheap stretch would cost the unit against what it has walked away from before. Peakers are called hour by hour; outage is a unit off for three weeks or more.",
  p_on: "The odds the unit is on over the day.",
  loss: "What running at minimum output through the day's cheap stretch would cost at the unit's own node's day-ahead price: minimum-energy cost minus price, times minimum output, summed.",
  cutoff: "The cost to stay on above which this unit has usually turned off on days it held no day-ahead award.",
  off_hours: "Hours the unit is expected off.",
  online_h: "Hours the unit was online in the 60-day disclosure (at least half of the hour's SCED runs).",
  hit: "Right when a likely-on or toss-up unit ran at least 12 hours, or a likely-off unit ran under 12. Peakers and outages are not scored here.",
  fit: "The 2-day fit's call: which units must have been on to produce ERCOT's aggregate thermal offer curve two days after the day, starting from the forecast's set. An inference, not a published actual; a changed call is marked.",
};
// the 2-day fit's call for each unit (pipeline/models/two_day_fit), keyed by unit
function fitCalls() {
  const f = S.fit && S.fit.units;
  if (!f) return null;
  const ci = Object.fromEntries(f.columns.map((c, i) => [c, i]));
  return Object.fromEntries(f.rows.map((r) => [r[ci.unit], { fit: r[ci.fit], changed: r[ci.changed], config: r[ci.config] }]));
}
function unitRows() {
  const D = S.day;
  if (!D) return [];
  const C = D.units.columns, a60 = S.a60, fc = fitCalls();
  return D.units.rows.map((r) => {
    const o = Object.fromEntries(C.map((c, i) => [c, r[i]]));
    o.online_h = a60 ? a60.online[o.unit] || 0 : null;
    o.hit = a60 && ["on", "maybe", "off"].includes(o.verdict) ? ((o.verdict === "off") === (o.online_h < 12) ? "right" : "wrong") : null;
    const fv = fc && fc[o.unit];
    o.fit = fv ? fv.fit : null; o.fit_changed = fv ? fv.changed : null;
    return o;
  });
}
function drawUnits() {
  const el = $("units-table"), D = S.day;
  if (!D) { $("units-foot").textContent = ""; return emptyMsg(el, "No forecast for this day."); }
  const hourly = S.unitView === "hour", h = S.hour, f = S.units60;
  let rows = unitRows();
  if (hourly) {
    // the selected hour: the unit's expected state in it, and its measured state once the 60-day data is in
    const ci = f ? Object.fromEntries(f.columns.map((c, i) => [c, i + 2])) : null;
    const on60 = {};
    if (f) f.rows.forEach((r) => {
      if (r[1] !== h + 1) return;
      const [n0, , t] = f.units[r[0]], name = S.a60.trainOf(n0, t), a = on60[name] || (on60[name] = { online: 0, out: 0 });
      a.online = Math.max(a.online, r[ci.online_share] || 0); a.out += r[ci.output] || 0;
    });
    rows.forEach((o) => {
      const offHere = o.off_from != null && o.off_hours && h >= o.off_from - 1 && h < o.off_from - 1 + o.off_hours;
      o.state = o.verdict === "peaker" ? "peaker" : o.verdict === "outage" ? "outage" : offHere ? "off" : o.verdict;
      const a = on60[o.unit];
      o.online_h = f ? (a && a.online >= 0.5 ? 1 : 0) : null;
      o.out_mw = a ? a.out : null;
    });
  }
  if (S.unitTech !== "all") rows = rows.filter((r) => r.tech === S.unitTech);
  if (S.unitSearch) rows = rows.filter((r) => r.unit.toLowerCase().includes(S.unitSearch.toLowerCase()));
  const { key, dir } = S.unitSort;
  rows.sort((a, b) => {
    const va = a[key], vb = b[key];
    if (va == null) return 1; if (vb == null) return -1;
    return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * dir;
  });
  const order = S.a60 ? UNIT_COLS_OBSERVED : UNIT_COLS.map(([k]) => k);
  const cols = order.map((k) => UNIT_COLS.find((c) => c[0] === k))
    .filter(([k]) => (S.a60 || !["online_h", "hit"].includes(k)) && (S.fit || k !== "fit") && !(hourly && (k === "hit" || k === "fit")))
    .map(([k, l, kind]) => (hourly && k === "verdict" ? ["state", `Call in ${heLabel(h)}`, "verdict"] : hourly && k === "online_h" ? ["online_h", `Online in ${heLabel(h)}`, "yn"] : [k, l, kind]));
  if (hourly && f) cols.push(["out_mw", `Output in ${heLabel(h)} (MW)`]);
  const csvKeys = [...D.units.columns, ...(S.fit ? ["fit", "fit_changed"] : []), ...(S.a60 ? ["online_h", "hit"] : []), ...(hourly ? ["state", ...(f ? ["out_mw"] : [])] : [])];
  setCSV(el, csvKeys, rows.map((r) => csvKeys.map((k) => r[k])), `Units ${S.date}${hourly ? " " + heLabel(h) : ""}`);
  const total = rows.length;
  if (!S.unitShowAll) rows = rows.slice(0, PAGE_ROWS);
  const fmt = (r, k, kind) => {
    const v = r[k];
    if (v == null) return "–";
    if (kind === "t") return k === "unit" ? `<a href="unit.html?unit=${encodeURIComponent(v)}">${esc(v)}</a>` : esc(v);
    if (kind === "tech") return TECH_LABEL[v] || esc(v);
    if (kind === "group") return GROUP_SHORT[v] || esc(v);
    if (kind === "verdict") return VERDICT_LABEL[v] || esc(v);
    if (kind === "fitv") return (VERDICT_LABEL[v] || esc(v)) + (r.fit_changed ? " <small>(changed)</small>" : "");
    if (kind === "pct") return fmtPct(v);
    if (kind === "$") return d3.format("$,.0f")(v);
    if (kind === "yn") return v ? "yes" : "no";
    if (k === "off_hours" || k === "online_h") return d3.format(",.0f")(v);
    return d3.format(",.1f")(v);
  };
  let html = `<div class="units-wrap"><table class="data"><thead><tr>${cols.map(([k, l, kind]) =>
    `<th class="sortable ${["t", "tech", "group", "verdict", "fitv"].includes(kind) ? "t" : ""}${UNIT_TIPS[k] ? " has-tip" : ""}" data-k="${k}"${UNIT_TIPS[k] ? ` data-tip-title="${esc(l)}" data-tip="${esc(UNIT_TIPS[k])}"` : ""} aria-sort="${k === key ? (dir > 0 ? "ascending" : "descending") : "none"}">${l}${k === key ? (dir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead><tbody>`;
  html += rows.map((r) => `<tr>${cols.map(([k, , kind]) => `<td class="${["t", "tech", "group", "verdict", "fitv"].includes(kind) ? "t" : ""}">${fmt(r, k, kind)}</td>`).join("")}</tr>`).join("");
  el.innerHTML = html + "</tbody></table></div>";
  const sc = dayScore();
  $("units-foot").innerHTML = (total > rows.length ? `Showing ${rows.length} of ${total} units. <button type="button" id="units-all" class="linkish">Show all</button>` : `Units: ${total}.`) +
    (sc && sc.sixty_day ? ` On or off calls right on ${fmtPct(sc.sixty_day.unit_hit)} of the ${sc.sixty_day.n_judged} judged units this day.` : "") +
    " The CSV download has every column, including the model and version behind each row.";
  $("units-note").textContent = `${S.date} · ${D.units.rows.length} thermal units`;
  const b = $("units-all");
  if (b) b.onclick = () => { S.unitShowAll = true; drawUnits(); };
}

// ---------------------------------------------------------------- layers strip ---
function drawLayers() {
  const d = S.date, known = S.day && S.day.inputs;
  const sc = dayScore();
  const L = lead();
  const card = (n, title, state, body) => `<div class="layer ${state === "now" ? "now" : ""}"><span class="st">${n} · ${title} · ${state === "now" ? "leads the page" : state}</span><p>${body}</p></div>`;
  $("layers").innerHTML =
    card(1, "Forecast", L === "fc" ? "now" : "in", known ? `from day-ahead prices known on ${known.known_date}${L === "fc" ? "" : "; kept under Estimates"}` : "no forecast for this day") +
    card(2, "2-day summary", L === "2d" ? "now" : has("2dgen") || S.fit ? "in" : "in 2 days",
      has("2dgen") ? (sc && sc.two_day ? `thermal energy ${sc.two_day.headline_hit ? "within" : "outside"} tolerance of the forecast; thermal in total, wind, solar and batteries by hour` : "thermal in total, wind, solar and batteries by hour") : "adds what ran: thermal in total, wind, solar and batteries") +
    card(3, "60-day disclosure", L === "60d" ? "now" : has("60d") ? "in" : "in 60 days", has("60d") ? (sc && sc.sixty_day ? `unit calls right ${fmtPct(sc.sixty_day.unit_hit)}; each unit's output by hour` : "each unit's output by hour") : "adds each unit's hours and output, so the groups and the units table get their answer");
  $("source-note").textContent = known ? `Forecast built ${S.fc.updated.slice(0, 10)}` : "";
}

// ---------------------------------------------------------------- the step down to the bids ---
// the forecast day's hour in the latest offers: the 2-day curves run two days behind, so the
// link opens the Offers page on the newest day with curves, on or before this one
function offersHref(he) {
  const ds = (S.index && S.index.days["2d"]) || [], d = [...ds].reverse().find((x) => x <= S.date) || ds.at(-1);
  return d ? { href: `beyond.html#date=${d}&he=${he}`, d } : null;
}
function drawOffersLinks() {
  const H = S.day && S.day.headline;
  const P = dayPrice(), cheap = P && P.vals ? d3.minIndex(P.vals.map((p) => (p == null ? Infinity : p))) + 1 : null;
  const a = cheap && offersHref(cheap), b = offersHref(S.hour + 1);
  $("offers-step").innerHTML = a ? `<a href="${a.href}">What is bid at the cheapest hour, HE ${cheap}: the latest offers, ${esc(a.d)} →</a>` : "";
  $("offers-hour").innerHTML = b ? `<a href="${b.href}">What is bid in HE ${S.hour + 1}: the latest offers, ${esc(b.d)} →</a>` : "";
}

// ---------------------------------------------------------------- render ---
function render() {
  const days = S.fc.days, di = days.indexOf(S.date);
  $("date-prev").disabled = di <= 0;
  $("date-next").disabled = di < 0 || di >= days.length - 1;
  $("hour-out").textContent = `${heLabel(S.hour)} · ${String(S.hour).padStart(2, "0")}:00–${String(S.hour + 1).padStart(2, "0")}:00`;
  drawLayers(); drawHeadline(); drawSpark(); drawMini(); drawActual(); drawActualBars(); drawEstimates(); drawGroups(); drawTechs(); drawFit(); drawHourly(); drawScore(); drawMix(); drawUnits(); drawOffersLinks();
  saveView();
}
// a click on an hourly chart picks the hour for the generation mix and the units table
function pickHour(h) {
  S.hour = Math.max(0, Math.min(23, h)); $("hour").value = S.hour; renderHour();
}
function renderHour() {
  $("hour-out").textContent = `${heLabel(S.hour)} · ${String(S.hour).padStart(2, "0")}:00–${String(S.hour + 1).padStart(2, "0")}:00`;
  drawMix(); drawOffersLinks(); if (S.unitView === "hour") drawUnits();
  saveView();
}
async function loadDay() {
  const d = S.date;
  const [day, gen, units60, prices, fit] = await Promise.all([
    tryJSON(`data/forecast/${d}.json.gz`),
    has("2dgen") ? tryJSON(`data/2dgen/${d}.json.gz`) : null,
    has("60d") ? tryJSON(`data/60d-units/${d}.json.gz`) : null,
    has("prices") ? tryJSON(`data/prices/${d}.json.gz`) : null,
    has("fit") ? tryJSON(`data/fit/${d}.json.gz`) : null,
  ]);
  if (d !== S.date) return;    // a newer pick took over
  S.day = day; S.gen = gen; S.units60 = units60; S.prices = prices; S.fit = fit;
  S.a60 = actual60();
  S.unitShowAll = false;
}
async function changeDay() { await loadDay(); render(); }
function saveView() { window.CX.writeHash({ date: S.date, he: S.hour + 1, unit: S.unit, uv: S.unitView }); }
function loadView() {
  const v = window.CX.readHash();
  if (v.date) S.date = v.date;
  if (v.he && +v.he >= 1 && +v.he <= 24) S.hour = +v.he - 1;
  if (["gw", "gwh"].includes(v.unit)) S.unit = v.unit;
  if (["day", "hour"].includes(v.uv)) S.unitView = v.uv;
}

async function boot() {
  S.fc = await tryJSON("data/forecast/index.json.gz");
  if (!S.fc || !S.fc.days || !S.fc.days.length) { $("status").textContent = "No forecast files yet. They are built by the data update workflow."; return; }
  [S.index, S.scores, S.hubs, S.dalam] = await Promise.all([tryJSON("data/index.json"), tryJSON("data/forecast/scores.json.gz"), tryJSON("data/dam_hubs.json.gz"), tryJSON("data/dam_lambda.json.gz")]);
  S.index = S.index || { days: {} };
  const days = S.fc.days;
  loadView();
  if (!days.includes(S.date)) S.date = defaultDate(days);
  $("date").innerHTML = [...days].reverse().map((d) => `<option value="${d}">${dayLabel(d)}${has("60d", d) ? " · 60-day" : has("2dgen", d) ? " · 2-day" : ""}</option>`).join("");
  $("date").value = S.date;
  $("status").textContent = `Forecasts for ${days.length} days, ${days[0]} to ${days.at(-1)} · updated ${S.fc.updated.replace("T", " ").replace("Z", " UTC")}`;
  $("unit-tech").innerHTML = `<option value="all">All</option>` + TECHS.map(([id, l]) => `<option value="${id}">${l}</option>`).join("");
  $("unit-tech").value = S.unitTech;
  $("hour").value = S.hour;
  const UNIT_SEGS = ["unit-a", "unit-g", "unit-t"];
  UNIT_SEGS.forEach((id) => setSeg(id, S.unit)); setSeg("unit-view", S.unitView);
  UNIT_SEGS.forEach((id) => $(id).addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; S.unit = b.dataset.v; UNIT_SEGS.forEach((s) => setSeg(s, S.unit)); drawActualBars(); drawGroups(); drawTechs(); saveView(); }));
  bindSeg("unit-view", "unitView", () => { S.unitShowAll = false; drawUnits(); });
  $("date").onchange = async (e) => { S.date = e.target.value; await changeDay(); };
  const stepDay = async (dir) => { const i = days.indexOf(S.date) + dir; if (i < 0 || i >= days.length) return; S.date = days[i]; $("date").value = S.date; await changeDay(); };
  $("date-prev").onclick = () => stepDay(-1);
  $("date-next").onclick = () => stepDay(1);
  $("hour").oninput = (e) => { S.hour = +e.target.value; renderHour(); };
  $("unit-tech").onchange = (e) => { S.unitTech = e.target.value; S.unitShowAll = false; drawUnits(); };
  $("unit-search").oninput = (e) => { S.unitSearch = e.target.value; drawUnits(); };
  $("units-table").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-k]");
    if (!th) return;
    const k = th.dataset.k;
    S.unitSort = { key: k, dir: S.unitSort.key === k ? -S.unitSort.dir : (["unit", "tech", "group", "verdict", "fit", "reason", "state", "hit"].includes(k) ? 1 : -1) };
    drawUnits();
  });
  [["hourly-legend", drawHourly], ["actual-legend", drawActual]].forEach(([id, draw]) => $(id).addEventListener("click", (e) => {
    const b = e.target.closest("button[data-id]");
    if (!b) return;
    S.hidden.has(b.dataset.id) ? S.hidden.delete(b.dataset.id) : S.hidden.add(b.dataset.id);
    draw();
  }));
  // bar and header tooltips: hover, keyboard focus, or tap
  const tipFor = (el) => el.dataset.tipHtml || `<h4>${esc(el.dataset.tipTitle || "")}</h4><p class="tip-body">${esc(el.dataset.tip)}</p>`;
  const tipAt = (el) => { const r = el.getBoundingClientRect(); return { clientX: r.left, clientY: r.bottom - 6 }; };
  document.addEventListener("pointerover", (e) => { const el = e.target.closest("[data-tip],[data-tip-html]"); if (el && e.pointerType === "mouse") showTip(e, tipFor(el)); });
  document.addEventListener("pointermove", (e) => { const el = e.target.closest("[data-tip],[data-tip-html]"); if (el && e.pointerType === "mouse") showTip(e, tipFor(el)); });
  document.addEventListener("pointerout", (e) => { if (e.target.closest("[data-tip],[data-tip-html]")) hideTip(); });
  document.addEventListener("click", (e) => { const el = e.target.closest("[data-tip],[data-tip-html]"); if (el && !el.closest("th")) showTip(tipAt(el), tipFor(el)); else if (!e.target.closest(".tip")) hideTip(); });
  await loadDay();
  render();
  window.CX.init();
  window.CX.panelFromLink();
  let rt;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(render, 150); });
}
boot();
})();

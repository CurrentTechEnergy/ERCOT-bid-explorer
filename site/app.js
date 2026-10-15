/* ERCOT Bid Stack Explorer — static dashboard. Reads data/*.json(.gz) written by the pipeline. */
(() => {
"use strict";

// ---------------------------------------------------------------- series ---
// Colors are fixed per technology (never re-assigned when series are hidden).
const SERIES = {
  "2d": [
    { id: "non_irr", keys: ["non_irr"], label: "Thermal & other (non-IRR)", color: "--c1" },
    { id: "wind", keys: ["wind"], label: "Wind", color: "--c3" },
    { id: "solar", keys: ["solar"], label: "Solar", color: "--c4" },
    { id: "storage", keys: ["storage"], label: "Storage (ESR)", color: "--c7" },
  ],
  "60d": [
    { id: "combined_cycle", keys: ["combined_cycle"], label: "Combined cycle", color: "--c1" },
    { id: "combustion_turbine", keys: ["combustion_turbine"], label: "Combustion turbine", color: "--c2" },
    { id: "wind", keys: ["wind"], label: "Wind", color: "--c3" },
    { id: "solar", keys: ["solar"], label: "Solar", color: "--c4" },
    { id: "nuclear", keys: ["nuclear"], label: "Nuclear", color: "--c5" },
    { id: "gas_steam", keys: ["gas_steam"], label: "Gas steam", color: "--c6" },
    { id: "storage", keys: ["storage"], label: "Storage (ESR)", color: "--c7" },
    { id: "coal", keys: ["coal"], label: "Coal & lignite", color: "--c8" },
    { id: "other", keys: ["hydro", "other"], label: "Other (hydro, diesel, biomass)", color: "--c-other" },
  ],
};
const DEMAND_2D = { id: "clr", keys: ["clr"], label: "Controllable load bids (demand)" };

// "low" runs from -$50 to the hour's highest cleared price or $60, whichever is higher, so the
// cleared price is always in view; the -$250 floor is left to the full range.
const RANGES = {
  low: { domain: [-50, 60], scale: "linear" },
  mid: { domain: [-50, 300], scale: "linear" },
  full: { domain: [-250, 5000], scale: "symlog" },
};
function rangeFor(key) {
  if (key === "custom") return priceAxis(S.xMin, S.xMax);
  if (key !== "low") return RANGES[key];
  const hp = hourPrice(S.prices, S.hour);
  const top = hp && hp.max != null && hp.max > 55 ? Math.ceil((hp.max + 5) / 10) * 10 : 60;
  return priceAxis(-50, top);
}
// A price axis the user types in: kept inside the price grid, at least $5 wide, and
// compressed (symlog) once it spans more than $600 so the low prices stay readable.
const LOG_TICKS = [-250, -100, -50, -20, 0, 10, 20, 30, 50, 100, 200, 300, 500, 1000, 2000, 5000];
function priceAxis(lo, hi) {
  const g = S.index ? S.index.grid : [-250, 5000], g0 = g[0], g1 = g[g.length - 1];
  lo = Math.max(g0, Math.min(isFinite(lo) ? lo : g0, g1 - 5));
  hi = Math.min(g1, Math.max(isFinite(hi) ? hi : g1, lo + 5));
  return { domain: [lo, hi], scale: hi - lo > 600 ? "symlog" : "linear" };
}
const LOG_TICKS_NARROW = [-250, -50, 0, 25, 100, 1000, 5000];
const logTicks = (dom, narrow) => (narrow ? LOG_TICKS_NARROW : LOG_TICKS).filter((v) => v >= dom[0] && v <= dom[1]);

// ----------------------------------------------------------------- state ---
const S = {
  index: null, source: "2d", date: null, hour: 12, version: "curves",
  xrange: "low", xMin: -250, xMax: 100, osMin: -100, osMax: 1000, mode: "lines", axes: "price_x", threshold: 0, location: "lambda",
  lslMode: "from_lsl",     // offer curves: "from_lsl" (LSL plus the MW offered above it) or "ercot" (as ERCOT prices them)
  hidden: new Set(), unitTech: "all", unitSearch: "",
  unitSort: { key: "lsl", dir: -1 }, unitShowAll: false, unitView: "day", unitHours: new Map(),
  day: null, prices: null, summaries: {}, osView: "hour", ttView: "hour", osUnit: "share", osSmooth: "smooth",
};
const $ = (id) => document.getElementById(id);
const fmtMW = d3.format(",.0f");
const fmtPrice = (v) => (v == null || isNaN(v) ? "–" : d3.format("$,.2f")(v));
const fmtPrice0 = (v) => d3.format("$,.0f")(v);
const fmtPct = d3.format(".0%");
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const heLabel = (h) => `HE ${h + 1}`;

// ------------------------------------------------------------------ data ---
const { getJSON, tryJSON, showTip, hideTip, setCSV, axisFmt } = window.CX;

function seriesList() { return SERIES[S.source]; }
function gridIndex(price) {
  const g = S.index.grid;
  let best = 0;
  for (let i = 0; i < g.length; i++) if (Math.abs(g[i] - price) < Math.abs(g[best] - price)) best = i;
  return best;
}

/** [24][G] array for a series (summing component keys), or null.  With `dispatchable`, a 60-day
 * day that has the block (each unit's minimum output taken out, pipeline/dispatchable.py) gives
 * that version of the curve; technologies the block leaves out (wind, solar, storage) and days
 * without it fall back to the whole curve. */
function seriesCurves(day, s, version, dispatchable) {
  const key = version === "submitted" && S.source === "60d" ? "submitted" : "curves";
  const block = day[key], disp = dispatchable && S.source === "60d" && day.dispatchable && day.dispatchable[key];
  const parts = s.keys.map((k) => (disp && disp[k]) || (block && block[k])).filter(Boolean);
  if (!parts.length) return null;
  return parts[0].map((row, h) => row == null ? null : row.map((v, i) =>
    parts.reduce((a, p) => a + ((p[h] && p[h][i]) || 0), 0)));
}

/** Threshold summary for a series on one date: [24][T] or null. */
function summarySeries(entry, s) {
  if (!entry) return null;
  const block = S.source === "60d" ? entry[S.version === "submitted" ? "submitted" : "curves"] : entry;
  const parts = s.keys.map((k) => block && block[k]).filter(Boolean);
  if (!parts.length) return null;
  return parts[0].map((row, h) => row.map((v, i) =>
    parts.reduce((a, p) => (p[h][i] == null ? a : a + p[h][i]), 0)));
}

/** Whether the loaded day carries dispatchable curves (minimum output taken out). */
function hasDispatchable() { return S.source === "60d" && !!(S.day && S.day.dispatchable); }
/** Short note on what the marginal charts count: MW above LSL, or whole curves where the day lacks the block. */
function dispNote() {
  return hasDispatchable() ? "MW above minimum output (LSL)" : S.source === "60d" ? "minimum output included: this day has not been reprocessed yet" : "minimum output included: the 2-day report has no unit limits";
}
/** Minimum output (LSL) online in hour h for a series, from the 60-day technology stats (null without them). */
function seriesLSL(s, h) {
  if (S.source !== "60d" || !S.day || !S.day.stats || s.id === "storage") return null;
  const j = S.day.stat_names.indexOf("lsl");
  return j < 0 ? null : d3.sum(s.keys, (k) => (S.day.stats[k] && S.day.stats[k][h] && S.day.stats[k][h][j]) || 0);
}

/** [G] curve for series s in hour h as the chart draws it.  "From LSL": each technology's online
 * minimum output (LSL) plus the MW it offers above LSL at or below each price, from the dispatchable
 * block, so the curve runs flat at LSL from the left edge instead of carrying ERCOT's -$20/-$50
 * placeholder steps and the sub-LSL points of submitted curves.  Technologies the block leaves out
 * (wind, solar, storage), 2-day days and days without the block keep the curve as ERCOT prices it. */
function chartCurve(s, h) {
  const key = S.version === "submitted" && S.source === "60d" ? "submitted" : "curves";
  const block = S.day[key] || {};
  const disp = S.lslMode === "from_lsl" && hasDispatchable() ? S.day.dispatchable[key] || {} : {};
  const j = S.day.stat_names ? S.day.stat_names.indexOf("lsl") : -1;
  const parts = s.keys.map((k) => {
    const d = disp[k] && disp[k][h];
    if (!d) return block[k] && block[k][h];
    const lsl = (j >= 0 && S.day.stats[k] && S.day.stats[k][h] && S.day.stats[k][h][j]) || 0;
    return d.map((v) => (v == null ? null : v + lsl));
  }).filter(Boolean);
  if (!parts.length) return null;
  return parts[0].map((v, i) => parts.reduce((a, p) => a + (p[i] || 0), 0));
}
/** Whether the offer curves chart is drawing from LSL for the loaded day. */
function curvesFromLSL() { return S.lslMode === "from_lsl" && hasDispatchable(); }

function hourPrice(prices, h) {
  if (!prices) return null;
  if (S.location === "lambda") {
    const L = prices.lambda;
    return { mean: L.hourly_mean[h], min: L.hourly_min[h], max: L.hourly_max[h] };
  }
  const q = prices.spp15 && prices.spp15[S.location];
  if (!q) return null;
  const v = q.slice(h * 4, h * 4 + 4).filter((x) => x != null);
  if (!v.length) return null;
  return { mean: d3.mean(v), min: d3.min(v), max: d3.max(v) };
}

// ------------------------------------------------------------- controls ---
function setSeg(id, value) {
  $(id).querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === value)));
}
function bindSeg(id, key, after) {
  $(id).addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;
    S[key] = b.dataset.v;
    setSeg(id, S[key]);
    after ? after() : render();
  });
}

// every operating day with either report, oldest first
function allDays() { return [...new Set([...S.index.days["2d"], ...S.index.days["60d"]])].sort(); }
// the 60-day disclosure is more detailed (per unit, measured output), so use it whenever the day has it
function sourceFor(d) { return S.index.days["60d"].includes(d) ? "60d" : "2d"; }

function fillDates() {
  const days = allDays().reverse();
  const withPrices = new Set(S.index.days.prices);
  $("date").innerHTML = days.map((d) => {
    const label = d3.timeFormat("%a %b %-d, %Y")(new Date(d + "T12:00:00"));
    return `<option value="${d}">${label}${withPrices.has(d) ? "" : " (no prices yet)"}</option>`;
  }).join("");
  if (!days.includes(S.date)) S.date = days[0] || null;
  $("date").value = S.date || "";
}

// pick the report for the selected day; reset per-report choices when it changes
function syncSource() {
  const src = S.date ? sourceFor(S.date) : S.source;
  if (src !== S.source) { S.source = src; S.hidden.clear(); fillTechSelects(); }
  $("source-note").textContent = S.source === "60d"
    ? "Data: 60-day disclosure, per unit"
    : "Data: 2-day report. Per-unit detail arrives about 60 days later.";
}

function fillLocations() {
  const pts = new Set();
  Object.values(S.summaries.prices || {}).forEach((e) => Object.keys(e.spp || {}).forEach((p) => pts.add(p)));
  const sorted = [...pts].sort((a, b) => (a.startsWith("HB_") === b.startsWith("HB_") ? a.localeCompare(b) : a.startsWith("HB_") ? -1 : 1));
  $("location").innerHTML = `<option value="lambda">System lambda</option>` +
    sorted.map((p) => `<option value="${p}">${p}</option>`).join("");
  $("location").value = pts.has(S.location) ? S.location : "lambda";
  S.location = $("location").value;
}

function fillThresholds() {
  $("threshold").innerHTML = S.index.thresholds.map((t) =>
    `<option value="${t}">${t === -249 ? "Price floor (−$250)" : fmtPrice0(t)}</option>`).join("");
  $("threshold").value = String(S.threshold);
}

function fillTechSelects() {
  $("unit-tech").innerHTML = `<option value="all">All</option>` +
    SERIES["60d"].map((s) => `<option value="${s.id}">${s.label}</option>`).join("");
  $("unit-tech").value = S.unitTech;
}

// ------------------------------------------------------------ rendering ---
async function loadDay() {
  if (!S.date) { S.day = null; S.prices = null; return; }
  const has = (k) => (S.index.days[k] || []).includes(S.date);
  // a day uses the 60-day report whenever it has it, so curtailment needs the 2-day files only
  // for days without it
  const [day, prices, gen] = await Promise.all([
    tryJSON(`data/${S.source}/${S.date}.json.gz`),
    tryJSON(`data/prices/${S.date}.json.gz`),
    S.source === "2d" && has("2dgen") ? tryJSON(`data/2dgen/${S.date}.json.gz`) : null,
  ]);
  S.day = day; S.prices = prices;
  S.day60 = S.source === "60d" ? day : null; S.day2 = S.source === "60d" ? null : day; S.gen = gen;
}

async function changeDay() {
  syncSource();
  await loadDay();
  render();
}

function render() {
  const is60 = S.source === "60d";
  const days = S.index ? allDays() : [];
  const di = days.indexOf(S.date);
  $("date-prev").disabled = di <= 0;
  $("date-next").disabled = di < 0 || di >= days.length - 1;
  $("ctl-version").hidden = !is60;
  $("thermal-panel").hidden = !is60;
  $("units-panel").hidden = !is60;
  $("hour-out").textContent = `${heLabel(S.hour)} · ${String(S.hour).padStart(2, "0")}:00–${String(S.hour + 1).padStart(2, "0")}:00`;
  $("curve-title-note").textContent = S.date ? `${S.date} · ${heLabel(S.hour)}${S.source !== "60d" ? "" : curvesFromLSL() ? " · from LSL" : S.lslMode === "from_lsl" ? " · as ERCOT prices them (no LSL data for this day yet)" : " · as ERCOT prices them"}` : "";
  renderLegend();
  drawCurves();
  drawDay();
  drawCurtail();
  drawMix();
  drawMarginal();
  drawOfferStack();
  drawProfile();
  if (is60) { drawTechTable(); drawUnits(); }
  drawDuration();
  saveView();
}

// the address bar carries the view, so a copied link reopens this exact day, hour and settings
const NUM_KEYS = new Set(["threshold", "xMin", "xMax", "osMin", "osMax"]);
const VIEW_KEYS = { loc: "location", xr: "xrange", xmin: "xMin", xmax: "xMax", osmin: "osMin", osmax: "osMax", mode: "mode", axes: "axes", lsl: "lslMode", ver: "version", thr: "threshold", os: "osView", tt: "ttView", uv: "unitView", osu: "osUnit", osm: "osSmooth" };
// price limits go in the link only when they are in use
const HIDE_KEY = { xMin: () => S.xrange !== "custom", xMax: () => S.xrange !== "custom",
  osMin: () => S.osMin === OS_DEFAULT[0] && S.osMax === OS_DEFAULT[1], osMax: () => S.osMin === OS_DEFAULT[0] && S.osMax === OS_DEFAULT[1] };
function saveView() {
  window.CX.writeHash({ date: S.date, he: S.hour + 1, ...Object.fromEntries(Object.entries(VIEW_KEYS)
    .filter(([, sk]) => !(HIDE_KEY[sk] && HIDE_KEY[sk]())).map(([k, sk]) => [k, S[sk]])) });
}
function loadView() {
  const v = window.CX.readHash();
  if (v.date) S.date = v.date;
  if (v.he && +v.he >= 1 && +v.he <= 24) S.hour = +v.he - 1;
  Object.entries(VIEW_KEYS).forEach(([k, sk]) => { if (v[k] != null) S[sk] = NUM_KEYS.has(sk) ? +v[k] : v[k]; });
  if (!S.index.thresholds.includes(S.threshold)) S.threshold = 0;
}

function renderLegend() {
  const items = seriesList().map((s) =>
    `<button type="button" data-id="${s.id}" aria-pressed="${!S.hidden.has(s.id)}"><span class="sw" style="background:var(${s.color})"></span>${s.label}</button>`);
  if (S.source === "2d") items.push(`<button type="button" data-id="clr" aria-pressed="${!S.hidden.has("clr")}"><span class="sw sw-line"></span>${DEMAND_2D.label}</button>`);
  $("legend").innerHTML = items.join("");
}

function emptyMsg(el, msg) { el.innerHTML = `<p class="empty">${msg}</p>`; }

function size(el, h) {
  const w = Math.max(280, el.clientWidth || el.parentElement.clientWidth || 600);
  return { w, h };
}

// ---- offer curve chart ----------------------------------------------------
function drawCurves() {
  const el = $("curve-chart");
  if (!S.day) return emptyMsg(el, "No data for this day.");
  const h = S.hour;
  if (!S.day.runs[h]) return emptyMsg(el, `No SCED runs recorded in ${heLabel(h)} (daylight-saving change).`);
  const grid = S.index.grid;
  const R = rangeFor(S.xrange);
  const dom = [R.domain[0], Math.min(R.domain[1], grid[grid.length - 1])];
  const idx = grid.map((p, i) => i).filter((i) => grid[i] >= dom[0] && grid[i] <= dom[1]);
  const prices = idx.map((i) => grid[i]);
  const flip = S.axes === "price_y";          // classic supply-curve orientation: MW across, price up

  const visible = seriesList().filter((s) => !S.hidden.has(s.id));
  const rows = visible.map((s) => {
    const r = chartCurve(s, h);
    if (!r) return null;
    let vals = idx.map((i) => r[i] ?? 0);
    if (S.mode === "share") {
      const last = r[r.length - 1] ?? 0, first = r[0] ?? 0;
      const span = s.id === "storage" ? last - first : last;
      vals = idx.map((i) => span ? ((s.id === "storage" ? (r[i] - first) : r[i]) / span) * 100 : 0);
    }
    return { s, vals, full: r };
  }).filter(Boolean);
  const demand = S.source === "2d" && !S.hidden.has("clr") && S.mode === "lines" && S.day.curves.clr && S.day.curves.clr[h]
    ? { s: { ...DEMAND_2D, color: "--c-other" }, vals: idx.map((i) => S.day.curves.clr[h][i] ?? 0) } : null;

  const { w } = size(el);
  const H = flip ? Math.max(340, Math.min(520, w * 0.52)) : Math.max(300, Math.min(440, w * 0.45));
  const labelRoom = !flip && S.mode !== "stack" && w >= 560;
  const m = { t: 18, r: labelRoom ? 150 : 16, b: 40, l: flip ? 70 : 64 };

  // value (MW or %) scale and price scale; which one is horizontal depends on `flip`
  let stacked = null, vDom;
  if (S.mode === "stack" && rows.length) {
    const data = prices.map((p, j) => Object.fromEntries([["p", p], ...rows.map((r) => [r.s.id, r.vals[j]])]));
    stacked = d3.stack().keys(rows.map((r) => r.s.id)).offset(d3.stackOffsetDiverging)(data);
    vDom = [Math.min(0, d3.min(stacked, (l) => d3.min(l, (d) => d[0]))), d3.max(stacked, (l) => d3.max(l, (d) => d[1]))];
  } else if (S.mode === "share") {
    vDom = [0, 100];
  } else {
    const all = rows.flatMap((r) => r.vals).concat(demand ? demand.vals : []);
    vDom = [Math.min(0, d3.min(all) ?? 0), Math.max(1, d3.max(all) ?? 1)];
  }
  const pScale = (R.scale === "symlog" ? d3.scaleSymlog().constant(25) : d3.scaleLinear()).domain(dom);
  const vScale = d3.scaleLinear().domain(vDom);
  const xS = flip ? vScale : pScale, yS = flip ? pScale : vScale;
  xS.range([m.l, w - m.r]);
  yS.range([H - m.b, m.t]);
  vScale.nice();
  const P = flip ? (p) => yS(p) : (p) => xS(p);   // price -> pixel along the price axis
  const V = flip ? (v) => xS(v) : (v) => yS(v);   // value -> pixel along the value axis
  const pt = (p, v) => (flip ? [V(v), P(p)] : [P(p), V(v)]);

  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`).attr("role", "img")
    .attr("aria-label", `Offer curves for ${S.date} ${heLabel(h)}`);
  const priceTicks = R.scale === "symlog" ? (S.xrange === "custom" ? logTicks(dom, w < 560) : [-250, -100, -25, 0, 25, 100, 300, 1000, 5000])
    : pScale.ticks(flip ? 8 : (w < 560 ? 5 : 9));
  const valFmt = S.mode === "share" ? (v) => v + "%" : d3.format(",.0f");
  const valTicks = flip && w < 560 ? 4 : 6;
  const xAxis = flip ? d3.axisBottom(xS).ticks(valTicks).tickFormat(valFmt) : d3.axisBottom(xS).tickValues(priceTicks).tickFormat(fmtPrice0);
  const yAxis = flip ? d3.axisLeft(yS).tickValues(priceTicks).tickFormat(fmtPrice0) : d3.axisLeft(yS).ticks(6).tickFormat(valFmt);
  const gridAxis = flip ? d3.axisBottom(xS).ticks(valTicks).tickSize(-(H - m.t - m.b)).tickFormat("")
    : d3.axisLeft(yS).ticks(6).tickSize(-(w - m.l - m.r)).tickFormat("");
  svg.append("g").attr("class", "gridline").attr("transform", flip ? `translate(0,${H - m.b})` : `translate(${m.l},0)`).call(gridAxis);
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(xAxis.tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(yAxis.tickSizeOuter(0));
  // zero lines: value 0 (MW) and, when flipped, $0 is just a tick
  if (vDom[0] < 0) {
    if (flip) svg.append("line").attr("class", "zero").attr("x1", V(0)).attr("x2", V(0)).attr("y1", m.t).attr("y2", H - m.b);
    else svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", V(0)).attr("y2", V(0));
  }
  const valTitle = S.mode === "share" ? "% of MW offered at any price" : "MW offered at or below price";
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", H - 6).attr("text-anchor", "end").text(flip ? valTitle : "Offer price ($/MWh)");
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text(flip ? "Offer price ($/MWh)" : valTitle);

  const hp = hourPrice(S.prices, h);
  const priceLayer = svg.append("g");

  // stacked view: the minimum output (LSL) of the online units shown as one band from zero, the
  // part of the stack that keeps running however low the price goes and never sets dispatch
  if (S.mode === "stack") {
    const lsl = d3.sum(rows, (r) => seriesLSL(r.s, h) || 0);
    if (lsl > 0 && lsl <= vDom[1]) {
      if (flip) priceLayer.append("rect").attr("class", "lsl-band").attr("x", V(0)).attr("width", Math.max(1, V(lsl) - V(0))).attr("y", m.t).attr("height", H - m.b - m.t);
      else priceLayer.append("rect").attr("class", "lsl-band").attr("x", m.l).attr("width", w - m.l - m.r).attr("y", V(lsl)).attr("height", Math.max(1, V(0) - V(lsl)));
      const l = priceLayer.append("line").attr("class", "lsl-rule");
      if (flip) l.attr("x1", V(lsl)).attr("x2", V(lsl)).attr("y1", m.t).attr("y2", H - m.b);
      else l.attr("x1", m.l).attr("x2", w - m.r).attr("y1", V(lsl)).attr("y2", V(lsl));
      const txt = `Minimum output (LSL) of the online units shown: ${fmtMW(lsl)} MW`;
      if (flip) priceLayer.append("text").attr("class", "lsl-label").attr("x", V(lsl) + 5).attr("y", H - m.b - 6).text(txt);
      else priceLayer.append("text").attr("class", "lsl-label").attr("x", m.l + 6).attr("y", V(lsl) - 5).text(txt);
    }
  }

  if (stacked) {
    const area = flip
      ? d3.area().y((d) => P(d.data.p)).x0((d) => V(d[0])).x1((d) => V(d[1])).curve(d3.curveStepBefore)
      : d3.area().x((d) => P(d.data.p)).y0((d) => V(d[0])).y1((d) => V(d[1])).curve(d3.curveStepAfter);
    svg.append("g").selectAll("path").data(stacked).join("path")
      .attr("fill", (l) => css(rows.find((r) => r.s.id === l.key).s.color))
      .attr("d", area);
  } else {
    const line = d3.line().x((d, j) => pt(prices[j], d)[0]).y((d, j) => pt(prices[j], d)[1])
      .curve(flip ? d3.curveStepBefore : d3.curveStepAfter);
    const g = svg.append("g").attr("fill", "none").attr("stroke-width", 2).attr("stroke-linejoin", "round");
    rows.forEach((r) => g.append("path").attr("stroke", css(r.s.color)).attr("d", line(r.vals)));
    if (demand) g.append("path").attr("stroke", css("--c-other")).attr("stroke-dasharray", "5 4").attr("d", line(demand.vals));
    if (labelRoom) {
      const labs = rows.concat(demand ? [demand] : []).map((r) => ({ text: r.s.label.replace(/ \(.*\)$/, ""), y: V(r.vals[r.vals.length - 1]) }))
        .sort((a, b) => a.y - b.y);
      for (let i = 1; i < labs.length; i++) if (labs[i].y - labs[i - 1].y < 13) labs[i].y = labs[i - 1].y + 13;
      svg.append("g").selectAll("text").data(labs).join("text").attr("class", "dlabel")
        .attr("x", w - m.r + 8).attr("y", (d) => d.y).attr("dy", "0.32em").text((d) => d.text);
    }
  }

  // cleared price: a line across the value axis at the hour's average, with the hour's range shaded
  if (hp && hp.mean != null && hp.mean >= dom[0] && hp.mean <= dom[1]) {
    const lo = Math.max(dom[0], hp.min ?? hp.mean), hi = Math.min(dom[1], hp.max ?? hp.mean);
    const txt = `${S.location === "lambda" ? "λ" : S.location} ${fmtPrice(hp.mean)}`;
    if (flip) {
      if (hi > lo) priceLayer.append("rect").attr("class", "price-band").attr("x", m.l).attr("width", w - m.l - m.r)
        .attr("y", P(hi)).attr("height", Math.max(1, P(lo) - P(hi)));
      svg.append("line").attr("class", "price-rule").attr("x1", m.l).attr("x2", w - m.r).attr("y1", P(hp.mean)).attr("y2", P(hp.mean));
      svg.append("text").attr("class", "price-label").attr("x", w - m.r).attr("y", P(hp.mean) - 5).attr("text-anchor", "end").text(txt);
    } else {
      if (hi > lo) priceLayer.append("rect").attr("class", "price-band").attr("x", P(lo)).attr("width", Math.max(1, P(hi) - P(lo)))
        .attr("y", m.t).attr("height", H - m.b - m.t);
      svg.append("line").attr("class", "price-rule").attr("x1", P(hp.mean)).attr("x2", P(hp.mean)).attr("y1", m.t).attr("y2", H - m.b);
      const right = P(hp.mean) > w - m.r - 120;
      svg.append("text").attr("class", "price-label").attr("x", P(hp.mean) + (right ? -6 : 6)).attr("y", m.t + 12)
        .attr("text-anchor", right ? "end" : "start").text(txt);
    }
  }

  // hover: crosshair along the price axis
  const cross = svg.append("line").attr("class", "crosshair").style("display", "none");
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b)
    .attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const [mx, my] = d3.pointer(ev);
      const p = pScale.invert(flip ? my : mx);
      const j = d3.minIndex(prices, (q) => Math.abs(q - p));
      if (flip) cross.attr("x1", m.l).attr("x2", w - m.r).attr("y1", P(prices[j])).attr("y2", P(prices[j]));
      else cross.attr("x1", P(prices[j])).attr("x2", P(prices[j])).attr("y1", m.t).attr("y2", H - m.b);
      cross.style("display", null);
      const unit = S.mode === "share" ? "%" : " MW";
      const lines = rows.map((r) => [r.s, r.vals[j], S.mode === "share" ? null : seriesLSL(r.s, h)]).concat(demand ? [[demand.s, demand.vals[j], null]] : []);
      const withLSL = lines.some((l) => l[2] != null);
      const lslCell = (v) => (withLSL ? `<td class="n muted">${v == null ? "" : fmtMW(v)}</td>` : "");
      let html = `<h4>At or below ${fmtPrice0(prices[j])}/MWh</h4><table>` +
        (withLSL ? `<tr><th></th><th></th><th class="n">Offered</th><th class="n">of which LSL</th></tr>` : "") +
        lines.map(([s, v, l]) => `<tr><td><span class="sw ${s.id === "clr" ? "sw-line" : ""}" style="${s.id === "clr" ? "" : `background:var(${s.color})`}"></span></td><td>${s.label}</td><td class="n">${fmtMW(v)}${unit}</td>${lslCell(l)}</tr>`).join("");
      if (S.mode !== "share" && rows.length > 1) html += `<tr><td></td><td><b>Total supply</b></td><td class="n"><b>${fmtMW(d3.sum(rows, (r) => r.vals[j]))} MW</b></td>${lslCell(withLSL ? d3.sum(lines, (l) => l[2] || 0) : null)}</tr>`;
      if (withLSL) html += `</table><p class="tip-body">LSL is the minimum output of the online units: it runs at any price, so the MW SCED can move by price is what is offered above it.${curvesFromLSL() ? " The curves start at LSL and rise with the offers above it." : ""}</p><table>`;
      showTip(ev, html + "</table>");
    })
    .on("pointerleave", () => { cross.style("display", "none"); hideTip(); });

  el.replaceChildren(svg.node());
  setCSV(el, ["price_usd_mwh", ...rows.map((r) => r.s.label + (S.mode === "share" ? " (%)" : " (MW)")), ...(demand ? [demand.s.label + " (MW)"] : [])],
    prices.map((p, j) => [p, ...rows.map((r) => r.vals[j]), ...(demand ? [demand.vals[j]] : [])]), `Offer curves ${S.date} ${heLabel(h)}`);
  if (!hp) el.insertAdjacentHTML("beforeend", `<p class="note">No cleared price loaded for this day yet.</p>`);
  drawCurveTable(rows);
}

function drawCurveTable(rows) {
  const th = S.index.thresholds;
  const grid = S.index.grid;
  const cols = rows.map((r) => r.s);
  let html = `<table class="data"><thead><tr><th class="t">At or below ($/MWh)</th>${cols.map((s) => `<th>${s.label} (MW)</th>`).join("")}</tr></thead><tbody>`;
  th.forEach((t) => {
    const i = grid.indexOf(t);
    html += `<tr><td class="t">${t === -249 ? "Floor" : fmtPrice0(t)}</td>${rows.map((r) => `<td>${fmtMW(r.full[i] ?? 0)}</td>`).join("")}</tr>`;
  });
  $("curve-table").innerHTML = html + "</tbody></table>";
}

// ---- horizontal bars: one per technology, MW with share ----------------------
// rows: [{ s, mw, share }] sorted; returns the svg node.
function hBars(el, rows, tipFor) {
  const { w } = size(el);
  const narrow = w < 560;
  // on phones the technology name sits above its bar instead of to the left
  const bh = 22, lab = narrow ? 18 : 0, gap = 8 + lab, m = { t: 8 + lab, r: narrow ? 120 : 150, b: 26, l: narrow ? 8 : 220 };
  const H = m.t + m.b + rows.length * (bh + gap) - gap;
  const pct = d3.format(narrow ? ".0%" : ".1%");
  const x = d3.scaleLinear().domain([Math.min(0, d3.min(rows, (r) => r.mw)), Math.max(1, d3.max(rows, (r) => r.mw))]).nice().range([m.l, w - m.r]);
  const y = d3.scaleBand().domain(rows.map((r) => r.s.id)).range([m.t, H - m.b]).paddingInner(gap / (bh + gap));
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(narrow ? 3 : 6).tickSize(-(H - m.t - m.b)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(narrow ? 3 : 6).tickFormat(narrow ? (v) => (v ? d3.format(",")(v / 1000) + "k" : "0") : d3.format(",.0f")).tickSizeOuter(0));
  rows.forEach((r) => {
    const y0 = y(r.s.id), x0 = x(0), x1 = x(r.mw), len = Math.abs(x1 - x0);
    const g = svg.append("g");
    if (len >= 0.5) {
      // rounded at the data end, square at the zero baseline
      const rr = Math.min(4, len, bh / 2), dir = r.mw >= 0 ? 1 : -1;
      g.append("path").attr("fill", css(r.s.color)).attr("d",
        `M${x0},${y0}H${x1 - dir * rr}Q${x1},${y0} ${x1},${y0 + rr}V${y0 + bh - rr}Q${x1},${y0 + bh} ${x1 - dir * rr},${y0 + bh}H${x0}Z`);
    }
    if (narrow) g.append("text").attr("class", "mix-label").attr("x", m.l).attr("y", y0 - 5).text(r.s.label);
    else g.append("text").attr("class", "mix-label").attr("x", m.l - 10).attr("y", y0 + bh / 2).attr("dy", "0.35em").attr("text-anchor", "end").text(r.s.label);
    const val = r.valText ?? `${fmtMW(r.mw)} MW` + (r.share != null ? ` · ${pct(r.share)}` : r.mw < 0 ? " · charging" : "");
    g.append("text").attr("class", "mix-value").attr("x", Math.max(x0, x1) + 6).attr("y", y0 + bh / 2).attr("dy", "0.35em").text(val);
    g.append("rect").attr("x", 0).attr("y", y0 - gap + 4).attr("width", w).attr("height", bh + gap).attr("fill", "transparent")
      .on("pointermove", (ev) => showTip(ev, tipFor(r)))
      .on("pointerleave", hideTip);
  });
  if (x.domain()[0] < 0) svg.append("line").attr("class", "zero").attr("x1", x(0)).attr("x2", x(0)).attr("y1", m.t).attr("y2", H - m.b);
  return svg.node();
}

function barTable(rows, mwHead, shareHead, totalLabel, total) {
  return `<table class="data"><thead><tr><th class="t">Technology</th><th>${mwHead}</th><th>${shareHead}</th></tr></thead><tbody>` +
    rows.map((r) => `<tr><td class="t">${r.s.label}</td><td>${fmtMW(r.mw)}</td><td>${r.share != null ? d3.format(".1%")(r.share) : "–"}</td></tr>`).join("") +
    `<tr><td class="t"><b>${totalLabel}</b></td><td><b>${fmtMW(total)}</b></td><td></td></tr></tbody></table>`;
}

// ---- day overview: mix and price by hour, click to pick the hour --------------
function drawDay() {
  const mel = $("day-mix"), pel = $("day-price"), est = S.source !== "60d";
  $("day-title-note").textContent = S.date ? `${S.date}${est ? " · mix estimated from 2-day curves" : ""}` : "";
  const list = SERIES[S.source];
  $("day-legend").innerHTML = list.map((s) => `<span><span class="sw" style="background:var(${s.color})"></span>${s.label}</span>`).join("");
  if (!S.day) { emptyMsg(mel, "No data for this day."); pel.innerHTML = ""; return; }
  const mix = d3.range(24).map((h) => {
    const rows = mixRows(h);
    return rows && Object.fromEntries(rows.map((r) => [r.s.id, r.mw]));
  });
  const hp = d3.range(24).map((h) => hourPrice(S.prices, h));
  const pname = S.location === "lambda" ? "System lambda" : S.location;

  const { w } = size(mel);
  const m = { t: 14, r: 16, b: 26, l: 64 };
  const x = d3.scaleBand().domain(d3.range(1, 25)).range([m.l, w - m.r]).paddingInner(0.15);
  const xc = d3.scaleLinear().domain([1, 24]).range([x(1) + x.bandwidth() / 2, x(24) + x.bandwidth() / 2]);   // band centres, for hover
  const xAxis = (g, H) => g.attr("class", "axis").attr("transform", `translate(0,${H - m.b})`)
    .call(d3.axisBottom(x).tickValues([1, 4, 8, 12, 16, 20, 24]).tickFormat((d) => "HE" + d).tickSizeOuter(0));
  const tip = (i) => {
    const p = hp[i], mx = mix[i];
    let html = `<h4>${heLabel(i)}</h4>${pname}: ${p && p.mean != null ? fmtPrice(p.mean) : "–"}`;
    if (mx) {
      const tot = d3.sum(list, (s) => Math.max(0, mx[s.id] || 0));
      html += `<table>` + list.filter((s) => mx[s.id]).sort((a, b) => mx[b.id] - mx[a.id]).map((s) =>
        `<tr><td><span class="sw" style="background:var(${s.color})"></span></td><td>${s.label}</td><td class="n">${fmtMW(mx[s.id])} MW</td><td class="n">${mx[s.id] > 0 && tot ? fmtPct(mx[s.id] / tot) : ""}</td></tr>`).join("") + `</table>`;
    }
    return html + `<p class="tip-body">Click to see this hour's bid stack.</p>`;
  };

  // stacked columns: generation above zero, storage charging below
  const H = 220;
  const ext = mix.filter(Boolean).map((mx) => [d3.sum(list, (s) => Math.min(0, mx[s.id] || 0)), d3.sum(list, (s) => Math.max(0, mx[s.id] || 0))]);
  const y = d3.scaleLinear().domain([Math.min(0, d3.min(ext, (e) => e[0]) ?? 0), Math.max(1, d3.max(ext, (e) => e[1]) ?? 1)]).nice().range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").call((g) => xAxis(g, H));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y), 5).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text(`Generation by hour (MW)${est ? ", estimated" : ""}`);
  mix.forEach((mx, i) => {
    if (!mx) return;
    const op = i === S.hour ? 1 : 0.5;   // the selected hour stands out
    let up = 0, down = 0;
    list.forEach((s) => {
      const v = mx[s.id] || 0;
      if (!v) return;
      const a = v > 0 ? up : down, b = a + v;
      v > 0 ? (up = b) : (down = b);
      const top = y(Math.max(a, b)), bot = y(Math.min(a, b));
      // 1px surface gap between stacked segments
      svg.append("rect").attr("x", x(i + 1)).attr("width", x.bandwidth()).attr("y", top).attr("height", Math.max(0, bot - top - 1))
        .attr("fill", css(s.color)).attr("opacity", op);
    });
  });
  if (y.domain()[0] < 0) svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(0)).attr("y2", y(0));
  hoverHours(svg, xc, m, H, tip);
  mel.replaceChildren(svg.node());
  setCSV(mel, ["hour_ending", `${pname} mean`, `${pname} min`, `${pname} max`, ...list.map((s) => `${s.label} (MW${est ? ", estimated" : ""})`)],
    d3.range(24).map((i) => [i + 1, hp[i]?.mean, hp[i]?.min, hp[i]?.max, ...list.map((s) => (mix[i] ? mix[i][s.id] ?? null : null))]), `Price and generation by hour ${S.date}`);

  // price by hour (its own chart, never a second axis)
  if (!S.prices) { pel.innerHTML = `<p class="note">No cleared price loaded for this day yet.</p>`; return; }
  const H2 = 140;
  const vals = hp.flatMap((p) => (p ? [p.min, p.max, p.mean] : [])).filter((v) => v != null);
  const y2 = d3.scaleLinear().domain([Math.min(0, d3.min(vals) ?? 0), Math.max(10, d3.max(vals) ?? 10)]).nice().range([H2 - m.b, m.t]);
  const s2 = d3.create("svg").attr("viewBox", `0 0 ${w} ${H2}`);
  s2.append("rect").attr("class", "price-band").attr("x", x(S.hour + 1)).attr("width", x.bandwidth()).attr("y", m.t).attr("height", H2 - m.t - m.b);
  s2.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y2).ticks(4).tickSize(-(w - m.l - m.r)).tickFormat(""));
  s2.append("g").call((g) => xAxis(g, H2));
  s2.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y2), 4, "$").tickSizeOuter(0));
  if (y2.domain()[0] < 0) s2.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y2(0)).attr("y2", y2(0));
  s2.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text(`${pname} ($/MWh), hourly average and range`);
  s2.append("path").attr("fill", css("--band")).attr("d", d3.area().defined((p) => p && p.min != null).x((p, i) => xc(i + 1)).y0((p) => y2(p.min)).y1((p) => y2(p.max))(hp));
  s2.append("path").attr("fill", "none").attr("stroke", css("--price")).attr("stroke-width", 2).attr("d", d3.line().defined((p) => p && p.mean != null).x((p, i) => xc(i + 1)).y((p) => y2(p.mean))(hp));
  const sel = hp[S.hour];
  if (sel && sel.mean != null) s2.append("circle").attr("cx", xc(S.hour + 1)).attr("cy", y2(sel.mean)).attr("r", 4).attr("fill", css("--price")).attr("stroke", css("--surface")).attr("stroke-width", 2);
  hoverHours(s2, xc, m, H2, tip);
  pel.replaceChildren(s2.node());
}

// ---- curtailment ----------------------------------------------------------------
// available MW (HSL; HASL in the 2-day summary) minus base point, per hour, from both reports
const CURT = [
  { id: "wind", label: "Wind", color: "--c3", stat: "wind", gen: "wgr" },
  { id: "solar", label: "Solar", color: "--c4", stat: "solar", gen: "pvgr" },
];
function curtHours(src, t) {
  if (src === "60d") {
    const D = S.day60;
    if (!D || !D.stats || !D.stats[t.stat]) return null;
    const hi = D.stat_names.indexOf("hsl"), bi = D.stat_names.indexOf("base_point");
    if (hi < 0 || bi < 0) return null;
    return d3.range(24).map((h) => { const r = D.stats[t.stat][h]; return r && r[hi] != null && r[bi] != null ? { a: r[hi], c: Math.max(0, r[hi] - r[bi]) } : null; });
  }
  const g = S.gen && S.gen.hourly;
  if (!g) return null;
  const find = (...parts) => Object.keys(g).find((k) => parts.every((p) => k.split("_").includes(p)));
  // since RTC+B the summary has no HASL: the top of the 2-day offer curve is the summed HSL
  const ak = find("hasl", t.gen), bk = find("base", "point", t.gen);
  const top = S.day2 && S.day2.curves && S.day2.curves[t.stat];
  if (!bk || (!ak && !top)) return null;
  const avail = (h) => (ak ? g[ak][h] : top[h] && top[h].length ? top[h][top[h].length - 1] : null);
  return d3.range(24).map((h) => { const a = avail(h), b = g[bk][h]; return a != null && b != null ? { a, c: Math.max(0, a - b) } : null; });
}

function drawCurtail() {
  const el = $("curt-chart");
  $("curt-legend").innerHTML = CURT.map((s) => `<span><span class="sw" style="background:var(${s.color})"></span>${s.label}</span>`).join("");
  const by = { "60d": CURT.map((t) => curtHours("60d", t)), "2d": CURT.map((t) => curtHours("2d", t)) };
  const has = (k) => by[k].some(Boolean);
  // the 60-day disclosure whenever the day has it; the 2-day figure (an estimate, see the note)
  // only for recent days that have no 60-day data yet
  const main = has("60d") ? "60d" : "2d";
  const srcName = { "60d": "60-day disclosure", "2d": "2-day reports, estimated" };
  $("curt-title-note").textContent = S.date && has(main) ? `${S.date} · ${srcName[main]}` : "";
  if (!has(main)) return emptyMsg(el, "No curtailment data for this day yet. The 2-day generation summary fills in recent days once the data update has fetched it.");
  const hp = d3.range(24).map((h) => hourPrice(S.prices, h));
  const pname = S.location === "lambda" ? "System lambda" : S.location;
  const { w } = size(el);
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
        .attr("fill", css(t.color)).attr("opacity", h === S.hour ? 1 : 0.6);
      acc += r.c;
    });
  });
  const row = (k, j, h) => { const r = by[k][j] && by[k][j][h]; return r ? `${fmtMW(r.c)} MW <span class="muted">of ${fmtMW(r.a)} (${r.a > 0 ? fmtPct(r.c / r.a) : "–"})</span>` : "–"; };
  hoverHours(svg, xc, m, H, (h) => `<h4>${heLabel(h)}</h4>${pname}: ${hp[h] && hp[h].mean != null ? fmtPrice(hp[h].mean) : "–"}<table>` +
    CURT.map((t, j) => `<tr><td><span class="sw" style="background:var(${t.color})"></span></td><td>${t.label}</td><td class="n">${row(main, j, h)}</td></tr>`).join("") + "</table>" +
    (main === "2d" ? `<p class="tip-body">Estimated from the 2-day reports until this day's 60-day disclosure is out.</p>` : ""));
  el.replaceChildren(svg.node());
  const cols = ["hour_ending", `${pname} mean`];
  CURT.forEach((t) => cols.push(`${t.label} curtailed MW (${main})`, `${t.label} available MW (${main})`));
  setCSV(el, cols, d3.range(24).map((h) => [h + 1, hp[h]?.mean, ...CURT.flatMap((t, j) => {
    const r = by[main][j] && by[main][j][h]; return [r ? r.c : null, r ? r.a : null];
  })]), `Wind and solar curtailment ${S.date}`);
}

// ---- generation mix ----------------------------------------------------------
// 60-day: telemetered output by technology. 2-day: estimated as each curve's MW at or
// below the hour's average system lambda (the curves carry no output figures).
function mixRows(h) {
  const D = S.day;
  if (!D || !D.runs[h]) return null;
  if (S.source === "60d") {
    const oi = D.stat_names.indexOf("output");
    return SERIES["60d"].map((s) => ({ s, mw: d3.sum(s.keys, (k) => (D.stats[k] && D.stats[k][h] && D.stats[k][h][oi]) || 0) }));
  }
  const lam = S.prices && S.prices.lambda && S.prices.lambda.hourly_mean[h];
  if (lam == null) return null;
  const i = d3.bisectRight(S.index.grid, lam) - 1;
  return SERIES["2d"].map((s) => {
    const c = seriesCurves(D, s, S.version), r = c && c[h];
    return r && { s, mw: i < 0 ? (s.id === "storage" ? r[0] ?? 0 : 0) : r[i] ?? 0 };
  }).filter(Boolean);
}

function drawMix() {
  const el = $("mix-chart"), tel = $("mix-table");
  const h = S.hour, est = S.source !== "60d";
  $("mix-title-note").textContent = S.date ? `${S.date} · ${heLabel(h)}${est ? " · estimated" : ""}` : "";
  const clear = (msg) => { tel.innerHTML = ""; emptyMsg(el, msg); };
  if (!S.day) return clear("No data for this day.");
  if (!S.day.runs[h]) return clear(`No SCED runs recorded in ${heLabel(h)} (daylight-saving change).`);
  const rows = mixRows(h);
  if (!rows) return clear("No system lambda loaded for this day yet, so output can't be estimated from the 2-day curves.");
  // share of generation: storage counts only while discharging (net positive)
  const total = d3.sum(rows, (r) => Math.max(0, r.mw));
  rows.forEach((r) => (r.share = total > 0 && r.mw > 0 ? r.mw / total : null));
  rows.sort((a, b) => b.mw - a.mw);
  const what = est ? "Estimated output" : "Net output";
  el.replaceChildren(hBars(el, rows, (r) => `<h4>${r.s.label} · ${heLabel(h)}</h4><table>
        <tr><td>${what}</td><td class="n">${fmtMW(r.mw)} MW</td></tr>
        <tr><td>Share of generation</td><td class="n">${r.share != null ? d3.format(".1%")(r.share) : "–"}</td></tr>
        <tr><td>Total generation</td><td class="n">${fmtMW(total)} MW</td></tr></table>${r.s.id === "storage" ? `<p class="tip-body">Net of charging. Counted in the share only while discharging.</p>` : ""}`));
  const lam = est ? S.prices.lambda.hourly_mean[h] : null;
  el.insertAdjacentHTML("beforeend", `<p class="note">${est
    ? `Estimated: MW each group offers at or below the hour's average system lambda (${fmtPrice(lam)}), from the hourly-averaged 2-day curves. The 2-day report has no output figures. Against the 60-day telemetered output this runs about 8% high for wind and solar (it counts available output, before curtailment) and is typically within about 8% for thermal in a given hour. Days with the 60-day disclosure (about two months back and older) show measured output with thermal split by technology.`
    : "Telemetered net output from the 60-day disclosure, averaged over the SCED runs in the hour."} Total generation ${fmtMW(total)} MW. Storage is shown net of charging and counts toward the total only while discharging.</p>`);
  tel.innerHTML = barTable(rows, `${what} (MW)`, "Share of generation", "Total generation", total);
  setCSV(el, ["technology", `${what} (MW)`, "share_of_generation"], rows.map((r) => [r.s.label, r.mw, r.share]), `Generation mix ${S.date} ${heLabel(h)}`);
}

// ---- marginal supply: MW offered within the hour's cleared price range ------
// Price window for an hour: the cleared range, widened to at least ±$1 around the average.
function priceWindow(hp) {
  return [Math.min(hp.min ?? hp.mean, hp.mean - 1), Math.max(hp.max ?? hp.mean, hp.mean + 1)];
}
// MW each technology offers between lo and hi (inclusive) in hour h, from the hourly curves.
// Storage at the margin is split by the side of its curve: below zero MW it is charging
// (bidding to buy, so it takes less as price rises), above zero it is discharging.
const STORAGE_SPLIT = [
  { id: "storage_charging", keys: ["storage"], part: "chg", label: "Storage charging (bids to buy)", color: "--c7-soft" },
  { id: "storage_discharging", keys: ["storage"], part: "dis", label: "Storage discharging", color: "--c7" },
];
// charging as a share of supply can pass 100% when little supply moves, so the charts draw it
// no deeper than 100% (the readouts give the real value)
const CHG_AXIS_MAX = 1;
function marginalSeries(list) { return list.flatMap((s) => (s.id === "storage" ? STORAGE_SPLIT : [s])); }

function marginalRows(h, hp) {
  const grid = S.index.grid;
  const [lo, hi] = priceWindow(hp);
  const iHi = d3.bisectRight(grid, hi) - 1, iLo = d3.bisectLeft(grid, lo) - 1;   // last point <= hi, last point < lo
  const rows = marginalSeries(seriesList()).map((s) => {
    const c = seriesCurves(S.day, s, S.version, true), r = c && c[h];
    if (!r) return null;
    const at = (i) => (i < 0 ? (s.keys[0] === "storage" ? r[0] ?? 0 : 0) : r[i] ?? 0);
    const a = at(iLo), b = at(iHi);
    const mw = s.part === "chg" ? Math.min(b, 0) - Math.min(a, 0) : s.part === "dis" ? Math.max(b, 0) - Math.max(a, 0) : b - a;
    return { s, mw: Math.max(0, mw) };
  }).filter(Boolean);
  // supply shares add to 100% of supply; battery charging is demand, so it is kept out of them
  // and shown as a share of that supply (it can pass 100% when little supply moves)
  const supply = rows.filter((r) => r.s.part !== "chg"), chg = rows.find((r) => r.s.part === "chg");
  const total = d3.sum(supply, (r) => r.mw), chgMW = chg ? chg.mw : 0;
  supply.forEach((r) => (r.share = total > 0 ? r.mw / total : null));
  if (chg) chg.share = total > 0 ? chgMW / total : null;
  return { rows, supply, chg, total, chgMW, lo, hi };
}

function drawMarginal() {
  const el = $("marg-chart"), del = $("marg-day"), tel = $("marg-table");
  const h = S.hour;
  const pname = S.location === "lambda" ? "system lambda" : S.location;
  $("marg-title-note").textContent = S.date ? `${S.date} · ${heLabel(h)} · ${S.location === "lambda" ? "System lambda" : S.location} · ${dispNote()}` : "";
  const clear = (msg) => { emptyMsg(el, msg); del.innerHTML = ""; tel.innerHTML = ""; };
  if (!S.day) return clear("No data for this day.");
  if (!S.prices) return clear("No cleared price loaded for this day yet.");
  const hp = hourPrice(S.prices, h);
  if (!S.day.runs[h] || !hp || hp.mean == null) return clear(`No SCED runs or price recorded in ${heLabel(h)}.`);

  const m0 = marginalRows(h, hp), { total, chg, chgMW, lo, hi } = m0;
  // technologies with nothing at the margin are left off the bars (they stay in the table)
  const all = m0.supply.sort((a, b) => b.mw - a.mw), rows = all.filter((r) => r.mw >= 1);
  if (!rows.length && chgMW < 1) return clear(`No MW offered within ${heLabel(h)}'s cleared price range.`);
  const win = `${fmtPrice(lo)} to ${fmtPrice(hi)}`;
  // battery charging is drawn on the other side of zero: it is demand that drops out as price rises
  const bars = rows.concat(chg && chgMW >= 1 ? [{ ...chg, mw: -chgMW, valText: `${fmtMW(chgMW)} MW · ${d3.format(".0%")(chg.share)} of supply` }] : []);
  el.replaceChildren(hBars(el, bars, (r) => r.s.part === "chg"
    ? `<h4>${r.s.label} · ${heLabel(h)}</h4><table>
      <tr><td>Charging that stops from ${win}</td><td class="n">${fmtMW(chgMW)} MW</td></tr>
      <tr><td>As a share of supply in the window</td><td class="n">${d3.format(".1%")(r.share)}</td></tr></table>
      <p class="tip-body">Batteries bidding to charge below this price stop charging as price rises. That is demand stepping back, not supply, so it is kept out of the supply shares.</p>`
    : `<h4>${r.s.label} · ${heLabel(h)}</h4><table>
      <tr><td>Offered from ${win}</td><td class="n">${fmtMW(r.mw)} MW</td></tr>
      <tr><td>Share of marginal supply</td><td class="n">${r.share != null ? d3.format(".1%")(r.share) : "–"}</td></tr></table>`));
  el.insertAdjacentHTML("beforeend", `<p class="note">${fmtMW(total)} MW of supply offered from ${win}${chgMW >= 1 ? `, and ${fmtMW(chgMW)} MW of battery charging that stops in the same window` : ""} (${pname} averaged ${fmtPrice(hp.mean)} in ${heLabel(h)}).</p>`);
  tel.innerHTML = barTable(all, `MW offered ${win}`, "Share of marginal supply", "Total supply", total) +
    (chg ? `<p class="note">Storage charging (bids to buy) that stops in the window: ${fmtMW(chgMW)} MW (${chg.share != null ? d3.format(".1%")(chg.share) : "–"} of supply).</p>` : "");
  setCSV(el, ["technology", `MW from ${lo} to ${hi}`, "share_of_marginal_supply"], all.map((r) => [r.s.label, r.mw, r.share])
    .concat(chg ? [[chg.s.label, chgMW, null], ["storage charging as share of supply", null, chg.share]] : []), `Marginal supply ${S.date} ${heLabel(h)}`);

  // by hour: supply shares above zero (100% stacked), charging below as a share of supply
  const list = marginalSeries(seriesList()).filter((s) => s.part !== "chg");
  const hours = d3.range(24).map((i) => {
    const p = hourPrice(S.prices, i);
    if (!S.day.runs[i] || !p || p.mean == null) return null;
    const m = marginalRows(i, p);
    if (!(m.total > 0) && !(m.chgMW > 0)) return null;
    return { sh: Object.fromEntries(m.supply.map((r) => [r.s.id, r.share || 0])), chg: m.chg ? m.chg.share || 0 : 0 };
  });
  const { w } = size(del);
  const H = 230, m = { t: 14, r: 16, b: 26, l: 64 };
  const x = d3.scaleBand().domain(d3.range(1, 25)).range([m.l, w - m.r]).paddingInner(0.15);
  const lowest = -Math.min(CHG_AXIS_MAX, Math.max(0.25, d3.max(hours, (d) => (d ? d.chg : 0)) || 0));
  const y = d3.scaleLinear().domain([lowest, 1]).nice().range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickValues([1, 4, 8, 12, 16, 20, 24]).tickFormat((d) => "HE" + d).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y), 5, "%", true).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text("Share of marginal supply by hour (above) · battery charging that stops (below)");
  hours.forEach((d, i) => {
    const cx = x(i + 1), bw = x.bandwidth();
    if (!d) return;
    const op = i === h ? 1 : 0.5;   // the selected hour stands out
    let acc = 0;
    list.forEach((s) => {
      const v = d.sh[s.id] || 0;
      if (v <= 0) return;
      // 1px surface gap between stacked segments
      const y1 = y(acc + v), y0 = y(acc);
      svg.append("rect").attr("x", cx).attr("width", bw).attr("y", y1).attr("height", Math.max(0, y0 - y1 - 1)).attr("fill", css(s.color)).attr("opacity", op);
      acc += v;
    });
    if (d.chg > 0) svg.append("rect").attr("x", cx).attr("width", bw).attr("y", y(0) + 1).attr("height", Math.max(0, y(-Math.min(d.chg, -lowest)) - y(0) - 1))
      .attr("fill", css(STORAGE_SPLIT[0].color)).attr("opacity", op);
  });
  svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(0)).attr("y2", y(0));
  hoverHours(svg, d3.scaleLinear().domain([1, 24]).range([x(1) + x.bandwidth() / 2, x(24) + x.bandwidth() / 2]), m, H, (i) => {
    const d = hours[i];
    if (!d) return `<h4>${heLabel(i)}</h4>No price or curve data`;
    return `<h4>${heLabel(i)}</h4><table>` + list.filter((s) => d.sh[s.id] > 0).sort((a, b) => d.sh[b.id] - d.sh[a.id]).map((s) =>
      `<tr><td><span class="sw" style="background:var(${s.color})"></span></td><td>${s.label}</td><td class="n">${d3.format(".0%")(d.sh[s.id])}</td></tr>`).join("") +
      (d.chg > 0 ? `<tr><td><span class="sw" style="background:var(${STORAGE_SPLIT[0].color})"></span></td><td>Storage charging (bids to buy)</td><td class="n">${d3.format(".0%")(d.chg)} of supply</td></tr>` : "") + "</table>";
  });
  del.replaceChildren(svg.node());
  setCSV(del, ["hour_ending", ...list.map((s) => `${s.label} share of marginal supply`), "storage charging as share of supply"],
    hours.map((d, i) => [i + 1, ...list.map((s) => (d ? d.sh[s.id] ?? 0 : null)), d ? d.chg : null]), `Marginal supply by hour ${S.date}`);
}

// ---- marginal offer stack by price: the slope of the day's offer curves ----------------
// Each technology's share of the MW offered around each price: who would move next if price
// landed there. Battery charging bids are demand, so they are kept out of the supply shares and
// drawn below the line as a share of the supply offered at that price. MW at the -$250 floor
// (no-offer units) are left out. Minimum output (LSL) is left out too where the day has the
// dispatchable curves; on days without them it shows as a spike at -$20/-$50.
const OS_DEFAULT = [-100, 1000];
function drawOfferStack() {
  const el = $("os-chart");
  const list = marginalSeries(seriesList());
  const chgI = list.findIndex((s) => s.part === "chg");
  const supI = list.map((s, j) => j).filter((j) => j !== chgI);
  $("os-legend").innerHTML = list.map((s) => `<span><span class="sw" style="background:var(${s.color})"></span>${s.label}</span>`).join("");
  $("os-title-note").textContent = S.date ? `${S.date} · ${S.osView === "hour" ? heLabel(S.hour) : "average of the day's hours"} · ${dispNote()}` : "";
  if (!S.day) return emptyMsg(el, "No data for this day.");
  const hours = S.osView === "hour" ? [S.hour].filter((h) => S.day.runs[h]) : d3.range(24).filter((h) => S.day.runs[h]);
  if (!hours.length) return emptyMsg(el, `No SCED runs recorded in ${heLabel(S.hour)}.`);
  const G = S.index.grid;
  // MW added between consecutive grid prices, per series, averaged over the hours
  const inc = list.map((s) => {
    const c = seriesCurves(S.day, s, S.version, true);
    return G.map((g, i) => {
      if (!c || i === 0 || g <= -249) return 0;
      let v = 0;
      hours.forEach((h) => {
        const r = c[h];
        if (!r) return;
        const a = r[i - 1] ?? 0, b = r[i] ?? 0;
        v += s.part === "chg" ? Math.min(b, 0) - Math.min(a, 0) : s.part === "dis" ? Math.max(b, 0) - Math.max(a, 0) : b - a;
      });
      return Math.max(0, v / hours.length);
    });
  });

  const { w } = size(el);
  const narrow = w < 560;
  const H = 360, m = { t: 26, r: 16, b: 30, l: 56 }, HS = 54;
  const OSR = priceAxis(S.osMin, S.osMax), OS_DOMAIN = OSR.domain;
  const x = (OSR.scale === "symlog" ? d3.scaleSymlog().constant(10) : d3.scaleLinear()).domain(OS_DOMAIN).range([m.l, w - m.r]);
  // Gaussian smoothing in screen space, so the blur looks the same at every price
  const bw = Math.max(2, (w - m.l - m.r) * 0.004);
  const xg = G.map((g) => x(g));
  const exact = S.osSmooth === "exact";
  // exact: one flat step per $ grid interval, MW in the interval / its width in $
  const exactPts = () => {
    const out = [];
    for (let i = 1; i < G.length; i++) {
      if (G[i] <= OS_DOMAIN[0] || G[i - 1] >= OS_DOMAIN[1]) continue;
      const dw = G[i] - G[i - 1], v = list.map((_, j) => inc[j][i] / dw);
      const sup = d3.sum(supI, (j) => v[j]), chg = chgI >= 0 ? v[chgI] : 0;
      const sh = v.map((t, j) => (j === chgI ? (sup > 0 ? chg / sup : 0) : sup > 0 ? t / sup : 0));
      const d = { p: G[i], mwd: v, sup, chg, sh };
      out.push({ ...d, px: x(Math.max(G[i - 1], OS_DOMAIN[0])) }, { ...d, px: x(Math.min(G[i], OS_DOMAIN[1])) });
    }
    return out;
  };
  const pts = exact ? exactPts() : d3.range(m.l, w - m.r + 1, narrow ? 2 : 3).map((px) => {
    const v = list.map((_, j) => {
      let t = 0;
      for (let i = 1; i < G.length; i++) {
        const d = (xg[i] - px) / bw;
        if (d > -3 && d < 3 && inc[j][i]) t += inc[j][i] * Math.exp(-d * d / 2);
      }
      return t;
    });
    const p = x.invert(px), dollarsPerPx = (x.invert(px + 1) - x.invert(px - 1)) / 2;
    const k = 1 / (Math.sqrt(2 * Math.PI) * bw * dollarsPerPx);   // kernel sum -> MW per $
    const sup = d3.sum(supI, (j) => v[j]), chg = chgI >= 0 ? v[chgI] : 0;
    return { px, p, mwd: v.map((t) => t * k), sup: sup * k, chg: chg * k,
      sh: v.map((t, j) => (j === chgI ? (sup > 0 ? chg / sup : 0) : sup > 0 ? t / sup : 0)) };
  });
  const maxAll = d3.max(pts, (d) => d.sup + d.chg) || 1;
  const live = pts.map((d) => d.sup + d.chg > maxAll * 1e-4);   // nothing offered: leave a gap
  const share = S.osUnit === "share";
  const chgTop = chgI >= 0 ? d3.max(pts.filter((d, i) => live[i]), (d) => d.sh[chgI]) || 0 : 0;
  const y = share ? d3.scaleLinear().domain([-Math.min(CHG_AXIS_MAX, Math.max(0.5, chgTop)), 1]).nice().range([H - m.b, m.t])
    : d3.scaleLinear().domain([-(d3.max(pts, (d) => d.chg) || 1), d3.max(pts, (d) => d.sup) || 1]).nice().range([H - m.b, m.t]);
  const val = (d, j) => (share ? d.sh[j] : d.mwd[j]);

  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H + (share ? HS + 24 : 0)}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(6).tickSize(-(w - m.l - m.r)).tickFormat(""));
  const pt = OSR.scale === "linear" ? x.ticks(narrow ? 5 : 10) : logTicks(OS_DOMAIN, narrow);
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickValues(pt).tickFormat(fmtPrice0).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`)
    .call(axisFmt(d3.axisLeft(y), 6, share ? "%" : "num", true).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10)
    .text(share ? "Share of supply offered near each price (above) · battery charging (below)" : "MW offered at each $1 of price (above: supply, below: battery charging)");
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", H - 2).attr("text-anchor", "end").text(OSR.scale === "symlog" ? "Offer price ($/MWh, compressed scale)" : "Offer price ($/MWh)");
  // supply stacked upward, charging downward, clipped to the plot
  const clipId = "os-clip-" + Math.random().toString(36).slice(2, 8);
  svg.append("clipPath").attr("id", clipId).append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b);
  const plot = svg.append("g").attr("clip-path", `url(#${clipId})`);
  const area = (y0f, y1f) => d3.area().defined((d, i) => live[i]).curve(exact ? d3.curveLinear : d3.curveMonotoneX).x((d) => d.px).y0(y0f).y1(y1f);
  let base = pts.map(() => 0);
  supI.forEach((j) => {
    const lo = base, hi = pts.map((d, i) => lo[i] + val(d, j));
    plot.append("path").attr("fill", css(list[j].color)).attr("d", area((d, i) => y(lo[i]), (d, i) => y(hi[i]))(pts));
    base = hi;
  });
  if (chgI >= 0) plot.append("path").attr("fill", css(list[chgI].color)).attr("d", area(() => y(0), (d) => y(-val(d, chgI)))(pts));
  svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(0)).attr("y2", y(0));
  // each hour's system lambda as a tick along the top; the selected hour is darker
  const lam = S.prices && S.prices.lambda ? S.prices.lambda.hourly_mean : [];
  svg.append("g").selectAll("line").data(lam.map((v, i) => ({ v, i })).filter((d) => d.v != null && d.v >= OS_DOMAIN[0] && d.v <= OS_DOMAIN[1])).join("line")
    .attr("x1", (d) => x(d.v)).attr("x2", (d) => x(d.v)).attr("y1", 14).attr("y2", 24)
    .attr("stroke", css("--ink")).attr("stroke-width", (d) => (d.i === S.hour ? 2.5 : 1.2)).attr("opacity", (d) => (d.i === S.hour ? 1 : 0.45));
  if (lam.length) svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", 10).attr("text-anchor", "end").text(`ticks: system lambda by hour, ${heLabel(S.hour)} darker`);
  if (share) {
    // how much is offered near each price, so a 100% share on a sliver of MW reads as a sliver
    const g = svg.append("g").attr("transform", `translate(0,${H + 14})`);
    const yd = d3.scaleLinear().domain([0, maxAll]).range([HS, 0]);
    g.append("path").attr("fill", css("--band-strong") || css("--muted")).attr("opacity", 0.5)
      .attr("d", d3.area().curve(d3.curveMonotoneX).x((d) => d.px).y0(HS).y1((d) => yd(d.sup + d.chg))(pts));
    g.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", HS).attr("y2", HS);
    g.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", -2).text("How much is offered near each price (relative)");
  }
  // hover
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", H - m.b).style("display", "none");
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const i = d3.minIndex(pts, (d) => Math.abs(d.px - d3.pointer(ev)[0])), d = pts[i];
      cross.style("display", null).attr("x1", d.px).attr("x2", d.px);
      if (!live[i]) return showTip(ev, `<h4>Around ${fmtPrice0(Math.round(d.p) || 0)}</h4>Almost nothing is offered near this price.`);
      const rows = supI.filter((j) => d.sh[j] > 0.005).sort((a, b) => d.sh[b] - d.sh[a]);
      showTip(ev, `<h4>Around ${fmtPrice0(Math.round(d.p) || 0)}</h4><table>` + rows.map((j) =>
        `<tr><td><span class="sw" style="background:var(${list[j].color})"></span></td><td>${list[j].label}</td><td class="n">${d3.format(".0%")(d.sh[j])}</td><td class="n">${d3.format(",.0f")(d.mwd[j])} MW</td></tr>`).join("") +
        (chgI >= 0 && d.chg > 0 ? `<tr><td><span class="sw" style="background:var(${list[chgI].color})"></span></td><td>Storage charging (bids to buy)</td><td class="n">${d3.format(".0%")(d.sh[chgI])} of supply</td><td class="n">${d3.format(",.0f")(d.chg)} MW</td></tr>` : "") +
        `</table><p class="tip-body">Supply shares add to 100% of supply offered near this price.</p>`);
    })
    .on("pointerleave", () => { cross.style("display", "none"); hideTip(); });
  el.replaceChildren(svg.node());
  setCSV(el, ["price_usd_mwh", ...supI.map((j) => `${list[j].label} share of supply`), ...supI.map((j) => `${list[j].label} MW per $1 of price`),
    ...(chgI >= 0 ? ["storage charging as share of supply", "storage charging MW per $1 of price"] : [])],
    pts.filter((d, i) => live[i]).map((d) => [Math.round(d.p * 100) / 100, ...supI.map((j) => d.sh[j]), ...supI.map((j) => d.mwd[j]), ...(chgI >= 0 ? [d.sh[chgI], d.chg] : [])]),
    `Marginal offer stack by price ${S.date}`);
}

// ---- hourly profile + price ------------------------------------------------
function drawProfile() {
  const el = $("profile-chart"), pel = $("price-chart");
  if (!S.day) { emptyMsg(el, "No data for this day."); pel.innerHTML = ""; return; }
  const gi = S.index.grid.indexOf(S.threshold);
  // follows the Offer curves chart: from LSL (online minimum output counts at every threshold, plus
  // the MW offered above it) or the curves as ERCOT prices them (minimum output at -$20/-$50)
  const fromLSL = curvesFromLSL();
  const rows = seriesList().filter((s) => !S.hidden.has(s.id)).map((s) => {
    if (fromLSL) {
      const vals = d3.range(24).map((h) => { const c = S.day.runs[h] ? chartCurve(s, h) : null; return c ? c[gi] : null; });
      return vals.some((v) => v != null) && { s, vals };
    }
    const c = seriesCurves(S.day, s, S.version);
    return c && { s, vals: c.map((r) => (r ? r[gi] : null)) };
  }).filter(Boolean);
  $("profile-title-note").textContent = S.source !== "60d" ? "" : fromLSL ? "from LSL" : "as ERCOT prices them";

  const { w } = size(el);
  const H = 240, m = { t: 14, r: 16, b: 26, l: 64 };
  const x = d3.scaleLinear().domain([1, 24]).range([m.l, w - m.r]);
  const all = rows.flatMap((r) => r.vals).filter((v) => v != null);
  const y = d3.scaleLinear().domain([Math.min(0, d3.min(all) ?? 0), Math.max(1, d3.max(all) ?? 1)]).nice().range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("rect").attr("class", "price-band").attr("x", x(S.hour + 1) - 6).attr("width", 12).attr("y", m.t).attr("height", H - m.t - m.b);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickValues([1, 4, 8, 12, 16, 20, 24]).tickFormat((d) => "HE" + d).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y), 5).tickSizeOuter(0));
  if (y.domain()[0] < 0) svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(0)).attr("y2", y(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text(`MW at or below ${S.threshold === -249 ? "the price floor" : fmtPrice0(S.threshold)}`);
  const line = d3.line().defined((d) => d != null).x((d, i) => x(i + 1)).y((d) => y(d));
  rows.forEach((r) => svg.append("path").attr("fill", "none").attr("stroke", css(r.s.color)).attr("stroke-width", 2).attr("d", line(r.vals)));
  setCSV(el, ["hour_ending", ...rows.map((r) => `${r.s.label} (MW at or below ${S.threshold})`)], d3.range(24).map((i) => [i + 1, ...rows.map((r) => r.vals[i])]), `Through the day ${S.date}`);
  hoverHours(svg, x, m, H, (i) => `<h4>${heLabel(i)}</h4><table>` + rows.map((r) =>
    `<tr><td><span class="sw" style="background:var(${r.s.color})"></span></td><td>${r.s.label}</td><td class="n">${r.vals[i] == null ? "–" : fmtMW(r.vals[i]) + " MW"}</td></tr>`).join("") + "</table>");
  el.replaceChildren(svg.node());

  // price by hour (separate chart, never a second axis)
  if (!S.prices) { pel.innerHTML = `<p class="note">No cleared price loaded for this day yet.</p>`; return; }
  const hp = d3.range(24).map((i) => hourPrice(S.prices, i));
  const H2 = 150, m2 = { t: 14, r: 16, b: 26, l: 64 };
  const vals = hp.flatMap((p) => p ? [p.min, p.max, p.mean] : []).filter((v) => v != null);
  const y2 = d3.scaleLinear().domain([Math.min(0, d3.min(vals) ?? 0), Math.max(10, d3.max(vals) ?? 10)]).nice().range([H2 - m2.b, m2.t]);
  const s2 = d3.create("svg").attr("viewBox", `0 0 ${w} ${H2}`);
  s2.append("rect").attr("class", "price-band").attr("x", x(S.hour + 1) - 6).attr("width", 12).attr("y", m2.t).attr("height", H2 - m2.t - m2.b);
  s2.append("g").attr("class", "gridline").attr("transform", `translate(${m2.l},0)`).call(d3.axisLeft(y2).ticks(4).tickSize(-(w - m2.l - m2.r)).tickFormat(""));
  s2.append("g").attr("class", "axis").attr("transform", `translate(0,${H2 - m2.b})`).call(d3.axisBottom(x).tickValues([1, 4, 8, 12, 16, 20, 24]).tickFormat((d) => "HE" + d).tickSizeOuter(0));
  s2.append("g").attr("class", "axis").attr("transform", `translate(${m2.l},0)`).call(axisFmt(d3.axisLeft(y2), 4, "$").tickSizeOuter(0));
  if (y2.domain()[0] < 0) s2.append("line").attr("class", "zero").attr("x1", m2.l).attr("x2", w - m2.r).attr("y1", y2(0)).attr("y2", y2(0));
  s2.append("text").attr("class", "axis-title").attr("x", m2.l).attr("y", 10).text(`${S.location === "lambda" ? "System lambda" : S.location} ($/MWh), hourly average and range`);
  s2.append("path").attr("fill", css("--band")).attr("d", d3.area().defined((p) => p && p.min != null).x((p, i) => x(i + 1)).y0((p) => y2(p.min)).y1((p) => y2(p.max))(hp));
  s2.append("path").attr("fill", "none").attr("stroke", css("--price")).attr("stroke-width", 2).attr("d", d3.line().defined((p) => p && p.mean != null).x((p, i) => x(i + 1)).y((p) => y2(p.mean))(hp));
  hoverHours(s2, x, m2, H2, (i) => hp[i] ? `<h4>${heLabel(i)}</h4>Average ${fmtPrice(hp[i].mean)}<br>Range ${fmtPrice(hp[i].min)} to ${fmtPrice(hp[i].max)}` : `<h4>${heLabel(i)}</h4>No price`);
  pel.replaceChildren(s2.node());
}

function hoverHours(svg, x, m, H, htmlFor) {
  const w = +svg.attr("viewBox").split(" ")[2];
  svg.attr("data-nopin", "");   // a click here picks the hour
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", H - m.b).style("display", "none");
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .style("cursor", "pointer")
    .on("pointermove", (ev) => {
      const i = Math.max(0, Math.min(23, Math.round(x.invert(d3.pointer(ev)[0])) - 1));
      cross.style("display", null).attr("x1", x(i + 1)).attr("x2", x(i + 1));
      showTip(ev, htmlFor(i));
    })
    .on("pointerleave", () => { cross.style("display", "none"); hideTip(); })
    .on("click", (ev) => {
      S.hour = Math.max(0, Math.min(23, Math.round(x.invert(d3.pointer(ev)[0])) - 1));
      $("hour").value = S.hour; render();
    });
}

// ---- explanations shown on hover / focus ---------------------------------------
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const TECH_COLS = [
  ["Technology", "Resources are grouped by the resource type ERCOT reports for each unit. Hover a technology name to see which types it includes."],
  ["Units online", "Average number of units with an online status (ON, ONRUC, ONTEST and similar) across the SCED runs in the hours shown. Units that are off or on outage are excluded from every column."],
  ["Available, HSL (MW)", "High Sustained Limit: the most the online units can produce right now, as telemetered to ERCOT. For wind and solar it follows available output from the forecast and telemetry, not nameplate capacity."],
  ["Min output, LSL (MW)", "Low Sustained Limit: the least an online unit can produce and stay online. A thermal unit cannot go below this in response to price without shutting down, so this block keeps running however low prices fall."],
  ["LSL / HSL", "Minimum output as a share of available capacity. A higher share means less room to back down when prices drop: a unit at 60% can only shed 40% of its available output before it has to shut down."],
  ["Output (MW)", "Telemetered net output, averaged over the hours shown."],
  ["Offered ≤ $0 above LSL (MW)", "MW above the units' minimum output (LSL) that the generators themselves offered at or below $0, from their submitted curves: output that SCED could back down by price but that keeps running when prices go negative. Minimum output is left out because it runs at any price, and units without an offer curve count nothing here because SCED holds them at their schedule. For wind and solar this is the whole submitted curve (they have no minimum output to speak of). Blank for storage, whose curve runs from charging to discharging."],
  ["No offer curve (MW)", "MW scheduled (the output schedule) by online units running without an offer curve. SCED holds these units at that MW whatever the price, against a stand-in curve ERCOT fills in (−$250/−$249.99 for nuclear and hydro, −$20 or −$50 for others). Nuclear units typically work this way. This is the MW that runs regardless of price because no price was offered."],
];
const TECH_NOTES = {
  combined_cycle: "Combined-cycle gas plants (resource types CCGT90 and CCLE90). Each configuration of a plant is reported as its own resource.",
  combustion_turbine: "Simple-cycle gas and oil combustion turbines (SCGT90, SCLE90): typically peakers with quick starts.",
  wind: "Wind-powered generation resources (WIND). Curves are capped at available output.",
  solar: "Photovoltaic generation resources (PVGR). Curves are capped at available output, so they shrink to zero at night.",
  nuclear: "Nuclear units (NUC). They normally run without an offer curve, held to their output schedule.",
  gas_steam: "Gas-fired steam units (GSREH reheat, GSSUP supercritical, GSNONR non-reheat).",
  storage: "Energy storage resources (ESR). Values are net: negative while charging, positive while discharging.",
  coal: "Coal and lignite units (CLLIG).",
  other: "Hydro (HYDRO), diesel (DSL), biomass and other renewables (RENEW), and any resource type not otherwise mapped.",
};
const UNIT_TIPS = {
  hours_online: "Hours of the day with an online status.",
  hsl: "High Sustained Limit averaged over the hours online.",
  lsl: "Low Sustained Limit (minimum output) averaged over the hours online.",
  output: "Telemetered net output averaged over the hours online.",
  pinned_share: "Share of online SCED runs in which the unit's base point sat at its minimum output: SCED wanted less but the unit could not go lower.",
  floor_mw: "MW priced at −$250/−$249.99 in the curve SCED used, averaged over the hours online.",
  le0_sced: "MW at or below $0 in the curve SCED used.",
  le0_submitted: "MW above minimum output (LSL) at or below $0 in the curve the generator submitted. Minimum output is left out because SCED cannot dispatch below it. Days processed before this column was read from LSL up include it.",
  min_sub_price: "Price of the first point at or above minimum output (LSL) on the submitted offer curve, lowest of the day (or of the hour). \"No curve\" marks units that ran without an offer curve, which SCED holds at their output schedule whatever the price; a unit with a curve only part of the time shows the share without one. Days processed before this column was read from LSL up show the curve's first point, which is −$250 for curves that start at 0 MW.",
  no_offer_share: "Share of online SCED runs without an offer curve.",
};

// ---- technology table (60-day) ---------------------------------------------
function drawTechTable() {
  const el = $("tech-table");
  if (!S.day || !S.day.stats) return emptyMsg(el, "No 60-day data for this day.");
  const names = S.day.stat_names;
  const col = (k) => names.indexOf(k);
  const hours = (S.ttView === "hour" ? [S.hour] : d3.range(24)).filter((h) => S.day.runs[h]);
  if (!hours.length) return emptyMsg(el, `No SCED runs recorded in ${heLabel(S.hour)}.`);
  const rows = SERIES["60d"].map((s) => {
    const avg = (k) => d3.mean(hours, (h) => d3.sum(s.keys, (key) => (S.day.stats[key] && S.day.stats[key][h] && S.day.stats[key][h][col(k)]) || 0));
    const r = { s };
    names.forEach((k) => (r[k] = avg(k)));
    return r;
  });
  // MW the generators offered above LSL at or below $0: the submitted curves with LSL taken out
  // (dispatchable block); wind and solar, which the block leaves out, use their whole submitted curve
  const i0 = gridIndex(0), disp = hasDispatchable() ? S.day.dispatchable.submitted || {} : null;
  rows.forEach((r) => {
    if (r.s.id === "storage") { r.le0_flex = null; return; }
    if (!disp) { r.le0_flex = r.le0_submitted; return; }
    const at0 = (k, h) => { const c = (disp[k] || (S.day.submitted || {})[k] || [])[h]; return (c && c[i0]) || 0; };
    r.le0_flex = d3.mean(hours, (h) => d3.sum(r.s.keys, (k) => at0(k, h)));
  });
  const head = TECH_COLS.map(([label, tip], i) =>
    `<th class="${i ? "" : "t"} has-tip" tabindex="0" data-tip-title="${esc(label)}" data-tip="${esc(tip)}">${label}</th>`);
  let html = `<table class="data"><thead><tr>${head.join("")}</tr></thead><tbody>`;
  rows.forEach((r) => {
    const st = r.s.id === "storage";
    html += `<tr><td class="t"><span class="has-tip" tabindex="0" data-tip-title="${esc(r.s.label)}" data-tip="${esc(TECH_NOTES[r.s.id] || "")}"><span class="sw" style="background:var(${r.s.color});margin-right:6px"></span>${r.s.label}</span></td>
      <td>${d3.format(",.0f")(r.n_online)}</td><td>${fmtMW(r.hsl)}</td><td>${fmtMW(r.lsl)}</td>
      <td>${r.hsl > 1 && !st ? fmtPct(r.lsl / r.hsl) : "–"}</td><td>${fmtMW(r.output)}</td>
      <td>${r.le0_flex == null ? "–" : fmtMW(r.le0_flex)}</td><td>${st ? "–" : fmtMW(r.no_offer_output_schedule)}</td></tr>`;
  });
  const span = S.ttView === "hour" ? heLabel(S.hour) : "day average";
  el.innerHTML = html + `</tbody></table><p class="note">MW are ${S.ttView === "hour" ? `averages over the SCED runs in ${heLabel(S.hour)}` : "averages over the day's hours"}. Hover a column heading or a technology name for an explanation. The CSV download has every measure, including the ones not shown here.${disp ? "" : " This day has not been reprocessed with the dispatchable curves, so \"Offered ≤ $0 above LSL\" may still include some minimum output."}</p>`;
  setCSV(el, ["technology", "hours", "le0_offered_above_lsl", ...names], rows.map((r) => [r.s.label, span, r.le0_flex, ...names.map((k) => r[k])]),
    `Inflexibility by technology ${S.date} ${span}`);
}

// ---- unit table (60-day) -----------------------------------------------------
// Day: one row per unit from the day file. Selected hour: the unit's row for that hour from
// data/60d-units/{date}.json.gz (pipeline/unit_hours_day.py), loaded when first asked for.
// Columns hidden from the table stay in the CSV download.
const UNIT_COLS = [
  ["unit", "Unit", "t"], ["type", "Type", "t"], ["hours_online", "Hours online"], ["hsl", "HSL (MW)"], ["lsl", "LSL (MW)"],
  ["output", "Output (MW)"], ["pinned_share", "Time at LSL", "pct"], ["le0_submitted", "Offered ≤ $0 above LSL (MW)"],
  ["min_sub_price", "Lowest offer price at or above LSL ($/MWh)", "offer"],
];
const UNIT_CSV = ["unit", "type", "tech", "hours_online", "hsl", "lsl", "base_point", "output", "pinned_share", "floor_mw", "le0_sced",
  "le0_submitted", "min_sub_price", "avg_sub_price", "no_offer_share"];
async function unitHourRows(date) {
  if (!S.unitHours.has(date)) S.unitHours.set(date, tryJSON(`data/60d-units/${date}.json.gz`));
  return S.unitHours.get(date);
}
async function drawUnits() {
  const el = $("units-table");
  if (!S.day || !S.day.units) return emptyMsg(el, "No 60-day data for this day.");
  const hourly = S.unitView === "hour", date = S.date, h = S.hour;
  let rows;
  if (hourly) {
    const f = await unitHourRows(date);
    if (date !== S.date || h !== S.hour || S.unitView !== "hour") return;   // a newer draw took over
    if (!f) return emptyMsg(el, "Hourly unit data for this day is not built yet. It fills in over the next data updates; the Day view has the daily table.");
    const ci = Object.fromEntries(f.columns.map((c, i) => [c, i + 2]));
    rows = f.rows.filter((r) => r[1] === h + 1).map((r) => {
      const [unit, type, tech] = f.units[r[0]];
      const o = { unit, type, tech };
      f.columns.forEach((c) => (o[c] = r[ci[c]]));
      o.hours_online = o.online_share;
      return o;
    });
  } else {
    const C = S.day.units.columns;
    rows = S.day.units.rows.map((r) => Object.fromEntries(C.map((c, i) => [c, r[i]])));
  }
  const techOf = (t) => (["hydro", "other"].includes(t) ? "other" : t);
  if (S.unitTech !== "all") rows = rows.filter((r) => techOf(r.tech) === S.unitTech);
  if (S.unitSearch) rows = rows.filter((r) => r.unit.toLowerCase().includes(S.unitSearch.toLowerCase()));
  const { key, dir } = S.unitSort;
  rows.sort((a, b) => {
    const va = a[key], vb = b[key];
    if (va == null) return 1; if (vb == null) return -1;
    return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * dir;
  });
  const span = hourly ? heLabel(h) : "day";
  setCSV(el, UNIT_CSV.map((k) => (hourly && k === "hours_online" ? "online_share" : k)).filter((k) => !(hourly && k === "avg_sub_price")),
    rows.map((r) => UNIT_CSV.filter((k) => !(hourly && k === "avg_sub_price")).map((k) => r[k])), `Units ${date} ${span}`);
  const total = rows.length;
  if (!S.unitShowAll) rows = rows.slice(0, 150);
  // the lowest offer price, or "No curve" for units that ran without one (with the share of
  // the time when they had a curve only part of it)
  const offer = (r) => {
    const nc = r.no_offer_share || 0;
    if (r.min_sub_price == null) return nc > 0 ? "No curve" : "–";
    return fmtPrice(r.min_sub_price) + (nc >= 0.005 ? ` <span class="muted">· no curve ${fmtPct(nc)}</span>` : "");
  };
  const fmt = (r, k, kind) => kind === "offer" ? offer(r) : r[k] == null ? "–" : kind === "pct" ? fmtPct(r[k])
    : kind === "t" ? esc(r[k]) : k === "hours_online" && hourly ? fmtPct(r[k]) : d3.format(hourly ? ",.0f" : ",.1f")(r[k]);   // hourly rows are whole MW
  const label = (k, l) => (hourly && k === "hours_online" ? "Online" : l);
  const tip = (k) => (hourly && k === "hours_online" ? "Share of the hour's SCED runs with an online status." : UNIT_TIPS[k]);
  let html = `<div class="units-wrap"><table class="data"><thead><tr>${UNIT_COLS.map(([k, l, kind]) =>
    `<th class="sortable ${kind === "t" ? "t" : ""}${tip(k) ? " has-tip" : ""}" data-k="${k}"${tip(k) ? ` data-tip-title="${esc(label(k, l))}" data-tip="${esc(tip(k))}"` : ""} aria-sort="${k === key ? (dir > 0 ? "ascending" : "descending") : "none"}">${label(k, l)}${k === key ? (dir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead><tbody>`;
  html += rows.map((r) => `<tr>${UNIT_COLS.map(([k, , kind]) => `<td class="${kind === "t" ? "t" : ""}">${fmt(r, k, kind)}</td>`).join("")}</tr>`).join("");
  el.innerHTML = html + "</tbody></table></div>";
  const what = hourly ? `Units online in ${heLabel(h)}` : "Units";
  $("units-foot").innerHTML = (total > rows.length
    ? `Showing ${rows.length} of ${total} units. <button type="button" id="units-all" class="linkish">Show all</button>`
    : `${what}: ${total}.`) + " The CSV download has every measure, including the ones not shown here.";
  const b = $("units-all");
  if (b) b.onclick = () => { S.unitShowAll = true; drawUnits(); };
}

// ---- price duration -----------------------------------------------------------
function drawDuration() {
  const el = $("duration-chart");
  const summ = S.summaries.prices || {};
  const vals = Object.values(summ).flatMap((e) => (S.location === "lambda" ? e.lambda : (e.spp || {})[S.location]) || []).filter((v) => v != null);
  if (vals.length < 2) return emptyMsg(el, "Price history appears here as days with prices are loaded.");
  vals.sort((a, b) => b - a);
  const { w } = size(el);
  const H = 200, m = { t: 14, r: 16, b: 30, l: 64 };
  const x = d3.scaleLinear().domain([0, 100]).range([m.l, w - m.r]);
  const ext = d3.extent(vals);
  const y = d3.scaleSymlog().constant(20).domain([Math.min(0, ext[0]), Math.max(50, ext[1])]).range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  const yt = [-250, -50, 0, 25, 50, 100, 500, 1000, 5000].filter((v) => v >= y.domain()[0] && v <= y.domain()[1]);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).tickValues(yt).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(5).tickFormat((d) => d + "%").tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).tickValues(yt).tickFormat(fmtPrice0).tickSizeOuter(0));
  svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(0)).attr("y2", y(0));
  svg.append("path").attr("fill", "none").attr("stroke", css("--price")).attr("stroke-width", 2)
    .attr("d", d3.line().x((v, i) => x((i / (vals.length - 1)) * 100)).y((v) => y(v))(vals));
  const below = vals.filter((v) => v <= S.threshold).length / vals.length;
  const pname = S.location === "lambda" ? "System lambda" : `${S.location} settlement point price`;
  $("dur-title-note").textContent = S.location === "lambda" ? "System lambda" : S.location;
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text(`${pname} ($/MWh), hourly average`);
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", 10).attr("text-anchor", "end")
    .text(`${vals.length.toLocaleString()} hours · ${fmtPct(below)} at or below ${S.threshold === -249 ? "the floor" : fmtPrice0(S.threshold)}`);
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", H - 4).attr("text-anchor", "end").text("Share of hours above the price");
  // the selected day's hours on the curve: where each sat in the distribution, the selected hour as a dot
  const pctAbove = (v) => (d3.bisectLeft(vals.map((q) => -q), -v) / (vals.length - 1)) * 100;   // vals sorted high to low
  const hp = d3.range(24).map((i) => hourPrice(S.prices, i));
  const dayPts = hp.map((p, i) => (p && p.mean != null ? { i, v: p.mean, x: pctAbove(p.mean) } : null)).filter(Boolean);
  svg.append("g").selectAll("line").data(dayPts.filter((d) => d.i !== S.hour)).join("line")
    .attr("x1", (d) => x(d.x)).attr("x2", (d) => x(d.x)).attr("y1", (d) => y(d.v) - 5).attr("y2", (d) => y(d.v) + 5)
    .attr("stroke", css("--accent")).attr("stroke-width", 1.5).attr("opacity", 0.6);
  const sel = dayPts.find((d) => d.i === S.hour);
  if (sel) {
    svg.append("circle").attr("cx", x(sel.x)).attr("cy", y(sel.v)).attr("r", 5).attr("fill", css("--accent")).attr("stroke", css("--surface")).attr("stroke-width", 2);
    const right = x(sel.x) > w - m.r - 230;
    svg.append("text").attr("class", "price-label").attr("x", x(sel.x) + (right ? -10 : 10)).attr("y", y(sel.v) - 8).attr("text-anchor", right ? "end" : "start")
      .text(`${S.date} ${heLabel(S.hour)} · ${fmtPrice(sel.v)}, above ${fmtPct(1 - sel.x / 100)} of hours`);
  }
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", H - m.b).style("display", "none");
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const q = Math.max(0, Math.min(100, x.invert(d3.pointer(ev)[0]))), v = vals[Math.round((q / 100) * (vals.length - 1))];
      cross.style("display", null).attr("x1", x(q)).attr("x2", x(q));
      showTip(ev, `<h4>${pname}</h4>${fmtPct(q / 100)} of hours were above ${fmtPrice(v)}`);
    })
    .on("pointerleave", () => { cross.style("display", "none"); hideTip(); });
  el.replaceChildren(svg.node());
  setCSV(el, ["share_of_hours_above", `${pname} ($/MWh)`], vals.map((v, i) => [i / (vals.length - 1), v]), "Price duration");
}

// ---------------------------------------------------------------- boot ---
async function boot() {
  try {
    S.index = await getJSON("data/index.json");
  } catch (e) {
    $("status").textContent = "No data yet. Run the pipeline to fetch ERCOT reports (see README).";
    return;
  }
  const [s2, s60, sp] = await Promise.all([tryJSON("data/summary_2d.json.gz"), tryJSON("data/summary_60d.json.gz"), tryJSON("data/summary_prices.json.gz")]);
  S.summaries = { "2d": s2 || {}, "60d": s60 || {}, prices: sp || {} };
  const D = S.index.days;
  const last = (a) => (a.length ? [...a].sort().at(-1) : "none");
  $("status").textContent = `2-day: ${D["2d"].length} day(s), latest ${last(D["2d"])} · 60-day: ${D["60d"].length} day(s), latest ${last(D["60d"])} · prices: ${D.prices.length} day(s) · updated ${S.index.updated.replace("T", " ").replace("Z", " UTC")}`;

  loadView();
  $("hour").value = S.hour;
  setSeg("version", S.version); setSeg("xrange", S.xrange); setSeg("mode", S.mode); setSeg("axes", S.axes);
  fillDates(); syncSource(); fillLocations(); fillThresholds(); fillTechSelects();

  bindSeg("version", "version");
  // Custom price range: the boxes start from the range that was showing
  const syncXr = () => {
    $("xrange-custom").hidden = S.xrange !== "custom";
    const d = priceAxis(S.xMin, S.xMax).domain;
    $("xr-min").value = d[0]; $("xr-max").value = d[1];
  };
  let lastPreset = S.xrange === "custom" ? "low" : S.xrange;
  bindSeg("xrange", "xrange", () => {
    if (S.xrange === "custom") {
      if (lastPreset) [S.xMin, S.xMax] = rangeFor(lastPreset).domain;
      lastPreset = null;
    } else lastPreset = S.xrange;
    syncXr(); render();
  });
  const readRange = (minId, maxId, keys) => {
    const d = priceAxis(parseFloat($(minId).value), parseFloat($(maxId).value)).domain;
    [S[keys[0]], S[keys[1]]] = d;
    $(minId).value = d[0]; $(maxId).value = d[1];
  };
  ["xr-min", "xr-max"].forEach((id) => $(id).addEventListener("change", () => { readRange("xr-min", "xr-max", ["xMin", "xMax"]); render(); }));
  syncXr();
  const syncOs = () => { const d = priceAxis(S.osMin, S.osMax).domain; $("os-min").value = d[0]; $("os-max").value = d[1]; };
  ["os-min", "os-max"].forEach((id) => $(id).addEventListener("change", () => { readRange("os-min", "os-max", ["osMin", "osMax"]); drawOfferStack(); saveView(); }));
  $("os-reset").onclick = () => { [S.osMin, S.osMax] = OS_DEFAULT; syncOs(); drawOfferStack(); saveView(); };
  syncOs();
  bindSeg("mode", "mode");
  bindSeg("axes", "axes");
  if (!["from_lsl", "ercot"].includes(S.lslMode)) S.lslMode = "from_lsl";
  setSeg("lsl-mode", S.lslMode); bindSeg("lsl-mode", "lslMode");
  setSeg("os-view", S.osView); setSeg("os-unit", S.osUnit);
  bindSeg("os-view", "osView", drawOfferStack);
  setSeg("tt-view", S.ttView); bindSeg("tt-view", "ttView", drawTechTable);
  if (!["day", "hour"].includes(S.unitView)) S.unitView = "day";
  setSeg("unit-view", S.unitView); bindSeg("unit-view", "unitView", () => { S.unitShowAll = false; drawUnits(); saveView(); });
  bindSeg("os-unit", "osUnit", drawOfferStack);
  setSeg("os-smooth", S.osSmooth); bindSeg("os-smooth", "osSmooth", drawOfferStack);
  $("date").onchange = async (e) => { S.date = e.target.value; await changeDay(); };
  // step one available day older (-1) or newer (+1)
  const stepDay = async (dir) => {
    const days = allDays();
    const i = days.indexOf(S.date) + dir;
    if (i < 0 || i >= days.length) return;
    S.date = days[i]; $("date").value = S.date;
    await changeDay();
  };
  $("date-prev").onclick = () => stepDay(-1);
  $("date-next").onclick = () => stepDay(1);
  $("hour").oninput = (e) => { S.hour = +e.target.value; render(); };
  $("location").onchange = (e) => { S.location = e.target.value; render(); };
  $("threshold").onchange = (e) => { S.threshold = +e.target.value; render(); };
  $("unit-tech").onchange = (e) => { S.unitTech = e.target.value; S.unitShowAll = false; drawUnits(); };
  $("unit-search").oninput = (e) => { S.unitSearch = e.target.value; drawUnits(); };
  $("units-table").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-k]");
    if (!th) return;
    const k = th.dataset.k;
    S.unitSort = { key: k, dir: S.unitSort.key === k ? -S.unitSort.dir : (["unit", "type"].includes(k) ? 1 : -1) };
    drawUnits();
  });
  $("legend").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-id]");
    if (!b) return;
    const id = b.dataset.id;
    S.hidden.has(id) ? S.hidden.delete(id) : S.hidden.add(id);
    render();
  });

  // explainer tooltips: hover, keyboard focus, or tap
  const tipFor = (el) => `<h4>${esc(el.dataset.tipTitle || "")}</h4><p class="tip-body">${esc(el.dataset.tip)}</p>`;
  const tipAt = (el) => { const r = el.getBoundingClientRect(); return { clientX: r.left, clientY: r.bottom - 6 }; };
  document.addEventListener("pointerover", (e) => { const el = e.target.closest("[data-tip]"); if (el && e.pointerType === "mouse") showTip(e, tipFor(el)); });
  document.addEventListener("pointermove", (e) => { const el = e.target.closest("[data-tip]"); if (el && e.pointerType === "mouse") showTip(e, tipFor(el)); });
  document.addEventListener("pointerout", (e) => { const el = e.target.closest("[data-tip]"); if (el && !el.contains(e.relatedTarget)) hideTip(); });
  document.addEventListener("focusin", (e) => { const el = e.target.closest("[data-tip]"); if (el) showTip(tipAt(el), tipFor(el)); });
  document.addEventListener("focusout", (e) => { if (e.target.closest("[data-tip]")) hideTip(); });
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-tip]");
    if (el && e.pointerType !== "mouse" && !el.dataset.k) showTip(tipAt(el), tipFor(el));
  });

  window.CX.init();
  let t, lastW = 0;
  // redraw on width changes only (the page grows as charts draw, which would loop)
  new ResizeObserver((e) => { const w = Math.round(e[0].contentRect.width); if (w === lastW) return; lastW = w; clearTimeout(t); t = setTimeout(render, 120); }).observe(document.querySelector("main"));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
  new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  await changeDay();
  window.CX.panelFromLink();
}
boot();
})();

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

const RANGES = {
  low: { domain: [-250, 100], scale: "linear" },
  mid: { domain: [-250, 300], scale: "linear" },
  full: { domain: [-250, 5000], scale: "symlog" },
};

// ----------------------------------------------------------------- state ---
const S = {
  index: null, source: "2d", date: null, hour: 12, version: "curves",
  xrange: "low", mode: "lines", axes: "price_x", threshold: 0, location: "lambda",
  hidden: new Set(), heatTech: null, unitTech: "all", unitSearch: "",
  unitSort: { key: "floor_mw", dir: -1 }, unitShowAll: false,
  day: null, prices: null, summaries: {}, mbpDays: "all", mbpUnit: "share",
};
const cache = new Map();
const $ = (id) => document.getElementById(id);
const fmtMW = d3.format(",.0f");
const fmtPrice = (v) => (v == null || isNaN(v) ? "–" : d3.format("$,.2f")(v));
const fmtPrice0 = (v) => d3.format("$,.0f")(v);
const fmtPct = d3.format(".0%");
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const heLabel = (h) => `HE ${h + 1}`;

// ------------------------------------------------------------------ data ---
async function getJSON(url) {
  if (cache.has(url)) return cache.get(url);
  const p = (async () => {
    const r = await fetch(url, { cache: "no-cache" });
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    let text;
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
      const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
      text = await new Response(stream).text();
    } else {
      text = new TextDecoder().decode(buf);
    }
    return JSON.parse(text);
  })();
  cache.set(url, p);
  p.catch(() => cache.delete(url));
  return p;
}
const tryJSON = (url) => getJSON(url).catch(() => null);

function seriesList() { return SERIES[S.source]; }
function gridIndex(price) {
  const g = S.index.grid;
  let best = 0;
  for (let i = 0; i < g.length; i++) if (Math.abs(g[i] - price) < Math.abs(g[best] - price)) best = i;
  return best;
}

/** [24][G] array for a series (summing component keys), or null. */
function seriesCurves(day, s, version) {
  const block = day[version === "submitted" && S.source === "60d" ? "submitted" : "curves"];
  const parts = s.keys.map((k) => block && block[k]).filter(Boolean);
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

function fillDates() {
  const days = [...S.index.days[S.source]].sort().reverse();
  const withPrices = new Set(S.index.days.prices);
  $("date").innerHTML = days.map((d) => {
    const label = d3.timeFormat("%a %b %-d, %Y")(new Date(d + "T12:00:00"));
    return `<option value="${d}">${label}${withPrices.has(d) ? "" : " (no prices yet)"}</option>`;
  }).join("");
  if (!days.includes(S.date)) S.date = days[0] || null;
  $("date").value = S.date || "";
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
  const list = seriesList();
  if (!list.some((s) => s.id === S.heatTech)) S.heatTech = list[0].id;
  $("heat-tech").innerHTML = list.map((s) => `<option value="${s.id}">${s.label}</option>`).join("");
  $("heat-tech").value = S.heatTech;
  $("unit-tech").innerHTML = `<option value="all">All</option>` +
    SERIES["60d"].map((s) => `<option value="${s.id}">${s.label}</option>`).join("");
  $("unit-tech").value = S.unitTech;
}

// ------------------------------------------------------------ rendering ---
async function loadDay() {
  if (!S.date) { S.day = null; S.prices = null; return; }
  const [day, prices] = await Promise.all([
    tryJSON(`data/${S.source}/${S.date}.json.gz`),
    tryJSON(`data/prices/${S.date}.json.gz`),
  ]);
  S.day = day; S.prices = prices;
}

async function changeDay() {
  await loadDay();
  render();
}

function render() {
  const is60 = S.source === "60d";
  const days = S.index ? [...S.index.days[S.source]].sort() : [];
  const di = days.indexOf(S.date);
  $("date-prev").disabled = di <= 0;
  $("date-next").disabled = di < 0 || di >= days.length - 1;
  $("ctl-version").hidden = !is60;
  $("thermal-panel").hidden = !is60;
  $("units-panel").hidden = !is60;
  $("hour-out").textContent = `${heLabel(S.hour)} · ${String(S.hour).padStart(2, "0")}:00–${String(S.hour + 1).padStart(2, "0")}:00`;
  $("curve-title-note").textContent = S.date ? `${S.date} · ${heLabel(S.hour)}` : "";
  renderLegend();
  drawCurves();
  drawMix();
  drawMarginal();
  drawMarginalByPrice();
  drawProfile();
  drawHeatmap();
  if (is60) { drawTechTable(); drawUnits(); }
  drawDuration();
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
  const R = RANGES[S.xrange];
  const dom = [R.domain[0], Math.min(R.domain[1], grid[grid.length - 1])];
  const idx = grid.map((p, i) => i).filter((i) => grid[i] >= dom[0] && grid[i] <= dom[1]);
  const prices = idx.map((i) => grid[i]);
  const flip = S.axes === "price_y";          // classic supply-curve orientation: MW across, price up

  const visible = seriesList().filter((s) => !S.hidden.has(s.id));
  const rows = visible.map((s) => {
    const c = seriesCurves(S.day, s, S.version);
    const r = c && c[h];
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
  const priceTicks = R.scale === "symlog" ? [-250, -100, -25, 0, 25, 100, 300, 1000, 5000]
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
      const lines = rows.map((r) => [r.s, r.vals[j]]).concat(demand ? [[demand.s, demand.vals[j]]] : []);
      let html = `<h4>At or below ${fmtPrice0(prices[j])}/MWh</h4><table>` +
        lines.map(([s, v]) => `<tr><td><span class="sw ${s.id === "clr" ? "sw-line" : ""}" style="${s.id === "clr" ? "" : `background:var(${s.color})`}"></span></td><td>${s.label}</td><td class="n">${fmtMW(v)}${unit}</td></tr>`).join("");
      if (S.mode !== "share" && rows.length > 1) html += `<tr><td></td><td><b>Total supply</b></td><td class="n"><b>${fmtMW(d3.sum(rows, (r) => r.vals[j]))} MW</b></td></tr>`;
      showTip(ev, html + "</table>");
    })
    .on("pointerleave", () => { cross.style("display", "none"); hideTip(); });

  el.replaceChildren(svg.node());
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
    const val = `${fmtMW(r.mw)} MW` + (r.share != null ? ` · ${pct(r.share)}` : r.mw < 0 ? " · charging" : "");
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

// ---- generation mix ----------------------------------------------------------
// 60-day: telemetered output by technology. 2-day: estimated as each curve's MW at or
// below the hour's average system lambda (the curves carry no output figures).
function mixRows(h) {
  const D = S.day;
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
    ? `Estimated: MW each group offers at or below the hour's average system lambda (${fmtPrice(lam)}), from the hourly-averaged 2-day curves. The 2-day report has no output figures. Against the 60-day telemetered output this runs about 8% high for wind and solar (it counts available output, before curtailment) and is typically within about 8% for thermal in a given hour. Switch to the 60-day report for measured output and a split of thermal by technology.`
    : "Telemetered net output from the 60-day disclosure, averaged over the SCED runs in the hour."} Total generation ${fmtMW(total)} MW. Storage is shown net of charging and counts toward the total only while discharging.</p>`);
  tel.innerHTML = barTable(rows, `${what} (MW)`, "Share of generation", "Total generation", total);
}

// ---- marginal supply: MW offered within the hour's cleared price range ------
// Price window for an hour: the cleared range, widened to at least ±$1 around the average.
function priceWindow(hp) {
  return [Math.min(hp.min ?? hp.mean, hp.mean - 1), Math.max(hp.max ?? hp.mean, hp.mean + 1)];
}
// MW each technology offers between lo and hi (inclusive) in hour h, from the hourly curves.
function marginalRows(h, hp) {
  const grid = S.index.grid;
  const [lo, hi] = priceWindow(hp);
  const iHi = d3.bisectRight(grid, hi) - 1, iLo = d3.bisectLeft(grid, lo) - 1;   // last point <= hi, last point < lo
  const rows = seriesList().map((s) => {
    const c = seriesCurves(S.day, s, S.version), r = c && c[h];
    if (!r) return null;
    const at = (i) => (i < 0 ? (s.id === "storage" ? r[0] ?? 0 : 0) : r[i] ?? 0);
    return { s, mw: Math.max(0, at(iHi) - at(iLo)) };
  }).filter(Boolean);
  const total = d3.sum(rows, (r) => r.mw);
  rows.forEach((r) => (r.share = total > 0 ? r.mw / total : null));
  return { rows, total, lo, hi };
}

function drawMarginal() {
  const el = $("marg-chart"), del = $("marg-day"), tel = $("marg-table");
  const h = S.hour;
  const pname = S.location === "lambda" ? "system lambda" : S.location;
  $("marg-title-note").textContent = S.date ? `${S.date} · ${heLabel(h)}` : "";
  const clear = (msg) => { emptyMsg(el, msg); del.innerHTML = ""; tel.innerHTML = ""; };
  if (!S.day) return clear("No data for this day.");
  if (!S.prices) return clear("No cleared price loaded for this day yet.");
  const hp = hourPrice(S.prices, h);
  if (!S.day.runs[h] || !hp || hp.mean == null) return clear(`No SCED runs or price recorded in ${heLabel(h)}.`);

  const m0 = marginalRows(h, hp), { total, lo, hi } = m0;
  // technologies with nothing at the margin are left off the bars (they stay in the table)
  const all = m0.rows.sort((a, b) => b.mw - a.mw), rows = all.filter((r) => r.mw >= 1);
  if (!rows.length) return clear(`No MW offered within ${heLabel(h)}'s cleared price range.`);
  const win = `${fmtPrice(lo)} to ${fmtPrice(hi)}`;
  el.replaceChildren(hBars(el, rows, (r) => `<h4>${r.s.label} · ${heLabel(h)}</h4><table>
      <tr><td>Offered from ${win}</td><td class="n">${fmtMW(r.mw)} MW</td></tr>
      <tr><td>Share of marginal MW</td><td class="n">${r.share != null ? d3.format(".1%")(r.share) : "–"}</td></tr></table>`));
  el.insertAdjacentHTML("beforeend", `<p class="note">${fmtMW(total)} MW offered from ${win} (${pname} averaged ${fmtPrice(hp.mean)} in ${heLabel(h)}).</p>`);
  tel.innerHTML = barTable(all, `MW offered ${win}`, "Share of marginal MW", "Total", total);

  // share of marginal MW by hour, 100% stacked columns
  const list = seriesList();
  const hours = d3.range(24).map((i) => {
    const p = hourPrice(S.prices, i);
    if (!S.day.runs[i] || !p || p.mean == null) return null;
    const m = marginalRows(i, p);
    return m.total > 0 ? Object.fromEntries(m.rows.map((r) => [r.s.id, r.mw / m.total])) : null;
  });
  const { w } = size(del);
  const H = 200, m = { t: 14, r: 16, b: 26, l: 64 };
  const x = d3.scaleBand().domain(d3.range(1, 25)).range([m.l, w - m.r]).paddingInner(0.15);
  const y = d3.scaleLinear().domain([0, 1]).range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickValues([1, 4, 8, 12, 16, 20, 24]).tickFormat((d) => "HE" + d).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickFormat(fmtPct).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text("Share of marginal MW by hour");
  hours.forEach((sh, i) => {
    const cx = x(i + 1), bw = x.bandwidth();
    if (!sh) return;
    const op = i === h ? 1 : 0.5;   // the selected hour stands out
    let acc = 0;
    list.forEach((s) => {
      const v = sh[s.id] || 0;
      if (v <= 0) return;
      // 1px surface gap between stacked segments
      const y1 = y(acc + v), y0 = y(acc);
      svg.append("rect").attr("x", cx).attr("width", bw).attr("y", y1).attr("height", Math.max(0, y0 - y1 - 1)).attr("fill", css(s.color)).attr("opacity", op);
      acc += v;
    });
  });
  hoverHours(svg, d3.scaleLinear().domain([1, 24]).range([x(1) + x.bandwidth() / 2, x(24) + x.bandwidth() / 2]), m, H, (i) => {
    const sh = hours[i];
    if (!sh) return `<h4>${heLabel(i)}</h4>No price or curve data`;
    return `<h4>${heLabel(i)}</h4><table>` + list.filter((s) => sh[s.id] > 0).sort((a, b) => sh[b.id] - sh[a.id]).map((s) =>
      `<tr><td><span class="sw" style="background:var(${s.color})"></span></td><td>${s.label}</td><td class="n">${d3.format(".0%")(sh[s.id])}</td></tr>`).join("") + "</table>";
  });
  del.replaceChildren(svg.node());
}

// ---- marginality by price: every loaded hour, grouped by system lambda -------
const MBP_BINS = [
  [-Infinity, -5, "< −$5"], [-5, 0, "−$5–0"], [0, 5, "$0–5"], [5, 10, "$5–10"], [10, 15, "$10–15"], [15, 20, "$15–20"],
  [20, 25, "$20–25"], [25, 30, "$25–30"], [30, 40, "$30–40"], [40, 50, "$40–50"], [50, 75, "$50–75"],
  [75, 100, "$75–100"], [100, 200, "$100–200"], [200, Infinity, "≥ $200"],
];

async function drawMarginalByPrice() {
  const el = $("mbp-chart"), tel = $("mbp-table");
  const src = S.source, list = SERIES[src];
  $("mbp-legend").innerHTML = list.map((s) => `<span><span class="sw" style="background:var(${s.color})"></span>${s.label}</span>`).join("");
  const data = await tryJSON(`data/marginal_${src}.json.gz`);
  if (src !== S.source) return;   // report changed while loading
  if (!data || !data.rows.length) { tel.innerHTML = ""; return emptyMsg(el, "No marginal data yet. It is built by the data update workflow."); }
  const C = data.columns, ci = Object.fromEntries(C.map((c, i) => [c, i]));
  let rows = data.rows;
  const last = rows[rows.length - 1][0];
  if (S.mbpDays !== "all") {
    const from = d3.timeFormat("%Y-%m-%d")(d3.timeDay.offset(new Date(last + "T12:00:00"), -(+S.mbpDays - 1)));
    rows = rows.filter((r) => r[0] >= from);
  }
  $("mbp-title-note").textContent = `${rows.length ? rows[0][0] : ""} to ${last} · ${rows.length.toLocaleString()} hours`;

  const bins = MBP_BINS.map(([lo, hi, label]) => {
    const hrs = rows.filter((r) => r[2] >= lo && r[2] < hi);
    const mw = Object.fromEntries(list.map((s) => [s.id, d3.sum(hrs, (r) => d3.sum(s.keys, (k) => r[ci[k]] || 0))]));
    const tot = d3.sum(list, (s) => mw[s.id]);
    return { label, n: hrs.length, mw, tot };
  });
  const val = (b, s) => (S.mbpUnit === "share" ? (b.tot ? b.mw[s.id] / b.tot : 0) : (b.n ? b.mw[s.id] / b.n : 0));

  const { w } = size(el);
  const narrow = w < 560;
  const H = 310, m = { t: 14, r: 12, b: narrow ? 74 : 58, l: 56 };
  const x = d3.scaleBand().domain(bins.map((b) => b.label)).range([m.l, w - m.r]).paddingInner(0.18);
  const ymax = S.mbpUnit === "share" ? 1 : d3.max(bins, (b) => d3.sum(list, (s) => val(b, s))) || 1;
  const y = d3.scaleLinear().domain([0, ymax]).nice().range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
  const xa = svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickSizeOuter(0));
  if (narrow) xa.selectAll("text").attr("transform", "rotate(-45)").attr("text-anchor", "end").attr("dx", "-0.4em").attr("dy", "0.5em");
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`)
    .call(d3.axisLeft(y).ticks(5).tickFormat(S.mbpUnit === "share" ? fmtPct : d3.format(",.0f")).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10)
    .text(S.mbpUnit === "share" ? "Share of marginal MW" : "Average marginal MW per hour");
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", H - 2).attr("text-anchor", "end").text("Hour's average system lambda ($/MWh)");
  bins.forEach((b) => {
    const cx = x(b.label), bw = x.bandwidth();
    let acc = 0;
    if (b.n) list.forEach((s) => {
      const v = val(b, s);
      if (v <= 0) return;
      const y1 = y(acc + v), y0 = y(acc);
      // 1px surface gap between stacked segments; groups with few hours are faded
      svg.append("rect").attr("x", cx).attr("width", bw).attr("y", y1).attr("height", Math.max(0, y0 - y1 - 1))
        .attr("fill", css(s.color)).attr("opacity", b.n < 24 ? 0.45 : 1);
      acc += v;
    });
    if (!narrow) svg.append("text").attr("class", "axis-title").attr("x", cx + bw / 2).attr("y", H - m.b + 32).attr("text-anchor", "middle").text(`${b.n.toLocaleString()} h`);
    svg.append("rect").attr("x", cx - 2).attr("width", bw + 4).attr("y", m.t).attr("height", H - m.t - m.b).attr("fill", "transparent")
      .on("pointermove", (ev) => showTip(ev, `<h4>System lambda ${b.label}</h4>${b.n.toLocaleString()} hours${b.n && b.n < 24 ? " (few hours: read with care)" : ""}` +
        (b.n ? `<table>` + list.filter((s) => b.mw[s.id] > 0).sort((p, q) => b.mw[q.id] - b.mw[p.id]).map((s) =>
          `<tr><td><span class="sw" style="background:var(${s.color})"></span></td><td>${s.label}</td><td class="n">${fmtPct(b.mw[s.id] / b.tot)}</td><td class="n">${fmtMW(b.mw[s.id] / b.n)} MW</td></tr>`).join("") + `</table><p class="tip-body">Share of marginal MW, and average marginal MW per hour.</p>` : "")))
      .on("pointerleave", hideTip);
  });
  el.replaceChildren(svg.node());

  tel.innerHTML = `<table class="data"><thead><tr><th class="t">System lambda</th><th>Hours</th>${list.map((s) => `<th>${s.label}</th>`).join("")}</tr></thead><tbody>` +
    bins.map((b) => `<tr><td class="t">${b.label}</td><td>${b.n.toLocaleString()}</td>${list.map((s) => `<td>${b.tot ? fmtPct(b.mw[s.id] / b.tot) : "–"}</td>`).join("")}</tr>`).join("") +
    `</tbody></table><p class="note">Share of marginal MW in each price group.</p>`;
}

// ---- hourly profile + price ------------------------------------------------
function drawProfile() {
  const el = $("profile-chart"), pel = $("price-chart");
  if (!S.day) { emptyMsg(el, "No data for this day."); pel.innerHTML = ""; return; }
  const gi = S.index.grid.indexOf(S.threshold);
  const rows = seriesList().filter((s) => !S.hidden.has(s.id)).map((s) => {
    const c = seriesCurves(S.day, s, S.version);
    return c && { s, vals: c.map((r) => (r ? r[gi] : null)) };
  }).filter(Boolean);

  const { w } = size(el);
  const H = 240, m = { t: 14, r: 16, b: 26, l: 64 };
  const x = d3.scaleLinear().domain([1, 24]).range([m.l, w - m.r]);
  const all = rows.flatMap((r) => r.vals).filter((v) => v != null);
  const y = d3.scaleLinear().domain([Math.min(0, d3.min(all) ?? 0), Math.max(1, d3.max(all) ?? 1)]).nice().range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("rect").attr("class", "price-band").attr("x", x(S.hour + 1) - 6).attr("width", 12).attr("y", m.t).attr("height", H - m.t - m.b);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickValues([1, 4, 8, 12, 16, 20, 24]).tickFormat((d) => "HE" + d).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickFormat(d3.format(",.0f")).tickSizeOuter(0));
  if (y.domain()[0] < 0) svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(0)).attr("y2", y(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text(`MW at or below ${S.threshold === -249 ? "the price floor" : fmtPrice0(S.threshold)}`);
  const line = d3.line().defined((d) => d != null).x((d, i) => x(i + 1)).y((d) => y(d));
  rows.forEach((r) => svg.append("path").attr("fill", "none").attr("stroke", css(r.s.color)).attr("stroke-width", 2).attr("d", line(r.vals)));
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
  s2.append("g").attr("class", "axis").attr("transform", `translate(${m2.l},0)`).call(d3.axisLeft(y2).ticks(4).tickFormat(fmtPrice0).tickSizeOuter(0));
  if (y2.domain()[0] < 0) s2.append("line").attr("class", "zero").attr("x1", m2.l).attr("x2", w - m2.r).attr("y1", y2(0)).attr("y2", y2(0));
  s2.append("text").attr("class", "axis-title").attr("x", m2.l).attr("y", 10).text(`${S.location === "lambda" ? "System lambda" : S.location} ($/MWh), hourly average and range`);
  s2.append("path").attr("fill", css("--band")).attr("d", d3.area().defined((p) => p && p.min != null).x((p, i) => x(i + 1)).y0((p) => y2(p.min)).y1((p) => y2(p.max))(hp));
  s2.append("path").attr("fill", "none").attr("stroke", css("--price")).attr("stroke-width", 2).attr("d", d3.line().defined((p) => p && p.mean != null).x((p, i) => x(i + 1)).y((p) => y2(p.mean))(hp));
  hoverHours(s2, x, m2, H2, (i) => hp[i] ? `<h4>${heLabel(i)}</h4>Average ${fmtPrice(hp[i].mean)}<br>Range ${fmtPrice(hp[i].min)} to ${fmtPrice(hp[i].max)}` : `<h4>${heLabel(i)}</h4>No price`);
  pel.replaceChildren(s2.node());
}

function hoverHours(svg, x, m, H, htmlFor) {
  const w = +svg.attr("viewBox").split(" ")[2];
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

// ---- heatmap --------------------------------------------------------------
function drawHeatmap() {
  const el = $("heatmap"), scaleEl = $("heat-scale");
  const summ = S.summaries[S.source] || {};
  const s = seriesList().find((q) => q.id === S.heatTech) || seriesList()[0];
  const ti = S.index.thresholds.indexOf(S.threshold);
  const dates = Object.keys(summ).sort();
  if (!dates.length) { emptyMsg(el, "No days loaded yet."); scaleEl.innerHTML = ""; return; }
  const cells = [];
  dates.forEach((d) => {
    const v = summarySeries(summ[d], s);
    if (v) v.forEach((row, h) => { if (row && row[ti] != null) cells.push({ d, h, v: row[ti] }); });
  });
  const cw = Math.max(10, Math.min(36, (el.clientWidth - 70) / dates.length));
  const ch = 10;
  const m = { t: 8, r: 8, b: 44, l: 52 };
  const w = Math.max(el.clientWidth || 300, m.l + m.r + cw * dates.length);
  const H = m.t + m.b + ch * 24;
  const x = d3.scaleBand().domain(dates).range([m.l, m.l + cw * dates.length]).paddingInner(0.08);
  const y = d3.scaleBand().domain(d3.range(24)).range([m.t, m.t + ch * 24]).paddingInner(0.08);
  const ext = d3.extent(cells, (c) => c.v);
  if (ext[0] === ext[1]) ext[1] = ext[0] + 1;
  const color = d3.scaleSequential(d3.interpolateRgb(css("--seq-lo"), css("--seq-hi"))).domain(ext);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`).style("width", w + "px").style("max-width", "none");
  svg.append("g").selectAll("rect").data(cells).join("rect")
    .attr("x", (c) => x(c.d)).attr("y", (c) => y(c.h)).attr("width", x.bandwidth()).attr("height", y.bandwidth()).attr("rx", 2)
    .attr("fill", (c) => color(c.v))
    .attr("stroke", (c) => (c.d === S.date && c.h === S.hour ? css("--ink") : "none")).attr("stroke-width", 1.5)
    .style("cursor", "pointer")
    .on("pointermove", (ev, c) => showTip(ev, `<h4>${c.d} · ${heLabel(c.h)}</h4>${s.label}: <b>${fmtMW(c.v)} MW</b> at or below ${S.threshold === -249 ? "the floor" : fmtPrice0(S.threshold)}`))
    .on("pointerleave", hideTip)
    .on("click", async (ev, c) => { S.hour = c.h; $("hour").value = c.h; if (c.d !== S.date) { S.date = c.d; $("date").value = c.d; await loadDay(); } render(); });
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l - 2},0)`)
    .call(d3.axisLeft(y).tickValues([0, 5, 11, 17, 23]).tickFormat((h) => heLabel(h)).tickSize(0)).select(".domain").remove();
  const every = Math.ceil(dates.length / Math.max(1, Math.floor((cw * dates.length) / 70)));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${m.t + ch * 24 + 2})`)
    .call(d3.axisBottom(x).tickValues(dates.filter((d, i) => i % every === 0)).tickFormat((d) => d3.timeFormat("%b %-d")(new Date(d + "T12:00:00"))).tickSize(0))
    .select(".domain").remove();
  el.replaceChildren(svg.node());
  scaleEl.innerHTML = `<span>${fmtMW(ext[0])} MW</span><span class="ramp" style="background:linear-gradient(90deg,${css("--seq-lo")},${css("--seq-hi")})"></span><span>${fmtMW(ext[1])} MW</span>`;
}


// ---- explanations shown on hover / focus ---------------------------------------
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const TECH_COLS = [
  ["Technology", "Resources are grouped by the resource type ERCOT reports for each unit. Hover a technology name to see which types it includes."],
  ["Units online", "Average number of units with an online status (ON, ONRUC, ONTEST and similar) across the day's SCED runs. Units that are off or on outage are excluded from every column."],
  ["Available, HSL (MW)", "High Sustained Limit: the most the online units can produce right now, as telemetered to ERCOT. For wind and solar it follows available output from the forecast and telemetry, not nameplate capacity."],
  ["Min output, LSL (MW)", "Low Sustained Limit: the least an online unit can produce and stay online. A thermal unit cannot go below this in response to price without shutting down, so this block keeps running however low prices fall."],
  ["LSL / HSL", "Minimum output as a share of available capacity. A higher share means less room to back down when prices drop: a unit at 60% can only shed 40% of its available output before it has to shut down."],
  ["Output (MW)", "Telemetered net output, averaged over the day."],
  ["At floor, as used (MW)", "MW in the curve SCED dispatched against that is priced at the −$250 floor (or −$249.99). This includes minimum output, which ERCOT places at −$250 whatever the generator offered, and the full output schedule of units with no offer curve. SCED treats this supply as a price-taker."],
  ["Floor / output", "At-floor MW as a share of actual output: how much of the technology's generation SCED could not price off the system."],
  ["≤ $0, as used (MW)", "MW offered at or below $0 in the curve SCED used. This supply keeps running when prices go negative."],
  ["≤ $0, as submitted (MW)", "MW the generators themselves priced at or below $0 in the offer curves they submitted. The gap between this and the as-used column is supply placed low by ERCOT's curve extensions (minimum output and units without offers) rather than by the generator's own price."],
  ["No submitted offer (MW)", "Available capacity (HSL, in MW) of online units that submitted no energy offer curve and ran on an output schedule instead. ERCOT dispatches these against a proxy curve priced at the floor up to their schedule. Nuclear units typically work this way."],
];
const TECH_NOTES = {
  combined_cycle: "Combined-cycle gas plants (resource types CCGT90 and CCLE90). Each configuration of a plant is reported as its own resource.",
  combustion_turbine: "Simple-cycle gas and oil combustion turbines (SCGT90, SCLE90): typically peakers with quick starts.",
  wind: "Wind-powered generation resources (WIND). Curves are capped at available output.",
  solar: "Photovoltaic generation resources (PVGR). Curves are capped at available output, so they shrink to zero at night.",
  nuclear: "Nuclear units (NUC). They normally submit no offer curve and run on an output schedule.",
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
  le0_submitted: "MW at or below $0 in the curve the generator submitted.",
  min_sub_price: "Price of the first (cheapest) point on the submitted offer curve, lowest of the day. Blank when no curve was submitted.",
  no_offer_share: "Share of online SCED runs with no submitted offer curve.",
};

// ---- technology table (60-day) ---------------------------------------------
function drawTechTable() {
  const el = $("tech-table");
  if (!S.day || !S.day.stats) return emptyMsg(el, "No 60-day data for this day.");
  const names = S.day.stat_names;
  const col = (k) => names.indexOf(k);
  const hours = d3.range(24).filter((h) => S.day.runs[h]);
  const rows = SERIES["60d"].map((s) => {
    const avg = (k) => d3.mean(hours, (h) => d3.sum(s.keys, (key) => (S.day.stats[key] && S.day.stats[key][h] && S.day.stats[key][h][col(k)]) || 0));
    const r = { s };
    names.forEach((k) => (r[k] = avg(k)));
    return r;
  });
  const maxShare = d3.max(rows, (r) => (r.output > 1 ? r.floor_sced / r.output : 0)) || 1;
  const head = TECH_COLS.map(([label, tip], i) =>
    `<th class="${i ? "" : "t"} has-tip" tabindex="0" data-tip-title="${esc(label)}" data-tip="${esc(tip)}">${label}</th>`);
  let html = `<table class="data"><thead><tr>${head.join("")}</tr></thead><tbody>`;
  rows.forEach((r) => {
    const share = r.output > 1 ? r.floor_sced / r.output : null;
    html += `<tr><td class="t"><span class="has-tip" tabindex="0" data-tip-title="${esc(r.s.label)}" data-tip="${esc(TECH_NOTES[r.s.id] || "")}"><span class="sw" style="background:var(${r.s.color});margin-right:6px"></span>${r.s.label}</span></td>
      <td>${d3.format(",.0f")(r.n_online)}</td><td>${fmtMW(r.hsl)}</td><td>${fmtMW(r.lsl)}</td>
      <td>${r.hsl > 1 && r.s.id !== "storage" ? fmtPct(r.lsl / r.hsl) : "–"}</td><td>${fmtMW(r.output)}</td>
      <td>${fmtMW(r.floor_sced)}</td>
      <td>${share == null || r.s.id === "storage" ? "–" : fmtPct(share) + `<span class="bar-cell" style="width:${Math.round(40 * share / maxShare)}px"></span>`}</td>
      <td>${fmtMW(r.le0_sced)}</td><td>${fmtMW(r.le0_submitted)}</td><td>${fmtMW(r.no_offer_hsl)}</td></tr>`;
  });
  el.innerHTML = html + `</tbody></table><p class="note">MW are averages over the day's hours. Hover a column heading or a technology name for an explanation.</p>`;
}

// ---- unit table (60-day) -----------------------------------------------------
const UNIT_COLS = [
  ["unit", "Unit", "t"], ["type", "Type", "t"], ["hours_online", "Hours online"], ["hsl", "HSL (MW)"], ["lsl", "LSL (MW)"],
  ["output", "Output (MW)"], ["pinned_share", "Time at LSL", "pct"], ["floor_mw", "At floor (MW)"],
  ["le0_sced", "≤ $0 as used (MW)"], ["le0_submitted", "≤ $0 as submitted (MW)"], ["min_sub_price", "Lowest submitted price ($/MWh)", "price"],
  ["no_offer_share", "No offer", "pct"],
];
function drawUnits() {
  const el = $("units-table");
  if (!S.day || !S.day.units) return emptyMsg(el, "No 60-day data for this day.");
  const C = S.day.units.columns;
  const techOf = (t) => (["hydro", "other"].includes(t) ? "other" : t);
  let rows = S.day.units.rows.map((r) => Object.fromEntries(C.map((c, i) => [c, r[i]])));
  if (S.unitTech !== "all") rows = rows.filter((r) => techOf(r.tech) === S.unitTech);
  if (S.unitSearch) rows = rows.filter((r) => r.unit.toLowerCase().includes(S.unitSearch.toLowerCase()));
  const { key, dir } = S.unitSort;
  rows.sort((a, b) => {
    const va = a[key], vb = b[key];
    if (va == null) return 1; if (vb == null) return -1;
    return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * dir;
  });
  const total = rows.length;
  if (!S.unitShowAll) rows = rows.slice(0, 150);
  const fmt = (v, kind) => v == null ? "–" : kind === "pct" ? fmtPct(v) : kind === "price" ? fmtPrice(v) : kind === "t" ? v : d3.format(",.1f")(v);
  let html = `<div class="units-wrap"><table class="data"><thead><tr>${UNIT_COLS.map(([k, label, kind]) =>
    `<th class="sortable ${kind === "t" ? "t" : ""}${UNIT_TIPS[k] ? " has-tip" : ""}" data-k="${k}"${UNIT_TIPS[k] ? ` data-tip-title="${esc(label)}" data-tip="${esc(UNIT_TIPS[k])}"` : ""} aria-sort="${k === key ? (dir > 0 ? "ascending" : "descending") : "none"}">${label}${k === key ? (dir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead><tbody>`;
  html += rows.map((r) => `<tr>${UNIT_COLS.map(([k, , kind]) => `<td class="${kind === "t" ? "t" : ""}">${fmt(r[k], kind)}</td>`).join("")}</tr>`).join("");
  el.innerHTML = html + "</tbody></table></div>";
  $("units-foot").innerHTML = total > rows.length
    ? `Showing ${rows.length} of ${total} units. <button type="button" id="units-all" class="linkish">Show all</button>`
    : `${total} units. "Time at LSL" is the share of online SCED runs with the base point at minimum output.`;
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
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", 12).attr("text-anchor", "end")
    .text(`${vals.length.toLocaleString()} hours · ${fmtPct(below)} at or below ${S.threshold === -249 ? "the floor" : fmtPrice0(S.threshold)}`);
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", H - 4).attr("text-anchor", "end").text("Share of hours");
  el.replaceChildren(svg.node());
}

// -------------------------------------------------------------- tooltip ---
function showTip(ev, html) {
  const t = $("tip");
  t.innerHTML = html; t.hidden = false;
  const r = t.getBoundingClientRect();
  let left = ev.clientX + 14, top = ev.clientY + 14;
  if (left + r.width > window.innerWidth - 8) left = ev.clientX - r.width - 14;
  if (top + r.height > window.innerHeight - 8) top = ev.clientY - r.height - 14;
  t.style.left = Math.max(8, left) + "px"; t.style.top = Math.max(8, top) + "px";
}
function hideTip() { $("tip").hidden = true; }

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
  if (!D["2d"].length && D["60d"].length) S.source = "60d";
  const last = (a) => (a.length ? [...a].sort().at(-1) : "none");
  $("status").textContent = `2-day: ${D["2d"].length} day(s), latest ${last(D["2d"])} · 60-day: ${D["60d"].length} day(s), latest ${last(D["60d"])} · prices: ${D.prices.length} day(s) · updated ${S.index.updated.replace("T", " ").replace("Z", " UTC")}`;

  $("source").querySelectorAll("button").forEach((b) => (b.disabled = !D[b.dataset.v].length));
  setSeg("source", S.source); setSeg("version", S.version); setSeg("xrange", S.xrange); setSeg("mode", S.mode); setSeg("axes", S.axes);
  fillDates(); fillLocations(); fillThresholds(); fillTechSelects();

  bindSeg("source", "source", async () => { S.hidden.clear(); fillDates(); fillTechSelects(); await changeDay(); });
  bindSeg("version", "version");
  bindSeg("xrange", "xrange");
  bindSeg("mode", "mode");
  bindSeg("axes", "axes");
  setSeg("mbp-days", S.mbpDays); setSeg("mbp-unit", S.mbpUnit);
  bindSeg("mbp-days", "mbpDays", drawMarginalByPrice);
  bindSeg("mbp-unit", "mbpUnit", drawMarginalByPrice);
  $("date").onchange = async (e) => { S.date = e.target.value; await changeDay(); };
  // step one available day older (-1) or newer (+1)
  const stepDay = async (dir) => {
    const days = [...S.index.days[S.source]].sort();
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
  $("heat-tech").onchange = (e) => { S.heatTech = e.target.value; drawHeatmap(); };
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

  let t;
  new ResizeObserver(() => { clearTimeout(t); t = setTimeout(render, 120); }).observe(document.querySelector("main"));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
  new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  await changeDay();
}
boot();
})();

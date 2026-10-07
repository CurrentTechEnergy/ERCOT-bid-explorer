/* ERCOT Bidding Trends — long-term view. Reads data/trends_60d.json.gz written by pipeline/trends.py. */
(() => {
"use strict";

// Colors are fixed per technology and match the day view.
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
const FLOOR_NOTES = {
  floor_sced: "MW priced at the −$250 floor (or −$249.99) in the curves SCED dispatched against, averaged over each day. This includes minimum output, which ERCOT places at the floor whatever the generator offered, and units running on an output schedule with no offer.",
  floor_submitted: "MW the generators themselves priced at the −$250 floor in the offer curves they submitted, averaged over each day.",
  le0_submitted: "MW the generators themselves priced at or below $0 in the offer curves they submitted, averaged over each day. Wind and solar are capped at available output.",
};
const SIG_FMT = { le0: (v) => d3.format(".0%")(v), noff: (v) => d3.format(".0%")(v), rel: (v) => (v >= 0 ? "+" : "−") + d3.format("$,.0f")(Math.abs(v)) };

const S = { T: null, floorMode: "floor_sced", hidden: { floor: new Set(), online: new Set(), partial: new Set() },
  scTech: "coal", scX: "week", chgTech: "all", chgSig: "all", unit: null };
const $ = (id) => document.getElementById(id);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const fmtMW = d3.format(",.0f");
const fmtPrice = (v) => (v == null || isNaN(v) ? "–" : d3.format("$,.2f")(v));
const parseDate = (d) => new Date(d + "T12:00:00");
const fmtDate = d3.timeFormat("%a %b %-d, %Y");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function getJSON(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
    return JSON.parse(await new Response(stream).text());
  }
  return JSON.parse(new TextDecoder().decode(buf));
}

function setSeg(id, value) { $(id).querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === value))); }
function bindSeg(id, key, after) {
  $(id).addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    S[key] = b.dataset.v; setSeg(id, S[key]); after();
  });
}
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
function emptyMsg(el, msg) { el.innerHTML = `<p class="empty">${msg}</p>`; }

function legend(el, list, hidden, redraw) {
  el.innerHTML = list.map((s) => `<button type="button" data-id="${s.id}" aria-pressed="${!hidden.has(s.id)}"><span class="sw" style="background:var(${s.color})"></span>${s.label}</button>`).join("");
  el.onclick = (e) => {
    const b = e.target.closest("button[data-id]");
    if (!b) return;
    hidden.has(b.dataset.id) ? hidden.delete(b.dataset.id) : hidden.add(b.dataset.id);
    legend(el, list, hidden, redraw); redraw();
  };
}

// daily value for a technology series (sums component keys; null when every part is missing)
function techDaily(s, stat) {
  const D = S.T.daily;
  return S.T.dates.map((_, i) => {
    const parts = s.keys.map((k) => D[k] && D[k][stat] && D[k][stat][i]).filter((v) => v != null);
    return parts.length ? d3.sum(parts) : null;
  });
}

// ---- time-series line chart with hover crosshair ------------------------------
// series: [{ label, color, values }]; opts: { title, yFmt, H, markers: [date strings], dashed: index set }
function timeChart(el, series, opts) {
  const dates = S.T.dates.map(parseDate);
  const w = Math.max(280, el.clientWidth || 600);
  const H = opts.H || 260, m = { t: 16, r: 16, b: 26, l: 64 };
  const x = d3.scaleTime().domain(d3.extent(dates)).range([m.l, w - m.r]);
  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  if (!all.length) return emptyMsg(el, "No data.");
  const lo = d3.min(all), hi = d3.max(all);
  const y = d3.scaleLinear().domain([Math.min(0, lo), Math.max(opts.yMin || 1, hi)]).nice().range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(w < 560 ? 4 : 8).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickFormat(opts.yFmt || d3.format(",.0f")).tickSizeOuter(0));
  if (y.domain()[0] < 0) svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(0)).attr("y2", y(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text(opts.title);
  (opts.markers || []).forEach((d) => svg.append("line").attr("class", "crosshair").attr("x1", x(parseDate(d))).attr("x2", x(parseDate(d))).attr("y1", m.t).attr("y2", H - m.b).style("stroke", css("--accent")));
  const line = d3.line().defined((v) => v != null).x((v, i) => x(dates[i])).y((v) => y(v));
  series.forEach((s) => svg.append("path").attr("fill", "none").attr("stroke", css(s.color)).attr("stroke-width", s.width || 2)
    .attr("stroke-dasharray", s.dash || null).attr("d", line(s.values)));
  // single online days between gaps draw no line segment, so mark every point when asked
  if (opts.dots) series.forEach((s) => svg.append("g").selectAll("circle").data(s.values.map((v, i) => [v, i]).filter(([v]) => v != null))
    .join("circle").attr("cx", ([, i]) => x(dates[i])).attr("cy", ([v]) => y(v)).attr("r", 2).attr("fill", css(s.color)));
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", H - m.b).style("display", "none");
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const t = x.invert(d3.pointer(ev)[0]);
      const i = d3.minIndex(dates, (d) => Math.abs(d - t));
      cross.style("display", null).attr("x1", x(dates[i])).attr("x2", x(dates[i]));
      const rows = series.filter((s) => s.values[i] != null).sort((a, b) => b.values[i] - a.values[i]);
      showTip(ev, `<h4>${fmtDate(dates[i])}</h4><table>` + rows.map((s) =>
        `<tr><td><span class="sw" style="background:var(${s.color})"></span></td><td>${s.label}</td><td class="n">${(opts.tipFmt || opts.yFmt || fmtMW)(s.values[i])}</td></tr>`).join("") + "</table>");
    })
    .on("pointerleave", () => { cross.style("display", "none"); hideTip(); });
  el.replaceChildren(svg.node());
}

// ---- panels ----------------------------------------------------------------------
function drawFloor() {
  $("floor-note").textContent = FLOOR_NOTES[S.floorMode];
  const list = TECHS.filter((s) => !S.hidden.floor.has(s.id));
  timeChart($("floor-chart"), list.map((s) => ({ ...s, values: techDaily(s, S.floorMode) })), { title: "MW, daily average", H: 280 });
  timeChart($("floor-price"), [{ label: "System lambda", color: "--price", values: S.T.lambda }],
    { title: "System lambda ($/MWh), daily average", H: 140, yFmt: d3.format("$,.0f"), tipFmt: fmtPrice, yMin: 10 });
}

function drawOnline() {
  const list = TECHS.filter((s) => THERMAL.includes(s.id) && !S.hidden.online.has(s.id));
  timeChart($("online-chart"), list.map((s) => ({ ...s, values: techDaily(s, "n_online") })), { title: "Units online, daily average", tipFmt: d3.format(",.1f") });
}

function drawPartial() {
  const list = TECHS.filter((s) => THERMAL.includes(s.id) && !S.hidden.partial.has(s.id));
  timeChart($("partial-chart"), list.map((s) => ({ ...s, values: techDaily(s, "partial_units") })), { title: "Units online 1–22 hours of the day" });
}

function drawScatter() {
  const el = $("sc-chart");
  const s = TECHS.find((t) => t.id === S.scTech);
  const units = techDaily(s, "n_online");
  const lam = S.T.lambda;
  const xv = lam.map((v, i) => {
    if (S.scX === "day") return v;
    const prev = lam.slice(Math.max(0, i - 7), i).filter((p) => p != null);
    return prev.length >= 4 ? d3.mean(prev) : null;   // needs most of the previous week
  });
  const pts = S.T.dates.map((d, i) => ({ d, x: xv[i], y: units[i] })).filter((p) => p.x != null && p.y != null);
  if (!pts.length) return emptyMsg(el, "No data.");
  const w = Math.max(280, el.clientWidth || 600);
  const H = 320, m = { t: 30, r: 16, b: 38, l: 56 };
  // clip extreme prices so the bulk of days stays readable; they still count in the bands
  const xmax = Math.min(d3.max(pts, (p) => p.x), d3.quantile(pts.map((p) => p.x).sort(d3.ascending), 0.98) * 1.2);
  const x = d3.scaleLinear().domain([Math.min(0, d3.min(pts, (p) => p.x)), xmax]).nice().range([m.l, w - m.r]);
  const shown = pts.filter((p) => p.x <= x.domain()[1]), off = pts.length - shown.length;
  const y = d3.scaleLinear().domain([0, d3.max(pts, (p) => p.y)]).nice().range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(w < 560 ? 4 : 8).tickFormat(d3.format("$,.0f")).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text(`${s.label}: units online, daily average`);
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", H - 4).attr("text-anchor", "end")
    .text(S.scX === "day" ? "System lambda that day ($/MWh)" : "Average system lambda over the previous 7 days ($/MWh)");
  if (off) svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 24)
    .text(`${off} day${off === 1 ? "" : "s"} above ${d3.format("$,.0f")(x.domain()[1])} not shown`);
  svg.append("g").selectAll("circle").data(shown).join("circle").attr("cx", (p) => x(p.x)).attr("cy", (p) => y(p.y)).attr("r", 4)
    .attr("fill", css(s.color)).attr("fill-opacity", 0.55).attr("stroke", css("--surface")).attr("stroke-width", 1)
    .on("pointermove", (ev, p) => showTip(ev, `<h4>${fmtDate(parseDate(p.d))}</h4>${d3.format(",.1f")(p.y)} units online<br>Lambda ${fmtPrice(p.x)}`))
    .on("pointerleave", hideTip);
  // median per $5 band (bands with at least 3 days)
  const bands = d3.groups(pts, (p) => Math.floor(p.x / 5) * 5).filter(([, g]) => g.length >= 3)
    .map(([b, g]) => ({ x: b + 2.5, y: d3.median(g, (p) => p.y), n: g.length })).sort((a, b) => a.x - b.x);
  svg.append("path").attr("fill", "none").attr("stroke", css("--ink")).attr("stroke-width", 2)
    .attr("d", d3.line().defined((b) => b.x <= x.domain()[1]).x((b) => x(b.x)).y((b) => y(b.y))(bands));
  el.replaceChildren(svg.node());
}

// ---- bidding-approach changes -----------------------------------------------------
function drawChanges() {
  const T = S.T, techOf = Object.fromEntries(T.units.map((u) => [u.unit, u]));
  $("chg-note").textContent = `A change is a shift that holds: the median over the ${T.window} online days after a day differs from the median over the ${T.window} online days before by at least 25 percentage points of MW offered at or below $0, half the day running without an offer, or $10 in first offer price relative to that day's median for the technology (which removes moves in fuel price). Thermal units only. Click a row to see the unit.`;
  // summary: units per technology, how many changed
  const sum = THERMAL.map((t) => {
    const us = T.units.filter((u) => u.tech === t);
    const ch = us.filter((u) => u.n_changes > 0);
    return { s: TECHS.find((x) => x.id === t), n: us.length, changed: ch.length, changes: d3.sum(ch, (u) => u.n_changes) };
  });
  $("chg-summary").innerHTML = `<table class="data"><thead><tr><th class="t">Technology</th><th>Units</th><th>Kept one approach</th><th>Changed at least once</th><th>Changes</th></tr></thead><tbody>` +
    sum.map((r) => `<tr><td class="t"><span class="sw" style="background:var(${r.s.color});margin-right:6px"></span>${r.s.label}</td><td>${r.n}</td><td>${r.n - r.changed}</td><td>${r.changed}</td><td>${r.changes}</td></tr>`).join("") + "</tbody></table>";

  let rows = T.changes;
  if (S.chgTech !== "all") rows = rows.filter((c) => c[1] === S.chgTech);
  if (S.chgSig !== "all") rows = rows.filter((c) => c[3] === S.chgSig);
  rows = [...rows].reverse();
  $("chg-table").innerHTML = rows.length ? `<table class="data"><thead><tr><th class="t">Date</th><th class="t">Unit</th><th class="t">Technology</th><th class="t">Change</th><th>Before</th><th>After</th></tr></thead><tbody>` +
    rows.map((c) => {
      const s = TECHS.find((x) => x.id === c[1]);
      return `<tr data-unit="${esc(c[0])}" style="cursor:pointer"><td class="t">${c[2]}</td><td class="t">${esc(c[0])}</td><td class="t">${s ? s.label : c[1]}</td><td class="t">${T.signals[c[3]]}</td><td>${SIG_FMT[c[3]](c[4])}</td><td>${SIG_FMT[c[3]](c[5])}</td></tr>`;
    }).join("") + "</tbody></table>" : `<p class="empty">No changes match.</p>`;
  if (S.unit && techOf[S.unit]) drawUnit(techOf[S.unit]);
}

function drawUnit(u) {
  const T = S.T, s = TECHS.find((x) => x.id === u.tech);
  const marks = T.changes.filter((c) => c[0] === u.unit).map((c) => c[2]);
  $("unit-detail").hidden = false;
  $("unit-title").textContent = `${u.unit} · ${s.label} (${u.type})`;
  $("unit-note").textContent = `${marks.length} change${marks.length === 1 ? "" : "s"} detected, marked with vertical lines. Days offline are gaps.`;
  const median = u.first.map((v, i) => (v == null || u.rel[i] == null ? null : v - u.rel[i]));
  timeChart($("unit-price"), [
    { label: "First offer price", color: s.color, values: u.first },
    { label: `${s.label} median`, color: "--muted", values: median, dash: "4 3", width: 1.5 },
  ], { title: "First offer price ($/MWh)", H: 170, yFmt: d3.format("$,.0f"), tipFmt: fmtPrice, markers: marks, dots: true });
  timeChart($("unit-share"), [
    { label: "MW offered ≤ $0", color: s.color, values: u.le0 },
    { label: "Share of day with no offer", color: "--muted", values: u.noff, dash: "4 3", width: 1.5 },
  ], { title: "MW offered ≤ $0, and day with no offer (share)", H: 150, yFmt: d3.format(".0%"), markers: marks, dots: true });
  timeChart($("unit-hours"), [{ label: "Hours online", color: s.color, values: u.hours }],
    { title: "Hours online", H: 130, yFmt: d3.format(",.0f"), tipFmt: d3.format(",.1f"), markers: marks });
}

// ---- boot ---------------------------------------------------------------------------
function drawAll() { drawFloor(); drawOnline(); drawScatter(); drawPartial(); drawChanges(); }

async function boot() {
  try { S.T = await getJSON("data/trends_60d.json.gz"); }
  catch (e) { $("status").textContent = "No trends data yet. It is built by the data update workflow."; return; }
  const D = S.T.dates;
  $("status").textContent = `60-day data: ${D.length} days, ${D[0]} to ${D[D.length - 1]} · ${S.T.units.length} thermal units`;
  setSeg("floor-mode", S.floorMode); setSeg("sc-x", S.scX);
  bindSeg("floor-mode", "floorMode", drawFloor);
  bindSeg("sc-x", "scX", drawScatter);
  legend($("floor-legend"), TECHS, S.hidden.floor, drawFloor);
  legend($("online-legend"), TECHS.filter((s) => THERMAL.includes(s.id)), S.hidden.online, drawOnline);
  legend($("partial-legend"), TECHS.filter((s) => THERMAL.includes(s.id)), S.hidden.partial, drawPartial);
  $("sc-tech").innerHTML = TECHS.filter((s) => THERMAL.includes(s.id)).map((s) => `<option value="${s.id}">${s.label}</option>`).join("");
  $("sc-tech").value = S.scTech;
  $("sc-tech").onchange = (e) => { S.scTech = e.target.value; drawScatter(); };
  $("chg-tech").innerHTML = `<option value="all">All</option>` + TECHS.filter((s) => THERMAL.includes(s.id)).map((s) => `<option value="${s.id}">${s.label}</option>`).join("");
  $("chg-sig").innerHTML = `<option value="all">All</option>` + Object.entries(S.T.signals).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
  $("chg-tech").onchange = (e) => { S.chgTech = e.target.value; drawChanges(); };
  $("chg-sig").onchange = (e) => { S.chgSig = e.target.value; drawChanges(); };
  $("chg-table").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-unit]");
    if (!tr) return;
    S.unit = tr.dataset.unit;
    drawUnit(S.T.units.find((u) => u.unit === S.unit));
    $("unit-detail").scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  drawAll();
  let t;
  new ResizeObserver(() => { clearTimeout(t); t = setTimeout(drawAll, 120); }).observe(document.querySelector("main"));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", drawAll);
}
boot();
})();

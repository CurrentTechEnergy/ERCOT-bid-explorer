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
  ["price_sensitive", "Price-sensitive", "--g4", "Units that do turn off on price, each judged at its own cutoff"],
  ["peakers", "Peakers", "--c2", "Combustion turbines, from their history at this price level and hour"],
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
  fc: null, index: null, scores: null, hubs: null, prices_all: null,
  date: null, day: null, gen: null, day60: null, units60: null, prices: null,
  unit: "gw", hour: 12, loc: "hub", unitView: "day", unitTech: "all", unitSearch: "", unitSort: { key: "hsl", dir: -1 }, unitShowAll: false,
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
// the day's cheap stretch: the longest run of hours whose hub price is in the low band
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
  const byG = {}, byT = {}, online = {};
  // a combined-cycle train is one resource per configuration in the 60-day data (NAME_CC1_2);
  // the forecast judges the train (NAME_CC1), as pipeline/forecast/score.py does
  const trainOf = (name, t) => (t === "combined_cycle" ? (name.match(/^(.*_CC\d+)_/) || [])[1] || name : name);
  const onHour = {};
  f.rows.forEach((r) => {
    const [name0, , t] = f.units[r[0]], h = r[1] - 1, out = r[ci.output] || 0, name = trainOf(name0, t);
    if (h < 0 || h > 23) return;
    (byT[t] = byT[t] || HRS.map(() => 0))[h] += out;
    const g = group[name];
    if (g) (byG[g] = byG[g] || HRS.map(() => 0))[h] += out;
    if ((r[ci.online_share] || 0) >= 0.5) (onHour[name] = onHour[name] || new Set()).add(h);
  });
  Object.entries(onHour).forEach(([name, hs]) => (online[name] = hs.size));
  return { group: byG, tech: byT, online, trainOf };
}

// ---------------------------------------------------------------- headline ---
function drawHeadline() {
  const D = S.day, H = D && D.headline;
  const el = $("lede");
  if (!D || !H || H.hub_avg == null) {
    el.innerHTML = `${esc(dayLabel(S.date))} has no day-ahead prices loaded yet.`;
    $("lede-sub").textContent = ""; $("expect").innerHTML = ""; $("track").textContent = ""; return;
  }
  const band = H.band, e = H.band_edges, stretch = cheapStretch(H.hub, e);
  const cd = centralDays();
  const when = S.date === cd.today ? "Today" : S.date === cd.tomorrow ? "Tomorrow" : dayLabel(S.date);
  el.innerHTML = `${esc(when)} in ERCOT is <span class="lvl" style="background:var(${BAND_COLOR[band] || "--c-other"})">${esc(BAND_LABEL[band] || band || "?")}</span> priced.`;
  const place = band === "low" ? "in the bottom quarter of the last twelve months" : band === "high" ? "in the top quarter of the last twelve months" : "in the middle half of the last twelve months";
  const minH = d3.minIndex(H.hub.map((p) => (p == null ? Infinity : p)));
  $("lede-sub").innerHTML = `Day-ahead hub average <b>${fmtPrice0(H.hub_avg)}/MWh</b>, ${place} (bottom quarter under ${fmtPrice0(e[0])}, top quarter above ${fmtPrice0(e[1])}, ${H.band_window.n} days). `
    + (stretch ? `The cheapest stretch is hours ending ${stretch.from + 1} to ${stretch.to + 1} at ${fmtPrice0(stretch.min)} to ${fmtPrice0(stretch.max)}, and each thermal unit is judged on what riding through it would cost at its own node.`
      : `No hour is priced in the low band; the cheapest is hour ending ${minH + 1} at ${fmtPrice0(H.hub[minH])}. Each thermal unit is judged on what riding through its cheapest window would cost at its own node.`);
  const tr = trackRecord();
  const tiles = CATS.map(([k, label, color, note]) => {
    const c = H[k];
    if (!c) return "";
    return `<li><div class="k"><i class="sw" style="background:var(${color})"></i>${label}</div><div class="v">${c.share != null ? fmtPct(c.share) : "–"}</div>` +
      `<div class="w"><b>${fmtGW(c.exp)} GW</b> expected output of ${fmtGW(c.cap)} GW · ${c.n_on} of ${c.n_units} units on</div><div class="w"><b>${fmtGWh(c.gwh)} GWh</b> over the day</div><div class="w2">${note}</div></li>`;
  });
  [WIND, SOLAR].forEach((s) => {
    const r = H[s.id];
    tiles.push(r ? `<li><div class="k"><i class="sw" style="background:var(${s.color})"></i>${s.label}</div><div class="v">${r.avail ? fmtPct(r.disp / r.avail) : "–"}</div>` +
      `<div class="w"><b>${fmtGW(r.disp)} GW</b> dispatched of ${fmtGW(r.avail)} GW available, on average</div><div class="w"><b>${fmtGWh(r.disp_gwh)} of ${fmtGWh(r.avail_gwh)} GWh</b>, ${fmtGWh(r.curt_gwh)} GWh priced out</div><div class="w2">Priced out means offered above its own nodal day-ahead price · ${r.n_units} units, ${fmtGW(r.nameplate)} GW nameplate</div></li>`
      : `<li><div class="k"><i class="sw" style="background:var(${s.color})"></i>${s.label}</div><div class="v">–</div><div class="w">No ${s.label.toLowerCase()} forecast loaded for this day</div><div class="w2">ERCOT's forecast posting is fetched by the update run for the days ahead</div></li>`);
  });
  const gh = genHourly();
  tiles.push(`<li><div class="k"><i class="sw" style="background:var(${STORAGE.color})"></i>${STORAGE.label}</div><div class="v">–</div>` +
    (gh && gh.discharging.some((v) => v != null)
      ? `<div class="w"><b>${fmtGW(d3.max(gh.discharging))} GW</b> discharging at most, <b>${fmtGW(-d3.min(gh.charging))} GW</b> charging at most (2-day actual)</div><div class="w"><b>${fmtGWh(-d3.sum(gh.charging) / 1000)} GWh</b> charged, <b>${fmtGWh(d3.sum(gh.discharging) / 1000)} GWh</b> discharged</div>`
      : `<div class="w">Awaiting battery data</div>`) +
    `<div class="w2">No battery forecast yet: the charge and discharge model follows the battery data load</div></li>`);
  $("expect").innerHTML = tiles.join("");
  $("track").innerHTML = tr
    ? `<b>Track record</b> (${tr.n} days scored, model versions ${esc(Object.entries(S.fc.models).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(", "))}): thermal energy over the day within ${fmtPct(S.scores.headline_tol)} of the 2-day summary on ${fmtPct(tr.headline_hit)} of ${tr.n_two_day} days; each unit's on or off call right on ${fmtPct(tr.unit_hit)} of ${d3.format(",")(tr.n_judged)} unit-days against the 60-day disclosure (${tr.n_sixty_day} days); thermal output off by ${fmtGW(tr.thermal_mae)} GW on average, wind by ${fmtGW(tr.wind_mae)} GW, solar by ${fmtGW(tr.solar_mae)} GW` +
      (tr.by_band && tr.by_band[band] ? `. On ${band} days: thermal within tolerance ${fmtPct(tr.by_band[band].headline_hit)} of ${tr.by_band[band].n_two_day} days, unit calls right ${fmtPct(tr.by_band[band].unit_hit)}.` : ".") +
      (tr.fit && tr.fit.lsl_mae_fit != null ? ` <b>2-day fit</b> (${tr.fit.version}, ${tr.fit.n_sixty_day} days): the committed minimum is off by ${fmtGW(tr.fit.lsl_mae_fc)} GW in the forecast and ${fmtGW(tr.fit.lsl_mae_fit)} GW after the fit; unit calls right ${fmtPct(tr.fit.unit_hit_fc)} and ${fmtPct(tr.fit.unit_hit_fit)}${tr.fit.config_hit != null ? `, combined-cycle configuration right ${fmtPct(tr.fit.config_hit)}` : ""}.` : "")
    : "No scores yet.";
}

// ---- the small price and mix charts beside the headline -----------------------------------
function drawSpark() {
  const el = $("spark"), H = S.day && S.day.headline;
  if (!H || !H.hub) return emptyMsg(el, "No day-ahead hub prices for this day.");
  const w = size(el), Hh = 190, m = { t: 12, r: 12, b: 26, l: 48 };
  const lam = S.prices && S.prices.lambda ? S.prices.lambda.hourly_mean : null;
  const e = H.band_edges || [0, 0];
  const vals = [...H.hub, ...(lam || []), e[1] * 1.15].filter((v) => v != null);
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
  svg.append("path").attr("fill", "none").attr("stroke", css("--accent")).attr("stroke-width", 2).attr("d", line(H.hub));
  const st = cheapStretch(H.hub, e);
  if (st) svg.append("rect").attr("x", x(st.from + 1)).attr("width", x(st.to + 1) - x(st.from + 1)).attr("y", m.t).attr("height", Hh - m.t - m.b).attr("class", "price-band");
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", Hh - m.b).style("display", "none");
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", Hh - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const h = Math.max(0, Math.min(23, Math.round(x.invert(d3.pointer(ev)[0])) - 1));
      cross.style("display", null).attr("x1", x(h + 1)).attr("x2", x(h + 1));
      showTip(ev, `<h4>${heLabel(h)}</h4><table><tr><td>Day-ahead hub average</td><td class="n">${fmtPrice(H.hub[h])}</td></tr>` +
        (lam ? `<tr><td>Real-time system lambda</td><td class="n">${fmtPrice(lam[h])}</td></tr>` : "") + `</table>`);
    }).on("pointerleave", () => { cross.style("display", "none"); hideTip(); });
  el.replaceChildren(svg.node());
  setCSV(el, ["hour_ending", "da_hub_avg", "rt_lambda"], HRS.map((h) => [h + 1, H.hub[h], lam ? lam[h] : null]), `Hub price ${S.date}`);
  $("headline-note").textContent = `${S.date} · forecast`;
  $("spark-note").textContent = `Shaded bands are the bottom quarter, middle half and top quarter of daily hub averages over ${H.band_window.from} to ${H.band_window.to}. ` +
    (lam ? "The dashed line is the real-time system lambda." : "Real-time system lambda is drawn beside the day-ahead line once the day has happened.");
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
    }).on("pointerleave", () => { cross.style("display", "none"); hideTip(); });
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
    `<div class="val"><b>${f(exp)} ${u}</b> expected of ${f(cap * k)} ${u} max` + (act != null ? `<br>${gwh ? fmtGWh(act) : fmtGW(act / 24 * 1000)} ${u} actual` : "") + `</div>`;
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
  if (n("on")) parts.push(`${n("on")} on by verdict`);
  if (n("maybe")) parts.push(`${n("maybe")} maybe, counted on when its award share is at least half`);
  if (n("off")) parts.push(`${n("off")} off by verdict`);
  if (n("peaker")) parts.push(`${n("peaker")} judged hour by hour as peakers`);
  if (n("nocut")) parts.push(`${n("nocut")} with no fitted cutoff`);
  if (n("outage")) parts.push(`${n("outage")} on outage`);
  return parts.join("; ");
}
function drawTechs() {
  const el = $("tech-rows"), D = S.day;
  $("tech-legend").innerHTML = barLegend("--c1") + `<span><span class="sw" style="background:var(--c3);opacity:0.45"></span>Available, priced out</span><span><span class="sw" style="${HATCH}"></span>Not available from the weather</span>`;
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
  html += `<div class="sect">Wind and solar · full bar is nameplate · priced out means offered above its own nodal day-ahead price</div>`;
  [WIND, SOLAR].forEach((s) => {
    const r = D.headline[s.id];
    if (!r) { html += `<div class="lab"><span class="sw" style="background:var(${s.color})"></span><div>${s.label}<small>no forecast loaded for this day</small></div></div><div class="bar"></div><div class="val">–</div>`; return; }
    const k = gwh ? 24 / 1000 : 1 / 1000, f = d3.format(gwh ? ",.0f" : ",.1f");
    const np = r.nameplate || 1, w = (v) => (v / np) * 100;
    const disp = gwh ? r.disp_gwh : r.disp / 1000, avail = gwh ? r.avail_gwh : r.avail / 1000, curt = gwh ? r.curt_gwh : (r.avail - r.disp) / 1000;
    const a2 = sc && sc.two_day ? sc.two_day[`${s.id}_gwh_act`] : null;
    const tip = `<h4>${s.label}</h4><p class="tip-body">${f(disp)} ${u} expected dispatched of ${f(avail)} ${u} available${gwh ? "" : " on average"}, ${f(curt)} ${u} priced out, ${f(np * k - avail)} ${u} not available from the weather · ${r.n_units} units` +
      (a2 != null ? `. Actual over the day (2-day summary): ${fmtGWh(a2)} GWh` : "") + `</p>`;
    html += `<div class="lab"><span class="sw" style="background:var(${s.color})"></span><div>${s.label}<small>${s.id === "wind" ? "the weather sets what is available; the offer sets what runs" : "same, over the daylight hours"}</small></div></div>` +
      `<div class="bar" data-tip-html="${esc(tip)}"><i style="left:0;width:${w(r.avail)}%;background:var(${s.color});opacity:0.45"></i><i style="left:0;width:${w(r.disp)}%;background:var(${s.color})"></i>` +
      `<i style="left:${w(r.avail)}%;width:${w(np - r.avail)}%;${HATCH}"></i>` +
      (a2 != null ? `<i class="act" style="left:calc(${(a2 / (np * 24 / 1000)) * 100}% - 1.5px)"></i>` : "") + `</div>` +
      `<div class="val"><b>${f(disp)} ${u}</b> expected of ${f(avail)} ${u} available` + (a2 != null ? `<br>${gwh ? fmtGWh(a2) : fmtGW(a2 / 24 * 1000)} ${u} actual` : "") + `</div>`;
  });
  const csv = TECHS.filter(([t]) => D.capacity.tech[t]).map(([t, label]) => [label, ...CAP_KEYS.map((k) => D.capacity.tech[t][k]), act(t), null, null, null]);
  [WIND, SOLAR].forEach((s) => { const r = D.headline[s.id]; if (r) csv.push([s.label, r.nameplate, ...CAP_KEYS.slice(1).map(() => null), sc && sc.two_day ? sc.two_day[`${s.id}_gwh_act`] : null, r.avail_gwh, r.disp_gwh, r.curt_gwh]); });
  setCSV(el, ["technology", ...CAP_KEYS, "actual_gwh", "avail_gwh", "disp_gwh", "priced_out_gwh"], csv, `Expected to run by technology ${S.date}`);
  html += `<div class="sect">Storage</div><div class="lab"><span class="sw" style="background:var(${STORAGE.color})"></span><div>Batteries<small>awaiting battery data; no forecast yet</small></div></div><div class="bar"></div><div class="val">–</div>`;
  el.innerHTML = html;
}

// ---------------------------------------------------------------- expected generation by hour ---
function hourlySeries() {
  const h = S.day && S.day.hourly;
  if (!h) return null;
  const out = S.fc.groups.filter((g) => h.group[g]).map((g) => ({ id: g, label: GROUP_SHORT[g] || g, color: GROUP_COLORS[g] || "--c-other", vals: h.group[g].exp, kind: "thermal" }));
  [WIND, SOLAR].forEach((s) => { if (h[s.id]) out.push({ ...s, vals: h[s.id].disp, kind: "renew" }); });
  return out;
}
function drawHourly() {
  const el = $("hourly-chart"), ser = hourlySeries();
  if (!ser) { $("hourly-legend").innerHTML = ""; return emptyMsg(el, "No forecast for this day."); }
  const H = S.day.headline, gh = genHourly();
  const lines = [];
  if (gh) {
    // the actual lines are stacked the same way as the forecast (thermal, then wind on top, then
    // solar), so each line reads against the top of the matching band
    const add = (a, b) => HRS.map((h) => (a[h] == null || b[h] == null ? null : a[h] + b[h]));
    const tw = add(gh.thermal, gh.wind);
    lines.push({ id: "act_thermal", label: "2-day actual: thermal and other", color: "--ink", vals: gh.thermal, dash: null, own: gh.thermal });
    lines.push({ id: "act_wind", label: "2-day actual: wind (stacked on thermal)", color: "--c3", vals: tw, dash: "5 3", own: gh.wind });
    lines.push({ id: "act_solar", label: "2-day actual: solar (stacked on wind)", color: "--c4", vals: add(tw, gh.solar), dash: "5 3", own: gh.solar });
  }
  const minLine = S.day.hourly.fleet.min;
  // the 2-day fit's committed minimum: the online LSL of the units the fit says were on, two days after
  // the day (pipeline/models/two_day_fit); drawn as a line like the forecast's minimum
  const fitLsl = S.fit && S.fit.hourly && S.fit.hourly.lsl_fit;
  if (fitLsl) lines.push({ id: "fit_lsl", label: "2-day fit: committed minimum", color: "--c-other", vals: fitLsl, dash: "2 3", own: fitLsl });
  $("hourly-legend").innerHTML = ser.map((s) => `<button type="button" data-id="${s.id}" aria-pressed="${!S.hidden.has(s.id)}"><span class="sw" style="background:var(${s.color})"></span>${s.label}</button>`).join("") +
    `<span class="legend-static"><span><span class="mk" style="border-color:var(--ink)"></span>Committed thermal minimum (stays on at any price)</span></span>` +
    lines.map((l) => `<button type="button" data-id="${l.id}" aria-pressed="${!S.hidden.has(l.id)}"><span class="sw sw-line" style="border-color:var(${l.color});border-style:${l.dash ? "dashed" : "solid"}"></span>${l.label}</button>`).join("");
  const shown = ser.filter((s) => !S.hidden.has(s.id)), shownLines = lines.filter((l) => !S.hidden.has(l.id));
  const w = size(el), Hh = 340, m = { t: 16, r: 16, b: 30, l: 56 };
  const x = d3.scaleLinear().domain([1, 24]).range([m.l, w - m.r]);
  const tops = HRS.map((i) => d3.sum(shown, (s) => s.vals[i] || 0));
  const ymax = d3.max([...tops, ...shownLines.flatMap((l) => l.vals.filter((v) => v != null)), ...minLine]) || 1;
  const y = d3.scaleLinear().domain([0, ymax]).nice().range([Hh - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${Hh}`);
  const st = cheapStretch(H.hub, H.band_edges);
  if (st) {
    svg.append("rect").attr("class", "price-band").attr("x", x(st.from + 1)).attr("width", x(st.to + 1) - x(st.from + 1)).attr("y", m.t).attr("height", Hh - m.t - m.b);
    svg.append("text").attr("class", "axis-title").attr("x", (x(st.from + 1) + x(st.to + 1)) / 2).attr("y", m.t + 12).attr("text-anchor", "middle").text(`cheap stretch · ${fmtPrice0(st.min)} to ${fmtPrice0(st.max)}`);
  }
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(6).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(6).tickFormat((v) => d3.format(",")(v / 1000)).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${Hh - m.b})`).call(d3.axisBottom(x).tickValues([1, 4, 8, 12, 16, 20, 24]).tickFormat((d) => "HE" + d).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l - 44).attr("y", m.t - 4).text("GW");
  const base = HRS.map(() => 0);
  shown.forEach((s) => {
    const top = s.vals.map((v, i) => base[i] + (v || 0));
    svg.append("path").attr("fill", css(s.color)).attr("stroke", css("--surface")).attr("stroke-width", 0.75)
      .attr("d", d3.area().x((d, i) => x(i + 1)).y0((d, i) => y(base[i])).y1((d, i) => y(top[i]))(HRS));
    HRS.forEach((i) => (base[i] = top[i]));
  });
  const line = d3.line().defined((v) => v != null).x((v, i) => x(i + 1)).y((v) => y(v));
  svg.append("path").attr("fill", "none").attr("stroke", css("--ink")).attr("stroke-width", 1.5).attr("stroke-dasharray", "4 3").attr("opacity", 0.8).attr("d", line(minLine));
  shownLines.forEach((l) => svg.append("path").attr("fill", "none").attr("stroke", css(l.color)).attr("stroke-width", 2).attr("stroke-dasharray", l.dash).attr("d", line(l.vals)));
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", Hh - m.b).style("display", "none");
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", Hh - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const h = Math.max(0, Math.min(23, Math.round(x.invert(d3.pointer(ev)[0])) - 1));
      cross.style("display", null).attr("x1", x(h + 1)).attr("x2", x(h + 1));
      const th = d3.sum(shown.filter((s) => s.kind === "thermal"), (s) => s.vals[h] || 0);
      showTip(ev, `<h4>${heLabel(h)} · hub ${fmtPrice(H.hub[h])}</h4><table>` +
        [...shown].reverse().map((s) => `<tr><td><span class="sw" style="background:var(${s.color})"></span></td><td>${s.label}</td><td class="n">${fmtGW(s.vals[h])} GW</td></tr>`).join("") +
        `<tr><td></td><td>Thermal expected</td><td class="n">${fmtGW(th)} GW</td></tr><tr><td></td><td>Committed minimum</td><td class="n">${fmtGW(minLine[h])} GW</td></tr>` +
        shownLines.map((l) => `<tr><td></td><td>${l.label.replace(/ \(.*\)/, "")}</td><td class="n">${fmtGW(l.own[h])} GW</td></tr>`).join("") + `</table>`);
    }).on("pointerleave", () => { cross.style("display", "none"); hideTip(); });
  el.replaceChildren(svg.node());
  $("hourly-note").textContent = `${S.date} · GW · ${S.day.hourly.model.fleet ? "models " + S.day.hourly.model.fleet : ""}`;
  setCSV(el, ["hour_ending", "da_hub_avg", "committed_min_mw", ...ser.map((s) => `${s.id}_exp_mw`), ...lines.map((l) => `${l.id}_mw`)],
    HRS.map((h) => [h + 1, H.hub[h], minLine[h], ...ser.map((s) => s.vals[h]), ...lines.map((l) => l.own[h])]), `Expected generation ${S.date}`);
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
  [WIND, SOLAR].forEach((s) => rows.push({ ...s, mw: D.hourly[s.id] ? D.hourly[s.id].disp[h] : null, act: a60 && a60.tech[s.id] ? a60.tech[s.id][h] : gh ? gh[s.id][h] : null }));
  if (a60) ["storage", "hydro", "other"].forEach((t) => { if (a60.tech[t]) rows.push({ id: t, label: t === "storage" ? "Storage (ESR), net" : t === "hydro" ? "Hydro" : "Other", color: t === "storage" ? "--c7" : "--c-other", mw: null, act: a60.tech[t][h] }); });
  else if (gh && gh.discharging[h] != null) rows.push({ id: "storage", label: "Storage (ESR), net", color: "--c7", mw: null, act: gh.discharging[h] + gh.charging[h] });
  return rows;
}
function drawMix() {
  const el = $("mix-chart"), tel = $("mix-table"), h = S.hour;
  $("mix-title-note").textContent = S.date ? `${S.date} · ${heLabel(h)}` : "";
  const rows = mixRows(h);
  if (!rows) { tel.innerHTML = ""; return emptyMsg(el, "No forecast for this day."); }
  const total = d3.sum(rows, (r) => Math.max(0, r.mw || 0)), totalAct = rows.some((r) => r.act != null) ? d3.sum(rows, (r) => Math.max(0, r.act || 0)) : null;
  const gh = genHourly(), thermalAct = S.a60 ? null : gh ? gh.thermal[h] : null;
  rows.forEach((r) => { r.share = r.mw != null && total > 0 ? r.mw / total : null; r.actShare = r.act != null && totalAct > 0 && r.act > 0 ? r.act / totalAct : null; });
  rows.sort((a, b) => (b.mw ?? b.act ?? 0) - (a.mw ?? a.act ?? 0));
  const w = size(el), narrow = w < 560, bh = 22, lab = narrow ? 18 : 0, gap = 8 + lab, m = { t: 8 + lab, r: narrow ? 120 : 170, b: 26, l: narrow ? 8 : 180 };
  const Hh = m.t + m.b + rows.length * (bh + gap) - gap;
  const x = d3.scaleLinear().domain([Math.min(0, d3.min(rows, (r) => Math.min(r.mw ?? 0, r.act ?? 0))), Math.max(1, d3.max(rows, (r) => Math.max(r.mw ?? 0, r.act ?? 0)))]).nice().range([m.l, w - m.r]);
  const y = d3.scaleBand().domain(rows.map((r) => r.id)).range([m.t, Hh - m.b]).paddingInner(gap / (bh + gap));
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${Hh}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(0,${Hh - m.b})`).call(d3.axisBottom(x).ticks(narrow ? 3 : 6).tickSize(-(Hh - m.t - m.b)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${Hh - m.b})`).call(d3.axisBottom(x).ticks(narrow ? 3 : 6).tickFormat((v) => d3.format(",")(v / 1000) + " GW").tickSizeOuter(0));
  rows.forEach((r) => {
    const y0 = y(r.id), g = svg.append("g");
    if (r.mw != null && Math.abs(x(r.mw) - x(0)) > 0.5) g.append("rect").attr("x", Math.min(x(0), x(r.mw))).attr("y", y0).attr("width", Math.abs(x(r.mw) - x(0))).attr("height", bh).attr("fill", css(r.color)).attr("rx", 3);
    if (r.act != null) g.append("line").attr("x1", x(r.act)).attr("x2", x(r.act)).attr("y1", y0 - 3).attr("y2", y0 + bh + 3).attr("stroke", css("--ink")).attr("stroke-width", 3);
    g.append("text").attr("class", "mix-label").attr("x", narrow ? m.l : m.l - 10).attr("y", narrow ? y0 - 5 : y0 + bh / 2).attr("dy", narrow ? 0 : "0.35em").attr("text-anchor", narrow ? "start" : "end").text(r.label);
    const val = (r.mw != null ? `${fmtMW(r.mw)} MW` + (r.share != null ? ` · ${fmtPct(r.share)}` : "") : "no forecast") + (r.act != null ? ` · actual ${fmtMW(r.act)}` : "");
    g.append("text").attr("class", "mix-value").attr("x", Math.max(x(0), x(r.mw ?? 0), x(r.act ?? 0)) + 6).attr("y", y0 + bh / 2).attr("dy", "0.35em").text(val);
    g.append("rect").attr("x", 0).attr("y", y0 - gap + 4).attr("width", w).attr("height", bh + gap).attr("fill", "transparent")
      .on("pointermove", (ev) => showTip(ev, `<h4>${r.label} · ${heLabel(h)}</h4><table><tr><td>Expected output</td><td class="n">${r.mw != null ? fmtMW(r.mw) + " MW" : "–"}</td></tr><tr><td>Share of expected generation</td><td class="n">${r.share != null ? d3.format(".1%")(r.share) : "–"}</td></tr>` +
        (r.act != null ? `<tr><td>Actual output</td><td class="n">${fmtMW(r.act)} MW</td></tr><tr><td>Share of actual</td><td class="n">${r.actShare != null ? d3.format(".1%")(r.actShare) : "–"}</td></tr>` : "") + `</table>`))
      .on("pointerleave", hideTip);
  });
  if (x.domain()[0] < 0) svg.append("line").attr("class", "zero").attr("x1", x(0)).attr("x2", x(0)).attr("y1", m.t).attr("y2", Hh - m.b);
  el.replaceChildren(svg.node());
  el.insertAdjacentHTML("beforeend", `<p class="note">Expected generation ${fmtMW(total)} MW in the hour` +
    (totalAct != null ? `; actual ${fmtMW(totalAct)} MW from the ${S.a60 ? "60-day disclosure (output averaged over the hour's SCED runs)" : "2-day summary (base points)"}` : "") +
    (thermalAct != null ? `. Actual thermal and other in the hour: ${fmtMW(thermalAct)} MW against ${fmtMW(d3.sum(rows.filter((r) => TECH_LABEL[r.id]), (r) => r.mw || 0))} MW expected.` : ".") + `</p>`);
  tel.innerHTML = `<table class="data"><thead><tr><th class="t">Technology</th><th>Expected (MW)</th><th>Share</th><th>Actual (MW)</th><th>Share</th></tr></thead><tbody>` +
    rows.map((r) => `<tr><td class="t">${r.label}</td><td>${r.mw != null ? fmtMW(r.mw) : "–"}</td><td>${r.share != null ? d3.format(".1%")(r.share) : "–"}</td><td>${r.act != null ? fmtMW(r.act) : "–"}</td><td>${r.actShare != null ? d3.format(".1%")(r.actShare) : "–"}</td></tr>`).join("") +
    `<tr><td class="t"><b>Total</b></td><td><b>${fmtMW(total)}</b></td><td></td><td><b>${totalAct != null ? fmtMW(totalAct) : "–"}</b></td><td></td></tr></tbody></table>`;
  setCSV(el, ["technology", "expected_mw", "share", "actual_mw", "actual_share"], rows.map((r) => [r.label, r.mw, r.share, r.act, r.actShare]), `Generation mix ${S.date} ${heLabel(h)}`);
}

// ---------------------------------------------------------------- drill-down: price duration ---
function drawDuration() {
  const el = $("duration-chart"), hub = S.loc === "hub";
  const pname = hub ? "Day-ahead hub average" : "Real-time system lambda";
  $("dur-title-note").textContent = pname;
  let vals;
  if (hub) vals = Object.values((S.hubs && S.hubs.days) || {}).flatMap((d) => d.HB_HUBAVG || []);
  else vals = Object.values(S.prices_all || {}).flatMap((e) => e.lambda || []);
  vals = vals.filter((v) => v != null).sort((a, b) => b - a);
  if (vals.length < 2) return emptyMsg(el, "Price history appears here as days with prices are loaded.");
  const w = size(el), Hh = 220, m = { t: 14, r: 16, b: 30, l: 64 };
  const x = d3.scaleLinear().domain([0, 100]).range([m.l, w - m.r]);
  const ext = d3.extent(vals);
  const y = d3.scaleSymlog().constant(20).domain([Math.min(0, ext[0]), Math.max(50, ext[1])]).range([Hh - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${Hh}`);
  const yt = [-250, -50, 0, 25, 50, 100, 500, 1000, 5000].filter((v) => v >= y.domain()[0] && v <= y.domain()[1]);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).tickValues(yt).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${Hh - m.b})`).call(d3.axisBottom(x).ticks(5).tickFormat((d) => d + "%").tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).tickValues(yt).tickFormat(fmtPrice0).tickSizeOuter(0));
  svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(0)).attr("y2", y(0));
  svg.append("path").attr("fill", "none").attr("stroke", css("--price")).attr("stroke-width", 2).attr("d", d3.line().x((v, i) => x((i / (vals.length - 1)) * 100)).y((v) => y(v))(vals));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text(`${pname} ($/MWh), hourly`);
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", 10).attr("text-anchor", "end").text(`${vals.length.toLocaleString()} hours`);
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", Hh - 4).attr("text-anchor", "end").text("Share of hours above the price");
  const pctAbove = (v) => (d3.bisectLeft(vals.map((q) => -q), -v) / (vals.length - 1)) * 100;
  const dayVals = hub ? (S.day && S.day.headline.hub) || [] : (S.prices && S.prices.lambda ? S.prices.lambda.hourly_mean : []);
  const pts = dayVals.map((v, i) => (v != null ? { i, v, x: pctAbove(v) } : null)).filter(Boolean);
  svg.append("g").selectAll("line").data(pts.filter((d) => d.i !== S.hour)).join("line")
    .attr("x1", (d) => x(d.x)).attr("x2", (d) => x(d.x)).attr("y1", (d) => y(d.v) - 5).attr("y2", (d) => y(d.v) + 5).attr("stroke", css("--accent")).attr("stroke-width", 1.5).attr("opacity", 0.6);
  const sel = pts.find((d) => d.i === S.hour);
  if (sel) {
    svg.append("circle").attr("cx", x(sel.x)).attr("cy", y(sel.v)).attr("r", 5).attr("fill", css("--accent")).attr("stroke", css("--surface")).attr("stroke-width", 2);
    const right = x(sel.x) > w - m.r - 230;
    svg.append("text").attr("class", "price-label").attr("x", x(sel.x) + (right ? -10 : 10)).attr("y", y(sel.v) - 8).attr("text-anchor", right ? "end" : "start")
      .text(`${S.date} ${heLabel(S.hour)} · ${fmtPrice(sel.v)}, above ${fmtPct(1 - sel.x / 100)} of hours`);
  }
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", Hh - m.b).style("display", "none");
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", Hh - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const q = Math.max(0, Math.min(100, x.invert(d3.pointer(ev)[0]))), v = vals[Math.round((q / 100) * (vals.length - 1))];
      cross.style("display", null).attr("x1", x(q)).attr("x2", x(q));
      showTip(ev, `<h4>${pname}</h4>${fmtPct(q / 100)} of hours were above ${fmtPrice(v)}`);
    }).on("pointerleave", () => { cross.style("display", "none"); hideTip(); });
  el.replaceChildren(svg.node());
  setCSV(el, ["share_of_hours_above", `${pname} ($/MWh)`], vals.map((v, i) => [i / (vals.length - 1), v]), "Price duration");
}

// ---------------------------------------------------------------- drill-down: units ---
const VERDICT_LABEL = { on: "On", off: "Off", maybe: "Maybe", nocut: "No cutoff yet", outage: "Outage", peaker: "Peaker (by hour)" };
const UNIT_COLS = [
  ["unit", "Unit", "t"], ["tech", "Technology", "tech"], ["group", "Group", "group"], ["hsl", "HSL (MW)"], ["lsl", "LSL (MW)"],
  ["verdict", "Verdict", "verdict"], ["p_on", "Share on", "pct"], ["loss", "Stay-on loss ($)", "$"], ["cutoff", "Cutoff ($)", "$"],
  ["off_hours", "Hours off"], ["reason", "Reason", "t"], ["online_h", "Online hours (60-day)"], ["hit", "Call", "t"],
];
const UNIT_TIPS = {
  verdict: "On, maybe or off from the unit's day-ahead stay-on loss against its fitted cutoff; peakers are judged hour by hour; outage is a unit off for three weeks or more at the last known state; no cutoff yet means too few decision days.",
  p_on: "Expected share of the day on: 1 or 0 for a clear verdict, the unit's award share for a maybe, and the hour-average probability for a peaker.",
  loss: "The worst contiguous window of running at minimum output against the unit's own node day-ahead price: minimum-energy cost minus price, times LSL, summed.",
  cutoff: "The stay-on loss above which this unit has turned off when it held no day-ahead award, fitted on its decision days before this one.",
  off_hours: "Hours the verdict takes the unit off, for a unit with an off window.",
  online_h: "Hours the unit was online in the 60-day disclosure (at least half of the hour's SCED runs).",
  hit: "Right when an on or maybe verdict ran at least 12 hours, or an off verdict ran under 12; peakers and outages are not judged here.",
};
function unitRows() {
  const D = S.day;
  if (!D) return [];
  const C = D.units.columns, a60 = S.a60;
  return D.units.rows.map((r) => {
    const o = Object.fromEntries(C.map((c, i) => [c, r[i]]));
    o.online_h = a60 ? a60.online[o.unit] || 0 : null;
    o.hit = a60 && ["on", "maybe", "off"].includes(o.verdict) ? ((o.verdict === "off") === (o.online_h < 12) ? "right" : "wrong") : null;
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
  const cols = UNIT_COLS.filter(([k]) => (S.a60 || !["online_h", "hit"].includes(k)) && !(hourly && k === "hit"))
    .map(([k, l, kind]) => (hourly && k === "verdict" ? ["state", `Verdict in ${heLabel(h)}`, "verdict"] : hourly && k === "online_h" ? ["online_h", `Online in ${heLabel(h)}`, "yn"] : [k, l, kind]));
  if (hourly && f) cols.push(["out_mw", `Output in ${heLabel(h)} (MW)`]);
  const csvKeys = [...D.units.columns, ...(S.a60 ? ["online_h", "hit"] : []), ...(hourly ? ["state", ...(f ? ["out_mw"] : [])] : [])];
  setCSV(el, csvKeys, rows.map((r) => csvKeys.map((k) => r[k])), `Units ${S.date}${hourly ? " " + heLabel(h) : ""}`);
  const total = rows.length;
  if (!S.unitShowAll) rows = rows.slice(0, PAGE_ROWS);
  const fmt = (r, k, kind) => {
    const v = r[k];
    if (v == null) return "–";
    if (kind === "t") return esc(v);
    if (kind === "tech") return TECH_LABEL[v] || esc(v);
    if (kind === "group") return GROUP_SHORT[v] || esc(v);
    if (kind === "verdict") return VERDICT_LABEL[v] || esc(v);
    if (kind === "pct") return fmtPct(v);
    if (kind === "$") return d3.format("$,.0f")(v);
    if (kind === "yn") return v ? "yes" : "no";
    if (k === "off_hours" || k === "online_h") return d3.format(",.0f")(v);
    return d3.format(",.1f")(v);
  };
  let html = `<div class="units-wrap"><table class="data"><thead><tr>${cols.map(([k, l, kind]) =>
    `<th class="sortable ${["t", "tech", "group", "verdict"].includes(kind) ? "t" : ""}${UNIT_TIPS[k] ? " has-tip" : ""}" data-k="${k}"${UNIT_TIPS[k] ? ` data-tip-title="${esc(l)}" data-tip="${esc(UNIT_TIPS[k])}"` : ""} aria-sort="${k === key ? (dir > 0 ? "ascending" : "descending") : "none"}">${l}${k === key ? (dir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead><tbody>`;
  html += rows.map((r) => `<tr>${cols.map(([k, , kind]) => `<td class="${["t", "tech", "group", "verdict"].includes(kind) ? "t" : ""}">${fmt(r, k, kind)}</td>`).join("")}</tr>`).join("");
  el.innerHTML = html + "</tbody></table></div>";
  const sc = dayScore();
  $("units-foot").innerHTML = (total > rows.length ? `Showing ${rows.length} of ${total} units. <button type="button" id="units-all" class="linkish">Show all</button>` : `Units: ${total}.`) +
    (sc && sc.sixty_day ? ` On or off calls right on ${fmtPct(sc.sixty_day.unit_hit)} of the ${sc.sixty_day.n_judged} judged units this day.` : "") +
    " The CSV download has every column, including the model and version behind each row.";
  $("units-note").textContent = `${S.date} · ${D.units.rows.length} thermal trains · models ${D.models.thermal_cutoff} (cutoff), ${D.models.peaker_share} (peakers)`;
  const b = $("units-all");
  if (b) b.onclick = () => { S.unitShowAll = true; drawUnits(); };
}

// ---------------------------------------------------------------- layers strip ---
// one sentence on the 2-day fit: how far it moved the committed minimum, and how many units it changed
function fitSummary() {
  const f = S.fit, sc = dayScore(), fs = sc && sc.fit;
  const lsl = (a) => fmtGW(d3.mean(a));
  let t = `. 2-day fit (${f.model} ${f.version}): committed minimum ${lsl(f.hourly.lsl_forecast)} GW forecast, ${lsl(f.hourly.lsl_fit)} GW fitted on average over the day, ${f.inputs.n_changed} of ${f.inputs.n_candidates} units changed, residual against the 2-day curve ${fmtPct(1 - f.residual.after / f.residual.before)} lower`;
  if (fs && fs.lsl_mae_fit != null) t += `; against the 60-day answer the committed minimum was off by ${fmtGW(fs.lsl_mae_fc)} GW in the forecast and ${fmtGW(fs.lsl_mae_fit)} GW after the fit, unit calls right ${fmtPct(fs.unit_hit_fc)} and ${fmtPct(fs.unit_hit_fit)}`;
  return t;
}
function drawLayers() {
  const d = S.date, known = S.day && S.day.inputs;
  const sc = dayScore();
  const card = (n, title, state, body) => `<div class="layer ${state === "now" ? "now" : ""}"><span class="st">${n} · ${title} · ${state === "now" ? "shown" : state}</span><p>${body}</p></div>`;
  $("layers").innerHTML =
    card(1, "Forecast", "now", known ? `from day-ahead ${known.node_prices === "dam" ? "node" : "node (last 14 days' file)"} prices and unit states known on ${known.known_date}` : "no forecast file for this day") +
    card(2, "2-day summary and fit", has("2dgen") || S.fit ? "in" : "in 2 days",
      (has("2dgen") ? (sc && sc.two_day ? `thermal energy ${sc.two_day.headline_hit ? "within" : "outside"} tolerance; actual lines drawn on the hourly chart` : "actual lines drawn on the hourly chart") : "scores the thermal, wind and solar energy over the day") +
      (S.fit ? fitSummary() : has("2d") ? "" : "; the fit of the committed set to the 2-day thermal curve follows the 2-day curves")) +
    card(3, "60-day answer", has("60d") ? "in" : "in 60 days", has("60d") ? (sc && sc.sixty_day ? `unit calls right ${fmtPct(sc.sixty_day.unit_hit)}; actual ticks on the bars and the units table` : "actual ticks on the bars and the units table") : "scores each unit's on or off call and each group's energy");
  $("source-note").textContent = known ? `Forecast built ${S.fc.updated.slice(0, 10)} · curves from ${known.curve_month}` : "";
}

// ---------------------------------------------------------------- render ---
function render() {
  const days = S.fc.days, di = days.indexOf(S.date);
  $("date-prev").disabled = di <= 0;
  $("date-next").disabled = di < 0 || di >= days.length - 1;
  $("hour-out").textContent = `${heLabel(S.hour)} · ${String(S.hour).padStart(2, "0")}:00–${String(S.hour + 1).padStart(2, "0")}:00`;
  drawLayers(); drawHeadline(); drawSpark(); drawMini(); drawGroups(); drawTechs(); drawHourly(); drawScore(); drawMix(); drawDuration(); drawUnits();
  saveView();
}
function renderHour() {
  $("hour-out").textContent = `${heLabel(S.hour)} · ${String(S.hour).padStart(2, "0")}:00–${String(S.hour + 1).padStart(2, "0")}:00`;
  drawMix(); drawDuration(); if (S.unitView === "hour") drawUnits();
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
function saveView() { window.CX.writeHash({ date: S.date, he: S.hour + 1, unit: S.unit, loc: S.loc, uv: S.unitView }); }
function loadView() {
  const v = window.CX.readHash();
  if (v.date) S.date = v.date;
  if (v.he && +v.he >= 1 && +v.he <= 24) S.hour = +v.he - 1;
  if (["gw", "gwh"].includes(v.unit)) S.unit = v.unit;
  if (["hub", "lambda"].includes(v.loc)) S.loc = v.loc;
  if (["day", "hour"].includes(v.uv)) S.unitView = v.uv;
}

async function boot() {
  S.fc = await tryJSON("data/forecast/index.json.gz");
  if (!S.fc || !S.fc.days || !S.fc.days.length) { $("status").textContent = "No forecast files yet. They are built by the data update workflow."; return; }
  [S.index, S.scores, S.hubs, S.prices_all] = await Promise.all([tryJSON("data/index.json"), tryJSON("data/forecast/scores.json.gz"), tryJSON("data/dam_hubs.json.gz"), tryJSON("data/summary_prices.json.gz")]);
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
  setSeg("unit-g", S.unit); setSeg("unit-t", S.unit); setSeg("dur-loc", S.loc); setSeg("unit-view", S.unitView);
  const unitSeg = (id, other) => $(id).addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; S.unit = b.dataset.v; setSeg(id, S.unit); setSeg(other, S.unit); drawGroups(); drawTechs(); saveView(); });
  unitSeg("unit-g", "unit-t"); unitSeg("unit-t", "unit-g");
  bindSeg("dur-loc", "loc", drawDuration);
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
    S.unitSort = { key: k, dir: S.unitSort.key === k ? -S.unitSort.dir : (["unit", "tech", "group", "verdict", "reason", "state", "hit"].includes(k) ? 1 : -1) };
    drawUnits();
  });
  $("hourly-legend").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-id]");
    if (!b) return;
    S.hidden.has(b.dataset.id) ? S.hidden.delete(b.dataset.id) : S.hidden.add(b.dataset.id);
    drawHourly();
  });
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

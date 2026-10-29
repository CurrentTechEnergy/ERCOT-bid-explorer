/* A day in ERCOT: what ran on a day, from ERCOT's own reports. Reads the day's real-time prices
   (data/prices/<date>.json.gz), the day-ahead system lambda (dam_lambda.json.gz), the 2-day
   generation summary (data/2dgen/<date>.json.gz) and, once the day is in the 60-day disclosure,
   its per-unit hours (data/60d-units/<date>.json.gz) with each unit's group (groups_60d.json.gz).
   The page sums and takes shares; nothing on it is a forecast. */
(() => {
"use strict";
const { tryJSON, showTip, hideTip, setCSV, css, esc, axisFmt } = window.CX;
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
const addDays = (d, n) => { const t = new Date(d + "T12:00:00"); t.setDate(t.getDate() + n); return t.toISOString().slice(0, 10); };

// ---- series: colours are fixed per group, technology and category -----------------------
const GROUP_COLORS = { never: "--g1", multiday: "--g3", daily1: "--g4", daily2: "--g5", daily3: "--g6", peakers: "--c2", never_on: "--c-other", ungrouped: "--c-other" };
const GROUP_NOTES = {
  never: "off only for outages, never on price, plus nuclear", multiday: "shortest time off is a day or more",
  daily1: "turns off within a day, under once a week", daily2: "turns off within a day, 1 to 2 a week", daily3: "turns off within a day, over 2 a week",
  peakers: "run like peakers: online under 30% of available hours, at most 16 hours a day when on",
  never_on: "no running hour in the 60-day history (mothballed or on a long outage)", ungrouped: "no hourly history yet",
};
const GROUP_SHORT = { never: "Always on when available", multiday: "Multi-day", daily1: "Daily, under once a week", daily2: "Daily, 1 to 2 a week", daily3: "Daily, over 2 a week", peakers: "Peakers", never_on: "Never on", ungrouped: "Not yet grouped" };
// "peakers" is not a timescale group: the units groups_60d flags as peakers by how they run, taken out of
// their groups wherever thermal output is shown by group
const GROUPS = ["never", "multiday", "daily1", "daily2", "daily3", "peakers", "never_on", "ungrouped"];
const TECHS = [
  ["nuclear", "Nuclear", "--c5"], ["coal", "Coal & lignite", "--c8"], ["combined_cycle", "Combined cycle", "--c1"],
  ["gas_steam", "Gas steam", "--c6"], ["combustion_turbine", "Combustion turbine", "--c2"],
];
const TECH_LABEL = Object.fromEntries(TECHS.map(([id, l]) => [id, l]));
const CATS = [
  ["baseload", "Baseload", "--g1", "Units that never turn off on price, plus nuclear"],
  ["price_sensitive", "Price-sensitive", "--g4", "Units outside the always-on group that run more than peakers: they turn off when staying on costs too much"],
  ["peakers", "Peakers", "--c2", "Units that run like peakers, whatever their technology: online under 30% of available hours, at most 16 hours a day when on"],
];
const WIND = { id: "wind", label: "Wind", color: "--c3" }, SOLAR = { id: "solar", label: "Solar", color: "--c4" };
const STORAGE = { id: "storage", label: "Batteries", color: "--c7" };
// an hour is cheap when real-time system lambda averages this or less ($/MWh)
const CHEAP = 10;
// the 2-day generation summary's thermal total: non-IRR plus "remaining resources" (nuclear and
// the rest); before this date the summary folded storage into non-IRR, so storage is taken back
// out (the same rule pipeline/forecast/score.py applies)
const ESR_SPLIT_DATE = "2026-06-22";
// the 60-day disclosure posts about this many days after the operating day
const LAG_60D = 60;
const PAGE_ROWS = 150;
// profit in the Units table, on the Unit page's default bases (unit-econ.js): EIA average heat
// rates (Electric Power Annual table 8.2, 2024, MMBtu/MWh), generic variable O&M ($/MWh) and hot
// start ($) where the unit has no DAM start offer, coal and nuclear fuel at a flat $/MMBtu
const ECON = {
  combined_cycle: { hr: 7.548, vom: 3.0, start: 15000 }, combustion_turbine: { hr: 10.999, vom: 5.0, start: 3000 },
  gas_steam: { hr: 10.337, vom: 4.0, start: 10000 }, coal: { hr: 10.018, vom: 5.0, start: 30000, fuel: 2.0 },
  nuclear: { hr: 10.443, vom: 2.5, start: 0, fuel: 0.7 },
};

// ---------------------------------------------------------------- state ---
const S = {
  index: null, dalam: null, groups: null, days: [],
  date: null, gen: null, units60: null, unitHours: null, prices: null, a60: null, dam: null, rtNodes: null, fuelCost: null, gasHH: null,
  limBy: "group", hour: 12, unitView: "day", unitTech: "all", unitSearch: "", unitSort: { key: "hsl", dir: -1 }, unitShowAll: false,
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
const last60 = () => (S.index.days["60d"] || []).at(-1);
// the day's prices by hour: real-time system lambda (the hourly mean of its 5-minute values) and
// the day-ahead system lambda, both as published
function dayPrices() {
  const rt = S.prices && S.prices.lambda ? S.prices.lambda.hourly_mean : null;
  const da = (S.dalam && S.dalam.days && S.dalam.days[S.date]) || null;
  return { rt, da, ref: rt || da };
}
// the day's cheap hours: real-time lambda at or below CHEAP
function cheapHours() {
  const { ref } = dayPrices();
  return ref ? HRS.filter((h) => ref[h] != null && ref[h] <= CHEAP) : [];
}
// runs of consecutive cheap hours, for shading
function cheapRuns() {
  const hs = cheapHours(), out = [];
  hs.forEach((h) => { const r = out.at(-1); if (r && r.to === h - 1) r.to = h; else out.push({ from: h, to: h }); });
  return out;
}
// which data leads the page for this day: the 60-day disclosure or the 2-day summary
function lead() { return S.a60 ? "60d" : genHourly() ? "2d" : null; }
// the 2-day generation summary's hourly thermal, wind, solar and storage (MW)
function genHourly() {
  const g = S.gen && S.gen.hourly;
  if (!g) return null;
  const v = (k) => (g[k] || []).map((x) => (x == null ? null : x));
  const esrOut = (h) => (S.date < ESR_SPLIT_DATE ? v("sum_base_point_esr")[h] || 0 : 0);
  const thermal = HRS.map((h) => {
    const a = v("sum_base_point_non_irr")[h], b = v("sum_base_point_remaining_res")[h];
    return a == null || b == null ? null : a + b - esrOut(h);
  });
  // ERCOT's own categories as reported: non-IRR (thermal; storage taken out before the split
  // date), remaining resources (nuclear, hydro and the rest), wind, solar, batteries
  const nonIrr = HRS.map((h) => { const a = v("sum_base_point_non_irr")[h]; return a == null ? null : a - esrOut(h); });
  return { thermal, nonIrr, remaining: v("sum_base_point_remaining_res"), wind: v("sum_base_point_wgr"), solar: v("sum_base_point_pvgr"),
    charging: v("sum_base_point_esr_charging"), discharging: v("sum_base_point_esr_discharging") };
}
// a combined-cycle train is one resource per configuration in the 60-day data (NAME_CC1_2); the
// groups and the units table judge the train (NAME_CC1)
const trainOf = (name, t) => (t === "combined_cycle" ? (name.match(/^(.*_CC\d+)_/) || [])[1] || name : name);
const groupOf = (name) => (S.groups && S.groups.units[name] ? S.groups.units[name][1] : "ungrouped");
// nuclear and the always-on group are baseload, the units groups_60d flags as peakers (by how they
// run: pipeline/groups.py is_peaker) are peakers, the rest of the thermal fleet is price-sensitive
const isPeaker = (name) => !!(S.groups && S.groups.units[name] && S.groups.units[name][9]);
const catOf = (t, g, name) => (t === "nuclear" || g === "never" ? "baseload" : isPeaker(name) ? "peakers" : "price_sensitive");
const THERMAL = new Set(TECHS.map(([t]) => t));
// 60-day output by group, technology and category, hour by hour, and each thermal train's hours
function actual60() {
  const f = S.units60;
  if (!f) return null;
  const ci = Object.fromEntries(f.columns.map((c, i) => [c, i + 2]));
  const zero = () => HRS.map(() => 0);
  const byG = {}, byT = {}, byC = {}, capG = {}, capT = {}, dis = zero(), chg = zero();
  // online LSL and HSL hour by hour (MW summed over the units online), by group and technology
  const lslG = {}, hslG = {}, lslT = {}, hslT = {};
  const add = (o, k, h, v) => ((o[k] = o[k] || zero())[h] += v || 0);
  // wind and solar: each unit's largest hourly HSL over the day
  const renMax = {}, onT = {};
  // per train and hour: online (any configuration online at least half the hour's runs), output, HSL, LSL
  const units = {};
  f.rows.forEach((r) => {
    const [name0, , t] = f.units[r[0]], h = r[1] - 1, out = r[ci.output] || 0;
    if (h < 0 || h > 23) return;
    (byT[t] = byT[t] || zero())[h] += out;
    if (t === "storage") (out >= 0 ? dis : chg)[h] += out;
    const online = (r[ci.online_share] || 0) >= 0.5;
    if (online && t !== "storage") { add(lslT, t, h, r[ci.lsl]); add(hslT, t, h, r[ci.hsl]); }
    if (t === "wind" || t === "solar") {
      const m = renMax[t] = renMax[t] || {}; m[name0] = Math.max(m[name0] || 0, r[ci.hsl] || 0);
      if (out > 0) add(onT, t, h, 1);    // wind and solar: a unit counts as running in an hour with output
    }
    if (!THERMAL.has(t)) return;
    const name = trainOf(name0, t), g = t === "nuclear" ? "never" : groupOf(name);
    const c = catOf(t, g, name);
    (byC[c] = byC[c] || zero())[h] += out;
    // output by group, with peakers taken out of their groups into their own
    const k = c === "peakers" ? "peakers" : g;
    (byG[k] = byG[k] || zero())[h] += out;
    const u = units[name] || (units[name] = { unit: name, tech: t, group: g, gk: k, on: zero(), out: zero(), hsl: zero(), lsl: zero() });
    if (online) { add(lslG, k, h, r[ci.lsl]); add(hslG, k, h, r[ci.hsl]); }
    if (online) { u.on[h] = 1; u.lsl[h] += r[ci.lsl] || 0; }
    u.out[h] += out; u.hsl[h] += r[ci.hsl] || 0;
  });
  // capacity: each train's largest hourly HSL over the day, summed by group and technology (wind
  // and solar likewise, by unit); and
  // the thermal trains online in each hour
  const onG = {};
  Object.values(units).forEach((u) => {
    u.hslMax = d3.max(u.hsl); u.lslMax = d3.max(u.lsl); u.online_h = d3.sum(u.on); u.mwh = d3.sum(u.out);
    capG[u.gk] = (capG[u.gk] || 0) + u.hslMax; capT[u.tech] = (capT[u.tech] || 0) + u.hslMax;
    HRS.forEach((h) => { add(onG, u.gk, h, u.on[h]); add(onT, u.tech, h, u.on[h]); });
  });
  Object.entries(renMax).forEach(([t, m]) => (capT[t] = d3.sum(Object.values(m))));
  // how many units each group and technology has, for "x of n units online": every grouped thermal
  // unit or train but the never-on ones, plus any seen in the day that has no group yet (nuclear);
  // wind and solar, every unit in the day's file
  const setG = {}, setT = {}, put = (o, k, n) => (o[k] = o[k] || new Set()).add(n);
  Object.entries((S.groups && S.groups.units) || {}).forEach(([n, v]) => {
    const [t, g] = v;
    if (g === "never_on") return;
    put(setG, catOf(t, g, n) === "peakers" ? "peakers" : g, n); put(setT, t, n);
  });
  Object.values(units).forEach((u) => { put(setG, u.gk, u.unit); put(setT, u.tech, u.unit); });
  Object.keys(renMax).forEach((t) => Object.keys(renMax[t]).forEach((n) => put(setT, t, n)));
  const count = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.size]));
  return { group: byG, tech: byT, cat: byC, capG, capT, lslG, hslG, lslT, hslT, onG, onT, nG: count(setG), nT: count(setT), dis, chg, units };
}

// thermal capacity that was not online, hour by hour: each unit's or train's hours offline but
// available (unit_hours_60d "0") and on outage (ERCOT's OUT status, "o"), with no configuration
// running, at its full output (its largest configuration's median HSL when running, or the day's
// largest HSL if higher; the 60-day data gives no HSL while offline), by group (peakers on their
// own) and technology. Never-on units (mothballed or on a long outage) are left out
function offline60() {
  const uh = S.unitHours, i = uh ? uh.dates.indexOf(S.date) : -1;
  if (i < 0 || !S.groups) return null;
  const trains = {}, none = () => HRS.map(() => false);
  Object.entries(uh.units).forEach(([n, strip]) => {
    const cc = /_CC\d+_/.test(n), name = cc ? trainOf(n, "combined_cycle") : n, gu = S.groups.units[name], du = S.a60.units[name];
    const tech = gu ? gu[0] : du ? du.tech : null;    // nuclear has no group
    if (!tech || (gu && gu[1] === "never_on")) return;
    const e = trains[name] || (trains[name] = { name, tech, run: none(), off: none(), out: none(), mw: (du && du.hslMax) || 0 });
    const day = strip.slice(i * 24, i * 24 + 24);
    HRS.forEach((h) => { const c = day[h]; if (c === "m" || c === "a") e.run[h] = true; else if (c === "o") e.out[h] = true; else if (c === "0") e.off[h] = true; });
    e.mw = Math.max(e.mw, (uh.hsl && uh.hsl[n]) || 0);
  });
  const G = {}, T = {}, add = (o, k, u) => {
    const x = o[k] || (o[k] = { off: 0, nOff: 0, gwh: 0, units: [] });
    x.off += u.hOff * u.mw / 1000; if (u.hOff) x.nOff += 1;
    if (u.h) { x.gwh += u.h * u.mw / 1000; x.units.push(u); }
  };
  Object.values(trains).forEach((e) => {
    const mw = e.mw || (S.groups.units[e.name] || [])[2] || 0;
    const h = d3.sum(HRS, (k) => (e.out[k] && !e.run[k] ? 1 : 0)), hOff = d3.sum(HRS, (k) => (e.off[k] && !e.run[k] && !e.out[k] ? 1 : 0));
    if (!mw || (!h && !hOff)) return;
    const g = e.tech === "nuclear" ? "never" : groupOf(e.name), u = { name: e.name, h, hOff, mw };
    add(G, catOf(e.tech, g, e.name) === "peakers" ? "peakers" : g, u); add(T, e.tech, u);
  });
  [G, T].forEach((o) => Object.values(o).forEach((x) => x.units.sort((a, b) => b.h * b.mw - a.h * a.mw)));
  return { group: G, tech: T };
}

// ---------------------------------------------------------------- headline ---
function drawHeadline() {
  const el = $("lede"), L = lead(), { rt, da, ref } = dayPrices(), a60 = S.a60, gh = genHourly();
  const arrives = addDays(S.date, LAG_60D);
  if (!ref) el.innerHTML = `${esc(dayLabel(S.date))} has no prices loaded yet.`;
  else {
    const ok = ref.filter((v) => v != null), avg = d3.mean(ok), nCheap = cheapHours().length;
    el.innerHTML = `${esc(dayLabel(S.date))}: ${rt ? "real-time" : "day-ahead"} system lambda averaged <b>${fmtPrice0(avg)}/MWh</b>, from ${fmtPrice0(d3.min(ok))} to ${fmtPrice0(d3.max(ok))}.`;
    $("lede-sub").innerHTML = (nCheap ? `<b>${nCheap} hour${nCheap > 1 ? "s" : ""}</b> at ${fmtPrice0(CHEAP)} or less. ` : `No hour at ${fmtPrice0(CHEAP)} or less. `) +
      (L === "60d" ? "Each unit's hours are in, from the 60-day disclosure: who ran and who turned off is on Commitment."
        : `Unit detail for this day arrives with the 60-day disclosure, about ${esc(dayLabel(arrives))}; until then the page shows ERCOT's 2-day summary in total.`);
  }
  if (!ref) $("lede-sub").textContent = "";
  const tiles = [];
  const tile = (label, color, gwh, avgLine, note, src) => `<li><div class="k"><i class="sw" style="background:var(${color})"></i>${label}</div><div class="v">${fmtGWh(gwh)} GWh</div>` +
    `<div class="w">${avgLine} (${src})</div><div class="w2">${note}</div></li>`;
  const avgOf = (vals) => { const ok = vals.filter((v) => v != null), pk = d3.max(ok), pkH = d3.maxIndex(vals.map((v) => (v == null ? -Infinity : v))); return `<b>${fmtGW(d3.sum(ok) / 24)} GW</b> on average, <b>${fmtGW(pk)} GW</b> at most in ${heLabel(pkH)}`; };
  if (a60) {
    CATS.forEach(([k, label, color, note]) => { if (a60.cat[k]) tiles.push(tile(label, color, d3.sum(a60.cat[k]) / 1000, avgOf(a60.cat[k]), note, "60-day disclosure")); });
  } else if (gh && gh.nonIrr.some((v) => v != null)) {
    tiles.push(tile("Thermal (non-IRR)", "--g3", d3.sum(gh.nonIrr.filter((v) => v != null)) / 1000, avgOf(gh.nonIrr), "ERCOT's non-intermittent renewable resources: the gas, coal and other dispatchable units, by base point", "2-day summary"));
    tiles.push(tile("Remaining resources", "--c-other", d3.sum(gh.remaining.filter((v) => v != null)) / 1000, avgOf(gh.remaining), "ERCOT's remaining resources: nuclear, hydro and the rest outside the other categories, by base point", "2-day summary"));
  }
  [WIND, SOLAR].forEach((s) => {
    const vals = a60 && a60.tech[s.id] ? a60.tech[s.id] : gh ? gh[s.id] : null;
    if (vals && vals.some((v) => v != null)) tiles.push(tile(s.label, s.color, d3.sum(vals.filter((v) => v != null)) / 1000, avgOf(vals), s.id === "wind" ? "the weather sets what is available; the offer sets what runs" : "same, over the daylight hours", a60 ? "60-day disclosure" : "2-day summary"));
  });
  const dis = a60 && a60.tech.storage ? a60.dis : gh && gh.discharging.some((v) => v != null) ? gh.discharging : null;
  const chg = a60 && a60.tech.storage ? a60.chg : gh ? gh.charging : null;
  if (dis) {
    tiles.push(`<li><div class="k"><i class="sw" style="background:var(${STORAGE.color})"></i>${STORAGE.label}</div><div class="v">${fmtGW(d3.max(dis))} GW</div>` +
      `<div class="w"><b>${fmtGW(d3.max(dis))} GW</b> discharging at the peak hour, <b>${fmtGW(-d3.min(chg))} GW</b> charging at most (${a60 ? "60-day disclosure" : "2-day summary"})</div>` +
      `<div class="w"><b>${fmtGWh(d3.sum(dis) / 1000)} GWh</b> discharged, <b>${fmtGWh(-d3.sum(chg) / 1000)} GWh</b> charged over the day</div><div class="w2">the whole battery fleet</div></li>`);
  }
  $("expect").innerHTML = tiles.join("") || `<li><div class="w">No generation data for this day yet.</div></li>`;
  $("headline-note").textContent = `${S.date} · ${L === "60d" ? "60-day disclosure" : L === "2d" ? "2-day summary" : "prices only"}`;
  $("decisions-link").innerHTML = L === "60d"
    ? `<a href="commitment.html#date=${S.date}">Which coal and gas units turned off on ${esc(dayLabel(S.date))}, and at what loss: Commitment →</a>`
    : `<a href="commitment.html#date=${last60()}">Unit decisions are in through ${esc(dayLabel(last60()))}: Commitment →</a>`;
}

// ---- the price chart beside the headline --------------------------------------------------
function drawSpark() {
  const el = $("spark"), { rt, da, ref } = dayPrices();
  if (!ref) { $("spark-note").textContent = ""; return emptyMsg(el, "No prices for this day."); }
  const w = size(el), Hh = 170, m = { t: 16, r: 16, b: 26, l: 56 };   // same side margins as the generation chart below, so the hours line up
  $("spark-title").textContent = rt && da ? "System lambda by hour ending ($/MWh): real-time solid, day-ahead dashed" : `${rt ? "Real-time" : "Day-ahead"} system lambda by hour ending ($/MWh)`;
  const vals = [...(rt || []), ...(da || []), CHEAP * 2].filter((v) => v != null);
  const x = d3.scaleLinear().domain([1, 24]).range([m.l, w - m.r]);
  const y = d3.scaleLinear().domain([Math.min(0, d3.min(vals)), d3.max(vals)]).nice().range([Hh - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${Hh}`);
  cheapRuns().forEach((r) => svg.append("rect").attr("class", "price-band").attr("x", x(r.from + 1) - 4).attr("width", x(r.to + 1) - x(r.from + 1) + 8).attr("y", m.t).attr("height", Hh - m.t - m.b));
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y), 4, "$").tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${Hh - m.b})`).call(d3.axisBottom(x).tickValues([1, 4, 8, 12, 16, 20, 24]).tickFormat((d) => "HE" + d).tickSizeOuter(0));
  if (y.domain()[0] < 0) svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(0)).attr("y2", y(0));
  const line = d3.line().defined((v) => v != null).x((v, i) => x(i + 1)).y((v) => y(v));
  if (rt && da) svg.append("path").attr("fill", "none").attr("stroke", css("--ink")).attr("stroke-width", 1.5).attr("stroke-dasharray", "4 3").attr("opacity", 0.6).attr("d", line(da));
  svg.append("path").attr("fill", "none").attr("stroke", css("--accent")).attr("stroke-width", 2).attr("d", line(ref));
  svg.append("line").attr("class", "crosshair pin-mark").attr("x1", x(S.hour + 1)).attr("x2", x(S.hour + 1)).attr("y1", m.t).attr("y2", Hh - m.b);
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", Hh - m.b).style("display", "none");
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", Hh - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const h = Math.max(0, Math.min(23, Math.round(x.invert(d3.pointer(ev)[0])) - 1));
      cross.style("display", null).attr("x1", x(h + 1)).attr("x2", x(h + 1));
      showTip(ev, `<h4>${heLabel(h)}</h4><table>` + (rt ? `<tr><td>Real-time system lambda</td><td class="n">${fmtPrice(rt[h])}</td></tr>` : "") +
        (da ? `<tr><td>Day-ahead system lambda</td><td class="n">${fmtPrice(da[h])}</td></tr>` : "") + `</table>`);
    }).on("pointerleave", () => { cross.style("display", "none"); hideTip(); })
    .on("click", (ev) => pickHour(Math.round(x.invert(d3.pointer(ev)[0])) - 1)).style("cursor", "pointer");
  el.replaceChildren(svg.node());
  setCSV(el, ["hour_ending", "rt_lambda", "da_lambda"], HRS.map((h) => [h + 1, rt ? rt[h] : null, da ? da[h] : null]), `System lambda ${S.date}`);
  $("spark-note").textContent = `Shaded hours averaged ${fmtPrice0(CHEAP)}/MWh or less${rt ? " in real time" : ""}.` + (rt && da ? " The dashed line is the day-ahead system lambda, as cleared the day before." : "");
}

// ---------------------------------------------------------------- what ran by hour ---
// a line drawn over the bands: ink with a halo of the page background, so it reads on any band
function haloLine(svg, d, color, width, dash, opacity) {
  svg.append("path").attr("fill", "none").attr("stroke", css("--surface")).attr("stroke-width", width + 2.5).attr("opacity", 0.8).attr("d", d);
  svg.append("path").attr("fill", "none").attr("stroke", css(color)).attr("stroke-width", width).attr("stroke-dasharray", dash).attr("opacity", opacity == null ? 1 : opacity).attr("d", d);
}
// a stacked area chart by hour: `areas` stack upward from zero, `below` stack downward from zero
// (load, such as batteries charging); legend buttons toggle any of them through S.hidden under the
// chart's own prefix
function areaChart({ el, legendEl, areas, below = [], prefix, tipRows, csvName }) {
  const key = (s) => `${prefix}:${s.id}`, shownOf = (xs) => xs.filter((s) => !S.hidden.has(key(s)));
  const btn = (s) => `<button type="button" data-id="${key(s)}" aria-pressed="${!S.hidden.has(key(s))}"><span class="sw" style="background:var(${s.color})"></span>${s.label}</button>`;
  legendEl.innerHTML = areas.map(btn).join("") + below.map(btn).join("");
  const shown = shownOf(areas), shownBelow = shownOf(below);
  const w = size(el), Hh = 340, m = { t: 16, r: 16, b: 30, l: 56 };
  const x = d3.scaleLinear().domain([1, 24]).range([m.l, w - m.r]);
  const tops = HRS.map((i) => d3.sum(shown, (s) => s.vals[i] || 0)), bottoms = HRS.map((i) => d3.sum(shownBelow, (s) => Math.min(0, s.vals[i] || 0)));
  const ymax = d3.max(tops) || 1, ymin = Math.min(0, d3.min(bottoms) || 0);
  const y = d3.scaleLinear().domain([ymin, ymax]).nice().range([Hh - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${Hh}`);
  const runs = cheapRuns(), { ref } = dayPrices();
  runs.forEach((r) => svg.append("rect").attr("class", "price-band").attr("x", x(r.from + 1) - 4).attr("width", x(r.to + 1) - x(r.from + 1) + 8).attr("y", m.t).attr("height", Hh - m.t - m.b));
  const longest = runs.reduce((a, r) => (!a || r.to - r.from > a.to - a.from ? r : a), null);
  if (longest && longest.to > longest.from) svg.append("text").attr("class", "axis-title").attr("x", (x(longest.from + 1) + x(longest.to + 1)) / 2).attr("y", m.t + 12).attr("text-anchor", "middle").text(`lambda ${fmtPrice0(CHEAP)} or less`);
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
  // the picked hour, which the generation mix below shows
  svg.append("line").attr("class", "crosshair pin-mark").attr("x1", x(S.hour + 1)).attr("x2", x(S.hour + 1)).attr("y1", m.t).attr("y2", Hh - m.b);
  svg.append("text").attr("class", "axis-title").attr("x", x(S.hour + 1)).attr("y", m.t - 4).attr("text-anchor", S.hour > 20 ? "end" : S.hour < 3 ? "start" : "middle").text(heLabel(S.hour));
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", Hh - m.b).style("display", "none");
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", Hh - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const h = Math.max(0, Math.min(23, Math.round(x.invert(d3.pointer(ev)[0])) - 1));
      cross.style("display", null).attr("x1", x(h + 1)).attr("x2", x(h + 1));
      showTip(ev, `<h4>${heLabel(h)} · lambda ${ref ? fmtPrice(ref[h]) : "–"}</h4><table>` +
        [...shown].reverse().map((s) => `<tr><td><span class="sw" style="background:var(${s.color})"></span></td><td>${s.label}</td><td class="n">${fmtGW(s.vals[h])} GW</td></tr>`).join("") +
        shownBelow.map((s) => `<tr><td><span class="sw" style="background:var(${s.color})"></span></td><td>${s.label}</td><td class="n">${fmtGW(s.vals[h])} GW</td></tr>`).join("") +
        (tipRows ? tipRows(h, shown) : "") + `</table>`);
    }).on("pointerleave", () => { cross.style("display", "none"); hideTip(); })
    .on("click", (ev) => pickHour(Math.round(x.invert(d3.pointer(ev)[0])) - 1)).style("cursor", "pointer");
  el.replaceChildren(svg.node());
  const all = [...areas, ...below];
  setCSV(el, ["hour_ending", "lambda", ...all.map((s) => `${s.id}_mw`)], HRS.map((h) => [h + 1, ref ? ref[h] : null, ...all.map((s) => s.vals[h])]), csvName);
}
// what ran by hour, from ERCOT's data: the 60-day disclosure by group when it is in, else the
// 2-day summary's thermal, wind, solar and batteries
function actualSeries() {
  const L = lead(), a60 = S.a60, gh = genHourly();
  if (!L) return null;
  const areas = [], below = [];
  if (L === "60d") {
    GROUPS.filter((g) => a60.group[g]).forEach((g) => areas.push({ id: g, label: GROUP_SHORT[g] || g, color: GROUP_COLORS[g] || "--c-other", vals: a60.group[g] }));
    ["hydro", "other"].forEach((t) => { if (a60.tech[t]) areas.push({ id: t, label: t === "hydro" ? "Hydro" : "Other", color: "--c-other", vals: a60.tech[t] }); });
    [WIND, SOLAR].forEach((s) => { if (a60.tech[s.id]) areas.push({ ...s, vals: a60.tech[s.id] }); });
    if (a60.tech.storage) { areas.push({ ...STORAGE, id: "storage_dis", label: "Batteries discharging", vals: a60.dis }); below.push({ ...STORAGE, id: "storage_chg", label: "Batteries charging (load)", vals: a60.chg }); }
  } else {
    areas.push({ id: "thermal", label: "Thermal and other", color: "--g3", vals: gh.thermal });
    areas.push({ ...WIND, vals: gh.wind }); areas.push({ ...SOLAR, vals: gh.solar });
    if (gh.discharging.some((v) => v != null)) { areas.push({ ...STORAGE, id: "storage_dis", label: "Batteries discharging", vals: gh.discharging }); below.push({ ...STORAGE, id: "storage_chg", label: "Batteries charging (load)", vals: gh.charging }); }
  }
  return { areas, below, L };
}
function drawActual() {
  const panel = $("actual-panel"), el = $("actual-chart"), A = actualSeries();
  panel.hidden = !A;
  if (!A) return;
  areaChart({ el, legendEl: $("actual-legend"), areas: A.areas, below: A.below, prefix: "act", csvName: `What ran ${S.date}`,
    tipRows: (h, shown) => `<tr><td></td><td>Total supply</td><td class="n">${fmtGW(d3.sum(shown, (s) => s.vals[h] || 0))} GW</td></tr>` });
  $("actual-note").textContent = `${S.date} · GW · ${A.L === "60d" ? "60-day disclosure" : "2-day summary"}`;
  $("actual-sub").textContent = A.L === "60d"
    ? "Each unit's output from the 60-day disclosure, thermal units summed by how often they turn off on price. Batteries are drawn on top while discharging and below zero while charging. Shaded hours had system lambda at $10 or less."
    : `ERCOT's 2-day generation summary: thermal in total, wind, solar and batteries. Unit detail arrives with the 60-day disclosure, about ${dayLabel(addDays(S.date, LAG_60D))}. Shaded hours had system lambda at $10 or less.`;
}
// what ran over the day, as GWh bars: the bar is what ran, the full bar the units' largest hourly
// HSL over all 24 hours (wind and solar: their HSL hour by hour); rows without a maximum share
// `scale` (GWh) with the rest of their section
function actRow(name, note, color, act, tip, scale, seg) {
  // seg: wind and solar {ren, light: available from the weather}; thermal {light: online HSL,
  // max: online HSL + offline available, out: GWh on outage, nOut}; batteries and the 2-day view none
  const og = seg && seg.out >= 0.5 ? seg.out : 0, max = seg && !seg.ren ? seg.max : null;
  const capG = max ? max + og : scale || Math.max(act || 0, 1) * 1.1, w = (v) => Math.min(100, ((v || 0) / capG) * 100);
  const f1 = d3.format(",.1f"), f0 = d3.format(",.0f");
  return `<div class="lab"><span class="sw" style="background:var(${color})"></span><div>${esc(name)}<small>${esc(note)}</small></div></div>` +
    `<div class="bar" data-tip-html="${esc(`<h4>${esc(name)}</h4><p class="tip-body">${tip}</p>`)}">` +
    (seg && seg.light != null ? `<i style="left:0;width:${w(seg.light)}%;background:var(${color});opacity:.35"></i>` : "") +
    (act != null ? `<i style="left:0;width:${w(act)}%;background:var(${color})"></i>` : "") +
    (og ? `<i class="outage" style="left:${w(max)}%;width:${100 - w(max)}%;color:var(${color})"></i>` : "") + `</div>` +
    `<div class="val"><b>${act != null ? f1(act) + " GWh" : "–"}</b> ran` +
    (seg && seg.ren && seg.light != null ? `, ${f1(Math.max(0, seg.light - (act || 0)))} GWh curtailed<br>of ${f0(seg.light)} GWh available` : "") +
    (max ? `<br>of ${f0(max)} GWh max available` : "") +
    (og ? `<br>${fmtGWh(og)} GWh max on outage (${seg.nOut} unit${seg.nOut === 1 ? "" : "s"})` : "") + `</div>`;
}
// "x–y units online" over the day's hours, for a group's or technology's trains online
const onRange = (on, n) => { if (!on) return ""; const a = d3.min(on), b = d3.max(on); return `${a === b ? a : `${a}–${b}`}${n ? ` of ${n}` : ""} unit${(n || b) === 1 ? "" : "s"} online`; };
function drawActualBars() {
  const panel = $("actual-bars-panel"), el = $("actual-rows"), L = lead();
  panel.hidden = !L;
  if (!L) return;
  $("actual-bar-legend").innerHTML = `<span><span class="sw" style="background:var(--g3)"></span>What ran</span>` +
    (L === "60d" ? `<span><span class="sw" style="background:var(--g3);opacity:.35"></span>Thermal: online, not used (HSL each hour) · Wind and solar: curtailed</span><span><span class="sw" style="background:var(--track)"></span>Thermal: offline but available</span><span><span class="sw outage" style="color:var(--g3)"></span>Thermal: max on outage</span>` : "");
  $("actual-bars-sub").textContent = L === "60d" ? "ERCOT's reported energy for the day. The solid bar is what ran. For thermal, the light bar runs to the online units' maximum (HSL) each hour, summed over the day; the gray beyond it is units offline but available, at full output (their HSL when running, as the 60-day data gives no HSL while offline); together they are the max available. The hatched segment is the most outages took: each unit's hours reporting OUT, at full output. For wind and solar, the full bar is what the weather made available (their HSL each hour), and the light part of it was curtailed. Peakers are the units that run like peakers (online under 30% of available hours, at most 16 hours a day when on), shown on their own. Online minimum and maximum hour by hour are in the next panel." : "ERCOT's reported energy, from the 2-day summary. Thermal is reported in total until the 60-day disclosure.";
  const csv = [], gwhOf = (mw) => d3.sum(mw.filter((v) => v != null)) / 1000, sumOf = (a) => (a ? d3.sum(a) / 1000 : null);
  let html = "";
  const push = (sect, name, note, color, cap, act, lsl, hsl, scale, off) => {
    // wind and solar: the HSL each hour is what the weather made available, and what was available
    // but did not run was curtailed. Thermal: the most it could have made is the online units' HSL
    // each hour plus the offline-but-available units at full output; outages come on top
    const ren = sect === "wind" || sect === "solar", thermal = sect === "group" || sect === "tech";
    const avail = ren && hsl != null && act != null ? Math.max(hsl, act) : null;
    const onH = thermal && hsl != null ? Math.max(hsl, act || 0) : null, offA = off ? off.off : 0;
    const seg = ren ? { ren: true, light: avail } : thermal && onH != null ? { light: onH, max: onH + offA, out: off ? off.gwh : 0, nOut: off ? off.units.length : 0 } : null;
    const tip = `${act != null ? `${fmtGWh(act)} GWh ran (${fmtGW(act / 24 * 1000)} GW on average)` : "no data"}` +
      (avail != null ? `<br>${fmtGWh(avail)} GWh available from the weather (HSL each hour), ${fmtGWh(avail - act)} GWh curtailed` : "") +
      (seg && !ren ? `<br>${fmtGWh(seg.max)} GWh max available: ${fmtGWh(onH)} GWh online (the online units' HSL each hour)` +
        `, ${fmtGWh(offA)} GWh offline but available (${off ? off.nOff : 0} unit${off && off.nOff === 1 ? "" : "s"}, at full output: HSL when running)` : "") +
      (off && off.gwh >= 0.5 ? `<br>${fmtGWh(off.gwh)} GWh max on outage: ${off.units.length} unit${off.units.length === 1 ? "" : "s"} reporting OUT, at full output<br>` +
        off.units.slice(0, 5).map((u) => `${esc(u.name)}: ${u.h} h × ${d3.format(",.0f")(u.mw)} MW`).join("<br>") + (off.units.length > 5 ? `<br>and ${off.units.length - 5} more` : "") : "");
    html += actRow(name, note, color, act, tip, scale, seg);
    csv.push([sect, name, act, lsl, hsl, seg && !ren ? offA : null, seg && !ren ? seg.max : null, off ? off.gwh : null]);
  };
  const a60 = S.a60, gh = genHourly(), o60 = S.off60 || { group: {}, tech: {} };
  if (L === "60d") {
    html += `<div class="sect">Thermal · GWh · by how often it turns off on price (60-day disclosure)</div>`;
    GROUPS.forEach((g) => { if (a60.group[g]) push("group", GROUP_SHORT[g] || g, onRange(a60.onG[g], a60.nG[g]), GROUP_COLORS[g] || "--c-other", a60.capG[g], gwhOf(a60.group[g]), sumOf(a60.lslG[g]), sumOf(a60.hslG[g]), null, o60.group[g]); });
    html += `<div class="sect">Thermal · GWh · by technology</div>`;
    TECHS.forEach(([t, label, color]) => { if (a60.tech[t]) push("tech", label, onRange(a60.onT[t], a60.nT[t]), color, a60.capT[t], gwhOf(a60.tech[t]), sumOf(a60.lslT[t]), sumOf(a60.hslT[t]), null, o60.tech[t]); });
  } else {
    html += `<div class="sect">Thermal · GWh (2-day summary, reported in total)</div>`;
    const th = gwhOf(gh.thermal);
    push("thermal", "Thermal and other", "non-IRR plus remaining resources; by-group output arrives with the 60-day disclosure", "--g3", null, th, null, null, th * 1.1);
  }
  html += `<div class="sect">Wind and solar · GWh (${a60 ? "60-day disclosure" : "2-day summary"})</div>`;
  const ren = [WIND, SOLAR].map((s) => { const vals = a60 && a60.tech[s.id] ? a60.tech[s.id] : gh ? gh[s.id] : null; return [s, vals ? gwhOf(vals) : null]; });
  const renScale = (d3.max(ren, ([s, v]) => Math.max(v || 0, a60 && a60.hslT[s.id] ? d3.sum(a60.hslT[s.id]) / 1000 : 0)) || 1) * 1.1;
  ren.forEach(([s, v]) => push(s.id, s.label, "", s.color, a60 ? a60.capT[s.id] : null, v, null, a60 ? sumOf(a60.hslT[s.id]) : null, renScale));
  const dis = a60 && a60.tech.storage ? gwhOf(a60.dis) : gh && gh.discharging.some((v) => v != null) ? gwhOf(gh.discharging) : null;
  const chg = a60 && a60.tech.storage ? -gwhOf(a60.chg) : gh && gh.charging.some((v) => v != null) ? -gwhOf(gh.charging) : null;
  if (dis != null) {
    html += `<div class="sect">Batteries · GWh (${a60 ? "60-day disclosure" : "2-day summary"})</div>`;
    const batScale = Math.max(dis, chg || 0, 0.1) * 1.1;
    push("storage", "Discharged", "supply", STORAGE.color, null, dis, null, null, batScale);
    push("storage", "Charged", "load", STORAGE.color, null, chg, null, null, batScale);
  }
  el.innerHTML = html;
  $("actual-bars-note").textContent = `${S.date} · GWh · ${L === "60d" ? "60-day disclosure" : "2-day summary"}`;
  setCSV(el, ["section", "name", "actual_gwh", "online_lsl_gwh", "online_hsl_gwh", "offline_available_gwh", "max_available_gwh", "outage_gwh"], csv, `What ran ${S.date}`);
}
// online minimum and maximum by hour: one small chart per group or technology, with the online
// units' summed LSL as a solid bar, their summed HSL as a light bar above it, and what ran as a line
function limitSeries() {
  const a = S.a60;
  if (!a) return [];
  const renew = [WIND, SOLAR].filter((s) => a.tech[s.id]).map((s) => ({ id: s.id, label: s.label, color: s.color, out: a.tech[s.id], lsl: null, hsl: a.hslT[s.id], on: a.onT[s.id], n: a.nT[s.id] }));
  if (S.limBy === "tech") return [...TECHS.filter(([t]) => a.tech[t]).map(([t, label, color]) => ({ id: t, label, color, out: a.tech[t], lsl: a.lslT[t], hsl: a.hslT[t], on: a.onT[t], n: a.nT[t] })), ...renew];
  // by group (peakers on their own), then wind and solar
  return [...GROUPS.filter((g) => a.group[g] && a.hslG[g]).map((g) => ({ id: g, label: GROUP_SHORT[g] || g, color: GROUP_COLORS[g] || "--c-other", out: a.group[g], lsl: a.lslG[g], hsl: a.hslG[g], on: a.onG[g], n: a.nG[g] })), ...renew];
}
function limitChart(s, w0) {
  const zero = HRS.map(() => 0), lsl = s.lsl || zero, hsl = s.hsl || zero;
  const wrap = document.createElement("div"); wrap.className = "mult";
  const fmtMW = d3.format(",.0f"), rng = (a) => `${fmtMW(d3.min(a))}–${fmtMW(d3.max(a))} MW`;
  wrap.innerHTML = `<h3><span class="sw" style="background:var(${s.color})"></span>${esc(s.label)}</h3>` +
    `<p class="sub">${s.lsl ? `${onRange(s.on, s.n)} · LSL ${rng(lsl)}` : `${onRange(s.on, s.n).replace("online", "producing")} · ${fmtGWh(d3.sum(s.out) / 1000)} GWh ran · online HSL ${rng(hsl)}`}</p>`;
  const w = Math.max(240, w0 || 320), Hh = 170, m = { t: 8, r: 6, b: 24, l: 40 };
  const x = d3.scaleBand().domain(HRS).range([m.l, w - m.r]).paddingInner(0.12);
  const y = d3.scaleLinear().domain([0, d3.max([...hsl, ...s.out]) * 1.04 || 1]).nice().range([Hh - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${Hh}`).attr("role", "img").attr("aria-label", `${s.label}: online minimum, maximum and output by hour`);
  const { ref } = dayPrices();
  cheapRuns().forEach((r) => svg.append("rect").attr("class", "price-band").attr("x", x(r.from) - 1).attr("width", x(r.to) + x.bandwidth() - x(r.from) + 2).attr("y", m.t).attr("height", Hh - m.t - m.b));
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickFormat((v) => (v >= 1000 ? d3.format(",")(v / 1000) + "k" : v)).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${Hh - m.b})`).call(d3.axisBottom(x).tickValues([0, 5, 11, 17, 23]).tickFormat((h) => h + 1).tickSizeOuter(0));
  const col = css(s.color), bw = x.bandwidth();
  HRS.forEach((h) => {
    svg.append("rect").attr("x", x(h)).attr("width", bw).attr("y", y(hsl[h])).attr("height", y(0) - y(hsl[h])).attr("fill", col).attr("fill-opacity", 0.28).attr("stroke", col).attr("stroke-opacity", 0.7).attr("stroke-width", 0.75);
    if (s.lsl) {
      svg.append("rect").attr("x", x(h)).attr("width", bw).attr("y", y(lsl[h])).attr("height", y(0) - y(lsl[h])).attr("fill", col);
      if (lsl[h] > 0) svg.append("line").attr("x1", x(h)).attr("x2", x(h) + bw).attr("y1", y(lsl[h])).attr("y2", y(lsl[h])).attr("stroke", css("--ink")).attr("stroke-width", 1.25);
    }
  });
  svg.append("path").attr("fill", "none").attr("stroke", css("--ink")).attr("stroke-width", 2).attr("stroke-linejoin", "round")
    .attr("d", d3.line().x((h) => x(h) + bw / 2).y((h) => y(s.out[h] || 0))(HRS));
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", Hh - m.t - m.b).attr("fill", "transparent").style("cursor", "pointer")
    .on("pointermove", (ev) => {
      const h = Math.max(0, Math.min(23, Math.floor((d3.pointer(ev)[0] - m.l) / x.step())));
      const row = (l, v) => `<tr><td>${l}</td><td class="n">${v}</td></tr>`;
      showTip(ev, `<h4>${esc(s.label)} · ${heLabel(h)} · lambda ${ref ? fmtPrice(ref[h]) : "–"}</h4><table>` +
        (s.on ? row(s.lsl ? "Units online" : "Units producing", `${s.on[h] || 0}${s.n ? ` of ${s.n} (${d3.format(".0%")((s.on[h] || 0) / s.n)})` : ""}`) : "") +
        (s.lsl ? row("Online LSL", `${fmtMW(lsl[h])} MW`) : "") + row("Online HSL", `${fmtMW(hsl[h])} MW`) +
        row("What ran", `${fmtMW(s.out[h] || 0)} MW`) + (s.lsl ? row("Above LSL", `${fmtMW((s.out[h] || 0) - lsl[h])} MW`) : "") + `</table>`);
    }).on("pointerleave", hideTip)
    .on("click", (ev) => pickHour(Math.floor((d3.pointer(ev)[0] - m.l) / x.step())));
  wrap.append(svg.node());
  return wrap;
}
function drawLimits() {
  const panel = $("limits-panel"), el = $("limits-grid");
  panel.hidden = !S.a60;
  if (!S.a60) return;
  const series = limitSeries();
  // draw once to lay out the grid, then again at each cell's width
  el.replaceChildren(...series.map((s) => limitChart(s)));
  const cells = [...el.querySelectorAll(".mult")];
  el.replaceChildren(...series.map((s, i) => limitChart(s, cells[i].clientWidth)));
  $("limits-note").textContent = `${S.date} · MW · hour ending · 60-day disclosure`;
  const csv = [];
  series.forEach((s) => HRS.forEach((h) => csv.push([S.limBy, s.id, h + 1, s.on ? s.on[h] : null, s.lsl ? s.lsl[h] : null, s.hsl ? s.hsl[h] : null, s.out[h] || 0])));
  setCSV(el, ["by", "name", "hour_ending", "units_online", "online_lsl_mw", "online_hsl_mw", "output_mw"], csv, `Online minimum and maximum ${S.date}`);
}

// ---------------------------------------------------------------- drill-down: mix ---
function mixRows(h) {
  const a60 = S.a60, gh = genHourly();
  if (a60) {
    const rows = TECHS.filter(([t]) => a60.tech[t]).map(([t, label, color]) => ({ id: t, label, color, act: a60.tech[t][h] }));
    [WIND, SOLAR].forEach((s) => { if (a60.tech[s.id]) rows.push({ ...s, act: a60.tech[s.id][h] }); });
    if (a60.tech.storage) rows.push({ id: "storage", label: "Batteries, net", color: "--c7", act: a60.tech.storage[h] });
    ["hydro", "other"].forEach((t) => { if (a60.tech[t]) rows.push({ id: t, label: t === "hydro" ? "Hydro" : "Other", color: "--c-other", act: a60.tech[t][h] }); });
    return rows;
  }
  if (!gh) return null;
  const rows = [{ id: "thermal", label: "Thermal and other", color: "--g3", act: gh.thermal[h] }, { ...WIND, act: gh.wind[h] }, { ...SOLAR, act: gh.solar[h] }];
  if (gh.discharging[h] != null) rows.push({ id: "storage", label: "Batteries, net", color: "--c7", act: gh.discharging[h] + (gh.charging[h] || 0) });
  return rows;
}
function drawMix() {
  const el = $("mix-chart"), tel = $("mix-table"), h = S.hour;
  $("mix-title-note").textContent = S.date ? `${S.date} · ${heLabel(h)}` : "";
  let rows = mixRows(h);
  if (!rows) { tel.innerHTML = ""; return emptyMsg(el, "No generation data for this day yet."); }
  const total = d3.sum(rows, (r) => Math.max(0, r.act || 0));
  rows.forEach((r) => { r.share = r.act != null && total > 0 && r.act > 0 ? r.act / total : null; });
  rows = rows.sort((a, b) => (b.act ?? 0) - (a.act ?? 0));
  const w = size(el), narrow = w < 560, bh = 22, lab = narrow ? 18 : 0, gap = 8 + lab, m = { t: 8 + lab, r: narrow ? 90 : 130, b: 26, l: narrow ? 8 : 180 };
  const Hh = m.t + m.b + rows.length * (bh + gap) - gap;
  const x = d3.scaleLinear().domain([Math.min(0, d3.min(rows, (r) => r.act ?? 0)), Math.max(1, d3.max(rows, (r) => r.act ?? 0))]).nice().range([m.l, w - m.r]);
  const y = d3.scaleBand().domain(rows.map((r) => r.id)).range([m.t, Hh - m.b]).paddingInner(gap / (bh + gap));
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${Hh}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(0,${Hh - m.b})`).call(d3.axisBottom(x).ticks(narrow ? 3 : 6).tickSize(-(Hh - m.t - m.b)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${Hh - m.b})`).call(d3.axisBottom(x).ticks(narrow ? 3 : 6).tickFormat((v) => d3.format(",")(v / 1000) + " GW").tickSizeOuter(0));
  rows.forEach((r) => {
    const y0 = y(r.id), g = svg.append("g");
    if (r.act != null && Math.abs(x(r.act) - x(0)) > 0.5) g.append("rect").attr("x", Math.min(x(0), x(r.act))).attr("y", y0).attr("width", Math.abs(x(r.act) - x(0))).attr("height", bh).attr("fill", css(r.color)).attr("rx", 3);
    g.append("text").attr("class", "mix-label").attr("x", narrow ? m.l : m.l - 10).attr("y", narrow ? y0 - 5 : y0 + bh / 2).attr("dy", narrow ? 0 : "0.35em").attr("text-anchor", narrow ? "start" : "end").text(r.label);
    g.append("text").attr("class", "mix-value").attr("x", Math.max(x(0), x(r.act ?? 0)) + 6).attr("y", y0 + bh / 2).attr("dy", "0.35em")
      .text(r.act != null ? `${fmtMW(r.act)} MW` + (r.share != null ? ` · ${fmtPct(r.share)}` : "") : "no data");
  });
  if (x.domain()[0] < 0) svg.append("line").attr("class", "zero").attr("x1", x(0)).attr("x2", x(0)).attr("y1", m.t).attr("y2", Hh - m.b);
  el.replaceChildren(svg.node());
  el.insertAdjacentHTML("beforeend", `<p class="note">Generation ${fmtMW(total)} MW in the hour from the ${S.a60 ? "60-day disclosure (output averaged over the hour's SCED runs)" : "2-day summary (base points), with thermal in total"}.</p>`);
  tel.innerHTML = `<table class="data"><thead><tr><th class="t">Technology</th><th>Output (MW)</th><th>Share</th></tr></thead><tbody>` +
    rows.map((r) => `<tr><td class="t">${r.label}</td><td>${r.act != null ? fmtMW(r.act) : "–"}</td><td>${r.share != null ? d3.format(".1%")(r.share) : "–"}</td></tr>`).join("") +
    `<tr><td class="t"><b>Total</b></td><td><b>${fmtMW(total)}</b></td><td></td></tr></tbody></table>`;
  setCSV(el, ["technology", "output_mw", "share"], rows.map((r) => [r.label, r.act, r.share]), `Generation mix ${S.date} ${heLabel(h)}`);
}

// ---------------------------------------------------------------- drill-down: units ---
const UNIT_COLS = [
  ["unit", "Unit", "t"], ["tech", "Technology", "tech"], ["group", "Group", "group"], ["hsl", "HSL (MW)"], ["lsl", "LSL online (MW)"],
  ["online_h", "Hours online"], ["mwh", "Output (MWh)"], ["profit", "Profit ($)", "usd"],
];
const UNIT_TIPS = {
  group: "How often the unit has turned off on price over the 60-day data: always on when available, multi-day, or daily at three frequencies.",
  hsl: "The unit's largest hourly maximum output (HSL) over the day, configurations of a combined-cycle train summed.",
  lsl: "The unit's largest minimum output (LSL) in an hour it was online.",
  online_h: "Hours the unit was online in the 60-day disclosure (at least half of the hour's SCED runs).",
  mwh: "Energy produced over the day.",
  profit: "Energy revenue settled two-settlement (DAM award at its day-ahead price, the real-time deviation at the unit's real-time node price), plus ancillary services, less fuel at the EIA average heat rate and the unit's gas hub, variable O&M and, over the day, starts at its DAM hot start offer. The selected-hour view has no start costs. Same bases as the Unit page's revenue and cost panel; an estimate, not the unit's books.",
};
function unitRows() {
  const a60 = S.a60;
  if (!a60) return [];
  const h = S.hour, hourly = S.unitView === "hour";
  return Object.values(a60.units).map((u) => ({
    unit: u.unit, tech: u.tech, group: u.group, hsl: hourly ? u.hsl[h] : u.hslMax, lsl: hourly ? u.lsl[h] : u.lslMax,
    online_h: hourly ? u.on[h] : u.online_h, mwh: hourly ? u.out[h] : u.mwh,
    profit: !u.profit || u.noFuel ? null : hourly ? u.profit[h] : u.profitDay,
  }));
}
function drawUnits() {
  const el = $("units-table"), hourly = S.unitView === "hour", h = S.hour;
  if (!S.a60) {
    $("units-note").textContent = S.date;
    $("units-foot").textContent = "";
    return emptyMsg(el, `Each unit's hours for this day arrive with the 60-day disclosure, about ${esc(dayLabel(addDays(S.date, LAG_60D)))}. The latest day with unit detail is ${esc(dayLabel(last60()))}.`);
  }
  let rows = unitRows();
  if (S.unitTech !== "all") rows = rows.filter((r) => r.tech === S.unitTech);
  if (S.unitSearch) rows = rows.filter((r) => r.unit.toLowerCase().includes(S.unitSearch.toLowerCase()));
  if (!UNIT_COLS.some(([k]) => k === S.unitSort.key)) S.unitSort = { key: "hsl", dir: -1 };
  const { key, dir } = S.unitSort;
  rows.sort((a, b) => {
    const va = a[key], vb = b[key];
    if (va == null) return 1; if (vb == null) return -1;
    return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * dir;
  });
  const cols = UNIT_COLS.map(([k, l, kind]) => (hourly && k === "online_h" ? [k, `Online in ${heLabel(h)}`, "yn"] : hourly && k === "mwh" ? [k, `Output in ${heLabel(h)} (MW)`] : hourly && k === "profit" ? [k, `Profit in ${heLabel(h)} ($)`, kind] : [k, l, kind]));
  setCSV(el, cols.map(([k]) => k), rows.map((r) => cols.map(([k]) => r[k])), `Units ${S.date}${hourly ? " " + heLabel(h) : ""}`);
  const total = rows.length;
  if (!S.unitShowAll) rows = rows.slice(0, PAGE_ROWS);
  const fmt = (r, k, kind) => {
    const v = r[k];
    if (v == null) return "–";
    if (kind === "t") return k === "unit" ? `<a href="unit.html?unit=${encodeURIComponent(v)}">${esc(v)}</a>` : esc(v);
    if (kind === "tech") return TECH_LABEL[v] || esc(v);
    if (kind === "group") return GROUP_SHORT[v] || esc(v);
    if (kind === "yn") return v ? "yes" : "no";
    if (k === "online_h") return d3.format(",.0f")(v);
    if (kind === "usd") return `<span class="${v < 0 ? "neg" : ""}">${v < 0 ? "−" : ""}$${d3.format(",.0f")(Math.abs(v))}</span>`;
    return d3.format(",.0f")(v);
  };
  const tcls = (kind) => (["t", "tech", "group"].includes(kind) ? "t" : "");
  let html = `<div class="units-wrap"><table class="data"><thead><tr>${cols.map(([k, l, kind]) =>
    `<th class="sortable ${tcls(kind)}${UNIT_TIPS[k] ? " has-tip" : ""}" data-k="${k}"${UNIT_TIPS[k] ? ` data-tip-title="${esc(l)}" data-tip="${esc(UNIT_TIPS[k])}"` : ""} aria-sort="${k === key ? (dir > 0 ? "ascending" : "descending") : "none"}">${l}${k === key ? (dir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead><tbody>`;
  html += rows.map((r) => `<tr>${cols.map(([k, , kind]) => `<td class="${tcls(kind)}">${fmt(r, k, kind)}</td>`).join("")}</tr>`).join("");
  el.innerHTML = html + "</tbody></table></div>";
  $("units-foot").innerHTML = (total > rows.length ? `Showing ${rows.length} of ${total} units. <button type="button" id="units-all" class="linkish">Show all</button>` : `Units: ${total}.`) +
    ` Groups are from the full 60-day data. Which units turned off on the day, and at what loss, is on <a href="commitment.html#date=${S.date}">Commitment</a>.` +
    ` Profit is an estimate on generic costs (coal at $2/MMBtu, so lignite at its own mine reads low)${S.rtNodes ? "" : "; real-time node prices for this day are not in yet, so the real-time part settles at system lambda"}.`;
  $("units-note").textContent = `${S.date} · ${Object.keys(S.a60.units).length} thermal units`;
  const b = $("units-all");
  if (b) b.onclick = () => { S.unitShowAll = true; drawUnits(); };
}

// ---------------------------------------------------------------- the step down to the bids ---
// the day's hour in the offers: the 2-day curves run two days behind, so the link opens the
// Offers page on the newest day with curves, on or before this one
function offersHref(he) {
  const ds = (S.index && S.index.days["2d"]) || [], d = [...ds].reverse().find((x) => x <= S.date) || ds.at(-1);
  return d ? { href: `beyond.html#date=${d}&he=${he}`, d } : null;
}
function drawOffersLinks() {
  const b = offersHref(S.hour + 1);
  $("offers-hour").innerHTML = b ? `<a href="${b.href}">What was bid in HE ${S.hour + 1}: the offers on ${esc(b.d)} →</a>` : "";
}
function drawSource() {
  const d = S.date;
  $("source-note").textContent = has("60d") ? "60-day disclosure: each unit's hours" : has("2dgen") ? `2-day summary; unit detail about ${dayLabel(addDays(d, LAG_60D))}` : "Prices only so far";
}

// ---------------------------------------------------------------- profit ---
// a gas price for the day: the latest trading day on or before it in {dates, value}
function priceOn(src, d) {
  if (!src || !src.dates) return null;
  let v = null;
  for (let i = 0; i < src.dates.length && src.dates[i] <= d; i++) if (src.value[i] != null) v = src.value[i];
  return v;
}
// each thermal train's profit by hour and over the day ($), settled two-settlement as on the Unit
// page: the DAM award at its day-ahead price plus the real-time deviation (output less award) at
// the unit's real-time node price (system lambda where the node has no price), plus ancillary
// service awards at their clearing prices, less fuel (EIA heat rate x the unit's gas hub, as the
// pipeline prices it in fuel_cost_60d, the hub prices themselves being licensed; EIA heat rate x
// Henry Hub without one) and variable O&M on the output; the day also less its starts (the DAM hot
// start offer, else the generic one). Hourly profit has no start costs.
function unitProfit() {
  const f = S.units60, a = S.a60;
  if (!f || !a) return;
  const ci = Object.fromEntries(f.columns.map((c, i) => [c, i + 2]));
  const dam = (S.dam && S.dam.units) || {}, mcpc = (S.dam && S.dam.mcpc) || {};
  const rt = S.rtNodes && S.rtNodes.points, lam = dayPrices().rt;
  const hh = priceOn(S.gasHH, S.date), fc = S.fuelCost || {}, fi = (fc.dates || []).indexOf(S.date);
  const ownFuel = (name) => (fi >= 0 && fc.units && fc.units[name] ? fc.units[name][fi] : null);     // $/MWh
  const out = {};     // configuration -> [24] MW
  f.rows.forEach((r) => { const h = r[1] - 1; if (h >= 0 && h < 24) (out[r[0]] = out[r[0]] || HRS.map(() => 0))[h] += r[ci.output] || 0; });
  Object.values(a.units).forEach((u) => { u.profit = HRS.map(() => 0); u.startCost = 0; u.rtShare = 0; u.hot = null; u.noFuel = false; });
  const seen = {};
  f.units.forEach(([name, , t], i) => {
    const e = ECON[t], u = a.units[trainOf(name, t)];
    if (!e || !u) return;
    const du = dam[name] || {}, o = out[i] || HRS.map(() => 0), node = rt && du.sp ? rt[du.sp] : null;
    const own = e.fuel != null ? null : ownFuel(name);
    const fuelMWh = e.fuel != null ? e.fuel * e.hr : own != null ? own : hh != null ? hh * e.hr : null;
    if (fuelMWh == null) u.noFuel = true;
    if (du.start && du.start[0] != null) u.hot = Math.max(u.hot || 0, du.start[0]);
    HRS.forEach((h) => {
      const p = node && node[h] != null ? node[h] : lam ? lam[h] : null;
      if (p == null) return;
      if (node && node[h] != null && o[h]) seen[u.unit] = (seen[u.unit] || 0) + 1;
      const aw = du.award && du.award[h] != null ? du.award[h] : 0, spp = du.spp ? du.spp[h] : null;
      let v = aw && spp != null ? aw * spp + (o[h] - aw) * p : o[h] * p;
      Object.entries(du.as || {}).forEach(([k, q]) => { if (q && q[h] && mcpc[k] && mcpc[k][h] != null) v += q[h] * mcpc[k][h]; });
      v -= Math.max(0, o[h]) * ((fuelMWh || 0) + e.vom);
      u.profit[h] += v;
    });
  });
  Object.values(a.units).forEach((u) => {
    const e = ECON[u.tech] || {}, n = HRS.filter((h) => h > 0 && u.on[h] && !u.on[h - 1]).length;
    u.starts = n; u.startCost = n * (u.hot != null ? u.hot : e.start || 0);
    u.profitDay = d3.sum(u.profit) - u.startCost;
    u.rtShare = u.online_h ? (seen[u.unit] || 0) / u.online_h : 0;
  });
}

// ---------------------------------------------------------------- render ---
function render() {
  const days = S.days, di = days.indexOf(S.date);
  $("date-prev").disabled = di <= 0;
  $("date-next").disabled = di < 0 || di >= days.length - 1;
  $("hour-out").textContent = `${heLabel(S.hour)} · ${String(S.hour).padStart(2, "0")}:00–${String(S.hour + 1).padStart(2, "0")}:00`;
  drawSource(); drawHeadline(); drawSpark(); drawActual(); drawActualBars(); drawLimits(); drawMix(); drawUnits(); drawOffersLinks();
  saveView();
}
// a click on an hourly chart picks the hour for the generation mix and the units table
function pickHour(h) {
  S.hour = Math.max(0, Math.min(23, h)); $("hour").value = S.hour; renderHour();
}
function renderHour() {
  $("hour-out").textContent = `${heLabel(S.hour)} · ${String(S.hour).padStart(2, "0")}:00–${String(S.hour + 1).padStart(2, "0")}:00`;
  drawSpark(); drawActual(); drawMix(); drawOffersLinks(); if (S.unitView === "hour") drawUnits();
  saveView();
}
async function loadDay() {
  const d = S.date;
  const [gen, units60, prices, dam, rtNodes] = await Promise.all([
    has("2dgen") ? tryJSON(`data/2dgen/${d}.json.gz`) : null,
    has("60d") ? tryJSON(`data/60d-units/${d}.json.gz`) : null,
    has("prices") ? tryJSON(`data/prices/${d}.json.gz`) : null,
    has("60d") && has("dam") ? tryJSON(`data/dam/${d}.json.gz`) : null,
    has("60d") ? tryJSON(`data/rt-nodes/${d}.json.gz`) : null,
  ]);
  if (d !== S.date) return;    // a newer pick took over
  S.gen = gen; S.units60 = units60; S.prices = prices; S.dam = dam; S.rtNodes = rtNodes;
  S.a60 = actual60(); S.off60 = S.a60 ? offline60() : null;
  unitProfit();
  S.unitShowAll = false;
}
async function changeDay() { await loadDay(); render(); }
function saveView() { window.CX.writeHash({ date: S.date, he: S.hour + 1, lb: S.limBy, uv: S.unitView }); }
function loadView() {
  const v = window.CX.readHash();
  if (v.date) S.date = v.date;
  if (v.he && +v.he >= 1 && +v.he <= 24) S.hour = +v.he - 1;
  if (["group", "tech"].includes(v.lb)) S.limBy = v.lb;
  if (["day", "hour"].includes(v.uv)) S.unitView = v.uv;
}

async function boot() {
  [S.index, S.dalam, S.groups, S.fuelCost, S.gasHH, S.unitHours] = await Promise.all([tryJSON("data/index.json"), tryJSON("data/dam_lambda.json.gz"), tryJSON("data/groups_60d.json.gz"),
    tryJSON("data/fuel_cost_60d.json.gz"), tryJSON("data/gas.json.gz"), tryJSON("data/unit_hours_60d.json.gz")]);
  S.index = S.index || { days: {} };
  // every day with ERCOT data for it: prices, the 2-day summary or the 60-day disclosure
  const days = [...new Set(["prices", "2dgen", "60d"].flatMap((k) => S.index.days[k] || []))].sort();
  S.days = days;
  if (!days.length) { $("status").textContent = "No data yet. It is built by the data update workflow."; return; }
  loadView();
  // the page opens on the latest day with each unit's hours
  if (!days.includes(S.date)) S.date = last60() || days.at(-1);
  $("date").innerHTML = [...days].reverse().map((d) => `<option value="${d}">${dayLabel(d)}${has("60d", d) ? " · unit detail" : has("2dgen", d) ? " · 2-day" : ""}</option>`).join("");
  $("date").value = S.date;
  $("status").textContent = `${days.length} days, ${days[0]} to ${days.at(-1)} · unit detail through ${last60()} · updated ${(S.index.updated || "").replace("T", " ").replace("Z", " UTC")}`;
  $("unit-tech").innerHTML = `<option value="all">All</option>` + TECHS.map(([id, l]) => `<option value="${id}">${l}</option>`).join("");
  $("unit-tech").value = S.unitTech;
  $("hour").value = S.hour;
  setSeg("lim-by", S.limBy); setSeg("unit-view", S.unitView);
  bindSeg("lim-by", "limBy", drawLimits);
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
    S.unitSort = { key: k, dir: S.unitSort.key === k ? -S.unitSort.dir : (["unit", "tech", "group"].includes(k) ? 1 : -1) };
    drawUnits();
  });
  $("actual-legend").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-id]");
    if (!b) return;
    S.hidden.has(b.dataset.id) ? S.hidden.delete(b.dataset.id) : S.hidden.add(b.dataset.id);
    drawActual();
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

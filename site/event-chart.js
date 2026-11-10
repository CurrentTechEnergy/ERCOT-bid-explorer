/* One change from data/events.json.gz (pipeline/events.py), as a link and a chart.
   window.EVC.href(e) is the Unit page opened on the event: its day and the panel that shows that
   kind of change. window.EVC.toggle(tr, e, cols) opens or closes a row under a table row with a
   chart of what happened, in the layout of the Outpost Solar storm chart (it came from the graph
   builder): available (HSL) vs dispatched MW on top, the unit's offer price, the real-time price at
   its node, the real-time price at its zone's hub and the day-ahead price at its node below, on a
   compressed price axis. Day-dated changes are drawn hourly over a few days around the event;
   month-level changes (bidding, timescale group, turn-off point) as daily means over 30 days each
   side. Reads data/series/ (pipeline/series.py, from Nov 30, 2025), data/summary_prices.json.gz
   and data/dam_hubs.json.gz, only when a chart is first opened. */
(() => {
"use strict";

const { tryJSON, showTip, hideTip, css, esc } = window.CX;
const DAY = 864e5;
const parseDay = (s) => new Date(s + "T00:00:00Z");
const isoDay = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => isoDay(new Date(parseDay(s).getTime() + n * DAY));
const fmtDay = d3.utcFormat("%a %b %-d, %Y");
const fmtShort = d3.utcFormat("%b %-d");
const trainOf = (u) => { const m = /^(.*_CC\d+)_/.exec(u); return m ? m[1] : u; };
const MONTHLY = new Set(["bidding", "group", "turnoff"]);
const DAY_PANEL = new Set(["nuclear", "coal", "combined_cycle", "gas_steam", "combustion_turbine", "wind", "solar"]);   // unit.js drawDay
const HUB = { SOUTH: "HB_SOUTH", NORTH: "HB_NORTH", WEST: "HB_WEST", HOUSTON: "HB_HOUSTON", PAN: "HB_PAN" };
const FONT = "IBM Plex Sans, Helvetica, Arial, sans-serif", MONO = "IBM Plex Mono, Menlo, monospace";

// ------------------------------------------------------------------ links ---
// the Unit page panel that shows each kind of change
function panelOf(e) {
  const k = e.kind;
  if (e.tech === "storage") return "batt-day-panel";
  if (k.startsWith("dam_")) return "dam-panel";
  if (k === "renew_episode" || k.startsWith("renew_floor")) return "day-panel";   // the day it happened
  if (k.startsWith("renew_")) return "renew-panel";
  if (k === "bidding") return "bid-panel";
  if (k === "turnoff") return "dec-panel";
  if (k === "group") return "hours-panel";
  if (k.startsWith("shutdown") || k.startsWith("outage") || k === "rt_price") return DAY_PANEL.has(e.tech) ? "day-panel" : null;
  return null;
}
function href(e) {
  const unit = trainOf((e.units && e.units[0]) || e.unit);
  const q = new URLSearchParams();
  if (!MONTHLY.has(e.kind)) q.set(e.tech === "storage" ? "bday" : "day", e.date);
  const p = panelOf(e);
  if (p) q.set("p", p);
  return `unit.html?unit=${encodeURIComponent(unit)}${q.toString() ? "#" + q : ""}`;
}

// ------------------------------------------------------------------- data ---
const D = { ready: null, idx: null, prices: null, dam: null, ui: null, files: new Map() };
function load() {
  if (!D.ready) D.ready = Promise.all([tryJSON("data/series/index.json.gz"), tryJSON("data/summary_prices.json.gz"),
    tryJSON("data/dam_hubs.json.gz"), window.CX.unitIndex()]).then(([idx, prices, dam, ui]) => {
    Object.assign(D, { idx, prices, dam, ui: new Map((ui || []).map((u) => [u.unit, u])) });
  });
  return D.ready;
}
function monthFile(month, tech) {
  const k = `${month}/${tech}`;
  if (!D.files.has(k)) D.files.set(k, tryJSON(`data/series/${k}.json.gz`));
  return D.files.get(k);
}
// the series units behind an event: its units, or a train's configurations
function unitsOf(e) {
  const want = e.units && e.units.length ? e.units : [e.unit];
  const names = new Set();
  want.forEach((w) => {
    if (D.idx.units[w]) names.add(w);
    else Object.keys(D.idx.units).forEach((n) => { if (trainOf(n) === w || n.startsWith(w + "_")) names.add(n); });
  });
  return [...names];
}
const canChart = (e) => e.kind !== "fuel";

// the window drawn around an event
function windowOf(e) {
  const v = +e.value || 0;
  if (MONTHLY.has(e.kind)) return { from: addDays(e.date, -30), to: addDays(e.date, 30), daily: true };
  if (e.kind === "renew_episode") return { from: addDays(e.date, -2), to: addDays(e.date, Math.min(v, 14) + 1) };
  if (e.kind === "outage_start") return { from: addDays(e.date, -3), to: addDays(e.date, Math.min(v, 5) + 1) };
  if (e.kind === "outage_end") return { from: addDays(e.date, -Math.min(v, 5) - 1), to: addDays(e.date, 3) };
  return { from: addDays(e.date, -3), to: addDays(e.date, 3) };
}
// event span marked on the chart
// the kind and the title without saying either twice: a title with its own label keeps it
function subTitle(e, kind) {
  const t = e.title || "";
  if (t.includes(":")) return t;
  return kind.toLowerCase().includes(t.toLowerCase()) ? kind : `${kind}: ${t}`;
}

function markOf(e) {
  const v = +e.value || 0;
  if (e.kind === "renew_episode") return [e.date, addDays(e.date, v)];
  if (e.kind === "outage_end") return [addDays(e.date, -v), e.date];
  if (e.kind === "outage_start") return [e.date, addDays(e.date, v)];
  return [e.date, addDays(e.date, 1)];
}

const take = (a, i) => (a ? a.slice(i * 24, i * 24 + 24) : Array(24).fill(null));
const blank = () => Array(24).fill(null);
function hubRT(d, pt) { const p = D.prices && D.prices[d]; return ((p && (p.spp || {})[pt]) || []).concat(blank()).slice(0, 24); }

// hourly rows for the units over the dates: [{d, h, v: {hsl, bp, out, off, rt, hub, da}}]
async function hourly(names, dates, hub) {
  const techs = [...new Set(names.map((n) => D.idx.units[n][0]))];
  const months = [...new Set(dates.map((d) => d.slice(0, 7)))].filter((m) => D.idx.months.includes(m));
  const files = (await Promise.all(techs.flatMap((t) => months.map((m) => monthFile(m, t))))).filter(Boolean);
  const at = new Map();
  files.forEach((f) => f.dates.forEach((d, i) => { if (!at.has(d)) at.set(d, []); at.get(d).push([f, i]); }));
  const rows = [];
  dates.forEach((d) => {
    const per = names.map((n) => { const x = (at.get(d) || []).find(([f]) => f.units[n]); return x ? [n, x[0], x[1]] : null; }).filter(Boolean);
    const hb = hubRT(d, hub), da0 = blank(), rt0 = blank();
    for (let h = 0; h < 24; h++) {
      let hsl = null, bp = null, out = null, aw = null, sw = 0, sv = 0, k = 0, plain = 0, rt = null, da = null;
      per.forEach(([n, f, i]) => {
        const u = f.units[n], H = take(u.hsl, i)[h], B = take(u.bp, i)[h], O = take(u.out, i)[h], F = take(u.off_first, i)[h];
        if (H != null) hsl = (hsl || 0) + H;
        if (B != null) bp = (bp || 0) + B;
        if (O != null) out = (out || 0) + O;
        const A = take(u.award, i)[h];
        if (A != null) aw = (aw || 0) + A;
        if (F != null) { sw += H || 0; sv += (H || 0) * F; k++; plain += F; }
        const sp = D.idx.units[n][1];
        if (rt == null && sp && f.rt && f.rt[sp]) rt = take(f.rt[sp], i)[h];
        if (da == null && u.da) da = take(u.da, i)[h];
      });
      rows.push({ d, h, t: new Date(parseDay(d).getTime() + h * 36e5), v: { hsl, bp, out, award: aw, off: k ? (sw > 0 ? sv / sw : plain / k) : null, rt: rt ?? rt0[h], hub: hb[h], da: da ?? da0[h] } });
    }
  });
  return rows;
}
function daily(rows) {
  return d3.groups(rows, (r) => r.d).map(([d, rs]) => {
    const v = {};
    ["hsl", "bp", "out", "award", "off", "rt", "hub", "da"].forEach((k) => { const xs = rs.map((r) => r.v[k]).filter((x) => x != null); v[k] = xs.length ? d3.mean(xs) : null; });
    return { d, h: null, t: new Date(parseDay(d).getTime() + 12 * 36e5), v };
  });
}

// ------------------------------------------------------------------ chart ---
function draw(el, rows, spec) {
  // as wide as the table's scroll box (on a phone the table scrolls sideways; the chart stays put)
  const box = el.closest(".units-wrap") || el.parentElement;
  const W = Math.max(320, Math.min(1200, Math.round((box && box.clientWidth) || el.clientWidth || 900) - 4));
  el.style.width = `${W}px`;
  const narrow = W < 640;
  const PADX = 8, PL = narrow ? 52 : 64, PR = W - 12, CH = 190;
  const ink = css("--ink"), ink2 = css("--ink-2"), muted = css("--muted"), grid = css("--grid"), axisC = css("--axis"), surface = css("--surface");
  const svg = d3.create("svg").attr("viewBox", `0 0 ${W} 10`).attr("width", "100%").attr("data-nopin", "");
  const g = svg.append("g");
  const text = (x, y, s, size, color, weight = 400, family = FONT) => g.append("text").attr("x", x).attr("y", y).text(s)
    .attr("style", `font-family:${family};font-size:${size}px;fill:${color};font-weight:${weight}`);
  const dates = spec.dates;
  const x = d3.scaleUtc().domain([parseDay(dates[0]), new Date(parseDay(dates[dates.length - 1]).getTime() + DAY)]).range([PL, PR]);
  const tx = (r) => (spec.daily ? x(r.t) : x(new Date(r.t.getTime() + 18e5)));
  const span = dates.length;
  const ticks = span <= 10 ? d3.utcDay.every(narrow && span > 5 ? 2 : 1) : narrow ? d3.utcMonday.every(2) : d3.utcMonday.every(1);
  const tfmt = span <= 10 && !narrow ? d3.utcFormat("%a %b %-d") : d3.utcFormat("%b %-d");
  let y = 22;
  wrap(spec.title, W - 2 * PADX, 16).forEach((l, i) => { if (i) y += 20; text(PADX, y, l, 16, ink, 600); }); y += 20;
  wrap(spec.sub, W - 2 * PADX, 13).forEach((l, i) => { if (i) y += 17; text(PADX, y, l, 13, ink2); }); y += 12;
  const panels = [];
  spec.panels.forEach((p) => {
    y += 26;
    text(PADX, y, p.title, 13, ink, 600); y += 18;
    let lx = PADX;
    p.series.forEach((s) => {
      const w = 26 + s.l.length * 6.4;
      if (lx + w > W - PADX) { lx = PADX; y += 18; }
      if (s.t === "area") g.append("rect").attr("x", lx).attr("y", y - 10).attr("width", 14).attr("height", 10).attr("rx", 2).attr("style", `fill:${css(s.c)};fill-opacity:0.35`);
      else g.append("line").attr("x1", lx).attr("x2", lx + 16).attr("y1", y - 5).attr("y2", y - 5).attr("style", `stroke:${css(s.c)};stroke-width:2.5;${s.t === "dash" ? "stroke-dasharray:5 3;" : ""}`);
      text(lx + 22, y, s.l, 12, ink2);
      lx += w + 14;
    });
    y += 12;
    const top = y, bottom = y + CH;
    const vals = rows.flatMap((r) => p.series.map((s) => r.v[s.k])).filter((v) => v != null);
    let lo = vals.length ? d3.min(vals) : 0, hi = vals.length ? d3.max(vals) : 1;
    let ys, yt;
    if (p.u === "MW") {
      lo = Math.min(0, lo);
      ys = d3.scaleLinear().domain([lo, hi > lo ? hi : lo + 1]).nice().range([bottom, top]);
      yt = ys.ticks(4);
    } else {
      // the axis runs from the tick at or below the lowest value to the tick at or above the highest
      const T = [-5000, -1000, -500, -250, -100, -50, -20, 0, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
      lo = T.filter((t) => t <= Math.min(0, lo)).pop() ?? lo;
      hi = T.find((t) => t >= Math.max(20, hi)) ?? hi;
      ys = d3.scaleSymlog().constant(10).domain([lo, hi]).range([bottom, top]);
      yt = T.filter((t) => t >= lo && t <= hi);
    }
    const yf = window.CX.tickFormat(yt, p.u === "MW" ? undefined : "$");
    // the event's span, shaded
    const [m0, m1] = spec.mark;
    const a = Math.max(PL, x(parseDay(m0))), b = Math.min(PR, x(parseDay(m1)));
    if (b > a) g.append("rect").attr("x", a).attr("y", top).attr("width", b - a).attr("height", CH).attr("style", `fill:${css("--accent-soft") || grid};opacity:0.9`);
    yt.forEach((t) => {
      g.append("line").attr("x1", PL).attr("x2", PR).attr("y1", ys(t)).attr("y2", ys(t)).attr("style", `stroke:${t === 0 ? axisC : grid};stroke-width:1`);
      text(PL - 6, ys(t) + 4, t < 0 ? "−" + yf(-t) : yf(t), 11, muted, 400, MONO).attr("text-anchor", "end");
    });
    x.ticks(ticks).filter((t) => x(t) < PR - 50).forEach((t) => {
      g.append("line").attr("x1", x(t)).attr("x2", x(t)).attr("y1", bottom).attr("y2", bottom + 4).attr("style", `stroke:${axisC}`);
      text(x(t) + 3, bottom + 17, tfmt(t), 11, ink2);
    });
    g.append("line").attr("x1", PL).attr("x2", PR).attr("y1", bottom).attr("y2", bottom).attr("style", `stroke:${axisC}`);
    const clip = `evc-${Math.random().toString(36).slice(2)}`;
    svg.append("defs").append("clipPath").attr("id", clip).append("rect").attr("x", PL).attr("y", top - 2).attr("width", PR - PL).attr("height", CH + 4);
    const marks = g.append("g").attr("clip-path", `url(#${clip})`);
    [...p.series].sort((s1, s2) => (s1.t === "area" ? 0 : 1) - (s2.t === "area" ? 0 : 1)).forEach((s) => {
      const def = (r) => r.v[s.k] != null;
      if (s.t === "area") marks.append("path").attr("d", d3.area().defined(def).x(tx).y0(ys(0)).y1((r) => ys(r.v[s.k]))(rows)).attr("style", `fill:${css(s.c)};fill-opacity:0.35;stroke:none`);
      else marks.append("path").attr("d", d3.line().defined(def).x(tx).y((r) => ys(r.v[s.k]))(rows))
        .attr("style", `fill:none;stroke:${css(s.c)};stroke-width:${s.w || 1.8};stroke-linejoin:round;${s.t === "dash" ? "stroke-dasharray:6 4;" : ""}`);
    });
    panels.push({ top, bottom });
    y = bottom + 24;
  });
  y += 12;
  spec.notes.forEach((n) => wrap(n, W - 2 * PADX, 11.5).forEach((l) => { text(PADX, y, l, 11.5, muted); y += 15; }));
  y += 6;
  svg.attr("viewBox", `0 0 ${W} ${y}`);
  svg.insert("rect", ":first-child").attr("width", W).attr("height", y).attr("style", `fill:${surface}`);
  // hover
  const all = spec.panels.flatMap((p) => p.series);
  const fmtV = (s, v) => (v == null ? "–" : s.u === "MW" ? `${d3.format(",.0f")(v)} MW` : (v < 0 ? "−$" : "$") + d3.format(",.2f")(Math.abs(v)));
  const hover = svg.append("g");
  const cross = panels.map((p) => hover.append("line").attr("y1", p.top).attr("y2", p.bottom).attr("style", `stroke:${muted};stroke-dasharray:3 3;display:none`));
  hover.append("rect").attr("x", PL).attr("y", panels[0].top).attr("width", PR - PL).attr("height", panels[panels.length - 1].bottom - panels[0].top).attr("style", "fill:transparent")
    .on("mousemove", (ev) => {
      const [mx] = d3.pointer(ev);
      const t = x.invert(mx);
      const j = Math.max(0, Math.min(rows.length - 1, d3.bisector((r) => r.t).center(rows, spec.daily ? t : new Date(t.getTime() - 18e5))));
      const r = rows[j];
      cross.forEach((c) => c.attr("x1", tx(r)).attr("x2", tx(r)).style("display", null));
      const head = spec.daily ? `${fmtDay(parseDay(r.d))}, daily mean` : `${fmtDay(parseDay(r.d))}, HE ${r.h + 1}`;
      showTip(ev, `<h4>${head}</h4><table>${all.map((s) => `<tr><td><span class="sw" style="background:${css(s.c)};width:9px;height:9px"></span> ${esc(s.l)}</td><td class="n">${fmtV(s, r.v[s.k])}</td></tr>`).join("")}</table>`);
    })
    .on("mouseleave", () => { cross.forEach((c) => c.style("display", "none")); hideTip(); });
  el.innerHTML = "";
  el.appendChild(svg.node());
}
function wrap(s, width, size) {
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.font = `${size}px ${FONT}`;
  const lines = []; let line = "";
  String(s || "").split(/\s+/).filter(Boolean).forEach((w) => {
    const next = line ? `${line} ${w}` : w;
    if (line && ctx.measureText(next).width > width) { lines.push(line); line = w; } else line = next;
  });
  if (line) lines.push(line);
  return lines;
}

async function render(el, e, kinds) {
  el.innerHTML = `<p class="empty">Loading…</p>`;
  await load();
  if (!D.idx) { el.innerHTML = `<p class="empty">The hourly unit series aren't built yet.</p>`; return; }
  const first = D.idx.dates[0], last = D.idx.dates[D.idx.dates.length - 1];
  const win = windowOf(e);
  const from = win.from < first ? first : win.from, to = win.to > last ? last : win.to;
  const names = unitsOf(e);
  if (!names.length || from > to || e.date < addDays(first, -3) || e.date > addDays(last, 3)) {
    el.innerHTML = `<p class="empty">No hourly data around ${esc(e.date)}: the unit series run from ${esc(first)} to ${esc(last)}.</p>`;
    return;
  }
  const dates = []; for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
  const u0 = D.ui.get(names[0]) || D.ui.get(trainOf(names[0])) || {};
  const hub = HUB[u0.zone] || "HB_BUSAVG";
  let rows = await hourly(names, dates, hub);
  if (win.daily) rows = daily(rows);
  const storage = e.tech === "storage";
  const mw = d3.sum(names, (n) => D.idx.units[n][2] || 0);
  const title = (w) => String(w || "").toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  const place = `${d3.format(",.0f")(mw)} MW` + (u0.county ? `, ${title(u0.county)} County` : "");
  // the CDR plant name without its unit suffix ("OUTPOST SOLAR U1" -> Outpost Solar), else the resource name
  const plant = u0.plant ? title(u0.plant.replace(/\s+(U|UNIT|CTG|STG|GT|ST|CT)\s*\d+[A-Z]?$/i, "")) : "";
  const name = plant ? `${plant} (${e.unit}, ${place})` : `${e.unit} (${place})`;
  const res = win.daily ? "daily means" : "hourly";
  const spec = {
    dates, daily: !!win.daily, mark: markOf(e),
    title: name,
    sub: `${subTitle(e, (kinds && kinds[e.kind]) || e.kind)} · ${fmtShort(parseDay(from))}–${d3.utcFormat("%b %-d, %Y")(parseDay(to))}, ${res}`,
    panels: [
      { u: "MW", title: storage ? "Output (MW, charging below zero)" : "Available and dispatched output (MW)", series: storage
        ? [{ k: "out", t: "line", c: "--c1", l: "Output", u: "MW" }]
        : [{ k: "hsl", t: "area", c: "--c1", l: "Available (HSL)", u: "MW" }, { k: "bp", t: "line", c: "--c1", l: "Dispatched (base point)", u: "MW", w: 2.2 }]
          .concat(e.kind.startsWith("dam_") ? [{ k: "award", t: "dash", c: "--award", l: "Day-ahead award", u: "MW" }] : []) },
      { u: "$", title: "Prices ($/MWh)", series: [
        { k: "off", t: "line", c: "--c2", l: "Offer price", u: "$", w: 2.4 },
        { k: "rt", t: "line", c: "--c3", l: "Real-time price at its node", u: "$" },
        { k: "hub", t: "dash", c: "--c7", l: `Real-time price at ${hub === "HB_BUSAVG" ? "the hub average" : "the " + hub.slice(3)[0] + hub.slice(4).toLowerCase() + " hub"}`, u: "$" },
        { k: "da", t: "line", c: "--c4", l: "Day-ahead price at its node", u: "$" }] },
    ],
    notes: [
      "The days around the change in the unit's own numbers. Top: how much it could have run (HSL) against what SCED dispatched (base point); a gap between them is curtailment or a unit held back. Bottom: the unit's offer price against the real-time price at its node and hub and the day-ahead price at its node; an offer above the node price is a unit pricing itself out.",
      `Shaded: the ${e.kind === "renew_episode" || e.kind.startsWith("outage") ? "event's days" : MONTHLY.has(e.kind) ? "first of the month the change is dated to, though the change covers the whole month" : "event's day"}. Offer price is the lowest price on the unit's submitted real-time (SCED) curve, the price at which it first offers output` +
        (names.length > 1 ? `, weighted by HSL across ${names.length} units` : "") + "; prices are hourly means of ERCOT's 15-minute settlement point prices.",
      "Source: ERCOT 60-Day SCED Disclosure (NP3-965-ER), 60-Day DAM Disclosure (NP3-966-ER), Settlement Point Prices (NP6-905-CD).",
    ],
  };
  draw(el, rows, spec);
}

// open or close the chart row under tr; cols is the table's column count
function toggle(tr, e, cols, kinds) {
  const next = tr.nextElementSibling;
  const btn = tr.querySelector(".evc-btn");
  if (next && next.classList.contains("evc-row")) {
    next.remove(); if (btn) { btn.setAttribute("aria-expanded", "false"); btn.textContent = "Chart"; }
    return;
  }
  const row = document.createElement("tr");
  row.className = "evc-row";
  row.innerHTML = `<td colspan="${cols}"><div class="evc"></div></td>`;
  tr.after(row);
  if (btn) { btn.setAttribute("aria-expanded", "true"); btn.textContent = "Hide chart"; }
  render(row.querySelector(".evc"), e, kinds);
}
const button = (e) => (canChart(e) ? ` <button type="button" class="evc-btn" aria-expanded="false" title="Chart what happened around this change">Chart</button>` : "");

window.EVC = { href, toggle, button, canChart };
})();

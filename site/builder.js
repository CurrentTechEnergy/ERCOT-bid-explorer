/* ERCOT Graph Builder. Reads data/series/ (pipeline/series.py: hourly per-unit series by month and
   technology), data/summary_prices.json.gz (hourly lambda and hub prices) and
   data/dam_hubs.json.gz (day-ahead hub prices). Every series is drawn in a MW panel or a $/MWh
   panel on one shared time axis; the whole figure is one SVG, so the download is what you see. */
(() => {
"use strict";

const { tryJSON, showTip, hideTip, readHash, writeHash, css, esc } = window.CX;
const $ = (id) => document.getElementById(id);
const DAY = 864e5;
const fmtDay = d3.utcFormat("%a %b %-d, %Y");
const parseDay = (s) => new Date(s + "T00:00:00Z");
const isoDay = (d) => d.toISOString().slice(0, 10);
const SLOTS = ["--c1", "--c2", "--c3", "--c4", "--c5", "--c6", "--c7", "--c8"];
const MAX_SERIES = SLOTS.length;
const TECHS = { nuclear: "Nuclear", coal: "Coal & lignite", combined_cycle: "Combined cycle", gas_steam: "Gas steam",
  combustion_turbine: "Combustion turbine and recip", wind: "Wind", solar: "Solar", storage: "Storage", hydro: "Hydro", other: "Other" };
const METRICS = {
  hsl: { label: "Available (HSL)", u: "MW" },
  bp: { label: "Dispatched (base point)", u: "MW" },
  out: { label: "Output", u: "MW" },
  curt: { label: "Curtailed (HSL − base point)", u: "MW" },
  directed: { label: "Cut by operator override", u: "MW" },
  award: { label: "Day-ahead award", u: "MW" },
  off_first: { label: "Offer price (first step)", u: "$" },
  off_mid: { label: "Offer price (mid-curve)", u: "$" },
  off_bp: { label: "Offer price at base point", u: "$" },
  rt: { label: "Real-time price", u: "$" },
  da: { label: "Day-ahead price", u: "$" },
  basis: { label: "Basis: node − hub, real time", u: "$" },
};
const UNIT_METRICS = ["hsl", "bp", "out", "curt", "directed", "award", "off_first", "off_mid", "off_bp", "rt", "da", "basis"];
const FLEET_METRICS = ["hsl", "bp", "out", "curt", "directed", "award"];
const TYPES = { line: "Line", dash: "Dashed line", step: "Step", area: "Area", stack: "Stacked area" };
const HOURSETS = {
  all: () => true,
  day: (d, h) => h >= 7 && h <= 18,
  on: (d, h) => { const w = parseDay(d).getUTCDay(); return w >= 1 && w <= 5 && h >= 6 && h <= 21; },
  off: (d, h) => !HOURSETS.on(d, h),
};

const S = { from: null, to: null, res: "h", hs: "all", hrs: Array(24).fill(1), title: "", sub: "", note: "",
  paxis: "lin", maxis: "zero", pmin: "", pmax: "", series: [] };
const D = { idx: null, prices: null, dam: null, plants: {}, points: [] };

// ---------------------------------------------------------------- state & links ---
function saveView() {
  const v = { ...S, hrs: S.hrs.join("") };
  writeHash({ c: JSON.stringify(v) });
}
function loadView() {
  const h = readHash();
  if (!h.c) return false;
  try {
    const v = JSON.parse(h.c);
    Object.assign(S, v, { hrs: String(v.hrs || "").padEnd(24, "1").slice(0, 24).split("").map(Number) });
    S.series = (v.series || []).slice(0, MAX_SERIES);
    return true;
  } catch (e) { return false; }
}

// ------------------------------------------------------------------- data ---
function datesBetween(a, b) {
  const out = [];
  for (let t = parseDay(a).getTime(); t <= parseDay(b).getTime(); t += DAY) out.push(isoDay(new Date(t)));
  return out;
}
const monthFile = (month, tech) => tryJSON(`data/series/${month}/${tech}.json.gz`);

// one tech's files for the months in range -> [{file, di (index into file.dates) per range date}]
async function techSlices(tech, dates) {
  const months = [...new Set(dates.map((d) => d.slice(0, 7)))].filter((m) => D.idx && D.idx.months.includes(m));
  const files = await Promise.all(months.map((m) => monthFile(m, tech)));
  const byDate = new Map();
  files.forEach((f) => { if (f) f.dates.forEach((d, i) => byDate.set(d, [f, i])); });
  return byDate;
}
function take(arr, i) { return arr ? arr.slice(i * 24, i * 24 + 24) : Array(24).fill(null); }
function curtOf(hsl, bp) { return hsl.map((h, i) => (h == null || bp[i] == null ? null : Math.max(h - bp[i], 0))); }

// hourly values (dates.length x 24) of one unit's metric
function unitDay(f, i, name, m, s) {
  const u = f.units[name];
  if (!u) return Array(24).fill(null);
  if (m === "curt") return curtOf(take(u.hsl, i), take(u.bp, i));
  if (m === "rt" || m === "basis") {
    const sp = (D.idx.units[name] || [])[1];
    const rt = take(f.rt[sp], i);
    if (m === "rt") return rt;
    const hub = hubRT(f.dates[i], s.h || "HB_SOUTH");
    return rt.map((v, h) => (v == null || hub[h] == null ? null : v - hub[h]));
  }
  return take(u[m], i);
}
function hubRT(d, pt) {
  const p = D.prices && D.prices[d];
  if (!p) return Array(24).fill(null);
  const v = pt === "lambda" ? p.lambda : (p.spp || {})[pt];
  return (v || []).concat(Array(24).fill(null)).slice(0, 24);
}
function hubDA(d, pt) {
  const p = D.dam && D.dam.days[d];
  return ((p && p[pt]) || []).concat(Array(24).fill(null)).slice(0, 24);
}
const sumOf = (rows) => rows[0].map((_, h) => {
  let s = null;
  rows.forEach((r) => { if (r[h] != null) s = (s || 0) + r[h]; });
  return s;
});

async function values(s, dates) {
  const out = [];
  if (s.k === "price") {
    dates.forEach((d) => out.push(...(s.m === "da" ? hubDA(d, s.id) : hubRT(d, s.id))));
    return out;
  }
  if (!D.idx) return dates.flatMap(() => Array(24).fill(null));
  if (s.k === "unit") {
    const tech = (D.idx.units[s.id] || [])[0];
    const by = tech ? await techSlices(tech, dates) : new Map();
    dates.forEach((d) => { const x = by.get(d); out.push(...(x ? unitDay(x[0], x[1], s.id, s.m, s) : Array(24).fill(null))); });
    return out;
  }
  const names = s.k === "plant" ? D.plants[s.id] || []
    : Object.entries(D.idx.units).filter(([, u]) => s.id === "all" || u[0] === s.id).map(([n]) => n);
  const techs = [...new Set(names.map((n) => D.idx.units[n][0]))];
  const slices = await Promise.all(techs.map((t) => techSlices(t, dates)));
  const byTech = Object.fromEntries(techs.map((t, i) => [t, slices[i]]));
  const MW = METRICS[s.m].u === "MW";
  dates.forEach((d) => {
    const rows = [], wts = [];
    names.forEach((n) => {
      const x = byTech[D.idx.units[n][0]].get(d);
      if (!x) return;
      rows.push(unitDay(x[0], x[1], n, s.m, s));
      wts.push(take(x[0].units[n] && x[0].units[n].hsl, x[1]));
    });
    if (!rows.length) { out.push(...Array(24).fill(null)); return; }
    if (MW) { out.push(...sumOf(rows)); return; }
    if (s.m === "rt" || s.m === "da" || s.m === "basis") {   // the plant's node: first unit with a value
      out.push(...rows[0].map((_, h) => { const r = rows.find((r) => r[h] != null); return r ? r[h] : null; }));
      return;
    }
    // offers: mean weighted by HSL (equal weights where no unit has HSL)
    out.push(...rows[0].map((_, h) => {
      let sw = 0, sv = 0, n = 0, plain = 0;
      rows.forEach((r, j) => {
        if (r[h] == null) return;
        const w = wts[j][h] || 0;
        sw += w; sv += w * r[h]; n++; plain += r[h];
      });
      return n ? (sw > 0 ? sv / sw : plain / n) : null;
    }));
  });
  return out;
}

// hour mask and resolution -> [{t: Date, v: [per series]}]
function aggregate(dates, vals) {
  const inc = S.hs === "custom" ? (d, h) => S.hrs[h] === 1 : HOURSETS[S.hs] || HOURSETS.all;
  const rows = [];
  if (S.res === "h") {
    dates.forEach((d, di) => {
      for (let h = 0; h < 24; h++) {
        const on = inc(d, h);
        rows.push({ t: new Date(parseDay(d).getTime() + h * 36e5), d, h, v: vals.map((a) => (on ? a[di * 24 + h] : null)) });
      }
    });
    return rows;
  }
  dates.forEach((d, di) => {
    const v = vals.map((a, si) => {
      let s = 0, n = 0;
      for (let h = 0; h < 24; h++) if (inc(d, h) && a[di * 24 + h] != null) { s += a[di * 24 + h]; n++; }
      if (!n) return null;
      return S.res === "ds" && METRICS[S.series[si].m].u === "MW" ? s : s / n;
    });
    rows.push({ t: new Date(parseDay(d).getTime() + 12 * 36e5), d, h: null, v });
  });
  return rows;
}

// --------------------------------------------------------------- labels ---
function entityName(s) {
  if (s.k === "unit") return s.id;
  if (s.k === "plant") return `${s.id} (${(D.plants[s.id] || []).length} units)`;
  if (s.k === "fleet") return s.id === "all" ? "All units" : `${TECHS[s.id] || s.id} fleet`;
  return s.id === "lambda" ? "System lambda" : s.id;
}
function defaultLabel(s) {
  if (s.k === "price") return s.id === "lambda" ? "System lambda" : `${s.m === "da" ? "Day-ahead" : "Real-time"} price, ${s.id}`;
  let m = METRICS[s.m].label;
  if (s.m === "basis") m = `Basis: node − ${s.h || "HB_SOUTH"}, real time`;
  if ((s.m === "rt" || s.m === "da") && s.k !== "price") m += " at its node";
  return `${entityName(s)}, ${m.charAt(0).toLowerCase() + m.slice(1)}`;
}
const labelOf = (s) => s.l || defaultLabel(s);
const unitOf = (s) => METRICS[s.m].u;

// ---------------------------------------------------------------- sidebar ---
function setSeg(id, v) { $(id).querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === v))); }
function nextSlot() {
  const used = new Set(S.series.map((s) => s.c));
  return SLOTS.find((c) => !used.has(c)) || "--c-other";
}
function renderSeriesList() {
  const el = $("series-list");
  el.innerHTML = "";
  S.series.forEach((s, i) => {
    const row = document.createElement("div");
    row.className = "s-row";
    row.innerHTML = `<span class="sw" style="background:var(${s.c})"></span>
      <div><input type="text" class="lab" aria-label="Legend label" value="${esc(labelOf(s))}">
      <div class="meta"><select aria-label="Chart type">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}"${k === s.t ? " selected" : ""}>${v}</option>`).join("")}</select>
      <select aria-label="Color">${SLOTS.concat("--c-other").map((c, j) => `<option value="${c}"${c === s.c ? " selected" : ""}>Color ${j < SLOTS.length ? j + 1 : "gray"}</option>`).join("")}</select>
      <span>${unitOf(s) === "MW" ? "MW" : "$/MWh"}</span></div></div>
      <button type="button" class="x" aria-label="Remove">×</button>`;
    const [inp] = row.getElementsByTagName("input");
    const [type, color] = row.getElementsByTagName("select");
    inp.addEventListener("change", () => { s.l = inp.value.trim() && inp.value.trim() !== defaultLabel(s) ? inp.value.trim() : undefined; changed(); });
    type.addEventListener("change", () => { s.t = type.value; changed(); });
    color.addEventListener("change", () => { s.c = color.value; renderSeriesList(); changed(); });
    row.querySelector(".x").addEventListener("click", () => { S.series.splice(i, 1); renderSeriesList(); changed(); });
    el.appendChild(row);
  });
  $("add").disabled = S.series.length >= MAX_SERIES;
  $("series-hint").textContent = S.series.length >= MAX_SERIES ? `Up to ${MAX_SERIES} series, so each keeps its own color.` :
    S.series.length ? "" : "Add a unit, plant, fleet or price point to start.";
}
function renderHours() {
  setSeg("hourset", S.hs);
  const inc = S.hs === "custom" ? null : HOURSETS[S.hs];
  $("hours").innerHTML = S.hrs.map((on, h) => {
    const pressed = inc ? (S.hs === "on" || S.hs === "off" ? inc("2026-01-07", h) : inc("", h)) : on === 1;
    return `<button type="button" data-h="${h}" aria-pressed="${pressed}">${h + 1}</button>`;
  }).join("");
}
function syncInputs() {
  $("from").value = S.from || ""; $("to").value = S.to || "";
  $("res").value = S.res; $("title").value = S.title; $("subtitle").value = S.sub; $("note").value = S.note;
  $("paxis").value = S.paxis; $("maxis").value = S.maxis; $("pmin").value = S.pmin; $("pmax").value = S.pmax;
  renderHours(); renderSeriesList();
}
function bindInputs() {
  const on = (id, key, ev = "change") => $(id).addEventListener(ev, () => { S[key] = $(id).value; changed(); });
  on("from", "from"); on("to", "to"); on("res", "res"); on("paxis", "paxis"); on("maxis", "maxis");
  on("pmin", "pmin"); on("pmax", "pmax");
  on("title", "title", "input"); on("subtitle", "sub", "input"); on("note", "note", "input");
  $("hourset").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.v === "custom" && S.hs !== "custom") {     // start the custom set from what was shown
      const inc = HOURSETS[S.hs] || HOURSETS.all;
      S.hrs = S.hrs.map((_, h) => (inc(S.hs === "on" || S.hs === "off" ? "2026-01-07" : "", h) ? 1 : 0));
    }
    S.hs = b.dataset.v; renderHours(); changed();
  });
  $("hours").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (S.hs !== "custom") { const inc = HOURSETS[S.hs]; S.hrs = S.hrs.map((_, h) => (inc(S.hs === "on" || S.hs === "off" ? "2026-01-07" : "", h) ? 1 : 0)); S.hs = "custom"; }
    S.hrs[+b.dataset.h] ^= 1; renderHours(); changed();
  });
  $("preset").addEventListener("change", () => { if ($("preset").value) applyPreset($("preset").value); });
  document.querySelector(".exports").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-x]"); if (!b) return;
    ({ png: downloadPNG, svg: downloadSVG, csv: downloadCSV })[b.dataset.x]();
  });
}

// ----------------------------------------------------------------- picker ---
const P = { kind: "unit", sel: null };
function openPicker() {
  P.sel = null; $("pk-q").value = ""; setSeg("pk-kind", P.kind); renderPickList(); renderPickMetrics();
  $("picker").showModal(); $("pk-q").focus();
}
function pickItems() {
  const q = $("pk-q").value.trim().toLowerCase();
  if (P.kind === "fleet") return [["all", "All units", ""], ...Object.entries(TECHS)
    .filter(([t]) => D.idx && (D.idx.techs[t] || []).length).map(([t, l]) => [t, l, `${D.idx.techs[t].length} units`])]
    .filter(([, l]) => !q || l.toLowerCase().includes(q));
  if (P.kind === "price") return D.points.filter((p) => !q || p.toLowerCase().includes(q))
    .map((p) => [p, p === "lambda" ? "System lambda" : p, p.startsWith("HB_") ? "hub" : p.startsWith("LZ_") ? "load zone" : ""]);
  if (!D.idx || q.length < 2) return [];
  const items = [];
  Object.entries(D.plants).forEach(([sp, ns]) => {
    if (ns.length > 1 && (sp.toLowerCase().includes(q) || ns.some((n) => n.toLowerCase().includes(q))))
      items.push([`plant:${sp}`, `${sp} (plant, ${ns.length} units)`, TECHS[D.idx.units[ns[0]][0]] || ""]);
  });
  Object.entries(D.idx.units).forEach(([n, u]) => {
    if (n.toLowerCase().includes(q) || (u[1] || "").toLowerCase().includes(q))
      items.push([`unit:${n}`, n, `${TECHS[u[0]] || u[0]}${u[2] ? ` · ${Math.round(u[2])} MW` : ""}`]);
  });
  return items.slice(0, 60);
}
function renderPickList() {
  const items = pickItems();
  const q = $("pk-q").value.trim();
  $("pk-list").innerHTML = items.length ? items.map(([id, l, m]) =>
    `<li><button type="button" data-id="${esc(id)}" aria-pressed="${id === P.sel}"><span>${esc(l)}</span><span class="m">${esc(m)}</span></button></li>`).join("")
    : `<li class="hint" style="padding:6px 8px">${P.kind === "unit" && q.length < 2 ? "Type at least two letters of a unit or settlement point" : D.idx || P.kind === "price" ? "Nothing matches" : "No unit series loaded yet"}</li>`;
  $("pk-q").placeholder = P.kind === "unit" ? "Unit name or settlement point" : P.kind === "fleet" ? "Technology" : "Hub, load zone or lambda";
}
function renderPickMetrics() {
  const el = $("pk-metrics");
  if (!P.sel) { $("pk-for").textContent = "Pick one on the left"; el.innerHTML = ""; $("pk-go").disabled = true; return; }
  let ms;
  if (P.kind === "price") ms = P.sel === "lambda" ? ["rt"] : ["rt", "da"];
  else if (P.kind === "fleet") ms = FLEET_METRICS;
  else ms = UNIT_METRICS;
  const name = P.kind === "price" ? (P.sel === "lambda" ? "System lambda" : P.sel) : P.kind === "fleet" ? (P.sel === "all" ? "All units" : TECHS[P.sel]) : P.sel.split(":")[1];
  $("pk-for").textContent = `Metrics for ${name}`;
  const hubs = D.points.filter((p) => p.startsWith("HB_"));
  el.innerHTML = ms.map((m) => `<label><span><input type="checkbox" value="${m}"> ${P.kind === "price" && m === "rt" && P.sel === "lambda" ? "System lambda" : METRICS[m].label}${(m === "rt" || m === "da") && P.kind === "unit" ? " at its node" : ""}</span><span class="u">${METRICS[m].u === "MW" ? "MW" : "$/MWh"}</span></label>`).join("")
    + (ms.includes("basis") ? `<label class="f" style="font-size:12px">Basis against <select id="pk-hub">${hubs.map((h) => `<option${h === "HB_SOUTH" ? " selected" : ""}>${h}</option>`).join("")}</select></label>` : "");
  updateGo();
}
function updateGo() {
  const n = $("pk-metrics").querySelectorAll("input:checked").length;
  const room = MAX_SERIES - S.series.length;
  $("pk-go").disabled = !n || n > room;
  $("pk-go").textContent = n > 1 ? `Add ${n} series` : "Add";
  $("pk-hint").textContent = n > room ? `Only ${room} more series fit (${MAX_SERIES} at most).` : "MW metrics go to the MW panel and prices to the price panel.";
}
function bindPicker() {
  $("add").addEventListener("click", openPicker);
  $("pk-kind").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; P.kind = b.dataset.v; P.sel = null; setSeg("pk-kind", P.kind); renderPickList(); renderPickMetrics(); });
  $("pk-q").addEventListener("input", renderPickList);
  $("pk-list").addEventListener("click", (e) => { const b = e.target.closest("button[data-id]"); if (!b) return; P.sel = b.dataset.id; renderPickList(); renderPickMetrics(); });
  $("pk-metrics").addEventListener("change", updateGo);
  $("pk-cancel").addEventListener("click", () => $("picker").close());
  $("pk-go").addEventListener("click", () => {
    const ms = [...$("pk-metrics").querySelectorAll("input:checked")].map((i) => i.value);
    let k = P.kind, id = P.sel;
    if (k === "unit") [k, id] = P.sel.split(/:(.*)/s);
    const hub = $("pk-hub") ? $("pk-hub").value : undefined;
    ms.forEach((m) => {
      const s = { k, id, m, t: METRICS[m].u === "MW" ? (m === "hsl" ? "area" : "line") : "line", c: nextSlot() };
      if (m === "basis") s.h = hub;
      S.series.push(s);
    });
    $("picker").close();
    renderSeriesList(); changed();
  });
}

// ---------------------------------------------------------------- presets ---
const PRESETS = [
  { id: "outpost", label: "Outpost Solar during Winter Storm Fern", from: "2026-01-23", to: "2026-01-27", paxis: "sym",
    title: "Outpost Solar during Winter Storm Fern",
    sub: "What the plant could produce, what ERCOT dispatched, and the prices behind it, Jan 23–27, 2026, hourly",
    note: "On Jan 25 and 26 the plant offered its output well above the price at its node, so SCED dispatched it to zero. Offers are the first price on the submitted SCED curve; prices are hourly means of ERCOT's 15-minute settlement point prices.",
    series: [
      { k: "plant", id: "OUTP_SLR_RN", m: "hsl", t: "area", c: "--c1", l: "Available (HSL)" },
      { k: "plant", id: "OUTP_SLR_RN", m: "bp", t: "line", c: "--c1", l: "Dispatched (base point)" },
      { k: "plant", id: "OUTP_SLR_RN", m: "off_first", t: "line", c: "--c2", l: "Outpost offer price" },
      { k: "plant", id: "OUTP_SLR_RN", m: "rt", t: "line", c: "--c3", l: "Real-time price at Outpost's node" },
      { k: "price", id: "HB_SOUTH", m: "rt", t: "dash", c: "--c7", l: "Real-time price at the South hub" },
      { k: "plant", id: "OUTP_SLR_RN", m: "da", t: "line", c: "--c4", l: "Day-ahead price at Outpost's node" },
    ] },
  { id: "solar-curt", label: "Solar fleet curtailment vs South hub prices", last: 7, paxis: "lin",
    title: "Solar output, curtailment and South hub prices", sub: "ERCOT solar fleet, hourly",
    note: "Curtailed is each solar unit's HSL minus its SCED base point, summed over the fleet.",
    series: [
      { k: "fleet", id: "solar", m: "bp", t: "stack", c: "--c1", l: "Dispatched (base point)" },
      { k: "fleet", id: "solar", m: "curt", t: "stack", c: "--c4", l: "Curtailed (HSL − base point)" },
      { k: "price", id: "HB_SOUTH", m: "rt", t: "line", c: "--c2", l: "Real-time, South hub" },
      { k: "price", id: "HB_SOUTH", m: "da", t: "dash", c: "--c7", l: "Day-ahead, South hub" },
    ] },
  { id: "thermal", label: "Nuclear, coal and gas output vs lambda", last: 7, paxis: "lin",
    title: "Thermal output and system lambda", sub: "ERCOT nuclear, coal and combined-cycle fleets, hourly",
    note: "Output is telemetered net output summed over each fleet's units.",
    series: [
      { k: "fleet", id: "nuclear", m: "out", t: "stack", c: "--c7", l: "Nuclear" },
      { k: "fleet", id: "coal", m: "out", t: "stack", c: "--c5", l: "Coal & lignite" },
      { k: "fleet", id: "combined_cycle", m: "out", t: "stack", c: "--c1", l: "Combined cycle" },
      { k: "price", id: "lambda", m: "rt", t: "line", c: "--c2", l: "System lambda" },
    ] },
  { id: "blank", label: "Blank", last: 7, series: [] },
];
function applyPreset(id, write = true) {
  const p = PRESETS.find((x) => x.id === id) || PRESETS[0];
  const unitDates = (D.idx && D.idx.dates) || [];
  const allDates = unitDates.length ? unitDates : Object.keys(D.prices || {}).sort();
  let from = p.from, to = p.to;
  if (!from || !unitDates.includes(from)) { to = allDates[allDates.length - 1]; from = allDates[Math.max(0, allDates.length - (p.last || 7))]; }
  Object.assign(S, { from, to, res: "h", hs: "all", hrs: Array(24).fill(1), title: p.title || "", sub: p.sub || "",
    note: p.note || "", paxis: p.paxis || "lin", maxis: "zero", pmin: "", pmax: "",
    series: p.series.map((s) => ({ ...s })) });
  if (p.sub && p.id !== "outpost" && from) S.sub = `${p.sub}, ${d3.utcFormat("%b %-d")(parseDay(from))}–${d3.utcFormat("%b %-d, %Y")(parseDay(to))}`;
  $("preset").value = p.id;
  syncInputs();
  if (write) changed();
}

// ------------------------------------------------------------------ figure ---
const W = 1200, PADX = 36, PLOT_L = 92, PLOT_R = W - 24, CH = 260;
const FONT = "IBM Plex Sans, Helvetica, Arial, sans-serif", MONO = "IBM Plex Mono, Menlo, monospace";
let FIG = null;     // {svg, rows, series, panels} of the last render
let token = 0;

function wrap(text, width, size) {
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.font = `${size}px ${FONT}`;
  const lines = [];
  String(text || "").split(/\n/).forEach((para) => {
    let line = "";
    para.split(/\s+/).filter(Boolean).forEach((w) => {
      const next = line ? `${line} ${w}` : w;
      if (line && ctx.measureText(next).width > width) { lines.push(line); line = w; } else line = next;
    });
    if (line) lines.push(line);
  });
  return lines;
}
const fmtV = (u, v) => (v == null ? "–" : u === "MW" ? `${d3.format(",.1f")(v)} ${S.res === "ds" ? "MWh" : "MW"}` : (v < 0 ? "−$" : "$") + d3.format(",.2f")(Math.abs(v)));

function priceScale(lo, hi, range) {
  if (S.paxis === "sym") return d3.scaleSymlog().constant(10).domain([lo, hi]).range(range);
  return d3.scaleLinear().domain([lo, hi]).nice().range(range);
}
function symTicks(lo, hi) {
  const c = [-5000, -1000, -500, -250, -100, -50, -20, 0, 20, 50, 100, 200, 500, 1000, 2000, 5000];
  return c.filter((t) => t >= lo && t <= hi);
}

async function render() {
  const my = ++token;
  const el = $("figure");
  const dates = S.from && S.to && S.from <= S.to ? datesBetween(S.from, S.to) : [];
  if (!dates.length || !S.series.length) {
    el.innerHTML = `<p class="empty">${!S.series.length ? "Add a series to start, or pick a preset." : "Pick a date range."}</p>`;
    FIG = null; return;
  }
  if (dates.length > 120) $("status").textContent = `Loading ${dates.length} days of data…`;
  const vals = await Promise.all(S.series.map((s) => values(s, dates)));
  if (my !== token) return;
  const rows = aggregate(dates, vals);
  draw(rows, dates);
  $("status").textContent = statusText();
}

function draw(rows, dates) {
  const NS = "http://www.w3.org/2000/svg";
  const ink = css("--ink"), ink2 = css("--ink-2"), muted = css("--muted"), grid = css("--grid"), axisC = css("--axis"), surface = css("--surface");
  const svg = d3.create("svg").attr("xmlns", NS).attr("data-nopin", "");
  const g = svg.append("g");
  let y = 40;
  const text = (x, yy, s, size, color, weight = 400, family = FONT) => g.append("text").attr("x", x).attr("y", yy).text(s)
    .attr("style", `font-family:${family};font-size:${size}px;fill:${color};font-weight:${weight}`);
  if (S.title) { wrap(S.title, W - 2 * PADX, 24).forEach((l) => { text(PADX, y, l, 24, ink, 600); y += 30; }); y -= 4; }
  if (S.sub) { wrap(S.sub, W - 2 * PADX, 15).forEach((l) => { y += 6; text(PADX, y, l, 15, ink2); y += 14; }); }
  y += 18;

  const x = d3.scaleUtc().domain([parseDay(dates[0]), new Date(parseDay(dates[dates.length - 1]).getTime() + DAY)]).range([PLOT_L, PLOT_R]);
  const span = dates.length;
  const ticks = span <= 16 ? d3.utcDay.every(1) : span <= 70 ? d3.utcMonday.every(1) : d3.utcMonth.every(1);
  const tfmt = span <= 16 ? d3.utcFormat("%a %b %-d") : span <= 70 ? d3.utcFormat("%b %-d") : d3.utcFormat("%b %Y");
  const mw = S.series.map((s, i) => i).filter((i) => unitOf(S.series[i]) === "MW");
  const pr = S.series.map((s, i) => i).filter((i) => unitOf(S.series[i]) === "$");
  const panels = [];
  if (mw.length) panels.push({ u: "MW", idx: mw, title: S.res === "ds" ? "Energy (MWh per day)" : "Power (MW)" });
  if (pr.length) panels.push({ u: "$", idx: pr, title: S.res === "ds" ? "Prices ($/MWh, daily mean)" : "Prices ($/MWh)" });
  const color = (i) => css(S.series[i].c) || css("--c-other");
  const curveOf = (t) => (t === "step" ? d3.curveStepAfter : d3.curveLinear);
  const tx = (r) => (S.res === "h" ? x(new Date(r.t.getTime() + 18e5)) : x(r.t));

  panels.forEach((p) => {
    text(PADX, y, p.title, 15, ink, 600); y += 10;
    // legend
    let lx = PADX; y += 16;
    p.idx.forEach((i) => {
      const s = S.series[i], lab = labelOf(s), w = 26 + lab.length * 6.9;
      if (lx + w > W - PADX) { lx = PADX; y += 20; }
      if (s.t === "area" || s.t === "stack") g.append("rect").attr("x", lx).attr("y", y - 10).attr("width", 14).attr("height", 10).attr("rx", 2)
        .attr("style", `fill:${color(i)};fill-opacity:${s.t === "area" ? 0.35 : 0.8}`);
      else g.append("line").attr("x1", lx).attr("x2", lx + 16).attr("y1", y - 5).attr("y2", y - 5)
        .attr("style", `stroke:${color(i)};stroke-width:2.5;${s.t === "dash" ? "stroke-dasharray:5 3;" : ""}`);
      text(lx + 22, y, lab, 13, ink2);
      lx += w + 18;
    });
    y += 14;
    const top = y, bottom = y + CH;
    // stacks
    const stacked = p.idx.filter((i) => S.series[i].t === "stack");
    const base = rows.map(() => 0), tops = {};
    stacked.forEach((i) => { tops[i] = rows.map((r, j) => { const lo = base[j]; base[j] += r.v[i] || 0; return [lo, base[j]]; }); });
    let lo = Infinity, hi = -Infinity;
    rows.forEach((r, j) => p.idx.forEach((i) => {
      const v = S.series[i].t === "stack" ? (r.v[i] == null ? null : tops[i][j][1]) : r.v[i];
      if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    }));
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    let ys;
    if (p.u === "MW") {
      if (S.maxis === "zero" || p.idx.some((i) => ["area", "stack"].includes(S.series[i].t))) lo = Math.min(0, lo);
      ys = d3.scaleLinear().domain([lo, hi === lo ? lo + 1 : hi]).nice().range([bottom, top]);
    } else {
      const a = S.pmin !== "" && Number.isFinite(+S.pmin) ? +S.pmin : Math.min(0, lo);
      const b = S.pmax !== "" && Number.isFinite(+S.pmax) ? +S.pmax : hi;
      ys = priceScale(a, b > a ? b : a + 1, [bottom, top]);
    }
    const yt = p.u === "$" && S.paxis === "sym" ? symTicks(...ys.domain()) : ys.ticks(5);
    const yf = p.u === "MW" ? window.CX.tickFormat(yt) : window.CX.tickFormat(yt, "$");
    yt.forEach((t) => {
      g.append("line").attr("x1", PLOT_L).attr("x2", PLOT_R).attr("y1", ys(t)).attr("y2", ys(t))
        .attr("style", `stroke:${t === 0 ? axisC : grid};stroke-width:1`);
      text(PLOT_L - 8, ys(t) + 4, t < 0 ? "−" + yf(-t) : yf(t), 12, muted, 400, MONO).attr("text-anchor", "end");
    });
    x.ticks(ticks).filter((t) => x(t) < PLOT_R - 60).forEach((t) => {
      g.append("line").attr("x1", x(t)).attr("x2", x(t)).attr("y1", bottom).attr("y2", bottom + 5).attr("style", `stroke:${axisC}`);
      text(x(t) + 3, bottom + 20, tfmt(t), 12, ink2);
    });
    g.append("line").attr("x1", PLOT_L).attr("x2", PLOT_R).attr("y1", bottom).attr("y2", bottom).attr("style", `stroke:${axisC}`);
    const clip = `clip-${p.u === "MW" ? "mw" : "p"}`;
    svg.append("defs").append("clipPath").attr("id", clip).append("rect").attr("x", PLOT_L).attr("y", top - 2).attr("width", PLOT_R - PLOT_L).attr("height", CH + 4);
    const marks = g.append("g").attr("clip-path", `url(#${clip})`);
    // areas first, then stacks, then lines on top
    const order = [...p.idx].sort((a, b) => ({ area: 0, stack: 1 }[S.series[a].t] ?? 2) - ({ area: 0, stack: 1 }[S.series[b].t] ?? 2));
    order.forEach((i) => {
      const s = S.series[i], c = color(i);
      const def = (r) => r.v[i] != null;
      if (s.t === "area") {
        marks.append("path").attr("d", d3.area().defined(def).curve(curveOf(s.t)).x(tx).y0(ys(Math.max(0, ys.domain()[0]))).y1((r) => ys(r.v[i]))(rows))
          .attr("style", `fill:${c};fill-opacity:0.35;stroke:none`);
      } else if (s.t === "stack") {
        marks.append("path").attr("d", d3.area().defined(def).x(tx).y0((r, j) => ys(tops[i][j][0])).y1((r, j) => ys(tops[i][j][1]))(rows))
          .attr("style", `fill:${c};fill-opacity:0.8;stroke:${surface};stroke-width:0.5`);
      } else {
        marks.append("path").attr("d", d3.line().defined(def).curve(curveOf(s.t)).x(tx).y((r) => ys(r.v[i]))(rows))
          .attr("style", `fill:none;stroke:${c};stroke-width:2;stroke-linejoin:round;${s.t === "dash" ? "stroke-dasharray:6 4;" : ""}`);
        // isolated points (a lone hour between gaps) would vanish as a line
        if (S.res !== "h" || rows.length <= 400) rows.forEach((r, j) => {
          if (def(r) && !(rows[j - 1] && def(rows[j - 1])) && !(rows[j + 1] && def(rows[j + 1])))
            marks.append("circle").attr("cx", tx(r)).attr("cy", ys(r.v[i])).attr("r", 2.5).attr("style", `fill:${c}`);
        });
      }
    });
    p.top = top; p.bottom = bottom; p.ys = ys;
    y = bottom + 46;
  });
  // footnote and sources
  const src = sourcesLine();
  y += 4;
  wrap(S.note, W - 2 * PADX, 13).forEach((l) => { text(PADX, y, l, 13, muted); y += 18; });
  if (S.note) y += 6;
  wrap(src, W - 2 * PADX, 12).forEach((l) => { text(PADX, y, l, 12, muted); y += 17; });
  y += 14;
  svg.attr("viewBox", `0 0 ${W} ${y}`).attr("width", W).attr("height", y);
  svg.insert("rect", ":first-child").attr("width", W).attr("height", y).attr("style", `fill:${surface}`);
  // hover layer (removed from downloads)
  const hover = svg.append("g").attr("class", "hover-layer");
  const cross = panels.map((p) => hover.append("line").attr("y1", p.top).attr("y2", p.bottom).attr("style", `stroke:${muted};stroke-dasharray:3 3;display:none`));
  hover.append("rect").attr("x", PLOT_L).attr("y", panels[0] ? panels[0].top : 0).attr("width", PLOT_R - PLOT_L)
    .attr("height", panels.length ? panels[panels.length - 1].bottom - panels[0].top : 0).attr("style", "fill:transparent")
    .on("mousemove", (ev) => {
      const [mx] = d3.pointer(ev);
      const t = x.invert(mx);
      let j = d3.bisector((r) => r.t).center(rows, S.res === "h" ? new Date(t.getTime() - 18e5) : t);
      j = Math.max(0, Math.min(rows.length - 1, j));
      const r = rows[j];
      cross.forEach((c) => c.attr("x1", tx(r)).attr("x2", tx(r)).style("display", null));
      const head = S.res === "h" ? `${fmtDay(parseDay(r.d))}, hour ending ${r.h + 1}` : fmtDay(parseDay(r.d));
      showTip(ev, `<h4>${head}</h4><table>${S.series.map((s, i) => `<tr><td><span class="sw" style="background:${color(i)};width:9px;height:9px"></span> ${esc(labelOf(s))}</td><td class="n">${fmtV(unitOf(s), r.v[i])}</td></tr>`).join("")}</table>`);
    })
    .on("mouseleave", () => { cross.forEach((c) => c.style("display", "none")); hideTip(); });
  const el = $("figure");
  el.innerHTML = "";
  el.appendChild(svg.node());
  FIG = { svg: svg.node(), rows, H: y };
}

function sourcesLine() {
  const k = new Set(S.series.map((s) => (s.k === "price" ? `price-${s.m}` : s.m === "rt" || s.m === "basis" ? "node" : s.m === "da" || s.m === "award" ? "dam" : "sced")));
  if (S.series.some((s) => s.m === "basis")) k.add("price-rt");
  const parts = [];
  if (k.has("sced")) parts.push("60-Day SCED Disclosure (NP3-965-ER)");
  if (k.has("dam")) parts.push("60-Day DAM Disclosure (NP3-966-ER)");
  if (k.has("node") || k.has("price-rt")) parts.push("Settlement Point Prices (NP6-905-CD)");
  if (S.series.some((s) => s.k === "price" && s.id === "lambda")) parts.push("System Lambda (NP6-322-CD)");
  if (k.has("price-da")) parts.push("DAM Settlement Point Prices (NP4-190-CD)");
  return `Source: ERCOT ${parts.join(", ")}. ERCOT Bid Stack Explorer, ${location.host ? location.host + location.pathname.replace(/builder\.html$/, "") : "builder"}.`;
}

// --------------------------------------------------------------- downloads ---
function slug(s) { return (s || "chart").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "chart"; }
function exportSVG() {
  const c = FIG.svg.cloneNode(true);
  c.querySelectorAll(".hover-layer").forEach((n) => n.remove());
  c.removeAttribute("data-nopin");
  return new XMLSerializer().serializeToString(c);
}
function save(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const fileName = (ext) => `${slug(S.title || labelOf(S.series[0] || {}))}-${S.from}-to-${S.to}.${ext}`;
function downloadSVG() { if (FIG) save(new Blob([exportSVG()], { type: "image/svg+xml" }), fileName("svg")); }
function downloadPNG() {
  if (!FIG) return;
  const url = URL.createObjectURL(new Blob([exportSVG()], { type: "image/svg+xml" }));
  const img = new Image();
  img.onload = () => {
    const k = 2, c = document.createElement("canvas");
    c.width = W * k; c.height = FIG.H * k;
    const ctx = c.getContext("2d"); ctx.scale(k, k); ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    c.toBlob((b) => save(b, fileName("png")), "image/png");
  };
  img.src = url;
}
function downloadCSV() {
  if (!FIG) return;
  const cell = (v) => (v == null ? "" : typeof v === "number" ? String(Math.round(v * 1e4) / 1e4) : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const head = ["date", ...(S.res === "h" ? ["hour_ending"] : []), ...S.series.map((s) => `${labelOf(s)} (${unitOf(s) === "MW" ? (S.res === "ds" ? "MWh" : "MW") : "$/MWh"})`)];
  const lines = [head, ...FIG.rows.map((r) => [r.d, ...(S.res === "h" ? [r.h + 1] : []), ...r.v])].map((r) => r.map(cell).join(","));
  save(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }), fileName("csv"));
}

// ------------------------------------------------------------------- main ---
function statusText() {
  const u = D.idx ? `Unit series ${fmtDay(parseDay(D.idx.dates[0]))} to ${fmtDay(parseDay(D.idx.dates[D.idx.dates.length - 1]))}` : "No unit series yet (built by the next data update)";
  const pd = Object.keys(D.prices || {}).sort();
  return `${u}. Prices to ${pd.length ? fmtDay(parseDay(pd[pd.length - 1])) : "–"}.`;
}
function availHint() {
  const outside = S.series.some((s) => s.k !== "price") && D.idx && (S.from < D.idx.dates[0] || S.to > D.idx.dates[D.idx.dates.length - 1]);
  $("avail").textContent = outside ? `Unit, plant and fleet series cover ${D.idx.dates[0]} to ${D.idx.dates[D.idx.dates.length - 1]}; days outside that are blank.` : "";
}
let pending = null;
function changed() {
  saveView(); availHint();
  clearTimeout(pending);
  pending = setTimeout(render, 60);
}

async function init() {
  window.CX.init();
  bindInputs(); bindPicker();
  $("preset").innerHTML = `<option value="">Your chart</option>` + PRESETS.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join("");
  [D.idx, D.prices, D.dam] = await Promise.all([tryJSON("data/series/index.json.gz"), tryJSON("data/summary_prices.json.gz"), tryJSON("data/dam_hubs.json.gz")]);
  if (D.idx) Object.entries(D.idx.units).forEach(([n, u]) => { if (u[1]) (D.plants[u[1]] = D.plants[u[1]] || []).push(n); });
  const pts = new Set();
  Object.values(D.prices || {}).slice(-3).forEach((p) => Object.keys(p.spp || {}).forEach((k) => pts.add(k)));
  D.points = ["lambda", ...[...pts].sort()];
  const dates = D.idx ? D.idx.dates : Object.keys(D.prices || {}).sort();
  if (dates.length) { $("from").min = $("to").min = dates[0]; }
  const pd = Object.keys(D.prices || {}).sort();
  if (pd.length) $("from").max = $("to").max = pd[pd.length - 1];
  if (loadView()) { $("preset").value = ""; syncInputs(); changed(); }
  else applyPreset("thermal");
  $("status").textContent = statusText();
  window.addEventListener("hashchange", () => { if (loadView()) { syncInputs(); render(); } });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
}
init();
})();

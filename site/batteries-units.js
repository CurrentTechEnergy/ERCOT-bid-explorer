/* Batteries, units table: every battery against the perfect battery over the last 30 or 90 days of
   the benchmark, or every day since RTC+B. Reads data/storage/bench_units.json.gz
   (pipeline/battery_bench.py: per battery-day energy revenue, DAM AS revenue, the perfect battery,
   MWh and $ charged and discharged), data/storage/units.json.gz (pipeline/storage.py: each day's
   largest HSL) and data/unit_index.json.gz (QSE, zone, settlement point). Loaded when the panel
   comes into view, so the rest of the page does not wait for it. Sorting and the CSV follow the
   Renewables units table (renewables-hedge.js): click a column to sort, again to flip it; text
   sorts A to Z first, numbers largest first; a row opens the Unit page. */
(() => {
"use strict";

const { tryJSON, setCSV, esc, unitIndex } = window.CX;
const $ = (id) => document.getElementById(id);
const fmt0 = d3.format(",.0f"), fmt1 = d3.format(",.1f"), fmt2 = d3.format(".2f"), fmtPct = d3.format(".0%");
const money = (f) => (v) => (v == null || isNaN(v) ? "–" : (v < 0 ? "−" : "") + "$" + f(Math.abs(v)));
const fmt$ = money(d3.format(",.2f")), fmt$0 = money(fmt0);
const pct = (v) => (v == null || isNaN(v) ? "–" : fmtPct(v));
const MIN_DAYS = 7;          // fewer priced days than this in the period and a battery is left out
const IDLE_CYCLES = 0.1;     // full cycles a day below which a battery counts as idle
const CATS = {
  arb: { label: "Arbitrage", color: "--c3", tip: "Day-ahead AS under 25% of revenue: earns mostly by moving energy." },
  mixed: { label: "Mixed", color: "--c4", tip: "Day-ahead AS 25% to 50% of revenue." },
  as: { label: "Mostly AS", color: "--c1", tip: "Day-ahead AS over half of revenue: mostly paid to hold capacity." },
  idle: { label: "Idle", color: "--c-other", tip: `Under ${IDLE_CYCLES} full cycles a day over the period.` },
};
const CAT_ORDER = { arb: 0, mixed: 1, as: 2, idle: 3 };
const TEXT_KEYS = ["name", "qse", "zone", "sp", "cat"];
const S = { win: "90", cat: "all", q: "", sort: "kwm", dir: -1, rows: null, loading: null };
const VIEW_KEYS = { uwin: "win", ucat: "cat", usort: "sort", udir: "dir" };

function saveView() {
  window.CX.writeHash({ ...window.CX.readHash(), uwin: S.win === "90" ? null : S.win, ucat: S.cat === "all" ? null : S.cat,
    usort: S.sort === "kwm" ? null : S.sort, udir: S.dir === -1 ? null : S.dir });
}
function loadView() {
  const v = window.CX.readHash();
  Object.entries(VIEW_KEYS).forEach(([k, sk]) => { if (v[k] != null) S[sk] = v[k]; });
  S.dir = +S.dir === 1 ? 1 : -1;
  if (!["30", "90", "all"].includes(S.win)) S.win = "90";
  if (S.cat !== "all" && !CATS[S.cat]) S.cat = "all";
}
function setSeg(id, value) { $(id).querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === value))); }
function bindSeg(id, key, after) {
  $(id).addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; S[key] = b.dataset.v; setSeg(id, S[key]); after(); saveView(); });
}
const emptyMsg = (el, msg) => { el.innerHTML = `<p class="empty">${msg}</p>`; };
const catCell = (c) => `<span class="tier" title="${esc(CATS[c].tip)}"><span class="sw" style="background:var(${CATS[c].color})"></span>${CATS[c].label}</span>`;

const COLS = [
  { k: "name", h: "Unit", t: 1, f: (u) => `<a href="unit.html?unit=${encodeURIComponent(u.name)}">${esc(u.name)}</a>` },
  { k: "cat", h: "Category", t: 1, f: (u) => catCell(u.cat), tip: "Where the revenue came from. Arbitrage: day-ahead AS under 25% of revenue. Mixed: 25% to 50%. Mostly AS: over 50%. Idle: under 0.1 full cycles a day." },
  { k: "mw", h: "MW", f: (u) => fmt0(u.mw), tip: "The largest HSL over the period: what the battery can discharge." },
  { k: "mwh", h: "MWh", f: (u) => (u.mwh == null ? "–" : fmt0(u.mwh)), tip: "Usable state of charge range (maximum less minimum), the median day in the period." },
  { k: "dur", h: "Hours", f: (u) => (u.dur == null ? "–" : fmt1(u.dur)), tip: "Duration: MWh over MW." },
  { k: "kwm", h: "$/kW-month", f: (u) => fmt$(u.kwm), tip: "Energy plus day-ahead AS revenue per kW of MW, per 30.4 days." },
  { k: "perf", h: "% of perfect", f: (u) => pct(u.perf), tip: "Energy revenue over what a perfect battery at the same node would have made on energy, knowing the real-time prices in advance (same MW, usable range, round-trip efficiency, AS holdback, at most one cycle a day)." },
  { k: "as_share", h: "AS share", f: (u) => pct(u.as_share), tip: "Day-ahead AS revenue over energy (counted as zero if negative) plus AS revenue." },
  { k: "cyc", h: "Cycles a day", f: (u) => (u.cyc == null ? "–" : fmt2(u.cyc)), tip: "MWh discharged over the usable range, per day." },
  { k: "energy", h: "Energy $", f: (u) => fmt$0(u.energy), tip: "Two-settlement energy revenue: the day-ahead award at the day-ahead node price plus output less the award at the real-time node price." },
  { k: "as", h: "DAM AS $", f: (u) => fmt$0(u.as), tip: "Day-ahead AS awards at the day-ahead clearing price. Real-time AS is left out." },
  { k: "dis_p", h: "Discharged at", f: (u) => fmt$(u.dis_p), tip: "Average real-time node price of what it discharged, $/MWh." },
  { k: "chg_p", h: "Charged at", f: (u) => fmt$(u.chg_p), tip: "Average real-time node price of what it charged, $/MWh." },
  { k: "spread", h: "Spread", f: (u) => fmt$(u.spread), tip: "Discharged at less charged at, $/MWh, before losses." },
  { k: "days", h: "Days", f: (u) => fmt0(u.days), tip: "Days in the period the battery was priced against the perfect battery." },
  { k: "qse", h: "QSE", t: 1, f: (u) => (u.qse_name ? `<span title="${esc(u.qse_code || "")}">${esc(u.qse_name)}</span>` : esc(u.qse_code || "–")) },
  { k: "zone", h: "Zone", t: 1, f: (u) => esc(u.zone || "–") },
  { k: "sp", h: "Settlement point", t: 1, f: (u) => esc(u.sp || "–") },
];

// one row per battery over the chosen period, from the raw per-day arrays
function build(B, U, idx) {
  const dates = B.dates;
  const end = dates.length - 1, start = S.win === "all" ? Math.max(0, dates.indexOf(dates.find((d) => d >= window.CX.SITE_START))) : Math.max(0, end - +S.win + 1);
  const ui = U ? new Map(U.dates.map((d, i) => [d, i])) : new Map();
  const out = [];
  Object.entries(B.units).forEach(([name, d]) => {
    const get = (k) => d[k] || [];
    const perfect = get("perfect"), actual = get("actual");
    const sum = { actual: 0, dam_as: 0, perfect: 0, dis_mwh: 0, dis_usd: 0, chg_mwh: 0, chg_usd: 0 }, mwh = [];
    let days = 0, mw = null;
    for (let i = start; i <= end; i++) {
      if (perfect[i] == null || actual[i] == null) continue;
      days++;
      Object.keys(sum).forEach((k) => { sum[k] += get(k)[i] || 0; });
      if (get("mwh")[i] != null) mwh.push(get("mwh")[i]);
      const j = ui.get(dates[i]), h = j == null || !U.units[name] ? null : U.units[name].hsl?.[j];
      if (h != null && (mw == null || h > mw)) mw = h;
    }
    if (days < MIN_DAYS) return;
    const m = d3.median(mwh) || null, rev = Math.max(sum.actual, 0) + sum.dam_as, cyc = m ? sum.dis_mwh / m / days : null;
    const ix = idx.get(name) || {};
    const dis_p = sum.dis_mwh ? sum.dis_usd / sum.dis_mwh : null, chg_p = sum.chg_mwh ? sum.chg_usd / sum.chg_mwh : null;
    const as_share = rev > 0 ? sum.dam_as / rev : null;
    out.push({
      name, qse_name: ix.qse_name || null, qse_code: ix.qse || null, qse: ix.qse_name || ix.qse || null, zone: ix.zone || null, sp: ix.sp || null,
      mw, mwh: m, dur: m && mw ? m / mw : null, energy: sum.actual, as: sum.dam_as,
      kwm: mw ? (sum.actual + sum.dam_as) / (mw * 1000) / (days / 30.4) : null, as_share,
      perf: sum.perfect > 0 ? sum.actual / sum.perfect : null, cyc, dis_p, chg_p, spread: dis_p != null && chg_p != null ? dis_p - chg_p : null, days,
      cat: cyc != null && cyc < IDLE_CYCLES ? "idle" : as_share == null || as_share < 0.25 ? "arb" : as_share <= 0.5 ? "mixed" : "as",
    });
  });
  return { rows: out, from: dates[start], to: dates[end] };
}

function draw() {
  const el = $("bu-table");
  if (!S.data) return;
  const T = build(S.data.B, S.data.U, S.data.idx), q = S.q;
  const all = T.rows, rs = all.filter((u) => (S.cat === "all" || u.cat === S.cat)
    && (!q || [u.name, u.qse_name, u.qse_code, u.zone, u.sp].some((s) => (s || "").toLowerCase().includes(q))));
  const n = (c) => all.filter((u) => u.cat === c).length;
  $("bu-note").textContent = `${rs.length} of ${all.length} batteries · ${T.from} to ${T.to}`;
  $("bu-sum").textContent = all.length ? `Over ${T.from} to ${T.to}, ${n("arb")} batteries earned mostly from energy arbitrage, ${n("mixed")} from a mix, ${n("as")} mostly from day-ahead ancillary services, and ${n("idle")} barely cycled. ` +
    `The median battery earned ${pct(d3.median(all, (u) => u.perf))} of what a perfect battery would have on energy and ${fmt$(d3.median(all, (u) => u.kwm))}/kW-month in all.` : "";
  if (!rs.length) return emptyMsg(el, all.length ? "No battery matches." : "No batteries priced in this period.");
  const key = (u) => (S.sort === "cat" ? CAT_ORDER[u.cat] * 1e6 - (u.kwm || 0) : u[S.sort]);
  rs.sort((a, b) => { const x = key(a), y = key(b); if (x == null) return 1; if (y == null) return -1; return (typeof x === "string" ? x.localeCompare(y) : x - y) * S.dir; });
  el.innerHTML = `<table class="data"><thead><tr>${COLS.map((c) => `<th class="sortable${c.t ? " t" : ""}" data-k="${c.k}"${c.tip ? ` title="${esc(c.tip)}"` : ""}>${c.h}${S.sort === c.k ? (S.dir < 0 ? " ▾" : " ▴") : ""}</th>`).join("")}</tr></thead><tbody>` +
    rs.map((u) => `<tr data-unit="${esc(u.name)}" style="cursor:pointer">${COLS.map((c) => `<td${c.t ? ' class="t"' : ""}>${c.f(u)}</td>`).join("")}</tr>`).join("") + "</tbody></table>";
  el.querySelectorAll("th[data-k]").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.k; if (S.sort === k) S.dir = -S.dir; else { S.sort = k; S.dir = TEXT_KEYS.includes(k) ? 1 : -1; }
    draw(); saveView();
  }));
  el.querySelectorAll("tr[data-unit]").forEach((tr) => tr.addEventListener("click", (ev) => { if (!ev.target.closest("a")) location.href = `unit.html?unit=${encodeURIComponent(tr.dataset.unit)}`; }));
  const r = (v, p = 2) => (v == null ? null : +v.toFixed(p));
  setCSV(el, ["unit", "qse", "qse_code", "zone", "settlement_point", "mw", "mwh", "hours", "category", "energy_usd", "dam_as_usd", "usd_per_kw_month", "as_share", "share_of_perfect", "cycles_per_day", "discharged_at", "charged_at", "spread", "days", "from", "to"],
    rs.map((u) => [u.name, u.qse_name, u.qse_code, u.zone, u.sp, u.mw, r(u.mwh, 1), r(u.dur), CATS[u.cat].label, Math.round(u.energy), Math.round(u.as), r(u.kwm), r(u.as_share, 3), r(u.perf, 3), r(u.cyc, 3), r(u.dis_p), r(u.chg_p), r(u.spread), u.days, T.from, T.to]), "Battery units");
}

async function load() {
  if (S.loading) return S.loading;
  emptyMsg($("bu-table"), "Loading batteries…");
  S.loading = (async () => {
    const [B, U, I] = await Promise.all([tryJSON("data/storage/bench_units.json.gz"), tryJSON("data/storage/units.json.gz"), unitIndex()]);
    if (!B || !B.dates || !B.dates.length) return emptyMsg($("bu-table"), "No battery benchmark yet. It is built by the data update workflow.");
    S.data = { B, U, idx: new Map((I || []).filter((u) => u.tech === "storage").map((u) => [u.unit, u])) };
    draw();
  })();
  return S.loading;
}

function init() {
  if (!$("bu-panel")) return;
  loadView();
  setSeg("bu-win", S.win); setSeg("bu-cat", S.cat);
  bindSeg("bu-win", "win", draw); bindSeg("bu-cat", "cat", draw);
  $("bu-legend").innerHTML = Object.values(CATS).map((c) => `<span title="${esc(c.tip)}"><span class="sw" style="background:var(${c.color})"></span>${c.label}</span>`).join("");
  $("bu-search").addEventListener("input", (e) => { S.q = e.target.value.trim().toLowerCase(); draw(); });
  // a link straight to the table loads it at once; otherwise when it scrolls near
  if (location.hash.includes("bu-panel") || !("IntersectionObserver" in window)) { load(); return; }
  const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); load(); } }, { rootMargin: "600px" });
  io.observe($("bu-panel"));
}
init();
})();

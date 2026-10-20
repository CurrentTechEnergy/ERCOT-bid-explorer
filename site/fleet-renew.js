/* Fleet economics, wind and solar: revenue by month and realised $/MWh by unit (curtailment itself is on Renewables),
   moved from the Renewables page. Reads data/econ/wind and solar (pipeline/econ.py) and
   data/curtail_nodes.json.gz (curtailed energy, its worth at the node and each unit's curtailed
   share). fleet.js owns the status line and CX.init; this file keeps its own keys in the address
   bar. */
(() => {
"use strict";
const TECHS = [
  { id: "wind", keys: ["wind"], label: "Wind", color: "--c3" },
  { id: "solar", keys: ["solar"], label: "Solar", color: "--c4" },
];
const techLabel = (t) => TECHS.find((x) => x.id === t)?.label || t;
const S = { N: null, E: {}, ecoTech: "all", ecoSort: "pmwh", ecoDir: -1, ecoAll: false };
const { tryJSON, showTip, hideTip, setCSV, tickFormat, axisFmt, css, esc } = window.CX;
const $ = (id) => document.getElementById(id);
const fmtPct = d3.format(".0%");
const fmtPrice = (v) => (v == null || isNaN(v) ? "–" : d3.format("$,.2f")(v));
const fmtPrice0 = (v) => d3.format("$,.0f")(v);
function setSeg(id, value) { $(id).querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === value))); }
function emptyMsg(el, msg) { el.innerHTML = `<p class="empty">${msg}</p>`; }

// Energy revenue as on Plant economics' default: two-settlement (the DA award at the DA price plus
// the real-time deviation) where the unit has DA data, real-time at its node otherwise, and system
// lambda where the node price is missing; plus ancillary services.
function dayRevenue(u, i) {
  const two = u.rev_da[i] != null && u.rev_rt[i] != null && u.rev_da_rt[i] != null ? u.rev_da[i] + u.rev_rt[i] - u.rev_da_rt[i] : null;
  const e = two != null ? two : u.rev_rt[i] != null ? u.rev_rt[i] : u.rev_lam[i];
  return e == null ? null : e + (u.rev_as[i] || 0);
}
let ECO = null;
function computeEco() {
  // curtailed share of available energy (HSL), exact per unit from curtail_nodes
  const units = [], months = new Map(), cs = new Map((S.N?.units || []).map((r) => [r[0], r[7] ? r[3] / r[7] : null]));
  ["wind", "solar"].forEach((t) => {
    const E = S.E[t];
    if (!E) return;
    Object.entries(E.units).forEach(([name, u]) => {
      let rev = 0, mwh = 0, days = 0;
      E.dates.forEach((d, i) => {
        const r = dayRevenue(u, i), q = u.mwh[i];
        if (r == null || q == null) return;
        rev += r; mwh += q; days++;
        const mo = d.slice(0, 7), k = `${mo}|${t}`, m = months.get(k) || { mo, t, rev: 0, mwh: 0 };
        m.rev += r; m.mwh += q; months.set(k, m);
      });
      if (mwh > 0) units.push({ name, tech: t, sp: u.sp, hsl: u.hsl, rev, mwh, pmwh: rev / mwh, cf: u.hsl ? mwh / (u.hsl * 24 * days) : null, curt: cs.get(name) ?? null, days });
    });
  });
  ECO = { units, months: [...months.values()] };
}
function drawEcoMonths() {
  const el = $("eco-months");
  if (!ECO.months.length) return emptyMsg(el, "No economics data yet.");
  const mos = [...new Set(ECO.months.map((m) => m.mo))].sort();
  const get = (mo, t) => ECO.months.find((m) => m.mo === mo && m.t === t) || { rev: 0, mwh: 0 };
  const w = Math.max(280, el.clientWidth || 600), H = 240, m = { t: 18, r: 16, b: 26, l: 64 };
  const x = d3.scaleBand().domain(mos).range([m.l, w - m.r]).paddingInner(0.2);
  const y = d3.scaleLinear().domain([0, d3.max(mos, (mo) => get(mo, "wind").rev + get(mo, "solar").rev) / 1e6 || 1]).nice().range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y), 5, "$").tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickFormat((mo) => d3.timeFormat(w < 560 ? "%b" : "%b %y")(new Date(mo + "-15T12:00:00"))).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text("Revenue by month ($ million)");
  mos.forEach((mo) => {
    let acc = 0;
    TECHS.forEach((t) => { const v = get(mo, t.id).rev / 1e6; if (v > 0) svg.append("rect").attr("x", x(mo)).attr("width", x.bandwidth()).attr("y", y(acc + v)).attr("height", Math.max(0, y(acc) - y(acc + v) - 1)).attr("fill", css(t.color)); acc += v; });
    svg.append("rect").attr("x", x(mo)).attr("width", x.bandwidth()).attr("y", m.t).attr("height", H - m.t - m.b).attr("fill", "transparent")
      .on("pointermove", (ev) => showTip(ev, `<h4>${d3.timeFormat("%B %Y")(new Date(mo + "-15T12:00:00"))}</h4><table><tr><td></td><td></td><td class="n">Revenue</td><td class="n">$/MWh</td></tr>` +
        TECHS.map((t) => { const g = get(mo, t.id); return `<tr><td><span class="sw" style="background:var(${t.color})"></span></td><td>${t.label}</td><td class="n">$${d3.format(",.1f")(g.rev / 1e6)}M</td><td class="n">${g.mwh ? fmtPrice(g.rev / g.mwh) : "–"}</td></tr>`; }).join("") + "</table>"))
      .on("pointerleave", hideTip);
  });
  el.replaceChildren(svg.node());
  setCSV(el, ["month", "wind_revenue", "wind_mwh", "solar_revenue", "solar_mwh"],
    mos.map((mo) => [mo, get(mo, "wind").rev, get(mo, "wind").mwh, get(mo, "solar").rev, get(mo, "solar").mwh]), "Wind and solar revenue by month");
}
const ECO_COLS = [
  { k: "rank", h: "#", f: (u, i) => i + 1 },
  { k: "name", h: "Unit", t: 1, f: (u) => `<a href="unit.html?unit=${encodeURIComponent(u.name)}">${esc(u.name)}</a>` },
  { k: "tech", h: "Tech", t: 1, f: (u) => techLabel(u.tech) },
  { k: "sp", h: "Settlement point", t: 1, f: (u) => esc(u.sp || "–") },
  { k: "pmwh", h: "Realised $/MWh", f: (u) => fmtPrice(u.pmwh) },
  { k: "mwh", h: "GWh", f: (u) => d3.format(",.1f")(u.mwh / 1000) },
  { k: "rev", h: "Revenue", f: (u) => "$" + d3.format(",.2f")(u.rev / 1e6) + "M" },
  { k: "cf", h: "Capacity factor", f: (u) => (u.cf == null ? "–" : fmtPct(u.cf)) },
  { k: "curt", h: "Curtailed share", f: (u) => (u.curt == null ? "–" : d3.format(".1%")(u.curt)) },
];
function drawEcoUnits() {
  const el = $("eco-table"), hel = $("eco-hist");
  // units with under 1 GWh over the loaded days (new, retired or barely running) price a handful of
  // hours and would crowd both ends of the ranking
  const all = ECO.units.filter((u) => S.ecoTech === "all" || u.tech === S.ecoTech);
  let us = all.filter((u) => u.mwh >= 1000);
  const E0 = S.E.wind || S.E.solar;
  $("eco-note").textContent = E0 ? `${E0.dates[0]} to ${E0.dates.at(-1)} (every loaded 60-day day), ${us.length} units` + (all.length > us.length ? `, leaving out ${all.length - us.length} with under 1 GWh` : "") : "";
  if (!us.length) { emptyMsg(el, "No units."); hel.innerHTML = ""; return; }
  // distribution: units by realised $/MWh, wind and solar side by side
  const vals = us.map((u) => u.pmwh), lo = Math.floor(d3.quantile([...vals].sort(d3.ascending), 0.005) / 2) * 2, hi = Math.ceil(d3.quantile([...vals].sort(d3.ascending), 0.995) / 2) * 2;
  const bin = d3.bin().domain([lo, hi]).thresholds(d3.range(lo, hi + 0.001, Math.max(1, Math.round((hi - lo) / 30))));
  const w = Math.max(280, hel.clientWidth || 600), H = 220, m = { t: 18, r: 16, b: 34, l: 48 };
  const groups = TECHS.filter((t) => S.ecoTech === "all" || t.id === S.ecoTech).map((t) => ({ t, b: bin(us.filter((u) => u.tech === t.id).map((u) => Math.max(lo, Math.min(hi - 1e-9, u.pmwh)))) }));
  const x = d3.scaleLinear().domain([lo, hi]).range([m.l, w - m.r]);
  const y = d3.scaleLinear().domain([0, d3.max(groups, (g) => d3.max(g.b, (b) => b.length)) || 1]).nice().range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickFormat(d3.format(",d")).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(axisFmt(d3.axisBottom(x), w < 560 ? 5 : 10, "$").tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text("Units by realised revenue per MWh");
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", H - 2).attr("text-anchor", "end").text("$/MWh over the loaded days");
  groups.forEach((g, j) => g.b.forEach((b) => {
    const bw = (x(b.x1) - x(b.x0)) / groups.length;
    if (b.length) svg.append("rect").attr("x", x(b.x0) + j * bw).attr("width", Math.max(1, bw - 1)).attr("y", y(b.length)).attr("height", y(0) - y(b.length)).attr("fill", css(g.t.color));
  }));
  groups.forEach((g) => { const md = d3.median(us.filter((u) => u.tech === g.t.id), (u) => u.pmwh); if (md == null) return;
    svg.append("line").attr("x1", x(md)).attr("x2", x(md)).attr("y1", m.t).attr("y2", H - m.b).attr("stroke", css(g.t.color)).attr("stroke-dasharray", "4 3").attr("stroke-width", 1.5);
  });
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const v = x.invert(d3.pointer(ev)[0]);
      showTip(ev, `<table>` + groups.map((g) => { const b = g.b.find((b) => v >= b.x0 && v < b.x1); return b ? `<tr><td><span class="sw" style="background:var(${g.t.color})"></span></td><td>${g.t.label}, ${fmtPrice0(b.x0)} to ${fmtPrice0(b.x1)}</td><td class="n">${b.length} units</td></tr>` : ""; }).join("") +
        groups.map((g) => `<tr><td></td><td>${g.t.label} median</td><td class="n">${fmtPrice(d3.median(us.filter((u) => u.tech === g.t.id), (u) => u.pmwh))}</td></tr>`).join("") + "</table>");
    })
    .on("pointerleave", hideTip);
  hel.replaceChildren(svg.node());
  setCSV(hel, ["unit", "tech", "realised_usd_per_mwh"], us.map((u) => [u.name, u.tech, u.pmwh]), "Realised $/MWh distribution");
  // ranked table
  const k = S.ecoSort === "rank" ? "pmwh" : S.ecoSort;
  us = [...us].sort((a, b) => { const p = a[k], q = b[k]; if (p == null) return 1; if (q == null) return -1; return (typeof p === "string" ? p.localeCompare(q) : p - q) * S.ecoDir; });
  const shown = S.ecoAll ? us : us.slice(0, 50);
  el.innerHTML = `<table class="data"><thead><tr>${ECO_COLS.map((c) => `<th class="sortable${c.t ? " t" : ""}" data-k="${c.k}">${c.h}${S.ecoSort === c.k ? (S.ecoDir < 0 ? " ▾" : " ▴") : ""}</th>`).join("")}</tr></thead><tbody>` +
    shown.map((u, i) => `<tr>${ECO_COLS.map((c) => `<td${c.t ? ' class="t"' : ""}>${c.f(u, i)}</td>`).join("")}</tr>`).join("") + "</tbody></table>";
  $("eco-more").hidden = S.ecoAll || us.length <= 50;
  $("eco-more").textContent = `Show all ${us.length}`;
  el.querySelectorAll("th[data-k]").forEach((th) => th.addEventListener("click", () => {
    const kk = th.dataset.k; if (S.ecoSort === kk) S.ecoDir = -S.ecoDir; else { S.ecoSort = kk; S.ecoDir = ["name", "tech", "sp"].includes(kk) ? 1 : -1; }
    drawEcoUnits(); saveView();
  }));
  setCSV(el, ["unit", "tech", "settlement_point", "realised_usd_per_mwh", "mwh", "revenue", "capacity_factor", "curtailed_share", "days"], us.map((u) => [u.name, u.tech, u.sp, u.pmwh, u.mwh, u.rev, u.cf, u.curt, u.days]), "Wind and solar realised revenue");
}

// ---- links and boot --------------------------------------------------------------------
const VIEW_KEYS = { et: "ecoTech", es: "ecoSort" };
function saveView() { window.CX.writeHash({ ...window.CX.readHash(), ...Object.fromEntries(Object.entries(VIEW_KEYS).map(([k, sk]) => [k, S[sk]])), ed: S.ecoDir < 0 ? null : 1 }); }
function loadView() { const v = window.CX.readHash(); Object.entries(VIEW_KEYS).forEach(([k, sk]) => { if (v[k] != null) S[sk] = v[k]; }); if (v.ed === "1") S.ecoDir = 1; }
function drawAll() { if (ECO) { drawEcoMonths(); drawEcoUnits(); } }

async function boot() {
  loadView();
  setSeg("eco-tech", S.ecoTech);
  $("eco-tech").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; S.ecoTech = b.dataset.v; setSeg("eco-tech", S.ecoTech); drawEcoUnits(); saveView(); });
  $("eco-more").onclick = () => { S.ecoAll = true; drawEcoUnits(); };
  [S.N, S.E.wind, S.E.solar] = await Promise.all([tryJSON("data/curtail_nodes.json.gz"), tryJSON("data/econ/wind.json.gz"), tryJSON("data/econ/solar.json.gz")]);
  computeEco(); drawAll();
  let t, lastW = 0;
  new ResizeObserver((e) => { const w = Math.round(e[0].contentRect.width); if (w === lastW) return; lastW = w; clearTimeout(t); t = setTimeout(drawAll, 120); }).observe($("eco-panel"));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", drawAll);
}
boot();
})();

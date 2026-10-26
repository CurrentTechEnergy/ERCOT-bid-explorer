/* Day-ahead offers: what thermal units ask the DAM for in their three-part offers and whether it
   keeps them on through cheap hours, with the wind and solar units' day-ahead floors.  Reads
   data/dam_offers.json.gz (pipeline/dam_offers.py): one fleet value per day, award rate by
   cheap-stretch margin, the trains and wind/solar tables, and the offer change events.  Each unit's
   own history is on its Unit page (unit-dam.js). */
(() => {
"use strict";

const { tryJSON, showTip, hideTip, setCSV, css, esc, axisFmt } = window.CX;
const $ = (id) => document.getElementById(id);
const fmt0 = d3.format(",.0f"), fmtPct = d3.format(".0%");
const fmt$ = (v) => (v == null || isNaN(v) ? "–" : (v < 0 ? "−" : "") + "$" + d3.format(",.2f")(Math.abs(v)));
const fmt$s = (v) => (v == null || isNaN(v) ? "–" : (v < 0 ? "−" : "") + "$" + d3.format(",")(Math.abs(v)));
const parseDate = (d) => new Date(d + "T12:00:00");
const fmtDate = d3.timeFormat("%a %b %-d, %Y");
const unitURL = (name) => `unit.html?unit=${encodeURIComponent(name)}`;
const TECH = { combined_cycle: "Combined cycle", gas_steam: "Gas steam", combustion_turbine: "Combustion turbine", wind: "Wind", solar: "Solar" };
const S = { D: null, sort: { trains: [3, -1], renew: [5, -1] } };

function emptyMsg(el, msg) { el.innerHTML = `<p class="empty">${msg}</p>`; }
function staticLegend(el, list) {
  el.innerHTML = list.map((s) => `<span>${s.line ? `<span class="sw-line" style="border-top:2px ${s.dash ? "dashed" : "solid"} var(${s.color})"></span>`
    : s.dot ? `<span class="sw" style="background:var(${s.color});border-radius:50%;width:8px;height:8px"></span>`
    : `<span class="sw" style="background:var(${s.color})"></span>`}${s.label}</span>`).join("");
}
const med = (a) => { const v = a.filter((x) => x != null); return v.length ? d3.median(v) : null; };

// ---- summary --------------------------------------------------------------------------
function drawKPIs() {
  const D = S.D, F = D.fleet, ci = D.cheap.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
  const major = D.events.filter((e) => e.major).length;
  const months = Math.max(1, d3.timeMonth.count(parseDate(D.first), parseDate(D.last)));
  const k = [
    [`${fmt0(med(ci.map((i) => F.trains_aw[i])))} of ${fmt0(med(ci.map((i) => F.trains_filed[i])))}`, "combined cycle trains kept on through the cheap stretch on a median cheap day"],
    [fmtPct(med(F.below_mw_share)), "of three-part CC and gas steam minimum output offered below its fuel cost on a median day"],
    [`${fmt$(med(F.mk_aw))} / ${fmt$(med(F.mk_no))}`, "median CC train offer minus fuel cost on cheap days ($/MWh), kept on / left out"],
    [fmt0(major), `major offer changes in ${months} months (${fmt0(D.events.length)} in all)`],
  ];
  $("kpis").innerHTML = k.map(([v, t]) => `<div class="kpi"><span class="v">${v}</span><span class="k">${t}</span></div>`).join("");
}

// ---- lead: trains by lowest offer on each cheap day ---------------------------------------
function drawLead() {
  const D = S.D, F = D.fleet, el = $("lead-chart");
  const rows = D.cheap.map((c, i) => (c && F.trains_filed[i] ? i : -1)).filter((i) => i >= 0).map((i) => {
    const n = F.trains_filed[i], z = F.trains_zero[i], h = F.trains_high[i];
    return { i, d: parseDate(D.dates[i]), n, z, m: n - z - h, h, aw: F.trains_aw[i] };
  });
  const p = D.params || {}, lo = p.zero_usd ?? 1, hi = p.high_usd ?? 20;
  $("lead-note").textContent = `Combined cycle trains with a three-part offer on each day with cheap hours, placed by their lowest minimum-energy offer across configurations over the cheap hours. ` +
    `The dots count trains the DAM kept on through the cheap stretch. Gaps are days with no cheap hours (${D.cheap.filter((c) => !c).length} of ${D.dates.length}), not missing data.`;
  const series = [{ k: "z", color: "--c3", label: `Lowest offer ${fmt$s(lo)} or less` }, { k: "m", color: "--c-other", label: `${fmt$s(lo)} to ${fmt$s(hi)}` }, { k: "h", color: "--c2", label: `${fmt$s(hi)} or more` }];
  staticLegend($("lead-legend"), [...series, { color: "--ink", label: "Kept on through the stretch", dot: true }]);
  if (!rows.length) return emptyMsg(el, "No cheap days loaded.");
  const w = Math.max(280, el.clientWidth || 600), H = 300, m = { t: 18, r: 14, b: 28, l: 44 };
  const x = d3.scaleTime().domain(d3.extent(D.dates, parseDate)).range([m.l, w - m.r]);
  const y = d3.scaleLinear().domain([0, d3.max(rows, (r) => r.n)]).nice().range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(w < 560 ? 4 : 9).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text("Trains");
  const bw = Math.max(1.5, (w - m.l - m.r) / D.dates.length * 0.8);
  let base = rows.map(() => 0);
  series.forEach((s) => {
    svg.append("g").selectAll("rect").data(rows).join("rect").attr("x", (r) => x(r.d) - bw / 2).attr("width", bw)
      .attr("y", (r, j) => y(base[j] + r[s.k])).attr("height", (r, j) => Math.max(0, y(base[j]) - y(base[j] + r[s.k]))).attr("fill", css(s.color));
    base = base.map((b, j) => b + rows[j][s.k]);
  });
  svg.append("g").selectAll("circle").data(rows).join("circle").attr("cx", (r) => x(r.d)).attr("cy", (r) => y(r.aw)).attr("r", 2).attr("fill", css("--ink"));
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", H - m.b).style("display", "none");
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const t = x.invert(d3.pointer(ev)[0]), r = rows[d3.minIndex(rows, (q) => Math.abs(q.d - t))];
      cross.style("display", null).attr("x1", x(r.d)).attr("x2", x(r.d));
      showTip(ev, `<h4>${fmtDate(r.d)}</h4><table>${series.map((s) => `<tr><td><span class="sw" style="background:var(${s.color})"></span></td><td>${s.label}</td><td class="n">${r[s.k]}</td></tr>`).join("")}` +
        `<tr><td></td><td>Trains filing</td><td class="n">${r.n}</td></tr><tr><td></td><td>Kept on through the stretch</td><td class="n">${r.aw}</td></tr></table>`);
    })
    .on("pointerleave", () => { cross.style("display", "none"); hideTip(); });
  el.replaceChildren(svg.node());
  setCSV(el, ["date", "trains_filing", "lowest_offer_low", "lowest_offer_mid", "lowest_offer_high", "kept_on"], rows.map((r) => [D.dates[r.i], r.n, r.z, r.m, r.h, r.aw]), "Trains by lowest offer on cheap days");
}

// ---- award rate by offer minus node price ------------------------------------------------
function drawBins() {
  const B = S.D.bins, el = $("bins-chart"), e = B.edges;
  // bins come by margin (node less offer); shown as offer less node, so reversed
  const lab = [`< −$${-e[0]}`, ...e.slice(0, -1).map((a, k) => `${fmt$s(a)} to ${fmt$s(e[k + 1])}`), `≥ $${e.at(-1)}`];
  const rows = B.n.map((n, k) => ({ n, aw: B.aw[k] })).reverse().map((r, k) => ({ ...r, lab: lab[k], r: r.n ? r.aw / r.n : null }));
  const w = Math.max(280, el.clientWidth || 500), H = 280, m = { t: 22, r: 10, b: 64, l: 44 };
  const x = d3.scaleBand().domain(rows.map((r) => r.lab)).range([m.l, w - m.r]).padding(0.18);
  const y = d3.scaleLinear().domain([0, 1]).range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickFormat(fmtPct).tickSizeOuter(0));
  const ax = svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickSizeOuter(0));
  ax.selectAll("text").attr("transform", "rotate(-30)").attr("text-anchor", "end").attr("dx", "-0.4em").attr("dy", "0.5em");
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text("Kept on through the cheap stretch");
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", H - 2).attr("text-anchor", "end").text("Offer minus node price, $/MWh");
  const half = rows.length / 2;
  svg.append("g").selectAll("rect").data(rows).join("rect").attr("x", (r) => x(r.lab)).attr("width", x.bandwidth())
    .attr("y", (r) => y(r.r || 0)).attr("height", (r) => y(0) - y(r.r || 0)).attr("fill", (r, k) => css(k < half ? "--c3" : "--c2"))
    .on("pointermove", (ev, r) => showTip(ev, `<h4>Offer minus node price ${r.lab}</h4><p class="tip-body">${fmtPct(r.r || 0)} kept on, ${fmt0(r.aw)} of ${fmt0(r.n)} configuration-days</p>`))
    .on("pointerleave", hideTip);
  svg.append("g").selectAll("text.v").data(rows).join("text").attr("class", "dlabel").attr("x", (r) => x(r.lab) + x.bandwidth() / 2).attr("y", (r) => y(r.r || 0) - 4)
    .attr("text-anchor", "middle").text((r) => (r.r == null ? "" : fmtPct(r.r)));
  el.replaceChildren(svg.node());
  setCSV(el, ["offer_minus_node", "config_days", "kept_on", "share"], rows.map((r) => [r.lab, r.n, r.aw, r.r]), "Kept on by offer minus node price");
}

// ---- offer minus fuel cost, kept on against left out ----------------------------------------
function drawMarkup() {
  const D = S.D, F = D.fleet, el = $("mk-chart");
  const sets = [{ k: "mk_aw", color: "--c3", label: "Trains kept on through the cheap stretch" }, { k: "mk_no", color: "--c2", label: "Trains left out" }];
  staticLegend($("mk-legend"), [...sets.map((s) => ({ ...s, line: true })), { color: "--ink-2", label: "Offer equals fuel cost", line: true, dash: true }]);
  const pts = sets.map((s) => D.dates.map((d, i) => [parseDate(d), F[s.k][i]]).filter((p) => p[1] != null));
  if (!pts.some((p) => p.length)) return emptyMsg(el, "No cheap days loaded.");
  const w = Math.max(280, el.clientWidth || 500), H = 280, m = { t: 22, r: 12, b: 28, l: 56 };
  const x = d3.scaleTime().domain(d3.extent(D.dates, parseDate)).range([m.l, w - m.r]);
  const y = d3.scaleLinear().domain(d3.extent([0, ...pts.flat().map((p) => p[1])])).nice().range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y), 5, "$").tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(w < 560 ? 4 : 7).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text("Offer minus fuel cost, $/MWh");
  svg.append("line").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(0)).attr("y2", y(0)).attr("stroke", css("--ink-2")).attr("stroke-dasharray", "4 3");
  const line = d3.line().x((p) => x(p[0])).y((p) => y(p[1]));
  sets.forEach((s, j) => svg.append("path").attr("d", line(pts[j])).attr("fill", "none").attr("stroke", css(s.color)).attr("stroke-width", 1.6));
  const days = D.cheap.map((c, i) => (c && (F.mk_aw[i] != null || F.mk_no[i] != null) ? i : -1)).filter((i) => i >= 0);
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", H - m.b).style("display", "none");
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const t = x.invert(d3.pointer(ev)[0]), i = days[d3.minIndex(days, (q) => Math.abs(parseDate(D.dates[q]) - t))];
      cross.style("display", null).attr("x1", x(parseDate(D.dates[i]))).attr("x2", x(parseDate(D.dates[i])));
      showTip(ev, `<h4>${fmtDate(parseDate(D.dates[i]))}</h4><table>${sets.map((s) => `<tr><td><span class="sw" style="background:var(${s.color})"></span></td><td>${s.label}</td><td class="n">${fmt$(F[s.k][i])}</td></tr>`).join("")}</table>`);
    })
    .on("pointerleave", () => { cross.style("display", "none"); hideTip(); });
  el.replaceChildren(svg.node());
  setCSV(el, ["date", "kept_on", "left_out"], days.map((i) => [D.dates[i], F.mk_aw[i], F.mk_no[i]]), "Offer minus fuel cost by train");
}

// ---- tables ---------------------------------------------------------------------------------
function sortableTable(el, key, cols, rows, csvName) {
  const [k, dir] = S.sort[key];
  const val = (r) => r[cols[k].i];
  const sorted = rows.slice().sort((a, b) => {
    const va = val(a), vb = val(b);
    if (va == null) return 1;
    if (vb == null) return -1;
    return (va > vb ? 1 : va < vb ? -1 : 0) * dir;
  });
  el.innerHTML = `<table class="data"><thead><tr>${cols.map((c, j) => `<th class="sortable${c.t ? " t" : ""}${c.tip ? " has-tip" : ""}" data-j="${j}" scope="col"${c.tip ? ` title="${esc(c.tip)}"` : ""}>${c.h}${j === k ? (dir < 0 ? " ↓" : " ↑") : ""}</th>`).join("")}</tr></thead>` +
    `<tbody>${sorted.map((r) => `<tr>${cols.map((c) => `<td${c.t ? ' class="t"' : ""}>${c.f(r[c.i], r)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  el.querySelectorAll("th").forEach((th) => th.addEventListener("click", () => {
    const j = +th.dataset.j;
    S.sort[key] = [j, j === k ? -dir : cols[j].t ? 1 : -1];
    sortableTable(el, key, cols, rows, csvName);
  }));
  setCSV(el, cols.map((c) => c.csv), sorted.map((r) => cols.map((c) => r[c.i])), csvName);
}
function drawTrains() {
  const D = S.D, rep = new Set(D.repricers || []), c = Object.fromEntries(D.train_cols.map((k, i) => [k, i]));
  const bar = (v) => `<span class="bar-cell" style="width:${Math.round((v || 0) * 56)}px;margin:0 6px 0 0"></span>${v == null ? "–" : fmtPct(v)}`;
  const cols = [
    { h: "Train or plant", i: c.plant, t: true, csv: "train_or_plant", f: (v, r) => `<a class="u" href="${unitURL(r[c.unit] || v)}">${esc(v)}</a>${rep.has(v) ? '<span class="tag" title="Ten or more minimum-energy steps in a year">re-prices often</span>' : ""}` },
    { h: "Tech", i: c.tech, t: true, csv: "tech", f: (v) => (v === "combined_cycle" ? "CC" : TECH[v] || v) },
    { h: "Cheap days filed", i: c.cheap_days_filed, csv: "cheap_days_filed", f: fmt0 },
    { h: "Kept on", i: c.share_awarded, csv: "share_kept_on", tip: "Share of those cheap days the DAM kept it on through the cheap stretch", f: bar },
    { h: "Median lowest offer", i: c.median_lowest_offer, csv: "median_lowest_offer", tip: "Median over cheap days of its lowest configuration's cheap-hour minimum-energy offer, $/MWh", f: fmt$ },
    { h: "Implied heat rate", i: c.median_implied_hr, csv: "median_implied_heat_rate", tip: "That offer over the hub gas price, MMBtu/MWh", f: (v) => (v == null ? "–" : d3.format(".1f")(v)) },
    { h: "Price-outs", i: c.priced_out, csv: "price_outs", tip: "Short spells offered $10 or more above its usual level", f: fmt0 },
    { h: "Offer steps", i: c.steps, csv: "offer_steps", tip: "Minimum-energy offer moves of $5 or more that held", f: fmt0 },
  ];
  $("trains-note").textContent = `${D.trains.length} trains and plants`;
  sortableTable($("trains-table"), "trains", cols, D.trains, "Trains and plants");
}
function drawRenew() {
  const D = S.D, c = Object.fromEntries(D.renew_cols.map((k, i) => [k, i]));
  const rows = D.renew.filter((r) => r[c.days_filed] >= 20);
  const cols = [
    { h: "Unit", i: c.unit, t: true, csv: "unit", f: (v) => `<a class="u" href="${unitURL(v)}">${esc(v)}</a>` },
    { h: "Tech", i: c.tech, t: true, csv: "tech", f: (v) => TECH[v] || v },
    { h: "Days filed", i: c.days_filed, csv: "days_filed", f: fmt0 },
    { h: "DA floor", i: c.median_da_floor, csv: "median_da_floor", tip: "Median first price of its day-ahead curve, $/MWh", f: fmt$ },
    { h: "RT floor", i: c.median_rt_floor, csv: "median_rt_floor", tip: "Median real-time offer floor, $/MWh", f: fmt$ },
    { h: "DA − RT", i: c.median_gap, csv: "median_gap", tip: "Median of the day's DA floor less its RT floor, $/MWh", f: fmt$ },
    { h: "DA award share", i: c.median_award_share, csv: "median_award_share", tip: "Median day-ahead award over available energy (HSL), three-part offers only", f: (v) => (v == null ? "–" : fmtPct(v)) },
  ];
  sortableTable($("renew-table"), "renew", cols, rows, "Wind and solar day-ahead offers");
}

// ---- events ----------------------------------------------------------------------------------
function evText(e) {
  if (e.kind === "mingen_step") return `${fmt$(e.before)} to ${fmt$(e.after)}/MWh${e.mk_before != null && e.mk_after != null ? ` (${fmt$(e.mk_before)} to ${fmt$(e.mk_after)} against fuel cost)` : ""}`;
  if (e.kind === "priced_out") return `${fmt$(e.after)}/MWh against a usual ${fmt$(e.before)} for ${e.days} day${e.days === 1 ? "" : "s"}`;
  if (e.kind === "start_change") return `hot start ${fmt$(e.before)} to ${fmt$(e.after)}`;
  return "";
}
function drawEvents() {
  const D = S.D, major = D.events.filter((e) => e.major);
  $("events-note").textContent = `Minimum-energy steps that cross the fuel-cost line, price-outs on cheap days, and units that stop or start three-part offers: ${fmt0(major.length)} of ${fmt0(D.events.length)} offer changes. Click a unit for its Unit page.`;
  $("events-list").innerHTML = major.slice(0, 20).map((e) => {
    const cc = e.tech === "combined_cycle", us = e.units || [];
    const name = cc || us.length !== 1 ? e.plant : us[0], to = cc ? e.plant : us[0] || e.plant, t = evText(e);
    return `<li><span class="d">${e.date}</span><span><a class="u" href="${unitURL(to)}">${esc(name)}</a> · ${esc(D.kinds[e.kind])}${t ? `: ${esc(t)}` : ""}</span></li>`;
  }).join("") || `<li><span></span><span class="muted">No major changes.</span></li>`;
}

function drawAll() { if (!S.D) return; drawKPIs(); drawLead(); drawBins(); drawMarkup(); drawTrains(); drawRenew(); drawEvents(); }

async function boot() {
  S.D = await tryJSON("data/dam_offers.json.gz");
  const D = S.D;
  if (!D || !D.renew) { $("status").textContent = "Day-ahead offer data not loaded yet."; return; }
  const nCheap = D.cheap.filter(Boolean).length;
  $("status").textContent = `60-day DAM disclosure · ${D.first} to ${D.last} · ${nCheap} days with cheap hours`;
  document.querySelectorAll(".cheap-usd").forEach((s) => { s.textContent = D.cheap_usd; });
  const hr = D.ref.hr;
  $("ref-note").innerHTML = `Fuel-cost line: <a href="${esc(D.ref.url)}">${esc(D.ref.name)}</a>: combined cycle ${hr.combined_cycle}, steam ${hr.gas_steam} and gas turbine ${hr.combustion_turbine} MMBtu/MWh at full load, ` +
    `times the gas price at the unit's own hub (Waha or Houston Ship Channel) on the last trading day before the operating day. Units burn more per MWh at minimum load, so an offer below the line is below fuel cost with room to spare.`;
  drawAll();
  window.CX.init();
  let t, lastW = 0;
  new ResizeObserver((en) => { const w = Math.round(en[0].contentRect.width); if (w === lastW) return; lastW = w; clearTimeout(t); t = setTimeout(drawAll, 150); }).observe(document.querySelector("main"));
}
boot();
})();

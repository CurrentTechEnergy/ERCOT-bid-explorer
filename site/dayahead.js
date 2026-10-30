/* Day-ahead offers: what thermal units ask the DAM for in their three-part offers and whether it
   keeps them on through cheap hours, with the wind and solar units' day-ahead floors.  Reads
   data/dam_offers.json.gz (pipeline/dam_offers.py): one fleet value per day, award rate by
   cheap-stretch margin, the trains and wind/solar tables, and every offer change event.  Each unit's
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
const TECH = { combined_cycle: "Combined cycle", gas_steam: "Gas steam", combustion_turbine: "Combustion turbine and recip", wind: "Wind", solar: "Solar" };
const BF_MIN_DAYS = 10, BF_MOST = 0.75;   // trains filing on fewer cheap days are left off; "most days" is over 75%
const S = { D: null, G: null, sort: { trains: [3, -1], renew: [5, -1] } };

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
    [`${fmt$(med(F.mk_aw))} / ${fmt$(med(F.mk_no))}`, "median CC train offer minus fuel cost on cheap days ($/MWh), DAM award through the cheap hours / none"],
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

// ---- offer minus fuel cost, awarded against not: pooled over every cheap train-day -------------
function drawMarkup() {
  const D = S.D, Hm = D.mk_hist, el = $("mk-chart");
  const sets = [{ k: "aw", med: "med_aw", color: "--c3", label: "DAM award through the cheap hours" }, { k: "no", med: "med_no", color: "--c2", label: "No DAM award" }];
  if (!Hm || !Hm.edges) { $("mk-legend").innerHTML = ""; return emptyMsg(el, "The distribution appears after the next data update."); }
  const e = Hm.edges, nb = e.length - 1, tot = Object.fromEntries(sets.map((s) => [s.k, d3.sum(Hm[s.k])]));
  staticLegend($("mk-legend"), [...sets.map((s) => ({ ...s, label: `${s.label} (${fmt0(tot[s.k])} train-days, median ${fmt$s(Math.round(Hm[s.med]))})` })),
    { color: "--ink-2", label: "Offer equals fuel cost", line: true, dash: true }]);
  if (!tot.aw && !tot.no) return emptyMsg(el, "No cheap days loaded.");
  const share = (s, k) => (tot[s.k] ? Hm[s.k][k] / tot[s.k] : 0);
  const w = Math.max(280, el.clientWidth || 500), H = 280, m = { t: 22, r: 12, b: 40, l: 44 };
  const x = d3.scaleLinear().domain([e[0], e[nb]]).range([m.l, w - m.r]);
  const y = d3.scaleLinear().domain([0, d3.max(sets, (s) => d3.max(d3.range(nb), (k) => share(s, k))) * 1.06]).nice().range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickFormat(fmtPct).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(axisFmt(d3.axisBottom(x), w < 560 ? 5 : 8, "$").tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text("Share of train-days");
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", H - 4).attr("text-anchor", "end").text("Offer minus fuel cost, $/MWh");
  // a step outline per group, each bin at its share of that group's train-days
  const steps = (s) => d3.range(nb).flatMap((k) => [[e[k], share(s, k)], [e[k + 1], share(s, k)]]);
  sets.forEach((s) => {
    const pts = [[e[0], 0], ...steps(s), [e[nb], 0]];
    svg.append("path").attr("d", d3.area().x((p) => x(p[0])).y0(y(0)).y1((p) => y(p[1]))(pts)).attr("fill", css(s.color)).attr("fill-opacity", 0.18);
    svg.append("path").attr("d", d3.line().x((p) => x(p[0])).y((p) => y(p[1]))(pts)).attr("fill", "none").attr("stroke", css(s.color)).attr("stroke-width", 1.6);
    if (Hm[s.med] != null) svg.append("line").attr("x1", x(Hm[s.med])).attr("x2", x(Hm[s.med])).attr("y1", m.t).attr("y2", H - m.b)
      .attr("stroke", css(s.color)).attr("stroke-dasharray", "1 3").attr("stroke-width", 1.4);
  });
  svg.append("line").attr("x1", x(0)).attr("x2", x(0)).attr("y1", m.t).attr("y2", H - m.b).attr("stroke", css("--ink-2")).attr("stroke-dasharray", "4 3");
  const lab = (k) => (k === 0 ? `${fmt$s(e[1])} or less` : k === nb - 1 ? `${fmt$s(e[k])} or more` : `${fmt$s(e[k])} to ${fmt$s(e[k + 1])}`);
  const band = svg.append("rect").attr("y", m.t).attr("height", H - m.t - m.b).attr("fill", css("--ink-2")).attr("fill-opacity", 0.08).style("display", "none");
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const k = Math.min(nb - 1, Math.max(0, Math.floor((x.invert(d3.pointer(ev)[0]) - e[0]) / (e[1] - e[0]))));
      band.style("display", null).attr("x", x(e[k])).attr("width", x(e[k + 1]) - x(e[k]));
      showTip(ev, `<h4>Offer minus fuel cost ${lab(k)}</h4><table>${sets.map((s) => `<tr><td><span class="sw" style="background:var(${s.color})"></span></td><td>${s.label}</td>` +
        `<td class="n">${fmtPct(share(s, k))}</td><td class="n">${fmt0(Hm[s.k][k])}</td></tr>`).join("")}</table>`);
    })
    .on("pointerleave", () => { band.style("display", "none"); hideTip(); });
  el.replaceChildren(svg.node());
  setCSV(el, ["offer_minus_fuel_from", "offer_minus_fuel_to", "awarded_train_days", "not_awarded_train_days"],
    d3.range(nb).map((k) => [k === 0 ? null : e[k], k === nb - 1 ? null : e[k + 1], Hm.aw[k], Hm.no[k]]), "Offer minus fuel cost, awarded and not");
}

// ---- who offers below fuel cost, by the Commitment page's flexibility group ------------------------
function drawBelowFuel() {
  const D = S.D, G = S.G, el = $("bf-chart"), c = Object.fromEntries(D.train_cols.map((k, i) => [k, i]));
  if (c.share_below_fuel == null) { $("bf-legend").innerHTML = ""; return emptyMsg(el, "This chart appears after the next data update."); }
  if (!G || !G.units) { $("bf-legend").innerHTML = ""; return emptyMsg(el, "Flexibility groups not loaded."); }
  const label = Object.fromEntries((G.groups || []).map(([id, l]) => [id, l]));
  const order = ["never", "multiday", "daily1", "daily2", "daily3"].filter((g) => label[g]);
  const rows = D.trains.filter((r) => r[c.tech] === "combined_cycle" && r[c.share_below_fuel] != null && r[c.cheap_days_filed] >= BF_MIN_DAYS)
    .map((r) => ({ name: r[c.plant], unit: r[c.unit] || r[c.plant], b: r[c.share_below_fuel], aw: r[c.share_awarded], days: r[c.cheap_days_filed],
      hub: r[c.hub], g: (G.units[r[c.plant]] || [])[1], mw: (G.units[r[c.plant]] || [])[2] || 0 }))
    .filter((r) => order.includes(r.g));
  const legend = [{ color: "--c3", label: "DAM award through the cheap hours on most cheap days", dot: true }, { color: "--c2", label: "On fewer than half", dot: true }];
  staticLegend($("bf-legend"), legend);
  if (!rows.length) return emptyMsg(el, "No combined cycle trains with three-part offers on cheap days.");
  const narrow = (el.clientWidth || 600) < 560;
  const w = Math.max(280, el.clientWidth || 600), rowH = narrow ? 70 : 62, m = { t: 12, r: 16, b: 34, l: narrow ? 12 : 270 };
  const H = m.t + m.b + rowH * order.length + (narrow ? 22 * order.length : 0);
  const band = (i) => m.t + i * (rowH + (narrow ? 22 : 0)) + (narrow ? 22 : 0);
  const x = d3.scaleLinear().domain([0, 1]).range([m.l + 10, w - m.r - 10]);
  const rad = d3.scaleSqrt().domain([0, d3.max(rows, (r) => r.mw) || 1]).range([0, narrow ? 10 : 13]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(5).tickSize(-(H - m.t - m.b)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(5).tickFormat(fmtPct).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", H - 4).attr("text-anchor", "end").text("Share of cheap days offered below fuel cost");
  order.forEach((g, i) => {
    const rs = rows.filter((r) => r.g === g), most = rs.filter((r) => r.b > BF_MOST);
    const y0 = band(i), note = `${most.length} of ${rs.length} trains, ${d3.format(".1f")(d3.sum(most, (r) => r.mw) / 1e3)} of ${d3.format(".1f")(d3.sum(rs, (r) => r.mw) / 1e3)} GW mostly below`;
    const lx = narrow ? m.l : 0, ly = narrow ? y0 - 8 : y0 + rowH / 2 - 4;
    svg.append("text").attr("class", "dlabel").attr("x", lx).attr("y", ly).style("font-weight", 600).style("fill", css("--ink")).text(label[g].replace(/: .*/, "").replace(" when available", ""));
    svg.append("text").attr("class", "axis-title").attr("x", narrow ? w - m.r : lx).attr("y", narrow ? ly : ly + 15).attr("text-anchor", narrow ? "end" : "start").text(narrow ? `${most.length} of ${rs.length} mostly below` : note);
    svg.append("line").attr("x1", x(0)).attr("x2", x(1)).attr("y1", y0 + rowH / 2).attr("y2", y0 + rowH / 2).attr("stroke", css("--ink-2")).attr("stroke-opacity", 0.25);
    // spread dots up and down their row by name so they don't sit on top of each other, the same way every load
    rs.forEach((r) => { let h = 0; for (const ch of r.name) h = (h * 31 + ch.charCodeAt(0)) % 997; r.y = y0 + rowH / 2 + ((h / 997) - 0.5) * (rowH - 2 * rad(r.mw) - 6); });
  });
  svg.append("g").selectAll("circle").data(rows.sort((a, b) => b.mw - a.mw)).join("circle")
    .attr("cx", (r) => x(r.b)).attr("cy", (r) => r.y).attr("r", (r) => Math.max(3, rad(r.mw)))
    .attr("fill", (r) => css(r.aw >= 0.5 ? "--c3" : "--c2")).attr("fill-opacity", 0.8).attr("stroke", css("--surface")).attr("stroke-width", 1).style("cursor", "pointer")
    .on("pointermove", (ev, r) => showTip(ev, `<h4>${esc(r.name)}</h4><table><tr><td>Group</td><td class="n">${esc(label[r.g])}</td></tr>` +
      `<tr><td>Cheap days below fuel cost</td><td class="n">${fmtPct(r.b)}</td></tr><tr><td>DAM award through the cheap hours</td><td class="n">${fmtPct(r.aw)}</td></tr>` +
      `<tr><td>Cheap days filed</td><td class="n">${fmt0(r.days)}</td></tr><tr><td>Size</td><td class="n">${fmt0(r.mw)} MW</td></tr>` +
      `<tr><td>Gas hub</td><td class="n">${r.hub === "waha" ? "Waha" : "Houston Ship Channel"}</td></tr></table>`))
    .on("pointerleave", hideTip).on("click", (ev, r) => { location.href = unitURL(r.unit); });
  el.replaceChildren(svg.node());
  setCSV(el, ["train", "group", "share_below_fuel", "share_awarded", "cheap_days_filed", "mw", "gas_hub"],
    rows.map((r) => [r.name, r.g, r.b, r.aw, r.days, r.mw, r.hub]), "Below fuel cost by flexibility group");
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
    ...(c.share_below_fuel == null ? [] : [{ h: "Below fuel cost", i: c.share_below_fuel, csv: "share_below_fuel", tip: "Share of those cheap days its offer sat below fuel cost (the awarded configuration, else the lowest)", f: bar }]),
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

// ---- offer changes: monthly counts and the table ----------------------------------------------
const KIND_COLOR = { mingen_step: "--c1", priced_out: "--c2", start_change: "--c7-soft", filing_off: "--c8", filing_on: "--c5", renew_floor: "--c3", renew_off: "--c6", renew_on: "--c4" };
const CH = { kind: "all", tech: "all", major: false, hideRep: false, limit: 200 };
function evText(e) {
  if (e.kind === "mingen_step") return `${fmt$(e.before)} to ${fmt$(e.after)}/MWh${e.mk_before != null && e.mk_after != null ? ` (${fmt$(e.mk_before)} to ${fmt$(e.mk_after)} against fuel cost)` : ""}`;
  if (e.kind === "priced_out") return `${fmt$(e.after)}/MWh against a usual ${fmt$(e.before)} for ${e.days} day${e.days === 1 ? "" : "s"}`;
  if (e.kind === "start_change") return `hot start ${fmt$s(Math.round(e.before))} to ${fmt$s(Math.round(e.after))}`;
  if (e.kind === "renew_floor") return `DA floor ${fmt$(e.before)} to ${fmt$(e.after)}/MWh`;
  return `${e.before} to ${e.after}`;
}
// the Unit page a change opens: the train for a combined cycle, else its (first) unit
const evUnit = (e) => (e.tech === "combined_cycle" ? e.plant : (e.units || [])[0] || e.plant);
const evName = (e) => (e.tech === "combined_cycle" || (e.units || []).length !== 1 ? e.plant : e.units[0]);
function chgRows() {
  return S.D.events.filter((e) => (CH.kind === "all" || e.kind === CH.kind) && (CH.tech === "all" || e.tech === CH.tech)
    && (!CH.major || e.major) && (!CH.hideRep || !e.repricer));
}
function drawChangeMonths(el, rs) {
  const D = S.D;
  if (!rs.length) { emptyMsg(el, "No changes match."); $("chg-legend").innerHTML = ""; return; }
  const kinds = Object.keys(D.kinds).filter((k) => rs.some((e) => e.kind === k));
  const months = d3.timeMonths(d3.timeMonth.floor(parseDate(D.first)), d3.timeMonth.offset(d3.timeMonth.floor(parseDate(D.last)), 1)).map(d3.timeFormat("%Y-%m"));
  const data = months.map((m) => Object.fromEntries([["m", m], ...kinds.map((k) => [k, rs.filter((e) => e.kind === k && e.date.startsWith(m)).length])]));
  const stack = d3.stack().keys(kinds)(data);
  const w = Math.max(280, el.clientWidth || 600), H = 200, mg = { t: 18, r: 12, b: 26, l: 44 };
  const x = d3.scaleBand().domain(months).range([mg.l, w - mg.r]).paddingInner(0.2);
  const y = d3.scaleLinear().domain([0, d3.max(stack.at(-1), (d) => d[1]) || 1]).nice().range([H - mg.b, mg.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${mg.l},0)`).call(d3.axisLeft(y).ticks(4).tickSize(-(w - mg.l - mg.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - mg.b})`)
    .call(d3.axisBottom(x).tickValues(months.filter((m, i) => w >= 560 || i % 2 === 0)).tickFormat((m) => d3.timeFormat("%b %y")(new Date(m + "-15T12:00:00"))).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${mg.l},0)`).call(d3.axisLeft(y).ticks(4).tickFormat(d3.format(",d")).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", mg.l).attr("y", 10).text("Changes per month");
  stack.forEach((layer) => svg.append("g").selectAll("rect").data(layer).join("rect").attr("x", (d) => x(d.data.m)).attr("width", x.bandwidth())
    .attr("y", (d) => y(d[1])).attr("height", (d) => Math.max(0, y(d[0]) - y(d[1]))).attr("fill", css(KIND_COLOR[layer.key])));
  svg.append("g").selectAll("rect").data(data).join("rect").attr("x", (d) => x(d.m)).attr("width", x.bandwidth()).attr("y", mg.t).attr("height", H - mg.t - mg.b).attr("fill", "transparent")
    .on("pointermove", (ev, d) => showTip(ev, `<h4>${d3.timeFormat("%B %Y")(new Date(d.m + "-15T12:00:00"))}</h4><table>` +
      kinds.map((k) => `<tr><td><span class="sw" style="background:var(${KIND_COLOR[k]})"></span></td><td>${esc(D.kinds[k])}</td><td class="n">${d[k]}</td></tr>`).join("") +
      `<tr><td></td><td>All</td><td class="n">${d3.sum(kinds, (k) => d[k])}</td></tr></table>`))
    .on("pointerleave", hideTip);
  el.replaceChildren(svg.node());
  setCSV(el, ["month", ...kinds], data.map((d) => [d.m, ...kinds.map((k) => d[k])]), "Day-ahead offer changes by month");
  $("chg-legend").innerHTML = kinds.map((k) => `<span><span class="sw" style="background:var(${KIND_COLOR[k]})"></span>${esc(D.kinds[k])}</span>`).join("");
}
function drawChanges() {
  const D = S.D, rs = chgRows(), tbl = $("chg-table");
  $("chg-note").textContent = `${D.first} to ${D.last}`;
  window.CX.setNote($("chg-text"), `Every change in a three-part or wind and solar day-ahead offer: ${fmt0(rs.length)} in this selection, ${fmt0(rs.filter((e) => e.major).length)} major. Click a row to open the unit.`,
    `Minimum-energy offer steps of $5 or more that hold for most of the next week (major when the offer crosses the fuel-cost line), price-outs of 1 to 6 days $10 or more above the unit's usual offer (major on a cheap day), ` +
    `hot start changes of 25% or more that hold, a train or unit that stops three-part offers while running (self-scheduled) or starts them (both major), and wind and solar day-ahead floors moving $5 or more, or their DA curves stopping or starting. ` +
    `Changes of one plant on the same or the next day are one row. Combustion turbines start rather than ride through, so their changes are never major. Re-pricers step their offer ten or more times a year.`);
  drawChangeMonths($("chg-chart"), rs);
  const shown = rs.slice(0, CH.limit);
  tbl.innerHTML = rs.length ? `<table class="data"><thead><tr><th class="t">Date</th><th class="t">Train, plant or unit</th><th class="t">Tech</th><th class="t">Change</th><th class="t">Before → after</th></tr></thead><tbody>` +
    shown.map((e) => `<tr data-unit="${esc(evUnit(e))}" style="cursor:pointer"><td class="t">${e.date}</td>` +
      `<td class="t"><a class="u" href="${unitURL(evUnit(e))}">${esc(evName(e))}</a>${(e.units || []).length > 1 ? ` <span class="muted">${e.units.length} ${e.tech === "combined_cycle" ? "configurations" : "units"}</span>` : ""}${e.repricer ? '<span class="tag" title="Ten or more minimum-energy steps in a year">re-prices often</span>' : ""}</td>` +
      `<td class="t">${TECH[e.tech] || esc(e.tech)}</td><td class="t">${esc(D.kinds[e.kind])}${e.major ? ' <span class="tag">major</span>' : ""}</td><td class="t">${esc(evText(e))}</td></tr>`).join("") +
    "</tbody></table>" : `<p class="empty">No changes match.</p>`;
  $("chg-more").hidden = rs.length <= CH.limit;
  $("chg-more").textContent = `Show more (${fmt0(rs.length - CH.limit)} not shown)`;
  setCSV(tbl, ["date", "plant", "units", "tech", "kind", "major", "repricer", "before", "after", "markup_before", "markup_after", "days"],
    rs.map((e) => [e.date, e.plant, (e.units || []).join(" "), e.tech, e.kind, e.major, !!e.repricer, e.before, e.after, e.mk_before ?? null, e.mk_after ?? null, e.days ?? null]), "Day-ahead offer changes");
}
function initChanges() {
  const D = S.D;
  $("chg-kind").innerHTML = `<option value="all">All changes</option>` + Object.entries(D.kinds).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("");
  const techs = [...new Set(D.events.map((e) => e.tech))].sort((a, b) => Object.keys(TECH).indexOf(a) - Object.keys(TECH).indexOf(b));
  $("chg-tech").innerHTML = `<option value="all">All</option>` + techs.map((t) => `<option value="${t}">${TECH[t] || esc(t)}</option>`).join("");
  const on = (id, ev, f) => $(id).addEventListener(ev, (e) => { f(e.target); CH.limit = 200; drawChanges(); });
  on("chg-kind", "change", (t) => { CH.kind = t.value; });
  on("chg-tech", "change", (t) => { CH.tech = t.value; });
  on("chg-major", "change", (t) => { CH.major = t.checked; });
  on("chg-rep", "change", (t) => { CH.hideRep = t.checked; });
  $("chg-more").addEventListener("click", () => { CH.limit += 400; drawChanges(); });
  $("chg-table").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-unit]");
    if (tr && !e.target.closest("a")) location.href = unitURL(tr.dataset.unit);
  });
}

function drawAll() { if (!S.D) return; drawKPIs(); drawLead(); drawBins(); drawMarkup(); drawBelowFuel(); drawTrains(); drawChanges(); drawRenew(); }

async function boot() {
  [S.D, S.G] = await Promise.all([tryJSON("data/dam_offers.json.gz"), tryJSON("data/groups_60d.json.gz")]);
  const D = S.D;
  if (!D || !D.renew) { $("status").textContent = "Day-ahead offer data not loaded yet."; return; }
  const nCheap = D.cheap.filter(Boolean).length;
  $("status").textContent = `60-day DAM disclosure · ${D.first} to ${D.last} · ${nCheap} days with cheap hours`;
  document.querySelectorAll(".cheap-usd").forEach((s) => { s.textContent = D.cheap_usd; });
  const hr = D.ref.hr;
  $("ref-note").innerHTML = `Fuel-cost line: <a href="${esc(D.ref.url)}">${esc(D.ref.name)}</a>: combined cycle ${hr.combined_cycle}, steam ${hr.gas_steam} and gas turbine ${hr.combustion_turbine} MMBtu/MWh at full load, ` +
    `times the gas price at the unit's own hub (Waha or Houston Ship Channel) on the last trading day before the operating day. Units burn more per MWh at minimum load, so an offer below the line is below fuel cost with room to spare.`;
  initChanges();
  drawAll();
  window.CX.init();
  let t, lastW = 0;
  new ResizeObserver((en) => { const w = Math.round(en[0].contentRect.width); if (w === lastW) return; lastW = w; clearTimeout(t); t = setTimeout(drawAll, 150); }).observe(document.querySelector("main"));
}
boot();
})();

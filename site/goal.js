/* Will fossil turn off? Four questions, each by year from 2019, from data/goal.json.gz
   (pipeline/goal.py, built monthly from the 60-day reports): the floor fossil output holds against
   net load and what sits at it, why the rest stays on in cheap hours and what that costs, whether
   behaviour is changing, and where fossil minimums sit beside curtailed wind
   and solar.  The page only sums and divides what the file holds. */
const { tryJSON, showTip, hideTip, setCSV, setNote, axisFmt, css, esc, readHash, writeHash } = window.CX;
const $ = (id) => document.getElementById(id);
const fmtGW = (mw) => d3.format(",.1f")(mw / 1000);
const fmtPct = d3.format(".0%");
const fmtPt = (v) => `${v >= 0 ? "+" : "−"}${d3.format(".1f")(Math.abs(v) * 100)} pt`;
const fmtTWh = (mwh) => d3.format(",.2f")(mwh / 1e6);
const TECH = { combined_cycle: "Combined cycle", gas_steam: "Gas steam", coal: "Coal", combustion_turbine: "Combustion turbine", nuclear: "Nuclear" };
// one vocabulary for why a unit at minimum stayed on (the Unit and Commitment pages use the same words)
const REASON = {
  coal: { label: "Coal", color: "--c8" },
  "never off": { label: "Never off", color: "--c-other" },
  "held by its award": { label: "Held by its award", color: "--c3" },
  "rode through": { label: "Rode through", color: "--c1" },
  "against the model": { label: "Stayed on, model said off", color: "--c7" },
  "no model call": { label: "No model call", color: "--c5" },
  combustion_turbine: { label: "Combustion turbines", color: "--c4" },
};
const S = { G: null, year: "all", tech: "combined_cycle", fuel: "all", q2cost: "" };

function emptyMsg(el, msg) { el.innerHTML = `<p class="empty">${msg}</p>`; }
const yearLabel = (y) => { const r = S.G.years[y]; return r && r.to.slice(5) !== "12-31" ? `${y} (Jan 1 to ${d3.timeFormat("%b %-d")(new Date(r.to + "T12:00:00"))})` : String(y); };
const years = () => Object.keys(S.G.years).map(Number).sort();
const fullYears = () => years().filter((y) => S.G.years[y].to.slice(5) === "12-31");
const rowsOf = (q) => S.G[q].rows.map((r) => Object.fromEntries(S.G[q].columns.map((c, i) => [c, r[i]])));
function legend(id, items) {
  $(id).innerHTML = items.map(([label, color, op]) => `<span><span class="sw" style="background:var(${color})${op ? `;opacity:${op}` : ""}"></span>${esc(label)}</span>`).join("");
}

// ==== 1. What turns off: the floor fossil output does not go below, and what sits at it ========
const TECH_COLOR = { coal: "--c8", combined_cycle: "--c1", gas_steam: "--c7", combustion_turbine: "--c4" };
const STUCK_TECHS = ["coal", "combined_cycle", "gas_steam", "combustion_turbine"];
const LOW_NET = 8;             // GW: "low net load" in the answer
const MIN_STUCK_HOURS = 15;    // a stuck-on bar needs this many hours
const isAll = () => S.year === "all";
const yearName = (y) => (y === "all" ? "all years" : yearLabel(y));
function drawQ1() {
  const F = S.G.floor, el = $("q1-chart"), sel = S.year;
  if (!F || !F.grid.length) { emptyMsg(el, "No data yet."); $("q1s-chart").innerHTML = ""; return; }
  const cells = d3.rollup(F.grid, (v) => d3.sum(v, (r) => r[3]), (r) => r[1], (r) => r[2]);
  const mine = isAll() ? null : d3.rollup(F.grid.filter((r) => r[0] === sel), (v) => d3.sum(v, (r) => r[3]), (r) => r[1], (r) => r[2]);
  const all = [...cells].flatMap(([gx, m]) => [...m].map(([gy, n]) => [gx, gy, n]));
  const w = Math.max(300, el.clientWidth || 700), H = 340, m = { t: 16, r: 14, b: 40, l: 52 };
  const x = d3.scaleLinear().domain([Math.min(-5, d3.min(all, (c) => c[0])), d3.max(all, (c) => c[0] + 1)]).nice().range([m.l, w - m.r]);
  const y = d3.scaleLinear().domain([0, d3.max(all, (c) => c[1] + 1)]).nice().range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(6).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(6).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(w < 560 ? 5 : 10).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 9).text("Fossil output (GW), each hour");
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", H - 6).attr("text-anchor", "end").text("Net load: load less the wind and solar available (GW)");
  const cw = x(1) - x(0), ch = y(0) - y(1), col = isAll() ? css("--ink") : css("--c1");
  const op = (n, mx) => 0.12 + 0.88 * Math.log1p(n) / Math.log1p(mx);
  const back = svg.append("g"), front = svg.append("g");
  const mxAll = d3.max(all, (c) => c[2]);
  all.forEach(([gx, gy, n]) => back.append("rect").attr("x", x(gx)).attr("y", y(gy + 1)).attr("width", cw).attr("height", ch)
    .attr("fill", isAll() ? col : css("--c-other")).attr("opacity", isAll() ? op(n, mxAll) : 0.25 * op(n, mxAll)));
  if (mine) {
    const mm = d3.max([...mine.values()].flatMap((v) => [...v.values()])) || 1;
    mine.forEach((v, gx) => v.forEach((n, gy) => front.append("rect").attr("x", x(gx)).attr("y", y(gy + 1)).attr("width", cw).attr("height", ch).attr("fill", col).attr("opacity", op(n, mm))));
  }
  // fossil can't go below net load less nuclear: the line it would sit on with no other units
  const nuc = 5;
  svg.append("line").attr("x1", x(Math.max(x.domain()[0], nuc))).attr("x2", x(x.domain()[1])).attr("y1", y(Math.max(x.domain()[0], nuc) - nuc)).attr("y2", y(x.domain()[1] - nuc))
    .attr("stroke", css("--muted")).attr("stroke-dasharray", "5 4").attr("stroke-width", 1.2);
  const med = F.median[isAll() ? "all" : String(sel)] || [];
  const half = F.bin / 2;
  svg.append("path").attr("d", d3.line().x((r) => x(r[0] + half)).y((r) => y(r[1] / 1000))(med)).attr("fill", "none").attr("stroke", css("--surface")).attr("stroke-width", 5.5);
  svg.append("path").attr("d", d3.line().x((r) => x(r[0] + half)).y((r) => y(r[1] / 1000))(med)).attr("fill", "none").attr("stroke", isAll() ? css("--c2") : css("--c2")).attr("stroke-width", 2.5);
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const nx = x.invert(d3.pointer(ev)[0]), r = med.find((q) => nx >= q[0] && nx < q[0] + F.bin);
      if (!r) return hideTip();
      showTip(ev, `<h4>Net load ${r[0]} to ${r[0] + F.bin} GW · ${yearName(sel)}</h4><table><tr><td>Median fossil output</td><td class="n">${fmtGW(r[1])} GW</td></tr><tr><td>Hours</td><td class="n">${d3.format(",")(r[2])}</td></tr></table>`);
    })
    .on("pointerleave", hideTip);
  el.replaceChildren(svg.node());
  legend("q1-legend", [[isAll() ? "Hours, all years (darker: more hours)" : `Hours in ${yearName(sel)} (other years grey)`, isAll() ? "--ink" : "--c1"], ["Median fossil output", "--c2"]]);
  $("q1-legend").insertAdjacentHTML("beforeend", `<span><span class="sw sw-line"></span>Net load less about 5 GW of nuclear</span>`);
  // what is stuck on: average fossil output by net load, at minimum and above it
  const sb = F.stuck_bin, pick = (r) => isAll() || r[0] === sel;
  const hours = d3.rollup(F.hours.filter(pick), (v) => d3.sum(v, (r) => r[2]), (r) => r[1]);
  const bins = [...hours].filter(([, n]) => n >= MIN_STUCK_HOURS).map(([b]) => b).sort((a, b) => a - b);
  const part = (b, t, k) => d3.sum(F.stuck.filter((r) => pick(r) && r[1] === b && r[2] === t), (r) => r[k]) / hours.get(b);
  const keys = [...STUCK_TECHS.map((t) => [t, 3, 1]), ...STUCK_TECHS.map((t) => [t, 4, 0.35])];
  const el2 = $("q1s-chart"), H2 = 280, m2 = { t: 16, r: 14, b: 40, l: 52 };
  const xb = d3.scaleBand().domain(bins).range([m2.l, w - m2.r]).padding(0.15);
  const tops = bins.map((b) => d3.sum(keys, ([t, k]) => part(b, t, k)));
  const y2 = d3.scaleLinear().domain([0, d3.max(tops) || 1]).nice().range([H2 - m2.b, m2.t]);
  const s2 = d3.create("svg").attr("viewBox", `0 0 ${w} ${H2}`);
  s2.append("g").attr("class", "gridline").attr("transform", `translate(${m2.l},0)`).call(d3.axisLeft(y2).ticks(5).tickSize(-(w - m2.l - m2.r)).tickFormat(""));
  s2.append("g").attr("class", "axis").attr("transform", `translate(${m2.l},0)`).call(d3.axisLeft(y2).ticks(5).tickFormat((v) => d3.format(",.0f")(v / 1000)).tickSizeOuter(0));
  const every = Math.ceil(bins.length / (w < 560 ? 6 : 12));
  s2.append("g").attr("class", "axis").attr("transform", `translate(0,${H2 - m2.b})`).call(d3.axisBottom(xb).tickValues(bins.filter((_, i) => i % every === 0)).tickFormat((b) => `${b}`).tickSizeOuter(0));
  s2.append("text").attr("class", "axis-title").attr("x", m2.l).attr("y", 9).text(`Average fossil output (GW) by net load, ${yearName(sel)}`);
  s2.append("text").attr("class", "axis-title").attr("x", w - m2.r).attr("y", H2 - 6).attr("text-anchor", "end").text(`Net load (GW), ${sb} GW bins`);
  bins.forEach((b) => {
    let acc = 0;
    keys.forEach(([t, k, o]) => {
      const v = part(b, t, k);
      if (!v) return;
      s2.append("rect").attr("x", xb(b)).attr("width", xb.bandwidth()).attr("y", y2(acc + v)).attr("height", Math.max(0, y2(acc) - y2(acc + v) - 0.5)).attr("fill", css(TECH_COLOR[t])).attr("opacity", o);
      acc += v;
    });
    s2.append("rect").attr("x", xb(b)).attr("width", xb.bandwidth()).attr("y", m2.t).attr("height", H2 - m2.t - m2.b).attr("fill", "transparent")
      .on("pointermove", (ev) => showTip(ev, `<h4>Net load ${b} to ${b + sb} GW · ${yearName(sel)}</h4><table><tr><td></td><td class="n">At minimum, GW</td><td class="n">Above, GW</td></tr>` +
        STUCK_TECHS.map((t) => `<tr><td><span class="sw" style="background:var(${TECH_COLOR[t]})"></span> ${TECH[t]}</td><td class="n">${fmtGW(part(b, t, 3))}</td><td class="n">${fmtGW(part(b, t, 4))}</td></tr>`).join("") +
        `<tr><td><b>All fossil</b></td><td class="n"><b>${fmtGW(d3.sum(STUCK_TECHS, (t) => part(b, t, 3)))}</b></td><td class="n"><b>${fmtGW(d3.sum(STUCK_TECHS, (t) => part(b, t, 4)))}</b></td></tr><tr><td>Hours</td><td class="n" colspan="2">${d3.format(",")(hours.get(b))}</td></tr></table>`))
      .on("pointerleave", hideTip);
  });
  el2.replaceChildren(s2.node());
  legend("q1s-legend", [...STUCK_TECHS.map((t) => [`${TECH[t]} at minimum`, TECH_COLOR[t]]), ["Lighter: above minimum", "--c-other", 0.35]]);
  setCSV(el2, ["net_load_bin_gw", "hours", ...STUCK_TECHS.flatMap((t) => [`${t}_at_minimum_mw`, `${t}_above_minimum_mw`])],
    bins.map((b) => [b, hours.get(b), ...STUCK_TECHS.flatMap((t) => [Math.round(part(b, t, 3)), Math.round(part(b, t, 4))])]), `What is stuck on ${yearName(sel)}`);
  setCSV(el, ["net_load_bin_gw", "median_fossil_mw", "hours"], med, `Fossil against net load ${yearName(sel)}`);
  // the answer: the floor in low net load hours, and what sits at it
  const low = (rs) => rs.filter((r) => r[0] + F.bin <= LOW_NET);
  const floorOf = (k) => { const rs = low(F.median[k] || []), n = d3.sum(rs, (r) => r[2]); return n ? d3.sum(rs, (r) => r[1] * r[2]) / n : null; };
  const lowBins = bins.filter((b) => b + sb <= LOW_NET), lh = d3.sum(lowBins, (b) => hours.get(b));
  const lowPart = (t, k) => (lh ? d3.sum(lowBins, (b) => part(b, t, k) * hours.get(b)) / lh : 0);
  const atMin = d3.sum(STUCK_TECHS, (t) => lowPart(t, 3)), above = d3.sum(STUCK_TECHS, (t) => lowPart(t, 4));
  const yrs = years().filter((q) => floorOf(String(q)) != null);
  const f = floorOf(isAll() ? "all" : String(sel));
  $("q1-answer").innerHTML = f == null ? `Too few hours with net load under ${LOW_NET} GW in ${yearName(sel)} to say.` :
    `<b>Fossil output has a floor it doesn't go below.</b> In hours when net load was under ${LOW_NET} GW, fossil still ran a median of about ${fmtGW(f)} GW (${yearName(sel)}), ` +
    `and in those hours ${fmtGW(atMin)} GW of it was units at their minimum, against ${fmtGW(above)} GW above it: coal ${fmtGW(lowPart("coal", 3))} GW and combined cycles ${fmtGW(lowPart("combined_cycle", 3))} GW. ` +
    `By year the floor was ${yrs.map((q) => `${fmtGW(floorOf(String(q)))} GW in ${q}`).join(", ")}.`;
  setNote($("q1-note"), `Every hour since ${d3.timeFormat("%b %Y")(new Date(S.G.years[years()[0]].from + "T12:00:00"))}: fossil output against net load, the load left once the wind and solar available are counted. Where fossil could turn off, its output would follow net load down to the dashed line; instead it flattens. Below, the average fossil output in each band of net load, split into units at their minimum and output above it.`,
    `From the 60-day SCED disclosure, hour by hour. Fossil is coal, combined cycle, gas steam and combustion turbines. Net load is the output of every thermal unit (fossil and nuclear) plus wind and solar output, less the wind and solar available (their HSL), so load less what wind and solar could have supplied; storage and imports are left out. The median line uses ${F.bin} GW bands of net load with at least 10 hours. At minimum is the smaller of a running unit's output and its LSL (combined-cycle configurations merged into their train). The dashed line is net load less about 5 GW of nuclear.`);
}

// ==== 2. Why the rest stays on: minimum online in cheap hours, by reason, by year =============
function stack(el, ys, keys, val, opts) {
  const tip = opts.tip || ((v) => `${d3.format(",.0f")(v)} MW`);
  const w = Math.max(300, el.clientWidth || 700), m = { t: 14, r: 14, b: 26, l: 56 }, H = 260;
  const x = d3.scaleBand().domain(ys).range([m.l, w - m.r]).padding(0.25);
  const tops = ys.map((y) => d3.sum(keys, (k) => val(y, k)));
  const yy = d3.scaleLinear().domain([0, Math.max(d3.max(tops) || 1, opts.mark ? d3.max(ys, opts.mark) || 0 : 0)]).nice().range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(yy).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(yy).ticks(5).tickFormat(opts.axis || ((v) => d3.format(",.0f")(v / 1000))).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickFormat((y) => (S.G.years[y].to.slice(5) === "12-31" ? y : `${y}*`)).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 9).text(opts.title);
  ys.forEach((y) => {
    let acc = 0;
    keys.forEach((k) => {
      const v = val(y, k);
      if (!v) return;
      svg.append("rect").attr("x", x(y)).attr("width", x.bandwidth()).attr("y", yy(acc + v)).attr("height", Math.max(0, yy(acc) - yy(acc + v) - 0.5)).attr("fill", css((opts.labels || REASON)[k].color));
      acc += v;
    });
    if (opts.mark) {
      const v = opts.mark(y);
      [[css("--surface"), 5.5], [css("--ink"), 2.5]].forEach(([c, sw]) => svg.append("line").attr("x1", x(y) - 4).attr("x2", x(y) + x.bandwidth() + 4).attr("y1", yy(v)).attr("y2", yy(v)).attr("stroke", c).attr("stroke-width", sw));
    }
    svg.append("rect").attr("x", x(y)).attr("width", x.bandwidth()).attr("y", m.t).attr("height", H - m.t - m.b).attr("fill", "transparent")
      .on("pointermove", (ev) => showTip(ev, `<h4>${yearLabel(y)}</h4><table>` + keys.filter((k) => val(y, k)).reverse().map((k) => `<tr><td>${(opts.labels || REASON)[k].label}</td><td class="n">${tip(val(y, k))}</td></tr>`).join("") +
        `<tr><td><b>Total</b></td><td class="n"><b>${tip(d3.sum(keys, (k) => val(y, k)))}</b></td></tr>` + (opts.mark ? `<tr><td>${opts.markLabel}</td><td class="n">${tip(opts.mark(y))}</td></tr>` : "") + `</table>`))
      .on("pointerleave", hideTip);
  });
  el.replaceChildren(svg.node());
}
// the day-ahead award against staying on through a cheap midday stretch, by technology
const AWARD_GROUPS = [["award", "DAM award", "--c1"], ["self", "Self-committed, no award", "--c3"], ["neither", "Neither", "--c2"], ["no award", "No award", "--c-other"]];
const Q2_TECHS = ["combined_cycle", "gas_steam", "coal", "combustion_turbine"];
// the cost chart uses the award chart's groups and colors (AWARD_GROUPS, below)
function drawQ2Cost() {
  $("q2c-fuel").querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === S.fuel)));
  const gasOnly = S.fuel === "gas", el = $("q2c-chart");
  const Q = (S.G.q2.cost || []).map(([year, tech, group, mwh, cost]) => ({ year, tech, group, mwh, cost })).filter((r) => !gasOnly || r.tech !== "coal");
  if (!Q.length) return emptyMsg(el, "No cost yet.");
  const ys = years(), keys = AWARD_GROUPS.map((g) => g[0]), labels = Object.fromEntries(AWARD_GROUPS.map(([k, label, color]) => [k, { label, color }]));
  const val = (y, k) => d3.sum(Q.filter((r) => r.year === y && r.group === k), (r) => r.cost);
  stack(el, ys, keys, val, { title: `What staying on at minimum cost ${gasOnly ? "gas units" : "fossil units"} in cheap hours ($ million)`, labels, axis: (v) => d3.format(",.0f")(v / 1e6), tip: (v) => `$${d3.format(",.1f")(v / 1e6)}M` });
  legend("q2c-legend", AWARD_GROUPS.filter(([k]) => Q.some((r) => r.group === k)).map(([, label, c]) => [label, c]));
  setCSV(el, ["year", "tech", "group", "minimum_mwh", "cost_usd"], Q.map((r) => [r.year, r.tech, r.group, r.mwh, r.cost]), "Cost of staying on");
  const tot = (y) => d3.sum(keys, (k) => val(y, k)), fy = fullYears(), now = ys.at(-1);
  const big = fy.reduce((a, b) => (tot(b) > tot(a) ? b : a), fy[0]), all = d3.sum(ys, tot);
  const coal = d3.sum((S.G.q2.cost || []).filter((r) => r[1] === "coal"), (r) => r[4]);
  const per = (f) => d3.sum(Q.filter(f), (r) => r.cost) / (d3.sum(Q.filter(f), (r) => r.mwh) || 1);
  S.q2cost = `Staying on at minimum through cheap hours cost ${gasOnly ? "gas" : "fossil"} units $${d3.format(",.0f")(tot(big) / 1e6)}M in ${big}` + (now !== fy.at(-1) ? ` and $${d3.format(",.0f")(tot(now) / 1e6)}M so far in ${now}` : "") +
    (gasOnly ? `; $${d3.format(",.0f")(all / 1e6)}M since ${ys[0]}, leaving out coal's $${d3.format(",.0f")(coal / 1e6)}M.` : `; coal carries $${d3.format(",.0f")(coal / 1e6)}M of the $${d3.format(",.0f")(all / 1e6)}M since ${ys[0]}.`) + ` Hours held by a day-ahead award cost about $${d3.format(",.0f")(per((r) => r.group === "award"))}/MWh, against $${d3.format(",.0f")(per((r) => r.group !== "award"))} without one.`;
  setNote($("q2c-note"), `What it cost fossil units at their minimum to stay on through cheap hours, by the same groups as the chart below. * part year.`,
    `Coal, combined cycle and gas steam units at minimum in a cheap hour (day-ahead hub average of $${S.G.cheap}/MWh or less). Each hour costs the unit's cost of running at minimum less its real-time node price, times its LSL; an hour where the node paid more than the cost counts as negative. Real-time in every group: a day-ahead award pays the same whether or not the unit runs, so the choice each hour is to generate or buy the energy back in real time. For gas units that cost is fuel: an EIA average heat rate (7.5 MMBtu/MWh for combined cycles, 10.4 for gas steam) times the gas price at the unit's own hub, Houston Ship Channel or Waha, on the trading day before (Henry Hub before those series start). Coal is a generic $25/MWh. Units' DAM minimum-energy offers are not used: they are often set to win or avoid commitment rather than at cost. Only output up to the minimum is counted. Groups go hour by hour: a DAM energy award over 0.5 MW that hour; else self-committed when the unit's DAM resource status is on, else neither (from the 60-day DAM disclosure).`);
}
function drawQ2() {
  drawQ2Cost();
  const R = S.G.q2.award.map(([year, tech, group, n, stayed]) => ({ year, tech, group, n, stayed }));
  const el = $("q2a-chart");
  if (!R.length) return emptyMsg(el, "No cheap midday stretches.");
  const y = d3.max(R.filter((r) => r.group === "self"), (r) => r.year) || d3.max(R, (r) => r.year);
  const get = (t, k) => R.find((r) => r.year === y && r.tech === t && r.group === k) || { n: 0, stayed: 0 };
  const rows = Q2_TECHS.flatMap((t) => AWARD_GROUPS.filter(([k]) => get(t, k).n).map(([k, label, c]) => ({ t, k, label, c, ...get(t, k) })));
  $("q2a-title").textContent = `Units online going into a cheap midday stretch, ${yearLabel(y)}: share that stayed online through it`;
  const w = Math.max(300, el.clientWidth || 700), m = { t: 6, r: 60, b: 26, l: 160 }, band = 40, gap = 30;
  let yy = m.t;
  const pos = rows.map((r, i) => { if (i === 0 || rows[i - 1].t !== r.t) yy += gap; const p = yy; yy += band; return p; });
  const H = yy + m.b, x = d3.scaleLinear().domain([0, 1]).range([m.l, w - m.r]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(w < 500 ? 2 : 4).tickSize(-(H - m.t - m.b)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(w < 500 ? 2 : 4).tickFormat(fmtPct).tickSizeOuter(0));
  rows.forEach((r, i) => {
    if (i === 0 || rows[i - 1].t !== r.t) svg.append("text").attr("x", 0).attr("y", pos[i] - 10).attr("class", "axis-label").style("font-weight", 600).text(TECH[r.t]);
    const v = r.stayed / r.n, top = pos[i] + 4, bh = band - 10;
    svg.append("rect").attr("x", x(0)).attr("y", top).attr("width", x(v) - x(0)).attr("height", bh).attr("fill", css(r.c));
    svg.append("text").attr("x", x(v) + 6).attr("y", top + bh / 2).attr("dy", "0.35em").attr("class", "bar-val").style("font-weight", 600).text(d3.format(".1%")(v));
    const t = svg.append("text").attr("x", m.l - 8).attr("y", top + bh / 2).attr("text-anchor", "end").attr("class", "axis-label");
    t.append("tspan").attr("x", m.l - 8).attr("dy", "-0.2em").text(r.label);
    t.append("tspan").attr("x", m.l - 8).attr("dy", "1.2em").attr("fill", css("--muted")).text(`${d3.format(",")(r.n)} unit-days`);
  });
  el.replaceChildren(svg.node());
  setCSV(el, ["year", "tech", "group", "unit_days", "stayed_online"], R.map((r) => [r.year, r.tech, r.group, r.n, r.stayed]), "Award and staying on");
  const p = (t, k) => d3.format(".1%")(get(t, k).stayed / Math.max(1, get(t, k).n));
  $("q2-answer").innerHTML = (S.q2cost ? `${S.q2cost} ` : "") + `<b>A day-ahead award or a self-commitment keeps a unit on.</b> In ${yearLabel(y)}, combined cycles going into a cheap midday stretch with a DAM award stayed online through it ${p("combined_cycle", "award")} of the time, and self-committed ones ${p("combined_cycle", "self")}. With neither, only ${p("combined_cycle", "neither")} did. Coal and gas steam stay on almost regardless: ${p("coal", "self")} of self-committed coal and ${p("gas_steam", "self")} of gas steam rode through.`;
  setNote($("q2-note"), `Units online going into the day's first cheap midday stretch, by whether a day-ahead award or their own commitment had them on, and the share that stayed online through it. Combined-cycle configurations count as one train. * part year.`,
    `Counted: unit-days online in the hour before the day's first run of two or more cheap hours (day-ahead hub average of $${S.G.cheap}/MWh or less) between HE8 and HE19, with no outage hour in it; stayed online means no offline hour in the run (60-day SCED and DAM disclosures). DAM award: an energy award over 0.5 MW in at least half the run's hours. Self-committed: no award, and the unit's DAM resource status on at the run's first hour. The status comes from the 60-day DAM disclosure, every year from 2019.`);
}

// ==== 3. Is behaviour changing: triggers against behaviour, and where the loss windows fall ==
const Q3_KEYS = ["off", "more", "less", "award"];
const Q3 = {
  off: { label: "Turned off", color: "--c3" },
  more: { label: "Rode through, losing more than a restart", color: "--c7" },
  less: { label: "Rode through, losing less than a restart", color: "--c7-soft" },
  award: { label: "Held on by a day-ahead award", color: "--c-other" },
};
function drawQ3() {
  $("q3-tech").value = S.tech;
  const el = $("q3-chart"), O = S.G.q3.off.map(([year, tech, small, awarded, n, off, onMwh, offMwh]) => ({ year, tech, small, awarded, n, off, onMwh, offMwh })).filter((r) => r.tech === S.tech);
  const ys = [...new Set(O.map((r) => r.year))].sort();
  if (!ys.length) return emptyMsg(el, "No loss windows.");
  const sum = (y, f, get) => d3.sum(O.filter((r) => r.year === y && f(r)), get);
  const part = (y, k) => k === "off" ? sum(y, () => true, (r) => r.offMwh) : k === "award" ? sum(y, (r) => r.awarded, (r) => r.onMwh)
    : sum(y, (r) => !r.awarded && r.small === (k === "less" ? 1 : 0), (r) => r.onMwh);
  const share = (y, sm) => { const r = O.find((q) => q.year === y && !q.awarded && q.small === sm); return r ? r.off : NaN; };
  const w = Math.max(300, el.clientWidth || 700), m = { t: 14, r: 14, b: 26, l: 56 };
  stack(el, ys, Q3_KEYS, part, { title: `${TECH[S.tech]} minimum output in its day-ahead loss windows (TWh)`, labels: Q3,
    axis: (v) => d3.format(".0f")(v / 1e6), tip: (v) => `${fmtTWh(v)} TWh` });
  legend("q3-legend", Q3_KEYS.map((k) => [Q3[k].label, Q3[k].color]));
  setCSV(el, ["year", ...Q3_KEYS.map((k) => `${k}_mwh`)], ys.map((y) => [y, ...Q3_KEYS.map((k) => Math.round(part(y, k)))]), `Loss windows ${S.tech}`);
  // where the loss windows fall
  const M = S.G.q3.mix.map(([year, tech, n, overnight, midday, off, loss]) => ({ year, tech, n, overnight, midday, off, loss })).filter((r) => r.tech === S.tech);
  const el2 = $("q3m-chart"), H2 = 170, x2 = d3.scalePoint().domain(M.map((r) => r.year)).range([m.l + 20, w - m.r - 20]);
  const y2 = d3.scaleLinear().domain([0, Math.max(0.5, d3.max(M, (r) => Math.max(r.overnight, r.midday)))]).nice().range([H2 - m.b, m.t]);
  const s2 = d3.create("svg").attr("viewBox", `0 0 ${w} ${H2}`);
  s2.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y2).ticks(4).tickSize(-(w - m.l - m.r)).tickFormat(""));
  s2.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y2).ticks(4).tickFormat(fmtPct).tickSizeOuter(0));
  s2.append("g").attr("class", "axis").attr("transform", `translate(0,${H2 - m.b})`).call(d3.axisBottom(x2).tickFormat((y) => (S.G.years[y]?.to.slice(5) === "12-31" ? y : `${y}*`)).tickSizeOuter(0));
  s2.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 9).text("Where the day's worst loss window starts: share of windows");
  [["overnight", "--c1"], ["midday", "--c4"]].forEach(([k, c]) => {
    s2.append("path").attr("d", d3.line().x((r) => x2(r.year)).y((r) => y2(r[k]))(M)).attr("fill", "none").attr("stroke", css(c)).attr("stroke-width", 2);
    M.forEach((r) => s2.append("circle").attr("cx", x2(r.year)).attr("cy", y2(r[k])).attr("r", 3).attr("fill", css(c)));
  });
  M.forEach((r) => s2.append("rect").attr("x", x2(r.year) - 20).attr("width", 40).attr("y", m.t).attr("height", H2 - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => showTip(ev, `<h4>${yearLabel(r.year)}</h4><table><tr><td>Windows</td><td class="n">${d3.format(",")(r.n)}</td></tr><tr><td>Starting overnight</td><td class="n">${fmtPct(r.overnight)}</td></tr><tr><td>Starting midday (HE 9 to 17)</td><td class="n">${fmtPct(r.midday)}</td></tr><tr><td>Turned off for the window</td><td class="n">${fmtPct(r.off)}</td></tr><tr><td>Median loss of riding through</td><td class="n">$${d3.format(",.0f")(r.loss)}/MW</td></tr></table>`))
    .on("pointerleave", hideTip));
  el2.replaceChildren(s2.node());
  legend("q3m-legend", [["Starting overnight (after midnight)", "--c1"], ["Starting midday (HE 9 to 17)", "--c4"]]);
  setCSV(el2, ["year", "windows", "overnight", "midday", "turned_off", "median_loss_per_mw"], M.map((r) => [r.year, r.n, r.overnight, r.midday, r.off, r.loss]), `Loss windows ${S.tech}`);
  const f = M[0], l = M.at(-1), y0 = ys[0], y1 = fullYears().at(-1), now = ys.at(-1);
  const dir = part(y1, "more") > part(y0, "more") * 1.1 ? "more" : part(y1, "more") < part(y0, "more") * 0.9 ? "less" : "about as much";
  $("q3-answer").innerHTML = `<b>${TECH[S.tech]} units ride through ${dir} of their losses than in ${y0}.</b> Units without a day-ahead award, losing more than a restart would cost, rode through ${fmtTWh(part(y0, "more"))} TWh of minimum output in ${y0} and ${fmtTWh(part(y1, "more"))} TWh in ${y1}, while the output turned off across all loss windows went from ${fmtTWh(part(y0, "off"))} to ${fmtTWh(part(y1, "off"))} TWh. ` +
    `They turned off for ${fmtPct(share(y0, 0))} of such windows in ${y0} and ${fmtPct(share(y1, 0))} in ${y1}` + (now !== y1 ? ` (${fmtPct(share(now, 0))} so far in ${now})` : "") +
    `. Meanwhile the cheap hours moved to midday: ${fmtPct(f.overnight)} of loss windows started overnight in ${f.year}, ${fmtPct(l.overnight)} in ${yearLabel(l.year)}.`;
  setNote($("q3-note"), `Each unit's minimum output over its day's worst day-ahead loss window, by year: what was turned off, and what ran through it and why. * part year.`,
    `One row per unit and day it started online: its worst stretch of day-ahead losses at minimum over HE7 to HE6 the next day (its gas cost at minimum above its day-ahead node price, times its LSL; the gas cost as in question 2), and the hours it was online through it (60-day SCED and DAM disclosures, from 2019). Output is the LSL times the window's hours, online or offline. Losing more than a restart means that loss beat its hot start offer (a generic $15,000 for combined cycles and $10,000 for gas steam when none is offered). Held on by a day-ahead award: an award covered half the window's hours or more; those units almost never turn off. 2021 and 2022 include Winter Storm Uri and the 2022 gas price spike.`);
}

// ==== 4. Curtailment and the fossil minimum beside it ========================================
const Q4_KEYS = ["losing more than a restart", "losing, less than a restart", "covering its costs", "combustion_turbine"];
const RUN_KEYS = ["restart", "losing", "all", "none"];
const RUN = {
  restart: { label: "Runs if units losing more than a restart shut", color: "--c3" },
  losing: { label: "… if every unit losing money shut", color: "--c1" },
  all: { label: "… only if all fossil at minimum shut", color: "--c-other" },
  none: { label: "Stays curtailed", color: "--c8" },
};
const ECON = {
  "losing more than a restart": { label: "Losing more than a restart costs", color: "--c7" },
  "losing, less than a restart": { label: "Losing, but less than a restart", color: "--c7-soft" },
  "covering its costs": { label: "Covering its costs", color: "--c-other" },
  combustion_turbine: { label: "Combustion turbines", color: "--c4" },
};
function drawQ4() {
  const el = $("q4-chart"), Y = S.G.q4.years.map(([year, avail, curt, over, free, overH, counted, freeCounted, byHe]) => ({ year, avail, curt, over, free, overH, counted, freeCounted, byHe }));
  const A = S.G.q4.atmin.map(([year, tech, econ, mwh]) => ({ year, tech, econ, mwh }));
  const ys = Y.map((r) => r.year), cnt = Object.fromEntries(Y.map((r) => [r.year, r.counted || 1]));
  const val = (y, k) => d3.sum(A.filter((r) => r.year === y && r.tech !== "nuclear" && r.econ === k), (r) => r.mwh) / cnt[y];
  const V = S.G.q4.avoid.map(([year, s, mwh]) => ({ year, s, mwh })), sc = S.G.q4.scenarios;
  const run = (y, i) => (V.find((r) => r.year === y && r.s === sc[i]) || { mwh: 0 }).mwh;
  const part = (y, k) => { const r = Y.find((q) => q.year === y), i = RUN_KEYS.indexOf(k); return i === 3 ? Math.max(0, r.free - run(y, 2)) : run(y, i) - (i ? run(y, i - 1) : 0); };
  stack(el, ys, RUN_KEYS, part, { title: "Wind and solar curtailment fossil could make room for (TWh), by the shutdown that would let it run", labels: RUN,
    axis: (v) => d3.format(".1f")(v / 1e6), tip: (v) => `${fmtTWh(v)} TWh` });
  legend("q4-legend", RUN_KEYS.map((k) => [RUN[k].label, RUN[k].color]));
  const nuc = (y) => d3.sum(A.filter((r) => r.year === y && r.tech === "nuclear"), (r) => r.mwh) / cnt[y];
  const v = (y, s) => (V.find((r) => r.year === y && r.s === s) || { mwh: 0 }).mwh;
  $("q4-table").innerHTML = `<table class="data"><thead><tr><th class="t">Year</th><th>Curtailed</th><th>Fossil could make room for</th><th>Would run: units losing more than a restart shut</th><th>Would run: every unit losing money shut</th><th>Would run: all fossil at minimum shut</th></tr></thead><tbody>` +
    Y.slice().reverse().map((r) => `<tr><td class="t">${yearLabel(r.year)}</td><td>${fmtTWh(r.curt)} TWh (${fmtPct(r.curt / r.avail)})</td><td>${fmtTWh(r.free)} TWh (${fmtPct(r.free / r.curt)}), ${d3.format(",")(r.overH)} hours</td>` +
      sc.map((s) => `<td>${fmtTWh(v(r.year, s))} TWh (${fmtPct(v(r.year, s) / (r.free || 1))})</td>`).join("") + `</tr>`).join("") + `</tbody></table>`;
  setCSV(el, ["year", "available_mwh", "curtailed_mwh", "uncongested_oversupply_mwh", "oversupply_hours", "counted_hours", "nuclear_mw", ...Q4_KEYS.map((k) => `${k.replace(/[ ,]+/g, "_")}_mw`), ...sc.map((s) => `would_run_${s.replace(/[ ,]+/g, "_")}_mwh`)],
    Y.map((r) => [r.year, r.avail, r.curt, r.free, r.overH, r.counted, Math.round(nuc(r.year)), ...Q4_KEYS.map((k) => Math.round(val(r.year, k))), ...sc.map((s) => v(r.year, s))]), "Curtailment and fossil minimum");
  const y = fullYears().at(-1), r = Y.find((q) => q.year === y), fossil = d3.sum(Q4_KEYS, (k) => val(y, k));
  const runs = (s) => `${fmtTWh(v(y, s))} TWh (${fmtPct(v(y, s) / r.free)})`;
  $("q4-answer").innerHTML = `In ${y}, ${fmtTWh(r.curt)} TWh of wind and solar was curtailed, and fossil units could have made room for ${fmtTWh(r.free)} TWh of it (${fmtPct(r.free / r.curt)}): the curtailment in oversupply hours at wind and solar not behind congestion. In those hours ${fmtGW(fossil)} GW of fossil sat at minimum, beside ${fmtGW(nuc(y))} GW of nuclear. <b>${fmtGW(val(y, Q4_KEYS[0]))} GW of it was losing more than a restart would cost.</b> Had those units shut, ${runs(sc[0])} of that curtailment would have run instead. Had every unit losing money shut, ${runs(sc[1])} would have; shutting all fossil at minimum, ${runs(sc[2])}.`;
  setNote($("q4-note"), `The curtailment fossil units could make room for, by year, split by the shutdown that would have let it run. Each hour counts the smaller of its curtailment and the minimum of the units shut, so a year's average fossil minimum and average curtailment can't simply be compared. * part year.`,
    `Curtailment is a wind or solar unit's HSL above its base point (0.5 MW or more), from the 60-day SCED disclosure. An oversupply hour has a real-time hub average (HB_HUBAVG) of $${S.G.over_price}/MWh or less. A unit is behind congestion when its day-ahead node price sits $5 or more below the day-ahead bus average; most curtailment is (West and Panhandle), and shutting a gas unit elsewhere does not make room for it. The fossil split covers oversupply hours with at least 100 MW curtailed not behind congestion. A unit is losing money in the hours of its day's worst loss window: the longest run of hours in which its minimum-energy cost beat its day-ahead node price, times its LSL. It loses more than a restart when that window's loss beats its hot start offer (a generic $15,000 for combined cycles, $10,000 for gas steam and $30,000 for coal when none is offered). Units outside such a window are covering their costs at day-ahead prices. "Runs" sums, hour by hour, the smaller of that curtailment and the minimum of the units shut.`);
}

function drawAll() { drawQ1(); drawQ2(); drawQ3(); drawQ4(); }

(async function boot() {
  window.CX.init();
  S.G = await tryJSON("data/goal.json.gz");
  if (!S.G) { $("status").textContent = "Not built yet. The goal page's data is built monthly by its own workflow."; return; }
  const v = readHash();
  const ys = years();
  S.year = v.y === "all" || !v.y ? "all" : ys.includes(+v.y) ? +v.y : "all";
  if (["combined_cycle", "gas_steam"].includes(v.t)) S.tech = v.t;
  $("status").textContent = `60-day data, ${S.G.years[ys[0]].from} to ${S.G.through}. Built ${S.G.built.slice(0, 10)}.`;
  $("q1-year").innerHTML = [`<option value="all"${isAll() ? " selected" : ""}>All years</option>`, ...ys.slice().reverse().map((y) => `<option value="${y}"${y === S.year ? " selected" : ""}>${yearLabel(y)}</option>`)].join("");
  $("q1-year").addEventListener("change", (e) => { S.year = e.target.value === "all" ? "all" : +e.target.value; writeHash({ y: S.year, t: S.tech }); drawQ1(); });
  $("q2c-fuel").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; S.fuel = b.dataset.v; drawQ2(); });
  $("q3-tech").addEventListener("change", (e) => { S.tech = e.target.value; writeHash({ y: S.year, t: S.tech }); drawQ3(); });
  drawAll();
  let rw = 0;
  addEventListener("resize", () => { clearTimeout(rw); rw = setTimeout(drawAll, 150); });
  window.CX.panelFromLink?.();
})();

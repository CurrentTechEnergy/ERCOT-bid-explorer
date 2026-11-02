/* Will fossil turn off? Four questions, each by year from 2019, from data/goal.json.gz
   (pipeline/goal.py, built weekly from the 60-day reports): the floor fossil output holds against
   net load and what sits at it, why the rest stays on in cheap hours and what that costs, whether
   behaviour is changing, and where fossil minimums sit beside curtailed wind
   and solar.  The page only sums and divides what the file holds. */
const { tryJSON, showTip, hideTip, setCSV, setNote, axisFmt, css, esc, readHash, writeHash } = window.CX;
const $ = (id) => document.getElementById(id);
const fmtGW = (mw) => d3.format(",.1f")(mw / 1000);
const fmtPct = d3.format(".0%");
const fmtPt = (v) => `${v >= 0 ? "+" : "−"}${d3.format(".1f")(Math.abs(v) * 100)} pt`;
const fmtTWh = (mwh) => d3.format(",.2f")(mwh / 1e6);
const TECH = { combined_cycle: "Combined cycle", gas_steam: "Gas steam", coal: "Coal", combustion_turbine: "Combustion turbine and recip", nuclear: "Nuclear" };
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
const LOW_NET = 4;             // GW: low load left for fossil, in the answer
const MIN_STUCK_HOURS = 15;    // a stuck-on bar needs this many hours
const PLAY_MS = 800;           // each year's frame when the scatter plays
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
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", H - 6).attr("text-anchor", "end").text("Load less wind and solar HSL less nuclear (GW)");
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
  // fossil equal to the load left for it: where it would sit if it followed load down
  const x0 = Math.max(x.domain()[0], 0);
  svg.append("line").attr("x1", x(x0)).attr("x2", x(x.domain()[1])).attr("y1", y(x0)).attr("y2", y(x.domain()[1]))
    .attr("stroke", css("--muted")).attr("stroke-dasharray", "5 4").attr("stroke-width", 1.2);
  if (!isAll()) svg.append("text").attr("x", m.l + 14).attr("y", m.t + 34).attr("fill", css("--muted"))
    .style("font", "600 30px var(--font-ui)").text(yearLabel(sel));
  const med = F.median[isAll() ? "all" : String(sel)] || [];
  const half = F.bin / 2;
  svg.append("path").attr("d", d3.line().x((r) => x(r[0] + half)).y((r) => y(r[1] / 1000))(med)).attr("fill", "none").attr("stroke", css("--surface")).attr("stroke-width", 5.5);
  svg.append("path").attr("d", d3.line().x((r) => x(r[0] + half)).y((r) => y(r[1] / 1000))(med)).attr("fill", "none").attr("stroke", isAll() ? css("--c2") : css("--c2")).attr("stroke-width", 2.5);
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const nx = x.invert(d3.pointer(ev)[0]), r = med.find((q) => nx >= q[0] && nx < q[0] + F.bin);
      if (!r) return hideTip();
      showTip(ev, `<h4>Load left for fossil ${r[0]} to ${r[0] + F.bin} GW · ${yearName(sel)}</h4><table><tr><td>Median fossil output</td><td class="n">${fmtGW(r[1])} GW</td></tr><tr><td>Hours</td><td class="n">${d3.format(",")(r[2])}</td></tr></table>`);
    })
    .on("pointerleave", hideTip);
  el.replaceChildren(svg.node());
  legend("q1-legend", [[isAll() ? "Hours, all years (darker: more hours)" : `Hours in ${sel} (other years grey)`, isAll() ? "--ink" : "--c1"], ["Median fossil output", "--c2"]]);
  $("q1-legend").insertAdjacentHTML("beforeend", `<span><span class="sw sw-line"></span>Fossil equal to the load left for it</span>`);
  // what is stuck on: average fossil output by net load, at minimum and above it
  const sb = F.stuck_bin, pick = (r) => isAll() || r[0] === sel;
  const hours = d3.rollup(F.hours.filter(pick), (v) => d3.sum(v, (r) => r[2]), (r) => r[1]);
  const bins = [...hours].filter(([, n]) => n >= MIN_STUCK_HOURS).map(([b]) => b).sort((a, b) => a - b);
  const part = (b, t, k) => d3.sum(F.stuck.filter((r) => pick(r) && r[1] === b && r[2] === t), (r) => r[k]) / hours.get(b);
  const keys = [...STUCK_TECHS.map((t) => [t, 3, 1]), ...STUCK_TECHS.map((t) => [t, 4, 0.35])];
  const el2 = $("q1s-chart"), H2 = 280, m2 = { t: 16, r: 14, b: 40, l: 52 };
  // both axes span every year, so they hold still when the year changes (and while it plays)
  const allHours = d3.rollup(F.hours, (v) => d3.sum(v, (r) => r[2]), (r) => r[1]);
  const allBins = [...allHours].filter(([, n]) => n >= MIN_STUCK_HOURS).map(([b]) => b).sort((a, b) => a - b);
  const xb = d3.scaleBand().domain(allBins).range([m2.l, w - m2.r]).padding(0.15);
  const top = d3.max(F.stuck, (r) => r[3] + r[4]) ? d3.max([...new Set(F.hours.map((r) => r[0]))], (yr) => {
    const hy = d3.rollup(F.hours.filter((r) => r[0] === yr), (v) => d3.sum(v, (r) => r[2]), (r) => r[1]);
    return d3.max([...hy].filter(([, n]) => n >= MIN_STUCK_HOURS), ([b, n]) => d3.sum(F.stuck.filter((r) => r[0] === yr && r[1] === b), (r) => r[3] + r[4]) / n);
  }) : 1;
  const y2 = d3.scaleLinear().domain([0, top || 1]).nice().range([H2 - m2.b, m2.t]);
  const s2 = d3.create("svg").attr("viewBox", `0 0 ${w} ${H2}`);
  s2.append("g").attr("class", "gridline").attr("transform", `translate(${m2.l},0)`).call(d3.axisLeft(y2).ticks(5).tickSize(-(w - m2.l - m2.r)).tickFormat(""));
  s2.append("g").attr("class", "axis").attr("transform", `translate(${m2.l},0)`).call(d3.axisLeft(y2).ticks(5).tickFormat((v) => d3.format(",.0f")(v / 1000)).tickSizeOuter(0));
  const every = Math.ceil(allBins.length / (w < 560 ? 6 : 12));
  s2.append("g").attr("class", "axis").attr("transform", `translate(0,${H2 - m2.b})`).call(d3.axisBottom(xb).tickValues(allBins.filter((_, i) => i % every === 0)).tickFormat((b) => `${b}`).tickSizeOuter(0));
  s2.append("text").attr("class", "axis-title").attr("x", m2.l).attr("y", 9).text(`Average fossil output (GW) by load left for fossil, ${yearName(sel)}`);
  s2.append("text").attr("class", "axis-title").attr("x", w - m2.r).attr("y", H2 - 6).attr("text-anchor", "end").text(`Load less wind and solar HSL less nuclear (GW), ${sb} GW bins`);
  bins.forEach((b) => {
    let acc = 0;
    keys.forEach(([t, k, o]) => {
      const v = part(b, t, k);
      if (!v) return;
      s2.append("rect").attr("x", xb(b)).attr("width", xb.bandwidth()).attr("y", y2(acc + v)).attr("height", Math.max(0, y2(acc) - y2(acc + v) - 0.5)).attr("fill", css(TECH_COLOR[t])).attr("opacity", o);
      acc += v;
    });
    s2.append("rect").attr("x", xb(b)).attr("width", xb.bandwidth()).attr("y", m2.t).attr("height", H2 - m2.t - m2.b).attr("fill", "transparent")
      .on("pointermove", (ev) => showTip(ev, `<h4>Load left for fossil ${b} to ${b + sb} GW · ${yearName(sel)}</h4><table><tr><td></td><td class="n">At minimum, GW</td><td class="n">Above, GW</td></tr>` +
        STUCK_TECHS.map((t) => `<tr><td><span class="sw" style="background:var(${TECH_COLOR[t]})"></span> ${TECH[t]}</td><td class="n">${fmtGW(part(b, t, 3))}</td><td class="n">${fmtGW(part(b, t, 4))}</td></tr>`).join("") +
        `<tr><td><b>All fossil</b></td><td class="n"><b>${fmtGW(d3.sum(STUCK_TECHS, (t) => part(b, t, 3)))}</b></td><td class="n"><b>${fmtGW(d3.sum(STUCK_TECHS, (t) => part(b, t, 4)))}</b></td></tr><tr><td>Hours</td><td class="n" colspan="2">${d3.format(",")(hours.get(b))}</td></tr></table>`))
      .on("pointerleave", hideTip);
  });
  el2.replaceChildren(s2.node());
  legend("q1s-legend", [...STUCK_TECHS.map((t) => [`${TECH[t]} at minimum`, TECH_COLOR[t]]), ["Lighter: above minimum", "--c-other", 0.35]]);
  setCSV(el2, ["net_load_bin_gw", "hours", ...STUCK_TECHS.flatMap((t) => [`${t}_at_minimum_mw`, `${t}_above_minimum_mw`])],
    bins.map((b) => [b, hours.get(b), ...STUCK_TECHS.flatMap((t) => [Math.round(part(b, t, 3)), Math.round(part(b, t, 4))])]), `What is stuck on ${yearName(sel)}`);
  setCSV(el, ["load_left_for_fossil_bin_gw", "median_fossil_mw", "hours"], med, `Fossil against the load left for it ${yearName(sel)}`);
  // the answer: the floor in low net load hours, and what sits at it
  const low = (rs) => rs.filter((r) => r[0] + F.bin <= LOW_NET);
  const floorOf = (k) => { const rs = low(F.median[k] || []), n = d3.sum(rs, (r) => r[2]); return n ? d3.sum(rs, (r) => r[1] * r[2]) / n : null; };
  const lowBins = bins.filter((b) => b + sb <= LOW_NET), lh = d3.sum(lowBins, (b) => hours.get(b));
  const lowPart = (t, k) => (lh ? d3.sum(lowBins, (b) => part(b, t, k) * hours.get(b)) / lh : 0);
  const atMin = d3.sum(STUCK_TECHS, (t) => lowPart(t, 3)), above = d3.sum(STUCK_TECHS, (t) => lowPart(t, 4));
  const yrs = years().filter((q) => floorOf(String(q)) != null);
  const f = floorOf(isAll() ? "all" : String(sel));
  // while the years play the text holds still, so the chart below it doesn't move
  if (!S.playing) $("q1-answer").innerHTML = f == null ? `Too few hours with under ${LOW_NET} GW of load left for fossil in ${yearName(sel)} to say.` :
    `<b>Fossil output has a floor it doesn't go below.</b> In hours when the load left for fossil (load less wind and solar available, less nuclear) was under ${LOW_NET} GW, fossil still ran a median of about ${fmtGW(f)} GW (${yearName(sel)}), ` +
    `and in those hours ${fmtGW(atMin)} GW of it was units at their minimum, against ${fmtGW(above)} GW above it: coal ${fmtGW(lowPart("coal", 3))} GW and combined cycles ${fmtGW(lowPart("combined_cycle", 3))} GW. ` +
    `By year the floor was ${yrs.map((q) => `${fmtGW(floorOf(String(q)))} GW in ${q}`).join(", ")}.`;
  setNote($("q1-note"), `Every hour since ${d3.timeFormat("%b %Y")(new Date(S.G.years[years()[0]].from + "T12:00:00"))}: fossil output against the load left for it: load less what wind and solar could have supplied (their HSL), less nuclear, which runs flat at about 5 GW. Where fossil could turn off, its output would follow that load down the dashed line; instead it flattens, and runs above the line into the hours where it pushes wind and solar off. Below, the average fossil output in each band of that load, split into units at their minimum and output above it.`,
    `From the 60-day SCED disclosure, hour by hour. Fossil is coal, combined cycle, gas steam and combustion turbines. The load left for fossil is the output of every fossil unit plus wind and solar output, less the wind and solar available (their HSL): load less what wind and solar could have supplied and less each hour's actual nuclear output; storage and imports are left out. The median line uses ${F.bin} GW bands of it with at least 10 hours. At minimum is the smaller of a running unit's output and its LSL (combined-cycle configurations merged into their train). The dashed line is fossil output equal to the load left for it.`);
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
      svg.append("rect").attr("x", x(y)).attr("width", x.bandwidth()).attr("y", yy(acc + v)).attr("height", Math.max(0, yy(acc) - yy(acc + v) - 0.5)).attr("fill", css(opts.labels[k].color));
      acc += v;
    });
    if (opts.mark) {
      const v = opts.mark(y);
      [[css("--surface"), 5.5], [css("--ink"), 2.5]].forEach(([c, sw]) => svg.append("line").attr("x1", x(y) - 4).attr("x2", x(y) + x.bandwidth() + 4).attr("y1", yy(v)).attr("y2", yy(v)).attr("stroke", c).attr("stroke-width", sw));
    }
    svg.append("rect").attr("x", x(y)).attr("width", x.bandwidth()).attr("y", m.t).attr("height", H - m.t - m.b).attr("fill", "transparent")
      .on("pointermove", (ev) => showTip(ev, `<h4>${yearLabel(y)}</h4><table>` + keys.filter((k) => val(y, k)).reverse().map((k) => `<tr><td>${opts.labels[k].label}</td><td class="n">${tip(val(y, k))}</td></tr>`).join("") +
        `<tr><td><b>Total</b></td><td class="n"><b>${tip(d3.sum(keys, (k) => val(y, k)))}</b></td></tr>` + (opts.mark ? `<tr><td>${opts.markLabel}</td><td class="n">${tip(opts.mark(y))}</td></tr>` : "") + `</table>`))
      .on("pointerleave", hideTip);
  });
  el.replaceChildren(svg.node());
}
// the day-ahead award against staying on through a cheap midday stretch, by technology
const AWARD_GROUPS = [["award", "DAM award", "--c1"], ["self", "Self-committed, no award", "--c3"], ["neither", "Neither", "--c2"], ["no award", "No DAM record", "--c-other"]];
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
    `Coal, combined cycle and gas steam units at minimum in a cheap hour (day-ahead system lambda of $${S.G.cheap}/MWh or less). Each hour costs the unit's cost of running at minimum less its real-time node price (the day-ahead node price when the real-time one is missing), times its LSL; an hour where the node paid more than the cost counts as negative. Real-time in every group: a day-ahead award pays the same whether or not the unit runs, so the choice each hour is to generate or buy the energy back in real time. For gas units that cost is fuel: an EIA average heat rate (7.5 MMBtu/MWh for combined cycles; for gas steam 10.4 raised by 28% to 13.3 for running at minimum, from the price their day-ahead offers ask just above minimum) times the gas price at the unit's own hub, Houston Ship Channel or Waha, on the trading day before (Ship Channel from Jul 2019; where a hub has no price, Henry Hub plus Ship Channel's median basis for the calendar month, or Henry Hub alone for Waha units). Coal is a generic $25/MWh. Units' DAM minimum-energy offers are not used: they are often set to win or avoid commitment rather than at cost. Only output up to the minimum is counted. Groups go hour by hour: a DAM energy award over 0.5 MW that hour; else self-committed when the unit's DAM resource status is on, else neither (from the 60-day DAM disclosure).`);
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
    `Counted: unit-days online in the hour before the day's first run of two or more cheap hours (day-ahead system lambda of $${S.G.cheap}/MWh or less) between HE8 and HE19, with no outage hour in it; stayed online means no offline hour in the run (60-day SCED and DAM disclosures). DAM award: an energy award over 0.5 MW in at least half the run's hours. Self-committed: no award, and the unit's DAM resource status on at the run's first hour. The status comes from the 60-day DAM disclosure, every year from 2019.`);
}

// ==== 3. Is behaviour changing: the loss windows by bucket, and how often each was sat out ======
const Q3_KEYS = ["off", "more", "less", "short", "held"];
const Q3 = {
  off: { label: "Turned off", color: "--c3" },
  more: { label: "Rode through, losing more than a restart", color: "--c7" },
  less: { label: "Rode through, losing less than a restart", color: "--c7-soft" },
  short: { label: "Rode through, too short to cycle", color: "--c4" },
  held: { label: "Held on by a DAM commitment, AS or RUC", color: "--c-other" },
};
const BUCKET_KEYS = ["more", "less", "short", "held"];
const BUCKET_LABEL = { more: "Losing more than a restart", less: "Losing less than a restart", short: "Too short to cycle", held: "Held on by a DAM commitment, AS or RUC" };
function drawQ3() {
  $("q3-tech").value = S.tech;
  if (S.G.q3.off.length && typeof S.G.q3.off[0][2] !== "string") {    // a goal.json from before v7
    $("q3-answer").textContent = "The loss-window breakdown is being rebuilt on the new definition and appears after the next Goal page run.";
    return emptyMsg($("q3-chart"), "Rebuilding.");
  }
  const el = $("q3-chart"), O = S.G.q3.off.map(([year, tech, bucket, n, off, onMwh, offMwh]) => ({ year, tech, bucket, n, off, onMwh, offMwh })).filter((r) => r.tech === S.tech);
  const ys = [...new Set(O.map((r) => r.year))].sort();
  if (!ys.length) return emptyMsg(el, "No loss windows.");
  const row = (y, b) => O.find((r) => r.year === y && r.bucket === b) || { n: 0, off: NaN, onMwh: 0, offMwh: 0 };
  const part = (y, k) => k === "off" ? d3.sum(BUCKET_KEYS, (b) => row(y, b).offMwh) : row(y, k).onMwh;
  const nAll = (y) => d3.sum(BUCKET_KEYS, (b) => row(y, b).n);
  const w = Math.max(300, el.clientWidth || 700), m = { t: 14, r: 14, b: 26, l: 56 };
  stack(el, ys, Q3_KEYS, part, { title: `${TECH[S.tech]} minimum output in its day-ahead loss windows (TWh)`, labels: Q3,
    axis: (v) => d3.format(".0f")(v / 1e6), tip: (v) => `${fmtTWh(v)} TWh` });
  legend("q3-legend", Q3_KEYS.map((k) => [Q3[k].label, Q3[k].color]));
  setCSV(el, ["year", ...Q3_KEYS.map((k) => `${k}_mwh`), ...BUCKET_KEYS.flatMap((b) => [`${b}_windows`, `${b}_turned_off`])],
    ys.map((y) => [y, ...Q3_KEYS.map((k) => Math.round(part(y, k))), ...BUCKET_KEYS.flatMap((b) => [row(y, b).n, row(y, b).off])]), `Loss windows ${S.tech}`);
  // each bucket's share of the windows, and the night share
  const M = S.G.q3.mix.map(([year, tech, n, night, day, off, loss]) => ({ year, tech, n, night, day, off, loss })).filter((r) => r.tech === S.tech);
  const share = (y, b) => row(y, b).n / (nAll(y) || 1);
  const el2 = $("q3m-chart"), H2 = 190, x2 = d3.scalePoint().domain(ys).range([m.l + 20, w - m.r - 20]);
  const y2 = d3.scaleLinear().domain([0, Math.max(0.5, d3.max(ys, (y) => Math.max(...BUCKET_KEYS.map((b) => share(y, b)))), d3.max(M, (r) => r.night) || 0)]).nice().range([H2 - m.b, m.t]);
  const s2 = d3.create("svg").attr("viewBox", `0 0 ${w} ${H2}`);
  s2.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y2).ticks(4).tickSize(-(w - m.l - m.r)).tickFormat(""));
  s2.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y2).ticks(4).tickFormat(fmtPct).tickSizeOuter(0));
  s2.append("g").attr("class", "axis").attr("transform", `translate(0,${H2 - m.b})`).call(d3.axisBottom(x2).tickFormat((y) => (S.G.years[y]?.to.slice(5) === "12-31" ? y : `${y}*`)).tickSizeOuter(0));
  s2.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 9).text("Share of loss windows in each bucket, and starting at night");
  const lines = [...BUCKET_KEYS.map((b) => [b, Q3[b].color, (y) => share(y, b), null]), ["night", "--c1", (y) => (M.find((r) => r.year === y) || {}).night, "4 3"]];
  lines.forEach(([k, c, f, dash]) => {
    const pts = ys.map((y) => [y, f(y)]).filter((p) => p[1] != null && isFinite(p[1]));
    s2.append("path").attr("d", d3.line().x((p) => x2(p[0])).y((p) => y2(p[1]))(pts)).attr("fill", "none").attr("stroke", css(c)).attr("stroke-width", 2).attr("stroke-dasharray", dash);
    pts.forEach((p) => s2.append("circle").attr("cx", x2(p[0])).attr("cy", y2(p[1])).attr("r", 3).attr("fill", css(c)));
  });
  ys.forEach((y) => s2.append("rect").attr("x", x2(y) - 20).attr("width", 40).attr("y", m.t).attr("height", H2 - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => showTip(ev, `<h4>${yearLabel(y)}</h4><table><tr><td>Loss windows</td><td class="n">${d3.format(",")(nAll(y))}</td></tr>` +
      BUCKET_KEYS.map((b) => `<tr><td>${BUCKET_LABEL[b]}</td><td class="n">${fmtPct(share(y, b))}, ${fmtPct(row(y, b).off)} turned off</td></tr>`).join("") +
      `<tr><td>Starting at night (HE20 to HE7)</td><td class="n">${fmtPct((M.find((r) => r.year === y) || {}).night)}</td></tr></table>`))
    .on("pointerleave", hideTip));
  el2.replaceChildren(s2.node());
  legend("q3m-legend", [...BUCKET_KEYS.map((b) => [BUCKET_LABEL[b], Q3[b].color]), ["Starting at night (dashed)", "--c1"]]);
  setCSV(el2, ["year", "windows", ...BUCKET_KEYS.map((b) => `${b}_share`), "night_share", "turned_off", "median_loss_per_mw"],
    ys.map((y) => { const r = M.find((q) => q.year === y) || {}; return [y, nAll(y), ...BUCKET_KEYS.map((b) => share(y, b)), r.night, r.off, r.loss]; }), `Loss window mix ${S.tech}`);
  // the answer: how often units sat out the windows where shutting would have paid, first year against the last full one
  const y0 = ys[0], y1 = fullYears().at(-1), now = ys.at(-1), r0 = row(y0, "more"), r1 = row(y1, "more");
  const dir = r1.off > r0.off * 1.1 ? "more often than" : r1.off < r0.off * 0.9 ? "less often than" : "about as often as";
  const night = (y) => (M.find((r) => r.year === y) || {}).night;
  $("q3-answer").innerHTML = `<b>${TECH[S.tech]} units turn off ${dir} than in ${y0} when shutting would pay.</b> Of the loss windows where a shutdown of at least the unit's minimum off time beat a restart, ` +
    `they turned off for ${fmtPct(r0.off)} of ${d3.format(",")(r0.n)} in ${y0} and ${fmtPct(r1.off)} of ${d3.format(",")(r1.n)} in ${y1}` +
    (now !== y1 ? ` (${fmtPct(row(now, "more").off)} so far in ${yearLabel(now)}, which leans on the spring maintenance months)` : "") +
    `, and ran through ${fmtTWh(r0.onMwh)} and ${fmtTWh(r1.onMwh)} TWh of minimum output in them. ` +
    `Windows too short to cycle were ${fmtPct(share(y0, "short"))} of all loss windows in ${y0} and ${fmtPct(share(y1, "short"))} in ${y1}. ` +
    `${fmtPct(night(y0))} of loss windows started at night (HE20 to HE7) in ${y0}, ${fmtPct(night(y1))} in ${y1}.`;
  setNote($("q3-note"), `Each unit's day-ahead loss windows, by year: the minimum output it turned off, and what it ran through and why. * part year.`,
    `Judged as the operator saw it before the day, with day-ahead prices only. A loss window is the worst run of hours (up to 24) where the unit's gas cost at minimum (as in question 2) is above its day-ahead node price, at most one starting in the day (HE8 to HE19) and one at night (HE20 to HE7), reaching into the next day only from HE14, when its prices are out. ` +
    `A unit is in the decision when it was online the hour before the window (or shut up to 6 hours before it). Its loss is the window's sum of gas cost less node price, times the LSL of the configuration it was running. ` +
    `Held on: a DAM energy award while its DAM status was off (committed by the DAM, eligible for make-whole), a DAM AS award, or RUC (known from Dec 2025) over half the window's hours or more. A self-committed unit's DAM award doesn't count: shutting means buying it back, at an expected price of the day-ahead price. ` +
    `The unit's minimum off time is the 10th percentile of its off spells (2 hours or more offline) in the year before, else 4 hours for combined cycles and 8 for gas steam. Losing more than a restart: some shutdown at least that long, counting any profitable hours it would sit out, saves more than the restart (its hot start offer up to 8 hours off, intermediate beyond; generic $15,000/$25,000 for combined cycles and $10,000/$20,000 for gas steam when none is offered). ` +
    `Too short to cycle: the window is shorter than the minimum off time and no shutdown that long pays. Turned off: an off spell at least the minimum off time long over the window. Output is the LSL times the window's hours, split by the hours online. ` +
    `2021 and 2022 include Winter Storm Uri and the 2022 gas price spike.`);
}

// ==== 4. Curtailment and the fossil minimum beside it ========================================
const Q4_KEYS = ["losing more than a restart", "losing, shutting would not pay", "held on by a DAM commitment, AS or RUC", "covering its costs", "coal", "combustion_turbine"];
const RUN_KEYS = ["restart", "losing", "all", "none"];
const RUN = {
  restart: { label: "Runs if units losing more than a restart shut", color: "--c3" },
  losing: { label: "… if every unit losing money shut", color: "--c1" },
  all: { label: "… only if all fossil at minimum shut", color: "--c-other" },
  none: { label: "Stays curtailed", color: "--c8" },
};
const ECON = {
  "losing more than a restart": { label: "Losing more than a restart costs", color: "--c7" },
  "losing, shutting would not pay": { label: "Losing, but no shutdown would pay", color: "--c7-soft" },
  "held on by a DAM commitment, AS or RUC": { label: "Held on by a DAM commitment, AS or RUC", color: "--c5" },
  "covering its costs": { label: "Covering its costs", color: "--c-other" },
  coal: { label: "Coal", color: "--c8" },
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
    `Curtailment is a wind or solar unit's HSL above its base point (0.5 MW or more), from the 60-day SCED disclosure. An oversupply hour has a real-time hub average (HB_HUBAVG) of $${S.G.over_price}/MWh or less. A unit is behind congestion when its day-ahead node price sits $5 or more below the day-ahead bus average; most curtailment is (West and Panhandle), and shutting a gas unit elsewhere does not make room for it. The fossil split covers oversupply hours with at least 100 MW curtailed not behind congestion. A combined cycle or gas steam unit is losing money in the hours of its day-ahead loss windows (as in question 3). It loses more than a restart when some shutdown of at least its minimum off time would save more than the restart, and it is held on when a DAM commitment, AS or RUC covers half the window or more. Units outside such a window are covering their costs at day-ahead prices. Coal is shown on its own: its cost is a generic one and it mostly shuts by season. "Runs" sums, hour by hour, the smaller of that curtailment and the minimum of the units shut.`);
}

function drawAll() { drawQ1(); drawQ2(); drawQ3(); drawQ4(); }

(async function boot() {
  window.CX.init();
  S.G = await tryJSON("data/goal.json.gz");
  if (!S.G) { $("status").textContent = "Not built yet. The goal page's data is built weekly by its own workflow."; return; }
  const v = readHash();
  const ys = years();
  S.year = v.y === "all" || !v.y ? "all" : ys.includes(+v.y) ? +v.y : "all";
  if (["combined_cycle", "gas_steam"].includes(v.t)) S.tech = v.t;
  $("status").textContent = `60-day data, ${S.G.years[ys[0]].from} to ${S.G.through}. Built ${S.G.built.slice(0, 10)}.`;
  $("q1-year").innerHTML = [`<option value="all"${isAll() ? " selected" : ""}>All years</option>`, ...ys.slice().reverse().map((y) => `<option value="${y}"${y === S.year ? " selected" : ""}>${yearLabel(y)}</option>`)].join("");
  $("q1-year").addEventListener("change", (e) => { S.year = e.target.value === "all" ? "all" : +e.target.value; writeHash({ y: S.year, t: S.tech }); drawQ1(); });
  // play: step the scatter through the years, 2019 first, and stop on the latest
  let play = null;
  const stop = () => {
    if (!play) return;
    clearInterval(play); play = null; S.playing = false; $("q1-play").innerHTML = "&#9654;";
    drawQ1();
  };
  $("q1-play").addEventListener("click", () => {
    if (play) return stop();
    let i = 0;
    S.playing = true;
    const show = () => { S.year = ys[i]; $("q1-year").value = String(S.year); writeHash({ y: S.year, t: S.tech }); drawQ1(); if (++i >= ys.length) stop(); };
    $("q1-play").innerHTML = "&#10073;&#10073;";
    play = setInterval(show, PLAY_MS);
    show();
  });
  $("q1-year").addEventListener("mousedown", stop);
  $("q2c-fuel").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; S.fuel = b.dataset.v; drawQ2(); });
  $("q3-tech").addEventListener("change", (e) => { S.tech = e.target.value; writeHash({ y: S.year, t: S.tech }); drawQ3(); });
  drawAll();
  let rw = 0;
  addEventListener("resize", () => { clearTimeout(rw); rw = setTimeout(drawAll, 150); });
  window.CX.panelFromLink?.();
})();

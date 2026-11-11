/* Will fossil turn off? Four questions, each by year from 2019, from data/goal.json.gz
   (pipeline/goal.py, built weekly from the 60-day reports): the floor fossil output holds against
   net load and what sits at it, why the rest stays on in cheap hours and what that costs, whether
   behavior is changing, and where fossil minimums sit beside curtailed wind
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
const TECH_COLOR = { coal: "--c8", combined_cycle: "--c1", gas_steam: "--c6", combustion_turbine: "--c2" };
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
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", H - 6).attr("text-anchor", "end").text("Load left for fossil, GW (load − wind and solar available − nuclear)");
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
  legend("q1-legend", [[isAll() ? "Hours, all years (darker: more hours)" : `Hours in ${sel} (other years gray)`, isAll() ? "--ink" : "--c1"], ["Median fossil output", "--c2"]]);
  $("q1-legend").insertAdjacentHTML("beforeend", `<span><span class="sw sw-line"></span>Where fossil would sit if it followed the load left for it</span>`);
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
  s2.append("text").attr("class", "axis-title").attr("x", w - m2.r).attr("y", H2 - 6).attr("text-anchor", "end").text(`Load left for fossil, GW (load − wind and solar available − nuclear), ${sb} GW bands`);
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
  const noFloor = years().filter((q) => floorOf(String(q)) == null), fy = fullYears().filter((q) => floorOf(String(q)) != null);
  const trend = fy.length > 1 ? floorOf(String(fy.at(-1))) - floorOf(String(fy[0])) : 0;
  const yrText = yrs.map((q) => `${fmtGW(floorOf(String(q)))} GW ${fullYears().includes(q) ? "in" : "so far in"} ${q}`);
  if (!S.playing) $("q1-answer").innerHTML = f == null ? `Too few hours with under ${LOW_NET} GW of load left for fossil in ${yearName(sel)} to say.` :
    `<b>Fossil output has a floor it doesn't go below.</b> In hours when the load left for fossil (load less wind and solar available, less nuclear) was under ${LOW_NET} GW, ` +
    `fossil still ran about ${fmtGW(atMin + above)} GW on average (median ${fmtGW(f)} GW, ${yearName(sel)}). ` +
    `${fmtGW(atMin)} GW of that was units sitting at their minimum output, which cannot come down without a shutdown: ${fmtGW(lowPart("combined_cycle", 3))} GW of combined cycles and ${fmtGW(lowPart("coal", 3))} GW of coal among them. ` +
    `Only ${fmtGW(above)} GW was output above minimum that could have been cut without one. ` +
    `${Math.abs(trend) >= 500 ? `The floor has ${trend > 0 ? "risen, not fallen" : "fallen"}` : "The median floor by year"}: ${yrText.join(", ")}` +
    `${noFloor.length ? ` (${noFloor.join(" and ")} had too few such hours)` : ""}.`;
  setNote($("q1-note"), `Every hour since ${d3.timeFormat("%b %Y")(new Date(S.G.years[years()[0]].from + "T12:00:00"))}: fossil output against the load left for it: load less what wind and solar could have supplied (their HSL), less nuclear, which runs flat at about 5 GW. Where fossil could turn off, its output would follow that load down the dashed line; instead it flattens, and runs above the line into the hours where it pushes wind and solar off. How far a point sits above the dashed line is exactly the wind and solar curtailed in that hour, because the load left for fossil is fossil output less that curtailment. Points left of zero are hours when wind, solar and nuclear together could have met the load. Below, the average fossil output in each band of that load, split into units at their minimum and output above it.`,
    `From the 60-day SCED disclosure, hour by hour. Fossil is coal, combined cycle, gas steam and combustion turbines. The load left for fossil is the output of every fossil unit plus wind and solar output, less the wind and solar available (their HSL): load less what wind and solar could have supplied and less each hour's actual nuclear output; storage and imports are left out. The median line uses ${F.bin} GW bands of it with at least 10 hours. At minimum is the smaller of a running unit's output and its LSL (combined-cycle configurations merged into their train). The dashed line is fossil output equal to the load left for it.`);
}

// ==== 2. Why the rest stays on: minimum online in cheap hours, by reason, by year =============
function stack(el, ys, keys, val, opts) {
  const tip = opts.tip || ((v) => `${d3.format(",.0f")(v)} MW`);
  const w = Math.max(300, el.clientWidth || 700), m = { t: 14, r: 14, b: 26, l: 56 }, H = opts.height || 260;
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
const AWARD_GROUPS = [["award", "DAM award", "--award"], ["self", "Self-committed, no award", "--seq-hi"], ["neither", "Neither", "--c-other"], ["no award", "No DAM record", "--grid"]];
const Q2_TECHS = ["combined_cycle", "gas_steam", "coal", "combustion_turbine"];
// the cost chart uses the award chart's groups and colors (AWARD_GROUPS, below)
function drawQ2Cost() {
  $("q2c-fuel").querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === S.fuel)));
  const gasOnly = S.fuel === "gas", el = $("q2c-chart");
  const Q = (S.G.q2.cost || []).map(([year, tech, group, mwh, cost]) => ({ year, tech, group, mwh, cost })).filter((r) => !gasOnly || r.tech !== "coal");
  if (!Q.length) return emptyMsg(el, "No cost yet.");
  const ys = years(), keys = AWARD_GROUPS.map((g) => g[0]), labels = Object.fromEntries(AWARD_GROUPS.map(([k, label, color]) => [k, { label, color }]));
  const val = (y, k) => d3.sum(Q.filter((r) => r.year === y && r.group === k), (r) => r.cost);
  stack(el, ys, keys, val, { title: `What staying on at minimum lost ${gasOnly ? "gas units" : "fossil units"} in cheap hours ($ million)`, labels, axis: (v) => d3.format(",.0f")(v / 1e6), tip: (v) => `$${d3.format(",.1f")(v / 1e6)}M`, height: 200 });
  legend("q2c-legend", AWARD_GROUPS.filter(([k]) => Q.some((r) => r.group === k)).map(([, label, c]) => [label, c]));
  setCSV(el, ["year", "tech", "group", "minimum_mwh", "cost_usd"], Q.map((r) => [r.year, r.tech, r.group, r.mwh, r.cost]), "Loss from staying on");
  const tot = (y) => d3.sum(keys, (k) => val(y, k)), fy = fullYears(), now = ys.at(-1);
  const big = fy.reduce((a, b) => (tot(b) > tot(a) ? b : a), fy[0]), all = d3.sum(ys, tot);
  const coal = d3.sum((S.G.q2.cost || []).filter((r) => r[1] === "coal"), (r) => r[4]);
  const per = (f) => d3.sum(Q.filter(f), (r) => r.cost) / (d3.sum(Q.filter(f), (r) => r.mwh) || 1);
  const M = (v) => `$${d3.format(",.0f")(v / 1e6)}M`, last = fy.at(-1);
  const [pa, pn] = window.CX.fmtPair([per((r) => r.group === "award"), per((r) => r.group !== "award")], "$/MWh");
  S.q2cost = `Staying on at minimum through cheap hours cost ${gasOnly ? "gas" : "fossil"} units ${M(tot(last))} in ${last}` +
    (now !== last ? ` and ${M(tot(now))} so far in ${now}` : "") + (big !== last ? `, with ${big} the worst year at ${M(tot(big))}` : "") +
    (gasOnly ? `; ${M(all)} since ${ys[0]}, leaving out coal's ${M(coal)}.` : `; coal carries ${M(coal)} of the ${M(all)} since ${ys[0]}.`) +
    ` Hours held on by a day-ahead award lost about as much at real-time prices (${pa}) as hours without one (${pn}).`;
  setNote($("q2c-note"), `The loss from staying on: what fossil units at minimum paid, in running cost above the real-time price, by staying on through cheap hours rather than shutting down. It is the money a unit willing to cycle would have kept. Grouped as the chart below. * part year.`,
    `Coal, combined cycle and gas steam units at minimum in a cheap hour (day-ahead system lambda of $${S.G.cheap}/MWh or less). Each hour's loss is the unit's cost of running at minimum less its real-time node price (the day-ahead node price when the real-time one is missing), times its LSL; an hour where the node paid more than the cost counts as negative. Real-time in every group: a day-ahead award pays the same whether or not the unit runs, so the choice each hour is to generate or buy the energy back in real time. For gas units that cost is fuel: the unit's own heat rate at minimum, measured from EPA's hourly stack data as fuel burned per MWh of the unit's ERCOT net output when it ran at minimum (2019 to Nov 2025; a median 13.4 MMBtu/MWh for gas steam and 7.8 for combined cycles, used for units without enough hours), times the gas price at the unit's own hub, Houston Ship Channel or Waha, on the trading day before (Ship Channel from Jul 2019; where a hub has no price, Henry Hub plus Ship Channel's median basis for the calendar month, or Henry Hub alone for Waha units). Coal is its heat rate at minimum (a median 11.9) times its delivered coal price that month from EIA-923: the plant's own where it reports one (Fayette, J K Spruce, San Miguel), else the average of the Texas plants that report subbituminous coal (about $1.80/MMBtu), so about $22/MWh for most units. Units' DAM minimum-energy offers are not used: they are often set to win or avoid commitment rather than at cost. Only output up to the minimum is counted. Groups go hour by hour: a DAM energy award over 0.5 MW that hour; else self-committed when the unit's DAM resource status is on, else neither (from the 60-day DAM disclosure). No DAM record: hours with no day-ahead status for the unit at all.`);
}
function drawQ2() {
  drawQ2Cost();
  const R = S.G.q2.award.map(([year, tech, group, n, stayed]) => ({ year, tech, group, n, stayed }));
  const el = $("q2a-chart");
  if (!R.length) return emptyMsg(el, "No cheap midday stretches.");
  const y = d3.max(R.filter((r) => r.group === "self"), (r) => r.year) || d3.max(R, (r) => r.year);
  const get = (t, k) => R.find((r) => r.year === y && r.tech === t && r.group === k) || { n: 0, stayed: 0 };
  const rows = Q2_TECHS.flatMap((t) => AWARD_GROUPS.filter(([k]) => get(t, k).n).map(([k, label, c]) => ({ t, k, label, c, ...get(t, k) })));
  $("q2a-title").textContent = `Units online going into a cheap midday stretch, ${yearLabel(y)}: share that turned off during it`;
  // one small panel per technology: two columns on a wide screen, stacked on a narrow one
  const W = Math.max(300, el.clientWidth || 700), cols = W >= 900 ? 2 : 1, cg = 40, w = (W - cg * (cols - 1)) / cols;
  const m = { t: 22, r: 52, b: 22, l: 166 }, band = 30, bh = 20;
  const x = d3.scaleLinear().domain([0, 1]).range([m.l, w - m.r]);
  const per = Q2_TECHS.map((t) => rows.filter((r) => r.t === t)).filter((g) => g.length);
  const ph = m.t + d3.max(per, (g) => g.length) * band + m.b, nr = Math.ceil(per.length / cols), H = nr * ph + (nr - 1) * 14;
  const svg = d3.create("svg").attr("viewBox", `0 0 ${W} ${H}`);
  per.forEach((g, gi) => {
    const p = svg.append("g").attr("transform", `translate(${(gi % cols) * (w + cg)},${Math.floor(gi / cols) * (ph + 14)})`), base = ph - m.b;
    p.append("text").attr("x", 0).attr("y", 12).attr("class", "axis-label").attr("fill", css("--ink")).style("font-weight", 600).text(TECH[g[0].t]);
    p.append("g").attr("class", "gridline").attr("transform", `translate(0,${base})`).call(d3.axisBottom(x).ticks(w < 500 ? 2 : 4).tickSize(-(base - m.t)).tickFormat(""));
    p.append("g").attr("class", "axis").attr("transform", `translate(0,${base})`).call(d3.axisBottom(x).ticks(w < 500 ? 2 : 4).tickFormat(fmtPct).tickSizeOuter(0));
    g.forEach((r, i) => {
      const v = 1 - r.stayed / r.n, top = m.t + i * band + (band - bh) / 2;
      p.append("rect").attr("x", x(0)).attr("y", top).attr("width", x(v) - x(0)).attr("height", bh).attr("fill", css(r.c));
      p.append("text").attr("x", x(v) + 6).attr("y", top + bh / 2).attr("dy", "0.35em").attr("class", "bar-val").attr("fill", css("--ink")).style("font-weight", 600).text(d3.format(".1%")(v));
      const t = p.append("text").attr("x", m.l - 8).attr("y", top + bh / 2).attr("text-anchor", "end").attr("class", "axis-label").attr("fill", css("--ink"));
      t.append("tspan").attr("x", m.l - 8).attr("dy", "-0.15em").text(r.label);
      t.append("tspan").attr("x", m.l - 8).attr("dy", "1.1em").attr("fill", css("--muted")).style("font-size", "0.85em").text(`${d3.format(",")(r.n)} unit-days`);
    });
  });
  el.replaceChildren(svg.node());
  setCSV(el, ["year", "tech", "group", "unit_days", "turned_off", "share_turned_off"], R.map((r) => [r.year, r.tech, r.group, r.n, r.n - r.stayed, r.n ? +(1 - r.stayed / r.n).toFixed(4) : null]), "Award and turning off");
  const p = (t, k) => d3.format(".1%")(1 - get(t, k).stayed / Math.max(1, get(t, k).n));
  $("q2-answer").innerHTML = `<b>A day-ahead award or a self-commitment keeps a unit on; the price does not turn it off.</b> In ${yearLabel(y)}, combined cycles going into a cheap midday stretch with a day-ahead award turned off during it only ${p("combined_cycle", "award")} of the time, self-committed ones ${p("combined_cycle", "self")}, and those with neither ${p("combined_cycle", "neither")}. Coal and gas steam stay on almost regardless: only ${p("coal", "self")} of self-committed coal and ${p("gas_steam", "self")} of self-committed gas steam turned off.` + (S.q2cost ? ` ${S.q2cost}` : "");
  setNote($("q2-note"), `Two views of the same groups: first what staying on through cheap hours cost, by year; then, for units online going into the day's first cheap midday stretch, the share that turned off during it, by whether a day-ahead award, their own commitment or neither had them on. Combined-cycle configurations count as one train. * part year.`,
    `Counted: unit-days online in the hour before the day's first run of two or more cheap hours (day-ahead system lambda of $${S.G.cheap}/MWh or less) between HE 8 and HE 19, with no outage hour in it; turned off means at least one offline hour in the run (60-day SCED and DAM disclosures). DAM award: an energy award over 0.5 MW in at least half the run's hours. Self-committed: no award, and the unit's DAM resource status on at the run's first hour. The status comes from the 60-day DAM disclosure, every year from 2019.`);
}

// ==== 3. Is behavior changing: each unit where shutting pays, units that cycle by loss, the window mix ====
const Q3_BUCKETS = ["more", "less", "short", "held_mw", "held"];
const Q3B = {
  more: { label: "Loss above restart cost (shutting would have paid)", color: "--loss" },
  less: { label: "Loss below restart cost", color: "--loss-soft" },
  short: { label: "Too short to cycle", color: "--c4" },
  held_mw: { label: "Held on by the make-whole and ancillary-service pay it would give up", color: "--c7-soft" },
  held: { label: "Held on by ERCOT (RUC), or by a day-ahead AS award before Dec 5, 2025", color: "--c7" },     // purple wherever RUC is marked
};
const BAND_KEYS = ["over $200", "$50 to $200", "under $50"];
const BAND_COLOR = { "over $200": "--c8", "$50 to $200": "--c2", "under $50": "--c4" };
const POSITION_KEYS = ["none", "self", "committed", "as"];
const POSITION = {
  none: ["No day-ahead award", "Sold nothing day-ahead; free to shut."],
  self: ["Sold energy day-ahead", "Self-committed (status ON) with an energy award near its minimum or more: no make-whole; shutting means buying it back in real time."],
  committed: ["DAM committed", "The day-ahead market committed it on its offer. Its energy could be bought back in real time, but shutting would forgo any make-whole payment, if applicable."],
  as: ["Ancillary services only", "Holds a day-ahead AS award, bought back at the real-time price (from Dec 5, 2025)."]
};
const POS_THIN = 30;     // windows: a cell with fewer is greyed
const yTick = (y) => (S.G.years[y]?.to.slice(5) === "12-31" ? y : `${y}*`);
function drawQ3() {
  $("q3-tech").value = S.tech;
  const q = S.G.q3;
  if (!q.units) {      // a goal.json from before v11
    $("q3-answer").textContent = "Question 3 is being rebuilt by unit and appears after the next Goal page run.";
    ["q3h-chart", "q3s-chart", "q3-chart"].forEach((id) => emptyMsg($(id), "Rebuilding."));
    return;
  }
  const t = S.tech, base = q.base_years, b0 = base[0], b1 = base.at(-1);
  // ---- every unit, every year: share turned off of its windows where shutting pays
  const never = new Set(q.never.filter((r) => r[1] === t).map((r) => r[0]));
  const byT = d3.group(q.units.filter((r) => r[1] === t && r[3] >= q.unit_min), (r) => r[0]);
  never.forEach((tr) => { if (!byT.has(tr)) byT.set(tr, []); });
  const almost = new Map((q.almost || []).filter((r) => r[1] === t).map((r) => [r[0], { n: r[2], off: r[3] }]));
  almost.forEach((_, tr) => { if (!byT.has(tr)) byT.set(tr, []); });
  const everN = d3.rollup(q.units.filter((r) => r[1] === t), (v) => d3.sum(v, (r) => r[3]), (r) => r[0]);
  const T = [...byT].map(([tr, rs]) => {
    const mean = (f) => { const v = rs.filter(f); return v.length ? d3.mean(v, (r) => r[4]) : null; };
    return { tr, lsl: d3.median(rs, (r) => r[5]) ?? null, cells: rs.map((r) => ({ y: r[2], n: r[3], v: r[4] })),
      early: mean((r) => r[2] >= b0 && r[2] <= b1), late: mean((r) => r[2] >= 2024), never: never.has(tr), almost: almost.get(tr) };
  });
  // groups top to bottom: units that cycle, too few windows early or late, almost never off, never off
  const key = (r) => (r.never ? 3 : r.almost ? 2 : r.early == null || r.late == null ? 1 : 0);
  T.sort((a, b) => key(a) - key(b) || (key(a) >= 2 ? (a.almost ? a.almost.off / a.almost.n : 0) - (b.almost ? b.almost.off / b.almost.n : 0) :
    ((a.late ?? 0) - (a.early ?? 0)) - ((b.late ?? 0) - (b.early ?? 0))) || a.tr.localeCompare(b.tr));
  const ys = years();
  {
    const el = $("q3h-chart"), w = Math.max(320, el.clientWidth || 700), rh = 14, narrow = w < 560, m = { t: 22, r: narrow ? (T.some((r) => r.almost || r.never) ? 62 : 44) : 64, b: 6, l: narrow ? 104 : 150 };
    // a one-row gap at the almost-never-off break carries the last column's second header ("times off")
    const na = T.findIndex((r) => key(r) >= 2), nb = T.findIndex((r) => key(r) === 3), gapAt = na;
    const rowY = (i) => m.t + i * rh + (gapAt >= 0 && i >= gapAt ? rh : 0);
    const H = m.t + rh * (T.length + (gapAt >= 0 ? 1 : 0)) + m.b;
    const x = d3.scaleBand().domain(ys).range([m.l, w - m.r]).paddingInner(0.06);
    const col = d3.scaleSequential(d3.interpolateRgb(css("--grid"), css("--c1"))).domain([0, 1]);
    const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
    ys.forEach((y) => svg.append("text").attr("x", x(y) + x.bandwidth() / 2).attr("y", 14).attr("text-anchor", "middle").attr("font-size", 11).attr("fill", css("--muted")).text(narrow ? `'${String(y).slice(2)}` : yTick(y)));
    svg.append("text").attr("x", w - m.r + 6).attr("y", 14).attr("font-size", 11).attr("fill", css("--muted")).text("change, pt");
    T.forEach((r, i) => {
      const y0 = rowY(i);
      // the unit's name opens its Unit page (decision history and its own yearly strip)
      const a = svg.append("a").attr("href", `unit.html?unit=${encodeURIComponent(r.tr)}`).attr("class", "q3h-unit");
      a.append("title").text(`Open ${r.tr}'s unit page`);
      a.append("text").attr("x", m.l - 6).attr("y", y0 + rh - 3).attr("text-anchor", "end").attr("font-size", 11).attr("fill", css("--accent"))
        .text(narrow || r.lsl == null ? r.tr : `${r.tr} · ${d3.format(",")(r.lsl)} MW`);
      const d = r.early != null && r.late != null ? r.late - r.early : null;
      r.cells.forEach((c) => svg.append("rect").attr("x", x(c.y)).attr("y", y0 + 1).attr("width", x.bandwidth()).attr("height", rh - 2).attr("fill", col(c.v))
        .on("pointermove", (ev) => showTip(ev, `<h4>${esc(r.tr)}, ${c.y}${yearLabel(c.y) === String(c.y) ? "" : "*"}</h4><table>` +
          `<tr><td>Turned off for</td><td class="n">${fmtPct(c.v)}</td></tr><tr><td>Windows where shutting paid</td><td class="n">${c.n}</td></tr>` +
          (r.lsl != null ? `<tr><td>Minimum output</td><td class="n">${d3.format(",")(r.lsl)} MW</td></tr>` : "") +
          (r.almost || r.never ? `<tr><td>Turned off, whole record</td><td class="n">${r.almost ? r.almost.off : 0} of ${d3.format(",")(r.almost ? r.almost.n : everN.get(r.tr) || 0)}</td></tr>` : "") +
          (d != null ? `<tr><td>Change, ${b0}–${String(b1).slice(2)} to 2024 on</td><td class="n">${d > 0 ? "+" : d < 0 ? "−" : ""}${Math.abs(Math.round(100 * d))} pt</td></tr>` : "") +
          `</table>${yearLabel(c.y) === String(c.y) ? "" : `<p class="tip-pin-note">* ${esc(yearLabel(c.y).slice(6, -1))}</p>`}<p class="tip-pin-note">Click the name for its unit page</p>`))
        .on("pointerleave", hideTip));
      if (r.almost || r.never) {
        const n = r.almost ? r.almost.n : everN.get(r.tr) || 0;
        svg.append("text").attr("x", w - m.r + 6).attr("y", y0 + rh - 3).attr("font-size", 11).attr("fill", css("--muted"))
          .text(`${r.almost ? r.almost.off : 0} of ${d3.format(",")(n)}`).append("title").text(`Turned off for ${r.almost ? r.almost.off : 0} of its ${d3.format(",")(n)} windows where shutting would have paid, whole record`);
      } else if (r.early != null && r.late != null) {
        const d = r.late - r.early;
        svg.append("text").attr("x", w - m.r + 6).attr("y", y0 + rh - 3).attr("font-size", 11).attr("fill", css(d < -0.2 ? "--c8" : d > 0.2 ? "--c3" : "--muted"))
          .text(`${d > 0 ? "+" : d < 0 ? "−" : ""}${Math.abs(Math.round(100 * d))} pt`);
      }
    });
    if (gapAt >= 0) svg.append("text").attr("x", w - m.r + 6).attr("y", rowY(gapAt) - 4).attr("font-size", 11).attr("fill", css("--muted")).text("times off");
    if (na > 0 && na !== nb) svg.append("line").attr("x1", m.l).attr("x2", w - m.r).attr("y1", rowY(na) - rh / 2).attr("y2", rowY(na) - rh / 2).attr("stroke", css("--muted")).attr("stroke-dasharray", "1 3");
    if (nb > 0) { const yb = nb === na ? rowY(nb) - rh / 2 : rowY(nb); svg.append("line").attr("x1", m.l).attr("x2", w - m.r).attr("y1", yb).attr("y2", yb).attr("stroke", css("--ink")).attr("stroke-dasharray", "3 3"); }
    el.replaceChildren(svg.node());
    const ex = T.find((r) => r.almost);
    $("q3h-legend").innerHTML = `<span>Each cell: of the unit's loss windows where shutting would have paid, the share it turned off for (${q.unit_min} such windows or more). Light = rode through, dark = turned off. Biggest drop first. Below the dotted line, almost never off: turned off for 2% or fewer of 20 or more such windows over the record; below the dashed line, never off: none of 20 or more. For units below the dotted line, the last column is the number of times it turned off out of its windows where shutting would have paid, over the whole record${ex ? ` (${esc(ex.tr)}: ${ex.almost.off} of ${d3.format(",")(ex.almost.n)})` : ""}; a change in points means little for a unit that is almost always on. Beside each name, its minimum output (LSL). Change: 2024 on against ${b0} to ${b1}, in percentage points.</span>`;
    setCSV(el, ["train", "lsl_mw", ...ys.map(String), "early", "late", "never_off", "almost_never_off"], T.map((r) => [r.tr, r.lsl, ...ys.map((y) => (r.cells.find((c) => c.y === y) || {}).v ?? ""), r.early, r.late, r.never, !!r.almost]), `Units ${t}`);
    const both = T.filter((r) => key(r) === 0), fell = both.filter((r) => r.late < r.early - 0.2).length, rose = both.filter((r) => r.late > r.early + 0.2).length;
    $("q3h-text").textContent = `Of the ${both.length} ${TECH[t].toLowerCase()} units with such windows in both ${b0} to ${b1} and 2024 on, ${fell} now turn off at least 20 percentage points less often than they did, ${rose} ${rose === 1 ? "turns" : "turn"} off at least 20 points more often, and ${both.length - fell - rose} are within 20 points. ${never.size} ${never.size === 1 ? "unit has" : "units have"} never turned off where shutting would have paid, and ${almost.size} almost never.`;
    const un = (q.untested || []).filter((r) => r[1] === t).sort((a, b) => a[0].localeCompare(b[0]));
    $("q3h-untested").innerHTML = un.length ? `Never turned off, but never had 20 windows where shutting paid, so not judged: ` +
      un.map((r) => `<a href="unit.html?unit=${encodeURIComponent(r[0])}">${esc(r[0])}</a> (${r[2]})`).join(", ") + `.` : "";
  }
  // ---- units that cycle, by size of loss
  {
    const B = q.bands.filter((r) => r[1] === t).map(([year, , band, n, off]) => ({ year, band, n, off }));
    const bv = (band, y) => B.find((r) => r.band === band && r.year === y) || { n: 0, off: NaN };
    const el = $("q3s-chart"), w = Math.max(300, el.clientWidth || 700), m = { t: 14, r: 90, b: 26, l: 56 }, H = 260;
    const x = d3.scalePoint().domain(ys).range([m.l + 20, w - m.r - 20]);
    const y = d3.scaleLinear().domain([0, Math.max(0.8, d3.max(B, (r) => r.off) || 0)]).nice().range([H - m.b, m.t]);
    const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
    svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
    svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickFormat(fmtPct).tickSizeOuter(0));
    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickFormat((v) => (w < 560 ? `'${String(v).slice(2)}` : yTick(v))).tickSizeOuter(0));
    svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 9).text(`${TECH[t]} units that cycle: share of loss windows turned off, by loss from staying on ($/MW of LSL)`);
    BAND_KEYS.forEach((k) => {
      const pts = ys.map((yy) => [yy, bv(k, yy)]).filter((p) => p[1].n >= 30);
      const c = css(BAND_COLOR[k]);
      svg.append("path").attr("d", d3.line().x((p) => x(p[0])).y((p) => y(p[1].off))(pts)).attr("fill", "none").attr("stroke", c).attr("stroke-width", 2.5);
      pts.forEach((p) => svg.append("circle").attr("cx", x(p[0])).attr("cy", y(p[1].off)).attr("r", 3.5).attr("fill", c));
      const lp = pts.at(-1);
      if (lp) svg.append("text").attr("x", x(lp[0]) + 10).attr("y", y(lp[1].off) + 4).attr("fill", c).attr("font-size", 12).attr("font-weight", 600).text(k);
    });
    ys.forEach((yy) => svg.append("rect").attr("x", x(yy) - 20).attr("width", 40).attr("y", m.t).attr("height", H - m.t - m.b).attr("fill", "transparent")
      .on("pointermove", (ev) => showTip(ev, `<h4>${yearLabel(yy)}</h4><table><tr><td>Loss from staying on</td><td class="n">Turned off</td><td class="n">Windows</td></tr>` +
        BAND_KEYS.map((k) => `<tr><td>${k}/MW</td><td class="n">${fmtPct(bv(k, yy).off)}</td><td class="n">${d3.format(",")(bv(k, yy).n)}</td></tr>`).join("") + `</table>`))
      .on("pointerleave", hideTip));
    el.replaceChildren(svg.node());
    legend("q3s-legend", BAND_KEYS.map((k) => [k, BAND_COLOR[k]])); $("q3s-legend").insertAdjacentHTML("afterbegin", "<span>Loss from staying on, per MW of minimum output over the window:</span>");
    setCSV(el, ["year", ...BAND_KEYS.flatMap((k) => [`${k} turned off`, `${k} windows`])], ys.map((yy) => [yy, ...BAND_KEYS.flatMap((k) => [bv(k, yy).off, bv(k, yy).n])]), `Cycling units by loss ${t}`);
  }
  // ---- the windows themselves: share in each bucket
  const O = q.off.filter((r) => r[1] === t).map(([year, , bucket, n, off]) => ({ year, bucket, n, off }));
  const row = (y, b) => O.find((r) => r.year === y && r.bucket === b) || { n: 0, off: NaN };
  const nAll = (y) => d3.sum(Q3_BUCKETS, (b) => row(y, b).n);
  const yo = [...new Set(O.map((r) => r.year))].sort();
  stack($("q3-chart"), yo, Q3_BUCKETS, (y, b) => row(y, b).n / (nAll(y) || 1), { title: `${TECH[t]} loss windows by bucket (share)`, labels: Q3B,
    axis: (v) => `${Math.round(100 * v)}%`, tip: (v) => fmtPct(v) });
  legend("q3-legend", Q3_BUCKETS.map((b) => [Q3B[b].label, Q3B[b].color]));
  setCSV($("q3-chart"), ["year", "windows", ...Q3_BUCKETS.flatMap((b) => [`${b}_windows`, `${b}_turned_off`])], yo.map((y) => [y, nAll(y), ...Q3_BUCKETS.flatMap((b) => [row(y, b).n, row(y, b).off])]), `Loss windows ${t}`);
  const M = q.mix.filter((r) => r[1] === t).map(([year, , n, night, day]) => ({ year, day }));
  const day = (y) => (M.find((r) => r.year === y) || {}).day;
  const yl0 = yo[0], ylast = yo.at(-1);
  $("q3-day").textContent = `Loss windows have moved from night to midday: ${fmtPct(day(ylast))} start in the day (HE 8 to HE 19) ${ylast === fullYears().at(-1) ? "in" : "so far in"} ${ylast}, against ${fmtPct(day(yl0))} in ${yl0}, because solar growth moved the cheap hours to midday. "Held on" falls to almost nothing from Dec 5, 2025 because, under real-time co-optimization (RTC+B), a day-ahead ancillary-service award no longer holds a unit on: a market rule change, not a change in how units behave.`;
  // ---- where shutting pays, by DAM position: positions down, years across (base years pooled), share turned off
  const P = (q.position || []).map(([year, tech, pos, n, off, rt]) => ({ year, tech, pos, n, off, rt })).filter((r) => r.tech === t);
  const pool = (rs) => {
    const n = d3.sum(rs, (r) => r.n), k = rs.filter((r) => r.rt != null), nk = d3.sum(k, (r) => r.n);
    return n ? { n, off: d3.sum(rs, (r) => r.n * r.off) / n, rt: nk ? d3.sum(k, (r) => r.n * r.rt) / nk : null } : null;
  };
  const pcell = (y, p) => pool(P.filter((r) => r.pos === p && (y === "base" ? base.includes(r.year) : r.year === y)));
  const pYears = ["base", ...[...new Set(P.map((r) => r.year))].filter((y) => y > b1).sort()];
  const pKeys = POSITION_KEYS.filter((p) => P.some((r) => r.pos === p));
  const pLabel = (y) => (y === "base" ? `${b0}–${String(b1).slice(2)}` : yearLabel(y) === String(y) ? String(y) : `${y}*`);
  if (P.length) {
    const yp = fullYears().at(-1), none = pcell(yp, "none"), none0 = pcell("base", "none");
    const aw = pKeys.filter((p) => p !== "none").map((p) => pcell(yp, p)).filter((c) => c && c.n >= POS_THIN).map((c) => c.off);
    const all = pool(P.filter((r) => r.year === yp)), per = pKeys.map((p) => pcell(yp, p)).filter((c) => c && c.n >= POS_THIN && c.rt != null).map((c) => c.rt);
    const tl = TECH[t].toLowerCase();
    $("q3p-table").innerHTML =
      `<h3 class="sub-h">Does a day-ahead position keep units on?</h3>` +
      (none && aw.length ? `<p class="intro"><b>${aw.every((v) => v < 0.15) ? "Yes. A day-ahead position almost always keeps a unit on." : "Partly."}</b> With no award, ${tl} units turned off for ${fmtPct(none.off)} of these windows in ${yp}${none0 ? ` (${fmtPct(none0.off)} in ${b0} to ${b1})` : ""}. With any award they turned off for ${aw.length > 1 ? `${fmtPct(d3.min(aw))} to ${fmtPct(d3.max(aw))}` : fmtPct(aw[0])}, even though the award could have been bought back.</p>` : "") +
      `<div class="q3p-scroll"><table class="data q3p"><thead><tr><th class="t">Day-ahead position</th>` + pYears.map((y) => `<th>${pLabel(y)}</th>`).join("") + `</tr></thead><tbody>` +
      pKeys.map((p) => `<tr><td class="t q3p-pos"><b>${POSITION[p][0]}</b><span>${POSITION[p][1]}</span></td>` + pYears.map((y) => {
        const c = pcell(y, p);
        return c ? `<td class="${c.n < POS_THIN ? "thin" : ""}"><span class="v">${fmtPct(c.off)}</span><span class="n">${d3.format(",")(c.n)}</span><span class="bar"><i style="width:${(100 * c.off).toFixed(1)}%"></i></span></td>` : `<td class="thin">–</td>`;
      }).join("") + `</tr>`).join("") + `</tbody></table></div>` +
      `<p class="legend">Each cell: the share of windows where the unit actually shut down when shutting would have had positive economics (after the restart and any other financial benefits a shutdown gives up). The small number is how many such windows there were; gray under ${POS_THIN}. ${b0} to ${b1} pooled as the baseline. * part year.</p>` +
      (all && all.rt != null && per.length ? `<p class="day-flag q3p-check">Hindsight check: the same shutdown would also have paid at real-time prices in ${fmtPct(all.rt)} of ${yp}'s windows (${fmtPct(d3.min(per))} to ${fmtPct(d3.max(per))} across positions), so the day-ahead loss was usually a fair guide.</p>` : "");
    setCSV($("q3p-table"), ["year", "position", "windows", "turned_off", "paid_at_rt"], P.map((r) => [r.year, r.pos, r.n, r.off, r.rt ?? ""]), `Positions ${t}`);
  } else $("q3p-table").innerHTML = "";
  // ---- the answer
  const E = q.extra.filter((r) => r[1] === t).map(([year, , trains, on, atBase]) => ({ year, trains, on, atBase }));
  const yf = fullYears().at(-1), e = E.find((r) => r.year === yf), more = (y) => row(y, "more");
  const m0 = d3.sum(base, (y) => more(y).n * more(y).off) / (d3.sum(base, (y) => more(y).n) || 1);
  const less = e && e.on > e.atBase * 1.1;
  const offNow = more(yf).off, dir = offNow < m0 - 0.05 ? "less" : offNow > m0 + 0.05 ? "more" : "same";
  const [tOn, tBase, tMore] = e ? window.CX.fmtPair([e.on / 1e6, e.atBase / 1e6, Math.abs(e.on - e.atBase) / 1e6], "TWh", { dp: 2 }) : [];
  $("q3-answer").innerHTML = `<b>${dir === "less" ? `Yes, and in the wrong direction: ${TECH[t].toLowerCase()} units turn off less often than they used to.` : dir === "more" ? `Yes: ${TECH[t].toLowerCase()} units turn off more often than they used to.` : "Not clearly."}</b> ` +
    `Where a shutdown would have paid even after the restart, they turned off for ${fmtPct(m0)} of such windows in ${b0} to ${b1} and ${fmtPct(offNow)} in ${yf}. ` +
    (e ? `At their ${b0} to ${b1} habits they would have kept ${tBase} of minimum output on through those windows in ${yf}; they actually kept on ${tOn}, ${tMore} ${e.on >= e.atBase ? "more" : "less"}, about ${d3.format(",.0f")(Math.abs(e.on - e.atBase) / 8760)} MW around the clock. ` : "") +
    `Each unit is shown below.`;
  setNote($("q3-note"), `Each unit's day-ahead loss windows: how often it turned off where shutting would have paid, year by year; units that cycle by the size of the loss; and what the windows look like. * part year.`,
    `Judged as the operator saw it before the day, with day-ahead prices only. A loss window is the worst run of hours (up to 24) where the unit's gas cost at minimum (as in question 2) is above its day-ahead node price, at most one starting in the day (HE 8 to HE 19) and one at night (HE 20 to HE 7), reaching into the next day only from HE 14, when its prices are out. ` +
    `\n\nA unit is in the decision when it was online the hour before the window (or shut up to 6 hours before it). Its loss is the window's sum of gas cost less node price, times the LSL of the configuration it was running. ` +
    `\n\nA DAM award doesn't hold a unit on: shutting means buying the energy back in real time, at an expected price of the day-ahead price, and since RTC+B (Dec 5, 2025) the same holds for DAM AS awards, bought back at the real-time AS price. What a shutdown gives up is counted against it instead: the DAM make-whole a DAM-committed unit is paid only while online (ERCOT Protocols 4.6.2.3; its minimum-energy offer less the day-ahead price and AS revenue over the commitment, plus the start offer when the DAM started it), and from Dec 5, 2025 the AS revenue its capacity would carry. Held on: RUC (known from Dec 2025), or before Dec 5, 2025 a DAM AS award, over half the window's hours or more; or a shutdown beats the restart but not the restart plus what it gives up. ` +
    `\n\nThe unit's minimum off time is the 10th percentile of its off spells (2 hours or more offline) in the year before, else 4 hours for combined cycles and 8 for gas steam. Loss above restart cost: some shutdown at least that long, counting any profitable hours it would sit out, saves more than the restart and what it gives up (its hot start offer up to 8 hours off, intermediate beyond; generic $15,000/$25,000 for combined cycles and $10,000/$20,000 for gas steam when none is offered). ` +
    `\n\nToo short to cycle: the window is shorter than the minimum off time and no shutdown that long pays. The day-ahead position table splits the windows where shutting pays by the unit's DAM position over half the window or more (DAM committed first, then AS only, then an energy award). The hindsight check under it is the share of all those windows, turned off or not, where the same shutdown also paid at real-time node and AS prices, less the margin above LSL it would give up; it is not used for the buckets. \n\nTurned off: an off spell at least the minimum off time long over the window. Output is the LSL times the window's hours, split by the hours online. ` +
    `By unit: a unit's share is over its windows with a loss above restart cost (shutting would have paid), shown with ${q.unit_min} or more in the year. Never off: no shutdown in any window where shutting would have paid over the whole record, with 20 or more of them. An off spell that is mostly outage (or has under 2 offline hours around an outage) is maintenance, not a shutdown, as on the rest of the site. Units that cycle: a year's units with 20 or more loss windows and none turned off are left out of that year. ` +
    `Ridden through: each unit's minimum output (LSL times the window's hours) in windows where shutting pays that it stayed on for, against the same windows at its own ${b0} to ${b1} shut rate (units with ${q.unit_min} or more such windows in one of those years). ` +
    `2021 and 2022 include Winter Storm Uri and the 2022 gas price spike; biggest-loss windows lean to winter, when units ride through more.`);
}

// ==== 4. Curtailment and the fossil minimum beside it ========================================
const Q4_KEYS = ["losing more than a restart", "losing, shutting would not pay", "held on by RUC or what it would give up", "covering its costs", "coal", "combustion_turbine"];
const Q4_OLD = { "held on by a DAM commitment, AS or RUC": "held on by RUC or what it would give up" };    // goal.json before v10
const RUN_KEYS = ["restart", "losing", "all", "none"];
const RUN = {
  restart: { label: "Would run if the units losing more than a restart shut", color: "--c3" },
  losing: { label: "Would also run if every losing unit shut", color: "--c1" },
  all: { label: "Would run only if all fossil at minimum shut", color: "--c-other" },
  none: { label: "Stays curtailed even then", color: "--c8" },
};
const ECON = {
  "losing more than a restart": { label: "Losing more than a restart costs", color: "--loss" },
  "losing, shutting would not pay": { label: "Losing, but shutting down wouldn't pay", color: "--loss-soft" },
  "held on by RUC or what it would give up": { label: "Held on by RUC, or by the make-whole and AS it would give up", color: "--c7" },
  "covering its costs": { label: "Covering its costs", color: "--c-other" },
  coal: { label: "Coal", color: "--c8" },
  combustion_turbine: { label: "Combustion turbines", color: "--c2" },
};
const SPLIT_KEYS = ["grid", "congested", "free"];
const SPLIT = {
  grid: { label: "Transmission (hub price above $5/MWh, so the system wasn't oversupplied)", color: "--c-other" },
  congested: { label: "Oversupply hour, plant behind a constraint", color: "--c4" },
  free: { label: "Oversupply hour, no constraint: fossil minimums were the only thing in the way", color: "--c3" },
};
function drawQ4Split(Y) {
  const ys = Y.map((r) => r.year), R = Object.fromEntries(Y.map((r) => [r.year, r]));
  const part = (y, k) => { const r = R[y]; return k === "grid" ? r.curt - r.over : k === "congested" ? r.over - r.free : r.free; };
  stack($("q4s-chart"), ys, SPLIT_KEYS, part, { title: "All wind and solar curtailment (TWh), by what held it back", labels: SPLIT,
    axis: (v) => d3.format(".0f")(v / 1e6), tip: (v) => `${fmtTWh(v)} TWh` });
  legend("q4s-legend", SPLIT_KEYS.map((k) => [SPLIT[k].label, SPLIT[k].color]));
}
function drawQ4() {
  const el = $("q4-chart"), Y = S.G.q4.years.map(([year, avail, curt, over, free, overH, counted, freeCounted, byHe]) => ({ year, avail, curt, over, free, overH, counted, freeCounted, byHe }));
  drawQ4Split(Y);
  const A = S.G.q4.atmin.map(([year, tech, econ, mwh]) => ({ year, tech, econ: Q4_OLD[econ] || econ, mwh }));
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
  $("q4-table").innerHTML = `<table class="data"><thead><tr><th class="t">Year</th><th>Curtailed, TWh (share of available)</th><th>Fossil could make room for, TWh (share of curtailed), oversupply hours</th><th>Would run if units losing more than a restart shut, TWh (share of the make-room part)</th><th>… if every losing unit shut</th><th>… if all fossil at minimum shut</th></tr></thead><tbody>` +
    Y.slice().reverse().map((r) => `<tr><td class="t">${yearLabel(r.year)}</td><td>${fmtTWh(r.curt)} TWh (${fmtPct(r.curt / r.avail)})</td><td>${fmtTWh(r.free)} TWh (${fmtPct(r.free / r.curt)}), ${d3.format(",")(r.overH)} hours</td>` +
      sc.map((s) => `<td>${fmtTWh(v(r.year, s))} TWh (${fmtPct(v(r.year, s) / (r.free || 1))})</td>`).join("") + `</tr>`).join("") + `</tbody></table>`;
  setCSV(el, ["year", "available_mwh", "curtailed_mwh", "uncongested_oversupply_mwh", "oversupply_hours", "counted_hours", "nuclear_mw", ...Q4_KEYS.map((k) => `${k.replace(/[ ,]+/g, "_")}_mw`), ...sc.map((s) => `would_run_${s.replace(/[ ,]+/g, "_")}_mwh`)],
    Y.map((r) => [r.year, r.avail, r.curt, r.free, r.overH, r.counted, Math.round(nuc(r.year)), ...Q4_KEYS.map((k) => Math.round(val(r.year, k))), ...sc.map((s) => v(r.year, s))]), "Curtailment and fossil minimum");
  const y = fullYears().at(-1), r = Y.find((q) => q.year === y), fossil = d3.sum(Q4_KEYS, (k) => val(y, k));
  const [tCurt, tGrid, tCong, tFree] = window.CX.fmtPair([r.curt, r.curt - r.over, r.over - r.free, r.free].map((x) => x / 1e6), "TWh", { dp: 2 });
  const runs = (s, all) => `${fmtTWh(v(y, s))} TWh (${fmtPct(v(y, s) / r.free)} of the ${tFree}${all ? `, ${fmtPct(v(y, s) / r.curt)} of all curtailment` : ""})`;
  $("q4-answer").innerHTML = `<b>Most curtailment is transmission, not fossil.</b> In ${y}, ${tCurt} of wind and solar was curtailed: ${tGrid} (${fmtPct((r.curt - r.over) / r.curt)}) in hours when the hub price was above $${S.G.over_price}/MWh, so the system was not oversupplied; ` +
    `${tCong} (${fmtPct((r.over - r.free) / r.curt)}) in oversupply hours but at plants behind a transmission constraint; and ${tFree} (${fmtPct(r.free / r.curt)}) in oversupply hours where the grid could have taken it. Only that last part is fossil's to fix. ` +
    `In those hours ${fmtGW(fossil)} GW of fossil sat at minimum, beside ${fmtGW(nuc(y))} GW of nuclear, and <b>${fmtGW(val(y, Q4_KEYS[0]))} GW of it was losing more than a restart would have cost.</b> ` +
    `Had those units shut, ${runs(sc[0], true)} would have run instead; had every losing unit shut, ${runs(sc[1])}; had all fossil at minimum shut, ${runs(sc[2])}.`;
  setNote($("q4-note"), `Two charts. First, all wind and solar curtailment by what held it back: the system not being oversupplied, a transmission constraint at the plant, or nothing but fossil minimums. Second, that last part by year, split by the shutdown that would have let it run. Each hour counts the smaller of its curtailment and the minimum of the units shut, so a year's average fossil minimum and average curtailment can't simply be compared. * part year.`,
    `Curtailment is a wind or solar unit's HSL above its base point (0.5 MW or more), from the 60-day SCED disclosure. An oversupply hour has a real-time hub average (HB_HUBAVG) of $${S.G.over_price}/MWh or less. A unit is behind congestion when its day-ahead node price sits $5 or more below the day-ahead bus average; most curtailment is (West and Panhandle), and shutting a gas unit elsewhere does not make room for it. The fossil split covers oversupply hours with at least 100 MW curtailed not behind congestion. A combined cycle or gas steam unit is losing money in the hours of its day-ahead loss windows (as in question 3). It loses more than a restart when some shutdown of at least its minimum off time would save more than the restart and the DAM make-whole and AS it gives up, and it is held on when RUC (or before Dec 5, 2025 a DAM AS award) covers half the window or more, or when what a shutdown gives up outweighs its saving. Units outside such a window are covering their costs at day-ahead prices. Coal is shown on its own because it mostly shuts by season rather than for a day's cheap stretch; its cost is its heat rate at minimum times its plant's monthly EIA-923 coal price, as in Q2. "Runs" sums, hour by hour, the smaller of that curtailment and the minimum of the units shut.`);
  drawSiting();
}

// ---- 4b. Where a new load could use it: county maps of curtailment and the pockets that reach it ----
// S.G.siting (pipeline/load_siting.py) and vendor/tx-counties.json (US Census county outlines via
// us-atlas, Texas only).  A tap on a county picks it for the detail strip and the line chart.
const SIT_NAMED = [["SWISHER", "Swisher (southern Panhandle)", "--c3"], ["SCURRY", "Scurry (Rolling Plains)", "--c1"], ["PECOS", "Pecos (Permian)", "--c4"], ["KENEDY", "Kenedy (Lower Valley)", "--c7"], ["HARRIS", "Harris (Houston)", "--c-other"]];
const titleCase = (k) => k.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
function sitData() {
  const G = S.G.siting, c = G.columns, at = (n) => c.indexOf(n);
  const rows = {};
  for (const r of G.rows) rows[r[at("county")]] = { curt: r[at("curtailed_mwh")], mw: r[at("wind_solar_mw")], disc: r[at("disc")], reach: r[at("reach_hours")], svc: r[at("service")], absorb: r[at("absorb_mwh")] };
  return rows;
}
function drawSiting() {
  const G = S.G.siting;
  if (!G || !S.TX) return;
  $("sit").hidden = false;
  const R = sitData(), H = G.hours, Z = G.sizes, i20 = Z.indexOf(20), i1g = Z.indexOf(1000);
  const share = (r, i) => r.absorb[i] / (Z[i] * H);
  if (!S.sitSel || !R[S.sitSel]) S.sitSel = R.SWISHER ? "SWISHER" : Object.keys(R)[0];
  const svcOf = (k) => G.service[k] || "ercot";
  const best = Object.entries(R).filter(([k]) => svcOf(k) !== "none").sort((a, b) => share(b[1], i20) - share(a[1], i20))[0];
  const hou = R.HARRIS, fmtMon = (m) => d3.timeFormat("%b %Y")(d3.timeParse("%Y-%m")(m));
  $("sit-answer").innerHTML = `Most curtailment sits behind congestion, so a new load only uses it on the same side of the constraint. From ${fmtMon(G.months[0])} to ${fmtMon(G.months[1])}, a flexible 20 MW load in ${titleCase(best[0])} County could have taken <b>${fmtPct(share(best[1], i20))} of its energy from wind and solar that was otherwise curtailed</b>${hou ? `, against ${fmtPct(share(hou, i20))} in Houston` : ""}. The best places are the southern Panhandle and the Rolling Plains, the same pocket as the big Panhandle wind; the share falls as the load grows, and the order barely changes. ${titleCase(best[0])} County had ${d3.format(",")(best[1].reach)} hours with curtailment within reach over those months, about ${fmtPct(best[1].reach / 8760)} of a year.`;
  setNote($("sit-note"), `Left, curtailment at the units in each county. Right, the hours a year a load there could have run on curtailment it can reach. Tap a county for its numbers.`,
    `Each hour, a curtailed unit whose day-ahead node sits $${G.congested} or more below the day-ahead bus average is behind congestion. It counts toward every county whose median wind and solar node price is within $${G.pocket_tol} of it, taken as the same side of the binding constraints (inferred from prices, not shift factors). Curtailment at nodes nearer the bus price, in hours the real-time hub averaged $${G.over_price} or less, is system oversupply that a load anywhere could take, and counts everywhere. A load takes at most its own size each hour and is scored as if it were the only new load; a real one would also lift the local price. "Share of a flat load" is that energy over what the load would use running every hour. Counties are from ERCOT's CDR, with units it lacks placed from EIA-860. Hatched counties have no utility in ERCOT (EIA-861 service territories, 2024): a load there would normally be served from SPP, MISO or WECC even where ERCOT wind is. Gray counties have no wind or solar node to price them. ${d3.format(",")(H)} hours with data.`);
  const W = 520, Hh = 500, proj = d3.geoConicConformal().parallels([27.5, 35]).rotate([100, 0]).fitSize([W, Hh], S.TX), path = d3.geoPath(proj);
  const tip = (k) => { const r = R[k]; return `<b>${titleCase(k)} County</b>` + (r ? `<br>${d3.format(",.0f")(r.curt / 1e3)} GWh curtailed here<br>${d3.format(",")(r.reach)} hours with reachable curtailment<br>${fmtPct(share(r, i20))} of a flat 20 MW load` : "<br>No wind or solar node") + (svcOf(k) === "none" ? "<br>No ERCOT utility serves it" : ""); };
  const map = (id, value, scale, ticks, fmt) => {
    const el = d3.select("#" + id); el.selectAll("*").remove();
    const svg = el.append("svg").attr("viewBox", `0 0 ${W} ${Hh}`).attr("role", "img"), pid = id + "-hatch";
    svg.append("defs").append("pattern").attr("id", pid).attr("width", 5).attr("height", 5).attr("patternUnits", "userSpaceOnUse").attr("patternTransform", "rotate(45)")
      .append("line").attr("y2", 5).attr("stroke", css("--ink-2")).attr("stroke-opacity", 0.5).attr("stroke-width", 1.2);
    svg.append("g").selectAll("path").data(S.TX.features).join("path").attr("d", path)
      .attr("class", (f) => "county" + (f.properties.n === S.sitSel ? " sel" : ""))
      .attr("fill", (f) => R[f.properties.n] ? scale(value(R[f.properties.n])) : css("--grid"))
      .on("click", (e, f) => { if (R[f.properties.n]) { S.sitSel = f.properties.n; drawSiting(); } })
      .on("mousemove", (e, f) => showTip(e, tip(f.properties.n))).on("mouseleave", hideTip);
    svg.append("g").attr("pointer-events", "none").selectAll("path").data(S.TX.features.filter((f) => svcOf(f.properties.n) === "none")).join("path").attr("d", path).attr("fill", `url(#${pid})`);
    const s = svg.select(".county.sel"); if (!s.empty()) s.raise();
    const lg = d3.select(`#${id}-legend`); lg.selectAll("*").remove();
    const rs = lg.append("svg").attr("class", "sit-ramp").attr("viewBox", "0 0 230 26").attr("width", 230).attr("height", 26), n = ticks.length;
    ticks.forEach((t, i) => { rs.append("rect").attr("x", i * 230 / n).attr("width", 230 / n).attr("height", 10).attr("fill", scale(t)); rs.append("text").attr("x", i * 230 / n + 1).attr("y", 23).text(fmt(t)); });
    lg.append("span").html(`<span class="sw" style="background:var(--grid)"></span>No wind or solar node`);
    lg.append("span").html(`<svg width="12" height="10" aria-hidden="true"><rect width="12" height="10" fill="url(#${pid})"></rect></svg> No ERCOT utility`);
  };
  map("sit-a", (r) => r.curt / 1e3, d3.scaleSequentialSqrt([0, 600], d3.interpolateRgb(css("--seq-lo"), css("--seq-hi"))).clamp(true), [0, 50, 150, 300, 450, 600], d3.format(","));
  map("sit-b", (r) => r.reach, d3.scaleSequential([0, 3500], d3.interpolateRgb(css("--seq-lo"), css("--c3"))).clamp(true), [0, 500, 1000, 1500, 2500, 3500], d3.format(","));
  const r = R[S.sitSel], area = svcOf(S.sitSel) === "none" ? "No ERCOT utility serves it" : svcOf(S.sitSel) === "part" ? "Served partly by ERCOT utilities" : "ERCOT";
  const st = [[d3.format(",")(r.reach), "hours a year with reachable curtailment"], [fmtPct(share(r, i20)), "of a flat 20 MW load from curtailed wind and solar"],
    [fmtPct(share(r, i1g)), "of a flat 1 GW load"], [`${d3.format(",.0f")(r.curt / 1e3)} GWh`, `curtailed at ${d3.format(",")(r.mw)} MW of wind and solar here`],
    [`${r.disc > 0 ? "+" : r.disc < 0 ? "\u2212" : ""}$${d3.format(".1f")(Math.abs(r.disc))}/MWh`, "day-ahead node price against the bus average"]];
  $("sit-detail").innerHTML = `<h4>${esc(titleCase(S.sitSel))} County<span>${area}</span></h4><div class="sit-stats">${st.map(([b, s]) => `<div><b>${b}</b><span>${s}</span></div>`).join("")}</div>`;
  // the share of a flat load each county's reachable curtailment covers, 10 MW to 5 GW
  const named = SIT_NAMED.filter(([k]) => R[k] && k !== S.sitSel).concat([[S.sitSel, `${titleCase(S.sitSel)} (picked)`, "--c2"]]);
  legend("sit-lines-legend", [...named.map(([, lab, col]) => [lab, col]), ["Every other county", "--c-other", 0.35]]);
  const el = d3.select("#sit-lines"); el.selectAll("*").remove();
  const w = 900, h = 340, m = { l: 44, r: 16, t: 10, b: 38 };
  const x = d3.scaleLog([Z[0], Z.at(-1)], [m.l, w - m.r]), y = d3.scaleLinear([0, 0.4], [h - m.b, m.t]);
  const ln = d3.line().x((d) => x(d[0])).y((d) => y(Math.min(d[1], 0.4))), pts = (r) => Z.map((L, i) => [L, share(r, i)]);
  const svg = el.append("svg").attr("viewBox", `0 0 ${w} ${h}`).attr("role", "img").attr("aria-label", "Share of a flat load from curtailed wind and solar, by load size, one line per county");
  svg.append("g").selectAll("line").data(y.ticks(4)).join("line").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y).attr("y2", y).attr("stroke", css("--grid"));
  svg.append("g").selectAll("text").data(y.ticks(4)).join("text").attr("x", m.l - 6).attr("y", (d) => y(d) + 4).attr("text-anchor", "end").attr("class", "tick").attr("fill", css("--muted")).attr("font-size", 11).text(fmtPct);
  svg.append("g").selectAll("text").data(Z).join("text").attr("x", x).attr("y", h - m.b + 16).attr("text-anchor", "middle").attr("fill", css("--muted")).attr("font-size", 11).text((d) => (d === Z[0] || d === Z.at(-1) ? `${d3.format(",")(d)} MW` : d3.format(",")(d)));
  svg.append("text").attr("x", m.l).attr("y", h - 4).attr("fill", css("--muted")).attr("font-size", 11).text("New load, MW (log scale). Share of a flat load's energy from curtailed wind and solar.");
  svg.append("g").selectAll("path").data(Object.values(R)).join("path").attr("d", (r) => ln(pts(r))).attr("fill", "none").attr("stroke", css("--c-other")).attr("stroke-opacity", 0.25);
  for (const [k, lab, col] of named) {
    svg.append("path").attr("d", ln(pts(R[k]))).attr("fill", "none").attr("stroke", css(col)).attr("stroke-width", k === S.sitSel ? 2.6 : 2)
      .on("mousemove", (e) => showTip(e, `<b>${esc(lab)}</b><br>${Z.map((L, i) => `${d3.format(",")(L)} MW: ${fmtPct(share(R[k], i))}`).join("<br>")}`)).on("mouseleave", hideTip);
  }
  setCSV($("sit-lines"), ["county", "service", "curtailed_mwh", "wind_solar_mw", "reach_hours", "node_less_bus", ...Z.map((L) => `absorb_mwh_${L}mw`)],
    Object.entries(R).map(([k, r]) => [k, svcOf(k), r.curt, r.mw, r.reach, r.disc, ...r.absorb]), "Where a new load could use curtailment");
}

function drawAll() { drawQ1(); drawQ2(); drawQ3(); drawQ4(); }

(async function boot() {
  window.CX.init();
  S.G = await tryJSON("data/goal.json.gz");
  if (S.G?.siting) S.TX = await tryJSON("vendor/tx-counties.json");
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

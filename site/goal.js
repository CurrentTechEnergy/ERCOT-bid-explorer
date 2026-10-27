/* Will fossil turn off? Four questions, each by year from 2019, from data/goal.json.gz
   (pipeline/goal.py, built monthly from the 60-day reports): what turns off, why the rest stays on
   in cheap hours, whether behaviour is changing, and where fossil minimums sit beside curtailed wind
   and solar.  The page only sums and divides what the file holds. */
const { tryJSON, showTip, hideTip, setCSV, setNote, axisFmt, css, esc, readHash, writeHash } = window.CX;
const $ = (id) => document.getElementById(id);
const fmtGW = (mw) => d3.format(",.1f")(mw / 1000);
const fmtPct = d3.format(".0%");
const fmtPt = (v) => `${v >= 0 ? "+" : "−"}${d3.format(".1f")(Math.abs(v) * 100)} pt`;
const fmtTWh = (mwh) => d3.format(",.2f")(mwh / 1e6);
const TECH = { combined_cycle: "Combined cycle", gas_steam: "Gas steam", coal: "Coal", combustion_turbine: "Combustion turbine", nuclear: "Nuclear" };
const GROUP_COLOR = { "daily, over 2 a week": "--c1", "daily, 1 to 2 a week": "--c7", "daily, under 1 a week": "--c7-soft", "multi-day": "--c4", seasonal: "--c5", "never off": "--c-other" };
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
const S = { G: null, year: null, tech: "combined_cycle", vs: "first" };

function emptyMsg(el, msg) { el.innerHTML = `<p class="empty">${msg}</p>`; }
function setSeg(id, value) { $(id).querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === value))); }
const yearLabel = (y) => { const r = S.G.years[y]; return r && r.to.slice(5) !== "12-31" ? `${y} to ${d3.timeFormat("%b %-d")(new Date(r.to + "T12:00:00"))}` : String(y); };
const years = () => Object.keys(S.G.years).map(Number).sort();
const fullYears = () => years().filter((y) => S.G.years[y].to.slice(5) === "12-31");
const rowsOf = (q) => S.G[q].rows.map((r) => Object.fromEntries(S.G[q].columns.map((c, i) => [c, r[i]])));
function legend(id, items) {
  $(id).innerHTML = items.map(([label, color, op]) => `<span><span class="sw" style="background:var(${color})${op ? `;opacity:${op}` : ""}"></span>${esc(label)}</span>`).join("");
}

// ==== 1. What turns off: capacity and the minimum taken offline in cheap hours, by group ======
function drawQ1() {
  const el = $("q1-chart"), y = S.year, R = rowsOf("q1").filter((r) => r.year === y);
  if (!R.length) return emptyMsg(el, "No data for this year.");
  const groups = S.G.q1.groups, techs = ["combined_cycle", "gas_steam", "coal"];
  const share = (t, k) => { const rs = R.filter((r) => r.tech === t), tot = d3.sum(rs, (r) => r[k]) || 1; return groups.map((g) => ({ g, v: d3.sum(rs.filter((r) => r.group === g), (r) => r[k]) / tot, mw: d3.sum(rs.filter((r) => r.group === g), (r) => r[k]), n: d3.sum(rs.filter((r) => r.group === g), (r) => r.trains) })); };
  const cheapH = S.G.years[y].cheap_hours || 1;
  const bars = techs.flatMap((t) => [{ t, k: "capacity_mw", label: "Capacity", parts: share(t, "capacity_mw") }, { t, k: "off_mwh", label: "Minimum taken offline in cheap hours", parts: share(t, "off_mwh") }]);
  const w = Math.max(300, el.clientWidth || 700), narrow = w < 560, m = { t: 8, r: 12, b: 26, l: narrow ? 128 : 250 }, bh = 18, gap = 6, tg = 22;
  const H = m.t + techs.length * (2 * bh + gap + tg) + m.b;
  const x = d3.scaleLinear().domain([0, 1]).range([m.l, w - m.r]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(5).tickSize(-(H - m.t - m.b)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(5).tickFormat(fmtPct).tickSizeOuter(0));
  bars.forEach((b, i) => {
    const ti = Math.floor(i / 2), y0 = m.t + ti * (2 * bh + gap + tg) + tg + (i % 2) * (bh + gap);
    if (i % 2 === 0) svg.append("text").attr("x", 0).attr("y", y0 - 7).attr("font-weight", 600).attr("class", "axis-title").text(TECH[b.t]);
    svg.append("text").attr("x", m.l - 6).attr("y", y0 + bh / 2 + 4).attr("text-anchor", "end").attr("font-size", 12).attr("fill", css("--ink-2")).text(narrow ? (b.k === "capacity_mw" ? "Capacity" : "Taken offline") : b.label);
    let acc = 0;
    const tot = d3.sum(b.parts, (p) => p.mw);
    if (!tot) svg.append("text").attr("x", m.l + 4).attr("y", y0 + bh / 2 + 4).attr("font-size", 12).attr("fill", css("--muted")).text("none");
    b.parts.forEach((p) => {
      if (!p.v) return;
      const x0 = x(acc), x1 = x(acc + p.v);
      acc += p.v;
      svg.append("rect").attr("x", x0).attr("y", y0).attr("width", Math.max(0, x1 - x0 - 1)).attr("height", bh).attr("fill", css(GROUP_COLOR[p.g]))
        .on("pointermove", (ev) => showTip(ev, `<h4>${TECH[b.t]} · ${esc(p.g)} · ${yearLabel(y)}</h4><table><tr><td>${b.label}</td><td class="n">${fmtPct(p.v)}</td></tr>` +
          (b.k === "capacity_mw" ? `<tr><td>Capacity</td><td class="n">${fmtGW(p.mw)} GW, ${p.n} units</td></tr>` : `<tr><td>Average per cheap hour</td><td class="n">${d3.format(",.0f")(p.mw / cheapH)} MW</td></tr>`) + `</table>`))
        .on("pointerleave", hideTip);
      if (x1 - x0 > 34) svg.append("text").attr("x", (x0 + x1) / 2).attr("y", y0 + bh / 2 + 4).attr("text-anchor", "middle").attr("font-size", 11).attr("fill", "#fff").attr("pointer-events", "none").text(fmtPct(p.v));
    });
  });
  el.replaceChildren(svg.node());
  legend("q1-legend", groups.filter((g) => R.some((r) => r.group === g)).map((g) => [g[0].toUpperCase() + g.slice(1), GROUP_COLOR[g]]));
  setCSV(el, ["year", "tech", "group", "units", "capacity_mw", "minimum_offline_in_cheap_hours_mwh"], R.map((r) => [r.year, r.tech, r.group, r.trains, r.capacity_mw, r.off_mwh]), `What turns off ${y}`);
  // the answer, from the chosen year
  const cc = share("combined_cycle", "capacity_mw"), co = share("combined_cycle", "off_mwh");
  const daily = (a) => d3.sum(a.filter((p) => p.g.startsWith("daily")), (p) => p.v), never = (a) => (a.find((p) => p.g === "never off") || { v: 0 }).v;
  const coalOff = d3.sum(R.filter((r) => r.tech === "coal"), (r) => r.off_mwh) / cheapH, coalCap = d3.sum(R.filter((r) => r.tech === "coal"), (r) => r.capacity_mw);
  $("q1-answer").innerHTML = `In ${yearLabel(y)}, <b>daily-cycling combined cycles were ${fmtPct(daily(cc))} of combined-cycle capacity and took ${fmtPct(daily(co))} of the combined-cycle minimum that went offline in cheap hours.</b> Never-off combined cycles, ${fmtPct(never(cc))} of capacity, took ${fmtPct(never(co))}. Coal took ${d3.format(",.0f")(coalOff)} MW offline in the average cheap hour, out of ${fmtGW(coalCap)} GW.`;
  setNote($("q1-note"), `Each unit's share of its technology's capacity, and of the minimum output that went offline in cheap hours, by how often it turns off. ${d3.format(",")(S.G.years[y].cheap_hours)} cheap hours in ${yearLabel(y)}.`,
    `Every coal, combined-cycle and gas steam unit (combined-cycle configurations merged into their train), from the hourly states in the 60-day SCED disclosure. Its group comes from its off spells over the year (for a part year, the 365 days to its end): an off spell is at least ${4} offline hours after a running hour, not mostly outage. Daily: two or more spells under 24 hours, split by how many a week; multi-day: the shortest lasted a day to a week; seasonal: every one lasted a week or more; never off: none. Capacity is the unit's 95th-percentile HSL while online. A cheap hour has a day-ahead hub average (HB_HUBAVG) of $${S.G.cheap}/MWh or less. Minimum taken offline counts each cheap hour a unit was offline inside one of its off spells, having run in the 24 hours before, at its median LSL while online.`);
}

// ==== 2. Why the rest stays on: minimum online in cheap hours, by reason, by year =============
function stack(el, ys, keys, val, opts) {
  const w = Math.max(300, el.clientWidth || 700), m = { t: 14, r: 14, b: 26, l: 56 }, H = 260;
  const x = d3.scaleBand().domain(ys).range([m.l, w - m.r]).padding(0.25);
  const tops = ys.map((y) => d3.sum(keys, (k) => val(y, k)));
  const yy = d3.scaleLinear().domain([0, Math.max(d3.max(tops) || 1, opts.mark ? d3.max(ys, opts.mark) || 0 : 0)]).nice().range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(yy).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(yy).ticks(5).tickFormat((v) => d3.format(",.0f")(v / 1000)).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickFormat((y) => (S.G.years[y].to.slice(5) === "12-31" ? y : `${y}*`)).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 9).text(opts.title);
  ys.forEach((y) => {
    let acc = 0;
    keys.forEach((k) => {
      const v = val(y, k);
      if (!v) return;
      svg.append("rect").attr("x", x(y)).attr("width", x.bandwidth()).attr("y", yy(acc + v)).attr("height", Math.max(0, yy(acc) - yy(acc + v) - 0.5)).attr("fill", css(REASON[k].color));
      acc += v;
    });
    if (opts.mark) {
      const v = opts.mark(y);
      [[css("--surface"), 5.5], [css("--ink"), 2.5]].forEach(([c, sw]) => svg.append("line").attr("x1", x(y) - 4).attr("x2", x(y) + x.bandwidth() + 4).attr("y1", yy(v)).attr("y2", yy(v)).attr("stroke", c).attr("stroke-width", sw));
    }
    svg.append("rect").attr("x", x(y)).attr("width", x.bandwidth()).attr("y", m.t).attr("height", H - m.t - m.b).attr("fill", "transparent")
      .on("pointermove", (ev) => showTip(ev, `<h4>${yearLabel(y)}</h4><table>` + keys.filter((k) => val(y, k)).reverse().map((k) => `<tr><td>${REASON[k].label}</td><td class="n">${d3.format(",.0f")(val(y, k))} MW</td></tr>`).join("") +
        `<tr><td><b>Total</b></td><td class="n"><b>${d3.format(",.0f")(d3.sum(keys, (k) => val(y, k)))} MW</b></td></tr>` + (opts.mark ? `<tr><td>${opts.markLabel}</td><td class="n">${d3.format(",.0f")(opts.mark(y))} MW</td></tr>` : "") + `</table>`))
      .on("pointerleave", hideTip);
  });
  el.replaceChildren(svg.node());
}
const Q2_KEYS = ["coal", "never off", "held by its award", "rode through", "against the model", "no model call"];
function drawQ2() {
  const el = $("q2-chart"), R = rowsOf("q2").filter((r) => ["coal", "combined_cycle", "gas_steam"].includes(r.tech)), ys = years();
  const val = (y, k) => d3.sum(R.filter((r) => r.year === y && r.reason === k), (r) => r.mwh) / (S.G.years[y].cheap_hours || 1);
  stack(el, ys, Q2_KEYS, val, { title: "Fossil minimum online in the average cheap hour (GW)" });
  legend("q2-legend", Q2_KEYS.map((k) => [REASON[k].label, REASON[k].color]));
  setCSV(el, ["year", "reason", "mw_per_cheap_hour"], ys.flatMap((y) => Q2_KEYS.map((k) => [y, k, Math.round(val(y, k))])), "Why the rest stays on");
  const y = fullYears().at(-1), tot = d3.sum(Q2_KEYS, (k) => val(y, k));
  $("q2-answer").innerHTML = `In ${y}, <b>${fmtGW(tot)} GW of coal and gas minimum ran through the average cheap hour.</b> ${fmtGW(val(y, "coal"))} GW was coal, ${fmtGW(val(y, "held by its award"))} GW was held by its day-ahead award, ${fmtGW(val(y, "never off"))} GW never turns off, and ${fmtGW(val(y, "rode through"))} GW rode through, as the model also called it. Only ${d3.format(",.0f")(val(y, "against the model"))} MW stayed on when the model said it would turn off.`;
  setNote($("q2-note"), `Coal, combined-cycle and gas steam units online at minimum in cheap hours, by the first reason that applies. * part year.`,
    `A unit at minimum is online with output within 5% of its HSL above its LSL, from the 60-day SCED disclosure; its MW is its LSL. The reasons, in order: coal (it does not cycle within a day); never off (no off spell all year, as in question 1); held by its award (a day-ahead energy award of at least 90% of its LSL that hour); rode through (the operator-informed model, which judges each hour with the unit's own prices, costs, award and state, also called it on); stayed on, model said off (the model's chance online was under 50%); no model call (no operator day file, mostly Jan to Mar 2019, before the model's first fit). Before Feb 2026 the model is fitted on the 12 months before each month, without the day-ahead resource status. A cheap hour has a day-ahead hub average of $${S.G.cheap}/MWh or less.`);
}

// ==== 3. Is behaviour changing: triggers against behaviour, and where the loss windows fall ==
function drawQ3() {
  setSeg("q3-vs", S.vs);
  $("q3-tech").value = S.tech;
  const el = $("q3-chart"), P = S.G.q3.pairs.map(([tech, a, b, trains, offA, offB, trig, beh]) => ({ tech, a, b, trains, offA, offB, trig, beh })).filter((p) => p.tech === S.tech);
  const y0 = d3.min(P, (p) => p.a);
  const sel = P.filter((p) => (S.vs === "first" ? p.a === y0 : p.b === p.a + 1)).sort((p, q) => p.b - q.b);
  if (!sel.length) return emptyMsg(el, "No year pairs.");
  const w = Math.max(300, el.clientWidth || 700), m = { t: 14, r: 14, b: 26, l: 56 }, H = 240;
  const x = d3.scaleBand().domain(sel.map((p) => p.b)).range([m.l, w - m.r]).padding(0.3), bw = x.bandwidth() / 2;
  const lo = d3.min(sel, (p) => Math.min(0, p.trig, p.beh, p.offB - p.offA)), hi = d3.max(sel, (p) => Math.max(0, p.trig, p.beh, p.offB - p.offA));
  const yy = d3.scaleLinear().domain([lo * 1.1, hi * 1.1]).nice().range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(yy).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(yy).ticks(5).tickFormat((v) => d3.format("+.0f")(v * 100)).tickSizeOuter(0));
  const star = (y) => (S.G.years[y]?.to.slice(5) === "12-31" ? `${y}` : `${y}*`);
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${yy(0)})`).call(d3.axisBottom(x).tickFormat((b) => (S.vs === "first" ? star(b) : `${b - 1}→${star(b)}`)).tickSize(0).tickPadding(H - m.b - yy(0) + 8));
  svg.append("line").attr("x1", m.l).attr("x2", w - m.r).attr("y1", yy(0)).attr("y2", yy(0)).attr("stroke", css("--ink-2"));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 9).text(`Change in the share of loss windows ${TECH[S.tech].toLowerCase()} units turned off for (points)`);
  sel.forEach((p) => {
    [["trig", "--c4"], ["beh", "--c2"]].forEach(([k, c], i) => svg.append("rect").attr("x", x(p.b) + i * bw).attr("width", bw - 2).attr("y", yy(Math.max(0, p[k]))).attr("height", Math.abs(yy(p[k]) - yy(0))).attr("fill", css(c)));
    svg.append("circle").attr("cx", x(p.b) + x.bandwidth() / 2).attr("cy", yy(p.offB - p.offA)).attr("r", 4).attr("fill", css("--ink"));
    svg.append("rect").attr("x", x(p.b)).attr("width", x.bandwidth()).attr("y", m.t).attr("height", H - m.t - m.b).attr("fill", "transparent")
      .on("pointermove", (ev) => showTip(ev, `<h4>${p.a} to ${yearLabel(p.b)}</h4><table><tr><td>Turned off for the window</td><td class="n">${fmtPct(p.offA)} → ${fmtPct(p.offB)}</td></tr><tr><td>Change</td><td class="n">${fmtPt(p.offB - p.offA)}</td></tr><tr><td>Triggers (the losses changed)</td><td class="n">${fmtPt(p.trig)}</td></tr><tr><td>Behaviour (the rule changed)</td><td class="n">${fmtPt(p.beh)}</td></tr><tr><td>Units in both years</td><td class="n">${p.trains}</td></tr></table>`))
      .on("pointerleave", hideTip);
  });
  el.replaceChildren(svg.node());
  legend("q3-legend", [["Triggers: the losses changed", "--c4"], ["Behaviour: the rule changed", "--c2"]]);
  $("q3-legend").innerHTML += `<span>● change in the share turned off</span>`;
  setCSV(el, ["from", "to", "units", "off_from", "off_to", "triggers", "behaviour"], sel.map((p) => [p.a, p.b, p.trains, p.offA, p.offB, p.trig, p.beh]), `Triggers and behaviour ${S.tech}`);
  // where the loss windows fall
  const M = S.G.q3.mix.map(([year, tech, n, overnight, midday, off, loss]) => ({ year, tech, n, overnight, midday, off, loss })).filter((r) => r.tech === S.tech);
  const el2 = $("q3m-chart"), H2 = 170, x2 = d3.scalePoint().domain(M.map((r) => r.year)).range([m.l + 20, w - m.r - 20]);
  const y2 = d3.scaleLinear().domain([0, Math.max(0.5, d3.max(M, (r) => Math.max(r.overnight, r.midday)))]).nice().range([H2 - m.b, m.t]);
  const s2 = d3.create("svg").attr("viewBox", `0 0 ${w} ${H2}`);
  s2.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y2).ticks(4).tickSize(-(w - m.l - m.r)).tickFormat(""));
  s2.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y2).ticks(4).tickFormat(fmtPct).tickSizeOuter(0));
  s2.append("g").attr("class", "axis").attr("transform", `translate(0,${H2 - m.b})`).call(d3.axisBottom(x2).tickFormat((y) => (S.G.years[y]?.to.slice(5) === "12-31" ? y : `${y}*`)).tickSizeOuter(0));
  s2.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 9).text("Where the day's worst loss window starts: share of windows");
  [["overnight", "--c7"], ["midday", "--c4"]].forEach(([k, c]) => {
    s2.append("path").attr("d", d3.line().x((r) => x2(r.year)).y((r) => y2(r[k]))(M)).attr("fill", "none").attr("stroke", css(c)).attr("stroke-width", 2);
    M.forEach((r) => s2.append("circle").attr("cx", x2(r.year)).attr("cy", y2(r[k])).attr("r", 3).attr("fill", css(c)));
  });
  M.forEach((r) => s2.append("rect").attr("x", x2(r.year) - 20).attr("width", 40).attr("y", m.t).attr("height", H2 - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => showTip(ev, `<h4>${yearLabel(r.year)}</h4><table><tr><td>Windows</td><td class="n">${d3.format(",")(r.n)}</td></tr><tr><td>Starting overnight</td><td class="n">${fmtPct(r.overnight)}</td></tr><tr><td>Starting midday (HE 9 to 17)</td><td class="n">${fmtPct(r.midday)}</td></tr><tr><td>Turned off for the window</td><td class="n">${fmtPct(r.off)}</td></tr><tr><td>Median loss of riding through</td><td class="n">$${d3.format(",.0f")(r.loss)}/MW</td></tr></table>`))
    .on("pointerleave", hideTip));
  el2.replaceChildren(s2.node());
  legend("q3m-legend", [["Starting overnight (after midnight)", "--c7"], ["Starting midday (HE 9 to 17)", "--c4"]]);
  setCSV(el2, ["year", "windows", "overnight", "midday", "turned_off", "median_loss_per_mw"], M.map((r) => [r.year, r.n, r.overnight, r.midday, r.off, r.loss]), `Loss windows ${S.tech}`);
  const all = P.filter((p) => p.b === p.a + 1).sort((p, q) => p.b - q.b), last = all.at(-1), f = M[0], l = M.at(-1);
  $("q3-answer").innerHTML = `<b>The cheap hours moved to midday:</b> ${fmtPct(f.overnight)} of ${TECH[S.tech].toLowerCase()} loss windows started overnight in ${f.year}, ${fmtPct(l.overnight)} in ${yearLabel(l.year)}. ` +
    (last ? `From ${last.a} to ${yearLabel(last.b)} the share turned off moved ${fmtPt(last.offB - last.offA)}: ${fmtPt(last.trig)} from the losses and <b>${fmtPt(last.beh)} from behaviour</b>.` : "");
  setNote($("q3-note"), `Each year's change in how often units turned off through their worst day-ahead loss window, split into what changed in the losses (triggers) and in the units' response (behaviour). * part year.`,
    `One row per unit and day it started online: its worst stretch of day-ahead losses at minimum over HE7 to HE6 the next day, against its own minimum-energy cost, and whether it was off for most of it (60-day SCED and DAM disclosures, from 2019). A stay-on rule (a logistic with one intercept per unit, on the loss, the margins before and after, the window against the unit's usual off spell, its start cost, overnight and season) is fitted on each year. The change in the off rate from year A to year B splits into triggers, A's rule on B's windows against A's own, and behaviour, B's rule against A's on the same windows, averaged both ways so the two add up; only units present in both years. The rule leaves out the day-ahead award, which is the unit's own offer, so bidding differently counts as behaviour. 2020 to 2022 include Winter Storm Uri and the 2022 gas price spike.`);
}

// ==== 4. Curtailment and the fossil minimum beside it ========================================
const Q4_KEYS = ["coal", "never off", "held by its award", "rode through", "against the model", "no model call", "combustion_turbine"];
function drawQ4() {
  const el = $("q4-chart"), Y = S.G.q4.years.map(([year, avail, curt, over, free, overH, counted, freeCounted, byHe]) => ({ year, avail, curt, over, free, overH, counted, freeCounted, byHe }));
  const A = S.G.q4.atmin.map(([year, tech, reason, mwh]) => ({ year, tech, reason, mwh }));
  const key = (r) => (r.tech === "combustion_turbine" ? "combustion_turbine" : r.reason);
  const ys = Y.map((r) => r.year), cnt = Object.fromEntries(Y.map((r) => [r.year, r.counted || 1]));
  const val = (y, k) => d3.sum(A.filter((r) => r.year === y && r.tech !== "nuclear" && key(r) === k), (r) => r.mwh) / cnt[y];
  const mark = (y) => { const r = Y.find((v) => v.year === y); return r.freeCounted / Math.max(1, r.counted); };
  stack(el, ys, Q4_KEYS, val, { title: "In oversupply hours: fossil minimum online, and curtailment not behind congestion (GW)", mark, markLabel: "Curtailed, not behind congestion (average)" });
  legend("q4-legend", [...Q4_KEYS.map((k) => [REASON[k].label, REASON[k].color])]);
  $("q4-legend").innerHTML += `<span><span class="sw sw-line" style="border-top-color:var(--ink)"></span>Wind and solar curtailed, not behind congestion</span>`;
  const V = S.G.q4.avoid.map(([year, s, mwh]) => ({ year, s, mwh })), sc = S.G.q4.scenarios;
  const nuc = (y) => d3.sum(A.filter((r) => r.year === y && r.tech === "nuclear"), (r) => r.mwh) / cnt[y];
  const v = (y, s) => (V.find((r) => r.year === y && r.s === s) || { mwh: 0 }).mwh;
  $("q4-table").innerHTML = `<table class="data"><thead><tr><th class="t">Year</th><th>Curtailed</th><th>In oversupply hours, not behind congestion</th><th>Freed: units the model called off</th><th>Freed: all CC and gas steam without an award</th><th>Freed: those and coal</th></tr></thead><tbody>` +
    Y.slice().reverse().map((r) => `<tr><td class="t">${yearLabel(r.year)}</td><td>${fmtTWh(r.curt)} TWh (${fmtPct(r.curt / r.avail)})</td><td>${fmtTWh(r.free)} TWh (${fmtPct(r.free / r.curt)}), ${d3.format(",")(r.overH)} hours</td>` +
      [sc[0], sc[1], sc[2]].map((s) => `<td>${fmtTWh(v(r.year, s))} TWh (${fmtPct(v(r.year, s) / (r.free || 1))})</td>`).join("") + `</tr>`).join("") + `</tbody></table>`;
  setCSV(el, ["year", "available_mwh", "curtailed_mwh", "uncongested_oversupply_mwh", "oversupply_hours", "counted_hours", "nuclear_mw", ...Q4_KEYS.map((k) => `${k}_mw`), ...sc.map((s) => `freed_${s}_mwh`)],
    Y.map((r) => [r.year, r.avail, r.curt, r.free, r.overH, r.counted, Math.round(nuc(r.year)), ...Q4_KEYS.map((k) => Math.round(val(r.year, k))), ...sc.map((s) => v(r.year, s))]), "Curtailment and fossil minimum");
  const y = fullYears().at(-1), r = Y.find((q) => q.year === y), fossil = d3.sum(Q4_KEYS, (k) => val(y, k));
  $("q4-answer").innerHTML = `In ${y}, <b>${fmtPct(r.free / r.curt)} of curtailed wind and solar (${fmtTWh(r.free)} TWh) came in oversupply hours at units not behind congestion</b>, the part fossil units could free. In those hours ${fmtGW(fossil)} GW of fossil sat at minimum, beside ${fmtGW(nuc(y))} GW of nuclear. Had every combined-cycle and gas steam unit without an award shut, ${fmtPct(v(y, sc[1]) / r.free)} of that curtailment would have gone, and ${fmtPct(v(y, sc[2]) / r.free)} with coal. Shutting only the units the model called off frees ${fmtPct(v(y, sc[0]) / r.free)}.`;
  setNote($("q4-note"), `Wind and solar curtailment in oversupply hours, beside the fossil minimum online then, by the reasons in question 2, by year. * part year.`,
    `Curtailment is a wind or solar unit's HSL above its base point (0.5 MW or more), from the 60-day SCED disclosure. An oversupply hour has a real-time hub average (HB_HUBAVG) of $${S.G.over_price}/MWh or less. A unit is behind congestion when its day-ahead node price sits $5 or more below the day-ahead bus average; most curtailment is (West and Panhandle), and shutting a gas unit elsewhere does not free it. The fossil split covers oversupply hours with at least 100 MW curtailed not behind congestion. "Freed" sums, hour by hour, the smaller of that curtailment and the minimum of the units shut. Nuclear is shown in the tooltip total only: it runs regardless. The black line is the curtailment not behind congestion in the average such hour.`);
}

function drawAll() { drawQ1(); drawQ2(); drawQ3(); drawQ4(); }

(async function boot() {
  window.CX.init();
  S.G = await tryJSON("data/goal.json.gz");
  if (!S.G) { $("status").textContent = "Not built yet. The goal page's data is built monthly by its own workflow."; return; }
  const v = readHash();
  const ys = years();
  S.year = ys.includes(+v.y) ? +v.y : fullYears().at(-1) || ys.at(-1);
  if (["combined_cycle", "gas_steam"].includes(v.t)) S.tech = v.t;
  if (["first", "prev"].includes(v.vs)) S.vs = v.vs;
  $("status").textContent = `60-day data, ${S.G.years[ys[0]].from} to ${S.G.through}. Built ${S.G.built.slice(0, 10)}.`;
  $("q1-year").innerHTML = ys.slice().reverse().map((y) => `<option value="${y}"${y === S.year ? " selected" : ""}>${yearLabel(y)}</option>`).join("");
  $("q1-year").addEventListener("change", (e) => { S.year = +e.target.value; writeHash({ y: S.year, t: S.tech, vs: S.vs }); drawQ1(); });
  $("q3-tech").addEventListener("change", (e) => { S.tech = e.target.value; writeHash({ y: S.year, t: S.tech, vs: S.vs }); drawQ3(); });
  $("q3-vs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; S.vs = b.dataset.v; writeHash({ y: S.year, t: S.tech, vs: S.vs }); drawQ3(); });
  drawAll();
  let rw = 0;
  addEventListener("resize", () => { clearTimeout(rw); rw = setTimeout(drawAll, 150); });
  window.CX.panelFromLink?.();
})();

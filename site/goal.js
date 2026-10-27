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
const S = { G: null, year: null, tech: "combined_cycle" };

function emptyMsg(el, msg) { el.innerHTML = `<p class="empty">${msg}</p>`; }
const yearLabel = (y) => { const r = S.G.years[y]; return r && r.to.slice(5) !== "12-31" ? `${y} (Jan 1 to ${d3.timeFormat("%b %-d")(new Date(r.to + "T12:00:00"))})` : String(y); };
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
function drawQ2() {
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
  $("q2-answer").innerHTML = `<b>A day-ahead award or a self-commitment keeps a unit on.</b> In ${yearLabel(y)}, combined cycles going into a cheap midday stretch with a DAM award stayed online through it ${p("combined_cycle", "award")} of the time, and self-committed ones ${p("combined_cycle", "self")}. With neither, only ${p("combined_cycle", "neither")} did. Coal and gas steam stay on almost regardless: ${p("coal", "self")} of self-committed coal and ${p("gas_steam", "self")} of gas steam rode through.`;
  setNote($("q2-note"), `Units online going into the day's first cheap midday stretch, by whether a day-ahead award or their own commitment had them on, and the share that stayed online through it. Combined-cycle configurations count as one train. * part year.`,
    `Counted: unit-days online in the hour before the day's first run of two or more cheap hours (day-ahead hub average of $${S.G.cheap}/MWh or less) between HE8 and HE19, with no outage hour in it; stayed online means no offline hour in the run (60-day SCED and DAM disclosures). DAM award: an energy award over 0.5 MW in at least half the run's hours. Self-committed: no award, and the unit's DAM resource status on at the run's first hour. The status is in the 60-day DAM disclosure from Dec 2025; the history before has none, so earlier years split only by award (in the CSV).`);
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
    `One row per unit and day it started online: its worst stretch of day-ahead losses at minimum over HE7 to HE6 the next day (minimum-energy cost above its day-ahead node price, times its LSL), and the hours it was online through it (60-day SCED and DAM disclosures, from 2019). Output is the LSL times the window's hours, online or offline. Losing more than a restart means that loss beat its hot start offer (a generic $15,000 for combined cycles and $10,000 for gas steam when none is offered). Held on by a day-ahead award: an award covered half the window's hours or more; those units almost never turn off. 2021 and 2022 include Winter Storm Uri and the 2022 gas price spike.`);
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
  S.year = ys.includes(+v.y) ? +v.y : fullYears().at(-1) || ys.at(-1);
  if (["combined_cycle", "gas_steam"].includes(v.t)) S.tech = v.t;
  $("status").textContent = `60-day data, ${S.G.years[ys[0]].from} to ${S.G.through}. Built ${S.G.built.slice(0, 10)}.`;
  $("q1-year").innerHTML = ys.slice().reverse().map((y) => `<option value="${y}"${y === S.year ? " selected" : ""}>${yearLabel(y)}</option>`).join("");
  $("q1-year").addEventListener("change", (e) => { S.year = +e.target.value; writeHash({ y: S.year, t: S.tech }); drawQ1(); });
  $("q3-tech").addEventListener("change", (e) => { S.tech = e.target.value; writeHash({ y: S.year, t: S.tech }); drawQ3(); });
  drawAll();
  let rw = 0;
  addEventListener("resize", () => { clearTimeout(rw); rw = setTimeout(drawAll, 150); });
  window.CX.panelFromLink?.();
})();

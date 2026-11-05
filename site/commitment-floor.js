/* Turn-ons and Turn-offs, "Since 2019": the daily minimum thermal floor from data/lsl_floor.json.gz
   (pipeline/lsl_floor.py).  Each day's lowest hour of online LSL (nuclear at its output), by
   technology; the floor by year; and the hour it bottoms out.  The page only reads and draws. */
(function () {
"use strict";
const { tryJSON, showTip, hideTip, setCSV, css, esc } = window.CX;
const $ = (id) => document.getElementById(id);
const ALL = [
  { id: "nuclear", label: "Nuclear (output)", color: "--c5" },
  { id: "coal", label: "Coal & lignite", color: "--c8" },
  { id: "combined_cycle", label: "Combined cycle", color: "--c1" },
  { id: "gas_steam", label: "Gas steam", color: "--c6" },
  { id: "combustion_turbine", label: "Combustion turbine and recip", color: "--c2" },
];
const FOS = ALL.slice(1);
const S = { fleet: "all", smooth: "30", period: "all", stat: "mean", A: [], F: [], through: null };
const techs = () => (S.fleet === "fos" ? FOS : ALL);
const days = () => (S.fleet === "fos" ? S.F : S.A);
const gw = (v) => (v == null ? "–" : (v / 1000).toFixed(1) + " GW");
const width = (el) => Math.max(300, el.clientWidth || 640);
const partial = (y) => S.through && +S.through.slice(0, 4) === y && S.through.slice(5) !== "12-31";
const yName = (y) => (partial(y) ? `${y}*` : String(y));
const tipRows = (rows) => `<table>${rows.map(([sw, k, v, b]) => `<tr><td>${sw ? `<span class="sw" style="background:${sw}"></span> ` : ""}${b ? `<b>${esc(k)}</b>` : esc(k)}</td><td class="n">${b ? `<b>${v}</b>` : v}</td></tr>`).join("")}</table>`;
function frame(el, W, H, m) {
  el.innerHTML = "";
  const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${W} ${H}`);
  return { svg, g: svg.append("g").attr("transform", `translate(${m.l},${m.t})`), w: W - m.l - m.r, h: H - m.t - m.b };
}
function setSeg(id, v) { $(id).querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === v))); }
function bindSeg(id, key) {
  setSeg(id, S[key]);
  $(id).addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; S[key] = b.dataset.v; setSeg(id, S[key]); drawAll(); });
}

// ==== Daily minimum floor ====================================================================
function drawDaily() {
  const el = $("lf-chart"), W = width(el), H = Math.round(Math.min(400, Math.max(280, W * 0.42)));
  const m = { l: 52, r: 12, t: 16, b: 26 }, { g, w, h, svg } = frame(el, W, H, m), T = techs(), D = days();
  const n = +S.smooth;
  let rows = n > 1 ? D.map((d, i) => {
    const s = D.slice(Math.max(0, i - n + 1), i + 1), o = { ...d };
    T.forEach((t) => (o[t.id] = d3.mean(s, (x) => x[t.id])));
    o.total = d3.mean(s, (x) => x.total);
    return o;
  }) : D;
  if (S.period !== "all") rows = rows.filter((d) => d.y === +S.period);
  if (!rows.length) { el.innerHTML = '<p class="empty">No days in this period.</p>'; return; }
  const x = d3.scaleTime().domain(d3.extent(rows, (d) => d.d)).range([0, w]);
  const y = d3.scaleLinear().domain([0, d3.max(rows, (d) => d.total) * 1.05]).nice().range([h, 0]);
  g.append("g").attr("class", "gridline").call(d3.axisLeft(y).ticks(6).tickSize(-w).tickFormat(""));
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(6).tickFormat((v) => v / 1000).tickSizeOuter(0));
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`).call(d3.axisBottom(x).ticks(w < 500 ? 4 : 8).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 11).text("GW");
  const st = d3.stack().keys(T.map((t) => t.id))(rows);
  const area = d3.area().x((d) => x(d.data.d)).y0((d) => y(d[0])).y1((d) => y(d[1])).curve(n > 1 ? d3.curveMonotoneX : d3.curveStepAfter);
  g.selectAll("path.lf").data(st).join("path").attr("class", "lf").attr("d", area).attr("fill", (d, i) => css(T[i].color)).attr("fill-opacity", 0.88);
  const vl = g.append("line").attr("class", "crosshair").attr("y1", 0).attr("y2", h).attr("visibility", "hidden");
  const bis = d3.bisector((d) => d.d).center;
  g.append("rect").attr("width", w).attr("height", h).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const d = rows[bis(rows, x.invert(d3.pointer(ev)[0]))];
      vl.attr("x1", x(d.d)).attr("x2", x(d.d)).attr("visibility", "visible");
      const sub = n > 1 ? `${n}-day average to this day; this day's low was HE ${d.he}` : `Lowest hour: HE ${d.he}`;
      showTip(ev, `<h4>${d3.timeFormat("%a %b %-d, %Y")(d.d)}</h4><p class="note">${sub}</p>` +
        tipRows([...T].reverse().map((t) => [css(t.color), t.label, gw(d[t.id])]).concat([[null, "Total", gw(d.total), true]])));
    })
    .on("pointerleave", () => { vl.attr("visibility", "hidden"); hideTip(); });
  setCSV(el, ["date", "hour_ending", ...T.map((t) => `${t.id}_mw`), "total_mw"], rows.map((d) => [d.date, d.he, ...T.map((t) => Math.round(d[t.id])), Math.round(d.total)]),
    `Daily minimum floor ${S.fleet === "fos" ? "fossil only" : "with nuclear"}${n > 1 ? ` ${n}-day average` : ""}`);
  // the latest value against the same day a year earlier, in the smoothing shown
  const last = rows.at(-1), yAgo = last && rows[bis(rows, d3.timeDay.offset(last.d, -365))];
  const cmp = last && yAgo && Math.abs(yAgo.d - d3.timeDay.offset(last.d, -365)) < 7 * 864e5
    ? ` The latest ${n > 1 ? `${n}-day average` : "day"} is ${gw(last.total)}, against ${gw(yAgo.total)} a year earlier.` : "";
  window.CX.setNote($("lf-note"), "Is the inflexible thermal floor shrinking? For each day since 2019, the hour when the online thermal fleet's minimum output (LSL) was lowest" +
    (S.fleet === "fos" ? ", counting coal and gas only." : ", plus nuclear at its output.") +
    " This is the generation SCED cannot back down without units turning off, so it is the floor that wind, solar and storage must price under in the cheapest hour of the day." + cmp,
    "The floor is the LSL of every online coal, combined-cycle, gas steam and combustion turbine unit" +
    (S.fleet === "fos" ? ". Fossil only picks the low hour, and the lowest days below, on the fossil floor alone, so a nuclear refuelling outage cannot pull a day in." :
      ", plus nuclear at its output, since it has no offer curve and does not back down.") +
    " A combined-cycle train counts only its running configuration; units starting up or shutting down are left out.");
}

// ==== By year ================================================================================
function yearRows() {
  const T = techs(), D = days();
  return [...new Set(D.map((d) => d.y))].map((y) => {
    const s = D.filter((d) => d.y === y), o = { y, n: s.length, min: d3.min(s, (d) => d.total) };
    let pick = s;
    if (S.stat === "p5") { const cut = d3.quantile(s.map((d) => d.total).sort(d3.ascending), 0.05); pick = s.filter((d) => d.total <= cut); }
    T.forEach((t) => (o[t.id] = d3.mean(pick, (d) => d[t.id])));
    o.total = d3.sum(T, (t) => o[t.id]);
    return o;
  });
}
function drawYears() {
  const el = $("lf-years"), W = width(el), H = Math.round(Math.min(300, Math.max(220, W * 0.32)));
  const m = { l: 52, r: 12, t: 20, b: 24 }, { g, w, h, svg } = frame(el, W, H, m), T = techs(), R = yearRows();
  const x = d3.scaleBand().domain(R.map((r) => r.y)).range([0, w]).padding(0.28);
  const y = d3.scaleLinear().domain([0, d3.max(R, (r) => r.total) * 1.1]).nice().range([h, 0]);
  g.append("g").attr("class", "gridline").call(d3.axisLeft(y).ticks(5).tickSize(-w).tickFormat(""));
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5).tickFormat((v) => v / 1000).tickSizeOuter(0));
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`).call(d3.axisBottom(x).tickFormat(yName).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 11).text("GW");
  const st = d3.stack().keys(T.map((t) => t.id))(R);
  g.selectAll("g.lfy").data(st).join("g").attr("class", "lfy").attr("fill", (d, i) => css(T[i].color)).selectAll("rect").data((d) => d).join("rect")
    .attr("x", (d) => x(d.data.y)).attr("width", x.bandwidth()).attr("y", (d) => y(d[1])).attr("height", (d) => Math.max(0, y(d[0]) - y(d[1])));
  g.selectAll("text.tot").data(R).join("text").attr("class", "axis-title tot").attr("x", (d) => x(d.y) + x.bandwidth() / 2).attr("y", (d) => y(d.total) - 4)
    .attr("text-anchor", "middle").text((d) => (d.total / 1000).toFixed(1));
  g.selectAll("rect.hit").data(R).join("rect").attr("class", "hit").attr("x", (d) => x(d.y)).attr("width", x.bandwidth()).attr("height", h).attr("fill", "transparent")
    .on("pointermove", (ev, d) => showTip(ev, `<h4>${yName(d.y)}${partial(d.y) ? ` (to ${d3.timeFormat("%b %-d")(new Date(S.through + "T12:00:00"))})` : ""}</h4><p class="note">${S.stat === "mean" ? "Average day" : "Average of the lowest 5% of days"}</p>` +
      tipRows([...T].reverse().map((t) => [css(t.color), t.label, gw(d[t.id])]).concat([[null, "Total", gw(d.total), true]]))))
    .on("pointerleave", hideTip);
  const cols = ["Year", ...T.map((t) => t.label), "Total", "Lowest day"];
  $("lf-table").innerHTML = `<table class="data"><thead><tr>${cols.map((c, i) => `<th${i ? "" : ' class="t"'}>${esc(c)}</th>`).join("")}</tr></thead><tbody>` +
    R.map((r) => `<tr><td class="t">${yName(r.y)}</td>${T.map((t) => `<td>${(r[t.id] / 1000).toFixed(1)}</td>`).join("")}<td><b>${(r.total / 1000).toFixed(1)}</b></td><td>${(r.min / 1000).toFixed(1)}</td></tr>`).join("") + "</tbody></table>";
  setCSV(el, ["year", ...T.map((t) => `${t.id}_mw`), "total_mw", "lowest_day_mw"], R.map((r) => [r.y, ...T.map((t) => Math.round(r[t.id])), Math.round(r.total), Math.round(r.min)]),
    `Floor by year ${S.stat} ${S.fleet}`);
  $("lf-year-note").textContent = (S.stat === "mean" ? "Each year's average daily floor by technology, in GW" : "The average of each year's lowest 5% of days by technology, in GW") +
    "; the last column is the single lowest day of the year.";
  $("lf-foot").textContent = S.through && partial(+S.through.slice(0, 4)) ? `* ${S.through.slice(0, 4)} runs to ${d3.timeFormat("%b %-d")(new Date(S.through + "T12:00:00"))}, the latest 60-day day.` : "";
}

// ==== When it bottoms out ====================================================================
function drawHours() {
  const el = $("lf-hours"), D = days(), ys = [...new Set(D.map((d) => d.y))];
  const W = width(el), rowH = 22, m = { l: 52, r: 8, t: 4, b: 34 }, H = ys.length * rowH + m.t + m.b, { g, w, h, svg } = frame(el, W, H, m);
  const x = d3.scaleBand().domain(d3.range(1, 25)).range([0, w]).padding(0.06), y = d3.scaleBand().domain(ys).range([0, h]).padding(0.08);
  const cells = ys.flatMap((yr) => { const s = D.filter((d) => d.y === yr), c = d3.rollup(s, (v) => v.length, (d) => d.he); return d3.range(1, 25).map((he) => ({ yr, he, n: c.get(he) || 0, N: s.length, s: (c.get(he) || 0) / s.length })); });
  const col = d3.scaleSequential(d3.interpolateRgb(css("--seq-lo"), css("--seq-hi"))).domain([0, 0.3]).clamp(true);
  g.selectAll("rect").data(cells).join("rect").attr("x", (d) => x(d.he)).attr("y", (d) => y(d.yr)).attr("width", x.bandwidth()).attr("height", y.bandwidth()).attr("rx", 2).attr("fill", (d) => col(d.s))
    .on("pointermove", (ev, d) => showTip(ev, `<h4>${yName(d.yr)}, HE ${d.he}</h4>${d.n} of ${d.N} days (${Math.round(d.s * 100)}%) had their lowest floor in this hour`)).on("pointerleave", hideTip);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).tickFormat(yName).tickSize(0)).call((a) => a.select(".domain").remove());
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`).call(d3.axisBottom(x).tickSize(0).tickFormat((v) => (w < 520 && v % 3 ? "" : v))).call((a) => a.select(".domain").remove());
  svg.append("text").attr("class", "axis-title").attr("x", W - m.r).attr("y", H - 4).attr("text-anchor", "end").text("Hour ending, Central");
  setCSV(el, ["year", "hour_ending", "days", "share"], cells.map((c) => [c.yr, c.he, c.n, +c.s.toFixed(3)]), `Hour the floor bottoms out ${S.fleet}`);
  const modal = (yr) => d3.greatest(cells.filter((c) => c.yr === yr), (c) => c.n)?.he;
  const h0 = modal(ys[0]), h1 = modal(ys.at(-1)), mid = (he) => he >= 10 && he <= 17;
  $("lf-hour-note").textContent = `Share of each year's days whose lowest-floor hour fell in each hour. The commonest hour was HE ${h0} in ${ys[0]} and HE ${h1} in ${ys.at(-1)}${partial(ys.at(-1)) ? " so far" : ""}` +
    (!mid(h0) && mid(h1) ? ": the floor used to bottom out overnight and now bottoms out at midday, as units sit at minimum under solar." : ".");
}

function drawAll() { if (!S.A.length) return; drawDaily(); drawYears(); drawHours(); $("lf-legend").innerHTML = techs().map((t) => `<span><span class="sw" style="background:var(${t.color})"></span>${esc(t.label)}</span>`).join(""); }

(async function () {
  const f = await tryJSON("data/lsl_floor.json.gz");
  if (!f || !(f.rows || []).length) { $("lf-status").textContent = "Data not available yet."; return; }
  const C = f.columns, ix = Object.fromEntries(C.map((c, i) => [c, i]));
  const base = (r) => ({ date: r[0], d: new Date(r[0] + "T12:00:00"), y: +r[0].slice(0, 4) });
  S.A = f.rows.map((r) => { const o = { ...base(r), he: r[ix.he] }; ALL.forEach((t) => (o[t.id] = r[ix[t.id]])); o.total = d3.sum(ALL, (t) => o[t.id]); return o; });
  S.F = f.rows.map((r) => { const o = { ...base(r), he: r[ix.he_fos] }; FOS.forEach((t) => (o[t.id] = r[ix[`${t.id}_fos`]])); o.total = d3.sum(FOS, (t) => o[t.id]); return o; });
  S.through = f.through;
  const ys = [...new Set(S.A.map((d) => d.y))];
  $("lf-period").innerHTML = `<option value="all">All years</option>` + ys.slice().reverse().map((y) => `<option value="${y}">${yName(y)}</option>`).join("");
  $("lf-period").onchange = (e) => { S.period = e.target.value; drawDaily(); };
  $("lf-status").textContent = `${d3.timeFormat("%b %-d, %Y")(new Date(f.from + "T12:00:00"))} to ${d3.timeFormat("%b %-d, %Y")(new Date(f.through + "T12:00:00"))}`;
  bindSeg("lf-fleet", "fleet"); bindSeg("lf-smooth", "smooth"); bindSeg("lf-stat", "stat");
  drawAll();
  let t, lastW = 0;
  new ResizeObserver((e) => { const w = Math.round(e[0].contentRect.width); if (w === lastW) return; lastW = w; clearTimeout(t); t = setTimeout(drawAll, 120); }).observe($("lf-panel"));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", drawAll);
  new MutationObserver(drawAll).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
})();
})();

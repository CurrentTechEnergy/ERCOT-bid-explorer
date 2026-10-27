/* Unit page, day-ahead offer: for a thermal unit (a combined cycle train by configuration), each
   day's minimum-energy offer against its fuel-cost line, with the cheap days it was kept on through
   the cheap stretch, each configuration's size and hot start, and its offer changes; for a wind or
   solar unit with a DAM curve, its day-ahead floor against its real-time floor and the share of its
   available energy awarded day-ahead.  Reads data/dam_offers.json.gz and data/dam_offers/sig-YYYY.json.gz
   (pipeline/dam_offers.py). */
(() => {
"use strict";

const { tryJSON, showTip, hideTip, setCSV, css, esc, axisFmt } = window.CX;
const $ = (id) => document.getElementById(id);
const fmt0 = d3.format(",.0f"), fmtPct = d3.format(".0%");
const fmt$ = (v) => (v == null || isNaN(v) ? "–" : (v < 0 ? "−" : "") + "$" + d3.format(",.2f")(Math.abs(v)));
const fmt$0 = (v) => (v == null || isNaN(v) ? "–" : (v < 0 ? "−" : "") + "$" + fmt0(Math.abs(v)));
const parseDate = (d) => new Date(d + "T12:00:00");
const fmtDate = d3.timeFormat("%a %b %-d, %Y");
const THERMAL = new Set(["combined_cycle", "gas_steam", "combustion_turbine"]);
const PAL = ["--c1", "--c4", "--c7", "--c5", "--c6", "--c3", "--c8", "--c2"];
const S = { D: null, units: null, dates: null };

function emptyMsg(el, msg) { el.innerHTML = `<p class="empty">${msg}</p>`; }
const med = (a) => { const v = a.filter((x) => x != null); return v.length ? d3.median(v) : null; };

// every year's signature file, stitched onto the dates of dam_offers.json.gz
async function load() {
  const D = await tryJSON("data/dam_offers.json.gz");
  if (!D) return;
  const years = [...new Set(D.dates.map((d) => d.slice(0, 4)))];
  const sigs = await Promise.all(years.map((y) => tryJSON(`data/dam_offers/sig-${y}.json.gz`)));
  const pos = new Map(D.dates.map((d, i) => [d, i])), units = {};
  sigs.filter(Boolean).forEach((s) => {
    const at = s.dates.map((d) => pos.get(d));
    Object.entries(s.units).forEach(([n, u]) => {
      const r = units[n] || (units[n] = { tech: u.tech, plant: u.plant });
      Object.entries(u).forEach(([f, v]) => {
        if (!Array.isArray(v)) return;
        const a = r[f] || (r[f] = D.dates.map(() => null));
        v.forEach((x, j) => { if (at[j] != null) a[at[j]] = x; });
      });
    });
  });
  S.D = D; S.units = units; S.dates = D.dates.map(parseDate);
}

// ---- thermal ------------------------------------------------------------------------------
function thermalUnits(U) {
  const own = Object.entries(S.units).filter(([n, r]) => THERMAL.has(r.tech) && (n === U.name || (r.tech === "combined_cycle" && r.plant === U.name)));
  return own.filter(([, r]) => r.mg && r.mg.some((v) => v != null)).sort((a, b) => a[0].localeCompare(b[0]));
}
function unitEvents(U, names) {
  const set = new Set(names);
  return S.D.events.filter((e) => e.plant === U.name || (e.units || []).some((u) => set.has(u)));
}
// the unit's day-ahead offer changes, newest first, under the chart
function changesTable(evs) {
  const D = S.D, el = $("dam-changes");
  if (!evs.length) { el.innerHTML = `<p class="note">No day-ahead offer changes from ${D.first} to ${D.last}.</p>`; return; }
  el.innerHTML = `<table class="data"><thead><tr><th class="t">Date</th><th class="t">Change</th><th class="t">Before → after</th><th class="t">Units</th></tr></thead><tbody>` +
    evs.map((e) => `<tr><td class="t">${e.date}</td><td class="t">${esc(D.kinds[e.kind])}${e.major ? ' <span class="tag">major</span>' : ""}</td>` +
      `<td class="t">${esc(evText(e) || `${e.before} to ${e.after}`)}</td><td class="t muted">${esc((e.units || []).join(", "))}</td></tr>`).join("") + "</tbody></table>";
  setCSV(el, ["date", "kind", "major", "before", "after", "markup_before", "markup_after", "days", "units"],
    evs.map((e) => [e.date, e.kind, e.major, e.before, e.after, e.mk_before ?? null, e.mk_after ?? null, e.days ?? null, (e.units || []).join(" ")]), "Day-ahead offer changes");
}
function evText(e) {
  if (e.kind === "mingen_step") return `${fmt$(e.before)} to ${fmt$(e.after)}/MWh${e.mk_before != null && e.mk_after != null ? ` (${fmt$(e.mk_before)} to ${fmt$(e.mk_after)} against fuel cost)` : ""}`;
  if (e.kind === "priced_out") return `${fmt$(e.after)}/MWh against a usual ${fmt$(e.before)} for ${e.days} day${e.days === 1 ? "" : "s"}`;
  if (e.kind === "start_change") return `hot start ${fmt$0(e.before)} to ${fmt$0(e.after)}`;
  if (e.kind === "renew_floor") return `DA floor ${fmt$(e.before)} to ${fmt$(e.after)}/MWh`;
  return "";
}

function drawThermal(U, list) {
  const D = S.D, cheap = D.cheap, n = D.dates.length, names = list.map(([k]) => k);
  const col = (j) => css(PAL[j % PAL.length]);
  // the fuel-cost line: the offer less its markup, from whichever configuration has it that day
  const line = d3.range(n).map((i) => { for (const [, r] of list) if (r.mg[i] != null && r.mk && r.mk[i] != null) return r.mg[i] - r.mk[i]; return null; });
  const size = list.map(([, r]) => {
    const on = d3.range(n).filter((i) => r.mg[i] != null);
    return { lsl: med(on.map((i) => r.ls[i])), hsl: r.hs ? med(on.map((i) => r.hs[i])) : null, hot: med(on.map((i) => r.ho[i])) };
  });
  // cheap days: kept on (any configuration awarded through the stretch) against filed
  const filed = d3.range(n).filter((i) => cheap[i] && list.some(([, r]) => r.mc && r.mc[i] != null));
  const kept = filed.filter((i) => list.some(([, r]) => r.aw && r.aw[i] === 1));
  const lows = filed.map((i) => d3.min(list, ([, r]) => r.mc[i] ?? undefined));
  const cc = U.tech === "combined_cycle";
  $("dam-title-note").textContent = `${D.first} to ${D.last}`;
  $("dam-note").innerHTML = `Its three-part offer to the day-ahead market each day${cc ? ", one colour per configuration" : ""}. ` +
    `Large squares are cheap days (DA lambda at or below $${D.cheap_usd}) at the offer over the cheap hours: filled when a DAM award kept it on through the cheap stretch, hollow when not. Small faint squares are other days, at the day's offer. ` +
    `The black line is its fuel cost (the EIA heat rate times its hub gas price), and dashed rules mark offer changes. ` +
    (filed.length ? `On ${filed.length} cheap days with an offer it was kept on through ${fmtPct(kept.length / filed.length)} of them; median lowest offer ${fmt$(med(lows))}/MWh. ` : "") +
    `<a href="dayahead.html">Compare it with the fleet on Day-ahead offers</a>.`;
  const sz = (s) => [s.lsl != null ? `${fmt0(s.lsl)}${s.hsl != null ? `–${fmt0(s.hsl)}` : ""} MW` : null, s.hot ? `hot start ${fmt$0(s.hot)}${s.lsl ? `, ${fmt$0(s.hot / s.lsl)}/MW` : ""}` : null].filter(Boolean).join(", ");
  $("dam-legend").innerHTML = list.map(([k], j) => `<span><span class="sw" style="background:${col(j)};border-radius:50%"></span>${esc(k)}${sz(size[j]) ? ` <span class="muted">(${sz(size[j])})</span>` : ""}</span>`).join("") +
    `<span><span class="sw-line" style="border-top:2px solid var(--ink)"></span>Fuel cost</span>` +
    `<span><span class="sw" style="background:var(--ink-2);width:9px;height:9px;border-radius:1px"></span>Cheap day, DAM award kept it on</span>` +
    `<span><span class="sw" style="border:1.5px solid var(--ink-2);width:9px;height:9px;border-radius:1px;background:none;box-sizing:border-box"></span>Cheap day, no award</span>` +
    `<span><span class="mk" style="border-color:var(--c8)"></span>Offer change</span>`;
  const pts = [];
  list.forEach(([k, r], j) => r.mg.forEach((v, i) => {
    if (v == null) return;
    const ch = !!cheap[i] && r.mc && r.mc[i] != null;
    pts.push({ k, j, i, v: ch ? r.mc[i] : v, ch, aw: r.aw ? r.aw[i] : null });
  }));
  const el = $("dam-chart");
  if (!pts.length) return emptyMsg(el, "No three-part offers.");
  const w = Math.max(280, el.clientWidth || 600), H = 320, m = { t: 18, r: 14, b: 28, l: 56 };
  const vals = pts.map((p) => p.v).concat(line.filter((v) => v != null)).sort(d3.ascending);
  const lo = Math.min(0, d3.quantile(vals, 0.01)), hi = Math.max(10, d3.quantile(vals, 0.99));
  const x = d3.scaleTime().domain(d3.extent(S.dates)).range([m.l, w - m.r]);
  const y = d3.scaleLinear().domain([lo, hi]).nice().range([H - m.b, m.t]).clamp(true);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(6).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y), 6, "$").tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(w < 560 ? 4 : 9).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text("Minimum-energy offer, $/MWh");
  if (y.domain()[0] < 0) svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(0)).attr("y2", y(0));
  const evs = unitEvents(U, names);
  svg.append("g").selectAll("line").data(evs).join("line").attr("x1", (e) => x(parseDate(e.date))).attr("x2", (e) => x(parseDate(e.date)))
    .attr("y1", m.t).attr("y2", H - m.b).attr("stroke", css("--c8")).attr("stroke-dasharray", "3 3").attr("opacity", 0.75);
  svg.append("path").attr("d", d3.line().defined((v) => v != null).x((_, i) => x(S.dates[i])).y((v) => y(v))(line))
    .attr("fill", "none").attr("stroke", css("--ink")).attr("stroke-width", 1.3);
  // squares, not circles: circles mean online and offline across the site
  const sq = d3.symbol(d3.symbolSquare);
  svg.append("g").selectAll("path").data(pts).join("path").attr("transform", (p) => `translate(${x(S.dates[p.i])},${y(p.v)})`)
    .attr("d", (p) => sq.size(p.ch ? 32 : 8)()).attr("opacity", (p) => (p.ch ? 1 : 0.4))
    .attr("fill", (p) => (!p.ch || p.aw === 1 ? col(p.j) : css("--surface"))).attr("stroke", (p) => col(p.j)).attr("stroke-width", (p) => (p.ch ? 1.3 : 0));
  const tree = d3.quadtree(pts, (p) => x(S.dates[p.i]), (p) => y(p.v));
  const ring = svg.append("circle").attr("r", 6).attr("fill", "none").attr("stroke", css("--ink")).style("display", "none");
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const [px, py] = d3.pointer(ev), p = tree.find(px, py, 24);
      if (!p) { ring.style("display", "none"); hideTip(); return; }
      ring.style("display", null).attr("cx", x(S.dates[p.i])).attr("cy", y(p.v));
      const es = evs.filter((e) => e.date === D.dates[p.i]);
      showTip(ev, `<h4>${fmtDate(S.dates[p.i])}</h4><table><tr><td>${esc(p.k)}</td><td class="n">${fmt$(p.v)}/MWh</td></tr>` +
        `<tr><td>${p.ch ? "Offer over the cheap hours" : "The day's offer"}</td><td></td></tr>` +
        `<tr><td>Fuel cost</td><td class="n">${fmt$(line[p.i])}/MWh</td></tr></table>` +
        (p.ch ? `<p class="tip-body">${p.aw === 1 ? "Kept on through the cheap stretch" : "Not kept on through the cheap stretch"}</p>` : "") +
        es.map((e) => `<p class="tip-body"><b>${esc(D.kinds[e.kind])}</b>${evText(e) ? `: ${esc(evText(e))}` : ""}</p>`).join(""));
    })
    .on("pointerleave", () => { ring.style("display", "none"); hideTip(); });
  el.replaceChildren(svg.node());
  setCSV(el, ["date", "configuration", "offer", "cheap_hour_offer", "kept_on", "fuel_cost", "lsl", "hsl", "hot_start"],
    list.flatMap(([k, r]) => D.dates.map((d, i) => (r.mg[i] == null ? null : [d, k, r.mg[i], r.mc ? r.mc[i] : null, r.aw ? r.aw[i] : null, line[i], r.ls[i], r.hs ? r.hs[i] : null, r.ho[i]])).filter(Boolean)),
    `${U.name} day-ahead offer`);
  $("dam-share").hidden = true;
  changesTable(evs);
  $("dam-foot").textContent = U.tech === "combustion_turbine" ? "Combustion turbines start for the hours they are needed rather than riding through, so their offer changes are never marked major." : "";
}

// ---- wind and solar --------------------------------------------------------------------------
function drawRenew(U, r) {
  const D = S.D, n = D.dates.length;
  const days = d3.range(n).filter((i) => r.fl[i] != null);
  const gap = days.map((i) => (r.rt[i] != null ? r.fl[i] - r.rt[i] : null));
  $("dam-title-note").textContent = `${D.first} to ${D.last}`;
  $("dam-note").innerHTML = `Wind and solar three-part offers carry no start-up or minimum-energy cost, so the day-ahead offer is just the energy curve. ` +
    `Dots are its day-ahead floor (the first price of the day's most used curve), the line its real-time offer floor. ` +
    `Day-ahead curve filed on ${days.length} days; median floor ${fmt$(med(days.map((i) => r.fl[i])))}/MWh, ${fmt$(med(gap))} above its real-time floor. ` +
    `<a href="dayahead.html#p=renew-panel">Compare it with other wind and solar units on Day-ahead offers</a>.`;
  $("dam-legend").innerHTML = `<span><span class="sw" style="background:var(--c1);border-radius:50%"></span>Day-ahead floor</span>` +
    `<span><span class="sw-line" style="border-top:2px solid var(--c2)"></span>Real-time floor</span>` +
    `<span><span class="sw" style="background:var(--c3)"></span>Day-ahead award share of available energy</span>` +
    `<span><span class="mk" style="border-color:var(--c8)"></span>Offer change</span>`;
  const el = $("dam-chart"), w = Math.max(280, el.clientWidth || 600), H = 280, m = { t: 18, r: 14, b: 28, l: 56 };
  const vals = [...r.fl, ...r.rt].filter((v) => v != null).sort(d3.ascending);
  const x = d3.scaleTime().domain(d3.extent(S.dates)).range([m.l, w - m.r]);
  const y = d3.scaleLinear().domain([Math.min(0, d3.quantile(vals, 0.01)), Math.max(10, d3.quantile(vals, 0.99))]).nice().range([H - m.b, m.t]).clamp(true);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y), 5, "$").tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(w < 560 ? 4 : 9).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text("Offer floor, $/MWh");
  if (y.domain()[0] < 0) svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(0)).attr("y2", y(0));
  const evs = S.D.events.filter((e) => (e.units || []).includes(U.name));
  svg.append("g").selectAll("line").data(evs).join("line").attr("x1", (e) => x(parseDate(e.date))).attr("x2", (e) => x(parseDate(e.date)))
    .attr("y1", m.t).attr("y2", H - m.b).attr("stroke", css("--c8")).attr("stroke-dasharray", "3 3").attr("opacity", 0.75);
  svg.append("path").attr("d", d3.line().defined((v) => v != null).curve(d3.curveStepAfter).x((_, i) => x(S.dates[i])).y((v) => y(v))(r.rt))
    .attr("fill", "none").attr("stroke", css("--c2")).attr("stroke-width", 1.6);
  svg.append("g").selectAll("circle").data(days).join("circle").attr("cx", (i) => x(S.dates[i])).attr("cy", (i) => y(r.fl[i])).attr("r", 2.4).attr("fill", css("--c1"));
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", H - m.b).style("display", "none");
  const tipAt = (ev) => {
    if (!days.length) return;
    const t = x.invert(d3.pointer(ev)[0]), i = days[d3.minIndex(days, (q) => Math.abs(S.dates[q] - t))];
    cross.style("display", null).attr("x1", x(S.dates[i])).attr("x2", x(S.dates[i]));
    const es = evs.filter((e) => e.date === D.dates[i]);
    showTip(ev, `<h4>${fmtDate(S.dates[i])}</h4><table><tr><td>Day-ahead floor</td><td class="n">${fmt$(r.fl[i])}</td></tr><tr><td>Real-time floor</td><td class="n">${fmt$(r.rt[i])}</td></tr>` +
      `<tr><td>Day-ahead award share</td><td class="n">${r.as[i] == null ? "–" : fmtPct(r.as[i])}</td></tr></table>` +
      es.map((e) => `<p class="tip-body"><b>${esc(D.kinds[e.kind])}</b>${e.kind === "renew_floor" ? `: ${fmt$(e.before)} to ${fmt$(e.after)}/MWh` : ""}</p>`).join(""));
  };
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", tipAt).on("pointerleave", () => { cross.style("display", "none"); hideTip(); });
  el.replaceChildren(svg.node());
  setCSV(el, ["date", "da_floor", "rt_floor", "da_award_share"], days.map((i) => [D.dates[i], r.fl[i], r.rt[i], r.as[i]]), `${U.name} day-ahead floor`);
  // award share strip
  const el2 = $("dam-share"), H2 = 120, m2 = { t: 16, r: 14, b: 24, l: 56 };
  el2.hidden = false;
  const y2 = d3.scaleLinear().domain([0, Math.max(0.2, d3.max(r.as.filter((v) => v != null)) || 0)]).nice().range([H2 - m2.b, m2.t]);
  const svg2 = d3.create("svg").attr("viewBox", `0 0 ${w} ${H2}`);
  svg2.append("g").attr("class", "gridline").attr("transform", `translate(${m2.l},0)`).call(d3.axisLeft(y2).ticks(2).tickSize(-(w - m2.l - m2.r)).tickFormat(""));
  svg2.append("g").attr("class", "axis").attr("transform", `translate(${m2.l},0)`).call(d3.axisLeft(y2).ticks(2).tickFormat(fmtPct).tickSizeOuter(0));
  svg2.append("g").attr("class", "axis").attr("transform", `translate(0,${H2 - m2.b})`).call(d3.axisBottom(x).ticks(w < 560 ? 4 : 9).tickSizeOuter(0));
  svg2.append("text").attr("class", "axis-title").attr("x", m2.l).attr("y", 10).text("Day-ahead award, share of available energy");
  const bw = Math.max(1.2, (w - m.l - m.r) / n * 0.8);
  svg2.append("g").selectAll("rect").data(d3.range(n).filter((i) => r.as[i] != null)).join("rect").attr("x", (i) => x(S.dates[i]) - bw / 2).attr("width", bw)
    .attr("y", (i) => y2(r.as[i])).attr("height", (i) => y2(0) - y2(r.as[i])).attr("fill", css("--c3"));
  el2.replaceChildren(svg2.node());
  changesTable(evs);
  $("dam-foot").textContent = "Day-ahead sales through energy-only offers at the plant's node are not included, so this undercounts the plant's day-ahead exposure.";
}

let loaded = null;
async function draw() {
  const U = window.UNIT;
  if (!U) return;
  const box = $("dam-panel");
  if (!loaded) loaded = load();
  await loaded;
  if (window.UNIT !== U) return;
  if (!S.D) { box.hidden = true; return; }
  if (THERMAL.has(U.tech)) {
    const list = thermalUnits(U);
    box.hidden = !list.length;
    if (list.length) drawThermal(U, list);
  } else if (U.tech === "wind" || U.tech === "solar") {
    const r = S.units[U.name];
    box.hidden = !(r && r.fl && r.fl.some((v) => v != null));
    if (!box.hidden) drawRenew(U, r);
  } else box.hidden = true;
}
window.addEventListener("unitchange", draw);
window.addEventListener("unitresize", draw);
if (window.UNIT) draw();
})();

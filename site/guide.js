/* How offers work: a guided walk through offer curves, LSL, SCED, DAM and on/off decisions.
   Reads data/guide.json.gz (pipeline/guide.py: the example day and units), data/index.json (price
   grid) and that day's 60-day technology file for the fleet view. Steps 6 and 7 are the method notes
   for Fleet economics and the hedge signals; step 7's thresholds come from data/ppa.json.gz and
   data/renew_changes.json.gz. */
(() => {
"use strict";
const { getJSON, tryJSON, showTip, hideTip, css, axisFmt } = window.CX;
const $ = (id) => document.getElementById(id);
const fmt0 = d3.format(",.0f");
const fmtP = (v) => (v < 0 ? "−" : "") + "$" + d3.format(",.2f")(Math.abs(v));
const fmtP0 = (v) => (v < 0 ? "−" : "") + "$" + fmt0(Math.abs(v));
const fmt$k = (v) => { const a = Math.abs(v), s = v < 0 ? "−" : ""; return s + "$" + (a >= 1e6 ? d3.format(",.1f")(a / 1e6) + "M" : a >= 1e3 ? fmt0(a / 1e3) + "k" : fmt0(a)); };
const heLabel = (h) => `HE ${h + 1}`;
const FLEET = [
  { id: "nuclear", label: "Nuclear", color: "--c5" },
  { id: "coal", label: "Coal & lignite", color: "--c8" },
  { id: "combined_cycle", label: "Combined cycle", color: "--c1" },
  { id: "gas_steam", label: "Gas steam", color: "--c6" },
  { id: "combustion_turbine", label: "Peakers (CT and recip)", color: "--c2" },
];
const TECH_COLOR = { combined_cycle: "--c1", coal: "--c8", combustion_turbine: "--c2", gas_steam: "--c6", nuclear: "--c5" };
const S = { g: null, grid: null, day: null, unit: 0, hour: 12, ver: "sub", price: 0, mode: "from_lsl" };

const U = () => S.g.units[S.unit];
const width = (el) => Math.max(280, el.clientWidth || el.parentElement.clientWidth || 560);

function curveAt(u, ver, h) {
  const i = u[ver + "_h"][h];
  return i == null ? null : u[ver][i];
}
/** MW the curve offers at or below price p (linear between points, 0 below the first point). */
function mwAt(c, p) {
  const [ps, ms] = c;
  if (p < ps[0]) return 0;
  for (let i = 1; i < ps.length; i++) {
    if (p < ps[i]) return ps[i] === ps[i - 1] ? ms[i - 1] : ms[i - 1] + (ms[i] - ms[i - 1]) * (p - ps[i - 1]) / (ps[i] - ps[i - 1]);
  }
  return ms[ms.length - 1];
}
function svgEl(el, w, h) {
  el.innerHTML = "";
  return d3.select(el).append("svg").attr("viewBox", `0 0 ${w} ${h}`).attr("width", w).attr("height", h);
}
function grid(g, axis, w, m, H, horizontal) {
  g.append("g").attr("class", "gridline").attr("transform", horizontal ? `translate(${m.l},0)` : `translate(0,${H - m.b})`)
    .call(axis.tickSize(horizontal ? -(w - m.l - m.r) : -(H - m.t - m.b)).tickFormat(""));
}

// ------------------------------------------------------- step 2 / 3: unit curve ---
function drawCurve(el, opts) {
  const u = U(), h = S.hour;
  const c = curveAt(u, opts.ver, h);
  if (!c) { el.innerHTML = `<p class="empty">${u.label} had no ${opts.ver === "sub" ? "submitted" : ""} curve in ${heLabel(h)}.</p>`; return null; }
  const lsl = u.lsl[h], hsl = u.hsl[h];
  const w = width(el), H = Math.max(260, Math.min(360, w * 0.6));
  const m = { t: 16, r: 16, b: 40, l: 56 };
  const xMax = Math.max(hsl, d3.max(c[1])) * 1.06;
  const pAll = [...c[0], ...(opts.price != null ? [opts.price] : [])];
  const lo = Math.min(-30, d3.min(pAll)), hi = Math.max(40, Math.min(160, d3.max(c[0]) * 1.1));
  const x = d3.scaleLinear().domain([0, xMax]).range([m.l, w - m.r]);
  const y = d3.scaleLinear().domain([lo, hi]).nice().range([H - m.b, m.t]);
  const svg = svgEl(el, w, H);
  grid(svg, d3.axisLeft(y).ticks(6), w, m, H, true);
  svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(0)).attr("y2", y(0));
  // LSL block
  svg.append("rect").attr("class", "lsl-band").attr("x", x(0)).attr("y", m.t).attr("width", x(lsl) - x(0)).attr("height", H - m.b - m.t);
  svg.append("line").attr("class", "lsl-rule").attr("x1", x(lsl)).attr("x2", x(lsl)).attr("y1", m.t).attr("y2", H - m.b);
  svg.append("text").attr("class", "lab-ink").attr("x", x(lsl / 2)).attr("y", m.t + 14).attr("text-anchor", "middle").text("Minimum output");
  svg.append("text").attr("class", "lab").attr("x", x(lsl / 2)).attr("y", m.t + 28).attr("text-anchor", "middle").text(`LSL ${fmt0(lsl)} MW`);
  svg.append("line").attr("class", "lsl-rule").attr("x1", x(hsl)).attr("x2", x(hsl)).attr("y1", m.t).attr("y2", H - m.b);
  svg.append("text").attr("class", "lab").attr("x", x(hsl) - 4).attr("y", m.t + 14).attr("text-anchor", "end").text(`HSL ${fmt0(hsl)} MW`);
  // curve: faint below LSL, solid from LSL up
  const col = css(TECH_COLOR[u.tech] || "--c1");
  const pts = c[0].map((p, i) => [c[1][i], p]);
  const line = d3.line().x((d) => x(d[0])).y((d) => y(d[1]));
  const id = el.id + "-clip";
  svg.append("clipPath").attr("id", id).append("rect").attr("x", x(lsl)).attr("y", 0).attr("width", w).attr("height", H);
  svg.append("path").attr("class", "curve-faint").attr("stroke", col).attr("d", line(pts));
  svg.append("path").attr("class", "curve-solid").attr("stroke", col).attr("clip-path", `url(#${id})`).attr("d", line(pts));
  svg.append("g").selectAll("circle").data(pts).join("circle").attr("cx", (d) => x(d[0])).attr("cy", (d) => y(d[1])).attr("r", 3)
    .attr("fill", (d) => (d[0] < lsl - 0.5 ? css("--surface") : col)).attr("stroke", col).attr("stroke-width", 1.5)
    .on("mousemove", (ev, d) => showTip(ev, `<h4>${fmt0(d[0])} MW at ${fmtP(d[1])}</h4><p class="tip-body">${d[0] < lsl - 0.5 ? "Below LSL: never dispatched by price." : "From LSL up: SCED can dispatch this."}</p>`))
    .on("mouseleave", hideTip);
  // price line and dispatch point
  if (opts.price != null) {
    const bp = Math.min(hsl, Math.max(lsl, mwAt(c, opts.price)));
    svg.append("line").attr("class", "price-rule").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(opts.price)).attr("y2", y(opts.price));
    svg.append("text").attr("class", "price-label").attr("x", w - m.r - 2).attr("y", y(opts.price) - 5).attr("text-anchor", "end").text(`Price ${fmtP0(opts.price)}`);
    svg.append("circle").attr("class", "bp-dot").attr("cx", x(bp)).attr("cy", y(opts.price)).attr("r", 7).attr("fill", css("--ink"));
    svg.append("text").attr("class", "lab-ink").attr("x", x(bp) + (x(bp) > w * 0.6 ? -10 : 10)).attr("y", y(opts.price) + 18)
      .attr("text-anchor", x(bp) > w * 0.6 ? "end" : "start").text(`Dispatched at ${fmt0(bp)} MW`);
    opts.onBp && opts.onBp(bp, lsl, hsl);
  }
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(axisFmt(d3.axisBottom(x), 6));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y).ticks(6), 6, "$"));
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", H - 6).attr("text-anchor", "end").text("MW");
  svg.append("text").attr("class", "axis-title").attr("x", 4).attr("y", m.t - 4).text("$/MWh");
  return { c, lsl, hsl };
}

function drawStep2() {
  const u = U(), h = S.hour;
  const r = drawCurve($("c2"), { ver: S.ver });
  if (!r) { $("c2-cap").textContent = ""; return; }
  const below = r.c[1].filter((v) => v < r.lsl - 0.5).length;
  const first = r.c[0][0];
  $("c2-cap").textContent = `${u.label}, ${heLabel(h)}. ${S.ver === "sub"
    ? `${r.c[0].length} submitted points; ${below ? `${below} of them below LSL (hollow), drawn dashed because SCED never dispatches there` : "the first point is at LSL"}. ${first <= -249 ? "This curve starts at 0 MW and −$250, so a straight line to the next point would look like MW offered below $0 that are really minimum output." : ""}`
    : `The curve SCED dispatched against. From 0 MW to the first offered point ERCOT uses ${fmtP(first)}: that block is minimum output, not an offer.`}`;
  $("s2-lsl").textContent = fmt0(u.lsl[h]); $("s2-hsl").textContent = fmt0(u.hsl[h]);
}

function drawStep3() {
  const u = U(), h = S.hour;
  $("s3-price-out").textContent = fmtP0(S.price);
  let note = "";
  drawCurve($("c3"), { ver: "sub", price: S.price, onBp: (bp, lsl) => {
    note = bp <= lsl + 0.5 ? `At ${fmtP0(S.price)} the unit sits at LSL: no point on its curve is cheaper, and it cannot go lower while on.` : `At ${fmtP0(S.price)} SCED would dispatch ${fmt0(bp)} MW, ${fmt0(bp - lsl)} MW above LSL (ignoring ramp limits).`;
  } });
  drawDay($("c3d"), "sced");
  $("c3-cap").textContent = `${note} Below: ${u.label} through ${S.g.date}, SCED base point inside its LDL–HDL range, with the hourly system price above.`;
}

// ------------------------------------------------ day strip (steps 3, 4, 5) ---
function drawDay(el, kind) {
  const u = U(), g = S.g, lam = g.lambda;
  const w = width(el);
  const m = { t: 10, r: 14, b: 34, l: 56 };
  const pH = 90, gap = 18, uH = 190, H = m.t + pH + gap + uH + m.b;
  const x = d3.scaleBand().domain(d3.range(24)).range([m.l, w - m.r]).paddingInner(0.15);
  const cx = (h) => x(h) + x.bandwidth() / 2;
  const svg = svgEl(el, w, H);
  // stretch shade
  const [s0, sn] = g.stretch;
  svg.append("rect").attr("class", "price-band").attr("x", x(s0) - 1).attr("width", x(s0 + sn - 1) + x.bandwidth() - x(s0) + 2)
    .attr("y", m.t).attr("height", H - m.t - m.b);
  // price panel
  const yp = d3.scaleLinear().domain([Math.min(0, d3.min(lam)), Math.max(0, d3.max(lam))]).nice().range([m.t + pH, m.t]);
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(yp).ticks(3), 3, "$"));
  svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", yp(0)).attr("y2", yp(0));
  svg.append("g").selectAll("rect").data(lam).join("rect").attr("x", (d, h) => x(h)).attr("width", x.bandwidth())
    .attr("y", (d) => yp(Math.max(0, d))).attr("height", (d) => Math.abs(yp(d) - yp(0)))
    .attr("fill", (d) => css(d < 0 ? "--c8" : "--c-other"))
    .on("mousemove", (ev, d) => showTip(ev, `<h4>${heLabel(lam.indexOf(d))}</h4><p class="tip-body">System price ${fmtP(d)}/MWh</p>`)).on("mouseleave", hideTip);
  svg.append("text").attr("class", "lab").attr("x", m.l + 4).attr("y", m.t + 10).text("System price ($/MWh)");
  // unit panel
  const top = m.t + pH + gap, bot = top + uH;
  const vals = [...u.hsl, ...u.out, ...(kind === "dam" ? u.dam_award || [] : [])].filter((v) => v != null);
  const y = d3.scaleLinear().domain([0, d3.max(vals) * 1.08]).nice().range([bot, top]);
  grid(svg, d3.axisLeft(y).ticks(4), w, { ...m, t: top, b: H - bot }, H, true);
  const area = (lo, hi) => d3.area().defined((h) => u[lo][h] != null && u[hi][h] != null).x(cx).y0((h) => y(u[lo][h])).y1((h) => y(u[hi][h])).curve(d3.curveStep);
  const line = (k) => d3.line().defined((h) => u[k][h] != null).x(cx).y((h) => y(u[k][h])).curve(d3.curveStep);
  const col = css(TECH_COLOR[u.tech] || "--c1");
  if (kind === "sced") {
    svg.append("path").attr("d", area("lsl", "hsl")(d3.range(24))).attr("fill", css("--ink")).attr("opacity", 0.06);
    svg.append("path").attr("d", area("ldl", "hdl")(d3.range(24))).attr("fill", col).attr("opacity", 0.22);
    svg.append("path").attr("d", line("lsl")(d3.range(24))).attr("class", "lsl-rule").attr("fill", "none");
    svg.append("path").attr("d", line("bp")(d3.range(24))).attr("fill", "none").attr("stroke", col).attr("stroke-width", 2.25);
  } else {
    const aw = u.dam_award || [];
    svg.append("g").selectAll("rect").data(d3.range(24)).join("rect").attr("x", (h) => x(h)).attr("width", x.bandwidth())
      .attr("y", (h) => y(aw[h] || 0)).attr("height", (h) => y(0) - y(aw[h] || 0)).attr("fill", col).attr("opacity", 0.35);
    svg.append("path").attr("d", line("lsl")(d3.range(24))).attr("class", "lsl-rule").attr("fill", "none");
    svg.append("path").attr("d", line("out")(d3.range(24))).attr("fill", "none").attr("stroke", col).attr("stroke-width", 2.25);
  }
  // hover readout
  svg.append("g").selectAll("rect").data(d3.range(24)).join("rect").attr("x", (h) => x(h)).attr("width", x.bandwidth()).attr("y", top).attr("height", uH)
    .attr("fill", "transparent").on("mousemove", (ev, h) => {
      const rows = kind === "sced"
        ? [["Base point", u.bp[h]], ["LDL – HDL", u.ldl[h] != null ? `${fmt0(u.ldl[h])} – ${fmt0(u.hdl[h])}` : null], ["LSL", u.lsl[h]], ["HSL", u.hsl[h]]]
        : [["DAM award", (u.dam_award || [])[h]], ["Output", u.out[h]], ["LSL", u.lsl[h]]];
      showTip(ev, `<h4>${heLabel(h)} · ${fmtP(lam[h])}</h4><table>${rows.map(([k, v]) => `<tr><td>${k}</td><td class="n">${v == null ? "–" : typeof v === "string" ? v : fmt0(v) + " MW"}</td></tr>`).join("")}</table>`);
    }).on("mouseleave", hideTip);
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y).ticks(4), 4));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${bot})`)
    .call(d3.axisBottom(x).tickValues(d3.range(0, 24, w < 520 ? 3 : 2)).tickFormat((h) => h + 1));
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", H - 4).attr("text-anchor", "end").text("Hour ending");
  const lab = kind === "sced" ? [["Base point", col, "line"], ["LDL–HDL", col, "band"], ["LSL", null, "dash"]] : [["DAM award", col, "band"], ["Output", col, "line"], ["LSL", null, "dash"]];
  let lx = m.l + 4;
  lab.forEach(([t, c, k]) => {
    const gg = svg.append("g").attr("transform", `translate(${lx},${top + 4})`);
    if (k === "line") gg.append("line").attr("x1", 0).attr("x2", 14).attr("y1", 6).attr("y2", 6).attr("stroke", c).attr("stroke-width", 2.25);
    else if (k === "band") gg.append("rect").attr("width", 12).attr("height", 10).attr("y", 1).attr("fill", c).attr("opacity", kind === "sced" ? 0.3 : 0.4);
    else gg.append("line").attr("class", "lsl-rule").attr("x1", 0).attr("x2", 14).attr("y1", 6).attr("y2", 6);
    const tx = gg.append("text").attr("class", "lab").attr("x", 18).attr("y", 10).text(t);
    lx += 18 + tx.node().getComputedTextLength() + 14;
  });
}

function drawStep4() {
  const u = U(), g = S.g;
  drawDay($("c4"), "dam");
  const [s0, sn] = g.stretch;
  const aw = u.dam_award;
  const inStretch = aw ? d3.range(s0, s0 + sn).filter((h) => (aw[h] || 0) >= u.lsl[h] - 0.5).length : 0;
  $("c4-cap").textContent = aw && aw.some((v) => v != null)
    ? `${u.label}: day-ahead award (bars) against real-time output (line). A DAM award covered its LSL in ${inStretch} of the ${sn} negative-price hours.`
    : `${u.label} had no day-ahead award that day: it submitted no DAM energy offer, and ran on its owner's schedule alone.`;
  const f = g.fleet;
  $("s4-fleet").innerHTML = `Across the fleet that day, <strong>${f.n} thermal units</strong> stayed online through the whole negative stretch, with <strong>${fmt0(f.lsl)} MW</strong> of minimum output between them. Day-ahead awards covered only about <strong>${fmt0(f.lsl_award)} MW (${d3.format(".0%")(f.lsl_award / f.lsl)})</strong> of it. The rest ran on owners' own commitment decisions.`;
}

function drawStep5() {
  const u = U(), g = S.g, r = u.ride;
  const [s0, sn, mean] = g.stretch;
  if (!r) {
    $("k5").innerHTML = "";
    $("c5-cap").textContent = `${u.label} has no Stay-on figures for this stretch.`;
  } else {
    const k = [
      ["Output in the stretch", fmt0(r.mwh) + " MWh"],
      ["Paid at the system price", fmt$k(r.revenue), r.revenue < 0],
      ["Fuel and running cost" + (r.est || r.fuel ? " (est.)" : ""), fmt$k(r.cost), r.cost < 0],
      ["Restart cost if it had cycled off" + (r.est === 2 ? " (generic)" : r.est === 0 ? " (own offer)" : " (est.)"), fmt$k(r.start)],
      [r.saves > 0 ? "Cycling off would have saved" : "Staying on saved", fmt$k(Math.abs(r.saves))],
    ];
    $("k5").innerHTML = k.map(([t, v, neg]) => `<div class="kpi"><span class="v${neg ? " neg" : ""}">${v}</span><span class="k">${t}</span></div>`).join("");
    const f = r.fuel;
    const run = f
      ? `Running cost is estimated from ${f.hub} gas at ${fmtP(f.gas)}/MMBtu × the EIA heat rate of ${f.hr} MMBtu/MWh plus ${fmtP(f.vom)}/MWh variable O&M, or ${fmtP(f.per_mwh)}/MWh. Its own day-ahead minimum-energy offer was ${fmtP(f.mingen)}/MWh, a price set to get committed rather than a cost, so it is not used. Negative gas means the unit was paid to take fuel.`
      : `Running cost is output × minimum-energy cost, ${r.est === 2 ? "using the technology's generic cost because the unit had no three-part offer that day" : r.est === 1 ? "from the unit's most recent three-part offer" : "from the unit's own three-part offer"}.`;
    const start = r.est === 0 ? " The restart cost is the unit's own day-ahead start-up offer."
      : r.start_range ? ` The restart cost is a generic ${r.start_kind} start; real ${r.start_kind}-start offers from other units this type suggest roughly ${fmt$k(r.start_range[0])} to ${fmt$k(r.start_range[2])} for a unit this size (middle half), so read it as an order of magnitude.`
      : " The restart cost is a generic estimate; too few units of this type offer start costs to give a range.";
    $("c5-cap").textContent = `${u.label}, ${heLabel(s0)} to ${heLabel(s0 + sn - 1)} (${sn} hours, average system price ${fmtP(mean)}). ${run}${start}`;
  }
  drawChoice($("c5"), r);
}

/** Two bars: the net cost of running through the stretch against the cost of a restart. */
function drawChoice(el, r) {
  if (!r) { el.innerHTML = ""; return; }
  const rows = [
    { k: "Stay on", sub: "running cost minus what the price paid", v: r.loss },
    { k: "Cycle off", sub: "restart for the evening", v: r.start },
  ];
  const w = width(el), bh = 34, m = { t: 8, r: 70, b: 48, l: w < 480 ? 92 : 230 }, H = m.t + rows.length * (bh + 18) + m.b;
  const x = d3.scaleLinear().domain([Math.min(0, d3.min(rows, (d) => d.v) * 1.05), d3.max(rows, (d) => d.v) * 1.05]).nice().range([m.l, w - m.r]);
  const svg = svgEl(el, w, H);
  grid(svg, d3.axisBottom(x).ticks(4), w, m, H, false);
  rows.forEach((d, i) => {
    const y0 = m.t + i * (bh + 18);
    svg.append("rect").attr("x", Math.min(x(0), x(d.v))).attr("y", y0).attr("width", Math.max(1, Math.abs(x(d.v) - x(0)))).attr("height", bh)
      .attr("fill", css(i ? "--c-other" : TECH_COLOR[U().tech] || "--c1")).attr("rx", 2);
    svg.append("text").attr("class", "lab-ink").attr("x", m.l - 8).attr("y", y0 + 14).attr("text-anchor", "end").text(d.k);
    if (w >= 480) svg.append("text").attr("class", "lab").attr("x", m.l - 8).attr("y", y0 + 28).attr("text-anchor", "end").text(d.sub);
    svg.append("text").attr("class", "mix-value").attr("x", Math.max(x(0), x(d.v)) + 6).attr("y", y0 + bh / 2 + 4).text(fmt$k(d.v));
  });
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`)
    .call(d3.axisBottom(x).ticks(4).tickFormat((v) => fmt$k(v)));
  // which way is good: below $0 the owner comes out ahead, above $0 it pays
  const ax = svg.append("g").attr("transform", `translate(0,${H - 8})`);
  if (x.domain()[0] < 0) ax.append("text").attr("class", "lab-ink").attr("x", x(0) - 6).attr("text-anchor", "end").text(w < 480 ? "← better" : "← better: owner comes out ahead");
  ax.append("text").attr("class", "lab-ink").attr("x", x(0) + 6).text(x.domain()[0] < 0 ? (w < 480 ? "worse →" : "worse: owner pays →") : "Net cost to the owner: bigger is worse →");
}

// --------------------------------------------------- step 6: fleet curves ---
function drawStep6() {
  const el = $("c6"), d = S.day, h = S.hour, gridP = S.grid;
  if (!d) { el.innerHTML = `<p class="empty">The fleet curves for ${S.g.date} did not load.</p>`; return; }
  const j = d.stat_names.indexOf("lsl");
  const lo = -50, hi = 60;
  const idx = gridP.map((p, i) => i).filter((i) => gridP[i] >= lo && gridP[i] <= hi);
  const rows = FLEET.map((s) => {
    const lsl = (d.stats[s.id] && d.stats[s.id][h] && d.stats[s.id][h][j]) || 0;
    const disp = d.dispatchable && d.dispatchable.curves && d.dispatchable.curves[s.id] && d.dispatchable.curves[s.id][h];
    const full = d.curves[s.id] && d.curves[s.id][h];
    const vals = idx.map((i) => (S.mode === "from_lsl" && disp ? (disp[i] ?? 0) + lsl : (full && full[i]) ?? 0));
    return { s, lsl, vals };
  });
  const w = width(el), H = Math.max(280, Math.min(400, w * 0.55));
  const m = { t: 14, r: w >= 560 ? 120 : 16, b: 40, l: 60 };
  const x = d3.scaleLinear().domain([lo, hi]).range([m.l, w - m.r]);
  const y = d3.scaleLinear().domain([0, d3.max(rows, (r) => d3.max(r.vals)) * 1.05]).nice().range([H - m.b, m.t]);
  const svg = svgEl(el, w, H);
  grid(svg, d3.axisLeft(y).ticks(5), w, m, H, true);
  const lam = S.g.lambda[h];
  svg.append("line").attr("class", "price-rule").attr("x1", x(lam)).attr("x2", x(lam)).attr("y1", m.t).attr("y2", H - m.b);
  svg.append("text").attr("class", "price-label").attr("x", x(lam) + 4).attr("y", m.t + 10).text(`Price ${fmtP(lam)}`);
  const prices = idx.map((i) => gridP[i]);
  const line = d3.line().x((v, k) => x(prices[k])).y((v) => y(v));
  rows.forEach((r) => svg.append("path").attr("fill", "none").attr("stroke", css(r.s.color)).attr("stroke-width", 2).attr("d", line(r.vals)));
  if (m.r > 40) {
    // end labels, nudged apart so close lines stay readable
    const labs = rows.map((r) => ({ r, y: y(r.vals[r.vals.length - 1]) + 4 })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < labs.length; i++) labs[i].y = Math.max(labs[i].y, labs[i - 1].y + 13);
    for (let i = labs.length - 2; i >= 0; i--) labs[i].y = Math.min(labs[i].y, labs[i + 1].y - 13);
    labs.forEach((l) => svg.append("text").attr("class", "dlabel").attr("x", w - m.r + 6).attr("y", l.y).text(l.r.s.label));
  }
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(axisFmt(d3.axisBottom(x).ticks(6), 6, "$"));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y).ticks(5), 5));
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", H - 6).attr("text-anchor", "end").text("Offer price ($/MWh)");
  svg.append("text").attr("class", "axis-title").attr("x", 4).attr("y", m.t - 2).text("MW offered at or below price");
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", H - m.b).style("display", "none");
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("mousemove", (ev) => {
      const [px] = d3.pointer(ev);
      const k = Math.max(0, Math.min(prices.length - 1, d3.bisectCenter(prices, x.invert(px))));
      cross.attr("x1", x(prices[k])).attr("x2", x(prices[k])).style("display", null);
      showTip(ev, `<h4>At or below ${fmtP0(prices[k])}</h4><table>${rows.map((r) => `<tr><td><span class="sw" style="background:var(${r.s.color})"></span> ${r.s.label}</td><td class="n">${fmt0(r.vals[k])} MW</td></tr>`).join("")}</table>${S.mode === "from_lsl" ? `<p class="tip-body">Of which LSL: ${fmt0(d3.sum(rows, (r) => r.lsl))} MW across these technologies.</p>` : ""}`);
    }).on("mouseleave", () => { cross.style("display", "none"); hideTip(); });
  $("l6").innerHTML = FLEET.map((s) => `<span><span class="sw" style="background:var(${s.color})"></span>${s.label}</span>`).join("");
  const at = (r, p) => r.vals[prices.indexOf(p)];
  const cc = rows.find((r) => r.s.id === "combined_cycle");
  $("c6-cap").textContent = S.mode === "from_lsl"
    ? `${S.g.date}, ${heLabel(h)}. Each line starts at its technology's online LSL (combined cycle: ${fmt0(cc.lsl)} MW) and rises only with MW offered above it. At this hour's price, combined cycles offered ${fmt0(at(cc, Math.round(lam)) - cc.lsl)} MW above LSL.`
    : `${S.g.date}, ${heLabel(h)}. As ERCOT prices it: combined cycle shows ${fmt0(at(cc, -20))} MW at or below −$20, almost all of it the ${fmt0(cc.lsl)} MW of LSL placed at the placeholder price.`;
  $("s6-link").href = `beyond.html#date=${S.g.date}&he=${h + 1}&lsl=${S.mode}&p=curves-panel`;
}

// ------------------------------------------------------------------ wiring ---
function drawAll() {
  const u = U();
  $("unit-note").textContent = u.note;
  $("hour-out").textContent = heLabel(S.hour);
  $("s2-link").href = `beyond.html#date=${S.g.date}&he=${S.hour + 1}&lsl=ercot&p=curves-panel`;
  drawStep2(); drawStep3(); drawStep4(); drawStep5(); drawStep6();
}
function bindSeg(id, key) {
  const box = $(id);
  box.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (!b) return;
    S[key] = b.dataset.v;
    box.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    drawAll();
  });
}

// step 7: the hedge-signal and bidding-change thresholds, from the same files Renewables reads
async function fillHedgeMethod() {
  const [D, R] = await Promise.all([tryJSON("data/ppa.json.gz"), tryJSON("data/renew_changes.json.gz")]);
  if (D && D.hit_usd != null) $("hit-v").textContent = fmtP0(D.hit_usd);
  if (!R || !R.params) return;
  const P = R.params, fmtA = (v) => (v == null ? "–" : d3.format(".2f")(v));
  $("chg-method").textContent = `A unit's regime is its floor (one offer price most of the day, within $${P.tol}), a day-ahead formula at one settlement point (as fitted on this step), or offers that move within the day. ` +
    `A change is a new regime that holds on at least ${P.min_held} of the next ${P.hold} online days. A floor counts as "back" when the unit held it within the previous ${P.new_days} days. ` +
    `Inside a formula regime, a step of ${fmtA(P.terms_a)} in the share, or of $${P.terms_b} in the offer the formula gives at a $${P.ref_da} DA price, is a terms change. An episode is 1 to ${P.ep_max} days with a median offer at least $${P.ep_usd} from the floor, then back to it. ` +
    `Units of one plant changing the same way within a day are one row. A toggler has ${P.toggle} or more episodes or returns to an earlier floor within a year. ` +
    `Moved dispatch: for the first ${P.hold} online days of the new regime (or the episode's days), an hour counts when the unit was online and its node price fell between the old offer and the new one. Priced up, the old offer would have run, so the energy given up is HSL minus base point; priced down, the base point is energy the old offer would not have produced. Both are valued at the node price. ` +
    `The real-time node price is used where loaded (from ${R.live_first || "–"}); before that only the day-ahead node price is available and the estimate is marked "DA price". Hourly prices smooth over SCED's 5-minute prices, so the MWh are approximate.`;
}

async function main() {
  const [g, index] = await Promise.all([getJSON("data/guide.json.gz"), getJSON("data/index.json")]);
  S.g = g; S.grid = index.grid;
  S.day = await tryJSON(`data/60d/${g.date}.json.gz`);
  const [s0, sn, mean] = g.stretch;
  const low = d3.min(g.lambda), lowH = g.lambda.indexOf(low);
  const dt = new Date(g.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  $("day-key").innerHTML = `<strong>The example day: ${dt}.</strong> Wind and solar pushed ERCOT's system price below $0 for ${sn} straight hours, ${heLabel(s0)} to ${heLabel(s0 + sn - 1)}, averaging ${fmtP(mean)} and reaching ${fmtP(low)} in ${heLabel(lowH)}. Gas, coal and nuclear plants still produced through all of it. The steps below show why.`;
  $("unit").innerHTML = g.units.map((u, i) => `<option value="${i}">${u.label} (${u.name})</option>`).join("");
  $("unit").onchange = (e) => { S.unit = +e.target.value; drawAll(); };
  $("hour").oninput = (e) => { S.hour = +e.target.value; drawAll(); };
  $("s3-price").oninput = (e) => { S.price = +e.target.value; drawStep3(); };
  bindSeg("s2-ver", "ver"); bindSeg("s6-mode", "mode");
  $("status").textContent = `Example day ${g.date} · 60-day data`;
  drawAll();
  let rw = 0;
  window.addEventListener("resize", () => { if (window.innerWidth !== rw) { rw = window.innerWidth; drawAll(); } });
  rw = window.innerWidth;
}
main().catch((e) => { $("status").textContent = "Could not load the example data."; console.error(e); });
fillHedgeMethod().catch((e) => console.error(e));
})();

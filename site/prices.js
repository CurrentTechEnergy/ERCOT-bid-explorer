/* Prices: ERCOT hub prices by year from 2019, from data/prices_years.json.gz (pipeline/prices_years.py):
   duration curves, hours in the tails beside battery capacity and Ship Channel gas, gas units coming
   off in cheap hours, tail spreads, price by hour of day and a year-by-year table.  The page only
   reads and draws what the file holds. */
const { tryJSON, showTip, hideTip, setCSV, css, esc, readHash, writeHash } = window.CX;
const $ = (id) => document.getElementById(id);
const S = { P: null, C: null, mkt: "rt", hub: "HB_HUBAVG", unit: "usd", zoom: "all", hod: "hod_p50", on: new Set() };
const MIN_CHEAP = 15;      // a ride-through month needs this many cheap hours for a dot

const years = () => S.P.years;
const yc = (y) => d3.piecewise(d3.interpolateLab, [css("--yr-old"), css("--yr-mid"), css("--yr-new")])((y - years()[0]) / Math.max(1, years().length - 1));
const cur = () => S.P.data[`${S.mkt}|${S.hub}|full|${S.unit}`] || {};
const usd = () => S.P.data[`${S.mkt}|${S.hub}|full|usd`] || {};
const isUSD = () => S.unit === "usd";
const unitName = () => (isUSD() ? "$/MWh" : "MMBtu/MWh");
const num = (v) => { const a = Math.abs(v); return a >= 1000 ? d3.format(",.0f")(a) : a >= 100 ? a.toFixed(0) : a.toFixed(1); };
const fmt = (v) => (v == null ? "–" : (v < 0 ? "−" : "") + num(v));
const money = (v) => (v == null ? "–" : (v < 0 ? "−" : "") + (isUSD() ? "$" : "") + num(v));
// numbers in one comparison share their decimals (site writing standard)
const same = (vs) => window.CX.fmtPair(vs, isUSD() ? "$/MWh" : "MMBtu/MWh", { dp: d3.max(vs, (v) => Math.abs(v ?? 0)) >= 100 ? 0 : 1 });
const sub = (a, b) => { const [x, y, z] = same([a, b, a - b]); return `${x} − ${y} = ${z}`; };
const tickMoney = (v) => (v < 0 ? "\u2212" : "") + (isUSD() ? "$" : "") + (Math.abs(v) >= 10 || Number.isInteger(v) ? d3.format(",")(Math.round(Math.abs(v))) : Math.abs(v).toFixed(1));
const n125 = (v) => /^[125]0*$/.test(String(Math.round(Math.abs(v))));
const partYear = (y) => { const r = cur()[y]; return !!r && r.to.slice(5) !== "12-31"; };
const yrLabel = (y) => { const r = cur()[y]; return partYear(y) ? `${y} to ${d3.timeFormat("%b %-d")(new Date(r.to + "T12:00:00"))}` : String(y); };
const width = (el) => Math.max(300, el.clientWidth || 640);
function frame(el, W, H, m) {
  el.innerHTML = "";
  const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${W} ${H}`);
  return { svg, g: svg.append("g").attr("transform", `translate(${m.l},${m.t})`), w: W - m.l - m.r, h: H - m.t - m.b };
}
const tipRows = (rows) => `<table>${rows.map(([sw, k, v]) => `<tr><td>${sw ? `<span class="sw" style="background:${sw}"></span> ` : ""}${esc(k)}</td><td class="n">${v}</td></tr>`).join("")}</table>`;

// ==== Price duration curve ===================================================================
function drawPDC() {
  const el = $("pdc"), W = width(el), H = Math.round(Math.min(460, Math.max(300, W * 0.42)));
  const m = { l: 58, r: 14, t: 22, b: 38 }, { g, w, h, svg } = frame(el, W, H, m), R = cur(), xs = S.P.x;
  const Z = { all: [0, 100], top: [0, 5], bot: [85, 100] }[S.zoom];
  const ys = years().filter((y) => S.on.has(y) && R[y]);
  const idx = xs.map((x, i) => i).filter((i) => (xs[i + 1] ?? 101) > Z[0] && (xs[i - 1] ?? -1) < Z[1]);
  let y;
  if (S.zoom === "top") {
    const mx = d3.max(ys, (k) => R[k].curve[0]) || 100, lo = d3.min(ys, (k) => R[k].curve[idx[idx.length - 1]]) || 10;
    y = d3.scaleLog().domain([Math.max(isUSD() ? 20 : 3, lo * 0.9), mx * 1.15]).range([h, 0]).clamp(true);
  } else if (S.zoom === "bot") {
    const lo = d3.min(ys, (k) => R[k].curve[xs.length - 1]), hi = d3.max(ys, (k) => R[k].curve[idx[0]]);
    y = d3.scaleLinear().domain([Math.max(lo ?? -10, isUSD() ? -60 : -20), hi ?? 30]).nice().range([h, 0]).clamp(true);
  } else y = d3.scaleLinear().domain(isUSD() ? [-40, 250] : [-10, 60]).range([h, 0]).clamp(true);
  const x = d3.scaleLinear().domain(Z).range([0, w]);
  const tf = (v) => (S.zoom === "top" && !n125(v) ? "" : tickMoney(v));
  g.append("g").attr("class", "gridline").call(d3.axisLeft(y).ticks(6).tickSize(-w).tickFormat(""));
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(6).tickFormat(tf).tickSizeOuter(0));
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`).call(d3.axisBottom(x).ticks(S.zoom === "all" ? (w < 500 ? 5 : 10) : 5).tickFormat((v) => v + "%").tickSizeOuter(0));
  if (y.domain()[0] < 0) g.append("line").attr("class", "zero").attr("x1", 0).attr("x2", w).attr("y1", y(0)).attr("y2", y(0)).attr("stroke-dasharray", "3 3");
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", H - 4).text("Share of hours with a higher price →");
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 12).text(unitName());
  g.append("clipPath").attr("id", "pdc-clip").append("rect").attr("width", w).attr("height", h + 2).attr("y", -1);
  ys.forEach((k) => {
    const c = R[k].curve;
    g.append("path").attr("d", d3.line().x((i) => x(xs[i])).y((i) => y(c[i])).curve(d3.curveMonotoneX)(idx.filter((i) => c[i] != null)))
      .attr("fill", "none").attr("stroke", yc(k)).attr("stroke-width", k >= years()[years().length - 3] ? 2.4 : 1.5)
      .attr("stroke-dasharray", partYear(k) ? "5 3" : null).attr("clip-path", "url(#pdc-clip)");
  });
  if (S.zoom === "all") g.append("text").attr("class", "axis-title").attr("x", w - 4).attr("y", 12).attr("text-anchor", "end").text(isUSD() ? "Clipped at $250: see Top 5% of hours" : "Clipped at 60");
  const vl = g.append("line").attr("class", "crosshair").attr("y1", 0).attr("y2", h).attr("visibility", "hidden");
  g.append("rect").attr("width", w).attr("height", h).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const px = x.invert(d3.pointer(ev)[0]), i = d3.minIndex(xs, (v) => Math.abs(v - px));
      vl.attr("x1", x(xs[i])).attr("x2", x(xs[i])).attr("visibility", "visible");
      showTip(ev, `<h4>${xs[i]}% of hours (about ${d3.format(",")(Math.round(xs[i] / 100 * 8760))} a year) priced higher</h4>` +
        tipRows(ys.slice().reverse().map((k) => [yc(k), yrLabel(k), money(R[k].curve[i])])));
    })
    .on("pointerleave", () => { vl.attr("visibility", "hidden"); hideTip(); });
  setCSV(el, ["share_of_hours_higher_pct", ...ys.map((k) => `${k}_${S.unit === "usd" ? "usd_mwh" : "mmbtu_mwh"}`)], xs.map((v, i) => [v, ...ys.map((k) => R[k].curve[i])]),
    `Price duration curve ${S.mkt} ${S.hub}`);
  $("pdc-note").textContent = `Every hour of the year sorted from highest price to lowest, one line per year (${S.mkt === "rt" ? "real-time" : "day-ahead"}, ${$("c-hub").selectedOptions[0].text}). ` +
    "A flatter left end means fewer scarcity spikes; a higher right end means fewer cheap and negative hours." + (years().some(partYear) ? " The latest year is dashed: it runs to date." : "");
}

// ==== Batteries, gas and hours in the tails ==================================================
function drawTails() {
  const box = $("tails"); box.innerHTML = "";
  const R = usd(), ys = years().filter((y) => R[y]), B = S.P.battery || {}, G = S.P.gas || {};
  const specs = [
    { t: "Battery capacity at year end (GW)", f: (y) => (B[y] ? B[y].mw / 1000 : null), col: css("--c7"), lab: (v) => v.toFixed(1), tip: (v, y) => `${v.toFixed(1)} GW<br><span class="note">${esc(B[y]?.source || "")}</span>` },
    { t: "Ship Channel gas ($/MMBtu)", f: (y) => R[y].gas, col: css("--gas-line"), lab: (v) => v.toFixed(1), tip: (v, y) => `$${v.toFixed(2)}/MMBtu${G[y]?.filled > 0.05 ? `<br><span class="note">${d3.format(".0%")(G[y].filled)} of days on Henry Hub plus the usual Ship Channel difference</span>` : ""}` },
    { t: "Hours at $1,000 or more", f: (y) => R[y].cnt.ge1000 },
    { t: "Hours at $100 or more", f: (y) => R[y].cnt.ge100 },
    { t: "Hours at $10 or less", f: (y) => R[y].cnt.le10 },
    { t: "Hours at $0 or below", f: (y) => R[y].cnt.le0 },
  ];
  const csvRows = ys.map((y) => [y, ...specs.map((s) => s.f(y))]);
  specs.forEach((s) => {
    const d = document.createElement("div"); d.className = "mini";
    d.innerHTML = `<h3>${esc(s.t)}</h3><div class="chart"></div>`; box.appendChild(d);
    const el = d.querySelector(".chart"), W = Math.max(150, el.clientWidth || 220), H = 150, m = { l: 4, r: 4, t: 16, b: 20 }, { g, w, h } = frame(el, W, H, m);
    const x = d3.scaleBand().domain(ys).range([0, w]).padding(0.18), y = d3.scaleLinear().domain([0, d3.max(ys, s.f) || 1]).range([h, 0]);
    ys.forEach((k) => {
      const v = s.f(k);
      if (v == null) return;
      const part = partYear(k);
      g.append("rect").attr("x", x(k)).attr("width", x.bandwidth()).attr("y", y(v)).attr("height", h - y(v))
        .attr("fill", s.col || yc(k)).attr("opacity", S.on.has(k) ? (part ? 0.55 : 1) : 0.2)
        .on("pointermove", (ev) => showTip(ev, `<h4>${esc(s.t)}, ${yrLabel(k)}</h4>${s.tip ? s.tip(v, k) : d3.format(",")(v)}`)).on("pointerleave", hideTip);
      g.append("text").attr("class", "axis-title").attr("x", x(k) + x.bandwidth() / 2).attr("y", y(v) - 3).attr("text-anchor", "middle").style("font-size", "10px").text(s.lab ? s.lab(v) : d3.format(",")(v));
      g.append("text").attr("class", "axis-title").attr("x", x(k) + x.bandwidth() / 2).attr("y", h + 13).attr("text-anchor", "middle").style("font-size", "10px").text("'" + String(k).slice(2));
    });
    setCSV(el, ["year", "battery_gw", "ship_channel_gas_usd_mmbtu", "hours_ge_1000", "hours_ge_100", "hours_le_10", "hours_le_0"], csvRows, "Batteries, gas and hours in the tails");
  });
  const bLast = ys.filter((y) => B[y]).at(-1);
  $("tails-note").textContent = "Are the tails shrinking as batteries grow? Battery capacity and the gas price sit beside the hours each year spent at the extremes, so the years line up: more batteries should mean fewer hours at $1,000/MWh and fewer at or below $0/MWh. " +
    "Hour counts are always against $/MWh thresholds. The latest year runs to date (lighter bars)." +
    (bLast && /CDR/.test(B[bLast]?.source || "") ? ` ${bLast} battery capacity uses expected in-service dates (${String(B[bLast].source).split(":")[0]}), so it is partly planned.` : bLast && partYear(bLast) ? ` ${bLast} battery capacity is the latest reading: ${B[bLast]?.source || ""}.` : "");
}

// ==== Gas units coming off in cheap hours ====================================================
function drawRide() {
  const el = $("ride"), W = width(el), H = 330, m = { l: 52, r: 14, t: 14, b: 26 }, { g, w, h, svg } = frame(el, W, H, m);
  const C = S.P.ride.columns, rows = S.P.ride.rows.map((r) => Object.fromEntries(C.map((c, i) => [c, r[i]]))).map((r) => ({ ...r, d: new Date(r.ym + "-15T12:00:00"), ratio: r.lsl_cheap == null || !r.lsl_other ? null : 1 - r.lsl_cheap / r.lsl_other }));     // share of the gas minimum that came off for the cheap hours
  if (!rows.length) { el.innerHTML = '<p class="empty">No data yet.</p>'; return; }
  const x = d3.scaleTime().domain([new Date(`${years()[0]}-01-01`), d3.max(rows, (r) => r.d)]).range([0, w]);
  const h1 = Math.round(h * 0.32), gap = 22, top = h1 + gap;
  const yg = d3.scaleLinear().domain([0, d3.max(rows, (r) => r.gas) || 1]).nice().range([h1, 0]);
  const yr = d3.scaleLinear().domain([0, 0.7]).range([h, top]).clamp(true);
  g.append("g").attr("class", "gridline").call(d3.axisLeft(yg).ticks(3).tickSize(-w).tickFormat(""));
  g.append("g").attr("class", "axis").call(d3.axisLeft(yg).ticks(3).tickFormat((v) => "$" + v).tickSizeOuter(0));
  g.append("path").attr("d", d3.line().x((r) => x(r.d)).y((r) => yg(r.gas)).defined((r) => r.gas != null)(rows)).attr("fill", "none").attr("stroke", css("--gas-line")).attr("stroke-width", 2);
  g.append("text").attr("class", "axis-title").attr("x", 6).attr("y", 10).style("fill", css("--gas-line")).text("Ship Channel gas, $/MMBtu");
  g.append("g").attr("class", "gridline").call(d3.axisLeft(yr).ticks(5).tickSize(-w).tickFormat(""));
  g.append("g").attr("class", "axis").call(d3.axisLeft(yr).ticks(5).tickFormat(d3.format(".0%")).tickSizeOuter(0));
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`).call(d3.axisBottom(x).ticks(d3.timeYear.every(1)).tickFormat(w < 560 ? d3.timeFormat("'%y") : d3.timeFormat("%Y")).tickSizeOuter(0));
  g.append("text").attr("class", "axis-title").attr("x", 6).attr("y", top + 10).text("Gas minimum output that came off in cheap hours");
  if (w >= 560) {     // on a phone the key moves into the caption
    g.append("text").attr("class", "axis-title").attr("x", w).attr("y", top + 10).attr("text-anchor", "end").text("Dot size = cheap hours in the month");
    g.append("text").attr("class", "axis-title").attr("x", w).attr("y", top + 24).attr("text-anchor", "end").text(`Gray tick = fewer than ${MIN_CHEAP} cheap hours`);
  }
  const pts = rows.filter((r) => r.ratio != null && r.cheap_h >= MIN_CHEAP), few = rows.filter((r) => !(r.ratio != null && r.cheap_h >= MIN_CHEAP));
  const rs = d3.scaleSqrt().domain([MIN_CHEAP, d3.max(pts, (r) => r.cheap_h) || MIN_CHEAP + 1]).range([2.5, 8]);
  const mon = d3.timeFormat("%b %Y");
  few.forEach((r) => g.append("rect").attr("x", x(r.d) - 2).attr("width", 4).attr("y", h - 9).attr("height", 9).attr("fill", css("--muted")).attr("opacity", 0.55)
    .on("pointermove", (ev) => showTip(ev, `<h4>${mon(r.d)}</h4>${r.cheap_h ? `Only ${r.cheap_h} hour${r.cheap_h === 1 ? "" : "s"}` : "No hours"} at $${S.P.cheap}/MWh or less<br>Ship Channel gas $${r.gas?.toFixed(2)}/MMBtu`)).on("pointerleave", hideTip));
  pts.forEach((r) => g.append("circle").attr("cx", x(r.d)).attr("cy", yr(r.ratio)).attr("r", rs(r.cheap_h)).attr("fill", yc(+r.ym.slice(0, 4))).attr("fill-opacity", 0.85).attr("stroke", css("--surface"))
    .on("pointermove", (ev) => showTip(ev, `<h4>${mon(r.d)}</h4>` + tipRows([[null, "Came off in cheap hours", d3.format(".0%")(r.ratio)],
      [null, "Gas minimum online, cheap hours", `${(r.lsl_cheap / 1000).toFixed(1)} GW`], [null, "Gas minimum online, other hours", `${(r.lsl_other / 1000).toFixed(1)} GW`],
      [null, `Hours at $${S.P.cheap}/MWh or less`, r.cheap_h], [null, "Ship Channel gas", `$${r.gas?.toFixed(2)}/MMBtu`]]))).on("pointerleave", hideTip));
  setCSV(el, ["month", "ship_channel_gas_usd_mmbtu", "cheap_hours", "gas_lsl_online_cheap_mw", "gas_lsl_online_other_mw", "share_came_off"],
    rows.map((r) => [r.ym, r.gas, r.cheap_h, r.lsl_cheap, r.lsl_other, r.ratio == null ? null : +r.ratio.toFixed(3)]), "Gas units coming off in cheap hours");
  const recent = pts.slice(-12), first = pts.filter((r) => r.ym.startsWith(String(years()[0])));
  const mR = d3.mean(recent, (r) => r.ratio), m0 = d3.mean(first, (r) => r.ratio), dm = mR - m0;
  const trend = recent.length && first.length ? ` Over the last ${recent.length} months with enough cheap hours the share averaged ${d3.format(".0%")(mR)}, against ${d3.format(".0%")(m0)} in ${years()[0]}: ` +
    (Math.abs(dm) < 0.05 ? "the gas fleet is not coming off for cheap hours any more than it did." : dm > 0 ? "more of the gas fleet now comes off for cheap hours." : "less of the gas fleet now comes off for cheap hours.") : "";
  $("ride-note").textContent = `The link from cheap hours to the fossil fleet: when prices are at or below $${S.P.cheap}/MWh, how much of the gas fleet's minimum output comes off compared with the rest of the month? ` +
    `One minus combined-cycle and gas steam minimum output (LSL) online in those hours as a share of what is online in the month's other hours. ` +
    `0% means none of it came off for the cheap hours. Cheap hours are real-time Hub average, whatever the controls above say. Runs to ${mon(d3.max(rows, (r) => r.d))}, about two months behind, as the 60-day disclosure does.` + trend +
    (w < 560 ? ` Dot size is the month's cheap hours; a gray tick marks a month with fewer than ${MIN_CHEAP}.` : "");
}

// ==== Spread between the tails ===============================================================
function drawSpread() {
  const el = $("spread"), W = width(el), H = 280, m = { l: 52, r: 124, t: 12, b: 26 }, { g, w, h } = frame(el, W, H, m), R = cur();
  const ys = years().filter((y) => R[y]);
  const ser = [{ k: "99th − 1st pct", f: (y) => R[y].p99 - R[y].p1, c: css("--ink") }, { k: "95th − 5th pct", f: (y) => R[y].p95 - R[y].p5, c: css("--accent") },
    { k: "day's high − low", f: (y) => R[y].sp_mean, c: css("--muted"), dash: "4 3" }];
  const x = d3.scalePoint().domain(ys).range([0, w]).padding(0.3);
  const allv = ys.flatMap((y) => ser.map((s) => s.f(y))).filter((v) => v > 0);
  const lo = isUSD() ? 1 : 0.1;
  const y = d3.scaleLog().domain([Math.max(lo, d3.min(allv) * 0.8), d3.max(allv) * 1.2]).range([h, 0]);
  g.append("g").attr("class", "gridline").call(d3.axisLeft(y).ticks(5).tickSize(-w).tickFormat(""));
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5).tickFormat((v) => (n125(v) || v < 1 ? tickMoney(v) : "")).tickSizeOuter(0));
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`).call(d3.axisBottom(x).tickFormat((v) => "'" + String(v).slice(2)).tickSizeOuter(0));
  ser.forEach((s) => {
    g.append("path").attr("d", d3.line().x((k) => x(k)).y((k) => y(Math.max(lo, s.f(k))))(ys)).attr("fill", "none").attr("stroke", s.c).attr("stroke-width", 2).attr("stroke-dasharray", s.dash || null);
    ys.forEach((k) => g.append("circle").attr("cx", x(k)).attr("cy", y(Math.max(lo, s.f(k)))).attr("r", 3.5).attr("fill", s.c)
      .on("pointermove", (ev) => showTip(ev, `<h4>${yrLabel(k)}</h4>` + tipRows([[null, "99th − 1st percentile", sub(R[k].p99, R[k].p1)],
        [null, "95th − 5th percentile", sub(R[k].p95, R[k].p5)], [null, "Average day's high − low", same([R[k].sp_mean, R[k].sp_med]).join(" (median ") + ")"]])))
      .on("pointerleave", hideTip));
  });
  const last = ys[ys.length - 1], labs = ser.map((s) => ({ s, y: y(Math.max(lo, s.f(last))) + 4 })).sort((a, b) => a.y - b.y);
  labs.forEach((l, i) => { if (i && l.y - labs[i - 1].y < 13) l.y = labs[i - 1].y + 13; g.append("text").attr("class", "axis-title").attr("x", w + 6).attr("y", l.y).style("fill", l.s.c).text(l.s.k); });
  setCSV(el, ["year", "p99", "p1", "p95", "p5", "daily_max_min_mean", "daily_max_min_median"], ys.map((k) => [k, R[k].p99, R[k].p1, R[k].p95, R[k].p5, R[k].sp_mean, R[k].sp_med]), "Spread between the tails");
}

// ==== Price by hour of day ===================================================================
function drawHOD() {
  const el = $("hod"), W = width(el), H = 280, m = { l: 52, r: 14, t: 12, b: 26 }, { g, w, h } = frame(el, W, H, m), R = cur();
  const ys = years().filter((y) => S.on.has(y) && R[y]);
  const x = d3.scaleLinear().domain([1, 24]).range([0, w]);
  const vals = ys.flatMap((k) => R[k][S.hod]).filter((v) => v != null);
  const y = d3.scaleLinear().domain([Math.min(0, d3.min(vals) ?? 0), d3.max(vals) ?? 1]).nice().range([h, 0]);
  g.append("g").attr("class", "gridline").call(d3.axisLeft(y).ticks(5).tickSize(-w).tickFormat(""));
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5).tickFormat(tickMoney).tickSizeOuter(0));
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`).call(d3.axisBottom(x).tickValues([1, 4, 8, 12, 16, 20, 24]).tickFormat((v) => "HE" + v).tickSizeOuter(0));
  ys.forEach((k) => g.append("path").attr("d", d3.line().defined((v) => v != null).x((v, i) => x(i + 1)).y((v) => y(v)).curve(d3.curveMonotoneX)(R[k][S.hod]))
    .attr("fill", "none").attr("stroke", yc(k)).attr("stroke-width", k >= years()[years().length - 3] ? 2.4 : 1.5));
  g.append("rect").attr("width", w).attr("height", h).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const he = Math.max(1, Math.min(24, Math.round(x.invert(d3.pointer(ev)[0]))));
      showTip(ev, `<h4>HE ${he}</h4>` + tipRows(ys.slice().reverse().map((k) => [yc(k), yrLabel(k), money(R[k][S.hod][he - 1])])));
    })
    .on("pointerleave", hideTip);
  setCSV(el, ["hour_ending", ...ys.map(String)], d3.range(24).map((i) => [i + 1, ...ys.map((k) => R[k][S.hod][i])]), `Price by hour of day ${S.hod.slice(4)}`);
}

// ==== Year by year ===========================================================================
const GAS_FN = "Ship Channel gas filled from Henry Hub plus that month's usual difference on days with no Ship Channel price (none before Jul 15, 2019 or for most of Jun 2024 to Aug 2025).";
function drawTable() {
  const R = cur(), C = usd(), ys = years().filter((y) => R[y]), B = S.P.battery || {}, G = S.P.gas || {};
  const head = ["Year", "Hours", "Average", "Median", "99th pct", "1st pct", "99th − 1st", "Average day's high − low", "Hours ≥ $1,000", "Hours ≥ $100", "Hours ≤ $10", "Hours ≤ $0", "Ship Channel gas, $/MMBtu", "Batteries at year end, GW"];
  const dec = (v) => (v == null ? "–" : (v < 0 ? "−" : "") + (isUSD() ? "$" : "") + d3.format(",.1f")(Math.abs(v)));
  const rows = ys.map((k) => { const r = R[k], c = C[k]?.cnt || {}; return [yrLabel(k), r.n, r.mean, r.p50, r.p99, r.p1, r.p99 - r.p1, r.sp_mean, c.ge1000, c.ge100, c.le10, c.le0, r.gas, B[k] ? B[k].mw / 1000 : null, G[k]?.filled > 0.05 ? G[k].filled : 0]; });
  $("tbl").innerHTML = `<thead><tr>${head.map((t) => `<th>${t}</th>`).join("")}</tr></thead><tbody>` + rows.map((r) =>
    `<tr><td>${r[0]}</td><td>${d3.format(",")(r[1])}</td>${r.slice(2, 8).map((v) => `<td>${dec(v)}</td>`).join("")}` +
    `${r.slice(8, 12).map((v) => `<td>${v == null ? "–" : d3.format(",")(v)}</td>`).join("")}<td>${r[12] == null ? "–" : "$" + r[12].toFixed(2)}${r[14] ? `<span class="fn" tabindex="0" data-tip="${esc(GAS_FN)} ${d3.format(".0%")(r[14])} of ${esc(r[0])}'s days filled.">*</span>` : ""}</td><td>${r[13] == null ? "–" : r[13].toFixed(1)}</td></tr>`).join("") + "</tbody>";
  setCSV($("tbl"), ["year", "hours", `mean_${S.unit}`, `median_${S.unit}`, `p99_${S.unit}`, `p1_${S.unit}`, "p99_less_p1", "daily_max_min_mean", "hours_ge_1000", "hours_ge_100", "hours_le_10", "hours_le_0", "ship_channel_gas_usd_mmbtu", "battery_gw"],
    rows.map((r) => [r[0], ...r.slice(1, 14)]), "Year by year");
  $("table-note").textContent = `${S.mkt === "rt" ? "Real-time" : "Day-ahead"} ${$("c-hub").selectedOptions[0].text}, whole years (the latest to date). Prices in ${unitName()}, all to one decimal; the hour counts are always against $/MWh thresholds.`;
  const fixed = S.corrected ? S.corrected[S.mkt] : [];
  $("table-foot").textContent = (rows.some((r) => r[14]) ? `* ${GAS_FN} ` : "") +
    (fixed.length ? `${S.mkt === "rt" ? "Real-time" : "Day-ahead"} prices include ERCOT's after-the-fact price corrections on ${fixed.length} day${fixed.length > 1 ? "s" : ""}: ${shortDays(fixed)}.` : "");
}

// ==== Intervals at the price cap =============================================================
// data/price_cap.json.gz (pipeline/price_cap.py): 15-minute real-time and hourly day-ahead prices
// against the cap in effect, for the Hub average and every hub and load zone.
const PT_NAME = { HB_HUBAVG: "Hub average", HB_BUSAVG: "Bus average", HB_NORTH: "North hub", HB_HOUSTON: "Houston hub", HB_SOUTH: "South hub",
  HB_WEST: "West hub", HB_PAN: "Panhandle hub", LZ_NORTH: "North zone", LZ_HOUSTON: "Houston zone", LZ_SOUTH: "South zone", LZ_WEST: "West zone",
  LZ_AEN: "Austin Energy zone", LZ_CPS: "CPS Energy zone", LZ_LCRA: "LCRA zone", LZ_RAYBN: "Rayburn zone" };
const ptName = (p) => PT_NAME[p] || p;
const capOn = (d) => { let c = S.C.caps[0].cap; S.C.caps.forEach((e) => { if (d >= e.from) c = e.cap; }); return c; };
const dFmt = (d) => d3.timeFormat("%b %-d, %Y")(new Date(d + "T12:00:00"));
const ampm = (h, mi) => `${((h + 11) % 12) + 1}:${String(mi).padStart(2, "0")}${h < 12 ? " am" : " pm"}`;
// real time: "HH:MM" interval start -> "8:00 to 8:15 pm"; day ahead: hour ending -> "HE 20 (7 to 8 pm)"
function slotTxt(t) {
  if (t == null) return "";
  if (typeof t === "string") { const [h, mi] = t.split(":").map(Number), e = h * 60 + mi + 15; return `${ampm(h, mi).replace(/ (am|pm)$/, (h < 12) === (e / 60 % 24 < 12) ? "" : " $1")} to ${ampm(Math.floor(e / 60) % 24, e % 60)}`; }
  return `HE ${t} (${ampm(t - 1, 0).replace(":00", "")} to ${ampm(t % 24, 0).replace(":00", "")})`;
}
const usd0 = (v) => (v == null ? "–" : (v < 0 ? "−$" : "$") + d3.format(",.0f")(Math.abs(v)));
function drawCap() {
  const C = S.C, P = $("cap-panel");
  if (!C) { P.hidden = true; return; }
  const mk = S.mkt, MK = mk === "rt" ? "Real-time" : "Day-ahead", unitTxt = mk === "rt" ? "15-minute intervals" : "hours";
  const col = (k) => C.days.columns.indexOf(k);
  const iD = 0, iM = col(`${mk}_max`), iT = col(mk === "rt" ? "rt_time" : "da_he"), iA = col(`${mk}_any_max`), iP = col(`${mk}_any_point`), iN = col(`${mk}_any_at`);
  const rows = C.days.rows.filter((r) => r[iM] != null || r[iA] != null);
  const last = C.last[mk], lastAny = (C.last_any || {})[mk];
  const k = [];
  k.push([last ? `${dFmt(last[0])}` : "Not since 2019", last ? `Last time the ${mk === "rt" ? "real-time" : "day-ahead"} Hub average reached the cap: ${slotTxt(last[2])} Central, ${usd0(last[3])}/MWh` : `${MK} Hub average has not reached the cap in the data`]);
  if (lastAny && (!last || lastAny[0] > last[0])) k.push([dFmt(lastAny[0]), `Last time any hub or load zone did: ${ptName(lastAny[3])}, ${slotTxt(lastAny[1])}, ${usd0(lastAny[2])}/MWh`]);
  const since = last ? rows.filter((r) => r[iD] > last[0]) : rows;
  const top = since.length ? since.reduce((a, b) => ((b[iM] ?? -1e9) > (a[iM] ?? -1e9) ? b : a)) : null;
  if (top && last) k.push([usd0(top[iM]), `Highest Hub average ${mk === "rt" ? "15-minute price" : "hour"} since then, on ${dFmt(top[iD])}`]);
  $("cap-kpis").innerHTML = k.map(([v, t]) => `<div class="kpi"><span class="v">${esc(v)}</span><span class="k">${esc(t)}</span></div>`).join("");

  // the day's highest price, log scale, with the cap as a step
  const el = $("cap"), W = width(el), H = Math.round(Math.min(340, Math.max(240, W * 0.3)));
  const m = { l: 58, r: 14, t: 22, b: 30 }, { g, w, h, svg } = frame(el, W, H, m);
  const t0 = new Date(rows[0][iD] + "T00:00:00"), t1 = new Date(rows[rows.length - 1][iD] + "T23:59:00");
  const x = d3.scaleTime().domain([t0, t1]).range([0, w]);
  const FLOORP = 100;      // days whose highest price stayed under this are not drawn: they are most days, and say nothing about the cap
  const y = d3.scaleLog().domain([FLOORP, 12000]).range([h, 0]).clamp(true);
  const dt = (d) => new Date(d + "T12:00:00");
  g.append("g").attr("class", "gridline").call(d3.axisLeft(y).tickValues([100, 200, 500, 1000, 2000, 5000, 10000]).tickSize(-w).tickFormat(""));
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).tickValues([100, 200, 500, 1000, 2000, 5000, 10000]).tickFormat((v) => "$" + d3.format(",")(v)).tickSizeOuter(0));
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`).call(d3.axisBottom(x).ticks(d3.timeYear.every(1)).tickFormat(d3.timeFormat("%Y")).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 12).text(W < 560 ? `Day's highest price, $/MWh (log; under $${FLOORP} not drawn)` : `Highest ${mk === "rt" ? "15-minute" : "hourly"} price of each day, $/MWh (log scale; days under $${FLOORP} not drawn)`);
  const capPts = []; C.caps.forEach((c, i) => { const a = new Date(Math.max(+t0, +new Date(c.from + "T00:00:00"))), b = C.caps[i + 1] ? new Date(C.caps[i + 1].from + "T00:00:00") : t1; if (b > t0) capPts.push([a, c.cap], [b, c.cap]); });
  g.append("path").attr("d", d3.line().x((p) => x(p[0])).y((p) => y(p[1])).curve(d3.curveStepAfter)(capPts)).attr("fill", "none").attr("stroke", css("--c8")).attr("stroke-width", 1.5).attr("stroke-dasharray", "5 3");
  C.caps.forEach((c, i) => { const a = Math.max(+t0, +new Date(c.from + "T00:00:00")); if (a < +t1) g.append("text").attr("class", "axis-title").attr("x", x(new Date(a)) + 4).attr("y", y(c.cap) - 5).style("fill", css("--c8")).text(`Cap $${d3.format(",")(c.cap)}`); });
  const any = rows.filter((r) => r[iA] != null && r[iA] >= FLOORP && r[iA] > (r[iM] ?? -1e9) + 0.5);
  // a hub or load zone at the cap on a day the Hub average was not: a red ring, so the plot shows it
  const capAny = (r) => r[iA] >= C.at_cap * capOn(r[iD]) && !(r[iM] >= C.at_cap * capOn(r[iD]));
  g.selectAll(null).data(any.filter((r) => !capAny(r))).join("circle").attr("cx", (r) => x(dt(r[iD]))).attr("cy", (r) => y(r[iA])).attr("r", 1.6).attr("fill", css("--c-other")).attr("opacity", 0.5);
  g.selectAll(null).data(any.filter(capAny)).join("circle").attr("cx", (r) => x(dt(r[iD]))).attr("cy", (r) => y(r[iA])).attr("r", 3.4)
    .attr("fill", "none").attr("stroke", css("--c8")).attr("stroke-width", 1.5);
  const hub = rows.filter((r) => r[iM] != null && r[iM] >= FLOORP);
  g.selectAll(null).data(hub).join("circle").attr("cx", (r) => x(dt(r[iD]))).attr("cy", (r) => y(r[iM])).attr("r", (r) => (r[iM] >= C.at_cap * capOn(r[iD]) ? 3.6 : 1.8))
    .attr("fill", (r) => (r[iM] >= C.at_cap * capOn(r[iD]) ? css("--c8") : css("--ink"))).attr("opacity", (r) => (r[iM] >= C.at_cap * capOn(r[iD]) ? 1 : 0.45));
  const vl = g.append("line").attr("class", "crosshair").attr("y1", 0).attr("y2", h).attr("visibility", "hidden");
  const bis = d3.bisector((r) => dt(r[iD])).center;
  g.append("rect").attr("width", w).attr("height", h).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const r = rows[bis(rows, x.invert(d3.pointer(ev)[0]))]; if (!r) return;
      vl.attr("x1", x(dt(r[iD]))).attr("x2", x(dt(r[iD]))).attr("visibility", "visible");
      const tr = [[css("--ink"), "Hub average", r[iM] == null ? "–" : `${usd0(r[iM])} at ${slotTxt(r[iT])}`]];
      if (r[iA] != null) tr.push([css("--c-other"), `Highest hub or zone (${ptName(r[iP])})`, usd0(r[iA])]);
      if (r[iN]) tr.push([css("--c8"), "Hubs and zones at the cap", String(r[iN])]);
      tr.push([null, "Cap", usd0(capOn(r[iD]))]);
      showTip(ev, `<h4>${dFmt(r[iD])}</h4>` + tipRows(tr));
    })
    .on("pointerleave", () => { vl.attr("visibility", "hidden"); hideTip(); });
  setCSV(el, ["date", `${mk}_hub_average_max_usd_mwh`, mk === "rt" ? "interval_start_central" : "hour_ending", "highest_hub_or_zone_usd_mwh", "highest_hub_or_zone", "hubs_and_zones_at_cap", "cap_usd_mwh"],
    rows.map((r) => [r[iD], r[iM], r[iT], r[iA], r[iP], r[iN], capOn(r[iD])]), `Daily highest price ${mk}`);

  // year by year: the Hub average, and every hub and load zone that reached the cap
  const ys = Object.keys(C.years).sort();
  const tr = ys.map((yr) => {
    const Y = C.years[yr], c = Y[mk] || {}, pts = (Y.points || {})[mk] || {};
    const hit = Object.entries(pts).filter(([p, v]) => p !== C.hub && v.at > 0).sort((a, b) => b[1].at - a[1].at);
    const part = c.to && c.to.slice(5) !== "12-31";
    return { sp: (Y.spread || {})[mk], np: Object.keys(pts).filter((p) => p !== C.hub).length, yr: part ? `${yr} to ${d3.timeFormat("%b %-d")(new Date(c.to + "T12:00:00"))}` : yr, cap: capOn(`${yr}-12-31`), c, hit };
  }).filter((r) => r.c.n);
  const unitT = MK === "Real-time" ? "Intervals" : "Hours";
  const head = ["Year", "Cap", `${unitT} with every hub and load zone at the cap`, `${unitT} with only some at the cap`, "Hub average: at half the cap or more", "Hub average: at $1,000 or more", "Hub average: highest"];
  const n0 = (v) => (v == null ? "–" : d3.format(",")(v));
  // only some at the cap: which hubs and zones, with each one's own count, on hover, tap or focus
  const spTd = (r, k) => {
    const v = (r.sp || {})[k];
    if (k !== "some" || !v || !r.hit.length) return n0(v);
    return `<span class="fn" tabindex="0" data-tip="${esc("Intervals each reached the cap: " + r.hit.map(([p, x]) => `${ptName(p)} ${n0(x.at)}`).join(" · "))}">${n0(v)}</span>`;
  };
  $("cap-tbl").innerHTML = `<thead><tr>${head.map((t) => `<th>${t}</th>`).join("")}</tr></thead><tbody>` + tr.map((r) =>
    `<tr><td>${esc(r.yr)}</td><td>${usd0(r.cap)}</td><td>${spTd(r, "all")}</td><td>${spTd(r, "some")}</td><td>${n0(r.c.half)}</td><td>${n0(r.c.ge1000)}</td><td>${usd0(r.c.max)}</td></tr>`).join("") + "</tbody>";
  setCSV($("cap-tbl"), ["year", "cap_usd_mwh", "all_hubs_and_zones_at_cap", "only_some_at_cap", "hub_average_at_half_cap_or_more", "hub_average_at_1000_or_more", "hub_average_highest_usd_mwh", "points_at_cap"],
    tr.map((r) => [r.yr, r.cap, (r.sp || {}).all, (r.sp || {}).some, r.c.half, r.c.ge1000, r.c.max, r.hit.map(([p, v]) => `${p}:${v.at}`).join(" ")]), `Price cap by year ${mk}`);
  $("cap-note").textContent = `How often ERCOT's ${mk === "rt" ? "real-time" : "day-ahead"} prices reached the system-wide offer cap: $9,000/MWh through 2021, $5,000/MWh from 2022. ` +
    `Counted in ${unitTxt}${mk === "rt" ? ", because a single interval at the cap disappears into an hourly average" : ""}. ` +
    `The dark dots are the Hub average's highest price each day, red where it reached the cap; grey dots mark days a single hub or load zone went higher, usually from congestion in one area, with a red ring where that hub or zone reached the cap and the Hub average did not. ` +
    `A price counts as at the cap at ${d3.format(".0%")(C.at_cap)} of it or more, and that includes prices above it. The cap limits offers and the system price (lambda), but a settlement point price adds congestion and losses, so a hub or load zone, and the Hub average with it, can settle above the cap (dots above the dashed line; the Hub average reached $5,102 on Jul 13, 2022) or just under it. Follows the Market control above; always in $/MWh.`;
  const loc = ((C.local || {}).rows || []).filter((r) => r[1] === mk && r[0] >= "2022");
  $("cap-foot").textContent = (loc.length ? `Days since 2022 when a hub or load zone reached the cap but the Hub average did not: ${loc.map((r) => `${dFmt(r[0])} (${r[5].length <= 3 ? r[5].map(ptName).join(", ") : `${r[5].length} hubs and load zones, highest ${ptName(r[3])} at ${usd0(r[2])}`})`).join("; ")}. ` : "") +
    "Checked against news reports of the same days: Jul 13, 2022 (S&P Global), Jun 20, 2023 and May 8, 2024 (Bloomberg). " +
    "The cap's $2,000 low level applies only after generators' peaker net margin passes its yearly threshold, which has not happened since the cap moved to $5,000.";
}

// ==== controls ===============================================================================
function drawAll() { drawPDC(); drawTails(); drawCap(); drawRide(); drawSpread(); drawHOD(); drawTable(); }
function seg(id, key, after) {
  const el = $(id);
  const mark = () => el.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === S[key])));
  mark();
  el.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; S[key] = b.dataset.v; mark(); save(); (after || drawAll)(); });
}
// "Jan 10, Jan 22 and Aug 30, 2026": the year after each run of days in it
function shortDays(days) {
  const parts = days.map((d) => { const t = new Date(d + "T12:00:00Z"); return { y: t.getUTCFullYear(), s: t.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) }; });
  const out = parts.map((p, i) => p.s + (i === parts.length - 1 || parts[i + 1].y !== p.y ? `, ${p.y}` : ""));
  return out.length > 1 ? `${out.slice(0, -1).join("; ")} and ${out[out.length - 1]}`.replace(/; /g, ", ") : out[0];
}
const save = () => writeHash({ m: S.mkt, h: S.hub, u: S.unit });

(async function () {
  const [P, rtFixed, daFixed] = await Promise.all([tryJSON("data/prices_years.json.gz"), window.CX.correctedDays("rt"), window.CX.correctedDays("da")]);
  S.corrected = { rt: rtFixed, da: daFixed };
  if (!P) { $("status").textContent = "Price data is not available yet."; return; }
  S.P = P;
  S.C = await tryJSON("data/price_cap.json.gz");
  const v = readHash() || {};
  if (["rt", "da"].includes(v.m)) S.mkt = v.m;
  if (P.hubs.includes(v.h)) S.hub = v.h;
  if (["usd", "hr"].includes(v.u)) S.unit = v.u;
  $("c-hub").value = S.hub;
  years().forEach((y) => S.on.add(y));
  const yb = $("c-years");
  years().forEach((y) => {
    const b = document.createElement("button"); b.type = "button"; b.setAttribute("aria-pressed", "true");
    // the key: a dashed swatch and a star for a year that runs to date, as on the duration curve
    b.innerHTML = `<i class="${partYear(y) ? "part" : ""}" style="color:${yc(y)}"></i>${y}${partYear(y) ? "*" : ""}`;
    if (partYear(y)) b.title = `${yrLabel(y)}: the year to date`;
    b.onclick = () => { S.on.has(y) ? S.on.delete(y) : S.on.add(y); b.setAttribute("aria-pressed", String(S.on.has(y))); drawAll(); };
    yb.appendChild(b);
  });
  const part = years().filter(partYear);
  if (part.length) yb.insertAdjacentHTML("beforeend", `<span class="yrs-note">* ${part.map((y) => esc(yrLabel(y))).join(", ")}</span>`);
  seg("c-mkt", "mkt"); seg("c-unit", "unit"); seg("c-zoom", "zoom", drawPDC); seg("c-hod", "hod", drawHOD);
  // the table's footnote marks: the same note as a tooltip on hover, tap or focus
  const fnTip = (ev) => { const f = ev.target.closest?.(".fn"); if (f) showTip(ev.clientX != null ? ev : { clientX: f.getBoundingClientRect().right, clientY: f.getBoundingClientRect().bottom }, esc(f.dataset.tip)); };
  ["tbl", "cap-tbl"].forEach((id) => {
    $(id).addEventListener("pointerover", fnTip); $(id).addEventListener("focusin", fnTip);
    $(id).addEventListener("pointerout", (ev) => { if (ev.target.closest?.(".fn")) hideTip(); }); $(id).addEventListener("focusout", hideTip);
  });
  $("c-hub").addEventListener("change", (e) => { S.hub = e.target.value; save(); drawAll(); });
  $("status").textContent = `Real-time through ${P.through.rt}, day-ahead through ${P.through.da}. Built ${P.built.slice(0, 10)}.`;
  drawAll();
  window.CX.init();
  let rw = 0;
  addEventListener("resize", () => { clearTimeout(rw); rw = setTimeout(drawAll, 150); });
  const recolor = () => { yb.querySelectorAll("i").forEach((i, k) => (i.style.color = yc(years()[k]))); drawAll(); };
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", recolor);
  new MutationObserver(recolor).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  window.CX.panelFromLink?.();
})();

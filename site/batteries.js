/* Batteries: the fleet's charging and discharging by hour against its day-ahead awards, state of
   charge, offer prices, MW bid to charge (or offered to discharge) at set prices, unused room, and
   the same across days.  Reads data/storage/series.json.gz (pipeline/storage.py: every day's
   fleet block, [day][24] per field), data/hourly_context_60d.json.gz (real-time hub price) and
   data/dam_hubs.json.gz (day-ahead hub price).  Hour profiles are for one day or averaged over the
   7 / 30 days ending on it, or every day: MW are means across days, prices medians. */
(() => {
"use strict";

const { tryJSON, showTip, hideTip, setCSV, tickFormat, fmtKind, axisFmt, css } = window.CX;
const $ = (id) => document.getElementById(id);
const S = { B: null, H: null, D: null, day: null, win: "1", side: "chg" };
const HUB = "HB_HUBAVG";
const fmtMW = d3.format(",.0f");
const fmtGW = d3.format(",.1f");
const fmtPct = d3.format(".0%");
const fmtPrice = (v) => (v == null || isNaN(v) ? "–" : d3.format("$,.2f")(v));
const parseDate = (d) => new Date(d + "T12:00:00");
const fmtDate = d3.timeFormat("%a %b %-d, %Y");
const heLabel = (h) => `HE ${String(h + 1).padStart(2, "0")}`;
const HOURS = d3.range(24);

function setSeg(id, value) { $(id).querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === value))); }
function bindSeg(id, key, after) {
  $(id).addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    S[key] = b.dataset.v; setSeg(id, S[key]); after(); saveView();
  });
}
function emptyMsg(el, msg) { el.innerHTML = `<p class="empty">${msg}</p>`; }
function staticLegend(el, list) {
  el.innerHTML = list.map((s) => `<span><span class="sw" style="background:var(${s.color});${s.dash ? "opacity:.55" : ""}"></span>${s.label}</span>`).join("");
}

// ---- the chosen days --------------------------------------------------------------
// indices into the series file's dates for the chosen window ending on S.day
function dayIdx() {
  const dates = S.B.dates, end = dates.indexOf(S.day);
  if (S.win === "all") return dates.map((_, i) => i);
  const n = +S.win;
  return d3.range(Math.max(0, end - n + 1), end + 1);
}
function winLabel() {
  const idx = dayIdx(), d = S.B.dates;
  return idx.length === 1 ? fmtDate(parseDate(d[idx[0]])) : `${idx.length} days, ${d[idx[0]]} to ${d[idx.at(-1)]}`;
}
// one hourly profile over the chosen days: mean (MW) or median (prices), nulls skipped
function profile(rows, how = "mean") {
  const idx = dayIdx();
  return HOURS.map((h) => {
    const v = idx.map((i) => rows[i] && rows[i][h]).filter((x) => x != null);
    return v.length ? (how === "median" ? d3.median(v) : d3.mean(v)) : null;
  });
}
const F = (k, how) => profile(S.B.fleet[k], how);
function rtHub() {
  if (!S.H) return HOURS.map(() => null);
  const at = new Map(S.H.dates.map((d, i) => [d, S.H.hub[i]]));
  return profile(S.B.dates.map((d) => at.get(d)), "median");
}
function daHub() {
  if (!S.D) return HOURS.map(() => null);
  return profile(S.B.dates.map((d) => (S.D.days[d] || {})[HUB]), "median");
}

// ---- hourly chart -------------------------------------------------------------------
// lines: [{ label, color, values, dash?, width? }]; bars: [{ label, color, values }] stacked from
// zero in order (negative values stack downward); opts: { title, H, yFmt, tipFmt, yScale ("price"),
// csvName, tipExtra(h) }
function hourChart(el, opts) {
  const lines = opts.lines || [], bars = opts.bars || [];
  const w = Math.max(280, el.clientWidth || 600), H = opts.H || 280, m = { t: 18, r: 14, b: 30, l: 64 };
  const x = d3.scaleLinear().domain([0.5, 24.5]).range([m.l, w - m.r]);
  const up = HOURS.map((h) => d3.sum(bars, (b) => Math.max(0, b.values[h] || 0)));
  const dn = HOURS.map((h) => d3.sum(bars, (b) => Math.min(0, b.values[h] || 0)));
  const all = [...lines.flatMap((s) => s.values), ...up, ...dn].filter((v) => v != null);
  if (!all.length) return emptyMsg(el, opts.empty || "No data for these days.");
  let y;
  if (opts.yScale === "price") {
    // linear to $10, log above: battery offers run from a few dollars to the $2,000 cap
    const lo = Math.min(-10, d3.min(all)), hi = Math.max(50, d3.max(all));
    y = d3.scaleSymlog().constant(10).domain([lo, hi]).range([H - m.b, m.t]);
  } else {
    y = d3.scaleLinear().domain([Math.min(0, d3.min(all)), Math.max(opts.yMin || 0, d3.max(all))]).nice().range([H - m.b, m.t]);
  }
  const yTicks = opts.yScale === "price"
    ? [-250, -50, -10, 0, 10, 25, 50, 100, 250, 500, 1000, 2000].filter((v) => v >= y.domain()[0] && v <= y.domain()[1])
    : y.ticks(6);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`)
    .call(d3.axisLeft(y).tickValues(yTicks).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`)
    .call(d3.axisLeft(y).tickValues(yTicks).tickFormat(tickFormat(yTicks, fmtKind(opts.yFmt))).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`)
    .call(d3.axisBottom(x).tickValues(w < 560 ? [1, 6, 12, 18, 24] : d3.range(1, 25)).tickFormat(d3.format("d")).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text(opts.title);
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", H - 2).attr("text-anchor", "end").text("Hour ending");
  if (y.domain()[0] < 0) svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(0)).attr("y2", y(0));
  const bw = Math.max(2, (x(2) - x(1)) * 0.72);
  const accUp = HOURS.map(() => 0), accDn = HOURS.map(() => 0);
  bars.forEach((b) => HOURS.forEach((h) => {
    const v = b.values[h];
    if (!v) return;
    const acc = v > 0 ? accUp : accDn, y0 = acc[h], y1 = y0 + v;
    acc[h] = y1;
    svg.append("rect").attr("x", x(h + 1) - bw / 2).attr("width", bw)
      .attr("y", y(Math.max(y0, y1))).attr("height", Math.max(0, Math.abs(y(y0) - y(y1)))).attr("fill", css(b.color));
  }));
  const line = d3.line().defined((v) => v != null).x((_, h) => x(h + 1)).y((v) => y(v));
  lines.forEach((s) => {
    svg.append("path").attr("fill", "none").attr("stroke", css(s.color)).attr("stroke-width", s.width || 2)
      .attr("stroke-dasharray", s.dash || null).attr("d", line(s.values));
    const lone = s.values.map((v, h) => [v, h]).filter(([v, h]) => v != null && s.values[h - 1] == null && s.values[h + 1] == null);
    svg.append("g").selectAll("circle").data(lone).join("circle").attr("cx", ([, h]) => x(h + 1)).attr("cy", ([v]) => y(v)).attr("r", 2.2).attr("fill", css(s.color));
  });
  const tf = opts.tipFmt || fmtMW;
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", H - m.b).style("display", "none");
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const h = Math.max(0, Math.min(23, Math.round(x.invert(d3.pointer(ev)[0])) - 1));
      cross.style("display", null).attr("x1", x(h + 1)).attr("x2", x(h + 1));
      const rows = [...bars, ...lines].filter((s) => s.values[h] != null && !s.noTip);
      showTip(ev, `<h4>${heLabel(h)}</h4><table>` + rows.map((s) =>
        `<tr><td><span class="sw" style="background:var(${s.color})"></span></td><td>${s.label}</td><td class="n">${(s.fmt || tf)(s.values[h])}</td></tr>`).join("") +
        "</table>" + (opts.tipExtra ? opts.tipExtra(h) : ""));
    })
    .on("pointerleave", () => { cross.style("display", "none"); hideTip(); });
  el.replaceChildren(svg.node());
  const cols = [...bars, ...lines];
  setCSV(el, ["hour_ending", ...cols.map((s) => s.label)], HOURS.map((h) => [h + 1, ...cols.map((s) => s.values[h])]), `${opts.csvName || opts.title} ${S.day}${S.win === "1" ? "" : ` (${S.win} days)`}`);
}

const priceTip = (rt, da) => (h) => `<p class="tip-body">Hub price: real-time ${fmtPrice(rt[h])}, day-ahead ${fmtPrice(da[h])}</p>`;

// ---- panels --------------------------------------------------------------------------
function drawFlow() {
  const gw = (a) => a.map((v) => (v == null ? null : v / 1000));
  const neg = (a) => a.map((v) => (v == null ? null : -v));
  const dis = gw(F("dis")), chg = gw(neg(F("chg")));
  const dDis = gw(F("dam_dis")), dChg = gw(neg(F("dam_chg")));
  const list = [
    { label: "Discharging (real time)", color: "--c7", values: dis },
    { label: "Charging (real time)", color: "--c7-soft", values: chg },
  ];
  const dam = [
    { label: "Day-ahead discharge award", color: "--c2", dash: "5 3", values: dDis },
    { label: "Day-ahead charging award", color: "--c1", dash: "5 3", values: dChg },
  ];
  staticLegend($("flow-legend"), [...list, ...dam]);
  const rt = rtHub(), da = daHub();
  hourChart($("flow-chart"), { bars: list, lines: dam, title: "Fleet MW by hour (GW; charging below zero)", yFmt: fmtGW, tipFmt: (v) => `${fmtGW(v)} GW`,
    tipExtra: priceTip(rt, da), csvName: "Battery charging and discharging" });
  const gwh = (a) => d3.sum(a, (v) => Math.abs(v || 0));
  $("flow-note").textContent = `${winLabel()} · ${fmtGW(gwh(chg))} GWh charged, ${fmtGW(gwh(dis))} GWh discharged a day` +
    (dDis.some((v) => v != null) ? ` · day-ahead ${fmtGW(gwh(dChg))} and ${fmtGW(gwh(dDis))}` : "");
}

function drawSoc() {
  const soc = F("soc"), mx = F("soc_max"), mn = F("soc_min");
  const share = HOURS.map((h) => (soc[h] != null && mx[h] ? soc[h] / mx[h] : null));
  const floor = HOURS.map((h) => (mn[h] != null && mx[h] ? mn[h] / mx[h] : null));
  const el = $("soc-chart");
  if (!share.some((v) => v != null)) { $("soc-text").textContent = ""; $("soc-note").textContent = ""; return emptyMsg(el, "No state of charge for these days."); }
  hourChart(el, {
    H: 220, yMin: 1, title: "Fleet state of charge, share of its maximum", yFmt: fmtPct, tipFmt: fmtPct,
    lines: [
      { label: "State of charge", color: "--c7", values: share },
      { label: "Minimum state of charge", color: "--c-other", dash: "4 3", width: 1.5, values: floor },
    ],
    tipExtra: (h) => `<p class="tip-body">${soc[h] == null ? "–" : fmtGW(soc[h] / 1000)} GWh of ${mx[h] == null ? "–" : fmtGW(mx[h] / 1000)} GWh</p>`,
    csvName: "Battery fleet state of charge",
  });
  const top = d3.maxIndex(share, (v) => v ?? -1), low = d3.minIndex(share, (v) => v ?? 2);
  const full = share.findIndex((v) => v != null && v >= 0.9 * share[top]);
  $("soc-note").textContent = winLabel();
  $("soc-text").textContent = `Emptiest at ${heLabel(low)} (${fmtPct(share[low])}), fullest at ${heLabel(top)} (${fmtPct(share[top])} of ${fmtGW(mx[top] / 1000)} GWh). ` +
    (full >= 0 && full !== top ? `The fleet is within 10% of that peak from ${heLabel(full)}.` : "");
}

const OFFERS = [
  { id: "chg50", label: "Half the charging (bid at or below)", color: "--c1", dash: "5 3" },
  { id: "chg0", label: "Charging stops", color: "--c1" },
  { id: "dis0", label: "Discharge starts", color: "--c7" },
  { id: "dis50", label: "Half the discharge (offered at or below)", color: "--c7", dash: "5 3" },
];
function drawOffers() {
  const rt = rtHub(), da = daHub();
  const lines = [
    ...OFFERS.map((o) => ({ ...o, values: F(o.id, "median") })),
    { label: "Hub price, real time", color: "--c-other", width: 1.5, values: rt },
    { label: "Hub price, day-ahead", color: "--c-other", dash: "2 3", width: 1.5, values: da },
  ];
  staticLegend($("offer-legend"), lines);
  hourChart($("offer-chart"), { lines, yScale: "price", H: 300, title: "Fleet offer prices by hour ($/MWh)", yFmt: d3.format("$,.0f"), tipFmt: fmtPrice, csvName: "Battery offer prices" });
}

const BID_PRICES = { chg: ["-20", "0", "10", "20", "30", "50"], dis: ["20", "30", "50", "100", "250"] };
const BID_COLORS = ["--c6", "--c3", "--c4", "--c2", "--c8", "--c5"];
function drawBids() {
  setSeg("bside", S.side);
  const chg = S.side === "chg", key = chg ? "chg_ge" : "dis_le";
  const lines = BID_PRICES[S.side].map((p, i) => ({
    label: chg ? `Bid to charge at ${p < 0 ? "−$" + -p : "$" + p} or more` : `Offered to discharge at $${p} or less`,
    color: BID_COLORS[i], values: profile(S.B[key][p] || []).map((v) => (v == null ? null : v / 1000)),
  }));
  staticLegend($("bid-legend"), lines);
  const rt = rtHub(), da = daHub();
  hourChart($("bid-chart"), { lines, title: `${chg ? "GW the fleet bids to charge" : "GW the fleet offers to discharge"} at each price`,
    yFmt: fmtGW, tipFmt: (v) => `${fmtGW(v)} GW`, tipExtra: priceTip(rt, da), csvName: chg ? "Battery charging bids by price" : "Battery discharge offers by price" });
  $("bid-text").textContent = chg
    ? "How much charging the fleet bids at each price or above it: if the price clears at $10, batteries keep buying the GW on the $10 line. This is demand that competes with flexible load for cheap hours, and it falls away in the afternoon as batteries fill. From the submitted curves, capped at each battery's charging limit (LSL) in each SCED run."
    : "How much discharge the fleet offers at each price or below it, from the submitted curves capped at each battery's HSL in each SCED run. Off-peak most of it is priced high; it moves down toward the expected price in the peak hours.";
}

function drawHeadroom() {
  const gw = (a) => a.map((v) => (v == null ? null : v / 1000));
  const hd = F("head_dis"), hc = F("head_chg"), au = F("as_up"), ad = F("as_dn");
  const pos = (a, b) => HOURS.map((h) => (a[h] == null ? null : Math.max(0, a[h] - (b[h] || 0))));
  const bars = [
    { label: "Discharge room held for AS", color: "--c2", values: gw(au.map((v, h) => (v == null || hd[h] == null ? null : Math.min(v, hd[h])))) },
    { label: "Discharge room free, not used", color: "--c7", values: gw(pos(hd, au)) },
    { label: "Charging room held for AS (Reg-Down)", color: "--c4", values: gw(ad.map((v, h) => (v == null || hc[h] == null ? null : -Math.min(v, hc[h])))) },
    { label: "Charging room free, not used", color: "--c7-soft", values: gw(pos(hc, ad).map((v) => (v == null ? null : -v))) },
  ];
  staticLegend($("head-legend"), bars);
  const rt = rtHub(), da = daHub();
  hourChart($("head-chart"), { bars, title: "Unused room by hour (GW; charging below zero)", yFmt: fmtGW,
    tipFmt: (v) => `${fmtGW(Math.abs(v))} GW`, tipExtra: priceTip(rt, da), csvName: "Battery unused room" });
}

// ---- across days ------------------------------------------------------------------------
function dayChart(el, series, opts) {
  const dates = S.B.dates.map(parseDate);
  const w = Math.max(280, el.clientWidth || 600), H = opts.H || 240, m = { t: 18, r: 14, b: 26, l: 64 };
  const x = d3.scaleTime().domain([d3.timeHour.offset(dates[0], -12), d3.timeHour.offset(dates.at(-1), 12)]).range([m.l, w - m.r]);
  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  if (!all.length) return emptyMsg(el, "No data.");
  const y = d3.scaleLinear().domain([Math.min(0, d3.min(all)), d3.max(all)]).nice().range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y), 5, fmtKind(opts.yFmt)).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(w < 560 ? 4 : 8).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text(opts.title);
  if (y.domain()[0] < 0) svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(0)).attr("y2", y(0));
  const xm = x(parseDate(S.day));
  svg.append("line").attr("class", "crosshair").attr("x1", xm).attr("x2", xm).attr("y1", m.t).attr("y2", H - m.b).style("stroke", css("--accent"));
  const line = d3.line().defined((v) => v != null).x((_, i) => x(dates[i])).y((v) => y(v));
  series.forEach((s) => svg.append("path").attr("fill", "none").attr("stroke", css(s.color)).attr("stroke-width", s.width || 1.6)
    .attr("stroke-dasharray", s.dash || null).attr("d", line(s.values)));
  const tf = opts.tipFmt || fmtGW;
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", H - m.b).style("display", "none");
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const t = x.invert(d3.pointer(ev)[0]), i = d3.minIndex(dates, (d) => Math.abs(d - t));
      cross.style("display", null).attr("x1", x(dates[i])).attr("x2", x(dates[i]));
      showTip(ev, `<h4>${fmtDate(dates[i])}</h4><table>` + series.filter((s) => s.values[i] != null).map((s) =>
        `<tr><td><span class="sw" style="background:var(${s.color})"></span></td><td>${s.label}</td><td class="n">${tf(s.values[i])}</td></tr>`).join("") + "</table>" +
        `<p class="tip-body">Click to show this day above.</p>`);
    })
    .on("click", (ev) => { const t = x.invert(d3.pointer(ev)[0]); setDay(S.B.dates[d3.minIndex(dates, (d) => Math.abs(d - t))]); })
    .on("pointerleave", () => { cross.style("display", "none"); hideTip(); });
  el.replaceChildren(svg.node());
  setCSV(el, ["date", ...series.map((s) => s.label)], S.B.dates.map((d, i) => [d, ...series.map((s) => s.values[i])]), opts.title);
}

function drawDays() {
  const f = S.B.fleet;
  const sum = (rows) => rows.map((r) => (r && r.some((v) => v != null) ? d3.sum(r, (v) => v || 0) / 1000 : null));
  const maxOf = (rows) => rows.map((r) => (r && r.some((v) => v != null) ? d3.max(r) / 1000 : null));
  const energy = [
    { label: "Charged (GWh)", color: "--c7-soft", values: sum(f.chg) },
    { label: "Discharged (GWh)", color: "--c7", values: sum(f.dis) },
    { label: "Day-ahead charging award (GWh)", color: "--c1", dash: "4 3", values: sum(f.dam_chg) },
    { label: "Day-ahead discharge award (GWh)", color: "--c2", dash: "4 3", values: sum(f.dam_dis) },
    { label: "Fleet maximum state of charge (GWh)", color: "--c-other", width: 1.2, values: maxOf(f.soc_max) },
  ];
  staticLegend($("days-legend"), energy);
  dayChart($("days-energy"), energy, { title: "Energy each day (GWh)", tipFmt: (v) => `${fmtGW(v)} GWh` });
  const mid = (rows) => rows.map((r) => { const v = (r || []).slice(9, 16).filter((x) => x != null); return v.length ? d3.mean(v) : null; });
  const minOf = (rows) => rows.map((r) => { const v = (r || []).filter((x) => x != null); return v.length ? d3.min(v) : null; });
  const prices = [
    { label: "Charging stops, HE 10 to 16 average", color: "--c1", values: mid(f.chg0) },
    { label: "Discharge starts, cheapest hour", color: "--c7", values: minOf(f.dis0) },
  ];
  staticLegend($("days-price-legend"), prices);
  dayChart($("days-price"), prices, { title: "Fleet offer prices each day ($/MWh)", yFmt: d3.format("$,.0f"), tipFmt: fmtPrice, H: 200 });
}

// ---- view state -------------------------------------------------------------------------
const VIEW_KEYS = { day: "day", win: "win", side: "side" };
function saveView() { window.CX.writeHash({ ...window.CX.readHash(), ...Object.fromEntries(Object.entries(VIEW_KEYS).map(([k, sk]) => [k, S[sk]])) }); }
function loadView() { const v = window.CX.readHash(); Object.entries(VIEW_KEYS).forEach(([k, sk]) => { if (v[k] != null) S[sk] = v[k]; }); }
function setDay(d) { if (d < CX.SITE_START) d = CX.fromStart(S.B.dates)[0] || d; S.day = d; $("bday").value = d; drawAll(); saveView(); }

function drawAll() { ["offer-note", "bid-note", "head-note"].forEach((id) => { $(id).textContent = winLabel(); }); drawFlow(); drawSoc(); drawOffers(); drawBids(); drawHeadroom(); drawDays(); }

async function boot() {
  [S.B, S.H, S.D] = await Promise.all([tryJSON("data/storage/series.json.gz"), tryJSON("data/hourly_context_60d.json.gz"), tryJSON("data/dam_hubs.json.gz")]);
  if (!S.B || !S.B.dates.length) { $("status").textContent = "No battery data yet. It is built by the data update workflow."; return; }
  // the series file starts before RTC+B; keep the days with batteries on the single-curve model
  const first = S.B.dates.findIndex((_, i) => (S.B.fleet.dis0[i] || []).some((v) => v != null));
  if (first > 0) {
    const cut = (a) => a.slice(first);
    S.B.dates = cut(S.B.dates);
    Object.keys(S.B.fleet).forEach((k) => { S.B.fleet[k] = cut(S.B.fleet[k]); });
    ["chg_ge", "dis_le"].forEach((k) => Object.keys(S.B[k]).forEach((p) => { S.B[k][p] = cut(S.B[k][p]); }));
    S.B.n_units = cut(S.B.n_units);
  }
  const dates = CX.fromStart(S.B.dates);    // the picker's days; the charts keep every day
  $("status").textContent = `Battery offers and dispatch ${dates[0]} to ${dates.at(-1)} · ${S.B.n_units.at(-1)} batteries on the last day`;
  loadView();
  if (!dates.includes(S.day)) S.day = dates.at(-1);
  if (!["1", "7", "30", "all"].includes(S.win)) S.win = "1";
  if (!["chg", "dis"].includes(S.side)) S.side = "chg";
  const rev = dates.slice().reverse();
  $("bday").innerHTML = rev.map((d) => `<option>${d}</option>`).join("");
  $("bday").value = S.day;
  $("bday").onchange = (e) => setDay(e.target.value);
  const step = (k) => { const i = dates.indexOf(S.day) + k; if (i >= 0 && i < dates.length) setDay(dates[i]); };
  $("bday-prev").onclick = () => step(-1); $("bday-next").onclick = () => step(1);
  setSeg("bwin", S.win);
  bindSeg("bwin", "win", drawAll);
  bindSeg("bside", "side", drawBids);
  drawAll();
  window.CX.init();
  saveView();
  let t, lastW = 0;
  new ResizeObserver((e) => { const w = Math.round(e[0].contentRect.width); if (w === lastW) return; lastW = w; clearTimeout(t); t = setTimeout(drawAll, 120); }).observe(document.querySelector("main"));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", drawAll);
}
boot();
})();

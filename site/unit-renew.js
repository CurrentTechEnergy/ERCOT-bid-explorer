/* Unit page, wind and solar: the hedge formula fit, the formula by day and the bidding history
   with its changes, lifted from the Hedge signals unit detail (contracts.js) for the unit unit.js
   has selected. Reads data/ppa.json.gz (pipeline/ppa.py), data/renew_changes.json.gz and
   data/renew/sig-YYYY.json.gz (pipeline/renew_changes.py), and the buyers named in public
   announcements from data/offtakers.json.gz (pipeline/offtakers.py). */
(() => {
"use strict";

const { tryJSON, showTip, hideTip, setCSV, css, esc, axisFmt } = window.CX;
const $ = (id) => document.getElementById(id);
const fmt0 = d3.format(",.0f"), fmtPct = d3.format(".0%");
const fmt$ = (v) => (v == null || isNaN(v) ? "–" : (v < 0 ? "−" : "") + "$" + d3.format(",.2f")(Math.abs(v)));
const fmt$0 = (v) => (v == null || isNaN(v) ? "–" : (v < 0 ? "−" : "") + "$" + fmt0(Math.abs(v)));
const fmtA = (v) => (v == null ? "–" : d3.format(".2f")(v));
const parseDate = (d) => new Date(d + "T12:00:00");
const fmtDate = d3.timeFormat("%a %b %-d, %Y");
const TIER = {
  revealed: { label: "Revealed", color: "--c3", tip: "At least 3 formula days and 24 hours, the formula predicts 80% or more of those hours within the hit band, and no other settlement point fits nearly as well." },
  unclear: { label: "Revealed, location unclear", color: "--c1", tip: "Fits as well as Revealed, but other settlement points fit almost as well (the unit's node prices like them), so the settlement point is not pinned down." },
  partial: { label: "Partial", color: "--c4", tip: "A formula fits at least half of the formula-day hours, or the formula days are too few to call it revealed." },
  hints: { label: "Hints only", color: "--c-other", tip: "No hour-by-hour DA formula in its offers. Its floor offer and day-ahead habit are all the data says." },
};
const ORDER = { revealed: 0, unclear: 1, partial: 2, hints: 3 };
const POINT_LABEL = (p, u) => (p === "node" ? `own node${u && u.sp ? ` (${u.sp})` : ""}` : p);

const S = { unit: null, data: null, R: null, O: null };
const CH = { range: null };
function emptyMsg(el, msg) { el.innerHTML = `<p class="empty">${msg}</p>`; }

// offer against the DA price at the best point, one dot per formula hour, coloured by date
function fitChart(el, u, pts) {
  const D = S.data, w = Math.max(280, el.clientWidth || 600), H = 340, m = { t: 18, r: 16, b: 38, l: 64 };
  if (!pts || !pts.length) return emptyMsg(el, "No formula hours to plot.");
  const xs = pts.map((p) => p[1]), ys = pts.map((p) => p[2]);
  const x = d3.scaleLinear().domain(d3.extent(xs)).nice().range([m.l, w - m.r]);
  const y = d3.scaleLinear().domain(d3.extent([...ys, u.a * x.domain()[0] + u.b, u.a * x.domain()[1] + u.b])).nice().range([H - m.b, m.t]);
  const di = pts.map((p) => p[0]), col = d3.scaleSequential(d3.interpolateRgb(css("--seq-lo"), css("--seq-hi"))).domain([d3.min(di), Math.max(d3.min(di) + 1, d3.max(di))]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(6).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(axisFmt(d3.axisBottom(x), w < 560 ? 5 : 8, "$").tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y), 6, "$").tickSizeOuter(0));
  if (y.domain()[0] < 0 && y.domain()[1] > 0) svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(0)).attr("y2", y(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text("Offer, $/MWh");
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", H - 4).attr("text-anchor", "end").text(`DA price at ${POINT_LABEL(u.point, u)}, $/MWh`);
  svg.append("g").selectAll("circle").data(pts).join("circle")
    .attr("cx", (p) => x(p[1])).attr("cy", (p) => y(p[2])).attr("r", 3).attr("fill", (p) => col(p[0])).attr("fill-opacity", 0.85)
    .attr("stroke", css("--surface")).attr("stroke-width", 0.5);
  const [x0, x1] = x.domain(), fy = (v) => (u.cap != null ? Math.min(u.a * v + u.b, u.cap) : u.a * v + u.b);
  const xk = u.cap != null ? (u.cap - u.b) / u.a : null;
  const line = [x0, ...(xk != null && xk > x0 && xk < x1 ? [xk] : []), x1].map((v) => [x(v), y(Math.max(y.domain()[0], Math.min(y.domain()[1], fy(v))))]);
  svg.append("path").attr("d", d3.line()(line)).attr("fill", "none")
    .attr("stroke", css("--c8")).attr("stroke-width", 1.5).attr("stroke-dasharray", "5 3");
  const ring = svg.append("circle").attr("r", 6).attr("fill", "none").attr("stroke", css("--ink")).style("display", "none");
  const tree = d3.quadtree(pts, (p) => x(p[1]), (p) => y(p[2]));
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const [px, py] = d3.pointer(ev), p = tree.find(px, py, 30);
      if (!p) { ring.style("display", "none"); hideTip(); return; }
      ring.style("display", null).attr("cx", x(p[1])).attr("cy", y(p[2]));
      const pred = fy(p[1]);
      showTip(ev, `<h4>${fmtDate(parseDate(D.dates[p[0]]))}</h4><table>` +
        `<tr><td>DA at ${esc(POINT_LABEL(u.point, u))}</td><td class="n">${fmt$(p[1])}</td></tr>` +
        `<tr><td>Offer</td><td class="n">${fmt$(p[2])}</td></tr>` +
        `<tr><td>Formula</td><td class="n">${fmt$(pred)}</td></tr>` +
        `<tr><td>Off by</td><td class="n">${fmt$(p[2] - pred)}</td></tr></table>`);
    })
    .on("pointerleave", () => { ring.style("display", "none"); hideTip(); });
  el.replaceChildren(svg.node());
  setCSV(el, ["date", "da_price", "offer"], pts.map((p) => [D.dates[p[0]], p[1], p[2]]), `${u.name} offer vs DA`);
  const d0 = D.dates[d3.min(di)], d1 = D.dates[d3.max(di)];
  $("fit-legend").innerHTML = `<span class="dot-legend">Formula hours, by date <span class="muted">${d0}</span><span class="ramp" style="background:linear-gradient(90deg, ${css("--seq-lo")}, ${css("--seq-hi")})"></span><span class="muted">${d1}</span></span>` +
    `<span><span class="sw-line" style="border-top-color:var(--c8)"></span>Fitted formula${u.cap != null ? `, capped at ${fmt$(u.cap)}` : ""}</span>`;
}

// share and intercept fitted on each formula day alone
function dailyChart(el, u) {
  const rs = (u.daily || []).filter((r) => r[1] != null && r[2] != null);
  if (!rs.length) return emptyMsg(el, "No daily fits.");
  const w = Math.max(280, el.clientWidth || 600), H = 200, m = { t: 18, r: 56, b: 26, l: 64 };
  const dates = rs.map((r) => parseDate(r[0]));
  const span = d3.extent(dates);
  if (+span[0] === +span[1]) { span[0] = d3.timeDay.offset(span[0], -1); span[1] = d3.timeDay.offset(span[1], 1); }
  const x = d3.scaleTime().domain(span).range([m.l, w - m.r]);
  const yb = d3.scaleLinear().domain(d3.extent([...rs.map((r) => r[2]), 0])).nice().range([H - m.b, m.t]);
  const ya = d3.scaleLinear().domain([0, Math.max(1.2, d3.max(rs, (r) => r[1]))]).nice().range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(yb).ticks(4).tickSize(-(w - m.l - m.r)).tickFormat(""));
  const short = span[1] - span[0] < 20 * 864e5;
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`)
    .call((short ? d3.axisBottom(x).ticks(d3.timeDay.every(w < 560 ? 2 : 1)).tickFormat(d3.timeFormat("%b %-d")) : d3.axisBottom(x).ticks(w < 560 ? 4 : 8)).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(yb), 4, "$").tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${w - m.r},0)`).call(d3.axisRight(ya).ticks(4).tickFormat(d3.format(".1f")).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text("Intercept, $/MWh");
  svg.append("text").attr("class", "axis-title").attr("x", w - m.r).attr("y", 10).attr("text-anchor", "end").text("Share");
  svg.append("g").selectAll("circle").data(rs).join("circle").attr("cx", (r) => x(parseDate(r[0]))).attr("cy", (r) => yb(r[2])).attr("r", 2.5).attr("fill", css("--c1"));
  svg.append("g").selectAll("rect").data(rs).join("rect").attr("x", (r) => x(parseDate(r[0])) - 2).attr("y", (r) => ya(r[1]) - 2).attr("width", 4).attr("height", 4).attr("fill", css("--c2"));
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", H - m.b).style("display", "none");
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const t = x.invert(d3.pointer(ev)[0]), i = d3.minIndex(dates, (d) => Math.abs(d - t)), r = rs[i];
      cross.style("display", null).attr("x1", x(dates[i])).attr("x2", x(dates[i]));
      showTip(ev, `<h4>${fmtDate(dates[i])}</h4><table><tr><td><span class="sw" style="background:var(--c2)"></span></td><td>Share</td><td class="n">${fmtA(r[1])}</td></tr>` +
        `<tr><td><span class="sw" style="background:var(--c1)"></span></td><td>Intercept</td><td class="n">${fmt$(r[2])}</td></tr>` +
        `<tr><td></td><td>Fit error (RMS)</td><td class="n">${fmt$(r[3])}</td></tr><tr><td></td><td>Hours</td><td class="n">${r[4]}</td></tr></table>`);
    })
    .on("pointerleave", () => { cross.style("display", "none"); hideTip(); });
  el.replaceChildren(svg.node());
  setCSV(el, ["date", "share", "intercept", "rmse", "hours"], rs, `${u.name} daily formula`);
}

// buyers named in public announcements (pipeline/offtakers.py); kept apart from the strike, which is read from offers
const DEAL = { vppa: "Virtual PPA", hedge: "Hedge", ppa: "PPA, type not stated", ppa_recs: "PPA, power and RECs",
  recs: "RECs only, no power purchase", contract: "Contract, type not stated" };
const SOURCE = { developer: "developer", owner: "owner", buyer: "buyer", utility_or_city: "utility or city", trade_press: "trade press", other: "other" };
const fmtAnn = (d) => (d ? d3.timeFormat("%b %Y")(parseDate(d)) : "–");
function drawOfftakers(name) {
  const O = S.O, part = $("offtake-part"), ix = O && O.units[name];
  part.hidden = !ix || !ix.length;
  if (part.hidden) return;
  const rs = ix.map((i) => Object.fromEntries(O.columns.map((k, j) => [k, O.rows[i][j]])))
    .sort((a, b) => (b.announced || "").localeCompare(a.announced || ""));
  const size = (r) => [r.mw != null ? `${fmt0(r.mw)} MW` : null, r.share_pct != null ? `${fmt0(r.share_pct)}% of output` : null].filter(Boolean).join(", ") || "–";
  const flags = (r) => [r.phase === "unclear" ? "Phase not stated: the source names the project, not which phase" : null,
    r.may_have_expired ? "May have expired: the stated term has run out" : null,
    r.pre2012_no_term ? "Announced before 2012, term not stated" : null].filter(Boolean).map(esc).join("<br>") || "–";
  const el = $("offtake-table");
  el.innerHTML = `<table class="data"><thead><tr><th class="t">Buyer</th><th class="t">Deal, as stated</th><th>Size</th><th>Term</th><th>Announced</th><th class="t">Notes</th><th class="t">Source</th></tr></thead><tbody>` +
    rs.map((r) => `<tr${r.may_have_expired || r.pre2012_no_term ? ' class="minor"' : ""}><td class="t ev">${esc(r.buyer)}${r.quote ? `<br><span class="muted">“${esc(r.quote)}”</span>` : ""}</td>` +
      `<td class="t">${DEAL[r.deal] || DEAL.contract}</td><td>${size(r)}</td><td>${r.term_years != null ? `${fmt0(r.term_years)} yr` : "–"}</td><td>${fmtAnn(r.announced)}</td>` +
      `<td class="t ev">${flags(r)}</td><td class="t"><a href="${esc(r.source_url)}" target="_blank" rel="noopener">${esc(SOURCE[r.source_kind] || "source")}</a></td></tr>`).join("") + "</tbody></table>";
  setCSV(el, ["unit", "buyer", "deal", "mw", "share_pct", "term_years", "announced", "phase", "may_have_expired", "pre2012_no_term", "source_kind", "source_url", "quote"],
    rs.map((r) => [name, r.buyer, r.deal, r.mw, r.share_pct, r.term_years, r.announced, r.phase, r.may_have_expired, r.pre2012_no_term, r.source_kind, r.source_url, r.quote]), `${name} public contracts`);
}

function drawUnit() {
  const box = $("renew-panel"), u = S.data && S.data.units.find((v) => v.name === S.unit);
  const inR = S.R && S.R.events.some((e) => e.units.includes(S.unit));
  if (!u && !inR) { box.hidden = true; return; }
  box.hidden = false;
  drawOfftakers(S.unit);
  drawHistory(S.unit);
  $("ppa-part").hidden = !u;
  if (!u) {
    const e = S.R.events.find((v) => v.units.includes(S.unit));
        $("unit-formula").textContent = "";
    $("ppa-note").textContent = "Not in the loaded 60-day days (it may have been renamed or retired), so only its bidding history is shown.";
    return;
  }
  const floorIsCap = u.cap != null && u.floor != null && Math.abs(u.floor - u.cap) < 0.05;
  const habit = `${floorIsCap ? `Its most common offer, ${fmt$(u.floor)}, is the cap, not a floor` : `Usual floor offer ${fmt$(u.floor)}`}. Day-ahead: ${u.da_share == null ? "no data" : `awards equal to ${fmtPct(u.da_share)} of its real-time energy, with an award on ${fmtPct(u.da_days || 0)} of ${u.avail_days} days`}.`;
  if (u.tier === "hints") {
    $("unit-formula").textContent = "No day-ahead formula in its offers.";
    $("ppa-note").textContent = habit;
    $("fit-legend").innerHTML = "";
    emptyMsg($("fit-chart"), "Its offers never moved hour by hour with a DA price on enough hours to fit.");
    emptyMsg($("daily-chart"), "No formula days.");
    return;
  }
  const strikeTxt = u.strike_lo == null
    ? `If the intercept is all strike, the strike is ${fmt$(u.strike_hi)}/MWh (a $${S.data.credit} credit would leave nothing for a strike, so the bidder likely counts none).`
    : `Implied strike ${fmt$(u.strike_lo)} to ${fmt$(u.strike_hi)}/MWh: ${fmt$(u.strike_hi)} if the intercept is all strike, ${fmt$(u.strike_lo)} if the operator also counts a $${S.data.credit}/MWh credit such as the PTC.`;
  const fx = `${fmtA(u.a)} × DA(${POINT_LABEL(u.point, u)}) ${u.b < 0 ? "−" : "+"} ${fmt$(Math.abs(u.b))}`;
  $("unit-formula").textContent = u.cap != null ? `offer = min(${fx}, ${fmt$(u.cap)})` : `offer = ${fx}`;
  const capTxt = u.cap != null
    ? `Capped at ${fmt$(u.cap)}: on ${fmt0(u.cap_hours)} formula-day hours the formula was higher and the offer sat at the cap, so it runs at any price above ${fmt$(u.cap)} even when the formula says it loses money.`
    : u.capped === false ? "Uncapped: its offers followed the formula above $0." : "No cap tested: the formula never rose high enough to show one.";
  const alt = (u.alt || []).map(([p, h]) => `${POINT_LABEL(p, u)} ${fmtPct(h)}`).join(", ");
  $("ppa-note").textContent = `${TIER[u.tier].label}. The formula predicts ${fmtPct(u.hit)} of ${fmt0(u.hours)} formula hours within $${S.data.hit_usd}, on ${u.days} days from ${u.first} to ${u.last}` +
    `${alt ? ` (next best: ${alt})` : ""}. ${capTxt} ${strikeTxt} ${habit}` + (u.group ? ` Bid on the same rule as ${S.data.units.filter((v) => v.group === u.group && v.name !== u.name).map((v) => v.name).join(", ")}.` : "");
  fitChart($("fit-chart"), u, S.data.fits[u.name]);
  dailyChart($("daily-chart"), u);
}

// ---- bidding history (data/renew_changes.json.gz, pipeline/renew_changes.py) ----------------
const PTC_TAG = { level: { label: "PTC level", tip: "A floor change inside the PTC band of $5 or less: re-pricing the credit (the yearly inflation adjustment does this), not a change of approach." },
  expired: { label: "PTC may have expired", tip: "The floor left the PTC band for about $0 and never came back to it. The PTC runs 10 years from the plant's start, so this is what its end looks like; inferred, since the data has no start dates." } };
const ptcTag = (e) => (e.ptc ? ` <span class="tag" title="${esc(PTC_TAG[e.ptc].tip)}">${PTC_TAG[e.ptc].label}</span>` : "");
const MOVED = [
  { id: "yes", label: "Moved dispatch", color: "--c1" },
  { id: "no", label: "Did not move dispatch", color: "--c-other" },
  { id: "na", label: "Not estimated", color: "--c7-soft" },
];
const movedId = (e) => (e.moved == null ? "na" : e.moved ? "yes" : "no");
const fmtMWh = (v) => (v == null ? "–" : fmt0(v) + " MWh");
function regime(r, sp) {
  if (!r) return "–";
  if (r.k === "f") return `${fmt$(r.v)} floor`;
  if (r.k === "x") return `formula ${fmtA(r.a)} × ${esc(r.pt === "node" ? `own node${sp ? ` (${sp})` : ""}` : r.pt)} ${r.b < 0 ? "−" : "+"} ${fmt$(Math.abs(r.b))}`;
  if (r.k === "peak") return `${r.formula ? "formula, " : ""}up to ${fmt$(r.v)}`;
  return "moving within the day";
}
// the window a change's moved dispatch is measured over: its days in the new regime up to the
// next change, at most a year (pipeline/renew_changes.py WINDOW_MAX)
function winText(im) {
  if (!im.days) return "";
  return `${fmt0(im.days)} day${im.days === 1 ? "" : "s"}${im.open ? " so far" : ""}${im.capped ? ", capped at 1 year" : ""}`;
}
const perDay = (im) => (im.days ? ((im.up || 0) + (im.dn || 0)) / im.days : null);
function impactText(e) {
  const im = e.impact;
  if (!im) return `<span class="muted">${e.before.k === "v" ? "no fixed old offer" : "no hourly data"}</span>`;
  const da = im.est > 0.5 ? ", DA price" : "", win = winText(im);
  if (!e.moved) return `<span class="muted">no${win ? `, ${win}` : ""}${da}</span>`;
  const parts = [];
  if (im.up) parts.push(`gave up ${fmtMWh(im.up)}`);
  if (im.dn) parts.push(`ran ${fmtMWh(im.dn)} more`);
  return `<span class="moved">${parts.join(", ")}</span> <span class="muted">${win ? `over ${win} (${fmt0(perDay(im))} MWh/day), ` : ""}${im.hours} h${da}</span>`;
}
function valueText(e) {
  const im = e.impact;
  if (!im || !e.moved) return "–";
  const v = [];
  if (im.up) v.push(fmt$0(im.v_up));
  if (im.dn) v.push(fmt$0(im.v_dn));
  return im.days ? `<span title="${esc(`Over ${winText(im)}: ${fmt$0(((im.v_up || 0) + (im.v_dn || 0)) / im.days)} a day`)}">${v.join(" / ")}</span>` : v.join(" / ");
}
const pct = (v) => (v == null ? "–" : fmtPct(v));
const ctxText = (e) => (e.ctx ? `DA ${pct(e.ctx[0])} → ${pct(e.ctx[1])} · curtailed ${pct(e.ctx[2])} → ${pct(e.ctx[3])}` : "–");

// one unit's daily offers over time, with its changes marked
const sigCache = new Map();
function loadSig(year) {
  if (!sigCache.has(year)) sigCache.set(year, tryJSON(`data/renew/sig-${year}.json.gz`));
  return sigCache.get(year);
}
function histRanges() {
  const R = S.R;
  if (!R) return [];
  const yrs = R.years.slice().reverse();
  return [{ id: "12m", label: "Last 12 months" }, { id: "all", label: `All (${R.years[0]} on)` }, ...yrs.map((y) => ({ id: y, label: y }))];
}
async function drawHistory(name) {
  const el = $("hist-chart"), R = S.R;
  if (!R) { emptyMsg(el, "No bidding history yet."); $("unit-changes").innerHTML = ""; $("hist-legend").innerHTML = ""; return; }
  const range = CH.range || "12m";
  let years;
  const lastD = parseDate(R.last);
  if (range === "12m") years = [...new Set([String(lastD.getFullYear() - 1), String(lastD.getFullYear())])].filter((y) => R.years.includes(y));
  else if (range === "all") years = R.years;
  else years = [range];
  const files = await Promise.all(years.map(loadSig));
  if (S.unit !== name) return;
  const pts = [];
  files.forEach((f) => {
    const u = f && f.units[name];
    if (!u) return;
    f.dates.forEach((d, i) => {
      if (u.k[i] === ".") return;
      const x = u.x[String(i)];
      pts.push({ d, t: parseDate(d), k: u.k[i], fl: u.fl[i], md: u.md[i], dam: u.dam[i], cur: u.cur[i], h: u.h[i], src: f.src[i], x: x ? [f.points[x[0]], x[1], x[2]] : null });
    });
  });
  const t0 = range === "12m" ? d3.timeYear.offset(lastD, -1) : null;
  const P = t0 ? pts.filter((p) => p.t >= t0) : pts;
  const evs = R.events.filter((e) => e.units.includes(name));
  const evIn = evs.filter((e) => (!t0 || parseDate(e.date) >= t0) && years.includes(e.date.slice(0, 4)));
  $("hist-note").textContent = `${evs.length} change${evs.length === 1 ? "" : "s"} since ${R.first.slice(0, 4)}`;
  $("hist-text").textContent = `Each dot is a day's median offer while online. Formula days are filled; the vertical lines mark detected changes, solid where the change moved dispatch. Days with offers beyond the axis are drawn as triangles at its edge (hover for the value). ` +
    (R.togglers[name] ? `This unit is a toggler: ${R.togglers[name]} returns or episodes within a year. ` : "") + "Click a line to jump to the change in the table below.";
  if (!P.length) { emptyMsg(el, "No online days with an offer in this range."); }
  else histChart(el, name, P, evIn);
  $("unit-changes").innerHTML = evs.length ? `<table class="data"><thead><tr><th class="t">Date</th><th class="t">Change</th><th class="t">Before → after</th><th class="t">Moved dispatch</th><th>Worth at node price</th><th class="t">Context, 7 days before → after</th></tr></thead><tbody>` +
    evs.map((e) => `<tr id="uc-${e.date}-${e.kind}"><td class="t">${e.date}</td><td class="t">${esc(R.kinds[e.kind])}${ptcTag(e)}${e.days ? ` <span class="muted">${e.days} day${e.days > 1 ? "s" : ""}</span>` : ""}${e.units.length > 1 ? ` <span class="muted">with ${esc(e.units.filter((u) => u !== name).join(", "))}</span>` : ""}</td>` +
      `<td class="t">${regime(e.before)} → ${regime(e.after)}</td><td class="t">${impactText(e)}</td><td>${valueText(e)}</td><td class="t muted">${ctxText(e)}</td></tr>`).join("") + "</tbody></table>"
    : `<p class="empty">No bidding changes detected for this unit.</p>`;
}
function histChart(el, name, P, evs) {
  const w = Math.max(280, el.clientWidth || 600), H = 280, m = { t: 18, r: 16, b: 26, l: 64 };
  const vals = P.map((p) => p.md).filter((v) => v != null).sort(d3.ascending);
  let lo = d3.quantile(vals, 0.01), hi = d3.quantile(vals, 0.99);
  evs.forEach((e) => [e.before, e.after].forEach((r) => { if (r && r.k === "f") { lo = Math.min(lo, r.v); hi = Math.max(hi, r.v); } }));
  if (hi - lo < 10) { lo -= 5; hi += 5; }
  const pad = (hi - lo) * 0.08;
  const y = d3.scaleLinear().domain([lo - pad, hi + pad]).nice().range([H - m.b, m.t]);
  const span = d3.extent(P, (p) => p.t);
  if (+span[0] === +span[1]) { span[0] = d3.timeDay.offset(span[0], -1); span[1] = d3.timeDay.offset(span[1], 1); }
  const x = d3.scaleTime().domain(span).range([m.l, w - m.r]);
  const clamp = (v) => y(Math.max(y.domain()[0], Math.min(y.domain()[1], v)));
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(6).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(w < 560 ? 4 : 8).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y), 6, "$").tickSizeOuter(0));
  if (y.domain()[0] < 0 && y.domain()[1] > 0) svg.append("line").attr("class", "zero").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(0)).attr("y2", y(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text("Median offer while online, $/MWh");
  const evG = svg.append("g");
  evs.forEach((e) => {
    const xe = x(parseDate(e.date));
    evG.append("line").attr("x1", xe).attr("x2", xe).attr("y1", m.t).attr("y2", H - m.b)
      .attr("stroke", css(e.moved ? "--c1" : "--c-other")).attr("stroke-width", 1.5).attr("stroke-dasharray", e.moved ? null : "4 3");
  });
  const r = P.length > 200 ? 2 : 3;
  const [y0, y1] = y.domain(), inside = (v) => v >= y0 && v <= y1;
  const off = P.filter((p) => p.md != null && !inside(p.md));
  svg.append("g").selectAll("path").data(off).join("path")
    .attr("d", (p) => (p.md > y1 ? "M0,-4L4,3L-4,3Z" : "M0,4L4,-3L-4,-3Z"))
    .attr("transform", (p) => `translate(${x(p.t)},${p.md > y1 ? m.t + 4 : H - m.b - 4})`)
    .attr("fill", (p) => (p.k === "x" ? css("--c3") : p.k === "v" ? css("--c4") : css("--ink-2")));
  svg.append("g").selectAll("circle").data(P.filter((p) => p.md != null && inside(p.md))).join("circle")
    .attr("cx", (p) => x(p.t)).attr("cy", (p) => clamp(p.md)).attr("r", r)
    .attr("fill", (p) => (p.k === "x" ? css("--c3") : p.k === "v" ? css("--c4") : css("--surface")))
    .attr("stroke", (p) => (p.k === "x" ? css("--surface") : p.k === "v" ? css("--surface") : css("--ink-2"))).attr("stroke-width", (p) => (p.k === "f" ? 1 : 0.5));
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", H - m.b).style("display", "none");
  const ts = P.map((p) => p.t);
  const KL = { f: "Floor", x: "Formula day", v: "Moving within the day" };
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const t = x.invert(d3.pointer(ev)[0]), i = d3.minIndex(ts, (d) => Math.abs(d - t)), p = P[i];
      cross.style("display", null).attr("x1", x(p.t)).attr("x2", x(p.t));
      const e = evs.find((v) => Math.abs(parseDate(v.date) - p.t) < 864e5 * 0.5);
      showTip(ev, `<h4>${fmtDate(p.t)}</h4><table><tr><td>Kind</td><td class="n">${KL[p.k]}</td></tr>` +
        `<tr><td>Median offer</td><td class="n">${fmt$(p.md)}</td></tr><tr><td>Most common offer</td><td class="n">${fmt$(p.fl)}</td></tr>` +
        (p.x ? `<tr><td>Formula</td><td class="n">${fmtA(p.x[1])} × ${esc(p.x[0])} ${p.x[2] < 0 ? "−" : "+"} ${fmt$(Math.abs(p.x[2]))}</td></tr>` : "") +
        `<tr><td>Hours online</td><td class="n">${p.h}</td></tr><tr><td>DA award / available</td><td class="n">${pct(p.dam)}</td></tr><tr><td>Curtailed</td><td class="n">${pct(p.cur)}</td></tr>` +
        (e ? `<tr><td>Change</td><td class="n">${esc(S.R.kinds[e.kind])}</td></tr>` : "") + `</table>`);
    })
    .on("pointerleave", () => { cross.style("display", "none"); hideTip(); })
    .on("click", (ev) => {
      const t = x.invert(d3.pointer(ev)[0]), e = evs.length ? evs[d3.minIndex(evs, (v) => Math.abs(parseDate(v.date) - t))] : null;
      const row = e && document.getElementById(`uc-${e.date}-${e.kind}`);
      if (row) { row.scrollIntoView({ behavior: "smooth", block: "nearest" }); row.classList.add("sel"); setTimeout(() => row.classList.remove("sel"), 1500); }
    });
  el.replaceChildren(svg.node());
  setCSV(el, ["date", "kind", "median_offer", "most_common_offer", "formula_point", "formula_share", "formula_intercept", "hours_online", "dam_share", "curtailed_share", "source"],
    P.map((p) => [p.d, p.k, p.md, p.fl, ...(p.x || [null, null, null]), p.h, p.dam, p.cur, p.src === "l" ? "60-day" : "history"]), `${name} bidding history`);
  $("hist-legend").innerHTML = `<span><span class="sw" style="background:var(--surface);border:1px solid var(--ink-2);border-radius:50%"></span>Floor day</span>` +
    `<span><span class="sw" style="background:var(--c3);border-radius:50%"></span>Formula day</span><span><span class="sw" style="background:var(--c4);border-radius:50%"></span>Moving within the day</span>` +
    `<span><span class="mk" style="border-color:var(--c1);border-left-style:solid"></span>Change that moved dispatch</span><span><span class="mk" style="border-color:var(--c-other)"></span>Other change</span>`;
}

let loaded = null;
async function draw() {
  const U = window.UNIT;
  if (!U) return;
  const renew = U.tech === "wind" || U.tech === "solar";
  $("renew-panel").hidden = true;
  if (!renew) return;
  if (!loaded) loaded = Promise.all([tryJSON("data/ppa.json.gz"), tryJSON("data/renew_changes.json.gz"), tryJSON("data/offtakers.json.gz")]).then(([a, b, o]) => {
    S.data = a; S.R = b; S.O = o;
    $("hist-range").innerHTML = histRanges().map((r) => `<option value="${r.id}">${esc(r.label)}</option>`).join("");
    $("hist-range").value = CH.range || "12m";
    $("hist-range").addEventListener("change", (e) => { CH.range = e.target.value; if (S.unit) drawHistory(S.unit); });
    if ($("credit-v") && a) $("credit-v").textContent = `$${a.credit}`;
  });
  await loaded;
  if (window.UNIT !== U) return;
  S.unit = U.name;
  drawUnit();
}
window.addEventListener("unitchange", draw);
window.addEventListener("unitresize", draw);
if (window.UNIT) draw();
})();

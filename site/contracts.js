/* ERCOT Renewable Hedge Signals. Reads data/ppa.json.gz (pipeline/ppa.py): for every wind and
   solar unit, whether its real-time offers follow share x DA price - constant at some settlement
   point, and if so which point, share and constant, with the points behind the fit. */
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

const S = { tech: "all", show: "found", q: "", sort: "tier", dir: 1, unit: null, data: null };
const VIEW_KEYS = { tech: "tech", show: "show", unit: "unit", sort: "sort" };
function saveView() { window.CX.writeHash(Object.fromEntries(Object.entries(VIEW_KEYS).map(([k, sk]) => [k, S[sk]]).filter(([, v]) => v != null))); }
function loadView() { const v = window.CX.readHash(); Object.entries(VIEW_KEYS).forEach(([k, sk]) => { if (v[k] != null) S[sk] = v[k]; }); }
function setSeg(id, value) { $(id).querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === value))); }
function bindSeg(id, key, after) {
  $(id).addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; S[key] = b.dataset.v; setSeg(id, S[key]); after(); saveView(); });
}
function emptyMsg(el, msg) { el.innerHTML = `<p class="empty">${msg}</p>`; }
const tierCell = (t) => `<span class="tier"><span class="sw" style="background:var(${TIER[t].color})"></span>${TIER[t].label}</span>`;
const strike = (u) => (u.strike_hi == null ? "–" : u.strike_lo == null ? `≤ ${fmt$0(u.strike_hi)}` : `${fmt$0(u.strike_lo)}–${fmt$0(u.strike_hi)}`);

const COLS = [
  { k: "name", h: "Unit", t: 1, f: (u) => esc(u.name) },
  { k: "tech", h: "Tech", t: 1, f: (u) => (u.tech === "wind" ? "Wind" : "Solar") },
  { k: "tier", h: "Signal", t: 1, f: (u) => tierCell(u.tier) },
  { k: "point", h: "Settles at", t: 1, f: (u) => (u.point ? esc(POINT_LABEL(u.point, u)) + (u.near && u.near.length ? ` <span class="muted">(or ${esc(u.near.slice(0, 2).join(", "))})</span>` : "") : "–") },
  { k: "a", h: "Share", f: (u) => fmtA(u.a) },
  { k: "b", h: "Intercept", f: (u) => fmt$(u.b) },
  { k: "strike_hi", h: "Implied strike", f: strike },
  { k: "hit", h: "Hit rate", f: (u) => (u.hit == null ? "–" : fmtPct(u.hit)) },
  { k: "days", h: "Formula days", f: (u) => (u.days ? `${u.days} <span class="muted">${u.first.slice(5)} to ${u.last.slice(5)}</span>` : "–") },
  { k: "group", h: "Same rule as", t: 1, f: (u) => sameRule(u) },
  { k: "floor", h: "Floor", f: (u) => fmt$(u.floor) },
  { k: "da_share", h: "DA share", f: (u) => (u.da_share == null ? "–" : fmtPct(u.da_share)) },
];
function sameRule(u) {
  if (!u.group) return "–";
  const mates = S.data.units.filter((v) => v.group === u.group && v.name !== u.name).map((v) => v.name);
  return esc(mates.slice(0, 3).join(", ") + (mates.length > 3 ? ` +${mates.length - 3}` : ""));
}

function rows() {
  return S.data.units.filter((u) => (S.tech === "all" || u.tech === S.tech) && (S.show === "all" || u.tier !== "hints")
    && (!S.q || u.name.toLowerCase().includes(S.q) || (u.sp || "").toLowerCase().includes(S.q) || (u.point || "").toLowerCase().includes(S.q)));
}

function drawKpis() {
  const D = S.data, us = D.units.filter((u) => S.tech === "all" || u.tech === S.tech);
  const n = (t) => us.filter((u) => u.tier === t).length;
  const standing = us.filter((u) => u.tier !== "hints" && u.days >= 30).length;
  $("scan-note").textContent = `${D.n_days} days, ${D.first} to ${D.last}`;
  $("kpis").innerHTML = [
    [fmt0(us.length), "Units scanned"],
    [fmt0(n("revealed")), "Revealed"], [fmt0(n("unclear")), "Location unclear"], [fmt0(n("partial")), "Partial"],
    [fmt0(standing), "Formula on 30+ days"],
  ].map(([v, k]) => `<div class="kpi"><span class="v">${v}</span><span class="k">${k}</span></div>`).join("");
  $("kpi-note").textContent = `A formula found on many days is a standing bidding rule; one found only on a few high-price days is a policy the operator switched on. DA hub and load zone prices cover ${D.hub_days.length ? `${D.hub_days[0]} to ${D.hub_days[D.hub_days.length - 1]}` : "no days yet"}; outside that range only the unit's own node can be tested.`;
  $("credit-v").textContent = fmt$0(D.credit);
  $("hit-v").textContent = fmt$0(D.hit_usd);
  $("tier-legend").innerHTML = Object.entries(TIER).map(([, t]) => `<span class="has-tip" data-tip="${esc(t.tip)}"><span class="sw" style="background:var(${t.color})"></span>${t.label}</span>`).join("");
  $("tier-legend").querySelectorAll("[data-tip]").forEach((el) => {
    el.addEventListener("pointermove", (ev) => showTip(ev, `<p class="tip-body">${el.dataset.tip}</p>`));
    el.addEventListener("pointerleave", hideTip);
  });
}

function drawUnits() {
  const el = $("units-table"), rs = rows();
  $("units-note").textContent = rs.length ? `${rs.length} units` : "";
  if (!rs.length) return emptyMsg(el, S.show === "found" ? "No unit in this selection follows a DA formula." : "No units.");
  const key = (u) => (S.sort === "tier" ? ORDER[u.tier] * 1e6 - (u.hours || 0) : u[S.sort]);
  rs.sort((a, b) => { const x = key(a), y = key(b); if (x == null) return 1; if (y == null) return -1; return (typeof x === "string" ? x.localeCompare(y) : x - y) * S.dir; });
  el.innerHTML = `<table class="data"><thead><tr>${COLS.map((c) => `<th class="sortable${c.t ? " t" : ""}" data-k="${c.k}">${c.h}${S.sort === c.k ? (S.dir < 0 ? " ▾" : " ▴") : ""}</th>`).join("")}</tr></thead><tbody>` +
    rs.map((u) => `<tr data-unit="${esc(u.name)}" class="${S.unit === u.name ? "sel" : ""}" style="cursor:pointer">${COLS.map((c) => `<td${c.t ? ' class="t"' : ""}>${c.f(u)}</td>`).join("")}</tr>`).join("") + "</tbody></table>";
  el.querySelectorAll("th[data-k]").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.k; if (S.sort === k) S.dir = -S.dir; else { S.sort = k; S.dir = ["name", "tech", "tier", "point", "group"].includes(k) ? 1 : -1; }
    drawUnits(); saveView();
  }));
  el.querySelectorAll("tr[data-unit]").forEach((tr) => tr.addEventListener("click", () => {
    S.unit = tr.dataset.unit; drawUnit(); drawUnits(); saveView(); $("unit-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  setCSV(el, ["unit", "tech", "tier", "sp", "point", "share", "intercept", "strike_lo", "strike_hi", "hit", "days", "hours", "first", "last", "floor", "da_share", "da_days"],
    rs.map((u) => [u.name, u.tech, u.tier, u.sp, u.point, u.a, u.b, u.strike_lo, u.strike_hi, u.hit, u.days, u.hours, u.first, u.last, u.floor, u.da_share, u.da_days]), "Hedge signals");
}

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
  const [x0, x1] = x.domain();
  svg.append("line").attr("x1", x(x0)).attr("x2", x(x1)).attr("y1", y(u.a * x0 + u.b)).attr("y2", y(u.a * x1 + u.b))
    .attr("stroke", css("--c8")).attr("stroke-width", 1.5).attr("stroke-dasharray", "5 3");
  const ring = svg.append("circle").attr("r", 6).attr("fill", "none").attr("stroke", css("--ink")).style("display", "none");
  const tree = d3.quadtree(pts, (p) => x(p[1]), (p) => y(p[2]));
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const [px, py] = d3.pointer(ev), p = tree.find(px, py, 30);
      if (!p) { ring.style("display", "none"); hideTip(); return; }
      ring.style("display", null).attr("cx", x(p[1])).attr("cy", y(p[2]));
      const pred = u.a * p[1] + u.b;
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
    `<span><span class="sw-line" style="border-top-color:var(--c8)"></span>Fitted formula</span>`;
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

function drawUnit() {
  const box = $("unit-panel"), u = S.data.units.find((v) => v.name === S.unit);
  if (!u) { box.hidden = true; return; }
  box.hidden = false;
  $("unit-title").textContent = `${u.name} · ${u.tech === "wind" ? "Wind" : "Solar"}${u.sp ? ` · node ${u.sp}` : ""}`;
  const habit = `Usual floor offer ${fmt$(u.floor)}. Day-ahead: ${u.da_share == null ? "no data" : `awards equal to ${fmtPct(u.da_share)} of its real-time energy, with an award on ${fmtPct(u.da_days || 0)} of ${u.avail_days} days`}.`;
  if (u.tier === "hints") {
    $("unit-formula").textContent = "No day-ahead formula in its offers.";
    $("unit-note").textContent = habit;
    $("fit-legend").innerHTML = "";
    emptyMsg($("fit-chart"), "Its offers never moved hour by hour with a DA price on enough hours to fit.");
    emptyMsg($("daily-chart"), "No formula days.");
    return;
  }
  const strikeTxt = u.strike_lo == null
    ? `If the intercept is all strike, the strike is ${fmt$(u.strike_hi)}/MWh (a $${S.data.credit} credit would leave nothing for a strike, so the bidder likely counts none).`
    : `Implied strike ${fmt$(u.strike_lo)} to ${fmt$(u.strike_hi)}/MWh: ${fmt$(u.strike_hi)} if the intercept is all strike, ${fmt$(u.strike_lo)} if the operator also counts a $${S.data.credit}/MWh credit such as the PTC.`;
  $("unit-formula").textContent = `offer = ${fmtA(u.a)} × DA(${POINT_LABEL(u.point, u)}) ${u.b < 0 ? "−" : "+"} ${fmt$(Math.abs(u.b))}`;
  const alt = (u.alt || []).map(([p, h]) => `${POINT_LABEL(p, u)} ${fmtPct(h)}`).join(", ");
  $("unit-note").textContent = `${TIER[u.tier].label}. The formula predicts ${fmtPct(u.hit)} of ${fmt0(u.hours)} formula hours within $${S.data.hit_usd}, on ${u.days} days from ${u.first} to ${u.last}` +
    `${alt ? ` (next best: ${alt})` : ""}. ${strikeTxt} ${habit}` + (u.group ? ` Bid on the same rule as ${S.data.units.filter((v) => v.group === u.group && v.name !== u.name).map((v) => v.name).join(", ")}.` : "");
  fitChart($("fit-chart"), u, S.data.fits[u.name]);
  dailyChart($("daily-chart"), u);
}

function redraw() { drawKpis(); drawUnits(); drawUnit(); }

async function boot() {
  S.data = await tryJSON("data/ppa.json.gz");
  if (!S.data) { $("status").textContent = "No hedge signal data yet. It is built by the data update workflow."; return; }
  loadView();
  $("status").textContent = `60-day data: ${S.data.n_days} days, ${S.data.first} to ${S.data.last} · built ${S.data.updated.slice(0, 10)}`;
  setSeg("tech", S.tech); bindSeg("tech", "tech", redraw);
  setSeg("show", S.show); bindSeg("show", "show", drawUnits);
  $("unit-search").addEventListener("input", (e) => { S.q = e.target.value.trim().toLowerCase(); drawUnits(); });
  if (!S.unit) { const first = S.data.units.find((u) => u.tier === "revealed"); S.unit = first ? first.name : null; }
  redraw();
  window.CX.init();
  let tm; window.addEventListener("resize", () => { clearTimeout(tm); tm = setTimeout(drawUnit, 150); });
}
boot();
})();

/* ERCOT Renewable Hedge Signals. Reads data/ppa.json.gz (pipeline/ppa.py): for every wind and
   solar unit, whether its real-time offers follow share x DA price - constant at some settlement
   point, and if so which point, share and constant, with the points behind the fit.  Also reads
   data/renew_changes.json.gz and data/renew/sig-YYYY.json.gz (pipeline/renew_changes.py): every
   change in how each unit bids, whether it moved dispatch, and each unit's daily offers. */
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
const CH_KEYS = { ckind: "kind", cyear: "year", cmoved: "moved", crange: "range" };
function saveView() {
  window.CX.writeHash({ ...Object.fromEntries(Object.entries(VIEW_KEYS).map(([k, sk]) => [k, S[sk]]).filter(([, v]) => v != null)),
    ...Object.fromEntries(Object.entries(CH_KEYS).map(([k, ck]) => [k, CH[ck]]).filter(([, v]) => v != null && v !== "all" && v !== "12m")),
    ...(CH.hideTog ? { ctog: 1 } : {}) });
}
function loadView() {
  const v = window.CX.readHash();
  Object.entries(VIEW_KEYS).forEach(([k, sk]) => { if (v[k] != null) S[sk] = v[k]; });
  Object.entries(CH_KEYS).forEach(([k, ck]) => { if (v[k] != null) CH[ck] = v[k]; });
  CH.hideTog = v.ctog === "1";
}
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
  const inR = S.R && S.R.events.some((e) => e.units.includes(S.unit));
  if (!u && !inR) { box.hidden = true; return; }
  box.hidden = false;
  drawHistory(S.unit);
  $("ppa-part").hidden = !u;
  if (!u) {
    const e = S.R.events.find((v) => v.units.includes(S.unit));
    $("unit-title").textContent = `${S.unit} · ${e.tech === "wind" ? "Wind" : "Solar"}`;
    $("unit-formula").textContent = "";
    $("unit-note").textContent = "Not in the loaded 60-day days (it may have been renamed or retired), so only its bidding history is shown.";
    return;
  }
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

// ---- bidding changes (data/renew_changes.json.gz, pipeline/renew_changes.py) ----------------
const CH = { kind: "all", year: "all", moved: "all", hideTog: false, limit: 200, range: null };
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
function impactText(e) {
  const im = e.impact;
  if (!im) return `<span class="muted">${e.before.k === "v" ? "no fixed old offer" : "no hourly data"}</span>`;
  if (!e.moved) return `<span class="muted">no${im.est > 0.5 ? " (DA price)" : ""}</span>`;
  const parts = [];
  if (im.up) parts.push(`gave up ${fmtMWh(im.up)}`);
  if (im.dn) parts.push(`ran ${fmtMWh(im.dn)} more`);
  return `<span class="moved">${parts.join(", ")}</span> <span class="muted">${im.hours} h${im.est > 0.5 ? ", DA price" : ""}</span>`;
}
function valueText(e) {
  const im = e.impact;
  if (!im || !e.moved) return "–";
  const v = [];
  if (im.up) v.push(fmt$0(im.v_up));
  if (im.dn) v.push(fmt$0(im.v_dn));
  return v.join(" / ");
}
const pct = (v) => (v == null ? "–" : fmtPct(v));
const ctxText = (e) => (e.ctx ? `DA ${pct(e.ctx[0])} → ${pct(e.ctx[1])} · curtailed ${pct(e.ctx[2])} → ${pct(e.ctx[3])}` : "–");

function chgRows(R) {
  const q = S.q;
  return R.events.filter((e) => (S.tech === "all" || e.tech === S.tech)
    && (CH.kind === "all" || e.kind === CH.kind)
    && (CH.year === "all" || e.date.slice(0, 4) === CH.year)
    && (CH.moved === "all" || (CH.moved === "yes" ? e.moved === true : e.moved !== true))
    && (!CH.hideTog || !e.toggler)
    && (!q || e.plant.toLowerCase().includes(q) || e.units.some((u) => u.toLowerCase().includes(q))));
}

function drawChanges() {
  const R = S.R, tbl = $("chg-table"), chart = $("chg-chart");
  if (!R) { emptyMsg(chart, "No bidding change data yet. It is built by the data update workflow."); tbl.innerHTML = ""; return; }
  const P = R.params, rs = chgRows(R);
  $("chg-note").textContent = `${R.first} to ${R.last}`;
  $("chg-text").textContent = `Every change in how a wind or solar unit offers: a new floor, a formula switched on or off, an episode of a few days away from its floor. ` +
    `${fmt0(rs.length)} change${rs.length === 1 ? "" : "s"} in this selection, ${fmt0(rs.filter((e) => e.moved).length)} of which moved dispatch. ` +
    `Most offer changes happen below any price the unit's node reaches, so they say something about the bidder without changing what it produced. Click a row to see the unit.`;
  drawChangeMonths(chart, rs);
  const shown = rs.slice(0, CH.limit);
  tbl.innerHTML = rs.length ? `<table class="data"><thead><tr><th class="t">Date</th><th class="t">Plant</th><th class="t">Tech</th><th class="t">Change</th><th class="t">Before → after</th><th class="t">Moved dispatch</th><th>Worth at node price</th><th class="t">Context, 7 days before → after</th></tr></thead><tbody>` +
    shown.map((e) => `<tr data-unit="${esc(e.units[0])}" class="${e.units.includes(S.unit) ? "sel" : ""}" style="cursor:pointer">` +
      `<td class="t">${e.date}</td><td class="t">${esc(e.plant)}${e.units.length > 1 ? ` <span class="muted">${e.units.length} units</span>` : ""}${e.toggler ? ' <span class="tag" title="Moves between fixed offers often">toggler</span>' : ""}</td>` +
      `<td class="t">${e.tech === "wind" ? "Wind" : "Solar"}</td><td class="t">${esc(R.kinds[e.kind])}${e.days ? ` <span class="muted">${e.days} day${e.days > 1 ? "s" : ""}</span>` : ""}${e.gap ? ` <span class="muted">after ${e.gap} days off</span>` : ""}</td>` +
      `<td class="t">${regime(e.before)} → ${regime(e.after)}</td><td class="t">${impactText(e)}</td><td>${valueText(e)}</td><td class="t muted">${ctxText(e)}</td></tr>`).join("") +
    "</tbody></table>" : `<p class="empty">No changes match.</p>`;
  $("chg-more").hidden = rs.length <= CH.limit;
  $("chg-more").textContent = `Show more (${fmt0(rs.length - CH.limit)} not shown)`;
  setCSV(tbl, ["date", "plant", "units", "tech", "kind", "before", "after", "episode_days", "moved", "hours", "mwh_given_up", "mwh_gained", "value_given_up", "value_gained", "share_hours_da_price", "dam_before", "dam_after", "curtailed_before", "curtailed_after", "toggler"],
    rs.map((e) => [e.date, e.plant, e.units.join(" "), e.tech, e.kind, regime(e.before).replace(/&[a-z]+;/g, ""), regime(e.after).replace(/&[a-z]+;/g, ""), e.days, e.moved,
      ...(e.impact ? [e.impact.hours, e.impact.up, e.impact.dn, e.impact.v_up, e.impact.v_dn, e.impact.est] : [null, null, null, null, null, null]), ...(e.ctx || [null, null, null, null]), e.toggler]), "Bidding changes");
  $("chg-method").textContent = `A unit's regime is its floor (one offer price most of the day, within $${P.tol}), a day-ahead formula at one settlement point (as fitted above), or offers that move within the day. ` +
    `A change is a new regime that holds on at least ${P.min_held} of the next ${P.hold} online days. A floor counts as "back" when the unit held it within the previous ${P.new_days} days. ` +
    `Inside a formula regime, a step of ${fmtA(P.terms_a)} in the share, or of $${P.terms_b} in the offer the formula gives at a $${P.ref_da} DA price, is a terms change. An episode is 1 to ${P.ep_max} days with a median offer at least $${P.ep_usd} from the floor, then back to it. ` +
    `Units of one plant changing the same way within a day are one row. A toggler has ${P.toggle} or more episodes or returns to an earlier floor within a year. ` +
    `Moved dispatch: for the first ${P.hold} online days of the new regime (or the episode's days), an hour counts when the unit was online and its node price fell between the old offer and the new one. Priced up, the old offer would have run, so the energy given up is HSL minus base point; priced down, the base point is energy the old offer would not have produced. Both are valued at the node price. ` +
    `The real-time node price is used where loaded (from ${R.live_first || "–"}); before that only the day-ahead node price is available and the estimate is marked "DA price". Hourly prices smooth over SCED's 5-minute prices, so the MWh are approximate.`;
}

function drawChangeMonths(el, rs) {
  if (!rs.length) { emptyMsg(el, "No changes match."); $("chg-legend").innerHTML = ""; return; }
  const R = S.R;
  const first = CH.year === "all" ? R.first.slice(0, 7) : `${CH.year}-01`, last = CH.year === "all" ? R.last.slice(0, 7) : `${CH.year}-12`;
  const months = [];
  for (let d = new Date(first + "-15T12:00:00"); d3.timeFormat("%Y-%m")(d) <= last; d = d3.timeMonth.offset(d, 1)) months.push(d3.timeFormat("%Y-%m")(d));
  const cnt = new Map(months.map((m) => [m, { yes: 0, no: 0, na: 0 }]));
  rs.forEach((e) => { const c = cnt.get(e.date.slice(0, 7)); if (c) c[movedId(e)] += 1; });
  const data = months.map((m) => ({ m, ...cnt.get(m) }));
  const stack = d3.stack().keys(MOVED.map((s) => s.id))(data);
  const w = Math.max(280, el.clientWidth || 600), H = 200, mg = { t: 18, r: 12, b: 26, l: 44 };
  const x = d3.scaleBand().domain(months).range([mg.l, w - mg.r]).paddingInner(months.length > 60 ? 0.1 : 0.2);
  const y = d3.scaleLinear().domain([0, d3.max(data, (d) => d.yes + d.no + d.na) || 1]).nice().range([H - mg.b, mg.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${mg.l},0)`).call(d3.axisLeft(y).ticks(4).tickSize(-(w - mg.l - mg.r)).tickFormat(""));
  const every = Math.ceil(months.length / (w < 560 ? 4 : 10));
  const tickM = months.filter((m, i) => (months.length > 24 ? m.endsWith("-01") && (+m.slice(0, 4) % Math.max(1, Math.round(every / 12)) === 0) : i % every === 0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - mg.b})`)
    .call(d3.axisBottom(x).tickValues(tickM).tickFormat((m) => (months.length > 24 ? m.slice(0, 4) : d3.timeFormat("%b %y")(new Date(m + "-15T12:00:00")))).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${mg.l},0)`).call(d3.axisLeft(y).ticks(4).tickFormat(d3.format(",d")).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", mg.l).attr("y", 10).text("Changes per month");
  stack.forEach((layer, li) => {
    svg.append("g").selectAll("rect").data(layer).join("rect")
      .attr("x", (d) => x(d.data.m)).attr("width", x.bandwidth())
      .attr("y", (d) => y(d[1])).attr("height", (d) => Math.max(0, y(d[0]) - y(d[1]) - (d[1] > d[0] ? 1 : 0)))
      .attr("fill", css(MOVED[li].color));
  });
  svg.append("g").selectAll("rect").data(data).join("rect")
    .attr("x", (d) => x(d.m) - x.step() * x.paddingInner() / 2).attr("width", x.step()).attr("y", mg.t).attr("height", H - mg.t - mg.b).attr("fill", "transparent")
    .on("pointermove", (ev, d) => showTip(ev, `<h4>${d3.timeFormat("%B %Y")(new Date(d.m + "-15T12:00:00"))}</h4><table>` +
      MOVED.map((s) => `<tr><td><span class="sw" style="background:var(${s.color})"></span></td><td>${s.label}</td><td class="n">${d[s.id]}</td></tr>`).join("") +
      `<tr><td></td><td>All changes</td><td class="n">${d.yes + d.no + d.na}</td></tr></table>`))
    .on("pointerleave", hideTip)
    .on("click", (ev, d) => { CH.year = d.m.slice(0, 4); $("chg-year").value = CH.year; drawChanges(); });
  el.replaceChildren(svg.node());
  $("chg-legend").innerHTML = MOVED.map((s) => `<span><span class="sw" style="background:var(${s.color})"></span>${s.label}</span>`).join("");
}

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
    evs.map((e) => `<tr id="uc-${e.date}-${e.kind}"><td class="t">${e.date}</td><td class="t">${esc(R.kinds[e.kind])}${e.days ? ` <span class="muted">${e.days} day${e.days > 1 ? "s" : ""}</span>` : ""}${e.units.length > 1 ? ` <span class="muted">with ${esc(e.units.filter((u) => u !== name).join(", "))}</span>` : ""}</td>` +
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

function initChanges() {
  const R = S.R;
  if (!R) return;
  $("chg-kind").innerHTML = `<option value="all">All changes</option>` + Object.entries(R.kinds).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("");
  $("chg-year").innerHTML = `<option value="all">All years</option>` + R.years.slice().reverse().map((y) => `<option value="${y}">${y}</option>`).join("");
  $("chg-kind").value = CH.kind; $("chg-year").value = CH.year; $("chg-tog").checked = CH.hideTog;
  $("chg-kind").addEventListener("change", (e) => { CH.kind = e.target.value; CH.limit = 200; drawChanges(); saveView(); });
  $("chg-year").addEventListener("change", (e) => { CH.year = e.target.value; CH.limit = 200; drawChanges(); saveView(); });
  $("chg-tog").addEventListener("change", (e) => { CH.hideTog = e.target.checked; drawChanges(); saveView(); });
  setSeg("chg-moved", CH.moved);
  $("chg-moved").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; CH.moved = b.dataset.v; setSeg("chg-moved", CH.moved); CH.limit = 200; drawChanges(); saveView(); });
  $("chg-more").addEventListener("click", () => { CH.limit += 400; drawChanges(); });
  $("hist-range").innerHTML = histRanges().map((r) => `<option value="${r.id}">${esc(r.label)}</option>`).join("");
  $("hist-range").value = CH.range || "12m";
  $("hist-range").addEventListener("change", (e) => { CH.range = e.target.value; if (S.unit) drawHistory(S.unit); saveView(); });
  $("chg-table").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-unit]"); if (!tr) return;
    S.unit = tr.dataset.unit; drawUnit(); drawUnits(); saveView(); $("unit-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function redraw() { drawKpis(); drawUnits(); drawUnit(); drawChanges(); }

async function boot() {
  [S.data, S.R] = await Promise.all([tryJSON("data/ppa.json.gz"), tryJSON("data/renew_changes.json.gz")]);
  if (!S.data) { $("status").textContent = "No hedge signal data yet. It is built by the data update workflow."; return; }
  loadView();
  $("status").textContent = `60-day data: ${S.data.n_days} days, ${S.data.first} to ${S.data.last} · built ${S.data.updated.slice(0, 10)}`;
  setSeg("tech", S.tech); bindSeg("tech", "tech", redraw);
  setSeg("show", S.show); bindSeg("show", "show", drawUnits);
  $("unit-search").addEventListener("input", (e) => { S.q = e.target.value.trim().toLowerCase(); drawUnits(); drawChanges(); });
  initChanges();
  if (!S.unit) { const first = S.data.units.find((u) => u.tier === "revealed"); S.unit = first ? first.name : null; }
  redraw();
  window.CX.init();
  let tm; window.addEventListener("resize", () => { clearTimeout(tm); tm = setTimeout(() => { drawUnit(); drawChanges(); }, 150); });
}
boot();
})();

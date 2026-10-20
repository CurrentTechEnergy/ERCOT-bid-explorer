/* Renewables, hedge signals: the Hedge signals page (contracts.js) without its inline unit panel,
   whose units now open the Unit page (unit.html?unit=NAME). Reads data/ppa.json.gz (pipeline/ppa.py):
   for every wind and solar unit, whether its real-time offers follow share x DA price - constant at
   some settlement point. Also reads data/renew_changes.json.gz (pipeline/renew_changes.py): every
   change in how each unit bids, whether it moved dispatch, and the PTC floor level.
   renewables.js owns the status line and the shared chart controls (CX.init). */
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

const S = { tech: "all", show: "found", q: "", sort: "tier", dir: 1, data: null };
// the other panels on the page (renewables.js) keep their own keys in the same address bar
const VIEW_KEYS = { htech: "tech", hshow: "show", hsort: "sort" };
const CH_KEYS = { ckind: "kind", cyear: "year", cmoved: "moved", cptc: "ptc" };
function saveView() {
  window.CX.writeHash({ ...window.CX.readHash(), ...Object.fromEntries(Object.entries(VIEW_KEYS).map(([k, sk]) => [k, S[sk]])),
    ...Object.fromEntries(Object.entries(CH_KEYS).map(([k, ck]) => [k, CH[ck] === "all" || CH[ck] === "12m" ? null : CH[ck]])),
    ctog: CH.hideTog ? 1 : null });
}
const openUnit = (name) => { location.href = `unit.html?unit=${encodeURIComponent(name)}`; };
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
  { k: "name", h: "Unit", t: 1, f: (u) => `<a href="unit.html?unit=${encodeURIComponent(u.name)}">${esc(u.name)}</a>` },
  { k: "tech", h: "Tech", t: 1, f: (u) => (u.tech === "wind" ? "Wind" : "Solar") },
  { k: "tier", h: "Signal", t: 1, f: (u) => tierCell(u.tier) },
  { k: "point", h: "Settles at", t: 1, f: (u) => (u.point ? esc(POINT_LABEL(u.point, u)) + (u.near && u.near.length ? ` <span class="muted">(or ${esc(u.near.slice(0, 2).join(", "))})</span>` : "") : "–") },
  { k: "a", h: "Offers at", f: (u) => (u.a == null ? "–" : `${fmtPct(u.a)} of DA ${u.b < 0 ? "−" : "+"} ${fmt$(Math.abs(u.b))}`) },
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
  window.CX.setNote($("kpi-note"), "What the scan found: units whose offers follow a day-ahead price formula, and how consistently.", `A formula found on many days is a standing bidding rule; one found only on a few high-price days is a policy the operator switched on. DA hub and load zone prices cover ${D.hub_days.length ? `${D.hub_days[0]} to ${D.hub_days[D.hub_days.length - 1]}` : "no days yet"}; outside that range only the unit's own node can be tested.`);
  $("credit-v").textContent = fmt$0(D.credit);
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
    rs.map((u) => `<tr data-unit="${esc(u.name)}" style="cursor:pointer">${COLS.map((c) => `<td${c.t ? ' class="t"' : ""}>${c.f(u)}</td>`).join("")}</tr>`).join("") + "</tbody></table>";
  el.querySelectorAll("th[data-k]").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.k; if (S.sort === k) S.dir = -S.dir; else { S.sort = k; S.dir = ["name", "tech", "tier", "point", "group"].includes(k) ? 1 : -1; }
    drawUnits(); saveView();
  }));
  el.querySelectorAll("tr[data-unit]").forEach((tr) => tr.addEventListener("click", (ev) => { if (!ev.target.closest("a")) openUnit(tr.dataset.unit); }));
  setCSV(el, ["unit", "tech", "tier", "sp", "point", "share", "intercept", "strike_lo", "strike_hi", "hit", "days", "hours", "first", "last", "floor", "da_share", "da_days"],
    rs.map((u) => [u.name, u.tech, u.tier, u.sp, u.point, u.a, u.b, u.strike_lo, u.strike_hi, u.hit, u.days, u.hours, u.first, u.last, u.floor, u.da_share, u.da_days]), "Hedge signals");
}

// ---- bidding changes (data/renew_changes.json.gz, pipeline/renew_changes.py) ----------------
const CH = { kind: "all", year: "all", moved: "all", ptc: "all", hideTog: false, limit: 200, range: null };
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
    && (CH.ptc === "all" || (CH.ptc === "hide" ? e.ptc !== "level" : e.ptc === CH.ptc))
    && (!CH.hideTog || !e.toggler)
    && (!q || e.plant.toLowerCase().includes(q) || e.units.some((u) => u.toLowerCase().includes(q))));
}

function drawChanges() {
  const R = S.R, tbl = $("chg-table"), chart = $("chg-chart");
  if (!R) { emptyMsg(chart, "No bidding change data yet. It is built by the data update workflow."); tbl.innerHTML = ""; return; }
  const rs = chgRows(R);
  $("chg-note").textContent = `${R.first} to ${R.last}`;
  window.CX.setNote($("chg-text"), "Every change in how a wind or solar unit offers: a new floor, or a price formula switched on or off. Click a row to open the unit.", `Every change in how a wind or solar unit offers: a new floor, a formula switched on or off, an episode of a few days away from its floor. ` +
    `${fmt0(rs.length)} change${rs.length === 1 ? "" : "s"} in this selection, ${fmt0(rs.filter((e) => e.moved).length)} of which moved dispatch. ` +
    `Most offer changes happen below any price the unit's node reaches, so they say something about the bidder without changing what it produced. Click a row to open the unit's page.`);
  drawChangeMonths(chart, rs);
  const shown = rs.slice(0, CH.limit);
  tbl.innerHTML = rs.length ? `<table class="data"><thead><tr><th class="t">Date</th><th class="t">Plant</th><th class="t">Tech</th><th class="t">Change</th><th class="t">Before → after</th><th class="t">Moved dispatch</th><th>Worth at node price</th><th class="t">Context, 7 days before → after</th></tr></thead><tbody>` +
    shown.map((e) => `<tr data-unit="${esc(e.units[0])}" style="cursor:pointer">` +
      `<td class="t">${e.date}</td><td class="t">${esc(e.plant)}${e.units.length > 1 ? ` <span class="muted">${e.units.length} units</span>` : ""}${e.toggler ? ' <span class="tag" title="Moves between fixed offers often">toggler</span>' : ""}</td>` +
      `<td class="t">${e.tech === "wind" ? "Wind" : "Solar"}</td><td class="t">${esc(R.kinds[e.kind])}${ptcTag(e)}${e.days ? ` <span class="muted">${e.days} day${e.days > 1 ? "s" : ""}</span>` : ""}${e.gap ? ` <span class="muted">after ${e.gap} days off</span>` : ""}</td>` +
      `<td class="t">${regime(e.before)} → ${regime(e.after)}</td><td class="t">${impactText(e)}</td><td>${valueText(e)}</td><td class="t muted">${ctxText(e)}</td></tr>`).join("") +
    "</tbody></table>" : `<p class="empty">No changes match.</p>`;
  $("chg-more").hidden = rs.length <= CH.limit;
  $("chg-more").textContent = `Show more (${fmt0(rs.length - CH.limit)} not shown)`;
  setCSV(tbl, ["date", "plant", "units", "tech", "kind", "before", "after", "episode_days", "moved", "hours", "mwh_given_up", "mwh_gained", "value_given_up", "value_gained", "share_hours_da_price", "dam_before", "dam_after", "curtailed_before", "curtailed_after", "toggler"],
    rs.map((e) => [e.date, e.plant, e.units.join(" "), e.tech, e.kind + (e.ptc ? ` (ptc ${e.ptc})` : ""), regime(e.before).replace(/&[a-z]+;/g, ""), regime(e.after).replace(/&[a-z]+;/g, ""), e.days, e.moved,
      ...(e.impact ? [e.impact.hours, e.impact.up, e.impact.dn, e.impact.v_up, e.impact.v_dn, e.impact.est] : [null, null, null, null, null, null]), ...(e.ctx || [null, null, null, null]), e.toggler]), "Bidding changes");
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

// monthly median of floors in the PTC band, wind and solar
const PTC_SERIES = [{ id: "wind", label: "Wind", color: "--c3" }, { id: "solar", label: "Solar", color: "--c4" }];
function drawPTC() {
  const R = S.R, el = $("ptc-chart"), T = R && R.ptc_trend;
  if (!T || !T.months.length) { emptyMsg(el, "No PTC floor data yet."); return; }
  const [lo, hi] = R.ptc_band;
  const lev = R.events.filter((e) => e.ptc === "level").length, exp = R.events.filter((e) => e.ptc === "expired").length;
  $("ptc-note").textContent = `${T.months[0]} to ${T.months[T.months.length - 1]}`;
  window.CX.setNote($("ptc-text"), "The typical wind and solar floor offer each month. A floor between about −$60 and −$15 prices in a per-MWh credit such as the PTC.", `A floor between ${fmt$0(lo)} and ${fmt$0(hi)} prices a per-MWh credit such as the PTC: the unit would rather be paid less than not produce. Each line is the median, across units, of each unit's typical floor that month. ` +
    `Few units move their floor on the day the yearly inflation adjustment takes effect, but the median drifts lower year by year. In the change log, ${fmt0(lev)} changes are tagged PTC level (a move inside the band of $5 or less) and ${fmt0(exp)} PTC may have expired (the floor left the band for about $0 and never came back).`);
  const ts = T.months.map((m) => new Date(m + "-15T12:00:00"));
  const w = Math.max(280, el.clientWidth || 600), H = 220, m = { t: 18, r: 16, b: 26, l: 56 };
  const all = PTC_SERIES.flatMap((s) => T[s.id].median).filter((v) => v != null);
  const x = d3.scaleTime().domain(d3.extent(ts)).range([m.l, w - m.r]);
  const y = d3.scaleLinear().domain(d3.extent(all)).nice().range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(w < 560 ? 4 : 8).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y), 5, "$").tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text("Median PTC-band floor, $/MWh");
  PTC_SERIES.forEach((s) => {
    const line = d3.line().defined((d) => d != null).x((d, i) => x(ts[i])).y((d) => y(d));
    svg.append("path").attr("d", line(T[s.id].median)).attr("fill", "none").attr("stroke", css(s.color)).attr("stroke-width", 2);
  });
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", H - m.b).style("display", "none");
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const t = x.invert(d3.pointer(ev)[0]), i = d3.minIndex(ts, (d) => Math.abs(d - t));
      cross.style("display", null).attr("x1", x(ts[i])).attr("x2", x(ts[i]));
      showTip(ev, `<h4>${d3.timeFormat("%B %Y")(ts[i])}</h4><table>` + PTC_SERIES.map((s) =>
        `<tr><td><span class="sw" style="background:var(${s.color})"></span></td><td>${s.label}</td><td class="n">${fmt$(T[s.id].median[i])}</td><td class="n muted">${T[s.id].units[i]} units</td></tr>`).join("") + "</table>");
    })
    .on("pointerleave", () => { cross.style("display", "none"); hideTip(); });
  el.replaceChildren(svg.node());
  $("ptc-legend").innerHTML = PTC_SERIES.map((s) => `<span><span class="sw" style="background:var(${s.color})"></span>${s.label}</span>`).join("");
  setCSV(el, ["month", "wind_median_floor", "wind_units", "solar_median_floor", "solar_units"], T.months.map((mo, i) => [mo, T.wind.median[i], T.wind.units[i], T.solar.median[i], T.solar.units[i]]), "PTC floor level");
}

function initChanges() {
  const R = S.R;
  if (!R) return;
  $("chg-kind").innerHTML = `<option value="all">All changes</option>` + Object.entries(R.kinds).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("");
  $("chg-year").innerHTML = `<option value="all">All years</option>` + R.years.slice().reverse().map((y) => `<option value="${y}">${y}</option>`).join("");
  $("chg-kind").value = CH.kind; $("chg-year").value = CH.year; $("chg-ptc").value = CH.ptc; $("chg-tog").checked = CH.hideTog;
  $("chg-ptc").addEventListener("change", (e) => { CH.ptc = e.target.value; CH.limit = 200; drawChanges(); saveView(); });
  $("chg-kind").addEventListener("change", (e) => { CH.kind = e.target.value; CH.limit = 200; drawChanges(); saveView(); });
  $("chg-year").addEventListener("change", (e) => { CH.year = e.target.value; CH.limit = 200; drawChanges(); saveView(); });
  $("chg-tog").addEventListener("change", (e) => { CH.hideTog = e.target.checked; drawChanges(); saveView(); });
  setSeg("chg-moved", CH.moved);
  $("chg-moved").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; CH.moved = b.dataset.v; setSeg("chg-moved", CH.moved); CH.limit = 200; drawChanges(); saveView(); });
  $("chg-more").addEventListener("click", () => { CH.limit += 400; drawChanges(); });
  $("chg-table").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-unit]"); if (tr) openUnit(tr.dataset.unit);
  });
}

function redraw() { drawKpis(); drawUnits(); drawChanges(); drawPTC(); }

async function boot() {
  [S.data, S.R] = await Promise.all([tryJSON("data/ppa.json.gz"), tryJSON("data/renew_changes.json.gz")]);
  if (!S.data) { emptyMsg($("units-table"), "No hedge signal data yet. It is built by the data update workflow."); return; }
  loadView();
  setSeg("hedge-tech", S.tech); bindSeg("hedge-tech", "tech", redraw);
  setSeg("hedge-show", S.show); bindSeg("hedge-show", "show", drawUnits);
  $("hedge-search").addEventListener("input", (e) => { S.q = e.target.value.trim().toLowerCase(); drawUnits(); drawChanges(); });
  initChanges();
  redraw();
  saveView();
  let tm; window.addEventListener("resize", () => { clearTimeout(tm); tm = setTimeout(() => { drawChanges(); drawPTC(); }, 150); });
}
boot();
})();

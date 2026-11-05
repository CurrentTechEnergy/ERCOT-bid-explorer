/* Unit page, heat rate and fuel cost: the unit's measured heat rate and station use (EPA hourly
   stack data against ERCOT telemetry), and its cost of running at minimum by day (heat rate at
   minimum x the 7-day average of its gas hub's price, or its delivered coal price) against its own DAM
   minimum-energy offer. Reads data/unit_fuel.json.gz (pipeline/unit_fuel.py); the hub prices
   themselves are licensed and not in it. */
(() => {
"use strict";

const { tryJSON, showTip, hideTip, setCSV, css, esc, axisFmt, fmtKind } = window.CX;
const $ = (id) => document.getElementById(id);
const fmt0 = d3.format(",.0f"), fmt1 = d3.format(",.1f"), fmt2 = d3.format(".2f"), fmtPct = d3.format(".1%");
const fmt$2 = (v) => (v == null || isNaN(v) ? "–" : (v < 0 ? "−" : "") + "$" + d3.format(",.2f")(Math.abs(v)));
const parseDate = (d) => new Date(d + "T12:00:00");
const fmtDate = d3.timeFormat("%a %b %-d, %Y");
const TECH_NAME = { coal: "coal", gas_steam: "gas steam", combined_cycle: "combined cycle", combustion_turbine: "combustion turbine" };
const SERIES = [
  { k: "cost", label: "Fuel cost at minimum output", color: "--c1" },
  { k: "offer", label: "Day-ahead minimum-energy offer", color: "--c2" },
];
const S = { data: undefined };

function hrCell(v) { return v == null ? "–" : fmt2(v); }
function suCell(mw, share) {
  if (share == null) return "–";
  return mw != null ? `${fmt1(mw)} MW, ${fmtPct(share)} of gross` : `– MW (${fmtPct(share)} of gross)`;
}

function outCell(g, n) { return g == null || n == null ? "–" : `${fmt0(g)} MW gross, ${fmt0(n)} MW net`; }

function table(u) {
  const s = u.su;
  const rows = [
    ["Heat rate, MMBtu per net MWh", hrCell(u.hr_min), hrCell(u.hr_full)],
    ...(s ? [["Station use", suCell(s.su_mw_min, s.su_share_min), suCell(s.su_mw_full, s.su_share_full)],
             ["Output", outCell(s.gross_min, s.net_min), outCell(s.gross_full, s.net_full)]] : []),
  ];
  $("fuel-table").innerHTML = `<table class="data fuel-tbl"><thead><tr><th class="t"></th><th>At minimum</th><th>At full load</th></tr></thead><tbody>` +
    rows.map((r) => `<tr><td class="t">${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join("") + "</tbody></table>";
  $("fuel-title-note").textContent = u.basis === "cogen" ? "(cogeneration basis)" : u.basis !== "fallback" ? "(measured)" : "(technology median)";
}

function lead(u, D) {
  const own = u.basis !== "fallback" && u.basis !== "cogen";
  const cost = u.cost.filter((v) => v != null), off = u.offer.map((v, i) => [v, u.cost[i]]).filter(([o, c]) => o != null && c != null);
  const src = u.basis === "cogen" ? `fuel chargeable to power: it is a cogeneration unit that also makes steam for an industrial host, so EPA's heat input covers both and ERCOT sees only the power sent to the grid. This is ${u.note ? esc(u.note.replace(/^cogeneration, fuel chargeable to power: /, "")) : "EIA-923's fuel for electricity"}, which credits the steam at about boiler efficiency` :
    own ? `measured on ${fmt0(u.min_hours)} steady hours at minimum${u.epa ? ` (EPA ${u.tech === "combined_cycle" ? "plant" : "unit"} ${esc(u.epa)})` : ""}` :
    `the ${TECH_NAME[u.tech] || u.tech} median (${u.note && !/^technology median$/i.test(u.note) ? esc(u.note) : "no EPA unit matched with enough hours"})`;
  const gap = off.length ? d3.median(off, ([o, c]) => o - c) : null;
  const shared = u.su && u.su.shared_with ? ` Station use is the plant unit's, shared by ${esc(u.su.shared_with.split("+").join(", "))}.` : "";
  return `Heat rate at minimum ${fmt2(u.hr_min)} and at full load ${fmt2(u.hr_full)} MMBtu per MWh of net output, ${src}.${shared} ` +
    (cost.length ? `Its cost of running at minimum averaged ${fmt$2(d3.mean(cost))}/MWh over the ${cost.length} days it was in the day-ahead market (${D[0]} to ${D[D.length - 1]}). ` : "") +
    (gap != null ? `On the ${off.length} days it filed a three-part offer, its minimum-energy offer sat ${fmt$2(Math.abs(gap))}/MWh ${gap >= 0 ? "above" : "below"} that cost at the median.` :
      "It made no three-part offer with a minimum-energy price on these days (self-committed or not offered).");
}

function chart(el, D, u) {
  const dates = D.map(parseDate), w = Math.max(280, el.clientWidth || 600), H = 250, m = { t: 26, r: 16, b: 26, l: 60 };
  const all = SERIES.flatMap((s) => u[s.k]).filter((v) => v != null);
  if (!all.length) { el.innerHTML = `<p class="empty">No cost or offer on these days.</p>`; return; }
  const x = d3.scaleTime().domain(d3.extent(dates)).range([m.l, w - m.r]);
  // the axis stops a little above the 98th percentile so a price spike (Winter Storm days) does
  // not flatten the rest; the tooltip and the CSV keep every value
  const top = Math.min(d3.max(all), d3.quantile(all.slice().sort(d3.ascending), 0.98) * 1.3);
  const y = d3.scaleLinear().domain([Math.min(0, d3.min(all)), top]).nice().range([H - m.b, m.t]), cut = d3.max(all) > y.domain()[1];
  const clipId = "fuel-clip-" + Math.random().toString(36).slice(2);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(w < 560 ? 4 : 8).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y), 5, fmtKind(fmt$2)).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text("$/MWh at minimum, by day" + (cut ? ` · axis cut at ${fmt$2(y.domain()[1])}` : ""));
  svg.append("clipPath").attr("id", clipId).append("rect").attr("x", m.l).attr("y", m.t - 4).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b + 4);
  const plot = svg.append("g").attr("clip-path", `url(#${clipId})`);
  const line = (ok) => d3.line().defined((v, i) => v != null && ok(i)).x((v, i) => x(dates[i])).y((v) => y(v));
  SERIES.forEach((s) => {
    const v = u[s.k];
    if (s.k === "cost") {      // solid on its own hub or coal price, dashed where Henry Hub or an average stands in
      plot.append("path").attr("fill", "none").attr("stroke", css(s.color)).attr("stroke-width", 2).attr("d", line((i) => !u.est[i])(v));
      plot.append("path").attr("fill", "none").attr("stroke", css(s.color)).attr("stroke-width", 2).attr("stroke-dasharray", "4 3")
        .attr("d", line((i) => u.est[i] || (i > 0 && u.est[i - 1]) || (i + 1 < v.length && u.est[i + 1]))(v));
    } else {
      plot.append("g").selectAll("circle").data(v.map((p, i) => [p, i]).filter(([p]) => p != null)).join("circle")
        .attr("cx", ([, i]) => x(dates[i])).attr("cy", ([p]) => y(p)).attr("r", 2.5).attr("fill", css(s.color));
    }
  });
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", H - m.b).style("display", "none");
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const t = x.invert(d3.pointer(ev)[0]), i = d3.minIndex(dates, (d) => Math.abs(d - t));
      cross.style("display", null).attr("x1", x(dates[i])).attr("x2", x(dates[i]));
      showTip(ev, `<h4>${fmtDate(dates[i])}</h4><table>` + SERIES.filter((s) => u[s.k][i] != null).map((s) =>
        `<tr><td><span class="sw" style="background:var(${s.color})"></span></td><td>${s.label}${s.k === "cost" && u.est[i] ? " (estimated)" : ""}</td><td class="n">${fmt$2(u[s.k][i])}</td></tr>`).join("") + "</table>");
    })
    .on("pointerleave", () => { cross.style("display", "none"); hideTip(); });
  el.replaceChildren(svg.node());
  setCSV(el, ["date", "cost_at_min_usd_mwh", "cost_estimated", "dam_min_energy_offer_usd_mwh"], D.map((d, i) => [d, u.cost[i], u.est[i], u.offer[i]]), "Cost at minimum and DAM minimum-energy offer");
}

async function draw() {
  const U = window.UNIT, box = $("fuel-panel");
  if (!U) return;
  if (S.data === undefined) S.data = await tryJSON("data/unit_fuel.json.gz");
  if (window.UNIT !== U) return;
  const u = S.data && S.data.units[U.name];
  box.hidden = !u;
  if (!u) return;
  table(u);
  $("fuel-lead").innerHTML = lead(u, S.data.dates);
  // the key draws each mark as the chart does: a line for the cost, a dot for each day's offer
  const est = u.est.some((v, i) => v && u.cost[i] != null);
  const fuel = u.tech === "coal" ? "delivered coal price" : "7-day hub gas price";
  $("fuel-legend").innerHTML =
    `<span><span class="sw sw-line" style="border-color:var(--c1)"></span>Fuel cost at minimum output (heat rate × ${fuel})</span>` +
    `<span><span class="sw sw-dot" style="background:var(--c2)"></span>Day-ahead minimum-energy offer</span>`;
  chart($("fuel-chart"), S.data.dates, u);
  $("fuel-foot").textContent = !est ? "" : u.tech === "coal"
    ? "Dashed: months its plant reported no coal price to the EIA, costed at the Texas average for reporting plants."
    : "Dashed: weeks with a day its hub had no price, filled with Henry Hub (plus Ship Channel's usual basis for Ship Channel units).";
}
window.addEventListener("unitchange", draw);
window.addEventListener("unitresize", draw);
if (window.UNIT) draw();
})();

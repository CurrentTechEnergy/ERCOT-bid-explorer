/* Day-ahead offers, "How the output was sold: day-ahead or real time": real-time output of thermal, wind and
   solar split into what the unit's three-part DAM award covered, what its owner's energy-only
   sale at its node covered, and the rest settled at the real-time price, from data/da_sold.json.gz
   (pipeline/da_sold.py).  By technology, by month and by hour of day, over all hours, hours under
   $10 or under $0 (DA system lambda).  The page only reads and draws. */
(function () {
"use strict";
const { tryJSON, showTip, hideTip, setCSV, css, esc } = window.CX;
const $ = (id) => document.getElementById(id);
// two teals for the day-ahead ways (their own tokens, so they never read as the sequential blues of
// "How thermal is committed" just above), neutral for real-time only; no way borrows a technology's color
const WAYS = [
  { id: "3p", label: "Three-part DAM award", color: "--sold-3p" },
  { id: "eo", label: "Owner's energy-only sale at its node", color: "--sold-eo" },
  { id: "rt", label: "Real-time only (no day-ahead sale at the plant)", color: "--c-other" },
];
const col = (w) => css(w.color);
const TECHS = ["nuclear", "coal", "combined_cycle", "gas_steam", "combustion_turbine", "wind", "solar"];
const THERMAL = ["nuclear", "coal", "combined_cycle", "gas_steam", "combustion_turbine"];
const NAME = { nuclear: "Nuclear", coal: "Coal & lignite", combined_cycle: "Combined cycle", gas_steam: "Gas steam", combustion_turbine: "Combustion turbine", wind: "Wind", solar: "Solar" };
const GROUP = { ren: ["Wind and solar", ["wind", "solar"]], thermal: ["All thermal", THERMAL], all: ["All shown", TECHS] };
const SEL = { ren: GROUP.ren[0], thermal: GROUP.thermal[0], ...NAME };
const LC = { ren: "wind and solar", thermal: "thermal" };
const BAND = { all: "all hours", lt10: "hours under $10", lt0: "hours under $0" };
const S = { band: "lt10", tech: "ren", meas: "gw", f: null };
const MON = (m) => d3.timeFormat("%b %y")(new Date(m + "-15T12:00:00"));
const techsOf = (k) => (GROUP[k] ? GROUP[k][1] : [k]);

function setSeg(id, v) { $(id).querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === v))); }
function bindSeg(id, key) {
  setSeg(id, S[key]);
  $(id).addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; S[key] = b.dataset.v; setSeg(id, S[key]); drawAll(); });
}

// average GW per way over the chosen band's hours, keyed by month (k 0), hour (k 1) or technology (k 2)
function series(k, techs) {
  const f = S.f, ts = new Set(techs);
  const hrsBy = d3.rollup(f.hours.filter((r) => r[2] === S.band), (v) => d3.sum(v, (r) => r[3]), (r) => r[k === 2 ? 2 : k]);
  const nAll = d3.sum(f.hours.filter((r) => r[2] === S.band), (r) => r[3]);
  const rows = f.rows.filter((r) => r[4] === S.band && ts.has(r[2]));
  const g = d3.rollup(rows, (v) => d3.sum(v, (r) => r[5]), (r) => r[k], (r) => r[3]);
  const keys = k === 0 ? [...new Set(f.hours.map((r) => r[0]))].sort() : k === 1 ? d3.range(1, 25) : techs;
  return keys.map((key) => {
    const h = k === 2 ? nAll : hrsBy.get(key) || 0, c = g.get(key) || new Map(), o = { key, h };
    WAYS.concat([{ id: "over" }]).forEach((w) => (o[w.id] = h ? (c.get(w.id) || 0) / h / 1000 : 0));
    o.total = d3.sum(WAYS, (w) => o[w.id]);
    return o;
  });
}

function bars(el, data, xl, tipHead) {
  const W = Math.max(300, el.clientWidth || 640), H = Math.round(Math.min(300, Math.max(220, W * 0.3)));
  const share = S.meas === "share";
  const m = { l: 46, r: 10, t: 10, b: 24 }, w = W - m.l - m.r, h = H - m.t - m.b;
  el.innerHTML = "";
  const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${W} ${H}`), g = svg.append("g").attr("transform", `translate(${m.l},${m.t})`);
  const x = d3.scaleBand().domain(data.map((d) => d.key)).range([0, w]).padding(0.18);
  const y = d3.scaleLinear().domain([0, share ? 1 : d3.max(data, (d) => d.total) || 1]).nice().range([h, 0]);
  y.ticks(5).forEach((t) => {
    g.append("line").attr("x1", 0).attr("x2", w).attr("y1", y(t)).attr("y2", y(t)).attr("stroke", css("--grid"));
    g.append("text").attr("x", -6).attr("y", y(t) + 4).attr("text-anchor", "end").attr("font-size", 11).attr("fill", css("--muted")).text(share ? d3.format(".0%")(t) : t ? `${t} GW` : "0");
  });
  const few = data.length <= 8, every = few ? 1 : Math.ceil(data.length / Math.max(1, Math.floor(w / 40)));
  data.forEach((d, i) => {
    let y0 = 0;
    WAYS.forEach((p) => {
      const v = share ? (d.total ? d[p.id] / d.total : 0) : d[p.id]; if (!v) return;
      g.append("rect").attr("x", x(d.key)).attr("width", x.bandwidth()).attr("y", y(y0 + v)).attr("height", y(y0) - y(y0 + v)).attr("fill", col(p));
      y0 += v;
    });
    if (!d.h) g.append("text").attr("x", x(d.key) + x.bandwidth() / 2).attr("y", h - 3).attr("text-anchor", "middle").attr("font-size", 10).attr("fill", css("--muted")).text("–");
    g.append("rect").attr("x", x(d.key)).attr("width", x.bandwidth()).attr("y", 0).attr("height", h).attr("fill", "transparent")
      .on("pointermove", (ev) => showTip(ev, `<h4>${esc(tipHead(d))}</h4>` + (d.h && d.total ? `<table>` +
        WAYS.map((p) => `<tr><td><span class="sw" style="background:${col(p)}"></span> ${esc(p.label)}</td><td class="n">${d3.format(".2f")(d[p.id])} GW</td><td class="n">${d3.format(".0%")(d[p.id] / d.total)}</td></tr>`).join("") +
        `<tr><td><b>Output</b></td><td class="n"><b>${d3.format(".2f")(d.total)} GW</b></td><td></td></tr>` +
        `<tr><td class="muted">Sold day-ahead beyond output (bought back)</td><td class="n muted">${d3.format(".2f")(d.over)} GW</td><td></td></tr></table>` : `<p>No output in these hours.</p>`)))
      .on("pointerleave", hideTip);
    if (i % every === 0) g.append("text").attr("x", x(d.key) + x.bandwidth() / 2).attr("y", h + 16).attr("text-anchor", "middle").attr("font-size", few && w < 420 ? 10 : 11).attr("fill", css("--muted")).text(xl(d.key));
  });
}

function drawAll() {
  if (!S.f) return;
  const ts = techsOf(S.tech);
  const mm = series(0, ts), hh = series(1, ts), tt = series(2, TECHS);
  const hrs = (d) => `${d3.format(",")(d.h)} hour${d.h === 1 ? "" : "s"}`;
  bars($("ds-tech"), tt, (k) => ({ nuclear: "Nuclear", coal: "Coal", combined_cycle: "CC", gas_steam: "Gas st.", combustion_turbine: "CT", wind: "Wind", solar: "Solar" })[k], (d) => `${NAME[d.key]}, ${BAND[S.band]}: ${hrs(d)}`);
  bars($("ds-month"), mm, MON, (d) => `${MON(d.key)}: ${hrs(d)}`);
  bars($("ds-hour"), hh, (k) => `HE${k}`, (d) => `HE${d.key}: ${hrs(d)}`);
  const n = d3.sum(mm, (d) => d.h), avg = {};
  WAYS.concat([{ id: "over" }]).forEach((p) => (avg[p.id] = n ? d3.sum(mm, (d) => d[p.id] * d.h) / n : 0));
  const tot = d3.sum(WAYS, (p) => avg[p.id]), pct = (v) => `${d3.format(".0%")(tot ? v / tot : 0)} (${d3.format(".1f")(v)} GW)`;
  const who = LC[S.tech] || NAME[S.tech].toLowerCase();
  const ctx = S.f.ctx.filter((r) => r[2] === S.band), cn = d3.sum(S.f.hours.filter((r) => r[2] === S.band), (r) => r[3]);
  const hub = cn ? d3.sum(ctx, (r) => r[3]) / cn / 1000 : 0, oth = cn ? d3.sum(ctx, (r) => r[4]) / cn / 1000 : 0;
  $("ds-answer").innerHTML = n && tot
    ? `<b>In ${BAND[S.band]}, ${pct(avg["3p"] + avg.eo)} of ${who} output was sold day-ahead at the plant</b>: ${pct(avg["3p"])} through three-part awards and ${pct(avg.eo)} through the owner's energy-only sales at its node. The other ${pct(avg.rt)} settled at the real-time price with no day-ahead sale at the plant. Output averaged ${d3.format(".1f")(tot)} GW over ${d3.format(",")(n)} hours. ` +
      `<span class="muted">Not counted above, because the DAM files can't tie them to a plant: ${d3.format(".1f")(hub)} GW of energy-only sales at hubs and load zones, mostly virtual supply from traders and banks with no plants, plus hedges by large generation-and-retail portfolios (mainly fossil; renewable-only QSEs sell almost none there); and ${d3.format(".1f")(oth)} GW sold at these plants' own nodes by other QSEs, usually traders or a PPA offtaker selling the plant's output. Some of this may hedge the output shown here, so "real-time only" is an upper bound on what is truly unhedged.</span>`
    : `No ${BAND[S.band]} in this period.`;
  $("ds-legend").innerHTML = WAYS.map((p) => `<span><span class="sw" style="background:${col(p)}"></span>${esc(p.label)}</span>`).join("");
  const cols = ["key", ...WAYS.map((p) => `${p.id}_gw`), "over_gw", "hours"];
  const csv = (a) => a.map((d) => [d.key, ...WAYS.map((p) => +d[p.id].toFixed(3)), +d.over.toFixed(3), d.h]);
  setCSV($("ds-tech"), cols, csv(tt), `Output sold day-ahead by technology, ${S.band}`);
  setCSV($("ds-month"), cols, csv(mm), `Output sold day-ahead by month, ${S.tech}, ${S.band}`);
  setCSV($("ds-hour"), cols, csv(hh), `Output sold day-ahead by hour, ${S.tech}, ${S.band}`);
}

(async function () {
  const f = await tryJSON("data/da_sold.json.gz");
  if (!f || !(f.rows || []).length) { $("ds-status").textContent = "Data not available yet."; return; }
  S.f = f;
  const fmt = d3.timeFormat("%b %-d, %Y");
  $("ds-status").textContent = `${fmt(new Date(f.from + "T12:00:00"))} to ${fmt(new Date(f.through + "T12:00:00"))}`;
  window.CX.setNote($("ds-note"), "How much of what each technology generated was already sold in the day-ahead market, and how. The panel above asks who turned a unit on; this one asks how its megawatts were sold. A self-committed unit can still have sold its output day-ahead.",
    "Each hour, every unit's real-time output (telemetered, from the 60-day SCED data) is split in order: first what its own three-part DAM energy award covered, then what energy-only offer awards at its settlement point by a QSE that represents a resource there covered (the owner's own day-ahead sale; shared over the units at that point by the output each has left, and capped at it), and the rest. " +
    "The energy-only file names the QSE and settlement point but not the plant, so other QSEs' sales at a plant's node (traders, offtakers) are not counted as the plant's, and neither are sales at hubs or load zones or hedges outside the DAM (bilateral, PPAs, forwards). \"Real-time only\" therefore means no day-ahead sale visible at the plant, not unhedged. " +
    "Day-ahead sales beyond a unit's output (bought back at the real-time price) are shown in the tooltip, not stacked. A financial DAM sale does not change the real-time offer at the margin: each extra MW still earns the real-time price. " +
    "\n\nHours under $10 and under $0 are on the day-ahead system lambda, the site's cheap-hour price. From the 60-day files, so the latest 60 days are not in yet.");
  $("ds-sel").innerHTML = Object.entries(SEL).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
  $("ds-sel").value = S.tech;
  $("ds-sel").onchange = (e) => { S.tech = e.target.value; drawAll(); };
  bindSeg("ds-band", "band"); bindSeg("ds-meas", "meas");
  drawAll();
  let t, lastW = 0;
  new ResizeObserver((e) => { const w = Math.round(e[0].contentRect.width); if (w === lastW) return; lastW = w; clearTimeout(t); t = setTimeout(drawAll, 120); }).observe($("ds-panel"));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", drawAll);
  new MutationObserver(drawAll).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
})();
})();

/* Turn-ons and Turn-offs, "How thermal is committed": online thermal minimum output (or output) split
   by the day-ahead position that hour, from data/commit_mix.json.gz (pipeline/commit_mix.py).
   By month and by hour of day, over all hours, hours under $10 or under $0 (DA system lambda).
   The page only reads and draws. */
(function () {
"use strict";
const { tryJSON, showTip, hideTip, setCSV, css, esc } = window.CX;
const $ = (id) => document.getElementById(id);
const POS = [
  { id: "self", label: "Self-committed (status ON)", color: "--c1" },
  { id: "dam", label: "DAM committed", color: "--c2" },
  { id: "rt", label: "Neither (after the DAM, or RUC)", color: "--c-other" },
];
const TECH = { all: "All thermal", combined_cycle: "Combined cycle", combustion_turbine: "Combustion turbine", gas_steam: "Gas steam", coal: "Coal & lignite" };
const TECH_LC = { all: "thermal", combined_cycle: "combined-cycle", combustion_turbine: "combustion turbine", gas_steam: "gas steam", coal: "coal" };
const BAND = { all: "all hours", lt10: "hours under $10", lt0: "hours under $0" };
const S = { band: "lt10", tech: "all", meas: "0", f: null };
const MON = (m) => d3.timeFormat("%b %y")(new Date(m + "-15T12:00:00"));

function setSeg(id, v) { $(id).querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === v))); }
function bindSeg(id, key) {
  setSeg(id, S[key]);
  $(id).addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; S[key] = b.dataset.v; setSeg(id, S[key]); drawAll(); });
}

// average GW by month or hour of day, per position, over the chosen band's hours
function series(by) {
  const f = S.f, k = by === "m" ? 0 : 1, mi = 5 + +S.meas;
  const hrs = d3.rollup(f.hours.filter((r) => r[2] === S.band), (v) => d3.sum(v, (r) => r[3]), (r) => r[k]);
  const g = d3.rollup(f.rows.filter((r) => r[4] === S.band && (S.tech === "all" || r[2] === S.tech)), (v) => d3.sum(v, (r) => r[mi]), (r) => r[k], (r) => r[3]);
  const keys = by === "m" ? [...new Set(f.hours.map((r) => r[0]))].sort() : d3.range(1, 25);
  return keys.map((key) => {
    const h = hrs.get(key) || 0, c = g.get(key) || new Map(), o = { key, h };
    POS.forEach((p) => (o[p.id] = h ? (c.get(p.id) || 0) / h / 1000 : 0));
    o.total = d3.sum(POS, (p) => o[p.id]);
    return o;
  });
}

function bars(el, data, xl) {
  const W = Math.max(300, el.clientWidth || 640), H = Math.round(Math.min(300, Math.max(220, W * 0.3)));
  const m = { l: 46, r: 10, t: 10, b: 24 }, w = W - m.l - m.r, h = H - m.t - m.b;
  el.innerHTML = "";
  const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${W} ${H}`), g = svg.append("g").attr("transform", `translate(${m.l},${m.t})`);
  const x = d3.scaleBand().domain(data.map((d) => d.key)).range([0, w]).padding(0.18);
  const y = d3.scaleLinear().domain([0, d3.max(data, (d) => d.total) || 1]).nice().range([h, 0]);
  y.ticks(5).forEach((t) => {
    g.append("line").attr("x1", 0).attr("x2", w).attr("y1", y(t)).attr("y2", y(t)).attr("stroke", css("--grid"));
    g.append("text").attr("x", -6).attr("y", y(t) + 4).attr("text-anchor", "end").attr("font-size", 11).attr("fill", css("--muted")).text(t ? `${t} GW` : "0");
  });
  const every = Math.ceil(data.length / Math.max(1, Math.floor(w / 40)));
  data.forEach((d, i) => {
    let y0 = 0;
    POS.forEach((p) => {
      const v = d[p.id]; if (!v) return;
      g.append("rect").attr("x", x(d.key)).attr("width", x.bandwidth()).attr("y", y(y0 + v)).attr("height", y(y0) - y(y0 + v)).attr("fill", css(p.color));
      y0 += v;
    });
    if (!d.h) g.append("text").attr("x", x(d.key) + x.bandwidth() / 2).attr("y", h - 3).attr("text-anchor", "middle").attr("font-size", 10).attr("fill", css("--muted")).text("–");
    g.append("rect").attr("x", x(d.key)).attr("width", x.bandwidth()).attr("y", 0).attr("height", h).attr("fill", "transparent")
      .on("pointermove", (ev) => showTip(ev, `<h4>${esc(xl(d.key))}: ${d3.format(",")(d.h)} hour${d.h === 1 ? "" : "s"}</h4>` + (d.h ? `<table>` +
        POS.map((p) => `<tr><td><span class="sw" style="background:var(${p.color})"></span> ${esc(p.label)}</td><td class="n">${d3.format(".1f")(d[p.id])} GW</td><td class="n">${d3.format(".0%")(d.total ? d[p.id] / d.total : 0)}</td></tr>`).join("") +
        `<tr><td><b>Total</b></td><td class="n"><b>${d3.format(".1f")(d.total)} GW</b></td><td></td></tr></table>` : `<p>No such hours.</p>`)))
      .on("pointerleave", hideTip);
    if (i % every === 0) g.append("text").attr("x", x(d.key) + x.bandwidth() / 2).attr("y", h + 16).attr("text-anchor", "middle").attr("font-size", 11).attr("fill", css("--muted")).text(xl(d.key));
  });
}

function drawAll() {
  if (!S.f) return;
  const mm = series("m"), hh = series("h");
  bars($("cm-month"), mm, MON);
  bars($("cm-hour"), hh, (k) => `HE${k}`);
  const n = d3.sum(mm, (d) => d.h), avg = {};
  POS.forEach((p) => (avg[p.id] = n ? d3.sum(mm, (d) => d[p.id] * d.h) / n : 0));
  const tot = d3.sum(POS, (p) => avg[p.id]), pct = (id) => d3.format(".0%")(tot ? avg[id] / tot : 0);
  const ml = S.meas === "1" ? "output" : "minimum output";
  $("cm-answer").innerHTML = n
    ? `<b>In ${BAND[S.band]}, ${pct("self")} of online ${TECH_LC[S.tech]} ${ml} was self-committed and ${pct("dam")} DAM committed</b>; ${pct("rt")} had neither. The ${ml} was ${d3.format(".1f")(tot)} GW on average over ${d3.format(",")(n)} hours.`
    : `No ${BAND[S.band]} in this period.`;
  $("cm-legend").innerHTML = POS.map((p) => `<span><span class="sw" style="background:var(${p.color})"></span>${esc(p.label)}</span>`).join("");
  setCSV($("cm-month"), ["month", ...POS.map((p) => `${p.id}_gw`), "hours"], mm.map((d) => [d.key, ...POS.map((p) => +d[p.id].toFixed(3)), d.h]), `Thermal by commitment, ${S.tech}, ${S.band}`);
  setCSV($("cm-hour"), ["he", ...POS.map((p) => `${p.id}_gw`), "hours"], hh.map((d) => [d.key, ...POS.map((p) => +d[p.id].toFixed(3)), d.h]), `Thermal by commitment by hour, ${S.tech}, ${S.band}`);
}

(async function () {
  const f = await tryJSON("data/commit_mix.json.gz");
  if (!f || !(f.rows || []).length) { $("cm-status").textContent = "Data not available yet."; return; }
  S.f = f;
  const fmt = d3.timeFormat("%b %-d, %Y");
  $("cm-status").textContent = `${fmt(new Date(f.from + "T12:00:00"))} to ${fmt(new Date(f.through + "T12:00:00"))}`;
  window.CX.setNote($("cm-note"), "Who decided that the thermal units online would run: the owner, the day-ahead market, or a later commitment. Each hour, every unit online in real time is split by its day-ahead position that hour.",
    "Self-committed: the unit's DAM resource status was ON (the owner put it on in its current operating plan before the day-ahead market). DAM committed: its status was not ON and it held a DAM energy award of at least 95% of its minimum, so the day-ahead market committed it on its three-part offer (eligible for make-whole). Neither: online in real time with neither, so committed after the day-ahead market or by RUC. " +
    "\n\nOnline: online in at least half the hour's SCED runs. Minimum output is the unit's LSL, output its base point. Hours under $10 and under $0 are on the day-ahead system lambda, the site's cheap-hour price. The status is the DAM file's hourly status where it has one, else the day's. From the 60-day files, so the latest 60 days are not in yet.");
  $("cm-tech").innerHTML = Object.entries(TECH).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
  $("cm-tech").value = S.tech;
  $("cm-tech").onchange = (e) => { S.tech = e.target.value; drawAll(); };
  bindSeg("cm-band", "band"); bindSeg("cm-meas", "meas");
  drawAll();
  let t, lastW = 0;
  new ResizeObserver((e) => { const w = Math.round(e[0].contentRect.width); if (w === lastW) return; lastW = w; clearTimeout(t); t = setTimeout(drawAll, 120); }).observe($("cm-panel"));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", drawAll);
  new MutationObserver(drawAll).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
})();
})();

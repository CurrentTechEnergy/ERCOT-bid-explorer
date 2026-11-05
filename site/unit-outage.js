/* Unit page, wind and solar: outages. The banner under the unit's name, the hour-by-hour strip
   (available, derated, on outage, offline) and the table of outages and derates, for the unit
   unit.js has selected. Reads data/renew_outages_60d.json.gz (pipeline/renew_outages.py): whole-
   unit outages are the hours ERCOT's 60-day telemetered status reads OUT; derates come from
   ERCOT's Unplanned Resource Outages report and count only past its limits (at least 10% of the
   unit's max MW and 5 MW, for 4 hours or more). Times are Central, as ERCOT gives them. */
(() => {
"use strict";

const { tryJSON, showTip, hideTip, setCSV, css, esc } = window.CX;
const $ = (id) => document.getElementById(id);
const fmt0 = d3.format(",.0f");
const parseDate = (d) => new Date(d + "T12:00:00");
const fmtDay = d3.timeFormat("%b %-d"), fmtDayY = d3.timeFormat("%b %-d, %Y"), fmtDate = d3.timeFormat("%a %b %-d, %Y");
const COLOR = { wind: "--c3", solar: "--c4" };
const STATES = { r: "Available", d: "Derated (ERCOT outage report)", o: "On outage (ERCOT status OUT)", "0": "Offline" };
const parseTs = (s) => (s ? new Date(s.length === 10 ? s + "T00:00" : s) : null);
const fmtTs = (s) => { const t = parseTs(s); return t ? `${fmtDayY(t)} ${d3.timeFormat("%-I:%M %p")(t)}` : "–"; };
const hoursOf = (a, b) => (parseTs(b) - parseTs(a)) / 3.6e6;
const fmtDur = (h) => (h == null || isNaN(h) ? "–" : h >= 48 ? `${fmt0(h / 24)} days` : `${fmt0(h)} h`);

let RO = null, loaded = null;

function spellsFor(name) {
  return ((RO && RO.spells) || []).filter((s) => s[0] === name);
}

// the banner, only for a unit with a whole-unit outage of a day or more in the loaded period: the latest one
function drawBanner(U) {
  const el = $("unit-outage");
  const sp = spellsFor(U.name), last = RO && RO.dates.at(-1);
  const outs = sp.filter((s) => s[2] === "out" && (s[4] == null || hoursOf(s[3], s[4]) >= 24));
  const ders = sp.filter((s) => s[2] === "derate");
  if (!outs.length) { el.hidden = true; return; }     // derates alone are in the panel, not the banner
  const o = outs.at(-1);
  let txt = "";
  if (o) {
    const a = parseTs(o[3]), b = o[4] ? parseTs(o[4]) : null;
    const dur = b ? fmtDur(hoursOf(o[3], o[4])) : `${fmtDur((parseDate(last) - a) / 3.6e6 + 12)} so far`;
    txt = b ? `<b>On outage ${fmtDay(a)} to ${fmtDayY(b)}</b> (${dur}, all ${fmt0(o[5])} MW). `
      : `<b>On outage since ${fmtDayY(a)}</b>, still out at the end of the 60-day data (${esc(last)}; ${dur}). `;
    if (o[7] && o[7] !== "OUT status") txt += `ERCOT's outage report lists it as ${esc(o[7].toLowerCase())}` + (o[8] ? `, with its planned return moved ${o[8]} time${o[8] === 1 ? "" : "s"}. ` : ". ");
    const more = outs.length - 1;
    if (more > 0) txt += `${more} other outage${more === 1 ? "" : "s"} of a day or more in the period. `;
  }
  if (ders.length) txt += `${ders.length} partial derate${ders.length === 1 ? "" : "s"} in the period.`;
  el.innerHTML = txt + ` <a href="#rout-panel">Details</a>`;
  el.hidden = false;
}

function drawStrip(U) {
  const el = $("rout-strip"), color = COLOR[U.tech] || "--c-other";
  const str = RO.strips[U.name], dstr = RO.dates, D = dstr.length, dates = dstr.map(parseDate), cap = RO.cap[U.name];
  $("rout-legend").innerHTML = [[color, 0.85, "Available"], ["--c8", 0.9, "Derated (ERCOT outage report)"], ["--ink-2", 0.5, "On outage (status OUT)"], ["--grid", 1, "Offline"]]
    .map(([c, o, l]) => `<span><span class="sw" style="background:var(${c});opacity:${o}"></span>${l}</span>`).join("");
  if (!str) {
    $("rout-note").textContent = `No outage hours and no derate past the limits in ${dstr[0]} to ${dstr.at(-1)}` + (cap ? ` (largest HSL ${fmt0(cap)} MW).` : ".");
    el.replaceChildren(); return;
  }
  const n = (c) => [...str].filter((x) => x === c).length;
  const hrs = (k) => `${fmt0(n(k))} hour${n(k) === 1 ? "" : "s"}`;
  $("rout-note").textContent = `Over ${D} days: ${hrs("o")} on outage (ERCOT's telemetered status OUT), ${hrs("d")} derated, ${hrs("r")} available. ` +
    `Capacity here is the unit's largest hourly HSL in the period, ${fmt0(cap)} MW.`;
  const w = Math.max(280, el.clientWidth || 600), m = { t: 16, r: 16, b: 26, l: 64 }, ch = 7, H = m.t + m.b + ch * 24;
  const x = d3.scaleTime().domain([d3.timeHour.offset(dates[0], -12), d3.timeHour.offset(dates[D - 1], 12)]).range([m.l, w - m.r]);
  const cw = x(d3.timeDay.offset(x.domain()[0], 1)) - x(x.domain()[0]);
  const col = { r: [css(color), 0.85], d: [css("--c8"), 0.9], o: [css("--ink-2"), 0.5], "0": [css("--grid"), 1] };
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`), gg = svg.append("g");
  for (let i = 0; i < D; i++) for (let h = 0; h < 24; h++) {
    const c = str[i * 24 + h];
    if (!col[c]) continue;
    gg.append("rect").attr("x", x(dates[i]) - cw / 2).attr("y", m.t + h * ch).attr("width", cw + 0.3).attr("height", ch - 0.5)
      .attr("fill", col[c][0]).attr("fill-opacity", col[c][1]);
  }
  const y = d3.scaleBand().domain(d3.range(24)).range([m.t, m.t + ch * 24]);
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l - 4},0)`).call(d3.axisLeft(y).tickValues([0, 5, 11, 17, 23]).tickFormat((h) => `HE ${h + 1}`).tickSize(0)).select(".domain").remove();
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(w < 560 ? 4 : 8).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text("Hour by hour: available, derated, on outage or offline");
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", ch * 24).attr("fill", "transparent")
    .on("pointermove", (ev) => {
      const [px, py] = d3.pointer(ev);
      const i = d3.minIndex(dates, (d) => Math.abs(d - x.invert(px))), h = Math.max(0, Math.min(23, Math.floor((py - m.t) / ch)));
      showTip(ev, `<h4>${fmtDate(dates[i])} · HE ${h + 1}</h4>${STATES[str[i * 24 + h]] || "No data"}`);
    })
    .on("pointerleave", hideTip);
  el.replaceChildren(svg.node());
  setCSV(el, ["date", "hour_ending", "state"], dstr.flatMap((d, i) => d3.range(24).map((h) => [d, h + 1, STATES[str[i * 24 + h]] || ""])), `${U.name} hourly availability`);
}

function drawTable(U) {
  const el = $("rout-table"), sp = spellsFor(U.name).slice().reverse(), L = RO.limits || {};
  $("rout-table-note").textContent = `Whole-unit outages are runs of 4 hours or more with ERCOT's telemetered status OUT (60-day data). Derates are from ERCOT's Unplanned Resource Outages report, counted when they take at least ${d3.format(".0%")(L.share || 0.1)} of the unit's max MW and ${fmt0(L.mw || 5)} MW, for ${fmt0(L.hours || 4)} hours or more; smaller ones are left out. Planned outages are not in that report. Times are Central.`;
  if (!sp.length) { el.innerHTML = `<p class="empty">None in the period.</p>`; return; }
  const SHOW = 15, rows = sp.slice(0, SHOW).map((s) => {
    const dur = s[4] ? hoursOf(s[3], s[4]) : null;
    return `<tr><td class="t">${s[2] === "out" ? "Outage" : "Derate"}</td><td>${fmtTs(s[3])}</td><td>${s[4] ? fmtTs(s[4]) : "still out"}</td><td>${fmtDur(dur)}</td>` +
      `<td>${fmt0(s[5])} of ${fmt0(s[6])} MW</td><td>${esc(s[7] || "")}</td><td>${s[8] || ""}</td></tr>`;
  }).join("");
  el.innerHTML = `<table class="data"><thead><tr><th>Kind</th><th>Start</th><th>End</th><th>Length</th><th>MW out</th><th>ERCOT type</th><th>Planned end moved</th></tr></thead><tbody>${rows}</tbody></table>` +
    (sp.length > SHOW ? `<p class="note">The latest ${SHOW} of ${sp.length}; the download has them all.</p>` : "");
  setCSV(el, ["kind", "start", "end", "mw_out", "mw_max", "ercot_type", "planned_end_moves"], sp.map((s) => [s[2], s[3], s[4], s[5], s[6], s[7], s[8]]), `${U.name} outages and derates`);
}

async function draw() {
  const U = window.UNIT;
  if (!U) return;
  const renew = U.tech === "wind" || U.tech === "solar";
  $("rout-panel").hidden = true;
  $("unit-outage").hidden = true;
  if (!renew) return;
  if (!loaded) loaded = tryJSON("data/renew_outages_60d.json.gz").then((d) => { RO = d; window.RENEW_OUT = d; });
  await loaded;
  if (window.UNIT !== U || !RO) return;
  drawBanner(U);
  $("rout-panel").hidden = false;
  drawStrip(U);
  drawTable(U);
  window.dispatchEvent(new CustomEvent("renewoutloaded"));
}
window.addEventListener("unitchange", draw);
window.addEventListener("unitresize", draw);
if (window.UNIT) draw();
})();

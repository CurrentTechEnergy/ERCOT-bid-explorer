/* What's changing: one dated feed of every change the site's detectors found, newest first,
   grouped by week of operating date. Reads data/events.json.gz (pipeline/events.py, the same
   list the Unit page's recent changes and the Atom feeds come from) and data/groups_60d.json.gz
   for each thermal unit's timescale group. Notable changes ("major" in the file) show by
   default; the rest sit behind "All changes". The filters live in the address bar, so a view
   can be linked. */
(() => {
"use strict";

const { tryJSON, esc, readHash, writeHash } = window.CX;
const $ = (id) => document.getElementById(id);
const WEEKS = 8;        // weeks drawn before "Show more weeks"
const TECH_LABEL = {
  nuclear: "Nuclear", coal: "Coal & lignite", combined_cycle: "Combined cycle", gas_steam: "Gas steam",
  combustion_turbine: "Peakers (CT and recip)", wind: "Wind", solar: "Solar", storage: "Battery storage", hydro: "Hydro", other: "Other",
};
const TECH_ORDER = Object.keys(TECH_LABEL);
const trainOf = (u) => { const m = /^(.*_CC\d+)_/.exec(u); return m ? m[1] : u; };
const unitHref = (u) => `unit.html?unit=${encodeURIComponent(trainOf(u))}`;   // a combined-cycle configuration opens its train
const fmt$ = (v) => (v == null || isNaN(v) ? "–" : (v < 0 ? "−" : "") + "$" + d3.format(",.0f")(Math.abs(v)));
const fmtPct = d3.format(".0%");
const parseDate = d3.utcParse("%Y-%m-%d");
const fmtDay = d3.utcFormat("%b %-d");
const fmtLong = d3.utcFormat("%b %-d, %Y");
const isoDay = d3.utcFormat("%Y-%m-%d");
const weekOf = (d) => isoDay(d3.utcMonday.floor(parseDate(d)));

const S = { E: null, G: null, groupOf: new Map(), groupLabel: {}, latestSeen: null, weeks: WEEKS,
  tech: "", group: "", kind: "", span: "90", all: "major", q: "" };

// the numbers behind a change, in the kind's own terms (as on the Unit page)
function numbers(e) {
  const k = e.kind;
  if (k === "cutoff") return `${fmt$(e.before_usd)} → ${fmt$(e.after_usd)} for the day`;
  if (k === "bidding") return e.field === "rel" ? `${fmt$(e.before)} → ${fmt$(e.after)}/MWh against peers` : `${fmtPct(e.before)} → ${fmtPct(e.after)}`;
  if (k.startsWith("shutdown")) return `loss of staying on ${fmt$(e.value)}` + (e.award != null ? `, award over ${fmtPct(e.award)} of the window` : "");
  if (k.startsWith("renew_")) return e.before != null && e.after != null ? `${fmt$(e.before)} → ${fmt$(e.after)}/MWh` : "";
  if (k.startsWith("outage")) return `${e.value} days`;
  if (k === "battery_size") return (e.signals || []).map(([f, b, a]) => `${d3.format(",")(b)} → ${d3.format(",")(a)} ${f === "hsl" ? "MW" : "MWh"}`).join(", ");
  if (k === "fuel") return `${fmt$(e.before)} → ${fmt$(e.after)}/MWh` + (e.gas_before != null && e.gas_after != null ? `, gas $${e.gas_before.toFixed(2)} → $${e.gas_after.toFixed(2)}` : "");
  return "";
}

const groupOfEvent = (e) => S.groupOf.get(e.unit) || S.groupOf.get(trainOf(e.unit)) || "";
const isNew = (e) => S.latestSeen && e.seen === S.latestSeen && e.seen !== S.E.baseline;

function filtered() {
  const E = S.E.events, last = parseDate(S.E.last);
  const from = S.span === "all" ? null : isoDay(d3.utcDay.offset(last, -(+S.span - 1)));
  const q = S.q.trim().toUpperCase();
  return E.filter((e) => (!from || e.date >= from)
    && (!S.tech || e.tech === S.tech)
    && (!S.group || groupOfEvent(e) === S.group)
    && (!S.kind || e.kind === S.kind)
    && (!q || e.unit.toUpperCase().includes(q) || (e.units || []).some((u) => u.toUpperCase().includes(q))));
}

function drawCounts(evs) {
  const n = d3.rollup(evs, (v) => v.length, (e) => e.kind);
  const kinds = Object.keys(S.E.kinds).filter((k) => n.get(k));
  $("kind-counts").innerHTML = kinds.length > 1
    ? kinds.sort((a, b) => n.get(b) - n.get(a)).map((k) => `<button type="button" data-k="${k}" title="Show only this kind"><b>${n.get(k)}</b> ${esc(S.E.kinds[k].toLowerCase())}</button>`).join("")
    : "";
  $("kind-counts").querySelectorAll("button").forEach((b) => { b.onclick = () => { S.kind = b.dataset.k; $("f-kind").value = S.kind; draw(); }; });
}

function row(e) {
  // wind and solar events are per plant: the link opens its first unit, whose page lists the plant's changes
  const g = groupOfEvent(e), multi = e.units && e.units.length > 1;
  const unit = e.kind === "fuel" ? `${esc(TECH_LABEL[e.tech] || e.tech)} fleet <span class="tag">${e.value} units</span>` : `<a href="${unitHref((e.units && e.units[0]) || e.unit)}">${esc(e.unit)}</a>` + (multi ? ` <span class="tag">${e.units.length} units</span>` : "");
  return `<tr class="${e.major ? "" : "minor"}"><td class="t">${fmtDay(parseDate(e.date))}</td><td class="t">${unit}</td>` +
    `<td class="t hide-sm">${esc(TECH_LABEL[e.tech] || e.tech)}${g ? ` <span class="tag">${esc(S.groupLabel[g] || g)}</span>` : ""}</td>` +
    `<td class="t ev"><b>${esc(S.E.kinds[e.kind] || e.kind)}</b>${isNew(e) ? ` <span class="tag new">new</span>` : ""}<br>${esc(e.title)}${numbers(e) ? `<span class="num-sm"><br>${esc(numbers(e))}</span>` : ""}</td>` +
    `<td class="t num hide-sm">${esc(numbers(e))}</td></tr>`;
}

function draw() {
  writeHash({ tech: S.tech, group: S.group, kind: S.kind, span: S.span === "90" ? "" : S.span, show: S.all === "major" ? "" : S.all, q: S.q });
  document.querySelectorAll("#f-span button").forEach((b) => b.setAttribute("aria-checked", b.dataset.v === S.span));
  document.querySelectorAll("#f-all button").forEach((b) => b.setAttribute("aria-checked", b.dataset.v === S.all));
  const inView = filtered(), evs = S.all === "all" ? inView : inView.filter((e) => e.major);
  const nMajor = inView.filter((e) => e.major).length;
  $("feed-count").textContent = S.all === "all" ? `${inView.length} changes, ${nMajor} notable` : `${nMajor} notable of ${inView.length}`;
  drawCounts(evs);
  if (!evs.length) {
    $("feed").innerHTML = `<p class="empty">No ${S.all === "all" ? "" : "notable "}changes match these filters.` +
      (S.all !== "all" && inView.length ? ` ${inView.length} smaller ones do: choose "All changes".` : "") + `</p>`;
    $("feed-more").hidden = true;
    return;
  }
  const weeks = d3.groups(evs, (e) => weekOf(e.date));   // events are newest first, so weeks are too
  const head = `<thead><tr><th class="t w-date">Date</th><th class="t w-unit">Unit</th><th class="t hide-sm w-tech">Technology</th><th class="t">Change</th><th class="t hide-sm w-num">Numbers</th></tr></thead>`;
  $("feed").innerHTML = weeks.slice(0, S.weeks).map(([wk, list]) => {
    const kinds = d3.rollups(list, (v) => v.length, (e) => e.kind).sort((a, b) => b[1] - a[1]);
    const summary = kinds.map(([k, n]) => `${n} ${S.E.kinds[k].toLowerCase()}`).join(", ");
    return `<h3 class="week">Week of ${fmtLong(parseDate(wk))} <span class="h-note">${list.length} change${list.length > 1 ? "s" : ""}: ${esc(summary)}</span></h3>` +
      `<div class="units-wrap"><table class="data">${head}<tbody>${list.map(row).join("")}</tbody></table></div>`;
  }).join("");
  $("feed-more").hidden = weeks.length <= S.weeks;
  $("feed-more").textContent = `Show more weeks (${weeks.length - S.weeks} more)`;
}

function options(el, first, entries) {
  el.innerHTML = `<option value="">${first}</option>` + entries.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("");
}

async function boot() {
  const [E, G] = await Promise.all([tryJSON("data/events.json.gz"), tryJSON("data/groups_60d.json.gz")]);
  if (!E || !E.events || !E.events.length) {
    $("status").textContent = "No changes yet. The list is built by the data update workflow.";
    $("feed").innerHTML = `<p class="empty">The changes list hasn't been built yet.</p>`;
    return;
  }
  S.E = E;
  S.latestSeen = d3.max(E.events, (e) => e.seen);
  if (G && G.units) {
    for (const [u, r] of Object.entries(G.units)) S.groupOf.set(u, r[1]);
    S.groupLabel = Object.fromEntries(G.groups.map((g) => [g[0], g[1]]));
  }
  const newN = E.new_today || 0;
  $("status").textContent = `${E.n.toLocaleString()} changes, ${E.n_major.toLocaleString()} notable, ${E.first} to ${E.last} · updated ${E.updated.slice(0, 10)}` +
    (newN ? ` · ${newN} new in the latest update` : "");
  window.CX.setNote($("feed-note"), "Grouped by week, newest first. Notable changes show by default; switch to all for the rest. New marks what the latest update found.", `Grouped by week of the operating day. Notable means a change the detectors rate as large: daily cycling starting or stopping, a shutdown after 30 days on or despite a day-ahead award, an offer shift of $20/MWh or more against peers or of half the day in how much is offered at or below $0, an outage of 30 days or more, a large wind or solar floor or formula change, a technology's median offer moving by half or more, a new unit or battery, a battery growing or shrinking by half, or a new decision maker deciding a unit's offers (from ERCOT's DME list; a new QSE alone is not notable). "New" marks changes the latest update found.`);

  const techs = [...new Set(E.events.map((e) => e.tech))].sort((a, b) => TECH_ORDER.indexOf(a) - TECH_ORDER.indexOf(b));
  options($("f-tech"), "All technologies", techs.map((t) => [t, TECH_LABEL[t] || t]));
  options($("f-group"), "All groups", (G?.groups || []).map((g) => [g[0], g[1]]));
  const kinds = Object.keys(E.kinds).filter((k) => E.events.some((e) => e.kind === k));
  options($("f-kind"), "All kinds", kinds.map((k) => [k, E.kinds[k]]));

  const h = readHash();
  S.tech = techs.includes(h.tech) ? h.tech : "";
  S.group = S.groupLabel[h.group] ? h.group : "";
  S.kind = kinds.includes(h.kind) ? h.kind : "";
  S.span = ["30", "90", "all"].includes(h.span) ? h.span : "90";
  S.all = h.show === "all" ? "all" : "major";
  S.q = h.q || "";
  $("f-tech").value = S.tech; $("f-group").value = S.group; $("f-kind").value = S.kind; $("f-q").value = S.q;

  const reset = () => { S.weeks = WEEKS; draw(); };
  $("f-tech").onchange = (e) => { S.tech = e.target.value; reset(); };
  $("f-group").onchange = (e) => { S.group = e.target.value; reset(); };
  $("f-kind").onchange = (e) => { S.kind = e.target.value; reset(); };
  $("f-q").oninput = (e) => { S.q = e.target.value; reset(); };
  document.querySelectorAll("#f-span button").forEach((b) => { b.onclick = () => { S.span = b.dataset.v; reset(); }; });
  document.querySelectorAll("#f-all button").forEach((b) => { b.onclick = () => { S.all = b.dataset.v; reset(); }; });
  $("feed-more").onclick = () => { S.weeks += WEEKS; draw(); };
  draw();
}
boot();
})();

/* Shared helpers for every page: data loading, tooltips that pin on click, chart downloads
   (PNG, SVG, CSV), links that reopen the current view and the nav row's find-a-unit box. Exposed as window.CX. */
(() => {
"use strict";
const $ = (id) => document.getElementById(id);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

// ------------------------------------------------------------ analytics ---
// GoatCounter page counts: no cookies, no personal data. Set to "" to turn off.
const GOATCOUNTER_CODE = "ercotbids";
if (GOATCOUNTER_CODE) {
  const s = document.createElement("script");
  s.async = true;
  s.src = "https://gc.zgo.at/count.js";
  s.dataset.goatcounter = `https://${GOATCOUNTER_CODE}.goatcounter.com/count`;
  document.head.appendChild(s);
}

// ------------------------------------------------------------------ data ---
// The day pickers start at the first day of real-time co-optimization (RTC+B, Dec 5, 2025). The data
// keep the days before it (the forecast models train on them); only the lists the pickers read are
// cut: the days lists of the index files below, and the pickers that build from other files call
// fromStart.
const SITE_START = "2025-12-05";
const fromStart = (days) => days.filter((d) => !(typeof d === "string" && /^\d{4}-\d\d-\d\d$/.test(d)) || d >= SITE_START);
const DAY_INDEXES = ["data/index.json", "data/forecast/index.json.gz", "data/storage/index.json.gz"];
function trimDays(url, obj) {
  if (!obj || !DAY_INDEXES.includes(url.split("?")[0])) return obj;
  if (Array.isArray(obj.days)) obj.days = fromStart(obj.days);
  else if (obj.days && typeof obj.days === "object") for (const k of Object.keys(obj.days)) obj.days[k] = fromStart(obj.days[k]);
  return obj;
}
const cache = new Map();
function getJSON(url) {
  if (cache.has(url)) return cache.get(url);
  const p = (async () => {
    const r = await fetch(url, { cache: "no-cache" });
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
      const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
      return trimDays(url, JSON.parse(await new Response(stream).text()));
    }
    return trimDays(url, JSON.parse(new TextDecoder().decode(buf)));
  })();
  cache.set(url, p);
  p.catch(() => cache.delete(url));
  return p;
}
const tryJSON = (url) => getJSON(url).catch(() => null);

// -------------------------------------------------------------- tooltip ---
function showTip(ev, html) {
  const t = $("tip");
  t.innerHTML = html; t.hidden = false;
  place(t, ev.clientX, ev.clientY);
}
function place(t, cx, cy) {
  const r = t.getBoundingClientRect();
  let left = cx + 14, top = cy + 14;
  if (left + r.width > window.innerWidth - 8) left = cx - r.width - 14;
  if (top + r.height > window.innerHeight - 8) top = cy - r.height - 14;
  t.style.left = Math.max(8, left) + "px"; t.style.top = Math.max(8, top) + "px";
}
function hideTip() { $("tip").hidden = true; }

// ---- pinning: a click on a chart freezes its readout and crosshair where you clicked.
// Clicking elsewhere on the chart moves the pin; the same spot or Esc clears it.
// Charts whose click already does something (picking an hour or a day) opt out with data-nopin.
const pins = new Map();   // svg -> { tip, marks, x, y }
function unpin(svg) {
  const p = pins.get(svg);
  if (!p) return;
  p.tip.remove(); p.marks.forEach((m) => m.remove());
  pins.delete(svg);
}
function clearPins() { [...pins.keys()].forEach(unpin); }
function pinAt(svg, ev) {
  const live = $("tip");
  if (live.hidden) return;
  const marks = [...svg.querySelectorAll(".crosshair")].filter((l) => l.style.display !== "none" && !l.classList.contains("pin-mark"))
    .map((l) => { const c = l.cloneNode(); c.classList.add("pin-mark"); c.style.display = ""; svg.appendChild(c); return c; });
  const tip = live.cloneNode(true);
  tip.removeAttribute("id"); tip.classList.add("tip-pinned"); tip.hidden = false;
  tip.insertAdjacentHTML("beforeend", `<p class="tip-pin-note">Pinned · click the same spot or press Esc to clear</p>`);
  document.body.appendChild(tip);
  // pinned readouts scroll with the page
  const r = live.getBoundingClientRect();
  tip.style.left = r.left + window.scrollX + "px"; tip.style.top = r.top + window.scrollY + "px";
  pins.set(svg, { tip, marks, x: ev.clientX, y: ev.clientY });
  hideTip();
}
function initPins() {
  document.addEventListener("click", (ev) => {
    const svg = ev.target.closest(".chart svg");
    if (!svg || svg.hasAttribute("data-nopin") || ev.target.closest("[data-nopin]")) return;
    const p = pins.get(svg);
    if (p && Math.hypot(ev.clientX - p.x, ev.clientY - p.y) < 8) { unpin(svg); return; }
    unpin(svg);
    // taps don't produce hover events, so replay one at the click point to fill the readout
    ev.target.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: ev.clientX, clientY: ev.clientY, pointerType: ev.pointerType || "mouse" }));
    pinAt(svg, ev);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") clearPins(); });
  // a chart that is redrawn takes its pin with it
  new MutationObserver(() => { for (const svg of pins.keys()) if (!svg.isConnected) unpin(svg); })
    .observe(document.querySelector("main"), { childList: true, subtree: true });
}

// ---------------------------------------------------------------- icons ---
// small line icons for the per-panel buttons (the button's title carries the words)
const ICON = {
  download: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.5v8M4.8 7.3 8 10.5l3.2-3.2M2.5 12.5h11"/></svg>`,
  link: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.6 9.4a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-1 1"/><path d="M9.4 6.6a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l1-1"/></svg>`,
  check: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5"/></svg>`,
};

// the icon buttons sit in a corner strip at the panel's top right, outside the heading row
function panelActions(panel) {
  let a = panel.querySelector(":scope > .panel-actions");
  if (!a) { a = Object.assign(document.createElement("div"), { className: "panel-actions" }); panel.prepend(a); }
  return a;
}

// ------------------------------------------------------------ downloads ---
// Each chart can register the data it plots: CX.setCSV(chartEl, header, rows, name).
const csvData = new WeakMap();
function setCSV(el, header, rows, name) { csvData.set(el, { header, rows, name }); }
const STYLE_PROPS = ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray", "stroke-opacity", "opacity",
  "font-family", "font-size", "font-weight", "font-variant-numeric", "display", "visibility"];
function inlined(svg) {
  const clone = svg.cloneNode(true);
  const src = [svg, ...svg.querySelectorAll("*")], dst = [clone, ...clone.querySelectorAll("*")];
  src.forEach((s, i) => {
    const cs = getComputedStyle(s);
    dst[i].setAttribute("style", STYLE_PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(";"));
  });
  clone.querySelectorAll(".pin-mark").forEach((n) => n.remove());
  return clone;
}
// a panel's name: its heading without the date/hour note
function panelName(panel) {
  const h = panel.querySelector("h2");
  if (!h) return "chart";
  return [...h.childNodes].filter((n) => !(n.classList && n.classList.contains("h-note"))).map((n) => n.textContent).join("").trim();
}
function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60); }

// One SVG for a panel: title, description, legend, every chart in it, and a source line.
function panelSVG(panel) {
  const title = (panel.querySelector("h2")?.textContent || "chart").trim().replace(/\s+/g, " ");
  const svgs = [...panel.querySelectorAll(".chart svg")].filter((s) => s.getBoundingClientRect().width > 0);
  const W = Math.max(600, ...svgs.map((s) => +s.getAttribute("viewBox").split(" ")[2]));
  const NS = "http://www.w3.org/2000/svg";
  const out = document.createElementNS(NS, "svg");
  const font = "IBM Plex Sans, Helvetica, Arial, sans-serif";
  const ink = css("--ink"), muted = css("--muted");
  let y = 28;
  const text = (x, yy, s, size, color, weight = 400) => {
    const t = document.createElementNS(NS, "text");
    t.setAttribute("x", x); t.setAttribute("y", yy); t.textContent = s;
    t.setAttribute("style", `font-family:${font};font-size:${size}px;fill:${color};font-weight:${weight}`);
    out.appendChild(t); return t;
  };
  text(16, y, title, 16, ink, 600);
  // the panel's description under the title, wrapped to the image width
  const note = (panel.querySelector(".panel-head .note")?.textContent || "").trim().replace(/\s+/g, " ");
  if (note) {
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.font = `12px ${font}`;
    let line = "";
    const lines = [];
    note.split(" ").forEach((word) => {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > W - 32) { lines.push(line); line = word; } else line = next;
    });
    if (line) lines.push(line);
    y += 6;
    lines.forEach((l) => { y += 16; text(16, y, l, 12, muted); });
  }
  y += 10;
  // legend: swatches and labels of the visible series
  const items = [...panel.querySelectorAll(".legend > *")].filter((b) => b.getAttribute("aria-pressed") !== "false")
    .map((b) => ({ color: getComputedStyle(b.querySelector(".sw") || b).backgroundColor, label: b.textContent.trim() })).filter((i) => i.label);
  if (items.length) {
    let x = 16; y += 16;
    items.forEach((it) => {
      const wEst = 18 + it.label.length * 6.4;
      if (x + wEst > W - 16) { x = 16; y += 18; }
      const r = document.createElementNS(NS, "rect");
      r.setAttribute("x", x); r.setAttribute("y", y - 9); r.setAttribute("width", 10); r.setAttribute("height", 10); r.setAttribute("rx", 2);
      r.setAttribute("style", `fill:${it.color}`); out.appendChild(r);
      text(x + 15, y, it.label, 12, muted);
      x += wEst + 14;
    });
  }
  y += 10;
  svgs.forEach((s) => {
    const [, , w, h] = s.getAttribute("viewBox").split(" ").map(Number);
    const c = inlined(s);
    c.setAttribute("x", 0); c.setAttribute("y", y); c.setAttribute("width", w); c.setAttribute("height", h);
    out.appendChild(c); y += h + 8;
  });
  y += 12;
  text(16, y, `${document.title} · ${location.href.split("#")[0]} · Source: ERCOT`, 11, muted);
  y += 12;
  out.setAttribute("xmlns", NS);
  out.setAttribute("viewBox", `0 0 ${W} ${y}`); out.setAttribute("width", W); out.setAttribute("height", y);
  const bg = document.createElementNS(NS, "rect");
  bg.setAttribute("width", "100%"); bg.setAttribute("height", "100%"); bg.setAttribute("style", `fill:${css("--surface")}`);
  out.insertBefore(bg, out.firstChild);
  return { svg: out, W, H: y, name: slug(panelName(panel)) };
}
function save(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function stamp() { return (location.hash.match(/date=([\d-]+)/) || [])[1] || new Date().toISOString().slice(0, 10); }
function downloadSVG(panel) {
  const p = panelSVG(panel);
  save(new Blob([new XMLSerializer().serializeToString(p.svg)], { type: "image/svg+xml" }), `${p.name}-${stamp()}.svg`);
}
function downloadPNG(panel) {
  const p = panelSVG(panel);
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(p.svg)], { type: "image/svg+xml" }));
  const img = new Image();
  img.onload = () => {
    const k = 2, c = document.createElement("canvas");
    c.width = p.W * k; c.height = p.H * k;
    const ctx = c.getContext("2d"); ctx.scale(k, k); ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    c.toBlob((b) => save(b, `${p.name}-${stamp()}.png`), "image/png");
  };
  img.src = url;
}
function downloadCSV(panel) {
  const parts = [...panel.querySelectorAll(".chart, [data-csv]")].map((el) => csvData.get(el)).filter(Boolean);
  if (!parts.length) return;
  const cell = (v) => (v == null ? "" : typeof v === "number" ? String(Math.round(v * 1e4) / 1e4) : /[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v);
  const text = parts.map((p) => (parts.length > 1 ? `# ${p.name}\n` : "") + [p.header, ...p.rows].map((r) => r.map(cell).join(",")).join("\n")).join("\n\n");
  save(new Blob([text + "\n"], { type: "text/csv" }), `${slug(panelName(panel))}-${stamp()}.csv`);
}
// a small Download menu at the top right of every panel that holds a chart (or a table marked
// data-csv, which offers its data only)
function addDownloads() {
  document.querySelectorAll("section.panel").forEach((panel) => {
    const chart = !!panel.querySelector(".chart");
    if ((!chart && !panel.querySelector("[data-csv]")) || panel.querySelector(".dl")) return;
    const box = document.createElement("details");
    box.className = "dl";
    box.innerHTML = `<summary class="icon-btn" aria-label="Download this ${chart ? "chart" : "table"}" title="Download this ${chart ? "chart" : "table"}">${ICON.download}</summary><div class="dl-menu">` +
      (chart ? `<button type="button" data-f="png">Image (PNG)</button><button type="button" data-f="svg">Vector (SVG)</button>` : "") +
      `<button type="button" data-f="csv">Data (CSV${chart ? "" : ", all columns"})</button></div>`;
    panelActions(panel).appendChild(box);
    box.addEventListener("toggle", () => {
      const has = [...panel.querySelectorAll(".chart, [data-csv]")].some((el) => csvData.get(el));
      box.querySelector('[data-f="csv"]').disabled = !has;
    });
    box.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-f]");
      if (!b) return;
      box.open = false;
      ({ png: downloadPNG, svg: downloadSVG, csv: downloadCSV })[b.dataset.f](panel);
    });
  });
  document.addEventListener("click", (e) => document.querySelectorAll("details.dl[open]").forEach((d) => { if (!d.contains(e.target)) d.open = false; }));
}

// ------------------------------------------------------------- links ---
// The address bar carries the view (#date=…&hour=…); it is rewritten in place, so the
// back button isn't filled with every click.
function readHash() { return Object.fromEntries(new URLSearchParams(location.hash.slice(1))); }
function writeHash(obj) {
  const q = new URLSearchParams(Object.entries(obj).filter(([, v]) => v != null && v !== "")).toString();
  // path and query kept explicitly: on the Unit page a <base> element points relative URLs elsewhere
  if (q !== location.hash.slice(1)) history.replaceState(null, "", location.pathname + location.search + "#" + q);
}
function initCopyLink() {
  const b = $("copy-link");
  if (!b) return;
  b.innerHTML = ICON.link; b.classList.add("icon-btn"); b.setAttribute("aria-label", b.title || "Copy link");
  b.onclick = () => copyText(b, location.href);
}

// ---------------------------------------------------------------- axes ---
// Tick labels carry only as many decimals as the tick spacing needs, so every axis reads the
// same way: $5, $10 (or $2.50, $3.00 when steps are under $1); 0.5, 1.0; 20%, 40%.
// kind: "num", "$", "%" or "$k" (money in one unit per axis: $500k, $1,000k or $0.5M, $1.0M).
function tickFormat(ticks, kind = "num") {
  const t = [...ticks].filter(Number.isFinite).sort((a, b) => a - b);
  let step = Infinity;
  for (let i = 1; i < t.length; i++) if (t[i] > t[i - 1]) step = Math.min(step, t[i] - t[i - 1]);
  if (!Number.isFinite(step)) step = Math.abs(t[0]) || 1;
  if (kind === "%") return d3.format(`.${d3.precisionFixed(step * 100)}%`);
  if (kind === "$k") {
    const top = d3.max(t, Math.abs) || 0;
    const [u, sfx] = top >= 1e9 ? [1e9, "B"] : top >= 1e6 ? [1e6, "M"] : top >= 1e3 ? [1e3, "k"] : [1, ""];
    const f = d3.format(`,.${d3.precisionFixed(step / u)}f`);
    return (v) => (v < 0 ? "\u2212" : "") + "$" + f(Math.abs(v) / u) + (v ? sfx : "");
  }
  const p = d3.precisionFixed(step);
  return d3.format(kind === "$" ? `$,.${p ? Math.max(2, p) : 0}f` : `,.${p}f`);
}
// the kind of a value formatter, read from how it prints 1 ("$1.00" -> "$", "100%" -> "%")
function fmtKind(f) { const s = f ? String(f(1)) : ""; return s.includes("%") ? "%" : s.includes("$") ? "$" : "num"; }
// fixes an axis's tick values (its own, or scale.ticks(n)) and labels them with tickFormat;
// abs labels mirrored axes (values below zero drawn downward) by size
function axisFmt(axis, n, kind = "num", abs = false) {
  const v = axis.tickValues() || axis.scale().ticks(n);
  const f = tickFormat(v, kind);
  return axis.tickValues(v).tickFormat(abs ? (x) => f(Math.abs(x)) : f);
}

// pages with <body data-panel-links> get a Copy link button on each panel instead of one in the
// header: the link carries the view plus the panel (p=<panel id>), and panelFromLink() scrolls there
// the button shows a check for a moment once the link is on the clipboard
async function copyText(b, text) {
  const was = b.innerHTML, title = b.title;
  try { await navigator.clipboard.writeText(text); b.innerHTML = ICON.check; b.title = "Link copied"; b.classList.add("copied"); }
  catch (e) { prompt("Copy this link", text); }
  setTimeout(() => { b.innerHTML = was; b.title = title; b.classList.remove("copied"); }, 1600);
}
function addPanelLinks() {
  if (!document.body.hasAttribute("data-panel-links")) return;
  document.querySelectorAll("section.panel[id]").forEach((panel) => {
    if (panel.querySelector(".panel-link")) return;
    const b = Object.assign(document.createElement("button"), { type: "button", className: "copy-link panel-link icon-btn", innerHTML: ICON.link,
      title: "Copy a link that opens this chart with the same day, hour and settings" });
    b.setAttribute("aria-label", "Copy link to this chart");
    panelActions(panel).appendChild(b);
    b.onclick = () => {
      const q = new URLSearchParams(location.hash.slice(1));
      q.set("p", panel.id);
      copyText(b, `${location.origin}${location.pathname}${location.search}#${q}`);
    };
  });
}
// the panel a copied link points at (read once, before the page rewrites the address bar)
const linkedPanel = new URLSearchParams(location.hash.slice(1)).get("p");
function panelFromLink() {
  const el = linkedPanel && document.getElementById(linkedPanel);
  if (el && !el.hidden) el.scrollIntoView({ block: "start" });
}

// ---------------------------------------------------------- find a unit ---
// A search box in every page's nav row that opens a unit's page, by resource name, settlement
// point, combined-cycle configuration, CDR plant name, another name it goes by, county, QSE (code or name),
// decision maker, owner, public buyer, or a company from unit_companies.csv (EIA-860 operator and plant
// name, web-search owner and developer). A hit found by anything but its name says what matched. The unit list
// (data/unit_index.json.gz, pipeline/unit_index.py) loads on first focus. The Unit page has its
// own picker and directory, so it gets no box here.
const TECH_SHORT = { nuclear: "Nuclear", coal: "Coal", combined_cycle: "Combined cycle", gas_steam: "Gas steam", combustion_turbine: "Combustion turbine", wind: "Wind", solar: "Solar", storage: "Battery storage ESR" };
const unitURL = (name) => `unit.html?unit=${encodeURIComponent(name)}`;
// rows of the unit index as objects, each with the lowercase text a search matches against
async function unitIndex() {
  const ui = await tryJSON("data/unit_index.json.gz");
  if (!ui) return null;
  const c = ui.columns;
  unitIndex.cdr = ui.cdr || "";
  return ui.rows.map((r) => {
    const u = Object.fromEntries(c.map((k, i) => [k, r[i]]));
    u.buyers = u.buyers || []; u.companies = u.companies || [];
    u.text = [u.unit, u.sp, ...(u.configs || []), u.plant, ...(u.aliases || []), u.county, u.qse, u.qse_name, u.dme, u.owner,
      ...u.buyers, ...u.companies.map((c) => c[0]), TECH_SHORT[u.tech]].filter(Boolean).join(" ").toLowerCase();
    return u;
  });
}
const COMPANY_ROLE = { operator: "Operator (EIA)", owner: "Owner (web search)", developer: "Developer (web search)", "plant name": "Plant (EIA)" };
// what a hit matched on, as "Label: value", when the query is not in the name, CDR plant name or other names
// the result row already shows; the field matching the most query words wins, in this order on a tie
function matchedOn(u, q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = [u.unit, u.plant, ...(u.aliases || [])].filter(Boolean).join(" ").toLowerCase();
  if (!words.length || words.every((w) => shown.includes(w))) return "";
  const fields = [["Buyer", u.buyers], ["QSE", [u.qse_name || u.qse, u.qse_name && u.qse]], ["Decides offers", [u.dme]], ["Owner (ERCOT)", [u.owner]],
    ...u.companies.map((c) => [COMPANY_ROLE[c[1]] || c[1], [c[0]]]), ["Configuration", u.configs || []], ["Settlement point", [u.sp]], ["County", [u.county]]];
  let best = null, n = 0;
  for (const [label, vals] of fields) for (const v of vals) {
    if (!v) continue;
    const k = words.filter((w) => !shown.includes(w) && v.toLowerCase().includes(w)).length;
    if (k > n) { best = `${label}: ${label === "QSE" && u.qse_name ? u.qse_name : v}`; n = k; }
  }
  return best || "";
}
// every word of the query must appear; names that start with the query come first
function findUnits(units, q, n = 8) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits = units.filter((u) => words.every((w) => u.text.includes(w)));
  const lq = q.trim().toLowerCase(), rank = (u) => (u.unit.toLowerCase() === lq ? 0 : u.unit.toLowerCase().startsWith(lq) ? 1 : 2);
  return hits.sort((a, b) => rank(a) - rank(b) || a.unit.localeCompare(b.unit)).slice(0, n);
}
function initUnitFind() {
  const row = document.querySelector(".nav-row");
  if (!row || $("unit-pick")) return;
  const box = document.createElement("div");
  box.className = "unit-find";
  box.innerHTML = `<input type="search" id="unit-find" placeholder="Unit, QSE, company, buyer" aria-label="Find a unit by name, plant, county, settlement point, QSE, decision maker, owner, operator, developer or buyer" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false" aria-controls="unit-find-list" aria-autocomplete="list">` +
    `<ul class="unit-find-list" id="unit-find-list" role="listbox" hidden></ul>`;
  row.appendChild(box);
  const input = box.querySelector("input"), list = box.querySelector("ul");
  let units = null, hits = [], at = -1;
  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); at = -1; };
  const mark = () => list.querySelectorAll("li").forEach((li, i) => li.setAttribute("aria-selected", String(i === at)));
  const show = () => {
    if (!units) { list.innerHTML = `<li class="unit-find-none">Loading units…</li>`; list.hidden = !input.value.trim(); return; }
    hits = findUnits(units, input.value);
    at = hits.length ? 0 : -1;
    let why;
    list.innerHTML = hits.length ? hits.map((u, i) => `<li role="option" id="unit-find-${i}"><a href="${unitURL(u.unit)}"><span class="unit-find-name">${esc(u.unit)}${u.plant || u.aliases?.length ? `<small>${esc([u.plant, ...(u.aliases || [])].filter(Boolean).join(" · "))}</small>` : ""}` +
      `${(why = matchedOn(u, input.value)) ? `<small class="unit-find-why">${esc(why)}</small>` : ""}</span>` +
      `<span class="unit-find-meta">${TECH_SHORT[u.tech] || esc(u.tech)}${u.mw ? ` · ${u.mw} MW` : ""}</span></a></li>`).join("")
      : `<li class="unit-find-none">No unit matches. <a href="unit.html">Browse all units</a></li>`;
    list.hidden = !input.value.trim();
    input.setAttribute("aria-expanded", String(!list.hidden));
    mark();
  };
  input.addEventListener("focus", async () => { if (!units) { units = (await unitIndex()) || []; if (document.activeElement === input) show(); } });
  input.addEventListener("input", show);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!hits.length) return;
      e.preventDefault();
      at = (at + (e.key === "ArrowDown" ? 1 : -1) + hits.length) % hits.length; mark();
      input.setAttribute("aria-activedescendant", `unit-find-${at}`);
    } else if (e.key === "Enter") {
      if (at >= 0 && hits[at]) { e.preventDefault(); location.href = unitURL(hits[at].unit); }
    } else if (e.key === "Escape") { close(); }
  });
  document.addEventListener("click", (e) => { if (!box.contains(e.target)) close(); });
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initUnitFind); else initUnitFind();

// ------------------------------------------------- days that failed checks ---
// Days with an error in data/validation.json (pipeline/validate.py) get a mark in the day picker
// and a warning under it while selected.  Pages fill and set #date themselves, so this watches
// the options and checks the value on each change, step click and hash change.
const FLAG_TEXT = [
  [/^base_point_thermal/, "ERCOT's 60-day report and its generation summary disagree on thermal output for this day. Fuel totals, nuclear especially, may read low."],
  [/^curve_wind/, "ERCOT's 60-day and 2-day reports disagree on wind offers for this day by more than the usual margin."],
];
async function initDayFlags() {
  const sel = document.getElementById("date");
  if (!sel) return;
  const v = await tryJSON("data/validation.json");
  const flagged = {};
  Object.entries((v && v.days) || {}).forEach(([d, r]) => {
    if (r.level !== "error") return;
    const msgs = (r.checks || []).filter((c) => c[1] === "error").map(([check, , detail]) =>
      (FLAG_TEXT.find(([re]) => re.test(check)) || [, `This day failed a data check: ${detail}`])[1]);
    flagged[d] = [...new Set(msgs)];
  });
  if (!Object.keys(flagged).length) return;
  const note = document.createElement("p");
  note.className = "day-flag";
  note.setAttribute("role", "status");
  note.hidden = true;
  (sel.closest(".date-step") || sel).after(note);
  const mark = () => {
    for (const o of sel.options) {
      if (flagged[o.value] && !o.dataset.flagged) { o.dataset.flagged = "1"; o.textContent += " ⚠ check failed"; }
    }
  };
  const show = () => {
    const m = flagged[sel.value];
    note.hidden = !m;
    if (m) note.innerHTML = `<strong>Data check failed.</strong> ${m.map(esc).join(" ")} Treat this day's numbers with care.`;
  };
  new MutationObserver(() => { mark(); show(); }).observe(sel, { childList: true });
  sel.addEventListener("change", show);
  document.addEventListener("click", (e) => { if (e.target.closest(".step")) setTimeout(show); });
  window.addEventListener("hashchange", () => setTimeout(show));
  mark(); show();
  setInterval(show, 1000);   // a page can also set the value directly, which fires no event
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initDayFlags); else initDayFlags();

function init() { initPins(); addDownloads(); addPanelLinks(); initCopyLink(); }

// a chart's one-line caption, with the method kept behind "How it's built" (a details element after it)
function setNote(el, caption, how) {
  if (!el) return;
  el.textContent = caption || "";
  let d = el.nextElementSibling;
  if (!(d && d.matches("details.how"))) {
    if (!how) return;
    d = document.createElement("details");
    d.className = "how";
    d.innerHTML = '<summary>How it\'s built</summary><p class="note"></p>';
    el.after(d);
  }
  d.hidden = !how;
  if (how) d.querySelector("p").textContent = how;
}

// ---- wind and solar curtailment by hour, one day ---------------------------------------
// Shared by Renewables ("Curtailment by hour, one day") and Real-time offers. `c` is
// curve_trends' "curt" key; its hourly rows already pick the 60-day disclosure where the day has
// it and the 2-day estimate otherwise. opts.hour marks the selected hour (the other hours are
// lighter) and opts.onPick(hour) makes a click pick the hour.
const CURT_TECHS = [
  { id: "wind", label: "Wind", color: "--c3" },
  { id: "solar", label: "Solar", color: "--c4" },
];
function drawCurtailDay(el, legendEl, noteEl, c, day, opts = {}) {
  const fmtMW = d3.format(",.0f"), fmtPct = d3.format(".0%");
  const fmtPrice = (v) => (v == null || isNaN(v) ? "–" : d3.format("$,.2f")(v));
  const heLabel = (h) => `HE ${String(h + 1).padStart(2, "0")}`;
  const sel = opts.hour == null ? null : opts.hour;
  if (legendEl) legendEl.innerHTML = CURT_TECHS.map((s) => `<span><span class="sw" style="background:var(${s.color})"></span>${s.label}</span>`).join("");
  const empty = (msg) => { el.innerHTML = `<p class="empty">${msg}</p>`; if (noteEl) noteEl.textContent = ""; };
  if (!c) return empty("No curtailment data yet. It is built by the data update workflow.");
  const ci = Object.fromEntries(c.hours.columns.map((k, i) => [k, i]));
  const rows = c.hours.rows.filter((r) => r[ci.date] === day);
  const byH = new Map(rows.map((r) => [r[ci.hour], r]));
  const by = CURT_TECHS.map((t) => d3.range(24).map((h) => { const r = byH.get(h); return r && r[ci[t.id]] != null ? { c: r[ci[t.id]], a: r[ci[t.id + "_avail"]] } : null; }));
  const src = rows.length ? rows[0][ci.src] : null;
  const srcName = { "60d": "60-day disclosure", "2d": "2-day reports, estimated" };
  if (!rows.length) return empty("No curtailment data for this day yet. The 2-day generation summary fills in recent days once the data update has fetched it.");
  if (noteEl) noteEl.textContent = `${day}${sel == null ? "" : ` · HE ${sel + 1}`} · ${srcName[src] || src}`;
  const hp = d3.range(24).map((h) => { const r = byH.get(h); return r ? r[ci.lambda] : null; });
  const w = Math.max(280, el.clientWidth || 600);
  const m = { t: 14, r: 16, b: 26, l: 64 }, H = 200;
  const x = d3.scaleBand().domain(d3.range(1, 25)).range([m.l, w - m.r]).paddingInner(0.15);
  const xc = d3.scaleLinear().domain([1, 24]).range([x(1) + x.bandwidth() / 2, x(24) + x.bandwidth() / 2]);
  const tot = d3.range(24).map((h) => d3.sum(by, (r) => (r[h] ? r[h].c : 0)));
  const y = d3.scaleLinear().domain([0, Math.max(100, d3.max(tot))]).nice().range([H - m.b, m.t]);
  const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${H}`);
  svg.append("g").attr("class", "gridline").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickSize(-(w - m.l - m.r)).tickFormat(""));
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickValues([1, 4, 8, 12, 16, 20, 24]).tickFormat((d) => "HE" + d).tickSizeOuter(0));
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(axisFmt(d3.axisLeft(y), 4).tickSizeOuter(0));
  svg.append("text").attr("class", "axis-title").attr("x", m.l).attr("y", 10).text("Curtailed MW, hourly average");
  d3.range(24).forEach((h) => {
    let acc = 0;
    CURT_TECHS.forEach((t, j) => {
      const r = by[j][h];
      if (!r || !r.c) return;
      svg.append("rect").attr("x", x(h + 1)).attr("width", x.bandwidth()).attr("y", y(acc + r.c)).attr("height", Math.max(0, y(acc) - y(acc + r.c) - 1))
        .attr("fill", css(t.color)).attr("opacity", sel == null || h === sel ? 1 : 0.5);   // the selected hour stands out
      acc += r.c;
    });
  });
  const cell = (j, h) => { const r = by[j][h]; return r ? `${fmtMW(r.c)} MW <span class="muted">of ${fmtMW(r.a)} (${r.a > 0 ? fmtPct(r.c / r.a) : "–"})</span>` : "–"; };
  const tip = (h) => `<h4>${heLabel(h)}</h4>System lambda: ${fmtPrice(hp[h])}<table>` +
    CURT_TECHS.map((t, j) => `<tr><td><span class="sw" style="background:var(${t.color})"></span></td><td>${t.label}</td><td class="n">${cell(j, h)}</td></tr>`).join("") + "</table>" +
    (src === "2d" ? `<p class="tip-body">Estimated from the 2-day reports until this day's 60-day disclosure is out.</p>` : "");
  const hourAt = (ev) => Math.max(0, Math.min(23, Math.round(xc.invert(d3.pointer(ev)[0])) - 1));
  const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", H - m.b).style("display", "none");
  const hit = svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", w - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
    .on("pointermove", (ev) => { const i = hourAt(ev); cross.style("display", null).attr("x1", xc(i + 1)).attr("x2", xc(i + 1)); showTip(ev, tip(i)); })
    .on("pointerleave", () => { cross.style("display", "none"); hideTip(); });
  if (opts.onPick) {
    svg.attr("data-nopin", "");   // a click here picks the hour
    hit.style("cursor", "pointer").on("click", (ev) => opts.onPick(hourAt(ev)));
  }
  el.replaceChildren(svg.node());
  const cols = ["hour_ending", "System lambda mean"];
  CURT_TECHS.forEach((t) => cols.push(`${t.label} curtailed MW (${src})`, `${t.label} available MW (${src})`));
  setCSV(el, cols, d3.range(24).map((h) => [h + 1, hp[h], ...CURT_TECHS.flatMap((t, j) => { const r = by[j][h]; return [r ? r.c : null, r ? r.a : null]; })]),
    `Wind and solar curtailment ${day}`);
}

window.CX = { fromStart, SITE_START, setNote, getJSON, tryJSON, showTip, hideTip, clearPins, setCSV, readHash, writeHash, init, panelFromLink, css, esc, tickFormat, fmtKind, axisFmt, unitIndex, findUnits, matchedOn, drawCurtailDay };
})();

/* Shared helpers for both pages: data loading, tooltips that pin on click, chart downloads
   (PNG, SVG, CSV) and links that reopen the current view. Exposed as window.CX. */
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
const cache = new Map();
function getJSON(url) {
  if (cache.has(url)) return cache.get(url);
  const p = (async () => {
    const r = await fetch(url, { cache: "no-cache" });
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
      const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
      return JSON.parse(await new Response(stream).text());
    }
    return JSON.parse(new TextDecoder().decode(buf));
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

// One SVG for a panel: title, legend, every chart in it, and a source line.
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
  const parts = [...panel.querySelectorAll(".chart")].map((el) => csvData.get(el)).filter(Boolean);
  if (!parts.length) return;
  const cell = (v) => (v == null ? "" : typeof v === "number" ? String(Math.round(v * 1e4) / 1e4) : /[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v);
  const text = parts.map((p) => (parts.length > 1 ? `# ${p.name}\n` : "") + [p.header, ...p.rows].map((r) => r.map(cell).join(",")).join("\n")).join("\n\n");
  save(new Blob([text + "\n"], { type: "text/csv" }), `${slug(panelName(panel))}-${stamp()}.csv`);
}
// a small Download menu at the top right of every panel that holds a chart
function addDownloads() {
  document.querySelectorAll("section.panel").forEach((panel) => {
    if (!panel.querySelector(".chart") || panel.querySelector(".dl")) return;
    const head = panel.querySelector(".panel-head");
    const box = document.createElement("details");
    box.className = "dl";
    box.innerHTML = `<summary aria-label="Download this chart">Download</summary><div class="dl-menu">
      <button type="button" data-f="png">Image (PNG)</button><button type="button" data-f="svg">Vector (SVG)</button><button type="button" data-f="csv">Data (CSV)</button></div>`;
    (head.querySelector(".panel-tools") || head.appendChild(Object.assign(document.createElement("div"), { className: "panel-tools" }))).appendChild(box);
    box.addEventListener("toggle", () => {
      const has = [...panel.querySelectorAll(".chart")].some((el) => csvData.get(el));
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
  if (q !== location.hash.slice(1)) history.replaceState(null, "", "#" + q);
}
function initCopyLink() {
  const b = $("copy-link");
  if (!b) return;
  b.onclick = async () => {
    try { await navigator.clipboard.writeText(location.href); b.textContent = "Link copied"; }
    catch (e) { prompt("Copy this link", location.href); }
    setTimeout(() => (b.textContent = "Copy link"), 1600);
  };
}

function init() { initPins(); addDownloads(); initCopyLink(); }

window.CX = { getJSON, tryJSON, showTip, hideTip, clearPins, setCSV, readHash, writeHash, init, css, esc };
})();

/* Ask the data: sends a question to the "ercot-ask" Worker (ask-worker/, address in ask.json,
   written by .github/workflows/ask-server.yml) and shows the answer. The Worker answers Markdown
   that marks the changes it cites as {{event:<id>}} and units as {{unit:<NAME>}}; each change
   becomes a link to its day on the Unit page, and a table under the answer gives each one a
   Chart button (event-chart.js), the same as on What's changing. A conversation keeps its last
   few turns so a follow-up can say "that unit". The passcode is kept in this browser only. */
(() => {
"use strict";

const { esc } = window.CX;
const $ = (id) => document.getElementById(id);
const PASS_KEY = "ask-passcode";
const fmtDay = d3.utcFormat("%b %-d, %Y");
const EXAMPLES = [
  "What did Outpost Solar offer during Winter Storm Fern, and why was it dispatched to zero?",
  "Which combined cycles shut down after a long run in August, and what were prices when they did?",
  "How much wind was curtailed in the first week of August, by day?",
  "How did Comanche Peak run in the cheapest hours of last month?",
];
const S = { url: null, history: [] };

const store = {
  get: () => { try { return localStorage.getItem(PASS_KEY) || ""; } catch (e) { return ""; } },
  set: (v) => { try { v ? localStorage.setItem(PASS_KEY, v) : localStorage.removeItem(PASS_KEY); } catch (e) { /* private window */ } },
};
function say(text, err) { $("msg").textContent = text || ""; $("msg").className = "ask-msg" + (err ? " err" : ""); }

// ------------------------------------------------------------- Markdown ---
// a small subset: paragraphs, - and 1. lists, pipe tables, **bold**, `code`; references become links
function inline(s, refs) {
  const keep = [];
  s = s.replace(/\{\{(event|unit):([^}]+)\}\}/g, (m, k, v) => { keep.push([k, v.trim()]); return `\u0000${keep.length - 1}\u0000`; });
  s = esc(s).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => {
    const [k, v] = keep[+i];
    if (k === "unit") return /^[A-Za-z0-9_.\-]{1,48}$/.test(v) ? `<a href="unit.html?unit=${encodeURIComponent(v)}">${esc(v)}</a>` : esc(v);
    const e = refs.get(v);
    if (!e) return "";
    return ` <a href="${window.EVC.href(e)}" title="${esc(e.title)}">(${esc(fmtDay(new Date(e.date + "T00:00:00Z")))})</a>`;
  });
}
function markdown(md, refs) {
  const lines = String(md || "").replace(/\r/g, "").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (/^\s*\|/.test(l)) {                       // table
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
      const [h, ...rest] = body;
      out.push(`<div class="units-wrap"><table class="data"><thead><tr>${cells(h).map((c) => `<th class="t">${inline(c, refs)}</th>`).join("")}</tr></thead><tbody>` +
        rest.map((r) => `<tr>${cells(r).map((c) => `<td class="t">${inline(c, refs)}</td>`).join("")}</tr>`).join("") + "</tbody></table></div>");
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {           // list
      const ordered = /^\s*\d+\./.test(l), items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ""));
      out.push(`<${ordered ? "ol" : "ul"}>${items.map((x) => `<li>${inline(x, refs)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    if (/^#{1,4}\s/.test(l)) { out.push(`<p><b>${inline(l.replace(/^#+\s*/, ""), refs)}</b></p>`); i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(\||[-*]\s|\d+\.\s|#{1,4}\s)/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(" "), refs)}</p>`);
  }
  return out.join("");
}

// ---------------------------------------------------------------- turns ---
function showTurn(q, d) {
  const refs = new Map((d.events || []).map((e) => [e.id, e]));
  const el = document.createElement("section");
  el.className = "panel turn";
  const changes = d.events && d.events.length
    ? `<h3>Changes in this answer</h3><div class="units-wrap"><table class="data"><thead><tr><th class="t">Date</th><th class="t">Unit</th><th class="t">Change</th></tr></thead><tbody>` +
      d.events.map((e) => `<tr data-id="${esc(e.id)}"><td class="t"><a href="${window.EVC.href(e)}">${e.date}</a></td><td class="t">${esc(e.unit)}</td>` +
        `<td class="t ev"><b>${esc((d.kinds || {})[e.kind] || e.kind)}</b><br>${esc(e.title)}${window.EVC.button(e)}</td></tr>`).join("") + "</tbody></table></div>"
    : "";
  el.innerHTML = `<p class="q">${esc(q)}</p><div class="a">${markdown(d.answer, refs)}</div>${changes}` +
    `<p class="meta">${d.usd != null ? `Cost about $${d.usd.toFixed(2)}` : ""}${d.remaining != null ? ` · ${d.remaining} question${d.remaining === 1 ? "" : "s"} left today` : ""}</p>`;
  el.addEventListener("click", (ev) => {
    const b = ev.target.closest(".evc-btn"); if (!b) return;
    const tr = b.closest("tr"), e = refs.get(tr.dataset.id);
    if (e) window.EVC.toggle(tr, e, tr.children.length, d.kinds);
  });
  $("turns").prepend(el);
}

async function ask(q) {
  const pass = $("pass").value.trim() || store.get();
  if (!pass) { say("Enter the passcode.", true); $("pass-row").hidden = false; $("pass").focus(); return; }
  $("go").disabled = true;
  say("Looking through the data… this usually takes 20 to 60 seconds.");
  try {
    const r = await fetch(`${S.url}/ask`, { method: "POST", headers: { "Content-Type": "application/json", "X-Ask-Passcode": pass },
      body: JSON.stringify({ question: q, history: S.history.slice(-3) }) });
    const d = await r.json().catch(() => ({ ok: false, msg: "The answer server didn't answer properly." }));
    if (r.status === 401) { store.set(""); $("pass-row").hidden = false; }
    if (!d.ok) { say(d.msg || "That didn't work. Try again in a minute.", true); return; }
    store.set(pass); $("pass-row").hidden = true;
    S.history.push({ q, a: d.answer });
    showTurn(q, d);
    $("q").value = ""; $("new").hidden = false;
    say("");
  } catch (e) {
    say("Couldn't reach the answer server. Try again in a minute.", true);
  } finally {
    $("go").disabled = false;
  }
}

async function boot() {
  window.CX.init();
  $("examples").innerHTML = EXAMPLES.map((x) => `<button type="button">${esc(x)}</button>`).join("");
  $("examples").addEventListener("click", (ev) => { const b = ev.target.closest("button"); if (b) { $("q").value = b.textContent; $("q").focus(); } });
  $("pass-row").hidden = !!store.get();
  $("new").onclick = () => { S.history = []; $("turns").innerHTML = ""; $("new").hidden = true; say(""); };
  try { const r = await fetch("ask.json", { cache: "no-store" }); S.url = r.ok ? (await r.json()).url : null; } catch (e) { S.url = null; }
  if (!S.url) { $("go").disabled = true; say("The answer server isn't set up yet."); return; }
  S.url = S.url.replace(/\/$/, "");
  $("ask-form").addEventListener("submit", (ev) => { ev.preventDefault(); const q = $("q").value.trim(); if (q) ask(q); });
  $("q").addEventListener("keydown", (ev) => { if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) $("ask-form").requestSubmit(); });
}
boot();
})();

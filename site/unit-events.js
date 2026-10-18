/* Unit page: the unit's recent changes and the subscribe box, for the unit unit.js has
   selected. Reads data/events.json.gz (pipeline/events.py), the one list every detector's
   findings go into; the per-unit Atom feed it writes is linked from the panel.

   Email sign-up goes through Buttondown's public embed endpoint, so the page needs no server:
   the form posts the address with a tag for the unit (a real form post, which Buttondown's
   docs require so its answer page can run its CAPTCHA), Buttondown sends its confirmation
   email and keeps the list, and the send step (pipeline/notify.py) later targets each unit's
   tag. NEWSLETTER is the Buttondown username; until it is set the panel offers the feed only. */
(() => {
"use strict";

const NEWSLETTER = "currenttech.energy";   // Buttondown username (buttondown.com/currenttech.energy)
const SUBSCRIBE_URL = (n) => `https://buttondown.com/api/emails/embed-subscribe/${n}`;
const SHOW = 12;                // major changes shown before "Show all"
const { tryJSON, esc } = window.CX;
const $ = (id) => document.getElementById(id);
const trainOf = (u) => { const m = /^(.*_CC\d+)_/.exec(u); return m ? m[1] : u; };
const fmt$ = (v) => (v == null || isNaN(v) ? "–" : (v < 0 ? "−" : "") + "$" + d3.format(",.0f")(Math.abs(v)));

const S = { unit: null, E: null, all: false };
let loaded = null;

// events for a unit: its own, a configuration's (bidding changes are per configuration), or
// a plant event that lists it (wind and solar events are per plant)
function eventsFor(name) {
  return S.E.events.filter((e) => e.unit === name || trainOf(e.unit) === name || (e.units || []).includes(name));
}

function numbers(e) {
  const k = e.kind;
  if (k === "cutoff") return `${fmt$(e.before_usd)} → ${fmt$(e.after_usd)} for the day`;
  if (k === "bidding") return e.field === "rel" ? `${fmt$(e.before)} → ${fmt$(e.after)}/MWh` : `${d3.format(".0%")(e.before)} → ${d3.format(".0%")(e.after)}`;
  if (k.startsWith("shutdown")) return `loss of staying on ${fmt$(e.value)}` + (e.award != null ? `, award over ${d3.format(".0%")(e.award)} of the window` : "");
  if (k.startsWith("renew_")) return e.before != null && e.after != null ? `${fmt$(e.before)} → ${fmt$(e.after)}/MWh` : "";
  if (k.startsWith("outage")) return `${e.value} days`;
  return "";
}

function drawTable() {
  const evs = eventsFor(S.unit), shown = S.all ? evs : evs.filter((e) => e.major).slice(0, SHOW);
  const nMajor = evs.filter((e) => e.major).length;
  $("changes-count").textContent = evs.length ? `${nMajor} notable, ${evs.length} in all` : "";
  $("changes-more").hidden = S.all || shown.length >= evs.length;
  $("changes-more").textContent = `Show all ${evs.length}`;
  if (!evs.length) { $("changes-table").innerHTML = `<p class="empty">No changes found for this unit in the loaded data.</p>`; return; }
  $("changes-table").innerHTML = `<table class="data"><thead><tr><th class="t">Date</th><th class="t">Change</th><th class="t">Detail</th><th class="t">Numbers</th><th class="t">Found</th></tr></thead><tbody>` +
    shown.map((e) => `<tr class="${e.major ? "" : "minor"}"><td class="t">${e.date}</td><td class="t">${esc(S.E.kinds[e.kind] || e.kind)}</td><td class="t ev">${esc(e.title)}` +
      (e.units && e.units.length > 1 ? ` <span class="tag">${e.units.length} units</span>` : "") + `</td><td class="t">${esc(numbers(e))}</td><td class="t">${e.seen}</td></tr>`).join("") + "</tbody></table>";
}

// ---- subscribe ---------------------------------------------------------------------------
function msg(text, keep) {
  const el = $("sub-msg"); el.hidden = !text; el.innerHTML = text || "";
  if (text && !keep) setTimeout(() => { if (el.innerHTML === text) el.hidden = true; }, 8000);
}
function drawSubscribe() {
  const feed = `data/feeds/units/${encodeURIComponent(S.unit)}.xml`;
  const feedLink = `<a class="btn" href="${feed}" title="Atom feed of this unit's changes, for a feed reader">Feed</a>`;
  if (!NEWSLETTER) {
    $("sub-tools").innerHTML = feedLink;
    msg("Email alerts are not switched on yet. The feed carries the same changes for a feed reader.", true);
    return;
  }
  // a real form post, as Buttondown's docs require (not fetch): its answer page handles the
  // CAPTCHA and validation, and opens in a new tab so this page stays
  $("sub-tools").innerHTML = `<form class="sub-form" id="sub-form" method="post" action="${SUBSCRIBE_URL(NEWSLETTER)}" target="_blank">` +
    `<input type="hidden" name="embed" value="1"><input type="hidden" name="tag" value="unit:${esc(S.unit)}">` +
    `<input type="email" name="email" id="sub-email" placeholder="you@example.com" required aria-label="Email address">` +
    `<button type="submit">Subscribe to ${esc(S.unit)}</button></form>${feedLink}`;
  msg("");
  $("sub-form").addEventListener("submit", () => {
    const email = $("sub-email").value.trim();
    msg(`Buttondown opens in a new tab to confirm. Check <b>${esc(email)}</b> for its confirmation email; once confirmed, you get one email on any day the update finds a change for ${esc(S.unit)}.`, true);
  });
}

// ---- page --------------------------------------------------------------------------------
function draw(ev) {
  const u = ev && ev.detail ? ev.detail : window.UNIT;
  if (!u) return;
  S.unit = u.name; S.all = false;
  if (!loaded) loaded = tryJSON("data/events.json.gz").then((e) => { S.E = e; });
  loaded.then(() => {
    if (S.unit !== u.name) return;
    $("changes-panel").hidden = !S.E;
    if (!S.E) return;
    drawTable(); drawSubscribe();
  });
}
$("changes-more").addEventListener("click", () => { S.all = true; drawTable(); });
window.addEventListener("unitchange", draw);
})();

/* Unit follows for the ERCOT bid explorer.

   The site is static, so this small Worker is the one place that holds who follows which unit:
     POST /follow        email + unit from the Unit page's form: saves a pending follow and emails
                         a confirmation link (Resend). Answers JSON for the page to show.
     GET  /confirm?t=    the confirmation link: a page with a button; POST to the same URL makes
                         the follow active (mail scanners open links on their own, so a GET
                         alone never confirms).
     GET  /unsubscribe?t=[&all=1]   a page with a button; POST to the same URL removes the follow
                         (or every follow of that address with all=1). Mail clients' one-click
                         unsubscribe (List-Unsubscribe-Post) POSTs here too.
   The daily send (pipeline/notify.py) reads active follows straight from the D1 database
   through Cloudflare's API, so there is no endpoint that lists addresses.

   Abuse limits: a hidden "website" field bots fill in, units that have a page on the site only,
   at most SIGNUPS_PER_IP sign-ups per IP address per day, at most CONFIRMS_PER_EMAIL
   confirmation emails per email address per day, and at most one confirmation email per follow
   per RESEND_AFTER_MIN. */

const SIGNUPS_PER_IP = 20;
const CONFIRMS_PER_EMAIL = 10;        // confirmation emails one address can be sent in a day
const UNIT_CACHE_S = 86400;           // how long a unit page lookup is cached
const RESEND_AFTER_MIN = 10;
const PENDING_DAYS = 14;              // unconfirmed follows older than this are dropped
const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,255}\.[a-z]{2,}$/i;
const UNIT_RE = /^[A-Za-z0-9_.\-]{1,48}$/;

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS",
               "Access-Control-Allow-Headers": "Content-Type" };

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
const now = () => new Date().toISOString();
const token = () => crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");

function page(env, title, body, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
body{font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;color:#1d2433;background:#fff}
@media (prefers-color-scheme:dark){body{color:#e6e8ee;background:#14171d}a{color:#8ab4ff}}
h1{font-size:22px}button{font:inherit;padding:8px 14px;margin:4px 8px 4px 0;border-radius:6px;border:1px solid #888;background:transparent;color:inherit;cursor:pointer}
</style></head><body><h1>${esc(title)}</h1>${body}<p><a href="${esc(env.SITE_URL)}">ERCOT bid explorer</a></p></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function sendEmail(env, to, subject, html, text) {
  const r = await fetch(`${env.RESEND_API || "https://api.resend.com"}/emails`, {   // RESEND_API: a local stand-in for tests
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.FROM, to: [to], subject, html, text }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

// Is `unit` a unit with a page on the site?  Every unit in the Units directory has a share page at
// /unit/<NAME>.html (pipeline/share_pages.py); the answer is cached at the edge for a day.
async function knownUnit(env, unit) {
  if (env.SKIP_UNIT_CHECK === "1") return true;   // local tests only
  const r = await fetch(`${env.SITE_URL}unit/${encodeURIComponent(unit)}.html`,
                        { method: "HEAD", cf: { cacheTtl: UNIT_CACHE_S, cacheEverything: true } });
  if (r.status >= 500) throw new Error(`unit page lookup ${r.status}`);   // the site is down: "try again later"
  return r.ok;
}

async function follow(req, env) {
  const f = await req.formData();
  if (f.get("website")) return json({ ok: true, msg: "Thanks." });     // honeypot: say nothing useful
  const email = String(f.get("email") || "").trim().toLowerCase();
  const unit = String(f.get("unit") || "").trim();
  if (!EMAIL_RE.test(email)) return json({ ok: false, msg: "That doesn't look like an email address." }, 400);
  if (!UNIT_RE.test(unit) || !(await knownUnit(env, unit))) return json({ ok: false, msg: "Unknown unit." }, 400);

  const ip = req.headers.get("CF-Connecting-IP") || "?";
  const day = now().slice(0, 10);
  const { n } = (await env.DB.prepare("INSERT INTO signups (ip, day, n) VALUES (?, ?, 1) ON CONFLICT (ip, day) DO UPDATE SET n = n + 1 RETURNING n")
    .bind(ip, day).first()) || { n: 1 };
  if (n > SIGNUPS_PER_IP) return json({ ok: false, msg: "Too many sign-ups from here today. Try again tomorrow." }, 429);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM signups WHERE day < ?").bind(day),
    env.DB.prepare("DELETE FROM confirms WHERE day < ?").bind(day),
    env.DB.prepare("DELETE FROM follows WHERE status = 'pending' AND created < ?").bind(new Date(Date.now() - PENDING_DAYS * 864e5).toISOString()),
  ]);

  const row = await env.DB.prepare("SELECT status, token, created FROM follows WHERE email = ? AND unit = ?").bind(email, unit).first();
  if (row && row.status === "active") return json({ ok: true, msg: `${email} already follows ${unit}.` });
  if (row && Date.now() - Date.parse(row.created) < RESEND_AFTER_MIN * 6e4)
    return json({ ok: true, msg: `A confirmation email is already on its way to ${email}. Open the link in it to start.` });

  const { m } = (await env.DB.prepare("INSERT INTO confirms (email, day, n) VALUES (?, ?, 1) ON CONFLICT (email, day) DO UPDATE SET n = n + 1 RETURNING n AS m")
    .bind(email, day).first()) || { m: 1 };
  if (m > CONFIRMS_PER_EMAIL) return json({ ok: false, msg: `Too many confirmation emails for ${email} today. Try again tomorrow.` }, 429);

  const t = row ? row.token : token();
  if (row) await env.DB.prepare("UPDATE follows SET created = ? WHERE email = ? AND unit = ?").bind(now(), email, unit).run();
  else await env.DB.prepare("INSERT INTO follows (email, unit, token, created) VALUES (?, ?, ?, ?)").bind(email, unit, t, now()).run();

  const base = new URL(req.url).origin;
  const link = `${base}/confirm?t=${t}`;
  try {
    await sendEmail(env, email, `Confirm: follow ${unit} on the ERCOT bid explorer`,
      `<p>Someone, hopefully you, asked to follow <b>${esc(unit)}</b> on the ERCOT bid explorer.</p>
<p><a href="${link}">Confirm and start following ${esc(unit)}</a></p>
<p>You'll get at most one email a day, only on days the update finds a change for a unit you follow. If this wasn't you, ignore this email and nothing happens.</p>`,
      `Someone, hopefully you, asked to follow ${unit} on the ERCOT bid explorer.\n\nConfirm: ${link}\n\nYou'll get at most one email a day, only on days the update finds a change for a unit you follow. If this wasn't you, ignore this email and nothing happens.`);
  } catch (e) {
    if (!row) await env.DB.prepare("DELETE FROM follows WHERE token = ?").bind(t).run();
    console.log(String(e));
    return json({ ok: false, msg: "The confirmation email couldn't be sent. Please try again later." }, 502);
  }
  return json({ ok: true, msg: `Check ${email} for a confirmation email. Once you open the link, you get one email on any day the update finds a change for ${unit}.` });
}

async function confirm(req, url, env) {
  const t = url.searchParams.get("t") || "";
  const row = await env.DB.prepare("SELECT email, unit, status FROM follows WHERE token = ?").bind(t).first();
  if (!row) return page(env, "Link expired", "<p>This confirmation link is no longer valid. Sign up again from the unit's page.</p>", 404);
  if (row.status !== "active" && req.method !== "POST")
    // a page with a button, not an instant confirm: mail scanners open links on their own
    return page(env, `Follow ${row.unit}?`,
      `<p>Start emails to <b>${esc(row.email)}</b> about changes to <b>${esc(row.unit)}</b>?</p>` +
      `<form method="post" action="/confirm?t=${esc(t)}"><button>Confirm</button></form>`);
  if (row.status !== "active") await env.DB.prepare("UPDATE follows SET status = 'active', confirmed = ? WHERE token = ?").bind(now(), t).run();
  const unitUrl = `${env.SITE_URL}unit.html?unit=${encodeURIComponent(row.unit)}`;
  return page(env, `Following ${row.unit}`,
    `<p><b>${esc(row.email)}</b> now follows <a href="${esc(unitUrl)}">${esc(row.unit)}</a>. You'll get at most one email a day, only on days the update finds a change for a unit you follow. Every email has an unsubscribe link.</p>`);
}

async function unsubscribe(req, url, env) {
  const t = url.searchParams.get("t") || "";
  const all = url.searchParams.get("all") === "1";
  const row = await env.DB.prepare("SELECT email, unit FROM follows WHERE token = ?").bind(t).first();
  if (!row) return page(env, "Already unsubscribed", "<p>There's nothing left to unsubscribe for this link.</p>");
  if (req.method === "POST") {
    if (all) await env.DB.prepare("DELETE FROM follows WHERE email = ?").bind(row.email).run();
    else await env.DB.prepare("DELETE FROM follows WHERE token = ?").bind(t).run();
    return page(env, "Unsubscribed", all ? `<p><b>${esc(row.email)}</b> no longer follows any units.</p>`
                                         : `<p><b>${esc(row.email)}</b> no longer follows ${esc(row.unit)}.</p>`);
  }
  // a page with buttons, not an instant unsubscribe: mail scanners open links on their own
  const units = (await env.DB.prepare("SELECT unit FROM follows WHERE email = ? AND status = 'active' ORDER BY unit").bind(row.email).all()).results.map((r) => r.unit);
  const one = `<form method="post" action="/unsubscribe?t=${esc(t)}" style="display:inline"><button>Stop following ${esc(row.unit)}</button></form>`;
  const every = `<form method="post" action="/unsubscribe?t=${esc(t)}&amp;all=1" style="display:inline"><button>Stop all emails</button></form>`;
  return page(env, "Unsubscribe", `<p><b>${esc(row.email)}</b> follows ${units.map(esc).join(", ") || esc(row.unit)}.</p><p>${all ? every : one + every}</p>`);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      if (url.pathname === "/follow" && req.method === "POST") return await follow(req, env);
      if (url.pathname === "/confirm" && (req.method === "GET" || req.method === "POST")) return await confirm(req, url, env);
      if (url.pathname === "/unsubscribe" && (req.method === "GET" || req.method === "POST")) return await unsubscribe(req, url, env);
      if (url.pathname === "/") return page(env, "ERCOT bid explorer follows", "<p>Follow a unit from its page on the ERCOT bid explorer.</p>");
      return new Response("Not found", { status: 404 });
    } catch (e) {
      console.log(String(e && e.stack || e));
      return url.pathname === "/follow" ? json({ ok: false, msg: "Something went wrong. Please try again later." }, 500)
                                        : page(env, "Something went wrong", "<p>Please try again later.</p>", 500);
    }
  },
};

/* "Ask the data": the Worker behind site/ask.html.

     POST /ask   {question, history?: [{q, a}]} with the passcode in X-Ask-Passcode. Runs Claude
                 with the read-only tools in tools.js over the site's published data and answers
                 JSON {answer, events, units, usd, remaining}. The answer is Markdown; it marks the
                 changes it cites as {{event:<id>}} and units as {{unit:<NAME>}}, and only
                 references a tool returned this question are kept (the page turns them into links
                 and charts with site/event-chart.js).
     GET  /log   the last questions, answers, tools used and cost; owner passcode only.

   Limits: a passcode (ASK_PASSCODE; ASK_OWNER_PASSCODE is also accepted and skips the
   per-visitor count), PER_VISITOR_PER_DAY questions per IP per UTC day, DAILY_USD and
   MONTHLY_USD of spend (counted here from each response's tokens; the Anthropic Console spend
   limit on the key's workspace is the hard ceiling), QUESTION_USD and MAX_ROUNDS per question.
   The Worker never calls ERCOT: every tool reads files the site already publishes. */

import Anthropic from "@anthropic-ai/sdk";
import { TOOLS, runTool, eventKinds } from "./tools.js";
import { SYSTEM } from "./prompt.js";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
               "Access-Control-Allow-Headers": "Content-Type, X-Ask-Passcode" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
const MAX_Q = 1500;          // characters in a question
const MAX_HISTORY = 3;       // earlier turns sent back with a follow-up
const MAX_TOOL_TEXT = 24000; // characters of one tool result passed to the model

// $ per million tokens: [input, output, cache read, cache write (5-minute)]
const PRICE = { "claude-opus-5-5": [4, 20, 0.2, 5], "claude-opus-5": [5, 25, 0.5, 6.25], "claude-opus-4-8": [5, 25, 0.5, 6.25] };
function cost(model, u) {
  const p = PRICE[model] || PRICE["claude-opus-5"];
  return ((u.input_tokens || 0) * p[0] + (u.output_tokens || 0) * p[1] + (u.cache_read_input_tokens || 0) * p[2] + (u.cache_creation_input_tokens || 0) * p[3]) / 1e6;
}

function same(a, b) {   // constant-time string compare
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function hashIP(ip) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("ercot-ask:" + ip));
  return [...new Uint8Array(b)].slice(0, 6).map((x) => x.toString(16).padStart(2, "0")).join("");
}
const today = () => new Date().toISOString().slice(0, 10);

async function spentToday(env) { const r = await env.DB.prepare("SELECT usd FROM spend WHERE day = ?").bind(today()).first(); return r ? r.usd : 0; }
async function spentMonth(env) { const r = await env.DB.prepare("SELECT COALESCE(SUM(usd), 0) AS usd FROM spend WHERE day LIKE ?").bind(today().slice(0, 7) + "%").first(); return r ? r.usd : 0; }
async function addSpend(env, usd) {
  if (usd > 0) await env.DB.prepare("INSERT INTO spend (day, usd) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET usd = usd + excluded.usd").bind(today(), usd).run();
}

async function ask(req, env) {
  const pass = req.headers.get("X-Ask-Passcode") || "";
  const owner = same(pass, env.ASK_OWNER_PASSCODE || "");
  if (!owner && !same(pass, env.ASK_PASSCODE || "")) return json({ ok: false, msg: "Wrong or missing passcode." }, 401);
  let body;
  try { body = await req.json(); } catch (e) { return json({ ok: false, msg: "Send JSON." }, 400); }
  const question = String(body.question || "").trim();
  if (!question) return json({ ok: false, msg: "Ask a question." }, 400);
  if (question.length > MAX_Q) return json({ ok: false, msg: `Keep questions under ${MAX_Q} characters.` }, 400);

  const ip = req.headers.get("CF-Connecting-IP") || "?";
  const who = owner ? "owner" : await hashIP(ip);
  const perDay = +env.PER_VISITOR_PER_DAY || 5;
  if ((await spentToday(env)) >= +env.DAILY_USD) return json({ ok: false, msg: "The day's question budget is used up. Try again tomorrow (UTC)." }, 429);
  if ((await spentMonth(env)) >= +env.MONTHLY_USD) return json({ ok: false, msg: "This month's question budget is used up." }, 429);
  let remaining = null;
  if (!owner) {
    const { n } = (await env.DB.prepare("INSERT INTO asks (who, day, n) VALUES (?, ?, 1) ON CONFLICT (who, day) DO UPDATE SET n = n + 1 RETURNING n")
      .bind(who, today()).first()) || { n: 1 };
    if (n > perDay) return json({ ok: false, msg: `That's ${perDay} questions today, the most one visitor can ask. Try again tomorrow (UTC).` }, 429);
    remaining = perDay - n;
    await env.DB.prepare("DELETE FROM asks WHERE day < ?").bind(today()).run();
  }

  // earlier turns, as plain text (their references were already resolved on the page)
  const messages = [];
  for (const t of (Array.isArray(body.history) ? body.history : []).slice(-MAX_HISTORY)) {
    if (!t || !t.q || !t.a) continue;
    messages.push({ role: "user", content: String(t.q).slice(0, MAX_Q) }, { role: "assistant", content: String(t.a).slice(0, 6000) });
  }
  messages.push({ role: "user", content: question });

  // ANTHROPIC_BASE_URL: a local stand-in for tests only
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}) });
  const t0 = Date.now(), used = [], seenEvents = new Map(), seenUnits = new Set();
  const tok = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let usd = 0, rounds = 0, stop = "", answer = "", model = env.MODEL;
  try {
    while (rounds < +env.MAX_ROUNDS) {
      rounds++;
      const last = rounds === +env.MAX_ROUNDS || usd >= +env.QUESTION_USD;
      const res = await client.beta.messages.create({
        model: env.MODEL,
        max_tokens: 8000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",                 // a declined request is re-run on the recommended fallback model
        output_config: { effort: env.EFFORT || "medium" },
        cache_control: { type: "ephemeral" }, // caches the growing prefix across the tool loop
        system: SYSTEM,
        tools: TOOLS,
        tool_choice: last ? { type: "none" } : { type: "auto" },
        messages,
      });
      model = res.model;
      for (const k of Object.keys(tok)) tok[k] += res.usage[k] || 0;
      usd += cost(res.model, res.usage);
      stop = res.stop_reason;
      if (stop === "refusal") { answer = "I can't help with that one. I answer questions about ERCOT offers, operations and prices from this site's data."; break; }
      if (stop !== "tool_use") {
        answer = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
        if (stop === "max_tokens") answer += "\n\n(The answer was cut off at its length limit.)";
        break;
      }
      messages.push({ role: "assistant", content: res.content });
      const calls = res.content.filter((b) => b.type === "tool_use");
      const results = await Promise.all(calls.map(async (c) => {
        used.push([c.name, c.input]);
        const r = await runTool(env, c.name, c.input);
        (r.events || []).forEach((e) => seenEvents.set(e.id, e));
        (r.units || []).forEach((u) => seenUnits.add(u));
        const text = r.text.length > MAX_TOOL_TEXT ? r.text.slice(0, MAX_TOOL_TEXT) + "\n(cut: ask for a shorter range)" : r.text;
        return { type: "tool_result", tool_use_id: c.id, content: text, ...(r.error ? { is_error: true } : {}) };
      }));
      messages.push({ role: "user", content: results });
    }
  } catch (e) {
    await addSpend(env, usd);
    const msg = e instanceof Anthropic.RateLimitError ? "The model is busy right now. Try again in a minute."
      : e instanceof Anthropic.AuthenticationError ? "The site's API key isn't working."
      : e instanceof Anthropic.APIError ? `The model service returned an error (${e.status}). Try again shortly.` : "Something went wrong answering that.";
    await log(env, { who, question, answer: `ERROR: ${e.message}`, used, model, rounds, tok, usd, ms: Date.now() - t0, stop: "error" });
    return json({ ok: false, msg }, 502);
  }
  await addSpend(env, usd);
  if (!answer) answer = "I ran out of steps before finishing. Try a narrower question (one unit, a shorter date range).";

  // keep only references a tool returned; unknown ones become plain text
  const cited = new Map();
  answer = answer.replace(/\{\{event:([^}]+)\}\}/g, (m, id) => { const e = seenEvents.get(id.trim()); if (!e) return ""; cited.set(e.id, e); return m; });
  const kinds = await eventKinds(env);
  await log(env, { who, question, answer, used, model, rounds, tok, usd, ms: Date.now() - t0, stop });
  return json({ ok: true, answer, events: [...cited.values()], kinds, units: [...seenUnits], usd: Math.round(usd * 1000) / 1000, remaining });
}

async function log(env, { who, question, answer, used, model, rounds, tok, usd, ms, stop }) {
  try {
    await env.DB.prepare("INSERT INTO log (ts, who, question, answer, tools, model, rounds, in_tok, out_tok, cache_read, cache_write, usd, ms, stop) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(new Date().toISOString(), who, question, answer, JSON.stringify(used), model, rounds, tok.input_tokens, tok.output_tokens,
        tok.cache_read_input_tokens, tok.cache_creation_input_tokens, Math.round(usd * 10000) / 10000, ms, stop).run();
  } catch (e) { /* a failed log write must not lose the answer */ }
}

async function showLog(req, env) {
  const u = new URL(req.url);
  if (!same(req.headers.get("X-Ask-Passcode") || "", env.ASK_OWNER_PASSCODE || "")) return json({ ok: false, msg: "Owner passcode needed." }, 401);
  const n = Math.min(+u.searchParams.get("n") || 50, 500);
  const rows = (await env.DB.prepare("SELECT * FROM log ORDER BY ts DESC LIMIT ?").bind(n).all()).results;
  const spend = (await env.DB.prepare("SELECT * FROM spend ORDER BY day DESC LIMIT 40").all()).results;
  return json({ ok: true, rows, spend });
}

export default {
  async fetch(req, env) {
    const path = new URL(req.url).pathname;
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (path === "/ask" && req.method === "POST") return ask(req, env);
    if (path === "/log" && req.method === "GET") return showLog(req, env);
    if (path === "/") return json({ ok: true, service: "ERCOT bid explorer: Ask the data" });
    return json({ ok: false, msg: "Not found." }, 404);
  },
};

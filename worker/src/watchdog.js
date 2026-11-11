/* Update watchdog: starts the twice-daily "Update ERCOT data" run on time and emails the owner
   when one hasn't succeeded.

   GitHub starts scheduled workflows late under load, sometimes many hours late, and sometimes
   not at all (November 2026: 5-10 hours late most days). Cloudflare's cron triggers fire on time,
   so this Worker's trigger (every 15 minutes, wrangler.toml) does the scheduling instead:

     - once a slot's start time has passed (Central time, SLOTS), and no run of that slot has
       succeeded or is under way today, it starts one through GitHub's workflow_dispatch API with
       the slot as an input (at most MAX_DISPATCHES a day per slot: the start and one retry);
     - when a slot still hasn't succeeded ALERT_AFTER_MIN after its start and no run of it is under
       way, or GitHub refuses a dispatch (an expired token, say), it emails OWNER_EMAIL once that day.

   update.yml names each run after its slot ("Update ERCOT data (morning)"), so the runs GitHub's
   own backup crons start count too, and its "when" job skips a slot run that another run has
   already done.  A run "did" its slot when its `update` job succeeded (a skipped run's own
   conclusion is success too, so the run's conclusion alone isn't enough).

   Needs the Worker secrets GH_DISPATCH_TOKEN (a fine-grained GitHub token with Actions: read and
   write on this repository only) and OWNER_EMAIL; without the token it does nothing.  State (how
   many times a slot was started today, whether the owner was emailed) is in the `watchdog` table
   of the D1 database. */

const SLOTS = [
  // ERCOT posts the 2-day reports by about 04:50 Central and the 60-day SCED and DAM disclosures
  // by about 06:05; the day-ahead market results (tomorrow's prices) by about 13:30.
  { slot: "morning", at: 6 * 60 + 30 },      // 06:30 Central (05:30 Mountain)
  { slot: "afternoon", at: 13 * 60 + 45 },   // 13:45 Central (12:45 Mountain)
];
const MAX_DISPATCHES = 2;          // the start and one retry after a failed run
const ALERT_AFTER_MIN = 180;       // a normal run takes 30-80 minutes
const WORKFLOW = "update.yml";
const TITLE = "Update ERCOT data";

const pad = (n) => String(n).padStart(2, "0");

// The date (YYYY-MM-DD) and minutes past midnight of `d` in time zone `tz`.
export function local(d, tz = "America/Chicago") {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) };
}

const mountain = (d) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", hour: "numeric", minute: "2-digit", month: "short", day: "numeric" }).format(d) + " MT";
const hhmm = (min) => { const h = Math.floor(min / 60), m = min % 60; return `${h % 12 || 12}:${pad(m)} ${h < 12 ? "AM" : "PM"}`; };

async function gh(env, path, init = {}) {
  const r = await fetch(`${env.GITHUB_API || "https://api.github.com"}/repos/${env.REPO}${path}`, {   // GITHUB_API: a local stand-in for tests
    ...init,
    headers: { Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`, Accept: "application/vnd.github+json",
               "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "ercot-follows-watchdog", ...(init.headers || {}) },
  });
  if (!r.ok) throw new Error(`GitHub ${init.method || "GET"} ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
}

// Today's runs (Central date) of the slot, newest first, each with `did`: its update job succeeded.
async function slotRuns(env, slot, today, now) {
  const since = new Date(now.getTime() - 2 * 864e5).toISOString().slice(0, 10);
  const { workflow_runs: all } = await gh(env, `/actions/workflows/${WORKFLOW}/runs?per_page=100&created=%3E%3D${since}`);
  const runs = all.filter((r) => r.display_title === `${TITLE} (${slot})` && local(new Date(r.created_at)).day === today);
  for (const r of runs) {
    r.did = false;
    if (r.status === "completed" && r.conclusion === "success") {
      const { jobs } = await gh(env, `/actions/runs/${r.id}/jobs?per_page=50`);
      r.did = jobs.some((j) => j.name === "update" && j.conclusion === "success");
    }
  }
  return runs;
}

async function state(env, day, slot) {
  await env.DB.prepare("INSERT INTO watchdog (day, slot) VALUES (?, ?) ON CONFLICT (day, slot) DO NOTHING").bind(day, slot).run();
  return env.DB.prepare("SELECT dispatches, alerted, error FROM watchdog WHERE day = ? AND slot = ?").bind(day, slot).first();
}

async function checkSlot(env, { slot, at }, now, sendEmail) {
  const { day, min } = local(now);
  if (min < at) return `${slot}: not due until ${hhmm(at)} Central`;
  const st = await state(env, day, slot);
  const save = (fields) => {
    const keys = Object.keys(fields);
    return env.DB.prepare(`UPDATE watchdog SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE day = ? AND slot = ?`)
      .bind(...keys.map((k) => fields[k]), day, slot).run();
  };

  let runs = [], note, going = false;   // going: a run of the slot is under way, or was just started
  try {
    runs = await slotRuns(env, slot, day, now);
    if (runs.some((r) => r.did)) return `${slot}: done`;
    if (runs.some((r) => r.status !== "completed")) { going = true; note = `${slot}: a run is under way`; }
    else if (st.dispatches < MAX_DISPATCHES) {
      await gh(env, `/actions/workflows/${WORKFLOW}/dispatches`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref: env.BRANCH || "main", inputs: { slot } }),
      });
      st.dispatches += 1;
      going = true;
      await save({ dispatches: st.dispatches, last_dispatch: now.toISOString(), error: null });
      note = `${slot}: started run ${st.dispatches} of ${MAX_DISPATCHES}`;
    } else note = `${slot}: ${MAX_DISPATCHES} runs started today and none succeeded`;
  } catch (e) {
    st.error = String(e && e.message || e);
    await save({ error: st.error });
    note = `${slot}: ${st.error}`;
  }

  // late: overdue with nothing under way, so an update that is merely running late (or was just
  // started, say on the day the watchdog is deployed) doesn't send a false alarm
  const late = min >= at + ALERT_AFTER_MIN && !going;
  if (!st.alerted && (late || st.error) && env.OWNER_EMAIL) {
    const why = st.error ? `The watchdog couldn't check or start it: ${st.error}`
                         : `It was due at ${hhmm(at)} Central (${hhmm(at - 60)} MT) and hasn't succeeded ${ALERT_AFTER_MIN / 60} hours later.`;
    const list = runs.length ? runs.map((r) => `${mountain(new Date(r.created_at))}: ${r.event}, ${r.conclusion || r.status} ${r.html_url}`)
                             : ["No run of this slot today."];
    const actions = `https://github.com/${env.REPO}/actions/workflows/${WORKFLOW}`;
    const text = `The ${slot} ERCOT data update for ${day} hasn't succeeded as of ${mountain(now)}.\n\n${why}\n\n` +
      `Runs today:\n${list.join("\n")}\n\nThe watchdog started ${st.dispatches} of at most ${MAX_DISPATCHES}. ` +
      `Start one by hand with "Run workflow" on ${actions} (slot: ${slot}).`;
    const html = `<p>The <b>${slot}</b> ERCOT data update for ${day} hasn't succeeded as of ${mountain(now)}.</p><p>${why.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>` +
      `<p>Runs today:</p><ul>${runs.length ? runs.map((r) => `<li>${mountain(new Date(r.created_at))}: ${r.event}, ${r.conclusion || r.status}, <a href="${r.html_url}">run</a></li>`).join("") : "<li>No run of this slot today.</li>"}</ul>` +
      `<p>The watchdog started ${st.dispatches} of at most ${MAX_DISPATCHES}. Start one by hand with <i>Run workflow</i> on <a href="${actions}">the workflow page</a> (slot: ${slot}).</p>`;
    try {
      await sendEmail(env, env.OWNER_EMAIL, `ERCOT ${slot} update missing for ${day}`, html, text);
      await save({ alerted: now.toISOString() });
      note += "; emailed the owner";
    } catch (e) { note += `; the alert email failed: ${e && e.message || e}`; }
  }
  return note;
}

export async function watchdog(env, now, sendEmail) {
  if (!env.GH_DISPATCH_TOKEN || !env.REPO) { console.log("watchdog: no GH_DISPATCH_TOKEN or REPO, skipping"); return []; }
  const notes = [];
  for (const s of SLOTS) notes.push(await checkSlot(env, s, now, sendEmail));
  await env.DB.prepare("DELETE FROM watchdog WHERE day < ?").bind(local(new Date(now.getTime() - 30 * 864e5)).day).run();
  console.log("watchdog: " + notes.join(" | "));
  return notes;
}

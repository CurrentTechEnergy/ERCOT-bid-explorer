/* The read-only tools "Ask the data" gives the model. Every tool reads files the site already
   publishes (SITE_URL data/...), never ERCOT and never the raw store, and does its own arithmetic
   (sums, means, counts) so the model quotes numbers rather than computing them.

   Sources (all written by the pipeline; see README):
     data/unit_index.json.gz       every unit: technology, size, plant, county, zone, group, QSE, owner, buyers
     data/groups_60d.json.gz       timescale group labels
     data/series/index.json.gz     which months and units the hourly series cover
     data/series/YYYY-MM/<tech>.json.gz   hourly per unit: HSL, base point, output, offer prices, award, DA price; RT price per node
     data/summary_prices.json.gz   hourly real-time hub and load-zone prices and lambda
     data/dam_hubs.json.gz         hourly day-ahead hub and load-zone prices
     data/events.json.gz           every change the site's detectors found (the What's changing feed)

   Each tool returns { text, events?, units? }: text goes back to the model; events and units are
   what the answer may link to (index.js keeps only references a tool returned). */

const MAX_HOURLY_DAYS = 7;
const MAX_DAILY_DAYS = 92;
const MAX_EVENTS = 40;
const THERMAL = ["nuclear", "coal", "combined_cycle", "gas_steam", "combustion_turbine"];
const TECHS = [...THERMAL, "wind", "solar", "storage", "hydro", "other"];
const HUB = { SOUTH: "HB_SOUTH", NORTH: "HB_NORTH", WEST: "HB_WEST", HOUSTON: "HB_HOUSTON", PAN: "HB_PAN" };
const DAY = 864e5;

// ------------------------------------------------------------------ files ---
const memo = new Map();       // per isolate: url -> {t, promise}
const MEMO_MS = 10 * 60e3;
async function getJSON(env, path) {
  const url = new URL(path, env.SITE_URL).href;
  const hit = memo.get(url);
  if (hit && Date.now() - hit.t < MEMO_MS) return hit.p;
  const p = (async () => {
    const r = await fetch(url, { cf: { cacheTtl: 600, cacheEverything: true } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    // Pages serves .json.gz as gzip bytes with no Content-Encoding, so unzip here
    const body = path.endsWith(".gz") ? r.body.pipeThrough(new DecompressionStream("gzip")) : r.body;
    return JSON.parse(await new Response(body).text());
  })();
  memo.set(url, { t: Date.now(), p });
  if (memo.size > 40) memo.delete(memo.keys().next().value);
  p.catch(() => memo.delete(url));
  return p;
}

const r1 = (v) => (v == null ? "" : Math.round(v * 10) / 10);
const t1 = (v) => (v == null || Number.isNaN(v) ? "n/a" : Math.round(v * 10) / 10);     // in sentences: say n/a, not blank
const t2 = (v) => (v == null || Number.isNaN(v) ? "n/a" : Math.round(v * 100) / 100);
const r2 = (v) => (v == null ? "" : Math.round(v * 100) / 100);
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const addDays = (d, n) => iso(Date.parse(d + "T00:00:00Z") + n * DAY);
const datesBetween = (a, b) => { const out = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };
const trainOf = (u) => { const m = /^(.*_CC\d+)_/.exec(u); return m ? m[1] : u; };
const isDate = (s) => typeof s === "string" && /^\d{4}-\d\d-\d\d$/.test(s);
const mean = (xs) => { const v = xs.filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const sum = (xs) => { const v = xs.filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
const csv = (rows) => rows.map((r) => r.join(",")).join("\n");

async function unitIndex(env) {
  const ui = await getJSON(env, "data/unit_index.json.gz");
  if (!ui) return [];
  if (!ui._rows) ui._rows = ui.rows.map((r) => Object.fromEntries(ui.columns.map((k, i) => [k, r[i]])));
  return ui._rows;
}

// clip a requested range to what the series cover, and say so
function clip(idx, from, to) {
  const first = idx.dates[0], last = idx.dates[idx.dates.length - 1];
  const notes = [];
  if (!isDate(from) || !isDate(to)) throw new Error("from and to must be dates as YYYY-MM-DD");
  if (from > to) [from, to] = [to, from];
  if (to < first || from > last) throw new Error(`no hourly unit data in that range: the series run from ${first} to ${last}`);
  if (from < first) { notes.push(`starts ${first} (the series begin then)`); from = first; }
  if (to > last) { notes.push(`ends ${last} (the latest day with unit data; ERCOT publishes unit data 60 days after the day)`); to = last; }
  return { from, to, notes };
}

// series units behind a name: a unit, a CC train's configurations, a plant's units (by settlement point)
function seriesUnits(idx, name) {
  if (idx.units[name]) return [name];
  const n = name.toUpperCase();
  const out = Object.keys(idx.units).filter((u) => trainOf(u) === n || u.startsWith(n + "_") || idx.units[u][1] === n);
  return out;
}

async function monthFiles(env, idx, tech, dates) {
  const months = [...new Set(dates.map((d) => d.slice(0, 7)))].filter((m) => idx.months.includes(m));
  const files = await Promise.all(months.map((m) => getJSON(env, `data/series/${m}/${tech}.json.gz`)));
  const at = new Map();
  files.forEach((f) => f && f.dates.forEach((d, i) => at.set(d, [f, i])));
  return at;
}
const take = (a, i, h) => (a ? a[i * 24 + h] ?? null : null);

// hourly values for a set of units: [{d, h, hsl, bp, out, off, off_bp, award, rt, da}] (MW summed;
// offers HSL-weighted; prices from the first unit with one)
async function unitRows(env, idx, names, dates) {
  const techs = [...new Set(names.map((n) => idx.units[n][0]))];
  const byTech = Object.fromEntries(await Promise.all(techs.map(async (t) => [t, await monthFiles(env, idx, t, dates)])));
  const rows = [];
  for (const d of dates) {
    for (let h = 0; h < 24; h++) {
      const r = { d, h, hsl: null, bp: null, out: null, award: null, directed: null, off: null, off_bp: null, rt: null, da: null };
      let w = 0, wv = 0, wb = 0, wvb = 0, k = 0, plain = 0, kb = 0, plainb = 0;
      for (const n of names) {
        const x = byTech[idx.units[n][0]].get(d);
        if (!x) continue;
        const [f, i] = x, u = f.units[n];
        if (!u) continue;
        const H = take(u.hsl, i, h), B = take(u.bp, i, h), O = take(u.out, i, h), A = take(u.award, i, h), Dr = take(u.directed, i, h);
        const F = take(u.off_first, i, h), FB = take(u.off_bp, i, h);
        if (H != null) r.hsl = (r.hsl || 0) + H;
        if (B != null) r.bp = (r.bp || 0) + B;
        if (O != null) r.out = (r.out || 0) + O;
        if (A != null) r.award = (r.award || 0) + A;
        if (Dr != null) r.directed = (r.directed || 0) + Dr;
        if (F != null) { w += H || 0; wv += (H || 0) * F; k++; plain += F; }
        if (FB != null) { wb += H || 0; wvb += (H || 0) * FB; kb++; plainb += FB; }
        const sp = idx.units[n][1];
        if (r.rt == null && sp && f.rt && f.rt[sp]) r.rt = take(f.rt[sp], i, h);
        if (r.da == null) r.da = take(u.da, i, h);
      }
      r.off = k ? (w > 0 ? wv / w : plain / k) : null;
      r.off_bp = kb ? (wb > 0 ? wvb / wb : plainb / kb) : null;
      rows.push(r);
    }
  }
  return rows;
}

async function hubPrices(env, point, dates) {
  const [rt, dam] = await Promise.all([getJSON(env, "data/summary_prices.json.gz"), getJSON(env, "data/dam_hubs.json.gz")]);
  return dates.map((d) => {
    const p = rt && rt[d], q = dam && dam.days && dam.days[d];
    const r = point === "lambda" ? p && p.lambda : p && (p.spp || {})[point];
    return { d, rt: r || null, da: (point !== "lambda" && q && q[point]) || null };
  });
}

// ------------------------------------------------------------------ tools ---
export const TOOLS = [
  {
    name: "find_units",
    description: "Search ERCOT generation and storage resources by resource name, plant name, other names, county, QSE or decision maker, owner/operator/developer, or a public power buyer. Returns up to 12 matches with technology, size (MW), plant, county, load zone, settlement point, timescale group (how often a thermal unit shuts down), QSE, decision-making entity, owner and buyers. Use it first to turn a plant or company name into resource names for the other tools.",
    input_schema: { type: "object", properties: {
      query: { type: "string", description: "Words to match, e.g. 'Outpost', 'Comanche Peak', 'Vistra', 'Hormel'" },
      tech: { type: "string", enum: TECHS, description: "Optional technology filter" },
    }, required: ["query"], additionalProperties: false },
  },
  {
    name: "unit_hours",
    description: "Hourly operations, offers and prices for one unit, a combined-cycle train (e.g. BASTEN_CC1, summing its configurations) or a plant's units, from ERCOT's 60-day SCED and DAM disclosures (so the latest day is about 60 days ago). Ranges of up to 7 days come back hourly (hour ending 1-24, Central time); longer ranges (up to 92 days) come back as daily totals and means. Fields: hsl = available MW (high sustained limit), bp = dispatched MW (SCED base point), out = metered output MW, curt = hsl - bp for wind and solar, offer = first price on the submitted offer curve ($/MWh; for wind and solar the price of its whole offer, for thermal usually the price at minimum output), offer_bp = price the curve puts on the dispatched MW, award = day-ahead energy award MW, rt = real-time price at its node, da = day-ahead price at its node, hub_rt = real-time price at its zone's hub. Also returns totals over the range.",
    input_schema: { type: "object", properties: {
      unit: { type: "string", description: "Resource name, CC train or settlement point from find_units" },
      from: { type: "string", description: "First operating day, YYYY-MM-DD" },
      to: { type: "string", description: "Last operating day, YYYY-MM-DD" },
    }, required: ["unit", "from", "to"], additionalProperties: false },
  },
  {
    name: "fleet_days",
    description: "One technology's whole fleet, summed: available (HSL), dispatched (base point) and metered output MW, curtailed MW (HSL - base point, wind and solar), day-ahead award MW, units online, plus the real-time and day-ahead South/North/West/Houston hub prices. Up to 3 days hourly, or up to 31 days as daily totals (MWh) and means. Heavy for wind, solar and storage: ask for the shortest range that answers the question.",
    input_schema: { type: "object", properties: {
      tech: { type: "string", enum: TECHS },
      from: { type: "string", description: "YYYY-MM-DD" },
      to: { type: "string", description: "YYYY-MM-DD" },
    }, required: ["tech", "from", "to"], additionalProperties: false },
  },
  {
    name: "prices",
    description: "Real-time (hourly mean of 15-minute settlement point prices) and day-ahead hourly prices at ERCOT hubs and load zones (HB_NORTH, HB_SOUTH, HB_WEST, HB_HOUSTON, HB_PAN, HB_BUSAVG, HB_HUBAVG, LZ_*), and real-time system lambda ('lambda'). These run to a few days ago, later than the unit data. Up to 7 days hourly; longer (up to 92 days) as daily mean, min, max and hours at or below $0.",
    input_schema: { type: "object", properties: {
      points: { type: "array", items: { type: "string" }, description: "Up to 4 points, e.g. ['HB_SOUTH','lambda']" },
      from: { type: "string", description: "YYYY-MM-DD" },
      to: { type: "string", description: "YYYY-MM-DD" },
    }, required: ["points", "from", "to"], additionalProperties: false },
  },
  {
    name: "changes",
    description: "Changes the site's detectors found (the What's changing feed, 2019 on): shutdowns after a long run or despite a day-ahead award, timescale group changes, bidding shifts, turn-off point moves, outages, new units and batteries, decision-maker or QSE changes, wind/solar offer floors, formulas and episodes, day-ahead offer changes, and fleet median offer shifts. Filter by unit (resource, train or plant name), technology, kind and dates. Returns up to 40, newest first, each with an id. Cite a change in the answer as {{event:<id>}}.",
    input_schema: { type: "object", properties: {
      unit: { type: "string" }, tech: { type: "string", enum: TECHS },
      kind: { type: "string", description: "One kind code, e.g. shutdown_new, shutdown_award, group, bidding, turnoff, outage_start, outage_end, renew_episode, renew_floor_new, dam_priced_out, fuel" },
      from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD" },
      notable_only: { type: "boolean", description: "Only the changes the detectors rate as large" },
    }, required: [], additionalProperties: false },
  },
];

async function find_units(env, { query, tech }) {
  const [rows, g] = await Promise.all([unitIndex(env), getJSON(env, "data/groups_60d.json.gz")]);
  const label = Object.fromEntries(((g && g.groups) || []).map((x) => [x[0], x[1]]));
  const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) throw new Error("query is empty");
  const scored = [];
  for (const u of rows) {
    if (tech && u.tech !== tech) continue;
    const name = [u.unit, u.plant, ...(u.aliases || []), ...(u.configs || [])].filter(Boolean).join(" ").toLowerCase();
    const other = [u.sp, u.county, u.qse, u.qse_name, u.dme, u.owner, ...(u.buyers || []), ...((u.companies || []).map((c) => c[0]))].filter(Boolean).join(" ").toLowerCase();
    let s = 0;
    for (const w of words) { if (name.includes(w)) s += 3; else if (other.includes(w)) s += 1; else { s = -1; break; } }
    if (s > 0) scored.push([s + (u.mw || 0) / 1e5, u]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const hits = scored.slice(0, 12).map(([, u]) => u);
  if (!hits.length) return { text: `No unit matches "${query}".` };
  const text = csv([["unit", "tech", "mw", "plant", "county", "zone", "settlement_point", "group", "qse", "decision_maker", "owner", "buyers"],
    ...hits.map((u) => [u.unit, u.tech, u.mw, u.plant || "", u.county || "", u.zone || "", u.sp || "", label[u.group] || u.group || "", u.qse_name || u.qse || "", u.dme || "", u.owner || "", (u.buyers || []).join("; ")].map((v) => String(v).replace(/,/g, " ")))])
    + (scored.length > 12 ? `\n(${scored.length - 12} more matches; narrow the query)` : "");
  return { text, units: hits.map((u) => u.unit) };
}

async function unit_hours(env, { unit, from, to }) {
  const idx = await getJSON(env, "data/series/index.json.gz");
  if (!idx) throw new Error("the hourly unit series aren't built yet");
  const names = seriesUnits(idx, String(unit || "").trim());
  if (!names.length) throw new Error(`no hourly series for "${unit}"; use find_units for the resource name`);
  const c = clip(idx, from, to);
  let dates = datesBetween(c.from, c.to);
  if (dates.length > MAX_DAILY_DAYS) { dates = dates.slice(-MAX_DAILY_DAYS); c.notes.push(`cut to the last ${MAX_DAILY_DAYS} days`); }
  const tech = idx.units[names[0]][0], renew = tech === "wind" || tech === "solar";
  const rows = await unitRows(env, idx, names, dates);
  const ui = (await unitIndex(env)).find((u) => u.unit === names[0] || u.unit === trainOf(names[0]) || (u.configs || []).includes(names[0])) || {};
  const hub = HUB[ui.zone] || "HB_BUSAVG";
  const hp = await hubPrices(env, hub, dates);
  rows.forEach((r) => { const p = hp.find((x) => x.d === r.d); r.hub = p && p.rt ? p.rt[r.h] ?? null : null; r.curt = renew && r.hsl != null && r.bp != null ? Math.max(r.hsl - r.bp, 0) : null; });
  const mw = names.reduce((a, n) => a + (idx.units[n][2] || 0), 0);
  const head = `${unit}: ${names.length > 1 ? `${names.length} series units (${names.join(", ")})` : names[0]}, ${tech}, ${Math.round(mw)} MW, hub ${hub}. ${c.from} to ${c.to}${c.notes.length ? " (" + c.notes.join("; ") + ")" : ""}.`;
  const online = rows.filter((r) => (r.bp || 0) > 0.5 || (r.out || 0) > 0.5);
  const tot = `Totals over the range: output ${t1(sum(rows.map((r) => r.out)))} MWh, dispatched ${t1(sum(rows.map((r) => r.bp)))} MWh` +
    (renew ? `, curtailed ${t1(sum(rows.map((r) => r.curt)))} MWh` : "") +
    `, day-ahead award ${t1(sum(rows.map((r) => r.award)))} MWh, online ${online.length} of ${rows.length} hours, mean offer $${t2(mean(rows.map((r) => r.off)))}, ` +
    `mean RT at node $${t2(mean(rows.map((r) => r.rt)))}, output-weighted RT at node $${t2(sum(rows.map((r) => (r.out > 0 && r.rt != null ? r.out * r.rt : null))) / (sum(rows.filter((r) => r.rt != null).map((r) => Math.max(r.out || 0, 0))) || NaN))}, ` +
    `hours with RT at node <= $0: ${rows.filter((r) => r.rt != null && r.rt <= 0).length}.`;
  let body;
  if (dates.length <= MAX_HOURLY_DAYS) {
    body = csv([["date", "he", "hsl", "bp", "out", ...(renew ? ["curt"] : []), "offer", "offer_bp", "award", "rt", "hub_rt", "da"],
      ...rows.map((r) => [r.d, r.h + 1, r1(r.hsl), r1(r.bp), r1(r.out), ...(renew ? [r1(r.curt)] : []), r2(r.off), r2(r.off_bp), r1(r.award), r2(r.rt), r2(r.hub), r2(r.da)])]);
  } else {
    const days = dates.map((d) => {
      const rs = rows.filter((r) => r.d === d);
      return [d, r1(sum(rs.map((r) => r.hsl))), r1(sum(rs.map((r) => r.bp))), r1(sum(rs.map((r) => r.out))), ...(renew ? [r1(sum(rs.map((r) => r.curt)))] : []),
        rs.filter((r) => (r.bp || 0) > 0.5 || (r.out || 0) > 0.5).length, r2(mean(rs.map((r) => r.off))), r1(sum(rs.map((r) => r.award))), r2(mean(rs.map((r) => r.rt))), r2(mean(rs.map((r) => r.hub))), r2(mean(rs.map((r) => r.da)))];
    });
    body = "Daily: MWh columns are sums over the day's hours; prices are hourly means.\n" +
      csv([["date", "hsl_mwh", "bp_mwh", "out_mwh", ...(renew ? ["curt_mwh"] : []), "hours_online", "mean_offer", "award_mwh", "mean_rt", "mean_hub_rt", "mean_da"], ...days]);
  }
  return { text: `${head}\n${tot}\n${body}`, units: [trainOf(names[0])] };
}

async function fleet_days(env, { tech, from, to }) {
  if (!TECHS.includes(tech)) throw new Error(`tech must be one of ${TECHS.join(", ")}`);
  const idx = await getJSON(env, "data/series/index.json.gz");
  if (!idx) throw new Error("the hourly unit series aren't built yet");
  const c = clip(idx, from, to);
  let dates = datesBetween(c.from, c.to);
  if (dates.length > 31) { dates = dates.slice(-31); c.notes.push("cut to the last 31 days"); }
  const at = await monthFiles(env, idx, tech, dates);
  const renew = tech === "wind" || tech === "solar";
  const hubs = ["HB_SOUTH", "HB_NORTH", "HB_WEST", "HB_HOUSTON"];
  const hp = Object.fromEntries(await Promise.all(hubs.map(async (h) => [h, await hubPrices(env, h, dates)])));
  const rows = [];
  for (const [di, d] of dates.entries()) {
    const x = at.get(d);
    for (let h = 0; h < 24; h++) {
      const r = { d, h, hsl: 0, bp: 0, out: 0, curt: 0, award: 0, on: 0 };
      if (x) for (const u of Object.values(x[0].units)) {
        const H = take(u.hsl, x[1], h), B = take(u.bp, x[1], h), O = take(u.out, x[1], h), A = take(u.award, x[1], h);
        r.hsl += H || 0; r.bp += B || 0; r.out += O || 0; r.award += A || 0;
        if (renew && H != null && B != null) r.curt += Math.max(H - B, 0);
        if ((B || 0) > 0.5 || (O || 0) > 0.5) r.on++;
      }
      hubs.forEach((hb) => { const p = hp[hb][di]; r[hb] = p.rt ? p.rt[h] ?? null : null; r[hb + "_da"] = p.da ? p.da[h] ?? null : null; });
      rows.push(r);
    }
  }
  const head = `${tech} fleet, ${c.from} to ${c.to}${c.notes.length ? " (" + c.notes.join("; ") + ")" : ""}.`;
  const cols = ["hsl", "bp", "out", ...(renew ? ["curt"] : []), "award"];
  let body;
  if (dates.length <= 3) {
    body = csv([["date", "he", ...cols, "units_online", ...hubs.map((h) => h + "_rt"), ...hubs.map((h) => h + "_da")],
      ...rows.map((r) => [r.d, r.h + 1, ...cols.map((k) => r1(r[k])), r.on, ...hubs.map((h) => r2(r[h])), ...hubs.map((h) => r2(r[h + "_da"]))])]);
  } else {
    body = "Daily: MWh columns are sums over the day's hours; units_online is the most in any hour; prices are hourly means.\n" +
      csv([["date", ...cols.map((k) => k + "_mwh"), "units_online", ...hubs.map((h) => h + "_rt"), ...hubs.map((h) => h + "_da")],
        ...dates.map((d) => { const rs = rows.filter((r) => r.d === d); return [d, ...cols.map((k) => r1(sum(rs.map((r) => r[k])))), Math.max(...rs.map((r) => r.on)), ...hubs.map((h) => r2(mean(rs.map((r) => r[h])))), ...hubs.map((h) => r2(mean(rs.map((r) => r[h + "_da"]))))]; })]);
  }
  return { text: `${head}\n${body}` };
}

async function prices(env, { points, from, to }) {
  const pts = (Array.isArray(points) ? points : [points]).map((p) => String(p).trim()).filter(Boolean).slice(0, 4);
  if (!pts.length) throw new Error("name at least one point");
  if (!isDate(from) || !isDate(to)) throw new Error("from and to must be dates as YYYY-MM-DD");
  const rt = await getJSON(env, "data/summary_prices.json.gz");
  const days = Object.keys(rt || {}).sort();
  if (from > to) [from, to] = [to, from];
  const notes = [];
  if (from < days[0]) { notes.push(`prices here start ${days[0]}`); from = days[0]; }
  if (to > days[days.length - 1]) { notes.push(`latest real-time day ${days[days.length - 1]}`); to = days[days.length - 1]; }
  let dates = datesBetween(from, to);
  if (dates.length > MAX_DAILY_DAYS) { dates = dates.slice(-MAX_DAILY_DAYS); notes.push(`cut to the last ${MAX_DAILY_DAYS} days`); }
  const per = Object.fromEntries(await Promise.all(pts.map(async (p) => [p, await hubPrices(env, p, dates)])));
  const head = `${pts.join(", ")}, ${from} to ${to}${notes.length ? " (" + notes.join("; ") + ")" : ""}. $/MWh.`;
  if (dates.length <= MAX_HOURLY_DAYS) {
    const rows = [];
    dates.forEach((d, di) => { for (let h = 0; h < 24; h++) rows.push([d, h + 1, ...pts.flatMap((p) => [r2(per[p][di].rt ? per[p][di].rt[h] : null), r2(per[p][di].da ? per[p][di].da[h] : null)])]); });
    return { text: `${head}\n${csv([["date", "he", ...pts.flatMap((p) => [p + "_rt", p + "_da"])], ...rows])}` };
  }
  const rows = dates.map((d, di) => [d, ...pts.flatMap((p) => {
    const v = (per[p][di].rt || []).filter((x) => x != null), a = (per[p][di].da || []).filter((x) => x != null);
    return [r2(mean(v)), r2(v.length ? Math.min(...v) : null), r2(v.length ? Math.max(...v) : null), v.filter((x) => x <= 0).length, r2(mean(a))];
  })]);
  return { text: `${head} Daily from hourly values.\n${csv([["date", ...pts.flatMap((p) => [p + "_rt_mean", p + "_rt_min", p + "_rt_max", p + "_rt_hours_le0", p + "_da_mean"])], ...rows])}` };
}

async function changes(env, { unit, tech, kind, from, to, notable_only }) {
  const E = await getJSON(env, "data/events.json.gz");
  if (!E) throw new Error("the changes list isn't built yet");
  const q = unit ? String(unit).trim().toUpperCase() : "";
  const evs = E.events.filter((e) => (!q || e.unit === q || trainOf(e.unit) === q || (e.units || []).some((u) => u === q || trainOf(u) === q) || e.unit.startsWith(q + "_"))
    && (!tech || e.tech === tech) && (!kind || e.kind === kind) && (!isDate(from) || e.date >= from) && (!isDate(to) || e.date <= to) && (!notable_only || e.major));
  const shown = evs.slice(0, MAX_EVENTS);
  if (!shown.length) return { text: `No changes match (the feed runs ${E.first} to ${E.last}).` };
  const val = (v) => (v == null ? "" : Array.isArray(v) ? JSON.stringify(v) : typeof v === "number" ? r2(v) : String(v));
  const text = `${evs.length} change(s)${evs.length > MAX_EVENTS ? `, newest ${MAX_EVENTS} shown` : ""}. Feed runs ${E.first} to ${E.last}.\n` +
    shown.map((e) => `id=${e.id} | ${e.date} | ${e.unit}${e.units && e.units.length > 1 ? ` (${e.units.length} units)` : ""} | ${e.tech} | ${E.kinds[e.kind] || e.kind}${e.major ? " (notable)" : ""} | ${e.title}` +
      ` | before=${val(e.before_usd ?? e.before)} after=${val(e.after_usd ?? e.after)} value=${val(e.value)} field=${val(e.field)}`).join("\n");
  return { text, events: shown };
}

const RUN = { find_units, unit_hours, fleet_days, prices, changes };

export async function runTool(env, name, input) {
  const f = RUN[name];
  if (!f) return { text: `Unknown tool ${name}`, error: true };
  try { return await f(env, input || {}); }
  catch (e) { return { text: `Error: ${e.message}`, error: true }; }
}

// what the page needs to draw an event's link and chart (site/event-chart.js), and its kind label
export async function eventKinds(env) { const E = await getJSON(env, "data/events.json.gz"); return (E && E.kinds) || {}; }

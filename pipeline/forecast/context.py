"""Shared inputs for the forecast models, loaded once per build and read by every model.

Nothing here decides anything: a model reads the context and returns rows.  The context
answers "what was known when the day-ahead market for day D cleared":

  node_price(D, sp)     the day-ahead price at a settlement point, from the 60-day DAM
                        disclosure (data/dam/D, the unit's own spp) when D's disclosure is in,
                        else from data/dam_nodes.json.gz (thermal, wind and solar nodes kept
                        for the last two weeks); None if neither has it
  hub(D)                HB_HUBAVG day-ahead hourly prices for D (data/dam_hubs.json.gz)
  known_date(D)         the latest 60-day day whose per-unit data was public before D's
                        day-ahead market cleared (60-day lag), so a backtest sees what a
                        live forecast would have seen; the earliest 60-day day when D is
                        inside the first 60 days of the history (flagged by the caller)
  units(D)              every generation resource in the latest DAM disclosure at or before
                        D, merged into trains: tech, sp, hsl, lsl, costs
  stats                 per-unit history from the hourly states and the 60-day unit rows:
                        online share by day-ahead hub price bin and hour, typical output when
                        running, HSL
  curve(name, D)        the unit's SCED2 offer curve from the latest monthly snapshot that was
                        public before D cleared (UNIT_DATA_DIR/forecast/curves/)
"""
import datetime as dt
from collections import defaultdict

import numpy as np

from ..config import DATA_DIR, UNIT_DATA_DIR, GENERIC_COSTS
from ..intraday import train_of
from ..store import read_json_gz, write_json_gz
from ..trends import UNIT_TECHS
from ..units import expand
from . import groups as grp

LAG = 60                       # days between an operating day and its 60-day disclosure
HUB = "HB_HUBAVG"
PRICE_BINS = [-1e9, 0.0, 15.0, 25.0, 35.0, 50.0, 100.0, 1e9]   # $/MWh, day-ahead hub average
BIN_LABELS = ["<0", "0-15", "15-25", "25-35", "35-50", "50-100", "100+"]
THERMAL = ["nuclear", "coal", "combined_cycle", "gas_steam", "combustion_turbine"]
RENEW = ["wind", "solar"]
CURVE_DIR = UNIT_DATA_DIR / "forecast" / "curves"
CURVE_FORMAT = 1
SNAP_HOUR = 15                 # the run nearest this hour on the snapshot day gives the curve


def price_bin(p):
    return int(np.searchsorted(PRICE_BINS, p, side="right") - 1) if p is not None else None


def _d(s):
    return dt.date.fromisoformat(s)


def _iso(d):
    return d.isoformat()


class Context:
    def __init__(self, index: dict):
        self.index = index
        self.days60 = sorted(index["days"].get("60d", []))
        self.dam_days = sorted(d for d in index["days"].get("dam", []) if (DATA_DIR / "dam" / f"{d}.json.gz").exists())
        self.uh = read_json_gz(DATA_DIR / "unit_hours_60d.json.gz", default={}) or {"dates": [], "units": {}, "hsl": {}}
        tr = read_json_gz(DATA_DIR / "trends_60d.json.gz", default={}) or {}
        self.techs = {u["unit"]: u["tech"] for u in tr.get("units", [])}
        self.groups = grp.unit_groups(self.uh, self.techs)
        self.decisions = read_json_gz(DATA_DIR / "decisions.json.gz", default={}) or {}
        self.dam_hubs = (read_json_gz(DATA_DIR / "dam_hubs.json.gz", default=None) or {"days": {}})["days"]
        self.dam_nodes = (read_json_gz(DATA_DIR / "dam_nodes.json.gz", default=None) or {"days": {}})["days"]
        self.renew_fc = (read_json_gz(DATA_DIR / "renew_forecast.json.gz", default=None) or {"days": {}})["days"]
        ppa = read_json_gz(DATA_DIR / "ppa.json.gz", default={}) or {}
        self.ppa = {u["name"]: u for u in ppa.get("units", [])}
        self._dam = {}
        self._units = {}
        self._stats = None
        self._snapshots = None
        self._curves = {}

    # ------------------------------------------------------------ prices --
    def hub(self, date):
        v = (self.dam_hubs.get(date) or {}).get(HUB)
        return np.array(v, float) if v and len(v) >= 24 and all(x is not None for x in v[:24]) else None

    def hub_daily(self):
        """{date: daily mean HB_HUBAVG} for every day with 24 hub prices."""
        out = {}
        for d in self.dam_hubs:
            h = self.hub(d)
            if h is not None:
                out[d] = float(h.mean())
        return out

    def dam(self, date):
        if date not in self._dam:
            self._dam[date] = read_json_gz(DATA_DIR / "dam" / f"{date}.json.gz") if date in self.dam_days else None
        return self._dam[date]

    def node_source(self, date):
        if self.dam(date):
            return "dam"
        return "dam_nodes" if date in self.dam_nodes else None

    def node_price(self, date, sp, name=None):
        """24 day-ahead prices at a settlement point for `date`, or None."""
        dd = self.dam(date)
        if dd:
            u = dd["units"].get(name) if name else None
            if u is None:
                for cand in dd["units"].values():
                    if cand.get("sp") == sp and cand.get("spp"):
                        u = cand
                        break
            spp = (u or {}).get("spp") or []
            if len(spp) >= 24 and all(v is not None for v in spp[:24]):
                return np.array(spp[:24], float)
        v = (self.dam_nodes.get(date) or {}).get(sp)
        if v and len(v) >= 24 and all(x is not None for x in v[:24]):
            return np.array(v[:24], float)
        return None

    # ------------------------------------------------------------- dates --
    def known_date(self, date):
        """Latest 60-day day public before `date` cleared, else the earliest (hindsight)."""
        cut = _iso(_d(date) - dt.timedelta(days=LAG))
        ok = [d for d in self.days60 if d <= cut]
        if ok:
            return ok[-1], False
        return (self.days60[0], True) if self.days60 else (None, True)

    def known_dam_date(self, date):
        """The DAM disclosure to read a unit's costs from: D's own if public... it is not (60-day
        lag), so the latest disclosure public before D cleared; for a backtest of a day whose own
        disclosure is in, its own three-part offer (submitted for that day, so known then)."""
        if self.dam(date):
            return date
        cut = _iso(_d(date) - dt.timedelta(days=LAG))
        ok = [d for d in self.dam_days if d <= cut]
        return ok[-1] if ok else (self.dam_days[0] if self.dam_days else None)

    def month_to_date_hub(self, date):
        """Mean daily hub average over the days of D's month before D (the previous month when
        D is its first day), and the month's label."""
        d = _d(date)
        days = {k: v for k, v in self.hub_daily().items()}
        mtd = [v for k, v in days.items() if k[:7] == date[:7] and k < date]
        if mtd:
            return float(np.mean(mtd)), date[:7]
        prev = (d.replace(day=1) - dt.timedelta(days=1)).isoformat()[:7]
        pm = [v for k, v in days.items() if k[:7] == prev]
        return (float(np.mean(pm)) if pm else None), prev

    # -------------------------------------------------------------- units --
    def units(self, date):
        """{train: {tech, sp, hsl, lsl, mingen, hot, est, configs: [names]}} from the DAM
        disclosure public before `date`, thermal and renewable resources, combined-cycle
        configurations merged (smallest LSL, largest HSL, smallest costs)."""
        kd = self.known_dam_date(date)
        if kd is None:
            return {}
        if kd in self._units:
            return self._units[kd]
        dd = self.dam(kd) or {"units": {}}
        out = {}
        # own costs carried back from up to COST_DAYS earlier disclosures
        carried = self._carried_costs(kd)
        for name, u in dd["units"].items():
            t = u.get("tech")
            if t not in THERMAL + RENEW:
                continue
            key = train_of(name) if t == "combined_cycle" else name
            e = out.setdefault(key, {"tech": t, "sp": u.get("sp") or None, "hsl": 0.0, "lsl": None, "mingen": None,
                                     "hot": None, "est": 2, "configs": []})
            e["configs"].append(name)
            hsl = u.get("hsl") or 0.0
            e["hsl"] = max(e["hsl"], hsl)
            lsl = u.get("lsl")
            if lsl is not None and lsl > 0:
                e["lsl"] = lsl if e["lsl"] is None else min(e["lsl"], lsl)
            c = carried.get(name)
            if c:
                mg, hot = c
                if e["mingen"] is None or mg < e["mingen"]:
                    e["mingen"], e["hot"], e["est"] = mg, hot, 0
        for key, e in out.items():
            if e["lsl"] is None:
                e["lsl"] = 0.0
            if e["mingen"] is None and e["tech"] in GENERIC_COSTS:
                g = GENERIC_COSTS[e["tech"]]
                e["mingen"], e["hot"], e["est"] = g[3], g[0], 2
        self._units[kd] = out
        return out

    def _carried_costs(self, kd):
        from ..decisions import COST_DAYS
        i = self.dam_days.index(kd)
        carried = {}
        for d in self.dam_days[max(0, i - COST_DAYS):i + 1]:
            dd = self.dam(d) or {"units": {}}
            for name, u in dd["units"].items():
                if u.get("mingen") is not None:
                    carried[name] = (u["mingen"], (u.get("start") or [None])[0])
        return carried

    # -------------------------------------------------------------- stats --
    @property
    def stats(self):
        if self._stats is None:
            self._stats = build_unit_stats(self)
        return self._stats

    # ------------------------------------------------------------- curves --
    def snapshots(self):
        if self._snapshots is None:
            self._snapshots = sorted(p.stem[:7] for p in CURVE_DIR.glob("*.json.gz")) if CURVE_DIR.exists() else []
        return self._snapshots

    def curve_month(self, date):
        """Latest monthly curve snapshot public before `date` cleared (hindsight: the earliest)."""
        snaps = self.snapshots()
        if not snaps:
            return None, True
        cut = _iso(_d(date) - dt.timedelta(days=LAG))[:7]
        ok = [m for m in snaps if m <= cut]
        return (ok[-1], False) if ok else (snaps[0], True)

    def curves(self, month):
        if month not in self._curves:
            self._curves[month] = read_json_gz(CURVE_DIR / f"{month}.json.gz", default={}) or {}
        return self._curves[month].get("units", {})


# ------------------------------------------------------------------ stats --
def build_unit_stats(ctx: Context) -> dict:
    """Per unit (train for combined cycles) from the hourly states and the 60-day unit rows:
      on_bin[b][h]   online hours / hours with data, by day-ahead hub price bin b and hour h
      on_days        share of days with any online hour
      out_med        median output when running (MW)
      hsl_max        largest hourly HSL seen
      out_by_hour    wind, solar: mean HSL by hour of day over the last 30 days with rows
    plus fleet[tech] on_bin for the technology as a whole (hours summed over units)."""
    uh, techs = ctx.uh, ctx.techs
    dates = uh.get("dates", [])
    hub_bin = {}
    for d in dates:
        h = ctx.hub(d)
        hub_bin[d] = [price_bin(v) for v in h] if h is not None else None
    nb = len(BIN_LABELS)
    units, fleet = {}, {}
    by, N, day0 = grp.merged_states(uh, techs)
    # nuclear is not grouped (never cycles) but its states are still wanted here
    for name, s in uh.get("units", {}).items():
        if techs.get(name) == "nuclear":
            a = np.frombuffer(s.encode(), dtype="S1").astype(str)
            st = np.full(N, "-")
            for i, d in enumerate(dates):
                dn = (_d(d) - day0).days
                seg = a[i * 24:(i + 1) * 24]
                st[dn * 24:dn * 24 + seg.size] = seg
            by[name] = ("nuclear", st)
    for key, (t, st) in by.items():
        on = np.zeros((nb, 24)); tot = np.zeros((nb, 24)); days_on = 0; ndays = 0
        for i, d in enumerate(dates):
            dn = (_d(d) - day0).days
            seg = st[dn * 24:(dn + 1) * 24]
            if seg.size < 24 or hub_bin.get(d) is None:
                continue
            ndays += 1
            run = np.isin(seg, ["m", "a"])
            has = seg != "-"
            if run.any():
                days_on += 1
            for h in range(24):
                if has[h]:
                    b = hub_bin[d][h]
                    tot[b, h] += 1
                    on[b, h] += run[h]
        f = fleet.setdefault(t, {"on": np.zeros((nb, 24)), "tot": np.zeros((nb, 24))})
        f["on"] += on; f["tot"] += tot
        units[key] = {"tech": t, "on": on, "tot": tot, "on_days": days_on / ndays if ndays else 0.0,
                      "last_state": None, "out_med": None, "hsl_max": 0.0}
    # output when running, HSL and wind / solar availability by hour from the 60-day unit rows
    files = sorted((DATA_DIR / "60d-units").glob("*.json.gz"))
    outs = defaultdict(list); hsl_max = defaultdict(float); avail = defaultdict(lambda: np.zeros(24)); navail = defaultdict(lambda: np.zeros(24))
    recent = files[-30:]
    for f in files:
        day = read_json_gz(f)
        if not day:
            continue
        cols = {c: i + 2 for i, c in enumerate(day["columns"])}
        names = day["units"]
        for r in day["rows"]:
            name, t = names[r[0]][0], names[r[0]][2]
            key = train_of(name) if t == "combined_cycle" else name
            hsl, out, share = r[cols["hsl"]], r[cols["output"]], r[cols["online_share"]]
            if hsl:
                hsl_max[key] = max(hsl_max[key], hsl)
            if t in THERMAL and share and share >= 0.5 and out is not None:
                outs[key].append(out)
            if t in RENEW and f in recent and hsl is not None:
                avail[key][r[1] - 1] += hsl; navail[key][r[1] - 1] += 1
    for key, u in units.items():
        u["out_med"] = float(np.median(outs[key])) if outs[key] else None
        u["hsl_max"] = float(hsl_max.get(key, 0.0))
    renew = {}
    for key in set(avail) | set(hsl_max):
        if key in units:
            continue
        renew[key] = {"hsl_max": float(hsl_max.get(key, 0.0)),
                      "avail_by_hour": (avail[key] / np.maximum(navail[key], 1)).tolist() if key in avail else None}
    return {"units": units, "fleet": fleet, "renew": renew, "N": N, "day0": day0, "states": by}


# ----------------------------------------------------------------- curves --
def snapshot_month(ctx: Context, month: str) -> dict:
    """Offer curves at the end of a month: for every thermal resource, the SCED2 curve, HSL and
    LSL at the run nearest SNAP_HOUR on the last day of the month it was online, from the
    per-unit day files."""
    days = [d for d in ctx.days60 if d[:7] == month and (UNIT_DATA_DIR / "60d" / f"{d}.json.gz").exists()]
    units = {}
    for d in reversed(days):
        day = read_json_gz(UNIT_DATA_DIR / "60d" / f"{d}.json.gz")
        if not day:
            continue
        runs = np.array(day["runs"])
        target = int(np.argmin(np.abs(runs - SNAP_HOUR * 60)))
        for name, u in day["units"].items():
            if u.get("tech") not in THERMAL or name in units:
                continue
            e = expand(u, len(runs))
            on = np.array([bool(s) and s.startswith("ON") for s in e["status"]])
            if not on.any():
                continue
            cand = np.where(on)[0]
            r = int(cand[np.argmin(np.abs(cand - target))])
            cv = u.get("curve2") or u["curve"]
            ci = np.searchsorted([ev[0] for ev in cv], r, side="right") - 1
            ev = cv[ci] if ci >= 0 else None
            hsl, lsl = e["hsl"][r], e["lsl"][r]
            units[name] = {"tech": u["tech"], "date": d, "n_on": int(on.sum()),
                           "hsl": None if np.isnan(hsl) else round(float(hsl), 1),
                           "lsl": None if np.isnan(lsl) else round(float(lsl), 1),
                           "p": ev[1] if ev and ev[1] is not None else None,
                           "mw": ev[2] if ev and ev[1] is not None else None}
    return {"month": month, "format": CURVE_FORMAT, "days": days, "units": dict(sorted(units.items()))}


def update_snapshots(ctx: Context) -> list:
    """Write a snapshot for every month whose 60-day days changed since it was last written."""
    months = sorted({d[:7] for d in ctx.days60})
    done = []
    for m in months:
        path = CURVE_DIR / f"{m}.json.gz"
        want = [d for d in ctx.days60 if d[:7] == m and (UNIT_DATA_DIR / "60d" / f"{d}.json.gz").exists()]
        if not want:
            continue
        cur = read_json_gz(path, default=None)
        if cur and cur.get("format") == CURVE_FORMAT and cur.get("days") == want:
            continue
        snap = snapshot_month(ctx, m)
        write_json_gz(path, snap)
        done.append((m, len(snap["units"])))
        print(f"  curve snapshot {m}: {len(snap['units'])} units from {len(want)} day(s)")
    ctx._snapshots = None
    return done


def curve_mw(p, mw, price, lsl, hsl):
    """MW a piecewise-linear offer curve (price, MW points, non-decreasing) gives at `price`,
    clamped to [lsl, hsl]: the MW offered strictly below the price, interpolated between
    points.  A block offered exactly at the price (a step whose price equals it) is not
    counted: SCED takes it only when the price clears above it, and the day-ahead price the
    models use is the block's own typical offer for many units, so counting it would put every
    such unit at the top of the block on a day it is merely marginal."""
    if p is None or not len(p):
        return None
    p, mw = np.asarray(p, float), np.asarray(mw, float)
    j = int(np.searchsorted(p, price, side="left")) - 1     # last point priced below `price`
    if j < 0:
        v = 0.0
    elif j == len(p) - 1:
        v = mw[-1]
    else:
        # p[j] < price <= p[j+1], so the segment is sloped or ends exactly at the price: interpolate.
        # At price == p[j+1] this gives mw[j+1], the top of a ramp that ends there, while a step
        # at the price (p[j+1] == p[j+2]) stays uncounted because the ramp stops at its bottom.
        v = mw[j] + (price - p[j]) / (p[j + 1] - p[j]) * (mw[j + 1] - mw[j])
    return float(min(max(v, lsl), hsl))

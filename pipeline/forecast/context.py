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
  asof(D)               the history point D's models may read: the latest month end (or the
                        last day of the record) at or before known_date(D).  groups_at(D) and
                        stats_at(D) are the timescale groups and unit stats built from the
                        hourly states and 60-day rows up to that point only, so a backtest
                        day never sees later behaviour.  A live day's point is the record's
                        last day, where both equal the full-record groups and stats.  A day
                        whose point has under MIN_ASOF_DAYS days of history before it uses the
                        first point that has them and is flagged asof_hindsight; the scores
                        leave such days out of the track record
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
CHEAP_HUB = 10.0               # $/MWh: an hour at or below this day-ahead hub price is a cheap hour (scored in score.py)
PRICE_BINS = [-1e9, 0.0, 15.0, 25.0, 35.0, 50.0, 100.0, 1e9]   # $/MWh, day-ahead hub average
BIN_LABELS = ["<0", "0-15", "15-25", "25-35", "35-50", "50-100", "100+"]
THERMAL = ["nuclear", "coal", "combined_cycle", "gas_steam", "combustion_turbine"]
RENEW = ["wind", "solar"]
CURVE_DIR = UNIT_DATA_DIR / "forecast" / "curves"
CURVE_FORMAT = 1
OUTAGE_SNAPSHOT_LAG = 4        # days: the NP1-346-ER snapshot of D - 4 is posted about 05:00 on D - 1, before D clears
RENEW_FUEL = {"Wind": "wind", "Solar": "solar", "BATT": "storage"}   # unit-level report fuel -> technology
# Unseen outage MW (Context.unseen_out): the HSL of thermal units (combustion turbines included)
# on outage for at least half the day that the model did not call "outage" regresses on the zonal
# remainder (the report's total, which leaves the IRR part out, less the unit-level listings) as
# about 257 MW + 0.93 x remainder (daily, Mar-Aug 2026, r 0.98, residual MAE 1.0 GW).  Spread at
# that slope, the committed minimum ran 500 MW low in cheap hours (part of that outage sits on
# units already off on price), so the slope is set from the backtest instead: 0.60 passes the
# gate (0.75 and 0.93 fail it).  In-sample either way.  (The earlier fit, 910 + 0.46 x, took the
# IRR part off a total that never held it.)
UNSEEN_BASE = 257.0           # MW, fleet, split across zones by their thermal MW
UNSEEN_SLOPE = 0.60           # MW per MW of zonal remainder
OUT_SHARE_MIN = 0.5            # a non-CC unit listed with at least this share of its max MW out is off for the day
NRC_OFF_PCT = 50.0             # a reactor the NRC reported below this power the morning before D is off on D
CC_MIN_DAYS = 120              # days of 60-day history before the asof point a train's smallest running size is taken from
CC_MIN_Q = 0.1                 # ... as this percentile of its hourly online LSL
OFF_MIN_SPELLS = 3             # off spells a train needs for its own off-spell percentile
MIN_ASOF_DAYS = 28             # days of hourly history a backtest day's groups and stats need
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
        self._asof = {}
        self._raw = None
        self._off_p10 = None
        self._listed = {}
        self._turbines = None
        self._cap = None
        self._zones = None
        self._nrc = None
        self._cc_lsl = None
        self._cc_min = {}
        self._rows60 = {}
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

    # -------------------------------------------------------------- as-of --
    def asof(self, date):
        """(history point, hindsight): the latest month end of the hourly record at or before
        known_date(date), or the record's last day when that is the known date; hindsight when
        the point has fewer than MIN_ASOF_DAYS days before it (the first point that has them is
        used instead)."""
        dates = self.uh.get("dates", [])
        if not dates:
            return None, True
        known, _ = self.known_date(date)
        points = [d for i, d in enumerate(dates) if i + 1 == len(dates) or dates[i + 1][:7] != d[:7]]
        first = _d(dates[0])
        enough = [p for p in points if (_d(p) - first).days + 1 >= MIN_ASOF_DAYS]
        if known is not None and known >= dates[-1]:
            return dates[-1], not enough
        ok = [p for p in enough if known is not None and p <= known]
        if ok:
            return ok[-1], False
        return (enough[0] if enough else dates[-1]), True

    def _at(self, date):
        point, _ = self.asof(date)
        if point is None or point == (self.uh.get("dates") or [None])[-1]:
            return None
        if point not in self._asof:
            uh = _uh_upto(self.uh, point)
            by, N, _ = grp.merged_states(uh, self.techs)
            self._asof[point] = {"groups": {key: grp.group_of(st, N) for key, (t, st) in by.items()},
                                 "stats": build_unit_stats(self, upto=point), "off_p10": _off_p10(by)}
        return self._asof[point]

    def groups_at(self, date):
        """{train: group} as of asof(date) (the full-record groups for a live day)."""
        a = self._at(date)
        return self.groups if a is None else a["groups"]

    def stats_at(self, date):
        """Unit stats as of asof(date) (the full-record stats for a live day)."""
        a = self._at(date)
        return self.stats if a is None else a["stats"]

    def off_p10_at(self, date):
        """{train: 10th percentile of its off spells (hours)} as of asof(date), for trains with
        at least OFF_MIN_SPELLS spells."""
        a = self._at(date)
        if a is not None:
            return a["off_p10"]
        if self._off_p10 is None:
            self._off_p10 = _off_p10(grp.merged_states(self.uh, self.techs)[0])
        return self._off_p10

    def listed_out(self, date):
        """{unit or train: share out} from ERCOT's unplanned outage report public before `date`
        cleared (the snapshot of D - OUTAGE_SNAPSHOT_LAG, pipeline/outages.py), counting outages
        not ended by the start of `date`.  The report can list one turbine on several rows (one
        per outage entry), so each turbine counts once, at its largest MW out.  A non-CC unit,
        matched by name, is 1.0 when its MW out is at least OUT_SHARE_MIN of its max MW.  A CC
        train is 1.0 when every one of its gas turbines (pipeline/sp_list.py) is listed that
        way, and otherwise the share of its gas turbines so listed when any is; a train the
        turbine map does not cover gets its site's MW out over the site's MW (the trains' MW from
        data/groups_60d.json.gz), capped at 1.  None when there is no snapshot."""
        if date in self._listed:
            return self._listed[date]
        snap = (_d(date) - dt.timedelta(days=OUTAGE_SNAPSHOT_LAG)).isoformat()
        s = read_json_gz(DATA_DIR / "outages" / "unplanned" / f"{snap}.json.gz", default=None)
        out = None
        if s and s.get("rows"):
            out = {}
            c = {n: i for i, n in enumerate(s["columns"])}
            t0 = date + "T00:00"
            live = [r for r in s["rows"] if not (r[c["actual_end"]] and r[c["actual_end"]] < t0)
                    and not (r[c["planned_end"]] and r[c["planned_end"]] < t0)]
            tur = {}
            for r in live:
                mw, mx, _ = tur.get(r[c["unit"]], (0.0, 0.0, None))
                tur[r[c["unit"]]] = (max(mw, r[c["mw_out"]] or 0), max(mx, r[c["mw_max"]] or 0), r[c["resource"]])
            down = {u for u, (mw, mx, _) in tur.items() if mx > 0 and mw >= OUT_SHARE_MIN * mx}
            if self._turbines is None:
                self._turbines = (read_json_gz(DATA_DIR / "outages" / "cc_turbines.json.gz", default=None) or {}).get("trains", {})
            gu = (read_json_gz(DATA_DIR / "groups_60d.json.gz", default={}) or {}).get("units", {})
            by_site, site_mw = defaultdict(float), defaultdict(float)
            for mw, _, site in tur.values():
                by_site[site] += mw
            for key, v in gu.items():
                if v[0] == "combined_cycle":
                    site_mw[_site(key)] += v[2] or 0
            for key, v in gu.items():
                if v[0] != "combined_cycle":
                    continue
                gas = self._turbines.get(key, {}).get("gas")
                if gas:
                    n = sum(t in down for t in gas)
                    if n:
                        out[key] = n / len(gas)
                else:
                    mw = by_site.get(_site(key), 0.0)
                    if mw > 0 and site_mw[_site(key)] > 0:
                        out[key] = min(1.0, mw / site_mw[_site(key)])
            for name in down:
                out.setdefault(name, 1.0)
        self._listed[date] = out
        return out

    def unseen_out(self, date, zone_mw):
        """{zone: MW of thermal outage the unit-level report does not show}: the zonal outage
        capacity public before `date` cleared (pipeline/outages.py, planned outages included; its
        "total" is the non-IRR resources, batteries in, wind and solar out), less the MW the unit-level snapshot lists in the zone, as
        UNSEEN_BASE (split by `zone_mw`, the zones' thermal MW) + UNSEEN_SLOPE x that remainder,
        at least 0.  None when either report is missing."""
        self._load_zones()
        c = self._cap.get(date)
        snap = (_d(date) - dt.timedelta(days=OUTAGE_SNAPSHOT_LAG)).isoformat()
        s = read_json_gz(DATA_DIR / "outages" / "unplanned" / f"{snap}.json.gz", default=None)
        if not c or not s or not s.get("rows"):
            return None
        ci = {n: i for i, n in enumerate(s["columns"])}
        t0 = date + "T00:00"
        tur = {}
        for r in s["rows"]:
            if (r[ci["actual_end"]] and r[ci["actual_end"]] < t0) or (r[ci["planned_end"]] and r[ci["planned_end"]] < t0):
                continue
            if r[ci["fuel"]] in RENEW_FUEL:
                continue        # batteries ("BATT") stay: they are inside the zonal total
            z = self._zones["sub"].get(r[ci["resource"]])
            if z:
                tur[r[ci["unit"]]] = (z, max(tur.get(r[ci["unit"]], (z, 0.0))[1], r[ci["mw_out"]] or 0))
        listed = defaultdict(float)
        for z, mw in tur.values():
            listed[z] += mw
        tot_mw = sum(zone_mw.values()) or 1.0
        out = {}
        for z, v in c["total"].items():
            rem = float(np.mean([a or 0 for a in v])) - listed[z]      # "total" leaves out the IRR part already
            out[z] = max(0.0, UNSEEN_BASE * zone_mw.get(z, 0.0) / tot_mw + UNSEEN_SLOPE * rem)
        return out

    def renew_out(self, date):
        """Wind, solar and battery outage public before `date` cleared: {"irr": [24] fleet MW of
        intermittent renewable outage from the zonal report (planned included), "wind", "solar",
        "storage": MW the unit-level snapshot lists out for each (each unit once, at its largest
        MW out; unplanned only)}, the lists empty without a snapshot; None without the zonal day."""
        self._load_zones()
        c = self._cap.get(date)
        if not c or not c.get("irr"):
            return None
        irr = [sum((v[h] or 0) for v in c["irr"].values() if len(v) > h) for h in range(24)]
        out = {"irr": irr, "wind": 0.0, "solar": 0.0, "storage": 0.0}
        snap = (_d(date) - dt.timedelta(days=OUTAGE_SNAPSHOT_LAG)).isoformat()
        s = read_json_gz(DATA_DIR / "outages" / "unplanned" / f"{snap}.json.gz", default=None)
        if s and s.get("rows"):
            ci = {n: i for i, n in enumerate(s["columns"])}
            t0 = date + "T00:00"
            tur = {}
            for r in s["rows"]:
                k = RENEW_FUEL.get(r[ci["fuel"]])
                if k is None or (r[ci["actual_end"]] and r[ci["actual_end"]] < t0) or (r[ci["planned_end"]] and r[ci["planned_end"]] < t0):
                    continue
                tur[r[ci["unit"]]] = (k, max(tur.get(r[ci["unit"]], (k, 0.0))[1], r[ci["mw_out"]] or 0))
            for k, mw in tur.values():
                out[k] += mw
        return out

    def _load_zones(self):
        if self._cap is None:
            self._cap = (read_json_gz(DATA_DIR / "outages" / "capacity.json.gz", default=None) or {}).get("days", {})
            self._zones = read_json_gz(DATA_DIR / "outages" / "sp_zones.json.gz", default=None) or {"node": {}, "sub": {}}

    def zone_of(self, sp, key=""):
        """The outage-capacity zone (houston, north, south, west) of a unit, from its resource
        node, else its site (a CC train's node is its logical name), or None."""
        self._load_zones()
        return (self._zones["node"].get(sp) or self._zones["sub"].get(_site(key))
                or self._zones["sub"].get(key.split("_")[0]))

    def nrc_off(self, date):
        """{nuclear unit: power %} for the units of every reactor the NRC reported below
        NRC_OFF_PCT on the morning of D - 1 (pipeline/nrc.py, public before D cleared)."""
        if self._nrc is None:
            self._nrc = read_json_gz(DATA_DIR / "outages" / "nrc.json.gz", default=None) or {"days": {}, "units": {}}
        prev = (_d(date) - dt.timedelta(days=1)).isoformat()
        day = self._nrc["days"].get(prev) or {}
        return {u: p for name, p in day.items() if p < NRC_OFF_PCT for u in self._nrc["units"].get(name, [])}

    def cc_min_lsl_at(self, date):
        """{train: smallest usual running size, MW}: the CC_MIN_Q percentile of the train's
        hourly online LSL (configurations summed, as the 60-day data reports them) over the
        CC_MIN_DAYS days up to asof(date)."""
        point, _ = self.asof(date)
        if point is None:
            return {}
        if point not in self._cc_min:
            if self._cc_lsl is None:
                self._cc_lsl = _cc_online_lsl(self.days60)
            lo = (_d(point) - dt.timedelta(days=CC_MIN_DAYS)).isoformat()
            out = {}
            for key, days in self._cc_lsl.items():
                v = [a for d, a in days if lo < d <= point]
                v = np.concatenate(v) if v else np.array([])
                v = v[v > 0]
                if len(v):
                    out[key] = float(np.quantile(v, CC_MIN_Q))
            self._cc_min[point] = out
        return self._cc_min[point]

    def raw_states(self):
        """{train: (tech, state array)} merged but not outage-rewritten, on the stats' calendar."""
        if self._raw is None:
            self._raw = grp.merged_states(self.uh, self.techs, rewrite=False)[0]
        return self._raw

    def rows60(self, f):
        """Thermal and renewable rows of one 60-day unit file, cached: [(key, tech, hour, hsl,
        output, online share)]."""
        if f not in self._rows60:
            day = read_json_gz(f)
            rows = []
            if day:
                cols = {c: i + 2 for i, c in enumerate(day["columns"])}
                names = day["units"]
                for r in day["rows"]:
                    name, t = names[r[0]][0], names[r[0]][2]
                    key = train_of(name) if t == "combined_cycle" else name
                    rows.append((key, t, r[1], r[cols["hsl"]], r[cols["output"]], r[cols["online_share"]]))
            self._rows60[f] = rows
        return self._rows60[f]

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
def _site(train: str) -> str:
    """The plant site a CC train belongs to, as the outage report names it."""
    return train.rsplit("_CC", 1)[0]


def _cc_online_lsl(days60) -> dict:
    """{train: [(date, hourly online LSL array)]} for every CC train in the 60-day unit files."""
    out = defaultdict(list)
    for d in days60:
        f = read_json_gz(DATA_DIR / "60d-units" / f"{d}.json.gz", default=None)
        if not f:
            continue
        cols = {c: i + 2 for i, c in enumerate(f["columns"])}
        day = {}
        for r in f["rows"]:
            name, t = f["units"][r[0]][0], f["units"][r[0]][2]
            if t != "combined_cycle":
                continue
            a = day.setdefault(train_of(name), np.zeros(24))
            if (r[cols["online_share"]] or 0) >= 0.5 and 1 <= r[1] <= 24:
                a[r[1] - 1] += r[cols["lsl"]] or 0
        for k, a in day.items():
            out[k].append((d, a))
    return out


def _off_p10(by: dict) -> dict:
    """{train: 10th percentile off-spell length} from merged states (groups.off_spells)."""
    out = {}
    for key, (t, st) in by.items():
        n = [n for _, n, _ in grp.off_spells(st)]
        if len(n) >= OFF_MIN_SPELLS:
            out[key] = float(np.quantile(n, 0.1))
    return out


def _uh_upto(uh: dict, upto: str) -> dict:
    """The hourly-states record cut after day `upto` (dates and each unit's strip)."""
    dates = [d for d in uh.get("dates", []) if d <= upto]
    n = len(dates) * 24
    return {**uh, "dates": dates, "units": {k: s[:n] for k, s in uh.get("units", {}).items()}}


def build_unit_stats(ctx: Context, upto: str = None) -> dict:
    """Per unit (train for combined cycles) from the hourly states and the 60-day unit rows:
      on_bin[b][h]   online hours / hours with data, by day-ahead hub price bin b and hour h
                     (kept as on, tot; avail counts the hours with data not on outage, so
                     on / avail is the online share while available)
      on_days        share of days with any online hour
      out_med        median output when running (MW)
      hsl_max        largest hourly HSL seen
      out_by_hour    wind, solar: mean HSL by hour of day over the last 30 days with rows
    plus fleet[tech] on_bin for the technology as a whole (hours summed over units).
    upto: build from the record up to and including that day only (ctx.stats_at)."""
    uh, techs = (ctx.uh if upto is None else _uh_upto(ctx.uh, upto)), ctx.techs
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
        on = np.zeros((nb, 24)); tot = np.zeros((nb, 24)); av = np.zeros((nb, 24)); days_on = 0; ndays = 0
        for i, d in enumerate(dates):
            dn = (_d(d) - day0).days
            seg = st[dn * 24:(dn + 1) * 24]
            if seg.size < 24 or hub_bin.get(d) is None:
                continue
            ndays += 1
            run = np.isin(seg, ["m", "a"])
            has = seg != "-"
            up = has & (seg != "o")
            if run.any():
                days_on += 1
            for h in range(24):
                if has[h]:
                    b = hub_bin[d][h]
                    tot[b, h] += 1
                    av[b, h] += up[h]
                    on[b, h] += run[h]
        f = fleet.setdefault(t, {"on": np.zeros((nb, 24)), "tot": np.zeros((nb, 24)), "avail": np.zeros((nb, 24))})
        f["on"] += on; f["tot"] += tot; f["avail"] += av
        units[key] = {"tech": t, "on": on, "tot": tot, "avail": av, "on_days": days_on / ndays if ndays else 0.0,
                      "last_state": None, "out_med": None, "hsl_max": 0.0}
    # output when running, HSL and wind / solar availability by hour from the 60-day unit rows
    files = sorted((DATA_DIR / "60d-units").glob("*.json.gz"))
    if upto is not None:
        files = [f for f in files if f.name[:10] <= upto]
    outs = defaultdict(list); hsl_max = defaultdict(float); avail = defaultdict(lambda: np.zeros(24)); navail = defaultdict(lambda: np.zeros(24))
    recent = set(files[-30:])
    for f in files:
        for key, t, he, hsl, out, share in ctx.rows60(f):
            if hsl:
                hsl_max[key] = max(hsl_max[key], hsl)
            if t in THERMAL and share and share >= 0.5 and out is not None:
                outs[key].append(out)
            if t in RENEW and f in recent and hsl is not None:
                avail[key][he - 1] += hsl; navail[key][he - 1] += 1
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

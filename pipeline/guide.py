"""Worked examples for the "How offers work" page (site/guide.html).

The guide walks through one operating day with a long stretch of negative prices and a few real
units on it.  The site's own day files carry technology totals only, so this script pulls the
units' offer curves, limits and dispatch out of the per-unit day file (pipeline/units.py, the
`data` branch) once and writes them to site/data/guide.json.gz.  Run it by hand when the example
day or units change; the update workflow does not touch it.

    UNIT_DATA_DIR=unitdata python -m pipeline.guide

Writes data/guide.json.gz:
  date, lambda[24]          hourly mean system lambda ($/MWh)
  stretch                   [first hour (0-based), hours, mean lambda] of the day's sub-$0 stretch
  fleet                     thermal units online through the stretch: n, lsl (MW), lsl_award (MW
                            of that LSL covered by a DAM energy award, mean over the stretch)
  units[]                   {name, label, type, tech, note,
                             hsl, lsl, ldl, hdl, bp, out, as_up: [24] hourly means (MW),
                             sub: [[prices], [MW]] curves, sub_h: [24] index into sub per hour,
                             sced: same for the SCED2 curve (as ERCOT used it), sced_h,
                             dam_award, dam_spp: [24], dam_curve: [[prices], [MW]] or null,
                             ride: stay-on figures for the stretch (pipeline/stayon.py) or null}
"""
import numpy as np

from .config import DATA_DIR, UNIT_DATA_DIR
from .store import read_json_gz, write_json_gz
from .units import _ffill_index, expand

DATE = "2026-02-24"
UNITS = {   # resource name -> (label, one-line note shown with the picker)
    "RIONOG_CC1_6": ("Rio Nogales combined cycle", "Gas combined cycle that sat at its minimum output all afternoon"),
    "BRAUNIG_CC1_2": ("Braunig combined cycle", "Smaller gas combined cycle with the same pattern"),
    "CALAVERS_JKS2": ("J.K. Spruce 2 (coal)", "Coal unit at minimum output, carrying reserves through the stretch"),
    "SANMIGL_G1": ("San Miguel (lignite)", "Lignite unit whose curve starts at 0 MW and −$250"),
}
THERMAL = ("nuclear", "coal", "combined_cycle", "gas_steam", "combustion_turbine")


def _r(x, nd=1):
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


def _hourly(a, hour):
    return [_r(np.nanmean(a[hour == h])) if np.isfinite(a[hour == h]).any() else None for h in range(24)]


def _curves(events, hour, n_runs):
    """Distinct curves of an event list and, per hour, the one in force at the hour's middle run."""
    ci = _ffill_index(events, n_runs)
    out, idx, by_h = [], {}, []
    for h in range(24):
        runs = np.flatnonzero(hour == h)
        if not len(runs):
            by_h.append(None)
            continue
        i = ci[runs[len(runs) // 2]]
        ev = events[i] if i >= 0 else None
        if ev is None or ev[1] is None:
            by_h.append(None)
            continue
        if i not in idx:
            idx[i] = len(out)
            out.append([ev[1], ev[2]])
        by_h.append(idx[i])
    return out, by_h


def build():
    ud = read_json_gz(UNIT_DATA_DIR / "60d" / f"{DATE}.json.gz")
    if ud is None:
        raise SystemExit(f"no per-unit file for {DATE} in {UNIT_DATA_DIR}/60d")
    prices = read_json_gz(DATA_DIR / "prices" / f"{DATE}.json.gz")
    dam = (read_json_gz(DATA_DIR / "dam" / f"{DATE}.json.gz") or {}).get("units", {})
    stay = read_json_gz(DATA_DIR / "stayon_60d.json.gz") or {}

    runs = ud["runs"]
    n = len(runs)
    hour = np.minimum(np.array(runs) // 60, 23)

    lam = prices["lambda"]
    vals = next(v for k, v in lam.items() if k != "time")
    lh = [[] for _ in range(24)]
    for t, v in zip(lam["time"], vals):
        if v is not None and int(t[:2]) < 24:
            lh[int(t[:2])].append(v)
    lam_h = [_r(np.mean(a), 2) if a else None for a in lh]

    neg = [h for h in range(24) if lam_h[h] is not None and lam_h[h] < 0]
    first, last = neg[0], neg[-1]
    stretch = [first, last - first + 1, _r(np.mean(lam_h[first:last + 1]), 2)]
    sh = range(first, last + 1)

    # stay-on rides for this day's sub-$0 stretch
    rides = {}
    st = stay.get("stretches", {}).get("0", [])
    si = [i for i, s in enumerate(st) if s[0] == DATE]
    for r in stay.get("rides", []):
        if r[2] == 0 and r[3] in si:
            rides[r[0]] = {"mwh": r[4], "revenue": r[5], "cost": r[6], "loss": r[7], "start": r[8],
                           "saves": r[9], "est": r[10]}

    # fleet: thermal units online in every run of the stretch, and how much of their LSL a DAM
    # energy award covered
    n_on, lsl_mw, lsl_aw = 0, 0.0, 0.0
    mask = np.isin(hour, list(sh))
    for name, u in ud["units"].items():
        if u["tech"] not in THERMAL:
            continue
        e = expand(u, n)
        if not all(s and s.startswith("ON") for s, m in zip(e["status"], mask) if m):
            continue
        n_on += 1
        lsl_h = [np.nanmean(e["lsl"][hour == h]) for h in sh]
        aw = (dam.get(name) or {}).get("award") or [None] * 24
        lsl_mw += np.mean(lsl_h)
        lsl_aw += np.mean([min(aw[h] or 0.0, l) for h, l in zip(sh, lsl_h)])
    fleet = {"n": n_on, "lsl": _r(lsl_mw, 0), "lsl_award": _r(lsl_aw, 0)}

    units = []
    for name, (label, note) in UNITS.items():
        u = ud["units"][name]
        e = expand(u, n)
        sub, sub_h = _curves(u["curve"], hour, n)
        sced, sced_h = _curves(u.get("curve2") or u["curve"], hour, n)
        d = dam.get(name) or {}
        dc = d.get("curves") or []
        units.append({
            "name": name, "label": label, "note": note, "type": u["type"], "tech": u["tech"],
            **{k: _hourly(e[k], hour) for k in ("hsl", "lsl", "ldl", "hdl", "bp")},
            "out": u["out"], "as_up": _hourly(e["asup"], hour),
            "sub": sub, "sub_h": sub_h, "sced": sced, "sced_h": sced_h,
            "dam_award": d.get("award"), "dam_spp": d.get("spp"),
            "dam_curve": dc[d["curve"][12]] if dc and d.get("curve") and d["curve"][12] is not None else None,
            "ride": rides.get(name),
        })

    out = {"date": DATE, "lambda": lam_h, "stretch": stretch, "fleet": fleet, "units": units}
    write_json_gz(DATA_DIR / "guide.json.gz", out)
    print(f"guide: {DATE}, stretch HE{first + 1}-HE{last + 1} at {stretch[2]} $/MWh, {len(units)} units, "
          f"fleet {fleet}")


if __name__ == "__main__":
    build()

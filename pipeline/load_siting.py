"""Goal page question 4's siting maps: where wind and solar is curtailed, and where a new load could
reach it.  Over the last TRAIL_MONTHS complete months, by Texas county:

  curtailment   a wind or solar unit's HSL above its base point (CURT_MIN MW or more), from the 60-day
                SCED disclosure, at the unit's county.
  pockets       each hour, a curtailed unit whose DA node is CONGESTED or more below the DA bus average
                is behind congestion; its curtailment counts toward every county whose median wind and
                solar DA node price is within POCKET_TOL of the unit's node price (the same side of the
                binding constraints, inferred from prices: no shift factors).  Curtailment at nodes
                nearer the bus price, in hours the real-time hub average is OVER_PRICE or less, is
                system oversupply that a load anywhere could take, and counts toward every county.
  a new load    of each size in SIZES takes the smaller of its size and that county's reachable
                curtailment, hour by hour, scored as if it were the only new load.

A unit's county is the CDR's (site/data/unit_index.json.gz), else reference/unit_county_eia860.csv
(units the CDR lacks, matched to EIA-860 plants by owner or plant name), with the CDR's two-county
entries in COUNTY_FIX.  reference/county_ba.csv lists the balancing authorities of the utilities
serving each county (EIA-861 2024 service territories, utilities' BA from the sales and delivery
files): a county with no ERCO utility has no ERCOT retail service.

The fall-back day's merged HE2 counts as two hours; the spring-forward day has no HE3.  Days missing
from both the history release and the day files are left out, and the shares use the hours with data.

Returns the "siting" block of data/goal.json.gz (pipeline/goal.py):
  {"months": [first, last], "hours", "sizes", "pocket_tol", "congested", "over_price",
   "system_mwh" (oversupply curtailment counted everywhere), "congested_mwh",
   "columns": ["county", "curtailed_mwh", "wind_solar_mw", "disc", "reach_hours", "service",
               "absorb_mwh" ([per size])],
   "rows": [...]}
disc is the county's mean DA node price less the DA bus average, $/MWh; reach_hours the hours with any
reachable curtailment; service "ercot" | "part" | "none" (no ERCOT utility).
"""
import csv
from pathlib import Path

import numpy as np
import pandas as pd

from .config import DATA_DIR
from .decision_table import month_file
from .hours import hour_weight
from .store import read_json_gz

TRAIL_MONTHS = 12
SIZES = (10, 20, 50, 100, 200, 500, 1000, 2000, 3000, 5000)   # MW
POCKET_TOL = 2.0      # $/MWh: a county's node price this close to a curtailed unit's is in its pocket
CURT_MIN = 0.5        # MW, as pipeline/goal.py
COUNTY_FIX = {"HILL & LIMESTONE": "HILL"}   # Hubbard Wind (Aquilla Lake) sits in Hill County
REF = Path(__file__).parent / "reference"


def _counties():
    """{unit: county} for wind and solar units."""
    ix = read_json_gz(DATA_DIR / "unit_index.json.gz", default=None) or {}
    c = ix.get("columns") or []
    if not c:
        return {}
    i_u, i_t, i_c = c.index("unit"), c.index("tech"), c.index("county")
    out = {r[i_u]: COUNTY_FIX.get(r[i_c], r[i_c]) for r in ix["rows"] if r[i_t] in ("wind", "solar") and r[i_c]}
    with open(REF / "unit_county_eia860.csv", newline="") as f:
        for r in csv.DictReader(f):
            out.setdefault(r["unit"], r["county"])
    return out


def _service():
    """{county: "ercot" | "part" | "none"} from the EIA-861 service territories."""
    out = {}
    with open(REF / "county_ba.csv", newline="") as f:
        for r in csv.DictReader(f):
            ba = r["balancing_authorities"].split()
            out[r["county"]] = "none" if "ERCO" not in ba else "part" if len(ba) > 1 else "ercot"
    return out


def _weight(dates, he):
    """1 per hour, 2 for HE2 on the fall-back Sunday (the data merges the repeated hour)."""
    return hour_weight(np.asarray(dates), np.asarray(he))


def build(months, cache: Path, hubs, congested: float, over_price: float):
    """The siting block over the last TRAIL_MONTHS complete months of `months`; hubs(month) gives
    {(date, he): (DA hub, DA bus, RT hub, lambda)} (pipeline/goal._hubs)."""
    county = _counties()
    frames = {}
    for m in reversed(months):
        u = month_file("units", m, cache)
        if u is None:
            continue
        if not frames and str(u["date"].max()) < pd.Period(m).end_time.date().isoformat():
            continue   # the latest month is not complete yet
        frames[m] = u
        if len(frames) == TRAIL_MONTHS:
            break
    if not frames:
        return None
    use = sorted(frames)
    S = np.array(SIZES, dtype=float)
    acc = {}   # county -> [curtailed, absorb[sizes], reach hours]
    disc_sum, disc_n = {}, {}
    hours = sysw = congw = 0.0
    for m in use:
        u = frames[m]
        u = u[u["tech"].astype(str).isin(["wind", "solar"])].copy()
        u["county"] = u["unit"].map(county)
        h = hubs(m)
        key = list(zip(u["date"], u["he"].astype(int)))
        u["bus"] = [h[k][1] if k in h else np.nan for k in key]
        u["rt"] = [h[k][2] if k in h else np.nan for k in key]
        u = u.dropna(subset=["da_node", "bus"])
        c = (u["hsl"] - u["bp"]).clip(lower=0).fillna(0.0)
        u["curt"] = c.where(c >= CURT_MIN, 0.0) * _weight(u["date"], u["he"])
        u["w"] = _weight(u["date"], u["he"])
        for k, v in u.dropna(subset=["county"]).groupby("county")["curt"].sum().items():
            acc.setdefault(k, [0.0, np.zeros(len(S)), 0.0])[0] += v
        cp = u.dropna(subset=["county"]).groupby(["date", "he", "county"]).agg(
            node=("da_node", "median"), bus=("bus", "first"), w=("w", "first")).reset_index()
        for k, g in cp.groupby("county"):
            disc_sum[k] = disc_sum.get(k, 0.0) + float(((g["node"] - g["bus"]) * g["w"]).sum())
            disc_n[k] = disc_n.get(k, 0.0) + float(g["w"].sum())
        hours += float(cp.groupby(["date", "he"])["w"].first().sum())
        cu = u[u["curt"] > 0]
        cong = cu[cu["da_node"] <= cu["bus"] - congested]
        over = cu[(cu["da_node"] > cu["bus"] - congested) & (cu["rt"] <= over_price)]
        congw += float(cong["curt"].sum())
        sysw += float(over["curt"].sum())
        sys_h = over.groupby(["date", "he"])["curt"].sum()
        cg = dict(list(cong.groupby(["date", "he"])))
        for (d, he), q in cp.groupby(["date", "he"]):
            g = cg.get((d, he))
            s = float(sys_h.get((d, he), 0.0))
            if g is None and s == 0:
                continue
            got = s + ((np.abs(q["node"].values[:, None] - g["da_node"].values[None, :]) <= POCKET_TOL) @ g["curt"].values
                       if g is not None else 0.0)
            w = float(q["w"].iloc[0])
            for k, v in zip(q["county"].values, np.broadcast_to(got, len(q))):
                if v <= 0:
                    continue
                a = acc.setdefault(k, [0.0, np.zeros(len(S)), 0.0])
                a[1] += np.minimum(v / w, S) * w
                a[2] += w
        print(f"  siting: {m}", flush=True)
    svc = _service()
    rows = []
    for k in sorted(disc_n):
        a = acc.get(k, [0.0, np.zeros(len(S)), 0.0])
        rows.append([k, round(a[0], 1), None, round(disc_sum[k] / disc_n[k], 2), int(a[2]), svc.get(k, "ercot"),
                     [round(float(x), 1) for x in a[1]]])
    cap = {}
    ix = read_json_gz(DATA_DIR / "unit_index.json.gz", default=None) or {}
    if ix.get("columns"):
        c = ix["columns"]
        for r in ix["rows"]:
            k = county.get(r[c.index("unit")])
            if k and r[c.index("tech")] in ("wind", "solar"):
                cap[k] = cap.get(k, 0) + (r[c.index("mw")] or 0)
    for r in rows:
        r[2] = round(cap.get(r[0], 0))
    return {"months": [use[0], use[-1]], "hours": round(hours), "sizes": list(SIZES), "pocket_tol": POCKET_TOL,
            "congested": congested, "over_price": over_price, "system_mwh": round(sysw), "congested_mwh": round(congw),
            "service": {k: v for k, v in svc.items() if v != "ercot"},
            "columns": ["county", "curtailed_mwh", "wind_solar_mw", "disc", "reach_hours", "service", "absorb_mwh"],
            "rows": rows}

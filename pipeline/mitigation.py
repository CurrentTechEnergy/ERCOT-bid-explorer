"""How often ERCOT mitigated each unit's offer, by how much, and whether it moved the price,
read from the per-unit day files (format 6 on, which carry the SCED1-minus-SCED2 cut).

ERCOT mitigates an offer when the unit can relieve a non-competitive transmission
constraint: the curve SCED uses (SCED2) is capped at the unit's mitigated offer cap.  For
each unit and SCED run the day file holds the cut at the base point (SCED1 minus SCED2
price there) and the largest cut anywhere between LSL and HSL.  A run counts as:
  mitigated            some part of the curve between LSL and HSL was lowered by > CUT $/MWh
  mitigated at the BP  the price at the base point was lowered by > CUT
  price-setting        mitigated at the base point while the unit was marginal on SCED2 (see
                       marginal_nodes): the node's LMP was the mitigated price, so the cut at
                       the base point is how much mitigation lowered that LMP, holding the
                       dispatch fixed (the as-offered curve would also have moved dispatch,
                       so this is the first-order effect, an upper bound on the price change)
On days with node prices the price-setting runs are checked against ERCOT's published node
price, both with the mitigated price and with the price the unit offered.
Runs are weighted 1 / (runs in the hour), so totals are unit-hours.

Writes site/data/mitigation.json.gz:
  {"dates", "covered": [bool per date: day file has mitigation data],
   "cut": CUT,
   "days": {"columns": [date, tech, h_mit, h_mit_bp, h_set, impact_sum, max_cut], "rows": [...]},
   "by_hour": {tech: [24 x mitigated unit-hours]},
   "units": {"columns": [...], "rows": [...]}   # the TOP_UNITS most often mitigated
   "check": {"n", "within5_mitigated", "within5_offered"}}
"""
import numpy as np

from .config import DATA_DIR, UNIT_DATA_DIR, SIXTY_DAY_TECHS
from .marginal_nodes import STEP_MW, node_at, unit_runs
from .nodes import settlement_points
from .store import read_json_gz, write_json_gz
from .units import _ffill_index
from .intraday import _online

CUT = 0.5          # $/MWh: smaller differences are rounding
TOP_UNITS = 80
UNIT_COLS = ["unit", "tech", "sp", "hours_online", "h_mit", "h_mit_bp", "mean_cut_bp", "max_cut", "h_set",
             "mean_impact", "n_checked", "within5_mitigated", "within5_offered", "days_mitigated"]


def _r(x, nd=1):
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


def build_mitigation(index: dict) -> None:
    dates = sorted(index["days"].get("60d", []))
    node_days = set(index["days"].get("nodes", []))
    sp_of = settlement_points(index)
    covered, rows = [], []
    by_hour = {t: np.zeros(24) for t in SIXTY_DAY_TECHS}
    units = {}   # name -> [tech, sp, h_on, h_mit, h_mit_bp, sum cut bp, max cut, h_set, sum impact, n chk, ok mit, ok off, days]
    for d in dates:
        ud = read_json_gz(UNIT_DATA_DIR / "60d" / f"{d}.json.gz")
        ok_day = bool(ud) and ud.get("format", 0) >= 6
        covered.append(ok_day)
        if not ok_day:
            continue
        nodes = ((read_json_gz(UNIT_DATA_DIR / "nodes" / f"{d}.json.gz") or {}).get("points") or {}) if d in node_days else {}
        by_site = {}
        for k in nodes:
            by_site.setdefault(k.split("_")[0], []).append(k)
        runs = ud["runs"]
        n = len(runs)
        hr = np.minimum(np.array(runs) // 60, 23)
        w = 1.0 / np.bincount(hr, minlength=24).astype(float)[hr]
        day = {t: np.zeros(5) for t in SIXTY_DAY_TECHS}   # h_mit, h_mit_bp, h_set, impact sum, max cut
        for name, u in ud["units"].items():
            t = u.get("tech")
            disp = u.get("disp") or []
            if t not in day or not disp or len(disp[0]) < 8:
                continue
            di, si = _ffill_index(disp, n), _ffill_index(u["status"], n)
            on = np.array([i >= 0 and _online(u["status"][i][1]) for i in si])
            cut_bp = np.array([disp[i][6] if i >= 0 and disp[i][6] is not None else np.nan for i in di], float)
            cut_max = np.array([disp[i][7] if i >= 0 and disp[i][7] is not None else np.nan for i in di], float)
            mit = on & (np.nan_to_num(cut_max) > CUT)
            mit_bp = on & (np.nan_to_num(cut_bp) > CUT)
            rec = units.setdefault(name, [t, sp_of.get(name), 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0, 0, 0, 0])
            rec[2] += float(w[on].sum())
            if not mit.any():
                continue
            marg, price, bp, _ = unit_runs(u, n, hr)
            if t == "storage":
                marg &= np.abs(bp) >= STEP_MW
            sets = marg & mit_bp & np.isfinite(price)
            rec[3] += float(w[mit].sum())
            rec[4] += float(w[mit_bp].sum())
            rec[5] += float((w * np.nan_to_num(cut_bp))[mit_bp].sum())
            rec[6] = max(rec[6], float(np.nanmax(cut_max[mit])))
            rec[7] += float(w[sets].sum())
            rec[8] += float((w * cut_bp)[sets].sum())
            rec[12] += 1
            a = day[t]
            a[0] += w[mit].sum()
            a[1] += w[mit_bp].sum()
            a[2] += w[sets].sum()
            a[3] += (w * cut_bp)[sets].sum()
            a[4] = max(a[4], np.nanmax(cut_max[mit]))
            np.add.at(by_hour[t], hr[mit], w[mit])
            sp = rec[1]
            if sp is None and t == "storage" and len(by_site.get(name.split("_")[0], [])) == 1:
                sp = by_site[name.split("_")[0]][0]
            node = nodes.get(sp) if sp else None
            if node is not None:
                for r in np.flatnonzero(sets):
                    v = node_at(node, runs[r])
                    if np.isfinite(v):
                        rec[9] += 1
                        rec[10] += abs(v - price[r]) <= 5
                        rec[11] += abs(v - (price[r] + cut_bp[r])) <= 5
        for t, a in day.items():
            if a[0] > 0:
                rows.append([d, t, _r(a[0], 2), _r(a[1], 2), _r(a[2], 2), _r(a[3], 2), _r(a[4], 2)])

    mitigated = {k: v for k, v in units.items() if v[3] > 0}
    top = sorted(mitigated.items(), key=lambda kv: -kv[1][3])[:TOP_UNITS]
    out_units = [[name, r[0], r[1], _r(r[2]), _r(r[3], 2), _r(r[4], 2), _r(r[5] / r[4], 2) if r[4] else None, _r(r[6], 2),
                  _r(r[7], 2), _r(r[8] / r[7], 2) if r[7] else None, r[9],
                  _r(r[10] / r[9], 3) if r[9] else None, _r(r[11] / r[9], 3) if r[9] else None, r[12]] for name, r in top]
    n_chk = sum(r[9] for r in units.values())
    check = {"n": n_chk,
             "within5_mitigated": _r(sum(r[10] for r in units.values()) / n_chk, 3) if n_chk else None,
             "within5_offered": _r(sum(r[11] for r in units.values()) / n_chk, 3) if n_chk else None}
    write_json_gz(DATA_DIR / "mitigation.json.gz", {
        "dates": dates, "covered": covered, "cut": CUT,
        "days": {"columns": ["date", "tech", "h_mit", "h_mit_bp", "h_set", "impact_sum", "max_cut"], "rows": rows},
        "by_hour": {t: [_r(v, 2) for v in a] for t, a in by_hour.items() if a.sum() > 0},
        "units": {"columns": UNIT_COLS, "rows": out_units},
        "n_units": len(units), "n_mitigated": len(mitigated), "check": check,
    })
    print(f"mitigation: {sum(covered)} of {len(dates)} days with SCED2 data, {len(mitigated)} of {len(units)} units "
          f"mitigated at least once; price-setting checks {n_chk:,} runs: within $5 of the node "
          f"{check['within5_mitigated']} mitigated vs {check['within5_offered']} as offered")

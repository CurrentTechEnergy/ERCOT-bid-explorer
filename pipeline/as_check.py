"""Branch-only check: parse one real 60-day zip with the new parser and score it."""
import datetime as dt, json, sys
import numpy as np
from .config import DATA_DIR, EMIL_60DAY, UNIT_DATA_DIR
from .ercot_api import ErcotAPI
from .parse_60day import parse_60day_zip
from .marginal_nodes import unit_runs, run_lambda, node_at, band, STEP_MW
from .nodes import settlement_points
from .store import read_json_gz
day = sys.argv[1]
api = ErcotAPI()
d0 = dt.date.fromisoformat(day) + dt.timedelta(days=60)
docs = api.list_archives(EMIL_60DAY, dt.datetime.combine(d0 - dt.timedelta(days=1), dt.time()), dt.datetime.combine(d0 + dt.timedelta(days=2), dt.time()))
doc = next(d for d in docs if d["postDatetime"][:10] == d0.isoformat())
date, _, _, (ud, nev) = parse_60day_zip(api.download(EMIL_60DAY, doc["docId"]))
lens = {}
for u in ud["units"].values():
    for e in u.get("disp") or []:
        lens[len(e)] = lens.get(len(e), 0) + 1
asup = sum(1 for u in ud["units"].values() for e in (u.get("disp") or []) if len(e) > 4 and e[4])
ix = json.load(open(DATA_DIR / "index.json")); SP = settlement_points(ix)
pr = read_json_gz(DATA_DIR / "prices" / f"{date}.json.gz"); nodes = read_json_gz(UNIT_DATA_DIR / "nodes" / f"{date}.json.gz")["points"]
runs = ud["runs"]; n = len(runs); hr = np.minimum(np.array(runs) // 60, 23); lr = run_lambda(pr["lambda"], runs)
site = {}
for k in nodes: site.setdefault(k.split("_")[0], []).append(k)
res = {}
import copy
for variant in ("netted", "not_netted"):
  for name, u0 in ud["units"].items():
    u = u0 if variant == "netted" else dict(u0, disp=[e[:4] for e in (u0.get("disp") or [])])
    t = u.get("tech")
    if not u.get("curve") or not u.get("disp"): continue
    t = variant + "|" + t
    marg, price, bp, _ = unit_runs(u, n, hr)
    if t.endswith("storage"): marg &= np.abs(bp) >= STEP_MW
    sp = SP.get(name) or (site[name.split("_")[0]][0] if len(site.get(name.split("_")[0], [])) == 1 else None)
    node = nodes.get(sp) if sp else None
    if node is None: continue
    for r in np.flatnonzero(marg):
        l = lr[r]; v = node_at(node, runs[r])
        if not (np.isfinite(l) and np.isfinite(v)): continue
        c = "at" if abs(price[r] - l) <= band(l) else ("below" if price[r] < l else "above")
        o = res.setdefault(f"{t}|{c}", [0, 0]); o[0] += 1; o[1] += abs(v - price[r]) <= 5
out = {"date": date, "format": ud["format"], "disp_lengths": lens, "disp_events_with_as_up": asup, "events": nev,
       "score": {k: [v[0], round(v[1] / v[0], 3)] for k, v in sorted(res.items())}}
json.dump(out, open("as_test.json", "w"), indent=1, default=float)
print(json.dumps(out, indent=1, default=float))

"""Branch-only check: parse real days with the SCED2 parser and build marginality and mitigation."""
import datetime as dt, json, os, sys
from .config import DATA_DIR, EMIL_60DAY, UNIT_DATA_DIR
from .ercot_api import ErcotAPI
from .parse_60day import parse_60day_zip
from .store import write_json_gz, read_json_gz
from .marginal_nodes import build_marginal_nodes
from .mitigation import build_mitigation
api = ErcotAPI()
out = {}
days = sys.argv[1:]
for day in days:
    old = UNIT_DATA_DIR / "60d" / f"{day}.json.gz"
    old_size = old.stat().st_size if old.exists() else None
    d0 = dt.date.fromisoformat(day) + dt.timedelta(days=60)
    docs = api.list_archives(EMIL_60DAY, dt.datetime.combine(d0 - dt.timedelta(days=1), dt.time()), dt.datetime.combine(d0 + dt.timedelta(days=2), dt.time()))
    doc = next(d for d in docs if d["postDatetime"][:10] == d0.isoformat())
    date, dayfile, summary, (ud, nev) = parse_60day_zip(api.download(EMIL_60DAY, doc["docId"]))
    write_json_gz(old, ud)
    out[day] = {"date": date, "format": ud["format"], "old_size": old_size, "new_size": old.stat().st_size, "events": nev,
                "units_with_curve2": sum(1 for u in ud["units"].values() if u.get("curve2")),
                "disp_len": sorted({len(e) for u in ud["units"].values() for e in u.get("disp") or []})}
ix = json.load(open(DATA_DIR / "index.json"))
ix["days"]["60d"] = sorted(days)
build_marginal_nodes(ix)
build_mitigation(ix)
m = read_json_gz(DATA_DIR / "mitigation.json.gz")
mn = read_json_gz(DATA_DIR / "marginal_nodes.json.gz")
out["mitigation"] = {k: m[k] for k in ("covered", "n_units", "n_mitigated", "check", "by_hour")}
out["mitigation"]["days"] = m["days"]["rows"]
out["mitigation"]["units"] = m["units"]["rows"][:25]
out["marginal_valid"] = {k: mn["valid"][k] for k in ("n", "median_abs", "within5")}
out["marginal_by_class"] = mn["valid"]["by_class"]
json.dump(out, open("as_test.json", "w"), indent=1, default=float)
print(json.dumps(out, default=float)[:3000])

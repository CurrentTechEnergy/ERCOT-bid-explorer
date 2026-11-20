"""The Load page's data: ERCOT's day-ahead load forecast against actual load, and net load three
ways, by hour, for every day from SITE_START.  Built from files the pipeline already has; needs no
downloads.

  data/load.json.gz            in-use load forecast as of the DAM, actual load (pipeline/load.py)
  data/renew_forecast.json.gz  STWPF / STPPF as of the DAM, actual wind and solar output
                               (pipeline/renew_forecast.py)
  data/summary_60d.json.gz     wind and solar HSL (what the plants could have produced) per hour,
                               60-day days only
  data/summary_prices.json.gz  real-time hub average price per hour

Net load = load less wind and solar:
  forecast    load forecast - wind forecast - solar forecast (all as of the DAM)
  potential   actual load - wind HSL - solar HSL (60-day days only): what thermal and batteries
              would have had to cover had no wind or solar been curtailed
  served      actual load - actual wind output - actual solar output: what they did cover
Potential - served is wind and solar curtailment (economic or ordered); forecast - potential is
the true net-load forecast miss.  Forecast - served mixes the two, so the page never shows it as
an error.

Writes data/load_page.json.gz:
  {"built", "dates": [...],
   "days": {date: {"fc", "act", "wfc", "sfc", "wact", "sact", "whsl", "shsl", "hub": [24] or null}}}
MW rounded to whole numbers, prices to cents.
"""
import datetime as dt

from .config import DATA_DIR
from .store import read_json_gz, write_json_gz

PATH = DATA_DIR / "load_page.json.gz"
SITE_START = "2025-11-30"
HUB = "HB_HUBAVG"


def _arr(v, nd=0):
    if not v:
        return None
    out = [None if x is None else round(float(x), nd) if nd else int(round(float(x))) for x in list(v)[:24]]
    out += [None] * (24 - len(out))
    return out if any(x is not None for x in out) else None


def build_load_page(index: dict = None) -> None:
    load = (read_json_gz(DATA_DIR / "load.json.gz", default=None) or {}).get("days") or {}
    renew = (read_json_gz(DATA_DIR / "renew_forecast.json.gz", default=None) or {}).get("days") or {}
    summ = read_json_gz(DATA_DIR / "summary_60d.json.gz", default={}) or {}
    prices = read_json_gz(DATA_DIR / "summary_prices.json.gz", default={}) or {}
    days = {}
    for d in sorted(set(load) | set(renew)):
        if d < SITE_START:
            continue
        L, R = load.get(d) or {}, renew.get(d) or {}
        e = {"fc": _arr(L.get("fc")), "act": _arr(L.get("actual")),
             "wfc": _arr(R.get("wind")), "sfc": _arr(R.get("solar")),
             "wact": _arr(R.get("wind_actual")), "sact": _arr(R.get("solar_actual")),
             "whsl": None, "shsl": None,
             "hub": _arr(((prices.get(d) or {}).get("spp") or {}).get(HUB), 2)}
        s = summ.get(d) or {}
        names = s.get("stat_names") or []
        if "hsl" in names:
            i = names.index("hsl")
            for tech, k in (("wind", "whsl"), ("solar", "shsl")):
                rows = (s.get("stats") or {}).get(tech) or []
                e[k] = _arr([r[i] if r else None for r in rows])
        if e["fc"] or e["act"]:
            days[d] = e
    write_json_gz(PATH, {"built": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
                         "dates": sorted(days), "days": days})
    pot = sum(1 for v in days.values() if v["whsl"] and v["act"])
    print(f"load_page: {len(days)} days" + (f", {min(days)} to {max(days)}" if days else "") + f", {pot} with available wind/solar")


if __name__ == "__main__":
    build_load_page()

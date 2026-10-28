"""Real-time resource-node prices by hour, one file per day, from the stored node files
(UNIT_DATA_DIR/nodes/, written by the price step), so it needs no downloads and fills in
history on its first run.  Read by the Day page's Units table (profit by hour and day).

Writes
  data/rt-nodes/{date}.json.gz
    {"date": "YYYY-MM-DD", "format": FORMAT, "points": {settlement point: [24 hourly means, $/MWh]}}
  Each hour is the mean of the point's 15-minute real-time settlement point prices (parse_prices
  .node_hourly, as pipeline/econ.py uses them); null where the hour has no price.
"""
from .config import DATA_DIR, UNIT_DATA_DIR
from .parse_prices import node_hourly
from .store import read_json_gz, write_json_gz

FORMAT = 1
MAX_PER_RUN = 120     # days built per update run, newest first (each is a small file)
OUT_DIR = DATA_DIR / "rt-nodes"


def build_rt_nodes(index: dict) -> None:
    """Write data/rt-nodes/{date}.json.gz for every day with a stored node file that lacks it
    (or has an older format, or whose node file changed size)."""
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    done = 0
    days = sorted(index["days"].get("nodes", []), reverse=True)
    for d in days:
        if done >= MAX_PER_RUN:
            break
        path, src = OUT_DIR / f"{d}.json.gz", UNIT_DATA_DIR / "nodes" / f"{d}.json.gz"
        if not src.exists():
            continue
        size = src.stat().st_size
        cur = read_json_gz(path) if path.exists() else None
        if cur and cur.get("format") == FORMAT and cur.get("src_size") == size:
            continue
        pts = node_hourly(read_json_gz(src))
        if not pts:
            continue
        write_json_gz(path, {"date": d, "format": FORMAT, "points": pts, "src_size": size})
        done += 1
    left = sum(1 for d in days if (UNIT_DATA_DIR / "nodes" / f"{d}.json.gz").exists() and not (OUT_DIR / f"{d}.json.gz").exists())
    print(f"rt nodes: {done} day(s) written" + (f", {left} left for later runs" if left else ""))

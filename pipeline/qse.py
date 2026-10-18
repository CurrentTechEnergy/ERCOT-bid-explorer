"""Each unit's QSE (the entity that schedules and offers it), where ERCOT's 60-day files carry one.

parse_60day (SCED generation resource file) and parse_dam (DAM generation resource file) call
note() on every chunk they read.  The column is found by name (QSE, QSE Name, ...; never the
"QSE submitted curve" columns), so a file without one costs nothing.  update.py calls save()
after a run: names seen this run replace older ones, and the run summary says which files had
the column (and, when none did, the first columns of the header) so its presence is checked
on real files rather than assumed.

Writes data/unit_qse.json.gz: {units: {resource name: [qse, date last seen]}, sources: {...}}
"""
import datetime as dt

from .config import DATA_DIR
from .store import read_json_gz, write_json_gz

PATH = DATA_DIR / "unit_qse.json.gz"
SEEN = {"units": {}, "sources": {}}    # this run: {name: (qse, date)}, {source: {files, col, header}}
_NAMES = ("qse", "qsename", "qsecode", "qseshortname", "qualifiedschedulingentity")


def _norm(c) -> str:
    return "".join(ch for ch in str(c).lower() if ch.isalnum())


def note(source: str, df, unit_col: str, date: str = "") -> None:
    src = SEEN["sources"].setdefault(source, {"chunks": 0, "col": None, "header": None})
    src["chunks"] += 1
    col = next((c for c in df.columns if _norm(c) in _NAMES), None)
    if col is None:
        if src["header"] is None:
            src["header"] = [str(c) for c in df.columns[:40]]
        return
    src["col"] = str(col)
    pairs = df[[unit_col, col]].dropna().astype(str)
    for name, q in zip(pairs[unit_col].str.strip(), pairs[col].str.strip()):
        if q:
            SEEN["units"][name] = (q, date)


def save() -> list:
    """Merge this run's QSEs into the file; -> lines for the run summary."""
    if not SEEN["sources"]:
        return []
    old = read_json_gz(PATH, default={}) or {}
    units = dict(old.get("units", {}))
    for name, (q, d) in SEEN["units"].items():
        prev = units.get(name)
        if not prev or (d or "") >= (prev[1] or ""):
            units[name] = [q, d]
    if units:
        write_json_gz(PATH, {"updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "units": units,
                             "sources": {k: v["col"] for k, v in SEEN["sources"].items()}})
    lines = []
    for k, v in SEEN["sources"].items():
        if v["col"]:
            lines.append(f"QSE: the {k} files carry a {v['col']!r} column ({len(SEEN['units'])} units seen this run)")
        else:
            lines.append(f"QSE: no QSE column in the {k} files; header starts {v['header']}")
    for ln in lines:
        print(ln, flush=True)
    return lines

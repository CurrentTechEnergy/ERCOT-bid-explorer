"""Each unit's QSE (the entity that schedules and offers it) and DME (the decision-making entity
that decides how it is offered), where ERCOT's 60-day files carry them.

parse_60day (SCED generation resource and ESR files) and parse_dam (DAM generation resource file)
call note() on every chunk they read.  Columns are found by name (QSE, QSE Name, ...; DME, ...;
never the "QSE submitted curve" columns), so a file without one costs nothing.  Both are ERCOT's
short codes (QSUE66, YGALT); pipeline/entities.py maps both to names.  update.py calls save()
after a run: each unit keeps its latest pair and a dated history of changes, and the run summary
says which files had the columns (and, when none did, the first columns of the header) so their
presence is checked on real files rather than assumed.

Writes data/unit_qse.json.gz:
  {updated, sources: {source: {qse: column or null, dme: column or null}},
   units: {resource name: [qse, dme, date last seen]},
   history: {resource name: [[from date, qse, dme], ...]}}   oldest first; a row is added only
            when the pair changes, so one row means no change seen.  A day read out of order (a
            backfill) is placed by date; it adds a row only if it differs from the row in force.
            A field a file lacks (null) is unknown, not a change, and is filled from the next
            file that has it.
Older files held units as [qse, date]; save() reads both.
"""
import bisect
import datetime as dt

from .config import DATA_DIR
from .store import read_json_gz, write_json_gz

PATH = DATA_DIR / "unit_qse.json.gz"
SEEN = {"units": {}, "sources": {}}    # this run: {name: {date: (qse, dme)}}, {source: {...}}
_QSE = ("qse", "qsename", "qsecode", "qseshortname", "qualifiedschedulingentity")
_DME = ("dme", "dmename", "dmecode", "dmeshortname", "decisionmakingentity")


def _norm(c) -> str:
    return "".join(ch for ch in str(c).lower() if ch.isalnum())


def _col(df, names):
    return next((c for c in df.columns if _norm(c) in names), None)


def note(source: str, df, unit_col: str, date: str = "") -> None:
    src = SEEN["sources"].setdefault(source, {"chunks": 0, "qse": None, "dme": None, "header": None})
    src["chunks"] += 1
    q, d = _col(df, _QSE), _col(df, _DME)
    if q is None and d is None:
        if src["header"] is None:
            src["header"] = [str(c) for c in df.columns[:40]]
        return
    src["qse"], src["dme"] = (str(q) if q else src["qse"]), (str(d) if d else src["dme"])
    cols = [unit_col] + [c for c in (q, d) if c]
    sub = df[cols].astype(str).apply(lambda s: s.str.strip())
    for vals in sub.drop_duplicates().itertuples(index=False):
        name = vals[0]
        qv = vals[1] if q else ""
        dv = vals[-1] if d else ""
        qv, dv = (None if v in ("", "nan") else v for v in (qv, dv))
        if name and (qv or dv):
            prev = SEEN["units"].setdefault(name, {}).get(date)
            # a field missing from this file (DAM may lack DME) keeps what another file said
            SEEN["units"][name][date] = (qv or (prev[0] if prev else None), dv or (prev[1] if prev else None))


def _same(a, b) -> bool:
    """Two (qse, dme) pairs agree where both are known; a missing field is not a change."""
    return all(x is None or y is None or x == y for x, y in zip(a, b))


def merge(history: list, date: str, qse, dme) -> list:
    """Place one observation in a unit's change history (rows [from date, qse, dme], oldest first)."""
    dates = [r[0] for r in history]
    i = bisect.bisect_right(dates, date) - 1
    if i >= 0 and _same(history[i][1:], (qse, dme)):
        cur = history[i]
        cur[1], cur[2] = cur[1] or qse, cur[2] or dme
        return history
    if i >= 0 and history[i][0] == date:
        history[i] = [date, qse or history[i][1], dme or history[i][2]]
    else:
        i += 1
        history.insert(i, [date, qse, dme])
    nxt = history[i + 1] if i + 1 < len(history) else None
    if nxt and _same(nxt[1:], history[i][1:]):          # the next row was the same pair, seen earlier now
        history[i] = [date, history[i][1] or nxt[1], history[i][2] or nxt[2]]
        del history[i + 1]
    return history


def save() -> list:
    """Merge this run's QSEs and DMEs into the file; -> lines for the run summary."""
    if not SEEN["sources"]:
        return []
    old = read_json_gz(PATH, default={}) or {}
    units, hist = {}, {k: [list(r) for r in v] for k, v in (old.get("history") or {}).items()}
    for name, v in (old.get("units") or {}).items():
        units[name] = v if len(v) == 3 else [v[0], None, v[1]]     # older [qse, date] rows
        if name not in hist and units[name][2]:
            hist[name] = [[units[name][2], units[name][0], units[name][1]]]
    for name, days in SEEN["units"].items():
        h = hist.setdefault(name, [])
        for date in sorted(days):
            merge(h, date, *days[date])
        last = max([max(days), (units.get(name) or [None, None, ""])[2] or ""])
        units[name] = [h[-1][1], h[-1][2], last]         # the pair in force now, and the last day seen
    if units:
        write_json_gz(PATH, {"updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                             "sources": {k: {"qse": v["qse"], "dme": v["dme"]} for k, v in SEEN["sources"].items()},
                             "units": units, "history": hist})
    lines = []
    n = len(SEEN["units"])
    for k, v in SEEN["sources"].items():
        if v["qse"] or v["dme"]:
            have = " and ".join(f"a {v[f]!r} column" for f in ("qse", "dme") if v[f])
            lines.append(f"QSE/DME: the {k} files carry {have} ({n} units seen this run)")
            if not v["dme"]:
                lines.append(f"QSE/DME: no DME column in the {k} files")
        else:
            lines.append(f"QSE/DME: no QSE or DME column in the {k} files; header starts {v['header']}")
    changed = sorted(k for k, h in hist.items() if len(h) > 1 and h[-1][0] in {d for days in SEEN["units"].values() for d in days})
    if changed:
        lines.append(f"QSE/DME: {len(changed)} units changed QSE or DME on a day read this run, e.g. {changed[:5]}")
    for ln in lines:
        print(ln, flush=True)
    return lines

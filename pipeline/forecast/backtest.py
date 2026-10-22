"""Backtest: rerun the forecast over the history for the working tree and another version of the
code, side by side, without touching site/data, and report the promotion gate for both.

  python -m pipeline.forecast.backtest --against main --out backtests/v1-vs-main
  python -m pipeline.forecast.backtest --against cutoff-v1 --no-fit --days 2026-03-01 2026-06-30

Each side gets its own folder under --out (current/ for the working tree, ref/ for --against):

  tree/pipeline/     the code: the working tree's pipeline/ as it stands (uncommitted changes
                     included), or `git archive <ref> pipeline`
  tree/site/data/    the inputs: every entry of site/data linked, except forecast/ and fit/, which
                     start empty and take this side's output (so a version of the code from
                     before this module existed runs unchanged)
  tree/unitdata/     a copy of UNIT_DATA_DIR (the curve snapshots the run may rewrite)
  run.log            the side's output

The two sides run in parallel, each as `pipeline.forecast.run` inside its own tree.  --no-fit
skips the 2-day fit (most of the run time) when only the forecast itself is being judged; the
fit lines of the report are then empty.  --days builds only the days in that range (the scores
cover the days built).

report.md (also printed): the promotion gate of pipeline/forecast/benchmark.py, line by line, for
both sides with a pass or fail verdict for the current side (the cheap-hour floor error both in
total and for each of its causes, outages, on/off calls and sizing, on its own), then the
committed-minimum error (all, cheap and negative hours, and by cause) and the score by
technology and group over every as-of day.
backtests/ is gitignored; the scripts in analysis/ read a side folder (see analysis/README.md).

Split and cached (the Backtest workflow, .github/workflows/backtest.yml, runs it this way):

  --side current --chunk I N   build one side only, and only the Ith of N runs of consecutive
                               days among those with no file yet, so N jobs given the same seed
                               build every day between them
  --current REF                take the current side's code from REF instead of the working tree
  --seed DIR                   copy the day files in DIR/<side>/ into each side before building:
                               days already built (a cache, or the chunks' output) are kept
  --emit DIR                   copy the day files this run built to DIR/<side>/
  --score-only                 build nothing: score the seeded day files with each side's own
                               code, then write the report

The days are independent (each is forecast from what was public the day before it), so the
chunks can run on separate machines and a side's day files can be reused for as long as its
code and the thermal history it reads are unchanged.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from ..config import DATA_DIR, HISTORY_DIR, ROOT, UNIT_DATA_DIR
from ..store import read_json_gz

OUTPUTS = ("forecast", "fit")       # site/data entries a forecast run writes; everything else is input
RUNNER = """
import sys
sys.path.insert(0, {tree!r})
from pipeline.forecast import run
if {no_fit!r}:
    run.fit_days = lambda *a, **k: []
sys.exit(run.main({argv!r}))
"""
# One chunk of the days with no file yet: the Ith of N runs of consecutive days, since the
# cutoff model is fitted once per history point (a month) and reused for the days that share
# it.  Uses only functions every version of run.py uses.
CHUNK_RUNNER = """
import sys
sys.path.insert(0, {tree!r})
from pipeline.store import load_index
from pipeline.forecast import context as C
from pipeline.forecast.build import OUT_DIR, forecast_days, write_day
ctx = C.Context(load_index())
C.update_snapshots(ctx)
rng = {days!r}
days = [d for d in forecast_days(ctx) if not rng or rng[0] <= d <= rng[1]]
todo = [d for d in days if not (OUT_DIR / (d + ".json.gz")).exists()]
todo = todo[{i} * len(todo) // {n}:({i} + 1) * len(todo) // {n}]
print(f"chunk {i} of {n}: {{len(todo)}} of {{len(days)}} day(s) to build", flush=True)
for d in todo:
    write_day(d, ctx)
    print("built", d, flush=True)
"""


def make_tree(side_dir: Path, ref: str = None) -> Path:
    """side_dir/tree with the code (working tree, or `ref`) and a linked copy of the inputs."""
    tree = side_dir / "tree"
    if tree.exists():
        shutil.rmtree(tree)
    tree.mkdir(parents=True)
    if ref is None:
        shutil.copytree(ROOT / "pipeline", tree / "pipeline", ignore=shutil.ignore_patterns("__pycache__"))
    else:
        tar = subprocess.run(["git", "-C", str(ROOT), "archive", ref, "pipeline"], check=True, capture_output=True).stdout
        subprocess.run(["tar", "-x", "-C", str(tree)], input=tar, check=True)
    data = tree / "site" / "data"
    data.mkdir(parents=True)
    for p in DATA_DIR.iterdir():
        if p.name in OUTPUTS:
            (data / p.name).mkdir()
        else:
            (data / p.name).symlink_to(p.resolve())
    if UNIT_DATA_DIR.exists():
        shutil.copytree(UNIT_DATA_DIR, tree / "unitdata", symlinks=True)
    else:
        (tree / "unitdata").mkdir()
    return tree


def start(side_dir: Path, tree: Path, no_fit: bool, days, chunk=None, score_only=False, env_extra=None, n_sides=2):
    argv = ["--score"] if score_only else (["--days", *days] if days else [])
    tree = tree.resolve()       # the side runs with the tree as its working directory
    env = {**os.environ, "UNIT_DATA_DIR": str(tree / "unitdata"), "PYTHONDONTWRITEBYTECODE": "1", **(env_extra or {})}
    env.setdefault("HISTORY_DIR", str(HISTORY_DIR))     # else each side would look in tree/history, which is empty
    # the boosted trees use every core; two sides each doing so on the same machine slow both
    # to a crawl (OpenMP threads spinning against each other), so split the cores between them
    env.setdefault("OMP_NUM_THREADS", str(max(1, (os.cpu_count() or 2) // n_sides)))
    log = open(side_dir / "run.log", "w")
    if chunk and not score_only:
        code = CHUNK_RUNNER.format(tree=str(tree), days=list(days) if days else None, i=chunk[0], n=chunk[1])
    else:
        code = RUNNER.format(tree=str(tree), no_fit=no_fit, argv=argv)
    return subprocess.Popen([sys.executable, "-c", code], cwd=tree, env=env, stdout=log, stderr=subprocess.STDOUT), log


def _day_files(forecast_dir: Path) -> list:
    """The per-day outputs of a forecast folder, relative to it: <date>.json.gz and stack/<date>.json.gz."""
    return sorted(p.relative_to(forecast_dir) for p in [*forecast_dir.glob("20*.json.gz"), *forecast_dir.glob("stack/20*.json.gz")])


def _copy_days(src: Path, dst: Path) -> int:
    n = 0
    for rel in _day_files(src) if src.exists() else []:
        (dst / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src / rel, dst / rel)
        n += 1
    return n


# the floor error parts (score.FLOOR_PARTS) each held to the gate on its own, so a candidate cannot
# pass by trading an error in one for an offsetting error in another
GATE_PARTS = {"outage": "outages", "onoff": "on/off calls", "sizing": "sizing"}


def _versions(scores: dict) -> str:
    vs = {k for s in scores.get("days", {}).values() for k in [json.dumps(s.get("versions"), sort_keys=True)]}
    return "; ".join(", ".join(f"{k}={v}" for k, v in sorted(json.loads(x).items())) for x in sorted(vs) if x != "null")


def _cell(v, pct=False):
    if v is None:
        return "–"
    return f"{v:.1%}" if pct else f"{v:,.0f}"


def report(cur: dict, ref: dict, labels=("current", "ref"), cal=None) -> str:
    """Markdown: the promotion gate for both sides, then the floor and technology scores.
    cal: {"current": score.calibration(...), "ref": ...} adds the Brier line (report only: it
    never fails the gate) and the reliability table."""
    from .benchmark import BENCH, report as bench_report
    from .score import summarise
    bench = json.loads(BENCH.read_text())

    def one(scores):
        b = list(bench_report(scores, bench).values())
        a = list(summarise(scores.get("days", {})).values())
        b, a = (b[0] if b else {}), (a[0] if a else {})
        worst = max((g["mae"] or 0) for g in b["group"].values()) if b.get("group") else None
        fl, fp = a.get("floor") or {}, a.get("floor_parts") or {}
        return {"headline": b.get("headline_hit"), "unit": b.get("unit_hit"), "worst": worst,
                "cheap": (fl.get("cheap") or {}).get("mae"), "bench": b, "all": a, "floor": fl, "parts": fp,
                **{f"part_{k}": ((fp.get(k) or {}).get("cheap") or {}).get("mae") for k in GATE_PARTS}}
    c, r = one(cur), one(ref)
    cal = cal or {}
    c["brier"], r["brier"] = (cal.get("current") or {}).get("brier"), (cal.get("ref") or {}).get("brier")
    gate = [("Benchmark headline hit", "headline", True, True), ("Benchmark unit hit", "unit", True, True),
            ("Benchmark worst group MAE (MW)", "worst", False, False),
            ("Cheap-hour floor MAE, all as-of days (MW)", "cheap", False, False)]
    gate += [(f"Cheap-hour floor MAE, {name} only (MW)", f"part_{k}", False, False) for k, name in GATE_PARTS.items()]
    if cal:
        gate.append(("Brier score of P(on), loss-window units, all as-of days (report only)", "brier", False, False))
    lines = [f"# Backtest: {labels[0]} vs {labels[1]}", "",
             f"- {labels[0]}: {_versions(cur) or 'no scored days'}", f"- {labels[1]}: {_versions(ref) or 'no scored days'}", "",
             "## Promotion gate", "", f"| Line | {labels[1]} | {labels[0]} | |", "|---|---|---|---|"]
    ok_all = True
    for name, k, pct, higher in gate:
        a, b = r[k], c[k]
        ok = a is None or (b is not None and (b >= a if higher else b <= a))
        if k == "brier":    # report only
            f4 = lambda v: "–" if v is None else f"{v:.4f}"
            lines.append(f"| {name} | {f4(a)} | {f4(b)} | {'better or same' if ok else 'worse'} |")
            continue
        ok_all &= ok
        lines.append(f"| {name} | {_cell(a, pct)} | {_cell(b, pct)} | {'pass' if ok else '**fail**'} |")
    lines += ["", f"**{labels[0]}: {'passes' if ok_all else 'fails'} the gate.**", "",
              "## Committed minimum against online LSL, all as-of days", "",
              f"| Hours | {labels[1]} MAE | {labels[0]} MAE | {labels[1]} bias | {labels[0]} bias |", "|---|---|---|---|---|"]
    for h in ("all", "cheap", "neg"):
        fa, fb = r["floor"].get(h) or {}, c["floor"].get(h) or {}
        lines.append(f"| {h} ({fb.get('hours', fa.get('hours', 0))} h) | {_cell(fa.get('mae'))} | {_cell(fb.get('mae'))} | "
                     f"{_cell(fa.get('bias'))} | {_cell(fb.get('bias'))} |")
    rb, cb = r["all"].get("floor_bin") or {}, c["all"].get("floor_bin") or {}
    if rb or cb:
        lines += ["", "## Binary committed minimum against online LSL, all as-of days", "",
                  "Each unit-hour in full when its P(on) is 0.5 or more, none otherwise, less the outage pool "
                  "(the fleet's min_bin line; – for a side without it).", "",
                  f"| Hours | {labels[1]} MAE | {labels[0]} MAE | {labels[1]} bias | {labels[0]} bias |", "|---|---|---|---|---|"]
        for h in ("all", "cheap", "neg"):
            fa, fb = rb.get(h) or {}, cb.get(h) or {}
            lines.append(f"| {h} ({fb.get('hours', fa.get('hours', 0))} h) | {_cell(fa.get('mae'))} | {_cell(fb.get('mae'))} | "
                         f"{_cell(fa.get('bias'))} | {_cell(fb.get('bias'))} |")
    if r["parts"] or c["parts"]:
        lines += ["", "## Committed minimum error by cause, all as-of days", "",
                  "Each unit-hour's committed minimum less its online LSL, by cause (pipeline/forecast/score.py, "
                  "floor_parts), so errors that cancel in the fleet line show up.", "",
                  f"| Cause | Hours | {labels[1]} MAE | {labels[0]} MAE | {labels[1]} bias | {labels[0]} bias |", "|---|---|---|---|---|---|"]
        for k in ("outage", "onoff", "sizing", "other"):
            for h in ("all", "cheap"):
                fa, fb = (r["parts"].get(k) or {}).get(h) or {}, (c["parts"].get(k) or {}).get(h) or {}
                lines.append(f"| {k} | {h} | {_cell(fa.get('mae'))} | {_cell(fb.get('mae'))} | {_cell(fa.get('bias'))} | {_cell(fb.get('bias'))} |")
    lines += ["", "## All as-of days", "", f"| | {labels[1]} | {labels[0]} |", "|---|---|---|"]
    for name, k, pct in (("Days", "n", False), ("Headline hit", "headline_hit", True), ("Unit hit", "unit_hit", True),
                         ("Thermal MAE (MW)", "thermal_mae", False), ("Thermal bias (MW)", "thermal_bias", False)):
        lines.append(f"| {name} | {_cell(r['all'].get(k), pct)} | {_cell(c['all'].get(k), pct)} |")
    for part in ("tech", "group"):
        keys = sorted(set((r["all"].get(part) or {})) | set((c["all"].get(part) or {})))
        if keys:
            lines += ["", f"| {part.capitalize()} MAE / bias (MW) | {labels[1]} | {labels[0]} |", "|---|---|---|"]
            for k in keys:
                a, b = (r["all"].get(part) or {}).get(k) or {}, (c["all"].get(part) or {}).get(k) or {}
                lines.append(f"| {k} | {_cell(a.get('mae'))} / {_cell(a.get('bias'))} | {_cell(b.get('mae'))} / {_cell(b.get('bias'))} |")
    if cal:
        lines += ["", "## Reliability of P(on), loss-window units", "",
                  f"| P(on) | {labels[1]} unit-days | {labels[1]} mean p / online | {labels[0]} unit-days | {labels[0]} mean p / online |",
                  "|---|---|---|---|---|"]
        rb, cb = (cal.get("ref") or {}).get("bins") or [], (cal.get("current") or {}).get("bins") or []
        for i in range(max(len(rb), len(cb))):
            a, b = (rb[i] if i < len(rb) else None), (cb[i] if i < len(cb) else None)
            lo, hi = (a or b)[0], (a or b)[1]
            cellb = lambda x: "–" if not x or not x[2] else f"{x[3]:.2f} / {x[4]:.2f}"
            lines.append(f"| {lo:.2f}–{hi:.2f} | {a[2] if a else 0:,} | {cellb(a)} | {b[2] if b else 0:,} | {cellb(b)} |")
    fa, fb = (r["all"].get("fit") or {}), (c["all"].get("fit") or {})
    if fa.get("n") or fb.get("n"):
        lines += ["", f"2-day fit floor MAE (MW): {labels[1]} {_cell(fa.get('lsl_mae_fit'))}, {labels[0]} {_cell(fb.get('lsl_mae_fit'))}"]
    return "\n".join(lines) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--against", default="main", help="git ref to compare with (default main)")
    ap.add_argument("--current", help="git ref for the current side (default the working tree)")
    ap.add_argument("--out", help="output folder (default backtests/<timestamp>)")
    ap.add_argument("--no-fit", action="store_true", help="skip the 2-day fit")
    ap.add_argument("--days", nargs=2, metavar=("START", "END"), help="only build days in this range")
    ap.add_argument("--report-only", action="store_true", help="rewrite report.md from the sides already run")
    ap.add_argument("--side", choices=("current", "ref"), help="run this side only")
    ap.add_argument("--chunk", nargs=2, type=int, metavar=("I", "N"), help="build the Ith of N runs of the unbuilt days (no fit, no scores)")
    ap.add_argument("--seed", help="copy DIR/<side>/ day files into each side first")
    ap.add_argument("--emit", help="copy the day files built to DIR/<side>/")
    ap.add_argument("--score-only", action="store_true", help="score the seeded day files, build nothing")
    ap.add_argument("--labels", nargs=2, metavar=("CURRENT", "REF"), help="names for the two sides in the report")
    ap.add_argument("--current-env", default="", help="NAME=VALUE pairs (space-separated) for the current side only, e.g. THERMAL_VARIANT=logit")
    args = ap.parse_args(argv)
    out = Path(args.out or ROOT / "backtests" / time.strftime("%Y%m%d-%H%M%S")).resolve()
    sides = {"current": args.current, "ref": args.against}
    run_sides = [args.side] if args.side else list(sides)
    env_of = {"current": dict(kv.split("=", 1) for kv in args.current_env.split()), "ref": {}}
    if not args.report_only:
        t0 = time.time()
        procs, before = {}, {}
        for side in run_sides:
            ref = sides[side]
            d = out / side
            d.mkdir(parents=True, exist_ok=True)
            tree = make_tree(d, ref)
            fc = tree / "site" / "data" / "forecast"
            if args.seed:
                print(f"{side}: {_copy_days(Path(args.seed) / side, fc)} day file(s) seeded", flush=True)
            before[side] = set(_day_files(fc))
            procs[side] = start(d, tree, args.no_fit or bool(args.chunk), args.days, args.chunk, args.score_only,
                                env_of[side], len(run_sides))
            print(f"{side}: {'working tree' if ref is None else ref} running, log {d / 'run.log'}", flush=True)
        failed = []
        for side, (p, log) in procs.items():
            rc = p.wait()
            log.close()
            if rc:
                failed.append(side)
        print(f"{', '.join(procs)} done in {time.time() - t0:.0f}s" + (f"; failed: {', '.join(failed)} (see run.log)" if failed else ""))
        if failed:
            return 1
        if args.emit:
            for side in run_sides:
                fc = out / side / "tree" / "site" / "data" / "forecast"
                new = [r for r in _day_files(fc) if r not in before[side]]
                for rel in new:
                    (Path(args.emit) / side / rel).parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(fc / rel, Path(args.emit) / side / rel)
                print(f"{side}: {len(new)} day file(s) emitted", flush=True)
        if args.chunk or args.side:
            return 0
    scores = {s: read_json_gz(out / s / "tree" / "site" / "data" / "forecast" / "scores.json.gz", default={"days": {}})
              for s in sides}
    from .score import calibration
    cal = {s: calibration(scores[s].get("days", {}), out / s / "tree" / "site" / "data" / "forecast") for s in sides}
    labels = list(args.labels or (args.current or "current", args.against))
    if args.current_env:
        labels[0] += f" ({args.current_env})"
    text = report(scores["current"], scores["ref"], tuple(labels), cal)
    (out / "report.md").write_text(text)
    print(text)
    return 0

if __name__ == "__main__":
    sys.exit(main())

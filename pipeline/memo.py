"""Skip a history-wide builder when nothing it depends on has changed since it last ran.

The heavy builders (trends, intraday, curtail_nodes, marginal_nodes, econ) read every
60-day day on each run, about 40 minutes in all, even when no report was added.  run() records
the files a builder reads and writes (through store.read_json_gz / write_json_gz) and keeps, in
data/build_memo.json.gz, a hash of the builder's code (its module and the pipeline modules it imports), the index's day lists it uses, those inputs and
those outputs.  On the next run the builder is skipped when all four still match, so its output files
are left exactly as they are.

Only the day lists named in DAYS count, so a new 2-day or forecast day leaves a 60-day builder
alone.  Each builder reads the other lists only for the dates in its 60-day list, so those are
cut to the 60-day dates before hashing.

A builder must depend only on the index's day lists, files read with read_json_gz and the code:
no clock, no network.  Small JSON inputs are hashed without their top-level "updated" / "built"
stamps (gas.json.gz carries a fetch time even when no price changed).

Set REBUILD_ALL=1 (or pass --rebuild-all to pipeline.update) to run every builder regardless.
"""
import ast
import gzip
import hashlib
import json
import os
from pathlib import Path

from . import store
from .config import DATA_DIR, ROOT, UNIT_DATA_DIR

MEMO_PATH = DATA_DIR / "build_memo.json.gz"
PIPELINE = (ROOT / "pipeline").resolve()
STAMP_KEYS = ("updated", "built")
SMALL = 5 << 20             # compressed bytes; smaller JSON files are hashed without their stamps

_file_hashes = {}           # (path, mtime_ns, size) -> digest, for this process
_code = {}                  # builder module -> code hash, for this process


def _rel(p: Path) -> str:
    p = Path(p).resolve()
    for tag, base in (("data", DATA_DIR.resolve()), ("unit", UNIT_DATA_DIR)):
        try:
            return f"{tag}/{p.relative_to(base).as_posix()}"
        except ValueError:
            pass
    return p.as_posix()


def _abs(rel: str) -> Path:
    tag, _, rest = rel.partition("/")
    return {"data": DATA_DIR, "unit": UNIT_DATA_DIR}.get(tag, Path("/") / tag) / rest if rest else Path(rel)


def _file_hash(p: Path) -> str:
    try:
        st = p.stat()
    except FileNotFoundError:
        return "-"
    key = (str(p), st.st_mtime_ns, st.st_size)
    if key not in _file_hashes:
        raw = p.read_bytes()
        if st.st_size < SMALL and p.name.endswith((".json", ".json.gz")):
            try:
                text = gzip.decompress(raw) if p.name.endswith(".gz") else raw
                if any(f'"{k}":'.encode() in text for k in STAMP_KEYS):      # parse only the few stamped files
                    obj = json.loads(text)
                    if isinstance(obj, dict):
                        for k in STAMP_KEYS:
                            obj.pop(k, None)
                    text = json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()
                raw = text
            except (OSError, ValueError):
                pass
        _file_hashes[key] = hashlib.sha1(raw).hexdigest()
    return _file_hashes[key]


def _digest(rels) -> str:
    h = hashlib.sha1()
    for r in sorted(rels):
        h.update(f"{r}:{_file_hash(_abs(r))}\n".encode())
    return h.hexdigest()


def _imports(path: Path) -> set:
    """pipeline modules a module imports with relative imports, anywhere in the file."""
    pkg = PIPELINE / path.relative_to(PIPELINE).parent
    out = set()
    for node in ast.walk(ast.parse(path.read_text())):
        if not isinstance(node, ast.ImportFrom) or not node.level:
            continue
        base = pkg
        for _ in range(node.level - 1):
            base = base.parent
        names = [node.module] if node.module else [a.name for a in node.names]
        for name in names:
            stem = base.joinpath(*name.split("."))
            for cand in (stem.with_suffix(".py"), stem / "__init__.py"):
                if cand.is_file() and PIPELINE in cand.parents:
                    out.add(cand)
                    break
    return out


def code_hash(module: str) -> str:
    """The builder's module and every pipeline module it imports, directly or not, plus the
    non-Python files under pipeline/ (reference data) and requirements.txt.  A change to code the
    builder never imports leaves it alone."""
    if module not in _code:
        start = PIPELINE.joinpath(*module.split(".")[1:]).with_suffix(".py")
        seen, todo = set(), [start]
        while todo:
            f = todo.pop()
            if f not in seen:
                seen.add(f)
                todo += _imports(f)
        seen.discard(Path(__file__).resolve())
        data = [p for p in PIPELINE.rglob("*")
                if p.is_file() and p.suffix not in (".py", ".pyc") and "__pycache__" not in p.parts]
        h = hashlib.sha1()
        for p in sorted(seen) + sorted(data) + [ROOT / "requirements.txt"]:
            if p.exists():
                h.update(p.relative_to(ROOT).as_posix().encode() + b"\0" + p.read_bytes() + b"\0")
        _code[module] = h.hexdigest()
    return _code[module]


# builder -> (day lists hashed whole, day lists hashed only on the 60-day dates).  dam is whole
# because nodes.settlement_points reads every DAM day.  A builder missing here hashes every list.
DAYS = {
    "trends": (("60d",), ()),
    "intraday": (("60d",), ()),
    "curtail_nodes": (("60d", "dam"), ("nodes",)),
    "marginal_nodes": (("60d", "dam"), ("nodes", "prices")),
    "econ": (("60d", "dam"), ("nodes",)),
}


def index_hash(index: dict, name: str = None) -> str:
    lists = index["days"]
    if name in DAYS:
        whole, on_60d = DAYS[name]
        sixty = set(lists.get("60d", []))
        days = {k: sorted(set(lists.get(k, []))) for k in whole}
        days.update({k: sorted(set(lists.get(k, [])) & sixty) for k in on_60d})
    else:
        days = {k: sorted(set(v)) for k, v in lists.items()}
    return hashlib.sha1(json.dumps(days, sort_keys=True).encode()).hexdigest()


def _load() -> dict:
    try:
        return store.read_json_gz(MEMO_PATH, default={})
    except (OSError, ValueError):
        return {}


def run(name: str, fn, index: dict) -> bool:
    """fn(index), unless its last recorded run saw the same code, days, inputs and outputs.  True if it ran."""
    memo = _load()
    prev = memo.get(name)
    if (prev and not os.environ.get("REBUILD_ALL")
            and prev["code"] == code_hash(fn.__module__) and prev["index"] == index_hash(index, name)
            and prev["reads_digest"] == _digest(prev["reads"])
            and prev["writes_digest"] == _digest(prev["writes"])):
        print(f"{name}: inputs unchanged since the last build, skipped")
        return False
    store.TRACE = {"reads": set(), "writes": set()}
    try:
        fn(index)
        trace = store.TRACE
    finally:
        store.TRACE = None
    writes = sorted({_rel(p) for p in trace["writes"]})
    reads = sorted({_rel(p) for p in trace["reads"]} - set(writes))    # a file it rewrites is an output
    memo[name] = {"code": code_hash(fn.__module__), "index": index_hash(index, name),
                  "reads": reads, "reads_digest": _digest(reads),
                  "writes": writes, "writes_digest": _digest(writes)}
    store.write_json_gz(MEMO_PATH, dict(sorted(memo.items())))
    return True

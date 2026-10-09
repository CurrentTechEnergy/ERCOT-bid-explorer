"""Reading report zips and writing the dashboard's data files."""
import gzip
import io
import json
import zipfile
from pathlib import Path
from typing import Dict, Iterator, Tuple

import numpy as np

from .config import DATA_DIR, PRICE_GRID, THRESHOLDS


# ---------------------------------------------------------------- reading ---
def iter_csvs(blob: bytes, name: str = "") -> Iterator[Tuple[str, bytes]]:
    """Yield (file name, bytes) for every CSV inside a zip, descending into nested zips."""
    if name.lower().endswith(".csv"):
        yield name, blob
        return
    with zipfile.ZipFile(io.BytesIO(blob)) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            inner = zf.read(info)
            if info.filename.lower().endswith(".zip"):
                yield from iter_csvs(inner, info.filename)
            elif info.filename.lower().endswith(".csv"):
                yield Path(info.filename).name, inner


def zip_names(blob: bytes) -> list:
    """File names inside a zip, descending into nested zips, without decompressing CSVs."""
    if blob[:2] != b"PK":
        return []
    names = []
    with zipfile.ZipFile(io.BytesIO(blob)) as zf:
        for info in zf.infolist():
            if info.filename.lower().endswith(".zip"):
                names += zip_names(zf.read(info))
            else:
                names.append(Path(info.filename).name)
    return names


def describe_blob(blob: bytes) -> str:
    """Short description of a downloaded file, for error messages."""
    if blob[:2] != b"PK":
        head = blob[:120].decode("utf-8", "replace").replace("\n", " ").strip()
        return f"{len(blob):,} bytes, not a zip, starts with {head!r}"
    names = zip_names(blob)
    shown = ", ".join(names[:8]) + (f", ... ({len(names)} files)" if len(names) > 8 else "")
    return f"{len(blob):,} byte zip containing: {shown or 'nothing'}"


# ---------------------------------------------------------------- writing ---
def _round(a):
    """Round to whole MW and turn NaN into None for JSON."""
    a = np.asarray(a, dtype=float)
    r = np.round(a).astype(object)
    r[np.isnan(a)] = None
    return r.tolist()


def write_json_gz(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(obj, separators=(",", ":"), allow_nan=False).encode()
    # mtime=0 keeps the file byte-identical when content is unchanged (clean git diffs)
    with open(path, "wb") as f:
        with gzip.GzipFile(fileobj=f, mode="wb", mtime=0) as gz:
            gz.write(raw)


def read_json_gz(path: Path, default=None):
    if not path.exists():
        return default
    with gzip.open(path, "rb") as f:
        return json.loads(f.read())


def thresholds_from_curves(curves: np.ndarray) -> np.ndarray:
    """curves (..., len(PRICE_GRID)) -> (..., len(THRESHOLDS)) MW at each threshold price."""
    idx = [int(np.searchsorted(PRICE_GRID, t)) for t in THRESHOLDS]
    return curves[..., idx]


# ------------------------------------------------------------ index files ---
INDEX_PATH = DATA_DIR / "index.json"


def load_index() -> dict:
    if INDEX_PATH.exists():
        return json.loads(INDEX_PATH.read_text())
    return {"days": {"2d": [], "60d": [], "dam": [], "prices": [], "nodes": []}}


def save_index(index: dict) -> None:
    from .config import SIXTY_DAY_TECHS, TECH_LABELS, TWO_DAY_CURVES
    import datetime as dt
    for k in index["days"]:
        index["days"][k] = sorted(set(index["days"][k]))
    index["grid"] = PRICE_GRID.tolist()
    index["thresholds"] = THRESHOLDS
    index["techs"] = {
        "2d": [{"key": k, "label": v[1], "kind": v[2]} for k, v in TWO_DAY_CURVES.items()],
        "60d": [{"key": k, "label": TECH_LABELS[k]} for k in SIXTY_DAY_TECHS],
    }
    index["updated"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
    INDEX_PATH.write_text(json.dumps(index, separators=(",", ":")))


def update_summary(source: str, date: str, payload: dict) -> None:
    """Merge one day's small summary into data/summary_<source>.json.gz."""
    path = DATA_DIR / f"summary_{source}.json.gz"
    summ = read_json_gz(path, default={})
    summ[date] = payload
    summ = dict(sorted(summ.items()))
    write_json_gz(path, summ)

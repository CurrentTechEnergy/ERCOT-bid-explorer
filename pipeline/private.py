"""Licensed inputs the pipeline may use but the site must not publish: the OilPriceAPI hub gas
prices (Houston Ship Channel and Waha).  Their terms grant no right to redistribute or publicly
display the data, so the files live outside site/ (PRIVATE_DIR, gitignored) and in the private R2
bucket (pipeline/raw_store.py) under private/<name>, which is what carries them from one run to
the next.  Only values derived from them reach site/data.

  gas_hubs.json.gz          the live daily hub prices (pipeline/gas.py fetch_hubs)
  gas_hub_history.json.gz   the hubs before the live series (pipeline/gas.py fetch_gas_history)

read() takes the local copy, else the bucket's (and keeps it locally for the rest of the run),
else the copy the site used to publish in site/data: the one-time migration stores that in the
bucket and only then takes it out of site/data, so the data commit deletes the public file.
write() writes both and says whether the bucket holds it.  Without R2 credentials it works on the
local copy only and leaves a published copy where it is, and a reader with neither gets the
default: every user of the hub prices already falls back to Henry Hub.
"""
from .config import DATA_DIR, ROOT
from .log import warn
from .store import read_json_gz, write_json_gz

PRIVATE_DIR = ROOT / "private"
PREFIX = "private/"
_store = None
_unread = set()     # names the bucket could not be read for: never overwrite its copy this run


def _bucket():
    global _store
    if _store is None:
        from .raw_store import RawStore
        _store = RawStore()
    return _store


def _published(name):
    """What site/data used to publish under this name (None when there is nothing): gas_hub_history
    is the hsc and waha series of the public gas_history file, whose Henry Hub series (EIA,
    public) stays there."""
    if name == "gas_hub_history.json.gz":
        h = read_json_gz(DATA_DIR / "gas_history.json.gz", default=None) or {}
        return {k: h[k] for k in ("hsc", "waha") if k in h} or None
    return read_json_gz(DATA_DIR / name, default=None)


def _unpublish(name):
    """Take the published copy out of site/data, once the bucket holds it (a no-op when site/data
    has none)."""
    if _published(name) is None:
        return False
    if name == "gas_hub_history.json.gz":
        pub = DATA_DIR / "gas_history.json.gz"
        h = read_json_gz(pub, default=None) or {}
        for k in ("hsc", "waha"):
            h.pop(k, None)
        write_json_gz(pub, h)
    else:
        (DATA_DIR / name).unlink(missing_ok=True)
    return True


def read(name, default=None):
    path = PRIVATE_DIR / name
    if path.exists():
        return read_json_gz(path, default=default)
    try:
        blob = _bucket().get_object(PREFIX + name)
    except RuntimeError as e:
        warn(f"private: {e}; {name} is not used this run")
        _unread.add(name)
        return default
    if blob:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(blob)     # a site/data copy goes at the next write(), not here: workflows
                                   # that only read must not leave site/data changed
        return read_json_gz(path, default=default)
    obj = _published(name)
    if obj is None:
        return default
    if write(name, obj):                     # write() takes the site/data copy out
        print(f"private: moved {name} out of site/data")
    else:
        warn(f"private: {name} stays in site/data until the bucket can hold it")
    return obj


def write(name, obj) -> bool:
    """Write the local copy and the bucket's; True when the bucket now holds it."""
    path = PRIVATE_DIR / name
    path.parent.mkdir(parents=True, exist_ok=True)
    write_json_gz(path, obj)
    if name in _unread:
        warn(f"private: the bucket's {name} could not be read this run, so it is not overwritten")
        return False
    if not _bucket().enabled:
        return False
    if not _bucket().put_object(PREFIX + name, path.read_bytes(), "application/gzip"):
        warn(f"private: {name} not stored in the bucket; it lasts only this run")
        return False
    if _unpublish(name):
        print(f"private: removed site/data's copy of {name}, now in the bucket")
    return True

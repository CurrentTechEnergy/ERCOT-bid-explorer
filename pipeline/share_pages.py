"""Link-preview pages for units: site/unit/<UNIT>.html, one small stub per unit in the unit index.

Chat and social apps build a link preview from the HTML a link returns, without running the
page's scripts, and GitHub Pages serves the same unit.html whatever its ?unit= query says. So
each unit gets a stub at unit/<UNIT>.html (served at /unit/<UNIT>) carrying only that unit's
title, description and Open Graph tags, plus a redirect to unit.html?unit=<UNIT> that keeps any
#day=… part. The Unit page then shows /unit/<UNIT> in the address bar, so a link copied from it
previews with the unit's name.

The stubs hold none of the page itself, so changes to unit.html never touch them. A stub is
written only when its text would change: a new unit, or a unit whose name, technology, county or
zone changed, or whose capacity moved by more than MW_TOLERANCE from the MW its stub shows (the
index's MW is a percentile of daily HSLs and drifts a little). Stubs of units that leave the
index are kept, so links already sent still open. Changing TEMPLATE_VERSION rewrites every stub.

Run from the update after the unit index (pipeline/update.py), or by hand:
  python -m pipeline.share_pages
"""
import html
import re

from .config import SITE_DIR
from .unit_index import PATH as UNIT_INDEX_PATH
from .store import read_json_gz

SITE_URL = "https://ercotbids.currenttech.energy"
SITE_NAME = "ERCOT Bids"
OG_SITE_NAME = "ERCOT Bids · CurrentTech Energy"
SHARE_IMAGE = f"{SITE_URL}/share-card.png"
OUT_DIR = SITE_DIR / "unit"
TEMPLATE_VERSION = "1"
MW_TOLERANCE = 0.10

TECH_LABEL = {"nuclear": "Nuclear", "coal": "Coal", "combined_cycle": "Combined cycle", "gas_steam": "Gas steam",
              "combustion_turbine": "Combustion turbine", "wind": "Wind", "solar": "Solar", "storage": "Battery"}
ABOUT = {"storage": "How it charges and discharges, what it offers and bids, and its state of charge, from ERCOT's SCED and DAM disclosures.",
         "wind": "How it offers into ERCOT, how much is curtailed at low prices, and the hedge signals in its bids.",
         "solar": "How it offers into ERCOT, how much is curtailed at low prices, and the hedge signals in its bids."}
ABOUT_THERMAL = "How it offers into ERCOT, when it runs and turns off at low prices, and tomorrow's forecast."

# CDR names are in capitals; these stay that way when the name is title-cased
ACRONYMS = {"BESS", "ESS", "CTG", "STG", "CT", "CC", "GT", "BRP", "DGR", "SLF", "TNP", "PHR", "IC", "OCI", "CSG", "SES",
            "RTS", "SMT", "LLC", "LP", "LCP", "BAC", "RMR", "BNB", "DJ", "WP", "FS", "SP", "TG", "RE", "XE", "LCRA", "CPS",
            "NRG", "AEP", "ERCOT", "TX", "USA"}
LOWER = {"OF", "AND", "AT", "THE"}
_ROMAN = re.compile(r"^(?=[IVX]+$)X{0,3}(IX|IV|V?I{0,3})$")


def _word(w: str, first: bool) -> str:
    if "-" in w:
        return "-".join(_word(p, first and i == 0) for i, p in enumerate(w.split("-")))
    if not w or any(ch.isdigit() for ch in w) or w in ACRONYMS or len(w) == 1 or _ROMAN.match(w):
        return w
    if w in LOWER and not first:
        return w.lower()
    return w[0] + w[1:].lower()


def display_name(plant: str) -> str:
    """A CDR name as a title: bracketed notes dropped ("V H BRAUNIG STG 3 (RMR FROM …)" -> "V H Braunig STG 3")."""
    s = re.sub(r"\s+", " ", re.sub(r"\([^)]*\)|\[[^\]]*\]", " ", plant)).strip()
    return " ".join(_word(w, i == 0) for i, w in enumerate(s.split(" ")))


def _names_unit(u: dict) -> bool:
    """Whether the CDR name is this unit's own: a unit match, a combined-cycle train's plant, or a
    battery matched by a site whose name is itself a battery's (not the solar farm beside it)."""
    p = u.get("plant") or ""
    if not p or u.get("match") not in ("unit", "site"):
        return False
    return u["match"] == "unit" or u["tech"] == "combined_cycle" or (u["tech"] == "storage" and bool(re.search(r"\b(BESS|ESS|STORAGE|BATTERY)\b", p)))


def card(u: dict, mw) -> dict:
    """Title, preview headline and description for one unit-index row, at capacity mw."""
    tech = TECH_LABEL.get(u["tech"], u["tech"])
    named = _names_unit(u)
    head = f"{display_name(u['plant'])} ({u['unit']})" if named else u["unit"]
    size = f"{tech}, {mw:,} MW" if mw else tech
    where = ", ".join(x for x in [u.get("county") and f"{u['county'].title()} County", u.get("zone") and f"{u['zone'].title()} zone"] if x)
    bits = [f"{size}{', ' + where if where else ''}."]
    if u.get("plant") and not named:
        bits.append(f"At the {display_name(u['plant'])} site.")
    if u.get("aliases"):
        bits.append(f"Also known as {', '.join(u['aliases'])}.")
    bits.append(ABOUT.get(u["tech"], ABOUT_THERMAL))
    return {"title": f"{head} · {size} · {SITE_NAME}", "og_title": f"{head} · {size}", "description": " ".join(bits)}


def render(u: dict, mw) -> str:
    c, name = card(u, mw), u["unit"]
    e = lambda s: html.escape(s, quote=True)
    url, target = f"{SITE_URL}/unit/{name}", f"../unit.html?unit={name}"
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="pipeline/share_pages.py v{TEMPLATE_VERSION}" data-mw="{mw or ''}">
<title>{e(c['title'])}</title>
<meta name="description" content="{e(c['description'])}">
<link rel="canonical" href="{url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="{e(OG_SITE_NAME)}">
<meta property="og:title" content="{e(c['og_title'])}">
<meta property="og:description" content="{e(c['description'])}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{SHARE_IMAGE}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<script>location.replace("{target}" + location.hash);</script>
<noscript><meta http-equiv="refresh" content="0; url={target}"></noscript>
</head>
<body><p><a href="{target}">Open {e(name)} on {SITE_NAME}</a></p></body>
</html>
"""


def _stub_mw(text: str):
    m = re.search(rf'share_pages\.py v{re.escape(TEMPLATE_VERSION)}" data-mw="(\d*)"', text)
    return (int(m.group(1)) if m.group(1) else None) if m else False


def write_all() -> int:
    """Write the stubs whose text would change; returns how many were written."""
    ui = read_json_gz(UNIT_INDEX_PATH, default={}) or {}
    cols = ui.get("columns") or []
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    written = 0
    for r in ui.get("rows") or []:
        u = dict(zip(cols, r))
        if not re.fullmatch(r"[A-Za-z0-9_]+", u.get("unit") or ""):
            continue     # names are letters, digits and _; anything else would need escaping in the path
        path = OUT_DIR / f"{u['unit']}.html"
        old = path.read_text() if path.exists() else ""
        mw = round(u["mw"]) if u.get("mw") else None
        had = _stub_mw(old) if old else False
        if had and mw and abs(mw - had) <= MW_TOLERANCE * had:
            mw = had     # small drift in capacity: keep the MW the stub already shows
        text = render(u, mw)
        if text != old:
            path.write_text(text)
            written += 1
    return written


if __name__ == "__main__":
    print(f"{write_all()} unit preview page(s) written to {OUT_DIR}")

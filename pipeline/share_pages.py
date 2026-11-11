"""Link-preview pages for units: site/unit/<UNIT>.html, one small stub per unit in the unit index.

Chat and social apps build a link preview from the HTML a link returns, without running the
page's scripts, and GitHub Pages serves the same unit.html whatever its ?unit= query says. So
each unit gets a stub at unit/<UNIT>.html (served at /unit/<UNIT>) carrying only that unit's
title, description and Open Graph tags, plus a redirect to unit.html?unit=<UNIT> that keeps any
#day=… part. The Unit page then shows /unit/<UNIT> in the address bar, so a link copied from it
previews with the unit's name.

Each stub also carries the unit's heading and a few sentences about it (summary). At deploy,
pipeline/unit_pages.py turns every stub into the full Unit page in the deployed copy, so search
engines index /unit/<UNIT> as its own page; the committed stub keeps working on its own through
its redirect.

The stubs hold none of the page itself, so changes to unit.html never touch them. A stub is
written only when its text would change: a new unit, or a unit whose name, technology, county or
zone changed, or whose capacity moved by more than MW_TOLERANCE from the MW its stub shows (the
index's MW is a percentile of daily HSLs and drifts a little). Stubs of units that leave the
index are kept, so links already sent still open. Changing TEMPLATE_VERSION rewrites every stub.

write_all also writes site/sitemap.xml: the site's pages and every unit stub, for search engines
(site/robots.txt points to it).

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
TEMPLATE_VERSION = "2"
MW_TOLERANCE = 0.10
SITEMAP_PATH = SITE_DIR / "sitemap.xml"
# the pages in the nav, plus the reference pages; retired pages (redirects) are left out
SITEMAP_PAGES = ["", "day-in-ercot.html", "prices.html", "realtime.html", "thermal.html", "turn-ons-and-turn-offs.html", "dayahead.html", "renewables.html", "batteries.html", "unit.html",
                 "changes.html", "guide.html", "contact.html", "terms.html"]

TECH_LABEL = {"nuclear": "Nuclear", "coal": "Coal", "combined_cycle": "Combined cycle", "gas_steam": "Gas steam",
              "combustion_turbine": "Combustion turbine and recip", "wind": "Wind", "solar": "Solar", "storage": "Battery"}
ABOUT = {"storage": "How it charges and discharges, what it offers and bids, and its state of charge, from ERCOT's SCED and DAM disclosures.",
         "wind": "How it offers into ERCOT, how much is curtailed at low prices, and the hedge signals in its bids.",
         "solar": "How it offers into ERCOT, how much is curtailed at low prices, and the hedge signals in its bids."}
ABOUT_THERMAL = "How it offers into ERCOT, when it runs and turns off at low prices, and tomorrow's forecast."
# the timescale groups (site/unit-dir.js GROUP_SHORT) as what the unit did
GROUP_TEXT = {"never": "stayed on whenever it was available", "seasonal": "turned off for a season at a time",
              "multiday": "turned off for days at a time", "daily1": "turned off within a day, under once a week",
              "daily2": "turned off within a day, 1 to 2 times a week", "daily3": "turned off within a day, over twice a week",
              "never_on": "did not run"}

# CDR names are in capitals; these stay that way when the name is title-cased
ACRONYMS = {"BESS", "ESS", "CTG", "STG", "CT", "CC", "GT", "BRP", "DGR", "SLF", "TNP", "PHR", "IC", "OCI", "CSG", "SES",
            "RTS", "SMT", "LLC", "LP", "LCP", "BAC", "RMR", "BNB", "DJ", "WP", "FS", "SP", "TG", "RE", "XE", "LCRA", "CPS",
            "NRG", "AEP", "ERCOT", "TX", "USA", "NA"}
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


def label(u: dict) -> str:
    """How a unit is named in text: "Colorado Bend Energy Center CTG 12 (CBEC_GT12)" when the CDR
    name is the unit's own, else its code (the Unit page heading and the alert emails)."""
    return f"{display_name(u['plant'])} ({u['unit']})" if _names_unit(u) else u["unit"]


def unit_labels() -> dict:
    """{unit: label} for every unit in the index, and each combined-cycle configuration under its
    train's label; {} without an index."""
    ui = read_json_gz(UNIT_INDEX_PATH, default=None)
    if not ui:
        return {}
    out = {}
    for r in ui["rows"]:
        u = dict(zip(ui["columns"], r))
        out[u["unit"]] = label(u)
        for c in u.get("configs") or []:
            out.setdefault(c, out[u["unit"]])
    return out


def card(u: dict, mw) -> dict:
    """Title, preview headline and description for one unit-index row, at capacity mw."""
    tech = TECH_LABEL.get(u["tech"], u["tech"])
    named = _names_unit(u)
    head = label(u)
    size = f"{tech}, {mw:,} MW" if mw else tech
    where = ", ".join(x for x in [u.get("county") and f"{u['county'].title()} County", u.get("zone") and f"{u['zone'].title()} zone"] if x)
    bits = [f"{size}{', ' + where if where else ''}."]
    if u.get("plant") and not named:
        bits.append(f"At the {display_name(u['plant'])} site.")
    if u.get("aliases"):
        bits.append(f"Also known as {', '.join(u['aliases'])}.")
    bits.append(ABOUT.get(u["tech"], ABOUT_THERMAL))
    return {"title": f"{head} · {size} · {SITE_NAME}", "og_title": f"{head} · {size}", "description": " ".join(bits)}


def _a(word: str) -> str:
    return ("an " if word[:1].lower() in "aeiou" else "a ") + word


def summary(u: dict, mw) -> str:
    """A few plain sentences about the unit from its unit-index row: what and where it is, who
    offers it, its group. Written into the page's HTML so search engines and anything that does
    not run the page's scripts see the unit, not an empty shell; unit.js replaces it on load."""
    tech = {"wind": "wind farm", "solar": "solar farm", "storage": "battery"}.get(u["tech"], TECH_LABEL.get(u["tech"], u["tech"]).lower() + " unit")
    what = f"{mw:,} MW {tech}" if mw else tech
    where = ", ".join(x for x in [u.get("county") and f"{u['county'].title()} County", u.get("zone") and f"{u['zone'].title()} zone"] if x)
    yrs = u.get("in_service")
    s = [f"{label(u)} is {_a(what)} in ERCOT{', in ' + where if where else ''}"
         + (f", in service since {yrs[0]}" if yrs and yrs[0] else "") + "."]
    if u.get("plant") and not _names_unit(u):
        s.append(f"It is at the {display_name(u['plant'])} site.")
    if u.get("aliases"):
        s.append(f"Also known as {', '.join(u['aliases'])}.")
    dme, qse = u.get("dme"), u.get("qse_name")
    if dme and qse and dme.upper() != qse.upper():
        s.append(f"Its offers are decided by {display_name(dme)} and scheduled by {display_name(qse)}.")
    elif dme or qse:
        s.append(f"Its offers are decided and scheduled by {display_name(dme or qse)}.")
    if u.get("owner") and (u["owner"] or "").upper() != (dme or "").upper():
        s.append(f"Owned by {display_name(u['owner'])}.")
    if u.get("buyers"):
        s.append(f"Public buyers of its output: {', '.join(u['buyers'])}.")
    if u.get("group") in GROUP_TEXT:
        s.append(f"Over the last 60 days of unit data it {GROUP_TEXT[u['group']]}.")
    if len(u.get("configs") or []) > 1:
        s.append(f"It offers in {len(u['configs'])} configurations: {', '.join(u['configs'])}.")
    s.append(ABOUT.get(u["tech"], ABOUT_THERMAL))
    return " ".join(s)


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
<body>
<h1 id="unit-title">{e(display_name(u['plant'])) + ' <span class="unit-code">' + e(name) + '</span>' if _names_unit(u) else e(name)}</h1>
<p class="sub" id="unit-meta">{e(summary(u, mw))}</p>
<p><a href="{target}">Open {e(name)} on {SITE_NAME}</a></p>
</body>
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
    write_sitemap(sorted(p.stem for p in OUT_DIR.glob("*.html")))
    return written


def write_sitemap(units) -> None:
    """site/sitemap.xml: the pages in SITEMAP_PAGES and /unit/<UNIT> for every stub, written only
    when the list changes (no lastmod, so a run with no new unit leaves it alone)."""
    urls = [f"{SITE_URL}/{p}" for p in SITEMAP_PAGES] + [f"{SITE_URL}/unit/{u}" for u in units]
    text = ('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
            + "".join(f"  <url><loc>{html.escape(u)}</loc></url>\n" for u in urls) + "</urlset>\n")
    if not SITEMAP_PATH.exists() or SITEMAP_PATH.read_text() != text:
        SITEMAP_PATH.write_text(text)


if __name__ == "__main__":
    print(f"{write_all()} unit preview page(s) written to {OUT_DIR}")

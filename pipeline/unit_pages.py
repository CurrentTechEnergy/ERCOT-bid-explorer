"""Full unit pages at /unit/<UNIT>, built at deploy time from site/unit.html and each unit's stub.

share_pages.py writes and commits a small stub per unit (site/unit/<UNIT>.html): that unit's
title, description, canonical and Open Graph tags, its heading and a few sentences about it, and
a redirect to unit.html?unit=<UNIT>. Search engines treated that as a redirect to unit.html,
whose own canonical is the Units directory, and anything that does not run scripts saw only the
stub. So the deploy (update.yml, renew-history.yml) runs this just before uploading site/: each
stub is replaced, in the deployed copy only, by unit.html with

  - a fixed <base href="../"> so the page's relative links resolve from the site root,
  - the stub's title, description, canonical and Open Graph tags in place of the directory's,
  - the stub's heading and sentences in #unit-title and #unit-meta (unit.js redraws both),
  - the Units directory panel hidden until unit.js has looked the unit up,

and no redirect: unit.js reads the unit from the /unit/<UNIT> address. The committed stubs never
change, so the repository holds no copies of unit.html, and a change to unit.html reaches every
unit page at the next deploy.

Anything unexpected (unit.html no longer has a marker this looks for, a stub in another
format) leaves the stubs as they are, which still work through their redirect; the script always
exits 0 so a deploy is never held back by it. Standard library only: the deploy job installs
nothing.

  python3 pipeline/unit_pages.py [site_dir]
"""
import re
import sys
from pathlib import Path

GENERATOR = re.compile(r'<meta name="generator" content="pipeline/share_pages\.py v(\d+)"')
MIN_VERSION = 2     # stubs from share_pages TEMPLATE_VERSION 2 on carry the heading and sentences
BASE_LINE = re.compile(r"^<script>document\.write\('<base href=.*?</script>\n", re.M)
META_BLOCK = re.compile(r"<title>.*?<meta name=\"twitter:card\"[^>]*>\n", re.S)
TITLE = re.compile(r'<h1 id="unit-title">.*?</h1>', re.S)
META_P = re.compile(r'<p class="sub" id="unit-meta">.*?</p>', re.S)
EMPTY = '<section class="panel panel-wide" id="unit-empty">'
UNIT_NAME = re.compile(r"[A-Za-z0-9_]+")


def _one(rx, text):
    m = list(rx.finditer(text))
    return m[0] if len(m) == 1 else None


def build(template: str, stub: str):
    """The full page for one stub, or None when the stub isn't in the expected form."""
    g = GENERATOR.search(stub)
    if not g or int(g.group(1)) < MIN_VERSION:
        return None
    parts = [_one(META_BLOCK, stub), _one(TITLE, stub), _one(META_P, stub)]
    if not all(parts):
        return None
    meta, h1, sub = (m.group(0) for m in parts)
    page = BASE_LINE.sub(lambda _: '<base href="../">\n', template, count=1)
    page = META_BLOCK.sub(lambda _: meta, page, count=1)
    page = TITLE.sub(lambda _: h1, page, count=1)
    page = META_P.sub(lambda _: sub, page, count=1)
    # the Units directory starts hidden (unit.js shows it again if the unit isn't found)
    page = page.replace(EMPTY, EMPTY.replace('">', '" hidden>'), 1)
    # the Units nav link is not the current page here
    return page.replace('<a href="unit.html" aria-current="page">Units</a>', '<a href="unit.html">Units</a>', 1)


def main(site: Path) -> None:
    tpl_path = site / "unit.html"
    template = tpl_path.read_text()
    # every marker must be in unit.html exactly once, or no page is built
    missing = [n for n, rx in [("base script", BASE_LINE), ("head tags", META_BLOCK), ("unit-title", TITLE), ("unit-meta", META_P)]
               if len(rx.findall(template)) != 1] + (["unit-empty section"] if template.count(EMPTY) != 1 else [])
    if missing:
        print(f"::warning::unit pages not built: unit.html has no single {', '.join(missing)}; the stubs stay as they are")
        return
    built = skipped = 0
    for stub_path in sorted((site / "unit").glob("*.html")):
        if not UNIT_NAME.fullmatch(stub_path.stem):
            skipped += 1
            continue
        try:
            page = build(template, stub_path.read_text())
        except Exception as e:     # one odd stub must not stop the rest
            print(f"{stub_path.name}: {e}")
            page = None
        if page is None:
            skipped += 1
            continue
        stub_path.write_text(page)
        built += 1
    print(f"unit pages: {built} built from unit.html, {skipped} stub(s) left as they are")


if __name__ == "__main__":
    try:
        main(Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "site"))
    except Exception as e:
        print(f"::warning::unit pages not built: {e}; the stubs stay as they are")

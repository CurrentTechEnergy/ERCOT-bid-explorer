"""Shared settings: price grid, technology groupings, file locations."""
import os
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SITE_DIR = ROOT / "site"
DATA_DIR = SITE_DIR / "data"
# Full-fidelity per-unit day files (see pipeline/units.py). Too big for the site's branch:
# in GitHub Actions this is a checkout of the orphan `data` branch. Gitignored on main.
UNIT_DATA_DIR = Path(os.environ.get("UNIT_DATA_DIR") or (ROOT / "unitdata")).resolve()

# Price grid ($/MWh) on which every curve is stored.
# $1 steps where low-price behaviour lives, coarser above.
PRICE_GRID = np.concatenate([
    np.arange(-250, 151, 1),        # -250 .. 150 by $1
    np.arange(155, 501, 5),         # 155 .. 500 by $5
    np.arange(525, 2001, 25),       # 525 .. 2000 by $25
    np.array([2500, 3000, 4000, 5000]),
]).astype(float)

# Price thresholds kept in the long-range summary ("MW offered at or below $X").
# -249 stands for the price floor: ERCOT proxy curves place minimum output at -$250
# and output-schedule MW at -$249.99.
THRESHOLDS = [-249, -100, -50, -25, -10, -5, 0, 5, 10, 15, 20, 25, 30, 40,
              50, 75, 100, 150, 200, 300, 500, 1000, 2000]

# --- 2-Day SCED Energy Curves (NP3-908-ER): system-wide files -----------------
# key -> (file name prefix, label, kind)
TWO_DAY_CURVES = {
    "wind":    ("2d_Agg_Supply_Curves_Wind-",    "Wind",                         "supply"),
    "solar":   ("2d_Agg_Supply_Curves_PVGR-",    "Solar",                        "supply"),
    "storage": ("2d_Agg_Supply_Curves_ESR-",     "Storage (ESR)",                "supply"),
    "non_irr": ("2d_Agg_Supply_Curves_Non_IRR-", "Thermal & other (non-IRR)",    "supply"),
    "clr":     ("2d_Agg_Energy_Demand_Curves_CLR-", "Controllable load (bids)",  "demand"),
}

# --- 60-Day SCED Disclosure (NP3-965-ER): resource type -> technology ---------
TECH_OF_TYPE = {
    "NUC": "nuclear",
    "CLLIG": "coal",
    "CCGT90": "combined_cycle", "CCLE90": "combined_cycle",
    "GSREH": "gas_steam", "GSSUP": "gas_steam", "GSNONR": "gas_steam",
    "SCGT90": "combustion_turbine", "SCLE90": "combustion_turbine",
    "WIND": "wind",
    "PVGR": "solar",
    "HYDRO": "hydro",
    "DSL": "other", "RENEW": "other",
    "ESR": "storage",
}
TECH_LABELS = {
    "nuclear": "Nuclear",
    "coal": "Coal & lignite",
    "combined_cycle": "Combined cycle",
    "gas_steam": "Gas steam",
    "combustion_turbine": "Combustion turbine",
    "wind": "Wind",
    "solar": "Solar",
    "storage": "Storage (ESR)",
    "hydro": "Hydro",
    "other": "Other (diesel, biomass, unclassified)",
}
SIXTY_DAY_TECHS = list(TECH_LABELS)

# --- Prices -----------------------------------------------------------------
# Settlement point types kept from NP6-905-CD in the site's price day files (hubs and load zones).
PRICE_POINT_TYPES = {"HU", "SH", "AH", "LZ"}
# Resource-node prices are kept too, hourly, in per-day files on the data branch (see
# pipeline/nodes.py): one unit's own settlement point price, for curtailment and revenue.
PRICE_NODE_TYPES = {"RN"}
# Node prices are fetched for days with per-unit data; this many node-only days per run.
NODE_DAYS_PER_RUN = 40

# ERCOT Public API report ids (EMIL ids)
EMIL_2DAY = "np3-908-er"
EMIL_2DAY_GEN = "np3-910-er"     # 2-day aggregated generation / load / output schedule summaries
EMIL_60DAY = "np3-965-er"
EMIL_DAM = "np3-966-er"          # 60-day DAM disclosure: three-part offers, awards, AS awards
EMIL_LAMBDA = "np6-322-cd"
EMIL_SPP = "np6-905-cd"

# --- Natural gas (EIA open data, https://www.eia.gov/opendata/) ---------------------------
# Henry Hub spot price, $/MMBtu, daily (EIA_API_KEY in the environment; skipped without one).
EIA_SERIES = "RNGWHHD"
EIA_ROUTE = "natural-gas/pri/fut"
GAS_START = "2025-11-01"

# --- Plant costs when a unit has no DAM three-part offer that day ---------------
# Generic per-technology values used (and marked as such) by pipeline/stayon.py when a unit
# submitted no DAM three-part offer, so stay-on comparisons still cover it.  Start costs are
# $ per start for a typical unit; minimum-energy cost is $/MWh at minimum output.  Rough values
# chosen from the range of submitted DAM offers; override by editing here.  Nuclear has no
# entry: it does not cycle for a cheap stretch, so it is left out when it has no DAM offer.
GENERIC_COSTS = {
    #                  start hot, inter,   cold,  min-energy $/MWh
    "coal":           (30000.0, 60000.0, 90000.0,  25.0),
    "combined_cycle": (15000.0, 25000.0, 40000.0,  22.0),
    "gas_steam":      (10000.0, 20000.0, 30000.0,  35.0),
    "combustion_turbine": (3000.0, 4000.0, 5000.0, 40.0),
}

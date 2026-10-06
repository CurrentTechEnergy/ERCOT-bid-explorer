"""Shared settings: price grid, technology groupings, file locations."""
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SITE_DIR = ROOT / "site"
DATA_DIR = SITE_DIR / "data"

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
# Settlement point types kept from NP6-905-CD (hubs and load zones only).
PRICE_POINT_TYPES = {"HU", "SH", "AH", "LZ"}

# ERCOT Public API report ids (EMIL ids)
EMIL_2DAY = "np3-908-er"
EMIL_60DAY = "np3-965-er"
EMIL_LAMBDA = "np6-322-cd"
EMIL_SPP = "np6-905-cd"

# ERCOT Bid Stack Explorer

An interactive dashboard of how ERCOT resources offer energy into real-time dispatch (SCED), by technology, operating day and hour, with the cleared price alongside. It is built for questions like:

- How much inflexible "baseload" capacity is offered at or near the −$250 price floor, and how much of that is minimum output that ERCOT's proxy curves place there rather than a price the generator chose?
- At what prices do wind and solar offer, and how does that change through the day?
- How much supply sits below a given price, hour by hour and across days?

## Data sources

| Report | EMIL id | Lag | What it gives |
|---|---|---|---|
| 2-Day SCED Energy Curves | NP3-908-ER | 2 days | Aggregate supply curves for wind, solar, storage and all other resources ("non-IRR", i.e. thermal and everything else), plus controllable-load demand bids, for every SCED run |
| 60-Day SCED Disclosure | NP3-965-ER | 60 days | Every unit's offer curve in every SCED run, with its resource type, limits, base point and output. Lets thermal capacity be split into nuclear, coal, combined cycle, gas steam and combustion turbines |
| 60-Day DAM Disclosure | NP3-966-ER | 60 days | Every generation resource's day-ahead three-part offer (energy curve, start-up costs, minimum-energy cost), its day-ahead energy and ancillary service awards, its settlement point and the day-ahead price there |
| SCED System Lambda | NP6-322-CD | real time | System energy price for each SCED run |
| Settlement Point Prices | NP6-905-CD | real time | 15-minute prices at hubs and load zones; hourly prices at every resource node (kept on the data branch, for days with per-unit data) |
| EIA Henry Hub spot price | RNGWHHD | daily | Natural gas price, $/MMBtu, from the EIA open data API (needs an `EIA_API_KEY` secret; skipped without one) |

All curves are stored as hourly averages of the SCED runs in each hour, on a price grid with $1 steps from −$250 to $150 and coarser steps above.

### Two versions of the 60-day curves

- **As used in SCED** (`SCED1 Curve`): the submitted curve after ERCOT extends or truncates it to the unit's operating limits. Minimum output (LSL) is placed at −$250, and units with no offer curve are dispatched against a proxy curve with their output schedule at −$249.99.
- **As submitted** (`Submitted TPO`): the price/quantity pairs the QSE actually submitted. Units with no submitted curve contribute nothing here; the "No submitted offer" column shows how much capacity that is.

Both versions are capped at each unit's high sustainable limit (HSL) for the SCED run, so wind and solar curves reflect available output, not nameplate. Storage curves run from charging (negative MW) to discharging.

## How it updates

`.github/workflows/update.yml` runs twice a day. It calls the ERCOT Public API for any reports posted in the last few days, processes them into `site/data/`, and commits the result. Each day adds roughly 50 KB of 2-day data and 150 KB of 60-day data.

### Accuracy checks

After processing, `pipeline/validate.py` checks every new or changed operating day: the wind, solar and storage curves rebuilt from 60-day unit data against ERCOT's 2-day aggregate curves, thermal base points against the 2-day generation summary, curves and base points against online HSL, SCED runs per hour (allowing for DST), system lambda against the hub average, and status codes and resource types the pipeline does not know. A new error stops the run before anything is committed (an error already recorded for that day, from a run committed with **ignore_checks**, does not block a later re-check); warnings appear on the run summary. Results that did not pass are kept per day in `site/data/validation.json`. To commit a day anyway, run the workflow with **ignore_checks**.

```bash
python -m pipeline.validate --all --no-fail   # re-check every day
```

### One-time setup

1. Register for the ERCOT Public API at https://apiexplorer.ercot.com and subscribe to the public reports product.
2. In this repository go to **Settings → Secrets and variables → Actions → New repository secret** and add:
   - `ERCOT_API_USERNAME`: the email you registered with
   - `ERCOT_API_PASSWORD`: that account's password
   - `ERCOT_API_SUBSCRIPTION_KEY`: your primary subscription key
3. Run the workflow once from the **Actions** tab (**Update ERCOT data → Run workflow**) to check it works.

### Loading history

From the Actions tab, run **Update ERCOT data** with a backfill start and end date (operating days). Each run processes up to `max_files` reports per report type; run it again to continue. Locally:

```bash
python -m pipeline.update --backfill 2026-07-01 2026-07-31
```

## Viewing the dashboard

The dashboard is a static page in `site/`; it needs no server-side code.

- **Locally:** `python -m http.server -d site 8000`, then open http://localhost:8000.
- **GitHub Pages:** set Pages source to "GitHub Actions" and add a repository *variable* `ENABLE_PAGES` = `true`. The workflow then publishes the site after every data update. (GitHub Pages on a private repository requires a paid GitHub plan; on a public repository it is free. The secrets stay private either way.)

## Running the pipeline yourself

```bash
pip install -r requirements.txt
export ERCOT_API_USERNAME=... ERCOT_API_PASSWORD=... ERCOT_API_SUBSCRIPTION_KEY=...
python -m pipeline.update                 # anything posted in the last 4 days
python -m pipeline.update --local *.zip   # report zips downloaded by hand from ercot.com
```

## Layout

```
pipeline/
  config.py        price grid, thresholds, technology groupings
  parse_2day.py    NP3-908-ER  -> hourly curves per technology
  parse_60day.py   NP3-965-ER  -> hourly curves, statistics, per-unit summary
  parse_dam.py     NP3-966-ER  -> per-unit day-ahead offers, costs, awards and prices (data/dam/)
  parse_prices.py  NP6-322-CD, NP6-905-CD -> lambda and hub/zone prices (data/prices/), hourly
                   resource-node prices (data branch nodes/)
  nodes.py         per-unit day files + node prices + DAM settlement points -> wind and solar
                   curtailment priced at each unit's node, split congestion / oversupply (no downloads)
  gas.py           EIA API -> Henry Hub daily spot price (data/gas.json.gz)
  econ.py          per-unit day files + node prices + DAM awards and offers -> daily revenue and
                   offer-implied cost per unit (data/econ/<tech>.json.gz, no downloads)
  marginal.py      day files + prices -> hourly marginal MW by technology (no downloads)
  trends.py        per-unit day files -> daily trends, starts, flips, bidding changes (no downloads)
  intraday.py      per-unit day files -> thermal output at/above minimum in cheap hours, off spells
  stayon.py        per-unit day files + DAM costs -> what riding through a cheap stretch cost each
                   thermal unit against a shutdown and restart (no downloads)
                   (shutdowns, two-shifting), hourly state per unit (no downloads)
  ercot_api.py     ERCOT Public API client (token, archive listing, downloads)
  update.py        command line entry point
site/
  index.html, app.js, trends.html, trends.js, economics.html, economics.js, style.css, vendor/d3.min.js
  data/            generated: index.json, summary_*.json.gz, marginal_*.json.gz, 2d/, 60d/, dam/, prices/,
                   curtail_nodes.json.gz, gas.json.gz
```

### Day-ahead offers and costs

`pipeline/parse_dam.py` keeps, for every generation resource and operating day, the DAM three-part offer as submitted (energy offer curve by hour, hot / intermediate / cold start-up cost in $ per start, minimum-energy cost in $/MWh), the DAM resource status, the energy award, the unit's settlement point with the day-ahead price there, and ancillary service awards with their clearing prices. Only the generation resource file of the DAM disclosure is read; energy-only offers, PTP obligations and load resources are not.

`pipeline/stayon.py` puts those costs against the real-time data: for every stretch of hours with system lambda below $0 or $10, each thermal unit that ran through it is scored on what its output earned at lambda, what it cost at the unit's minimum-energy price, and what a shutdown and restart would have cost instead (hot start for stretches up to 8 hours, intermediate up to 24, cold beyond). Units with no three-part offer that day use their own most recent one within 10 days, or a generic per-technology value from `pipeline/config.py`, and are marked as such. Submitted costs are capped by ERCOT's cost verification rules, so they are an upper bound on cost, and lambda is the system price rather than the unit's node price.

### Curtailment at the node

`pipeline/nodes.py` prices every curtailed wind and solar unit-hour (hourly HSL minus base point, from the per-unit day files) at the unit's own resource node. Units are matched to settlement points through the DAM disclosure, since the SCED file carries none. Curtailment in an hour where ERCOT's "HDL and LDL Manual Override Summary" (part of the same 60-day zip) shows an operator lowering the unit's HDL counts as **operator-directed**, up to that reduction; the rest counts as **congestion** when the node price is at least $5/MWh below system lambda (the energy was worth less where the unit sits) and as **oversupply** otherwise (the system as a whole did not want it at the unit's offer). The split is by price, so it describes what the energy was worth at the node, not which constraint SCED was managing. Node prices are fetched a few days per run for days that have per-unit data, newest first, so the split fills in over several runs (or at once with a backfill run).

### Plant economics

`pipeline/econ.py` writes, for every unit and loaded day, the energy produced, its value at the unit's node and at system lambda, the DAM energy award and its value at the day-ahead and real-time prices (so two-settlement revenue can be formed), ancillary service awards at their clearing prices, the cost implied by the unit's own DAM energy offer curve up to its output, its minimum-energy and start-up offers, starts and hours run. Combined-cycle configurations are summed into their train. The page `economics.html` turns that into revenue, cost and margin on a cost basis chosen there: the EIA average tested heat rate for the technology (Electric Power Annual table 8.2) times Henry Hub plus an adder, the unit's own DAM offer, or generic per-technology inputs that can be edited on the page. Fixed costs are not included, so margin is the contribution to them.

## Caveats

- Hours are hour-beginning in Central prevailing time, labelled as hour ending (HE 1 = 00:00–01:00). On the fall daylight-saving day the repeated hour is averaged into one.
- The 2-day "non-IRR" curve combines all thermal, hydro and other non-wind, non-solar resources; only the 60-day data separates them.
- Resource types not listed in `pipeline/config.py` are grouped as "Other"; the pipeline prints any it sees.
- ERCOT market design changed in December 2025 (real-time co-optimization). Storage curves before and after that date are not directly comparable.

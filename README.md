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
| SCED System Lambda | NP6-322-CD | real time | System energy price for each SCED run |
| Settlement Point Prices | NP6-905-CD | real time | 15-minute prices at hubs and load zones |

All curves are stored as hourly averages of the SCED runs in each hour, on a price grid with $1 steps from −$250 to $150 and coarser steps above.

### Two versions of the 60-day curves

- **As used in SCED** (`SCED1 Curve`): the submitted curve after ERCOT extends or truncates it to the unit's operating limits. Minimum output (LSL) is placed at −$250, and units with no offer curve are dispatched against a proxy curve with their output schedule at −$249.99.
- **As submitted** (`Submitted TPO`): the price/quantity pairs the QSE actually submitted. Units with no submitted curve contribute nothing here; the "No submitted offer" column shows how much capacity that is.

Both versions are capped at each unit's high sustainable limit (HSL) for the SCED run, so wind and solar curves reflect available output, not nameplate. Storage curves run from charging (negative MW) to discharging.

## How it updates

`.github/workflows/update.yml` runs twice a day. It calls the ERCOT Public API for any reports posted in the last few days, processes them into `site/data/`, and commits the result. Each day adds roughly 50 KB of 2-day data and 150 KB of 60-day data.

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
  parse_prices.py  NP6-322-CD, NP6-905-CD -> lambda and hub/zone prices
  marginal.py      day files + prices -> hourly marginal MW by technology (no downloads)
  ercot_api.py     ERCOT Public API client (token, archive listing, downloads)
  update.py        command line entry point
site/
  index.html, app.js, style.css, vendor/d3.min.js
  data/            generated: index.json, summary_*.json.gz, marginal_*.json.gz, 2d/, 60d/, prices/
```

## Caveats

- Hours are hour-beginning in Central prevailing time, labelled as hour ending (HE 1 = 00:00–01:00). On the fall daylight-saving day the repeated hour is averaged into one.
- The 2-day "non-IRR" curve combines all thermal, hydro and other non-wind, non-solar resources; only the 60-day data separates them.
- Resource types not listed in `pipeline/config.py` are grouped as "Other"; the pipeline prints any it sees.
- ERCOT market design changed in December 2025 (real-time co-optimization). Storage curves before and after that date are not directly comparable.

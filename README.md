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
| 60-Day DAM Disclosure | NP3-966-ER | 60 days | Every generation resource's day-ahead three-part offer (energy curve, start-up costs, minimum-energy cost), its day-ahead energy and ancillary service awards, its settlement point and the day-ahead price there; from the RTC+B start (Dec 6, 2025) the same for every battery from the ESR Data file (a charging award is negative MW). The ESR AS Offers file is not read |
| SCED System Lambda | NP6-322-CD | real time | System energy price for each SCED run |
| Settlement Point Prices | NP6-905-CD | real time | 15-minute prices at hubs and load zones; hourly prices at every resource node (kept on the data branch, for days with per-unit data) |
| DAM Settlement Point Prices | NP4-190-CD | day ahead | Hourly day-ahead prices at hubs and load zones, for the hedge signals page (history can be loaded from the yearly NP4-180-ER workbook), and at thermal resource nodes for the last two weeks, for tomorrow's shutdown verdicts |
| Wind and solar power production, hourly averaged actual and forecasted | NP4-732-CD, NP4-737-CD | hourly | ERCOT's short-term wind and solar forecasts (STWPF, STPPF), system-wide: the available wind and solar in the Overview's forecast (the posting in force when the day-ahead market cleared), and the hourly actuals for reconciliation |
| Resource Decision-Making Entity List | NP3-988-ER | daily | Each resource's decision-making entity (who decides how it is offered) and owning entity, by name; read from ercot.com (no key) to name the DME codes in the 60-day files |
| Qualified Scheduling Entity List | NP16-474-M | daily | QSE names for the QSE codes in the 60-day files; read from ercot.com (no key). Only name, code and registration date are kept, not the contact columns |
| EIA Henry Hub spot price | RNGWHHD | daily | Natural gas price, $/MMBtu, from the EIA open data API (needs an `EIA_API_KEY` secret; skipped without one) |
| OilPriceAPI regional gas prices | NATURAL_GAS_HSC_USD, NATURAL_GAS_WAHA | daily | Houston Ship Channel and Waha (West Texas) natural gas prices, $/MMBtu (needs an `OILPRICEAPI_KEY` secret, free tier; skipped without one). Their Henry Hub series is not used: it is not the spot price |

All curves are stored as hourly averages of the SCED runs in each hour, on a price grid with $1 steps from −$250 to $150 and coarser steps above.

### Two versions of the 60-day curves

- **As used in SCED** (`SCED2 Curve`): the submitted curve after ERCOT extends or truncates it to the unit's operating limits (`SCED1 Curve`) and then mitigates it where the unit can relieve a non-competitive constraint, i.e. the curve SCED dispatched against. Minimum output (LSL) is placed at −$250, and units with no offer curve are dispatched against a proxy curve with their output schedule at −$249.99. Days processed before SCED2 was read (unit file format below 6) use SCED1, which differs only on the rare mitigated runs.
- **As submitted** (`Submitted TPO`): the price/quantity pairs the QSE actually submitted. Units with no submitted curve contribute nothing here; the "No submitted offer" column shows how much capacity that is.

Both versions are capped at each unit's high sustainable limit (HSL) for the SCED run, so wind and solar curves reflect available output, not nameplate. Storage curves run from charging (negative MW) to discharging.

SCED can only move a unit between its LSL and HSL, so the part of a curve below minimum output never sets dispatch or price. The technology curves keep it (it is the MW that stays on at any price), and each 60-day day file also carries a **dispatchable** version of both curves with every online unit's LSL taken out (`pipeline/dispatchable.py`; written by the parser for new days and filled in for history from the per-unit files, no download needed). The Day page's marginal supply and marginal offer stack, the Trends marginal supply by settled price and the thermal offer-price quantiles read that version, so minimum output that ERCOT prices at −$20 no longer shows as marginal. The Offer curves chart draws each technology from LSL by default (online LSL plus the MW offered above it, so the curve runs flat at minimum output and rises with the bids), with "As ERCOT prices it" for the curves as SCED sees them. The unit-level offer metrics read the submitted curve from LSL up: the share offered at or below $0 is of the dispatchable range (HSL − LSL), and a unit's first offer price above $0 is the first submitted point at or above LSL. Many curves run from 0 MW at −$250 to the unit's price at HSL, which would otherwise count MW "at or below $0" by interpolation alone.

## How it updates

`.github/workflows/update.yml` runs twice a day. It calls the ERCOT Public API for any reports posted in the last few days, processes them into `site/data/`, and commits the result. Each day adds roughly 50 KB of 2-day data and 150 KB of 60-day data.

### Accuracy checks

After processing, `pipeline/validate.py` checks every new or changed operating day: the wind, solar and storage curves rebuilt from 60-day unit data against ERCOT's 2-day aggregate curves, thermal base points against the 2-day generation summary, the 2-day fit's residual and its fitted curve against the 2-day curve, battery charging and discharging rebuilt from the per-unit base points against the summary's ESR series (with each battery's DAM awards against its limits and its state of charge against its window), curves and base points against online HSL, SCED runs per hour (allowing for DST), system lambda against the hub average, and status codes and resource types the pipeline does not know. A new error stops the run before anything is committed (an error already recorded for that day, from a run committed with **ignore_checks**, does not block a later re-check); warnings appear on the run summary. Results that did not pass are kept per day in `site/data/validation.json`. To commit a day anyway, run the workflow with **ignore_checks**.

At the end of every normal run, even one that failed, `pipeline/freshness.py` checks that each input is still arriving: its newest day against its usual lag (two days for the 2-day reports and real-time prices, sixty for the 60-day disclosure, tomorrow for the DAM results after 14:00 Central, three trading days for the gas hubs). A fetch that fails only warns and keeps the stored data, so this is what notices a source that has stopped. It writes `site/data/freshness.json` and keeps one GitHub issue, labelled `stale-data`, open while anything is behind: a comment when another source goes stale, and closed by itself once everything has caught up. It never fails the run.

```bash
python -m pipeline.validate --all --no-fail   # re-check every day
```

### One-time setup

1. Register for the ERCOT Public API at https://apiexplorer.ercot.com and subscribe to the public reports product.
2. In this repository go to **Settings → Secrets and variables → Actions → New repository secret** and add:
   - `ERCOT_API_USERNAME`: the email you registered with
   - `ERCOT_API_PASSWORD`: that account's password
   - `ERCOT_API_SUBSCRIPTION_KEY`: your primary subscription key
3. Optional, recommended: keep a copy of every ERCOT file downloaded, so a reparse reads it from there instead of downloading it from ERCOT again (`pipeline/raw_store.py`). Create a private Cloudflare R2 bucket named `ercot-raw` and an R2 API token with Object Read & Write on that bucket only, then add the secrets `R2_ENDPOINT` (`https://<account id>.r2.cloudflarestorage.com`), `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`. Without them the pipeline downloads from ERCOT as before.
4. Run the workflow once from the **Actions** tab (**Update ERCOT data → Run workflow**) to check it works.

Subscriber emails (optional): the Unit page's Subscribe box signs people up with the follow server in `worker/`, a free Cloudflare Worker that confirms each follow by email and keeps the list in a D1 database; the daily send emails each follower through [Resend](https://resend.com). Setup, once: add the repository secrets `CLOUDFLARE_API_TOKEN` (a Cloudflare API token with Workers Scripts: Edit, D1: Edit and Account Settings: Read), `RESEND_API_KEY` (with your sending domain verified in Resend) and `OWNER_EMAIL` (gets a daily digest of what went out), then run **Deploy the follow server** in the Actions tab; it creates the database, deploys the Worker and writes its address to `site/follow.json`. Set a repository *variable* `NOTIFY_DRY_RUN` = `1` to see the emails on the run summary without sending them; **Subscriber emails (manual)** in the Actions tab does the same by hand.

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
  parse_dam.py     NP3-966-ER  -> per-unit day-ahead offers, costs, awards and prices (data/dam/),
                   generation resources and, from RTC+B, batteries (the DAM ESR Data file)
  parse_prices.py  NP6-322-CD, NP6-905-CD -> lambda and hub/zone prices (data/prices/), hourly
                   resource-node prices (data branch nodes/)
  nodes.py         per-unit day files + node prices + DAM settlement points -> wind and solar
                   curtailment priced at each unit's node, split congestion / oversupply (no downloads)
  marginal_nodes.py per-unit day files -> units on the interior of their offer curve, the
                   price that implies, and how it sits against lambda (no downloads)
  gas.py           EIA API -> Henry Hub daily spot price (data/gas.json.gz); OilPriceAPI -> Houston
                   Ship Channel and Waha daily prices (data/gas_hubs.json.gz)
  fuel_hub.py      trends + DAM offers + node prices + gas hubs -> which gas price each gas unit
                   buys at, Waha or Houston Ship Channel (data/fuel_hubs.json.gz, no downloads)
  econ.py          per-unit day files + node prices + DAM awards and offers -> daily revenue and
                   offer-implied cost per unit (data/econ/<tech>.json.gz, no downloads)
  dispatchable.py  per-unit day files -> "dispatchable" curves (LSL taken out) in the 60-day day files (no downloads)
  marginal.py      day files + prices -> hourly marginal MW by technology (no downloads)
  dam_prices.py    NP4-190-CD (or the yearly NP4-180-ER workbook) -> day-ahead hub and load zone prices
                   (data/dam_hubs.json.gz); thermal node prices for the last two weeks (data/dam_nodes.json.gz)
  ppa.py           per-unit day files + DA prices -> wind and solar offers that follow
                   share x DA price - constant: settlement point, share, implied strike (data/ppa.json.gz)
  renew_changes.py ppa cache + DAM day files + node prices (and the history release) -> every change in
                   how each wind and solar unit bids, and whether it moved dispatch (data/renew_changes.json.gz,
                   data/renew/, no downloads)
  dam_offers.py    DAM day files + gas hubs + fuel hubs + renew_changes signatures -> each unit's day-ahead
                   three-part offer against its fuel cost, offer changes, fleet series and the train
                   table for the Day-ahead offers page (data/dam_offers.json.gz, data/dam_offers/, no downloads)
  offtakers.py     pipeline/reference/offtakers.csv (buyers named in public announcements, with
                   source and quote, curated by hand and refreshed about quarterly) -> data/offtakers.json.gz
                   for the Unit page's "Public contracts" box and the hedge table (no downloads)
  series.py        per-unit day files + node prices + DAM awards -> hourly HSL, base point, output,
                   offer prices, award and node prices per unit, by month and technology, for the
                   graph builder (data/series/, no downloads)
  storage.py       per-unit day files + DAM day files -> one battery day file per 60-day day
                   (data/storage/): fleet and per-battery charging, discharging, limits, headroom,
                   state of charge, AS awards and capability, DAM energy and AS awards, and the
                   offer prices from the submitted curves (where discharge starts, where charging
                   stops, MW bid to charge and offered to discharge at set prices); plus
                   data/storage/series.json.gz, every day's fleet block for date-range charts,
                   and units.json.gz, one row a day per battery for the Unit page and the
                   battery events (no downloads)
  trends.py        per-unit day files -> daily trends, starts, bidding changes (no downloads)
  events.py        decisions, groups, trends, renew_changes, dam_offers, cutoff_history and the battery
                   daily rows -> one list of unit
                   events in one format with the run that first found each (data/events.json.gz)
                   and Atom feeds per unit (data/feeds/, no downloads)
  unit_index.py    trends, decisions, the latest forecast, ppa and econ -> every unit the Unit page
                   can open, with technology, group, capacity, settlement point and combined-cycle
                   configurations, CDR name, county and zone, and QSE (data/unit_index.json.gz), for
                   the Units directory and the nav row's "Find a unit" box (no downloads)
  cdr.py           ERCOT's Capacity, Demand and Reserves report -> pipeline/reference/cdr_units.csv,
                   the plant names the unit index matches on (python -m pipeline.cdr <workbook.xlsx>
                   when a new report comes out, twice a year; needs openpyxl)
                   pipeline/reference/unit_aliases.csv: other names a unit goes by (a developer's
                   project name), one row per unit and name, edited by hand; search finds them
  qse.py           the QSE and DME columns of the 60-day SCED, ESR and DAM files, where they
                   carry them -> data/unit_qse.json.gz (latest pair per unit and a dated history
                   of changes); the run summary says which files had them
  entities.py      ERCOT's daily DME list (NP3-988-ER) and QSE list (NP16-474-M) from ercot.com
                   -> data/entities.json.gz: names for the QSE and DME codes, each resource's
                   owner; the unit index carries qse_name, dme and owner from it
  notify.py        events -> one email a day through Resend to each person who follows a unit
                   that changed, follows read from the follow server's database (needs the
                   RESEND_API_KEY and CLOUDFLARE_API_TOKEN secrets; a dry run without them);
                   data/notify_sent.json records what went out
  intraday.py      per-unit day files -> thermal output at/above minimum in cheap hours, off spells
  unit_hours_day.py per-unit day files -> each unit's hourly rows for the Day page's Units table (data/60d-units/)
  stayon.py        per-unit day files + DAM costs -> what riding through a cheap stretch cost each
                   thermal unit against a shutdown and restart (no downloads)
  renew_forecast.py NP4-732-CD, NP4-737-CD -> ERCOT's wind and solar forecasts for the days ahead
                   (data/renew_forecast.json.gz)
  forecast/        the Overview's forecast files (data/forecast/<date>.json.gz, index, scores): one
                   file per operating day in a fixed schema, written from the models below and read
                   by the page, which does sums and shares only.  context.py gathers what was known
                   when the day-ahead market cleared (prices, units, 60-day-old states, curve
                   snapshots on the data branch), build.py assembles a day, score.py scores every
                   day against the 2-day and 60-day answers, benchmark.py holds the fixed 30-day set
                   a model version must beat (python -m pipeline.forecast, python -m
                   pipeline.forecast.benchmark); groups.py ports the timescale groups
  models/          one module per model, each with NAME, VERSION and forecast(date, ctx):
                   thermal_cutoff (commitment on the stay-on loss at the node against the unit's
                   own cutoff), thermal_dispatch (the committed set's offer curves met by the hourly
                   day-ahead price), peaker_share (combustion turbines by price level and hour),
                   renewable_floor (wind and solar forecast less what prices itself out at its
                   node), storage_habit (the battery fleet's discharging and charging by hour from
                   its recent habit, nudged by the day's hub price shape; python -m
                   pipeline.models.storage_habit --backtest prints how the rule has done);
                   cutoff_history refits each thermal unit's cutoff at every month end on its
                   last 30 decisions and records the months it moved (data/cutoff_history.json.gz;
                   python -m pipeline.models.cutoff_history --benchmark prints how the moves held up)
                   two_day_fit (the 2-day fit, plan layer 2: the committed set inferred from the 2-day
                   thermal curve two days after the day, by unit, combined-cycle configuration and the
                   peaker fleet's hourly share; data/fit/<date>.json.gz, scored beside the forecast)
  decisions.py     hourly unit states + DAM node prices, costs and awards -> each thermal unit's
                   shutdown decisions day by day, its loss cutoff, and tomorrow's expected
                   turn-offs from the day-ahead node prices (no downloads)
                   (shutdowns, two-shifting), hourly state per unit (no downloads)
  hourly_context.py 60-day summary + prices -> hourly wind, solar, storage and hub price for the
                   Trends page's leanest thermal hours table (no downloads)
  guide.py         one example day's per-unit file -> data/guide.json.gz, the worked examples on
                   the How offers work page (run by hand, not by the workflow)
  ercot_api.py     ERCOT Public API client (token, archive listing, downloads)
  update.py        command line entry point
site/
  index.html, overview.js (the Overview and landing page: the forecast files rendered, with the day
                   drill-down; overview.html redirects here),
  commitment.html, commitment.js (which thermal units stay on when power is cheap: the cutoff curve
                   from the day's forecast file, groups and cutoffs, the forecast against the 2-day fit and
                   the 60-day answer, and the thermal panels lifted from Trends, plus what riding through
                   cheap stretches cost from data/stayon_60d.json.gz and one row per unit),
  beyond.html, renewables.html, fleet.html, unit.html, builder.html and their scripts
                   (unit.html with no unit shows the Units directory, unit-dir.js; common.js adds
                   the "Find a unit" box to every page's nav row),
  guide.html, guide.js (How offers work, including how revenue is counted and how hedge signals are found),
  trends.html, day.html, economics.html, contracts.html
                   (retired pages, kept as redirects to commitment.html, beyond.html, fleet.html
                   and renewables.html#hedge so old links still open),
  style.css, vendor/d3.min.js
  data/            generated: index.json, summary_*.json.gz, marginal_*.json.gz, 2d/, 60d/, dam/, prices/,
                   curtail_nodes.json.gz, marginal_nodes.json.gz, gas.json.gz, gas_hubs.json.gz,
                   series/, storage/, forecast/, fit/
  follow.json      the follow server's address (written by Deploy the follow server)
  unit/            one link-preview page per unit (pipeline/share_pages.py): the unit's title, description
                   and Open Graph tags, and a redirect to unit.html?unit=NAME. Served at /unit/NAME
  share-card.png   the image every page's link preview shows
worker/            the follow server: a Cloudflare Worker (src/index.js) that signs people up for a
                   unit's emails, confirms them and unsubscribes them; schema.sql is its D1 database
```

### Page titles and link previews

Every page carries a title in the form "Page · ERCOT Bids", a description and Open Graph / Twitter card tags with `share-card.png`, so links preview with a name, a line about the page and an image. Chat and social apps read those tags from the HTML a link returns, without running scripts, and GitHub Pages serves the same `unit.html` whatever its `?unit=` query says, so a unit's own preview comes from `site/unit/<NAME>.html`, a 1.5 KB stub with that unit's title (CDR plant name, resource name, technology and MW) that sends the browser on to the Unit page. The Unit page then shows `/unit/<NAME>` in the address bar, so a copied or shared link previews with the unit's name; a `<base>` element in `unit.html` keeps its relative URLs pointing at the site root. The update writes a stub only for a new unit or one whose name, technology, county or zone changed, or whose capacity moved by more than 10%, and commits it with the data; stubs of units that leave the index stay, so links already sent keep working. Old `unit.html?unit=NAME` links still open, with the generic Units preview.

### Day-ahead offers and costs

`pipeline/parse_dam.py` keeps, for every generation resource and operating day, the DAM three-part offer as submitted (energy offer curve by hour, hot / intermediate / cold start-up cost in $ per start, minimum-energy cost in $/MWh), the DAM resource status, the energy award, the unit's settlement point with the day-ahead price there, and ancillary service awards with their clearing prices. Only the generation resource file of the DAM disclosure is read; energy-only offers, PTP obligations and load resources are not.

`pipeline/stayon.py` puts those costs against the real-time data: for every stretch of hours with system lambda below $0 or $10, each thermal unit that ran through it is scored on what its output earned at lambda, what it cost at the unit's minimum-energy price, and what a shutdown and restart would have cost instead (hot start for stretches up to 8 hours, intermediate up to 24, cold beyond). Units with no three-part offer that day use their own most recent one within 10 days, or a generic per-technology value from `pipeline/config.py`, and are marked as such. Submitted costs are capped by ERCOT's cost verification rules, so they are an upper bound on cost, and lambda is the system price rather than the unit's node price.

`pipeline/decisions.py` scores the decision as the unit could have made it when the day-ahead market cleared: for every day a thermal unit started online, the worst contiguous window of (minimum-energy cost − day-ahead price at its own node) × LSL is what riding through would lose, before any start cost; whether its DAM energy award covered that window; and whether it shut down for at least 4 hours. A unit with enough history gets a cutoff, the loss that best separates its shutdowns from its stays on days without an award, and the rule "off when no award covers the window and the loss exceeds the cutoff" is scored against its commoner outcome. Day-ahead node prices for tomorrow are public the afternoon before (NP4-190-CD, kept for thermal nodes in `data/dam_nodes.json.gz`), so the same arithmetic with each unit's latest costs gives the units expected to turn off tomorrow; the award is not known until the disclosure, so the verdict leans on how often the unit has held one. Each day's verdicts are kept and scored once its 60-day data arrives. Shutdowns that break a unit's pattern are flagged: the first after 30 days or more without one, or one over a window its award covered in full.

### Curtailment at the node

`pipeline/nodes.py` prices every curtailed wind and solar unit-hour (hourly HSL minus base point, from the per-unit day files) at the unit's own resource node. Units are matched to settlement points through the DAM disclosure, since the SCED file carries none. Curtailment in an hour where ERCOT's "HDL and LDL Manual Override Summary" (part of the same 60-day zip) shows an operator lowering the unit's HDL counts as **operator-directed**, up to that reduction; the rest counts as **congestion** when the node price is at least $5/MWh below system lambda (the energy was worth less where the unit sits) and as **oversupply** otherwise (the system as a whole did not want it at the unit's offer). The split is by price, so it describes what the energy was worth at the node, not which constraint SCED was managing. Node prices are fetched a few days per run for days that have per-unit data, newest first, so the split fills in over several runs (or at once with a backfill run).

### Marginality at the node

`pipeline/marginal_nodes.py` finds, for every unit and SCED run, whether SCED dispatched it to the interior of its own offer curve (SCED2 from format 6, the submitted curve before): base point strictly inside the ramp-limited range it had that run (LDL to HDL, within LSL and HSL) on a segment with some width rather than a vertical step. A unit climbing at its ramp rate sits at HDL and is pinned, not marginal. The curve's price at the base point is the price SCED saw at the unit's node, so each marginal run carries an implied LMP. Against that run's system lambda the unit is **at lambda** (within $2 or 5%: setting the system price), **below** (behind an export constraint; wind and solar at negative prices are the usual case) or **above** (its node dearer than the system). The per-unit day files carry the base point, HDL and LDL of every run from format 4 on (`pipeline/units.py`); for older files the hourly mean base point stands in, which lets a unit swinging between its limits read as marginal, and storage is skipped. From format 5 the files also carry each run's ancillary service awards (up: Reg-Up, RRS, ECRS, Non-Spin; down: Reg-Down), and the scoring takes them off the HDL-to-LDL range first, except for combustion turbines, where netting made the check against node prices worse. Format 6 adds the SCED2 curve, which the scoring uses in place of the submitted one. Format 7 keeps, for batteries, the state of charge with its minimum and maximum (MWh; in ERCOT's ESR file from the February 2026 postings on) and the AS capability telemetered per service, which `pipeline/storage.py` reads. History stays at its older format until a `reprocess_60d` run redoes it.

Node prices are kept at 15 minutes for every settlement point that is not a hub or load zone (ERCOT files combined-cycle trains under a type other than `RN`); `node_hourly()` gives the hourly means the curtailment and revenue figures use. Node files and per-unit day files carry a format number, and a workflow run with **reprocess_60d** (or the regular node backfill, a few days per run) redoes the older ones.

### Which gas price a unit buys at

`pipeline/fuel_hub.py` assigns every gas-fired unit a fuel hub, Waha (West Texas) or Houston Ship Channel, from two signals. Its own offer prices (first SCED offer price above $0, and DAM minimum-energy offer) are each regressed on the previous trading day's Waha and Houston prices; a series votes for a hub when the better fit explains at least 30% of the variance with a heat rate between 3 and 25 MMBtu/MWh and beats the other hub by 0.1 in R². When the votes agree the offers decide; otherwise the unit's node location does (the ERCOT hub whose real-time price its node tracks most closely: West and Panhandle nodes go to Waha, the rest to Houston). The Economics page uses this for its "By unit" gas price and shows each unit's hub and how it was decided.

### Hedge signals

`pipeline/ppa.py` looks for wind and solar units whose real-time offers follow a contract for differences settled at a day-ahead price on generated energy: offer = share × DA price − constant, hour by hour. For each unit it fits every candidate settlement point (its own node, each hub and load zone) on the days its offer moved with the hour, picks the point whose formula predicts the most hours within $2, and grades the result (revealed, location unclear, partial, hints only). The intercept gives an implied strike range: all strike, or strike plus a per-MWh credit such as the PTC. Everything is inferred from offers; Renewables (hedge signals) and each Unit page show the fits. Hourly offers per day are cached on the data branch under `ppa/`.

### Bidding changes (wind and solar)

`pipeline/renew_changes.py` gives every wind and solar unit-day a signature from its hourly real-time offers: a floor (one offer price most of the day), a day-ahead formula day (as on the hedge signals page, fitted per calendar year), or offers that move within the day, plus its DAM award and curtailed share. A change is a new regime that holds on 6 of the next 7 online days: a floor that moves by $1 or more (new, or back to one held in the previous 90 days), a formula switched on or off, a step in the formula's share or intercept, or offers starting or stopping moving within the day. An episode is 1 to 6 days with a median offer $5 or more from the floor, then back to it (Outpost and Frye in Winter Storm Fern). Units of one plant that change the same way within a day are one event.

Floors between −$60 and −$15 price a per-MWh credit such as the PTC. A floor change inside that band of $5 or less is tagged **PTC level** (re-pricing the credit, as the yearly inflation adjustment does), and a floor that leaves the band for −$5 or higher and never comes back to it is tagged **PTC may have expired** (inferred: the credit runs 10 years from the plant's start, which the data does not give). The page also charts the monthly median of those floors for wind and solar.

Each change is checked for whether it **moved dispatch**: over every online day the unit spent in the new regime, from the change up to its next change and at most a year (or the episode's days), an hour counts when the unit was online and its node price fell between the old and the new offer. Priced up, HSL minus base point is energy given up; priced down, the base point is energy the old offer would not have produced; both are valued at the node price. A change counts as moving dispatch at 1 MWh or more per day of its window; a window still running at the last data day fills in as data arrives. The real-time node price is used where loaded (the live node files, and the history release's `rt-prices-*` files for 2019 on); estimates that fall back to the day-ahead node price for most hours are marked. Most changes never move dispatch (a floor moving from −$37 to −$39 sits below almost every price the node reaches), so the page keeps them all and lets the reader filter.

The regular update rebuilds the loaded 60-day days. Years before that come from the `history` release: run **Build bidding-change history** (manual) once after the release is built, or locally `python -m pipeline.renew_changes --history history/`. Daily signatures are kept per year in `site/data/renew/sig-YYYY.json.gz` for the unit timeline, and moved-dispatch estimates in `site/data/renew/impacts.json.gz`, so the regular update never needs the history files.

### Day-ahead offers

`pipeline/dam_offers.py` reads each unit's three-part offer from the DAM day files: combined cycle configurations, gas steam and combustion turbines, plus the wind and solar units that file a DAM energy curve. A thermal unit's minimum-energy offer is set against a fuel-cost line, EIA's average tested heat rate for natural gas by prime mover (Electric Power Annual, Table 8.2, 2025: combined cycle 7.535, steam 10.293, gas turbine 10.975 MMBtu/MWh, full load) times the gas price at the unit's own hub (`fuel_hub.py`) on the last trading day before the operating day. The implied heat rate is the offer over that gas price, as on the Offers page. On days with cheap hours (DA lambda at or below $15) each unit also gets its cheap-stretch offer (hourly values from DAM format 3 on), its margin (node price less that offer) and whether it was awarded through the stretch. Wind and solar get their DA floor beside their real-time floor from `renew_changes.py`; energy-only offers at the plant's node are not counted, so their day-ahead sales are undercounted.

Changes are held steps of $5 in the minimum-energy offer (tested on the offer, so a gas move alone is not one; major when it crosses the fuel-cost line), price-outs (1 to 6 days $10 or more above the unit's 30-day median), start-cost changes of 25%, a train or unit stopping or starting three-part offers, and wind and solar DA floor steps and filing. Combustion turbine events are never major. Daily signatures are kept per year in `site/data/dam_offers/sig-YYYY.json.gz`.

The **Day-ahead offers** page (`site/dayahead.html`, `dayahead.js`) shows the fleet view: combined cycle trains on each cheap day by their lowest offer and how many were kept on through the stretch, the award rate by offer less node price, the median train offer less fuel cost (kept on at the configuration that won, left out at the lowest), the trains and plants table, the wind and solar DA floor table and the recent major changes. The Unit page's **Day-ahead offer** panel (`unit-dam.js`) charts one unit's offers against its fuel-cost line by configuration, with each configuration's typical LSL, HSL and hot start, or for wind and solar the DA floor against the RT floor and the DA award share.

DAM format 3 adds the hourly start-up and minimum-energy costs. A **reprocess_60d** run fills it in for older days; such runs read the raw store only (`reprocess_store_only`, on by default) and leave a day whose file is not there, since ERCOT's terms limit downloading the same report again.

### Hourly history (2019 on)

`pipeline/history.py` builds a separate, compact history for longer-run analysis of wind and solar behaviour: one row per unit and hour with the real-time offer, HSL, base point, output, operator HDL overrides, DAM award, DAM HSL forecast and node DA price, plus DA hub and load-zone prices. It reads ERCOT's archive directly (the 60-day reports there go back to at least 2016) and never touches `site/data` or the data branch. The **Build hourly history** workflow (manual) builds one month per job and uploads `units-YYYY-MM.parquet` and `da-hubs-YYYY-MM.parquet` to the `history` release; kind `rt` adds `rt-prices-YYYY-MM.parquet`, the hourly real-time price at every settlement point from the 15-minute settlement point prices (NP6-905-CD), which reach back to 2016 in the archive; `gh release download history -D history/` fetches them. Kind `rtas` (Dec 2025 on, `pipeline/rt_as.py`) adds `rt-as-YYYY-MM.parquet` (each resource's AS awards in SCED per 15-minute interval), `rt-mcpc-YYYY-MM.parquet` (real-time MCPCs, NP6-331-CD) and `dam-as-YYYY-MM.parquet` (DAM AS awards of every technology, batteries included), so AS revenue can be priced on both the DAM and the real-time side.

### Hourly unit series

`pipeline/series.py` reduces each 60-day per-unit day file to one value per unit and hour: mean HSL while online, base point, telemetered output, three readings of the submitted offer curve (its first price, the price at half its MW, and the price it puts on the base point, each the median over the hour's online runs), MW taken off HDL by operator override, the DAM award and the DA price at the unit's settlement point, plus the real-time price at each settlement point. It writes `data/series/YYYY-MM/<tech>.json.gz` and an index of units, read by the graph builder (`builder.html`), for charts of any unit or plant without loading the full day files (about 185 KB a day for all units). Per-day results are cached on the data branch under `series/`, keyed on the sizes of the files they came from, so each update only redoes new or reprocessed days.

`pipeline/battery_bench.py` compares every battery with a perfect battery of the same size: one linear program per battery and day that knows the day's hourly real-time prices at its node in advance, with its own fitted round-trip efficiency, the MW it held for ancillary services taken out, its actual starting and ending state of charge, and at most one full cycle a day. It writes the fleet's daily totals (`data/storage/bench.json.gz`, the Batteries page's across-days charts) and each battery's (`data/storage/bench_units.json.gz`, the Unit page): energy earned (two-settlement), day-ahead AS earned, the perfect battery's energy revenue, and MWh and dollars each way for both. Per-day results are cached on the data branch under `bench/`.

### Plant economics

`pipeline/econ.py` writes, for every unit and loaded day, the energy produced, its value at the unit's node and at system lambda, the DAM energy award and its value at the day-ahead and real-time prices (so two-settlement revenue can be formed), ancillary service awards at their clearing prices, the cost implied by the unit's own DAM energy offer curve up to its output, its minimum-energy and start-up offers, starts and hours run. Combined-cycle configurations are summed into their train. Fleet economics and the Unit page turn that into revenue, cost and margin on a cost basis chosen there: the EIA average tested heat rate for the technology (Electric Power Annual table 8.2) times a gas price (each unit's own fuel hub by default, see below, or Houston Ship Channel, Waha or Henry Hub for all) plus an adder, the unit's own DAM offer, or generic per-technology inputs that can be edited on the page. Fixed costs are not included, so margin is the contribution to them. Capacity factor divides output by a capacity taken from the SCED data: the 95th percentile, over the loaded days, of each day's highest HSL (for a combined-cycle train, across its configurations). Wind and solar HSL is weather-limited available output, so a typical HSL would measure output against availability; the daily peak reaches the rating on windy or clear days.

## Caveats

- Hours are hour-beginning in Central prevailing time, labelled as hour ending (HE 1 = 00:00–01:00). On the fall daylight-saving day the repeated hour is averaged into one.
- The 2-day "non-IRR" curve combines all thermal, hydro and other non-wind, non-solar resources; only the 60-day data separates them.
- Resource types not listed in `pipeline/config.py` are grouped as "Other"; the pipeline prints any it sees.
- ERCOT market design changed in December 2025 (real-time co-optimization). Storage curves before and after that date are not directly comparable.

## Copyright

© 2026 CurrentTech Energy. All rights reserved. This repository is public so the site can be built and checked, but no license is granted to copy, modify or redistribute its code, pages or derived data. See the site's [Terms and privacy](https://ercotbids.currenttech.energy/terms.html) page. ERCOT's own reports are public and available from ERCOT.

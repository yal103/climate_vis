# When does the world cross 2°C?

An interactive visualization of CMIP6 climate model projections that shows *when* — and *where* — different parts of the world cross critical warming thresholds under different emissions scenarios.

**DSC 106 · Project 3 · Spring 2026**

---

## What this is

Global warming isn't uniform. The Arctic heats up several times faster than the tropics. Continents warm faster than oceans. And whether a region crosses 1.5°C in 2035 or never crosses 4°C at all depends heavily on what humans choose to emit over the next few decades.

This project makes that geography tangible. You can explore how warming spreads across the globe under three futures — aggressive mitigation (SSP1-2.6), middle-of-the-road policy (SSP2-4.5), or fossil-fuel-heavy growth (SSP5-8.5) — and pick any threshold from 1.5°C to 4°C to see when each region hits it.

The data comes from CESM2, one of the flagship models in the CMIP6 ensemble, downloaded from Google Cloud's public CMIP6 archive.

---

## What you can do with it

- **Switch scenarios** to see how much the choice of emissions pathway changes the timeline
- **Change the threshold** (1.5°C, 2°C, 3°C, 4°C) and watch the map repaint
- **Click any grid cell** to pull up that location's full warming trajectory
- **Pick a named region** (Arctic, Amazon, South Asia, etc.) to compare regional warming curves
- **Toggle to anomaly mode** and scrub through years to watch warming spread across the globe in real time
- **Hover** anywhere for lat/lon coordinates, crossing year, and 2100 projection

---

## How to run it locally

```bash
cd climate_visualization
python3 -m http.server 8000
# open http://localhost:8000
```

No build step. No npm. Just a static file server.

---

## Project structure

```
climate_visualization/
├── index.html              # the page
├── css/style.css           # all styles
├── js/app.js               # all visualization logic (~1000 lines, pure D3 v7)
├── data/
│   ├── grid.json           # lat/lon arrays, years, scenario/threshold metadata
│   ├── crossings.json      # first-crossing-year per cell (scenario × threshold)
│   ├── timeseries.bin      # full anomaly grid as binary int16 (~5 MB)
│   ├── global_means.json   # area-weighted global mean per scenario
│   └── regional_means.json # area-weighted means for named regions
├── generate_data.py        # data pipeline: reads .npy files, writes data/
└── project-3.ipynb         # CMIP6 data acquisition and .npy export
```

---

## Data pipeline

The notebook (`project-3.ipynb`) connects to the CMIP6 Zarr archive on Google Cloud, downloads CESM2 temperature data for all three scenarios, computes annual means, subtracts a 2015–2034 baseline, and saves the anomaly arrays as `.npy` files in `data/`.

`generate_data.py` then takes those `.npy` files, downsamples the grid to roughly 64×96 for web performance, computes first-crossing-year maps and regional aggregates, and writes everything to the `data/` JSON and binary files the visualization reads.

To regenerate the data files after re-running the notebook:

```bash
python3 generate_data.py
```

---

## Tech

Built entirely with D3 v7 — no charting libraries, no frameworks. The map uses `d3.geoEqualEarth` for the projection and manually projects each grid cell as a polygon (rather than using `d3.geoPath` per cell, which produces antimeridian artifacts on some projections). Coastlines come from the Natural Earth world-atlas CDN via topojson-client.

The binary `timeseries.bin` format stores anomaly values as `int16` (×100 fixed-point) to keep the file small enough for a browser fetch. JSON encoding the same data would be roughly 4× larger and significantly slower to parse.

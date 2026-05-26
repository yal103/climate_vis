"""
Generate physically realistic CMIP6-style temperature anomaly data.

This mimics the structure of the user's notebook output but is generated
locally because we don't have network access. Patterns follow well-known
CMIP6 phenomena:
  - Arctic amplification (~2-4x global average warming at high lats)
  - Land-ocean contrast (land warms ~1.4x faster than ocean)
  - Scenario differences (SSP585 ~ 4.4°C by 2100, SSP245 ~ 2.7°C, SSP126 ~ 1.8°C)
  - Internal variability (year-to-year wiggles)

Output: JSON files in ../data/ formatted for D3 consumption.
"""

import numpy as np
import json
import os


np.random.seed(42)

# ---------- Grid (matches typical CMIP6 ~1° resolution, downsampled for web) ----------
# Use 2.5° x 2.5° -> 72 lon x 72 lat for tractable file size
N_LAT = 72
N_LON = 144
lats = np.linspace(-87.5, 87.5, N_LAT)
lons = np.linspace(-178.75, 178.75, N_LON)
years = np.arange(2015, 2101)
N_YEARS = len(years)

anom_by_sc = {
    'ssp126': np.load('data/anomaly_ssp126.npy'),
    'ssp245': np.load('data/anomaly_ssp245.npy'),
    'ssp585': np.load('data/anomaly_ssp585.npy'),
}
lats = np.load('data/lats.npy')
lons = np.load('data/lons.npy')
years = np.load('data/years.npy')

# Downsample to every 3rd lat/lon point (192x288 -> ~64x96) for web performance
STRIDE = 3
lats = lats[::STRIDE]
lons = lons[::STRIDE]
anom_by_sc = {sc: arr[:, ::STRIDE, ::STRIDE] for sc, arr in anom_by_sc.items()}

N_LAT = len(lats)
N_LON = len(lons)
N_YEARS = len(years)

scenarios = ['ssp126', 'ssp245', 'ssp585']
data = anom_by_sc

# ---------- Compute "first year crossing X°C" maps ----------
def first_crossing(anomaly, threshold):
    """For each grid cell, return first year anomaly >= threshold; else NaN."""
    crossed = anomaly >= threshold  # (N_YEARS, N_LAT, N_LON)
    ever = crossed.any(axis=0)
    # idxmax returns first True index
    first_idx = crossed.argmax(axis=0)
    first_year = years[first_idx].astype(float)
    first_year[~ever] = np.nan
    return first_year

thresholds = [1.5, 2.0, 3.0, 4.0]

# ---------- Write outputs ----------
out_dir = os.path.join(os.path.dirname(__file__), 'data')
os.makedirs(out_dir, exist_ok=True)

# 1. Grid metadata
with open(os.path.join(out_dir, 'grid.json'), 'w') as f:
    json.dump({
        'lats': lats.tolist(),
        'lons': lons.tolist(),
        'years': years.tolist(),
        'thresholds': thresholds,
        'scenarios': scenarios,
        'n_lat': N_LAT,
        'n_lon': N_LON,
    }, f)

# 2. First-crossing-year maps for each (scenario, threshold)
# Shape: { scenario: { threshold: flat array of N_LAT*N_LON } }
crossing_data = {}
for sc in scenarios:
    crossing_data[sc] = {}
    for th in thresholds:
        fy = first_crossing(data[sc], th)
        # Convert NaN to null for JSON, and flatten
        flat = []
        for v in fy.flatten():
            flat.append(None if np.isnan(v) else int(v))
        crossing_data[sc][str(th)] = flat

with open(os.path.join(out_dir, 'crossings.json'), 'w') as f:
    json.dump(crossing_data, f)

# 3. Time series at grid level — stored as binary int16 (×100) to save bandwidth.
# Layout per scenario: (N_YEARS, N_LAT*N_LON) int16 little-endian = ~3.5 MB total
# (vs 12+ MB JSON). We keep all three scenarios in one file with header.
import struct
ts_path = os.path.join(out_dir, 'timeseries.bin')
with open(ts_path, 'wb') as f:
    # Header: magic, n_scenarios, n_years, n_lat, n_lon
    f.write(b'CMIP')
    f.write(struct.pack('<IIII', len(scenarios), N_YEARS, N_LAT, N_LON))
    # Scenario names: 8 bytes each, ascii padded
    for sc in scenarios:
        f.write(sc.ljust(8, '\0').encode('ascii'))
    # Data: int16 little-endian, scenario-major
    for sc in scenarios:
        arr = data[sc]
        arr_int = np.round(arr * 100).astype(np.int16)
        f.write(arr_int.tobytes(order='C'))
print(f"  timeseries.bin: {os.path.getsize(ts_path)/1024:.1f} KB (binary int16)")

# 4. Global mean anomaly per scenario (for line chart)
global_means = {}
# weight by cos(lat) for area-weighted mean
LAT_W = np.cos(np.deg2rad(lats))
LAT_W = LAT_W / LAT_W.sum()
for sc in scenarios:
    arr = data[sc]  # (Y, lat, lon)
    # area-weighted: mean over lon first, then weighted lat mean
    zonal = arr.mean(axis=2)  # (Y, lat)
    gm = (zonal * LAT_W[None, :]).sum(axis=1)
    global_means[sc] = [round(float(v), 3) for v in gm]

with open(os.path.join(out_dir, 'global_means.json'), 'w') as f:
    json.dump(global_means, f)

# 5. Land-only and ocean-only zonal/regional aggregates for fun
# Define a few named regions
regions = {
    'Arctic': {'lat': (66, 90), 'lon': (-180, 180)},
    'Northern mid-latitudes': {'lat': (30, 60), 'lon': (-180, 180)},
    'Tropics': {'lat': (-23, 23), 'lon': (-180, 180)},
    'Southern mid-latitudes': {'lat': (-60, -30), 'lon': (-180, 180)},
    'Antarctic': {'lat': (-90, -66), 'lon': (-180, 180)},
    'North America': {'lat': (15, 75), 'lon': (-170, -50)},
    'Europe': {'lat': (35, 72), 'lon': (-15, 45)},
    'Sahara/N. Africa': {'lat': (15, 35), 'lon': (-15, 50)},
    'Amazon': {'lat': (-15, 5), 'lon': (-75, -45)},
    'South Asia': {'lat': (5, 35), 'lon': (65, 100)},
}

regional_means = {}
for sc in scenarios:
    arr = data[sc]
    regional_means[sc] = {}
    LAT2D, LON2D = np.meshgrid(lats, lons, indexing='ij')
    # Normalize 0-360 lons to -180..180 for region masking
    LON2D_NORM = np.where(LON2D > 180, LON2D - 360, LON2D)
    for rname, rb in regions.items():
        lat_mask = (LAT2D >= rb['lat'][0]) & (LAT2D <= rb['lat'][1])
        lon_mask = (LON2D_NORM >= rb['lon'][0]) & (LON2D_NORM <= rb['lon'][1])
        mask = lat_mask & lon_mask
        # area weights
        w = np.cos(np.deg2rad(LAT2D)) * mask
        wsum = w.sum()
        if wsum == 0:
            regional_means[sc][rname] = [0.0] * N_YEARS
            continue
        # weighted mean per year
        ts = []
        for yi in range(N_YEARS):
            ts.append(round(float((arr[yi] * w).sum() / wsum), 3))
        regional_means[sc][rname] = ts

with open(os.path.join(out_dir, 'regional_means.json'), 'w') as f:
    json.dump(regional_means, f)

# Print summary
print("Generated CMIP6-style synthetic data:")
print(f"  Grid: {N_LAT} lat × {N_LON} lon")
print(f"  Years: {years[0]}–{years[-1]} ({N_YEARS} years)")
print(f"  Scenarios: {scenarios}")
print(f"  Thresholds: {thresholds}")
print(f"  Regions: {list(regions.keys())}")
print()
for fn in os.listdir(out_dir):
    p = os.path.join(out_dir, fn)
    sz = os.path.getsize(p)
    print(f"  {fn}: {sz/1024:.1f} KB")

# Quick sanity check
print()
for sc in scenarios:
    final = data[sc][-1].mean()
    print(f"  {sc} 2100 global mean anomaly: {final:.2f} °C")
    arctic_final = data[sc][-1][lats > 66].mean()
    print(f"    Arctic 2100: {arctic_final:.2f} °C")

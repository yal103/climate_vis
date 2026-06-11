/* ============================================================
   When does the world cross 2°C — DSC 106 Project 3
   D3 v7 · CMIP6 climate threshold explorer
   ============================================================
   Architecture:
     - State object holds current scenario, threshold, mode, year, selected cell.
     - Each component (map, globalChart, cellChart, histogram, legend, stats)
       has an init() called once and an update() called whenever state changes.
     - The render() loop pushes state through every component.
   ============================================================ */

// ---------- Global state ----------
const state = {
  scenario: "ssp585",
  threshold: "2.0",
  mode: "crossing", // 'crossing' or 'anomaly'
  year: 2050,
  selectedCell: null, // { latIdx, lonIdx, lat, lon } or null
  selectedRegion: null, // region name or null (mutually exclusive with cell)
  isPlaying: false,
  playTimer: null,
};

// Loaded data
const data = {
  grid: null,
  crossings: null,
  globalMeans: null,
  regionalMeans: null,
  timeseries: null, // {scenario: Float32Array of length N_YEARS*N_LAT*N_LON values in °C}
  worldTopo: null,
};

// Constants
const SCENARIO_LABELS = {
  ssp126: "SSP1-2.6",
  ssp245: "SSP2-4.5",
  ssp585: "SSP5-8.5",
};
const SCENARIO_DESC = {
  ssp126: "strong mitigation — net-zero by ~2070",
  ssp245: "middle of the road — current policy trajectory",
  ssp585: "fossil-fueled — high emissions",
};
const SCENARIO_HELP = [
  {
    key: "ssp126",
    label: "SSP1-2.6",
    short: "rapid cuts",
    text: "Countries move quickly away from fossil fuels; warming slows late century.",
  },
  {
    key: "ssp245",
    label: "SSP2-4.5",
    short: "middle path",
    text: "Some climate policy works, but emissions fall gradually rather than fast.",
  },
  {
    key: "ssp585",
    label: "SSP5-8.5",
    short: "high emissions",
    text: "Fossil fuel use stays high; warming keeps rising through 2100.",
  },
];

// =========================================================
// TEMPERATURE UNIT PREFERENCE
// =========================================================
// Every value in the dataset is a warming *anomaly* (degrees above the
// 2015–2034 baseline), i.e. a temperature difference rather than an absolute
// reading. Converting a difference from Celsius to Fahrenheit is a pure 9/5
// scale with NO +32 offset — a +2°C change is a +3.6°F change.
const prefs = {
  unit:
    (typeof localStorage !== "undefined" &&
      localStorage.getItem("tempUnit") === "F")
      ? "F"
      : "C",
};

// Convert an anomaly in °C to the active unit.
function toUnit(c) {
  return prefs.unit === "F" ? (c * 9) / 5 : c;
}
// The active unit's symbol.
function unitSym() {
  return prefs.unit === "F" ? "°F" : "°C";
}
// Signed anomaly with unit, e.g. "+3.2°C" / "+5.8°F".
function fmtAnom(c, digits = 1) {
  const v = toUnit(c);
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}${unitSym()}`;
}
// Axis tick: anomaly in °C → bare number + degree sign in the active unit,
// e.g. 2 → "2°" (C) / "3.6°" (F). The axis label/header carries C vs F.
function unitTick(c) {
  const v = toUnit(c);
  return `${Number.isInteger(v) ? v : v.toFixed(1)}°`;
}
// Magnitude with unit, no forced sign, trailing zeros trimmed:
// 2.0 → "2°C" / "3.6°F", 1.5 → "1.5°C" / "2.7°F".
function fmtMag(c, digits = 1) {
  const s = toUnit(c)
    .toFixed(digits)
    .replace(/\.?0+$/, "");
  return `${s}${unitSym()}`;
}

// Re-label every static, markup-driven temperature element for the active unit:
//   [data-temp]      — a value in °C, formatted per data-temp-fmt
//                      ("mag" | "tick" | "stick" signed degree | "smag" signed)
//   [data-unitsym]   — a bare unit symbol placeholder
// plus the JS-generated scrolly toolbar threshold buttons and the toggle state.
// Charts redraw themselves via the "unitchange" event; this handles the DOM.
function refreshUnitLabels() {
  const num = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
  document.querySelectorAll("[data-temp]").forEach((el) => {
    const c = parseFloat(el.dataset.temp);
    if (!Number.isFinite(c)) return;
    const v = toUnit(c);
    switch (el.dataset.tempFmt) {
      case "tick":
        el.textContent = `${num(v)}°`;
        break;
      case "stick":
        el.textContent = `${v > 0 ? "+" : v < 0 ? "−" : ""}${num(
          Math.abs(v)
        )}°`;
        break;
      case "smag":
        el.textContent = `${v >= 0 ? "+" : ""}${fmtMag(c)}`;
        break;
      default:
        el.textContent = fmtMag(c);
    }
  });
  document
    .querySelectorAll("[data-unitsym]")
    .forEach((el) => (el.textContent = unitSym()));
  // Scrolly toolbar threshold buttons are built in JS; relabel numeric ones.
  document.querySelectorAll(".viz-toolbar .seg-btn-mini").forEach((b) => {
    const v = b.dataset.value;
    if (v && /^[0-9.]+$/.test(v)) b.textContent = fmtMag(parseFloat(v));
  });
  // Keep the toggle in sync with the active unit.
  document.querySelectorAll("#unit-toggle .unit-btn").forEach((b) => {
    const on = b.dataset.unit === prefs.unit;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

// Show / hide a centered "computing…" overlay inside a viz panel. Created
// lazily so panels that never recompute pay nothing.
function showPanelLoading(panelId, text = "Computing…") {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  let el = panel.querySelector(".panel-loading");
  if (!el) {
    el = document.createElement("div");
    el.className = "panel-loading";
    el.innerHTML = `<span class="spinner" aria-hidden="true"></span><span class="panel-loading-text"></span>`;
    panel.appendChild(el);
  }
  el.querySelector(".panel-loading-text").textContent = text;
  el.classList.add("visible");
}
function hidePanelLoading(panelId) {
  const panel = document.getElementById(panelId);
  const el = panel && panel.querySelector(".panel-loading");
  if (el) el.classList.remove("visible");
}

// Switch the active temperature unit and refresh the entire page. The choice is
// persisted immediately (so a reload never has to regenerate), and the actual
// relabel/rebuild is deferred a couple of frames so the spinner can paint —
// charts keep their °C-based geometry, so this is just relabeling, not a full
// data regeneration.
let unitSwitchPending = false;
function setUnit(u) {
  if ((u !== "C" && u !== "F") || u === prefs.unit || unitSwitchPending) return;
  prefs.unit = u;
  try {
    localStorage.setItem("tempUnit", u);
  } catch (e) {
    /* storage unavailable — keep the in-memory preference */
  }
  // Reflect the toggle state right away for instant feedback.
  document.querySelectorAll("#unit-toggle .unit-btn").forEach((b) => {
    const on = b.dataset.unit === prefs.unit;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
  const loader = document.getElementById("unit-loading");
  if (loader) loader.classList.add("visible");
  unitSwitchPending = true;
  // setTimeout (not rAF) so the work still runs if the tab is backgrounded,
  // while still yielding a frame for the spinner to paint.
  setTimeout(() => {
    refreshUnitLabels();
    render(); // main explorer (map, charts, stats, legend)
    window.dispatchEvent(new Event("unitchange")); // scrolly acts + chart axes
    if (loader) loader.classList.remove("visible");
    unitSwitchPending = false;
  }, 30);
}

// =========================================================
// DATA LOADING
// =========================================================
async function loadData() {
  const overlay = document.getElementById("map-loading");

  // Fetch JSON files
  overlay.textContent = "Loading grid…";
  const [grid, crossings, globalMeans, regionalMeans] = await Promise.all([
    d3.json("data/grid.json"),
    d3.json("data/crossings.json"),
    d3.json("data/global_means.json"),
    d3.json("data/regional_means.json"),
  ]);
  data.grid = grid;
  data.crossings = crossings;
  data.globalMeans = globalMeans;
  data.regionalMeans = regionalMeans;

  // Fetch the binary timeseries
  overlay.textContent = "Loading time series…";
  const tsResp = await fetch("data/timeseries.bin");
  const tsBuf = await tsResp.arrayBuffer();
  parseTimeseries(tsBuf);

  overlay.classList.add("hidden");
  setTimeout(() => overlay.remove(), 500);
}

// Coastlines are NOT on the critical path. The maps draw their data cells
// immediately; the borders are a decorative overlay that fades in whenever this
// resolves. Fetching them here (instead of inside loadData) means a slow CDN
// can never hold up the rest of the page. Try Natural Earth via CDN, fall back
// to a bundled local copy.
async function fetchCoastlines() {
  try {
    const topo = await d3.json(
      "https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json"
    );
    data.worldGeo = topojson.feature(topo, topo.objects.land);
  } catch (e) {
    try {
      data.worldGeo = await d3.json("data/coastlines.json");
    } catch (e2) {
      console.warn("No coastlines available:", e2.message);
      return;
    }
  }
  // Redraw any map that was already built without borders.
  scrollMapModule.onCoastlines();
  mapModule.onCoastlines();
}

function parseTimeseries(buf) {
  const view = new DataView(buf);
  // Header: magic 'CMIP' (4 bytes), then 4 uint32: nScen, nYears, nLat, nLon
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3)
  );
  if (magic !== "CMIP") throw new Error("Bad timeseries file magic");
  let off = 4;
  const nScen = view.getUint32(off, true);
  off += 4;
  const nYears = view.getUint32(off, true);
  off += 4;
  const nLat = view.getUint32(off, true);
  off += 4;
  const nLon = view.getUint32(off, true);
  off += 4;
  // Scenario names (8 bytes each, ascii)
  const sNames = [];
  for (let i = 0; i < nScen; i++) {
    let name = "";
    for (let j = 0; j < 8; j++) {
      const c = view.getUint8(off + j);
      if (c !== 0) name += String.fromCharCode(c);
    }
    sNames.push(name);
    off += 8;
  }
  // Data: int16 LE, scenario-major
  data.timeseries = {};
  const cellsPerYear = nLat * nLon;
  const valuesPerScen = nYears * cellsPerYear;
  for (let s = 0; s < nScen; s++) {
    const i16 = new Int16Array(buf, off, valuesPerScen);
    // Convert to Float32 in-place (divide by 100)
    const f = new Float32Array(valuesPerScen);
    for (let i = 0; i < valuesPerScen; i++) f[i] = i16[i] / 100;
    data.timeseries[sNames[s]] = f;
    off += valuesPerScen * 2;
  }
}

// Quickly index timeseries: ts[year_idx, lat_idx, lon_idx]
function getCellSeries(scenario, latIdx, lonIdx) {
  const arr = data.timeseries[scenario];
  const { n_lat, n_lon, years } = data.grid;
  const out = new Float32Array(years.length);
  const cellsPerYear = n_lat * n_lon;
  for (let y = 0; y < years.length; y++) {
    out[y] = arr[y * cellsPerYear + latIdx * n_lon + lonIdx];
  }
  return out;
}

function getCellAnomaly(scenario, year, latIdx, lonIdx) {
  const arr = data.timeseries[scenario];
  const { n_lat, n_lon, years } = data.grid;
  const cellsPerYear = n_lat * n_lon;
  const yIdx = years.indexOf(year);
  if (yIdx < 0) return null;
  return arr[yIdx * cellsPerYear + latIdx * n_lon + lonIdx];
}

function getYearAnomalyField(scenario, year) {
  const arr = data.timeseries[scenario];
  const { n_lat, n_lon, years } = data.grid;
  const cellsPerYear = n_lat * n_lon;
  const yIdx = years.indexOf(year);
  if (yIdx < 0) return null;
  return arr.subarray(yIdx * cellsPerYear, (yIdx + 1) * cellsPerYear);
}

// =========================================================
// COLOR SCALES
// =========================================================
function makeCrossingScale() {
  return d3
    .scaleThreshold()
    .domain([2030, 2040, 2050, 2060, 2070, 2080, 2090])
    .range([
      "#7a0a04",
      "#c2261b",
      "#ff5c2b",
      "#ffaa3d",
      "#fde29c",
      "#88b8c4",
      "#4a7d99",
      "#2d5a73",
    ]);
}

function makeAnomalyScale() {
  return d3
    .scaleThreshold()
    .domain([0, 1, 2, 3, 4, 5, 6])
    .range([
      "#1d3a4f",
      "#356a8a",
      "#5fa8d3",
      "#a8c8d8",
      "#fde29c",
      "#ffaa3d",
      "#ff5c2b",
      "#c2261b",
    ]);
}

const crossingScale = makeCrossingScale();
const anomalyScale = makeAnomalyScale();

// =========================================================
// MAP
// =========================================================
const mapModule = (() => {
  let svg, gMap, gCells, gCoast, gGratic, gSphere, gSelection;
  let projection, path;
  let built = false;
  let cellsSel = null;
  let cachedDims = null;

  function init() {
    svg = d3.select("#map");
    gSphere = svg.append("g").attr("class", "g-sphere");
    gGratic = svg.append("g").attr("class", "g-graticule");
    gCells = svg.append("g").attr("class", "g-cells");
    gCoast = svg.append("g").attr("class", "g-coast");
    gSelection = svg.append("g").attr("class", "g-selection");

    // Resize handling
    const ro = new ResizeObserver(() => {
      build();
      update();
    });
    ro.observe(svg.node());

    build();
  }

  function build() {
    const node = svg.node();
    const { width, height } = node.getBoundingClientRect();
    if (width === 0 || height === 0) return;
    cachedDims = { width, height };
    svg.attr("viewBox", `0 0 ${width} ${height}`);

    // Equal Earth projection — a fair, modern equal-area projection
    projection = d3.geoEqualEarth().fitExtent(
      [
        [8, 8],
        [width - 8, height - 8],
      ],
      { type: "Sphere" }
    );
    path = d3.geoPath(projection);

    // Sphere
    gSphere.selectAll("path").remove();
    gSphere
      .append("path")
      .attr("class", "sphere")
      .attr("d", path({ type: "Sphere" }));

    // Graticule
    const gratic = d3.geoGraticule().step([30, 30])();
    gGratic.selectAll("path").remove();
    gGratic.append("path").attr("class", "graticule").attr("d", path(gratic));

    // Coastlines if available — rendered as a "halo + line" pair so they
    // remain legible against any colormap (saturated reds and pale yellows alike).
    gCoast.selectAll("path").remove();
    if (data.worldGeo) {
      // Backing stroke (dark halo)
      gCoast
        .append("path")
        .attr("class", "coastline-halo")
        .attr("d", path(data.worldGeo))
        .attr("fill", "none")
        .attr("stroke", "rgba(0,0,0,0.55)")
        .attr("stroke-width", 2.6)
        .attr("stroke-linejoin", "round")
        .attr("pointer-events", "none");
      // Foreground stroke (light)
      gCoast
        .append("path")
        .attr("class", "coastline")
        .attr("d", path(data.worldGeo))
        .attr("pointer-events", "none");
    }

    // Cells: render as rectangles in projected space.
    // We pre-project each grid cell to a polygon (4 corners).
    buildCells();
    built = true;
  }

  // Coastlines arrived after the map was already drawn — repaint borders + cells.
  function onCoastlines() {
    if (built) {
      build();
      update();
    }
  }

  function buildCells() {
    const { lats, lons, n_lat, n_lon } = data.grid;
    const dLat = (lats[1] - lats[0]) / 2;
    const dLon = (lons[1] - lons[0]) / 2;

    // For each grid cell, project the 4 corners to screen space.
    // Build the SVG path string directly. This is much faster than d3.geoPath,
    // and avoids the antimeridian-clipping artifact that geoPath produces
    // for tiny polygons on certain projections (which would add a giant
    // sphere outline to each cell path).
    const cells = [];
    for (let i = 0; i < n_lat; i++) {
      for (let j = 0; j < n_lon; j++) {
        const lat = lats[i];
        const lon = lons[j];
        // Cell corners in lon/lat
        const corners = [
          [lon - dLon, lat - dLat],
          [lon + dLon, lat - dLat],
          [lon + dLon, lat + dLat],
          [lon - dLon, lat + dLat],
        ];
        const projected = corners.map((c) => projection(c));
        // If any corner failed to project (e.g. on the back of a globe), skip
        if (projected.some((p) => !p || isNaN(p[0]) || isNaN(p[1]))) {
          cells.push({
            latIdx: i,
            lonIdx: j,
            lat,
            lon,
            idx: i * n_lon + j,
            d: null,
          });
          continue;
        }
        // Reject cells that span the antimeridian (very wide projected width)
        const xs = projected.map((p) => p[0]);
        const xRange = Math.max(...xs) - Math.min(...xs);
        let d;
        if (xRange > 200) {
          // Wraps around — skip
          d = null;
        } else {
          d =
            `M${projected[0][0].toFixed(2)},${projected[0][1].toFixed(2)}` +
            `L${projected[1][0].toFixed(2)},${projected[1][1].toFixed(2)}` +
            `L${projected[2][0].toFixed(2)},${projected[2][1].toFixed(2)}` +
            `L${projected[3][0].toFixed(2)},${projected[3][1].toFixed(2)}Z`;
        }
        cells.push({ latIdx: i, lonIdx: j, lat, lon, idx: i * n_lon + j, d });
      }
    }

    cellsSel = gCells.selectAll("path.map-cell").data(
      cells.filter((c) => c.d),
      (d) => d.idx
    );

    cellsSel = cellsSel.join(
      (enter) =>
        enter
          .append("path")
          .attr("class", "map-cell")
          .attr("d", (d) => d.d)
          .on("mouseenter", onCellHover)
          .on("mousemove", onCellMove)
          .on("mouseleave", onCellLeave)
          .on("click", onCellClick),
      (update) => update.attr("d", (d) => d.d),
      (exit) => exit.remove()
    );
  }

  function update() {
    if (!cellsSel) return;
    const { scenario, threshold, mode, year } = state;
    const flatField =
      mode === "crossing"
        ? data.crossings[scenario][threshold]
        : Array.from(getYearAnomalyField(scenario, year));

    cellsSel
      .classed("never", (d) => mode === "crossing" && flatField[d.idx] === null)
      .attr("fill", (d) => {
        const v = flatField[d.idx];
        if (v === null || v === undefined || Number.isNaN(v)) return null; // CSS handles never
        if (mode === "crossing") return crossingScale(v);
        return anomalyScale(v);
      });

    // Selection ring
    drawSelection();
  }

  function drawSelection() {
    gSelection.selectAll("*").remove();
    if (!state.selectedCell) return;
    const { latIdx, lonIdx } = state.selectedCell;
    const { lats, lons } = data.grid;
    const dLat = (lats[1] - lats[0]) / 2;
    const dLon = (lons[1] - lons[0]) / 2;
    const lat = lats[latIdx],
      lon = lons[lonIdx];
    const corners = [
      [lon - dLon, lat - dLat],
      [lon + dLon, lat - dLat],
      [lon + dLon, lat + dLat],
      [lon - dLon, lat + dLat],
    ];
    const projected = corners.map((c) => projection(c));
    if (projected.some((p) => !p || isNaN(p[0]))) return;
    const xs = projected.map((p) => p[0]);
    if (Math.max(...xs) - Math.min(...xs) > 200) return;
    const d = `M${projected[0]}L${projected[1]}L${projected[2]}L${projected[3]}Z`;

    // Determine stroke color: white on the two darkest blues, black everywhere else
    const DARK_BLUES = new Set([
      "#4a7d99",
      "#2d5a73",
      "#1d3a4f",
      "#356a8a",
      "#7a0a04",
      "#c2261b",
    ]);
    const { scenario, threshold, mode, year } = state;
    const idx = latIdx * data.grid.n_lon + lonIdx;
    let fillColor = null;
    if (mode === "crossing") {
      const v = data.crossings[scenario][threshold][idx];
      if (v !== null) fillColor = crossingScale(v);
    } else {
      const field = getYearAnomalyField(scenario, year);
      if (field) fillColor = anomalyScale(field[idx]);
    }
    const strokeColor =
      !fillColor || DARK_BLUES.has(fillColor) ? "#fff" : "#000";

    gSelection
      .append("path")
      .attr("d", d)
      .attr("fill", "none")
      .attr(
        "stroke",
        strokeColor === "#fff" ? "rgba(0,0,0,0.4)" : "rgba(255,255,255,0.3)"
      )
      .attr("stroke-width", 4);
    gSelection
      .append("path")
      .attr("d", d)
      .attr("fill", "none")
      .attr("stroke", strokeColor)
      .attr("stroke-width", 2);
  }

  // --- Interaction handlers ---
  function onCellHover(event, d) {
    showTooltip(event, d);
  }
  function onCellMove(event, d) {
    showTooltip(event, d);
  }
  function onCellLeave() {
    document
      .getElementById("tooltip")
      .classList.remove("visible", "scenario-tooltip");
  }
  function onCellClick(event, d) {
    state.selectedCell = {
      latIdx: d.latIdx,
      lonIdx: d.lonIdx,
      lat: d.lat,
      lon: d.lon,
    };
    state.selectedRegion = null;
    render();
  }

  return { init, update, build, onCoastlines };
})();

// =========================================================
// TOOLTIP
// =========================================================
function getRegionForCell(lat, lon) {
  const normLon = lon > 180 ? lon - 360 : lon;
  const specific = [
    { name: "North America", lat: [15, 75], lon: [-170, -50] },
    { name: "Europe", lat: [35, 72], lon: [-15, 45] },
    { name: "Sahara/N. Africa", lat: [15, 35], lon: [-15, 50] },
    { name: "Amazon", lat: [-15, 5], lon: [-75, -45] },
    { name: "South Asia", lat: [5, 35], lon: [65, 100] },
  ];
  for (const r of specific) {
    if (
      lat >= r.lat[0] &&
      lat <= r.lat[1] &&
      normLon >= r.lon[0] &&
      normLon <= r.lon[1]
    )
      return r.name;
  }
  if (lat > 66) return "Arctic";
  if (lat < -66) return "Antarctic";
  if (lat >= 30) return "Northern mid-latitudes";
  if (lat <= -30) return "Southern mid-latitudes";
  return "Tropics";
}

function showTooltip(event, d) {
  const tip = document.getElementById("tooltip");
  tip.classList.remove("scenario-tooltip");
  const { scenario, threshold, mode, year } = state;
  const crossing = data.crossings[scenario][threshold][d.idx];
  const anom = getCellAnomaly(scenario, year, d.latIdx, d.lonIdx);
  const final = getCellAnomaly(scenario, 2100, d.latIdx, d.lonIdx);

  const latStr = `${Math.abs(d.lat).toFixed(1)}°${d.lat >= 0 ? "N" : "S"}`;
  const normLon = d.lon > 180 ? d.lon - 360 : d.lon;
  const lonStr = `${Math.abs(normLon).toFixed(1)}°${normLon >= 0 ? "E" : "W"}`;
  const region = getRegionForCell(d.lat, d.lon);

  let headline;
  if (mode === "crossing") {
    headline =
      crossing === null
        ? `never crosses ${fmtMag(+threshold)}`
        : `crosses ${fmtMag(+threshold)} in ${crossing}`;
  } else {
    headline = `${fmtAnom(anom, 2)} in ${year}`;
  }

  tip.innerHTML = `
    <div class="tip-row">
      <span class="tip-key">Location</span>
      <span class="tip-val">${latStr}, ${lonStr}</span>
    </div>
    <div class="tip-row">
      <span class="tip-key">Region</span>
      <span class="tip-val">${region}</span>
    </div>
    <div class="tip-headline">${headline}</div>
    <div class="tip-row">
      <span class="tip-key">2100 anomaly</span>
      <span class="tip-val">${fmtAnom(final)}</span>
    </div>
    <div class="tip-row">
      <span class="tip-key">Scenario</span>
      <span class="tip-val">${SCENARIO_LABELS[scenario]}</span>
    </div>
  `;

  // Position. The scrolly acts re-parent this single #tooltip element into
  // their own panels, so bring it back into .map-wrap before positioning it
  // relative to that wrap — otherwise it lands off-screen in a scrolly panel.
  const wrap = document.querySelector(".map-wrap");
  if (tip.parentElement !== wrap) wrap.appendChild(tip);
  const wrapRect = wrap.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  let left = event.clientX - wrapRect.left + 14;
  let top = event.clientY - wrapRect.top + 14;
  if (left + tipRect.width > wrapRect.width - 8)
    left = event.clientX - wrapRect.left - tipRect.width - 14;
  if (top + tipRect.height > wrapRect.height - 8)
    top = event.clientY - wrapRect.top - tipRect.height - 14;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
  tip.classList.add("visible");
}

// =========================================================
// SHARED SCROLLY TOOLTIP
// Reuses the single global #tooltip element, re-parenting it
// into whichever scrolly panel is asking so absolute positioning
// stays correct across panels.
// =========================================================
function scrollyTip(hostId, event, html) {
  const tip = document.getElementById("tooltip");
  const host = document.getElementById(hostId);
  if (!host) return;
  if (tip.parentElement !== host) host.appendChild(tip);
  tip.classList.remove("scenario-tooltip");
  tip.innerHTML = html;
  const hostRect = host.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  let left = event.clientX - hostRect.left + 16;
  let top = event.clientY - hostRect.top + 16;
  if (left + tipRect.width > hostRect.width - 8)
    left = event.clientX - hostRect.left - tipRect.width - 16;
  if (top + tipRect.height > hostRect.height - 8)
    top = event.clientY - hostRect.top - tipRect.height - 16;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
  tip.classList.add("visible");
}
function scrollyTipHide() {
  document
    .getElementById("tooltip")
    .classList.remove("visible", "scenario-tooltip");
}

function scenarioHelpHTML() {
  const rows = SCENARIO_HELP.map(
    (s) => `
      <div class="scenario-tip-row">
        <span class="scenario-tip-label">${s.label}</span>
        <span class="scenario-tip-short">${s.short}</span>
        <span class="scenario-tip-text">${s.text}</span>
      </div>`
  ).join("");
  return `
    <div class="tip-key">Emissions scenarios</div>
    <div class="tip-headline">Three possible futures</div>
    <div class="scenario-tip-note">Lower numbers mean stronger climate action.</div>
    <div class="scenario-tip-list">${rows}</div>`;
}

function showScenarioHelp(anchor) {
  const tip = document.getElementById("tooltip");
  if (!tip || !anchor) return;
  document.body.appendChild(tip);
  tip.innerHTML = scenarioHelpHTML();
  tip.classList.add("scenario-tooltip", "visible");

  const rect = anchor.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  let left = rect.left + window.scrollX;
  let top = rect.bottom + window.scrollY + 10;
  const maxLeft = window.scrollX + window.innerWidth - tipRect.width - 12;
  left = Math.max(window.scrollX + 12, Math.min(left, maxLeft));
  if (top + tipRect.height > window.scrollY + window.innerHeight - 12) {
    top = rect.top + window.scrollY - tipRect.height - 10;
  }
  tip.style.left = `${left}px`;
  tip.style.top = `${Math.max(window.scrollY + 12, top)}px`;
}

function hideScenarioHelp() {
  const tip = document.getElementById("tooltip");
  if (!tip) return;
  tip.classList.remove("visible", "scenario-tooltip");
}

function attachScenarioHelp(button) {
  if (!button || button.dataset.scenarioHelpReady) return;
  button.dataset.scenarioHelpReady = "true";
  button.addEventListener("mouseenter", () => showScenarioHelp(button));
  button.addEventListener("mousemove", () => showScenarioHelp(button));
  button.addEventListener("mouseleave", hideScenarioHelp);
  button.addEventListener("focus", () => showScenarioHelp(button));
  button.addEventListener("blur", hideScenarioHelp);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    showScenarioHelp(button);
  });
  button.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideScenarioHelp();
      button.blur();
    }
  });
}

// =========================================================
// LEGEND
// =========================================================
const legendModule = (() => {
  let container;
  function init() {
    container = d3.select("#map-legend");
  }
  function update() {
    container.selectAll("*").remove();
    const { mode, threshold } = state;

    // Title
    container
      .append("div")
      .style("font-family", "var(--font-mono)")
      .style("font-size", "10px")
      .style("text-transform", "uppercase")
      .style("letter-spacing", "0.1em")
      .style("color", "var(--ink-faint)")
      .text(
        mode === "crossing"
          ? `Year crossing +${fmtMag(+threshold)}`
          : `Anomaly ${unitSym()}`
      );

    const colors =
      mode === "crossing" ? crossingScale.range() : anomalyScale.range();
    const labels =
      mode === "crossing"
        ? [
            "<2030",
            "2030s",
            "2040s",
            "2050s",
            "2060s",
            "2070s",
            "2080s",
            "≥2090",
          ]
        : (() => {
            // Color bins are fixed in °C (domain [-1, 6]); relabel the bin
            // edges in the active unit. Header already carries °C/°F.
            const e = (c) => {
              const v = toUnit(c);
              return Number.isInteger(v) ? String(v) : v.toFixed(1);
            };
            return [
              `<${e(0)}°`,
              `${e(0)}–${e(1)}°`,
              `${e(1)}–${e(2)}°`,
              `${e(2)}–${e(3)}°`,
              `${e(3)}–${e(4)}°`,
              `${e(4)}–${e(5)}°`,
              `${e(5)}–${e(6)}°`,
              `≥${e(6)}°`,
            ];
          })();

    const swatches = container
      .append("div")
      .style("display", "flex")
      .style("gap", "2px")
      .style("align-items", "flex-end");

    colors.forEach((color, i) => {
      const sw = swatches
        .append("div")
        .style("display", "flex")
        .style("flex-direction", "column")
        .style("align-items", "center");
      sw.append("div")
        .style("width", "24px")
        .style("height", "10px")
        .style("background", color)
        .style("border-radius", "2px");
      sw.append("div")
        .style("font-size", "8px")
        .style("color", "var(--ink-faint)")
        .style("font-family", "var(--font-mono)")
        .style("margin-top", "2px")
        .text(labels[i]);
    });

    if (mode === "crossing") {
      container.append("div").attr("class", "legend-never").html(`
        <span class="legend-never-swatch"></span>
        <span>Never crosses by 2100</span>
      `);
    }
  }
  return { init, update };
})();

// =========================================================
// GLOBAL CHART
// =========================================================
const globalChartModule = (() => {
  let svg, g, x, y, line;
  let dims;

  function init() {
    svg = d3.select("#global-chart");
    g = svg.append("g").attr("class", "g-root");

    const ro = new ResizeObserver(() => {
      build();
      update();
    });
    ro.observe(svg.node());
    window.addEventListener("unitchange", () => {
      build();
      update();
    });
    build();
  }

  function build() {
    const { width, height } = svg.node().getBoundingClientRect();
    if (!width || !height) return;
    svg.attr("viewBox", `0 0 ${width} ${height}`);
    const m = { top: 18, right: 56, bottom: 28, left: 32 };
    dims = { width, height, m };
    g.attr("transform", `translate(0,0)`);

    const years = data.grid.years;
    x = d3
      .scaleLinear()
      .domain(d3.extent(years))
      .range([m.left, width - m.right]);
    y = d3
      .scaleLinear()
      .domain([0, 5.5])
      .range([height - m.bottom, m.top]);

    line = d3
      .line()
      .x((_, i) => x(years[i]))
      .y((d) => y(d))
      .curve(d3.curveMonotoneX);

    // Axes
    g.selectAll(".axis").remove();
    g.append("g")
      .attr("class", "axis axis--x")
      .attr("transform", `translate(0,${height - m.bottom})`)
      .call(
        d3
          .axisBottom(x)
          .tickValues([2020, 2040, 2060, 2080, 2100])
          .tickFormat(d3.format("d"))
          .tickSize(-height + m.top + m.bottom)
      );
    g.append("g")
      .attr("class", "axis axis--y")
      .attr("transform", `translate(${m.left},0)`)
      .call(
        d3
          .axisLeft(y)
          .ticks(5)
          .tickFormat((d) => unitTick(d))
          .tickSize(-(width - m.left - m.right))
      );

    g.selectAll(".axis line")
      .attr("class", "gridline")
      .attr("stroke-dasharray", "2 3");
    g.selectAll(".axis path").attr("display", "none");
  }

  function update() {
    if (!x) return;
    const { width, height, m } = dims;
    const years = data.grid.years;

    // Clear previous lines
    g.selectAll(".scenario-line").remove();
    g.selectAll(".scenario-label").remove();
    g.selectAll(".threshold-line").remove();
    g.selectAll(".threshold-label").remove();
    g.selectAll(".scenario-dot").remove();
    g.selectAll(".year-marker").remove();

    // Threshold line
    const thNum = +state.threshold;
    g.append("line")
      .attr("class", "threshold-line")
      .attr("x1", m.left)
      .attr("x2", width - m.right)
      .attr("y1", y(thNum))
      .attr("y2", y(thNum));
    g.append("text")
      .attr("class", "threshold-label")
      .attr("x", width - m.right + 4)
      .attr("y", y(thNum) + 4)
      .text(`+${fmtMag(thNum)}`);

    // Scenario lines
    const order = ["ssp126", "ssp245", "ssp585"];
    order.forEach((sc) => {
      const series = data.globalMeans[sc];
      g.append("path")
        .attr("class", `scenario-line ${sc}`)
        .classed("dim", sc !== state.scenario)
        .attr("d", line(series));

      // End label
      g.append("text")
        .attr("class", `scenario-label`)
        .attr("fill", sc === state.scenario ? "var(--ink)" : "var(--ink-faint)")
        .attr("x", x(years[years.length - 1]) + 4)
        .attr("y", y(series[series.length - 1]) + 3)
        .text(SCENARIO_LABELS[sc]);
    });

    // Crossing point on selected scenario
    const series = data.globalMeans[state.scenario];
    let crossYr = null;
    for (let i = 0; i < series.length; i++) {
      if (series[i] >= thNum) {
        crossYr = years[i];
        break;
      }
    }
    if (crossYr !== null) {
      g.append("circle")
        .attr("class", "scenario-dot")
        .attr("cx", x(crossYr))
        .attr("cy", y(thNum))
        .attr("r", 5);
      g.append("text")
        .attr("class", "scenario-label")
        .attr("fill", "var(--ink)")
        .attr("text-anchor", "middle")
        .attr("x", x(crossYr))
        .attr("y", y(thNum) - 10)
        .text(`global avg: ${crossYr}`);
    }

    // Year cursor in anomaly mode
    if (state.mode === "anomaly") {
      g.append("line")
        .attr("class", "year-marker")
        .attr("x1", x(state.year))
        .attr("x2", x(state.year))
        .attr("y1", m.top)
        .attr("y2", height - m.bottom)
        .attr("stroke", "var(--ink)")
        .attr("stroke-width", 1)
        .attr("stroke-dasharray", "2 3")
        .attr("opacity", 0.6);
    }
  }

  return { init, update };
})();

// =========================================================
// CELL CHART
// =========================================================
const cellChartModule = (() => {
  let svg, g, x, y, line, area;
  let dims;

  function init() {
    svg = d3.select("#cell-chart");
    g = svg.append("g");
    const ro = new ResizeObserver(() => {
      build();
      update();
    });
    ro.observe(svg.node());
    window.addEventListener("unitchange", () => {
      build();
      update();
    });
    build();
    buildChips();
  }

  function buildChips() {
    const wrap = d3.select("#region-chips");
    const regions = Object.keys(data.regionalMeans[state.scenario]);
    wrap
      .selectAll("button")
      .data(regions)
      .join("button")
      .attr("class", (d) => "chip")
      .text((d) => d)
      .on("click", (event, d) => {
        state.selectedRegion = state.selectedRegion === d ? null : d;
        state.selectedCell = null;
        render();
      });
  }

  function build() {
    const { width, height } = svg.node().getBoundingClientRect();
    if (!width || !height) return;
    svg.attr("viewBox", `0 0 ${width} ${height}`);
    const m = { top: 14, right: 16, bottom: 24, left: 30 };
    dims = { width, height, m };

    const years = data.grid.years;
    x = d3
      .scaleLinear()
      .domain(d3.extent(years))
      .range([m.left, width - m.right]);
    y = d3
      .scaleLinear()
      .domain([-1, 8])
      .range([height - m.bottom, m.top]);

    line = d3
      .line()
      .x((_, i) => x(years[i]))
      .y((d) => y(d))
      .curve(d3.curveMonotoneX);

    area = d3
      .area()
      .x((_, i) => x(years[i]))
      .y0(y(0))
      .y1((d) => y(d))
      .curve(d3.curveMonotoneX);

    g.selectAll(".axis").remove();
    g.append("g")
      .attr("class", "axis axis--x")
      .attr("transform", `translate(0,${height - m.bottom})`)
      .call(
        d3
          .axisBottom(x)
          .tickValues([2020, 2050, 2080])
          .tickFormat(d3.format("d"))
      );
    g.append("g")
      .attr("class", "axis axis--y")
      .attr("transform", `translate(${m.left},0)`)
      .call(
        d3
          .axisLeft(y)
          .ticks(4)
          .tickFormat((d) => unitTick(d))
          .tickSize(-(width - m.left - m.right))
      );
    g.selectAll(".axis line")
      .attr("class", "gridline")
      .attr("stroke-dasharray", "2 3");
    g.selectAll(".axis path").attr("display", "none");
  }

  function update() {
    if (!x) return;
    const { width, height, m } = dims;
    const years = data.grid.years;

    g.selectAll(
      ".cell-line, .cell-area, .threshold-line, .threshold-label, .crossing-dot, .crossing-text, .empty-msg"
    ).remove();

    let series, label, source;
    if (state.selectedCell) {
      series = getCellSeries(
        state.scenario,
        state.selectedCell.latIdx,
        state.selectedCell.lonIdx
      );
      const { lat, lon } = state.selectedCell;
      label = `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? "N" : "S"}, ${Math.abs(
        lon
      ).toFixed(1)}°${lon >= 0 ? "E" : "W"}`;
      source = "cell";
    } else if (state.selectedRegion) {
      series = data.regionalMeans[state.scenario][state.selectedRegion];
      label = state.selectedRegion;
      source = "region";
    }

    // Update title
    if (source) {
      d3.select("#cell-title").text(label);
      d3.select("#cell-sub").text(
        `${SCENARIO_LABELS[state.scenario]} · annual mean anomaly ${
          source === "region" ? "(regional area-weighted)" : "(grid cell)"
        }`
      );
    } else {
      d3.select("#cell-title").text("Click a region on the map");
      d3.select("#cell-sub").text("Or pick a region below to compare warming.");
    }

    // Update chip active states
    d3.selectAll("#region-chips .chip").classed(
      "active",
      (d) => d === state.selectedRegion
    );

    if (!series) {
      g.append("text")
        .attr("class", "empty-msg")
        .attr("x", width / 2)
        .attr("y", height / 2)
        .attr("text-anchor", "middle")
        .attr("fill", "var(--ink-faint)")
        .style("font-family", "var(--font-mono)")
        .style("font-size", "11px")
        .text("select a location");
      return;
    }

    // Threshold line
    const thNum = +state.threshold;
    g.append("line")
      .attr("class", "threshold-line")
      .attr("x1", m.left)
      .attr("x2", width - m.right)
      .attr("y1", y(thNum))
      .attr("y2", y(thNum));

    // Area + line
    g.append("path").attr("class", "cell-area").attr("d", area(series));
    g.append("path").attr("class", "cell-line").attr("d", line(series));

    // Find first crossing
    let crossYr = null;
    for (let i = 0; i < series.length; i++) {
      if (series[i] >= thNum) {
        crossYr = years[i];
        break;
      }
    }
    if (crossYr !== null) {
      g.append("circle")
        .attr("class", "crossing-dot")
        .attr("cx", x(crossYr))
        .attr("cy", y(thNum))
        .attr("r", 4)
        .attr("fill", "var(--ink)")
        .attr("stroke", "var(--bg-card)")
        .attr("stroke-width", 2);
      g.append("text")
        .attr("class", "crossing-text")
        .attr("x", x(crossYr))
        .attr("y", y(thNum) - 8)
        .attr("text-anchor", "middle")
        .attr("fill", "var(--ink)")
        .style("font-family", "var(--font-mono)")
        .style("font-size", "10px")
        .text(`crosses ${fmtMag(thNum)} in ${crossYr}`);
    } else {
      g.append("text")
        .attr("class", "crossing-text")
        .attr("x", width - m.right - 4)
        .attr("y", y(thNum) - 4)
        .attr("text-anchor", "end")
        .attr("fill", "var(--good)")
        .style("font-family", "var(--font-mono)")
        .style("font-size", "10px")
        .text(`stays below ${fmtMag(thNum)}`);
    }
  }
  return { init, update };
})();

// =========================================================
// HISTOGRAM
// =========================================================
const histogramModule = (() => {
  let svg, g, x, y;
  let dims;

  function init() {
    svg = d3.select("#histogram");
    g = svg.append("g");
    const ro = new ResizeObserver(() => {
      build();
      update();
    });
    ro.observe(svg.node());
    build();
  }

  function build() {
    const { width, height } = svg.node().getBoundingClientRect();
    if (!width || !height) return;
    svg.attr("viewBox", `0 0 ${width} ${height}`);
    const m = { top: 20, right: 16, bottom: 28, left: 36 };
    dims = { width, height, m };

    const years = data.grid.years;
    x = d3
      .scaleLinear()
      .domain([2015, 2105])
      .range([m.left, width - m.right]);

    g.selectAll(".axis").remove();
    g.append("g")
      .attr("class", "axis axis--x")
      .attr("transform", `translate(0,${height - m.bottom})`)
      .call(
        d3
          .axisBottom(x)
          .tickValues([2020, 2040, 2060, 2080, 2100])
          .tickFormat(d3.format("d"))
      );
    g.selectAll(".axis path").attr("display", "none");
  }

  function update() {
    if (!x) return;
    const { width, height, m } = dims;
    const years = data.grid.years;
    const flat = data.crossings[state.scenario][state.threshold];

    // Build histogram bins
    const crossed = flat.filter((v) => v !== null);
    // Bin by 5-year buckets
    const binner = d3
      .bin()
      .domain([2015, 2105])
      .thresholds(d3.range(2015, 2105, 5));
    const bins = binner(crossed);

    // Y scale
    y = d3
      .scaleLinear()
      .domain([0, d3.max(bins, (b) => b.length) || 1])
      .range([height - m.bottom, m.top]);

    g.selectAll(".hist-bar").remove();
    g.selectAll(".hist-axis-y").remove();
    g.selectAll(".hist-meta").remove();
    g.selectAll(".hist-cursor").remove();

    g.selectAll(".hist-bar")
      .data(bins)
      .join("rect")
      .attr("class", "hist-bar")
      .attr("x", (d) => x(d.x0) + 1)
      .attr("width", (d) => Math.max(0, x(d.x1) - x(d.x0) - 2))
      .attr("y", (d) => y(d.length))
      .attr("height", (d) => height - m.bottom - y(d.length));

    // Median line
    const sorted = crossed.slice().sort(d3.ascending);
    const median = d3.quantile(sorted, 0.5);
    if (median !== undefined) {
      g.append("line")
        .attr("class", "hist-cursor")
        .attr("x1", x(median))
        .attr("x2", x(median))
        .attr("y1", m.top)
        .attr("y2", height - m.bottom)
        .attr("stroke", "var(--ink)")
        .attr("stroke-dasharray", "3 3")
        .attr("opacity", 0.6);
      g.append("text")
        .attr("class", "hist-meta")
        .attr("x", x(median))
        .attr("y", m.top - 4)
        .attr("text-anchor", "middle")
        .style("font-family", "var(--font-mono)")
        .style("font-size", "10px")
        .attr("fill", "var(--ink)")
        .text(`median: ${Math.round(median)}`);
    }

    // Caption: how many cells never cross
    const neverCount = flat.filter((v) => v === null).length;
    g.append("text")
      .attr("class", "hist-meta")
      .attr("x", width - m.right)
      .attr("y", height - 4)
      .attr("text-anchor", "end")
      .style("font-family", "var(--font-mono)")
      .style("font-size", "10px")
      .attr("fill", "var(--ink-faint)")
      .text(`${neverCount.toLocaleString()} cells never cross`);
  }
  return { init, update };
})();

// =========================================================
// STATS / FOOTER
// =========================================================
function updateStats() {
  const flat = data.crossings[state.scenario][state.threshold];
  const total = flat.length;
  const crossed = flat.filter((v) => v !== null);
  const pct = (crossed.length / total) * 100;
  const sorted = crossed.slice().sort(d3.ascending);
  const median = d3.quantile(sorted, 0.5);

  // First region: find earliest crossing year and the lat band it's in
  const earliest = d3.min(crossed);
  let firstRegion = "—";
  if (earliest != null) {
    // Find which named region has earliest median crossing
    const regionalCross = {};
    Object.keys(data.regionalMeans[state.scenario]).forEach((r) => {
      const series = data.regionalMeans[state.scenario][r];
      const yrs = data.grid.years;
      const th = +state.threshold;
      let cy = null;
      for (let i = 0; i < series.length; i++)
        if (series[i] >= th) {
          cy = yrs[i];
          break;
        }
      regionalCross[r] = cy;
    });
    const sortedR = Object.entries(regionalCross)
      .filter(([_, y]) => y !== null)
      .sort((a, b) => a[1] - b[1]);
    if (sortedR.length) firstRegion = `${sortedR[0][0]} (${sortedR[0][1]})`;
  }

  d3.select("#stat-pct-crossed").text(`${pct.toFixed(0)}%`);
  d3.select("#stat-median-year").text(
    median != null ? Math.round(median) : "—"
  );
  d3.select("#stat-first-region").text(firstRegion);

  // Map title and subtitle
  if (state.mode === "crossing") {
    d3.select("#map-title").text(
      `First year each region crosses +${fmtMag(+state.threshold)}`
    );
    d3.select("#map-sub").text(
      `Under ${SCENARIO_LABELS[state.scenario]} (${
        SCENARIO_DESC[state.scenario]
      }) · relative to 2015–2034 baseline · click any cell to inspect`
    );
  } else {
    d3.select("#map-title").text(`Temperature anomaly in ${state.year}`);
    d3.select("#map-sub").text(
      `Under ${SCENARIO_LABELS[state.scenario]} · ${unitSym()} above 2015–2034 baseline`
    );
  }

  // Hero threshold
  d3.select("#hero-threshold").text(fmtMag(+state.threshold));

  // Mode button year readout
  d3.select("#year-readout").text(state.year);

  // Year scrubber visibility
  d3.select("#year-scrubber").attr(
    "hidden",
    state.mode === "anomaly" ? null : true
  );
}

// =========================================================
// CONTROLS / EVENT WIRING
// =========================================================
function wireControls() {
  document
    .querySelectorAll("[data-scenario-help]")
    .forEach((btn) => attachScenarioHelp(btn));

  // Scenario tabs
  document.querySelectorAll("#scenario-control .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.scenario = btn.dataset.value;
      updateSegActive("#scenario-control", btn);
      render();
    });
  });

  // Threshold tabs
  document.querySelectorAll("#threshold-control .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.threshold = btn.dataset.value;
      updateSegActive("#threshold-control", btn);
      render();
    });
  });

  // Mode tabs
  document.querySelectorAll("#mode-control .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.mode = btn.dataset.value;
      updateSegActive("#mode-control", btn);
      render();
    });
  });

  // Year slider
  const slider = document.getElementById("year-slider");
  slider.addEventListener("input", () => {
    state.year = +slider.value;
    document.getElementById("year-tick").textContent = state.year;
    render();
  });

  // Play/pause
  const playBtn = document.getElementById("play-btn");
  const playIcon = document.getElementById("play-icon");
  playBtn.addEventListener("click", () => {
    state.isPlaying = !state.isPlaying;
    if (state.isPlaying) {
      playIcon.setAttribute("d", "M6 5h4v14H6zm8 0h4v14h-4z");
      const tick = () => {
        if (!state.isPlaying) return;
        let next = state.year + 1;
        if (next > 2100) next = 2015;
        state.year = next;
        slider.value = next;
        document.getElementById("year-tick").textContent = next;
        render();
        state.playTimer = setTimeout(tick, 80);
      };
      tick();
    } else {
      playIcon.setAttribute("d", "M8 5v14l11-7z");
      clearTimeout(state.playTimer);
    }
  });

  // Temperature unit toggle (°C / °F)
  document.querySelectorAll("#unit-toggle .unit-btn").forEach((btn) => {
    btn.addEventListener("click", () => setUnit(btn.dataset.unit));
  });
}

function updateSegActive(selector, activeBtn) {
  document
    .querySelectorAll(`${selector} .seg-btn`)
    .forEach((b) => b.classList.toggle("active", b === activeBtn));
}

// =========================================================
// SCROLLYTELLING STATE & HELPERS
// =========================================================
const scrollyState = {
  activeStep: "stripes",
  birthYear: 2000,
  lifetimeScenario: "ssp585",
  lifeScrubYear: null, // year the lifetime age-scrubber is parked on
  lifeZoom: null, // [yearA, yearB] zoom window, or null for full view
};

// 7 latitude bands, ordered from south to north
const LAT_BANDS = [
  {
    id: "antarctic",
    name: "Antarctic",
    sub: "below −66°",
    min: -90,
    max: -66,
    color: "#2d5a73",
  },
  {
    id: "southern-ocean",
    name: "Southern Ocean",
    sub: "−66° to −30°",
    min: -66,
    max: -30,
    color: "#5fa8d3",
  },
  {
    id: "s-subtropics",
    name: "S. Subtropics",
    sub: "−30° to −10°",
    min: -30,
    max: -10,
    color: "#88b8c4",
  },
  {
    id: "tropics",
    name: "Tropics",
    sub: "−10° to +10°",
    min: -10,
    max: 10,
    color: "#fde29c",
  },
  {
    id: "n-subtropics",
    name: "N. Subtropics",
    sub: "+10° to +30°",
    min: 10,
    max: 30,
    color: "#ffaa3d",
  },
  {
    id: "n-temperate",
    name: "N. Temperate",
    sub: "+30° to +66°",
    min: 30,
    max: 66,
    color: "#ff5c2b",
  },
  {
    id: "arctic",
    name: "Arctic",
    sub: "above +66°",
    min: 66,
    max: 90,
    color: "#7a0a04",
  },
];

function latBandFor(lat) {
  for (const b of LAT_BANDS) if (lat >= b.min && lat < b.max) return b;
  return LAT_BANDS[LAT_BANDS.length - 1]; // catch 90°
}

function latitudeAreaWeight(lat) {
  return Math.max(0, Math.cos((lat * Math.PI) / 180));
}

// Stripe palette — diverging blue→yellow→red over [-1, 6]°C
function stripeColor(anom) {
  const scale = d3
    .scaleThreshold()
    .domain([-0.5, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0])
    .range([
      "#0d2438",
      "#1d3a4f",
      "#356a8a",
      "#5fa8d3",
      "#a8c8d8",
      "#fde29c",
      "#ffaa3d",
      "#ff8d4a",
      "#ff5c2b",
      "#c2261b",
      "#7a0a04",
      "#4a0500",
    ]);
  return scale(anom);
}

// Build a list of {cellIdx, lat, lon, band, crossing, weight} for current scenario+threshold
function buildCellList(scenario, threshold) {
  const { lats, lons, n_lat, n_lon } = data.grid;
  const flat = data.crossings[scenario][threshold];
  const out = [];
  for (let i = 0; i < n_lat; i++) {
    for (let j = 0; j < n_lon; j++) {
      const idx = i * n_lon + j;
      out.push({
        idx,
        latIdx: i,
        lonIdx: j,
        lat: lats[i],
        lon: lons[j],
        band: latBandFor(lats[i]),
        crossing: flat[idx], // year or null
        weight: latitudeAreaWeight(lats[i]),
      });
    }
  }
  return out;
}

function prefersReducedMotion() {
  return (
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// =========================================================
// SHARED ACT TOOLBAR
// =========================================================
const SCENARIO_OPTIONS = [
  { value: "ssp126", label: "SSP1-2.6" },
  { value: "ssp245", label: "SSP2-4.5" },
  { value: "ssp585", label: "SSP5-8.5" },
];
const THRESHOLD_OPTIONS = [
  { value: "1.5", label: "1.5°C" },
  { value: "2.0", label: "2°C" },
  { value: "3.0", label: "3°C" },
  { value: "4.0", label: "4°C" },
];

// Build a compact control bar inside a scrolly panel, placed in normal flow
// above the chart's <svg> so it reserves layout space (never overlaps the viz).
// config: { groups: [{ name, label, options, value, onChange }], onReset, resetLabel }
// Returns { setActive(groupName, value) } to sync buttons with external state.
function createVizToolbar(panelId, config) {
  const panel = document.getElementById(panelId);
  if (!panel) return null;
  const bar = document.createElement("div");
  bar.className = "viz-toolbar";

  const apis = {};
  (config.groups || []).forEach((group) => {
    const wrap = document.createElement("div");
    wrap.className = "vt-group";
    if (group.label) {
      const lab = document.createElement("span");
      lab.className = "vt-label";
      lab.textContent = group.label;
      wrap.appendChild(lab);
      if (group.name === "scenario") {
        const help = document.createElement("button");
        help.type = "button";
        help.className = "scenario-help-btn";
        help.dataset.scenarioHelp = "";
        help.setAttribute("aria-label", "Explain emissions scenarios");
        help.textContent = "?";
        wrap.appendChild(help);
        attachScenarioHelp(help);
      }
    }
    const seg = document.createElement("div");
    seg.className = "vt-seg";
    const btns = {};
    group.options.forEach((opt) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "seg-btn-mini";
      b.textContent = opt.label;
      b.dataset.value = opt.value;
      if (opt.value === group.value) b.classList.add("active");
      b.addEventListener("click", () => {
        if (b.classList.contains("active")) return;
        Object.values(btns).forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        group.onChange(opt.value);
      });
      btns[opt.value] = b;
      seg.appendChild(b);
    });
    wrap.appendChild(seg);
    bar.appendChild(wrap);
    apis[group.name] = (v) =>
      Object.entries(btns).forEach(([val, el]) =>
        el.classList.toggle("active", val === v)
      );
  });

  if (config.onReset) {
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "vt-reset";
    reset.textContent = config.resetLabel || "Reset view";
    reset.addEventListener("click", config.onReset);
    bar.appendChild(reset);
  }

  // Insert before the panel's <svg> so it sits at the top of the flex column.
  const svgEl = panel.querySelector("svg");
  panel.insertBefore(bar, svgEl);
  return {
    el: bar,
    setActive: (name, v) => apis[name] && apis[name](v),
  };
}

// =========================================================
// ACT I — WARMING STRIPES
// =========================================================
const stripesModule = (() => {
  let svg, g, dims;
  const SCENARIOS = ["ssp126", "ssp245", "ssp585"];
  let stripesBuilt = false;
  let stripesRevealed = false;
  let toolbar = null;
  const state = { highlight: "all" };

  // Dim the scenarios the reader isn't focusing on.
  function applyHighlight() {
    SCENARIOS.forEach((sc) => {
      const on = state.highlight === "all" || state.highlight === sc;
      g.selectAll(".stripe-row-" + sc).style("opacity", on ? 1 : 0.16);
    });
  }
  function reset() {
    state.highlight = "all";
    if (toolbar) toolbar.setActive("highlight", "all");
    applyHighlight();
  }

  function init() {
    svg = d3.select("#stripes-svg");
    g = svg.append("g").attr("class", "stripes-root");
    const ro = new ResizeObserver(() => {
      if (stripesBuilt) build();
    });
    ro.observe(svg.node());
    window.addEventListener("unitchange", () => {
      if (stripesBuilt) build();
    });
    // First build is triggered explicitly via show() — stripes is the one act
    // visible at load.

    toolbar = createVizToolbar("panel-stripes", {
      groups: [
        {
          name: "highlight",
          label: "Highlight",
          options: [
            { value: "all", label: "All" },
            { value: "ssp126", label: "SSP1-2.6" },
            { value: "ssp245", label: "SSP2-4.5" },
            { value: "ssp585", label: "SSP5-8.5" },
          ],
          value: state.highlight,
          onChange: (v) => {
            state.highlight = v;
            applyHighlight();
          },
        },
      ],
      onReset: reset,
    });
  }

  function build() {
    const node = svg.node();
    const { width, height } = node.getBoundingClientRect();
    if (!width || !height) return;
    svg.attr("viewBox", `0 0 ${width} ${height}`);
    const m = { top: 70, right: 80, bottom: 60, left: 170 };
    dims = { width, height, m };
    const SHORT_DESC = {
      ssp126: "strong mitigation",
      ssp245: "middle of the road",
      ssp585: "fossil-fueled",
    };

    g.selectAll("*").remove();

    const years = data.grid.years;
    const x = d3
      .scaleLinear()
      .domain([d3.min(years), d3.max(years) + 1])
      .range([m.left, width - m.right]);

    const rowH = Math.min(80, (height - m.top - m.bottom) / SCENARIOS.length);
    const totalRowsH = rowH * SCENARIOS.length;
    const startY = m.top + (height - m.top - m.bottom - totalRowsH) / 2;

    // X axis
    g.append("g")
      .attr("class", "stripe-axis")
      .attr("transform", `translate(0, ${startY + totalRowsH + 10})`)
      .call(
        d3
          .axisBottom(x)
          .tickValues([2020, 2040, 2060, 2080, 2100])
          .tickFormat(d3.format("d"))
          .tickSize(6)
      );

    // Each scenario row
    SCENARIOS.forEach((sc, rowIdx) => {
      const rowY = startY + rowIdx * rowH;
      const series = data.globalMeans[sc];

      // Row label
      g.append("text")
        .attr("class", "stripe-row-label")
        .attr("x", m.left - 14)
        .attr("y", rowY + rowH * 0.5 - 8)
        .attr("text-anchor", "end")
        .text(SCENARIO_LABELS[sc]);
      g.append("text")
        .attr("class", "stripe-row-label dim")
        .attr("x", m.left - 14)
        .attr("y", rowY + rowH * 0.5 + 8)
        .attr("text-anchor", "end")
        .style("font-size", "9px")
        .text(SHORT_DESC[sc]);

      // Stripes
      const w = (width - m.right - m.left) / years.length;
      const stripeG = g
        .append("g")
        .attr("class", `stripe-row stripe-row-${sc}`);
      stripeG
        .selectAll("rect")
        .data(years.map((y, i) => ({ y, anom: series[i] })))
        .join("rect")
        .attr("class", "stripe-rect")
        .attr("x", (d) => x(d.y))
        .attr("y", rowY + 4)
        .attr("width", w + 0.6)
        .attr("height", rowH - 8)
        .attr("fill", (d) => stripeColor(d.anom))
        .style("opacity", stripesRevealed ? 1 : 0);

      // End-of-row label: 2100 value
      const endVal = series[series.length - 1];
      g.append("text")
        .attr("class", "stripe-row-label")
        .attr("x", width - m.right + 6)
        .attr("y", rowY + rowH * 0.5 + 4)
        .attr("text-anchor", "start")
        .style("fill", stripeColor(endVal))
        .style("font-weight", 600)
        .text(fmtAnom(endVal));
    });

    // Title-ish caption above the stripes
    g.append("text")
      .attr("class", "stripe-row-label dim")
      .attr("x", m.left)
      .attr("y", startY - 26)
      .style("font-size", "10px")
      .style("letter-spacing", "0.16em")
      .style("text-transform", "uppercase")
      .text(
        "Each stripe = one year · color = global mean anomaly relative to 2015–2034"
      );

    // 2026 divider line
    const divX = x(2026.6);
    g.append("line")
      .attr("class", "stripe-divider-line")
      .attr("x1", divX)
      .attr("x2", divX)
      .attr("y1", startY - 4)
      .attr("y2", startY + totalRowsH + 22);
    g.append("text")
      .attr("class", "stripe-divider-text")
      .attr("x", divX + 4)
      .attr("y", startY + totalRowsH + 36)
      .text("today");

    g.selectAll(
      ".stripe-axis, .stripe-row-label, .stripe-divider-line, .stripe-divider-text"
    ).style("opacity", stripesRevealed ? null : 0);

    // ---- Interactive hover-scrub ----
    const w = (width - m.right - m.left) / years.length;
    const guide = g
      .append("line")
      .attr("class", "stripe-guide")
      .attr("y1", startY - 4)
      .attr("y2", startY + totalRowsH + 4)
      .style("opacity", 0);
    const yearBadge = g
      .append("text")
      .attr("class", "stripe-guide-year")
      .attr("y", startY - 10)
      .attr("text-anchor", "middle")
      .style("opacity", 0);

    g.append("rect")
      .attr("class", "stripe-overlay")
      .attr("x", m.left)
      .attr("y", startY)
      .attr("width", width - m.left - m.right)
      .attr("height", totalRowsH)
      .style("fill", "transparent")
      .style("cursor", "crosshair")
      .on("pointermove", function (event) {
        const [mx] = d3.pointer(event, g.node());
        const yr = Math.max(
          years[0],
          Math.min(years[years.length - 1], Math.round(x.invert(mx)))
        );
        const i = years.indexOf(yr);
        if (i < 0) return;
        const gx = x(yr) + w / 2;
        guide.attr("x1", gx).attr("x2", gx).style("opacity", 1);
        yearBadge.attr("x", gx).text(yr).style("opacity", 1);
        const rows = SCENARIOS.map((sc) => {
          const v = data.globalMeans[sc][i];
          return `<div class="tip-row"><span class="tip-key" style="color:${stripeColor(
            v
          )}">${SCENARIO_LABELS[sc]}</span><span class="tip-val">${fmtAnom(
            v,
            2
          )}</span></div>`;
        }).join("");
        scrollyTip(
          "panel-stripes",
          event,
          `<div class="tip-headline" style="font-size:15px">${yr}</div>${rows}`
        );
      })
      .on("pointerleave", () => {
        guide.style("opacity", 0);
        yearBadge.style("opacity", 0);
        scrollyTipHide();
      });

    applyHighlight();
    stripesBuilt = true;
  }

  function show() {
    if (!stripesBuilt) build();
  }
  function reveal() {
    if (stripesRevealed) return;
    stripesRevealed = true;
    const totalYears = data.grid.years.length;
    if (prefersReducedMotion()) {
      g.selectAll(".stripe-rect").style("opacity", 1);
      g.selectAll(
        ".stripe-axis, .stripe-row-label, .stripe-divider-line, .stripe-divider-text"
      ).style("opacity", null);
      return;
    }
    g.selectAll(
      ".stripe-axis, .stripe-row-label, .stripe-divider-line, .stripe-divider-text"
    )
      .transition()
      .duration(320)
      .style("opacity", 1);
    g.selectAll(".stripe-rect")
      .transition()
      .delay((d, i) => (i % totalYears) * 5 + Math.floor(i / totalYears) * 80)
      .duration(360)
      .style("opacity", 1);
  }
  return { init, show, build, reveal };
})();

// =========================================================
// ACT II — ANNOTATED SCROLL MAP
// =========================================================
const scrollMapModule = (() => {
  let svg, g, gZoom, dims, projection, path, zoom;
  let built = false;
  let revealed = false;
  let toolbar = null;
  const state = { scenario: "ssp585", threshold: "2.0" };

  const ANNOTATIONS = [
    {
      name: "Arctic",
      lat: 78,
      lon: 10,
      dx: 60,
      dy: -60,
      descrip: "crosses by 2035",
    },
    {
      name: "Amazon",
      lat: -5,
      lon: -60,
      dx: -80,
      dy: 40,
      descrip: "crosses by 2050",
    },
    {
      name: "South Asia",
      lat: 25,
      lon: 80,
      dx: 60,
      dy: 60,
      descrip: "crosses by 2045",
    },
    {
      name: "Southern Ocean",
      lat: -60,
      lon: 10,
      dx: 30,
      dy: 70,
      descrip: "may never cross",
    },
  ];

  function init() {
    svg = d3.select("#scroll-map");
    g = svg.append("g").attr("class", "scroll-map-root");
    // Only rebuild on resize once this act has actually been built — the
    // observer's initial fire must NOT build it (that's deferred to show()).
    const ro = new ResizeObserver(() => {
      if (built) build();
    });
    ro.observe(svg.node());
    // Header label carries the threshold + unit; no temp inside the SVG itself.
    window.addEventListener("unitchange", updateLabel);
    buildLegend(); // cheap; ready before the chart is built

    toolbar = createVizToolbar("panel-map", {
      groups: [
        {
          name: "scenario",
          label: "Scenario",
          options: SCENARIO_OPTIONS,
          value: state.scenario,
          onChange: (v) => {
            state.scenario = v;
            recolor();
            updateLabel();
          },
        },
        {
          name: "threshold",
          label: "Threshold",
          options: THRESHOLD_OPTIONS,
          value: state.threshold,
          onChange: (v) => {
            state.threshold = v;
            recolor();
            updateLabel();
          },
        },
      ],
      onReset: reset,
    });
  }

  function updateLabel() {
    const sEl = document.getElementById("scroll-map-scenario");
    const tEl = document.getElementById("scroll-map-threshold");
    if (sEl) sEl.textContent = SCENARIO_LABELS[state.scenario];
    if (tEl) tEl.textContent = fmtMag(+state.threshold);
  }

  // Recolor existing cells in place (cheap — no re-projection) when the
  // scenario or threshold changes.
  function recolor() {
    if (!built) return;
    const flat = data.crossings[state.scenario][state.threshold];
    gZoom.selectAll(".scroll-map-cells .map-cell").each(function (d) {
      const v = flat[d.idx];
      d.crossing = v;
      d3.select(this)
        .attr("class", v === null ? "map-cell never" : "map-cell")
        .attr("fill", v === null ? null : crossingScale(v));
    });
  }

  function reset() {
    state.scenario = "ssp585";
    state.threshold = "2.0";
    if (toolbar) {
      toolbar.setActive("scenario", "ssp585");
      toolbar.setActive("threshold", "2.0");
    }
    recolor();
    updateLabel();
    if (zoom) svg.transition().duration(450).call(zoom.transform, d3.zoomIdentity);
  }

  function onCoastlines() {
    if (built) build();
  }

  function buildLegend() {
    const container = d3.select("#scroll-map-legend");
    container.selectAll("*").remove();
    const colors = crossingScale.range();
    const labels = [
      "<2030",
      "2030s",
      "2040s",
      "2050s",
      "2060s",
      "2070s",
      "2080s",
      "≥2090",
    ];
    const row = container
      .append("div")
      .style("display", "flex")
      .style("gap", "2px")
      .style("align-items", "flex-end");
    colors.forEach((c, i) => {
      const cell = row
        .append("div")
        .style("display", "flex")
        .style("flex-direction", "column")
        .style("align-items", "center");
      cell
        .append("div")
        .style("width", "24px")
        .style("height", "10px")
        .style("background", c)
        .style("border-radius", "2px");
      cell
        .append("div")
        .style("font-size", "8px")
        .style("color", "var(--ink-faint)")
        .style("font-family", "var(--font-mono)")
        .style("margin-top", "2px")
        .text(labels[i]);
    });
    container
      .append("div")
      .attr("class", "legend-never")
      .style("margin-left", "12px")
      .html(
        `<span class="legend-never-swatch"></span><span>never by 2100</span>`
      );
  }

  function build() {
    const node = svg.node();
    const { width, height } = node.getBoundingClientRect();
    if (!width || !height) return;
    svg.attr("viewBox", `0 0 ${width} ${height}`);
    dims = { width, height };

    g.selectAll("*").remove();
    // Everything drawable lives in gZoom so pan/zoom transforms one node.
    gZoom = g.append("g").attr("class", "scroll-map-zoom");

    projection = d3.geoEqualEarth().fitExtent(
      [
        [16, 50],
        [width - 16, height - 60],
      ],
      { type: "Sphere" }
    );
    path = d3.geoPath(projection);

    // Sphere + graticule
    gZoom
      .append("path")
      .attr("class", "sphere")
      .attr("d", path({ type: "Sphere" }));
    const gratic = d3.geoGraticule().step([30, 30])();
    gZoom.append("path").attr("class", "graticule").attr("d", path(gratic));

    // Cells
    const { lats, lons, n_lat, n_lon } = data.grid;
    const dLat = (lats[1] - lats[0]) / 2;
    const dLon = (lons[1] - lons[0]) / 2;
    const flat = data.crossings[state.scenario][state.threshold];
    const cellG = gZoom.append("g").attr("class", "scroll-map-cells");

    for (let i = 0; i < n_lat; i++) {
      for (let j = 0; j < n_lon; j++) {
        const lat = lats[i];
        const lon = lons[j];
        const corners = [
          [lon - dLon, lat - dLat],
          [lon + dLon, lat - dLat],
          [lon + dLon, lat + dLat],
          [lon - dLon, lat + dLat],
        ];
        const projected = corners.map((c) => projection(c));
        if (projected.some((p) => !p || isNaN(p[0]))) continue;
        const xs = projected.map((p) => p[0]);
        if (Math.max(...xs) - Math.min(...xs) > 200) continue;
        const idx = i * n_lon + j;
        const v = flat[idx];
        const d = `M${projected[0]}L${projected[1]}L${projected[2]}L${projected[3]}Z`;
        cellG
          .append("path")
          .attr("d", d)
          .attr("class", v === null ? "map-cell never" : "map-cell")
          .attr("fill", v === null ? null : crossingScale(v))
          .style("opacity", revealed ? 1 : 0)
          .datum({ lat, lon, idx, crossing: v })
          .on("pointerenter", onCellEnter)
          .on("pointermove", onCellMove)
          .on("pointerleave", onCellLeave)
          .on("click", onCellClick);
      }
    }

    // Coastlines
    if (data.worldGeo) {
      gZoom
        .append("path")
        .attr("d", path(data.worldGeo))
        .attr("fill", "none")
        .attr("stroke", "rgba(0,0,0,0.55)")
        .attr("stroke-width", 2.4)
        .attr("stroke-linejoin", "round")
        .style("pointer-events", "none")
        .style("vector-effect", "non-scaling-stroke");
      gZoom
        .append("path")
        .attr("d", path(data.worldGeo))
        .attr("class", "coastline")
        .style("pointer-events", "none")
        .style("vector-effect", "non-scaling-stroke");
    }

    // Annotations (narrative labels — fade out when the reader zooms in)
    const annoG = gZoom
      .append("g")
      .attr("class", "scroll-map-annos")
      .style("pointer-events", "none");
    ANNOTATIONS.forEach((a) => {
      const [px, py] = projection([a.lon, a.lat]);
      const tx = px + a.dx,
        ty = py + a.dy;
      annoG
        .append("circle")
        .attr("class", "scroll-map-anno-circle")
        .attr("cx", px)
        .attr("cy", py)
        .attr("r", 14);
      annoG
        .append("path")
        .attr("class", "scroll-map-anno-line")
        .attr("d", `M${px},${py} L${tx},${ty}`);
      annoG
        .append("text")
        .attr("class", "scroll-map-anno-bg")
        .attr("x", tx)
        .attr("y", ty)
        .attr("text-anchor", a.dx < 0 ? "end" : "start")
        .text(a.name);
      annoG
        .append("text")
        .attr("class", "scroll-map-annotation")
        .attr("x", tx)
        .attr("y", ty)
        .attr("text-anchor", a.dx < 0 ? "end" : "start")
        .text(a.name);
      annoG
        .append("text")
        .attr("class", "scroll-map-anno-bg")
        .attr("x", tx)
        .attr("y", ty + 13)
        .attr("text-anchor", a.dx < 0 ? "end" : "start")
        .style("font-size", "9px")
        .style("fill", "var(--ink-faint)")
        .text(a.descrip);
      annoG
        .append("text")
        .attr("class", "scroll-map-annotation")
        .attr("x", tx)
        .attr("y", ty + 13)
        .attr("text-anchor", a.dx < 0 ? "end" : "start")
        .style("font-size", "9px")
        .style("fill", "var(--ink-soft)")
        .text(a.descrip);
    });

    // ---- Pan + zoom ----
    zoom = d3
      .zoom()
      .scaleExtent([1, 8])
      .translateExtent([
        [0, 0],
        [width, height],
      ])
      .on("zoom", (event) => {
        gZoom.attr("transform", event.transform);
        const zoomed = event.transform.k > 1.05;
        d3.select("#scroll-map-hint").classed("dim", zoomed);
        annoG.style("opacity", zoomed ? 0 : 1);
      });
    svg.call(zoom).on("dblclick.zoom", null);
    svg.on("dblclick", () =>
      svg.transition().duration(450).call(zoom.transform, d3.zoomIdentity)
    );

    // Hint
    g.append("text")
      .attr("id", "scroll-map-hint")
      .attr("class", "scroll-map-hint")
      .attr("x", width - 16)
      .attr("y", height - 14)
      .attr("text-anchor", "end")
      .style("opacity", revealed ? null : 0)
      .text("click a region to zoom · drag to pan · double-click to reset");

    if (!revealed) annoG.style("opacity", 0);

    built = true;
  }

  function onCellEnter(event, d) {
    d3.select(this).raise().classed("cell-hover", true);
    onCellMove(event, d);
  }
  function onCellMove(event, d) {
    const latStr = `${Math.abs(d.lat).toFixed(1)}°${d.lat >= 0 ? "N" : "S"}`;
    const normLon = d.lon > 180 ? d.lon - 360 : d.lon;
    const lonStr = `${Math.abs(normLon).toFixed(1)}°${
      normLon >= 0 ? "E" : "W"
    }`;
    const region = getRegionForCell(d.lat, d.lon);
    const headline =
      d.crossing == null
        ? `never crosses +${fmtMag(+state.threshold)} by 2100`
        : `crosses +${fmtMag(+state.threshold)} in ${d.crossing}`;
    scrollyTip(
      "panel-map",
      event,
      `
      <div class="tip-row"><span class="tip-key">Location</span><span class="tip-val">${latStr}, ${lonStr}</span></div>
      <div class="tip-row"><span class="tip-key">Region</span><span class="tip-val">${region}</span></div>
      <div class="tip-headline">${headline}</div>`
    );
  }
  function onCellLeave() {
    d3.select(this).classed("cell-hover", false);
    scrollyTipHide();
  }
  // Click a region to zoom into it (then drag to pan, Reset to return).
  function onCellClick(event, d) {
    if (!zoom || !dims) return;
    const [px, py] = projection([d.lon, d.lat]);
    const k = 4;
    const t = d3.zoomIdentity
      .translate(dims.width / 2, dims.height / 2)
      .scale(k)
      .translate(-px, -py);
    svg.transition().duration(650).call(zoom.transform, t);
  }

  function show() {
    if (!built) {
      build();
      // Legend can wrap/reflow after first paint and shrink the chart; rebuild
      // once on the next frame so the viewBox matches the final height.
      requestAnimationFrame(() => build());
    }
  }
  function reveal() {
    if (revealed) return;
    revealed = true;
    if (prefersReducedMotion()) {
      gZoom.selectAll(".scroll-map-cells .map-cell").style("opacity", 1);
      gZoom.select(".scroll-map-annos").style("opacity", null);
      g.select("#scroll-map-hint").style("opacity", null);
      return;
    }
    gZoom
      .selectAll(".scroll-map-cells .map-cell")
      .transition()
      .delay((d) => {
        const lon = d.lon > 180 ? d.lon - 360 : d.lon;
        return ((lon + 180) / 360) * 850;
      })
      .duration(420)
      .style("opacity", 1);
    gZoom
      .select(".scroll-map-annos")
      .transition()
      .delay(760)
      .duration(520)
      .style("opacity", 1);
    g.select("#scroll-map-hint")
      .transition()
      .delay(980)
      .duration(360)
      .style("opacity", 1);
  }
  return { init, show, reveal, onCoastlines };
})();

// =========================================================
// ACT III — RIDGE PLOT
// =========================================================
const ridgeModule = (() => {
  let svg, g, gStatic, gRidges, gScrub, dims;
  let built = false;
  let revealed = false;
  let toolbar = null;
  const state = { scenario: "ssp585", threshold: "2.0" };

  function updateLabel() {
    const el = document.getElementById("ridge-scenario-label");
    if (el)
      el.textContent = `${SCENARIO_LABELS[state.scenario]} · +${fmtMag(
        +state.threshold
      )}`;
  }
  function reset() {
    state.scenario = "ssp585";
    state.threshold = "2.0";
    if (toolbar) {
      toolbar.setActive("scenario", "ssp585");
      toolbar.setActive("threshold", "2.0");
    }
    updateLabel();
    build({ animate: true });
  }

  function weightedKde(kernel, bandwidth, sampleX) {
    return function (values) {
      const totalWeight = d3.sum(values, (v) => v.weight) || 1;
      return sampleX.map((x) => [
        x,
        d3.sum(
          values,
          (v) => v.weight * kernel((x - v.crossing) / bandwidth)
        ) / totalWeight,
      ]);
    };
  }
  function weightedQuantile(values, q, valueAccessor, weightAccessor) {
    const sorted = values
      .slice()
      .sort((a, b) => valueAccessor(a) - valueAccessor(b));
    const totalWeight = d3.sum(sorted, weightAccessor);
    if (!sorted.length || !totalWeight) return null;
    const target = totalWeight * q;
    let acc = 0;
    for (const item of sorted) {
      acc += weightAccessor(item);
      if (acc >= target) return valueAccessor(item);
    }
    return valueAccessor(sorted[sorted.length - 1]);
  }
  function gaussian(u) {
    return Math.exp(-0.5 * u * u) / Math.sqrt(2 * Math.PI);
  }

  function init() {
    svg = d3.select("#ridge-svg");
    g = svg.append("g").attr("class", "ridge-root");
    // Persistent paint layers (bottom → top): static scaffolding, morphing
    // ridges, then the scrub overlay. Keeping them around lets data-joins
    // tween between scenarios instead of being wiped and redrawn.
    gStatic = g.append("g").attr("class", "ridge-static");
    gRidges = g.append("g").attr("class", "ridge-dyn");
    gScrub = g.append("g").attr("class", "ridge-scrub-layer").style("opacity", 0);
    const ro = new ResizeObserver(() => {
      if (built) build({ animate: false });
    });
    ro.observe(svg.node());
    // Ridge axes are year × latitude; only the header label carries a unit.
    window.addEventListener("unitchange", updateLabel);

    toolbar = createVizToolbar("panel-ridge", {
      groups: [
        {
          name: "scenario",
          label: "Scenario",
          options: SCENARIO_OPTIONS,
          value: state.scenario,
          onChange: (v) => {
            state.scenario = v;
            updateLabel();
            build({ animate: true });
          },
        },
        {
          name: "threshold",
          label: "Threshold",
          options: THRESHOLD_OPTIONS,
          value: state.threshold,
          onChange: (v) => {
            state.threshold = v;
            updateLabel();
            build({ animate: true });
          },
        },
      ],
      onReset: reset,
    });
  }

  function build(opts = {}) {
    const animate = !!opts.animate && revealed && !prefersReducedMotion();
    const DUR = 720;
    const node = svg.node();
    const { width, height } = node.getBoundingClientRect();
    if (!width || !height) return;
    svg.attr("viewBox", `0 0 ${width} ${height}`);
    const m = { top: 40, right: 90, bottom: 50, left: 150 };
    dims = { width, height, m };

    const cells = buildCellList(state.scenario, state.threshold);
    const thLabel = `+${fmtMag(+state.threshold)}`;

    const xMax = 2102;
    const xMin = 2018;
    const x = d3
      .scaleLinear()
      .domain([xMin, xMax])
      .range([m.left, width - m.right]);

    const bandHeight = (height - m.top - m.bottom) / LAT_BANDS.length;

    // KDE setup
    const sampleX = d3.range(xMin, xMax, 1);
    const estimator = weightedKde(gaussian, 2.5, sampleX);
    const ridgeH = bandHeight * 1.4; // overlap rows

    // North → south for natural reading (Arctic at top)
    const orderedBands = LAT_BANDS.slice().reverse();

    // ---- Compute everything up front, keyed by band ----
    const bandData = orderedBands.map((band, rowIdx) => {
      const rowY = m.top + rowIdx * bandHeight;
      const baseline = rowY + bandHeight - 4;
      const bandCells = cells.filter((c) => c.band.id === band.id);
      const crossed = bandCells
        .filter((c) => c.crossing !== null)
        .map((c) => ({ crossing: c.crossing, weight: c.weight }));
      const totalWeight = d3.sum(bandCells, (c) => c.weight);
      const crossedWeight = d3.sum(crossed, (c) => c.weight);
      const crossedPct = totalWeight
        ? Math.round((crossedWeight / totalWeight) * 100)
        : 0;
      const hasRidge = crossed.length >= 2;

      let pathD,
        median = null;
      if (hasRidge) {
        const density = estimator(crossed);
        const yMax = d3.max(density, (d) => d[1]) || 1;
        const yScale = d3
          .scaleLinear()
          .domain([0, yMax])
          .range([baseline, rowY + bandHeight - ridgeH]);
        const area = d3
          .area()
          .curve(d3.curveBasis)
          .x((d) => x(d[0]))
          .y0(baseline)
          .y1((d) => yScale(d[1]));
        pathD = area(density);
        median = weightedQuantile(
          crossed,
          0.5,
          (d) => d.crossing,
          (d) => d.weight
        );
      } else {
        // Collapsed area pinned to the baseline so it can morph in/out
        // smoothly from a real ridge (same point count → tweenable "d").
        const area = d3
          .area()
          .curve(d3.curveBasis)
          .x((d) => x(d[0]))
          .y0(baseline)
          .y1(baseline);
        pathD = area(sampleX.map((xv) => [xv, 0]));
      }
      return {
        band,
        rowY,
        baseline,
        crossed,
        totalWeight,
        crossedPct,
        hasRidge,
        pathD,
        median,
      };
    });

    // ---- Static scaffolding (instant; doesn't need to tween) ----
    gStatic.selectAll("*").remove();
    gStatic
      .append("text")
      .attr("class", "stripe-row-label dim")
      .attr("x", m.left)
      .attr("y", m.top - 18)
      .style("font-size", "10px")
      .style("letter-spacing", "0.16em")
      .style("text-transform", "uppercase")
      .text(
        "Each ridge = an area-weighted density of crossing years inside one latitude band"
      );

    gStatic
      .append("g")
      .attr("class", "ridge-axis")
      .attr("transform", `translate(0, ${height - m.bottom + 6})`)
      .call(
        d3
          .axisBottom(x)
          .tickValues([2020, 2040, 2060, 2080, 2100])
          .tickFormat(d3.format("d"))
      );
    gStatic
      .append("text")
      .attr("class", "ridge-sublabel")
      .attr("x", (width - m.right + m.left) / 2)
      .attr("y", height - m.bottom + 36)
      .attr("text-anchor", "middle")
      .style("font-size", "10px")
      .text(`year when each grid cell first crosses ${thLabel}`);

    bandData.forEach((r) => {
      const labelY = r.rowY + bandHeight * 0.55;
      gStatic
        .append("text")
        .attr("class", "ridge-label")
        .attr("x", m.left - 14)
        .attr("y", labelY - 4)
        .attr("text-anchor", "end")
        .text(r.band.name);
      gStatic
        .append("text")
        .attr("class", "ridge-sublabel")
        .attr("x", m.left - 14)
        .attr("y", labelY + 10)
        .attr("text-anchor", "end")
        .text(r.band.sub);

      // Right-side % stat. Fade it when morphing so the number swap is gentle.
      const pct = gStatic
        .append("text")
        .attr("class", "ridge-label")
        .attr("x", width - m.right + 10)
        .attr("y", labelY - 4)
        .style("fill", r.band.color)
        .text(`${r.crossedPct}%`);
      gStatic
        .append("text")
        .attr("class", "ridge-sublabel")
        .attr("x", width - m.right + 10)
        .attr("y", labelY + 10)
        .text("crossed");
      if (animate) {
        pct.style("opacity", 0).transition().duration(DUR).style("opacity", 1);
      }

      // Flat reference line for bands that never cross.
      if (!r.hasRidge) {
        const fl = gStatic
          .append("line")
          .attr("x1", m.left)
          .attr("x2", width - m.right)
          .attr("y1", r.rowY + bandHeight - 6)
          .attr("y2", r.rowY + bandHeight - 6)
          .attr("stroke", r.band.color)
          .attr("stroke-width", 1.2)
          .attr("opacity", animate ? 0 : 0.6);
        if (animate) fl.transition().duration(DUR).attr("opacity", 0.6);
      }
    });

    // ---- Morphing ridges (keyed by band id) ----
    const key = (d) => d.band.id;

    const paths = gRidges
      .selectAll("path.ridge-path")
      .data(bandData, key);
    paths.exit().remove();
    const pathsMerge = paths
      .enter()
      .append("path")
      .attr("class", "ridge-path")
      .attr("d", (d) => d.pathD)
      .attr("fill", (d) => d.band.color)
      .attr("stroke", (d) => d.band.color)
      .attr("transform", revealed ? null : "translate(-14,0)")
      .style("opacity", revealed ? 1 : 0)
      .merge(paths);

    if (animate) {
      pathsMerge
        .transition()
        .duration(DUR)
        .ease(d3.easeCubicInOut)
        .attr("d", (d) => d.pathD)
        .attr("fill", (d) => d.band.color)
        .attr("stroke", (d) => d.band.color);
    } else {
      pathsMerge
        .attr("d", (d) => d.pathD)
        .attr("fill", (d) => d.band.color)
        .attr("stroke", (d) => d.band.color);
      if (revealed) pathsMerge.attr("transform", null).style("opacity", 1);
    }

    // ---- Median ticks + labels (only for bands with a ridge) ----
    const medData = bandData.filter((d) => d.hasRidge && d.median != null);

    const medLines = gRidges
      .selectAll("line.ridge-median")
      .data(medData, key);
    medLines.exit().remove();
    const medMerge = medLines
      .enter()
      .append("line")
      .attr("class", "ridge-median")
      .attr("stroke", "var(--ink)")
      .attr("stroke-width", 1)
      .attr("opacity", 0.55)
      .attr("x1", (d) => x(d.median))
      .attr("x2", (d) => x(d.median))
      .merge(medLines)
      .attr("y1", (d) => d.baseline)
      .attr("y2", (d) => d.rowY + bandHeight - 18);
    (animate
      ? medMerge.transition().duration(DUR).ease(d3.easeCubicInOut)
      : medMerge
    )
      .attr("x1", (d) => x(d.median))
      .attr("x2", (d) => x(d.median));

    const medText = gRidges
      .selectAll("text.ridge-median-label")
      .data(medData, key);
    medText.exit().remove();
    const medTextMerge = medText
      .enter()
      .append("text")
      .attr("class", "ridge-median-label ridge-sublabel")
      .attr("text-anchor", "middle")
      .style("fill", "var(--ink)")
      .attr("x", (d) => x(d.median))
      .merge(medText)
      .attr("y", (d) => d.rowY + bandHeight - 22)
      .text((d) => `${Math.round(d.median)}`);
    (animate
      ? medTextMerge.transition().duration(DUR).ease(d3.easeCubicInOut)
      : medTextMerge
    ).attr("x", (d) => x(d.median));

    // ---- Scrub overlay (rebuilt each time; cheap, captures fresh data) ----
    gScrub.selectAll("*").remove();
    gScrub.style("opacity", 0);
    const scrubLine = gScrub
      .append("line")
      .attr("class", "ridge-scrub-line")
      .attr("y1", m.top - 6)
      .attr("y2", height - m.bottom);
    const scrubYear = gScrub
      .append("text")
      .attr("class", "ridge-scrub-year")
      .attr("y", m.top - 10)
      .attr("text-anchor", "middle");
    const scrubLabels = bandData.map((r) =>
      gScrub
        .append("text")
        .attr("class", "ridge-scrub-pct")
        .attr("y", r.rowY + bandHeight * 0.55 + 24)
        .attr("text-anchor", "middle")
        .style("fill", r.band.color)
    );

    gScrub
      .append("rect")
      .attr("x", m.left)
      .attr("y", m.top - 6)
      .attr("width", width - m.left - m.right)
      .attr("height", height - m.bottom - m.top + 6)
      .style("fill", "transparent")
      .style("cursor", "ew-resize")
      .on("pointermove", function (event) {
        const [mx] = d3.pointer(event, g.node());
        const yr = Math.max(xMin, Math.min(xMax, Math.round(x.invert(mx))));
        const px = x(yr);
        gScrub.style("opacity", 1);
        scrubLine.attr("x1", px).attr("x2", px);
        scrubYear.attr("x", px).text(yr);
        bandData.forEach((r, i) => {
          const crossedWeight = d3.sum(
            r.crossed.filter((c) => c.crossing <= yr),
            (c) => c.weight
          );
          const pct = r.totalWeight
            ? Math.round((crossedWeight / r.totalWeight) * 100)
            : 0;
          scrubLabels[i].attr("x", px).text(`${pct}%`);
        });
      })
      .on("pointerleave", () => gScrub.style("opacity", 0));

    built = true;
  }

  function show() {
    if (!built) build();
  }
  function reveal() {
    if (revealed) return;
    revealed = true;
    if (prefersReducedMotion()) {
      gRidges.selectAll(".ridge-path").attr("transform", null).style("opacity", 1);
      return;
    }
    gRidges
      .selectAll(".ridge-path")
      .transition()
      .delay((d, i) => i * 120)
      .duration(700)
      .ease(d3.easeCubicOut)
      .attr("transform", "translate(0,0)")
      .style("opacity", 1);
  }
  return { init, show, reveal };
})();

// =========================================================
// ACT IV — BEESWARM
// =========================================================
const beeswarmModule = (() => {
  let svg, g, dims;
  let built = false;
  let revealed = false;
  let nodes = null;
  let toolbar = null;
  const state = { scenario: "ssp585", threshold: "2.0" };
  // Cache settled dot positions per scenario|threshold|size so revisiting a
  // combo (or just flipping units) reuses the layout instead of re-running the
  // ~6,000-node force simulation.
  const simCache = new Map();

  function thLabel() {
    return `+${fmtMag(+state.threshold)}`;
  }

  function sizeKey() {
    const { width, height } = svg.node().getBoundingClientRect();
    return `${Math.round(width)}x${Math.round(height)}`;
  }
  function layoutKey() {
    return `${state.scenario}|${state.threshold}|${sizeKey()}`;
  }

  // Scenario/threshold change → recompute the layout and redraw. Show a spinner
  // only when the layout isn't cached (the force simulation is the slow bit).
  function rebuild() {
    nodes = null;
    revealed = true; // keep dots visible (no re-entrance animation on a swap)
    if (simCache.has(layoutKey())) {
      build(); // cached — instant
      return;
    }
    showPanelLoading("panel-beeswarm", "Laying out ~6,000 cells…");
    // setTimeout so the spinner paints (and still fires if the tab is hidden)
    // before the blocking force simulation runs.
    setTimeout(() => {
      build();
      hidePanelLoading("panel-beeswarm");
    }, 30);
  }
  function reset() {
    state.scenario = "ssp585";
    state.threshold = "2.0";
    if (toolbar) {
      toolbar.setActive("scenario", "ssp585");
      toolbar.setActive("threshold", "2.0");
    }
    rebuild();
  }

  function init() {
    svg = d3.select("#beeswarm-svg");
    g = svg.append("g").attr("class", "beeswarm-root");
    // Deferred build: the observer's initial fire must not run the (expensive)
    // force simulation — that happens on first show().
    const ro = new ResizeObserver(() => {
      if (built) build();
    });
    ro.observe(svg.node());
    window.addEventListener("unitchange", () => {
      if (built) build();
    });
    buildLegend(); // cheap; ready before the chart is built

    toolbar = createVizToolbar("panel-beeswarm", {
      groups: [
        {
          name: "scenario",
          label: "Scenario",
          options: SCENARIO_OPTIONS,
          value: state.scenario,
          onChange: (v) => {
            state.scenario = v;
            rebuild();
          },
        },
        {
          name: "threshold",
          label: "Threshold",
          options: THRESHOLD_OPTIONS,
          value: state.threshold,
          onChange: (v) => {
            state.threshold = v;
            rebuild();
          },
        },
      ],
      onReset: reset,
    });
  }

  function buildLegend() {
    const container = d3.select("#beeswarm-legend");
    container.selectAll("*").remove();
    LAT_BANDS.slice()
      .reverse()
      .forEach((b) => {
        container
          .append("span")
          .style("display", "inline-flex")
          .style("align-items", "center")
          .style("margin-right", "10px")
          .html(
            `<span class="caption-key" style="background:${b.color}"></span><span>${b.name}</span>`
          );
      });
  }

  function computeNodes() {
    const cells = buildCellList(state.scenario, state.threshold);
    const sample = cells; // use them all
    const NEVER_X = 2105;
    const yearJitter = () => (Math.random() - 0.5) * 0.6;

    nodes = sample.map((c) => ({
      ...c,
      // target x: crossing year or NEVER_X
      tx:
        c.crossing == null ? NEVER_X + yearJitter() : c.crossing + yearJitter(),
    }));
  }

  function tooltip(event, d) {
    const tip = document.getElementById("tooltip");
    tip.classList.remove("scenario-tooltip");
    const latStr = `${Math.abs(d.lat).toFixed(1)}°${d.lat >= 0 ? "N" : "S"}`;
    const normLon = d.lon > 180 ? d.lon - 360 : d.lon;
    const lonStr = `${Math.abs(normLon).toFixed(1)}°${
      normLon >= 0 ? "E" : "W"
    }`;
    const headline =
      d.crossing == null
        ? `never crosses ${thLabel()} by 2100`
        : `crosses ${thLabel()} in ${d.crossing}`;
    tip.innerHTML = `
      <div class="tip-row"><span class="tip-key">Location</span><span class="tip-val">${latStr}, ${lonStr}</span></div>
      <div class="tip-row"><span class="tip-key">Band</span><span class="tip-val">${d.band.name}</span></div>
      <div class="tip-headline">${headline}</div>
    `;
    // Position via global tooltip (within scroll-graphic context)
    const host = document.getElementById("panel-beeswarm");
    const hostRect = host.getBoundingClientRect();
    // Move tooltip into scroll-graphic if not there
    if (tip.parentElement !== host) host.appendChild(tip);
    let left = event.clientX - hostRect.left + 14;
    let top = event.clientY - hostRect.top + 14;
    const tipRect = tip.getBoundingClientRect();
    if (left + tipRect.width > hostRect.width - 8)
      left = event.clientX - hostRect.left - tipRect.width - 14;
    if (top + tipRect.height > hostRect.height - 8)
      top = event.clientY - hostRect.top - tipRect.height - 14;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.classList.add("visible");
  }
  function tooltipHide() {
    document
      .getElementById("tooltip")
      .classList.remove("visible", "scenario-tooltip");
  }

  function build() {
    const node = svg.node();
    const { width, height } = node.getBoundingClientRect();
    if (!width || !height) return;
    svg.attr("viewBox", `0 0 ${width} ${height}`);
    const m = { top: 40, right: 80, bottom: 56, left: 100 };
    dims = { width, height, m };
    g.selectAll("*").remove();

    if (!nodes) computeNodes();

    const xMin = 2018,
      xMax = 2108;
    const x = d3
      .scaleLinear()
      .domain([xMin, xMax])
      .range([m.left, width - m.right]);

    // X axis (only up to 2100)
    const axisG = g
      .append("g")
      .attr("class", "bee-axis")
      .attr("transform", `translate(0, ${height - m.bottom + 8})`)
      .call(
        d3
          .axisBottom(x)
          .tickValues([2020, 2040, 2060, 2080, 2100])
          .tickFormat(d3.format("d"))
      );
    g.append("text")
      .attr("class", "ridge-sublabel")
      .attr("x", (m.left + (width - m.right)) / 2)
      .attr("y", height - m.bottom + 38)
      .attr("text-anchor", "middle")
      .style("font-size", "10px")
      .text(
        `year each grid cell first crosses ${thLabel()}  (right of dashed line: never crosses by 2100)`
      );

    // Latitude band Y centers (Arctic on top)
    const bandsTopDown = LAT_BANDS.slice().reverse();
    const bandH = (height - m.top - m.bottom) / bandsTopDown.length;
    const bandY = {};
    bandsTopDown.forEach((b, i) => (bandY[b.id] = m.top + bandH * (i + 0.5)));

    // Band labels (left)
    bandsTopDown.forEach((b) => {
      g.append("text")
        .attr("class", "ridge-label")
        .attr("x", m.left - 14)
        .attr("y", bandY[b.id] + 4)
        .attr("text-anchor", "end")
        .style("font-size", "10px")
        .style("fill", b.color)
        .text(b.name);
    });

    // Never divider
    const dividerX = x(2102);
    g.append("line")
      .attr("class", "bee-never-divider")
      .attr("x1", dividerX)
      .attr("x2", dividerX)
      .attr("y1", m.top - 4)
      .attr("y2", height - m.bottom);
    g.append("text")
      .attr("class", "bee-never-label")
      .attr("x", dividerX + 6)
      .attr("y", m.top + 4)
      .text("never");

    // Assign initial node positions
    nodes.forEach((n) => {
      n.x = x(n.tx);
      n.y = bandY[n.band.id];
    });

    const radius = Math.max(
      1.3,
      Math.min(2.6, Math.sqrt((width * height) / nodes.length) * 0.13)
    );

    // Reuse settled positions when this scenario|threshold|size was laid out
    // before (e.g. on a unit flip); otherwise run the force simulation offline
    // and cache the result.
    const key = layoutKey();
    const cached = simCache.get(key);
    if (cached && cached.length === nodes.length) {
      nodes.forEach((n, i) => {
        n.x = cached[i][0];
        n.y = cached[i][1];
      });
    } else {
      const sim = d3
        .forceSimulation(nodes)
        .alpha(0.9)
        .alphaDecay(0.07)
        .force("x", d3.forceX((d) => x(d.tx)).strength(0.95))
        .force("y", d3.forceY((d) => bandY[d.band.id]).strength(0.1))
        .force("collide", d3.forceCollide(radius + 0.15).strength(0.85))
        .stop();
      for (let i = 0; i < 140; i++) sim.tick();
      simCache.set(
        key,
        nodes.map((n) => [n.x, n.y])
      );
    }

    // Draw circles
    const dotG = g.append("g").attr("class", "bee-dots");
    const dots = dotG
      .selectAll("circle")
      .data(nodes)
      .join("circle")
      .attr("class", "bee-dot")
      .attr("cx", (d) => d.x)
      .attr("cy", (d) => d.y)
      .attr("r", revealed ? radius : 0)
      .attr("data-r", radius)
      .attr("fill", (d) =>
        d.crossing == null ? "rgba(95, 168, 211, 0.55)" : d.band.color
      )
      .style("opacity", revealed ? 1 : 0)
      .on("mouseover", tooltip)
      .on("mousemove", tooltip)
      .on("mouseout", tooltipHide);

    // ---- Year scrubber: drag to light up the planet as it crosses +2°C ----
    const total = nodes.length;
    const scrubG = g.append("g");

    // A single solid "veil" rect washes out the dots to the RIGHT of the scrub
    // line — uniformly transparent across the whole right side. This is the
    // cheap way to fade thousands of dots: as you pan we only move/resize one
    // rect, never touch the dots themselves.
    const veil = scrubG
      .append("rect")
      .attr("class", "bee-right-veil")
      .attr("y", m.top - 4)
      .attr("height", height - m.bottom - (m.top - 4))
      .attr("fill", "#0e0d0c")
      .style("pointer-events", "none")
      .style("opacity", 0);

    const scrubLine = scrubG
      .append("line")
      .attr("class", "bee-scrub-line")
      .attr("y1", m.top - 4)
      .attr("y2", height - m.bottom)
      .style("opacity", 0);
    const scrubLabel = scrubG
      .append("text")
      .attr("class", "bee-scrub-label")
      .attr("y", m.top - 8)
      .attr("text-anchor", "middle")
      .style("opacity", 0);
    const readout = scrubG
      .append("text")
      .attr("class", "bee-scrub-readout")
      .attr("x", m.left)
      .attr("y", 24)
      .style("opacity", 0);

    // Pre-index for cheap scrubbing. The DOM circles come back in data order,
    // so circleEls[i] corresponds to nodes[i]. We sort the *crossing* cells by
    // year once; lighting up to a year is then a binary-search boundary, and
    // moving the scrub only flips the dots between the old and new boundary —
    // no full pass over all ~6,000 nodes per mouse move.
    const circleEls = dots.nodes();
    const dotGNode = dotG.node();
    const crossedIdx = d3
      .range(nodes.length)
      .filter((i) => nodes[i].crossing != null)
      .sort((a, b) => nodes[a].crossing - nodes[b].crossing);
    const crossedYears = crossedIdx.map((i) => nodes[i].crossing);

    let active = false;
    let boundary = 0; // count of crossed dots currently lit (crossing <= yr)
    let lastYr = null;

    // Dimming is done with ONE class on the parent group (CSS dims every dot,
    // then un-dims the ones tagged .bee-lit). So a move only ever writes the
    // small set of dots that actually flip — never all 6,000.
    const litOn = (i) => circleEls[i].classList.add("bee-lit");
    const litOff = (i) => circleEls[i].classList.remove("bee-lit");

    function applyScrub(yr) {
      if (yr === lastYr) return; // year-granular: skip redundant mouse moves
      lastYr = yr;
      const b = d3.bisectRight(crossedYears, yr);

      if (!active) {
        dotGNode.classList.add("scrubbing"); // dims all dots in one write
        for (let k = 0; k < b; k++) litOn(crossedIdx[k]); // light those crossed
        active = true;
      } else if (b > boundary) {
        for (let k = boundary; k < b; k++) litOn(crossedIdx[k]); // newly crossed
      } else if (b < boundary) {
        for (let k = b; k < boundary; k++) litOff(crossedIdx[k]); // un-crossed
      }
      boundary = b;

      const pct = Math.round((b / total) * 100);
      const px = x(yr);
      // Move the veil so everything right of the scrub line fades out. Single
      // attribute write — independent of dot count.
      veil
        .attr("x", px)
        .attr("width", Math.max(0, width - m.right - px))
        .style("opacity", 0.72);
      scrubLine.attr("x1", px).attr("x2", px).style("opacity", 1);
      scrubLabel.attr("x", px).text(yr).style("opacity", 1);
      readout
        .style("opacity", 1)
        .text(`By ${yr}, ${pct}% of Earth has crossed ${thLabel()}`);
    }
    function clearScrub() {
      veil.style("opacity", 0);
      scrubLine.style("opacity", 0);
      scrubLabel.style("opacity", 0);
      readout.style("opacity", 0);
      if (active) {
        dotGNode.classList.remove("scrubbing");
        for (let k = 0; k < boundary; k++) litOff(crossedIdx[k]); // only the lit ones
        active = false;
        boundary = 0;
        lastYr = null;
      }
    }

    // Track the cursor at the svg level so scrubbing keeps working even when
    // the pointer is over a dot (events bubble up) — and per-dot tooltips
    // continue to fire on the dots themselves.
    //
    // Performance: we deliberately do NOT use d3.pointer() here. It calls
    // getScreenCTM(), which forces a synchronous style+layout recalc — and
    // because the previous move just changed classes on thousands of dots,
    // that recalc is expensive, causing the drag jank. Instead we cache the
    // svg's client rect once per gesture and map clientX → svg-x arithmetically,
    // so the hot path never reads layout and the class changes only trigger a
    // cheap, batched opacity repaint.
    let cachedRect = null;
    const viewScaleX = () => width / cachedRect.width; // viewBox px per CSS px
    svg
      .style("cursor", "ew-resize")
      .on("pointerenter.scrub", function () {
        cachedRect = svg.node().getBoundingClientRect();
      })
      .on("pointermove.scrub", function (event) {
        if (!cachedRect) cachedRect = svg.node().getBoundingClientRect();
        const mx = (event.clientX - cachedRect.left) * viewScaleX();
        if (mx < m.left || mx > width - m.right) {
          clearScrub();
          return;
        }
        const yr = Math.max(2020, Math.min(2100, Math.round(x.invert(mx))));
        applyScrub(yr);
      })
      .on("pointerleave.scrub", function () {
        clearScrub();
        cachedRect = null;
      });

    built = true;
  }

  function show() {
    if (!built) {
      build();
      // Legend can wrap/reflow after first paint and shrink the chart; rebuild
      // once on the next frame so the viewBox matches the final height.
      requestAnimationFrame(() => build());
    }
  }
  function reveal() {
    if (revealed) return;
    revealed = true;
    // No entrance transition: staggering ~6,000 dots is laggy on the first
    // scroll into this act, so snap straight to the final state.
    g.selectAll(".bee-dot")
      .attr("r", function () {
        return +this.getAttribute("data-r");
      })
      .style("opacity", 1);
  }
  return { init, show, reveal };
})();

// =========================================================
// ACT V — FAN CHART
// =========================================================
const fanModule = (() => {
  let svg, g, dims;
  let built = false;
  let revealed = false;

  function init() {
    svg = d3.select("#fan-svg");
    g = svg.append("g").attr("class", "fan-root");
    const ro = new ResizeObserver(() => {
      if (built) build();
    });
    ro.observe(svg.node());
    window.addEventListener("unitchange", () => {
      if (built) build();
    });
  }

  function build() {
    const node = svg.node();
    const { width, height } = node.getBoundingClientRect();
    if (!width || !height) return;
    svg.attr("viewBox", `0 0 ${width} ${height}`);
    const m = { top: 60, right: 130, bottom: 60, left: 60 };
    dims = { width, height, m };
    g.selectAll("*").remove();

    const years = data.grid.years;
    const TODAY = 2026;
    const x = d3
      .scaleLinear()
      .domain([d3.min(years), d3.max(years)])
      .range([m.left, width - m.right]);
    const y = d3
      .scaleLinear()
      .domain([-1, 6])
      .range([height - m.bottom, m.top]);

    // Axes
    g.append("g")
      .attr("class", "fan-axis")
      .attr("transform", `translate(0,${height - m.bottom})`)
      .call(
        d3
          .axisBottom(x)
          .tickValues([2020, 2040, 2060, 2080, 2100])
          .tickFormat(d3.format("d"))
      );
    g.append("g")
      .attr("class", "fan-axis")
      .attr("transform", `translate(${m.left},0)`)
      .call(
        d3
          .axisLeft(y)
          .ticks(6)
          .tickFormat((d) => unitTick(d))
          .tickSize(-(width - m.left - m.right))
      );
    g.selectAll(".fan-axis line")
      .attr("class", "gridline")
      .attr("stroke-dasharray", "2 3");

    // Possibility space (between 126 and 585) — fill from divergence onward
    const lo = data.globalMeans["ssp126"];
    const hi = data.globalMeans["ssp585"];
    const possibility = years
      .map((yr, i) => ({ yr, lo: lo[i], hi: hi[i] }))
      .filter((d) => d.yr >= TODAY);
    const possibleArea = d3
      .area()
      .x((d) => x(d.yr))
      .y0((d) => y(d.lo))
      .y1((d) => y(d.hi))
      .curve(d3.curveMonotoneX);
    g.append("path")
      .attr("class", "fan-possibility-area")
      .attr("d", possibleArea(possibility))
      .attr("fill", "url(#possibility-grad)")
      .attr("opacity", revealed ? 1 : 0);

    // Gradient
    const defs = svg.select("defs").empty()
      ? svg.append("defs")
      : svg.select("defs");
    defs.selectAll("#possibility-grad").remove();
    const grad = defs
      .append("linearGradient")
      .attr("id", "possibility-grad")
      .attr("x1", "0%")
      .attr("x2", "0%")
      .attr("y1", "0%")
      .attr("y2", "100%");
    grad
      .append("stop")
      .attr("offset", "0%")
      .attr("stop-color", "var(--bad)")
      .attr("stop-opacity", 0.18);
    grad
      .append("stop")
      .attr("offset", "100%")
      .attr("stop-color", "var(--good)")
      .attr("stop-opacity", 0.18);

    // Threshold lines
    [1.5, 2, 3].forEach((t) => {
      g.append("line")
        .attr("class", "threshold-line")
        .attr("x1", m.left)
        .attr("x2", width - m.right)
        .attr("y1", y(t))
        .attr("y2", y(t));
      g.append("text")
        .attr("class", "threshold-label")
        .attr("x", m.left + 4)
        .attr("y", y(t) - 4)
        .text(`+${fmtMag(t)}`);
    });

    // Today vertical
    g.append("line")
      .attr("x1", x(TODAY))
      .attr("x2", x(TODAY))
      .attr("y1", m.top)
      .attr("y2", height - m.bottom)
      .attr("stroke", "var(--ink-faint)")
      .attr("stroke-dasharray", "2 3");
    g.append("text")
      .attr("x", x(TODAY))
      .attr("y", m.top - 8)
      .attr("text-anchor", "middle")
      .style("font-family", "var(--font-mono)")
      .style("font-size", "10px")
      .style("fill", "var(--ink-faint)")
      .text("today");

    // Scenario lines
    const line = d3
      .line()
      .x((_, i) => x(years[i]))
      .y((d) => y(d))
      .curve(d3.curveMonotoneX);

    ["ssp585", "ssp245", "ssp126"].forEach((sc) => {
      const series = data.globalMeans[sc];
      const path = g
        .append("path")
        .attr("class", `fan-line fan-line-${sc.slice(-3)}`)
        .attr("d", line(series));
      const totalLen = path.node().getTotalLength();
      path
        .attr("stroke-dasharray", `${totalLen} ${totalLen}`)
        .attr("data-length", totalLen)
        .attr("stroke-dashoffset", revealed ? 0 : totalLen);

      // End label
      const endVal = series[series.length - 1];
      g.append("text")
        .attr("class", "fan-scenario-label")
        .attr("x", x(years[years.length - 1]) + 8)
        .attr("y", y(endVal) + 4)
        .style(
          "fill",
          sc === "ssp126"
            ? "var(--good)"
            : sc === "ssp245"
            ? "var(--accent-2)"
            : "var(--bad)"
        )
        .style("opacity", revealed ? 1 : 0)
        .text(`${SCENARIO_LABELS[sc]}: ${fmtAnom(endVal)}`);
    });

    // Divergence annotation
    const gap = hi[hi.length - 1] - lo[lo.length - 1];
    g.append("text")
      .attr("class", "fan-divergence-anno")
      .attr("x", x(2090))
      .attr("y", y((hi[hi.length - 1] + lo[lo.length - 1]) / 2))
      .attr("text-anchor", "middle")
      .style("opacity", revealed ? 1 : 0)
      .text(`Δ ${fmtMag(gap)}`);
    g.append("text")
      .attr("class", "fan-divergence-note")
      .attr("x", x(2090))
      .attr("y", y((hi[hi.length - 1] + lo[lo.length - 1]) / 2) + 16)
      .attr("text-anchor", "middle")
      .style("font-family", "var(--font-mono)")
      .style("font-size", "10px")
      .style("fill", "var(--ink-faint)")
      .style("opacity", revealed ? 1 : 0)
      .text("possibility space");

    // ---- Hover scrubber ----
    const SCEN = ["ssp126", "ssp245", "ssp585"];
    const scrubG = g.append("g").style("opacity", 0);
    const scrubLine = scrubG
      .append("line")
      .attr("class", "fan-scrub-line")
      .attr("y1", m.top)
      .attr("y2", height - m.bottom);
    const scrubDots = SCEN.map((sc) =>
      scrubG
        .append("circle")
        .attr("class", "fan-scrub-dot")
        .attr("r", 4)
        .attr(
          "fill",
          sc === "ssp126"
            ? "var(--good)"
            : sc === "ssp245"
            ? "var(--accent-2)"
            : "var(--bad)"
        )
    );

    g.append("rect")
      .attr("x", m.left)
      .attr("y", m.top)
      .attr("width", width - m.left - m.right)
      .attr("height", height - m.top - m.bottom)
      .style("fill", "transparent")
      .style("cursor", "crosshair")
      .on("pointermove", function (event) {
        const [mx] = d3.pointer(event, g.node());
        const yr = Math.max(
          years[0],
          Math.min(years[years.length - 1], Math.round(x.invert(mx)))
        );
        const i = years.indexOf(yr);
        if (i < 0) return;
        const px = x(yr);
        scrubG.style("opacity", 1);
        scrubLine.attr("x1", px).attr("x2", px);
        SCEN.forEach((sc, k) =>
          scrubDots[k].attr("cx", px).attr("cy", y(data.globalMeans[sc][i]))
        );
        const lo = data.globalMeans["ssp126"][i];
        const hi = data.globalMeans["ssp585"][i];
        const rows = ["ssp585", "ssp245", "ssp126"]
          .map((sc) => {
            const v = data.globalMeans[sc][i];
            const col =
              sc === "ssp126"
                ? "var(--good)"
                : sc === "ssp245"
                ? "var(--accent-2)"
                : "var(--bad)";
            return `<div class="tip-row"><span class="tip-key" style="color:${col}">${
              SCENARIO_LABELS[sc]
            }</span><span class="tip-val">${fmtAnom(v, 2)}</span></div>`;
          })
          .join("");
        scrollyTip(
          "panel-fan",
          event,
          `<div class="tip-headline" style="font-size:15px">${yr}</div>${rows}` +
            `<div class="tip-row"><span class="tip-key">spread</span><span class="tip-val">${fmtMag(
              hi - lo,
              2
            )}</span></div>`
        );
      })
      .on("pointerleave", () => {
        scrubG.style("opacity", 0);
        scrollyTipHide();
      });

    built = true;
  }

  function show() {
    if (!built) build();
  }
  function reveal() {
    if (revealed) return;
    revealed = true;
    if (prefersReducedMotion()) {
      g.select(".fan-possibility-area").attr("opacity", 1);
      g.selectAll(".fan-line").attr("stroke-dashoffset", 0);
      g.selectAll(
        ".fan-scenario-label, .fan-divergence-anno, .fan-divergence-note"
      ).style("opacity", 1);
      return;
    }
    g.select(".fan-possibility-area")
      .transition()
      .delay(250)
      .duration(760)
      .attr("opacity", 1);
    g.selectAll(".fan-line")
      .transition()
      .delay((d, i) => i * 140)
      .duration(1050)
      .ease(d3.easeCubicInOut)
      .attr("stroke-dashoffset", 0);
    g.selectAll(
      ".fan-scenario-label, .fan-divergence-anno, .fan-divergence-note"
    )
      .transition()
      .delay(950)
      .duration(420)
      .style("opacity", 1);
  }
  return { init, show, reveal };
})();

// =========================================================
// ACT V — LIFETIME TIMELINE
// =========================================================
const lifetimeModule = (() => {
  let svg, g, dims;
  let built = false;
  let revealed = false;
  let started = false; // becomes true once the user submits a birth year

  // Compute first crossing of +2°C for various reference series
  function getMilestones(scenario) {
    const TH = 2.0;
    const cross = `crosses +${fmtMag(TH)}`;
    const years = data.grid.years;
    const findCross = (series) => {
      for (let i = 0; i < series.length; i++)
        if (series[i] >= TH) return years[i];
      return null;
    };

    const items = [];
    items.push({
      key: "global",
      label: `Global mean ${cross}`,
      year: findCross(data.globalMeans[scenario]),
      color: "var(--accent)",
    });
    const r = data.regionalMeans[scenario];
    const named = [
      { k: "Arctic", label: `Arctic ${cross}`, color: "#7a0a04" },
      { k: "Europe", label: `Europe ${cross}`, color: "#ff5c2b" },
      { k: "South Asia", label: `South Asia ${cross}`, color: "#ffaa3d" },
      { k: "Amazon", label: `Amazon ${cross}`, color: "#88b8c4" },
      { k: "Antarctic", label: `Antarctic ${cross}`, color: "#5fa8d3" },
    ];
    named.forEach((n) => {
      if (r[n.k])
        items.push({
          key: n.k,
          label: n.label,
          year: findCross(r[n.k]),
          color: n.color,
        });
    });
    return items;
  }

  function readBirthInput() {
    const input = document.getElementById("birth-year-input");
    const v = Math.max(1930, Math.min(2025, +input.value || 2000));
    input.value = v;
    scrollyState.birthYear = v;
    return v;
  }

  // User submitted a birth year: slide the popup up, reveal the graph.
  function start() {
    readBirthInput();
    if (started) return;
    started = true;
    const panel = document.getElementById("panel-lifetime");
    panel.classList.add("lifetime-started");
    document.getElementById("lifetime-hint").textContent =
      "Drag across the chart to zoom into any stretch of your life.";
    build();
    reveal();
    // The control bar then morphs/wraps to its final height; a ResizeObserver on
    // it (set up in init) rebuilds the chart so the header + plot clear it.
  }

  // Reset the *view* only (keep the birth year): clear zoom + scrub, restore
  // the default scenario.
  function reset() {
    scrollyState.lifeZoom = null;
    scrollyState.lifeScrubYear = null;
    scrollyState.lifetimeScenario = "ssp585";
    document
      .querySelectorAll("#lifetime-scenario-toggle .seg-btn-mini")
      .forEach((b) => b.classList.toggle("active", b.dataset.value === "ssp585"));
    rebuildAnimated();
  }

  // Rebuild the chart (e.g. swapping to a zoomed/reset view) with a quick
  // fade-in. Build happens synchronously so the new view always renders even if
  // the fade transition is interrupted.
  function rebuildAnimated() {
    build();
    if (!started || prefersReducedMotion()) return;
    g.interrupt().style("opacity", 0).transition().duration(260).style("opacity", 1);
    // Safety net: guarantee the chart ends fully visible even if the fade
    // transition is interrupted or its timer never advances.
    setTimeout(() => g.style("opacity", 1), 320);
  }

  function init() {
    svg = d3.select("#lifetime-svg");
    g = svg.append("g").attr("class", "lifetime-root");
    // Coalesce rapid rebuilds (e.g. while the control bar morphs/wraps over many
    // frames) into one build per frame.
    let buildScheduled = false;
    const scheduleBuild = () => {
      if (buildScheduled || !built) return;
      buildScheduled = true;
      requestAnimationFrame(() => {
        buildScheduled = false;
        if (built) build();
      });
    };
    const ro = new ResizeObserver(scheduleBuild);
    ro.observe(svg.node());
    // The floating control bar's height depends on how its buttons wrap, and it
    // changes as the bar morphs in or the window resizes. Observe it so the
    // chart header + plot are always re-laid-out below the bar's real bottom
    // edge — a fixed guess gets hidden behind a taller, wrapped bar.
    const card = document.querySelector("#panel-lifetime .lifetime-card");
    if (card) {
      const cardRo = new ResizeObserver(() => {
        if (built && started) scheduleBuild();
      });
      cardRo.observe(card);
    }
    window.addEventListener("unitchange", () => {
      if (built) build();
    });

    // Submit birth year (button or Enter in the input)
    document.getElementById("lifetime-go").addEventListener("click", start);
    const input = document.getElementById("birth-year-input");
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") start();
    });
    input.addEventListener("change", () => {
      readBirthInput();
      if (started) rebuildAnimated();
    });

    // Reset view
    document.getElementById("lifetime-reset").addEventListener("click", reset);

    // Scenario toggle (only redraws once the chart is live)
    document
      .querySelectorAll("#lifetime-scenario-toggle .seg-btn-mini")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          document
            .querySelectorAll("#lifetime-scenario-toggle .seg-btn-mini")
            .forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          scrollyState.lifetimeScenario = btn.dataset.value;
          if (started) rebuildAnimated();
        });
      });
  }

  // Anomaly the chosen scenario reaches in a given (integer) year
  function valueAt(scen, year) {
    const years = data.grid.years;
    const i = Math.max(0, Math.min(years.length - 1, year - years[0]));
    return data.globalMeans[scen][i];
  }

  function build() {
    const node = svg.node();
    const { width, height } = node.getBoundingClientRect();
    if (!width || !height) return;
    svg.attr("viewBox", `0 0 ${width} ${height}`);
    // Once started, the floating control bar sits across the top of the panel,
    // so drop the chart header + plot down to clear it. The bar wraps to a
    // different height depending on width, so measure its real bottom edge
    // rather than assuming a fixed height — otherwise it hides the chart title.
    let headerY = 8;
    let topMargin = 120;
    if (started) {
      const card = document.querySelector("#panel-lifetime .lifetime-card");
      const panel = document.getElementById("panel-lifetime");
      let barBottom = 94; // fallback ≈ default single-row bar
      if (card && panel) {
        barBottom =
          card.getBoundingClientRect().bottom - panel.getBoundingClientRect().top;
      }
      headerY = barBottom + 24;
      topMargin = headerY + 90;
    }
    const m = { top: topMargin, right: 96, bottom: 56, left: 64 };
    dims = { width, height, m };
    g.selectAll("*").remove();

    const birth = scrollyState.birthYear;
    const scen = scrollyState.lifetimeScenario;
    const years = data.grid.years;
    const dataStart = years[0]; // first year we actually have data (≈2015)
    const xMax = 2100;
    const xMin = Math.min(birth, dataStart);
    const curveStart = Math.max(birth, dataStart); // lived-warming begins here
    // Visible window: full lifetime, or a zoomed-in range the user brushed.
    const zoom = scrollyState.lifeZoom;
    const domMin = zoom ? Math.max(xMin, zoom[0]) : xMin;
    const domMax = zoom ? Math.min(xMax, zoom[1]) : xMax;
    const x = d3
      .scaleLinear()
      .domain([domMin, domMax])
      .range([m.left, width - m.right]);

    const plotTop = m.top,
      plotBottom = height - m.bottom;
    const yTop = Math.ceil(
      d3.max(["ssp126", "ssp245", "ssp585"], (s) => d3.max(data.globalMeans[s]))
    );
    const y = d3
      .scaleLinear()
      .domain([-0.15, yTop])
      .range([plotBottom, plotTop]);

    // Warming the person has lived through, relative to their birth year
    const baseAtBirth = valueAt(scen, curveStart);

    // ---- Gradients (time: cool early → hot late) ----
    const defs = svg.select("defs").empty()
      ? svg.append("defs")
      : svg.select("defs");
    defs.selectAll("#life-gradient").remove();
    const grad = defs
      .append("linearGradient")
      .attr("id", "life-gradient")
      .attr("x1", x(curveStart))
      .attr("x2", x(xMax))
      .attr("y1", 0)
      .attr("y2", 0)
      .attr("gradientUnits", "userSpaceOnUse");
    grad.append("stop").attr("offset", "0%").attr("stop-color", "#5fa8d3");
    grad.append("stop").attr("offset", "40%").attr("stop-color", "#fde29c");
    grad.append("stop").attr("offset", "75%").attr("stop-color", "#ff5c2b");
    grad.append("stop").attr("offset", "100%").attr("stop-color", "#7a0a04");

    // Clip the trajectory to the plot area so a zoomed view doesn't spill out.
    defs.selectAll("#life-clip").remove();
    defs
      .append("clipPath")
      .attr("id", "life-clip")
      .append("rect")
      .attr("x", m.left)
      .attr("y", plotTop - 60)
      .attr("width", width - m.left - m.right)
      .attr("height", plotBottom - plotTop + 60);

    // ---- Axes ----
    g.append("g")
      .attr("class", "life-axis")
      .attr("transform", `translate(0, ${plotBottom + 6})`)
      .call(d3.axisBottom(x).ticks(8).tickFormat(d3.format("d")));
    g.append("g")
      .attr("class", "life-axis life-axis-y")
      .attr("transform", `translate(${m.left}, 0)`)
      .call(
        d3
          .axisLeft(y)
          .ticks(5)
          .tickFormat((d) => `+${unitTick(d)}`)
          .tickSize(-(width - m.left - m.right))
      );
    g.selectAll(".life-axis-y line")
      .attr("class", "gridline")
      .attr("stroke-dasharray", "2 3");

    // +1.5 / +2 reference lines
    [1.5, 2].forEach((t) => {
      g.append("line")
        .attr("class", "life-threshold-line")
        .attr("x1", m.left)
        .attr("x2", width - m.right)
        .attr("y1", y(t))
        .attr("y2", y(t));
      g.append("text")
        .attr("class", "life-eyebrow")
        .attr("x", width - m.right - 2)
        .attr("y", y(t) - 5)
        .attr("text-anchor", "end")
        .text(`+${fmtMag(t)}`);
    });

    // ---- Lifetime warming trajectory ----
    const pts = years
      .filter((yr) => yr >= curveStart)
      .map((yr) => ({ yr, v: valueAt(scen, yr) }));
    const area = d3
      .area()
      .x((d) => x(d.yr))
      .y0(plotBottom)
      .y1((d) => y(d.v))
      .curve(d3.curveMonotoneX);
    const line = d3
      .line()
      .x((d) => x(d.yr))
      .y((d) => y(d.v))
      .curve(d3.curveMonotoneX);

    g.append("path")
      .attr("class", "life-area")
      .attr("d", area(pts))
      .attr("fill", "url(#life-gradient)")
      .attr("clip-path", "url(#life-clip)")
      .style("opacity", revealed ? null : 0);
    const lifeLinePath = g
      .append("path")
      .attr("class", "life-line")
      .attr("clip-path", "url(#life-clip)")
      .attr("d", line(pts));
    const lifeLineLen = lifeLinePath.node().getTotalLength();
    lifeLinePath
      .attr("stroke-dasharray", `${lifeLineLen} ${lifeLineLen}`)
      .attr("stroke-dashoffset", revealed ? 0 : lifeLineLen);

    // Pre-data hint (birth before our records begin)
    if (birth < dataStart) {
      g.append("line")
        .attr("class", "life-predata")
        .attr("x1", x(birth))
        .attr("x2", x(dataStart))
        .attr("y1", y(baseAtBirth))
        .attr("y2", y(baseAtBirth));
      g.append("text")
        .attr("class", "life-eyebrow")
        .attr("x", (x(birth) + x(dataStart)) / 2)
        .attr("y", y(baseAtBirth) - 8)
        .attr("text-anchor", "middle")
        .text("before records");
    }

    // ---- Milestone markers on the curve (packed labels along the top) ----
    const milestones = getMilestones(scen)
      .filter(
        (d) =>
          d.year != null &&
          d.year >= Math.max(curveStart, domMin) &&
          d.year <= domMax
      )
      .sort((a, b) => a.year - b.year);
    // Two staggered rows so clustered late-century crossings don't overprint.
    const LABEL_GAP = 128;
    const rowLastX = [-1e9, -1e9];
    const rowY = [plotTop + 8, plotTop + 44];
    milestones.forEach((mi, idx) => {
      const px = x(mi.year);
      const cy = y(valueAt(scen, mi.year));
      const row = idx % 2;
      const labelX = Math.min(
        width - m.right - 6,
        Math.max(px, rowLastX[row] + LABEL_GAP)
      );
      rowLastX[row] = labelX;
      const ly = rowY[row];
      g.append("line")
        .attr("class", "life-milestone-line life-milestone-mark")
        .attr("x1", px)
        .attr("x2", px)
        .attr("y1", cy)
        .attr("y2", ly + 2)
        .attr("stroke", mi.color);
      g.append("circle")
        .attr("class", "life-milestone-dot life-milestone-mark")
        .attr("cx", px)
        .attr("cy", cy)
        .attr("r", 4.5)
        .attr("fill", mi.color);
      const lg = g
        .append("g")
        .attr("class", "life-milestone-mark")
        .attr("transform", `translate(${labelX}, ${ly})`);
      if (labelX !== px) {
        lg.append("line")
          .attr("class", "life-milestone-line")
          .attr("x1", px - labelX)
          .attr("x2", 0)
          .attr("y1", 2)
          .attr("y2", -2)
          .attr("stroke", mi.color);
      }
      lg.append("text")
        .attr("class", "life-milestone-text")
        .attr("text-anchor", "middle")
        .attr("y", -2)
        .style("fill", mi.color)
        .style("font-weight", 600)
        .text(mi.year);
      lg.append("text")
        .attr("class", "life-milestone-text")
        .attr("text-anchor", "middle")
        .attr("y", -13)
        .style("fill", "var(--ink-faint)")
        .style("font-size", "8.5px")
        .text(mi.label.replace(" crosses +", " +"));
    });

    // ---- Birth handle (draggable) — only when the birth year is in view ----
    if (birth >= domMin && birth <= domMax) {
      const birthHandle = g
        .append("g")
        .attr("class", "life-birth-handle")
        .style("cursor", "ew-resize");
      birthHandle
        .append("line")
        .attr("class", "life-birth-stem")
        .attr("x1", 0)
        .attr("x2", 0)
        .attr("y1", y(baseAtBirth))
        .attr("y2", plotBottom);
      birthHandle
        .append("circle")
        .attr("cx", 0)
        .attr("cy", y(baseAtBirth))
        .attr("r", 7)
        .attr("fill", "var(--ink)")
        .attr("stroke", "var(--bg)")
        .attr("stroke-width", 3);
      birthHandle
        .append("text")
        .attr("class", "life-birth-label")
        .attr("x", 0)
        .attr("y", y(baseAtBirth) - 14)
        .attr("text-anchor", "middle")
        .text(`born ${birth}`);
      birthHandle.attr("transform", `translate(${x(birth)},0)`);
      birthHandle.raise().call(
        d3.drag().on("drag", (event) => {
          const yr = Math.max(1930, Math.min(2025, Math.round(x.invert(event.x))));
          if (yr !== scrollyState.birthYear) {
            scrollyState.birthYear = yr;
            document.getElementById("birth-year-input").value = yr;
            build();
          }
        })
      );
    }

    const eventYearButtons = document.querySelectorAll(".event-year-btn");
    const birthInput = document.getElementById("birth-year-input");
    const lifetimeGo = document.getElementById("lifetime-go");
    const lifetimeReset = document.getElementById("lifetime-reset");
    const lifetimeHint = document.getElementById("lifetime-hint");
    
    eventYearButtons.forEach((button) => {
      button.addEventListener("click", () => {
        const year = button.dataset.year;
        const label = button.dataset.label;
    
        eventYearButtons.forEach((b) => b.classList.remove("active"));
        button.classList.add("active");
    
        if (lifetimeReset) {
          lifetimeReset.click();
        }
    
        birthInput.value = year;
    
        lifetimeHint.textContent = `Tracing warming from ${label} (${year}). You can still type your own birth year above.`;
    
        lifetimeGo.click();
      });
    });
    
    // ---- Header / live readout ----
    g.append("text")
      .attr("class", "life-eyebrow")
      .attr("x", m.left)
      .attr("y", headerY)
      .text(
        (zoom ? `Zoomed ${domMin}–${domMax}` : "Your lifetime") +
          " · " +
          SCENARIO_LABELS[scen] +
          " · drag to zoom · hover to read"
      );
    const headline = g
      .append("text")
      .attr("class", "life-age-text")
      .attr("x", m.left)
      .attr("y", headerY + 30)
      .style("font-size", "24px");
    const subline = g
      .append("text")
      .attr("class", "life-eyebrow")
      .attr("x", m.left)
      .attr("y", headerY + 54)
      .style("font-size", "12px")
      .style("letter-spacing", "0.04em")
      .style("text-transform", "none")
      .style("fill", "var(--ink-soft)");

    // ---- Age scrubber (the core interaction) ----
    const scrub = g.append("g").attr("class", "life-scrub");
    const scrubLine = scrub
      .append("line")
      .attr("class", "life-scrub-line")
      .attr("y1", plotTop)
      .attr("y2", plotBottom);
    const scrubDot = scrub
      .append("circle")
      .attr("class", "life-scrub-dot")
      .attr("r", 6);
    const scrubBadge = scrub.append("g").attr("class", "life-scrub-badge");
    const badgeRect = scrubBadge
      .append("rect")
      .attr("rx", 5)
      .attr("height", 20)
      .attr("y", -28);
    const badgeText = scrubBadge
      .append("text")
      .attr("y", -14)
      .attr("text-anchor", "middle");

    const scrubLo = Math.max(curveStart, domMin);
    const scrubHi = Math.min(xMax, domMax);
    function setScrub(year) {
      year = Math.max(scrubLo, Math.min(scrubHi, Math.round(year)));
      scrollyState.lifeScrubYear = year;
      const v = valueAt(scen, year);
      const px = x(year),
        py = y(v);
      const age = year - birth;
      const delta = v - baseAtBirth;
      scrubLine.attr("x1", px).attr("x2", px);
      scrubDot.attr("cx", px).attr("cy", py);
      scrubBadge.attr("transform", `translate(${px}, ${py})`);
      const label = `age ${age} · ${year}`;
      badgeText.text(label);
      const tw = label.length * 6.2 + 16;
      badgeRect.attr("x", -tw / 2).attr("width", tw);
      const signed = (n) =>
        `${n >= 0 ? "+" : "−"}${Math.abs(toUnit(n)).toFixed(1)}${unitSym()}`;
      headline.text(`At age ${age}, you live in a ${signed(v)} world.`);
      subline.text(
        delta >= 0.05
          ? `That's +${fmtMag(delta)} hotter than the year you were born.`
          : `Right around the warming baseline of your birth year.`
      );
    }

    // ---- Brush: drag across a stretch of time to zoom into it ----
    const brush = d3
      .brushX()
      .extent([
        [m.left, plotTop],
        [width - m.right, plotBottom],
      ])
      .on("end", brushed);

    function brushed({ selection, sourceEvent }) {
      // Ignore programmatic clears (no sourceEvent) and empty selections.
      if (!selection || !sourceEvent) return;
      const [px0, px1] = selection;
      const y0 = Math.round(x.invert(px0));
      const y1 = Math.round(x.invert(px1));
      brushGroup.call(brush.move, null); // drop the grey selection box
      if (y1 - y0 < 3) return; // too small to be meaningful
      scrollyState.lifeZoom = [y0, y1];
      rebuildAnimated();
    }

    const brushGroup = g.append("g").attr("class", "life-brush").call(brush);

    // Keep the hover readout working: the brush's overlay rect still receives
    // pointermove when the user isn't actively dragging a selection.
    brushGroup
      .select(".overlay")
      .style("cursor", "crosshair")
      .on("pointermove.read", function (event) {
        setScrub(x.invert(d3.pointer(event, g.node())[0]));
      });

    // Layering: the scrub indicator and the draggable birth handle must sit
    // above the brush overlay. The area/line/milestones are non-interactive
    // (see CSS) so the overlay still receives hover everywhere.
    scrub.raise();
    g.select(".life-birth-handle").raise();

    // Park the scrubber at its remembered year (or the start of the view)
    const initYear =
      scrollyState.lifeScrubYear != null
        ? Math.max(scrubLo, Math.min(scrubHi, scrollyState.lifeScrubYear))
        : Math.max(scrubLo, Math.min(scrubHi, 2026));
    setScrub(initYear);

    g.selectAll(".life-milestone-mark").style("opacity", revealed ? 1 : 0);

    built = true;
  }
  const eventYearButtons = document.querySelectorAll(".event-year-btn");
  const birthInput = document.getElementById("birth-year-input");
  const lifetimeGo = document.getElementById("lifetime-go");
  const lifetimeHint = document.getElementById("lifetime-hint");
  
  eventYearButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const year = button.dataset.year;
      const label = button.dataset.label;
  
      // Fill the existing birth year input
      birthInput.value = year;
  
      // Optional: update the hint text
      lifetimeHint.textContent = `Tracing warming from ${label}. Since the climate data is yearly, the chart starts at ${year}.`;
  
      // This runs the same logic as clicking "See my lifetime"
      lifetimeGo.click();
    });
  });
  function show() {
    // Graph stays hidden behind the popup until the user submits a birth year.
    if (started && !built) build();
  }
  function reveal() {
    if (!started) return;
    if (revealed) return;
    revealed = true;
    if (prefersReducedMotion()) {
      g.select(".life-area").style("opacity", null);
      g.select(".life-line").attr("stroke-dashoffset", 0);
      g.selectAll(".life-milestone-mark").style("opacity", 1);
      return;
    }
    g.select(".life-area").transition().duration(760).style("opacity", 0.5);
    g.select(".life-line")
      .transition()
      .duration(1100)
      .ease(d3.easeCubicInOut)
      .attr("stroke-dashoffset", 0);
    g.selectAll(".life-milestone-mark")
      .transition()
      .delay((d, i) => 760 + i * 55)
      .duration(300)
      .style("opacity", 1);
  }
  return { init, show, reveal };
})();

// =========================================================
// SCROLLAMA CONTROLLER
// =========================================================
function setupStickyStepStage() {
  const scrolly = document.getElementById("scrolly");
  const stepsEl = document.getElementById("scroll-steps");
  const steps = Array.from(stepsEl.querySelectorAll(".step"));

  let stage = document.getElementById("step-stage");
  if (!stage) {
    stage = document.createElement("div");
    stage.className = "step-stage";
    stage.id = "step-stage";
    stage.setAttribute("aria-live", "polite");
    const inner = document.createElement("div");
    inner.className = "step-stage-inner";
    steps.forEach((step) => {
      const copy = document.createElement("article");
      copy.className = "step-copy";
      copy.dataset.step = step.dataset.step;
      copy.innerHTML = step.innerHTML;
      copy.insertAdjacentHTML(
        "beforeend",
        '<div class="scrolly-progress" aria-hidden="true"><span class="scrolly-progress-fill"></span></div>'
      );
      inner.appendChild(copy);
      step.setAttribute("aria-hidden", "true");
    });
    stage.appendChild(inner);
    scrolly.insertBefore(stage, stepsEl);
  }

  let activeStep = "stripes";
  let raf = null;
  const clamp01 = (value) => Math.max(0, Math.min(1, value));

  function setActive(stepName) {
    activeStep = stepName;
    stage.querySelectorAll(".step-copy").forEach((copy) => {
      copy.classList.toggle("is-active", copy.dataset.step === stepName);
    });
    updateProgress();
  }

  function updateProgress() {
    const scrollyRect = scrolly.getBoundingClientRect();
    const isVisible =
      scrollyRect.top < window.innerHeight * 0.95 &&
      scrollyRect.bottom > window.innerHeight * 0.05 &&
      !document.documentElement.classList.contains("is-loading");
    stage.classList.toggle("is-progress-visible", isVisible);

    const current =
      steps.find((step) => step.dataset.step === activeStep) || steps[0];
    const rect = current.getBoundingClientRect();
    const threshold = window.innerHeight * 0.55;
    const value = rect.height
      ? clamp01((threshold - rect.top) / rect.height)
      : 0;
    stage.style.setProperty("--scrolly-progress", value.toFixed(3));
  }

  function scheduleProgressUpdate() {
    if (raf != null) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      updateProgress();
    });
  }

  window.addEventListener("scroll", scheduleProgressUpdate, { passive: true });
  window.addEventListener("resize", scheduleProgressUpdate);
  setActive(activeStep);

  return { setActive, updateProgress };
}

function setupScrollama() {
  const scroller = scrollama();
  const stickyText = setupStickyStepStage();
  const actModules = {
    stripes: stripesModule,
    map: scrollMapModule,
    ridge: ridgeModule,
    beeswarm: beeswarmModule,
    fan: fanModule,
    lifetime: lifetimeModule,
  };

  function activatePanel(step) {
    document.querySelectorAll(".viz-panel").forEach((p) => {
      p.classList.toggle("active", p.dataset.viz === step);
    });
    document.querySelectorAll(".step").forEach((s) => {
      s.classList.toggle("is-active", s.dataset.step === step);
    });
    scrollyState.activeStep = step;
    stickyText.setActive(step);

    const module = actModules[step];
    if (module) {
      module.show();
      module.reveal();
    }
  }

  scroller
    .setup({
      step: "#scroll-steps .step",
      offset: 0.55,
      debug: false,
    })
    .onStepEnter(({ element }) => {
      const step = element.dataset.step;
      if (step === "finale") {
        // For the finale step, keep the previous panel showing
        document.querySelectorAll(".step").forEach((s) => {
          s.classList.toggle("is-active", s.dataset.step === "finale");
        });
        scrollyState.activeStep = "finale";
        stickyText.setActive("finale");
        return;
      }
      activatePanel(step);
    });

  window.addEventListener("resize", () => scroller.resize());
}

// =========================================================
// MAIN RENDER
// =========================================================
function render() {
  updateStats();
  legendModule.update();
  mapModule.update();
  globalChartModule.update();
  cellChartModule.update();
  histogramModule.update();
}

// =========================================================
// BOOTSTRAP
// =========================================================
// Climate data is in: unlock scrolling and flip the hero cue to "Scroll to
// begin". Idempotent.
function markDataReady() {
  document.documentElement.classList.remove("is-loading");
  document.body.classList.remove("scroll-locked");
  document.body.style.top = "";
  window.scrollTo(0, 0);
  const lbl = document.getElementById("scroll-label");
  if (lbl) lbl.textContent = "Scroll to begin";
}

function markDataFailed() {
  document.documentElement.classList.remove("is-loading");
  document.body.classList.remove("scroll-locked");
  document.body.style.top = "";
}

function revealStripesOnFirstScroll() {
  let armed = true;
  let timer = null;
  const reveal = () => {
    if (!armed) return;
    armed = false;
    window.removeEventListener("scroll", reveal);
    window.removeEventListener("wheel", reveal);
    window.removeEventListener("touchstart", reveal);
    window.removeEventListener("keydown", revealOnScrollKey);
    timer = setTimeout(() => stripesModule.reveal(), 200);
  };
  const revealOnScrollKey = (event) => {
    if (
      [
        "ArrowDown",
        "ArrowUp",
        "PageDown",
        "PageUp",
        "Home",
        "End",
        " ",
      ].includes(event.key)
    ) {
      reveal();
    }
  };
  window.addEventListener("scroll", reveal, { passive: true, once: true });
  window.addEventListener("wheel", reveal, { passive: true, once: true });
  window.addEventListener("touchstart", reveal, { passive: true, once: true });
  window.addEventListener("keydown", revealOnScrollKey);
  return () => {
    armed = false;
    clearTimeout(timer);
    window.removeEventListener("scroll", reveal);
    window.removeEventListener("wheel", reveal);
    window.removeEventListener("touchstart", reveal);
    window.removeEventListener("keydown", revealOnScrollKey);
  };
}

// The interactive dashboard (heavy ~6,000-cell map + side charts).
let dashboardReady = false;
function ensureDashboard() {
  if (dashboardReady) return;
  dashboardReady = true;
  legendModule.init();
  mapModule.init();
  globalChartModule.init();
  cellChartModule.init();
  histogramModule.init();
  wireControls();
  render();
}

// Yield to the browser so the "Loading data…" cue can repaint between builds.
const nextTick = () => new Promise((r) => setTimeout(r, 0));

async function main() {
  // GitHub Pages can be slow to deliver the binary climate data. Keep the
  // scroll lock active until startup really completes; this timer only updates
  // the cue so it doesn't look frozen.
  const loadingNotice = setTimeout(() => {
    const lbl = document.getElementById("scroll-label");
    if (lbl) lbl.textContent = "Still loading data…";
  }, 25000);
  try {
    // Coastlines overlap the data fetch (decorative; they fade in later).
    fetchCoastlines();

    await loadData();

    // Hide the in-card loading overlay.
    const scrollLoading = document.getElementById("scroll-loading");
    if (scrollLoading) {
      scrollLoading.classList.add("hidden");
      setTimeout(() => scrollLoading.remove(), 500);
    }

    // Init every module (cheap)…
    stripesModule.init();
    scrollMapModule.init();
    ridgeModule.init();
    beeswarmModule.init();
    fanModule.init();
    lifetimeModule.init();
    setupScrollama();

    // …then BUILD every visualization while the page is still scroll-locked, so
    // the reader can never scroll into a half-built chart. Yielding between each
    // build keeps the "Loading data…" cue animating instead of freezing.
    const builds = [
      () => stripesModule.show(),
      () => scrollMapModule.show(),
      () => ridgeModule.show(),
      () => beeswarmModule.show(),
      () => fanModule.show(),
      () => lifetimeModule.show(),
      () => ensureDashboard(),
    ];
    for (const build of builds) {
      build();
      await nextTick();
    }

    // Apply a persisted unit preference to all static labels + toolbar buttons
    // now that every panel and its toolbar exist. Charts already read prefs at
    // build time, so this only syncs the markup-driven bits.
    refreshUnitLabels();

    // Everything is rendered — unlock scrolling and flip the cue.
    clearTimeout(loadingNotice);
    markDataReady();
    revealStripesOnFirstScroll();
  } catch (err) {
    console.error("Failed to start app", err);
    // Unlock scrolling so the page isn't stuck, and surface the error.
    clearTimeout(loadingNotice);
    markDataFailed();
    const lbl = document.getElementById("scroll-label");
    if (lbl) lbl.textContent = "Failed to load data";
    const el = document.getElementById("scroll-loading");
    if (el) el.textContent = `error: ${err.message}`;
    const el2 = document.getElementById("map-loading");
    if (el2) el2.textContent = `error: ${err.message}`;
  }
}

document.addEventListener("DOMContentLoaded", main);

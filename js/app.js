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
    document.getElementById("tooltip").classList.remove("visible");
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
        ? `never crosses ${threshold}°C`
        : `crosses ${threshold}°C in ${crossing}`;
  } else {
    headline = `${anom >= 0 ? "+" : ""}${anom.toFixed(2)}°C in ${year}`;
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
      <span class="tip-val">${final >= 0 ? "+" : ""}${final.toFixed(1)}°C</span>
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
  document.getElementById("tooltip").classList.remove("visible");
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
        mode === "crossing" ? `Year crossing +${threshold}°C` : "Anomaly °C"
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
        : ["<0°", "0–1°", "1–2°", "2–3°", "3–4°", "4–5°", "5–6°", "≥6°"];

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
          .tickFormat((d) => `${d}°`)
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
      .text(`+${thNum}°C`);

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
          .tickFormat((d) => `${d}°`)
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
        .text(`crosses ${thNum}°C in ${crossYr}`);
    } else {
      g.append("text")
        .attr("class", "crossing-text")
        .attr("x", width - m.right - 4)
        .attr("y", y(thNum) - 4)
        .attr("text-anchor", "end")
        .attr("fill", "var(--good)")
        .style("font-family", "var(--font-mono)")
        .style("font-size", "10px")
        .text(`stays below ${thNum}°C`);
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
      `First year each region crosses +${state.threshold}°C`
    );
    d3.select("#map-sub").text(
      `Under ${SCENARIO_LABELS[state.scenario]} (${
        SCENARIO_DESC[state.scenario]
      }) · relative to 2015–2034 baseline · click any cell to inspect`
    );
  } else {
    d3.select("#map-title").text(`Temperature anomaly in ${state.year}`);
    d3.select("#map-sub").text(
      `Under ${SCENARIO_LABELS[state.scenario]} · °C above 2015–2034 baseline`
    );
  }

  // Hero threshold
  d3.select("#hero-threshold").text(`${state.threshold}°C`);

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

// Build a list of {cellIdx, lat, lon, band, crossing} for current scenario+threshold
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
      });
    }
  }
  return out;
}

// =========================================================
// ACT I — WARMING STRIPES
// =========================================================
const stripesModule = (() => {
  let svg, g, dims;
  const SCENARIOS = ["ssp126", "ssp245", "ssp585"];
  let stripesBuilt = false;

  function init() {
    svg = d3.select("#stripes-svg");
    g = svg.append("g").attr("class", "stripes-root");
    const ro = new ResizeObserver(() => { if (stripesBuilt) build(); });
    ro.observe(svg.node());
    // First build is triggered explicitly via show() — stripes is the one act
    // visible at load.
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
        .style("opacity", 0)
        .transition()
        .delay((d, i) => i * 6 + rowIdx * 80)
        .duration(400)
        .style("opacity", 1);

      // End-of-row label: 2100 value
      const endVal = series[series.length - 1];
      g.append("text")
        .attr("class", "stripe-row-label")
        .attr("x", width - m.right + 6)
        .attr("y", rowY + rowH * 0.5 + 4)
        .attr("text-anchor", "start")
        .style("fill", stripeColor(endVal))
        .style("font-weight", 600)
        .text(`+${endVal.toFixed(1)}°C`);
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
          )}">${SCENARIO_LABELS[sc]}</span><span class="tip-val">+${v.toFixed(
            2
          )}°C</span></div>`;
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

    stripesBuilt = true;
  }

  function show() {
    if (!stripesBuilt) build();
  }
  return { init, show, build };
})();

// =========================================================
// ACT II — ANNOTATED SCROLL MAP
// =========================================================
const scrollMapModule = (() => {
  let svg, g, gZoom, dims, projection, path, zoom;
  let built = false;

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
    const ro = new ResizeObserver(() => { if (built) build(); });
    ro.observe(svg.node());
    buildLegend(); // cheap; ready before the chart is built
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
    const flat = data.crossings["ssp585"]["2.0"];
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
          .datum({ lat, lon, idx, crossing: v })
          .on("pointerenter", onCellEnter)
          .on("pointermove", onCellMove)
          .on("pointerleave", onCellLeave);
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
      .text("scroll to zoom · drag to pan · double-click to reset");

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
        ? "never crosses +2°C by 2100"
        : `crosses +2°C in ${d.crossing}`;
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

  function show() {
    if (!built) {
      build();
      // Legend can wrap/reflow after first paint and shrink the chart; rebuild
      // once on the next frame so the viewBox matches the final height.
      requestAnimationFrame(() => build());
    }
  }
  return { init, show, onCoastlines };
})();

// =========================================================
// ACT III — RIDGE PLOT
// =========================================================
const ridgeModule = (() => {
  let svg, g, dims;
  let built = false;

  // Kernel density estimator
  function kde(kernel, bandwidth, sampleX) {
    return function (values) {
      return sampleX.map((x) => [
        x,
        d3.mean(values, (v) => kernel((x - v) / bandwidth)) || 0,
      ]);
    };
  }
  function gaussian(u) {
    return Math.exp(-0.5 * u * u) / Math.sqrt(2 * Math.PI);
  }

  function init() {
    svg = d3.select("#ridge-svg");
    g = svg.append("g").attr("class", "ridge-root");
    const ro = new ResizeObserver(() => { if (built) build(); });
    ro.observe(svg.node());
  }

  function build() {
    const node = svg.node();
    const { width, height } = node.getBoundingClientRect();
    if (!width || !height) return;
    svg.attr("viewBox", `0 0 ${width} ${height}`);
    const m = { top: 40, right: 90, bottom: 50, left: 150 };
    dims = { width, height, m };

    g.selectAll("*").remove();

    const cells = buildCellList("ssp585", "2.0");
    // Top label
    g.append("text")
      .attr("class", "stripe-row-label dim")
      .attr("x", m.left)
      .attr("y", m.top - 18)
      .style("font-size", "10px")
      .style("letter-spacing", "0.16em")
      .style("text-transform", "uppercase")
      .text(
        "Each ridge = a kernel density of crossing years inside one latitude band"
      );

    const xMax = 2102;
    const xMin = 2018;
    const x = d3
      .scaleLinear()
      .domain([xMin, xMax])
      .range([m.left, width - m.right]);

    const bandHeight = (height - m.top - m.bottom) / LAT_BANDS.length;

    // X axis
    g.append("g")
      .attr("class", "ridge-axis")
      .attr("transform", `translate(0, ${height - m.bottom + 6})`)
      .call(
        d3
          .axisBottom(x)
          .tickValues([2020, 2040, 2060, 2080, 2100])
          .tickFormat(d3.format("d"))
      );
    g.append("text")
      .attr("class", "ridge-sublabel")
      .attr("x", (width - m.right + m.left) / 2)
      .attr("y", height - m.bottom + 36)
      .attr("text-anchor", "middle")
      .style("font-size", "10px")
      .text("year when each grid cell first crosses +2°C");

    // KDE sample
    const sampleX = d3.range(xMin, xMax, 1);
    const estimator = kde(gaussian, 2.5, sampleX);

    // From north to south for natural reading (Arctic at top)
    const orderedBands = LAT_BANDS.slice().reverse();
    const bandRows = []; // geometry + data for the scrub interaction

    orderedBands.forEach((band, rowIdx) => {
      const rowY = m.top + rowIdx * bandHeight;
      const bandCells = cells.filter((c) => c.band.id === band.id);
      const crossed = bandCells
        .filter((c) => c.crossing !== null)
        .map((c) => c.crossing);
      const total = bandCells.length;
      const crossedPct = total ? Math.round((crossed.length / total) * 100) : 0;
      bandRows.push({ band, rowY, crossed, total });

      // Row label
      g.append("text")
        .attr("class", "ridge-label")
        .attr("x", m.left - 14)
        .attr("y", rowY + bandHeight * 0.55 - 4)
        .attr("text-anchor", "end")
        .text(band.name);
      g.append("text")
        .attr("class", "ridge-sublabel")
        .attr("x", m.left - 14)
        .attr("y", rowY + bandHeight * 0.55 + 10)
        .attr("text-anchor", "end")
        .text(band.sub);

      // Right-side stat
      g.append("text")
        .attr("class", "ridge-label")
        .attr("x", width - m.right + 10)
        .attr("y", rowY + bandHeight * 0.55 - 4)
        .style("fill", band.color)
        .text(`${crossedPct}%`);
      g.append("text")
        .attr("class", "ridge-sublabel")
        .attr("x", width - m.right + 10)
        .attr("y", rowY + bandHeight * 0.55 + 10)
        .text("crossed");

      if (crossed.length < 2) {
        // Flat line if no data
        g.append("line")
          .attr("x1", m.left)
          .attr("x2", width - m.right)
          .attr("y1", rowY + bandHeight - 6)
          .attr("y2", rowY + bandHeight - 6)
          .attr("stroke", band.color)
          .attr("stroke-width", 1.2)
          .attr("opacity", 0.6);
        return; // skip this band (inside forEach callback)
      }

      // KDE
      const density = estimator(crossed);
      const ridgeH = bandHeight * 1.4; // overlap rows
      const yMax = d3.max(density, (d) => d[1]) || 1;
      const yScale = d3
        .scaleLinear()
        .domain([0, yMax])
        .range([rowY + bandHeight - 4, rowY + bandHeight - ridgeH]);

      const area = d3
        .area()
        .curve(d3.curveBasis)
        .x((d) => x(d[0]))
        .y0(rowY + bandHeight - 4)
        .y1((d) => yScale(d[1]));

      g.append("path")
        .attr("class", "ridge-path")
        .attr("d", area(density))
        .attr("fill", band.color)
        .attr("stroke", band.color)
        .style("opacity", 0)
        .transition()
        .delay(rowIdx * 90)
        .duration(700)
        .style("opacity", 1);

      // Median tick
      const sorted = crossed.slice().sort(d3.ascending);
      const median = d3.quantile(sorted, 0.5);
      if (median != null) {
        g.append("line")
          .attr("x1", x(median))
          .attr("x2", x(median))
          .attr("y1", rowY + bandHeight - 4)
          .attr("y2", rowY + bandHeight - 18)
          .attr("stroke", "var(--ink)")
          .attr("stroke-width", 1)
          .attr("opacity", 0.55);
        g.append("text")
          .attr("class", "ridge-sublabel")
          .attr("x", x(median))
          .attr("y", rowY + bandHeight - 22)
          .attr("text-anchor", "middle")
          .style("fill", "var(--ink)")
          .text(`${Math.round(median)}`);
      }
    });

    // ---- Scrub line: drag/hover across years to read cumulative % crossed ----
    const scrubG = g.append("g").style("opacity", 0);
    const scrubLine = scrubG
      .append("line")
      .attr("class", "ridge-scrub-line")
      .attr("y1", m.top - 6)
      .attr("y2", height - m.bottom);
    const scrubYear = scrubG
      .append("text")
      .attr("class", "ridge-scrub-year")
      .attr("y", m.top - 10)
      .attr("text-anchor", "middle");
    // Per-band running-% labels that ride along the scrub line
    const scrubLabels = bandRows.map((r) =>
      scrubG
        .append("text")
        .attr("class", "ridge-scrub-pct")
        .attr("y", r.rowY + bandHeight * 0.55 + 24)
        .attr("text-anchor", "middle")
        .style("fill", r.band.color)
    );

    g.append("rect")
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
        scrubG.style("opacity", 1);
        scrubLine.attr("x1", px).attr("x2", px);
        scrubYear.attr("x", px).text(yr);
        bandRows.forEach((r, i) => {
          const n = r.crossed.filter((c) => c <= yr).length;
          const pct = r.total ? Math.round((n / r.total) * 100) : 0;
          scrubLabels[i].attr("x", px).text(`${pct}%`);
        });
      })
      .on("pointerleave", () => scrubG.style("opacity", 0));

    built = true;
  }

  function show() {
    if (!built) build();
  }
  return { init, show };
})();

// =========================================================
// ACT IV — BEESWARM
// =========================================================
const beeswarmModule = (() => {
  let svg, g, dims;
  let built = false;
  let nodes = null;

  function init() {
    svg = d3.select("#beeswarm-svg");
    g = svg.append("g").attr("class", "beeswarm-root");
    // Deferred build: the observer's initial fire must not run the (expensive)
    // force simulation — that happens on first show().
    const ro = new ResizeObserver(() => { if (built) build(); });
    ro.observe(svg.node());
    buildLegend(); // cheap; ready before the chart is built
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
    const cells = buildCellList("ssp585", "2.0");
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
    const latStr = `${Math.abs(d.lat).toFixed(1)}°${d.lat >= 0 ? "N" : "S"}`;
    const normLon = d.lon > 180 ? d.lon - 360 : d.lon;
    const lonStr = `${Math.abs(normLon).toFixed(1)}°${
      normLon >= 0 ? "E" : "W"
    }`;
    const headline =
      d.crossing == null
        ? "never crosses +2°C by 2100"
        : `crosses +2°C in ${d.crossing}`;
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
    document.getElementById("tooltip").classList.remove("visible");
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
        "year each grid cell first crosses +2°C  (right of dashed line: never crosses by 2100)"
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

    // Run a quick force simulation offline
    const radius = Math.max(
      1.3,
      Math.min(2.6, Math.sqrt((width * height) / nodes.length) * 0.13)
    );
    const sim = d3
      .forceSimulation(nodes)
      .alpha(0.9)
      .alphaDecay(0.07)
      .force("x", d3.forceX((d) => x(d.tx)).strength(0.95))
      .force("y", d3.forceY((d) => bandY[d.band.id]).strength(0.1))
      .force("collide", d3.forceCollide(radius + 0.15).strength(0.85))
      .stop();
    for (let i = 0; i < 140; i++) sim.tick();

    // Draw circles
    const dotG = g.append("g").attr("class", "bee-dots");
    const dots = dotG
      .selectAll("circle")
      .data(nodes)
      .join("circle")
      .attr("class", "bee-dot")
      .attr("cx", (d) => d.x)
      .attr("cy", (d) => d.y)
      .attr("r", radius)
      .attr("fill", (d) =>
        d.crossing == null ? "rgba(95, 168, 211, 0.55)" : d.band.color
      )
      .on("mouseover", tooltip)
      .on("mousemove", tooltip)
      .on("mouseout", tooltipHide);

    // ---- Year scrubber: drag to light up the planet as it crosses +2°C ----
    const total = nodes.length;
    const scrubG = g.append("g");
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
      scrubLine.attr("x1", px).attr("x2", px).style("opacity", 1);
      scrubLabel.attr("x", px).text(yr).style("opacity", 1);
      readout
        .style("opacity", 1)
        .text(`By ${yr}, ${pct}% of Earth has crossed +2°C`);
    }
    function clearScrub() {
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
  return { init, show };
})();

// =========================================================
// ACT V — FAN CHART
// =========================================================
const fanModule = (() => {
  let svg, g, dims;
  let built = false;

  function init() {
    svg = d3.select("#fan-svg");
    g = svg.append("g").attr("class", "fan-root");
    const ro = new ResizeObserver(() => { if (built) build(); });
    ro.observe(svg.node());
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
          .tickFormat((d) => `${d}°`)
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
      .attr("d", possibleArea(possibility))
      .attr("fill", "url(#possibility-grad)")
      .attr("opacity", 0)
      .transition()
      .duration(900)
      .attr("opacity", 1);

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
        .text(`+${t}°C`);
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
        .attr("stroke-dashoffset", totalLen)
        .transition()
        .duration(1100)
        .attr("stroke-dashoffset", 0);

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
        .text(`${SCENARIO_LABELS[sc]}: +${endVal.toFixed(1)}°C`);
    });

    // Divergence annotation
    const gap = hi[hi.length - 1] - lo[lo.length - 1];
    g.append("text")
      .attr("class", "fan-divergence-anno")
      .attr("x", x(2090))
      .attr("y", y((hi[hi.length - 1] + lo[lo.length - 1]) / 2))
      .attr("text-anchor", "middle")
      .text(`Δ ${gap.toFixed(1)}°C`);
    g.append("text")
      .attr("x", x(2090))
      .attr("y", y((hi[hi.length - 1] + lo[lo.length - 1]) / 2) + 16)
      .attr("text-anchor", "middle")
      .style("font-family", "var(--font-mono)")
      .style("font-size", "10px")
      .style("fill", "var(--ink-faint)")
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
            }</span><span class="tip-val">+${v.toFixed(2)}°C</span></div>`;
          })
          .join("");
        scrollyTip(
          "panel-fan",
          event,
          `<div class="tip-headline" style="font-size:15px">${yr}</div>${rows}` +
            `<div class="tip-row"><span class="tip-key">spread</span><span class="tip-val">${(
              hi - lo
            ).toFixed(2)}°C</span></div>`
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
  return { init, show };
})();

// =========================================================
// ACT V — LIFETIME TIMELINE
// =========================================================
const lifetimeModule = (() => {
  let svg, g, dims;
  let built = false;

  // Compute first crossing of +2°C for various reference series
  function getMilestones(scenario) {
    const TH = 2.0;
    const years = data.grid.years;
    const findCross = (series) => {
      for (let i = 0; i < series.length; i++)
        if (series[i] >= TH) return years[i];
      return null;
    };

    const items = [];
    items.push({
      key: "global",
      label: "Global mean crosses +2°C",
      year: findCross(data.globalMeans[scenario]),
      color: "var(--accent)",
    });
    const r = data.regionalMeans[scenario];
    const named = [
      { k: "Arctic", label: "Arctic crosses +2°C", color: "#7a0a04" },
      { k: "Europe", label: "Europe crosses +2°C", color: "#ff5c2b" },
      { k: "South Asia", label: "South Asia crosses +2°C", color: "#ffaa3d" },
      { k: "Amazon", label: "Amazon crosses +2°C", color: "#88b8c4" },
      { k: "Antarctic", label: "Antarctic crosses +2°C", color: "#5fa8d3" },
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

  function init() {
    svg = d3.select("#lifetime-svg");
    g = svg.append("g").attr("class", "lifetime-root");
    const ro = new ResizeObserver(() => { if (built) build(); });
    ro.observe(svg.node());

    // Wire up controls
    const input = document.getElementById("birth-year-input");
    input.addEventListener("input", () => {
      const v = +input.value;
      if (v >= 1930 && v <= 2025) {
        scrollyState.birthYear = v;
        build();
      }
    });
    document
      .querySelectorAll("#lifetime-scenario-toggle .seg-btn-mini")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          document
            .querySelectorAll("#lifetime-scenario-toggle .seg-btn-mini")
            .forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          scrollyState.lifetimeScenario = btn.dataset.value;
          build();
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
    const m = { top: 120, right: 96, bottom: 56, left: 64 };
    dims = { width, height, m };
    g.selectAll("*").remove();

    const birth = scrollyState.birthYear;
    const scen = scrollyState.lifetimeScenario;
    const years = data.grid.years;
    const dataStart = years[0]; // first year we actually have data (≈2015)
    const xMax = 2100;
    const xMin = Math.min(birth, dataStart);
    const curveStart = Math.max(birth, dataStart); // lived-warming begins here
    const x = d3
      .scaleLinear()
      .domain([xMin, xMax])
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
          .tickFormat((d) => `+${d}°`)
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
        .text(`+${t}°C`);
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
      .attr("fill", "url(#life-gradient)");
    g.append("path").attr("class", "life-line").attr("d", line(pts));

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
      .filter((d) => d.year != null && d.year >= curveStart && d.year <= xMax)
      .sort((a, b) => a.year - b.year);
    // Two staggered rows so clustered late-century crossings don't overprint.
    const LABEL_GAP = 92;
    const rowLastX = [-1e9, -1e9];
    const rowY = [plotTop + 12, plotTop + 40];
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
        .attr("class", "life-milestone-line")
        .attr("x1", px)
        .attr("x2", px)
        .attr("y1", cy)
        .attr("y2", ly + 2)
        .attr("stroke", mi.color);
      g.append("circle")
        .attr("class", "life-milestone-dot")
        .attr("cx", px)
        .attr("cy", cy)
        .attr("r", 4.5)
        .attr("fill", mi.color);
      const lg = g.append("g").attr("transform", `translate(${labelX}, ${ly})`);
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
        .text(mi.label.replace(" crosses +2°C", " +2°C"));
    });

    // ---- Birth handle (draggable) ----
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
    birthHandle.call(
      d3.drag().on("drag", (event) => {
        const yr = Math.max(
          1930,
          Math.min(2025, Math.round(x.invert(event.x)))
        );
        if (yr !== scrollyState.birthYear) {
          scrollyState.birthYear = yr;
          document.getElementById("birth-year-input").value = yr;
          build();
        }
      })
    );

    // ---- Header / live readout ----
    g.append("text")
      .attr("class", "life-eyebrow")
      .attr("x", m.left)
      .attr("y", 30)
      .text(
        "Your lifetime · " +
          SCENARIO_LABELS[scen] +
          " · hover or drag across the chart"
      );
    const headline = g
      .append("text")
      .attr("class", "life-age-text")
      .attr("x", m.left)
      .attr("y", 60)
      .style("font-size", "24px");
    const subline = g
      .append("text")
      .attr("class", "life-eyebrow")
      .attr("x", m.left)
      .attr("y", 84)
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

    function setScrub(year) {
      year = Math.max(curveStart, Math.min(xMax, Math.round(year)));
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
      const signed = (n) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}`;
      headline.text(`At age ${age}, you live in a ${signed(v)}°C world.`);
      subline.text(
        delta >= 0.05
          ? `That's +${delta.toFixed(1)}°C hotter than the year you were born.`
          : `Right around the warming baseline of your birth year.`
      );
    }

    // Interaction surface
    g.append("rect")
      .attr("class", "life-scrub-surface")
      .attr("x", m.left)
      .attr("y", plotTop)
      .attr("width", width - m.left - m.right)
      .attr("height", plotBottom - plotTop)
      .style("fill", "transparent")
      .style("cursor", "ew-resize")
      .call(d3.drag().on("start drag", (event) => setScrub(x.invert(event.x))))
      .on("pointermove", function (event) {
        setScrub(x.invert(d3.pointer(event, g.node())[0]));
      });

    // Park the scrubber at its remembered year (or "today")
    const initYear =
      scrollyState.lifeScrubYear != null
        ? Math.max(curveStart, Math.min(xMax, scrollyState.lifeScrubYear))
        : Math.max(curveStart, Math.min(xMax, 2025));
    setScrub(initYear);

    built = true;
  }

  function show() {
    if (!built) build();
  }
  return { init, show };
})();

// =========================================================
// SCROLLAMA CONTROLLER
// =========================================================
function setupScrollama() {
  const scroller = scrollama();

  function activatePanel(step) {
    document.querySelectorAll(".viz-panel").forEach((p) => {
      p.classList.toggle("active", p.dataset.viz === step);
    });
    document.querySelectorAll(".step").forEach((s) => {
      s.classList.toggle("is-active", s.dataset.step === step);
    });
    scrollyState.activeStep = step;

    // Trigger build on first show (for resize correctness)
    if (step === "stripes") stripesModule.show();
    else if (step === "map") scrollMapModule.show();
    else if (step === "ridge") ridgeModule.show();
    else if (step === "beeswarm") beeswarmModule.show();
    else if (step === "fan") fanModule.show();
    else if (step === "lifetime") lifetimeModule.show();
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
// Run work when the main thread is idle (falls back to a short timeout).
function idle(fn) {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(fn, { timeout: 2500 });
  } else {
    setTimeout(fn, 200);
  }
}

// The interactive dashboard (and its heavy ~6,000-cell map) lives far below the
// fold, so build it only once — when the reader approaches it — instead of at
// startup.
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
function setupDashboardLazyInit() {
  const target = document.getElementById("controls");
  if (target && "IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          ensureDashboard();
          io.disconnect();
        }
      },
      { rootMargin: "1400px 0px" } // build well before it scrolls into view
    );
    io.observe(target);
    // Safety net: also build during idle so it's always ready off the critical
    // path, even if approach-detection is missed.
    idle(ensureDashboard);
  } else {
    ensureDashboard();
  }
}

async function main() {
  try {
    // Start the coastline fetch immediately so it overlaps the data fetches
    // (it's a decorative overlay and no longer blocks anything).
    fetchCoastlines();

    await loadData();

    // Hide scroll loading overlay
    const scrollLoading = document.getElementById("scroll-loading");
    if (scrollLoading) {
      scrollLoading.classList.add("hidden");
      setTimeout(() => scrollLoading.remove(), 500);
    }

    // Init scrolly modules — cheap now: each chart builds lazily on first show.
    stripesModule.init();
    scrollMapModule.init();
    ridgeModule.init();
    beeswarmModule.init();
    fanModule.init();
    lifetimeModule.init();
    setupScrollama();

    // Build only the act that's actually on screen.
    stripesModule.show();

    // Everything below the fold is deferred off the critical path.
    setupDashboardLazyInit();

    // Pre-warm the heavy acts during idle time so scrolling to them is smooth
    // (the beeswarm runs a force simulation; the map draws ~6,000 cells).
    idle(() => beeswarmModule.show());
    idle(() => scrollMapModule.show());
  } catch (err) {
    console.error("Failed to start app", err);
    const el = document.getElementById("scroll-loading");
    if (el) el.textContent = `error: ${err.message}`;
    const el2 = document.getElementById("map-loading");
    if (el2) el2.textContent = `error: ${err.message}`;
  }
}

document.addEventListener("DOMContentLoaded", main);

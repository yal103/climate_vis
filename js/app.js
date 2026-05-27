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

  // Fetch world coastlines — try real Natural Earth (world-atlas CDN) first,
  // fall back to the local synthetic GeoJSON if offline / CDN blocked.
  overlay.textContent = "Loading map…";
  try {
    const topo = await d3.json(
      "https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json"
    );
    // topojson-client converts topology → GeoJSON FeatureCollection
    data.worldGeo = topojson.feature(topo, topo.objects.land);
    console.log("Loaded Natural Earth coastlines from CDN");
  } catch (e) {
    console.warn(
      "CDN coastlines unavailable, using local fallback:",
      e.message
    );
    try {
      data.worldGeo = await d3.json("data/coastlines.json");
    } catch (e2) {
      console.warn("No coastlines available:", e2.message);
    }
  }

  overlay.classList.add("hidden");
  setTimeout(() => overlay.remove(), 500);
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
    const DARK_BLUES = new Set(["#4a7d99", "#2d5a73", "#1d3a4f", "#356a8a", "#7a0a04", "#c2261b"]);
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
    const strokeColor = (!fillColor || DARK_BLUES.has(fillColor)) ? "#fff" : "#000";

    gSelection
      .append("path")
      .attr("d", d)
      .attr("fill", "none")
      .attr("stroke", strokeColor === "#fff" ? "rgba(0,0,0,0.4)" : "rgba(255,255,255,0.3)")
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

  return { init, update, build };
})();

// =========================================================
// TOOLTIP
// =========================================================
function getRegionForCell(lat, lon) {
  const normLon = lon > 180 ? lon - 360 : lon;
  const specific = [
    { name: "North America",    lat: [15, 75],  lon: [-170, -50] },
    { name: "Europe",           lat: [35, 72],  lon: [-15,   45] },
    { name: "Sahara/N. Africa", lat: [15, 35],  lon: [-15,   50] },
    { name: "Amazon",           lat: [-15,  5], lon: [-75,  -45] },
    { name: "South Asia",       lat: [5,   35], lon: [65,   100] },
  ];
  for (const r of specific) {
    if (lat >= r.lat[0] && lat <= r.lat[1] && normLon >= r.lon[0] && normLon <= r.lon[1])
      return r.name;
  }
  if (lat > 66)   return "Arctic";
  if (lat < -66)  return "Antarctic";
  if (lat >= 30)  return "Northern mid-latitudes";
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

  // Position
  const wrap = document.querySelector(".map-wrap");
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
async function main() {
  try {
    await loadData();
    legendModule.init();
    mapModule.init();
    globalChartModule.init();
    cellChartModule.init();
    histogramModule.init();
    wireControls();
    render();
  } catch (err) {
    console.error("Failed to start app", err);
    document.getElementById(
      "map-loading"
    ).textContent = `error: ${err.message}`;
  }
}

document.addEventListener("DOMContentLoaded", main);

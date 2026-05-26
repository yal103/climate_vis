/* ============================================================
   2°C is not one deadline — DSC 106 final project
   Scroll-driven explorable explanation built on Project 3
   ============================================================ */

// ---------- Global state ----------
const state = {
  scenario: "ssp245",
  threshold: "2.0",
  mode: "crossing",
  year: 2050,
  selectedCell: null,
  selectedRegion: null,
  isPlaying: false,
  playTimer: null,
  activeStep: 1,
};

const data = {
  grid: null,
  crossings: null,
  globalMeans: null,
  regionalMeans: null,
  timeseries: null,
  worldGeo: null,
};

const SCENARIO_LABELS = {
  ssp126: "SSP1-2.6",
  ssp245: "SSP2-4.5",
  ssp585: "SSP5-8.5",
};
const SCENARIO_DESC = {
  ssp126: "strong mitigation",
  ssp245: "middle of the road",
  ssp585: "fossil-fueled",
};

// =========================================================
// DATA LOADING
// =========================================================
async function loadData() {
  const overlay = document.getElementById("map-loading");
  if (overlay) overlay.textContent = "Loading grid…";
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

  if (overlay) overlay.textContent = "Loading time series…";
  const tsResp = await fetch("data/timeseries.bin");
  const tsBuf = await tsResp.arrayBuffer();
  parseTimeseries(tsBuf);

  if (overlay) overlay.textContent = "Loading map…";
  try {
    const topo = await d3.json(
      "https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json"
    );
    data.worldGeo = topojson.feature(topo, topo.objects.land);
  } catch (e) {
    try {
      data.worldGeo = await d3.json("data/coastlines.json");
    } catch (e2) { /* no coastlines */ }
  }

  if (overlay) {
    overlay.classList.add("hidden");
    setTimeout(() => overlay.remove(), 500);
  }
}

function parseTimeseries(buf) {
  const view = new DataView(buf);
  const magic = String.fromCharCode(
    view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)
  );
  if (magic !== "CMIP") throw new Error("Bad timeseries file magic");
  let off = 4;
  const nScen = view.getUint32(off, true); off += 4;
  const nYears = view.getUint32(off, true); off += 4;
  const nLat = view.getUint32(off, true); off += 4;
  const nLon = view.getUint32(off, true); off += 4;
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
  data.timeseries = {};
  const cellsPerYear = nLat * nLon;
  const valuesPerScen = nYears * cellsPerYear;
  for (let s = 0; s < nScen; s++) {
    const i16 = new Int16Array(buf, off, valuesPerScen);
    const f = new Float32Array(valuesPerScen);
    for (let i = 0; i < valuesPerScen; i++) f[i] = i16[i] / 100;
    data.timeseries[sNames[s]] = f;
    off += valuesPerScen * 2;
  }
}

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
  return d3.scaleThreshold()
    .domain([2030, 2040, 2050, 2060, 2070, 2080, 2090])
    .range([
      "#7a0a04", "#c2261b", "#ff5c2b", "#ffaa3d",
      "#fde29c", "#88b8c4", "#4a7d99", "#2d5a73",
    ]);
}
function makeAnomalyScale() {
  return d3.scaleThreshold()
    .domain([0, 1, 2, 3, 4, 5, 6])
    .range([
      "#1d3a4f", "#356a8a", "#5fa8d3", "#a8c8d8",
      "#fde29c", "#ffaa3d", "#ff5c2b", "#c2261b",
    ]);
}
function makeMitigationScale() {
  // "Years gained" by switching from SSP5-8.5 to SSP1-2.6.
  // Diverging: gray (≤0, no gain) → green (more years gained) → deep green (huge gain).
  return d3.scaleThreshold()
    .domain([5, 10, 20, 30, 45])
    .range([
      "#3a3a3a", "#c9e2c5", "#7ec18e", "#4f9a6d", "#2d6b4d", "#0e4730"
    ]);
}

const crossingScale = makeCrossingScale();
const anomalyScale = makeAnomalyScale();
const mitigationScale = makeMitigationScale();

// =========================================================
// MAP FACTORY  (so we can have one in the scrolly stage and one in the explore section)
// =========================================================
function createMapModule({ svgId, tooltipId, legendId, titleId, subId, interactive = true }) {
  let svg, gMap, gCells, gCoast, gGratic, gSphere, gSelection, gAnnotations;
  let projection, path;
  let cellsSel = null;
  let cachedDims = null;

  function init() {
    svg = d3.select(`#${svgId}`);
    if (svg.empty()) return null;
    gSphere = svg.append("g").attr("class", "g-sphere");
    gGratic = svg.append("g").attr("class", "g-graticule");
    gCells = svg.append("g").attr("class", "g-cells");
    gCoast = svg.append("g").attr("class", "g-coast");
    gSelection = svg.append("g").attr("class", "g-selection");
    gAnnotations = svg.append("g").attr("class", "g-annotations");

    const ro = new ResizeObserver(() => { build(); update(); });
    ro.observe(svg.node());
    build();
    return true;
  }

  function build() {
    const node = svg.node();
    if (!node) return;
    const { width, height } = node.getBoundingClientRect();
    if (width === 0 || height === 0) return;
    cachedDims = { width, height };
    svg.attr("viewBox", `0 0 ${width} ${height}`);

    projection = d3.geoEqualEarth().fitExtent(
      [[8, 8], [width - 8, height - 8]],
      { type: "Sphere" }
    );
    path = d3.geoPath(projection);

    gSphere.selectAll("path").remove();
    gSphere.append("path").attr("class", "sphere").attr("d", path({ type: "Sphere" }));

    const gratic = d3.geoGraticule().step([30, 30])();
    gGratic.selectAll("path").remove();
    gGratic.append("path").attr("class", "graticule").attr("d", path(gratic));

    gCoast.selectAll("path").remove();
    if (data.worldGeo) {
      gCoast.append("path")
        .attr("class", "coastline-halo")
        .attr("d", path(data.worldGeo))
        .attr("fill", "none")
        .attr("stroke", "rgba(0,0,0,0.55)")
        .attr("stroke-width", 2.6)
        .attr("stroke-linejoin", "round")
        .attr("pointer-events", "none");
      gCoast.append("path")
        .attr("class", "coastline")
        .attr("d", path(data.worldGeo))
        .attr("pointer-events", "none");
    }

    buildCells();
  }

  function buildCells() {
    const { lats, lons, n_lat, n_lon } = data.grid;
    const dLat = (lats[1] - lats[0]) / 2;
    const dLon = (lons[1] - lons[0]) / 2;

    const cells = [];
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
        if (projected.some((p) => !p || isNaN(p[0]) || isNaN(p[1]))) continue;
        const xs = projected.map((p) => p[0]);
        const xRange = Math.max(...xs) - Math.min(...xs);
        if (xRange > 200) continue;
        const d =
          `M${projected[0][0].toFixed(2)},${projected[0][1].toFixed(2)}` +
          `L${projected[1][0].toFixed(2)},${projected[1][1].toFixed(2)}` +
          `L${projected[2][0].toFixed(2)},${projected[2][1].toFixed(2)}` +
          `L${projected[3][0].toFixed(2)},${projected[3][1].toFixed(2)}Z`;
        cells.push({ latIdx: i, lonIdx: j, lat, lon, idx: i * n_lon + j, d });
      }
    }

    cellsSel = gCells.selectAll("path.map-cell").data(cells, (d) => d.idx);
    const enter = cellsSel.enter().append("path")
      .attr("class", "map-cell")
      .attr("d", (d) => d.d);
    if (interactive) {
      enter
        .on("mouseenter", onCellHover)
        .on("mousemove", onCellMove)
        .on("mouseleave", onCellLeave)
        .on("click", onCellClick);
    }
    cellsSel.attr("d", (d) => d.d);
    cellsSel = enter.merge(cellsSel);
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
        if (v === null || v === undefined || Number.isNaN(v)) return null;
        if (mode === "crossing") return crossingScale(v);
        return anomalyScale(v);
      });

    drawSelection();
    drawAnnotations();

    // Update title/sub if provided
    if (titleId) {
      const t = document.getElementById(titleId);
      if (t) {
        t.textContent = mode === "crossing"
          ? `First year crossing +${state.threshold}°C`
          : `Temperature anomaly in ${state.year}`;
      }
    }
    if (subId) {
      const s = document.getElementById(subId);
      if (s) {
        s.textContent = `${SCENARIO_LABELS[scenario]} · ${SCENARIO_DESC[scenario]} · vs 2015–2034 baseline`;
      }
    }
  }

  function drawSelection() {
    gSelection.selectAll("*").remove();
    if (!state.selectedCell) return;
    const { latIdx, lonIdx } = state.selectedCell;
    const { lats, lons } = data.grid;
    const dLat = (lats[1] - lats[0]) / 2;
    const dLon = (lons[1] - lons[0]) / 2;
    const lat = lats[latIdx], lon = lons[lonIdx];
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

    gSelection.append("path").attr("d", d)
      .attr("fill", "none")
      .attr("stroke", "rgba(0,0,0,0.5)")
      .attr("stroke-width", 4);
    gSelection.append("path").attr("d", d)
      .attr("fill", "none")
      .attr("stroke", "#fff")
      .attr("stroke-width", 2);
  }

  function drawAnnotations() {
    gAnnotations.selectAll("*").remove();
    if (svgId !== "map") return; // annotations only on the sticky scrolly map
    if (state.activeStep !== 2) return;

    // Arctic callout — pointing at high-latitude region
    const arcticPt = projection([20, 78]); // Svalbard-ish
    const arcticLabel = projection([60, 80]);
    if (arcticPt && arcticLabel) {
      gAnnotations.append("circle")
        .attr("cx", arcticPt[0]).attr("cy", arcticPt[1])
        .attr("r", 4).attr("fill", "var(--accent-2)").attr("opacity", 0.9);
      gAnnotations.append("line")
        .attr("class", "map-annotation-line")
        .attr("x1", arcticPt[0]).attr("y1", arcticPt[1])
        .attr("x2", arcticLabel[0] + 10).attr("y2", arcticLabel[1] - 10);
      gAnnotations.append("text")
        .attr("class", "map-annotation-label")
        .attr("x", arcticLabel[0] + 14).attr("y", arcticLabel[1] - 14)
        .text("Arctic crosses first");
    }

    // Tropical belt callout
    const tropPt = projection([-60, 0]); // Amazon-ish
    const tropLabel = projection([-100, -25]);
    if (tropPt && tropLabel) {
      gAnnotations.append("circle")
        .attr("cx", tropPt[0]).attr("cy", tropPt[1])
        .attr("r", 4).attr("fill", "var(--accent-2)").attr("opacity", 0.9);
      gAnnotations.append("line")
        .attr("class", "map-annotation-line")
        .attr("x1", tropPt[0]).attr("y1", tropPt[1])
        .attr("x2", tropLabel[0]).attr("y2", tropLabel[1]);
      gAnnotations.append("text")
        .attr("class", "map-annotation-label")
        .attr("x", tropLabel[0]).attr("y", tropLabel[1] + 4)
        .attr("text-anchor", "end")
        .text("Tropics: decades later");
    }
  }

  // Interaction handlers
  function onCellHover(event, d) { showTooltip(event, d, tooltipId, svgId); }
  function onCellMove(event, d)  { showTooltip(event, d, tooltipId, svgId); }
  function onCellLeave() {
    const t = document.getElementById(tooltipId);
    if (t) t.classList.remove("visible");
  }
  function onCellClick(event, d) {
    state.selectedCell = { latIdx: d.latIdx, lonIdx: d.lonIdx, lat: d.lat, lon: d.lon };
    state.selectedRegion = null;
    render();
  }

  // Legend (per-map)
  function updateLegend() {
    if (!legendId) return;
    const container = d3.select(`#${legendId}`);
    if (container.empty()) return;
    container.selectAll("*").remove();
    const { mode, threshold } = state;

    container.append("div")
      .style("font-family", "var(--font-mono)")
      .style("font-size", "10px")
      .style("text-transform", "uppercase")
      .style("letter-spacing", "0.1em")
      .style("color", "var(--ink-faint)")
      .text(mode === "crossing" ? `Year crossing +${threshold}°C` : "Anomaly °C");

    const colors = mode === "crossing" ? crossingScale.range() : anomalyScale.range();
    const labels = mode === "crossing"
      ? ["<2030", "2030s", "2040s", "2050s", "2060s", "2070s", "2080s", "≥2090"]
      : ["<0°", "0–1°", "1–2°", "2–3°", "3–4°", "4–5°", "5–6°", "≥6°"];

    const swatches = container.append("div")
      .style("display", "flex").style("gap", "2px").style("align-items", "flex-end");
    colors.forEach((color, i) => {
      const sw = swatches.append("div")
        .style("display", "flex").style("flex-direction", "column").style("align-items", "center");
      sw.append("div")
        .style("width", "22px").style("height", "10px")
        .style("background", color).style("border-radius", "2px");
      sw.append("div")
        .style("font-size", "8px").style("color", "var(--ink-faint)")
        .style("font-family", "var(--font-mono)").style("margin-top", "2px")
        .text(labels[i]);
    });

    if (mode === "crossing") {
      container.append("div").attr("class", "legend-never").html(`
        <span class="legend-never-swatch"></span><span>Never crosses by 2100</span>
      `);
    }
  }

  return { init, update, updateLegend, build };
}

// =========================================================
// TOOLTIP (shared)
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

function showTooltip(event, d, tooltipId, mapSvgId) {
  const tip = document.getElementById(tooltipId);
  if (!tip) return;
  const { scenario, threshold, mode, year } = state;
  const crossing = data.crossings[scenario][threshold][d.idx];
  const anom = getCellAnomaly(scenario, year, d.latIdx, d.lonIdx);
  const final = getCellAnomaly(scenario, 2100, d.latIdx, d.lonIdx);

  const latStr = `${Math.abs(d.lat).toFixed(1)}°${d.lat >= 0 ? "N" : "S"}`;
  const normLon = d.lon > 180 ? d.lon - 360 : d.lon;
  const lonStr = `${Math.abs(normLon).toFixed(1)}°${normLon >= 0 ? "E" : "W"}`;
  const region = getRegionForCell(d.lat, d.lon);

  let headline = mode === "crossing"
    ? (crossing === null ? `never crosses ${threshold}°C` : `crosses ${threshold}°C in ${crossing}`)
    : `${anom >= 0 ? "+" : ""}${anom.toFixed(2)}°C in ${year}`;

  tip.innerHTML = `
    <div class="tip-row"><span class="tip-key">Location</span><span class="tip-val">${latStr}, ${lonStr}</span></div>
    <div class="tip-row"><span class="tip-key">Region</span><span class="tip-val">${region}</span></div>
    <div class="tip-headline">${headline}</div>
    <div class="tip-row"><span class="tip-key">2100 anomaly</span><span class="tip-val">${final >= 0 ? "+" : ""}${final.toFixed(1)}°C</span></div>
    <div class="tip-row"><span class="tip-key">Scenario</span><span class="tip-val">${SCENARIO_LABELS[scenario]}</span></div>
  `;

  // Position relative to the nearest map-wrap parent of the source svg
  const mapEl = document.getElementById(mapSvgId);
  const wrap = mapEl ? mapEl.closest(".map-wrap") : null;
  if (!wrap) { tip.classList.add("visible"); return; }
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
// MITIGATION MAP — "years gained by switching SSP5-8.5 → SSP1-2.6"
// =========================================================
const mitigationMapModule = (() => {
  let svg, gSphere, gGratic, gCells, gCoast, gLegend;
  let projection, path;
  let cellsSel = null;

  function init() {
    svg = d3.select("#mitigation-map");
    if (svg.empty()) return;
    gSphere = svg.append("g");
    gGratic = svg.append("g");
    gCells = svg.append("g");
    gCoast = svg.append("g");
    const ro = new ResizeObserver(() => { build(); update(); });
    ro.observe(svg.node());
    build();
  }

  function build() {
    const node = svg.node();
    if (!node) return;
    const { width, height } = node.getBoundingClientRect();
    if (!width || !height) return;
    svg.attr("viewBox", `0 0 ${width} ${height}`);
    projection = d3.geoEqualEarth().fitExtent(
      [[8, 8], [width - 8, height - 8]], { type: "Sphere" }
    );
    path = d3.geoPath(projection);

    gSphere.selectAll("*").remove();
    gSphere.append("path").attr("class", "sphere").attr("d", path({ type: "Sphere" }));

    const gratic = d3.geoGraticule().step([30, 30])();
    gGratic.selectAll("*").remove();
    gGratic.append("path").attr("class", "graticule").attr("d", path(gratic));

    gCoast.selectAll("*").remove();
    if (data.worldGeo) {
      gCoast.append("path")
        .attr("d", path(data.worldGeo))
        .attr("fill", "none")
        .attr("stroke", "rgba(0,0,0,0.55)")
        .attr("stroke-width", 2.6)
        .attr("stroke-linejoin", "round")
        .attr("pointer-events", "none");
      gCoast.append("path")
        .attr("class", "coastline")
        .attr("d", path(data.worldGeo))
        .attr("pointer-events", "none");
    }

    buildCells();
  }

  function buildCells() {
    const { lats, lons, n_lat, n_lon } = data.grid;
    const dLat = (lats[1] - lats[0]) / 2;
    const dLon = (lons[1] - lons[0]) / 2;
    const cells = [];
    for (let i = 0; i < n_lat; i++) {
      for (let j = 0; j < n_lon; j++) {
        const lat = lats[i], lon = lons[j];
        const corners = [
          [lon - dLon, lat - dLat], [lon + dLon, lat - dLat],
          [lon + dLon, lat + dLat], [lon - dLon, lat + dLat],
        ];
        const projected = corners.map((c) => projection(c));
        if (projected.some((p) => !p || isNaN(p[0]) || isNaN(p[1]))) continue;
        const xs = projected.map((p) => p[0]);
        if (Math.max(...xs) - Math.min(...xs) > 200) continue;
        const d =
          `M${projected[0][0].toFixed(2)},${projected[0][1].toFixed(2)}` +
          `L${projected[1][0].toFixed(2)},${projected[1][1].toFixed(2)}` +
          `L${projected[2][0].toFixed(2)},${projected[2][1].toFixed(2)}` +
          `L${projected[3][0].toFixed(2)},${projected[3][1].toFixed(2)}Z`;
        cells.push({ latIdx: i, lonIdx: j, idx: i * n_lon + j, d });
      }
    }
    cellsSel = gCells.selectAll("path.mit-cell").data(cells, (d) => d.idx);
    cellsSel = cellsSel.enter().append("path")
      .attr("class", "map-cell mit-cell")
      .attr("d", (d) => d.d)
      .merge(cellsSel);
  }

  function update() {
    if (!cellsSel) return;
    const th = state.threshold;
    const high = data.crossings.ssp585[th];
    const low = data.crossings.ssp126[th];

    cellsSel
      .attr("fill", (d) => {
        const h = high[d.idx];
        const l = low[d.idx];
        // If high-emissions never crosses, mitigation is not needed there.
        if (h === null) return "#1d3a4f"; // dark blue: never threatens
        // If high crosses but low doesn't, mitigation prevents crossing entirely.
        if (l === null) return "#0e4730"; // deepest green: fully avoided
        // Otherwise show years gained.
        const gained = l - h;
        return mitigationScale(Math.max(0, gained));
      })
      .classed("never", false);

    updateLegend();
  }

  function updateLegend() {
    const container = d3.select("#mitigation-legend");
    if (container.empty()) return;
    container.selectAll("*").remove();
    container.append("div")
      .style("font-family", "var(--font-mono)")
      .style("font-size", "10px")
      .style("text-transform", "uppercase")
      .style("letter-spacing", "0.1em")
      .style("color", "var(--ink-faint)")
      .text(`Years gained by mitigation (+${state.threshold}°C)`);

    const colors = ["#1d3a4f", "#3a3a3a", "#c9e2c5", "#7ec18e", "#4f9a6d", "#2d6b4d", "#0e4730"];
    const labels = ["never crosses", "0–5y", "5–10y", "10–20y", "20–30y", "30–45y", "avoided"];
    const sw = container.append("div")
      .style("display", "flex").style("gap", "2px").style("align-items", "flex-end");
    colors.forEach((c, i) => {
      const cell = sw.append("div")
        .style("display", "flex").style("flex-direction", "column").style("align-items", "center");
      cell.append("div").style("width", "26px").style("height", "10px").style("background", c).style("border-radius", "2px");
      cell.append("div").style("font-size", "8px").style("color", "var(--ink-faint)")
        .style("font-family", "var(--font-mono)").style("margin-top", "2px").text(labels[i]);
    });
  }

  return { init, update, rebuild: build };
})();

// =========================================================
// RACE CHART
// =========================================================
const raceChartModule = (() => {
  let svg, g;
  let dims;

  function init() {
    svg = d3.select("#race-chart");
    if (svg.empty()) return;
    g = svg.append("g");
    const ro = new ResizeObserver(() => { build(); update(); });
    ro.observe(svg.node());
    build();
  }

  function build() {
    const node = svg.node();
    if (!node) return;
    const { width, height } = node.getBoundingClientRect();
    if (!width || !height) return;
    svg.attr("viewBox", `0 0 ${width} ${height}`);
    dims = { width, height, m: { top: 16, right: 90, bottom: 30, left: 160 } };
  }

  function getRegionCrossings() {
    const th = +state.threshold;
    const years = data.grid.years;
    const out = [];
    Object.entries(data.regionalMeans[state.scenario]).forEach(([name, series]) => {
      let cy = null;
      for (let i = 0; i < series.length; i++) {
        if (series[i] >= th) { cy = years[i]; break; }
      }
      out.push({ name, crossYear: cy, finalAnom: series[series.length - 1] });
    });
    // Sort: crossed regions first (earliest first), then never-crossing
    out.sort((a, b) => {
      if (a.crossYear === null && b.crossYear === null) return 0;
      if (a.crossYear === null) return 1;
      if (b.crossYear === null) return -1;
      return a.crossYear - b.crossYear;
    });
    return out;
  }

  function update() {
    if (!g || !dims) return;
    const { width, height, m } = dims;
    const rows = getRegionCrossings();

    const x = d3.scaleLinear().domain([2015, 2100]).range([m.left, width - m.right]);
    const y = d3.scaleBand()
      .domain(rows.map(d => d.name))
      .range([m.top, height - m.bottom])
      .padding(0.35);

    g.selectAll("*").remove();

    // Vertical year ticks
    [2020, 2040, 2060, 2080, 2100].forEach(yr => {
      g.append("line")
        .attr("x1", x(yr)).attr("x2", x(yr))
        .attr("y1", m.top).attr("y2", height - m.bottom)
        .attr("stroke", "var(--line)")
        .attr("stroke-dasharray", "2 3");
      g.append("text")
        .attr("x", x(yr)).attr("y", height - m.bottom + 16)
        .attr("text-anchor", "middle")
        .attr("fill", "var(--ink-faint)")
        .style("font-family", "var(--font-mono)").style("font-size", "10px")
        .text(yr);
    });

    // Rows
    rows.forEach(d => {
      const yPos = y(d.name) + y.bandwidth() / 2;
      // Region label (left)
      g.append("text")
        .attr("class", "race-label")
        .attr("x", m.left - 12).attr("y", yPos + 4)
        .attr("text-anchor", "end")
        .text(d.name);

      // Track line (full width)
      g.append("line")
        .attr("x1", x(2015)).attr("x2", x(2100))
        .attr("y1", yPos).attr("y2", yPos)
        .attr("stroke", "var(--line-strong)")
        .attr("stroke-width", 2);

      if (d.crossYear !== null) {
        // Filled bar from 2015 → crossing year
        g.append("line")
          .attr("x1", x(2015)).attr("x2", x(d.crossYear))
          .attr("y1", yPos).attr("y2", yPos)
          .attr("stroke", "var(--accent)")
          .attr("stroke-width", 5)
          .attr("stroke-linecap", "round")
          .attr("opacity", 0)
          .transition().duration(700)
          .attr("opacity", 1);

        // Marker dot at crossing
        g.append("circle")
          .attr("class", "race-marker")
          .attr("cx", x(d.crossYear)).attr("cy", yPos)
          .attr("r", 0)
          .transition().duration(500).delay(300)
          .attr("r", 6);

        // Year label (right)
        g.append("text")
          .attr("class", "race-year")
          .attr("x", x(d.crossYear) + 12).attr("y", yPos + 4)
          .text(d.crossYear)
          .attr("opacity", 0)
          .transition().duration(400).delay(500)
          .attr("opacity", 1);
      } else {
        g.append("text")
          .attr("class", "race-never")
          .attr("x", x(2100) + 12).attr("y", yPos + 4)
          .text(`stays below (+${d.finalAnom.toFixed(1)}°C in 2100)`);
      }
    });

    // Subtitle
    const sub = document.getElementById("race-sub");
    if (sub) sub.textContent = `${SCENARIO_LABELS[state.scenario]} · +${state.threshold}°C`;
  }

  return { init, update, rebuild: build };
})();

// =========================================================
// LEGEND (kept for backwards compat — delegates to per-map legends now)
// =========================================================
const legendModule = (() => {
  function init() {}
  function update() {}
  return { init, update };
})();

// =========================================================
// GLOBAL CHART
// =========================================================
const globalChartModule = (() => {
  let svg, g, x, y, line, dims;

  function init() {
    svg = d3.select("#global-chart");
    if (svg.empty()) return;
    g = svg.append("g").attr("class", "g-root");
    const ro = new ResizeObserver(() => { build(); update(); });
    ro.observe(svg.node());
    build();
  }

  function build() {
    const node = svg.node();
    if (!node) return;
    const { width, height } = node.getBoundingClientRect();
    if (!width || !height) return;
    svg.attr("viewBox", `0 0 ${width} ${height}`);
    const m = { top: 18, right: 56, bottom: 28, left: 32 };
    dims = { width, height, m };

    const years = data.grid.years;
    x = d3.scaleLinear().domain(d3.extent(years)).range([m.left, width - m.right]);
    y = d3.scaleLinear().domain([0, 5.5]).range([height - m.bottom, m.top]);
    line = d3.line().x((_, i) => x(years[i])).y((d) => y(d)).curve(d3.curveMonotoneX);

    g.selectAll(".axis").remove();
    g.append("g").attr("class", "axis axis--x")
      .attr("transform", `translate(0,${height - m.bottom})`)
      .call(d3.axisBottom(x).tickValues([2020, 2040, 2060, 2080, 2100]).tickFormat(d3.format("d")).tickSize(-height + m.top + m.bottom));
    g.append("g").attr("class", "axis axis--y")
      .attr("transform", `translate(${m.left},0)`)
      .call(d3.axisLeft(y).ticks(5).tickFormat((d) => `${d}°`).tickSize(-(width - m.left - m.right)));
    g.selectAll(".axis line").attr("class", "gridline").attr("stroke-dasharray", "2 3");
    g.selectAll(".axis path").attr("display", "none");
  }

  function update() {
    if (!x) return;
    const { width, height, m } = dims;
    const years = data.grid.years;

    g.selectAll(".scenario-line, .scenario-label, .threshold-line, .threshold-label, .scenario-dot, .year-marker").remove();

    const thNum = +state.threshold;
    g.append("line").attr("class", "threshold-line")
      .attr("x1", m.left).attr("x2", width - m.right)
      .attr("y1", y(thNum)).attr("y2", y(thNum));
    g.append("text").attr("class", "threshold-label")
      .attr("x", width - m.right + 4).attr("y", y(thNum) + 4)
      .text(`+${thNum}°C`);

    ["ssp126", "ssp245", "ssp585"].forEach((sc) => {
      const series = data.globalMeans[sc];
      g.append("path").attr("class", `scenario-line ${sc}`)
        .classed("dim", sc !== state.scenario).attr("d", line(series));
      g.append("text").attr("class", "scenario-label")
        .attr("fill", sc === state.scenario ? "var(--ink)" : "var(--ink-faint)")
        .attr("x", x(years[years.length - 1]) + 4)
        .attr("y", y(series[series.length - 1]) + 3)
        .text(SCENARIO_LABELS[sc]);
    });

    const series = data.globalMeans[state.scenario];
    let crossYr = null;
    for (let i = 0; i < series.length; i++) {
      if (series[i] >= thNum) { crossYr = years[i]; break; }
    }
    if (crossYr !== null) {
      g.append("circle").attr("class", "scenario-dot")
        .attr("cx", x(crossYr)).attr("cy", y(thNum)).attr("r", 5);
      g.append("text").attr("class", "scenario-label")
        .attr("fill", "var(--ink)").attr("text-anchor", "middle")
        .attr("x", x(crossYr)).attr("y", y(thNum) - 10)
        .text(`global avg: ${crossYr}`);
    }

    if (state.mode === "anomaly") {
      g.append("line").attr("class", "year-marker")
        .attr("x1", x(state.year)).attr("x2", x(state.year))
        .attr("y1", m.top).attr("y2", height - m.bottom)
        .attr("stroke", "var(--ink)").attr("stroke-width", 1)
        .attr("stroke-dasharray", "2 3").attr("opacity", 0.6);
    }
  }

  return { init, update };
})();

// =========================================================
// CELL CHART (with global mean overlay)
// =========================================================
const cellChartModule = (() => {
  let svg, g, x, y, line, area, dims;

  function init() {
    svg = d3.select("#cell-chart");
    if (svg.empty()) return;
    g = svg.append("g");
    const ro = new ResizeObserver(() => { build(); update(); });
    ro.observe(svg.node());
    build();
    buildChips();
  }

  function buildChips() {
    const wrap = d3.select("#region-chips");
    if (wrap.empty()) return;
    const regions = Object.keys(data.regionalMeans[state.scenario]);
    wrap.selectAll("button").data(regions).join("button")
      .attr("class", "chip")
      .text((d) => d)
      .on("click", (event, d) => {
        state.selectedRegion = state.selectedRegion === d ? null : d;
        state.selectedCell = null;
        render();
      });
  }

  function build() {
    const node = svg.node();
    if (!node) return;
    const { width, height } = node.getBoundingClientRect();
    if (!width || !height) return;
    svg.attr("viewBox", `0 0 ${width} ${height}`);
    const m = { top: 14, right: 16, bottom: 24, left: 30 };
    dims = { width, height, m };

    const years = data.grid.years;
    x = d3.scaleLinear().domain(d3.extent(years)).range([m.left, width - m.right]);
    y = d3.scaleLinear().domain([-1, 8]).range([height - m.bottom, m.top]);

    line = d3.line().x((_, i) => x(years[i])).y((d) => y(d)).curve(d3.curveMonotoneX);
    area = d3.area().x((_, i) => x(years[i])).y0(y(0)).y1((d) => y(d)).curve(d3.curveMonotoneX);

    g.selectAll(".axis").remove();
    g.append("g").attr("class", "axis axis--x")
      .attr("transform", `translate(0,${height - m.bottom})`)
      .call(d3.axisBottom(x).tickValues([2020, 2050, 2080]).tickFormat(d3.format("d")));
    g.append("g").attr("class", "axis axis--y")
      .attr("transform", `translate(${m.left},0)`)
      .call(d3.axisLeft(y).ticks(4).tickFormat((d) => `${d}°`).tickSize(-(width - m.left - m.right)));
    g.selectAll(".axis line").attr("class", "gridline").attr("stroke-dasharray", "2 3");
    g.selectAll(".axis path").attr("display", "none");
  }

  function update() {
    if (!x) return;
    const { width, height, m } = dims;
    const years = data.grid.years;

    g.selectAll(".cell-line, .cell-area, .threshold-line, .threshold-label, .crossing-dot, .crossing-text, .empty-msg, .global-overlay-line, .global-overlay-label").remove();

    let series, label, source;
    if (state.selectedCell) {
      series = getCellSeries(state.scenario, state.selectedCell.latIdx, state.selectedCell.lonIdx);
      const { lat, lon } = state.selectedCell;
      const normLon = lon > 180 ? lon - 360 : lon;
      label = `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? "N" : "S"}, ${Math.abs(normLon).toFixed(1)}°${normLon >= 0 ? "E" : "W"}`;
      source = "cell";
    } else if (state.selectedRegion) {
      series = data.regionalMeans[state.scenario][state.selectedRegion];
      label = state.selectedRegion;
      source = "region";
    }

    if (source) {
      d3.select("#cell-title").text(label);
      d3.select("#cell-sub").text(`${SCENARIO_LABELS[state.scenario]} · ${source === "region" ? "regional area-weighted mean" : "single grid cell"} vs global average`);
    } else {
      d3.select("#cell-title").text("Click a region on the map");
      d3.select("#cell-sub").text("Or pick a region below to compare warming.");
    }

    d3.selectAll("#region-chips .chip").classed("active", (d) => d === state.selectedRegion);

    if (!series) {
      g.append("text").attr("class", "empty-msg")
        .attr("x", width / 2).attr("y", height / 2)
        .attr("text-anchor", "middle").attr("fill", "var(--ink-faint)")
        .style("font-family", "var(--font-mono)").style("font-size", "11px")
        .text("select a location");
      return;
    }

    const thNum = +state.threshold;
    g.append("line").attr("class", "threshold-line")
      .attr("x1", m.left).attr("x2", width - m.right)
      .attr("y1", y(thNum)).attr("y2", y(thNum));

    // Global mean overlay (dashed)
    const globalSeries = data.globalMeans[state.scenario];
    g.append("path").attr("class", "global-overlay-line").attr("d", line(globalSeries));

    // Local series area + line
    g.append("path").attr("class", "cell-area").attr("d", area(series));
    g.append("path").attr("class", "cell-line").attr("d", line(series));

    // Find crossings
    let localCross = null, globalCross = null;
    for (let i = 0; i < series.length; i++) if (series[i] >= thNum) { localCross = years[i]; break; }
    for (let i = 0; i < globalSeries.length; i++) if (globalSeries[i] >= thNum) { globalCross = years[i]; break; }

    if (localCross !== null) {
      g.append("circle").attr("class", "crossing-dot")
        .attr("cx", x(localCross)).attr("cy", y(thNum)).attr("r", 4)
        .attr("fill", "var(--accent)").attr("stroke", "var(--bg-card)").attr("stroke-width", 2);
      g.append("text").attr("class", "crossing-text")
        .attr("x", x(localCross)).attr("y", y(thNum) - 8)
        .attr("text-anchor", "middle").attr("fill", "var(--accent)")
        .style("font-family", "var(--font-mono)").style("font-size", "10px")
        .text(`here: ${localCross}`);
    } else {
      g.append("text").attr("class", "crossing-text")
        .attr("x", width - m.right - 4).attr("y", y(thNum) - 4)
        .attr("text-anchor", "end").attr("fill", "var(--good)")
        .style("font-family", "var(--font-mono)").style("font-size", "10px")
        .text(`stays below ${thNum}°C`);
    }

    if (globalCross !== null) {
      g.append("text").attr("class", "global-overlay-label")
        .attr("x", x(globalCross)).attr("y", y(thNum) + 14)
        .attr("text-anchor", "middle")
        .text(`global: ${globalCross}`);
    }
  }
  return { init, update, rebuild: build };
})();

// =========================================================
// STATS
// =========================================================
function updateStats() {
  if (!document.getElementById("stat-pct-crossed")) return;
  const flat = data.crossings[state.scenario][state.threshold];
  const total = flat.length;
  const crossed = flat.filter((v) => v !== null);
  const pct = (crossed.length / total) * 100;
  const sorted = crossed.slice().sort(d3.ascending);
  const median = d3.quantile(sorted, 0.5);

  let firstRegion = "—";
  if (crossed.length) {
    const regionalCross = {};
    Object.keys(data.regionalMeans[state.scenario]).forEach((r) => {
      const series = data.regionalMeans[state.scenario][r];
      const yrs = data.grid.years;
      const th = +state.threshold;
      let cy = null;
      for (let i = 0; i < series.length; i++) if (series[i] >= th) { cy = yrs[i]; break; }
      regionalCross[r] = cy;
    });
    const sortedR = Object.entries(regionalCross)
      .filter(([_, y]) => y !== null)
      .sort((a, b) => a[1] - b[1]);
    if (sortedR.length) firstRegion = `${sortedR[0][0]} (${sortedR[0][1]})`;
  }

  d3.select("#stat-pct-crossed").text(`${pct.toFixed(0)}%`);
  d3.select("#stat-median-year").text(median != null ? Math.round(median) : "—");
  d3.select("#stat-first-region").text(firstRegion);

  d3.select("#year-readout").text(state.year);
  d3.select("#year-scrubber").attr("hidden", state.mode === "anomaly" ? null : true);
}

// =========================================================
// SCROLL ENGINE — IntersectionObserver swaps viz panel + locks/unlocks state
// =========================================================
const scrollEngine = (() => {
  const STEP_DEFAULTS = {
    1: { scenario: "ssp245", threshold: "2.0", mode: "crossing", panel: "map" },
    2: { scenario: "ssp245", threshold: "2.0", mode: "crossing", panel: "map" },
    3: {                      threshold: "2.0",                        panel: "mitigation" },
    4: { scenario: "ssp585", threshold: "2.0",                        panel: "race" },
    5: { scenario: "ssp585", threshold: "2.0",                        panel: "comparison" },
  };

  function init() {
    const steps = document.querySelectorAll(".story-step");
    if (!steps.length) return;

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && entry.intersectionRatio > 0.45) {
          const stepNum = +entry.target.dataset.step;
          activateStep(stepNum);
        }
      });
    }, {
      rootMargin: "-30% 0px -30% 0px",
      threshold: [0, 0.25, 0.5, 0.75, 1],
    });

    steps.forEach((s) => observer.observe(s));
    activateStep(1);
  }

  function activateStep(stepNum) {
    state.activeStep = stepNum;

    // Update visual active class
    document.querySelectorAll(".story-step").forEach((s) => {
      s.classList.toggle("is-active", +s.dataset.step === stepNum);
    });

    // Apply step defaults (if set)
    const defaults = STEP_DEFAULTS[stepNum] || {};
    if (defaults.scenario) {
      state.scenario = defaults.scenario;
      syncSegControls("scenario", state.scenario);
    }
    if (defaults.threshold) {
      state.threshold = defaults.threshold;
      syncSegControls("threshold", state.threshold);
    }
    if (defaults.mode) {
      state.mode = defaults.mode;
      syncSegControls("mode", state.mode);
    }

    // Swap viz panel
    const targetPanel = defaults.panel || "map";
    document.querySelectorAll(".viz-panel").forEach((p) => {
      const isActive = p.dataset.panel === targetPanel;
      p.classList.toggle("is-visible", isActive);
      if (isActive) p.removeAttribute("hidden");
      else p.setAttribute("hidden", "");
    });

    // After making a panel visible, give the browser one frame, then
    // ask the relevant module to rebuild against its now-measurable SVG.
    requestAnimationFrame(() => {
      if (targetPanel === "mitigation" && mitigationMapModule.rebuild) mitigationMapModule.rebuild();
      if (targetPanel === "race" && raceChartModule.rebuild) raceChartModule.rebuild();
      if (targetPanel === "map" && mainMap && mainMap.build) mainMap.build();
      if (targetPanel === "comparison" && cellChartModule.rebuild) cellChartModule.rebuild();
      render();
    });
  }

  return { init, activateStep };
})();

function syncSegControls(group, value) {
  // group: "scenario" | "threshold" | "mode" — sync all matching seg-controls across the page
  const sel = `[id^='${group}-control']`;
  document.querySelectorAll(sel).forEach((control) => {
    control.querySelectorAll(".seg-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.value === value);
    });
  });
}

// =========================================================
// CONTROLS WIRING
// =========================================================
function wireControls() {
  // Generic: any element whose id starts with scenario-control / threshold-control / mode-control
  document.querySelectorAll("[id^='scenario-control']").forEach((ctrl) => {
    ctrl.querySelectorAll(".seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.scenario = btn.dataset.value;
        syncSegControls("scenario", state.scenario);
        render();
      });
    });
  });
  document.querySelectorAll("[id^='threshold-control']").forEach((ctrl) => {
    ctrl.querySelectorAll(".seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.threshold = btn.dataset.value;
        syncSegControls("threshold", state.threshold);
        render();
      });
    });
  });
  document.querySelectorAll("[id^='mode-control']").forEach((ctrl) => {
    ctrl.querySelectorAll(".seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.mode = btn.dataset.value;
        syncSegControls("mode", state.mode);
        render();
      });
    });
  });

  const slider = document.getElementById("year-slider");
  if (slider) {
    slider.addEventListener("input", () => {
      state.year = +slider.value;
      const yt = document.getElementById("year-tick");
      if (yt) yt.textContent = state.year;
      render();
    });
  }

  const playBtn = document.getElementById("play-btn");
  const playIcon = document.getElementById("play-icon");
  if (playBtn && playIcon && slider) {
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
          const yt = document.getElementById("year-tick");
          if (yt) yt.textContent = next;
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
}

// =========================================================
// MAP INSTANCES & RENDER
// =========================================================
let mainMap, exploreMap;

function render() {
  updateStats();
  if (mainMap) { mainMap.update(); mainMap.updateLegend(); }
  if (exploreMap) { exploreMap.update(); exploreMap.updateLegend(); }
  mitigationMapModule.update();
  raceChartModule.update();
  globalChartModule.update();
  cellChartModule.update();
}

// =========================================================
// BOOTSTRAP
// =========================================================
async function main() {
  try {
    await loadData();

    mainMap = createMapModule({
      svgId: "map", tooltipId: "tooltip", legendId: "map-legend",
      titleId: "map-title", subId: "map-sub", interactive: true,
    });
    mainMap.init();

    exploreMap = createMapModule({
      svgId: "explore-map", tooltipId: "explore-tooltip", legendId: "explore-legend",
      interactive: true,
    });
    exploreMap.init();

    mitigationMapModule.init();
    raceChartModule.init();
    globalChartModule.init();
    cellChartModule.init();

    wireControls();
    scrollEngine.init();
    render();
  } catch (err) {
    console.error("Failed to start app", err);
    const overlay = document.getElementById("map-loading");
    if (overlay) overlay.textContent = `error: ${err.message}`;
  }
}

document.addEventListener("DOMContentLoaded", main);

// Expose for debugging
window.state = state;
window.data = data;

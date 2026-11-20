const { onRequest } = require("firebase-functions/v2/https");

const NA_SOURCES = [
  {
    id: "NOAA-20",
    window: "7d",
    url: "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_USA_contiguous_and_Hawaii_7d.csv",
  },
  {
    id: "NOAA-21",
    window: "7d",
    url: "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-21-viirs-c2/csv/J2_VIIRS_C2_USA_contiguous_and_Hawaii_7d.csv",
  },
];

const GLOBAL_SOURCES = [
  {
    id: "NOAA-20",
    window: "24h",
    url: "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_24h.csv",
  },
  {
    id: "NOAA-21",
    window: "24h",
    url: "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-21-viirs-c2/csv/J2_VIIRS_C2_Global_24h.csv",
  },
];

const cache = new Map();
const CACHE_MS = 10 * 60 * 1000;

function numberInRange(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(",");
  const index = Object.fromEntries(header.map((name, position) => [name, position]));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    if (cells.length < header.length) continue;
    const confidence = String(cells[index.confidence] || "").toLowerCase();
    if (confidence === "low" || confidence === "l") continue;
    rows.push({
      latitude: Number(cells[index.latitude]),
      longitude: Number(cells[index.longitude]),
      acq_date: cells[index.acq_date],
      acq_time: cells[index.acq_time],
      satellite: cells[index.satellite],
      confidence,
    });
  }
  return rows;
}

async function loadRows(source) {
  const hit = cache.get(source.url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;
  const response = await fetch(source.url);
  if (!response.ok) throw new Error(source.id + " returned " + response.status);
  const rows = parseCsv(await response.text());
  cache.set(source.url, { at: Date.now(), rows });
  return rows;
}

const fs = require("fs");
const path = require("path");

function mapKey() {
  if (process.env.FIRMS_MAP_KEY) return process.env.FIRMS_MAP_KEY.trim();
  try {
    const text = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
    const line = text.split(/\r?\n/).find((entry) => entry.startsWith("FIRMS_MAP_KEY="));
    return line ? line.slice("FIRMS_MAP_KEY=".length).trim() : "";
  } catch (error) {
    return "";
  }
}

const SENSOR_FAMILIES = [
  ["VIIRS_SNPP_SP", "VIIRS_SNPP_NRT"],
  ["VIIRS_NOAA20_SP", "VIIRS_NOAA20_NRT"],
  ["VIIRS_NOAA21_SP", "VIIRS_NOAA21_NRT"],
];

let availabilityCache = null;
let availabilityAt = 0;

function dayShift(isoDay, days) {
  return new Date(Date.parse(isoDay + "T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);
}

function overlaps(range, startDay, endDay) {
  return Boolean(range) && range.min <= endDay && range.max >= startDay;
}

async function loadAvailability(key) {
  if (availabilityCache && Date.now() - availabilityAt < 60 * 60 * 1000) return availabilityCache;
  const ids = SENSOR_FAMILIES.flat();
  const ranges = {};
  await Promise.all(
    ids.map(async (id) => {
      const response = await fetch("https://firms.modaps.eosdis.nasa.gov/api/data_availability/csv/" + key + "/" + id);
      const text = await response.text();
      const lines = text.trim().split(/\r?\n/);
      if (lines.length < 2 || lines[1].startsWith("Invalid")) return;
      const cells = lines[1].split(",");
      ranges[id] = { min: cells[1], max: cells[2] };
    })
  );
  availabilityCache = ranges;
  availabilityAt = Date.now();
  return ranges;
}

function sensorsFor(ranges, startDay, endDay) {
  const chosen = [];
  SENSOR_FAMILIES.forEach(([archive, recent]) => {
    const archiveRange = ranges[archive];
    const recentRange = ranges[recent];
    const archiveOverlaps = overlaps(archiveRange, startDay, endDay);
    const recentOverlaps = overlaps(recentRange, startDay, endDay);
    if (archiveOverlaps && (!recentOverlaps || endDay <= archiveRange.max)) chosen.push(archive);
    if (recentOverlaps && (!archiveOverlaps || endDay > archiveRange.max)) chosen.push(recent);
  });
  return chosen;
}

async function loadArchive(key, source, west, south, east, north, startDay) {
  const url =
    "https://firms.modaps.eosdis.nasa.gov/api/area/csv/" +
    key +
    "/" +
    source +
    "/" +
    [west, south, east, north].map((value) => Number(value).toFixed(4)).join(",") +
    "/5/" +
    startDay;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok || text.startsWith("Invalid") || text.startsWith("<")) {
    throw new Error(source + " could not be loaded for that date.");
  }
  const rows = parseCsv(text);
  cache.set(url, { at: Date.now(), rows });
  return rows;
}

function usesNorthAmerica(lat, lon) {
  const conus = lat >= 24 && lat <= 49.6 && lon >= -125 && lon <= -66;
  const hawaii = lat >= 18 && lat <= 23 && lon >= -161 && lon <= -154;
  return conus || hawaii;
}

function addressLabel(properties) {
  const street = [properties.housenumber, properties.street || properties.name].filter(Boolean).join(" ");
  const place = [properties.city || properties.town || properties.village || properties.county, properties.state].filter(Boolean).join(", ");
  return [street, place].filter(Boolean).join(", ");
}

function suggestionsFromPhoton(body) {
  const features = body.features || [];
  const suggestions = [];
  const seen = new Set();
  features.forEach((feature) => {
    const properties = feature.properties || {};
    const coordinates = feature.geometry && feature.geometry.coordinates;
    if (!coordinates) return;
    const label = addressLabel(properties);
    if (!label || seen.has(label)) return;
    seen.add(label);
    suggestions.push({ label, lat: coordinates[1], lon: coordinates[0] });
  });
  return suggestions;
}

exports.address = onRequest({ cors: true, timeoutSeconds: 20 }, async (req, res) => {
  const query = String(req.query.q || "").trim();
  if (query.length < 3) {
    res.json({ suggestions: [] });
    return;
  }
  try {
    const response = await fetch("https://photon.komoot.io/api/?limit=6&q=" + encodeURIComponent(query));
    if (!response.ok) throw new Error("address search failed");
    res.json({ suggestions: suggestionsFromPhoton(await response.json()) });
  } catch (error) {
    res.status(502).json({ error: "Address search is unavailable right now." });
  }
});

const OVERPASS_ENDPOINTS = [
  "https://overpass.openstreetmap.fr/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

function overpassQuery(lat, lon) {
  return (
    "[out:json][timeout:25];(" +
    'way["highway"~"^(motorway|trunk|primary|secondary)$"](around:10000,' +
    lat +
    "," +
    lon +
    ");" +
    'way["highway"="tertiary"](around:3500,' +
    lat +
    "," +
    lon +
    "););out tags geom;"
  );
}

function roadsFromOverpass(body) {
  return (body.elements || [])
    .filter((element) => element.geometry && element.geometry.length > 1)
    .map((element) => ({
      name: (element.tags && (element.tags.ref || element.tags.name)) || "Unnamed road",
      highway: element.tags && element.tags.highway,
      maxspeed: element.tags && element.tags.maxspeed,
      points: element.geometry.map((point) => ({ lat: point.lat, lon: point.lon })),
    }));
}

exports.roads = onRequest({ cors: true, timeoutSeconds: 60, memory: "512MiB" }, async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -85 || lat > 85 || lon < -180 || lon > 180) {
    res.status(400).json({ error: "Provide a valid latitude and longitude." });
    return;
  }

  const query = overpassQuery(lat, lon);
  let lastStatus = 0;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "User-Agent": "WhichEvacuationRoadClosesFirst/1.0 (Firebase Hosting planning aid)",
        },
        body: "data=" + encodeURIComponent(query),
      });
      lastStatus = response.status;
      if (!response.ok) continue;
      const body = await response.json();
      res.json({ roads: roadsFromOverpass(body) });
      return;
    } catch (error) {
      lastStatus = lastStatus || 502;
    }
  }
  res.status(502).json({ error: "The road map is unavailable." + (lastStatus ? " (" + lastStatus + ")" : "") });
});

exports.reverse = onRequest({ cors: true, timeoutSeconds: 20 }, async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    res.status(400).json({ error: "Provide a latitude and longitude." });
    return;
  }
  try {
    const response = await fetch("https://photon.komoot.io/reverse?lon=" + lon + "&lat=" + lat);
    if (!response.ok) throw new Error("reverse failed");
    const suggestions = suggestionsFromPhoton(await response.json());
    res.json({ place: suggestions[0] || { label: lat.toFixed(5) + ", " + lon.toFixed(5), lat, lon } });
  } catch (error) {
    res.status(502).json({ error: "Could not find an address for that location." });
  }
});

exports.firms = onRequest({ cors: true, timeoutSeconds: 120, memory: "512MiB" }, async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Use GET." });
    return;
  }

  const south = numberInRange(req.query.south, -85, 85);
  const north = numberInRange(req.query.north, -85, 85);
  const west = numberInRange(req.query.west, -180, 180);
  const east = numberInRange(req.query.east, -180, 180);
  if (south === null || north === null || west === null || east === null || south >= north || west >= east) {
    res.status(400).json({ error: "Provide a valid south, west, north, and east box." });
    return;
  }
  if (north - south > 2 || east - west > 2) {
    res.status(400).json({ error: "That search box is too large." });
    return;
  }

  const asOf = req.query.asOf ? Date.parse(req.query.asOf) : null;
  if (req.query.asOf && !Number.isFinite(asOf)) {
    res.status(400).json({ error: "That date and time is not valid." });
    return;
  }

  try {
    if (Number.isFinite(asOf)) {
      const key = mapKey();
      if (!key) {
        res.status(500).json({ error: "The FIRMS map key is not configured." });
        return;
      }
      const endDay = new Date(asOf).toISOString().slice(0, 10);
      const startDay = dayShift(endDay, -4);
      const ranges = await loadAvailability(key);
      const sensors = sensorsFor(ranges, startDay, endDay);
      if (!sensors.length) {
        res.status(400).json({ error: "FIRMS has no VIIRS archive for that date." });
        return;
      }
      const tables = await Promise.all(sensors.map((sensor) => loadArchive(key, sensor, west, south, east, north, startDay)));
      const detections = [];
      tables.forEach((rows) => {
        rows.forEach((row) => {
          const seen = Date.parse(row.acq_date + "T" + String(row.acq_time).padStart(4, "0").slice(0, 2) + ":" + String(row.acq_time).padStart(4, "0").slice(2) + ":00Z");
          if (seen > asOf) return;
          detections.push(row);
        });
      });
      res.json({ window: "5d", asOf: new Date(asOf).toISOString(), sources: sensors, detections });
      return;
    }

    const lat = (south + north) / 2;
    const lon = (west + east) / 2;
    const sources = usesNorthAmerica(lat, lon) ? NA_SOURCES : GLOBAL_SOURCES;
    const tables = await Promise.all(sources.map(loadRows));
    const detections = [];
    tables.forEach((rows) => {
      rows.forEach((row) => {
        if (row.latitude < south || row.latitude > north || row.longitude < west || row.longitude > east) return;
        detections.push(row);
      });
    });
    res.json({
      window: sources[0].window,
      sources: sources.map((source) => source.id + " " + source.window),
      detections,
    });
  } catch (error) {
    res.status(502).json({ error: "Fire detections are unavailable right now." });
  }
});

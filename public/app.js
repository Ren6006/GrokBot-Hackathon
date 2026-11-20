const form = document.querySelector("#search");
const placeInput = document.querySelector("#place");
const locateButton = document.querySelector("#locate");
const suggestionsNode = document.querySelector("#suggestions");
const statusNode = document.querySelector("#status");

const OVERPASS = "https://overpass.openstreetmap.fr/api/interpreter";
const map = L.map("map", { zoomControl: true }).setView([39.5, -98.35], 4);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
  maxZoom: 19,
}).addTo(map);
const drawn = L.layerGroup().addTo(map);

let suggestions = [];
let highlighted = -1;
let searchTimer = null;
let requestId = 0;

function setStatus(message) {
  statusNode.textContent = message;
}

function firmsTime(date, time) {
  const hhmm = String(time).padStart(4, "0");
  return Date.parse(date + "T" + hhmm.slice(0, 2) + ":" + hhmm.slice(2) + ":00Z");
}

function hideSuggestions() {
  suggestions = [];
  highlighted = -1;
  suggestionsNode.hidden = true;
  suggestionsNode.replaceChildren();
  placeInput.setAttribute("aria-expanded", "false");
}

function renderSuggestions() {
  suggestionsNode.replaceChildren();
  if (!suggestions.length) {
    suggestionsNode.hidden = true;
    placeInput.setAttribute("aria-expanded", "false");
    return;
  }
  suggestions.forEach((suggestion, index) => {
    const item = document.createElement("li");
    item.id = "suggestion-" + index;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", index === highlighted ? "true" : "false");
    item.textContent = suggestion.label;
    item.addEventListener("mousedown", (event) => {
      event.preventDefault();
      chooseSuggestion(suggestion);
    });
    suggestionsNode.append(item);
  });
  suggestionsNode.hidden = false;
  placeInput.setAttribute("aria-expanded", "true");
  placeInput.setAttribute("aria-activedescendant", highlighted >= 0 ? "suggestion-" + highlighted : "");
}

async function fetchSuggestions(query) {
  const response = await fetch("/api/address?q=" + encodeURIComponent(query));
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Address search is unavailable.");
  return body.suggestions || [];
}

function selectedAsOf() {
  const value = document.querySelector("#when").value;
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function whenLabel(asOf) {
  if (!asOf) return "";
  return "Treating " + new Date(asOf).toLocaleString() + " as the current time. ";
}

async function loadFires(lat, lon, asOf) {
  const latPad = 0.4;
  const lonPad = 0.4 / Math.max(Math.cos((lat * Math.PI) / 180), 0.2);
  const params = new URLSearchParams({
    south: String(lat - latPad),
    north: String(lat + latPad),
    west: String(lon - lonPad),
    east: String(lon + lonPad),
  });
  if (asOf) params.set("asOf", new Date(asOf).toISOString());
  const response = await fetch("/api/firms?" + params.toString());
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Fire detections are unavailable.");
  return body;
}

async function loadWind(lat, lon, asOf) {
  if (asOf && asOf < Date.now() - 3 * 60 * 60 * 1000) {
    const day = new Date(asOf).toISOString().slice(0, 10);
    const hour = new Date(asOf).toISOString().slice(0, 13) + ":00";
    const url =
      "https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=" +
      lat +
      "&longitude=" +
      lon +
      "&start_date=" +
      day +
      "&end_date=" +
      day +
      "&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms&timezone=UTC";
    const response = await fetch(url);
    if (!response.ok) throw new Error("The wind forecast for that time is unavailable.");
    const body = await response.json();
    const times = (body.hourly && body.hourly.time) || [];
    let index = times.indexOf(hour);
    if (index < 0) index = 0;
    const speed = body.hourly.wind_speed_10m[index];
    const direction = body.hourly.wind_direction_10m[index];
    if (!Number.isFinite(speed) || !Number.isFinite(direction)) {
      throw new Error("The wind forecast for that time did not include a wind speed.");
    }
    return { speedMs: speed, directionFrom: direction };
  }
  const url =
    "https://api.open-meteo.com/v1/forecast?latitude=" +
    lat +
    "&longitude=" +
    lon +
    "&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms";
  const response = await fetch(url);
  if (!response.ok) throw new Error("The wind forecast is unavailable.");
  const body = await response.json();
  const current = body.current || {};
  if (!Number.isFinite(current.wind_speed_10m) || !Number.isFinite(current.wind_direction_10m)) {
    throw new Error("The wind forecast did not include a wind speed.");
  }
  return { speedMs: current.wind_speed_10m, directionFrom: current.wind_direction_10m };
}

async function loadElevation(lat, lon) {
  const count = 10;
  const latPad = 0.22;
  const lonPad = 0.22 / Math.max(Math.cos((lat * Math.PI) / 180), 0.2);
  const lats = [];
  const lons = [];
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      lats.push(lat - latPad + ((row + 0.5) * (latPad * 2)) / count);
      lons.push(lon - lonPad + ((col + 0.5) * (lonPad * 2)) / count);
    }
  }
  const url = "https://api.open-meteo.com/v1/elevation?latitude=" + lats.join(",") + "&longitude=" + lons.join(",");
  const response = await fetch(url);
  if (!response.ok) return [];
  const body = await response.json();
  if (!body.elevation || body.elevation.length !== lats.length) return [];
  return lats.map((sampleLat, index) => ({
    lat: sampleLat,
    lon: lons[index],
    elevation: body.elevation[index],
  }));
}

async function loadRoads(lat, lon) {
  const query =
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
    "););out tags geom;";
  const response = await fetch(OVERPASS, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: "data=" + encodeURIComponent(query),
  });
  if (!response.ok) throw new Error("The road map is unavailable.");
  const body = await response.json();
  return (body.elements || [])
    .filter((element) => element.geometry && element.geometry.length > 1)
    .map((element) => ({
      name: (element.tags && (element.tags.ref || element.tags.name)) || "Unnamed road",
      highway: element.tags && element.tags.highway,
      maxspeed: element.tags && element.tags.maxspeed,
      points: element.geometry.map((point) => ({ lat: point.lat, lon: point.lon })),
    }));
}

function drawMap(place, roads, detections, segments) {
  drawn.clearLayers();
  const openRoads = segments
    ? segments.filter((segment) => !segment.blocked)
    : roads.map((road) => ({ positions: road.points.map((point) => [point.lat, point.lon]) }));
  const closedRoads = segments ? segments.filter((segment) => segment.blocked) : [];

  openRoads.forEach((segment) => {
    L.polyline(segment.positions, { color: "#3b6ea5", weight: 3, opacity: 0.85 }).addTo(drawn);
  });
  closedRoads.forEach((segment) => {
    L.polyline(segment.positions, { color: "#dc2626", weight: 5, opacity: 0.95 }).addTo(drawn);
  });

  const nearest = detections
    .map((detection) => ({
      detection,
      distance: Math.hypot(detection.lat - place.lat, detection.lon - place.lon),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 250);
  nearest.forEach(({ detection }) => {
    L.circleMarker([detection.lat, detection.lon], {
      radius: 4,
      color: "#7f1d1d",
      weight: 1,
      fillColor: "#ef4444",
      fillOpacity: 0.9,
    }).addTo(drawn);
  });

  L.circleMarker([place.lat, place.lon], {
    radius: 8,
    color: "#1d4ed8",
    weight: 3,
    fillColor: "#ffffff",
    fillOpacity: 1,
  })
    .bindTooltip(place.label, { permanent: false })
    .addTo(drawn);

  if (!openRoads.length && !closedRoads.length) {
    map.setView([place.lat, place.lon], 13);
    return;
  }
  const bounds = L.latLngBounds([[place.lat, place.lon]]);
  openRoads.concat(closedRoads).forEach((segment) => {
    segment.positions.forEach((position) => bounds.extend(position));
  });
  map.fitBounds(bounds.pad(0.15), { paddingTopLeft: [20, 150], maxZoom: 14 });
}

let lastPlace = null;

async function analyzePlace(place) {
  const ticket = ++requestId;
  lastPlace = place;
  const asOf = selectedAsOf();
  locateButton.disabled = true;
  hideSuggestions();
  placeInput.value = place.label;
  setStatus(whenLabel(asOf) + "Loading fire detections, wind, and roads for " + place.label + "…");
  map.setView([place.lat, place.lon], 13);

  try {
    const fires = await loadFires(place.lat, place.lon, asOf);
    if (ticket !== requestId) return;
    const detections = (fires.detections || [])
      .map((detection) => ({
        lat: detection.latitude,
        lon: detection.longitude,
        time: firmsTime(detection.acq_date, detection.acq_time),
      }))
      .filter((detection) => Number.isFinite(detection.lat) && Number.isFinite(detection.time) && (!asOf || detection.time <= asOf));
    const roads = await loadRoads(place.lat, place.lon);
    if (ticket !== requestId) return;

    if (!detections.length) {
      const windowLabel = asOf ? "5 days before that time" : fires.window === "7d" ? "7 days" : "24 hours";
      drawMap(place, roads, [], null);
      setStatus(whenLabel(asOf) + "No VIIRS fire detections within about 45 km of " + place.label + " in the last " + windowLabel + ". No road is marked closed.");
      return;
    }

    const fireLat = detections.reduce((sum, point) => sum + point.lat, 0) / detections.length;
    const fireLon = detections.reduce((sum, point) => sum + point.lon, 0) / detections.length;
    const [wind, elevation] = await Promise.all([loadWind(fireLat, fireLon, asOf), loadElevation(place.lat, place.lon)]);
    if (ticket !== requestId) return;
    const result = RoadModel.analyze({ town: place, detections, wind, elevation, roads, asOf });
    if (!result.fire) {
      drawMap(place, roads, detections, null);
      setStatus(whenLabel(asOf) + "Detections are outside the roads around " + place.label + ". No road is marked closed.");
      return;
    }
    drawMap(place, roads, detections, result.segments);
    const rateLabel = result.rateSource === "observed" ? "The spread rate is measured from satellite passes." : "Only one pass was usable, so the spread rate comes from the wind.";
    if (!result.blockedCount) {
      setStatus(whenLabel(asOf) + "If you leave in 30 minutes, these roads are still reachable before the fire. " + rateLabel);
      return;
    }
    setStatus(
      whenLabel(asOf) +
        result.blockedCount +
        " stretches turn red: the fire reaches them before you would, if you waited 30 minutes to start driving. " +
        rateLabel
    );
  } catch (error) {
    if (ticket !== requestId) return;
    setStatus(error.message || "Something went wrong while checking this address.");
  } finally {
    if (ticket === requestId) locateButton.disabled = false;
  }
}

async function chooseSuggestion(suggestion) {
  hideSuggestions();
  await analyzePlace(suggestion);
}

placeInput.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  const query = placeInput.value.trim();
  if (query.length < 3) {
    hideSuggestions();
    return;
  }
  searchTimer = window.setTimeout(async () => {
    try {
      suggestions = await fetchSuggestions(query);
      highlighted = suggestions.length ? 0 : -1;
      renderSuggestions();
    } catch (error) {
      hideSuggestions();
      setStatus(error.message);
    }
  }, 250);
});

placeInput.addEventListener("keydown", async (event) => {
  if (event.key === "ArrowDown" && suggestions.length) {
    event.preventDefault();
    highlighted = (highlighted + 1) % suggestions.length;
    renderSuggestions();
  } else if (event.key === "ArrowUp" && suggestions.length) {
    event.preventDefault();
    highlighted = (highlighted - 1 + suggestions.length) % suggestions.length;
    renderSuggestions();
  } else if (event.key === "Escape") {
    hideSuggestions();
  } else if (event.key === "Enter" && suggestions.length && highlighted >= 0) {
    event.preventDefault();
    await chooseSuggestion(suggestions[highlighted]);
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (suggestions.length) {
    await chooseSuggestion(suggestions[highlighted >= 0 ? highlighted : 0]);
    return;
  }
  const query = placeInput.value.trim();
  if (query.length < 3) return;
  try {
    const matches = await fetchSuggestions(query);
    if (!matches.length) {
      setStatus("No address matched that search.");
      return;
    }
    await chooseSuggestion(matches[0]);
  } catch (error) {
    setStatus(error.message);
  }
});

locateButton.addEventListener("click", () => {
  if (!navigator.geolocation) {
    setStatus("This browser cannot share your location.");
    return;
  }
  setStatus("Finding your location…");
  navigator.geolocation.getCurrentPosition(
    async (position) => {
      try {
        const response = await fetch("/api/reverse?lat=" + position.coords.latitude + "&lon=" + position.coords.longitude);
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "Could not find an address for your location.");
        await analyzePlace(body.place);
      } catch (error) {
        setStatus(error.message);
      }
    },
    () => setStatus("Location permission was denied.")
  );
});

document.querySelector("#when").addEventListener("change", () => {
  if (lastPlace) analyzePlace(lastPlace);
});

document.addEventListener("click", (event) => {
  if (!form.contains(event.target)) hideSuggestions();
});

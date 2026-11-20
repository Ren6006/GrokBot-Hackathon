const form = document.querySelector("#search");
const placeInput = document.querySelector("#place");
const destinationInput = document.querySelector("#destination");
const locateButton = document.querySelector("#locate");
const suggestionsNode = document.querySelector("#suggestions");
const routeChoices = document.querySelector("#route-choices");
const statusNode = document.querySelector("#status");

const OVERPASS = "https://overpass.openstreetmap.fr/api/interpreter";
const map = L.map("map", { zoomControl: true }).setView([39.5, -98.35], 4);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
  maxZoom: 19,
}).addTo(map);
const drawn = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);

let suggestions = [];
let highlighted = -1;
let searchTimer = null;
let requestId = 0;
let activeInput = placeInput;
let lastDestination = null;
let lastHoursUntilFire = null;
let offeredRoutes = [];
const ROUTE_COLORS = { Fastest: "#c2410c", Balanced: "#7c3aed", Safest: "#15803d", "Wider detour": "#0369a1" };

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
  destinationInput.setAttribute("aria-expanded", "false");
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
  activeInput.setAttribute("aria-expanded", "true");
  activeInput.setAttribute("aria-activedescendant", highlighted >= 0 ? "suggestion-" + highlighted : "");
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
  routeLayer.clearLayers();
  routeChoices.hidden = true;
  routeChoices.replaceChildren();
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
      lastHoursUntilFire = null;
      drawMap(place, roads, [], null);
      setStatus(whenLabel(asOf) + "No VIIRS fire detections within about 45 km of " + place.label + " in the last " + windowLabel + ". No road is marked closed.");
      if (lastDestination) await suggestRoutes();
      return;
    }

    const fireLat = detections.reduce((sum, point) => sum + point.lat, 0) / detections.length;
    const fireLon = detections.reduce((sum, point) => sum + point.lon, 0) / detections.length;
    const [wind, elevation] = await Promise.all([loadWind(fireLat, fireLon, asOf), loadElevation(place.lat, place.lon)]);
    if (ticket !== requestId) return;
    const result = RoadModel.analyze({ town: place, detections, wind, elevation, roads, asOf });
    lastHoursUntilFire = result.hoursUntilFire || null;
    if (!result.fire) {
      drawMap(place, roads, detections, null);
      setStatus(whenLabel(asOf) + "Detections are outside the roads around " + place.label + ". No road is marked closed.");
      if (lastDestination) await suggestRoutes();
      return;
    }
    drawMap(place, roads, detections, result.segments);
    if (lastDestination) {
      await suggestRoutes();
      return;
    }
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
  if (activeInput === destinationInput) {
    lastDestination = suggestion;
    destinationInput.value = suggestion.label;
    if (lastPlace) await suggestRoutes();
    return;
  }
  await analyzePlace(suggestion);
}

function kilometers(a, b) {
  const lat = ((a[1] + b[1]) / 2) * Math.PI / 180;
  const dx = (a[0] - b[0]) * 111.32 * Math.cos(lat);
  const dy = (a[1] - b[1]) * 110.57;
  return Math.hypot(dx, dy);
}

function assessRoute(route) {
  const coordinates = route.geometry.coordinates;
  const totalM = route.distance;
  const totalH = route.duration / 3600;
  let traveled = 0;
  let unsafeKm = 0;
  let minSlackH = Infinity;
  for (let i = 1; i < coordinates.length; i++) {
    const previous = coordinates[i - 1];
    const next = coordinates[i];
    const segmentKm = kilometers(previous, next);
    const alongH = totalM > 0 ? ((traveled + segmentKm / 2) / (totalM / 1000)) * totalH : 0;
    const fireH = lastHoursUntilFire ? lastHoursUntilFire(next[1], next[0]) : Infinity;
    const slack = fireH - (0.5 + alongH);
    minSlackH = Math.min(minSlackH, slack);
    if (slack < 0) unsafeKm += segmentKm;
    traveled += segmentKm;
  }
  return {
    durationMin: route.duration / 60,
    distanceKm: totalM / 1000,
    unsafeKm,
    minSlackH,
    coordinates,
  };
}

function safetyScore(option) {
  if (!Number.isFinite(option.minSlackH)) return 1000 - option.durationMin / 60;
  if (option.minSlackH < 0) return option.minSlackH - option.unsafeKm;
  return option.minSlackH;
}

function sameTrip(a, b) {
  return Math.abs(a.durationMin - b.durationMin) < 1.5 && Math.abs(a.unsafeKm - b.unsafeKm) < 0.4;
}

function viaPoint(origin, destination, fire, kilometers, towardFire) {
  const midLat = (origin.lat + destination.lat) / 2;
  const midLon = (origin.lon + destination.lon) / 2;
  const lonScale = 111.32 * Math.cos((midLat * Math.PI) / 180);
  const dx = (destination.lon - origin.lon) * lonScale;
  const dy = (destination.lat - origin.lat) * 110.57;
  const length = Math.hypot(dx, dy) || 1;
  let sideX = -dy / length;
  let sideY = dx / length;
  const fireX = (fire.lon - midLon) * lonScale;
  const fireY = (fire.lat - midLat) * 110.57;
  const pointsAtFire = sideX * fireX + sideY * fireY > 0;
  if (pointsAtFire !== towardFire) {
    sideX *= -1;
    sideY *= -1;
  }
  return { lon: midLon + (sideX * kilometers) / lonScale, lat: midLat + (sideY * kilometers) / 110.57 };
}

function beyondFire(origin, destination, fire, kilometers) {
  const midLon = (origin.lon + destination.lon) / 2;
  const midLat = (origin.lat + destination.lat) / 2;
  const lonScale = 111.32 * Math.cos((fire.lat * Math.PI) / 180);
  let dx = (fire.lon - midLon) * lonScale;
  let dy = (fire.lat - midLat) * 110.57;
  const length = Math.hypot(dx, dy) || 1;
  dx /= length;
  dy /= length;
  return { lon: fire.lon + (dx * kilometers) / lonScale, lat: fire.lat + (dy * kilometers) / 110.57 };
}

async function drivingRoute(points) {
  const path = points.map((point) => point.lon + "," + point.lat).join(";");
  const response = await fetch("https://router.project-osrm.org/route/v1/driving/" + path + "?overview=full&geometries=geojson");
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.code !== "Ok" || !body.routes || !body.routes[0]) return null;
  return assessRoute(body.routes[0]);
}

function describeRoute(option) {
  const time = Math.round(option.durationMin) + " min, " + option.distanceKm.toFixed(1) + " km";
  if (option.unsafeKm >= 0.3) {
    return time + ". About " + option.unsafeKm.toFixed(1) + " km is closed before you get there.";
  }
  if (!Number.isFinite(option.minSlackH) || option.minSlackH > 30) {
    return time + ". The fire does not reach this drive.";
  }
  return time + ". You stay about " + Math.max(1, Math.round(option.minSlackH * 60)) + " min ahead of the fire.";
}

function drawRouteChoices(selectedIndex) {
  routeLayer.clearLayers();
  offeredRoutes.forEach((option, index) => {
    L.polyline(option.coordinates.map((point) => [point[1], point[0]]), {
      color: ROUTE_COLORS[option.name],
      weight: index === selectedIndex ? 7 : 4,
      opacity: index === selectedIndex ? 0.95 : 0.55,
    }).addTo(routeLayer);
  });
  L.circleMarker([lastDestination.lat, lastDestination.lon], {
    radius: 7,
    color: "#111827",
    weight: 2,
    fillColor: "#f8fafc",
    fillOpacity: 1,
  })
    .bindTooltip(lastDestination.label, { permanent: false })
    .addTo(routeLayer);
  routeChoices.replaceChildren();
  offeredRoutes.forEach((option, index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "route-option" + (index === selectedIndex ? " selected" : "");
    button.style.borderLeftColor = ROUTE_COLORS[option.name];
    const title = document.createElement("strong");
    title.textContent = option.name;
    const detail = document.createElement("span");
    detail.textContent = describeRoute(option);
    button.append(title, detail);
    button.addEventListener("click", () => drawRouteChoices(index));
    item.append(button);
    routeChoices.append(item);
  });
  routeChoices.hidden = false;
  const bounds = L.latLngBounds(offeredRoutes.flatMap((option) => option.coordinates.map((point) => [point[1], point[0]])));
  map.fitBounds(bounds.pad(0.2), { paddingTopLeft: [20, 180], maxZoom: 13 });
}

async function suggestRoutes() {
  if (!lastPlace || !lastDestination) return;
  setStatus("Comparing three drives from " + lastPlace.label + " to " + lastDestination.label + "…");
  const fire = lastHoursUntilFire ? { lat: lastPlace.lat, lon: lastPlace.lon } : lastPlace;
  let firePoint = fire;
  if (lastHoursUntilFire) {
    const step = 0.02;
    let hottest = Infinity;
    for (let lat = lastPlace.lat - 0.3; lat <= lastPlace.lat + 0.3; lat += step) {
      for (let lon = lastPlace.lon - 0.3; lon <= lastPlace.lon + 0.3; lon += step) {
        const hours = lastHoursUntilFire(lat, lon);
        if (hours < hottest) {
          hottest = hours;
          firePoint = { lat, lon };
        }
      }
    }
  }
  const paths = [[{ ...lastPlace }, { ...lastDestination }]];
  [
    viaPoint(lastPlace, lastDestination, firePoint, 4, false),
    viaPoint(lastPlace, lastDestination, firePoint, 12, false),
    viaPoint(lastPlace, lastDestination, firePoint, 6, true),
    beyondFire(lastPlace, lastDestination, firePoint, 8),
  ].forEach((via) => paths.push([{ ...lastPlace }, via, { ...lastDestination }]));
  const assessed = [];
  for (const points of paths) {
    const option = await drivingRoute(points);
    if (!option) continue;
    if (assessed.some((existing) => sameTrip(existing, option))) continue;
    assessed.push(option);
  }
  if (!assessed.length) {
    setStatus("No driving route was found between those addresses.");
    return;
  }
  const ordered = assessed.slice().sort((a, b) => a.durationMin - b.durationMin);
  const picked = ordered.length <= 3 ? ordered : [ordered[0], ordered[Math.floor(ordered.length / 2)], ordered[ordered.length - 1]];
  const fastest = picked[0];
  const safest = picked.reduce((best, option) => (safetyScore(option) > safetyScore(best) ? option : best));
  const actuallySafer = safetyScore(safest) > safetyScore(fastest) + 0.15;
  const named = picked.map((option) => {
    let name = "Balanced";
    if (option === fastest) name = "Fastest";
    else if (option === safest && actuallySafer) name = "Safest";
    else if (option.durationMin === picked[picked.length - 1].durationMin) name = "Wider detour";
    return Object.assign({}, option, { name });
  });
  offeredRoutes = named;
  const preferred = named.findIndex((option) => option.name === "Safest" || option.name === "Balanced");
  drawRouteChoices(preferred >= 0 ? preferred : 0);
  const names = named.map((option) => option.name.toLowerCase()).join(", ");
  setStatus(named.length + " routes to " + lastDestination.label + ": " + names + ". Each one shows the drive time and how much of it the fire closes before you arrive.");
}

function watchAddress(input) {
  input.addEventListener("focus", () => {
    activeInput = input;
  });
  input.addEventListener("input", () => {
    activeInput = input;
    window.clearTimeout(searchTimer);
    const query = input.value.trim();
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
  input.addEventListener("keydown", async (event) => {
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
}

watchAddress(placeInput);
watchAddress(destinationInput);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (suggestions.length) {
    await chooseSuggestion(suggestions[highlighted >= 0 ? highlighted : 0]);
    return;
  }
  const field = document.activeElement === destinationInput ? destinationInput : placeInput;
  activeInput = field;
  const query = field.value.trim();
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

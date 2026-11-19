const map = L.map('map').setView([34.05, -118.25], 11);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

let userLatLng = null;
let roadLayer = null;
let roadElements = []; // store for recoloring

const statusEl = document.getElementById('status');
const analyzeBtn = document.getElementById('analyze-btn');
const routeList = document.getElementById('route-list');

document.getElementById('locate-btn').onclick = () => {
  statusEl.textContent = 'Getting location…';
  navigator.geolocation.getCurrentPosition(
    pos => {
      userLatLng = [pos.coords.latitude, pos.coords.longitude];
      map.setView(userLatLng, 13);
      L.marker(userLatLng).addTo(map).bindPopup('You are here').openPopup();
      statusEl.textContent = 'Loading major roads from OpenStreetMap…';
      loadRoads(userLatLng);
    },
    err => {
      statusEl.textContent = 'Location permission denied. Click the map to set a point.';
      map.on('click', e => {
        userLatLng = [e.latlng.lat, e.latlng.lng];
        L.marker(userLatLng).addTo(map).bindPopup('Selected point').openPopup();
        statusEl.textContent = 'Loading major roads…';
        loadRoads(userLatLng);
        map.off('click');
      });
    }
  );
};

async function loadRoads([lat, lon]) {
  const delta = 0.18;
  const bbox = `${lat - delta},${lon - delta},${lat + delta},${lon + delta}`;
  const query = `
    [out:json][timeout:30];
    (
      way["highway"~"^(motorway|trunk|primary|secondary|motorway_link|trunk_link|primary_link)$"](${bbox});
    );
    out geom;
  `;
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: 'data=' + encodeURIComponent(query)
    });
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    roadElements = data.elements || [];
    drawRoads(roadElements);
    statusEl.textContent = `Loaded ${roadElements.length} major road segments.`;
    analyzeBtn.disabled = false;
  } catch (e) {
    statusEl.textContent = 'Could not load roads (Overpass busy or network issue). Try again in a moment.';
    console.error(e);
  }
}

function riskColor(risk) {
  if (risk === 'high' || risk === 'red') return '#dc2626';
  if (risk === 'medium' || risk === 'orange') return '#ea580c';
  if (risk === 'low' || risk === 'green') return '#16a34a';
  return '#2563eb'; // default blue
}

function drawRoads(elements, riskMap = {}) {
  if (roadLayer) map.removeLayer(roadLayer);
  const group = L.layerGroup().addTo(map);
  elements.forEach(el => {
    if (!el.geometry || el.geometry.length < 2) return;
    const coords = el.geometry.map(g => [g.lat, g.lon]);
    const name = el.tags?.name || el.tags?.ref || 'Major road';
    const risk = riskMap[el.id] || riskMap[name] || null;
    const color = riskColor(risk);
    L.polyline(coords, { color, weight: 5, opacity: 0.85 })
      .bindPopup(`<strong>${name}</strong><br>Type: ${el.tags?.highway || ''}${risk ? `<br>Risk: ${risk}` : ''}`)
      .addTo(group);
  });
  roadLayer = group;
}

document.getElementById('analyze-btn').onclick = async () => {
  if (!userLatLng) return;
  statusEl.textContent = 'Fetching analysis…';
  analyzeBtn.disabled = true;
  try {
    let result;
    try {
      const url = `http://localhost:5001/analyze?lat=${userLatLng[0]}&lon=${userLatLng[1]}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('backend down');
      result = await res.json();
    } catch {
      result = getPlaceholderResult();
      statusEl.textContent = 'Using placeholder results (backend not running).';
    }
    renderResults(result);
    if (!statusEl.textContent.includes('placeholder')) {
      statusEl.textContent = 'Analysis complete.';
    }
  } catch (e) {
    statusEl.textContent = 'Error running analysis.';
    console.error(e);
  } finally {
    analyzeBtn.disabled = false;
  }
};

function getPlaceholderResult() {
  // Demonstrates the expected format from the calculation teammate
  return {
    wind: { speed: 18, direction: 245 },
    fires: [
      { lat: userLatLng[0] + 0.05, lon: userLatLng[1] + 0.03, confidence: 'high', frp: 42 },
      { lat: userLatLng[0] - 0.02, lon: userLatLng[1] + 0.06, confidence: 'nominal', frp: 12 }
    ],
    routes: [
      { name: 'Route A (Freeway)', closes_in_hours: 3.2, range: [2, 5], risk: 'high' },
      { name: 'Route B (Highway)', closes_in_hours: 9.1, range: [7, 12], risk: 'low' },
      { name: 'Route C (Local)', closes_in_hours: 6.4, range: [4, 9], risk: 'medium' }
    ],
    road_risks: {}, // teammate can fill with { osm_id: 'high' | 'medium' | 'low' }
    note: 'Placeholder results — replace with real calculation from teammate. Planning aid only.'
  };
}

function renderResults(result) {
  const wind = result.wind || {};
  const fires = result.fires || [];
  const routes = result.routes || [];

  let html = `
    <div class="info-block">
      <strong>Current wind</strong><br>
      ${wind.speed != null ? wind.speed + ' km/h' : '—'} from ${wind.direction != null ? wind.direction + '°' : '—'}
    </div>
    <div class="info-block">
      <strong>Active fire detections</strong><br>
      ${fires.length} points
    </div>
  `;

  if (routes.length > 0) {
    html += '<h3 style="margin:1rem 0 0.5rem; font-size:1rem;">Estimated time until road at risk</h3>';
    routes.forEach(r => {
      const color = riskColor(r.risk);
      html += `
        <div class="route" style="border-left: 4px solid ${color}">
          <h3 style="margin:0 0 0.25rem; font-size:1rem;">${r.name}</h3>
          <p style="margin:0; font-weight:600;">About ${r.closes_in_hours?.toFixed(1) || '?'} h</p>
          ${r.range ? `<p style="margin:0.15rem 0 0; color:#57534e; font-size:0.9rem;">Range: ${r.range[0]}–${r.range[1]} h</p>` : ''}
          <p style="margin:0.15rem 0 0; font-size:0.85rem; color:${color}">Risk: ${r.risk || 'unknown'}</p>
        </div>
      `;
    });
  }

  if (fires.length > 0 && fires[0].lat) {
    html += '<ul style="margin-top:0.75rem; padding-left:1.2rem; font-size:0.9rem;">';
    fires.slice(0, 5).forEach(f => {
      html += `<li>${f.lat?.toFixed(3)}, ${f.lon?.toFixed(3)} · ${f.confidence || ''} · FRP ${f.frp || '—'}</li>`;
    });
    html += '</ul>';
  }

  html += `<p class="status" style="margin-top:1rem;">${result.note || ''}</p>`;
  routeList.innerHTML = html;

  // Recolor roads if risk data is provided
  if (result.road_risks && Object.keys(result.road_risks).length > 0) {
    drawRoads(roadElements, result.road_risks);
  }

  // Plot fire points
  fires.forEach(f => {
    if (f.lat && f.lon) {
      L.circleMarker([f.lat, f.lon], {
        radius: 6,
        color: '#dc2626',
        fillColor: '#f87171',
        fillOpacity: 0.8
      }).addTo(map).bindPopup(`Fire detection<br>FRP: ${f.frp || '?'}`);
    }
  });
}

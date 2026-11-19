# Local prototype: Which evacuation road closes first

This is a runnable starter that:
- Asks for your location
- Loads real major roads from OpenStreetMap (Overpass)
- Has a simple Python backend that pulls wind (Open-Meteo) and fire detections (FIRMS)
- Is ready to display calculation results from the other teammate

## Expected result format (for the calculation teammate)

The frontend looks for this JSON shape from the backend (or any future endpoint):

```json
{
  "wind": { "speed": 18, "direction": 245 },
  "fires": [{ "lat": 34.1, "lon": -118.2, "confidence": "high", "frp": 42 }],
  "routes": [
    { "name": "Route A", "closes_in_hours": 3.2, "range": [2, 5], "risk": "high" },
    { "name": "Route B", "closes_in_hours": 9.1, "range": [7, 12], "risk": "low" }
  ],
  "road_risks": { "12345678": "high", "87654321": "medium" },
  "note": "Planning aid only — not an evacuation order."
}
```

- `routes` → shown in the sidebar with time + range + risk color
- `road_risks` → optional map of OSM way id → "high"/"medium"/"low" to recolor the roads
- If the backend is not running, the UI falls back to placeholder data so the interface can still be demoed

## Run it locally

1. Get a free FIRMS MAP_KEY: https://firms.modaps.eosdis.nasa.gov/api/map_key/
2. Install backend dependencies:
   ```bash
   pip install -r backend/requirements.txt
   ```
3. Start the backend (set the key first):
   ```bash
   export FIRMS_KEY=your_key_here
   python backend/server.py
   ```
4. Serve the frontend:
   ```bash
   python -m http.server 8000 --directory public
   ```
   Then open http://localhost:8000

Planning aid only — not an evacuation order.

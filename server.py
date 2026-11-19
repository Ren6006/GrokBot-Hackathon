#!/usr/bin/env python3
"""
Simple local backend for the evacuation road prototype.
Run with: python server.py
Then open the frontend (serve public/ or open index.html and allow localhost).

Requires: pip install flask flask-cors requests
"""

import os
import csv
import io
from flask import Flask, request, jsonify
from flask_cors import CORS
import requests

app = Flask(__name__)
CORS(app)  # allow the frontend to call this from the browser

# Get a free key at https://firms.modaps.eosdis.nasa.gov/api/map_key/
FIRMS_KEY = os.environ.get("FIRMS_KEY", "YOUR_MAP_KEY_HERE")

@app.route("/analyze")
def analyze():
    lat = request.args.get("lat", type=float)
    lon = request.args.get("lon", type=float)
    if lat is None or lon is None:
        return jsonify({"error": "lat and lon required"}), 400

    delta = 0.5
    bbox = f"{lon - delta},{lat - delta},{lon + delta},{lat + delta}"

    try:
        # Wind (Open-Meteo, no key)
        wind_url = (
            "https://api.open-meteo.com/v1/forecast"
            f"?latitude={lat}&longitude={lon}"
            "&current=wind_speed_10m,wind_direction_10m"
            "&wind_speed_unit=kmh"
        )
        wind_resp = requests.get(wind_url, timeout=15)
        wind_resp.raise_for_status()
        wind_data = wind_resp.json()
        current = wind_data.get("current", {})
        wind = {
            "speed": current.get("wind_speed_10m"),
            "direction": current.get("wind_direction_10m"),
        }

        # FIRMS detections
        fires = []
        if FIRMS_KEY and FIRMS_KEY != "YOUR_MAP_KEY_HERE":
            firms_url = (
                f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/"
                f"{FIRMS_KEY}/VIIRS_NOAA20_NRT/{bbox}/1"
            )
            firms_resp = requests.get(firms_url, timeout=20)
            if firms_resp.ok:
                fires = parse_firms(firms_resp.text)
        else:
            fires = [{"note": "Set FIRMS_KEY environment variable to fetch real detections"}]

        return jsonify({
            "wind": wind,
            "fires": fires,
            "routes": [
                {"name": "Route A (example)", "closes_in_hours": None, "range": None, "risk": "unknown"},
                {"name": "Route B (example)", "closes_in_hours": None, "range": None, "risk": "unknown"}
            ],
            "road_risks": {},
            "note": "Planning aid only — not an evacuation order. Replace routes/road_risks with real calculation results.",
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

def parse_firms(csv_text: str):
    reader = csv.DictReader(io.StringIO(csv_text.strip()))
    out = []
    for row in reader:
        try:
            lat = float(row.get("latitude") or row.get("Latitude") or 0)
            lon = float(row.get("longitude") or row.get("Longitude") or 0)
            if lat and lon:
                out.append({
                    "lat": lat,
                    "lon": lon,
                    "confidence": row.get("confidence") or row.get("Confidence"),
                    "frp": row.get("frp") or row.get("FRP"),
                    "acq_date": row.get("acq_date") or row.get("acq_date"),
                })
        except (ValueError, TypeError):
            continue
    return out

if __name__ == "__main__":
    print("Starting local backend on http://localhost:5001")
    print("Get a free FIRMS MAP_KEY and set FIRMS_KEY=... before running for real fire data.")
    app.run(host="0.0.0.0", port=5001, debug=True)

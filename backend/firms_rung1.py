# Rung 1: Pull live FIRMS detections
# What it does: Fetches last 2 days of VIIRS fire detections for the Bay Area box from NASA FIRMS.
# Drops low-confidence points. Groups by satellite pass. Prints counts.
# Handles API errors, empty results, bad values. Falls back to cached data labeled "stale".
# Inputs: FIRMS_KEY from .env, bounding box.
# Outputs: Printed counts, and cache/firms_latest.json with status (live/stale/empty).

import os
import json
import csv
import requests
from datetime import datetime, timezone
from collections import defaultdict
from pathlib import Path

# Load .env if present (simple parser so we don't need extra packages)
def load_env():
    env_path = Path(__file__).parent.parent / ".env"
    if env_path.exists():
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, val = line.split("=", 1)
                    os.environ[key.strip()] = val.strip().strip('"').strip("'")

load_env()

FIRMS_KEY = os.environ.get("FIRMS_KEY")
if not FIRMS_KEY:
    print("ERROR: FIRMS_KEY not found. Create a .env file with FIRMS_KEY=your_key")
    exit(1)

# Bay Area bounding box: west,south,east,north
BBOX = "-123.0,37.0,-121.5,38.5"
DAY_RANGE = 2
SOURCES = ["VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT"]

CACHE_DIR = Path(__file__).parent.parent / "cache"
CACHE_DIR.mkdir(exist_ok=True)
CACHE_FILE = CACHE_DIR / "firms_latest.json"

def fetch_source(source):
    url = f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{FIRMS_KEY}/{source}/{BBOX}/{DAY_RANGE}"
    try:
        resp = requests.get(url, timeout=30)
        resp.raise_for_status()
        text = resp.text.strip()
        if not text or "error" in text.lower() or text.startswith("<"):
            return None, f"Bad response from {source}: {text[:100]}"
        return text, None
    except Exception as e:
        return None, str(e)

def parse_and_filter(csv_text, source):
    detections = []
    reader = csv.DictReader(csv_text.splitlines())
    for row in reader:
        try:
            conf = row.get("confidence", "").lower()
            if conf == "low":
                continue
            lat = float(row["latitude"])
            lon = float(row["longitude"])
            if not (37.0 <= lat <= 38.5 and -123.0 <= lon <= -121.5):
                continue
            detections.append({
                "lat": lat,
                "lon": lon,
                "acq_date": row.get("acq_date"),
                "acq_time": row.get("acq_time"),
                "satellite": row.get("satellite", source),
                "confidence": conf,
                "frp": float(row.get("frp", 0) or 0),
                "source": source
            })
        except (ValueError, KeyError):
            continue
    return detections

def group_by_pass(detections):
    passes = defaultdict(list)
    for d in detections:
        try:
            hour = int(d["acq_time"]) // 100
            key = f"{d['satellite']}_{d['acq_date']}_{hour:02d}"
            passes[key].append(d)
        except:
            continue
    return passes

def main():
    print("=== Evacuation Route Watch - Rung 1: FIRMS check ===")
    print(f"Bounding box: {BBOX} (Bay Area)")
    print(f"Last {DAY_RANGE} days, dropping low-confidence points\n")

    all_detections = []
    errors = []

    for source in SOURCES:
        print(f"Fetching {source}...")
        csv_text, err = fetch_source(source)
        if err:
            errors.append(f"{source}: {err}")
            print(f"  Failed: {err}")
            continue
        dets = parse_and_filter(csv_text, source)
        print(f"  Got {len(dets)} high/nominal confidence detections")
        all_detections.extend(dets)

    status = "live"
    data_age_minutes = 0

    if not all_detections and errors:
        if CACHE_FILE.exists():
            print("\nAPI failed. Using cached data (STALE)")
            with open(CACHE_FILE) as f:
                cached = json.load(f)
            all_detections = cached.get("detections", [])
            status = "stale"
            try:
                ts = datetime.fromisoformat(cached.get("fetched_at", "").replace("Z", "+00:00"))
                data_age_minutes = int((datetime.now(timezone.utc) - ts).total_seconds() / 60)
            except:
                data_age_minutes = 999
        else:
            print("\nNo live data and no cache. Empty result.")
            status = "empty"
    elif not all_detections:
        print("\nNo fire detections found (quiet day or no high-confidence points).")
        status = "empty"
    else:
        payload = {
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "status": "live",
            "bbox": BBOX,
            "detections": all_detections,
            "count": len(all_detections)
        }
        with open(CACHE_FILE, "w") as f:
            json.dump(payload, f, indent=2)
        print(f"\nSaved {len(all_detections)} detections to cache.")

    if status == "empty":
        print("\nRESULT: No active fires detected in the box.")
        print("The app should show: 'No active fires detected. Planning aid, not an evacuation order.'")
        return

    passes = group_by_pass(all_detections)
    print(f"\nGrouped into {len(passes)} satellite passes:")
    for pass_id, points in sorted(passes.items()):
        print(f"  {pass_id}: {len(points)} points")

    print(f"\nTotal high/nominal detections: {len(all_detections)}")
    print(f"Status: {status.upper()}" + (f" (data age ~{data_age_minutes} min)" if status == "stale" else ""))
    print("Always label output: Planning aid, not an evacuation order")

if __name__ == "__main__":
    main()

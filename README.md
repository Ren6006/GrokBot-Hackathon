# Which evacuation road closes first

A planning aid that compares evacuation routes and estimates which one a nearby fire would reach first.

**Planning aid, not an evacuation order.**

Search a street address. Optionally set “Simulate this time” to treat a past date and time as now; fire detections then come from the FIRMS archive and the wind from the historical forecast. The map marks a road red when the fire would reach it before you could drive past it, assuming you wait 30 minutes before leaving. Fire detections come from VIIRS, wind and slope from Open-Meteo, and roads from OpenStreetMap. Fuel is treated as uniform. This is not a Rothermel model.

## Run locally

Install the function once:

```bash
npm install --prefix functions
```

Then start Hosting and Functions:

```bash
npx -y firebase-tools@latest emulators:start --only hosting,functions --project demo-road-closes
```

Open [http://127.0.0.1:5002](http://127.0.0.1:5002).

The Hosting emulator is pinned to port 5002 because macOS AirPlay Receiver often listens on 5000. The demo project id lets the emulator run without a Firebase account. The page calls `/api/firms` on that same origin, and Hosting forwards it to the function.

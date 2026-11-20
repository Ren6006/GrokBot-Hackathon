# Which evacuation road closes first

A planning aid for people in fire-prone areas, and for the sheriffs who plan evacuations. A map of where the fire is now does not say which way out stays open long enough to drive. This site estimates that.

**Planning aid, not an evacuation order.**

## What you can do

1. Type a street address the way you would in Google Maps, for example `2400 Durant Ave` or `15300 Sunset Blvd, Pacific Palisades`. Suggestions appear as you type. You can also use **Use my location**.
2. Optionally set **Simulate this time**. Leave it empty for the live feed. Set it to a past date and time and the site pretends that moment is now. This is how the Palisades fire can be shown at a hackathon: `January 8, 2025, 2:00 PM` at a Pacific Palisades address marks roads the fire would have cut off.
3. The map draws OpenStreetMap roads and VIIRS heat detections. A road turns **red** when the fire would reach it before you could drive past it, if you waited 30 minutes to start driving. Roads that stay **blue** are still reachable on that head start.

Checked examples:

- `2400 Durant Avenue, Berkeley` on the live feed: detections were far enough, or spreading slowly enough, that the nearby roads stayed blue.
- `15300 Sunset Boulevard, Pacific Palisades` at January 8, 2025, 2:00 PM: the archive showed the fire along the coast, and 234 road stretches turned red.

## How a road turns red

For each road segment the site estimates two times, both in hours from the moment you treat as now:

- **Fire arrival.** Satellite passes are grouped into perimeters. The distance the perimeter moved between passes is the observed spread rate. That rate is adjusted by wind direction and speed, and by terrain slope. The time for the fire to reach a spot is a shortest-path search across a grid, where the cost of a cell is distance divided by the spread rate in that direction.
- **Drive time.** The road graph is searched from the address. Speed comes from the OpenStreetMap `maxspeed` tag when it exists, otherwise from the road class (about 105 km/h on a motorway down to about 40 km/h on a tertiary road). The walk from the address to the nearest mapped road is added at 15 km/h.

A segment is red when:

`drive time + 30 minutes > fire arrival time`

The 30 minutes is the leeway for getting in the car. If the last satellite pass was earlier than the simulated clock, the fire is credited with the hours it has already had to move. If you do not set a time, arrival is measured from the latest pass, which is the live behavior.

VIIRS pixels are 375 m, so perimeters are coarse. Low-confidence detections are dropped. Fuel is treated as uniform. This is a wind-and-slope adjustment, not a Rothermel model, and LANDFIRE fuel models are not used.

## Data

| Need | Source | When |
| --- | --- | --- |
| Address suggestions and reverse geocoding | Photon (OpenStreetMap), proxied by the function because the browser cannot call it directly | Always |
| Fire detections, live | Public VIIRS CSVs for NOAA-20 and NOAA-21. The US and Hawaii use the 7-day files. Everywhere else uses the 24-hour global files. | Simulate time is empty |
| Fire detections, past | FIRMS area API, standard-processing VIIRS (Suomi-NPP, NOAA-20, NOAA-21) when the date is in the archive, near-real-time products when it is newer. Five days ending on the chosen date. Detections after that clock time are ignored. | Simulate time is set |
| Wind | Open-Meteo forecast for now. Open-Meteo historical forecast for a past hour. | Depends on the clock |
| Slope | Open-Meteo elevation, a 10 by 10 sample around the address | Always |
| Roads | OpenStreetMap via the French Overpass server: motorways, trunks, primary, and secondary roads within 10 km, plus tertiary roads within 3.5 km | Always, and it is today's network even when the clock is set to 2025 |

The FIRMS map key lives only in `functions/.env` as `FIRMS_MAP_KEY`. That file is gitignored and is not sent to the browser. Without a key, a past date cannot be loaded. The public 24-hour and 7-day files do not contain the Palisades fire.

## How the site is built

Classic Firebase Hosting serves the static page. A Firebase function on the same origin fetches the data the browser is not allowed to request.

- `public/index.html`, `public/styles.css`, `public/app.js` are the page: address box, time control, Leaflet map, and the calls to `/api/address`, `/api/reverse`, and `/api/firms`.
- `public/model.js` is the spread model and the red-road test. It has no network calls.
- `functions/index.js` proxies Photon and FIRMS. Live fires use the public CSVs. A simulated time uses the FIRMS archive.
- `firebase.json` points Hosting at `public`, rewrites `/api/firms`, `/api/address`, and `/api/reverse` to those functions, and pins the Hosting emulator to port 5002.

There is no Firebase project yet. The emulator runs as the demo project `demo-road-closes`, so it does not need a Firebase login. Nothing has been deployed.

## What this does not do

- It does not issue an evacuation order.
- It does not run a Rothermel model or read LANDFIRE fuel.
- It does not show an ensemble on the map. An earlier version varied wind by ±20% and spread rate by ±30% and printed a range for two named routes. The map uses the central wind and the central spread rate, then a yes-or-no red.
- It does not rebuild the road network as it was in January 2025. Roads are current OpenStreetMap.
- It does not draw every residential street. A dense city would be tens of thousands of segments.

## Run locally

Install the function once:

```bash
npm install --prefix functions
```

Start Hosting and Functions:

```bash
npx -y firebase-tools@latest emulators:start --only hosting,functions --project demo-road-closes
```

Open [http://127.0.0.1:5002](http://127.0.0.1:5002).

Port 5002 is pinned because macOS AirPlay Receiver often listens on 5000. If that command says the port is taken, an emulator is already running. Use the page that is up, or stop the old process before starting another.

## How it was built

The work was done in small steps, and each one was usable before the next.

1. A static page on the Firebase Hosting emulator: the title, the planning-aid label, and empty Route A and Route B cards. No cloud project.
2. A town search that loaded live VIIRS detections, wind, slope, and roads, then printed which named exit closed first, with a time range from the wind and spread ensemble.
3. A street-address box with suggestions, a map, and red roads instead of the route cards. Red means the fire beats a drive that starts after a 30-minute wait.
4. A date and time control. The first attempt stopped, because the live FIRMS files cannot see January 2025. After a FIRMS map key was added on the server, the archive and the historical wind forecast made a simulated clock work. The Palisades check above is the result.

# Which Evacuation Road Closes First

**Planning aid, not an evacuation order.**

When a wildfire is approaching, a map showing the current location of the fire does not answer the critical question: which evacuation routes will remain open long enough to use?

This project addresses that gap. Users enter a street address (or use their current location), and the system estimates which roads are likely to be threatened first. It is designed for residents in fire-prone areas and for sheriffs and emergency planners responsible for evacuation decisions.

## Inspiration

The project was inspired by Darren Yilmaz’s experience during the Palisades fire. He sheltered friends who had been displaced and witnessed the trauma and disruption the fire caused in the surrounding community. This made clear that a conventional fire map is insufficient; people need information about which roads are likely to stay open. Angela Zhao, Ryan Tung, and Mackenzie Tam joined to develop a practical tool based on that need.

## What It Does

The application combines live or historical satellite fire detections, wind data, terrain slope, and OpenStreetMap road networks. For a given address, it calculates an estimated fire arrival time and compares it to the drive time required to exit, including a 30-minute head start for the driver to depart.

- Roads marked **red** are those the fire is projected to reach before a driver waiting 30 minutes could pass.
- Roads marked **blue** remain reachable under the same conditions.

Users may also specify a past date and time to simulate historical conditions, such as the Palisades fire on January 8, 2025.

## How We Built It (Tech Stack)

- **Frontend**: Leaflet map with vanilla JavaScript, HTML, and CSS, served by Firebase Hosting.
- **Backend**: Firebase Functions that proxy Photon (address geocoding) and NASA FIRMS (fire detections).
- **Data sources**:
  - NASA FIRMS VIIRS (NOAA-20, NOAA-21, and Suomi-NPP) for live and archived fire detections
  - Open-Meteo for wind and elevation/slope
  - OpenStreetMap via the Overpass API for road networks
- **Model**: Observed fire spread rate is derived from movement between successive satellite passes and adjusted for wind direction, wind speed, and terrain slope. Drive time is computed on the road graph using OpenStreetMap speed tags or road-class defaults.
- **Development approach**: Incremental, independently testable steps. The full application runs locally via the Firebase emulator without requiring a cloud project.

## Challenges We Ran Into

The team had a little under two hours. The primary challenge was coordination under that time constraint. With four contributors editing a shared repository simultaneously, continuous alignment was required on file ownership and feature boundaries to avoid conflicting changes. Merging updates, maintaining a clear shared data contract, and ensuring everyone could run the latest version consumed more time than implementation.

Additional technical challenges included:

- FIRMS API rate limits and authentication requirements
- Overpass timeouts when querying large geographic areas
- The absence of historical events (such as the Palisades fire) in public near-real-time FIRMS files, necessitating a map key and the archive API for simulation

## Accomplishments

- Implemented a live and historical fire detection pipeline that filters low-confidence detections and groups them by satellite pass.
- Developed road scoring that incorporates distance to fire, downwind orientation, and a 30-minute driver head start.
- Created a functional simulation mode capable of reproducing Palisades fire conditions (234 road segments marked red for a Pacific Palisades address on January 8, 2025, at 2:00 PM).
- Established a self-contained local emulator setup so the complete stack can be run without a Firebase project.
- Included clear labeling (“Planning aid, not an evacuation order”) and data-age information on all results.

## What We Learned

Under a tight deadline and with multiple contributors in a single codebase, explicit role division and frequent communication are as important as the technical work. The project also highlighted the practical limitations of public Earth-observation APIs, including rate limits, incomplete historical coverage in near-real-time feeds, and the necessity of robust fallbacks. Building in small, independently testable increments allowed progress to continue even when individual components were blocked.

## What's Next

- Deploy the application to Firebase Hosting to provide a public URL.
- Add multiple route options (safest, fastest, and balanced) so users can compare alternatives.
- Refine the observed spread-rate calculation using additional satellite passes and alpha-shape perimeters.
- Improve messaging for empty results or unavailable data feeds.
- Display uncertainty ranges on the map by varying wind (±20%) and spread rate (±30%).

## How Grok Bot Helped Build It

Grok Bot served as an additional collaborator throughout development. It was used to:

- Draft the initial FIRMS data ingestion, road-scoring logic, and error-handling patterns
- Generate and refine the Leaflet map and demonstration pages
- Produce and revise this README
- Assist with debugging API interactions, resolving git conflicts, and configuring the Firebase emulator

This enabled four team members to work in parallel without being delayed by syntax or API details. The full session export is included in the repository.

## How to Run It

Install function dependencies once:

```bash
npm install --prefix functions
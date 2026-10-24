# 🚗 PulseNav — Live GPS Navigation & Convoy Web App

A high-performance, responsive navigation web application inspired by **Waze** and **Google Maps**. Built with pure vanilla HTML5, CSS3, and JavaScript, leveraging **Leaflet**, **OpenStreetMap**, **OSRM**, and **Supabase Realtime**.

---

## ✨ Features

### 📍 Turn-by-Turn GPS Navigation
* **3D Driving Perspective & Vehicle Arrow**: Waze-style cyan navigation chevron with smooth heading tracking along the route.
* **High-Precision Map Matching (Snap-to-Road)**: Snaps noisy raw GPS fixes dead-center to the road polyline, eliminating multipath drift into buildings and parking lots.
* **Stationary Position Anchor**: Prevents marker wandering and spinning when stopped at red lights or parked.
* **Instant Routing Engine**: Blends OSRM global routing with local road graph analysis (A* / Dijkstra) for sub-350ms route calculation and smart rerouting.
* **Voice Navigation**: Spoken maneuvers and junction alerts with an interactive slip volume slider and mute controls.

### 🏎️ Automotive-Grade Speedometer
* **Doppler Carrier Speed**: Prioritizes direct GNSS Doppler measurements (`coords.speed`) from hardware chips.
* **Zero-Velocity Deadband**: Eliminates phantom 1–2 km/h creep when stationary.
* **Adaptive Low-Pass Filter**: Responsive during braking and acceleration, stable during steady cruising.
* **60 FPS Smooth Interpolation**: Smooth visual transitions between 1Hz GPS updates.
* **Road Speed Limits & Warnings**: Displays active roadway speed limits with pulsing visual alerts when exceeding the limit.

### 👥 Live Convoy Mode (Supabase Realtime)
* **Real-Time Fleet Tracking**: Share a 6-character convoy code to track fellow drivers on the live map.
* **Role Management**: Dynamic Leader and Follower badges with synchronized convoy destinations.
* **1-Tap Convoy Pings**: Quick driver communication broadcast:
  - 🛑 *Pull Over*
  - ⛽ *Fuel / Rest Stop*
  - ⏳ *Wait Up*
  - ⚠️ *Hazard Ahead*

### ⚠️ Community Hazard & Incident Reporting
* User-reported incidents with real-time map pins:
  - 🚗 Heavy Traffic (Slow, Moderate, Gridlock)
  - 👮 Police / Speed Traps (Visible, Hidden, Speed Camera)
  - ⚠️ Road Hazards (Pothole, Object on Road, Stopped Car)
  - 🚧 Construction & Work Zones
  - ⛔ Road Closures
* Upvoting / confirmation system with auto-expiring incident lifespans.

### 🎨 Clean UI & Day / Night Themes
* Dynamic top controls that automatically glide below road banners and convoy status bars.
* High-contrast night theme and daylight theme optimized for dashboard glare reduction.

---

## 🚀 Getting Started

PulseNav requires no build steps, bundlers, or heavy frameworks.

### Running Locally
1. Clone or download the repository.
2. Open `index.html` directly in any modern browser (Chrome, Edge, Safari, Firefox).
3. Alternatively, serve via any local web server:
   ```bash
   # Using Python
   python -m http.server 8000

   # Or using Node.js npx
   npx serve .
   ```
4. Allow browser location permissions when prompted to enable live GPS navigation.

---

## 🗄️ Optional: Supabase Realtime Setup

For live multi-device Convoy tracking across different networks:
1. Create a free project on [Supabase](https://supabase.com).
2. Run the SQL schema found in [`supabase_schema.sql`](./supabase_schema.sql) in the Supabase SQL Editor.
3. Update `SUPABASE_CONFIG` in `app.js` with your project URL and public Anon key:
   ```javascript
   const SUPABASE_CONFIG = {
     url: 'YOUR_SUPABASE_URL',
     anonKey: 'YOUR_SUPABASE_ANON_KEY'
   };
   ```

---

## 🛠️ Tech Stack
* **Frontend**: HTML5, Vanilla JavaScript (ES2022), Tailwind CSS CDN, CSS Glassmorphism
* **Mapping**: Leaflet.js, OpenStreetMap Carto / Humanitarian tiles
* **Routing**: OSRM (Open Source Routing Machine) API + Custom Local Graph A* Solver
* **Backend**: Supabase Realtime (WebSockets & Postgres CDC)
* **Audio**: Web Speech Synthesis API

---

## 📄 License
MIT License. Free for personal and community use.


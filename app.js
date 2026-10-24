/**
 * PulseNav — Live GPS Navigation & Community Traffic Reporting App
 * 100% Live Version (Browser Geolocation API + OpenStreetMap Nominatim + OSRM Routing)
 */

(() => {
  'use strict';

  // ==========================================
  // 1. CONFIGURATION & CONSTANTS
  // ==========================================
  const STORAGE_KEY_REPORTS = 'pulsenav_live_reports_v2';
  const STORAGE_KEY_UPVOTES = 'pulsenav_upvoted_ids_v2';
  const STORAGE_KEY_THEME = 'pulsenav_theme_v1';
  const STORAGE_KEY_LAST_GPS = 'pulsenav_last_gps_v1';
  const STORAGE_KEY_VOICE_VOL = 'pulsenav_voice_vol_v1';

  // Clean up legacy demo storage key if present
  try {
    localStorage.removeItem('pulsenav_community_reports_v1');
  } catch (e) {
    // Ignore storage errors
  }

  // Fallback initial map center before browser GPS lock (or last known real GPS)
  const INITIAL_COORDS = (() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY_LAST_GPS) || 'null');
      if (saved && typeof saved.lat === 'number' && typeof saved.lng === 'number') {
        return saved;
      }
    } catch (e) {
      // Ignore
    }
    return { lat: 3.0333, lng: 101.5333 };
  })();

  // OpenStreetMap Tile Layer URLs (Primary Humanitarian/OSM France + Standard mirrors)
  const OSM_TILE_URLS = [
    'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
    'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
  ];

  // Report Categories & Subtypes / Severities
  const REPORT_CATEGORIES = {
    traffic: {
      id: 'traffic',
      label: 'Heavy Traffic',
      icon: '🚗',
      color: '#f59e0b',
      ringColor: 'rgba(245, 158, 11, 0.5)',
      badgeBg: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
      subtypes: [
        { id: 'Slow', label: 'Slow Traffic', desc: 'Moving slowly', ttlMin: 30 },
        { id: 'Moderate', label: 'Moderate Jam', desc: 'Stop & go traffic', ttlMin: 45 },
        { id: 'Gridlock', label: 'Standstill Gridlock', desc: 'Complete bumper-to-bumper', ttlMin: 60 }
      ]
    },
    accident: {
      id: 'accident',
      label: 'Accident',
      icon: '⚠️',
      color: '#ef4444',
      ringColor: 'rgba(239, 68, 68, 0.55)',
      badgeBg: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
      subtypes: [
        { id: 'Minor', label: 'Minor Collision', desc: 'Shoulder partially blocked', ttlMin: 45 },
        { id: 'Major', label: 'Major Collision', desc: 'Multiple lanes blocked', ttlMin: 60 },
        { id: 'Opposite Lane', label: 'Opposite Side', desc: 'Opposite lane incident', ttlMin: 35 }
      ]
    },
    police: {
      id: 'police',
      label: 'Police / Speed Trap',
      icon: '🚓',
      color: '#3b82f6',
      ringColor: 'rgba(59, 130, 246, 0.5)',
      badgeBg: 'bg-blue-500/20 text-blue-300 border-blue-500/40',
      subtypes: [
        { id: 'Visible', label: 'Visible Patrol', desc: 'Cruiser on roadside', ttlMin: 35 },
        { id: 'Hidden', label: 'Hidden Speed Trap', desc: 'Radar enforcement ahead', ttlMin: 45 },
        { id: 'Camera', label: 'Speed / Red Light Cam', desc: 'Automated enforcement', ttlMin: 60 }
      ]
    },
    hazard: {
      id: 'hazard',
      label: 'Road Hazard',
      icon: '🚧',
      color: '#f97316',
      ringColor: 'rgba(249, 115, 22, 0.5)',
      badgeBg: 'bg-orange-500/20 text-orange-300 border-orange-500/40',
      subtypes: [
        { id: 'Pothole', label: 'Deep Pothole', desc: 'Watch tires in lane', ttlMin: 60 },
        { id: 'Construction', label: 'Construction Zone', desc: 'Lane merge & roadwork', ttlMin: 60 },
        { id: 'Debris', label: 'Object on Road', desc: 'Debris / stalled vehicle', ttlMin: 35 }
      ]
    }
  };

  // ==========================================
  // 2. APPLICATION STATE
  // ==========================================
  const state = {
    map: null,
    tileLayer: null,
    theme: localStorage.getItem(STORAGE_KEY_THEME) || 'dark',
    voiceVolume: (() => {
      try {
        const saved = localStorage.getItem(STORAGE_KEY_VOICE_VOL);
        if (saved !== null) {
          const parsed = parseFloat(saved);
          if (!isNaN(parsed)) return Math.max(0, Math.min(1, parsed));
        }
      } catch (e) {
        // Ignore
      }
      return 1.0;
    })(),
    lastUnmutedVolume: 1.0,
    voiceEnabled: true,

    // Live GPS & Location
    userPos: { ...INITIAL_COORDS },
    rawGpsPos: { ...INITIAL_COORDS },
    lastGpsFixTime: 0,
    userHeading: 0,
    currentSpeedKmh: 0,
    gpsAccuracyM: null,
    hasLiveGpsLock: false,
    currentStreetName: '',
    followUser: true,
    geoWatchId: null,
    userMarker: null,
    accuracyCircle: null,
    stationaryAnchor: null,
    lastFilteredPos: null,
    currentRouteVertexIdx: 0,

    // Destinations & Live OSRM + Graph Theory (A* & Dijkstra) Routing
    routingRequestId: 0,
    localOsmWaysCache: new Map(), // spatialKey -> raw OSM ways for instant local routing
    selectedDestination: null,
    destMarker: null,
    rawOsrmRoutes: [],
    roadGraph: null, // Weighted Directed Road Graph G = (V, E, W)
    graphTelemetry: null, // { vertexCount, edgeCount, hazardEdgeCount, aStar, dijkstra }
    showGraphOverlay: false,
    graphOverlayLayers: [],
    routes: [], // [{ coords, distanceM, durationS, steps, summary, algorithmTag, hazardPenaltyS }]
    selectedRouteIdx: 0,
    routePolylines: [],
    isRerouting: false,

    // Active Live Turn-by-Turn Navigation
    isNavigating: false,
    currentStepIdx: 0,
    announcedStepIndices: new Set(),
    announcedHazardIds: new Set(),
    activeToastHazardId: null,

    // Community Reports (User-submitted only)
    reports: [],
    upvotedIds: new Set(),
    reportMarkers: new Map(), // id -> L.marker
    feedFilter: 'all',

    // Reporting Modal & Map Placement
    modalCategory: 'traffic',
    modalSubtype: 'Moderate',
    pendingMapPlacement: null, // { category, subtype, note, durationMin }

    // Live Convoy & Supabase Database/Realtime State
    supabase: null,
    reportsChannel: null,
    convoy: {
      driverId: '',
      driverName: '',
      driverColor: '#38bdf8',
      activeCode: null,
      role: null, // 'leader' | 'member'
      leaderId: null,
      leaderName: '',
      status: 'idle',
      sharedDestKey: '',
      lastPingId: '',
      members: new Map(), // memberId -> member telemetry object
      memberMarkers: new Map(), // memberId -> L.marker
      realtimeChannel: null,
      heartbeatTimer: null,
      broadcastChannel: null,
      lastTelemetrySentAt: 0,
      lastDbTelemetrySavedAt: 0
    }
  };

  // ==========================================
  // 3. UTILITY & GEOMETRY FUNCTIONS
  // ==========================================

  /** Calculate Haversine distance in meters between two lat/lng points */
  function getDistanceMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /** Calculate compass bearing (0-360 degrees) from point 1 to point 2 */
  function getBearing(lat1, lng1, lat2, lng2) {
    const toRad = (d) => (d * Math.PI) / 180;
    const toDeg = (r) => (r * 180) / Math.PI;
    const dLng = toRad(lng2 - lng1);
    const y = Math.sin(dLng) * Math.cos(toRad(lat2));
    const x =
      Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
      Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  /**
   * Projects point P(pLat, pLng) perpendicular onto road segment A(aLat, aLng) -> B(bLat, bLng).
   * Returns { lat, lng, distM, bearing, t }
   */
  function projectPointOnSegment(pLat, pLng, aLat, aLng, bLat, bLng) {
    const midLatRad = ((aLat + bLat) / 2) * (Math.PI / 180);
    const cosMid = Math.cos(midLatRad);
    const DEG_TO_M = 111319.49;

    const Bx = (bLng - aLng) * cosMid * DEG_TO_M;
    const By = (bLat - aLat) * DEG_TO_M;
    const Px = (pLng - aLng) * cosMid * DEG_TO_M;
    const Py = (pLat - aLat) * DEG_TO_M;

    const lenSq = Bx * Bx + By * By;
    let t = 0;
    if (lenSq > 0.0001) {
      t = (Px * Bx + Py * By) / lenSq;
      t = Math.max(0, Math.min(1, t));
    }

    const projLat = aLat + t * (bLat - aLat);
    const projLng = aLng + t * (bLng - aLng);
    const distM = getDistanceMeters(pLat, pLng, projLat, projLng);
    const bearing = getBearing(aLat, aLng, bLat, bLng);

    return { lat: projLat, lng: projLng, distM, bearing, t };
  }

  /**
   * Map Matching: Snaps raw GPS coordinates onto the active navigation route polyline.
   * If within SNAP_THRESHOLD_M (38m), locks vehicle position dead-center to the road.
   */
  function snapToActiveRoute(rawLat, rawLng) {
    const route = state.routes[state.selectedRouteIdx];
    if (!route || !route.coords || route.coords.length < 2) {
      return {
        snapped: false,
        lat: rawLat,
        lng: rawLng,
        bearing: state.userHeading,
        distanceToRouteM: 0,
        closestVertexIdx: 0
      };
    }

    const coords = route.coords;
    let bestProj = null;
    let minPerpDist = Infinity;
    let bestSegmentIdx = 0;

    // Search localized window around current route vertex progress
    const maxIdx = coords.length - 1;
    const curIdx = state.currentRouteVertexIdx || 0;
    const startIdx = Math.max(0, curIdx - 4);
    const endIdx = Math.min(maxIdx, curIdx + 30);

    for (let i = startIdx; i < endIdx; i++) {
      const a = coords[i];
      const b = coords[i + 1];
      const proj = projectPointOnSegment(rawLat, rawLng, a[0], a[1], b[0], b[1]);
      if (proj.distM < minPerpDist) {
        minPerpDist = proj.distM;
        bestProj = proj;
        bestSegmentIdx = i;
      }
    }

    // If local window didn't find segment within 40m, search entire route
    if (minPerpDist > 40 && coords.length < 800) {
      for (let i = 0; i < maxIdx; i++) {
        if (i >= startIdx && i < endIdx) continue;
        const a = coords[i];
        const b = coords[i + 1];
        const proj = projectPointOnSegment(rawLat, rawLng, a[0], a[1], b[0], b[1]);
        if (proj.distM < minPerpDist) {
          minPerpDist = proj.distM;
          bestProj = proj;
          bestSegmentIdx = i;
        }
      }
    }

    const SNAP_THRESHOLD_M = 38;
    if (bestProj && minPerpDist <= SNAP_THRESHOLD_M) {
      state.currentRouteVertexIdx = bestSegmentIdx;
      return {
        snapped: true,
        lat: bestProj.lat,
        lng: bestProj.lng,
        bearing: bestProj.bearing,
        distanceToRouteM: minPerpDist,
        closestVertexIdx: bestSegmentIdx
      };
    }

    return {
      snapped: false,
      lat: rawLat,
      lng: rawLng,
      bearing: state.userHeading,
      distanceToRouteM: minPerpDist,
      closestVertexIdx: bestSegmentIdx
    };
  }

  /** Format meters into human-readable '350 m' or '2.4 km' */
  function formatDistance(meters) {
    if (meters < 1000) {
      return `${Math.max(5, Math.round(meters / 5) * 5)} m`;
    }
    return `${(meters / 1000).toFixed(1)} km`;
  }

  /** Format seconds into '14 min' or '1 hr 12 min' */
  function formatDuration(seconds) {
    const mins = Math.max(1, Math.round(seconds / 60));
    if (mins < 60) return `${mins} min`;
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem > 0 ? `${hrs} hr ${rem} min` : `${hrs} hr`;
  }

  /** Compute arrival clock time string (HH:MM) given seconds from now */
  function formatETA(secondsFromNow) {
    const arrival = new Date(Date.now() + secondsFromNow * 1000);
    return arrival.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  /** Format relative time ("Just now", "6m ago") */
  function formatTimeAgo(timestampMs) {
    const diffSec = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
    if (diffSec < 45) return 'Just now';
    const mins = Math.floor(diffSec / 60);
    if (mins < 60) return `${mins}m ago`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
  }

  /** Format remaining expiration ("38m left") */
  function formatExpiresIn(expiresAtMs) {
    const remMs = expiresAtMs - Date.now();
    if (remMs <= 0) return 'Expiring...';
    const mins = Math.ceil(remMs / 60000);
    return `${mins}m left`;
  }

  /** Updates voice volume (0.0 to 1.0), updates slider & icons, persists to storage */
  function setVoiceVolume(newVol, save = true) {
    newVol = Math.max(0, Math.min(1, newVol));
    if (newVol > 0) {
      state.lastUnmutedVolume = newVol;
    }
    state.voiceVolume = newVol;
    state.voiceEnabled = newVol > 0;

    if (save) {
      try {
        localStorage.setItem(STORAGE_KEY_VOICE_VOL, newVol.toString());
      } catch (e) {
        // Ignore storage errors
      }
    }

    const pct = Math.round(newVol * 100);
    const slider = document.getElementById('voiceVolumeSlider');
    const label = document.getElementById('voiceVolumeLabel');
    const mainIcon = document.getElementById('voiceIcon');

    if (slider && parseInt(slider.value, 10) !== pct) {
      slider.value = pct;
    }

    let iconText = '🔊';
    if (pct === 0) {
      iconText = '🔇';
    } else if (pct <= 50) {
      iconText = '🔉';
    }

    if (mainIcon) mainIcon.textContent = iconText;
    if (label) {
      label.textContent = pct === 0 ? 'Mute' : `${pct}%`;
      label.className = `text-[11px] font-mono font-bold w-9 text-right shrink-0 ${
        pct === 0 ? 'text-rose-400' : 'text-emerald-400'
      }`;
    }

    if (pct === 0 && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }

  /** Speak text using Web Speech API if voice alerts are enabled */
  function speakAlert(text) {
    if (!state.voiceEnabled || state.voiceVolume <= 0 || !('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.04;
      utterance.pitch = 1.0;
      utterance.volume = state.voiceVolume;
      window.speechSynthesis.speak(utterance);
    } catch (e) {
      // Ignore speech synthesis errors on restricted browsers
    }
  }

  /** Reverse geocode coordinates via OpenStreetMap Nominatim */
  async function reverseGeocode(lat, lng) {
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;
      const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
      if (!res.ok) return null;
      const data = await res.json();
      const addr = data.address || {};
      const street =
        addr.road ||
        addr.pedestrian ||
        addr.highway ||
        addr.neighbourhood ||
        addr.suburb ||
        data.name ||
        null;
      const city = addr.city || addr.town || addr.village || addr.county || '';
      const shortLabel = street
        ? city
          ? `${street}, ${city}`
          : street
        : data.display_name
          ? data.display_name.split(',').slice(0, 2).join(',')
          : null;
      return {
        street: street || shortLabel || `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
        fullAddress: data.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
        shortLabel: shortLabel || `${lat.toFixed(4)}, ${lng.toFixed(4)}`
      };
    } catch (e) {
      return null;
    }
  }

  // ==========================================
  // 4. MAP INITIALIZATION & LIVE GPS TRACKING
  // ==========================================
  function initMap() {
    state.map = L.map('map', {
      center: [state.userPos.lat, state.userPos.lng],
      zoom: 15,
      maxZoom: 19,
      zoomControl: false,
      attributionControl: true,
      rotate: true,
      touchRotate: false,
      shiftKeyRotate: false,
      dragRotate: false
    });

    attachMapTileLayer();
    applyTheme(state.theme);

    // Create custom animated GPS user marker (2D Puck for idle mode, 3D Waze Vehicle Arrow for navigation)
    const gpsIcon = L.divIcon({
      className: 'custom-gps-icon',
      html: `
        <div id="userMarkerRoot" class="gps-user-marker">
          <!-- 2D Idle Mode: Standard blue pulsing puck with radar ring and cone -->
          <div class="gps-puck-wrapper">
            <div class="gps-accuracy-ring"></div>
            <div id="gpsHeadingCone" class="gps-heading-cone" style="transform: rotate(${state.userHeading}deg)"></div>
            <div class="gps-puck-core">
              <div class="gps-puck-arrow"></div>
            </div>
          </div>

          <!-- 3D Navigation Mode: Waze-Style Cyan Vehicle Navigation Arrow (Locked UP in Ride Mode) -->
          <div class="nav-vehicle-arrow-wrapper">
            <div id="navVehicleChevron" class="nav-arrow-chevron" style="transform: rotate(0deg)">
              <svg viewBox="0 0 44 48" class="w-12 h-14">
                <defs>
                  <linearGradient id="wazeArrowLeft" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#38bdf8"/>
                    <stop offset="100%" stop-color="#0284c7"/>
                  </linearGradient>
                  <linearGradient id="wazeArrowRight" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#0ea5e9"/>
                    <stop offset="100%" stop-color="#0369a1"/>
                  </linearGradient>
                </defs>
                <!-- Radar Halo Pulse around arrow -->
                <circle cx="22" cy="24" r="16" fill="rgba(56, 189, 248, 0.2)" stroke="rgba(56, 189, 248, 0.45)" stroke-width="1.5" class="nav-arrow-radar"/>
                <!-- Drop shadow -->
                <path d="M22 4 L6 38 L22 30 L38 38 Z" fill="rgba(0,0,0,0.5)" transform="translate(0, 4)"/>
                <!-- Left Wing -->
                <path d="M22 4 L6 38 L22 30 Z" fill="url(#wazeArrowLeft)" stroke="#ffffff" stroke-width="2.6" stroke-linejoin="round"/>
                <!-- Right Wing (3D beveled shade) -->
                <path d="M22 4 L38 38 L22 30 Z" fill="url(#wazeArrowRight)" stroke="#ffffff" stroke-width="2.6" stroke-linejoin="round"/>
                <!-- White Spine Highlight -->
                <line x1="22" y1="5" x2="22" y2="29" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" opacity="0.95"/>
                <!-- Nose tip point -->
                <circle cx="22" cy="5" r="1.6" fill="#ffffff"/>
              </svg>
            </div>
          </div>
        </div>
      `,
      iconSize: [52, 52],
      iconAnchor: [26, 26]
    });

    state.userMarker = L.marker([state.userPos.lat, state.userPos.lng], {
      icon: gpsIcon,
      zIndexOffset: 1000
    });

    // Detect manual map drag to disengage auto-follow and update Locate button state
    state.map.on('dragstart', () => {
      setFollowMode(false);
    });

    // Handle map click: either drop a community report pin OR route to clicked location
    state.map.on('click', async (e) => {
      const { lat, lng } = e.latlng;
      if (state.pendingMapPlacement) {
        completeMapTapReport(lat, lng);
        return;
      }

      // If not actively navigating, tapping on the map selects that point as a destination
      if (!state.isNavigating) {
        const defaultName = `Pinned Location (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
        selectDestination({
          name: 'Loading street address...',
          address: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
          icon: '📍',
          lat,
          lng,
          streetHint: defaultName
        });

        const geo = await reverseGeocode(lat, lng);
        if (geo && state.selectedDestination && Math.abs(state.selectedDestination.lat - lat) < 1e-5) {
          state.selectedDestination.name = geo.shortLabel;
          state.selectedDestination.address = geo.fullAddress;
          state.selectedDestination.streetHint = geo.street;
          document.getElementById('destinationInput').value = geo.shortLabel;
          document.getElementById('previewDestName').textContent = geo.shortLabel;
        }
      }
    });
  }

  /**
   * Initialize or switch OpenStreetMap raster tile layer.
   * Uses high-reliability OpenStreetMap mirrors (OSM France/HOT and official OSM).
   */
  function attachMapTileLayer() {
    if (state.tileLayer) {
      state.map.removeLayer(state.tileLayer);
    }
    let currentUrlIdx = 0;
    let errorCount = 0;

    const attach = (urlIdx) => {
      if (state.tileLayer) {
        state.map.removeLayer(state.tileLayer);
      }
      state.tileLayer = L.tileLayer(OSM_TILE_URLS[urlIdx], {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors',
        maxZoom: 19,
        subdomains: 'abc'
      }).addTo(state.map);

      state.tileLayer.on('tileerror', () => {
        errorCount++;
        if (errorCount >= 2 && currentUrlIdx < OSM_TILE_URLS.length - 1) {
          currentUrlIdx++;
          errorCount = 0;
          attach(currentUrlIdx);
        }
      });
    };

    attach(0);
  }

  function applyTheme(theme) {
    state.theme = theme;
    localStorage.setItem(STORAGE_KEY_THEME, theme);

    if (theme === 'day') {
      document.body.classList.add('theme-day');
      document.getElementById('themeIcon').textContent = '☀️';
    } else {
      document.body.classList.remove('theme-day');
      document.getElementById('themeIcon').textContent = '🌙';
    }

    setTimeout(() => {
      if (state.map) state.map.invalidateSize();
    }, 100);
  }

  let gpsBarAutoHideTimer = null;

  /** Update the right-hand Locate button (#recenterBtn) to match Google Maps states */
  function updateLocateButtonUI() {
    const dot = document.getElementById('gpsLockDot');
    const btn = document.getElementById('recenterBtn');
    const centerDot = document.getElementById('locateCenterDot');

    if (!state.hasLiveGpsLock) {
      // State 1: Location NOT detected — warning dot + muted crosshair
      dot.className = 'absolute top-1.5 right-1.5 w-2.5 h-2.5 rounded-full bg-amber-400 animate-ping';
      btn.className =
        'btn-tactile glass-panel w-11 h-11 sm:w-12 sm:h-12 rounded-2xl shadow-xl flex items-center justify-center text-amber-400 hover:text-amber-300 border border-amber-400/50 relative transition-all duration-200';
      if (centerDot) centerDot.setAttribute('fill', 'none');
      btn.title = 'Location not detected — Tap to locate';
    } else if (state.followUser) {
      // State 2: Location detected & map centered on user — Google Maps filled blue crosshair
      dot.className = 'hidden';
      btn.className =
        'btn-tactile glass-panel w-11 h-11 sm:w-12 sm:h-12 rounded-2xl shadow-xl flex items-center justify-center text-sky-400 hover:text-sky-300 border border-sky-400/60 relative transition-all duration-200';
      if (centerDot) centerDot.setAttribute('fill', 'currentColor');
      btn.title = 'Centered on your live GPS location';
    } else {
      // State 3: Location detected, but map was panned away — hollow crosshair
      dot.className = 'absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-sky-400';
      btn.className =
        'btn-tactile glass-panel w-11 h-11 sm:w-12 sm:h-12 rounded-2xl shadow-xl flex items-center justify-center text-slate-200 day-text-dark hover:text-sky-400 border border-slate-700/70 relative transition-all duration-200';
      if (centerDot) centerDot.setAttribute('fill', 'none');
      btn.title = 'Re-center on your live GPS location';
    }
  }

  function setFollowMode(enabled) {
    state.followUser = enabled;
    updateLocateButtonUI();
  }

  function showGpsStatusBanner(autoHideMs = 0) {
    if (state.isNavigating || state.selectedDestination) return;
    const bar = document.getElementById('idleBottomBar');
    bar.classList.remove('hidden');
    clearTimeout(gpsBarAutoHideTimer);
    if (autoHideMs > 0) {
      gpsBarAutoHideTimer = setTimeout(() => {
        if (state.hasLiveGpsLock) {
          bar.classList.add('hidden');
        }
      }, autoHideMs);
    }
  }

  // ==========================================
  // HIGH-ACCURACY GPS SPEEDOMETER & FILTERING
  // ==========================================
  function inferRoadSpeedLimit(streetName, stepInstruction = '') {
    const text = `${streetName || ''} ${stepInstruction || ''}`.toLowerCase();
    if (/motorway|expressway|lebuhraya|highway|\b(e\d{1,2}|ah\d{1,2})\b/i.test(text)) {
      return 110;
    }
    if (/trunk|lingkaran|bypass/i.test(text)) {
      return 90;
    }
    if (/persiaran\s+utama|persiaran|jalan\s+besar|arterial|boulevard/i.test(text)) {
      return 70;
    }
    if (/jalan/i.test(text)) {
      return 60;
    }
    if (/lorong|service|residential|living_street|kampung/i.test(text)) {
      return 40;
    }
    return 60;
  }

  const speedometerEngine = {
    // Sliding history buffer of recent GPS fixes for velocity estimation and drift rejection
    history: [], // [{ lat, lng, time, accuracy, rawSpeedKmh }]
    maxHistorySamples: 6,
    maxHistoryWindowMs: 3500,

    filteredSpeedKmh: 0,
    displayedSpeedKmh: 0,
    animFrameId: null,
    lastFixTime: 0,
    lastRawSpeedKmh: 0,
    activeSpeedLimitKmh: null,

    // Deadband threshold: speed below 2.2 km/h (0.61 m/s) is strictly clamped to 0 to eliminate stationary drift
    DEADBAND_KMH: 2.2,
    // Minimum displacement in meters required over window to register motion
    MIN_DISPLACEMENT_M: 2.0,
    // Maximum plausible vehicle acceleration: 18 km/h per sec (~5 m/s^2)
    MAX_ACCEL_KMH_PER_SEC: 18,
    // Maximum plausible vehicle deceleration: 36 km/h per sec (~10 m/s^2)
    MAX_DECEL_KMH_PER_SEC: 36,

    /**
     * Compute filtered, highly accurate ground speed (km/h) from GPS fix
     */
    processFix(lat, lng, hwSpeedMs, accuracyM, timestampMs) {
      const now = timestampMs || Date.now();
      const dtSec = this.lastFixTime > 0 ? (now - this.lastFixTime) / 1000 : 1.0;
      this.lastFixTime = now;

      const accuracy = Number.isFinite(accuracyM) ? accuracyM : 10;
      let rawSpeedKmh = null;

      // 1. Check direct hardware Doppler speed (coords.speed from GNSS chip)
      // Hardware Doppler carrier frequency shift is immune to multipath position drift.
      const hasValidHwSpeed = (
        hwSpeedMs !== null &&
        typeof hwSpeedMs === 'number' &&
        !Number.isNaN(hwSpeedMs) &&
        hwSpeedMs >= 0 &&
        accuracy < 45
      );

      if (hasValidHwSpeed) {
        // If speed is unusually high (> 85), handle cases where speed was passed in km/h
        const hwSpeedKmh = hwSpeedMs > 85 ? hwSpeedMs : hwSpeedMs * 3.6;
        if (hwSpeedKmh < this.DEADBAND_KMH) {
          rawSpeedKmh = 0;
        } else {
          rawSpeedKmh = hwSpeedKmh;
        }
      }

      // 2. Add current fix to history buffer for sliding-window estimation & drift cancellation
      this.history.push({ lat, lng, time: now, accuracy, rawSpeedKmh });
      this.history = this.history.filter(h => (now - h.time) <= this.maxHistoryWindowMs);
      if (this.history.length > this.maxHistorySamples) {
        this.history.shift();
      }

      // 3. Fallback: Multi-sample weighted sliding window displacement (when Doppler speed is unavailable)
      if (rawSpeedKmh === null) {
        if (this.history.length >= 2) {
          const oldest = this.history[0];
          const windowDtSec = (now - oldest.time) / 1000;
          const netDistM = getDistanceMeters(oldest.lat, oldest.lng, lat, lng);

          // Calculate adaptive stationary jitter threshold based on GPS accuracy
          const avgAccuracy = (accuracy + oldest.accuracy) / 2;
          const jitterThresholdM = Math.max(this.MIN_DISPLACEMENT_M, avgAccuracy * 0.22);

          if (windowDtSec >= 0.4 && windowDtSec <= 5.0) {
            if (netDistM < jitterThresholdM) {
              rawSpeedKmh = 0;
            } else {
              const computedKmh = (netDistM / windowDtSec) * 3.6;
              rawSpeedKmh = computedKmh < this.DEADBAND_KMH ? 0 : computedKmh;
            }
          } else {
            rawSpeedKmh = 0;
          }
        } else {
          rawSpeedKmh = 0;
        }
      }

      // 4. Zero-Velocity Lock: If total net displacement across the history window is < 2.0m, force 0
      if (this.history.length >= 3) {
        const earliest = this.history[0];
        const spanDist = getDistanceMeters(earliest.lat, earliest.lng, lat, lng);
        if (spanDist < this.MIN_DISPLACEMENT_M) {
          rawSpeedKmh = 0;
        }
      }

      // 5. Outlier & Spike Rejection (Physical acceleration/deceleration limits)
      if (this.lastRawSpeedKmh > 0 && rawSpeedKmh > 0 && dtSec > 0.1 && dtSec < 4.0) {
        const deltaSpeed = rawSpeedKmh - this.lastRawSpeedKmh;
        const maxAllowedDelta = deltaSpeed > 0
          ? this.MAX_ACCEL_KMH_PER_SEC * dtSec
          : this.MAX_DECEL_KMH_PER_SEC * dtSec;

        if (Math.abs(deltaSpeed) > maxAllowedDelta) {
          rawSpeedKmh = deltaSpeed > 0
            ? this.lastRawSpeedKmh + maxAllowedDelta
            : Math.max(0, this.lastRawSpeedKmh - maxAllowedDelta);
        }
      }
      this.lastRawSpeedKmh = rawSpeedKmh;

      // 6. Adaptive Low-Pass Filter (Exponential Moving Average)
      // When stopped, rapidly decay to 0. When cruising, use lower alpha (0.35) for stability.
      if (rawSpeedKmh === 0) {
        if (this.filteredSpeedKmh < 1.5) {
          this.filteredSpeedKmh = 0;
        } else {
          this.filteredSpeedKmh = this.filteredSpeedKmh * 0.45;
          if (this.filteredSpeedKmh < 0.8) this.filteredSpeedKmh = 0;
        }
      } else {
        const diff = Math.abs(rawSpeedKmh - this.filteredSpeedKmh);
        const alpha = diff > 10 ? 0.65 : 0.35;
        this.filteredSpeedKmh = alpha * rawSpeedKmh + (1 - alpha) * this.filteredSpeedKmh;
      }

      const finalSpeedKmh = Math.max(0, Math.round(this.filteredSpeedKmh));
      this.startDisplayAnimation(finalSpeedKmh);
      return finalSpeedKmh;
    },

    /**
     * Smooth 60fps interpolation of the speedometer number to prevent jarring digit jumps
     */
    startDisplayAnimation(targetSpeed) {
      if (this.animFrameId) {
        cancelAnimationFrame(this.animFrameId);
        this.animFrameId = null;
      }

      const speedValEl = document.getElementById('currentSpeedValue');
      const speedContainer = document.getElementById('speedometerContainer');
      if (!speedValEl) return;

      const startSpeed = this.displayedSpeedKmh;
      const startTime = performance.now();
      const durationMs = 280;

      const animate = (currentTime) => {
        const elapsed = currentTime - startTime;
        const progress = Math.min(1, elapsed / durationMs);
        const ease = 1 - Math.pow(1 - progress, 3);
        const currentInterp = startSpeed + (targetSpeed - startSpeed) * ease;
        this.displayedSpeedKmh = currentInterp;

        const roundedVal = Math.round(currentInterp);
        speedValEl.textContent = roundedVal;

        // Visual speeding warning check against active road speed limit
        if (speedContainer && this.activeSpeedLimitKmh) {
          if (roundedVal > this.activeSpeedLimitKmh + 3) {
            speedContainer.classList.add('speeding-warning');
          } else {
            speedContainer.classList.remove('speeding-warning');
          }
        }

        if (progress < 1) {
          this.animFrameId = requestAnimationFrame(animate);
        } else {
          this.displayedSpeedKmh = targetSpeed;
          speedValEl.textContent = targetSpeed;
          this.animFrameId = null;
        }
      };

      this.animFrameId = requestAnimationFrame(animate);
    },

    setSpeedLimit(limitKmh) {
      this.activeSpeedLimitKmh = limitKmh && limitKmh > 0 ? limitKmh : null;
      const badge = document.getElementById('speedLimitBadge');
      const valEl = document.getElementById('speedLimitValue');
      const speedContainer = document.getElementById('speedometerContainer');
      if (badge && valEl) {
        if (this.activeSpeedLimitKmh) {
          valEl.textContent = this.activeSpeedLimitKmh;
          badge.classList.remove('hidden');
        } else {
          badge.classList.add('hidden');
          if (speedContainer) {
            speedContainer.classList.remove('speeding-warning');
          }
        }
      }
    }
  };

  // ==========================================
  // SMOOTH 60 FPS VEHICLE MARKER & CAMERA GLIDE
  // ==========================================
  const markerAnimator = {
    currentLat: null,
    currentLng: null,
    currentBearing: 0,
    targetLat: null,
    targetLng: null,
    targetBearing: 0,
    startTime: 0,
    durationMs: 750,
    animId: null,

    animateTo(lat, lng, bearing, durationMs = 750) {
      if (this.currentLat === null) {
        this.currentLat = lat;
        this.currentLng = lng;
        this.currentBearing = bearing;
        this.targetLat = lat;
        this.targetLng = lng;
        this.targetBearing = bearing;
        if (state.userMarker) {
          state.userMarker.setLatLng([lat, lng]);
        }
        return;
      }

      // If position jump is large (> 250m, e.g. initial fix or warp), set immediately without animation
      const jumpM = getDistanceMeters(this.currentLat, this.currentLng, lat, lng);
      if (jumpM > 250) {
        this.currentLat = lat;
        this.currentLng = lng;
        this.currentBearing = bearing;
        this.targetLat = lat;
        this.targetLng = lng;
        this.targetBearing = bearing;
        if (state.userMarker) {
          state.userMarker.setLatLng([lat, lng]);
        }
        if (state.followUser && state.map) {
          state.map.setView([lat, lng], state.map.getZoom(), { animate: false });
        }
        return;
      }

      this.targetLat = lat;
      this.targetLng = lng;
      this.targetBearing = bearing;
      this.startTime = performance.now();
      this.durationMs = Math.max(300, Math.min(1500, durationMs));

      if (!this.animId) {
        this.loop();
      }
    },

    loop() {
      this.animId = requestAnimationFrame((now) => {
        const elapsed = now - this.startTime;
        const progress = Math.min(1, elapsed / this.durationMs);

        // Ease-out cubic for natural vehicle inertia
        const ease = progress < 1 ? 1 - Math.pow(1 - progress, 3) : 1;

        const interpLat = this.currentLat + (this.targetLat - this.currentLat) * ease;
        const interpLng = this.currentLng + (this.targetLng - this.currentLng) * ease;

        // Circular shortest-path angle interpolation
        let angleDiff = ((this.targetBearing - this.currentBearing + 540) % 360) - 180;
        const interpBearing = this.currentBearing + angleDiff * ease;

        if (state.userMarker) {
          state.userMarker.setLatLng([interpLat, interpLng]);
          const cone = document.getElementById('gpsHeadingCone');
          if (cone) cone.style.transform = `rotate(${Math.round(interpBearing)}deg)`;
          const navArrow = document.getElementById('navVehicleChevron');
          if (navArrow) {
            if (state.isNavigating) {
              // Locked pointing straight UP in Ride Mode (Course-Up navigation like Waze)
              navArrow.style.transform = 'rotate(0deg)';
            } else {
              navArrow.style.transform = `rotate(${Math.round(interpBearing)}deg)`;
            }
          }
        }

        if (state.accuracyCircle && !state.isNavigating && state.hasLiveGpsLock) {
          state.accuracyCircle.setLatLng([interpLat, interpLng]);
        }

        if (state.followUser && state.map) {
          state.map.panTo([interpLat, interpLng], { animate: false });
          // In Ride Mode: rotate map smoothly beneath vehicle so road ahead faces UP
          if (state.isNavigating && typeof state.map.setBearing === 'function') {
            state.map.setBearing(-interpBearing);
          }
        }

        if (progress < 1) {
          this.loop();
        } else {
          this.currentLat = this.targetLat;
          this.currentLng = this.targetLng;
          this.currentBearing = this.targetBearing;
          this.animId = null;
        }
      });
    }
  };

  function updateUserPosition(lat, lng, heading = null, hwSpeedMs = null, accuracyM = null, timestampMs = null) {
    const rawPos = { lat, lng };
    state.rawGpsPos = rawPos;
    const now = timestampMs || Date.now();
    const prevPos = { ...state.userPos };
    const rawMoveDist = getDistanceMeters(prevPos.lat, prevPos.lng, lat, lng);

    // Compute high-accuracy filtered ground speed (km/h) through Speedometer Engine
    const filteredSpeedKmh = speedometerEngine.processFix(lat, lng, hwSpeedMs, accuracyM, now);

    let resolvedLat = lat;
    let resolvedLng = lng;
    let resolvedHeading = heading;

    if (state.isNavigating) {
      // 1. ACTIVE NAVIGATION: High-Precision Map Matching (Snap-to-Road)
      const snap = snapToActiveRoute(lat, lng);
      if (snap.snapped) {
        resolvedLat = snap.lat;
        resolvedLng = snap.lng;
        resolvedHeading = snap.bearing;
      } else {
        // Off-route: vehicle in parking lot, service lane, or taking a detour
        resolvedLat = lat;
        resolvedLng = lng;
        if (resolvedHeading === null || Number.isNaN(resolvedHeading)) {
          resolvedHeading = state.userHeading;
        }
      }
    } else {
      // 2. 2D IDLE / FREE DRIVE MODE: Stationary Anchor & Accuracy Weighted Filter
      if (filteredSpeedKmh === 0) {
        // Vehicle is stopped: Lock position to stationary anchor to completely eliminate satellite drift
        if (state.stationaryAnchor) {
          const driftFromAnchor = getDistanceMeters(state.stationaryAnchor.lat, state.stationaryAnchor.lng, lat, lng);
          if (driftFromAnchor < 3.2) {
            resolvedLat = state.stationaryAnchor.lat;
            resolvedLng = state.stationaryAnchor.lng;
          } else {
            state.stationaryAnchor = { lat, lng };
          }
        } else {
          state.stationaryAnchor = { lat, lng };
        }
      } else {
        // Vehicle is moving: Release stationary anchor and apply accuracy-weighted complementary filter
        state.stationaryAnchor = null;
        if (state.lastFilteredPos) {
          const acc = accuracyM || 10;
          // Weighted complementary filter: higher confidence fixes pull position more strongly
          const weight = Math.max(0.3, Math.min(0.9, 1 - (acc / 60)));
          resolvedLat = weight * lat + (1 - weight) * state.lastFilteredPos.lat;
          resolvedLng = weight * lng + (1 - weight) * state.lastFilteredPos.lng;
        }
        state.lastFilteredPos = { lat: resolvedLat, lng: resolvedLng };
      }

      // Compass / Heading derivation when moving if hardware heading is absent
      if (resolvedHeading === null || Number.isNaN(resolvedHeading)) {
        if (filteredSpeedKmh > 2.5 && rawMoveDist > 2.0) {
          resolvedHeading = getBearing(prevPos.lat, prevPos.lng, resolvedLat, resolvedLng);
        } else {
          resolvedHeading = state.userHeading;
        }
      }
    }

    if (resolvedHeading === null || Number.isNaN(resolvedHeading)) {
      resolvedHeading = state.userHeading;
    }

    state.userPos = { lat: resolvedLat, lng: resolvedLng };
    state.lastGpsFixTime = now;
    state.userHeading = Math.round(resolvedHeading || 0);
    state.currentSpeedKmh = filteredSpeedKmh;
    if (accuracyM !== null) {
      state.gpsAccuracyM = Math.round(accuracyM);
    }

    try {
      localStorage.setItem(STORAGE_KEY_LAST_GPS, JSON.stringify({ lat: resolvedLat, lng: resolvedLng }));
    } catch (e) {
      // Ignore storage quota errors
    }

    // Ensure User Marker exists and is visible on map
    if (state.userMarker) {
      if (state.hasLiveGpsLock && state.map && !state.map.hasLayer(state.userMarker)) {
        state.userMarker.addTo(state.map);
      }
    }

    // Real-world GPS Accuracy Confidence Circle (in 2D Idle Mode)
    if (state.map && state.hasLiveGpsLock) {
      if (!state.accuracyCircle) {
        state.accuracyCircle = L.circle([resolvedLat, resolvedLng], {
          radius: state.gpsAccuracyM || 15,
          color: '#38bdf8',
          fillColor: '#0ea5e9',
          fillOpacity: 0.12,
          weight: 1.5,
          opacity: 0.45,
          className: 'gps-accuracy-circle',
          interactive: false
        }).addTo(state.map);
      } else {
        state.accuracyCircle.setRadius(Math.max(4, state.gpsAccuracyM || 12));
      }

      // Hide accuracy circle when navigating so the road is clean
      if (state.isNavigating && state.map.hasLayer(state.accuracyCircle)) {
        state.map.removeLayer(state.accuracyCircle);
      } else if (!state.isNavigating && !state.map.hasLayer(state.accuracyCircle)) {
        state.accuracyCircle.addTo(state.map);
      }
    }

    // Smooth 60 FPS marker glide along road
    markerAnimator.animateTo(resolvedLat, resolvedLng, state.userHeading, 800);

    updateLiveTickerAndBadges();
    broadcastMyConvoyTelemetry();

    if (state.isNavigating) {
      onLiveNavigationPositionUpdate(resolvedLat, resolvedLng);
    }
  }

  function startLiveGpsTracking(centerImmediately = false) {
    const statusBadge = document.getElementById('gpsStatusBadge');
    const statusTitle = document.getElementById('gpsStatusTitle');
    const locLabel = document.getElementById('currentLocationLabel');
    const locateMeBtn = document.getElementById('locateMeNowBtn');
    const dismissBtn = document.getElementById('dismissGpsBarBtn');
    const iconBox = document.getElementById('gpsBarIconBox');

    if (!('geolocation' in navigator)) {
      state.hasLiveGpsLock = false;
      updateLocateButtonUI();
      statusBadge.className = 'inline-block w-2 h-2 rounded-full bg-rose-500';
      statusTitle.className = 'text-xs font-bold uppercase tracking-wider text-rose-400';
      statusTitle.textContent = 'Geolocation Unsupported';
      locLabel.textContent = 'Browser does not support live GPS. Tap map to route.';
      locateMeBtn.classList.add('hidden');
      dismissBtn.classList.remove('hidden');
      showGpsStatusBanner(0);
      return;
    }

    statusBadge.className = 'inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse';
    statusTitle.className = 'text-xs font-bold uppercase tracking-wider text-amber-400';
    statusTitle.textContent = 'Detecting Your Location...';
    locLabel.textContent = 'Requesting live GPS signal from your browser...';
    locateMeBtn.classList.remove('hidden');
    locateMeBtn.textContent = 'Locate Me';
    dismissBtn.classList.add('hidden');
    if (iconBox) {
      iconBox.className = 'w-10 h-10 rounded-xl bg-amber-500/20 border border-amber-400/30 flex items-center justify-center text-xl shrink-0';
      iconBox.textContent = '📍';
    }
    showGpsStatusBanner(0);

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude, heading, speed, accuracy } = pos.coords;
        state.hasLiveGpsLock = true;

        statusBadge.className = 'inline-block w-2 h-2 rounded-full bg-emerald-400';
        statusTitle.className = 'text-xs font-bold uppercase tracking-wider text-sky-400';
        statusTitle.textContent = `Live GPS Active ${accuracy ? `(±${Math.round(accuracy)}m)` : ''}`;
        locLabel.textContent = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
        locateMeBtn.classList.add('hidden');
        dismissBtn.classList.remove('hidden');
        if (iconBox) {
          iconBox.className = 'w-10 h-10 rounded-xl bg-sky-500/20 border border-sky-400/30 flex items-center justify-center text-xl shrink-0';
          iconBox.textContent = '📡';
        }

        updateUserPosition(
          latitude,
          longitude,
          heading,
          speed,
          accuracy,
          pos.timestamp
        );

        if (centerImmediately || state.followUser) {
          state.map.setView([latitude, longitude], 16, { animate: true });
          setFollowMode(true);
        } else {
          updateLocateButtonUI();
        }

        // Auto-hide bottom bar after 3.5s once location is detected (like Google Maps)
        showGpsStatusBanner(3500);

        // Pre-warm local road graph in background so route calculation is instantaneous (<350ms)
        const sk = `${latitude.toFixed(3)},${longitude.toFixed(3)}`;
        if (!state.localOsmWaysCache.has(sk)) {
          resolveLocalOsmAccessPath({ lat: latitude, lng: longitude }, { lat: latitude, lng: longitude }).catch(() => {});
        }

        // Reverse geocode current GPS location for a human-readable street label
        const geo = await reverseGeocode(latitude, longitude);
        if (geo) {
          state.currentStreetName = geo.street;
          if (!state.isNavigating) {
            locLabel.textContent = `Near ${geo.shortLabel}`;
            const limit = inferRoadSpeedLimit(geo.street);
            speedometerEngine.setSpeedLimit(limit);
          }
        }
      },
      (err) => {
        state.hasLiveGpsLock = false;
        updateLocateButtonUI();
        statusBadge.className = 'inline-block w-2 h-2 rounded-full bg-rose-500';
        statusTitle.className = 'text-xs font-bold uppercase tracking-wider text-rose-400';
        statusTitle.textContent =
          err.code === 1 ? 'Location Permission Denied' : 'Location Not Detected';
        locLabel.textContent =
          err.code === 1
            ? 'Allow location access in browser settings, then tap Locate Me'
            : 'Could not determine your location. Tap Locate Me to retry.';
        locateMeBtn.classList.remove('hidden');
        locateMeBtn.textContent = 'Locate Me';
        dismissBtn.classList.remove('hidden');
        if (iconBox) {
          iconBox.className = 'w-10 h-10 rounded-xl bg-rose-500/20 border border-rose-400/30 flex items-center justify-center text-xl shrink-0';
          iconBox.textContent = '⚠️';
        }
        showGpsStatusBanner(0);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 1000 }
    );

    if (state.geoWatchId !== null) {
      navigator.geolocation.clearWatch(state.geoWatchId);
    }

    state.geoWatchId = navigator.geolocation.watchPosition(
      (update) => {
        const { latitude, longitude, heading, speed, accuracy } = update.coords;
        const wasLocked = state.hasLiveGpsLock;
        state.hasLiveGpsLock = true;
        statusBadge.className = 'inline-block w-2 h-2 rounded-full bg-emerald-400';
        statusTitle.className = 'text-xs font-bold uppercase tracking-wider text-sky-400';
        statusTitle.textContent = `Live GPS Active ${accuracy ? `(±${Math.round(accuracy)}m)` : ''}`;
        locateMeBtn.classList.add('hidden');
        dismissBtn.classList.remove('hidden');

        updateUserPosition(
          latitude,
          longitude,
          heading,
          speed,
          accuracy,
          update.timestamp
        );

        if (!wasLocked) {
          setFollowMode(true);
          showGpsStatusBanner(3500);
        }
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
    );
  }

  // ==========================================
  // 5. COMMUNITY INCIDENT REPORTING & STORAGE
  // ==========================================
  function loadReportsFromStorage() {
    try {
      const savedUpvotes = JSON.parse(localStorage.getItem(STORAGE_KEY_UPVOTES) || '[]');
      state.upvotedIds = new Set(savedUpvotes);

      const raw = localStorage.getItem(STORAGE_KEY_REPORTS);
      if (raw) {
        const parsed = JSON.parse(raw);
        const now = Date.now();
        // Filter out expired reports and any legacy seeded demo reports
        state.reports = parsed.filter(
          (r) =>
            r &&
            r.expiresAt > now &&
            !String(r.id).startsWith('rep-seed-') &&
            !String(r.id).startsWith('rep-route-')
        );
        saveReportsToStorage();
      } else {
        state.reports = [];
      }
    } catch (e) {
      state.reports = [];
    }

    renderAllReportMarkers();
    updateLiveTickerAndBadges();
    renderFeedDrawerList();
  }

  function saveReportsToStorage() {
    try {
      localStorage.setItem(STORAGE_KEY_REPORTS, JSON.stringify(state.reports));
      localStorage.setItem(STORAGE_KEY_UPVOTES, JSON.stringify([...state.upvotedIds]));
    } catch (e) {
      console.warn('Storage write error:', e);
    }
  }

  function clearAllReports() {
    state.reportMarkers.forEach((marker) => state.map.removeLayer(marker));
    state.reportMarkers.clear();
    state.reports = [];
    state.upvotedIds.clear();
    saveReportsToStorage();
    updateLiveTickerAndBadges();
    renderFeedDrawerList();
    updateRouteIncidentCount();
  }

  function mapDbRowToReport(row) {
    return {
      id: row.id,
      category: row.category,
      subtype: row.subtype,
      street: row.street || 'Roadway Report',
      note: row.note || '',
      lat: Number(row.lat),
      lng: Number(row.lng),
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      upvotes: Number(row.upvotes || 1),
      reporter: row.reporter || 'Driver'
    };
  }

  function mapReportToDbRow(report) {
    return {
      id: report.id,
      category: report.category,
      subtype: report.subtype,
      street: report.street || 'Roadway Report',
      note: report.note || '',
      lat: Number(report.lat),
      lng: Number(report.lng),
      created_at: Number(report.createdAt),
      expires_at: Number(report.expiresAt),
      upvotes: Number(report.upvotes || 1),
      reporter: report.reporter || 'Driver'
    };
  }

  async function syncCommunityReportsFromSupabase() {
    if (!state.supabase) return;
    try {
      const now = Date.now();
      const { data, error } = await state.supabase
        .from('community_reports')
        .select('*')
        .gt('expires_at', now)
        .order('created_at', { ascending: false })
        .limit(100);

      if (error || !Array.isArray(data)) return;

      const byId = new Map();
      state.reports.forEach((r) => {
        if (r.expiresAt > now) byId.set(r.id, r);
      });
      data.forEach((row) => {
        const mapped = mapDbRowToReport(row);
        if (mapped.expiresAt > now) {
          byId.set(mapped.id, mapped);
        }
      });

      state.reports = Array.from(byId.values()).sort((a, b) => b.createdAt - a.createdAt);
      saveReportsToStorage();
      renderAllReportMarkers();
      updateLiveTickerAndBadges();
      renderFeedDrawerList();
      updateRouteIncidentCount();
    } catch (e) {
      console.warn('Supabase community_reports fetch error:', e);
    }
  }

  function createReportMarkerHtml(report) {
    const cat = REPORT_CATEGORIES[report.category] || REPORT_CATEGORIES.hazard;
    return `
      <div class="incident-marker-container">
        <div class="incident-pulse-ring" style="background: ${cat.ringColor}"></div>
        <div class="incident-pin" style="background: ${cat.color}">
          <span class="incident-pin-inner">${cat.icon}</span>
        </div>
        <span class="incident-badge-count">👍 ${report.upvotes}</span>
      </div>
    `;
  }

  function buildReportPopupHtml(report) {
    const cat = REPORT_CATEGORIES[report.category] || REPORT_CATEGORIES.hazard;
    const hasUpvoted = state.upvotedIds.has(report.id);

    return `
      <div class="p-3.5 text-slate-100 font-sans">
        <div class="flex items-start justify-between gap-2 mb-2">
          <div class="flex items-center gap-2">
            <span class="text-2xl">${cat.icon}</span>
            <div>
              <span class="text-[10px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded border ${cat.badgeBg}">
                ${cat.label} • ${report.subtype}
              </span>
              <h4 class="text-sm font-bold text-white mt-1">${report.street || 'Roadway Report'}</h4>
            </div>
          </div>
        </div>
        ${report.note ? `<p class="text-xs text-slate-300 bg-slate-800/90 rounded-lg p-2 mb-2.5 border border-slate-700/70">"${report.note}"</p>` : ''}
        <div class="flex items-center justify-between text-[11px] text-slate-400 mb-3">
          <span>Reported ${formatTimeAgo(report.createdAt)}</span>
          <span class="text-amber-400 font-semibold">⏳ ${formatExpiresIn(report.expiresAt)}</span>
        </div>
        <div class="flex items-center gap-2">
          <button
            onclick="window.PulseNav.upvoteReport('${report.id}')"
            class="flex-1 py-2 px-2.5 rounded-xl font-bold text-xs flex items-center justify-center gap-1.5 transition ${
              hasUpvoted
                ? 'bg-emerald-500 text-slate-950'
                : 'bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40'
            }"
          >
            <span>👍</span>
            <span>Still there (${report.upvotes})</span>
          </button>
          <button
            onclick="window.PulseNav.dismissReport('${report.id}')"
            class="py-2 px-2.5 rounded-xl bg-slate-800 hover:bg-rose-500/20 hover:text-rose-300 text-slate-300 border border-slate-700 text-xs font-semibold transition"
          >
            Cleared
          </button>
        </div>
      </div>
    `;
  }

  function renderAllReportMarkers() {
    state.reportMarkers.forEach((marker) => state.map.removeLayer(marker));
    state.reportMarkers.clear();

    state.reports.forEach((report) => {
      addOrUpdateReportMarker(report);
    });
  }

  function addOrUpdateReportMarker(report) {
    if (state.reportMarkers.has(report.id)) {
      const existing = state.reportMarkers.get(report.id);
      state.map.removeLayer(existing);
    }

    const icon = L.divIcon({
      className: 'custom-incident-icon',
      html: createReportMarkerHtml(report),
      iconSize: [44, 44],
      iconAnchor: [22, 40],
      popupAnchor: [0, -36]
    });

    const marker = L.marker([report.lat, report.lng], {
      icon,
      zIndexOffset: 600
    }).addTo(state.map);

    marker.bindPopup(buildReportPopupHtml(report), {
      closeButton: true,
      maxWidth: 270
    });

    state.reportMarkers.set(report.id, marker);
  }

  async function addNewCommunityReport({ category, subtype, note, durationMin, lat, lng }) {
    const now = Date.now();
    const cat = REPORT_CATEGORIES[category] || REPORT_CATEGORIES.hazard;
    const ttlMinutes = parseInt(durationMin, 10) || 45;

    const newReport = {
      id: `rep-${now}-${Math.floor(Math.random() * 1000)}`,
      category,
      subtype,
      street: state.currentStreetName || `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
      note: note ? note.trim() : `${cat.label} (${subtype})`,
      lat,
      lng,
      createdAt: now,
      expiresAt: now + ttlMinutes * 60 * 1000,
      upvotes: 1,
      reporter: state.convoy.driverName || 'Driver'
    };

    state.reports.unshift(newReport);
    state.upvotedIds.add(newReport.id);
    saveReportsToStorage();

    addOrUpdateReportMarker(newReport);
    updateLiveTickerAndBadges();
    renderFeedDrawerList();
    recomputeGraphWeightsFromReports();

    const marker = state.reportMarkers.get(newReport.id);
    if (marker) {
      marker.openPopup();
    }

    if (state.supabase) {
      state.supabase
        .from('community_reports')
        .upsert(mapReportToDbRow(newReport))
        .then(() => {});
    }

    // Resolve exact street name via reverse geocoding asynchronously
    const geo = await reverseGeocode(lat, lng);
    if (geo && geo.street) {
      newReport.street = geo.shortLabel || geo.street;
      saveReportsToStorage();
      addOrUpdateReportMarker(newReport);
      updateLiveTickerAndBadges();
      renderFeedDrawerList();

      if (state.supabase) {
        state.supabase
          .from('community_reports')
          .update({ street: newReport.street })
          .eq('id', newReport.id)
          .then(() => {});
      }
    }
  }

  function upvoteReport(reportId) {
    const report = state.reports.find((r) => r.id === reportId);
    if (!report) return;

    if (state.upvotedIds.has(reportId)) {
      state.upvotedIds.delete(reportId);
      report.upvotes = Math.max(1, report.upvotes - 1);
    } else {
      state.upvotedIds.add(reportId);
      report.upvotes += 1;
      report.expiresAt = Math.min(
        Date.now() + 60 * 60 * 1000,
        report.expiresAt + 10 * 60 * 1000
      );
    }

    saveReportsToStorage();
    addOrUpdateReportMarker(report);
    updateLiveTickerAndBadges();
    renderFeedDrawerList();

    const marker = state.reportMarkers.get(report.id);
    if (marker && marker.isPopupOpen()) {
      marker.setPopupContent(buildReportPopupHtml(report));
    }

    if (state.supabase) {
      state.supabase
        .from('community_reports')
        .update({ upvotes: report.upvotes, expires_at: report.expiresAt })
        .eq('id', report.id)
        .then(() => {});
    }
  }

  function dismissReport(reportId) {
    const idx = state.reports.findIndex((r) => r.id === reportId);
    if (idx === -1) return;

    const marker = state.reportMarkers.get(reportId);
    if (marker) {
      state.map.removeLayer(marker);
      state.reportMarkers.delete(reportId);
    }

    state.reports.splice(idx, 1);
    saveReportsToStorage();
    updateLiveTickerAndBadges();
    renderFeedDrawerList();
    recomputeGraphWeightsFromReports();

    if (state.supabase) {
      state.supabase
        .from('community_reports')
        .delete()
        .eq('id', reportId)
        .then(() => {});
    }
  }

  function purgeExpiredReports() {
    const now = Date.now();
    let changed = false;

    state.reports = state.reports.filter((r) => {
      if (r.expiresAt <= now) {
        const m = state.reportMarkers.get(r.id);
        if (m) {
          state.map.removeLayer(m);
          state.reportMarkers.delete(r.id);
        }
        changed = true;
        return false;
      }
      return true;
    });

    if (changed) {
      saveReportsToStorage();
    }
    updateLiveTickerAndBadges();
    renderFeedDrawerList();
  }

  // ==========================================
  // 6. LIVE ALERT TICKER & COLLAPSIBLE FEED DRAWER
  // ==========================================
  function getSortedReportsWithDistance() {
    return state.reports
      .map((r) => ({
        ...r,
        distanceM: getDistanceMeters(state.userPos.lat, state.userPos.lng, r.lat, r.lng)
      }))
      .sort((a, b) => a.distanceM - b.distanceM);
  }

  function updateLiveTickerAndBadges() {
    const sorted = getSortedReportsWithDistance();
    const countBadge = document.getElementById('activeReportCountBadge');
    if (countBadge) countBadge.textContent = sorted.length;

    const tickerIcon = document.getElementById('tickerIcon');
    const tickerHazardBadge = document.getElementById('tickerHazardBadge');
    const tickerTitle = document.getElementById('tickerTitle');
    const tickerMessage = document.getElementById('tickerMessage');
    const tickerUpvoteBtn = document.getElementById('tickerUpvoteBtn');
    const tickerUpvoteCount = document.getElementById('tickerUpvoteCount');

    if (sorted.length === 0) {
      if (tickerIcon) tickerIcon.textContent = '✅';
      if (tickerHazardBadge) tickerHazardBadge.classList.add('hidden');
      if (tickerTitle) {
        tickerTitle.textContent = 'ALL CLEAR:';
        tickerTitle.className = 'font-bold text-emerald-400';
      }
      if (tickerMessage) tickerMessage.textContent = 'No active road hazards reported nearby';
      if (tickerUpvoteBtn) tickerUpvoteBtn.classList.add('hidden');
      const clickArea = document.getElementById('tickerClickArea');
      if (clickArea) clickArea.onclick = null;
      return;
    }

    const closest = sorted[0];
    const cat = REPORT_CATEGORIES[closest.category] || REPORT_CATEGORIES.hazard;

    if (tickerIcon) tickerIcon.textContent = cat.icon;
    if (tickerHazardBadge) tickerHazardBadge.classList.remove('hidden');
    if (tickerTitle) {
      tickerTitle.textContent = `${cat.label.toUpperCase()} (${closest.subtype}):`;
      tickerTitle.className = 'font-bold text-amber-400';
    }
    if (tickerMessage) tickerMessage.textContent = `${formatDistance(closest.distanceM)} away • ${closest.street}`;
    if (tickerUpvoteBtn) tickerUpvoteBtn.classList.remove('hidden');
    if (tickerUpvoteCount) tickerUpvoteCount.textContent = closest.upvotes;

    if (tickerUpvoteBtn) {
      tickerUpvoteBtn.onclick = (e) => {
        e.stopPropagation();
        upvoteReport(closest.id);
      };
    }

    const clickArea = document.getElementById('tickerClickArea');
    if (clickArea) {
      clickArea.onclick = () => {
        focusReportOnMap(closest.id);
      };
    }
  }

  function focusReportOnMap(reportId) {
    const report = state.reports.find((r) => r.id === reportId);
    if (!report) return;

    setFollowMode(false);
    state.map.setView([report.lat, report.lng], 17, { animate: true });
    const marker = state.reportMarkers.get(report.id);
    if (marker) {
      marker.openPopup();
    }
  }

  function renderFeedDrawerList() {
    const container = document.getElementById('feedListContainer');
    const sorted = getSortedReportsWithDistance().filter(
      (r) => state.feedFilter === 'all' || r.category === state.feedFilter
    );

    if (sorted.length === 0) {
      container.innerHTML = `
        <div class="text-center py-12 px-4">
          <div class="text-4xl mb-2">🛣️</div>
          <p class="text-sm font-bold text-slate-300 day-text-dark">No active reports</p>
          <p class="text-xs text-slate-500 mt-1">Roads are clear! Tap "+ Report Incident Nearby" below if you spot traffic or a road hazard.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = sorted
      .map((report) => {
        const cat = REPORT_CATEGORIES[report.category] || REPORT_CATEGORIES.hazard;
        const hasUpvoted = state.upvotedIds.has(report.id);
        const totalDuration = Math.max(1, report.expiresAt - report.createdAt);
        const remainingPct = Math.max(
          5,
          Math.min(100, Math.round(((report.expiresAt - Date.now()) / totalDuration) * 100))
        );

        return `
          <div class="rounded-2xl bg-slate-900/90 day-bg-card border border-slate-800 p-3.5 shadow-md hover:border-slate-700 transition">
            <div class="flex items-start justify-between gap-2.5">
              <div class="flex items-start gap-3 min-w-0">
                <div class="w-11 h-11 rounded-xl flex items-center justify-center text-2xl shrink-0 border" style="background: ${cat.color}22; border-color: ${cat.color}66">
                  ${cat.icon}
                </div>
                <div class="min-w-0">
                  <div class="flex items-center gap-1.5 flex-wrap">
                    <span class="text-[10px] font-extrabold uppercase px-2 py-0.5 rounded border ${cat.badgeBg}">
                      ${cat.label} • ${report.subtype}
                    </span>
                    <span class="text-xs font-extrabold text-sky-400">
                      ${formatDistance(report.distanceM)} away
                    </span>
                  </div>
                  <h4 class="text-sm font-bold text-white day-text-dark truncate mt-1">
                    ${report.street}
                  </h4>
                  <p class="text-xs text-slate-400 day-text-muted mt-0.5">
                    ${report.note}
                  </p>
                </div>
              </div>
              <button
                onclick="window.PulseNav.locateFromDrawer('${report.id}')"
                title="View on Map"
                class="btn-tactile shrink-0 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-sky-400 text-xs font-bold border border-slate-700"
              >
                Map ⌖
              </button>
            </div>

            <div class="mt-3 mb-2">
              <div class="flex justify-between text-[10px] font-semibold text-slate-400 mb-1">
                <span>Reported ${formatTimeAgo(report.createdAt)}</span>
                <span class="text-amber-400">Auto-clears: ${formatExpiresIn(report.expiresAt)}</span>
              </div>
              <div class="w-full h-1 bg-slate-800 rounded-full overflow-hidden">
                <div class="h-full bg-amber-400 rounded-full" style="width: ${remainingPct}%"></div>
              </div>
            </div>

            <div class="flex items-center justify-between gap-2 pt-1.5 border-t border-slate-800/80">
              <span class="text-[11px] font-semibold text-slate-400">Still there?</span>
              <div class="flex items-center gap-2">
                <button
                  onclick="window.PulseNav.upvoteReport('${report.id}')"
                  class="btn-tactile px-3 py-1 rounded-lg text-xs font-bold flex items-center gap-1 ${
                    hasUpvoted
                      ? 'bg-emerald-500 text-slate-950'
                      : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/30'
                  }"
                >
                  👍 Yes (${report.upvotes})
                </button>
                <button
                  onclick="window.PulseNav.dismissReport('${report.id}')"
                  class="btn-tactile px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-rose-500/20 text-slate-400 hover:text-rose-300 text-xs font-semibold border border-slate-700"
                >
                  Cleared ✕
                </button>
              </div>
            </div>
          </div>
        `;
      })
      .join('');
  }

  // ==========================================
  // 7. LIVE NOMINATIM GEOCODING & POI SEARCH
  // ==========================================
  async function queryNominatimPlaces(query, boundedToView = false) {
    const q = query.trim();
    if (!q) return [];

    let viewboxParam = '';
    if (state.map) {
      const b = state.map.getBounds();
      viewboxParam = `&viewbox=${b.getWest()},${b.getNorth()},${b.getEast()},${b.getSouth()}${boundedToView ? '&bounded=1' : ''}`;
    }

    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&q=${encodeURIComponent(q)}${viewboxParam}`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];

    return data
      .map((item) => {
        const lat = parseFloat(item.lat);
        const lng = parseFloat(item.lon);
        const shortName = item.name || item.display_name.split(',')[0];
        const distM = getDistanceMeters(state.userPos.lat, state.userPos.lng, lat, lng);
        return {
          name: shortName,
          address: item.display_name,
          lat,
          lng,
          distM
        };
      })
      .sort((a, b) => a.distM - b.distM);
  }

  function renderDropdownResults(results, emptyMessage = 'No matching locations found.') {
    const dropdown = document.getElementById('searchDropdown');
    if (!results || results.length === 0) {
      dropdown.innerHTML = `
        <div class="px-4 py-3 text-xs text-slate-400 text-center">
          ${emptyMessage}
        </div>
      `;
      dropdown.classList.remove('hidden');
      return;
    }

    dropdown.innerHTML = results
      .map(
        (item, idx) => `
          <button
            data-res-idx="${idx}"
            class="search-result-live w-full text-left px-4 py-3 hover:bg-slate-800/80 flex items-center justify-between gap-3 transition"
          >
            <div class="flex items-center gap-3 min-w-0">
              <span class="w-9 h-9 rounded-xl bg-sky-500/20 border border-sky-400/40 flex items-center justify-center text-lg shrink-0">
                📍
              </span>
              <div class="min-w-0">
                <p class="text-sm font-bold text-white day-text-dark truncate">${item.name}</p>
                <p class="text-xs text-slate-400 day-text-muted truncate">${item.address}</p>
              </div>
            </div>
            <span class="text-xs font-bold text-sky-400 shrink-0">${formatDistance(item.distM)}</span>
          </button>
        `
      )
      .join('');

    dropdown.classList.remove('hidden');

    dropdown.querySelectorAll('.search-result-live').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-res-idx'), 10);
        const target = results[idx];
        if (target) {
          selectDestination({
            name: target.name,
            address: target.address,
            icon: '📍',
            lat: target.lat,
            lng: target.lng,
            streetHint: target.name
          });
        }
      });
    });
  }

  function setupSearchAndAutocomplete() {
    const input = document.getElementById('destinationInput');
    const dropdown = document.getElementById('searchDropdown');
    const clearBtn = document.getElementById('clearSearchBtn');

    let debounceTimer = null;

    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      const q = input.value.trim();
      clearBtn.classList.toggle('hidden', q.length === 0);

      if (q.length === 0) {
        dropdown.classList.add('hidden');
        if (state.selectedDestination || state.routes.length > 0) {
          cancelRouteSelection();
        }
        return;
      }

      if (q.length < 2) {
        dropdown.classList.add('hidden');
        return;
      }

      dropdown.innerHTML = `
        <div class="px-4 py-3 text-xs text-slate-400 flex items-center gap-2">
          <span class="inline-block w-2 h-2 rounded-full bg-sky-400 animate-ping"></span>
          Searching live addresses for "${q}"...
        </div>
      `;
      dropdown.classList.remove('hidden');

      debounceTimer = setTimeout(async () => {
        try {
          const results = await queryNominatimPlaces(q, false);
          renderDropdownResults(results, `No places found for "${q}". Try another street or city.`);
        } catch (err) {
          renderDropdownResults([], 'Unable to reach live geocoding service.');
        }
      }, 320);
    });

    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(debounceTimer);
        const q = input.value.trim();
        if (q.length < 2) return;
        const results = await queryNominatimPlaces(q, false);
        if (results.length > 0) {
          selectDestination({
            name: results[0].name,
            address: results[0].address,
            icon: '📍',
            lat: results[0].lat,
            lng: results[0].lng,
            streetHint: results[0].name
          });
        } else {
          renderDropdownResults([], `No places found for "${q}".`);
        }
      }
    });

    clearBtn.addEventListener('click', () => {
      input.value = '';
      clearBtn.classList.add('hidden');
      dropdown.classList.add('hidden');
      cancelRouteSelection();
    });

    // Live POI Category Chips
    document.querySelectorAll('.poi-chip').forEach((chip) => {
      chip.addEventListener('click', async () => {
        const query = chip.getAttribute('data-poi-query');
        if (!query) return;

        input.value = query;
        clearBtn.classList.remove('hidden');
        dropdown.innerHTML = `
          <div class="px-4 py-3 text-xs text-slate-400 flex items-center gap-2">
            <span class="inline-block w-2 h-2 rounded-full bg-sky-400 animate-ping"></span>
            Searching nearby ${query}...
          </div>
        `;
        dropdown.classList.remove('hidden');

        try {
          let results = await queryNominatimPlaces(query, true);
          if (results.length === 0) {
            results = await queryNominatimPlaces(query, false);
          }
          renderDropdownResults(results, `No nearby ${query} found in current map view.`);
        } catch (e) {
          renderDropdownResults([], 'Live POI search failed. Check your internet connection.');
        }
      });
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (!document.getElementById('searchHeader').contains(e.target)) {
        dropdown.classList.add('hidden');
      }
    });
  }

  // ==========================================
  // 8. LIVE OSRM ROUTING & POLYLINE RENDERING
  // ==========================================
  async function selectDestination(dest, isFromConvoySync = false) {
    // Enforce Leader-led routing when user is a follower member in an active convoy
    if (state.convoy.activeCode && state.convoy.role === 'member' && !isFromConvoySync) {
      showConvoyPingToast({
        senderName: 'Convoy Leader Lock',
        message: `Following ${state.convoy.leaderName || 'Leader'}'s shared route`,
        icon: '👑'
      });
      return;
    }

    if (state.isNavigating) {
      stopNavigation(false);
    }

    // Unique incrementing request ID so cancelled or stale requests are immediately dropped
    const currentRequestId = ++state.routingRequestId;
    state.selectedDestination = dest;
    document.getElementById('destinationInput').value = dest.name;
    document.getElementById('clearSearchBtn').classList.remove('hidden');
    document.getElementById('searchDropdown').classList.add('hidden');

    // Immediately remove previous marker and any active route lines from the map
    if (state.destMarker) {
      try {
        state.map.removeLayer(state.destMarker);
      } catch (e) {}
      state.destMarker = null;
    }
    state.routePolylines.forEach((line) => {
      try {
        state.map.removeLayer(line);
      } catch (e) {}
    });
    state.routePolylines = [];
    state.graphOverlayLayers.forEach((layer) => {
      try {
        state.map.removeLayer(layer);
      } catch (e) {}
    });
    state.graphOverlayLayers = [];

    const destIcon = L.divIcon({
      className: 'custom-dest-icon',
      html: `<div class="dest-marker-pin"><span>🏁</span></div>`,
      iconSize: [38, 38],
      iconAnchor: [19, 38]
    });

    state.destMarker = L.marker([dest.lat, dest.lng], {
      icon: destIcon,
      zIndexOffset: 900
    }).addTo(state.map);

    // Show route preview card in loading state
    ensureCleanRoutePreviewCardDom();
    document.getElementById('searchHeader').classList.add('hidden');
    document.getElementById('idleBottomBar').classList.add('hidden');
    document.getElementById('activeNavHud').classList.add('hidden');
    document.getElementById('routePreviewCard').classList.remove('hidden');
    document.getElementById('previewDestName').textContent = dest.name;
    document.getElementById('previewDestAddress').textContent = 'Calculating route...';

    const routes = await fetchLiveOsrmRoutes(state.userPos, dest);

    // CANCELLATION GUARD: If user deselected or cancelled while calculating, abort immediately
    if (state.routingRequestId !== currentRequestId || state.selectedDestination !== dest) {
      return;
    }

    if (!routes || routes.length === 0) {
      document.getElementById('previewDestAddress').textContent =
        'No driving route found between your GPS location and destination.';
      return;
    }

    state.routes = routes;
    state.selectedRouteIdx = 0;

    renderRoutePolylines(true);
    renderGraphTopologyOverlay();
    showRoutePreviewCard();

    if (state.convoy.activeCode && state.convoy.role === 'leader') {
      syncLeaderStateToConvoy('routing');
    }
  }

  // ==========================================
  // 8.5 GRAPH THEORY (G = V, E, W) + A* + DIJKSTRA PATHFINDING ENGINE
  // ==========================================

  /**
   * Binary Min-Heap Priority Queue for O((|V| + |E|) log |V|) A* and Dijkstra relaxation.
   */
  class MinPriorityQueue {
    constructor() {
      this.heap = [];
    }
    get size() {
      return this.heap.length;
    }
    push(nodeId, priority) {
      this.heap.push({ nodeId, priority });
      this._bubbleUp(this.heap.length - 1);
    }
    pop() {
      if (this.heap.length === 0) return null;
      const top = this.heap[0];
      const bottom = this.heap.pop();
      if (this.heap.length > 0) {
        this.heap[0] = bottom;
        this._sinkDown(0);
      }
      return top;
    }
    _bubbleUp(idx) {
      while (idx > 0) {
        const parentIdx = (idx - 1) >> 1;
        if (this.heap[parentIdx].priority <= this.heap[idx].priority) break;
        [this.heap[parentIdx], this.heap[idx]] = [this.heap[idx], this.heap[parentIdx]];
        idx = parentIdx;
      }
    }
    _sinkDown(idx) {
      const length = this.heap.length;
      while (true) {
        const left = (idx << 1) + 1;
        const right = left + 1;
        let smallest = idx;
        if (left < length && this.heap[left].priority < this.heap[smallest].priority) {
          smallest = left;
        }
        if (right < length && this.heap[right].priority < this.heap[smallest].priority) {
          smallest = right;
        }
        if (smallest === idx) break;
        [this.heap[idx], this.heap[smallest]] = [this.heap[smallest], this.heap[idx]];
        idx = smallest;
      }
    }
  }

  /**
   * Calculate dynamic hazard penalty w_hazard(u, v) in seconds for a directed road edge
   * based on proximity (<= 240m) to live community incident reports.
   */
  function computeEdgeHazardPenalty(edgeCoords, activeReports) {
    if (!edgeCoords || !edgeCoords.length || !activeReports || !activeReports.length) {
      return { penaltyS: 0, matchedReportIds: [] };
    }

    let penaltyS = 0;
    const matchedReportIds = [];

    for (const rep of activeReports) {
      let minDist = Infinity;
      const stride = Math.max(1, Math.floor(edgeCoords.length / 8));
      for (let i = 0; i < edgeCoords.length; i += stride) {
        const d = getDistanceMeters(rep.lat, rep.lng, edgeCoords[i][0], edgeCoords[i][1]);
        if (d < minDist) minDist = d;
      }
      const lastPt = edgeCoords[edgeCoords.length - 1];
      const dLast = getDistanceMeters(rep.lat, rep.lng, lastPt[0], lastPt[1]);
      if (dLast < minDist) minDist = dLast;

      if (minDist <= 240) {
        matchedReportIds.push(rep.id);
        let basePenalty = 55;
        const sub = String(rep.subtype || '').toLowerCase();
        if (rep.category === 'accident') {
          basePenalty = sub.includes('major') ? 190 : 115;
        } else if (rep.category === 'traffic') {
          basePenalty = sub.includes('gridlock') ? 175 : sub.includes('moderate') ? 95 : 50;
        } else if (rep.category === 'hazard') {
          basePenalty = sub.includes('construction') ? 90 : 55;
        } else if (rep.category === 'police') {
          basePenalty = 35;
        }
        // Scale slightly with community upvotes and proximity
        const upvoteFactor = 1 + Math.min(0.6, (Math.max(1, rep.upvotes || 1) - 1) * 0.12);
        const proximityFactor = 1 - (minDist / 260) * 0.45;
        penaltyS += Math.round(basePenalty * upvoteFactor * proximityFactor);
      }
    }

    return { penaltyS, matchedReportIds };
  }

  /**
   * Project point P(pLat, pLng) onto road segment AB(aLat, aLng -> bLat, bLng)
   * Returns { lat, lng, t, distM } where t in [0, 1].
   */
  function projectPointOnSegment(pLat, pLng, aLat, aLng, bLat, bLng) {
    const cosLat = Math.cos((pLat * Math.PI) / 180);
    const px = pLng * cosLat;
    const py = pLat;
    const ax = aLng * cosLat;
    const ay = aLat;
    const bx = bLng * cosLat;
    const by = bLat;

    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = 0;
    if (lenSq > 1e-14) {
      t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    }
    const projLat = aLat + t * (bLat - aLat);
    const projLng = aLng + t * (bLng - aLng);
    const distM = getDistanceMeters(pLat, pLng, projLat, projLng);
    return { lat: projLat, lng: projLng, t, distM };
  }

  /**
   * Query OpenStreetMap Overpass API for all local roads (including internal apartment/complex
   * service roads like Pangsapuri Seri Palma) within 350m of the user, build a local road network
   * graph G_local = (V, E, W), snap the user's GPS position to the nearest road inside their area,
   * and run A* pathfinding to find the true connected road exit out to the public street network.
   */
  async function resolveLocalOsmAccessPath(start, dest) {
    if (!start || !dest) return null;

    // 1. Check in-memory spatial cache first for instant (<1ms) local road graph retrieval
    const spatialKey = `${start.lat.toFixed(3)},${start.lng.toFixed(3)}`;
    let elements = state.localOsmWaysCache.get(spatialKey);

    if (!elements) {
      const query = `[out:json][timeout:3];way(around:350,${start.lat},${start.lng})["highway"~"^(service|residential|living_street|unclassified|tertiary|secondary|primary|trunk|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|road)$"];out geom;`;
      const endpoints = [
        `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`,
        `https://lz4.overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`,
        `https://overpass.kumi.systems/api/interpreter?data=${encodeURIComponent(query)}`
      ];

      const fetchMirror = async (url) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1200);
        try {
          const res = await fetch(url, { signal: controller.signal });
          clearTimeout(timer);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json = await res.json();
          if (json && Array.isArray(json.elements) && json.elements.length > 0) {
            return json.elements;
          }
          throw new Error('No elements');
        } catch (e) {
          clearTimeout(timer);
          throw e;
        }
      };

      try {
        elements = await Promise.any(endpoints.map((ep) => fetchMirror(ep)));
        if (elements && elements.length > 0) {
          state.localOsmWaysCache.set(spatialKey, elements);
        }
      } catch (err) {
        elements = null;
      }
    }

    if (!elements || !elements.length) return null;

    // Build local road graph G_local = (V, E, W)
    const nodes = new Map(); // nodeId -> { id, lat, lng, isPublicExit, streetName }
    const adj = new Map(); // nodeId -> Array<{ to, distM, weightS, street, highway }>
    const segments = [];

    const ensureNode = (id, lat, lng) => {
      if (!nodes.has(id)) {
        nodes.set(id, { id, lat, lng, isPublicExit: false, streetName: '' });
        adj.set(id, []);
      }
      return nodes.get(id);
    };

    const publicHighwayTypes = new Set([
      'residential',
      'unclassified',
      'tertiary',
      'secondary',
      'primary',
      'trunk',
      'primary_link',
      'secondary_link',
      'tertiary_link'
    ]);

    elements.forEach((way) => {
      if (!way.geometry || way.geometry.length < 2 || !way.nodes) return;
      const tags = way.tags || {};
      const hw = (tags.highway || 'road').toLowerCase();
      const access = (tags.access || '').toLowerCase();
      const streetName = tags.name || (hw === 'service' ? 'Internal Access Road' : 'Local Road');
      const isPublic = publicHighwayTypes.has(hw) && access !== 'private' && access !== 'no';
      const isOneway = tags.oneway === 'yes' || tags.oneway === '1';
      const isReverseOneway = tags.oneway === '-1';

      // Speed factor so A* travels along internal roads and exits onto collector roads
      const speedMs = hw === 'service' ? 7.5 : 11.5;

      for (let i = 0; i < way.geometry.length - 1; i++) {
        const nAId = `osm_${way.nodes[i]}`;
        const nBId = `osm_${way.nodes[i + 1]}`;
        const ptA = way.geometry[i];
        const ptB = way.geometry[i + 1];

        const nodeA = ensureNode(nAId, ptA.lat, ptA.lon);
        const nodeB = ensureNode(nBId, ptB.lat, ptB.lon);

        if (isPublic) {
          nodeA.isPublicExit = true;
          nodeB.isPublicExit = true;
          if (tags.name) {
            nodeA.streetName = tags.name;
            nodeB.streetName = tags.name;
          }
        }

        const distM = Math.max(1, getDistanceMeters(ptA.lat, ptA.lon, ptB.lat, ptB.lon));
        const weightS = distM / speedMs;

        segments.push({
          nAId,
          nBId,
          aLat: ptA.lat,
          aLng: ptA.lon,
          bLat: ptB.lat,
          bLng: ptB.lon,
          distM,
          weightS,
          streetName,
          hw,
          isPublic
        });

        // On internal service roads inside complexes, allow bidirectional exit discovery; on public roads respect oneway
        if (!isReverseOneway || hw === 'service') {
          adj.get(nAId).push({ to: nBId, distM, weightS, street: streetName, hw });
        }
        if (!isOneway || hw === 'service') {
          adj.get(nBId).push({ to: nAId, distM, weightS, street: streetName, hw });
        }
      }
    });

    if (!segments.length) return null;

    // Find the closest road segment to the user's exact GPS coordinates (e.g. inside Pangsapuri Seri Palma)
    let bestSeg = null;
    let bestProj = null;
    for (const seg of segments) {
      const proj = projectPointOnSegment(
        start.lat,
        start.lng,
        seg.aLat,
        seg.aLng,
        seg.bLat,
        seg.bLng
      );
      if (!bestProj || proj.distM < bestProj.distM) {
        bestProj = proj;
        bestSeg = seg;
      }
    }

    if (!bestSeg || !bestProj || bestProj.distM > 140) return null;

    // Insert virtual snapped origin node v_origin on the nearest local road segment
    const originId = 'v_local_origin';
    ensureNode(originId, bestProj.lat, bestProj.lng);
    const distToA = Math.max(1, getDistanceMeters(bestProj.lat, bestProj.lng, bestSeg.aLat, bestSeg.aLng));
    const distToB = Math.max(1, getDistanceMeters(bestProj.lat, bestProj.lng, bestSeg.bLat, bestSeg.bLng));
    adj.get(originId).push({
      to: bestSeg.nAId,
      distM: distToA,
      weightS: distToA / 8,
      street: bestSeg.streetName,
      hw: bestSeg.hw
    });
    adj.get(originId).push({
      to: bestSeg.nBId,
      distM: distToB,
      weightS: distToB / 8,
      street: bestSeg.streetName,
      hw: bestSeg.hw
    });

    // Run Dijkstra + A* Heuristic evaluation from originId to find the best reachable public road exit node
    const pq = new MinPriorityQueue();
    const gCost = new Map();
    const parentMap = new Map();
    for (const k of nodes.keys()) gCost.set(k, Infinity);
    gCost.set(originId, 0);
    pq.push(originId, 0);

    let bestExitNodeId = null;
    let bestExitScore = Infinity;

    while (pq.size > 0) {
      const curr = pq.pop();
      if (!curr) break;
      const uId = curr.nodeId;
      const uNode = nodes.get(uId);
      const g = gCost.get(uId);

      if (uNode && uNode.isPublicExit && uId !== originId) {
        // Combine local path cost g(n) with A* heuristic h(n) toward destination
        const hToDest = getDistanceMeters(uNode.lat, uNode.lng, dest.lat, dest.lng) / 22.0;
        const fScore = g + hToDest * 0.15;
        if (fScore < bestExitScore) {
          bestExitScore = fScore;
          bestExitNodeId = uId;
        }
      }

      for (const edge of adj.get(uId) || []) {
        const tentative = g + edge.weightS;
        if (tentative < gCost.get(edge.to)) {
          gCost.set(edge.to, tentative);
          parentMap.set(edge.to, { from: uId, edge });
          pq.push(edge.to, tentative);
        }
      }
    }

    if (!bestExitNodeId) {
      // Even if already on a public road, return the exact snapped point on the closest road
      return {
        handoverPoint: { lat: bestProj.lat, lng: bestProj.lng },
        accessCoords:
          bestProj.distM > 4
            ? [
                [start.lat, start.lng],
                [bestProj.lat, bestProj.lng]
              ]
            : [[bestProj.lat, bestProj.lng]],
        accessDistM: Math.round(bestProj.distM),
        accessDurS: Math.max(1, Math.round(bestProj.distM / 7)),
        exitStreet: bestSeg.streetName || 'Local Road'
      };
    }

    // Reconstruct local road access path from inside complex out to public collector road
    const pathCoords = [];
    let totalDistM = 0;
    let currId = bestExitNodeId;
    let exitStreet = nodes.get(bestExitNodeId)?.streetName || bestSeg.streetName || 'Local Road';

    while (currId && currId !== originId) {
      const n = nodes.get(currId);
      pathCoords.unshift([n.lat, n.lng]);
      const p = parentMap.get(currId);
      if (!p) break;
      totalDistM += p.edge.distM;
      if (p.edge.street && p.edge.street !== 'Internal Access Road') {
        exitStreet = p.edge.street;
      }
      currId = p.from;
    }

    pathCoords.unshift([bestProj.lat, bestProj.lng]);
    if (bestProj.distM > 4 && bestProj.distM <= 65) {
      pathCoords.unshift([start.lat, start.lng]);
      totalDistM += bestProj.distM;
    }

    const exitNode = nodes.get(bestExitNodeId);
    return {
      handoverPoint: { lat: exitNode.lat, lng: exitNode.lng },
      accessCoords: pathCoords,
      accessDistM: Math.round(totalDistM),
      accessDurS: Math.max(2, Math.round(totalDistM / 8.5)),
      exitStreet
    };
  }

  /**
   * Slice exact full-resolution OSRM route coordinates for each turn step so no road curves
   * are ever flattened into straight lines.
   */
  function extractExactStepCoordinateSlices(fullCoords, rawSteps) {
    if (!fullCoords || fullCoords.length < 2 || !rawSteps || !rawSteps.length) {
      return [fullCoords || []];
    }

    const stepStartIndices = [0];
    let searchFrom = 0;

    for (let i = 1; i < rawSteps.length; i++) {
      const loc = rawSteps[i].maneuver?.location;
      if (!loc) {
        stepStartIndices.push(Math.min(fullCoords.length - 1, searchFrom + 1));
        continue;
      }
      const mLat = loc[1];
      const mLng = loc[0];
      let bestIdx = searchFrom;
      let bestDist = Infinity;

      for (let j = searchFrom; j < fullCoords.length; j++) {
        const d = getDistanceMeters(mLat, mLng, fullCoords[j][0], fullCoords[j][1]);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = j;
        }
        // Stop searching ahead once we've passed the exact maneuver point (< 3m) and distance grows
        if (bestDist < 3 && d > 25) break;
      }
      stepStartIndices.push(bestIdx);
      searchFrom = bestIdx;
    }

    const slices = [];
    for (let i = 0; i < rawSteps.length; i++) {
      const startIdx = stepStartIndices[i];
      const endIdx = i === rawSteps.length - 1 ? fullCoords.length - 1 : stepStartIndices[i + 1];
      if (endIdx > startIdx) {
        slices.push(fullCoords.slice(startIdx, endIdx + 1));
      } else {
        slices.push([
          fullCoords[startIdx],
          fullCoords[Math.min(fullCoords.length - 1, startIdx + 1)]
        ]);
      }
    }
    return slices;
  }

  /**
   * Construct a Weighted Directed Road Network Graph G = (V, E, W) from OSRM candidate routes.
   * Preserves 100% of full-resolution road curve coordinates while modeling junctions as vertices V
   * and road segments as weighted directed edges E.
   */
  function buildRoadNetworkGraph(osrmCandidateRoutes, destName, activeReports = []) {
    const vertices = new Map();
    const adjacency = new Map();
    const edges = [];

    const findOrCreateVertex = (lat, lng, label = 'Road Node', isJunction = false, snapRadiusM = 8) => {
      for (const v of vertices.values()) {
        if (getDistanceMeters(lat, lng, v.lat, v.lng) <= snapRadiusM) {
          if (isJunction) v.isJunction = true;
          if (label && v.label === 'Road Node') v.label = label;
          return v.id;
        }
      }
      const id = `v_${vertices.size}`;
      vertices.set(id, {
        id,
        lat,
        lng,
        label,
        isJunction,
        degree: 0,
        exploredByAStar: false,
        exploredByDijkstra: false,
        onOptimalPath: false
      });
      adjacency.set(id, []);
      return id;
    };

    const firstRoute = osrmCandidateRoutes[0];
    const firstCoord = firstRoute.coords[0];
    const lastCoord = firstRoute.coords[firstRoute.coords.length - 1];

    const startNodeId = findOrCreateVertex(firstCoord[0], firstCoord[1], 'Origin (GPS)', true, 6);
    const goalNodeId = findOrCreateVertex(lastCoord[0], lastCoord[1], destName || 'Destination', true, 6);

    let hazardEdgeCount = 0;

    osrmCandidateRoutes.forEach((cand, routeIdx) => {
      const rawSteps = cand.rawSteps || [];
      let prevNodeId = startNodeId;

      // Prepend local OSM complex access edge if resolved (e.g., exiting Pangsapuri Seri Palma)
      if (cand.localAccess && cand.localAccess.accessCoords && cand.localAccess.accessCoords.length >= 2) {
        const acc = cand.localAccess;
        const endAccPt = acc.accessCoords[acc.accessCoords.length - 1];
        const handoverNodeId = findOrCreateVertex(
          endAccPt[0],
          endAccPt[1],
          acc.exitStreet || 'Local Exit',
          true,
          8
        );
        if (handoverNodeId !== prevNodeId) {
          const { penaltyS, matchedReportIds } = computeEdgeHazardPenalty(
            acc.accessCoords,
            activeReports
          );
          const accEdge = {
            id: `e_${edges.length}`,
            from: prevNodeId,
            to: handoverNodeId,
            routeIdx,
            street: acc.exitStreet || 'Local Access Road',
            distanceM: acc.accessDistM,
            baseDurationS: acc.accessDurS,
            hazardPenaltyS: penaltyS,
            matchedReportIds,
            weightS: acc.accessDurS + penaltyS,
            coords: acc.accessCoords,
            stepMeta: {
              instruction: `Proceed onto ${acc.exitStreet || 'main road'}`,
              street: acc.exitStreet || 'Local Access Road',
              distanceM: acc.accessDistM,
              maneuverType: 'depart',
              maneuverModifier: '',
              isJunctionOrLaneTurn: false,
              maneuverIcon: '⬆️',
              actionLabel: 'Continue',
              location: acc.accessCoords[0]
            }
          };
          edges.push(accEdge);
          adjacency.get(prevNodeId).push(accEdge);
          vertices.get(prevNodeId).degree++;
          vertices.get(handoverNodeId).degree++;
          prevNodeId = handoverNodeId;
        }
      }

      if (rawSteps.length > 0) {
        const stepCoordSlices = extractExactStepCoordinateSlices(cand.osrmCoreCoords || cand.coords, rawSteps);

        rawSteps.forEach((s, sIdx) => {
          const stepCoords = stepCoordSlices[sIdx] || [];
          if (stepCoords.length < 2) return;

          const stepDistM = Math.max(5, Math.round(s.distance || 10));
          const stepDurS = Math.max(1, Math.round(s.duration || stepDistM / 13.5));
          const isTurn = isJunctionTurnOrLaneChange(s.maneuver);
          const streetName = s.name || 'Roadway';

          const endPt = stepCoords[stepCoords.length - 1];
          const isFinalStep = sIdx === rawSteps.length - 1;
          const nextNodeId = isFinalStep
            ? goalNodeId
            : findOrCreateVertex(endPt[0], endPt[1], streetName, isTurn, 8);

          if (nextNodeId === prevNodeId && !isFinalStep) return;

          const { penaltyS, matchedReportIds } = computeEdgeHazardPenalty(stepCoords, activeReports);
          if (penaltyS > 0) hazardEdgeCount++;

          const corridorBiasS = routeIdx * 0.25;

          const edge = {
            id: `e_${edges.length}`,
            from: prevNodeId,
            to: nextNodeId,
            routeIdx,
            street: streetName,
            distanceM: stepDistM,
            baseDurationS: stepDurS,
            hazardPenaltyS: penaltyS,
            matchedReportIds,
            weightS: stepDurS + penaltyS + corridorBiasS,
            coords: stepCoords,
            stepMeta: {
              instruction: formatOsrmStepInstruction(s, destName),
              street: streetName,
              distanceM: stepDistM,
              maneuverType: (s.maneuver?.type || 'continue').toLowerCase(),
              maneuverModifier: (s.maneuver?.modifier || '').toLowerCase(),
              isJunctionOrLaneTurn: isTurn,
              maneuverIcon: getManeuverIcon(s.maneuver?.modifier || s.maneuver?.type),
              actionLabel: getManeuverLabel(
                s.maneuver?.modifier || s.maneuver?.type,
                isFinalStep
              ),
              location: s.maneuver?.location
                ? [s.maneuver.location[1], s.maneuver.location[0]]
                : stepCoords[0]
            }
          };

          edges.push(edge);
          adjacency.get(prevNodeId).push(edge);
          vertices.get(prevNodeId).degree++;
          vertices.get(nextNodeId).degree++;
          prevNodeId = nextNodeId;
        });

        if (prevNodeId !== goalNodeId) {
          const u = vertices.get(prevNodeId);
          const v = vertices.get(goalNodeId);
          const d = Math.max(5, Math.round(getDistanceMeters(u.lat, u.lng, v.lat, v.lng)));
          const dur = Math.max(1, Math.round(d / 13.5));
          const edge = {
            id: `e_${edges.length}`,
            from: prevNodeId,
            to: goalNodeId,
            routeIdx,
            street: destName || 'Destination',
            distanceM: d,
            baseDurationS: dur,
            hazardPenaltyS: 0,
            matchedReportIds: [],
            weightS: dur,
            coords: [
              [u.lat, u.lng],
              [v.lat, v.lng]
            ],
            stepMeta: null
          };
          edges.push(edge);
          adjacency.get(prevNodeId).push(edge);
        }
      }
    });

    return {
      vertices,
      adjacency,
      edges,
      startNodeId,
      goalNodeId,
      hazardEdgeCount
    };
  }

  /**
   * Admissible Haversine Heuristic h(n) for A* Search:
   * Straight-line great-circle distance divided by max highway speed (30.5 m/s ≈ 110 km/h)
   * guarantees h(n) <= true optimal cost h*(n) so A* is strictly optimal.
   */
  function aStarHeuristicSeconds(node, goalNode) {
    const straightDistM = getDistanceMeters(node.lat, node.lng, goalNode.lat, goalNode.lng);
    const MAX_SPEED_MS = 30.5;
    return straightDistM / MAX_SPEED_MS;
  }

  /**
   * Reconstruct full route object (coords, steps, distance, duration, hazard penalty) from an edge path.
   */
  function reconstructRouteFromEdgePath(edgePath, destName, labelPrefix, algorithmTag) {
    if (!edgePath || !edgePath.length) return null;

    const coords = [];
    const steps = [];
    let distanceM = 0;
    let baseDurationS = 0;
    let hazardPenaltyS = 0;
    const majorStreets = [];

    edgePath.forEach((edge) => {
      distanceM += edge.distanceM;
      baseDurationS += edge.baseDurationS;
      hazardPenaltyS += edge.hazardPenaltyS;

      if (
        edge.street &&
        edge.street !== 'Roadway' &&
        edge.street !== destName &&
        !majorStreets.includes(edge.street)
      ) {
        majorStreets.push(edge.street);
      }

      edge.coords.forEach((pt, idx) => {
        if (coords.length > 0 && idx === 0) return;
        coords.push(pt);
      });

      if (edge.stepMeta) {
        steps.push({ ...edge.stepMeta });
      }
    });

    if (steps.length === 0 && coords.length >= 2) {
      steps.push({
        instruction: `Arrive at ${destName}`,
        street: destName,
        distanceM,
        maneuverType: 'arrive',
        maneuverModifier: '',
        isJunctionOrLaneTurn: false,
        maneuverIcon: '🏁',
        actionLabel: 'Arrive',
        location: coords[coords.length - 1]
      });
    }

    const viaLabel = majorStreets.slice(0, 2).join(' & ') || 'Primary Route';
    return {
      coords,
      distanceM,
      baseDurationS,
      hazardPenaltyS,
      durationS: baseDurationS + hazardPenaltyS,
      steps,
      edgeIds: new Set(edgePath.map((e) => e.id)),
      summary: `Via ${viaLabel}`,
      algorithmTag
    };
  }

  /**
   * A* Pathfinding Algorithm: f(n) = g(n) + h(n)
   * Finds the minimum hazard-weighted time path from startNodeId to goalNodeId using admissible Haversine heuristic.
   */
  function runAStarPathfinding(graph, startNodeId, goalNodeId, excludedEdgeIds = new Set()) {
    const t0 = performance.now();
    const goalNode = graph.vertices.get(goalNodeId);
    const openQueue = new MinPriorityQueue();
    const gScore = new Map();
    const fScore = new Map();
    const cameFromEdge = new Map();
    const closedSet = new Set();

    for (const vId of graph.vertices.keys()) {
      gScore.set(vId, Infinity);
      fScore.set(vId, Infinity);
    }

    const startNode = graph.vertices.get(startNodeId);
    gScore.set(startNodeId, 0);
    const h0 = aStarHeuristicSeconds(startNode, goalNode);
    fScore.set(startNodeId, h0);
    openQueue.push(startNodeId, h0);

    let nodesExplored = 0;
    let edgesRelaxed = 0;
    let heuristicEvaluations = 1;

    while (openQueue.size > 0) {
      const current = openQueue.pop();
      if (!current) break;
      const uId = current.nodeId;

      if (closedSet.has(uId)) continue;
      closedSet.add(uId);
      nodesExplored++;

      const uVertex = graph.vertices.get(uId);
      if (uVertex) uVertex.exploredByAStar = true;

      if (uId === goalNodeId) break;

      const outgoing = graph.adjacency.get(uId) || [];
      for (const edge of outgoing) {
        if (excludedEdgeIds.has(edge.id)) continue;
        const vId = edge.to;
        if (closedSet.has(vId)) continue;

        edgesRelaxed++;
        const tentativeG = gScore.get(uId) + edge.weightS;

        if (tentativeG < gScore.get(vId)) {
          cameFromEdge.set(vId, edge);
          gScore.set(vId, tentativeG);
          const vNode = graph.vertices.get(vId);
          const h = aStarHeuristicSeconds(vNode, goalNode);
          heuristicEvaluations++;
          const f = tentativeG + h;
          fScore.set(vId, f);
          openQueue.push(vId, f);
        }
      }
    }

    const edgePath = [];
    let curr = goalNodeId;
    while (curr !== startNodeId && cameFromEdge.has(curr)) {
      const edge = cameFromEdge.get(curr);
      edgePath.unshift(edge);
      const vObj = graph.vertices.get(curr);
      if (vObj) vObj.onOptimalPath = true;
      curr = edge.from;
    }
    if (graph.vertices.has(startNodeId)) {
      graph.vertices.get(startNodeId).onOptimalPath = true;
    }

    return {
      edgePath,
      nodesExplored,
      edgesRelaxed,
      heuristicEvaluations,
      totalCostS: gScore.get(goalNodeId),
      elapsedMs: Math.max(0.1, +(performance.now() - t0).toFixed(2))
    };
  }

  /**
   * Dijkstra's Shortest-Path Algorithm: f(n) = g(n), h(n) = 0
   * Uniform-cost shortest-path relaxation over G = (V, E, W).
   * Supports costMode = 'time_hazard' | 'shortest_distance' and optional edge penalties for alternative path discovery.
   */
  function runDijkstraPathfinding(
    graph,
    startNodeId,
    goalNodeId,
    costMode = 'time_hazard',
    penalizedEdgeIds = new Set()
  ) {
    const t0 = performance.now();
    const pq = new MinPriorityQueue();
    const dist = new Map();
    const cameFromEdge = new Map();
    const visited = new Set();

    for (const vId of graph.vertices.keys()) {
      dist.set(vId, Infinity);
    }

    dist.set(startNodeId, 0);
    pq.push(startNodeId, 0);

    let nodesExplored = 0;
    let edgesRelaxed = 0;

    while (pq.size > 0) {
      const current = pq.pop();
      if (!current) break;
      const uId = current.nodeId;

      if (visited.has(uId)) continue;
      visited.add(uId);
      nodesExplored++;

      const uVertex = graph.vertices.get(uId);
      if (uVertex) uVertex.exploredByDijkstra = true;

      if (uId === goalNodeId) break;

      const outgoing = graph.adjacency.get(uId) || [];
      for (const edge of outgoing) {
        const vId = edge.to;
        if (visited.has(vId)) continue;

        edgesRelaxed++;
        let baseEdgeCost =
          costMode === 'shortest_distance'
            ? edge.distanceM + edge.hazardPenaltyS * 11
            : edge.weightS;

        // Apply Yen's / Suurballe-style overlap penalty when finding the distinct Dijkstra alternative path
        if (penalizedEdgeIds.has(edge.id)) {
          baseEdgeCost *= 2.6;
        }

        const alt = dist.get(uId) + baseEdgeCost;
        if (alt < dist.get(vId)) {
          dist.set(vId, alt);
          cameFromEdge.set(vId, edge);
          pq.push(vId, alt);
        }
      }
    }

    const edgePath = [];
    let curr = goalNodeId;
    while (curr !== startNodeId && cameFromEdge.has(curr)) {
      const edge = cameFromEdge.get(curr);
      edgePath.unshift(edge);
      curr = edge.from;
    }

    return {
      edgePath,
      nodesExplored,
      edgesRelaxed,
      totalCost: dist.get(goalNodeId),
      elapsedMs: Math.max(0.1, +(performance.now() - t0).toFixed(2))
    };
  }

  /**
   * Build the road network graph G=(V,E,W) from OSRM candidates and run both A* and Dijkstra
   * to produce the primary A* Heuristic Route and the Dijkstra Shortest/Alternative Route.
   */
  function solveRoutesWithGraphAlgorithms(osrmCandidates, destName) {
    if (!osrmCandidates || !osrmCandidates.length) return [];

    const graph = buildRoadNetworkGraph(osrmCandidates, destName, state.reports);
    state.roadGraph = graph;

    // 1. Run A* Search f(n) = g(n) + h(n) for optimal hazard-aware route
    const aStarRes = runAStarPathfinding(graph, graph.startNodeId, graph.goalNodeId);

    // 2. Run pure Dijkstra f(n) = g(n) on identical weights to benchmark exploration vs A*
    const dijkstraBenchmark = runDijkstraPathfinding(
      graph,
      graph.startNodeId,
      graph.goalNodeId,
      'time_hazard',
      new Set()
    );

    const primaryRoute = reconstructRouteFromEdgePath(
      aStarRes.edgePath,
      destName,
      'A* Optimal',
      `A* Search f(n)=g+h`
    );

    const solvedRoutes = [];
    if (primaryRoute) {
      solvedRoutes.push(primaryRoute);
    }

    // 3. Run Dijkstra Shortest-Distance / Alternative Path search (penalizing primary edges if alternative corridor exists)
    const dijkstraAltRes = runDijkstraPathfinding(
      graph,
      graph.startNodeId,
      graph.goalNodeId,
      'shortest_distance',
      primaryRoute ? primaryRoute.edgeIds : new Set()
    );

    const dijkstraAltRoute = reconstructRouteFromEdgePath(
      dijkstraAltRes.edgePath,
      destName,
      'Dijkstra Path',
      `Dijkstra Shortest g(n)`
    );

    if (dijkstraAltRoute) {
      const isDistinctCorridor =
        !primaryRoute ||
        Math.abs(dijkstraAltRoute.distanceM - primaryRoute.distanceM) > 15 ||
        dijkstraAltRes.edgePath.some((e) => !primaryRoute.edgeIds.has(e.id));

      if (isDistinctCorridor || osrmCandidates.length > 1) {
        solvedRoutes.push(dijkstraAltRoute);
      }
    }

    state.graphTelemetry = {
      vertexCount: graph.vertices.size,
      edgeCount: graph.edges.length,
      hazardEdgeCount: graph.hazardEdgeCount,
      aStar: aStarRes,
      dijkstra: dijkstraBenchmark
    };

    return solvedRoutes;
  }

  /**
   * Re-evaluate dynamic edge weights w(u, v) on the active road graph when community reports change.
   */
  function recomputeGraphWeightsFromReports() {
    if (!state.rawOsrmRoutes || !state.rawOsrmRoutes.length || !state.selectedDestination) {
      updateRouteIncidentCount();
      return;
    }

    const prevIdx = state.selectedRouteIdx;
    const updatedRoutes = solveRoutesWithGraphAlgorithms(
      state.rawOsrmRoutes,
      state.selectedDestination.name
    );

    if (updatedRoutes.length > 0) {
      state.routes = updatedRoutes;
      state.selectedRouteIdx = Math.min(prevIdx, updatedRoutes.length - 1);
      renderRoutePolylines(false);
      renderGraphTopologyOverlay();
      if (!state.isNavigating) {
        showRoutePreviewCard();
      } else {
        updateRouteIncidentCount();
      }
    }
  }

  /**
   * Render or clear the interactive Road Network Graph G=(V,E,W) overlay on the Leaflet map.
   */
  function renderGraphTopologyOverlay() {
    state.graphOverlayLayers.forEach((layer) => state.map.removeLayer(layer));
    state.graphOverlayLayers = [];

    const btnLabel = document.getElementById('toggleGraphNodesLabel');
    if (btnLabel) {
      btnLabel.textContent = state.showGraphOverlay
        ? 'Hide Graph G(V,E)'
        : 'Show Graph G(V,E)';
    }

    if (!state.showGraphOverlay || !state.roadGraph) return;

    const graph = state.roadGraph;

    // Draw directed graph edges e in E with hazard weight coloring
    graph.edges.forEach((edge) => {
      const hasHazard = edge.hazardPenaltyS > 0;
      const edgeLine = L.polyline(edge.coords, {
        color: hasHazard ? '#f43f5e' : '#818cf8',
        weight: hasHazard ? 4 : 2.5,
        opacity: hasHazard ? 0.9 : 0.65,
        dashArray: '4, 6'
      }).addTo(state.map);

      edgeLine.bindTooltip(
        `Edge ${edge.id} (${edge.from} → ${edge.to}) | d=${edge.distanceM}m | w(u,v)=${Math.round(edge.weightS)}s${
          hasHazard ? ` (+${edge.hazardPenaltyS}s hazard penalty)` : ''
        }`,
        { sticky: true, direction: 'top' }
      );
      state.graphOverlayLayers.push(edgeLine);
    });

    // Draw graph intersection vertices v in V
    graph.vertices.forEach((v) => {
      const isEndpoint = v.id === graph.startNodeId || v.id === graph.goalNodeId;
      const color = isEndpoint
        ? '#10b981'
        : v.onOptimalPath
          ? '#38bdf8'
          : v.isJunction
            ? '#f59e0b'
            : '#a855f7';

      const nodeMarker = L.circleMarker([v.lat, v.lng], {
        radius: isEndpoint ? 7 : v.isJunction ? 5.5 : 4,
        color: '#0f172a',
        weight: 1.5,
        fillColor: color,
        fillOpacity: 0.95
      }).addTo(state.map);

      nodeMarker.bindTooltip(
        `Vertex ${v.id}: ${v.label} | deg(v)=${v.degree} | ${
          v.onOptimalPath ? 'A* Optimal Path' : 'Explored by Dijkstra'
        }`,
        { direction: 'top' }
      );

      state.graphOverlayLayers.push(nodeMarker);
    });
  }

  function toggleGraphOverlay() {
    state.showGraphOverlay = !state.showGraphOverlay;
    renderGraphTopologyOverlay();
  }

  async function fetchLiveOsrmRoutes(start, dest) {
    try {
      // 1. Fetch OSRM driving route and resolve local complex access concurrently in parallel
      const osrmPromise = (async () => {
        const url = `https://router.project-osrm.org/route/v1/driving/${start.lng},${start.lat};${dest.lng},${dest.lat}?overview=full&geometries=geojson&steps=true&alternatives=true`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4500);
        try {
          const res = await fetch(url, { signal: controller.signal });
          clearTimeout(timeout);
          if (!res.ok) return null;
          return await res.json();
        } catch (err) {
          clearTimeout(timeout);
          return null;
        }
      })();

      const localAccessPromise = resolveLocalOsmAccessPath(start, dest).catch(() => null);

      const [data, localAccess] = await Promise.all([osrmPromise, localAccessPromise]);

      if (!data || !data.routes || !data.routes.length) return [];

      const osrmCandidates = data.routes.slice(0, 3).map((r, idx) => {
        const osrmCoreCoords = r.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
        
        let coords = osrmCoreCoords;
        if (localAccess && Array.isArray(localAccess.accessCoords) && localAccess.accessCoords.length >= 2) {
          const handoverPt = localAccess.accessCoords[localAccess.accessCoords.length - 1];
          const firstOsrmPt = osrmCoreCoords[0];
          const gapM = getDistanceMeters(handoverPt[0], handoverPt[1], firstOsrmPt[0], firstOsrmPt[1]);
          if (gapM < 60) {
            coords = [...localAccess.accessCoords, ...osrmCoreCoords.slice(1)];
          } else {
            coords = [...localAccess.accessCoords, ...osrmCoreCoords];
          }
        } else if (osrmCoreCoords.length > 0) {
          const distToFirst = getDistanceMeters(start.lat, start.lng, osrmCoreCoords[0][0], osrmCoreCoords[0][1]);
          if (distToFirst > 4 && distToFirst < 150) {
            coords = [[start.lat, start.lng], ...osrmCoreCoords];
          }
        }

        const rawSteps = (r.legs && r.legs[0] && r.legs[0].steps) || [];
        const steps = rawSteps.map((s, sIdx) => ({
          instruction: formatOsrmStepInstruction(s, dest.name),
          street: s.name || dest.streetHint || 'Roadway',
          distanceM: Math.max(5, Math.round(s.distance)),
          maneuverType: (s.maneuver?.type || 'continue').toLowerCase(),
          maneuverModifier: (s.maneuver?.modifier || '').toLowerCase(),
          isJunctionOrLaneTurn: isJunctionTurnOrLaneChange(s.maneuver),
          maneuverIcon: getManeuverIcon(s.maneuver?.modifier || s.maneuver?.type),
          actionLabel: getManeuverLabel(
            s.maneuver?.modifier || s.maneuver?.type,
            sIdx === rawSteps.length - 1
          ),
          location: s.maneuver?.location
            ? [s.maneuver.location[1], s.maneuver.location[0]]
            : coords[coords.length - 1]
        }));

        const summaryLeg = r.legs && r.legs[0] && r.legs[0].summary;
        return {
          coords,
          osrmCoreCoords,
          localAccess,
          rawSteps,
          distanceM: Math.round(r.distance) + (localAccess ? localAccess.accessDistM : 0),
          durationS: Math.round(r.duration) + (localAccess ? localAccess.accessDurS : 0),
          steps,
          summary: summaryLeg
            ? `Via ${summaryLeg}`
            : idx === 0
              ? `Via ${steps[0]?.street || 'Primary Route'}`
              : 'Alternative Route'
        };
      });

      state.rawOsrmRoutes = osrmCandidates;
      const graphSolvedRoutes = solveRoutesWithGraphAlgorithms(osrmCandidates, dest.name);
      return graphSolvedRoutes.length ? graphSolvedRoutes : osrmCandidates.slice(0, 2);
    } catch (e) {
      console.warn('Live OSRM routing error:', e);
      return [];
    }
  }

  function isJunctionTurnOrLaneChange(maneuver) {
    if (!maneuver) return false;
    const type = (maneuver.type || '').toLowerCase();
    const mod = (maneuver.modifier || '').toLowerCase();

    // Exclude depart/arrive/straight-ahead continuation unless a lane/turn direction is required
    if (type === 'depart' || type === 'arrive') return false;

    const junctionTypes = new Set([
      'turn',
      'fork',
      'merge',
      'on ramp',
      'off ramp',
      'ramp',
      'roundabout',
      'rotary',
      'roundabout turn',
      'exit roundabout',
      'exit rotary',
      'end of road'
    ]);

    if (junctionTypes.has(type)) return true;

    // Also include explicit left/right/uturn lane changes even on 'continue' or 'new name'
    if (
      mod.includes('left') ||
      mod.includes('right') ||
      mod.includes('uturn')
    ) {
      return true;
    }

    return false;
  }

  function formatOsrmStepInstruction(step, destName) {
    const type = (step.maneuver?.type || 'continue').toLowerCase();
    const mod = (step.maneuver?.modifier || '').toLowerCase();
    const street = step.name ? `onto ${step.name}` : 'ahead';
    if (type === 'arrive') return `Arrive at ${destName}`;
    if (type === 'depart') return `Head ${mod || 'forward'} ${street}`;
    if (type === 'fork' || type === 'off ramp' || type === 'on ramp' || type === 'ramp') {
      const dir = mod.includes('left') ? 'Keep left' : mod.includes('right') ? 'Keep right' : 'Take ramp';
      return `${dir} ${street}`;
    }
    if (type === 'merge') {
      return `Merge ${mod ? `${mod} ` : ''}${street}`;
    }
    if (type.includes('roundabout') || type.includes('rotary')) {
      return `At the roundabout, take the exit ${street}`;
    }
    return `${getManeuverLabel(mod || type, false)} ${street}`;
  }

  function getManeuverIcon(modifierOrType = '') {
    const m = modifierOrType.toLowerCase();
    if (m.includes('left')) return '↰';
    if (m.includes('right')) return '↱';
    if (m.includes('uturn')) return '⮌';
    if (m.includes('arrive')) return '🏁';
    return '⬆️';
  }

  function getManeuverLabel(modifierOrType = '', isLast = false) {
    if (isLast) return 'Arrive';
    const m = modifierOrType.toLowerCase();
    if (m.includes('slight left')) return 'Keep Left';
    if (m.includes('left')) return 'Turn Left';
    if (m.includes('slight right')) return 'Keep Right';
    if (m.includes('right')) return 'Turn Right';
    if (m.includes('uturn')) return 'Make U-Turn';
    return 'Continue';
  }

  function renderRoutePolylines(fitToBounds = true) {
    state.routePolylines.forEach((line) => {
      try {
        state.map.removeLayer(line);
      } catch (e) {}
    });
    state.routePolylines = [];

    // Never render if user has cleared or deselected destination
    if (!state.selectedDestination || !state.routes.length) return;

    // Draw unselected alternative first
    state.routes.forEach((route, idx) => {
      if (idx === state.selectedRouteIdx) return;
      const altLine = L.polyline(route.coords, {
        color: '#64748b',
        weight: 6,
        opacity: 0.75,
        lineCap: 'round',
        lineJoin: 'round'
      })
        .addTo(state.map)
        .on('click', () => {
          selectRouteAlternative(idx);
        });
      state.routePolylines.push(altLine);
    });

    // Draw selected route with solid outer casing + solid bright inner line
    const primary = state.routes[state.selectedRouteIdx];
    const glowLine = L.polyline(primary.coords, {
      color: '#0284c7',
      weight: 10,
      opacity: 0.85,
      lineCap: 'round',
      lineJoin: 'round'
    }).addTo(state.map);

    const coreLine = L.polyline(primary.coords, {
      color: '#38bdf8',
      weight: 6,
      opacity: 1,
      lineCap: 'round',
      lineJoin: 'round'
    }).addTo(state.map);

    state.routePolylines.push(glowLine, coreLine);

    if (fitToBounds) {
      const bounds = L.latLngBounds(primary.coords);
      state.map.fitBounds(bounds, { padding: [70, 70], maxZoom: 16 });
      setFollowMode(false);
    }
  }

  function countReportsAlongRoute(route) {
    if (!route || !route.coords) return 0;
    let count = 0;
    state.reports.forEach((rep) => {
      const near = route.coords.some(
        ([lat, lng]) => getDistanceMeters(rep.lat, rep.lng, lat, lng) < 240
      );
      if (near) count++;
    });
    return count;
  }

  function updateRouteIncidentCount() {
    const route = state.routes[state.selectedRouteIdx];
    if (!route) return;
    const count = countReportsAlongRoute(route);
    const pill = document.getElementById('routeIncidentCountPill');
    pill.textContent = count === 1 ? '1 Report on route' : `${count} Reports on route`;
  }

  function ensureCleanRoutePreviewCardDom() {
    const card = document.getElementById('routePreviewCard');
    if (!card) return;

    // Guard against Live Server DOM hot-patcher merging flex row classes or stale telemetry nodes
    card.classList.remove('flex', 'items-center', 'justify-between', 'gap-3');
    const staleTelemetry = document.getElementById('graphTelemetryPanel');
    if (staleTelemetry) staleTelemetry.remove();
    const staleBtn = document.getElementById('toggleGraphNodesBtn');
    if (staleBtn) staleBtn.remove();

    // Remove any leftover badge spans other than #routeIncidentCountPill inside the top badge row
    const pill = document.getElementById('routeIncidentCountPill');
    if (pill && pill.parentElement) {
      Array.from(pill.parentElement.children).forEach((child) => {
        if (child.id !== 'routeIncidentCountPill') {
          child.remove();
        }
      });
    }
  }

  function showRoutePreviewCard() {
    const dest = state.selectedDestination;
    const primary = state.routes[state.selectedRouteIdx];
    if (!dest || !primary) return;

    ensureCleanRoutePreviewCardDom();

    document.getElementById('searchHeader').classList.add('hidden');
    document.getElementById('idleBottomBar').classList.add('hidden');
    document.getElementById('activeNavHud').classList.add('hidden');
    document.getElementById('routePreviewCard').classList.remove('hidden');

    document.getElementById('previewDestName').textContent = dest.name;
    document.getElementById('previewDestAddress').textContent = primary.summary;
    document.getElementById('previewEta').textContent = formatETA(primary.durationS);
    document.getElementById('previewDistance').textContent = formatDistance(primary.distanceM);

    const altContainer = document.getElementById('routeAlternativesContainer');
    const alt1Btn = document.getElementById('alt1Btn');

    const alt0Title = document.getElementById('alt0Title');
    if (alt0Title) alt0Title.textContent = 'Primary Route';
    const alt1Title = document.getElementById('alt1Title');
    if (alt1Title) alt1Title.textContent = 'Alternative';

    if (state.routes[0]) {
      document.getElementById('alt0Time').textContent = formatDuration(state.routes[0].durationS);
      document.getElementById('alt0Dist').textContent = formatDistance(state.routes[0].distanceM);
      const alt0Tag = document.getElementById('alt0Tag');
      if (alt0Tag) {
        alt0Tag.textContent = 'Fastest';
      }
    }

    if (state.routes[1]) {
      alt1Btn.classList.remove('hidden');
      altContainer.className = 'grid grid-cols-2 gap-2 mb-3.5';
      document.getElementById('alt1Time').textContent = formatDuration(state.routes[1].durationS);
      document.getElementById('alt1Dist').textContent = formatDistance(state.routes[1].distanceM);
      document.getElementById('alt1Tag').textContent = state.routes[1].summary || 'Option 2';
    } else {
      alt1Btn.classList.add('hidden');
      altContainer.className = 'grid grid-cols-1 gap-2 mb-3.5';
    }

    updateRouteIncidentCount();
    highlightSelectedRouteTab();
  }

  function selectRouteAlternative(idx) {
    if (!state.routes[idx]) return;
    state.selectedRouteIdx = idx;
    renderRoutePolylines(true);
    showRoutePreviewCard();
  }

  function highlightSelectedRouteTab() {
    document.querySelectorAll('.route-alt-btn').forEach((btn) => {
      const idx = parseInt(btn.getAttribute('data-route-idx'), 10);
      if (idx === state.selectedRouteIdx) {
        btn.className =
          'route-alt-btn btn-tactile text-left p-2.5 rounded-xl bg-sky-500/20 border-2 border-sky-400 transition';
      } else {
        btn.className =
          'route-alt-btn btn-tactile text-left p-2.5 rounded-xl bg-slate-800/70 day-bg-card border border-slate-700/70 hover:border-slate-500 transition';
      }
      if (idx === 1 && !state.routes[1]) {
        btn.classList.add('hidden');
      }
    });
  }

  function cancelRouteSelection() {
    // Invalidate any in-flight route calculation promise
    state.routingRequestId++;

    stopNavigation(false);
    state.selectedDestination = null;
    state.rawOsrmRoutes = [];
    state.roadGraph = null;
    state.graphTelemetry = null;
    state.routes = [];

    if (state.destMarker) {
      try {
        state.map.removeLayer(state.destMarker);
      } catch (e) {}
      state.destMarker = null;
    }
    state.routePolylines.forEach((line) => {
      try {
        state.map.removeLayer(line);
      } catch (e) {}
    });
    state.routePolylines = [];

    state.graphOverlayLayers.forEach((layer) => {
      try {
        state.map.removeLayer(layer);
      } catch (e) {}
    });
    state.graphOverlayLayers = [];

    document.getElementById('routePreviewCard').classList.add('hidden');
    document.getElementById('activeNavHud').classList.add('hidden');
    document.getElementById('searchHeader').classList.remove('hidden');
    if (!state.hasLiveGpsLock) {
      document.getElementById('idleBottomBar').classList.remove('hidden');
    } else {
      document.getElementById('idleBottomBar').classList.add('hidden');
    }
    document.getElementById('destinationInput').value = '';
    document.getElementById('clearSearchBtn').classList.add('hidden');
    document.getElementById('searchDropdown').classList.add('hidden');

    if (state.convoy.activeCode && state.convoy.role === 'leader') {
      syncLeaderStateToConvoy('idle');
    }
  }

  // ==========================================
  // 9. LIVE GPS TURN-BY-TURN NAVIGATION
  // ==========================================
  function syncNavControlsPosition() {
    const tbtHeader = document.getElementById('tbtHeader');
    const convoyPill = document.getElementById('activeConvoyPill');

    let maxBottom = 0;
    if (tbtHeader && !tbtHeader.classList.contains('hidden')) {
      const rect = tbtHeader.getBoundingClientRect();
      if (rect.bottom > maxBottom) maxBottom = rect.bottom;
    }
    if (convoyPill && !convoyPill.classList.contains('hidden')) {
      const rect = convoyPill.getBoundingClientRect();
      if (rect.bottom > maxBottom) maxBottom = rect.bottom;
    }

    if (maxBottom > 0) {
      document.documentElement.style.setProperty('--top-overlays-bottom', `${Math.round(maxBottom)}px`);
      document.documentElement.style.setProperty('--tbt-banner-bottom', `${Math.round(maxBottom)}px`);
      document.body.classList.add('has-top-banner');
    } else {
      document.documentElement.style.removeProperty('--top-overlays-bottom');
      document.documentElement.style.removeProperty('--tbt-banner-bottom');
      document.body.classList.remove('has-top-banner');
    }
  }

  function startNavigation() {
    const route = state.routes[state.selectedRouteIdx];
    if (!route || !route.coords.length) return;

    state.isNavigating = true;
    state.currentStepIdx = 0;
    state.currentRouteVertexIdx = 0;
    state.announcedStepIndices.clear();
    state.announcedHazardIds.clear();

    // 1. Activate Waze 3D Driving Perspective Mode & Transform User Marker into Vehicle Arrow
    document.body.classList.add('nav-mode-active', 'nav-mode-3d');

    // Hide 2D accuracy circle during navigation
    if (state.accuracyCircle && state.map.hasLayer(state.accuracyCircle)) {
      state.map.removeLayer(state.accuracyCircle);
    }

    // Immediately snap vehicle position to starting segment of route
    const snap = snapToActiveRoute(state.userPos.lat, state.userPos.lng);
    if (snap.snapped) {
      state.userPos = { lat: snap.lat, lng: snap.lng };
      state.userHeading = snap.bearing;
      markerAnimator.animateTo(snap.lat, snap.lng, snap.bearing, 250);
    } else if (route.coords.length >= 2) {
      const initialBearing = Math.round(
        getBearing(route.coords[0][0], route.coords[0][1], route.coords[1][0], route.coords[1][1])
      );
      if (!Number.isNaN(initialBearing)) {
        state.userHeading = initialBearing;
        const navArrow = document.getElementById('navVehicleChevron');
        if (navArrow) {
          navArrow.style.transform = 'rotate(0deg)';
        }
      }
    }

    document.getElementById('searchHeader').classList.add('hidden');
    document.getElementById('tbtHeader').classList.remove('hidden');
    document.getElementById('routePreviewCard').classList.add('hidden');
    document.getElementById('idleBottomBar').classList.add('hidden');
    document.getElementById('activeNavHud').classList.remove('hidden');

    // Smoothly shift top-left and top-right controls down below the road instruction banner
    syncNavControlsPosition();
    requestAnimationFrame(syncNavControlsPosition);

    if (route.steps && route.steps.length > 0) {
      const curStep = route.steps[0];
      const limit = inferRoadSpeedLimit(curStep.street, curStep.instruction);
      speedometerEngine.setSpeedLimit(limit);
    }

    setFollowMode(true);
    state.map.setView([state.userPos.lat, state.userPos.lng], 17.5, { animate: true });
    if (typeof state.map.setBearing === 'function') {
      state.map.setBearing(-state.userHeading);
    }

    onLiveNavigationPositionUpdate(state.userPos.lat, state.userPos.lng);

    if (state.convoy.activeCode && state.convoy.role === 'leader') {
      syncLeaderStateToConvoy('navigating');
    }
  }

  /** Called on every live GPS position update while navigating */
  function onLiveNavigationPositionUpdate(lat, lng) {
    const route = state.routes[state.selectedRouteIdx];
    if (!route || !route.coords.length) return;

    const curVertex = state.currentRouteVertexIdx || 0;

    // 1. Check arrival at destination (within 30m of final point)
    const [endLat, endLng] = route.coords[route.coords.length - 1];
    const distToDest = getDistanceMeters(lat, lng, endLat, endLng);
    if (distToDest <= 30) {
      document.getElementById('navProgressBar').style.width = '100%';
      stopNavigation(true);
      return;
    }

    // 2. Auto-reroute if raw GPS deviates > 85 meters from active route
    const rawDevDist = state.rawGpsPos
      ? getDistanceMeters(state.rawGpsPos.lat, state.rawGpsPos.lng, lat, lng)
      : 0;
    if (rawDevDist > 85 && !state.isRerouting) {
      recalculateActiveRoute();
      return;
    }

    // 3. Compute remaining distance along polyline from current snapped segment to destination
    let remDistM = 0;
    if (curVertex < route.coords.length - 1) {
      remDistM += getDistanceMeters(lat, lng, route.coords[curVertex + 1][0], route.coords[curVertex + 1][1]);
    }
    for (let i = curVertex + 2; i < route.coords.length; i++) {
      remDistM += getDistanceMeters(
        route.coords[i - 1][0],
        route.coords[i - 1][1],
        route.coords[i][0],
        route.coords[i][1]
      );
    }

    const progressRatio = Math.max(
      0,
      Math.min(1, 1 - remDistM / Math.max(1, route.distanceM))
    );
    const pct = Math.min(100, Math.round(progressRatio * 100));
    document.getElementById('navProgressBar').style.width = `${pct}%`;

    const remSec = Math.max(10, Math.round(route.durationS * (1 - progressRatio)));
    document.getElementById('hudRemainingMin').textContent = Math.max(1, Math.ceil(remSec / 60));
    document.getElementById('hudRemainingDist').textContent = formatDistance(remDistM);
    document.getElementById('hudEta').textContent = formatETA(remSec);

    // 5. Advance turn-by-turn step & announce ONLY junction turns / lane changes
    if (route.steps && route.steps.length > 0) {
      const curStep = route.steps[state.currentStepIdx];
      if (curStep && curStep.location) {
        const distToManeuver = getDistanceMeters(
          lat,
          lng,
          curStep.location[0],
          curStep.location[1]
        );

        // Speak only if this step requires a junction turn or lane change (within 220m approach)
        if (
          curStep.isJunctionOrLaneTurn &&
          distToManeuver <= 220 &&
          !state.announcedStepIndices.has(state.currentStepIdx)
        ) {
          state.announcedStepIndices.add(state.currentStepIdx);
          speakCurrentTurnInstruction(false);
        }

        if (distToManeuver < 30 && state.currentStepIdx < route.steps.length - 1) {
          state.currentStepIdx += 1;
          const nextStep = route.steps[state.currentStepIdx];
          if (nextStep && nextStep.isJunctionOrLaneTurn && nextStep.location) {
            const distToNext = getDistanceMeters(
              lat,
              lng,
              nextStep.location[0],
              nextStep.location[1]
            );
            if (distToNext <= 220 && !state.announcedStepIndices.has(state.currentStepIdx)) {
              state.announcedStepIndices.add(state.currentStepIdx);
              speakCurrentTurnInstruction(false);
            }
          }
        }
      }
      updateTurnByTurnUI(lat, lng);
    }

    // 6. Check approaching community hazards within 380m
    checkApproachingHazards(lat, lng);
  }

  function updateTurnByTurnUI(lat, lng) {
    const route = state.routes[state.selectedRouteIdx];
    if (!route || !route.steps.length) return;

    const step = route.steps[state.currentStepIdx] || route.steps[0];
    const nextStep = route.steps[state.currentStepIdx + 1];

    // Infer and update current road speed limit from active maneuver step
    const limit = inferRoadSpeedLimit(step.street, step.instruction);
    speedometerEngine.setSpeedLimit(limit);

    const distToStep = step.location
      ? getDistanceMeters(lat, lng, step.location[0], step.location[1])
      : step.distanceM;

    document.getElementById('tbtIconBox').textContent = step.maneuverIcon || '⬆️';
    document.getElementById('tbtDistance').textContent = formatDistance(distToStep);
    document.getElementById('tbtAction').textContent = step.actionLabel || 'Continue';
    document.getElementById('tbtStreet').textContent = step.instruction;

    document.getElementById('tbtNextStepText').textContent = nextStep
      ? nextStep.instruction
      : `Arrive at ${state.selectedDestination?.name || 'Destination'}`;

    document.getElementById('tbtStepCounter').textContent = `Step ${state.currentStepIdx + 1}/${route.steps.length}`;
    syncNavControlsPosition();
  }

  async function recalculateActiveRoute() {
    if (!state.selectedDestination || state.isRerouting) return;
    state.isRerouting = true;
    try {
      const routes = await fetchLiveOsrmRoutes(state.userPos, state.selectedDestination);
      if (routes && routes.length > 0) {
        state.routes = routes;
        state.selectedRouteIdx = 0;
        state.currentStepIdx = 0;
        state.announcedStepIndices.clear();
        renderRoutePolylines(false);
        onLiveNavigationPositionUpdate(state.userPos.lat, state.userPos.lng);
      }
    } finally {
      state.isRerouting = false;
    }
  }

  function speakCurrentTurnInstruction(force = false) {
    const route = state.routes[state.selectedRouteIdx];
    if (!route || !route.steps[state.currentStepIdx]) return;
    const step = route.steps[state.currentStepIdx];
    if (!force && !step.isJunctionOrLaneTurn) return;

    const dist = step.location
      ? getDistanceMeters(
          state.userPos.lat,
          state.userPos.lng,
          step.location[0],
          step.location[1]
        )
      : step.distanceM;
    speakAlert(`In ${formatDistance(dist)}, ${step.instruction}`);
  }

  function checkApproachingHazards(lat, lng) {
    for (const rep of state.reports) {
      if (state.announcedHazardIds.has(rep.id)) continue;
      const dist = getDistanceMeters(lat, lng, rep.lat, rep.lng);
      if (dist <= 380) {
        state.announcedHazardIds.add(rep.id);
        showApproachingHazardToast(rep, dist);
        break;
      }
    }
  }

  function showApproachingHazardToast(report, distanceM) {
    const cat = REPORT_CATEGORIES[report.category] || REPORT_CATEGORIES.hazard;
    state.activeToastHazardId = report.id;

    document.getElementById('toastHazardIcon').textContent = cat.icon;
    document.getElementById('toastHazardText').textContent = `${cat.label} (${report.subtype}) ${formatDistance(distanceM)} ahead`;
    document.getElementById('hazardApproachToast').classList.remove('hidden');

    setTimeout(() => {
      if (state.activeToastHazardId === report.id) {
        document.getElementById('hazardApproachToast').classList.add('hidden');
      }
    }, 8000);
  }

  function stopNavigation(completed = false) {
    state.isNavigating = false;
    state.currentRouteVertexIdx = 0;
    state.stationaryAnchor = null;

    // Reset speed limit badge on navigation exit
    speedometerEngine.setSpeedLimit(null);

    // Re-show accuracy circle in 2D mode
    if (state.accuracyCircle && state.hasLiveGpsLock && state.map && !state.map.hasLayer(state.accuracyCircle)) {
      state.accuracyCircle.addTo(state.map);
    }

    // Exit 3D Waze Navigation Perspective back to 2D flat mode & reset map bearing to North-Up
    document.body.classList.remove('nav-mode-active', 'nav-mode-3d');
    if (state.map && typeof state.map.setBearing === 'function') {
      state.map.setBearing(0);
    }
    syncNavControlsPosition();

    document.getElementById('tbtHeader').classList.add('hidden');
    document.getElementById('searchHeader').classList.remove('hidden');
    document.getElementById('activeNavHud').classList.add('hidden');
    document.getElementById('hazardApproachToast').classList.add('hidden');

    if (completed) {
      document.getElementById('currentLocationLabel').textContent =
        `Arrived at ${state.selectedDestination?.name || 'Destination'}! 🏁`;
      showGpsStatusBanner(4500);
      state.routePolylines.forEach((line) => {
        try {
          state.map.removeLayer(line);
        } catch (e) {}
      });
      state.routePolylines = [];
      if (state.destMarker) {
        try {
          state.map.removeLayer(state.destMarker);
        } catch (e) {}
        state.destMarker = null;
      }
      state.selectedDestination = null;
      state.routes = [];
      document.getElementById('destinationInput').value = '';
      document.getElementById('clearSearchBtn').classList.add('hidden');
    } else if (!state.selectedDestination) {
      if (!state.hasLiveGpsLock) {
        showGpsStatusBanner(0);
      } else {
        document.getElementById('idleBottomBar').classList.add('hidden');
      }
    } else {
      showRoutePreviewCard();
    }
  }

  // ==========================================
  // 10. REPORTING MODAL & PIN PLACEMENT HANDLERS
  // ==========================================
  function openReportModal() {
    selectModalCategory(state.modalCategory || 'traffic');
    document.getElementById('reportCustomNote').value = '';
    document.getElementById('reportModalBackdrop').classList.remove('hidden');
  }

  function closeReportModal() {
    document.getElementById('reportModalBackdrop').classList.add('hidden');
  }

  function selectModalCategory(catKey) {
    const cat = REPORT_CATEGORIES[catKey] || REPORT_CATEGORIES.traffic;
    state.modalCategory = cat.id;
    state.modalSubtype = cat.subtypes[0].id;

    document.querySelectorAll('.report-cat-card').forEach((card) => {
      const key = card.getAttribute('data-cat');
      if (key === cat.id) {
        card.className =
          'report-cat-card btn-tactile p-3.5 rounded-2xl bg-slate-800 border-2 border-amber-400 text-left flex flex-col gap-1.5 shadow-lg';
      } else {
        card.className =
          'report-cat-card btn-tactile p-3.5 rounded-2xl bg-slate-800/75 border-2 border-transparent hover:border-slate-600 text-left flex flex-col gap-1.5';
      }
    });

    renderSubtypePills(cat);
  }

  function renderSubtypePills(cat) {
    const container = document.getElementById('subtypePillsContainer');
    container.innerHTML = cat.subtypes
      .map((sub) => {
        const active = sub.id === state.modalSubtype;
        return `
          <button
            type="button"
            data-sub="${sub.id}"
            class="subtype-pill-btn btn-tactile p-2.5 rounded-xl border text-left transition ${
              active
                ? 'bg-amber-500/20 border-amber-400 text-white day-text-dark'
                : 'bg-slate-800/80 day-bg-card border-slate-700 text-slate-300 day-text-muted hover:border-slate-500'
            }"
          >
            <p class="text-xs font-extrabold">${sub.label}</p>
            <p class="text-[10px] opacity-75 mt-0.5 truncate">${sub.desc}</p>
          </button>
        `;
      })
      .join('');

    container.querySelectorAll('.subtype-pill-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.modalSubtype = btn.getAttribute('data-sub');
        renderSubtypePills(cat);
      });
    });
  }

  function startMapTapPlacement() {
    const cat = REPORT_CATEGORIES[state.modalCategory];
    state.pendingMapPlacement = {
      category: state.modalCategory,
      subtype: state.modalSubtype,
      note: document.getElementById('reportCustomNote').value,
      durationMin: document.getElementById('reportDurationSelect').value
    };

    closeReportModal();
    document.body.classList.add('map-tap-cursor');
    document.getElementById('placementBannerIcon').textContent = cat.icon;
    document.getElementById('placementBannerText').textContent = `Tap on map to place ${cat.label} (${state.modalSubtype})`;
    document.getElementById('mapPlacementBanner').classList.remove('hidden');
  }

  function cancelMapTapPlacement() {
    state.pendingMapPlacement = null;
    document.body.classList.remove('map-tap-cursor');
    document.getElementById('mapPlacementBanner').classList.add('hidden');
  }

  function completeMapTapReport(lat, lng) {
    if (!state.pendingMapPlacement) return;
    const payload = { ...state.pendingMapPlacement, lat, lng };
    cancelMapTapPlacement();
    addNewCommunityReport(payload);
  }

  // ==========================================
  // 10.5 LIVE CONVOY & SUPABASE REALTIME DATABASE ENGINE
  // ==========================================
  const STORAGE_KEY_SUPABASE_CFG = 'pulsenav_supabase_config_v1';
  const STORAGE_KEY_DRIVER_PROFILE = 'pulsenav_driver_profile_v1';
  const STORAGE_KEY_LOCAL_CONVOYS = 'pulsenav_local_convoys_v1';

  const DEFAULT_SUPABASE_URL = 'https://rpqhjiefarrbigpmjtrl.supabase.co';
  const DEFAULT_SUPABASE_ANON_KEY =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJwcWhqaWVmYXJyYmlncG1qdHJsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI2NzA4MjgsImV4cCI6MjEwODI0NjgyOH0.J6Hccq_GyMmgbm2vWqPIZ8G5eytVgVTobnj7plt1aoo';

  // Automatic Convoy Driver Palette (Distinct high-contrast colors)
  const CONVOY_AUTO_COLOR_PALETTE = [
    '#38bdf8', // Sky Blue (Leader default)
    '#a855f7', // Purple
    '#10b981', // Emerald Green
    '#f43f5e', // Rose Red
    '#f59e0b', // Amber Gold
    '#06b6d4', // Cyan
    '#ec4899', // Pink
    '#84cc16'  // Lime
  ];

  function pickAutoDriverColor(existingColors = [], seedId = '') {
    const usedSet = new Set(existingColors.map((c) => String(c || '').toLowerCase()));
    const available = CONVOY_AUTO_COLOR_PALETTE.find(
      (c) => !usedSet.has(c.toLowerCase())
    );
    if (available) return available;

    // Fallback deterministic hash if convoy has > 8 drivers
    let hash = 0;
    for (let i = 0; i < seedId.length; i++) {
      hash = (hash * 31 + seedId.charCodeAt(i)) >>> 0;
    }
    return CONVOY_AUTO_COLOR_PALETTE[hash % CONVOY_AUTO_COLOR_PALETTE.length];
  }

  function updateAutoColorBadge(color) {
    const badge = document.getElementById('driverAutoColorBadge');
    if (badge && color) {
      badge.style.background = color;
    }
  }

  function loadOrCreateDriverProfile() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY_DRIVER_PROFILE) || 'null');
      if (saved && saved.driverId) {
        state.convoy.driverId = saved.driverId;
        state.convoy.driverName = saved.driverName || `Driver-${saved.driverId.slice(-3)}`;
        state.convoy.driverColor =
          saved.driverColor || pickAutoDriverColor([], saved.driverId);
      }
    } catch (e) {
      // Ignore
    }

    if (!state.convoy.driverId) {
      const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
      state.convoy.driverId = `drv-${rand}`;
      state.convoy.driverName = `Driver-${rand.slice(0, 3)}`;
      state.convoy.driverColor = pickAutoDriverColor([], state.convoy.driverId);
      saveDriverProfile();
    }

    const nameInput = document.getElementById('convoyDriverNameInput');
    if (nameInput) nameInput.value = state.convoy.driverName;
    updateAutoColorBadge(state.convoy.driverColor);
  }

  function saveDriverProfile() {
    try {
      localStorage.setItem(
        STORAGE_KEY_DRIVER_PROFILE,
        JSON.stringify({
          driverId: state.convoy.driverId,
          driverName: state.convoy.driverName,
          driverColor: state.convoy.driverColor
        })
      );
    } catch (e) {
      // Ignore
    }
  }

  function mapConvoyDocToDbRow(convoyDoc) {
    return {
      code: convoyDoc.code,
      leader_id: convoyDoc.leaderId,
      leader_name: convoyDoc.leaderName,
      status: convoyDoc.status || 'idle',
      destination: convoyDoc.destination || null,
      active_route: convoyDoc.activeRoute || null,
      latest_ping: convoyDoc.latestPing || null,
      created_at: Number(convoyDoc.createdAt || Date.now()),
      updated_at: Number(convoyDoc.updatedAt || Date.now())
    };
  }

  function mapDbRowToConvoyDoc(row) {
    if (!row) return null;
    return {
      code: row.code,
      leaderId: row.leader_id ?? row.leaderId,
      leaderName: row.leader_name ?? row.leaderName ?? 'Leader',
      status: row.status || 'idle',
      destination: row.destination || null,
      activeRoute: row.active_route ?? row.activeRoute ?? null,
      latestPing: row.latest_ping ?? row.latestPing ?? null,
      createdAt: Number(row.created_at ?? row.createdAt ?? Date.now()),
      updatedAt: Number(row.updated_at ?? row.updatedAt ?? Date.now())
    };
  }

  function mapMemberToDbRow(code, m) {
    return {
      convoy_code: code,
      id: m.id,
      name: m.name,
      color: m.color,
      role: m.role,
      lat: Number(m.lat),
      lng: Number(m.lng),
      heading: Number(m.heading || 0),
      speed_kmh: Number(m.speedKmh || 0),
      updated_at: Number(m.updatedAt || Date.now())
    };
  }

  function mapDbRowToMember(row) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name || 'Driver',
      color: row.color || '#38bdf8',
      role: row.role || 'member',
      lat: Number(row.lat),
      lng: Number(row.lng),
      heading: Number(row.heading || 0),
      speedKmh: Number(row.speed_kmh ?? row.speedKmh ?? 0),
      updatedAt: Number(row.updated_at ?? row.updatedAt ?? Date.now())
    };
  }

  /**
   * Initialize Supabase Client (`@supabase/supabase-js` v2) for PostgreSQL + Supabase Realtime.
   * Connects both `public.community_reports` and `public.convoys` / `public.convoy_members`.
   */
  async function initSupabaseClient() {
    const backendLabel = document.getElementById('convoyBackendStatusLabel');
    const syncTag = document.getElementById('convoySyncModeTag');

    if (state.reportsChannel && state.supabase) {
      try {
        state.supabase.removeChannel(state.reportsChannel);
      } catch (e) {
        // Ignore
      }
      state.reportsChannel = null;
    }

    try {
      const url = DEFAULT_SUPABASE_URL;
      const anonKey = DEFAULT_SUPABASE_ANON_KEY;

      if (!window.supabase || typeof window.supabase.createClient !== 'function') {
        throw new Error('Supabase JS SDK not loaded');
      }

      const client = window.supabase.createClient(url, anonKey, {
        realtime: { params: { eventsPerSecond: 20 } }
      });

      state.supabase = client;

      if (backendLabel) {
        backendLabel.textContent = 'Live Supabase Realtime Connected • Share one route & GPS markers';
      }
      if (syncTag) syncTag.textContent = '• Supabase Realtime';

      // Sync & subscribe to live Community Incident Reports in Supabase
      await syncCommunityReportsFromSupabase();
      subscribeToSupabaseReportsRealtime();

      // Re-subscribe active convoy if already in a session
      if (state.convoy.activeCode) {
        subscribeToActiveConvoy(state.convoy.activeCode);
      }

      return true;
    } catch (err) {
      console.warn('Supabase initialization error:', err);
      state.supabase = null;
      if (backendLabel) {
        backendLabel.textContent = 'Share one route & live driver GPS markers';
      }
      return false;
    }
  }

  function subscribeToSupabaseReportsRealtime() {
    if (!state.supabase) return;
    if (state.reportsChannel) {
      try {
        state.supabase.removeChannel(state.reportsChannel);
      } catch (e) {
        // Ignore
      }
    }

    state.reportsChannel = state.supabase
      .channel('pulsenav:reports')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'community_reports' },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            const delId = payload.old && payload.old.id;
            if (!delId) return;
            const idx = state.reports.findIndex((r) => r.id === delId);
            if (idx !== -1) {
              const marker = state.reportMarkers.get(delId);
              if (marker) {
                state.map.removeLayer(marker);
                state.reportMarkers.delete(delId);
              }
              state.reports.splice(idx, 1);
              saveReportsToStorage();
              updateLiveTickerAndBadges();
              renderFeedDrawerList();
              updateRouteIncidentCount();
            }
            return;
          }

          const row = payload.new;
          if (!row || !row.id) return;
          const mapped = mapDbRowToReport(row);
          if (mapped.expiresAt <= Date.now()) return;

          const existingIdx = state.reports.findIndex((r) => r.id === mapped.id);
          if (existingIdx !== -1) {
            state.reports[existingIdx] = mapped;
          } else {
            state.reports.unshift(mapped);
          }

          saveReportsToStorage();
          addOrUpdateReportMarker(mapped);
          updateLiveTickerAndBadges();
          renderFeedDrawerList();
          updateRouteIncidentCount();
        }
      )
      .subscribe();
  }

  function generateConvoyCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  function buildMyMemberPayload(role) {
    return {
      id: state.convoy.driverId,
      name: (state.convoy.driverName || 'Driver').slice(0, 40),
      color: state.convoy.driverColor || '#38bdf8',
      role: role || state.convoy.role || 'member',
      lat: Number(state.userPos.lat),
      lng: Number(state.userPos.lng),
      heading: Math.max(0, Math.min(360, Number(state.userHeading || 0))),
      speedKmh: Math.max(0, Math.min(400, Number(state.currentSpeedKmh || 0))),
      updatedAt: Date.now()
    };
  }

  async function createConvoyAsLeader() {
    updateDriverNameFromInput();
    if (state.convoy.activeCode) {
      await leaveConvoy();
    }

    const code = generateConvoyCode();
    const now = Date.now();
    const primaryRoute = state.routes[state.selectedRouteIdx];

    // Automatically assign the Leader color (first palette slot)
    state.convoy.driverColor = CONVOY_AUTO_COLOR_PALETTE[0];
    saveDriverProfile();
    updateAutoColorBadge(state.convoy.driverColor);

    const convoyDocData = {
      code,
      leaderId: state.convoy.driverId,
      leaderName: state.convoy.driverName.slice(0, 40),
      status: state.isNavigating
        ? 'navigating'
        : state.selectedDestination
          ? 'routing'
          : 'idle',
      destination: state.selectedDestination
        ? {
            name: state.selectedDestination.name,
            address: state.selectedDestination.address || '',
            lat: Number(state.selectedDestination.lat),
            lng: Number(state.selectedDestination.lng),
            streetHint: state.selectedDestination.streetHint || state.selectedDestination.name
          }
        : null,
      activeRoute: primaryRoute
        ? {
            distanceM: primaryRoute.distanceM,
            durationS: primaryRoute.durationS,
            summary: primaryRoute.summary
          }
        : null,
      latestPing: null,
      createdAt: now,
      updatedAt: now
    };

    const myMember = buildMyMemberPayload('leader');

    if (state.supabase) {
      const { error: cErr } = await state.supabase
        .from('convoys')
        .upsert(mapConvoyDocToDbRow(convoyDocData));
      if (cErr) {
        console.warn('Supabase create convoy error (falling back to local store):', cErr.message);
      } else {
        await state.supabase
          .from('convoy_members')
          .upsert(mapMemberToDbRow(code, myMember));
      }
    }

    saveLocalConvoyState(code, convoyDocData, myMember);
    activateConvoySession(code, 'leader', convoyDocData);
  }

  async function joinConvoyByCode(rawCode) {
    updateDriverNameFromInput();
    const errEl = document.getElementById('convoyErrorMsg');
    errEl.classList.add('hidden');

    const code = (rawCode || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      errEl.textContent = 'Please enter a valid 6-character alphanumeric Convoy Code.';
      errEl.classList.remove('hidden');
      return;
    }

    if (state.convoy.activeCode) {
      await leaveConvoy();
    }

    let convoyDocData = null;

    if (state.supabase) {
      try {
        const { data: row, error } = await state.supabase
          .from('convoys')
          .select('*')
          .eq('code', code)
          .maybeSingle();

        if (error) {
          throw error;
        }

        if (row) {
          convoyDocData = mapDbRowToConvoyDoc(row);
          const role = convoyDocData.leaderId === state.convoy.driverId ? 'leader' : 'member';

          // Automatically assign a unique color not already taken by other convoy drivers
          const { data: existingRows } = await state.supabase
            .from('convoy_members')
            .select('id, color')
            .eq('convoy_code', code);

          const takenColors = Array.isArray(existingRows)
            ? existingRows
                .filter((r) => r.id !== state.convoy.driverId)
                .map((r) => r.color)
            : [];

          state.convoy.driverColor =
            role === 'leader'
              ? CONVOY_AUTO_COLOR_PALETTE[0]
              : pickAutoDriverColor([CONVOY_AUTO_COLOR_PALETTE[0], ...takenColors], state.convoy.driverId);
          saveDriverProfile();
          updateAutoColorBadge(state.convoy.driverColor);

          const myMember = buildMyMemberPayload(role);
          await state.supabase
            .from('convoy_members')
            .upsert(mapMemberToDbRow(code, myMember));

          saveLocalConvoyState(code, convoyDocData, myMember);
          activateConvoySession(code, role, convoyDocData);
          return;
        }
      } catch (err) {
        console.warn('Supabase convoy lookup error:', err);
      }
    }

    // Fallback to local BroadcastChannel / localStorage convoy store
    const localStore = getLocalConvoysMap();
    convoyDocData = localStore[code] ? localStore[code].doc : null;
    if (!convoyDocData) {
      errEl.textContent = state.supabase
        ? `Convoy "${code}" not found in Supabase.`
        : `Convoy "${code}" not found. Create a convoy or configure Supabase below.`;
      errEl.classList.remove('hidden');
      return;
    }

    const role = convoyDocData.leaderId === state.convoy.driverId ? 'leader' : 'member';
    const localMembers = localStore[code]?.members ? Object.values(localStore[code].members) : [];
    const localTakenColors = localMembers
      .filter((m) => m.id !== state.convoy.driverId)
      .map((m) => m.color);
    state.convoy.driverColor =
      role === 'leader'
        ? CONVOY_AUTO_COLOR_PALETTE[0]
        : pickAutoDriverColor([CONVOY_AUTO_COLOR_PALETTE[0], ...localTakenColors], state.convoy.driverId);
    saveDriverProfile();
    updateAutoColorBadge(state.convoy.driverColor);

    const myMember = buildMyMemberPayload(role);
    saveLocalConvoyState(code, convoyDocData, myMember);
    activateConvoySession(code, role, convoyDocData);
  }

  function activateConvoySession(code, role, initialConvoyDoc) {
    state.convoy.activeCode = code;
    state.convoy.role = role;
    state.convoy.leaderId = initialConvoyDoc.leaderId;
    state.convoy.leaderName = initialConvoyDoc.leaderName;
    state.convoy.status = initialConvoyDoc.status || 'idle';
    state.convoy.members.clear();
    state.convoy.members.set(state.convoy.driverId, buildMyMemberPayload(role));

    // Subscribe to real-time Supabase channel + local BroadcastChannel
    subscribeToActiveConvoy(code);
    applyConvoyDocSnapshot(initialConvoyDoc);
    updateConvoyUI();
  }

  async function fetchActiveConvoySnapshotFromSupabase(code) {
    if (!state.supabase || !code || code !== state.convoy.activeCode) return;
    try {
      const [{ data: convoyRow }, { data: memberRows }] = await Promise.all([
        state.supabase.from('convoys').select('*').eq('code', code).maybeSingle(),
        state.supabase.from('convoy_members').select('*').eq('convoy_code', code)
      ]);

      if (convoyRow && code === state.convoy.activeCode) {
        applyConvoyDocSnapshot(mapDbRowToConvoyDoc(convoyRow));
      }

      if (Array.isArray(memberRows) && code === state.convoy.activeCode) {
        const now = Date.now();
        memberRows.forEach((r) => {
          const m = mapDbRowToMember(r);
          if (!m || !m.id) return;
          // Prune members inactive for more than 2 hours
          if (now - m.updatedAt > 2 * 60 * 60 * 1000) return;
          const cur = state.convoy.members.get(m.id);
          if (!cur || m.updatedAt >= cur.updatedAt) {
            state.convoy.members.set(m.id, m);
          }
        });
        renderConvoyMemberMarkers();
        renderConvoyRosterList();
        updateConvoyHeaderBadges();
      }
    } catch (e) {
      // Ignore transient network errors
    }
  }

  async function subscribeToActiveConvoy(code) {
    unsubscribeFromConvoyListeners();

    if (state.supabase) {
      await fetchActiveConvoySnapshotFromSupabase(code);

      const channel = state.supabase
        .channel(`convoy:${code}`, {
          config: { broadcast: { self: false } }
        })
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'convoys',
            filter: `code=eq.${code}`
          },
          (payload) => {
            if (payload.new) {
              applyConvoyDocSnapshot(mapDbRowToConvoyDoc(payload.new));
            }
          }
        )
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'convoy_members',
            filter: `convoy_code=eq.${code}`
          },
          (payload) => {
            if (payload.eventType === 'DELETE') {
              const oldId = payload.old && payload.old.id;
              if (oldId) {
                state.convoy.members.delete(oldId);
                renderConvoyMemberMarkers();
                renderConvoyRosterList();
                updateConvoyHeaderBadges();
              } else {
                fetchActiveConvoySnapshotFromSupabase(code);
              }
              return;
            }
            if (payload.new) {
              const m = mapDbRowToMember(payload.new);
              if (m && m.id) {
                state.convoy.members.set(m.id, m);
                renderConvoyMemberMarkers();
                renderConvoyRosterList();
                updateConvoyHeaderBadges();
              }
            }
          }
        )
        .on('broadcast', { event: 'driver_telemetry' }, ({ payload }) => {
          if (payload && payload.id) {
            state.convoy.members.set(payload.id, payload);
            renderConvoyMemberMarkers();
            renderConvoyRosterList();
            updateConvoyHeaderBadges();
          }
        })
        .on('broadcast', { event: 'driver_left' }, ({ payload }) => {
          if (payload && payload.id) {
            state.convoy.members.delete(payload.id);
            renderConvoyMemberMarkers();
            renderConvoyRosterList();
            updateConvoyHeaderBadges();
          }
        })
        .on('broadcast', { event: 'convoy_ping' }, ({ payload }) => {
          if (payload && payload.id && payload.id !== state.convoy.lastPingId) {
            state.convoy.lastPingId = payload.id;
            showConvoyPingToast(payload);
          }
        })
        .on('broadcast', { event: 'leader_route' }, ({ payload }) => {
          if (payload && payload.code === state.convoy.activeCode) {
            applyConvoyDocSnapshot(payload);
          }
        })
        .subscribe((status) => {
          const syncTag = document.getElementById('convoySyncModeTag');
          if (syncTag && status === 'SUBSCRIBED') {
            syncTag.textContent = '• Supabase Realtime';
          }
        });

      state.convoy.realtimeChannel = channel;

      // Continuous background heartbeat & state sync every 3 seconds
      state.convoy.heartbeatTimer = setInterval(() => {
        if (state.convoy.activeCode === code) {
          broadcastMyConvoyTelemetry(false);
          fetchActiveConvoySnapshotFromSupabase(code);
        }
      }, 3000);
    } else {
      refreshFromLocalConvoyStore(code);
    }
  }

  function unsubscribeFromConvoyListeners() {
    if (state.convoy.heartbeatTimer) {
      clearInterval(state.convoy.heartbeatTimer);
      state.convoy.heartbeatTimer = null;
    }
    if (state.convoy.realtimeChannel && state.supabase) {
      try {
        state.supabase.removeChannel(state.convoy.realtimeChannel);
      } catch (e) {
        // Ignore
      }
      state.convoy.realtimeChannel = null;
    }
  }

  async function leaveConvoy() {
    const code = state.convoy.activeCode;
    if (!code) return;

    if (state.convoy.realtimeChannel) {
      try {
        await state.convoy.realtimeChannel.send({
          type: 'broadcast',
          event: 'driver_left',
          payload: { id: state.convoy.driverId }
        });
      } catch (e) {
        // Ignore
      }
    }

    unsubscribeFromConvoyListeners();

    if (state.supabase) {
      try {
        await state.supabase
          .from('convoy_members')
          .delete()
          .eq('convoy_code', code)
          .eq('id', state.convoy.driverId);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    removeMemberFromLocalConvoy(code, state.convoy.driverId);

    state.convoy.memberMarkers.forEach((marker) => state.map.removeLayer(marker));
    state.convoy.memberMarkers.clear();
    state.convoy.members.clear();
    state.convoy.activeCode = null;
    state.convoy.role = null;
    state.convoy.sharedDestKey = '';

    // Clean ?convoy= param from URL without reloading
    if (window.location.search.includes('convoy=')) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    updateConvoyUI();
  }

  /** Apply shared route, navigation status, and quick pings from Convoy document */
  async function applyConvoyDocSnapshot(convoyDoc) {
    if (!convoyDoc || convoyDoc.code !== state.convoy.activeCode) return;

    state.convoy.leaderId = convoyDoc.leaderId;
    state.convoy.leaderName = convoyDoc.leaderName || 'Leader';
    state.convoy.status = convoyDoc.status || 'idle';

    // Handle incoming 1-tap Convoy Ping
    if (
      convoyDoc.latestPing &&
      convoyDoc.latestPing.id &&
      convoyDoc.latestPing.id !== state.convoy.lastPingId
    ) {
      state.convoy.lastPingId = convoyDoc.latestPing.id;
      if (Date.now() - (convoyDoc.latestPing.timestamp || 0) < 25000) {
        showConvoyPingToast(convoyDoc.latestPing);
      }
    }

    // Update route status text in Convoy Modal
    const routeStatusEl = document.getElementById('modalConvoyRouteStatus');
    if (routeStatusEl) {
      if (convoyDoc.destination) {
        routeStatusEl.textContent = `${convoyDoc.status === 'navigating' ? '▶ Navigating to' : '📍 Routed to'}: ${convoyDoc.destination.name}`;
      } else {
        routeStatusEl.textContent =
          state.convoy.role === 'leader'
            ? 'Select a destination on the map or search bar to route your convoy'
            : `Waiting for ${state.convoy.leaderName} to select a destination...`;
      }
    }

    // If we are a follower Member, automatically sync destination & navigation state from Leader
    if (state.convoy.role === 'member') {
      if (!convoyDoc.destination) {
        if (state.selectedDestination) {
          state.convoy.sharedDestKey = '';
          cancelRouteSelection();
        }
        return;
      }

      const destKey = `${Number(convoyDoc.destination.lat).toFixed(5)},${Number(convoyDoc.destination.lng).toFixed(5)}`;
      if (destKey !== state.convoy.sharedDestKey) {
        state.convoy.sharedDestKey = destKey;
        await selectDestination(
          {
            name: convoyDoc.destination.name,
            address: convoyDoc.destination.address || '',
            icon: '🏁',
            lat: Number(convoyDoc.destination.lat),
            lng: Number(convoyDoc.destination.lng),
            streetHint: convoyDoc.destination.streetHint || convoyDoc.destination.name
          },
          true
        );
      }

      if (convoyDoc.status === 'navigating' && !state.isNavigating && state.routes.length > 0) {
        startNavigation();
      } else if (convoyDoc.status !== 'navigating' && state.isNavigating) {
        stopNavigation(false);
      }
    }
  }

  /** Leader broadcasts route/navigation updates to the Convoy row & Realtime channel */
  async function syncLeaderStateToConvoy(newStatus) {
    const code = state.convoy.activeCode;
    if (!code || state.convoy.role !== 'leader') return;

    state.convoy.status = newStatus;
    const primaryRoute = state.routes[state.selectedRouteIdx];

    const updatePayload = {
      code,
      leaderId: state.convoy.driverId,
      leaderName: state.convoy.driverName.slice(0, 40),
      status: newStatus,
      destination: state.selectedDestination
        ? {
            name: state.selectedDestination.name,
            address: state.selectedDestination.address || '',
            lat: Number(state.selectedDestination.lat),
            lng: Number(state.selectedDestination.lng),
            streetHint: state.selectedDestination.streetHint || state.selectedDestination.name
          }
        : null,
      activeRoute: primaryRoute
        ? {
            distanceM: primaryRoute.distanceM,
            durationS: primaryRoute.durationS,
            summary: primaryRoute.summary
          }
        : null,
      updatedAt: Date.now()
    };

    if (state.convoy.realtimeChannel) {
      state.convoy.realtimeChannel.send({
        type: 'broadcast',
        event: 'leader_route',
        payload: updatePayload
      });
    }

    if (state.supabase) {
      try {
        await state.supabase
          .from('convoys')
          .update({
            leader_name: updatePayload.leaderName,
            status: updatePayload.status,
            destination: updatePayload.destination,
            active_route: updatePayload.activeRoute,
            updated_at: updatePayload.updatedAt
          })
          .eq('code', code);
      } catch (e) {
        console.warn('Failed to sync leader route to Supabase:', e);
      }
    }
    updateLocalConvoyDoc(code, updatePayload);
  }

  /** Broadcast this driver's live GPS coordinates, heading, and speed to the Convoy */
  async function broadcastMyConvoyTelemetry(force = false) {
    const code = state.convoy.activeCode;
    if (!code) return;

    const now = Date.now();
    if (!force && now - state.convoy.lastTelemetrySentAt < 650) return;
    state.convoy.lastTelemetrySentAt = now;

    const myMember = buildMyMemberPayload(state.convoy.role);
    state.convoy.members.set(state.convoy.driverId, myMember);

    // 1. Instant WebSocket broadcast for smooth real-time map markers
    if (state.convoy.realtimeChannel) {
      state.convoy.realtimeChannel.send({
        type: 'broadcast',
        event: 'driver_telemetry',
        payload: myMember
      });
    }

    // 2. Persist to PostgreSQL convoy_members table (every 2.5s or when forced)
    if (state.supabase && (force || now - state.convoy.lastDbTelemetrySavedAt >= 2500)) {
      state.convoy.lastDbTelemetrySavedAt = now;
      try {
        await state.supabase
          .from('convoy_members')
          .upsert(mapMemberToDbRow(code, myMember));
      } catch (e) {
        // Ignore transient network errors
      }
    }
    saveLocalConvoyState(code, null, myMember);

    renderConvoyMemberMarkers();
    renderConvoyRosterList();
  }

  /** Send a 1-tap quick Convoy Ping to all drivers in the convoy */
  async function broadcastConvoyPing(message, icon = '🚘') {
    const code = state.convoy.activeCode;
    if (!code) return;

    const pingPayload = {
      id: `ping-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      senderId: state.convoy.driverId,
      senderName: state.convoy.driverName.slice(0, 30),
      message: String(message).slice(0, 60),
      icon: String(icon).slice(0, 6),
      timestamp: Date.now()
    };

    state.convoy.lastPingId = pingPayload.id;
    showConvoyPingToast(pingPayload);

    if (state.convoy.realtimeChannel) {
      state.convoy.realtimeChannel.send({
        type: 'broadcast',
        event: 'convoy_ping',
        payload: pingPayload
      });
    }

    if (state.supabase) {
      try {
        await state.supabase
          .from('convoys')
          .update({
            latest_ping: pingPayload,
            updated_at: Date.now()
          })
          .eq('code', code);
      } catch (e) {
        console.warn('Convoy ping error:', e);
      }
    }
    updateLocalConvoyDoc(code, { latestPing: pingPayload, updatedAt: Date.now() });
  }

  let convoyPingToastTimer = null;
  function showConvoyPingToast(ping) {
    const toast = document.getElementById('convoyPingToast');
    document.getElementById('convoyPingToastIcon').textContent = ping.icon || '🚘';
    document.getElementById('convoyPingToastSender').textContent = `Convoy • ${ping.senderName || 'Driver'}`;
    document.getElementById('convoyPingToastText').textContent = ping.message || '';
    toast.classList.remove('hidden');

    clearTimeout(convoyPingToastTimer);
    convoyPingToastTimer = setTimeout(() => {
      toast.classList.add('hidden');
    }, 6000);
  }

  /** Render live map markers for all other drivers in the Convoy */
  function renderConvoyMemberMarkers() {
    if (!state.map) return;

    const activeIds = new Set();

    state.convoy.members.forEach((member) => {
      if (!member || member.id === state.convoy.driverId) return;
      activeIds.add(member.id);

      const roleIcon = member.role === 'leader' ? '👑 ' : '';
      const speedText = member.speedKmh > 0 ? ` • ${Math.round(member.speedKmh)} km/h` : '';
      const color = member.color || '#a855f7';

      const html = `
        <div class="convoy-driver-wrapper">
          <div class="convoy-driver-pulse" style="background: ${color}44; border: 1.5px solid ${color}99"></div>
          <div class="convoy-driver-core" style="background: ${color}; transform: rotate(${member.heading || 0}deg)">
            <div class="convoy-driver-arrow"></div>
          </div>
          <div class="convoy-driver-tag" style="border-color: ${color}">
            ${roleIcon}${member.name}${speedText}
          </div>
        </div>
      `;

      const icon = L.divIcon({
        className: 'custom-convoy-driver-icon',
        html,
        iconSize: [52, 52],
        iconAnchor: [26, 26],
        popupAnchor: [0, -24]
      });

      const distFromMe = getDistanceMeters(
        state.userPos.lat,
        state.userPos.lng,
        member.lat,
        member.lng
      );

      const popupHtml = `
        <div class="p-3.5 text-slate-100 font-sans">
          <div class="flex items-center justify-between gap-2 mb-1.5">
            <span class="text-xs font-extrabold uppercase tracking-wider px-2 py-0.5 rounded" style="background:${color}33; color:${color}; border:1px solid ${color}66">
              ${member.role === 'leader' ? '👑 Convoy Leader' : '🚘 Convoy Driver'}
            </span>
            <span class="text-xs font-bold text-sky-400">${formatDistance(distFromMe)} away</span>
          </div>
          <h4 class="text-base font-black text-white">${member.name}</h4>
          <p class="text-xs text-slate-400 mt-0.5">Speed: <strong class="text-white">${Math.round(member.speedKmh || 0)} km/h</strong> • Updated ${formatTimeAgo(member.updatedAt)}</p>
        </div>
      `;

      if (state.convoy.memberMarkers.has(member.id)) {
        const existing = state.convoy.memberMarkers.get(member.id);
        existing.setLatLng([member.lat, member.lng]);
        existing.setIcon(icon);
        if (existing.isPopupOpen()) {
          existing.setPopupContent(popupHtml);
        }
      } else {
        const marker = L.marker([member.lat, member.lng], {
          icon,
          zIndexOffset: 950
        }).addTo(state.map);
        marker.bindPopup(popupHtml, { closeButton: true, maxWidth: 250 });
        state.convoy.memberMarkers.set(member.id, marker);
      }
    });

    // Remove markers for members who left
    state.convoy.memberMarkers.forEach((marker, id) => {
      if (!activeIds.has(id)) {
        state.map.removeLayer(marker);
        state.convoy.memberMarkers.delete(id);
      }
    });
  }

  function renderConvoyRosterList() {
    const container = document.getElementById('convoyRosterList');
    const countLabel = document.getElementById('rosterDriverCountLabel');
    if (!container) return;

    const list = Array.from(state.convoy.members.values()).sort((a, b) => {
      if (a.role === 'leader') return -1;
      if (b.role === 'leader') return 1;
      return (a.name || '').localeCompare(b.name || '');
    });

    if (countLabel) {
      countLabel.textContent = list.length === 1 ? '1 Driver' : `${list.length} Drivers`;
    }

    container.innerHTML = list
      .map((m) => {
        const isMe = m.id === state.convoy.driverId;
        const distM = isMe
          ? 0
          : getDistanceMeters(state.userPos.lat, state.userPos.lng, m.lat, m.lng);
        return `
          <div class="p-3 rounded-xl bg-slate-900/90 day-bg-card border border-slate-800 flex items-center justify-between gap-2">
            <div class="flex items-center gap-2.5 min-w-0">
              <span class="w-4 h-4 rounded-full shrink-0 border border-white" style="background:${m.color || '#38bdf8'}"></span>
              <div class="min-w-0">
                <div class="flex items-center gap-1.5">
                  <p class="text-sm font-extrabold text-white day-text-dark truncate">${m.name}${isMe ? ' (You)' : ''}</p>
                  <span class="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${
                    m.role === 'leader'
                      ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                      : 'bg-slate-800 text-slate-300'
                  }">${m.role === 'leader' ? '👑 Leader' : 'Member'}</span>
                </div>
                <p class="text-[11px] text-slate-400">
                  ${Math.round(m.speedKmh || 0)} km/h ${!isMe ? `• ${formatDistance(distM)} away` : '• Broadcasting live GPS'}
                </p>
              </div>
            </div>
            ${
              !isMe
                ? `<button onclick="window.PulseNav.focusConvoyDriver('${m.id}')" class="btn-tactile px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-sky-400 text-xs font-bold border border-slate-700">Map ⌖</button>`
                : ''
            }
          </div>
        `;
      })
      .join('');
  }

  function updateConvoyHeaderBadges() {
    const count = Math.max(1, state.convoy.members.size);
    const headerBadge = document.getElementById('convoyMemberCountBadge');
    const pillCount = document.getElementById('convoyPillCount');
    const headerDot = document.getElementById('convoyHeaderDot');

    if (state.convoy.activeCode) {
      headerBadge.textContent = count;
      headerBadge.classList.remove('hidden');
      headerDot.classList.remove('hidden');
      if (pillCount) pillCount.textContent = count;
    } else {
      headerBadge.classList.add('hidden');
      headerDot.classList.add('hidden');
    }
  }

  function updateConvoyUI() {
    const activePill = document.getElementById('activeConvoyPill');
    const joinCreateSec = document.getElementById('convoyJoinCreateSection');
    const activeRosterSec = document.getElementById('convoyActiveRosterSection');

    updateConvoyHeaderBadges();

    if (!state.convoy.activeCode) {
      activePill.classList.add('hidden');
      joinCreateSec.classList.remove('hidden');
      activeRosterSec.classList.add('hidden');
      syncNavControlsPosition();
      document.getElementById('destinationInput').placeholder =
        'Search address, place, or tap map to route...';
      return;
    }

    activePill.classList.remove('hidden');
    joinCreateSec.classList.add('hidden');
    activeRosterSec.classList.remove('hidden');
    syncNavControlsPosition();

    document.getElementById('convoyActiveCodeText').textContent = state.convoy.activeCode;
    document.getElementById('modalConvoyCodeDisplay').textContent = state.convoy.activeCode;

    const roleBadge = document.getElementById('convoyRoleBadge');
    if (state.convoy.role === 'leader') {
      roleBadge.textContent = '👑 Leader';
      roleBadge.className = 'px-2 py-0.5 rounded-md bg-amber-500 text-slate-950 text-[10px] font-extrabold uppercase tracking-wider shrink-0';
      document.getElementById('destinationInput').placeholder =
        'Set destination for your entire Convoy...';
    } else {
      roleBadge.textContent = `🚗 Following ${state.convoy.leaderName || 'Leader'}`;
      roleBadge.className = 'px-2 py-0.5 rounded-md bg-indigo-500 text-white text-[10px] font-extrabold uppercase tracking-wider shrink-0';
      document.getElementById('destinationInput').placeholder =
        `Synced to ${state.convoy.leaderName || 'Leader'}'s Convoy route`;
    }

    renderConvoyRosterList();
    renderConvoyMemberMarkers();
  }

  function copyConvoyInviteLink() {
    const code = state.convoy.activeCode;
    if (!code) return;
    const inviteUrl = `${window.location.origin}${window.location.pathname}?convoy=${code}`;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(inviteUrl).catch(() => {});
    }
    showConvoyPingToast({
      senderName: `Convoy #${code}`,
      message: `Invite link copied! Share code ${code} with friends.`,
      icon: '🔗'
    });
  }

  function updateDriverNameFromInput() {
    const input = document.getElementById('convoyDriverNameInput');
    if (input && input.value.trim()) {
      state.convoy.driverName = input.value.trim().slice(0, 22);
      saveDriverProfile();
    }
  }

  // Local multi-tab BroadcastChannel + localStorage fallback when Supabase config is not yet added
  function getLocalConvoysMap() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY_LOCAL_CONVOYS) || '{}');
    } catch (e) {
      return {};
    }
  }

  function saveLocalConvoyState(code, docData, memberData) {
    const map = getLocalConvoysMap();
    if (!map[code]) {
      map[code] = { doc: docData, members: {} };
    }
    if (docData) {
      map[code].doc = docData;
    }
    if (memberData) {
      map[code].members[memberData.id] = memberData;
    }
    try {
      localStorage.setItem(STORAGE_KEY_LOCAL_CONVOYS, JSON.stringify(map));
    } catch (e) {
      // Ignore
    }
    if (state.convoy.broadcastChannel) {
      state.convoy.broadcastChannel.postMessage({ type: 'convoy_sync', code });
    }
  }

  function updateLocalConvoyDoc(code, partialDoc) {
    const map = getLocalConvoysMap();
    if (!map[code] || !map[code].doc) return;
    map[code].doc = { ...map[code].doc, ...partialDoc };
    try {
      localStorage.setItem(STORAGE_KEY_LOCAL_CONVOYS, JSON.stringify(map));
    } catch (e) {
      // Ignore
    }
    if (state.convoy.broadcastChannel) {
      state.convoy.broadcastChannel.postMessage({ type: 'convoy_sync', code });
    }
  }

  function removeMemberFromLocalConvoy(code, memberId) {
    const map = getLocalConvoysMap();
    if (map[code] && map[code].members) {
      delete map[code].members[memberId];
      try {
        localStorage.setItem(STORAGE_KEY_LOCAL_CONVOYS, JSON.stringify(map));
      } catch (e) {
        // Ignore
      }
      if (state.convoy.broadcastChannel) {
        state.convoy.broadcastChannel.postMessage({ type: 'convoy_sync', code });
      }
    }
  }

  function refreshFromLocalConvoyStore(code) {
    if (!code || state.supabase) return;
    const map = getLocalConvoysMap();
    const entry = map[code];
    if (!entry) return;
    if (entry.doc) {
      applyConvoyDocSnapshot(entry.doc);
    }
    if (entry.members) {
      state.convoy.members.clear();
      Object.values(entry.members).forEach((m) => {
        state.convoy.members.set(m.id, m);
      });
      renderConvoyMemberMarkers();
      renderConvoyRosterList();
      updateConvoyHeaderBadges();
    }
  }

  async function initConvoySystem() {
    loadOrCreateDriverProfile();

    if ('BroadcastChannel' in window) {
      state.convoy.broadcastChannel = new BroadcastChannel('pulsenav_convoy_channel');
      state.convoy.broadcastChannel.onmessage = (ev) => {
        if (ev.data && ev.data.code === state.convoy.activeCode) {
          refreshFromLocalConvoyStore(state.convoy.activeCode);
        }
      };
    }

    window.addEventListener('storage', (ev) => {
      if (ev.key === STORAGE_KEY_LOCAL_CONVOYS && state.convoy.activeCode) {
        refreshFromLocalConvoyStore(state.convoy.activeCode);
      }
    });

    await initSupabaseClient();

    // Auto-join if URL has ?convoy=XXXXXX
    const params = new URLSearchParams(window.location.search);
    const urlCode = params.get('convoy');
    if (urlCode && /^[A-Za-z0-9]{6}$/.test(urlCode.trim())) {
      const cleanCode = urlCode.trim().toUpperCase();
      document.getElementById('joinConvoyCodeInput').value = cleanCode;
      document.getElementById('convoyModalBackdrop').classList.remove('hidden');
      await joinConvoyByCode(cleanCode);
    }
  }

  // ==========================================
  // 11. EVENT LISTENERS & UI BINDINGS
  // ==========================================
  function bindUIEvents() {
    // Locate Me Now & Dismiss buttons on bottom GPS bar
    document.getElementById('locateMeNowBtn').addEventListener('click', () => {
      startLiveGpsTracking(true);
    });

    document.getElementById('dismissGpsBarBtn').addEventListener('click', () => {
      document.getElementById('idleBottomBar').classList.add('hidden');
    });

    // Route alternative buttons
    document.querySelectorAll('.route-alt-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-route-idx'), 10);
        selectRouteAlternative(idx);
      });
    });

    // Start / Cancel / Reroute / Overview / Exit Navigation Controls
    document.getElementById('startNavBtn').addEventListener('click', startNavigation);
    document.getElementById('cancelRouteBtn').addEventListener('click', cancelRouteSelection);
    const toggleGraphBtn = document.getElementById('toggleGraphNodesBtn');
    if (toggleGraphBtn) {
      toggleGraphBtn.addEventListener('click', toggleGraphOverlay);
    }
    document.getElementById('stopNavBtn').addEventListener('click', () => stopNavigation(false));
    document.getElementById('recalcRouteBtn').addEventListener('click', recalculateActiveRoute);

    document.getElementById('overviewRouteBtn').addEventListener('click', () => {
      const route = state.routes[state.selectedRouteIdx];
      if (route && route.coords.length) {
        setFollowMode(false);
        if (state.map && typeof state.map.setBearing === 'function') {
          state.map.setBearing(0);
        }
        state.map.fitBounds(L.latLngBounds(route.coords), { padding: [70, 70], maxZoom: 16 });
      }
    });

    document.getElementById('speakCurrentStepBtn').addEventListener('click', () => {
      speakCurrentTurnInstruction(true);
    });

    // Right Floating Controls (Google Maps style "Your Location" button)
    document.getElementById('recenterBtn').addEventListener('click', () => {
      if (!state.hasLiveGpsLock) {
        // Location not detected yet: show bottom prompt bar & request browser geolocation
        startLiveGpsTracking(true);
      } else {
        setFollowMode(true);
        if (state.isNavigating && state.map && typeof state.map.setBearing === 'function') {
          state.map.setBearing(-state.userHeading);
        }
        state.map.flyTo([state.userPos.lat, state.userPos.lng], state.isNavigating ? 17 : 16, {
          animate: true,
          duration: 0.6
        });
        showGpsStatusBanner(3500);
      }
    });

    document.getElementById('themeToggleBtn').addEventListener('click', () => {
      applyTheme(state.theme === 'dark' ? 'day' : 'dark');
    });

    // Single Unified Voice Guidance Speaker & Slip Volume Slider
    const voiceControlContainer = document.getElementById('voiceControlContainer');
    const voiceToggleBtn = document.getElementById('voiceToggleBtn');
    const voiceSliderTrack = document.getElementById('voiceSliderTrack');
    const voiceVolumeSlider = document.getElementById('voiceVolumeSlider');

    if (voiceToggleBtn && voiceSliderTrack) {
      voiceToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isHidden = voiceSliderTrack.classList.contains('hidden');
        if (isHidden) {
          // Open the slip slider track
          voiceSliderTrack.classList.remove('hidden');
          voiceSliderTrack.classList.add('flex');
        } else {
          // If already open, clicking the single speaker button toggles mute / unmute
          if (state.voiceVolume > 0) {
            setVoiceVolume(0);
          } else {
            setVoiceVolume(state.lastUnmutedVolume || 1.0);
          }
        }
      });

      // Prevent clicks inside the slider track from collapsing it prematurely
      voiceSliderTrack.addEventListener('click', (e) => {
        e.stopPropagation();
      });

      // Close the slider track when clicking outside the voice control container
      document.addEventListener('click', (e) => {
        if (voiceControlContainer && !voiceControlContainer.contains(e.target)) {
          voiceSliderTrack.classList.add('hidden');
          voiceSliderTrack.classList.remove('flex');
        }
      });

      if (voiceVolumeSlider) {
        voiceVolumeSlider.addEventListener('input', (e) => {
          const val = parseInt(e.target.value, 10) / 100;
          setVoiceVolume(val);
        });
      }

      // Initialize UI to saved volume level
      setVoiceVolume(state.voiceVolume, false);
    }

    document.getElementById('zoomInBtn').addEventListener('click', () => state.map.zoomIn());
    document.getElementById('zoomOutBtn').addEventListener('click', () => state.map.zoomOut());

    // Top-Left Expandable Live Road Alert Ticker
    const tickerContainer = document.getElementById('liveTickerContainer');
    const tickerToggleBtn = document.getElementById('tickerToggleBtn');
    const tickerExpandedContent = document.getElementById('tickerExpandedContent');

    if (tickerToggleBtn && tickerExpandedContent) {
      tickerToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isHidden = tickerExpandedContent.classList.contains('hidden');
        if (isHidden) {
          tickerExpandedContent.classList.remove('hidden');
          tickerExpandedContent.classList.add('flex', 'animate-ticker-in');
        } else {
          tickerExpandedContent.classList.add('hidden');
          tickerExpandedContent.classList.remove('flex', 'animate-ticker-in');
        }
      });

      // Prevent clicks inside the expanded content from closing it
      tickerExpandedContent.addEventListener('click', (e) => {
        e.stopPropagation();
      });

      // Collapse when clicking anywhere outside on the map
      document.addEventListener('click', (e) => {
        if (tickerContainer && !tickerContainer.contains(e.target)) {
          tickerExpandedContent.classList.add('hidden');
          tickerExpandedContent.classList.remove('flex', 'animate-ticker-in');
        }
      });
    }

    // Live Alert Feed Drawer Controls
    const drawer = document.getElementById('liveFeedDrawer');
    const openDrawer = () => {
      // Auto-collapse ticker when opening drawer
      if (tickerExpandedContent) {
        tickerExpandedContent.classList.add('hidden');
        tickerExpandedContent.classList.remove('flex', 'animate-ticker-in');
      }
      renderFeedDrawerList();
      drawer.classList.remove('translate-x-full');
    };
    const closeDrawer = () => {
      drawer.classList.add('translate-x-full');
    };

    document.getElementById('toggleFeedBtn').addEventListener('click', openDrawer);
    document.getElementById('tickerOpenDrawerBtn').addEventListener('click', openDrawer);
    document.getElementById('closeFeedDrawerBtn').addEventListener('click', closeDrawer);
    document.getElementById('clearAllReportsBtn').addEventListener('click', clearAllReports);

    document.getElementById('drawerNewReportBtn').addEventListener('click', () => {
      closeDrawer();
      openReportModal();
    });

    // Feed Category Filter Pills
    document.querySelectorAll('.feed-filter-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.feedFilter = btn.getAttribute('data-filter');
        document.querySelectorAll('.feed-filter-btn').forEach((b) => {
          if (b.getAttribute('data-filter') === state.feedFilter) {
            b.className = 'feed-filter-btn btn-tactile px-3 py-1 rounded-full bg-sky-500 text-slate-950 font-bold text-xs shrink-0';
          } else {
            b.className = 'feed-filter-btn btn-tactile px-3 py-1 rounded-full bg-slate-800 text-slate-300 hover:bg-slate-700 font-semibold text-xs shrink-0';
          }
        });
        renderFeedDrawerList();
      });
    });

    // Community Report Modal Controls
    document.getElementById('openReportModalBtn').addEventListener('click', openReportModal);
    document.getElementById('closeReportModalBtn').addEventListener('click', closeReportModal);
    document.getElementById('reportModalBackdrop').addEventListener('click', (e) => {
      if (e.target.id === 'reportModalBackdrop') closeReportModal();
    });

    document.querySelectorAll('.report-cat-card').forEach((card) => {
      card.addEventListener('click', () => {
        selectModalCategory(card.getAttribute('data-cat'));
      });
    });

    document.getElementById('submitReportHereBtn').addEventListener('click', () => {
      addNewCommunityReport({
        category: state.modalCategory,
        subtype: state.modalSubtype,
        note: document.getElementById('reportCustomNote').value,
        durationMin: document.getElementById('reportDurationSelect').value,
        lat: state.userPos.lat,
        lng: state.userPos.lng
      });
      closeReportModal();
    });

    document.getElementById('submitReportTapMapBtn').addEventListener('click', startMapTapPlacement);
    document.getElementById('cancelPlacementBtn').addEventListener('click', cancelMapTapPlacement);

    // Hazard Approach Toast Confirm / Dismiss
    document.getElementById('toastConfirmBtn').addEventListener('click', () => {
      if (state.activeToastHazardId) {
        upvoteReport(state.activeToastHazardId);
      }
      document.getElementById('hazardApproachToast').classList.add('hidden');
    });

    document.getElementById('toastDismissBtn').addEventListener('click', () => {
      if (state.activeToastHazardId) {
        dismissReport(state.activeToastHazardId);
      }
      document.getElementById('hazardApproachToast').classList.add('hidden');
    });

    // Live Convoy Modal & Controls
    const openConvoyModal = () => {
      document.getElementById('convoyModalBackdrop').classList.remove('hidden');
      renderConvoyRosterList();
    };
    const closeConvoyModal = () => {
      updateDriverNameFromInput();
      document.getElementById('convoyModalBackdrop').classList.add('hidden');
    };

    document.getElementById('openConvoyModalBtn').addEventListener('click', openConvoyModal);
    document.getElementById('openConvoyRosterBtn').addEventListener('click', openConvoyModal);
    document.getElementById('closeConvoyModalBtn').addEventListener('click', closeConvoyModal);
    document.getElementById('convoyModalBackdrop').addEventListener('click', (e) => {
      if (e.target.id === 'convoyModalBackdrop') closeConvoyModal();
    });

    document.getElementById('convoyDriverNameInput').addEventListener('change', () => {
      updateDriverNameFromInput();
      broadcastMyConvoyTelemetry(true);
    });

    document.getElementById('createConvoyBtn').addEventListener('click', () => {
      createConvoyAsLeader();
    });

    document.getElementById('joinConvoyBtn').addEventListener('click', () => {
      const code = document.getElementById('joinConvoyCodeInput').value;
      joinConvoyByCode(code);
    });

    document.getElementById('leaveConvoyBtn').addEventListener('click', () => {
      leaveConvoy();
    });

    document.getElementById('copyConvoyLinkBtn').addEventListener('click', copyConvoyInviteLink);
    document.getElementById('modalCopyInviteBtn').addEventListener('click', copyConvoyInviteLink);

    document.querySelectorAll('.convoy-ping-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const msg = btn.getAttribute('data-convoy-ping');
        const icon = btn.getAttribute('data-ping-icon') || '🚘';
        broadcastConvoyPing(msg, icon);
      });
    });

    // Synchronize navigation controls spacing on screen resize / orientation changes
    window.addEventListener('resize', syncNavControlsPosition);

    // Automatically observe top overlay banners (turn-by-turn instruction, convoy pill) to dynamically avoid overlaps
    const topHeader = document.getElementById('topAppHeader') || document.querySelector('header');
    if (topHeader && window.ResizeObserver) {
      const headerObserver = new ResizeObserver(() => {
        syncNavControlsPosition();
      });
      headerObserver.observe(topHeader);
    }
    if (topHeader && window.MutationObserver) {
      const headerMutObserver = new MutationObserver(() => {
        syncNavControlsPosition();
      });
      headerMutObserver.observe(topHeader, { attributes: true, subtree: true, childList: true });
    }

    // Cleanly remove driver from active convoy if tab/window is closed
    window.addEventListener('beforeunload', () => {
      const code = state.convoy.activeCode;
      if (code && state.convoy.realtimeChannel) {
        try {
          state.convoy.realtimeChannel.send({
            type: 'broadcast',
            event: 'driver_left',
            payload: { id: state.convoy.driverId }
          });
        } catch (e) {
          // Ignore
        }
      }
    });
  }

  // Expose helper actions for inline popup/drawer handlers
  window.PulseNav = {
    upvoteReport,
    dismissReport,
    locateFromDrawer: (reportId) => {
      document.getElementById('liveFeedDrawer').classList.add('translate-x-full');
      focusReportOnMap(reportId);
    },
    focusConvoyDriver: (memberId) => {
      const m = state.convoy.members.get(memberId);
      if (!m) return;
      document.getElementById('convoyModalBackdrop').classList.add('hidden');
      setFollowMode(false);
      state.map.flyTo([m.lat, m.lng], 16, { animate: true, duration: 0.6 });
      const marker = state.convoy.memberMarkers.get(memberId);
      if (marker) marker.openPopup();
    }
  };

  // ==========================================
  // 12. BOOTSTRAP LIVE APPLICATION
  // ==========================================
  window.addEventListener('DOMContentLoaded', () => {
    ensureCleanRoutePreviewCardDom();
    initMap();
    setupSearchAndAutocomplete();
    bindUIEvents();
    loadReportsFromStorage();
    startLiveGpsTracking(true);
    initConvoySystem();

    // Auto-purge expired reports & refresh live community reports every 15 seconds
    setInterval(() => {
      purgeExpiredReports();
      syncCommunityReportsFromSupabase();
    }, 15000);
  });
})();

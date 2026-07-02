/**
 * Client-side search location for place/venue recommendations.
 * Priority on the server: explicit utterance > browser geolocation > saved default.
 * Precise coordinates are kept in memory for the session unless the user saves a label.
 */
const VERA_SEARCH_LOCATION_KEY = "vera_search_location_v1";

let _sessionGeoCoords = null;

function getSavedVeraSearchLocation() {
  try {
    const raw = localStorage.getItem(VERA_SEARCH_LOCATION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const label = String(parsed?.label || parsed?.location || "").trim();
    if (!label) return null;
    return {
      label,
      source: String(parsed?.source || "saved_default").trim() || "saved_default",
    };
  } catch (_) {
    return null;
  }
}

function setVeraSearchLocation(label, source = "saved_default") {
  const clean = String(label || "").trim();
  if (!clean) {
    clearVeraSearchLocation();
    return null;
  }
  const entry = {
    label: clean,
    location: clean,
    source: String(source || "saved_default").trim() || "saved_default",
    updated_at_ms: Date.now(),
  };
  try {
    localStorage.setItem(VERA_SEARCH_LOCATION_KEY, JSON.stringify(entry));
  } catch (_) {}
  return entry;
}

function clearVeraSearchLocation() {
  try {
    localStorage.removeItem(VERA_SEARCH_LOCATION_KEY);
  } catch (_) {}
}

function clearSessionBrowserGeolocation() {
  _sessionGeoCoords = null;
}

function requestBrowserGeolocationForSearch() {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const latitude = Number(pos?.coords?.latitude);
        const longitude = Number(pos?.coords?.longitude);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          resolve(null);
          return;
        }
        _sessionGeoCoords = {
          latitude,
          longitude,
          accuracy_m: Number(pos?.coords?.accuracy) || null,
          captured_at_ms: Date.now(),
        };
        resolve({ ..._sessionGeoCoords });
      },
      () => resolve(null),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
    );
  });
}

function getVeraSearchLocationSnapshot() {
  const saved = getSavedVeraSearchLocation();
  if (saved) {
    return {
      location: saved.label,
      source: saved.source,
      latitude: null,
      longitude: null,
    };
  }
  if (
    _sessionGeoCoords &&
    Number.isFinite(_sessionGeoCoords.latitude) &&
    Number.isFinite(_sessionGeoCoords.longitude)
  ) {
    return {
      location: "your current location",
      source: "browser_geolocation",
      latitude: _sessionGeoCoords.latitude,
      longitude: _sessionGeoCoords.longitude,
    };
  }
  return {
    location: "",
    source: "",
    latitude: null,
    longitude: null,
  };
}

async function ensureVeraSearchLocationForPlaces({ requestBrowser = false } = {}) {
  const current = getVeraSearchLocationSnapshot();
  if (current.location) return current;
  if (!requestBrowser) return current;
  await requestBrowserGeolocationForSearch();
  return getVeraSearchLocationSnapshot();
}

try {
  window.getSavedVeraSearchLocation = getSavedVeraSearchLocation;
  window.setVeraSearchLocation = setVeraSearchLocation;
  window.clearVeraSearchLocation = clearVeraSearchLocation;
  window.clearSessionBrowserGeolocation = clearSessionBrowserGeolocation;
  window.requestBrowserGeolocationForSearch = requestBrowserGeolocationForSearch;
  window.getVeraSearchLocationSnapshot = getVeraSearchLocationSnapshot;
  window.ensureVeraSearchLocationForPlaces = ensureVeraSearchLocationForPlaces;
} catch (_) {}

import { importLibrary, setOptions } from "@googlemaps/js-api-loader";

const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

let optionsSet = false;
let loadPromise: Promise<typeof google> | null = null;

// "maps" pulls in Map/Marker/Polygon/Polyline (via google.maps.SymbolPath
// too); "geocoding" pulls in google.maps.Geocoder for the same address
// resolution step mobile's expo-location does. importLibrary() internally
// de-dupes concurrent calls for the same library, but this module still
// only calls setOptions() once (it throws if called twice) and caches the
// combined load promise so every caller shares one in-flight load.
//
// Note: the Quote Tools linear distance measurer does NOT use Google's
// own geometry.spherical.computeLength() (even though this loader could
// pull that library in) - it uses packages/shared/src/geo.ts's
// polylineLengthMeters() instead, the same equirectangular-projection
// approach polygonFlatAreaSqm() already uses for roof facets, so desktop
// and mobile (which has no such Google library available via
// react-native-maps) compute identical totals from identical
// coordinates, not two independently-rounded numbers.
export function loadGoogleMaps(): Promise<typeof google> {
  if (!apiKey) {
    return Promise.reject(
      new Error(
        "Missing VITE_GOOGLE_MAPS_API_KEY. Copy .env.example to apps/desktop/.env and fill in a Google Maps JS API key - see docs/SETUP.md's roof measurement section."
      )
    );
  }
  if (!optionsSet) {
    setOptions({ key: apiKey, v: "weekly" });
    optionsSet = true;
  }
  if (!loadPromise) {
    loadPromise = importLibrary("maps").then(() => importLibrary("geocoding")).then(() => google);
  }
  return loadPromise;
}

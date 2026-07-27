const fs = require("fs");
const path = require("path");

// Replaces the previous static app.json - needed so GOOGLE_MAPS_API_KEY_ANDROID
// (see below) can be read in here. The Expo CLI only guarantees EXPO_PUBLIC_-
// prefixed .env vars are available to the JS bundle; it's not documented
// whether non-prefixed vars are in process.env by the time this file itself
// runs, so .env is parsed directly here rather than relying on that. Every
// other field is an unchanged copy of the old app.json.
function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return {};
  const values = {};
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    values[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return values;
}

const dotEnv = loadDotEnv();
// Deliberately NOT EXPO_PUBLIC_-prefixed - this is a native-only secret
// baked into AndroidManifest.xml at prebuild time by the react-native-maps
// config plugin below, never inlined into the JS bundle the way an
// EXPO_PUBLIC_ var would be. See docs/SETUP.md for how to obtain this key.
const googleMapsApiKeyAndroid = process.env.GOOGLE_MAPS_API_KEY_ANDROID || dotEnv.GOOGLE_MAPS_API_KEY_ANDROID;

module.exports = {
  expo: {
    name: "Bingley Job Management",
    slug: "jmssaas-mobile",
    scheme: "jmssaas",
    version: "1.0.0",
    orientation: "portrait",
    icon: "./assets/icon.png",
    userInterfaceStyle: "light",
    newArchEnabled: true,
    ios: {
      supportsTablet: true,
      bundleIdentifier: "au.bingley.jmssaas",
    },
    android: {
      package: "au.bingley.jmssaas",
      adaptiveIcon: {
        backgroundColor: "#E6F4FE",
        foregroundImage: "./assets/android-icon-foreground.png",
        backgroundImage: "./assets/android-icon-background.png",
        monochromeImage: "./assets/android-icon-monochrome.png",
      },
      predictiveBackGestureEnabled: false,
    },
    web: {
      favicon: "./assets/favicon.png",
      bundler: "metro",
      output: "single",
    },
    plugins: [
      "expo-router",
      "expo-dev-client",
      [
        "expo-image-picker",
        {
          photosPermission: "Bingley Job Management needs access to your photos to attach them to job cards.",
          cameraPermission: "Bingley Job Management needs camera access to photograph jobs on site.",
        },
      ],
      [
        "expo-camera",
        {
          cameraPermission: "Bingley Job Management needs camera access to photograph jobs and tasks on site.",
          microphonePermission:
            "Bingley Job Management does not record audio - this permission is requested by the camera module but unused.",
          recordAudioAndroid: false,
        },
      ],
      "@react-native-community/datetimepicker",
      // "When in use" only - the roof measurement screen uses this to
      // center the map on the technician's current position as a fallback
      // when the job's address can't be geocoded, never for background
      // tracking.
      [
        "expo-location",
        {
          locationWhenInUsePermission:
            "Bingley Job Management uses your location to center the map when measuring a roof.",
        },
      ],
      // iOS deliberately has no Google Maps key configured here - it uses
      // Apple's native MapKit by default (PROVIDER_DEFAULT), which still
      // supports mapType="satellite" with zero extra setup or cost.
      // Android has no Apple-Maps equivalent, so react-native-maps always
      // uses Google Maps there and the SDK genuinely requires a key just to
      // render any tiles, satellite or otherwise - see docs/SETUP.md.
      [
        "react-native-maps",
        {
          androidGoogleMapsApiKey: googleMapsApiKeyAndroid,
        },
      ],
    ],
  },
};

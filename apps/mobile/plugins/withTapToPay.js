const fs = require("fs");
const { AndroidConfig, withAndroidManifest, withDangerousMod, withProjectBuildGradle } = require("expo/config-plugins");

// Tap to Pay on Android (Stripe Terminal) runs its card-reading screen in
// a separate Android process of this same app. That process must not boot
// the whole React Native app again, so MainApplication.onCreate() has to
// return straight after super.onCreate() when it's running in the Tap to
// Pay process - Stripe's own instruction for React Native apps.
//
// Stripe's Expo plugin (@stripe/stripe-terminal-react-native's
// `tapToPayCheck` option) does the same thing, but it also adds
// ACCESS_FINE_LOCATION capped at android:maxSdkVersion="30", which would
// stop precise location working on Android 12+ for the rest of the app
// (timesheet location stamps, roof measuring). This plugin does only the
// guard. Tap to Pay itself needs no extra manifest entries: the location
// permission it asks for at runtime is already declared by expo-location.
//
// Stripe's Android library manifest declares that same cap itself, and the
// manifest merger would carry it into the app. So the app's own
// ACCESS_FINE_LOCATION entry gets tools:remove="android:maxSdkVersion",
// which keeps precise location on every Android version.
//
// It also pins the Kotlin Gradle plugin in the root build.gradle to
// `kotlinVersion`: Stripe Terminal's Android SDK ships Kotlin 2.3
// libraries that the Kotlin 2.1 compiler React Native 0.86 brings can't
// read, and per Stripe's README setting the kotlinVersion property alone
// (expo-build-properties) doesn't change the compiler - the classpath
// entry has to name the version. Pass the same version to both.
//
// A dangerous mod (runs after every other plugin's MainApplication edits,
// same approach as Stripe's) so the guard always lands immediately after
// super.onCreate(), ahead of anything other plugins add to onCreate().
const IMPORT = "import com.stripeterminalreactnative.TapToPay";
const GUARD = "    if (TapToPay.isInTapToPayProcess()) { return }";

const KGP_UNVERSIONED = "classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')";
const KGP_VERSIONED = /classpath\(['"]org\.jetbrains\.kotlin:kotlin-gradle-plugin(:[^'"]*)?['"]\)/;

function withTapToPay(config, { kotlinVersion } = {}) {
  if (!kotlinVersion) throw new Error("withTapToPay: pass { kotlinVersion }");
  config = withProjectBuildGradle(config, (config) => {
    const contents = config.modResults.contents;
    if (!KGP_VERSIONED.test(contents)) {
      throw new Error(`withTapToPay: couldn't find ${KGP_UNVERSIONED} in android/build.gradle`);
    }
    config.modResults.contents = contents.replace(KGP_VERSIONED, `classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:${kotlinVersion}")`);
    return config;
  });
  config = withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    manifest.$ = manifest.$ ?? {};
    manifest.$["xmlns:tools"] = manifest.$["xmlns:tools"] ?? "http://schemas.android.com/tools";
    const permissions = (manifest["uses-permission"] = manifest["uses-permission"] ?? []);
    let fine = permissions.find((p) => p.$?.["android:name"] === "android.permission.ACCESS_FINE_LOCATION");
    if (!fine) {
      fine = { $: { "android:name": "android.permission.ACCESS_FINE_LOCATION" } };
      permissions.push(fine);
    }
    delete fine.$["android:maxSdkVersion"];
    fine.$["tools:remove"] = "android:maxSdkVersion";
    return config;
  });
  return withDangerousMod(config, [
    "android",
    async (config) => {
      const { path: mainApplicationPath, language } = await AndroidConfig.Paths.getMainApplicationAsync(config.modRequest.projectRoot);
      if (language !== "kt") {
        throw new Error("withTapToPay: expected a Kotlin MainApplication.kt");
      }
      let contents = await fs.promises.readFile(mainApplicationPath, "utf8");
      if (!contents.includes(IMPORT)) {
        contents = contents.replace(/^(package [^\n]+\n)/m, `$1\n${IMPORT}\n`);
      }
      if (!contents.includes(`super.onCreate()\n${GUARD}`)) {
        contents = contents.replace(`\n${GUARD}`, "");
        if (!contents.includes("super.onCreate()")) {
          throw new Error("withTapToPay: couldn't find super.onCreate() in MainApplication.kt");
        }
        contents = contents.replace("super.onCreate()", `super.onCreate()\n${GUARD}`);
      }
      await fs.promises.writeFile(mainApplicationPath, contents, "utf8");
      return config;
    },
  ]);
}

module.exports = withTapToPay;

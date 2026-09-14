const { withMainActivity } = require("expo/config-plugins");

// Works around a React Native/Android framework crash: Activity.onUserLeaveHint()
// can be dispatched by the OS before ReactActivityDelegate has finished
// initializing (mReactDelegate still null on a fast cold launch), and
// ReactActivityDelegate#onUserLeaveHint() calls
// Objects.requireNonNull(mReactDelegate) unconditionally - throwing an NPE
// that crashes the whole app before any JS runs, with a plain white screen
// as the only symptom. There's no app-level (JS) way to guard this - it's a
// native Activity lifecycle callback the OS calls straight into React
// Native's own delegate class - so this patches the generated MainActivity
// (there's no committed android/ directory in this project; native code is
// regenerated fresh on every `eas build`/prebuild) to swallow the NPE.
// Losing this one lifecycle hint under that narrow startup race is
// harmless - onUserLeaveHint only ever signals multi-window/PiP
// transitions, nothing this app relies on.
function withOnUserLeaveHintFix(config) {
  return withMainActivity(config, (config) => {
    const { modResults } = config;

    if (modResults.contents.includes("onUserLeaveHint")) {
      return config; // Already patched (e.g. re-running prebuild).
    }

    const isKotlin = modResults.language === "kt";
    const classPattern = isKotlin
      ? /class MainActivity\s*:\s*ReactActivity\(\)\s*\{/
      : /public class MainActivity extends ReactActivity\s*\{/;

    if (!classPattern.test(modResults.contents)) {
      throw new Error(
        "withOnUserLeaveHintFix: could not find the expected MainActivity class declaration to patch " +
          "(template may have changed for this Expo SDK version) - update the pattern in " +
          "apps/mobile/plugins/withOnUserLeaveHintFix.js."
      );
    }

    const override = isKotlin
      ? `\n  // See plugins/withOnUserLeaveHintFix.js for why this override exists.\n` +
        `  override fun onUserLeaveHint() {\n` +
        `    try {\n` +
        `      super.onUserLeaveHint()\n` +
        `    } catch (e: NullPointerException) {\n` +
        `      // Known ReactActivityDelegate cold-launch race - see plugin comment.\n` +
        `    }\n` +
        `  }\n`
      : `\n  // See plugins/withOnUserLeaveHintFix.js for why this override exists.\n` +
        `  @Override\n` +
        `  public void onUserLeaveHint() {\n` +
        `    try {\n` +
        `      super.onUserLeaveHint();\n` +
        `    } catch (NullPointerException e) {\n` +
        `      // Known ReactActivityDelegate cold-launch race - see plugin comment.\n` +
        `    }\n` +
        `  }\n`;

    modResults.contents = modResults.contents.replace(classPattern, (match) => `${match}${override}`);
    return config;
  });
}

module.exports = withOnUserLeaveHintFix;

// Design token source for the "CRT terminal" UI theme - shared by both the
// mobile (React Native StyleSheet via a ThemeProvider) and desktop (CSS
// custom properties via a ThemeProvider) apps so a single accent/font/size
// choice drives the same look on both platforms. Framework-agnostic on
// purpose: no react-native or DOM imports here.

export type AccentId = "green" | "cyan" | "magenta" | "amber" | "purple" | "red";
export type FontSizeId = "small" | "medium" | "large";
export type FontFamilyId = "vt323" | "shareTechMono" | "jetbrainsMono";

export interface UIPreferences {
  accent: AccentId;
  fontSize: FontSizeId;
  fontFamily: FontFamilyId;
}

export const DEFAULT_UI_PREFERENCES: UIPreferences = {
  accent: "green",
  fontSize: "medium",
  fontFamily: "shareTechMono",
};

export interface ThemeTokens {
  background: string;
  surface: string;
  border: string;
  accent: string;
  accentGlow: string;
  textPrimary: string;
  textMuted: string;
  danger: string;
  warning: string;
}

interface AccentPreset {
  label: string;
  border: string;
  accent: string;
  accentGlow: string;
  textPrimary: string;
  danger: string;
}

// background/surface/text-muted are shared dark neutrals every accent sits
// on top of (per the reference screenshots' "same skin, different accent"
// look) - only border/accent/accent-glow/text-primary/danger vary per
// preset, so switching accent never leaves stray green-tinted borders or
// text behind.
const BASE_BACKGROUND = "#0a0f0a";
const BASE_SURFACE = "#0f1611";
const BASE_TEXT_MUTED = "#6f8f7a";

export const ACCENT_PRESETS: Record<AccentId, AccentPreset> = {
  green: {
    label: "Neon Green",
    border: "#1d3a24",
    accent: "#39ff6a",
    accentGlow: "rgba(57, 255, 106, 0.35)",
    textPrimary: "#c8ffd8",
    danger: "#ff4d4d",
  },
  cyan: {
    label: "Cyan",
    border: "#12363a",
    accent: "#39e6ff",
    accentGlow: "rgba(57, 230, 255, 0.35)",
    textPrimary: "#c8fbff",
    danger: "#ff6b6b",
  },
  magenta: {
    label: "Magenta",
    border: "#3a1230",
    accent: "#ff3ec8",
    accentGlow: "rgba(255, 62, 200, 0.35)",
    textPrimary: "#ffd6f2",
    danger: "#ff5c5c",
  },
  amber: {
    label: "Amber",
    border: "#3a2a10",
    accent: "#ffb020",
    accentGlow: "rgba(255, 176, 32, 0.35)",
    textPrimary: "#ffe8bf",
    danger: "#ff5c5c",
  },
  purple: {
    label: "Purple",
    border: "#24103f",
    accent: "#a855f7",
    accentGlow: "rgba(168, 85, 247, 0.35)",
    textPrimary: "#e6d4ff",
    danger: "#ff6b6b",
  },
  red: {
    label: "Red",
    border: "#3a1010",
    // Danger swaps to amber for this preset only, so an error/warning
    // reads as distinct from the red accent used everywhere else.
    accent: "#ff3b3b",
    accentGlow: "rgba(255, 59, 59, 0.35)",
    textPrimary: "#ffd6d6",
    danger: "#ffb020",
  },
};

export const ACCENT_OPTIONS: { id: AccentId; label: string }[] = (
  Object.keys(ACCENT_PRESETS) as AccentId[]
).map((id) => ({ id, label: ACCENT_PRESETS[id].label }));

export function buildThemeTokens(accent: AccentId): ThemeTokens {
  const preset = ACCENT_PRESETS[accent];
  return {
    background: BASE_BACKGROUND,
    surface: BASE_SURFACE,
    border: preset.border,
    accent: preset.accent,
    accentGlow: preset.accentGlow,
    textPrimary: preset.textPrimary,
    textMuted: BASE_TEXT_MUTED,
    danger: preset.danger,
    warning: "#ffb020",
  };
}

export interface FontScale {
  /** Small uppercase field/panel labels */
  label: number;
  /** Body text and readout values */
  body: number;
  /** Panel header / screen title */
  title: number;
  /** Button text */
  button: number;
}

const FONT_SIZE_MULTIPLIER: Record<FontSizeId, number> = {
  small: 0.88,
  medium: 1,
  large: 1.18,
};

const BASE_FONT_SCALE: FontScale = { label: 11, body: 15, title: 18, button: 15 };

export const FONT_SIZE_OPTIONS: { id: FontSizeId; label: string }[] = [
  { id: "small", label: "Small" },
  { id: "medium", label: "Medium" },
  { id: "large", label: "Large" },
];

export function buildFontScale(fontSize: FontSizeId): FontScale {
  const m = FONT_SIZE_MULTIPLIER[fontSize];
  return {
    label: Math.round(BASE_FONT_SCALE.label * m),
    body: Math.round(BASE_FONT_SCALE.body * m),
    title: Math.round(BASE_FONT_SCALE.title * m),
    button: Math.round(BASE_FONT_SCALE.button * m),
  };
}

export interface FontFamilyOption {
  id: FontFamilyId;
  label: string;
  /** Postscript name registered by the matching @expo-google-fonts/* package via useFonts(). */
  mobileFontFamily: string;
  /** CSS font-family stack, including the Google Fonts family name loaded in index.html. */
  webFontFamily: string;
}

// All three are open-license (SIL Open Font License) Google Fonts, free for
// commercial use with no attribution requirement - VT323 for the classic
// pixel-terminal look, Share Tech Mono as a still-retro but more legible
// default, JetBrains Mono as the most readable option for long text.
export const FONT_FAMILY_OPTIONS: FontFamilyOption[] = [
  {
    id: "vt323",
    label: "VT323 (Classic Terminal)",
    mobileFontFamily: "VT323_400Regular",
    webFontFamily: "'VT323', monospace",
  },
  {
    id: "shareTechMono",
    label: "Share Tech Mono",
    mobileFontFamily: "ShareTechMono_400Regular",
    webFontFamily: "'Share Tech Mono', monospace",
  },
  {
    id: "jetbrainsMono",
    label: "JetBrains Mono",
    mobileFontFamily: "JetBrainsMono_400Regular",
    webFontFamily: "'JetBrains Mono', monospace",
  },
];

// Matches DEFAULT_UI_PREFERENCES.fontFamily - used as the fallback if an
// unrecognised id ever reaches getFontFamilyOption (e.g. stale persisted
// preferences from a future version of this file).
const DEFAULT_FONT_FAMILY_OPTION = FONT_FAMILY_OPTIONS[1] as FontFamilyOption;

export function getFontFamilyOption(id: FontFamilyId): FontFamilyOption {
  return FONT_FAMILY_OPTIONS.find((f) => f.id === id) ?? DEFAULT_FONT_FAMILY_OPTION;
}

export interface Theme {
  tokens: ThemeTokens;
  font: FontScale;
  fontFamily: FontFamilyOption;
  prefs: UIPreferences;
}

export function buildTheme(prefs: UIPreferences): Theme {
  return {
    tokens: buildThemeTokens(prefs.accent),
    font: buildFontScale(prefs.fontSize),
    fontFamily: getFontFamilyOption(prefs.fontFamily),
    prefs,
  };
}

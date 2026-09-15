import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  buildTheme,
  DEFAULT_UI_PREFERENCES,
  type AccentId,
  type FontFamilyId,
  type FontSizeId,
  type Theme,
  type UIPreferences,
} from "@jmssaas/shared";

const STORAGE_KEY = "jms-ui-preferences";

interface ThemeContextValue extends Theme {
  setAccent: (accent: AccentId) => void;
  setFontSize: (fontSize: FontSizeId) => void;
  setFontFamily: (fontFamily: FontFamilyId) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function isUIPreferences(value: unknown): value is UIPreferences {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.accent === "string" && typeof v.fontSize === "string" && typeof v.fontFamily === "string";
}

function loadPreferences(): UIPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_UI_PREFERENCES;
    const parsed: unknown = JSON.parse(raw);
    return isUIPreferences(parsed) ? { ...DEFAULT_UI_PREFERENCES, ...parsed } : DEFAULT_UI_PREFERENCES;
  } catch {
    return DEFAULT_UI_PREFERENCES;
  }
}

// Same local-per-device persistence choice as mobile (see
// apps/mobile/lib/theme-context.tsx) - a cosmetic browser preference, not
// tenant business data, so plain localStorage rather than a Supabase column.
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<UIPreferences>(loadPreferences);
  const theme = buildTheme(prefs);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  }, [prefs]);

  // Only the CRT-themed pages (currently UI Settings) actually read these
  // custom properties via Tailwind arbitrary values - writing them to
  // :root here doesn't visually affect the rest of the app, which still
  // uses its normal light Tailwind palette.
  useEffect(() => {
    const root = document.documentElement.style;
    const { tokens, font, fontFamily } = theme;
    root.setProperty("--jms-bg", tokens.background);
    root.setProperty("--jms-surface", tokens.surface);
    root.setProperty("--jms-border", tokens.border);
    root.setProperty("--jms-accent", tokens.accent);
    root.setProperty("--jms-accent-glow", tokens.accentGlow);
    root.setProperty("--jms-text", tokens.textPrimary);
    root.setProperty("--jms-text-muted", tokens.textMuted);
    root.setProperty("--jms-danger", tokens.danger);
    root.setProperty("--jms-warning", tokens.warning);
    root.setProperty("--jms-font", fontFamily.webFontFamily);
    root.setProperty("--jms-font-label", `${font.label}px`);
    root.setProperty("--jms-font-body", `${font.body}px`);
    root.setProperty("--jms-font-title", `${font.title}px`);
    root.setProperty("--jms-font-button", `${font.button}px`);
  }, [theme]);

  const value: ThemeContextValue = {
    ...theme,
    setAccent: (accent) => setPrefs((p) => ({ ...p, accent })),
    setFontSize: (fontSize) => setPrefs((p) => ({ ...p, fontSize })),
    setFontFamily: (fontFamily) => setPrefs((p) => ({ ...p, fontFamily })),
  };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}

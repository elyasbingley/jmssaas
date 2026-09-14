import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useFonts as useVT323Fonts, VT323_400Regular } from "@expo-google-fonts/vt323";
import { useFonts as useShareTechMonoFonts, ShareTechMono_400Regular } from "@expo-google-fonts/share-tech-mono";
import { useFonts as useJetBrainsMonoFonts, JetBrainsMono_400Regular } from "@expo-google-fonts/jetbrains-mono";
import {
  buildTheme,
  DEFAULT_UI_PREFERENCES,
  type AccentId,
  type FontFamilyId,
  type FontSizeId,
  type Theme,
  type UIPreferences,
} from "@jmssaas/shared";

const STORAGE_KEY = "jms:ui-preferences";

interface ThemeContextValue extends Theme {
  /** False until fonts have finished loading and the persisted preference has been read. */
  isReady: boolean;
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

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setPrefs] = useState<UIPreferences>(DEFAULT_UI_PREFERENCES);
  const [hydrated, setHydrated] = useState(false);

  // Preference is local-per-device (AsyncStorage), not synced through
  // Supabase - this is a cosmetic device setting like OS dark mode, not
  // tenant business data, so it doesn't need a schema migration/RLS policy.
  // Trade-off: it won't follow the user to a second device. Worth revisiting
  // as a `profiles` column if cross-device sync turns out to matter.
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (!raw) return;
        const parsed: unknown = JSON.parse(raw);
        if (isUIPreferences(parsed)) {
          setPrefs({ ...DEFAULT_UI_PREFERENCES, ...parsed });
        }
      })
      .catch(() => {})
      .finally(() => setHydrated(true));
  }, []);

  const persist = (next: UIPreferences) => {
    setPrefs(next);
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => {});
  };

  const [vt323Loaded] = useVT323Fonts({ VT323_400Regular });
  const [shareTechMonoLoaded] = useShareTechMonoFonts({ ShareTechMono_400Regular });
  const [jetBrainsMonoLoaded] = useJetBrainsMonoFonts({ JetBrainsMono_400Regular });
  const fontsLoaded = vt323Loaded && shareTechMonoLoaded && jetBrainsMonoLoaded;

  const theme = useMemo(() => buildTheme(prefs), [prefs]);

  const value: ThemeContextValue = {
    ...theme,
    isReady: hydrated && fontsLoaded,
    setAccent: (accent) => persist({ ...prefs, accent }),
    setFontSize: (fontSize) => persist({ ...prefs, fontSize }),
    setFontFamily: (fontFamily) => persist({ ...prefs, fontFamily }),
  };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}

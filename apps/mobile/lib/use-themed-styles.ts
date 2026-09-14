import { useMemo } from "react";
import { StyleSheet } from "react-native";
import type { FontFamilyOption, FontScale, ThemeTokens } from "@jmssaas/shared";
import { useTheme } from "./theme-context";

export interface StyleTheme {
  tokens: ThemeTokens;
  font: FontScale;
  fontFamily: FontFamilyOption;
}

/**
 * Drop-in replacement for `const styles = StyleSheet.create({...})` for
 * screens/components that need theme tokens. Define the factory at module
 * scope (same as a plain StyleSheet.create call today) so its reference is
 * stable and this only recomputes when the theme itself changes:
 *
 *   function createStyles({ tokens, font, fontFamily }: StyleTheme) {
 *     return StyleSheet.create({ ... });
 *   }
 *   const styles = useThemedStyles(createStyles);
 */
export function useThemedStyles<T extends StyleSheet.NamedStyles<T>>(
  factory: (theme: StyleTheme) => T
): T {
  const { tokens, font, fontFamily } = useTheme();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => StyleSheet.create(factory({ tokens, font, fontFamily })), [tokens, font, fontFamily, factory]);
}

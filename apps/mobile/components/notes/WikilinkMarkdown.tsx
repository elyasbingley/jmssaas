import { useMemo } from "react";
import { Text, View } from "react-native";
import Markdown from "react-native-markdown-display";
import { WIKILINK_REGEX, type FontFamilyOption, type FontScale, type ThemeTokens } from "@jmssaas/shared";
import { useTheme } from "../../lib/theme-context";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";

// Renders a note's markdown body for the Preview view, with [[wikilinks]]
// made tappable. react-native-markdown-display only knows standard
// markdown, so [[Target]]/[[Target|Alias]] is rewritten to an ordinary
// markdown link pointing at a made-up `wikilink://` scheme first, then
// intercepted via onLinkPress instead of letting it fall through to
// Linking.openURL (which has no handler for that scheme). Reuses the exact
// WIKILINK_REGEX the notes_module migration's trigger and extractWikilinks()
// use, so "what counts as a link" never drifts between preview and save.
const WIKILINK_SCHEME = "wikilink://";

function toMarkdownLinkSyntax(body: string): string {
  return body.replace(WIKILINK_REGEX, (_match: string, target: string, _aliasGroup?: string, alias?: string) => {
    const rawLabel = (alias ?? target ?? "").trim();
    const label = (rawLabel || target || "").trim() || "untitled";
    const safeTarget = (target ?? "").trim();
    return `[${label}](${WIKILINK_SCHEME}${encodeURIComponent(safeTarget)})`;
  });
}

interface WikilinkMarkdownProps {
  body: string;
  /** Called with the raw (decoded) target title when a wikilink is tapped. */
  onOpenWikilink: (title: string) => void;
}

export function WikilinkMarkdown({ body, onOpenWikilink }: WikilinkMarkdownProps) {
  const { tokens, font, fontFamily } = useTheme();
  const styles = useThemedStyles(createStyles);
  const transformed = useMemo(() => toMarkdownLinkSyntax(body), [body]);
  const markdownStyle = useMemo(() => buildMarkdownStyle(tokens, font, fontFamily), [tokens, font, fontFamily]);

  const handleLinkPress = (url: string): boolean => {
    if (url.startsWith(WIKILINK_SCHEME)) {
      const title = decodeURIComponent(url.slice(WIKILINK_SCHEME.length));
      onOpenWikilink(title);
      return false;
    }
    return true;
  };

  if (!body.trim()) {
    return <Text style={styles.empty}>Nothing here yet. Switch to Edit to start writing.</Text>;
  }

  return (
    <View>
      <Markdown style={markdownStyle} onLinkPress={handleLinkPress}>
        {transformed}
      </Markdown>
    </View>
  );
}

// Deliberately NOT built with useThemedStyles()/StyleSheet.create() - this
// is react-native-markdown-display's own node-type-keyed style map (keys
// like `heading1`/`link`/`code_inline`, each a *different* partial style
// shape), not a flat StyleSheet.NamedStyles<T> of same-shaped view/text
// styles, so it doesn't fit that helper's generic constraint.
function buildMarkdownStyle(tokens: ThemeTokens, font: FontScale, fontFamily: FontFamilyOption) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    body: { color: tokens.textPrimary, fontSize: font.body, ...mono },
    heading1: { color: tokens.accent, fontSize: font.title + 2, fontWeight: "700", marginTop: 4, marginBottom: 8, ...mono },
    heading2: { color: tokens.accent, fontSize: font.title, fontWeight: "700", marginTop: 4, marginBottom: 6, ...mono },
    heading3: { color: tokens.accent, fontSize: font.title - 2, fontWeight: "700", marginTop: 4, marginBottom: 6, ...mono },
    heading4: { color: tokens.accent, fontSize: font.body + 1, fontWeight: "700", ...mono },
    link: { color: tokens.accent, textDecorationLine: "underline" },
    strong: { fontWeight: "700" },
    em: { fontStyle: "italic" },
    blockquote: {
      backgroundColor: tokens.surface,
      borderLeftColor: tokens.accent,
      borderLeftWidth: 3,
      paddingHorizontal: 10,
      paddingVertical: 6,
      marginVertical: 6,
    },
    code_inline: { backgroundColor: tokens.surface, color: tokens.accent, ...mono },
    code_block: { backgroundColor: tokens.surface, color: tokens.textPrimary, borderRadius: 4, padding: 8, ...mono },
    fence: { backgroundColor: tokens.surface, color: tokens.textPrimary, borderRadius: 4, padding: 8, ...mono },
    hr: { backgroundColor: tokens.border, height: 1 },
    bullet_list_icon: { color: tokens.accent },
    ordered_list_icon: { color: tokens.accent },
    table: { borderColor: tokens.border, borderWidth: 1 },
    thead: { backgroundColor: tokens.surface },
    th: { color: tokens.accent, padding: 6, ...mono },
    td: { color: tokens.textPrimary, padding: 6, ...mono },
    tr: { borderColor: tokens.border, borderBottomWidth: 1 },
    s: { textDecorationLine: "line-through" },
  } as const;
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    empty: { color: tokens.textMuted, fontSize: font.body - 1, fontStyle: "italic" as const, padding: 4, ...mono },
  };
}

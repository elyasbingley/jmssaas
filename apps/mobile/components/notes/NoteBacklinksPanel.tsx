import { Pressable, Text, View } from "react-native";
import { useBacklinks } from "../../lib/use-notes";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";
import { Panel } from "../theme/Panel";

interface NoteBacklinksPanelProps {
  noteId: string;
  onOpenNote: (noteId: string) => void;
}

// Offline-available but may lag behind the true server state until this
// device's next sync, since note_links is only ever written by the
// Postgres trigger (notes_recompute_links_and_tags) - see use-notes.ts's
// useBacklinks() and the notes_module migration's own comments. That's an
// accepted, documented trade-off for this module, not a bug.
export function NoteBacklinksPanel({ noteId, onOpenNote }: NoteBacklinksPanelProps) {
  const backlinks = useBacklinks(noteId);
  const styles = useThemedStyles(createStyles);

  return (
    <Panel title="Backlinks" status={`${backlinks.length}`}>
      {backlinks.length === 0 ? (
        <Text style={styles.empty}>No other notes link here yet.</Text>
      ) : (
        backlinks.map((link) => (
          <Pressable key={link.link_id} style={styles.row} onPress={() => onOpenNote(link.source_note_id)}>
            <Text style={styles.rowTitle}>{link.title}</Text>
            <Text style={styles.chevron}>{"›"}</Text>
          </Pressable>
        ))
      )}
    </Panel>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    empty: { color: tokens.textMuted, fontSize: font.body - 1, ...mono },
    row: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      paddingVertical: 8,
    },
    rowTitle: { color: tokens.accent, fontSize: font.body - 1, fontWeight: "600" as const, flex: 1, ...mono },
    chevron: { color: tokens.accent, fontSize: font.body + 2 },
  };
}

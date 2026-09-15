import { Text, View } from "react-native";
import { useQuery } from "@powersync/react";
import type { ScheduledCommunicationEntityType, ScheduledCommunicationStatus, ThemeTokens } from "@jmssaas/shared";
import { useTheme } from "../../lib/theme-context";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";

interface CommunicationLogRow {
  id: string;
  channel: string;
  recipient_phone_or_email: string;
  rendered_subject: string | null;
  rendered_body: string;
  scheduled_for: string;
  status: ScheduledCommunicationStatus;
  sent_at: string | null;
  cancellation_reason: string | null;
  failure_reason: string | null;
}

interface ThemedCommunicationLogProps {
  entities: { entityType: ScheduledCommunicationEntityType; entityId: string }[];
}

const STATUS_LABELS: Record<ScheduledCommunicationStatus, string> = {
  pending: "Pending",
  sent: "Sent",
  cancelled: "Cancelled",
  failed: "Failed",
};

function statusColor(status: ScheduledCommunicationStatus, tokens: ThemeTokens): string {
  switch (status) {
    case "sent":
      return tokens.accent;
    case "failed":
      return tokens.danger;
    case "cancelled":
      return tokens.textMuted;
    default:
      return tokens.warning;
  }
}

// Theme-aware sibling of components/CommunicationLog.tsx - identical
// read-only query/rendering, only the styling changes. See ThemedModal.tsx
// for why this isn't a retheme of the shared original (also used by the
// unthemed Client and Task detail screens).
export function ThemedCommunicationLog({ entities }: ThemedCommunicationLogProps) {
  const { tokens } = useTheme();
  const styles = useThemedStyles(createStyles);
  const whereClause = entities.map(() => "(entity_type = ? AND entity_id = ?)").join(" OR ");
  const params = entities.flatMap((e) => [e.entityType, e.entityId]);

  const { data: rows } = useQuery<CommunicationLogRow>(
    entities.length > 0
      ? `SELECT id, channel, recipient_phone_or_email, rendered_subject, rendered_body, scheduled_for, status, sent_at, cancellation_reason, failure_reason
           FROM scheduled_communications
          WHERE ${whereClause}
          ORDER BY scheduled_for DESC`
      : `SELECT id, channel, recipient_phone_or_email, rendered_subject, rendered_body, scheduled_for, status, sent_at, cancellation_reason, failure_reason
           FROM scheduled_communications
          WHERE 1 = 0`,
    params
  );

  if (rows.length === 0) {
    return <Text style={styles.empty}>No messages yet.</Text>;
  }

  return (
    <View>
      {rows.map((row) => (
        <View key={row.id} style={styles.row}>
          <View style={styles.rowHeader}>
            <Text style={styles.channel}>{row.channel.toUpperCase()}</Text>
            <Text style={[styles.badgeText, { color: statusColor(row.status, tokens) }]}>
              {STATUS_LABELS[row.status].toUpperCase()}
            </Text>
          </View>
          <Text style={styles.recipient}>{row.recipient_phone_or_email || "No recipient on file"}</Text>
          {row.rendered_subject ? <Text style={styles.subject}>{row.rendered_subject}</Text> : null}
          <Text style={styles.body} numberOfLines={3}>
            {row.rendered_body}
          </Text>
          <Text style={styles.meta}>
            {row.status === "sent" && row.sent_at
              ? `Sent ${new Date(row.sent_at).toLocaleString()}`
              : row.status === "cancelled"
                ? `Cancelled${row.cancellation_reason ? ` - ${row.cancellation_reason}` : ""}`
                : row.status === "failed"
                  ? `Failed${row.failure_reason ? ` - ${row.failure_reason}` : ""}`
                  : `Scheduled for ${new Date(row.scheduled_for).toLocaleString()}`}
          </Text>
        </View>
      ))}
    </View>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  return {
    empty: { textAlign: "center" as const, color: tokens.textMuted, padding: 12, fontFamily: fontFamily.mobileFontFamily },
    row: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: tokens.border, gap: 3 },
    rowHeader: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const },
    channel: { fontSize: font.label, fontWeight: "700" as const, color: tokens.textMuted, fontFamily: fontFamily.mobileFontFamily, letterSpacing: 1 },
    badgeText: { fontSize: font.label, fontWeight: "700" as const, fontFamily: fontFamily.mobileFontFamily, letterSpacing: 1 },
    recipient: { fontSize: font.body - 2, fontWeight: "600" as const, color: tokens.textPrimary, fontFamily: fontFamily.mobileFontFamily },
    subject: { fontSize: font.body - 2, fontWeight: "600" as const, color: tokens.textPrimary, marginTop: 2, fontFamily: fontFamily.mobileFontFamily },
    body: { fontSize: font.body - 2, color: tokens.textMuted, marginTop: 2, fontFamily: fontFamily.mobileFontFamily },
    meta: { fontSize: font.label - 1, color: tokens.textMuted, marginTop: 4, fontFamily: fontFamily.mobileFontFamily },
  };
}

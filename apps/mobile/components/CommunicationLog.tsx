import { StyleSheet, Text, View } from "react-native";
import { useQuery } from "@powersync/react";
import type { ScheduledCommunicationEntityType, ScheduledCommunicationStatus } from "@jmssaas/shared";

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

interface CommunicationLogProps {
  // One row per (entity_type, entity_id) to include - scheduled_
  // communications has no client_id column of its own (a message is always
  // scoped to the quote/invoice/job it was scheduled against, see the
  // communication_engine migration), so showing "everything relevant to
  // this screen" means the caller supplying every entity that's relevant:
  // the job detail screen passes the job itself plus its linked quotes/
  // invoices; the client detail screen passes each of the client's jobs
  // (quote/invoice follow-ups aren't included there - see that screen's
  // own comment on why).
  entities: { entityType: ScheduledCommunicationEntityType; entityId: string }[];
}

const STATUS_LABELS: Record<ScheduledCommunicationStatus, string> = {
  pending: "Pending",
  sent: "Sent",
  cancelled: "Cancelled",
  failed: "Failed",
};

// Shared by the job detail screen and the client detail screen. Read-only -
// editing/cancelling a queued message isn't supported from here, only from
// Automation & Messaging Settings (which edits the underlying rule/
// template, not an individual queued row).
export function CommunicationLog({ entities }: CommunicationLogProps) {
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
            <View style={[styles.badge, styles[`badge_${row.status}` as const]]}>
              <Text style={styles.badgeText}>{STATUS_LABELS[row.status]}</Text>
            </View>
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

const styles = StyleSheet.create({
  empty: { textAlign: "center", color: "#6b7280", padding: 12 },
  row: {
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#d1d5db",
    gap: 3,
  },
  rowHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  channel: { fontSize: 12, fontWeight: "700", color: "#6b7280" },
  badge: { borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2, backgroundColor: "#f3f4f6" },
  badge_pending: { backgroundColor: "#fef9c3" },
  badge_sent: { backgroundColor: "#dcfce7" },
  badge_cancelled: { backgroundColor: "#f3f4f6" },
  badge_failed: { backgroundColor: "#fee2e2" },
  badgeText: { fontSize: 11, fontWeight: "700", color: "#374151" },
  recipient: { fontSize: 13, fontWeight: "600", color: "#111827" },
  subject: { fontSize: 13, fontWeight: "600", color: "#111827", marginTop: 2 },
  body: { fontSize: 13, color: "#374151", marginTop: 2 },
  meta: { fontSize: 11, color: "#9ca3af", marginTop: 4 },
});

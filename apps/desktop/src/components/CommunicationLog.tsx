import { useQuery } from "@tanstack/react-query";
import type { ScheduledCommunicationEntityType, ScheduledCommunicationStatus } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";

// Direct port of apps/mobile/components/CommunicationLog.tsx - same
// caller-supplies-every-relevant-entity shape (scheduled_communications
// has no client_id column of its own, see that file's own comment), same
// read-only history view. Desktop has no local SQLite to filter client-
// side, so the entity list becomes a Supabase .or() filter instead of a
// parameterized SQL WHERE clause.

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
  entities: { entityType: ScheduledCommunicationEntityType; entityId: string }[];
}

const STATUS_LABELS: Record<ScheduledCommunicationStatus, string> = {
  pending: "Pending",
  sent: "Sent",
  cancelled: "Cancelled",
  failed: "Failed",
};

const STATUS_BADGE_CLASSES: Record<ScheduledCommunicationStatus, string> = {
  pending: "bg-yellow-100 text-gray-700",
  sent: "bg-green-100 text-gray-700",
  cancelled: "bg-gray-100 text-gray-700",
  failed: "bg-red-100 text-gray-700",
};

async function fetchLog(
  entities: { entityType: ScheduledCommunicationEntityType; entityId: string }[]
): Promise<CommunicationLogRow[]> {
  if (entities.length === 0) return [];
  const filter = entities.map((e) => `and(entity_type.eq.${e.entityType},entity_id.eq.${e.entityId})`).join(",");
  const { data, error } = await supabase
    .from("scheduled_communications")
    .select("id, channel, recipient_phone_or_email, rendered_subject, rendered_body, scheduled_for, status, sent_at, cancellation_reason, failure_reason")
    .or(filter)
    .order("scheduled_for", { ascending: false });
  if (error) throw error;
  return data as CommunicationLogRow[];
}

export function CommunicationLog({ entities }: CommunicationLogProps) {
  const key = entities.map((e) => `${e.entityType}:${e.entityId}`).sort().join(",");
  const { data: rows } = useQuery({ queryKey: ["communication-log", key], queryFn: () => fetchLog(entities) });

  if (!rows || rows.length === 0) {
    return <p className="p-3 text-center text-sm text-gray-500">No messages yet.</p>;
  }

  return (
    <div className="divide-y divide-gray-100">
      {rows.map((row) => (
        <div key={row.id} className="py-2.5 first:pt-0">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-bold text-gray-500">{row.channel.toUpperCase()}</span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${STATUS_BADGE_CLASSES[row.status]}`}>
              {STATUS_LABELS[row.status]}
            </span>
          </div>
          <p className="mt-0.5 text-sm font-semibold text-gray-900">{row.recipient_phone_or_email || "No recipient on file"}</p>
          {row.rendered_subject ? <p className="mt-0.5 text-sm font-semibold text-gray-900">{row.rendered_subject}</p> : null}
          <p className="mt-0.5 line-clamp-3 text-sm text-gray-700">{row.rendered_body}</p>
          <p className="mt-1 text-xs text-gray-400">
            {row.status === "sent" && row.sent_at
              ? `Sent ${new Date(row.sent_at).toLocaleString()}`
              : row.status === "cancelled"
                ? `Cancelled${row.cancellation_reason ? ` - ${row.cancellation_reason}` : ""}`
                : row.status === "failed"
                  ? `Failed${row.failure_reason ? ` - ${row.failure_reason}` : ""}`
                  : `Scheduled for ${new Date(row.scheduled_for).toLocaleString()}`}
          </p>
        </div>
      ))}
    </div>
  );
}

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { KeyLog, Profile, Property } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { getErrorMessage } from "../lib/errors";

// Real-time-ish status table over key_logs, plus the spec's "4:00pm and a
// key still hasn't come back" banner. There's no scheduled server-side job
// for the banner (a daily Edge Function sweep would need its own delivery
// channel - push notification, email, something - which the spec doesn't
// ask for); instead it's computed client-side every time an admin has this
// tab open, comparing the local wall clock against 4pm today. That means
// it only actually fires while someone's looking at this screen, which is
// an acceptable gap for a v1 given the alternative isn't in scope here -
// see docs/SETUP.md's write-up for this batch.

async function fetchOpenKeyLogs(): Promise<KeyLog[]> {
  const { data, error } = await supabase
    .from("key_logs")
    .select("*")
    .in("status", ["picked_up", "in_van", "returned", "at_office"])
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return data as KeyLog[];
}
async function fetchProperties(): Promise<Property[]> {
  const { data, error } = await supabase.from("properties").select("*");
  if (error) throw error;
  return data as Property[];
}
async function fetchTechnicians(): Promise<Profile[]> {
  const { data, error } = await supabase.from("profiles").select("*").eq("role", "technician");
  if (error) throw error;
  return data as Profile[];
}

const STATUS_LABELS: Record<KeyLog["status"], string> = {
  at_office: "At Office",
  picked_up: "Picked Up",
  in_van: "In Van",
  returned: "Returned",
};

const STATUS_BADGE_CLASSES: Record<KeyLog["status"], string> = {
  at_office: "bg-gray-100 text-gray-700",
  picked_up: "bg-yellow-100 text-yellow-800",
  in_van: "bg-blue-100 text-blue-800",
  returned: "bg-green-100 text-green-800",
};

function isPastFourPmToday(now: Date): boolean {
  return now.getHours() >= 16;
}

export function KeyManagementDashboard() {
  const queryClient = useQueryClient();
  const { data: keyLogs } = useQuery({ queryKey: ["key-logs"], queryFn: fetchOpenKeyLogs });
  const { data: properties } = useQuery({ queryKey: ["properties"], queryFn: fetchProperties });
  const { data: technicians } = useQuery({ queryKey: ["technicians"], queryFn: fetchTechnicians });

  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(interval);
  }, []);

  const [actionError, setActionError] = useState<string | null>(null);

  const markReturned = useMutation({
    mutationFn: async (keyLog: KeyLog) => {
      const { error } = await supabase
        .from("key_logs")
        .update({ status: "returned", returned_at: new Date().toISOString() })
        .eq("id", keyLog.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["key-logs"] });
      setActionError(null);
    },
    onError: (e) => setActionError(getErrorMessage(e, "Failed to mark key returned")),
  });

  const propertyById = new Map((properties ?? []).map((p) => [p.id, p]));
  const technicianById = new Map((technicians ?? []).map((t) => [t.id, t]));

  const unreturnedRows = (keyLogs ?? []).filter((k) => k.status === "picked_up" || k.status === "in_van");
  const overdueRows = isPastFourPmToday(now) ? unreturnedRows : [];

  return (
    <div>
      {overdueRows.length > 0 ? (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-4">
          <p className="text-sm font-bold text-red-800">
            {overdueRows.length} key{overdueRows.length === 1 ? "" : "s"} not yet returned past 4:00pm
          </p>
          <ul className="mt-1 space-y-0.5 text-sm text-red-700">
            {overdueRows.map((k) => {
              const property = propertyById.get(k.property_id);
              return (
                <li key={k.id}>
                  {k.key_tag_number} - {property ? property.address_line1 : "Unknown property"} ({STATUS_LABELS[k.status]})
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {actionError ? <p className="mb-4 text-sm text-red-600">{actionError}</p> : null}

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        {!keyLogs || keyLogs.length === 0 ? (
          <p className="p-6 text-sm text-gray-500">No key activity logged yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-2 font-semibold">Key Tag #</th>
                <th className="px-4 py-2 font-semibold">Property Address</th>
                <th className="px-4 py-2 font-semibold">Assigned Tech</th>
                <th className="px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2 font-semibold"></th>
              </tr>
            </thead>
            <tbody>
              {keyLogs.map((keyLog) => {
                const property = propertyById.get(keyLog.property_id);
                const technician = keyLog.technician_id ? technicianById.get(keyLog.technician_id) : null;
                const overdue = isPastFourPmToday(now) && (keyLog.status === "picked_up" || keyLog.status === "in_van");
                return (
                  <tr key={keyLog.id} className={`border-b border-gray-100 last:border-0 ${overdue ? "bg-red-50" : ""}`}>
                    <td className="px-4 py-3 font-medium text-gray-900">{keyLog.key_tag_number}</td>
                    <td className="px-4 py-3 text-gray-700">{property ? property.address_line1 : "-"}</td>
                    <td className="px-4 py-3 text-gray-700">{technician ? technician.full_name : "-"}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_BADGE_CLASSES[keyLog.status]}`}>
                        {STATUS_LABELS[keyLog.status]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {keyLog.status !== "returned" ? (
                        <button
                          onClick={() => markReturned.mutate(keyLog)}
                          disabled={markReturned.isPending}
                          className="text-xs font-semibold text-blue-700 hover:underline disabled:opacity-60"
                        >
                          Mark Returned
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

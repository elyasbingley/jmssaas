import { useState } from "react";

export type RecurrenceEditScope = "this" | "following" | "all";

// Google Calendar's own "Which events do you want to change/delete?"
// prompt - shown whenever a save or delete targets one occurrence of a
// recurring series, since "this event" alone is ambiguous the moment
// recurrence_group_id is set. Deleting/editing a non-recurring event
// never shows this at all (see Calendar.tsx's own call sites).
export function RecurrenceScopeDialog({
  action,
  onConfirm,
  onCancel,
}: {
  action: "save" | "delete";
  onConfirm: (scope: RecurrenceEditScope) => void;
  onCancel: () => void;
}) {
  const [scope, setScope] = useState<RecurrenceEditScope>("this");
  const verb = action === "delete" ? "delete" : "change";

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30" onClick={onCancel}>
      <div className="w-80 rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-3 text-base font-semibold text-gray-900">Which events do you want to {verb}?</h3>
        <div className="mb-4 flex flex-col gap-2">
          {(
            [
              { value: "this", label: "This event" },
              { value: "following", label: "This and following events" },
              { value: "all", label: "All events" },
            ] as const
          ).map((opt) => (
            <label key={opt.value} className="flex items-center gap-2 text-sm text-gray-700">
              <input type="radio" name="recurrence-scope" checked={scope === opt.value} onChange={() => setScope(opt.value)} />
              {opt.label}
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="rounded-md px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-100">
            Cancel
          </button>
          <button
            onClick={() => onConfirm(scope)}
            className={`rounded-md px-4 py-2 text-sm font-semibold text-white ${
              action === "delete" ? "bg-red-600 hover:bg-red-700" : "bg-blue-700 hover:bg-blue-800"
            }`}
          >
            {action === "delete" ? "Delete" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { describeRecurrence, type CalendarEvent } from "@jmssaas/shared";

type CalendarEventRow = CalendarEvent & {
  job_cards: { id: string; title: string } | null;
  tasks: { id: string; title: string } | null;
};

// Google-Calendar-style quick-view popover: click an event, this appears
// anchored near it with the calendar grid still visible behind, click
// elsewhere (or the X) to dismiss. Editing/deleting opens from here
// rather than the popover doing either itself - see CalendarEventEditor
// and Calendar.tsx's own delete-scope handling for recurring events.
export function CalendarEventPopover({
  event,
  color,
  categoryLabel,
  anchorRect,
  onClose,
  onEdit,
  onDelete,
}: {
  event: CalendarEventRow;
  color: string;
  categoryLabel: string;
  anchorRect: DOMRect;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<{ left: number; top: number }>({ left: anchorRect.left, top: anchorRect.bottom + 6 });
  const isPersonal = event.source === "google_personal";
  const canEdit = !isPersonal;

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 12;
    let left = anchorRect.left;
    let top = anchorRect.bottom + 6;
    if (left + rect.width > window.innerWidth - margin) left = window.innerWidth - rect.width - margin;
    if (left < margin) left = margin;
    if (top + rect.height > window.innerHeight - margin) top = anchorRect.top - rect.height - 6;
    if (top < margin) top = margin;
    setStyle({ left, top });
  }, [anchorRect]);

  const dateRange = event.all_day
    ? new Date(event.start_at).toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" })
    : `${new Date(event.start_at).toLocaleString("en-AU", { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" })} - ${new Date(
        event.end_at
      ).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" })}`;

  return (
    <div
      ref={ref}
      style={{ position: "fixed", left: style.left, top: style.top, zIndex: 50 }}
      className="w-80 rounded-xl border border-gray-200 bg-white p-4 shadow-xl"
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <span className="mt-1 h-3 w-3 flex-shrink-0 rounded-sm" style={{ backgroundColor: color }} />
          <h3 className="text-base font-semibold text-gray-900">{event.title}</h3>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          {canEdit ? (
            <button
              onClick={onEdit}
              title="Edit"
              aria-label="Edit"
              className="rounded p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
            >
              &#9998;
            </button>
          ) : null}
          {canEdit ? (
            <button
              onClick={onDelete}
              title="Delete"
              aria-label="Delete"
              className="rounded p-1.5 text-gray-500 hover:bg-gray-100 hover:text-red-600"
            >
              &#128465;
            </button>
          ) : null}
          <button onClick={onClose} title="Close" aria-label="Close" className="rounded p-1.5 text-gray-500 hover:bg-gray-100">
            &times;
          </button>
        </div>
      </div>

      <p className="mb-1 pl-5 text-sm text-gray-700">{dateRange}</p>
      {event.recurrence_rule ? (
        <p className="mb-1 pl-5 text-sm text-gray-500">{describeRecurrence(event.recurrence_rule, new Date(event.start_at))}</p>
      ) : null}
      {event.location ? <p className="mb-1 pl-5 text-sm text-gray-700">{event.location}</p> : null}
      {event.description ? <p className="mb-1 whitespace-pre-wrap pl-5 text-sm text-gray-700">{event.description}</p> : null}

      <div className="mb-1 flex items-center gap-2 pl-5">
        <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: color }} />
        <span className="text-sm text-gray-500">{categoryLabel}</span>
      </div>

      {event.job_cards ? (
        <button onClick={() => navigate(`/jobs/${event.job_cards!.id}`)} className="mt-1 pl-5 text-sm text-blue-700 hover:underline">
          Linked job: {event.job_cards.title}
        </button>
      ) : null}
      {event.tasks ? <p className="mt-1 pl-5 text-sm text-blue-700">Linked task: {event.tasks.title}</p> : null}

      {isPersonal ? (
        <p className="mt-3 rounded-md bg-gray-50 p-2 text-xs text-gray-500">
          Personal Google Calendar event, shown for scheduling visibility only. Edit it in Google Calendar directly.
        </p>
      ) : null}
    </div>
  );
}

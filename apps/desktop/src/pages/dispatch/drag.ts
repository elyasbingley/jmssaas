import { createContext, useContext } from "react";
import type { DispatchEvent, DispatchJob } from "./data";

// Shared drag state for the board. One DndContext wraps the whole page so
// a job can be dragged from the Jobs panel onto any view; lanes read the
// live preview from here to draw where the drop will land.

export const DAY_START_MIN = 6 * 60; // the timeline runs 6:00...
export const DAY_END_MIN = 18 * 60; // ...to 18:00
export const WORK_START_MIN = 7 * 60; // shaded outside 7:00-17:00
export const WORK_END_MIN = 17 * 60;
export const SNAP_MIN = 15;
export const DEFAULT_BOOKING_MIN = 120;

// Draggables: a job card (from the Jobs panel or the Stages board) or a
// booking already on the schedule.
export type DragItem =
  | { kind: "job"; job: DispatchJob; width: number }
  | { kind: "event"; event: DispatchEvent; job: DispatchJob | undefined; width: number; height: number; grabOffsetPx: number };

// Drop targets.
export type DropTarget =
  | { type: "lane"; techId: string | null; day: string; startMin: number; endMin: number }
  | { type: "cell"; techId: string | null | undefined; day: string }
  | { type: "stage"; stageId: string }
  | { type: "panel" }; // the Jobs panel: drop a booking here to unschedule it

// Where the drop will land, drawn by the lane/cell under the pointer.
export interface DropPreview {
  targetId: string;
  day: string;
  techId: string | null | undefined;
  startMin: number;
  minutes: number;
  label: string;
}

export interface DragState {
  item: DragItem | null;
  preview: DropPreview | null;
}

export const DragContext = createContext<DragState>({ item: null, preview: null });
export const useDragState = () => useContext(DragContext);

export const laneId = (techId: string | null, day: string) => `lane|${techId ?? "none"}|${day}`;
export const cellId = (techId: string | null | undefined, day: string) => `cell|${techId === undefined ? "any" : techId ?? "none"}|${day}`;

export const snap = (m: number) => Math.round(m / SNAP_MIN) * SNAP_MIN;
export const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

// Local day key and minutes since local midnight (the office's own time).
export function dayKeyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function dateOfKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}
export function addDaysKey(key: string, days: number): string {
  const d = dateOfKey(key);
  d.setDate(d.getDate() + days);
  return dayKeyOf(d);
}
export function minutesOfDay(iso: string): number {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}
export function atMinutes(day: string, minutes: number): Date {
  const d = dateOfKey(day);
  d.setMinutes(minutes);
  return d;
}
export function clockLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
}
export function rangeLabel(startMin: number, minutes: number): string {
  return `${clockLabel(startMin)} - ${clockLabel(startMin + minutes)}`;
}
export function eventMinutes(e: Pick<DispatchEvent, "start_at" | "end_at">): number {
  return Math.max(SNAP_MIN, Math.round((new Date(e.end_at).getTime() - new Date(e.start_at).getTime()) / 60000));
}

// The first gap of `minutes` in a person's day (7:00-17:00, half-hour
// steps) - where a job dropped onto a whole day goes. Falls back to 7:00.
export function firstFreeSlot(dayEvents: Pick<DispatchEvent, "start_at" | "end_at">[], minutes: number): number {
  const busy = dayEvents.map((e) => [minutesOfDay(e.start_at), minutesOfDay(e.start_at) + eventMinutes(e)] as const);
  for (let start = WORK_START_MIN; start + minutes <= WORK_END_MIN; start += 30) {
    if (busy.every(([a, b]) => start + minutes <= a || start >= b)) return start;
  }
  return WORK_START_MIN;
}

// Side-by-side rows for overlapping bookings in a lane: each gets the
// first row free at its start time.
export function stackRows<T extends { start: number; end: number }>(items: T[]): { item: T; row: number }[] {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  const rowEnds: number[] = [];
  return sorted.map((item) => {
    let row = rowEnds.findIndex((end) => end <= item.start);
    if (row === -1) {
      row = rowEnds.length;
      rowEnds.push(item.end);
    } else rowEnds[row] = item.end;
    return { item, row };
  });
}

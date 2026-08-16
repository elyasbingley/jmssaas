import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import type { CalendarEvent } from "@jmssaas/shared";
import { useAuth } from "../../../lib/auth-context";
import { useIsOnline } from "../../../lib/connectivity";
import { useRefetchOnFocus, useSupabaseFetch } from "../../../lib/use-supabase-fetch";
import { supabase } from "../../../lib/supabase";
import {
  addDays,
  addMonths,
  formatEventTimeRange,
  isSameDay,
  monthGridDays,
  startOfMonth,
  startOfWeek,
} from "../../../lib/datetime";
import { RequiresConnectionNotice } from "../../../components/RequiresConnectionNotice";

type ViewMode = "day" | "week" | "month" | "year";
const VIEW_MODES: ViewMode[] = ["day", "week", "month", "year"];
const VIEW_MODE_LABELS: Record<ViewMode, string> = { day: "Day", week: "Week", month: "Month", year: "Year" };
const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export default function CalendarScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const isOnline = useIsOnline();

  const { data: events, loading, refetch } = useSupabaseFetch<CalendarEvent[]>(async () => {
    const { data, error } = await supabase.from("calendar_events").select("*").order("start_at", { ascending: true });
    if (error) throw error;
    const rows = (data ?? []) as CalendarEvent[];

    // Every 'google_personal' row's base title is always the literal
    // 'Busy' placeholder (see the migration's own comment on why) -
    // overlay the real title for whichever of these belong to the signed-
    // in user. calendar_event_personal_details' owner-only RLS means this
    // query only ever returns the caller's own rows regardless of who
    // else's personal events are mixed into `rows` above, so no extra
    // filtering is needed here.
    const { data: ownDetails } = await supabase.from("calendar_event_personal_details").select("calendar_event_id, title");
    if (ownDetails && ownDetails.length > 0) {
      const titleByEventId = new Map(ownDetails.map((d) => [d.calendar_event_id, d.title]));
      for (const row of rows) {
        const ownTitle = titleByEventId.get(row.id);
        if (ownTitle) row.title = ownTitle;
      }
    }

    return rows;
  }, [isOnline]);
  useRefetchOnFocus(refetch);

  const [viewMode, setViewMode] = useState<ViewMode>("month");
  const [anchor, setAnchor] = useState(new Date());

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of events ?? []) {
      const key = new Date(event.start_at).toDateString();
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(event);
    }
    return map;
  }, [events]);

  const eventsOn = (day: Date) => eventsByDay.get(day.toDateString()) ?? [];

  const goToday = () => setAnchor(new Date());
  const shiftAnchor = (direction: 1 | -1) => {
    if (viewMode === "day") setAnchor((d) => addDays(d, direction));
    else if (viewMode === "week") setAnchor((d) => addDays(d, 7 * direction));
    else if (viewMode === "month") setAnchor((d) => addMonths(d, direction));
    else setAnchor((d) => new Date(d.getFullYear() + direction, d.getMonth(), 1));
  };

  const openDay = (day: Date) => {
    setAnchor(day);
    setViewMode("day");
  };

  const openMonth = (monthDate: Date) => {
    setAnchor(monthDate);
    setViewMode("month");
  };

  const renderEventRow = (event: CalendarEvent) => (
    <Pressable key={event.id} style={styles.eventRow} onPress={() => router.push(`/calendar/${event.id}`)}>
      <Text style={styles.eventTime}>{formatEventTimeRange(event.start_at, event.end_at, event.all_day)}</Text>
      <Text style={styles.eventTitle}>{event.title}</Text>
    </Pressable>
  );

  const renderDayView = () => {
    const dayEvents = eventsOn(anchor);
    return (
      <ScrollView contentContainerStyle={styles.dayViewContent}>
        <Text style={styles.dayHeading}>
          {anchor.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
        </Text>
        {dayEvents.length === 0 ? <Text style={styles.empty}>No events.</Text> : dayEvents.map(renderEventRow)}
      </ScrollView>
    );
  };

  const renderWeekView = () => {
    const weekStart = startOfWeek(anchor);
    const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    return (
      <ScrollView contentContainerStyle={styles.weekViewContent}>
        {days.map((day) => {
          const dayEvents = eventsOn(day);
          return (
            <Pressable key={day.toDateString()} style={styles.weekDaySection} onPress={() => openDay(day)}>
              <Text style={[styles.weekDayHeading, isSameDay(day, new Date()) && styles.todayText]}>
                {day.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" })}
              </Text>
              {dayEvents.length === 0 ? (
                <Text style={styles.weekDayEmpty}>No events</Text>
              ) : (
                dayEvents.map(renderEventRow)
              )}
            </Pressable>
          );
        })}
      </ScrollView>
    );
  };

  const renderMonthView = () => {
    const gridDays = monthGridDays(startOfMonth(anchor));
    const today = new Date();
    return (
      <View style={styles.monthViewContent}>
        <Text style={styles.monthHeading}>{`${MONTH_LABELS[anchor.getMonth()]} ${anchor.getFullYear()}`}</Text>
        <View style={styles.weekdayHeaderRow}>
          {WEEKDAY_LABELS.map((label) => (
            <Text key={label} style={styles.weekdayHeaderText}>{label}</Text>
          ))}
        </View>
        <View style={styles.monthGrid}>
          {gridDays.map((day) => {
            const inMonth = day.getMonth() === anchor.getMonth();
            const dayEvents = eventsOn(day);
            return (
              <Pressable
                key={day.toDateString()}
                style={styles.monthCell}
                onPress={() => openDay(day)}
              >
                <Text
                  style={[
                    styles.monthCellText,
                    !inMonth && styles.monthCellTextMuted,
                    isSameDay(day, today) && styles.todayBadge,
                  ]}
                >
                  {day.getDate()}
                </Text>
                {dayEvents.length > 0 ? <View style={styles.monthCellDot} /> : null}
              </Pressable>
            );
          })}
        </View>
      </View>
    );
  };

  const renderYearView = () => {
    const year = anchor.getFullYear();
    return (
      <ScrollView contentContainerStyle={styles.yearViewContent}>
        <View style={styles.yearGrid}>
          {MONTH_LABELS.map((label, i) => {
            const monthDate = new Date(year, i, 1);
            const count = (events ?? []).filter(
              (e) => new Date(e.start_at).getFullYear() === year && new Date(e.start_at).getMonth() === i
            ).length;
            return (
              <Pressable key={label} style={styles.yearTile} onPress={() => openMonth(monthDate)}>
                <Text style={styles.yearTileLabel}>{label}</Text>
                <Text style={styles.yearTileCount}>{count} event{count === 1 ? "" : "s"}</Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    );
  };

  const heading =
    viewMode === "day"
      ? anchor.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })
      : viewMode === "week"
        ? `Week of ${startOfWeek(anchor).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}`
        : viewMode === "month"
          ? `${MONTH_LABELS[anchor.getMonth()]} ${anchor.getFullYear()}`
          : String(anchor.getFullYear());

  if (!isOnline) {
    return (
      <View style={styles.container}>
        <RequiresConnectionNotice label="Calendar" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.viewModeRow}>
        {VIEW_MODES.map((mode) => (
          <Pressable
            key={mode}
            style={[styles.viewModeChip, viewMode === mode && styles.viewModeChipActive]}
            onPress={() => setViewMode(mode)}
          >
            <Text style={[styles.viewModeChipText, viewMode === mode && styles.viewModeChipTextActive]}>
              {VIEW_MODE_LABELS[mode]}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.navRow}>
        <Pressable onPress={() => shiftAnchor(-1)} style={styles.navButton}>
          <Text style={styles.navButtonText}>‹</Text>
        </Pressable>
        <Pressable onPress={goToday} style={styles.navHeading}>
          <Text style={styles.navHeadingText}>{heading}</Text>
        </Pressable>
        <Pressable onPress={() => shiftAnchor(1)} style={styles.navButton}>
          <Text style={styles.navButtonText}>›</Text>
        </Pressable>
      </View>

      {!loading ? (
        <>
          {viewMode === "day" ? renderDayView() : null}
          {viewMode === "week" ? renderWeekView() : null}
          {viewMode === "month" ? renderMonthView() : null}
          {viewMode === "year" ? renderYearView() : null}
        </>
      ) : (
        <Text style={styles.empty}>Loading...</Text>
      )}

      {profile?.role === "admin" ? (
        <Pressable style={styles.fab} onPress={() => router.push("/calendar/new")}>
          <Text style={styles.fabText}>+ New event</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  viewModeRow: { flexDirection: "row", gap: 8, padding: 12, paddingBottom: 4 },
  viewModeChip: { flex: 1, paddingVertical: 8, borderRadius: 14, backgroundColor: "#f3f4f6", alignItems: "center" },
  viewModeChipActive: { backgroundColor: "#111827" },
  viewModeChipText: { color: "#374151", fontWeight: "600", fontSize: 13 },
  viewModeChipTextActive: { color: "#fff" },
  navRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#d1d5db",
  },
  navButton: { padding: 8 },
  navButtonText: { fontSize: 22, color: "#1d4ed8", fontWeight: "700" },
  navHeading: { flex: 1, alignItems: "center" },
  navHeadingText: { fontSize: 16, fontWeight: "700" },
  dayViewContent: { padding: 16 },
  dayHeading: { fontSize: 17, fontWeight: "700", marginBottom: 12 },
  eventRow: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#d1d5db" },
  eventTime: { color: "#1d4ed8", fontWeight: "600", fontSize: 12 },
  eventTitle: { fontSize: 16, fontWeight: "600", marginTop: 2 },
  weekViewContent: { padding: 16 },
  weekDaySection: { marginBottom: 18 },
  weekDayHeading: { fontWeight: "700", color: "#374151", marginBottom: 6 },
  todayText: { color: "#1d4ed8" },
  weekDayEmpty: { color: "#9ca3af", fontSize: 13 },
  monthViewContent: { padding: 16 },
  monthHeading: { fontSize: 17, fontWeight: "700", marginBottom: 10, textAlign: "center" },
  weekdayHeaderRow: { flexDirection: "row" },
  weekdayHeaderText: { flex: 1, textAlign: "center", color: "#9ca3af", fontSize: 12, fontWeight: "600" },
  monthGrid: { flexDirection: "row", flexWrap: "wrap" },
  monthCell: { width: `${100 / 7}%`, aspectRatio: 1, alignItems: "center", justifyContent: "center", gap: 4 },
  monthCellText: { fontSize: 14, color: "#111827" },
  monthCellTextMuted: { color: "#d1d5db" },
  todayBadge: { color: "#1d4ed8", fontWeight: "800" },
  monthCellDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: "#1d4ed8" },
  yearViewContent: { padding: 16 },
  yearGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  yearTile: { width: "31%", backgroundColor: "#f3f4f6", borderRadius: 12, padding: 12, gap: 4 },
  yearTileLabel: { fontWeight: "700", fontSize: 14 },
  yearTileCount: { color: "#6b7280", fontSize: 12 },
  empty: { textAlign: "center", color: "#6b7280", padding: 16 },
  fab: {
    position: "absolute",
    right: 16,
    bottom: 24,
    backgroundColor: "#1d4ed8",
    borderRadius: 24,
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  fabText: { color: "#fff", fontWeight: "700" },
});

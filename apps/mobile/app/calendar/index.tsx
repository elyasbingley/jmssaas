import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  categoryForEvent,
  DEFAULT_CALENDAR_CATEGORY_COLORS,
  type CalendarCategoryColors,
  type CalendarEvent,
} from "@jmssaas/shared";
import { useAuth } from "../../lib/auth-context";
import { useIsOnline } from "../../lib/connectivity";
import { useRefetchOnFocus, useSupabaseFetch } from "../../lib/use-supabase-fetch";
import { supabase } from "../../lib/supabase";
import {
  addDays,
  addMonths,
  formatEventTimeRange,
  isSameDay,
  monthGridDays,
  startOfMonth,
  startOfWeek,
} from "../../lib/datetime";
import { useThemedStyles, type StyleTheme } from "../../lib/use-themed-styles";
import { ThemedRequiresConnectionNotice } from "../../components/theme/ThemedRequiresConnectionNotice";

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
  const styles = useThemedStyles(createStyles);

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

  // Same admin-configurable per-category colors desktop's calendar reads
  // from tenants.calendar_category_colors (see Settings' "Calendar colors"
  // section) - mobile previously showed every event identically regardless
  // of category, the one piece of the desktop calendar overhaul that never
  // made it here.
  const { data: categoryColors } = useSupabaseFetch<CalendarCategoryColors>(async () => {
    if (!profile) return DEFAULT_CALENDAR_CATEGORY_COLORS;
    const { data, error } = await supabase.from("tenants").select("calendar_category_colors").eq("id", profile.tenant_id).single();
    if (error) throw error;
    return (data.calendar_category_colors as CalendarCategoryColors) ?? DEFAULT_CALENDAR_CATEGORY_COLORS;
  }, [profile?.tenant_id]);
  const colorFor = (event: CalendarEvent) => (categoryColors ?? DEFAULT_CALENDAR_CATEGORY_COLORS)[categoryForEvent(event)];

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

  // Full-tile fill, not just a colored accent - matches Google Calendar's
  // own event styling (a solid block in the category's color with white
  // text) rather than the flat white row every event used to render as
  // regardless of category. Category colors are admin-configurable business
  // data (Settings > Calendar colors), so they stay their own hex values
  // rather than following the CRT accent palette.
  const renderEventRow = (event: CalendarEvent) => (
    <Pressable
      key={event.id}
      style={[styles.eventRow, { backgroundColor: colorFor(event) }]}
      onPress={() => router.push(`/calendar/${event.id}`)}
    >
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
                {dayEvents.length > 0 ? (
                  <View style={[styles.monthCellDot, { backgroundColor: colorFor(dayEvents[0]) }]} />
                ) : null}
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

  return (
    <>
      <StatusBar style="light" />
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Text style={styles.link}>‹ Back</Text>
          </Pressable>
          <Text style={styles.title}>Calendar</Text>
          {profile?.role === "admin" ? (
            <Pressable style={styles.addButton} onPress={() => router.push("/calendar/new")} hitSlop={8}>
              <Text style={styles.addButtonText}>+</Text>
            </Pressable>
          ) : (
            <View style={styles.addButtonSpacer} />
          )}
        </View>

        {!isOnline ? (
          <ThemedRequiresConnectionNotice label="Calendar" />
        ) : (
          <>
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
          </>
        )}
      </SafeAreaView>
    </>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    container: { flex: 1, backgroundColor: tokens.background },
    header: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 4,
      gap: 6,
    },
    link: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    title: { fontSize: font.title + 4, fontWeight: "700" as const, color: tokens.textPrimary, letterSpacing: 1, flex: 1, ...mono },
    addButton: {
      width: 36,
      height: 36,
      borderRadius: 3,
      borderWidth: 1,
      borderColor: tokens.accent,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      backgroundColor: tokens.accentGlow,
    },
    addButtonSpacer: { width: 36, height: 36 },
    addButtonText: { color: tokens.accent, fontSize: 22, fontWeight: "700" as const, marginTop: -2, ...mono },
    viewModeRow: { flexDirection: "row" as const, gap: 8, padding: 12, paddingBottom: 4 },
    viewModeChip: { flex: 1, paddingVertical: 8, borderRadius: 3, borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.surface, alignItems: "center" as const },
    viewModeChipActive: { backgroundColor: tokens.accentGlow, borderColor: tokens.accent },
    viewModeChipText: { color: tokens.textMuted, fontWeight: "600" as const, fontSize: font.label, ...mono },
    viewModeChipTextActive: { color: tokens.accent },
    navRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: tokens.border,
    },
    navButton: { padding: 8 },
    navButtonText: { fontSize: 22, color: tokens.accent, fontWeight: "700" as const, ...mono },
    navHeading: { flex: 1, alignItems: "center" as const },
    navHeadingText: { fontSize: font.body, fontWeight: "700" as const, color: tokens.textPrimary, ...mono },
    dayViewContent: { padding: 16 },
    dayHeading: { fontSize: font.title - 1, fontWeight: "700" as const, color: tokens.textPrimary, marginBottom: 12, ...mono },
    eventRow: { paddingVertical: 8, paddingHorizontal: 10, borderRadius: 4, marginBottom: 6 },
    eventTime: { color: "rgba(255,255,255,0.85)", fontWeight: "600" as const, fontSize: font.label - 1, ...mono },
    eventTitle: { fontSize: font.body, fontWeight: "600" as const, marginTop: 2, color: "#fff", ...mono },
    weekViewContent: { padding: 16 },
    weekDaySection: { marginBottom: 18 },
    weekDayHeading: { fontWeight: "700" as const, color: tokens.textPrimary, marginBottom: 6, ...mono },
    todayText: { color: tokens.accent },
    weekDayEmpty: { color: tokens.textMuted, fontSize: font.label, ...mono },
    monthViewContent: { padding: 16 },
    monthHeading: { fontSize: font.title - 1, fontWeight: "700" as const, color: tokens.textPrimary, marginBottom: 10, textAlign: "center" as const, ...mono },
    weekdayHeaderRow: { flexDirection: "row" as const },
    weekdayHeaderText: { flex: 1, textAlign: "center" as const, color: tokens.textMuted, fontSize: font.label - 1, fontWeight: "600" as const, ...mono },
    monthGrid: { flexDirection: "row" as const, flexWrap: "wrap" as const },
    monthCell: { width: `${100 / 7}%` as const, aspectRatio: 1, alignItems: "center" as const, justifyContent: "center" as const, gap: 4 },
    monthCellText: { fontSize: font.body - 1, color: tokens.textPrimary, ...mono },
    monthCellTextMuted: { color: tokens.border },
    todayBadge: { color: tokens.accent, fontWeight: "800" as const },
    monthCellDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: tokens.accent },
    yearViewContent: { padding: 16 },
    yearGrid: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 12 },
    yearTile: { width: "31%" as const, backgroundColor: tokens.surface, borderWidth: 1, borderColor: tokens.border, borderRadius: 4, padding: 12, gap: 4 },
    yearTileLabel: { fontWeight: "700" as const, fontSize: font.body - 1, color: tokens.textPrimary, ...mono },
    yearTileCount: { color: tokens.textMuted, fontSize: font.label, ...mono },
    empty: { textAlign: "center" as const, color: tokens.textMuted, padding: 16, ...mono },
  };
}

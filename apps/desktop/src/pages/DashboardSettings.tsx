import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  DASHBOARD_WIDGET_LABELS,
  DEFAULT_DASHBOARD_WIDGETS,
  updateDashboardWidgetsSchema,
  type DashboardWidgetPrefs,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";

const WIDGET_KEYS = Object.keys(DASHBOARD_WIDGET_LABELS) as (keyof DashboardWidgetPrefs)[];

// Lets this user pick which of the Dashboard's four widgets show for them -
// per-user (profile.dashboard_widgets), not tenant-wide, since it's purely
// a personal display preference (see Dashboard.tsx's own comment).
export default function DashboardSettingsPage() {
  const { profile, refetchProfile } = useAuth();
  const [widgets, setWidgets] = useState<DashboardWidgetPrefs>(DEFAULT_DASHBOARD_WIDGETS);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (profile?.dashboard_widgets) setWidgets(profile.dashboard_widgets);
  }, [profile?.dashboard_widgets]);

  const save = useMutation({
    mutationFn: async (next: DashboardWidgetPrefs) => {
      const result = updateDashboardWidgetsSchema.safeParse(next);
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Check the form for errors");
      if (!profile) throw new Error("Not signed in");

      const { error } = await supabase.from("profiles").update({ dashboard_widgets: result.data }).eq("id", profile.id);
      if (error) throw error;
    },
    onSuccess: async () => {
      await refetchProfile();
      setSaveError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
    onError: (e) => setSaveError(getErrorMessage(e, "Failed to save")),
  });

  const toggle = (key: keyof DashboardWidgetPrefs) => {
    const next = { ...widgets, [key]: !widgets[key] };
    setWidgets(next);
    save.mutate(next);
  };

  return (
    <div className="mx-auto max-w-2xl p-8">
      <h1 className="text-xl font-bold text-gray-900">Dashboard</h1>
      <p className="mb-6 text-sm text-gray-500">Choose what shows on your Dashboard home screen.</p>

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        {WIDGET_KEYS.map((key) => (
          <label
            key={key}
            className="flex cursor-pointer items-center justify-between border-b border-gray-100 px-4 py-3 last:border-0 hover:bg-gray-50"
          >
            <span className="text-sm font-medium text-gray-900">{DASHBOARD_WIDGET_LABELS[key]}</span>
            <input type="checkbox" checked={widgets[key]} onChange={() => toggle(key)} className="h-4 w-4" />
          </label>
        ))}
      </div>

      {saveError ? <p className="mt-3 text-sm text-red-600">{saveError}</p> : null}
      {saved ? <p className="mt-3 text-sm text-green-700">Saved.</p> : null}
    </div>
  );
}

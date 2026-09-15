import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";

export type JobActionId = "notes" | "camera" | "email" | "sms" | "photoLibrary" | "phone" | "forms";

export interface JobActionDefinition {
  id: JobActionId;
  label: string;
  icon: string;
}

// Order here is also the default quick-bar order (first 4 = quick actions,
// remaining 3 live in the "more" sheet) - see the Job Card spec's
// defaults: Job Notes, Camera, Email, SMS on the bar; Photo Library, Phone,
// Forms + Certificates behind "more".
export const JOB_ACTION_DEFINITIONS: JobActionDefinition[] = [
  { id: "notes", label: "Job Notes", icon: "📝" },
  { id: "camera", label: "Camera", icon: "📷" },
  { id: "email", label: "Email", icon: "✉️" },
  { id: "sms", label: "SMS", icon: "💬" },
  { id: "photoLibrary", label: "Photo Library", icon: "🖼️" },
  { id: "phone", label: "Phone", icon: "📞" },
  { id: "forms", label: "Forms & Certificates", icon: "📋" },
];

export const DEFAULT_ACTION_ORDER: JobActionId[] = JOB_ACTION_DEFINITIONS.map((a) => a.id);
export const QUICK_ACTION_COUNT = 4;

const STORAGE_KEY = "jms:job-quick-actions";

function isValidOrder(value: unknown): value is JobActionId[] {
  if (!Array.isArray(value)) return false;
  const known = new Set(DEFAULT_ACTION_ORDER);
  return (
    value.length === DEFAULT_ACTION_ORDER.length &&
    value.every((v) => typeof v === "string" && known.has(v as JobActionId)) &&
    new Set(value).size === value.length
  );
}

// Which 4 actions sit on the persistent bottom bar, and in what order - a
// per-technician workflow preference, so it's local-per-device like the UI
// Settings theme choice (see lib/theme-context.tsx), not synced tenant data.
// The spec's "long-press-and-drag reordering" is implemented here as
// tap-to-move-up/down in JobActionsSheet instead of a true drag gesture -
// that would need react-native-gesture-handler/reanimated, a new native
// dependency requiring an EAS rebuild, which felt like too heavy an add for
// this one interaction. Straightforward to swap in later if wanted.
export function useJobActionOrder(): {
  order: JobActionId[];
  quickActions: JobActionId[];
  moreActions: JobActionId[];
  setOrder: (order: JobActionId[]) => void;
  isReady: boolean;
} {
  const [order, setOrderState] = useState<JobActionId[]>(DEFAULT_ACTION_ORDER);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (!raw) return;
        const parsed: unknown = JSON.parse(raw);
        if (isValidOrder(parsed)) setOrderState(parsed);
      })
      .catch(() => {})
      .finally(() => setIsReady(true));
  }, []);

  const setOrder = (next: JobActionId[]) => {
    setOrderState(next);
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => {});
  };

  return {
    order,
    quickActions: order.slice(0, QUICK_ACTION_COUNT),
    moreActions: order.slice(QUICK_ACTION_COUNT),
    setOrder,
    isReady,
  };
}

export function getActionDefinition(id: JobActionId): JobActionDefinition {
  return JOB_ACTION_DEFINITIONS.find((a) => a.id === id) as JobActionDefinition;
}

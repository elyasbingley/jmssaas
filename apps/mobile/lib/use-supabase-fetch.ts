import { useCallback, useEffect, useState } from "react";
import { useFocusEffect } from "expo-router";
import { getErrorMessage } from "./errors";

// Small fetch-on-mount helper for the Supabase-direct (non-PowerSync) screens
// - quotes, invoices, calendar. These are office/PC workflows by design (see
// docs/SETUP.md), so unlike the rest of the app they don't need offline
// watched queries, just a straightforward fetch + manual refetch.
//
// Deliberately does NOT refetch on focus by itself: several callers (quote/
// invoice/event detail screens) seed local editable state from `data` via a
// `useEffect(() => { if (data) setX(data.x) }, [data])`, so replacing `data`
// on every focus would silently discard an in-progress unsaved edit the
// moment the user navigated to a linked screen (e.g. "View linked job") and
// came back. List screens (calendar/quotes/invoices index) don't have that
// problem - use `useRefetchOnFocus(refetch)` below at those call sites
// instead of baking focus-refetch into every caller of this hook.
export function useSupabaseFetch<T>(fetcher: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    setLoading(true);
    setError(null);
    return fetcher()
      .then((result) => setData(result))
      .catch((e) => {
        console.error("[useSupabaseFetch] Failed to load", e);
        setError(getErrorMessage(e, "Failed to load (see console for details)"));
      })
      .finally(() => setLoading(false));
  }, deps);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { data, loading, error, refetch };
}

// Opt-in refetch-on-focus for pure list/read screens (see the note above on
// why this isn't baked into useSupabaseFetch itself). useFocusEffect's
// effect also runs on initial mount (a screen mounts already focused), so
// this alone covers "first load" and "returned to this screen" - no
// separate mount-only fetch needed alongside it.
export function useRefetchOnFocus(refetch: () => Promise<void> | void) {
  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch])
  );
}

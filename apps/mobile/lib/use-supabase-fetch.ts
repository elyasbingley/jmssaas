import { useCallback, useEffect, useState } from "react";

// Small fetch-on-mount helper for the Supabase-direct (non-PowerSync) screens
// - quotes, invoices, calendar. These are office/PC workflows by design (see
// docs/SETUP.md), so unlike the rest of the app they don't need offline
// watched queries, just a straightforward fetch + manual refetch.
export function useSupabaseFetch<T>(fetcher: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    setLoading(true);
    setError(null);
    return fetcher()
      .then((result) => setData(result))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, deps);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { data, loading, error, refetch };
}

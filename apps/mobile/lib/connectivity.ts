import { useStatus } from "@powersync/react";

// PowerSync's connection state is a reasonable proxy for "is this device
// online" without pulling in a separate NetInfo dependency - the app is
// already connected to PowerSync whenever signed in, and it tracks
// connectivity over the same network path Supabase-direct calls would use.
// It isn't a literal check of Supabase reachability, just good enough for
// Phase 1's "requires connection" screens (quotes, invoices, calendar).
export function useIsOnline(): boolean {
  return useStatus().connected;
}

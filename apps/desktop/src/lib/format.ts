import type { Client } from "@jmssaas/shared";

// Same helper as apps/mobile/lib/format.ts, duplicated rather than shared
// for the same reason lib/errors.ts is (tiny, no other cross-app lib dep).
export function formatClientAddress(client: Pick<Client, "address_line1" | "address_line2" | "suburb" | "state" | "postcode">): string | null {
  const parts = [
    client.address_line1,
    client.address_line2,
    [client.suburb, client.state, client.postcode].filter(Boolean).join(" "),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

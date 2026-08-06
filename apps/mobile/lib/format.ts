import type { Client } from "@jmssaas/shared";

// Shared by the client detail screen and the job detail screen (which shows
// its client's address inline) so the two don't drift into slightly
// different formatting.
export function formatClientAddress(client: Pick<Client, "address_line1" | "address_line2" | "suburb" | "state" | "postcode">): string | null {
  const parts = [
    client.address_line1,
    client.address_line2,
    [client.suburb, client.state, client.postcode].filter(Boolean).join(" "),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

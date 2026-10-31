// Client first_name/last_name <-> name helpers - same split/join heuristic
// as the clients_sync_full_name DB trigger (see the client_first_last_name
// migration), so a name built here and one computed server-side always
// agree. Used by the Clients tab's Add/Edit forms (both platforms) to
// compute `name` immediately for display/offline reads, without waiting on
// that trigger or a round trip.

export function joinClientName(firstName: string, lastName?: string | null): string {
  return [firstName.trim(), lastName?.trim()].filter(Boolean).join(" ");
}

export function splitClientName(fullName: string): { first_name: string; last_name: string | null } {
  const trimmed = fullName.trim();
  const spaceIndex = trimmed.indexOf(" ");
  if (spaceIndex === -1) return { first_name: trimmed, last_name: null };
  return { first_name: trimmed.slice(0, spaceIndex), last_name: trimmed.slice(spaceIndex + 1).trim() || null };
}

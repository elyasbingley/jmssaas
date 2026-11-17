import { toE164 } from "./channels";

// Matches a message sender to existing clients: by email (case-insensitive)
// against clients.email and client_contacts.email, and by phone (normalised
// with toE164) against clients.phone and client_contacts.phone. Returns
// client ids, deduplicated, clients' own matches before contacts'.
//
// Used by desktop's Attach to job dialog (to list the sender's jobs first)
// and by both apps' Channels "Create job" form (to create the job against
// the existing client rather than inserting a duplicate). Takes the app's
// own Supabase client so this package doesn't need supabase-js itself.

// The query builder's own type is generic over the schema; only .from() is
// needed here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ClientMatchDb = { from: (table: string) => any };

// PostgREST caps every response at 1000 rows, silently - phone matching has
// to normalise every stored number, so it pages through all of them (same
// approach as desktop's lib/fetch-all-rows.ts).
const PAGE_SIZE = 1000;

async function fetchAllWithPhone<T>(db: ClientMatchDb, table: string, columns: string): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await db.from(table).select(columns).not("phone", "is", null).order("id").range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

export async function matchingClientIds(db: ClientMatchDb, email: string | null | undefined, phone: string | null | undefined): Promise<string[]> {
  const ids = new Set<string>();
  const wantedEmail = email?.trim();
  if (wantedEmail) {
    const [clients, contacts] = await Promise.all([
      db.from("clients").select("id").ilike("email", wantedEmail),
      db.from("client_contacts").select("client_id").ilike("email", wantedEmail),
    ]);
    if (clients.error) throw clients.error;
    if (contacts.error) throw contacts.error;
    for (const row of (clients.data ?? []) as { id: string }[]) ids.add(row.id);
    for (const row of (contacts.data ?? []) as { client_id: string }[]) ids.add(row.client_id);
  }
  const wantedPhone = phone ? toE164(phone) : null;
  if (wantedPhone) {
    const [clients, contacts] = await Promise.all([
      fetchAllWithPhone<{ id: string; phone: string | null }>(db, "clients", "id, phone"),
      fetchAllWithPhone<{ client_id: string; phone: string | null }>(db, "client_contacts", "id, client_id, phone"),
    ]);
    for (const row of clients) if (row.phone && toE164(row.phone) === wantedPhone) ids.add(row.id);
    for (const row of contacts) if (row.phone && toE164(row.phone) === wantedPhone) ids.add(row.client_id);
  }
  return [...ids];
}

// Which existing client a "Create job" form should default to: the
// conversation's linked client if it has one, else the first sender match,
// else none (create a new client).
export function defaultClientForSender(linkedClientId: string | null | undefined, matchedIds: readonly string[]): string | null {
  return linkedClientId || matchedIds[0] || null;
}

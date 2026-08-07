// Same helper as apps/mobile/lib/errors.ts, duplicated rather than shared
// since it's tiny and this app has no other dependency on mobile's lib/
// directory (only packages/shared is meant to be shared code).
//
// Reads `.message`/`.hint` off anything shaped like an error rather than
// gating on `instanceof Error` - Supabase's PostgrestError does extend
// Error in source, but a bundler/target mismatch (or any other library
// that throws a plain `{ message, hint }` object instead of a real Error)
// can make `instanceof` checks lie, silently dropping the one piece of
// text ("column X does not exist", RLS hints, etc.) that actually explains
// the failure.
export function getErrorMessage(e: unknown, fallback: string): string {
  if (typeof e === "object" && e !== null && "message" in e && typeof (e as { message: unknown }).message === "string") {
    const message = (e as { message: string }).message;
    if (!message) return fallback;
    const hint = (e as { hint?: unknown }).hint;
    return typeof hint === "string" && hint.length > 0 ? `${message} (${hint})` : message;
  }
  return fallback;
}

// Formats an unknown thrown value into a display string. Supabase's
// PostgrestError extends Error (confirmed by reading the installed
// @supabase/postgrest-js's own source - not assumed), so `e.message` is
// already the real Postgres/PostgREST message rather than a generic
// fallback in the normal case. But PostgrestError's own doc comment is
// explicit that `hint` is often "the single most useful field" - Postgres
// puts the actionable fix there, not in `message` - so this appends it
// when present rather than showing message alone.
export function getErrorMessage(e: unknown, fallback: string): string {
  if (e instanceof Error) {
    const hint = (e as { hint?: unknown }).hint;
    return typeof hint === "string" && hint.length > 0 ? `${e.message} (${hint})` : e.message;
  }
  return fallback;
}

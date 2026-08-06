// Same helper as apps/mobile/lib/errors.ts, duplicated rather than shared
// since it's tiny and this app has no other dependency on mobile's lib/
// directory (only packages/shared is meant to be shared code).
export function getErrorMessage(e: unknown, fallback: string): string {
  if (e instanceof Error) {
    const hint = (e as { hint?: unknown }).hint;
    return typeof hint === "string" && hint.length > 0 ? `${e.message} (${hint})` : e.message;
  }
  return fallback;
}

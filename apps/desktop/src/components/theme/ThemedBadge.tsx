// Outlined status/tag pill - web sibling of the mobile theme's statusBadge
// pattern (border+text same colour, transparent-ish fill). Pass an explicit
// `color` for badges whose meaning must stay legible/consistent regardless
// of the active accent preset (e.g. fixed WHS risk colours); omit it to use
// the current accent.
export function ThemedBadge({ label, color }: { label: string; color?: string }) {
  const c = color ?? "var(--jms-accent)";
  return (
    <span
      className="inline-block whitespace-nowrap rounded border px-2 py-0.5 uppercase tracking-wide"
      style={{ borderColor: c, color: c, fontSize: "var(--jms-font-label)", fontFamily: "var(--jms-font)" }}
    >
      {label}
    </span>
  );
}

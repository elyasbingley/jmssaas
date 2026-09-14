export function ThemedReadout({ label, value, danger, warning }: { label: string; value: string; danger?: boolean; warning?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        {label}
      </span>
      <span style={{ color: danger ? "var(--jms-danger)" : warning ? "var(--jms-warning)" : "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
        {value}
      </span>
    </div>
  );
}

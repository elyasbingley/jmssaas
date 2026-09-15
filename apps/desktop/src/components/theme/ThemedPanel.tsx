import type { ReactNode } from "react";

// Bordered/titled CRT panel - web sibling of the mobile theme's card
// pattern (border+surface+accentGlow). Used as the standard content
// container on every rethemed desktop page.
export function ThemedPanel({
  title,
  status,
  actions,
  children,
  className,
}: {
  title?: string;
  status?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`overflow-hidden rounded ${className ?? ""}`}
      style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)", boxShadow: "0 0 12px var(--jms-accent-glow)" }}
    >
      {title || status || actions ? (
        <div
          className="flex items-center justify-between gap-3 px-4 py-2"
          style={{ borderBottom: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)" }}
        >
          <div className="flex items-center gap-2">
            {title ? (
              <>
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: "var(--jms-accent)", boxShadow: "0 0 6px var(--jms-accent-glow)" }}
                />
                <span className="uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
                  {title}
                </span>
              </>
            ) : null}
          </div>
          <div className="flex items-center gap-3">
            {status ? (
              <span className="uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                {status}
              </span>
            ) : null}
            {actions}
          </div>
        </div>
      ) : null}
      <div className="p-4">{children}</div>
    </div>
  );
}

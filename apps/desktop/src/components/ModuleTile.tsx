import { Link } from "react-router-dom";
import type { AppModule } from "../lib/modules";

// A big icon tile (Dashboard and More), ServiceM8 style.
export function ModuleTile({ module, showBlurb = false }: { module: AppModule; showBlurb?: boolean }) {
  return (
    <Link
      to={module.to}
      className="jms-tile flex flex-col items-center justify-center gap-2 rounded-xl px-3 py-5 text-center"
      style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)", minHeight: showBlurb ? 150 : 136 }}
      data-testid="module-tile"
    >
      <span style={{ fontSize: "2.6rem", lineHeight: 1 }} aria-hidden>
        {module.icon}
      </span>
      <span className="font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
        {module.label}
      </span>
      {showBlurb ? (
        <span style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>{module.blurb}</span>
      ) : null}
    </Link>
  );
}

import type { ReactNode } from "react";
import { ACCENT_OPTIONS, FONT_FAMILY_OPTIONS, FONT_SIZE_OPTIONS, type AccentId } from "@jmssaas/shared";
import { useTheme } from "../lib/theme-context";

// Local hex lookup purely so each swatch can preview its OWN accent colour
// (not the currently active one) - the app's actual active tokens always
// come from useTheme()/ACCENT_PRESETS via the shared theme module.
const ACCENT_HEX: Record<AccentId, string> = {
  green: "#39ff6a",
  cyan: "#39e6ff",
  magenta: "#ff3ec8",
  amber: "#ffb020",
  purple: "#a855f7",
  red: "#ff3b3b",
};

export default function UISettingsPage() {
  const { prefs, setAccent, setFontSize, setFontFamily } = useTheme();

  return (
    <div
      className="min-h-full p-8"
      style={{ backgroundColor: "var(--jms-bg)", fontFamily: "var(--jms-font)", color: "var(--jms-text)" }}
    >
      <div className="mx-auto max-w-2xl">
        <h1
          className="mb-1 text-2xl uppercase tracking-[0.2em]"
          style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}
        >
          UI Settings
        </h1>
        <p className="mb-8 text-sm" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
          Drives the retro terminal theme across the app - changes apply immediately and are saved to this browser.
        </p>

        <Panel title="Accent Colour" status={ACCENT_OPTIONS.find((a) => a.id === prefs.accent)?.label}>
          <div className="flex flex-wrap gap-4">
            {ACCENT_OPTIONS.map((option) => {
              const color = ACCENT_HEX[option.id];
              const selected = option.id === prefs.accent;
              return (
                <button
                  key={option.id}
                  onClick={() => setAccent(option.id)}
                  className="flex w-20 flex-col items-center gap-2"
                >
                  <span
                    className="flex h-12 w-12 items-center justify-center rounded-full border-2"
                    style={{
                      borderColor: color,
                      boxShadow: `0 0 8px ${color}66`,
                      backgroundColor: selected ? `${color}33` : "var(--jms-bg)",
                    }}
                  >
                    <span className="h-4 w-4 rounded-full" style={{ backgroundColor: color }} />
                  </span>
                  <span
                    className="text-center uppercase"
                    style={{ color: selected ? color : "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
                  >
                    {option.label}
                  </span>
                </button>
              );
            })}
          </div>
        </Panel>

        <Panel title="Font Size">
          <div className="flex gap-2">
            {FONT_SIZE_OPTIONS.map((option) => {
              const selected = option.id === prefs.fontSize;
              return (
                <button
                  key={option.id}
                  onClick={() => setFontSize(option.id)}
                  className="flex-1 rounded border py-2 uppercase tracking-wide"
                  style={{
                    borderColor: selected ? "var(--jms-accent)" : "var(--jms-border)",
                    backgroundColor: selected ? "var(--jms-accent-glow)" : "transparent",
                    color: selected ? "var(--jms-accent)" : "var(--jms-text-muted)",
                    fontSize: "var(--jms-font-body)",
                  }}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </Panel>

        <Panel title="Font Type">
          <div className="flex flex-col gap-2">
            {FONT_FAMILY_OPTIONS.map((option) => {
              const selected = option.id === prefs.fontFamily;
              return (
                <button
                  key={option.id}
                  onClick={() => setFontFamily(option.id)}
                  className="flex items-center justify-between rounded border p-3 text-left"
                  style={{ borderColor: selected ? "var(--jms-accent)" : "var(--jms-border)" }}
                >
                  <span>
                    <span
                      className="block uppercase tracking-wide"
                      style={{ color: selected ? "var(--jms-accent)" : "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
                    >
                      {option.label}
                    </span>
                    <span className="block" style={{ fontFamily: option.webFontFamily, fontSize: "var(--jms-font-body)" }}>
                      THE QUICK BROWN FOX 0123456789
                    </span>
                  </span>
                  {selected ? <span style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>✓</span> : null}
                </button>
              );
            })}
          </div>
        </Panel>

        <Panel title="Live Preview" status="ONLINE">
          <Readout label="Job Status" value="IN PROGRESS" />
          <Readout label="Technician" value="J. BINGLEY" />
          <Readout label="Priority" value="HIGH" danger />
        </Panel>
      </div>
    </div>
  );
}

function Panel({ title, status, children }: { title: string; status?: string; children: ReactNode }) {
  return (
    <div
      className="mb-6 overflow-hidden rounded"
      style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)", boxShadow: "0 0 12px var(--jms-accent-glow)" }}
    >
      <div
        className="flex items-center justify-between px-4 py-2"
        style={{ borderBottom: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)" }}
      >
        <div className="flex items-center gap-2">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: "var(--jms-accent)", boxShadow: "0 0 6px var(--jms-accent-glow)" }}
          />
          <span className="uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
            {title}
          </span>
        </div>
        {status ? (
          <span className="uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
            {status}
          </span>
        ) : null}
      </div>
      <div className="flex flex-col gap-3 p-4">{children}</div>
    </div>
  );
}

function Readout({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        {label}
      </span>
      <span style={{ color: danger ? "var(--jms-danger)" : "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>{value}</span>
    </div>
  );
}

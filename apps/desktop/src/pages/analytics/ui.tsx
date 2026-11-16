import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { formatCentsAsAud, type AnalyticsIndex } from "@jmssaas/shared";
import type { Drill } from "./data";

// Shared building blocks for every Analytics report. Charts are drawn in
// one hue (the theme's accent) plus a muted grey for context series -
// themes are user-selectable, so nothing here can rely on a fixed
// multi-colour palette staying distinguishable. Danger/warning colours
// are kept for actual status (behind target, overdue), never for a series.

export const ACCENT = "var(--jms-accent)";
export const CONTEXT = "color-mix(in srgb, var(--jms-text-muted) 55%, transparent)";
const HAIRLINE = "color-mix(in srgb, var(--jms-border) 70%, transparent)";

const label: CSSProperties = { color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" };
const body: CSSProperties = { color: "var(--jms-text)", fontSize: "var(--jms-font-body)" };

export function formatPercent(value: number | null, digits = 0): string {
  return value === null ? "-" : `${value.toFixed(digits)}%`;
}

export function formatDay(value: string | null): string {
  if (!value) return "-";
  return new Date(value.length === 10 ? `${value}T00:00:00` : value).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

// $1,234 / $12.3K / $1.2M - for chart labels and axis ticks, where the
// full figure doesn't fit. Tables and tooltips always show the full amount.
export function compactAud(cents: number): string {
  const dollars = cents / 100;
  const abs = Math.abs(dollars);
  const short = (n: number) => (Number.isInteger(Number(n.toFixed(1))) ? n.toFixed(0) : n.toFixed(1));
  if (abs >= 1_000_000) return `$${short(dollars / 1_000_000)}M`;
  if (abs >= 10_000) return `$${short(dollars / 1000)}K`;
  return `$${Math.round(dollars).toLocaleString("en-AU")}`;
}

export function downloadCsv(filename: string, header: string[], rows: (string | number)[][]) {
  const cell = (value: string | number) => (typeof value === "number" ? String(value) : `"${value.replace(/"/g, '""')}"`);
  const text = [header.map(cell).join(","), ...rows.map((row) => row.map(cell).join(","))].join("\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export const dollars = (cents: number) => Number((cents / 100).toFixed(2));

export function ExportButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-md px-3 py-1.5 font-semibold disabled:opacity-50"
      style={{ border: "1px solid var(--jms-border)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
    >
      Export CSV
    </button>
  );
}

export function PageHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-5">
      <h2 className="font-bold uppercase tracking-wide" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
        {title}
      </h2>
      <p className="mt-1 max-w-3xl" style={label}>
        {description}
      </p>
    </div>
  );
}

export function Panel({ title, note, actions, children }: { title?: string; note?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-5 rounded-lg p-5" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
      {title || actions ? (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            {title ? (
              <h3 className="font-bold uppercase tracking-wide" style={label}>
                {title}
              </h3>
            ) : null}
            {note ? (
              <p className="mt-1 max-w-2xl" style={label}>
                {note}
              </p>
            ) : null}
          </div>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="py-8 text-center" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
      {children}
    </p>
  );
}

// Change against the comparison period. Direction is carried by the arrow
// and the sign, not colour alone; colour says whether that direction is
// good (fewer days to payment is good, less revenue isn't).
export function Delta({ current, previous, goodWhenUp = true, unit = "%" }: { current: number | null; previous: number | null; goodWhenUp?: boolean; unit?: "%" | "pts" | "days" | "stars" }) {
  if (current === null || previous === null) return null;
  const change = unit === "%" ? (previous === 0 ? null : ((current - previous) / Math.abs(previous)) * 100) : current - previous;
  if (change === null) return null;
  if (Math.abs(change) < 0.05) {
    return <span style={label}>No change vs prior period</span>;
  }
  const up = change > 0;
  const good = up === goodWhenUp;
  const amount = unit === "%" ? `${Math.abs(change).toFixed(0)}%` : unit === "pts" ? `${Math.abs(change).toFixed(0)} pts` : `${Math.abs(change).toFixed(1)} ${unit}`;
  return (
    <span style={{ fontSize: "var(--jms-font-label)" }}>
      <span className="font-semibold" style={{ color: good ? "var(--jms-accent)" : "var(--jms-danger)" }}>
        {up ? "▲" : "▼"} {amount}
      </span>{" "}
      <span style={{ color: "var(--jms-text-muted)" }}>vs prior period</span>
    </span>
  );
}

export function StatTile({ label: tileLabel, value, sub, delta, onClick, tone }: { label: string; value: string; sub?: ReactNode; delta?: ReactNode; onClick?: () => void; tone?: "danger" }) {
  const content = (
    <>
      <p className="uppercase tracking-wide" style={label}>
        {tileLabel}
      </p>
      <p className="mt-1 text-2xl font-bold" style={{ color: tone === "danger" ? "var(--jms-danger)" : "var(--jms-text)" }}>
        {value}
      </p>
      {sub ? (
        <p className="mt-0.5" style={label}>
          {sub}
        </p>
      ) : null}
      {delta ? <p className="mt-1">{delta}</p> : null}
    </>
  );
  const style: CSSProperties = { border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" };
  if (!onClick) {
    return (
      <div className="flex h-full flex-col rounded-lg p-4" style={style}>
        {content}
      </div>
    );
  }
  return (
    <button onClick={onClick} className="jms-analytics-hit flex h-full w-full flex-col items-start rounded-lg p-4 text-left" style={style} title="Show what's behind this number">
      {content}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Ranked horizontal bars - one row per category, largest first.
// ---------------------------------------------------------------------------

export interface RankedRow {
  key: string;
  label: string;
  value: number;
  detail?: string;
  onSelect?: () => void;
}

export function RankedBars({ rows, format, limit }: { rows: RankedRow[]; format: (value: number) => string; limit?: number }) {
  const shown = limit ? rows.slice(0, limit) : rows;
  const max = Math.max(1, ...shown.map((r) => r.value));
  return (
    <div className="flex flex-col">
      {shown.map((row) => {
        const inner = (
          <>
            <span className="w-52 shrink-0 truncate text-left" style={body} title={row.label}>
              {row.label}
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span
                className="block h-3.5"
                style={{
                  width: `${(row.value / max) * 100}%`,
                  minWidth: row.value > 0 ? 2 : 0,
                  backgroundColor: ACCENT,
                  borderRadius: "0 4px 4px 0",
                }}
              />
              <span className="shrink-0 whitespace-nowrap font-semibold" style={body}>
                {format(row.value)}
              </span>
              {row.detail ? (
                <span className="shrink-0 whitespace-nowrap" style={label}>
                  {row.detail}
                </span>
              ) : null}
            </span>
          </>
        );
        return row.onSelect ? (
          <button key={row.key} onClick={row.onSelect} className="jms-analytics-hit flex items-center gap-3 rounded px-2 py-1.5">
            {inner}
          </button>
        ) : (
          <div key={row.key} className="flex items-center gap-3 px-2 py-1.5">
            {inner}
          </div>
        );
      })}
      {limit && rows.length > limit ? (
        <p className="px-2 pt-2" style={label}>
          Top {limit} of {rows.length} shown.
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Columns over time - one or two series per period, shared axis.
// ---------------------------------------------------------------------------

// Axis ticks from zero in a round step (1, 2 or 5 times a power of ten),
// at most five intervals, the last tick at or above the largest value.
function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const rough = max / 5;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 5, 10].find((m) => m * magnitude >= rough) ?? 10) * magnitude;
  const ticks: number[] = [];
  for (let t = 0; t < max + step - 1e-9; t += step) ticks.push(Number(t.toPrecision(12)));
  return ticks;
}

export interface ColumnPeriod {
  key: string;
  label: string;
  values: number[];
  onSelect?: (seriesIndex: number) => void;
}

export function Columns({ periods, series, format, tick, max: fixedMax }: { periods: ColumnPeriod[]; series: { name: string; color: string }[]; format: (value: number) => string; tick?: (value: number) => string; max?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const ticks = fixedMax ? Array.from({ length: fixedMax + 1 }, (_, i) => i) : niceTicks(Math.max(0, ...periods.flatMap((p) => p.values)));
  const top = ticks[ticks.length - 1] ?? 1;
  const tickText = tick ?? format;
  const plotHeight = 200;
  const hovered = hover === null ? null : periods[hover];

  return (
    <div>
      {series.length > 1 ? (
        <div className="mb-3 flex gap-4">
          {series.map((s) => (
            <span key={s.name} className="flex items-center gap-1.5" style={label}>
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      ) : null}
      <div className="flex">
        <div className="relative w-14 shrink-0" style={{ height: plotHeight }}>
          {ticks.map((t, i) => (
            <span key={i} className="absolute right-2 -translate-y-1/2 whitespace-nowrap tabular-nums" style={{ ...label, top: plotHeight - (t / top) * plotHeight }}>
              {tickText(t)}
            </span>
          ))}
        </div>
        <div className="min-w-0 flex-1 overflow-x-auto">
          <div className="relative" style={{ minWidth: periods.length * (series.length * 14 + 18) }}>
            <div className="relative" style={{ height: plotHeight }}>
              {ticks.map((t, i) => (
                <div key={i} className="absolute inset-x-0" style={{ top: plotHeight - (t / top) * plotHeight, borderTop: `1px solid ${i === 0 ? "var(--jms-border)" : HAIRLINE}` }} />
              ))}
              <div className="absolute inset-0 flex">
                {periods.map((period, index) => (
                  <div
                    key={period.key}
                    className="flex flex-1 items-end justify-center"
                    style={{ gap: 2, backgroundColor: hover === index ? "color-mix(in srgb, var(--jms-text-muted) 10%, transparent)" : undefined }}
                    onMouseEnter={() => setHover(index)}
                    onMouseLeave={() => setHover((h) => (h === index ? null : h))}
                  >
                    {period.values.map((value, seriesIndex) => {
                      const height = Math.max(value > 0 ? 2 : 0, (value / top) * plotHeight);
                      const bar: CSSProperties = { height, width: "100%", maxWidth: 24, backgroundColor: series[seriesIndex]?.color, borderRadius: "4px 4px 0 0" };
                      return period.onSelect ? (
                        <button
                          key={seriesIndex}
                          onClick={() => period.onSelect?.(seriesIndex)}
                          onFocus={() => setHover(index)}
                          onBlur={() => setHover(null)}
                          aria-label={`${period.label}, ${series[seriesIndex]?.name}: ${format(value)}`}
                          className="flex h-full flex-1 items-end justify-center"
                          style={{ maxWidth: 24 }}
                        >
                          <span className="block" style={bar} />
                        </button>
                      ) : (
                        <span key={seriesIndex} className="block flex-1" style={bar} />
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
            <div className="flex pt-1.5">
              {periods.map((period) => (
                <span key={period.key} className="flex-1 whitespace-nowrap text-center" style={label}>
                  {period.label}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
      <p className="mt-2 h-5" style={label} aria-live="polite">
        {hovered ? (
          <>
            <span style={{ color: "var(--jms-text)" }}>{hovered.label}</span>
            {hovered.values.map((value, i) => (
              <span key={i}>
                {" · "}
                <span className="font-semibold" style={{ color: "var(--jms-text)" }}>
                  {format(value)}
                </span>{" "}
                {series[i]?.name}
              </span>
            ))}
          </>
        ) : periods.some((p) => p.onSelect) ? (
          "Hover a column for its figures; click to see what's behind it."
        ) : (
          "Hover a column for its figures."
        )}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Two cumulative lines on one axis (FY target).
// ---------------------------------------------------------------------------

export interface LinePoint {
  label: string;
  actual: number | null;
  target: number | null;
}

export function CumulativeLines({ points, format, actualName, targetName }: { points: LinePoint[]; format: (value: number) => string; actualName: string; targetName: string }) {
  const wrapper = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  const height = 240;
  const pad = { left: 56, right: 16, top: 12, bottom: 26 };
  const plotW = Math.max(100, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;
  const ticks = niceTicks(Math.max(1, ...points.flatMap((p) => [p.actual ?? 0, p.target ?? 0])));
  const top = ticks[ticks.length - 1] ?? 1;
  const x = (i: number) => pad.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v: number) => pad.top + plotH - (v / top) * plotH;
  const path = (pick: (p: LinePoint) => number | null) =>
    points
      .map((p, i) => ({ v: pick(p), i }))
      .filter((d): d is { v: number; i: number } => d.v !== null)
      .map((d, n) => `${n === 0 ? "M" : "L"}${x(d.i).toFixed(1)},${y(d.v).toFixed(1)}`)
      .join(" ");
  const hasTarget = points.some((p) => p.target !== null);
  const lastActual = [...points].reverse().find((p) => p.actual !== null);
  const lastActualIndex = lastActual ? points.lastIndexOf(lastActual) : -1;
  const hovered = hover === null ? null : points[hover];

  return (
    <div ref={wrapper}>
      <div className="mb-2 flex gap-4">
        <span className="flex items-center gap-1.5" style={label}>
          <span className="inline-block h-0.5 w-4" style={{ backgroundColor: ACCENT }} />
          {actualName}
        </span>
        {hasTarget ? (
          <span className="flex items-center gap-1.5" style={label}>
            <span className="inline-block h-0.5 w-4" style={{ backgroundColor: CONTEXT }} />
            {targetName}
          </span>
        ) : null}
      </div>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`${actualName} against ${targetName} by month`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const ratio = (e.clientX - rect.left - pad.left) / plotW;
          setHover(Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1)))));
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={pad.left + plotW} y1={y(t)} y2={y(t)} stroke={t === 0 ? "var(--jms-border)" : HAIRLINE} strokeWidth={1} />
            <text x={pad.left - 8} y={y(t) + 3} textAnchor="end" style={{ fill: "var(--jms-text-muted)", fontSize: 11 }}>
              {compactAud(t)}
            </text>
          </g>
        ))}
        {points.map((p, i) => (
          <text key={i} x={x(i)} y={height - 8} textAnchor="middle" style={{ fill: "var(--jms-text-muted)", fontSize: 11 }}>
            {p.label}
          </text>
        ))}
        {hover !== null ? <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + plotH} stroke="var(--jms-text-muted)" strokeWidth={1} /> : null}
        {hasTarget ? <path d={path((p) => p.target)} fill="none" stroke={CONTEXT} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" /> : null}
        <path d={path((p) => p.actual)} fill="none" stroke={ACCENT} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {lastActual && lastActual.actual !== null ? (
          <circle cx={x(lastActualIndex)} cy={y(lastActual.actual)} r={4} fill={ACCENT} stroke="var(--jms-surface)" strokeWidth={2} />
        ) : null}
      </svg>
      <p className="mt-1 h-5" style={label} aria-live="polite">
        {hovered ? (
          <>
            <span style={{ color: "var(--jms-text)" }}>{hovered.label}</span>
            {hovered.actual !== null ? (
              <>
                {" · "}
                <span className="font-semibold" style={{ color: "var(--jms-text)" }}>
                  {format(hovered.actual)}
                </span>{" "}
                {actualName.toLowerCase()}
              </>
            ) : null}
            {hovered.target !== null ? (
              <>
                {" · "}
                <span className="font-semibold" style={{ color: "var(--jms-text)" }}>
                  {format(hovered.target)}
                </span>{" "}
                {targetName.toLowerCase()}
              </>
            ) : null}
          </>
        ) : (
          "Hover the chart for each month's running totals."
        )}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export interface Column<T> {
  header: string;
  align?: "right";
  render: (row: T) => ReactNode;
  // Makes this one cell a button that opens the records behind it.
  onSelect?: (row: T) => (() => void) | undefined;
}

export function DataTable<T>({ columns, rows, rowKey, footer }: { columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string; footer?: ReactNode[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left" style={{ fontSize: "var(--jms-font-body)" }}>
        <thead className="uppercase" style={{ borderBottom: "1px solid var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
          <tr>
            {columns.map((col, i) => (
              <th key={i} className={`px-2 py-2 font-semibold ${col.align === "right" ? "text-right" : ""}`}>
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} style={{ borderBottom: `1px solid ${HAIRLINE}`, color: "var(--jms-text)" }}>
              {columns.map((col, i) => {
                const select = col.onSelect?.(row);
                return (
                  <td key={i} className={`px-2 py-2 ${col.align === "right" ? "text-right tabular-nums" : ""}`}>
                    {select ? (
                      <button onClick={select} className="jms-analytics-link" title="Show what's behind this number">
                        {col.render(row)}
                      </button>
                    ) : (
                      col.render(row)
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        {footer ? (
          <tfoot>
            <tr className="font-semibold" style={{ borderTop: "1px solid var(--jms-border)", color: "var(--jms-text)" }}>
              {footer.map((cell, i) => (
                <td key={i} className={`px-2 py-2 ${columns[i]?.align === "right" ? "text-right tabular-nums" : ""}`}>
                  {cell}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The records behind a number
// ---------------------------------------------------------------------------

const DRILL_LIMIT = 200;

function DrillSection<T>({ heading, rows, render }: { heading: string; rows: T[]; render: (row: T) => ReactNode }) {
  return (
    <div className="mb-5 last:mb-0">
      <h4 className="mb-2 font-bold uppercase tracking-wide" style={label}>
        {heading} ({rows.length})
      </h4>
      <div className="flex flex-col">{rows.slice(0, DRILL_LIMIT).map(render)}</div>
      {rows.length > DRILL_LIMIT ? (
        <p className="mt-2" style={label}>
          Showing the first {DRILL_LIMIT} of {rows.length}.
        </p>
      ) : null}
    </div>
  );
}

function DrillRow({ to, primary, secondary, amount }: { to: string; primary: string; secondary: string; amount?: string }) {
  return (
    <Link to={to} className="jms-analytics-hit flex items-baseline gap-3 rounded px-2 py-1.5" style={{ borderBottom: `1px solid ${HAIRLINE}` }}>
      <span className="min-w-0 flex-1 truncate" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>
        {primary}
      </span>
      <span className="shrink-0 whitespace-nowrap" style={label}>
        {secondary}
      </span>
      {amount ? (
        <span className="w-24 shrink-0 text-right font-semibold tabular-nums" style={body}>
          {amount}
        </span>
      ) : null}
    </Link>
  );
}

export function DrillModal({ drill, ix, onClose }: { drill: Drill | null; ix: AnalyticsIndex; onClose: () => void }) {
  useEffect(() => {
    if (!drill) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drill, onClose]);

  if (!drill) return null;
  const clientName = (id: string) => ix.clientById.get(id)?.name ?? "Unknown client";
  const empty = !drill.jobs?.length && !drill.invoices?.length && !drill.quotes?.length && !drill.clients?.length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ backgroundColor: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={drill.title}
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg"
        style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)", fontFamily: "var(--jms-font)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 p-5" style={{ borderBottom: "1px solid var(--jms-border)" }}>
          <div>
            <h3 className="font-bold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
              {drill.title}
            </h3>
            {drill.subtitle ? (
              <p className="mt-0.5" style={label}>
                {drill.subtitle}
              </p>
            ) : null}
          </div>
          <button onClick={onClose} aria-label="Close" className="text-xl leading-none" style={{ color: "var(--jms-text-muted)" }}>
            &times;
          </button>
        </div>
        <div className="overflow-y-auto p-5">
          {empty ? <Empty>Nothing behind this number.</Empty> : null}
          {drill.jobs?.length ? (
            <DrillSection
              heading="Jobs"
              rows={[...drill.jobs].sort((a, b) => (b.completed_at ?? b.created_at).localeCompare(a.completed_at ?? a.created_at))}
              render={(job) => (
                <DrillRow
                  key={job.id}
                  to={`/jobs/${job.id}`}
                  primary={`${job.number ?? "Pending"} - ${job.title}`}
                  secondary={`${clientName(job.client_id)} · ${job.completed_at ? `completed ${formatDay(job.completed_at)}` : `created ${formatDay(job.created_at)}`}`}
                />
              )}
            />
          ) : null}
          {drill.invoices?.length ? (
            <DrillSection
              heading="Invoices"
              rows={[...drill.invoices].sort((a, b) => b.issue_date.localeCompare(a.issue_date))}
              render={(inv) => (
                <DrillRow
                  key={inv.id}
                  to={`/invoices/${inv.id}`}
                  primary={`${inv.invoice_number} - ${clientName(inv.client_id)}`}
                  secondary={`${inv.status} · issued ${formatDay(inv.issue_date)}`}
                  amount={formatCentsAsAud(inv.total_cents)}
                />
              )}
            />
          ) : null}
          {drill.quotes?.length ? (
            <DrillSection
              heading="Quotes"
              rows={[...drill.quotes].sort((a, b) => b.issue_date.localeCompare(a.issue_date))}
              render={(quote) => (
                <DrillRow
                  key={quote.id}
                  to={`/quotes/${quote.id}`}
                  primary={`${quote.quote_number} - ${clientName(quote.client_id)}`}
                  secondary={`${quote.status} · issued ${formatDay(quote.issue_date)}`}
                  amount={formatCentsAsAud(quote.total_cents)}
                />
              )}
            />
          ) : null}
          {drill.clients?.length ? (
            <DrillSection
              heading="Clients"
              rows={drill.clients}
              render={(client) => (
                <DrillRow
                  key={client.id}
                  to={`/clients/${client.id}`}
                  primary={client.name}
                  secondary={client.google_review_stars !== null ? `${client.google_review_stars} stars · ${formatDay(client.google_review_recorded_at)}` : ""}
                />
              )}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function Stars({ value }: { value: number }) {
  const rounded = Math.round(value);
  return (
    <span aria-label={`${value.toFixed(1)} out of 5`} style={{ color: "var(--jms-warning)" }}>
      {"★".repeat(rounded)}
      {"☆".repeat(5 - rounded)}
    </span>
  );
}

import { useState } from "react";
import { Link } from "react-router-dom";
import type { MaterialTallyItem } from "@jmssaas/shared";
import { LinearMeasurer } from "./LinearMeasurer";
import { MaterialTally } from "./MaterialTally";
import { PhotoMarkup } from "./PhotoMarkup";
import { ConcreteCalculator } from "./ConcreteCalculator";
import { MaterialOrderForm } from "./MaterialOrderForm";

type ToolKey = "roof" | "linear" | "tally" | "markup" | "concrete" | "order";

const TOOLS: { key: ToolKey; label: string }[] = [
  { key: "roof", label: "Roof Area" },
  { key: "linear", label: "Linear Measurer" },
  { key: "tally", label: "Material Tally" },
  { key: "markup", label: "Photo Markup" },
  { key: "concrete", label: "Concrete Calculator" },
  { key: "order", label: "Material Order" },
];

// Job Card "Quote Tools" - a hub for site-estimating tools, alongside the
// existing Roof Area Tool (its own route, /jobs/:id/measure - reused
// as-is here rather than duplicated, see the "Roof Area" tab below).
// `transferredTallyItems` is the one piece of state shared between two
// sibling tools (Material Tally's "Transfer to Material Order Form"
// button) - a pure in-memory handoff, no DB round-trip needed since both
// tools are mounted here at once (just conditionally rendered).
export function QuoteToolsSection({ jobCardId }: { jobCardId: string }) {
  const [activeTool, setActiveTool] = useState<ToolKey>("linear");
  const [transferredTallyItems, setTransferredTallyItems] = useState<MaterialTallyItem[] | null>(null);

  return (
    <div className="mb-6 rounded-lg border border-gray-300 bg-white p-6">
      <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-gray-500">Quote Tools</h2>
      <div className="mb-4 flex flex-wrap gap-1.5">
        {TOOLS.map((t) =>
          t.key === "roof" ? (
            <Link
              key={t.key}
              to={`/jobs/${jobCardId}/measure`}
              className="rounded-md bg-gray-100 px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-200"
            >
              {t.label}
            </Link>
          ) : (
            <button
              key={t.key}
              onClick={() => setActiveTool(t.key)}
              className={`rounded-md px-3 py-1.5 text-sm font-semibold ${activeTool === t.key ? "bg-blue-700 text-white" : "bg-gray-100 text-gray-700"}`}
            >
              {t.label}
            </button>
          )
        )}
      </div>

      {activeTool === "linear" ? <LinearMeasurer jobCardId={jobCardId} /> : null}
      {activeTool === "tally" ? (
        <MaterialTally
          jobCardId={jobCardId}
          onTransferToOrder={(items) => {
            setTransferredTallyItems(items);
            setActiveTool("order");
          }}
        />
      ) : null}
      {activeTool === "markup" ? <PhotoMarkup jobCardId={jobCardId} /> : null}
      {activeTool === "concrete" ? <ConcreteCalculator jobCardId={jobCardId} /> : null}
      {activeTool === "order" ? (
        <MaterialOrderForm jobCardId={jobCardId} prefillItems={transferredTallyItems} onConsumedPrefill={() => setTransferredTallyItems(null)} />
      ) : null}
    </div>
  );
}

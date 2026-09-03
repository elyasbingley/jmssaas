import { useState } from "react";
import type { MaterialTallyItem } from "@jmssaas/shared";
import { RoofAreaTool } from "./RoofAreaTool";
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

// Job Card "Quote Tools" - a hub for site-estimating tools, including the
// Roof Area Tool (embedded here as an ordinary tab rather than its own
// route, so it behaves identically to the other five tools).
// `transferredTallyItems` is the one piece of state shared between two
// sibling tools (Material Tally's "Transfer to Material Order Form"
// button) - a pure in-memory handoff, no DB round-trip needed since both
// tools are mounted here at once (just conditionally rendered).
export function QuoteToolsSection({ jobCardId }: { jobCardId: string }) {
  const [activeTool, setActiveTool] = useState<ToolKey>("roof");
  const [transferredTallyItems, setTransferredTallyItems] = useState<MaterialTallyItem[] | null>(null);

  return (
    <div className="mb-6 rounded-lg border border-gray-300 bg-white p-6">
      <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-gray-500">Quote Tools</h2>
      <div className="mb-4 flex flex-wrap gap-1.5">
        {TOOLS.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTool(t.key)}
            className={`rounded-md px-3 py-1.5 text-sm font-semibold ${activeTool === t.key ? "bg-blue-700 text-white" : "bg-gray-100 text-gray-700"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTool === "roof" ? <RoofAreaTool jobCardId={jobCardId} /> : null}
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

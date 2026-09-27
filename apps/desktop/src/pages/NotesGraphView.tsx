import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import ForceGraph2D, { type NodeObject } from "react-force-graph-2d";
import {
  ALL_NOTE_LINKS_KEY,
  NOTEBOOKS_KEY,
  NOTES_INDEX_KEY,
  colorForIndex,
  fetchAllResolvedNoteLinks,
  fetchNotebooks,
  fetchNotesIndex,
} from "../components/notes/notesData";

interface GraphNode {
  id: string;
  title: string;
  color: string;
}

// All notes + their resolved [[wikilinks]] as an interactive force-directed
// graph. Unresolved links (no target note yet) have nothing to draw an
// edge to, so they're left out here - see fetchAllResolvedNoteLinks.
// Nodes are coloured by notebook using the same "fixed, distinct app-level
// palette" reasoning as B2BReferrals.tsx's tier badges (colorForIndex),
// since the CRT theme only exposes one active accent colour at a time.
export default function NotesGraphViewPage() {
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });

  const { data: notesIndex } = useQuery({ queryKey: NOTES_INDEX_KEY, queryFn: fetchNotesIndex });
  const { data: notebooks } = useQuery({ queryKey: NOTEBOOKS_KEY, queryFn: fetchNotebooks });
  const { data: links } = useQuery({ queryKey: ALL_NOTE_LINKS_KEY, queryFn: fetchAllResolvedNoteLinks });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setSize({ width: el.clientWidth, height: Math.max(el.clientHeight, 480) });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const notebookColorById = useMemo(() => new Map((notebooks ?? []).map((nb, i) => [nb.id, colorForIndex(i)])), [notebooks]);
  const noNotebookColor = "#8a8f98";

  const graphData = useMemo(() => {
    const nodes: GraphNode[] = (notesIndex ?? []).map((n) => ({
      id: n.id,
      title: n.title || "Untitled",
      color: n.notebook_id ? notebookColorById.get(n.notebook_id) ?? noNotebookColor : noNotebookColor,
    }));
    const edges = (links ?? [])
      .filter((l) => l.target_note_id && l.source_note_id !== l.target_note_id)
      .map((l) => ({ source: l.source_note_id, target: l.target_note_id as string }));
    return { nodes, links: edges };
  }, [notesIndex, links, notebookColorById]);

  const themeColors = useMemo(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      text: style.getPropertyValue("--jms-text").trim() || "#e6f7ff",
      border: style.getPropertyValue("--jms-border").trim() || "#334",
    };
  }, []);

  return (
    <div>
      <h2 className="mb-2 uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
        Graph view
      </h2>
      <p className="mb-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
        Nodes are notes, coloured by notebook. Edges are resolved [[wikilinks]]. Click a node to open it, drag to rearrange, scroll to zoom.
      </p>
      <div ref={containerRef} className="rounded" style={{ border: "1px solid var(--jms-border)", height: "70vh", overflow: "hidden" }}>
        {graphData.nodes.length === 0 ? (
          <p className="p-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            No notes yet.
          </p>
        ) : (
          <ForceGraph2D
            width={size.width}
            height={size.height}
            graphData={graphData}
            nodeId="id"
            nodeLabel="title"
            linkColor={() => themeColors.border}
            linkDirectionalArrowLength={4}
            onNodeClick={(node: NodeObject<GraphNode>) => node.id && navigate(`/notes/note/${node.id}`)}
            nodeCanvasObject={(node: NodeObject<GraphNode>, ctx, globalScale) => {
              const r = 4;
              const x = node.x ?? 0;
              const y = node.y ?? 0;
              ctx.beginPath();
              ctx.arc(x, y, r, 0, 2 * Math.PI, false);
              ctx.fillStyle = node.color;
              ctx.fill();

              const fontSize = 12 / globalScale;
              ctx.font = `${fontSize}px sans-serif`;
              ctx.fillStyle = themeColors.text;
              ctx.textBaseline = "middle";
              ctx.fillText(node.title, x + r + 3, y);
            }}
          />
        )}
      </div>
    </div>
  );
}

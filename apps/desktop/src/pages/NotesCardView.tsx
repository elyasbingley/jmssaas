import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useNotesBaseData } from "../components/notes/useNotesBaseData";
import { formatPropertyValue, propertyMatchesFilter, sortableValue } from "../components/notes/notePropertyHelpers";

type SortKey = "title" | "updated_at" | `prop:${string}`;

// Card ("gallery") view - same filter/sort-on-property-values engine as
// the Table view, rendered as a grid of cards instead of rows.
export default function NotesCardViewPage() {
  const navigate = useNavigate();
  const { notes, notebooksById, propertiesByNote, propertyKeys, tagsByNote, isLoading } = useNotesBaseData();

  const [sortKey, setSortKey] = useState<SortKey>("updated_at");
  const [sortDesc, setSortDesc] = useState(true);
  const [filterKey, setFilterKey] = useState<string>("");
  const [filterValue, setFilterValue] = useState("");

  const cards = useMemo(() => {
    let list = notes;
    if (filterKey && filterValue.trim()) {
      list = list.filter((n) => propertyMatchesFilter(propertiesByNote.get(n.id)?.find((p) => p.key === filterKey), filterValue));
    }
    const sorted = [...list].sort((a, b) => {
      let av: number | string;
      let bv: number | string;
      if (sortKey === "title") {
        av = a.title.toLowerCase();
        bv = b.title.toLowerCase();
      } else if (sortKey === "updated_at") {
        av = a.updated_at;
        bv = b.updated_at;
      } else {
        const key = sortKey.slice("prop:".length);
        av = sortableValue(propertiesByNote.get(a.id)?.find((p) => p.key === key));
        bv = sortableValue(propertiesByNote.get(b.id)?.find((p) => p.key === key));
      }
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDesc ? -cmp : cmp;
    });
    return sorted;
  }, [notes, filterKey, filterValue, propertiesByNote, sortKey, sortDesc]);

  return (
    <div>
      <h2 className="mb-4 uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
        Card view
      </h2>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          className="rounded border px-2 py-1.5"
          style={{ backgroundColor: "var(--jms-surface)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
        >
          <option value="title">Sort: Title</option>
          <option value="updated_at">Sort: Last updated</option>
          {propertyKeys.map((k) => (
            <option key={k} value={`prop:${k}`}>
              Sort: {k}
            </option>
          ))}
        </select>
        <button
          onClick={() => setSortDesc((d) => !d)}
          className="rounded border px-3 py-1.5"
          style={{ borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}
        >
          {sortDesc ? "Descending" : "Ascending"}
        </button>
        <select
          value={filterKey}
          onChange={(e) => setFilterKey(e.target.value)}
          className="rounded border px-2 py-1.5"
          style={{ backgroundColor: "var(--jms-surface)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
        >
          <option value="">No property filter</option>
          {propertyKeys.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        {filterKey ? (
          <input
            type="text"
            value={filterValue}
            onChange={(e) => setFilterValue(e.target.value)}
            placeholder="value, or >10 / <=2026-01-01"
            className="rounded border px-3 py-1.5"
            style={{ backgroundColor: "var(--jms-surface)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
          />
        ) : null}
      </div>

      {isLoading ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>Loading...</p>
      ) : cards.length === 0 ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>No notes match.</p>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          {cards.map((n) => {
            const props = (propertiesByNote.get(n.id) ?? []).slice(0, 4);
            return (
              <button
                key={n.id}
                onClick={() => navigate(`/notes/note/${n.id}`)}
                className="rounded p-3 text-left"
                style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}
              >
                <p className="mb-1 truncate font-semibold" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                  {n.title || "Untitled"}
                </p>
                <p className="mb-2" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                  {notebooksById.get(n.notebook_id ?? "")?.name ?? "Unfiled"}
                </p>
                {(tagsByNote.get(n.id) ?? []).length > 0 ? (
                  <div className="mb-2 flex flex-wrap gap-1">
                    {(tagsByNote.get(n.id) ?? []).map((t) => (
                      <span key={t} className="rounded border px-1.5 py-0.5" style={{ borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                        #{t}
                      </span>
                    ))}
                  </div>
                ) : null}
                {props.length > 0 ? (
                  <div className="space-y-0.5">
                    {props.map((p) => (
                      <p key={p.key} style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                        <span className="font-semibold">{p.key}:</span> {formatPropertyValue(p) || "-"}
                      </p>
                    ))}
                  </div>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useNotesBaseData } from "../components/notes/useNotesBaseData";
import { formatPropertyValue, propertyMatchesFilter, sortableValue } from "../components/notes/notePropertyHelpers";

type SortKey = "title" | "notebook" | "updated_at" | `prop:${string}`;

// Table view - a minimal Bases-style filter/sort layer over notes +
// note_properties. Filters and sorts on real property values (not just
// note titles), per the spec.
export default function NotesTableViewPage() {
  const navigate = useNavigate();
  const { notes, notebooksById, propertiesByNote, propertyKeys, tagsByNote, isLoading } = useNotesBaseData();

  const [sortKey, setSortKey] = useState<SortKey>("updated_at");
  const [sortDesc, setSortDesc] = useState(true);
  const [filterKey, setFilterKey] = useState<SortKey | "">("");
  const [filterValue, setFilterValue] = useState("");
  const [titleFilter, setTitleFilter] = useState("");

  const rows = useMemo(() => {
    let list = notes;
    const trimmedTitle = titleFilter.trim().toLowerCase();
    if (trimmedTitle) list = list.filter((n) => n.title.toLowerCase().includes(trimmedTitle));

    if (filterKey && filterValue.trim()) {
      if (filterKey.startsWith("prop:")) {
        const key = filterKey.slice("prop:".length);
        list = list.filter((n) => propertyMatchesFilter(propertiesByNote.get(n.id)?.find((p) => p.key === key), filterValue));
      } else if (filterKey === "notebook") {
        list = list.filter((n) => (notebooksById.get(n.notebook_id ?? "")?.name ?? "Unfiled").toLowerCase().includes(filterValue.trim().toLowerCase()));
      }
    }

    const sorted = [...list].sort((a, b) => {
      let av: number | string;
      let bv: number | string;
      if (sortKey === "title") {
        av = a.title.toLowerCase();
        bv = b.title.toLowerCase();
      } else if (sortKey === "notebook") {
        av = (notebooksById.get(a.notebook_id ?? "")?.name ?? "").toLowerCase();
        bv = (notebooksById.get(b.notebook_id ?? "")?.name ?? "").toLowerCase();
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
  }, [notes, titleFilter, filterKey, filterValue, propertiesByNote, notebooksById, sortKey, sortDesc]);

  const sortOptions: { value: SortKey; label: string }[] = [
    { value: "title", label: "Title" },
    { value: "notebook", label: "Notebook" },
    { value: "updated_at", label: "Last updated" },
    ...propertyKeys.map((k): { value: SortKey; label: string } => ({ value: `prop:${k}`, label: k })),
  ];

  return (
    <div>
      <h2 className="mb-4 uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
        Table view
      </h2>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <input
          type="text"
          value={titleFilter}
          onChange={(e) => setTitleFilter(e.target.value)}
          placeholder="Filter by title..."
          className="rounded border px-3 py-1.5"
          style={{ backgroundColor: "var(--jms-surface)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
        />
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          className="rounded border px-2 py-1.5"
          style={{ backgroundColor: "var(--jms-surface)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
        >
          {sortOptions.map((o) => (
            <option key={o.value} value={o.value}>
              Sort: {o.label}
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
          onChange={(e) => setFilterKey(e.target.value as SortKey | "")}
          className="rounded border px-2 py-1.5"
          style={{ backgroundColor: "var(--jms-surface)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
        >
          <option value="">No property filter</option>
          <option value="notebook">Notebook</option>
          {propertyKeys.map((k) => (
            <option key={k} value={`prop:${k}`}>
              {k}
            </option>
          ))}
        </select>
        {filterKey ? (
          <input
            type="text"
            value={filterValue}
            onChange={(e) => setFilterValue(e.target.value)}
            placeholder={filterKey.startsWith("prop:") ? "value, or >10 / <=2026-01-01" : "value"}
            className="rounded border px-3 py-1.5"
            style={{ backgroundColor: "var(--jms-surface)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
          />
        ) : null}
      </div>

      {isLoading ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>Loading...</p>
      ) : rows.length === 0 ? (
        <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>No notes match.</p>
      ) : (
        <div className="overflow-x-auto rounded" style={{ border: "1px solid var(--jms-border)" }}>
          <table className="w-full" style={{ fontSize: "var(--jms-font-body)" }}>
            <thead>
              <tr style={{ backgroundColor: "var(--jms-bg)", borderBottom: "1px solid var(--jms-border)" }}>
                <th className="px-3 py-2 text-left" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                  Title
                </th>
                <th className="px-3 py-2 text-left" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                  Notebook
                </th>
                <th className="px-3 py-2 text-left" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                  Tags
                </th>
                {propertyKeys.map((k) => (
                  <th key={k} className="px-3 py-2 text-left" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                    {k}
                  </th>
                ))}
                <th className="px-3 py-2 text-left" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                  Updated
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((n) => (
                <tr
                  key={n.id}
                  onClick={() => navigate(`/notes/note/${n.id}`)}
                  className="jms-nav-link cursor-pointer"
                  style={{ borderBottom: "1px solid var(--jms-border)" }}
                >
                  <td className="px-3 py-2 font-semibold" style={{ color: "var(--jms-text)" }}>
                    {n.title || "Untitled"}
                  </td>
                  <td className="px-3 py-2" style={{ color: "var(--jms-text-muted)" }}>
                    {notebooksById.get(n.notebook_id ?? "")?.name ?? "Unfiled"}
                  </td>
                  <td className="px-3 py-2" style={{ color: "var(--jms-text-muted)" }}>
                    {(tagsByNote.get(n.id) ?? []).map((t) => `#${t}`).join(" ")}
                  </td>
                  {propertyKeys.map((k) => {
                    const prop = propertiesByNote.get(n.id)?.find((p) => p.key === k);
                    return (
                      <td key={k} className="px-3 py-2" style={{ color: "var(--jms-text)" }}>
                        {prop ? formatPropertyValue(prop) || "-" : "-"}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2" style={{ color: "var(--jms-text-muted)" }}>
                    {new Date(n.updated_at).toLocaleDateString("en-AU")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

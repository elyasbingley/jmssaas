import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { formatCentsAsAud, type Quote, type QuoteStatus } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";

const STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
};

// Status colours read from the CRT theme tokens (not a fixed hex palette -
// unlike a safety/tier signal, "accepted vs declined" has no meaning that
// must survive an accent swap, so it's fine for these to shift with the
// tenant's chosen accent like everything else on this page).
const STATUS_COLOR_VAR: Record<QuoteStatus, string> = {
  draft: "var(--jms-text-muted)",
  sent: "var(--jms-accent)",
  accepted: "var(--jms-accent)",
  declined: "var(--jms-danger)",
  expired: "var(--jms-warning)",
};

const STATUS_FILTERS: QuoteStatus[] = ["draft", "sent", "accepted", "declined", "expired"];

type QuoteRow = Quote & { clients: { name: string } | null };
type SortKey = "number" | "client" | "status" | "total" | "issued";

async function fetchQuotes(): Promise<QuoteRow[]> {
  const { data, error } = await supabase
    .from("quotes")
    .select("*, clients(name)")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as QuoteRow[];
}

// A quote whose own expiry_date has passed with no client decision is
// effectively dead even though nothing has (yet) flipped its stored
// status to 'expired' - the "quote_expired" reminder email fires on this
// same date, but nothing updates quotes.status itself, so without this a
// quote could sit in "Sent" forever after quietly lapsing. Deliberately
// keyed off expiry_date only, never token_expires_at (the approval link's
// own, unrelated 30-day security window, which silently renews itself the
// next time anyone clicks "Copy approval link" - see that migration's own
// comment) - conflating the two is exactly what caused the "I changed the
// expiry date but the link still says expired" confusion this is meant to
// avoid repeating in the other direction.
function effectiveStatus(quote: QuoteRow, todayStr: string): QuoteStatus {
  if (quote.status === "sent" && quote.expiry_date && quote.expiry_date < todayStr) return "expired";
  return quote.status;
}

function daysSince(dateStr: string, todayStr: string): number {
  const ms = new Date(todayStr).getTime() - new Date(dateStr).getTime();
  return Math.max(0, Math.round(ms / 86400000));
}

function SortHeader({
  label,
  sortKey,
  activeKey,
  direction,
  onSort,
  align,
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  direction: "asc" | "desc";
  onSort: (key: SortKey) => void;
  align?: "right";
}) {
  const active = activeKey === sortKey;
  return (
    <th className={`px-4 py-2 font-semibold ${align === "right" ? "text-right" : ""}`}>
      <button
        onClick={() => onSort(sortKey)}
        className="inline-flex items-center gap-1 uppercase"
        style={{ color: active ? "var(--jms-accent)" : "inherit" }}
      >
        {label}
        {active ? <span>{direction === "asc" ? "▲" : "▼"}</span> : null}
      </button>
    </th>
  );
}

export default function QuotesPage() {
  const { data: quotes, isLoading } = useQuery({ queryKey: ["quotes"], queryFn: fetchQuotes });

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<QuoteStatus | "all">("all");
  const [sortKey, setSortKey] = useState<SortKey>("issued");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const todayStr = new Date().toISOString().slice(0, 10);

  const statusCounts = useMemo(() => {
    const counts: Record<QuoteStatus, number> = { draft: 0, sent: 0, accepted: 0, declined: 0, expired: 0 };
    for (const q of quotes ?? []) counts[effectiveStatus(q, todayStr)]++;
    return counts;
  }, [quotes, todayStr]);

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "total" ? "desc" : "asc");
    }
  };

  const visibleQuotes = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = (quotes ?? []).filter((q) => {
      const status = effectiveStatus(q, todayStr);
      if (statusFilter !== "all" && status !== statusFilter) return false;
      if (!query) return true;
      return q.quote_number.toLowerCase().includes(query) || (q.clients?.name ?? "").toLowerCase().includes(query);
    });

    const sorted = [...filtered].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "number":
          cmp = a.quote_number.localeCompare(b.quote_number);
          break;
        case "client":
          cmp = (a.clients?.name ?? "").localeCompare(b.clients?.name ?? "");
          break;
        case "status":
          cmp = effectiveStatus(a, todayStr).localeCompare(effectiveStatus(b, todayStr));
          break;
        case "total":
          cmp = a.total_cents - b.total_cents;
          break;
        case "issued":
          cmp = a.issue_date.localeCompare(b.issue_date);
          break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [quotes, search, statusFilter, sortKey, sortDir, todayStr]);

  return (
    <div className="p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
            Quotes
          </h1>
          <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>{quotes?.length ?? 0} quotes</p>
        </div>
        <Link
          to="/quotes/new"
          className="rounded px-4 py-2 font-semibold uppercase tracking-wide"
          style={{ backgroundColor: "var(--jms-accent)", color: "var(--jms-bg)", boxShadow: "0 0 10px var(--jms-accent-glow)", fontSize: "var(--jms-font-button)" }}
        >
          + New quote
        </Link>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          onClick={() => setStatusFilter("all")}
          className="rounded-full border px-3 py-1.5 font-semibold"
          style={
            statusFilter === "all"
              ? { backgroundColor: "var(--jms-accent-glow)", borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }
              : { backgroundColor: "transparent", borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }
          }
        >
          All ({quotes?.length ?? 0})
        </button>
        {STATUS_FILTERS.map((status) => (
          <button
            key={status}
            onClick={() => setStatusFilter(status)}
            className="rounded-full border px-3 py-1.5 font-semibold"
            style={
              statusFilter === status
                ? { backgroundColor: "var(--jms-accent-glow)", borderColor: STATUS_COLOR_VAR[status], color: STATUS_COLOR_VAR[status], fontSize: "var(--jms-font-label)" }
                : { backgroundColor: "transparent", borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }
            }
          >
            {STATUS_LABELS[status]} ({statusCounts[status]})
          </button>
        ))}
      </div>

      <input
        type="text"
        placeholder="Search by client or quote number..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="mb-4 w-full max-w-sm rounded border px-3 py-2 focus:outline-none"
        style={{ backgroundColor: "var(--jms-surface)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
      />

      <div className="overflow-hidden rounded" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        {isLoading ? (
          <p className="p-6" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Loading...
          </p>
        ) : visibleQuotes.length === 0 ? (
          <p className="p-6" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            {quotes && quotes.length > 0 ? "No quotes match this filter." : "No quotes yet."}
          </p>
        ) : (
          <table className="w-full text-left" style={{ fontSize: "var(--jms-font-body)" }}>
            <thead
              className="uppercase"
              style={{ borderBottom: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
            >
              <tr>
                <SortHeader label="Number" sortKey="number" activeKey={sortKey} direction={sortDir} onSort={handleSort} />
                <SortHeader label="Client" sortKey="client" activeKey={sortKey} direction={sortDir} onSort={handleSort} />
                <SortHeader label="Status" sortKey="status" activeKey={sortKey} direction={sortDir} onSort={handleSort} />
                <SortHeader label="Sent" sortKey="issued" activeKey={sortKey} direction={sortDir} onSort={handleSort} />
                <SortHeader label="Total" sortKey="total" activeKey={sortKey} direction={sortDir} onSort={handleSort} align="right" />
              </tr>
            </thead>
            <tbody>
              {visibleQuotes.map((quote) => {
                const status = effectiveStatus(quote, todayStr);
                const outstandingDays = status === "sent" ? daysSince(quote.issue_date, todayStr) : null;
                return (
                  <tr key={quote.id} className="jms-nav-link last:border-0" style={{ borderBottom: "1px solid var(--jms-border)" }}>
                    <td className="px-4 py-3" style={{ color: "var(--jms-accent)" }}>
                      <Link to={`/quotes/${quote.id}`} className="font-medium hover:underline">
                        {quote.quote_number}
                      </Link>
                    </td>
                    <td className="px-4 py-3" style={{ color: "var(--jms-text-muted)" }}>
                      {quote.clients?.name ?? "Unknown client"}
                    </td>
                    <td className="px-4 py-3 font-semibold" style={{ color: STATUS_COLOR_VAR[status] }}>
                      {STATUS_LABELS[status]}
                    </td>
                    <td className="px-4 py-3" style={{ color: "var(--jms-text-muted)" }}>
                      {new Date(quote.issue_date).toLocaleDateString("en-AU")}
                      {outstandingDays !== null ? (
                        <span
                          className="ml-2 font-semibold"
                          style={{ color: outstandingDays >= 14 ? "var(--jms-danger)" : outstandingDays >= 7 ? "var(--jms-warning)" : "var(--jms-text-muted)" }}
                        >
                          · awaiting {outstandingDays} day{outstandingDays === 1 ? "" : "s"}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold" style={{ color: "var(--jms-text)" }}>
                      {formatCentsAsAud(quote.total_cents)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

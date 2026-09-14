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

type QuoteRow = Quote & { clients: { name: string } | null };

async function fetchQuotes(): Promise<QuoteRow[]> {
  const { data, error } = await supabase
    .from("quotes")
    .select("*, clients(name)")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as QuoteRow[];
}

export default function QuotesPage() {
  const { data: quotes, isLoading } = useQuery({ queryKey: ["quotes"], queryFn: fetchQuotes });

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

      <div className="overflow-hidden rounded" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        {isLoading ? (
          <p className="p-6" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Loading...
          </p>
        ) : !quotes || quotes.length === 0 ? (
          <p className="p-6" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            No quotes yet.
          </p>
        ) : (
          <table className="w-full text-left" style={{ fontSize: "var(--jms-font-body)" }}>
            <thead
              className="uppercase"
              style={{ borderBottom: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
            >
              <tr>
                <th className="px-4 py-2 font-semibold">Number</th>
                <th className="px-4 py-2 font-semibold">Client</th>
                <th className="px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2 text-right font-semibold">Total</th>
              </tr>
            </thead>
            <tbody>
              {quotes.map((quote) => (
                <tr key={quote.id} className="jms-nav-link last:border-0" style={{ borderBottom: "1px solid var(--jms-border)" }}>
                  <td className="px-4 py-3" style={{ color: "var(--jms-accent)" }}>
                    <Link to={`/quotes/${quote.id}`} className="font-medium hover:underline">
                      {quote.quote_number}
                    </Link>
                  </td>
                  <td className="px-4 py-3" style={{ color: "var(--jms-text-muted)" }}>
                    {quote.clients?.name ?? "Unknown client"}
                  </td>
                  <td className="px-4 py-3 font-semibold" style={{ color: STATUS_COLOR_VAR[quote.status] }}>
                    {STATUS_LABELS[quote.status]}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold" style={{ color: "var(--jms-text)" }}>
                    {formatCentsAsAud(quote.total_cents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

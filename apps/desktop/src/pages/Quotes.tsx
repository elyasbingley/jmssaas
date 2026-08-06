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
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Quotes</h1>
          <p className="text-sm text-gray-500">{quotes?.length ?? 0} quotes</p>
        </div>
        <Link
          to="/quotes/new"
          className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800"
        >
          + New quote
        </Link>
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        {isLoading ? (
          <p className="p-6 text-sm text-gray-500">Loading...</p>
        ) : !quotes || quotes.length === 0 ? (
          <p className="p-6 text-sm text-gray-500">No quotes yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-2 font-semibold">Number</th>
                <th className="px-4 py-2 font-semibold">Client</th>
                <th className="px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2 text-right font-semibold">Total</th>
              </tr>
            </thead>
            <tbody>
              {quotes.map((quote) => (
                <tr key={quote.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3 text-blue-700">
                    <Link to={`/quotes/${quote.id}`} className="font-medium hover:underline">
                      {quote.quote_number}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{quote.clients?.name ?? "Unknown client"}</td>
                  <td className="px-4 py-3 font-semibold text-gray-700">{STATUS_LABELS[quote.status]}</td>
                  <td className="px-4 py-3 text-right font-semibold">{formatCentsAsAud(quote.total_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

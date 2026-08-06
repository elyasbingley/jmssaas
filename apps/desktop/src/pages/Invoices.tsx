import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { formatCentsAsAud, type Invoice, type InvoiceStatus } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";

const STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  paid: "Paid",
  overdue: "Overdue",
  void: "Void",
};

type InvoiceRow = Invoice & { clients: { name: string } | null };

async function fetchInvoices(): Promise<InvoiceRow[]> {
  const { data, error } = await supabase
    .from("invoices")
    .select("*, clients(name)")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as InvoiceRow[];
}

export default function InvoicesPage() {
  const { data: invoices, isLoading } = useQuery({ queryKey: ["invoices"], queryFn: fetchInvoices });

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Invoices</h1>
          <p className="text-sm text-gray-500">{invoices?.length ?? 0} invoices</p>
        </div>
        <Link
          to="/invoices/new"
          className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800"
        >
          + New invoice
        </Link>
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        {isLoading ? (
          <p className="p-6 text-sm text-gray-500">Loading...</p>
        ) : !invoices || invoices.length === 0 ? (
          <p className="p-6 text-sm text-gray-500">No invoices yet.</p>
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
              {invoices.map((invoice) => (
                <tr key={invoice.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3 text-blue-700">
                    <Link to={`/invoices/${invoice.id}`} className="font-medium hover:underline">
                      {invoice.invoice_number}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{invoice.clients?.name ?? "Unknown client"}</td>
                  <td className="px-4 py-3 font-semibold text-gray-700">{STATUS_LABELS[invoice.status]}</td>
                  <td className="px-4 py-3 text-right font-semibold">{formatCentsAsAud(invoice.total_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

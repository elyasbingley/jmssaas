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

// Status colours read from theme tokens, same rationale as Quotes.tsx - no
// fixed semantic hex needed here (unlike a safety signal), this can shift
// with the tenant's chosen accent like everything else on the page.
const STATUS_COLOR_VAR: Record<InvoiceStatus, string> = {
  draft: "var(--jms-text-muted)",
  sent: "var(--jms-accent)",
  paid: "var(--jms-accent)",
  overdue: "var(--jms-danger)",
  void: "var(--jms-text-muted)",
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
    <div className="p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
            Invoices
          </h1>
          <p style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>{invoices?.length ?? 0} invoices</p>
        </div>
        <Link
          to="/invoices/new"
          className="rounded px-4 py-2 font-semibold uppercase tracking-wide"
          style={{ backgroundColor: "var(--jms-accent)", color: "var(--jms-bg)", boxShadow: "0 0 10px var(--jms-accent-glow)", fontSize: "var(--jms-font-button)" }}
        >
          + New invoice
        </Link>
      </div>

      <div className="overflow-hidden rounded" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
        {isLoading ? (
          <p className="p-6" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Loading...
          </p>
        ) : !invoices || invoices.length === 0 ? (
          <p className="p-6" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            No invoices yet.
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
              {invoices.map((invoice) => (
                <tr key={invoice.id} className="jms-nav-link last:border-0" style={{ borderBottom: "1px solid var(--jms-border)" }}>
                  <td className="px-4 py-3" style={{ color: "var(--jms-accent)" }}>
                    <Link to={`/invoices/${invoice.id}`} className="font-medium hover:underline">
                      {invoice.invoice_number}
                    </Link>
                  </td>
                  <td className="px-4 py-3" style={{ color: "var(--jms-text-muted)" }}>
                    {invoice.clients?.name ?? "Unknown client"}
                  </td>
                  <td className="px-4 py-3 font-semibold" style={{ color: STATUS_COLOR_VAR[invoice.status] }}>
                    {STATUS_LABELS[invoice.status]}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold" style={{ color: "var(--jms-text)" }}>
                    {formatCentsAsAud(invoice.total_cents)}
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

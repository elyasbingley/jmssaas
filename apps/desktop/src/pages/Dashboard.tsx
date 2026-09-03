import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  DEFAULT_DASHBOARD_WIDGETS,
  invoiceDashboardBucket,
  quoteDashboardBucket,
  type DashboardWidgetPrefs,
  type InvoiceStatus,
  type QuoteStatus,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { addDays, isSameDay } from "../lib/datetime";

// The home screen (see App.tsx - "/" renders this, not Dispatch). Shows the
// four summary widgets from the Dashboard spec: jobs booked today/tomorrow,
// and status breakdowns for invoices/quotes. Which widgets show is
// per-user, editable from Settings > Dashboard (see DashboardSettings.tsx) -
// profile.dashboard_widgets, not a tenant-wide setting, since it's purely a
// personal "what do I want to see first" preference.
//
// "Booked" is read off calendar_events, not job_cards.scheduled_at -
// calendar_events is the single source of truth for "when is this job
// happening" (see Dispatch.tsx's own comment), so a job only counts once it
// actually has a booking, same definition Dispatch itself uses for
// "unassigned".
type BookedEvent = { job_card_id: string | null; start_at: string };
type QuoteRow = { id: string; status: QuoteStatus };
type InvoiceRow = { id: string; status: InvoiceStatus; quote_id: string | null };

async function fetchBookedEvents(): Promise<BookedEvent[]> {
  const { data, error } = await supabase.from("calendar_events").select("job_card_id, start_at").not("job_card_id", "is", null);
  if (error) throw error;
  return data as BookedEvent[];
}
async function fetchQuotes(): Promise<QuoteRow[]> {
  const { data, error } = await supabase.from("quotes").select("id, status");
  if (error) throw error;
  return data as QuoteRow[];
}
async function fetchInvoices(): Promise<InvoiceRow[]> {
  const { data, error } = await supabase.from("invoices").select("id, status, quote_id");
  if (error) throw error;
  return data as InvoiceRow[];
}

function StatCard({ to, label, value }: { to: string; label: string; value: number | undefined }) {
  return (
    <Link
      to={to}
      className="flex flex-col justify-between rounded-lg border border-gray-200 bg-white p-6 shadow-sm hover:border-blue-300 hover:shadow-md"
    >
      <p className="text-sm font-semibold text-gray-500">{label}</p>
      <p className="mt-2 text-4xl font-bold text-gray-900">{value ?? "-"}</p>
    </Link>
  );
}

function BreakdownCard({
  to,
  title,
  rows,
}: {
  to: string;
  title: string;
  rows: { label: string; value: number | undefined }[];
}) {
  return (
    <Link to={to} className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm hover:border-blue-300 hover:shadow-md">
      <p className="mb-3 text-sm font-semibold text-gray-500">{title}</p>
      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between">
            <span className="text-sm text-gray-600">{row.label}</span>
            <span className="text-lg font-bold text-gray-900">{row.value ?? "-"}</span>
          </div>
        ))}
      </div>
    </Link>
  );
}

export default function DashboardPage() {
  const { profile } = useAuth();
  const widgets: DashboardWidgetPrefs = profile?.dashboard_widgets ?? DEFAULT_DASHBOARD_WIDGETS;

  const { data: events } = useQuery({ queryKey: ["dashboard-booked-events"], queryFn: fetchBookedEvents });
  const { data: quotes } = useQuery({ queryKey: ["dashboard-quotes"], queryFn: fetchQuotes });
  const { data: invoices } = useQuery({ queryKey: ["dashboard-invoices"], queryFn: fetchInvoices });

  const jobsToday = useMemo(() => {
    if (!events) return undefined;
    const today = new Date();
    return events.filter((e) => isSameDay(new Date(e.start_at), today)).length;
  }, [events]);

  const jobsTomorrow = useMemo(() => {
    if (!events) return undefined;
    const tomorrow = addDays(new Date(), 1);
    return events.filter((e) => isSameDay(new Date(e.start_at), tomorrow)).length;
  }, [events]);

  const invoiceCounts = useMemo(() => {
    if (!invoices) return undefined;
    const counts = { draft: 0, unpaid: 0, overdue: 0 };
    for (const invoice of invoices) {
      const bucket = invoiceDashboardBucket(invoice.status);
      if (bucket) counts[bucket]++;
    }
    return counts;
  }, [invoices]);

  const quoteCounts = useMemo(() => {
    if (!quotes || !invoices) return undefined;
    const billedQuoteIds = new Set(invoices.filter((i) => i.quote_id).map((i) => i.quote_id));
    const counts = { draft: 0, unbilled: 0, billed: 0 };
    for (const quote of quotes) {
      counts[quoteDashboardBucket(quote.status, billedQuoteIds.has(quote.id))]++;
    }
    return counts;
  }, [quotes, invoices]);

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">Dashboard</h1>
        <Link to="/settings/dashboard" className="text-sm font-semibold text-blue-700 hover:underline">
          Customise
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {widgets.jobs_today ? <StatCard to="/dispatch" label="Jobs booked today" value={jobsToday} /> : null}
        {widgets.jobs_tomorrow ? <StatCard to="/dispatch" label="Jobs booked tomorrow" value={jobsTomorrow} /> : null}
        {widgets.invoices ? (
          <BreakdownCard
            to="/invoices"
            title="Invoices"
            rows={[
              { label: "Draft", value: invoiceCounts?.draft },
              { label: "Unpaid", value: invoiceCounts?.unpaid },
              { label: "Overdue", value: invoiceCounts?.overdue },
            ]}
          />
        ) : null}
        {widgets.quotes ? (
          <BreakdownCard
            to="/quotes"
            title="Quotes"
            rows={[
              { label: "Draft", value: quoteCounts?.draft },
              { label: "Unbilled", value: quoteCounts?.unbilled },
              { label: "Billed", value: quoteCounts?.billed },
            ]}
          />
        ) : null}
      </div>

      {!widgets.jobs_today && !widgets.jobs_tomorrow && !widgets.invoices && !widgets.quotes ? (
        <p className="text-sm text-gray-500">
          Every widget is turned off. <Link to="/settings/dashboard" className="text-blue-700 hover:underline">Customise your Dashboard</Link> to
          show some again.
        </p>
      ) : null}
    </div>
  );
}

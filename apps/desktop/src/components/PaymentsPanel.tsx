import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MANUAL_PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  formatCentsAsAud,
  invoiceBalanceCents,
  invoiceOverpaidCents,
  parseDollarsToCents,
  quoteBalanceCents,
  quoteDepositDueCents,
  quoteDepositRemainingCents,
  type Invoice,
  type Payment,
  type PaymentMethod,
  type Quote,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { getErrorMessage } from "../lib/errors";
import { useAuth } from "../lib/auth-context";
import { ThemedButton } from "./theme/ThemedButton";
import { ThemedModal } from "./theme/ThemedModal";

// Payments against an invoice (part payments, deposits carried over from
// its quote) or a quote (deposits) - see the payments migration. The
// database keeps the invoice's amount paid and paid/unpaid status in step
// with these rows; this panel only lists them and records/removes them.
//
// Card payments through Stripe (Tap to Pay on the phone, or the client
// paying online from their link) are recorded automatically, so the
// "Record payment" form here is for everything else.

type Target = { kind: "invoice"; invoice: Invoice } | { kind: "quote"; quote: Quote };

async function fetchPayments(target: Target): Promise<Payment[]> {
  const column = target.kind === "invoice" ? "invoice_id" : "quote_id";
  const id = target.kind === "invoice" ? target.invoice.id : target.quote.id;
  const { data, error } = await supabase.from("payments").select("*").eq(column, id).order("paid_at");
  if (error) throw error;
  return data as Payment[];
}

const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const labelStyle = { color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" };
const inputStyle = { backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" };

export function PaymentsPanel({ target, onChanged }: { target: Target; onChanged: () => void }) {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";
  const targetId = target.kind === "invoice" ? target.invoice.id : target.quote.id;
  const queryKey = ["payments", target.kind, targetId];
  const { data: payments, error: loadError } = useQuery({ queryKey, queryFn: () => fetchPayments(target) });

  const [recordOpen, setRecordOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("bank_transfer");
  const [paidOn, setPaidOn] = useState(todayLocal());
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["payments"] });
    queryClient.invalidateQueries({ queryKey: ["analytics"] });
    onChanged();
  };

  // What's still owing: the invoice balance, or for a quote the deposit
  // still to come (falling back to the quote balance if there's no deposit
  // set, e.g. the client wants to pay up front).
  const balanceCents = target.kind === "invoice" ? invoiceBalanceCents(target.invoice) : quoteBalanceCents(target.quote);
  const suggestedCents =
    target.kind === "invoice" ? balanceCents : quoteDepositRemainingCents(target.quote) || balanceCents;

  const openRecord = () => {
    setAmount(suggestedCents > 0 ? (suggestedCents / 100).toFixed(2) : "");
    setMethod("bank_transfer");
    setPaidOn(todayLocal());
    setReference("");
    setNotes("");
    setFormError(null);
    setRecordOpen(true);
  };

  const record = useMutation({
    mutationFn: async () => {
      const cents = parseDollarsToCents(amount);
      if (cents === null) throw new Error("Enter an amount, e.g. 250 or 250.50");
      // Noon local time, so the date never slips a day either side of UTC.
      const paidAt = new Date(`${paidOn}T12:00:00`);
      const { error } = await supabase.rpc("record_payment", {
        p_invoice_id: target.kind === "invoice" ? targetId : null,
        p_quote_id: target.kind === "quote" ? targetId : null,
        p_amount_cents: cents,
        p_method: method,
        p_paid_at: paidOn === todayLocal() ? null : paidAt.toISOString(),
        p_reference: reference,
        p_notes: notes,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setRecordOpen(false);
      refresh();
    },
    onError: (e) => setFormError(getErrorMessage(e, "Couldn't record the payment")),
  });

  const remove = useMutation({
    mutationFn: async (payment: Payment) => {
      const { error } = await supabase.rpc("delete_payment", { p_payment_id: payment.id });
      if (error) throw error;
    },
    onSuccess: () => {
      setRemoveError(null);
      refresh();
    },
    onError: (e) => setRemoveError(getErrorMessage(e, "Couldn't remove the payment")),
  });

  const confirmRemove = (payment: Payment) => {
    const stripeNote = payment.stripe_payment_intent_id
      ? "\n\nThis was a card payment through Stripe - removing it here does NOT refund the client. Refund it in the Stripe Dashboard first if that's what you mean to do."
      : "";
    if (window.confirm(`Remove this ${formatCentsAsAud(payment.amount_cents)} payment?${stripeNote}`)) remove.mutate(payment);
  };

  const summaryRows: [string, string, string?][] =
    target.kind === "invoice"
      ? [
          ["Invoice total", formatCentsAsAud(target.invoice.total_cents)],
          ["Paid", formatCentsAsAud(target.invoice.amount_paid_cents)],
          invoiceOverpaidCents(target.invoice) > 0
            ? ["Overpaid", formatCentsAsAud(invoiceOverpaidCents(target.invoice)), "var(--jms-danger)"]
            : ["Balance owing", formatCentsAsAud(balanceCents), balanceCents > 0 ? "var(--jms-accent)" : undefined],
        ]
      : [
          ["Deposit asked", quoteDepositDueCents(target.quote) > 0 ? formatCentsAsAud(quoteDepositDueCents(target.quote)) : "None"],
          ["Paid so far", formatCentsAsAud(target.quote.deposit_paid_cents)],
          ...(quoteDepositDueCents(target.quote) > 0
            ? ([["Deposit still to come", formatCentsAsAud(quoteDepositRemainingCents(target.quote)), quoteDepositRemainingCents(target.quote) > 0 ? "var(--jms-accent)" : undefined]] as [string, string, string?][])
            : []),
        ];

  const closed =
    target.kind === "invoice" ? target.invoice.status === "void" : target.quote.status === "draft" || target.quote.status === "declined" || target.quote.status === "expired";

  return (
    <div className="mt-3 rounded p-3" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }} data-testid="payments-panel">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="font-bold uppercase tracking-wide" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
          {target.kind === "invoice" ? "Payments" : "Deposit & payments"}
        </p>
        {!closed && balanceCents > 0 ? (
          <ThemedButton onClick={openRecord} style={{ paddingBlock: 4, paddingInline: 10 }}>
            + Record payment
          </ThemedButton>
        ) : null}
      </div>

      <div className="mb-2 flex flex-wrap gap-x-6 gap-y-1" style={{ fontSize: "var(--jms-font-body)" }}>
        {summaryRows.map(([label, value, color]) => (
          <span key={label}>
            <span style={labelStyle}>{label}: </span>
            <span className="font-semibold" style={{ color: color ?? "var(--jms-text)" }}>
              {value}
            </span>
          </span>
        ))}
      </div>

      {loadError ? <p style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>{getErrorMessage(loadError, "Couldn't load payments")}</p> : null}

      {payments && payments.length > 0 ? (
        <table className="w-full" style={{ fontSize: "var(--jms-font-body)", color: "var(--jms-text)" }}>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id} style={{ borderTop: "1px solid var(--jms-border)" }}>
                <td className="py-1 pr-3" style={{ color: "var(--jms-text-muted)", whiteSpace: "nowrap" }}>
                  {new Date(p.paid_at).toLocaleDateString("en-AU")}
                </td>
                <td className="py-1 pr-3">
                  {PAYMENT_METHOD_LABELS[p.method]}
                  {p.kind === "deposit" ? <span style={labelStyle}> · deposit</span> : null}
                  {p.reference ? <span style={labelStyle}> · {p.reference}</span> : null}
                  {p.notes ? <div style={labelStyle}>{p.notes}</div> : null}
                  <XeroPaymentStatus payment={p} invoiceInXero={target.kind === "invoice" && !!target.invoice.xero_invoice_id} />
                </td>
                <td className="py-1 pr-3 text-right font-semibold">{formatCentsAsAud(p.amount_cents)}</td>
                <td className="py-1 text-right">
                  {isAdmin ? (
                    <button onClick={() => confirmRemove(p)} disabled={remove.isPending} className="hover:underline" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}>
                      Remove
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : payments ? (
        <p style={labelStyle}>No payments yet.</p>
      ) : null}
      {removeError ? <p className="mt-2" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>{removeError}</p> : null}

      <p className="mt-2" style={labelStyle}>
        {target.kind === "quote" && target.quote.status === "draft"
          ? "Send the quote before taking a deposit on it. "
          : null}
        Card payments are recorded automatically - Tap to Pay in the phone app, or the client paying from their {target.kind} link. No card surcharge is added.
      </p>

      <ThemedModal open={recordOpen} onClose={() => setRecordOpen(false)} title={target.kind === "invoice" ? "Record a payment" : "Record a deposit"}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            record.mutate();
          }}
          className="space-y-3"
        >
          <label className="block">
            <span className="mb-1 block font-semibold uppercase tracking-wide" style={labelStyle}>
              Amount ($)
            </span>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" autoFocus className="w-full rounded border px-3 py-2" style={inputStyle} />
            <span style={labelStyle}>Up to {formatCentsAsAud(balanceCents)} - a smaller amount is a part payment.</span>
          </label>
          <label className="block">
            <span className="mb-1 block font-semibold uppercase tracking-wide" style={labelStyle}>
              Paid by
            </span>
            <select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)} className="w-full rounded border px-3 py-2" style={inputStyle}>
              {MANUAL_PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {PAYMENT_METHOD_LABELS[m]}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block font-semibold uppercase tracking-wide" style={labelStyle}>
              Date received
            </span>
            <input type="date" value={paidOn} max={todayLocal()} onChange={(e) => setPaidOn(e.target.value)} className="w-full rounded border px-3 py-2" style={inputStyle} />
          </label>
          <label className="block">
            <span className="mb-1 block font-semibold uppercase tracking-wide" style={labelStyle}>
              Reference (optional)
            </span>
            <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. bank transfer description" className="w-full rounded border px-3 py-2" style={inputStyle} />
          </label>
          <label className="block">
            <span className="mb-1 block font-semibold uppercase tracking-wide" style={labelStyle}>
              Notes (optional)
            </span>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full rounded border px-3 py-2" style={inputStyle} />
          </label>
          {formError ? <p style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>{formError}</p> : null}
          <div className="flex justify-end gap-2">
            <ThemedButton type="button" variant="secondary" onClick={() => setRecordOpen(false)}>
              Cancel
            </ThemedButton>
            <ThemedButton type="submit" disabled={record.isPending}>
              {record.isPending ? "Saving..." : "Record payment"}
            </ThemedButton>
          </div>
        </form>
      </ThemedModal>
    </div>
  );
}

// Where a payment stands with Xero (xero_two_way_sync migration). Nothing
// is shown for payments that were never going to Xero (recorded before
// two-way sync, placeholders) unless something went wrong.
function XeroPaymentStatus({ payment, invoiceInXero }: { payment: Payment; invoiceInXero: boolean }) {
  let text: string | null = null;
  let color = "var(--jms-text-muted)";
  if (payment.source === "xero") text = "From Xero";
  else if (payment.xero_payment_id) text = "In Xero";
  else if (payment.xero_sync_error) {
    text = `Not in Xero: ${payment.xero_sync_error}`;
    color = "var(--jms-danger)";
  } else if (!payment.xero_skip && invoiceInXero) text = "Waiting to go to Xero";
  if (!text) return null;
  return <div style={{ ...labelStyle, color }}>{text}</div>;
}

// The deposit a quote asks for: none, a % of the total, or a fixed amount.
// New quotes start with the company default (Settings > Company Details).
export function QuoteDepositControl({ quote, onChanged }: { quote: Quote; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState<"none" | "percent" | "fixed">("none");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const due = quoteDepositDueCents(quote);
  const current =
    quote.deposit_fixed_cents != null
      ? `${formatCentsAsAud(quote.deposit_fixed_cents)} fixed`
      : quote.deposit_percent != null
        ? `${Number(quote.deposit_percent)}% (${formatCentsAsAud(due)})`
        : "No deposit";

  const save = useMutation({
    mutationFn: async () => {
      let update: { deposit_percent: number | null; deposit_fixed_cents: number | null };
      if (kind === "none") update = { deposit_percent: null, deposit_fixed_cents: null };
      else if (kind === "percent") {
        const pct = Number(value);
        if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw new Error("Enter a % between 1 and 100");
        update = { deposit_percent: Math.round(pct * 100) / 100, deposit_fixed_cents: null };
      } else {
        const cents = parseDollarsToCents(value);
        if (cents === null) throw new Error("Enter an amount, e.g. 500");
        update = { deposit_percent: null, deposit_fixed_cents: cents };
      }
      const { error } = await supabase.from("quotes").update(update).eq("id", quote.id);
      if (error) throw error;
    },
    onSuccess: () => {
      setEditing(false);
      setError(null);
      onChanged();
    },
    onError: (e) => setError(getErrorMessage(e, "Couldn't save the deposit")),
  });

  const startEditing = () => {
    if (quote.deposit_fixed_cents != null) {
      setKind("fixed");
      setValue((quote.deposit_fixed_cents / 100).toFixed(2));
    } else if (quote.deposit_percent != null) {
      setKind("percent");
      setValue(String(Number(quote.deposit_percent)));
    } else {
      setKind("none");
      setValue("");
    }
    setEditing(true);
  };

  return (
    <div className="mt-3 rounded p-3" style={{ border: "1px solid var(--jms-border)", fontSize: "var(--jms-font-body)" }} data-testid="quote-deposit">
      <div className="flex items-center justify-between gap-3">
        <span>
          <span style={labelStyle}>Deposit: </span>
          <span className="font-semibold">{current}</span>
        </span>
        {editing ? null : (
          <button onClick={startEditing} className="font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
            Change
          </button>
        )}
      </div>
      {editing ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className="rounded border px-2 py-1" style={inputStyle}>
            <option value="none">No deposit</option>
            <option value="percent">% of the quote</option>
            <option value="fixed">Fixed amount</option>
          </select>
          {kind !== "none" ? (
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              inputMode="decimal"
              placeholder={kind === "percent" ? "e.g. 30" : "e.g. 500"}
              className="w-28 rounded border px-2 py-1"
              style={inputStyle}
              aria-label={kind === "percent" ? "Deposit percent" : "Deposit amount"}
            />
          ) : null}
          <span style={labelStyle}>{kind === "percent" ? "%" : kind === "fixed" ? "$" : ""}</span>
          <ThemedButton onClick={() => save.mutate()} disabled={save.isPending} style={{ paddingBlock: 4, paddingInline: 10 }}>
            Save
          </ThemedButton>
          <ThemedButton variant="secondary" onClick={() => setEditing(false)} style={{ paddingBlock: 4, paddingInline: 10 }}>
            Cancel
          </ThemedButton>
        </div>
      ) : null}
      {error ? <p className="mt-2" style={{ color: "var(--jms-danger)" }}>{error}</p> : null}
      <p className="mt-1" style={labelStyle}>
        Once the client accepts, their quote link offers to pay the deposit online by card.
      </p>
    </div>
  );
}

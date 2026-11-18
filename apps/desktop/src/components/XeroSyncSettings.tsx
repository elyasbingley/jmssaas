import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { XeroPaymentAccountKey, XeroPaymentAccounts } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { getErrorMessage } from "../lib/errors";
import { ThemedButton } from "./theme/ThemedButton";

// Settings > Company Details > Xero, once connected: the two-way sync
// (xero_two_way_sync migration, xero-sync function). Automatic invoice
// push on/off, which Xero account each kind of payment lands in, and how
// the sync is going.

export interface XeroStatus {
  connected: boolean;
  org_name?: string | null;
  last_sweep_at?: string | null;
  last_sweep_error?: string | null;
  missing_scopes?: string[];
  pending_invoices?: number;
  invoice_errors?: number;
  pending_payments?: number;
  payment_errors?: number;
}

type XeroAccount = { id: string; name: string; code: string | null; type: string };

const ACCOUNT_ROWS: { key: XeroPaymentAccountKey; label: string; hint: string }[] = [
  { key: "stripe", label: "Card payments through Stripe", hint: "Tap to Pay and clients paying online. A Stripe clearing account lets each Stripe payout match in one go." },
  { key: "cash", label: "Cash", hint: "" },
  { key: "bank_transfer", label: "Bank transfer", hint: "" },
  { key: "card", label: "Card on another machine", hint: "" },
  { key: "cheque", label: "Cheque", hint: "" },
  { key: "other", label: "Other", hint: "" },
];

async function callXeroSync(body: Record<string, unknown>) {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  if (!token) throw new Error("Not signed in");
  const res = await fetch(`${supabaseUrl}/functions/v1/xero-sync`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body: json };
}

const muted = { color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" };
const selectStyle = { backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" };

export function XeroSyncSettings({
  tenantId,
  status,
  autoSync,
  paymentAccounts,
  isAdmin,
  onReconnect,
}: {
  tenantId: string;
  status: XeroStatus;
  autoSync: boolean;
  paymentAccounts: XeroPaymentAccounts;
  isAdmin: boolean;
  onReconnect: () => void;
}) {
  const queryClient = useQueryClient();
  const [mapping, setMapping] = useState<XeroPaymentAccounts>(paymentAccounts);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  useEffect(() => setMapping(paymentAccounts), [paymentAccounts]);

  const missing = status.missing_scopes ?? [];
  const canListAccounts = !missing.includes("accounting.settings.read");
  const accountsQuery = useQuery({
    queryKey: ["xero-accounts", tenantId],
    enabled: isAdmin && canListAccounts,
    queryFn: async () => {
      const res = await callXeroSync({ action: "list_accounts" });
      if (!res.ok) {
        const e = res.body?.error;
        throw new Error(e === "missing_scope" ? "Reconnect Xero to load your accounts" : e === "busy" ? "Xero is syncing - try again in a moment" : e || "Couldn't load accounts from Xero");
      }
      return res.body.accounts as XeroAccount[];
    },
    staleTime: 5 * 60_000,
    retry: false,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["xero-status"] });
    queryClient.invalidateQueries({ queryKey: ["tenant"] });
  };

  const saveAutoSync = useMutation({
    mutationFn: async (value: boolean) => {
      const { error } = await supabase.from("tenants").update({ xero_auto_sync: value }).eq("id", tenantId);
      if (error) throw error;
    },
    onSuccess: refresh,
    onError: (e) => setMessage({ tone: "error", text: getErrorMessage(e, "Couldn't save") }),
  });

  const saveAccounts = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("tenants").update({ xero_payment_accounts: mapping }).eq("id", tenantId);
      if (error) throw error;
      // Payments that were waiting for an account go on the next sync.
      await callXeroSync({ action: "sync_now" });
    },
    onSuccess: () => {
      setMessage({ tone: "ok", text: "Saved - payments waiting for an account have been sent." });
      refresh();
    },
    onError: (e) => setMessage({ tone: "error", text: getErrorMessage(e, "Couldn't save") }),
  });

  const syncNow = useMutation({
    mutationFn: async () => {
      const res = await callXeroSync({ action: "sync_now" });
      if (res.status === 409) throw new Error("A sync is already running - give it a minute");
      if (!res.ok) throw new Error(res.body?.error || "Sync failed");
      return res.body.result as Record<string, number>;
    },
    onSuccess: (r) => {
      const parts = [
        r.invoicesPushed ? `${r.invoicesPushed} invoice${r.invoicesPushed === 1 ? "" : "s"} sent` : null,
        r.paymentsPushed ? `${r.paymentsPushed} payment${r.paymentsPushed === 1 ? "" : "s"} sent` : null,
        r.paymentsImported ? `${r.paymentsImported} payment${r.paymentsImported === 1 ? "" : "s"} brought in` : null,
        r.invoicesSettled ? `${r.invoicesSettled} marked paid` : null,
        r.invoicesVoided ? `${r.invoicesVoided} voided` : null,
      ].filter(Boolean);
      setMessage({ tone: "ok", text: parts.length ? `Synced: ${parts.join(", ")}.` : "Synced - nothing new." });
      refresh();
      queryClient.invalidateQueries({ queryKey: ["invoice"] });
      queryClient.invalidateQueries({ queryKey: ["payments"] });
    },
    onError: (e) => setMessage({ tone: "error", text: getErrorMessage(e, "Sync failed") }),
  });

  const accounts = accountsQuery.data ?? [];
  const dirty = JSON.stringify(mapping) !== JSON.stringify(paymentAccounts);
  const pendingLine = [
    status.pending_invoices ? `${status.pending_invoices} invoice${status.pending_invoices === 1 ? "" : "s"} waiting` : null,
    status.pending_payments ? `${status.pending_payments} payment${status.pending_payments === 1 ? "" : "s"} waiting` : null,
    status.invoice_errors || status.payment_errors ? `${(status.invoice_errors ?? 0) + (status.payment_errors ?? 0)} with a problem (see the invoice)` : null,
  ].filter(Boolean);

  return (
    <div className="mt-3 rounded-lg p-4" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)", fontSize: "var(--jms-font-body)" }} data-testid="xero-sync-settings">
      <p className="mb-1 font-bold uppercase tracking-wide" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
        Two-way sync
      </p>
      <p className="mb-3" style={muted}>
        Invoices go to Xero, payments taken here go onto the Xero invoice, and payments you receive or reconcile in Xero come back here and
        mark the invoice paid. Checks Xero every 10 minutes, and straight away if the Xero webhook is set up.
      </p>

      {missing.length ? (
        <div className="mb-3 rounded p-3" style={{ border: "1px solid var(--jms-danger)" }}>
          <p style={{ color: "var(--jms-danger)" }}>
            Reconnect Xero to turn on payment sync - this connection was made before the app asked Xero for permission to read and add
            payments{missing.includes("accounting.settings.read") ? " and list your bank accounts" : ""}. Invoices still sync, and invoices
            paid in full in Xero still show as paid here.
          </p>
          {isAdmin ? (
            <ThemedButton onClick={onReconnect} style={{ marginTop: 8, paddingBlock: 6, paddingInline: 12 }}>
              Reconnect Xero
            </ThemedButton>
          ) : null}
        </div>
      ) : null}

      <label className="mb-3 flex items-center gap-2" style={{ color: "var(--jms-text)" }}>
        <input type="checkbox" checked={autoSync} disabled={!isAdmin || saveAutoSync.isPending} onChange={(e) => saveAutoSync.mutate(e.target.checked)} />
        Send invoices to Xero automatically when they're sent to the client
      </label>
      {!autoSync ? (
        <p className="-mt-2 mb-3" style={muted}>
          Off: an invoice only goes to Xero from its "Sync to Xero" button. Turning this on also sends invoices from the last 30 days that
          aren't in Xero yet.
        </p>
      ) : null}

      <p className="mb-1 font-semibold" style={{ color: "var(--jms-text)" }}>
        Which Xero account payments go into
      </p>
      <p className="mb-2" style={muted}>
        Payments with no account chosen aren't sent to Xero.
      </p>
      {accountsQuery.error ? <p className="mb-2" style={{ color: "var(--jms-danger)" }}>{getErrorMessage(accountsQuery.error, "Couldn't load accounts")}</p> : null}
      <div className="mb-3 space-y-2">
        {ACCOUNT_ROWS.map((row) => (
          <div key={row.key} className="grid grid-cols-[220px_1fr] items-center gap-3">
            <div>
              <div style={{ color: "var(--jms-text)" }}>{row.label}</div>
              {row.hint ? <div style={muted}>{row.hint}</div> : null}
            </div>
            <select
              aria-label={`Xero account for ${row.label}`}
              value={mapping[row.key]?.id ?? ""}
              disabled={!isAdmin || !accounts.length}
              onChange={(e) => {
                const account = accounts.find((a) => a.id === e.target.value);
                setMapping((m) => {
                  const next = { ...m };
                  if (account) next[row.key] = { id: account.id, name: account.name };
                  else delete next[row.key];
                  return next;
                });
              }}
              className="rounded border px-2 py-1.5"
              style={selectStyle}
            >
              <option value="">{accounts.length ? "Don't send to Xero" : mapping[row.key]?.name ?? (accountsQuery.isLoading ? "Loading..." : "Not set")}</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.code ? ` (${a.code})` : ""}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
      {isAdmin ? (
        <ThemedButton onClick={() => saveAccounts.mutate()} disabled={!dirty || saveAccounts.isPending} style={{ paddingBlock: 6, paddingInline: 12 }}>
          {saveAccounts.isPending ? "Saving..." : "Save accounts"}
        </ThemedButton>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t pt-3" style={{ borderColor: "var(--jms-border)" }}>
        <span style={muted}>
          {status.last_sweep_at ? `Last synced ${new Date(status.last_sweep_at).toLocaleString("en-AU")}` : "Not synced yet"}
          {pendingLine.length ? ` · ${pendingLine.join(" · ")}` : ""}
        </span>
        <ThemedButton variant="secondary" onClick={() => syncNow.mutate()} disabled={syncNow.isPending} style={{ paddingBlock: 6, paddingInline: 12 }}>
          {syncNow.isPending ? "Syncing..." : "Sync now"}
        </ThemedButton>
      </div>
      {status.last_sweep_error ? <p className="mt-2" style={{ color: "var(--jms-danger)" }}>Last sync problem: {status.last_sweep_error}</p> : null}
      {message ? <p className="mt-2" style={{ color: message.tone === "ok" ? "var(--jms-accent)" : "var(--jms-danger)" }}>{message.text}</p> : null}
    </div>
  );
}

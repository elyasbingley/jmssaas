import { NativeModules, Platform } from "react-native";
import type { Payment, PaymentMethod } from "@jmssaas/shared";
import { supabase } from "./supabase";

// Payments from the phone - see the payments migration and the
// stripe-terminal Edge Function. Both need a connection: a card payment
// has to reach Stripe anyway, and recording cash/transfer goes through the
// record_payment check (amount owing etc.) on the server.

export async function fetchPayments(target: { invoiceId?: string; quoteId?: string }): Promise<Payment[]> {
  const query = supabase.from("payments").select("*").order("paid_at");
  const { data, error } = target.invoiceId ? await query.eq("invoice_id", target.invoiceId) : await query.eq("quote_id", target.quoteId!);
  if (error) throw error;
  return data as Payment[];
}

export async function recordManualPayment(params: {
  invoiceId?: string;
  quoteId?: string;
  amountCents: number;
  method: PaymentMethod;
  reference?: string;
}): Promise<void> {
  const { error } = await supabase.rpc("record_payment", {
    p_invoice_id: params.invoiceId ?? null,
    p_quote_id: params.quoteId ?? null,
    p_amount_cents: params.amountCents,
    p_method: params.method,
    p_reference: params.reference ?? null,
  });
  if (error) throw new Error(error.message);
}

export class TerminalError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

// Calls the stripe-terminal Edge Function as the signed-in user.
export async function callStripeTerminal<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("stripe-terminal", { body });
  if (error) {
    // A non-2xx response: the function's own { error, detail } is in the body.
    let detail: { error?: string; detail?: string } | null = null;
    try {
      const context = (error as { context?: Response }).context;
      detail = context ? await context.json() : null;
    } catch {
      detail = null;
    }
    if (detail?.error === "stripe_not_configured") {
      throw new TerminalError("Card payments aren't set up yet - the Stripe key needs adding to Supabase (see docs/SETUP.md).", detail.error);
    }
    throw new TerminalError(detail?.detail || detail?.error || error.message, detail?.error);
  }
  return data as T;
}

// Tap to Pay needs Android and a build of the app that includes Stripe
// Terminal (an app installed before it was added, even with this code
// arriving as an over-the-air update, doesn't have it).
export function tapToPayAvailability(): { ok: true } | { ok: false; reason: string } {
  if (Platform.OS !== "android") return { ok: false, reason: "Tap to Pay is set up for Android phones." };
  if (!NativeModules.StripeTerminalReactNative) {
    return { ok: false, reason: "This copy of the app was built before Tap to Pay was added - install the latest build to use it." };
  }
  return { ok: true };
}

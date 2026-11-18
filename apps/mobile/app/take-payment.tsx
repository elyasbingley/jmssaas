import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Location from "expo-location";
import { StripeTerminalProvider, useStripeTerminal } from "@stripe/stripe-terminal-react-native";
import {
  MANUAL_PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  formatCentsAsAud,
  invoiceBalanceCents,
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
import { useSupabaseFetch } from "../lib/use-supabase-fetch";
import { callStripeTerminal, fetchPayments, recordManualPayment, tapToPayAvailability, TerminalError } from "../lib/payments";
import { getErrorMessage } from "../lib/errors";
import { useThemedStyles, type StyleTheme } from "../lib/use-themed-styles";
import { ThemedButton } from "../components/theme/ThemedButton";
import { ThemedFormField } from "../components/theme/ThemedFormField";

// "Take payment" for an invoice (any amount up to the balance - part
// payments) or a quote (deposit). Opened with ?invoice_id= or ?quote_id=.
//
// Tap to Pay: the client taps their card or phone on the back of this
// phone. Stripe Terminal does the card reading; the stripe-terminal Edge
// Function makes the charge at exactly the amount entered (no surcharge)
// and records it once Stripe confirms. With test Stripe keys the reader is
// simulated - tapping the on-screen card completes a test payment.
//
// Cash / bank transfer / card on another machine are recorded straight
// against the invoice or quote.

type Doc =
  | { kind: "invoice"; invoice: Pick<Invoice, "id" | "invoice_number" | "status" | "total_cents" | "amount_paid_cents"> & { clients: { name: string } | null } }
  | {
      kind: "quote";
      quote: Pick<Quote, "id" | "quote_number" | "status" | "total_cents" | "deposit_percent" | "deposit_fixed_cents" | "deposit_paid_cents"> & {
        clients: { name: string } | null;
      };
    };

async function fetchDoc(invoiceId?: string, quoteId?: string): Promise<{ doc: Doc; payments: Payment[] }> {
  if (invoiceId) {
    const { data, error } = await supabase
      .from("invoices")
      .select("id, invoice_number, status, total_cents, amount_paid_cents, clients(name)")
      .eq("id", invoiceId)
      .single();
    if (error) throw error;
    return { doc: { kind: "invoice", invoice: data as never }, payments: await fetchPayments({ invoiceId }) };
  }
  const { data, error } = await supabase
    .from("quotes")
    .select("id, quote_number, status, total_cents, deposit_percent, deposit_fixed_cents, deposit_paid_cents, clients(name)")
    .eq("id", quoteId!)
    .single();
  if (error) throw error;
  return { doc: { kind: "quote", quote: data as never }, payments: await fetchPayments({ quoteId }) };
}

// The Stripe Terminal SDK asks for a fresh connection token whenever it
// needs one.
async function fetchConnectionToken(): Promise<string> {
  const { secret } = await callStripeTerminal<{ secret: string }>({ action: "connection_token" });
  return secret;
}

export default function TakePaymentScreen() {
  const availability = tapToPayAvailability();
  if (!availability.ok) return <TakePayment tapToPayUnavailableReason={availability.reason} />;
  return (
    <StripeTerminalProvider tokenProvider={fetchConnectionToken} logLevel="error" localeConfig={{ type: "cardLanguagePreferenceIfAvailable" }}>
      <TakePayment tapToPayUnavailableReason={null} />
    </StripeTerminalProvider>
  );
}

function TakePayment({ tapToPayUnavailableReason }: { tapToPayUnavailableReason: string | null }) {
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const { invoice_id: invoiceId, quote_id: quoteId } = useLocalSearchParams<{ invoice_id?: string; quote_id?: string }>();
  const { data, loading, error, refetch } = useSupabaseFetch(() => fetchDoc(invoiceId, quoteId), [invoiceId, quoteId]);

  const [amountText, setAmountText] = useState<string | null>(null);
  const [mode, setMode] = useState<"card" | "other">(tapToPayUnavailableReason ? "other" : "card");
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [reference, setReference] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  if (loading && !data) {
    return (
      <SafeAreaView style={styles.container}>
        <ActivityIndicator style={{ marginTop: 40 }} />
      </SafeAreaView>
    );
  }
  if (!data) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.error}>{error ?? "Not found"}</Text>
      </SafeAreaView>
    );
  }

  const { doc, payments } = data;
  const isInvoice = doc.kind === "invoice";
  const number = isInvoice ? doc.invoice.invoice_number : doc.quote.quote_number;
  const clientName = (isInvoice ? doc.invoice.clients?.name : doc.quote.clients?.name) ?? "";
  const balanceCents = isInvoice ? invoiceBalanceCents(doc.invoice) : quoteBalanceCents(doc.quote);
  const depositDueCents = isInvoice ? 0 : quoteDepositDueCents(doc.quote);
  const depositRemainingCents = isInvoice ? 0 : quoteDepositRemainingCents(doc.quote);
  const suggestedCents = isInvoice ? balanceCents : depositRemainingCents || balanceCents;
  const amountInput = amountText ?? (suggestedCents > 0 ? (suggestedCents / 100).toFixed(2) : "");
  const amountCents = parseDollarsToCents(amountInput);
  const closedReason = isInvoice
    ? doc.invoice.status === "void"
      ? "This invoice is void."
      : balanceCents <= 0
        ? "This invoice is paid in full."
        : null
    : doc.quote.status === "draft"
      ? "Send the quote to the client before taking a deposit on it."
      : doc.quote.status === "declined" || doc.quote.status === "expired"
        ? `This quote is ${doc.quote.status}.`
        : balanceCents <= 0
          ? "This quote is paid in full."
          : null;

  const amountProblem =
    amountCents === null ? "Enter the amount, e.g. 250 or 250.50" : amountCents > balanceCents ? `That's more than the ${formatCentsAsAud(balanceCents)} owing` : null;

  const paid = async (text: string) => {
    setMessage({ tone: "ok", text });
    setAmountText(null);
    setReference("");
    await refetch();
  };

  const recordOther = async () => {
    if (amountProblem || amountCents === null) return setMessage({ tone: "error", text: amountProblem ?? "Enter an amount" });
    setSaving(true);
    setMessage(null);
    try {
      await recordManualPayment({ invoiceId, quoteId, amountCents, method, reference });
      await paid(`${formatCentsAsAud(amountCents)} ${PAYMENT_METHOD_LABELS[method].toLowerCase()} recorded.`);
    } catch (e) {
      setMessage({ tone: "error", text: getErrorMessage(e, "Couldn't record the payment") });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text style={styles.link}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>{isInvoice ? "Take payment" : "Take deposit"}</Text>
        <Text style={styles.subtitle}>
          {isInvoice ? "Invoice" : "Quote"} {number}
          {clientName ? ` · ${clientName}` : ""}
        </Text>
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <View style={styles.summary}>
          <SummaryRow label={isInvoice ? "Invoice total" : "Quote total"} value={formatCentsAsAud(isInvoice ? doc.invoice.total_cents : doc.quote.total_cents)} styles={styles} />
          {!isInvoice ? <SummaryRow label="Deposit asked" value={depositDueCents > 0 ? formatCentsAsAud(depositDueCents) : "None set"} styles={styles} /> : null}
          <SummaryRow label="Paid so far" value={formatCentsAsAud(isInvoice ? doc.invoice.amount_paid_cents : doc.quote.deposit_paid_cents)} styles={styles} />
          <SummaryRow label={isInvoice ? "Balance owing" : depositDueCents > 0 ? "Deposit still to come" : "Still owing"} value={formatCentsAsAud(isInvoice ? balanceCents : depositRemainingCents || balanceCents)} strong styles={styles} />
        </View>

        {message ? <Text style={message.tone === "ok" ? styles.ok : styles.error}>{message.text}</Text> : null}

        {closedReason ? (
          <Text style={styles.notice}>{closedReason}</Text>
        ) : (
          <>
            <ThemedFormField label="Amount ($)" value={amountInput} onChangeText={setAmountText} keyboardType="decimal-pad" />
            {amountProblem ? <Text style={styles.hint}>{amountProblem}</Text> : <Text style={styles.hint}>Less than the full amount is fine - it's recorded as a part payment.</Text>}

            <View style={styles.modeRow}>
              <Chip label="Tap to Pay" active={mode === "card"} onPress={() => setMode("card")} styles={styles} />
              <Chip label="Cash / transfer / other" active={mode === "other"} onPress={() => setMode("other")} styles={styles} />
            </View>

            {mode === "card" ? (
              tapToPayUnavailableReason ? (
                <Text style={styles.notice}>{tapToPayUnavailableReason}</Text>
              ) : (
                <TapToPayButton
                  amountCents={amountProblem ? null : amountCents}
                  invoiceId={invoiceId}
                  quoteId={quoteId}
                  onPaid={(cents) => paid(`${formatCentsAsAud(cents)} card payment received.`)}
                  onError={(text) => setMessage({ tone: "error", text })}
                  styles={styles}
                />
              )
            ) : (
              <View style={{ gap: 12 }}>
                <View style={styles.modeRow}>
                  {MANUAL_PAYMENT_METHODS.map((m) => (
                    <Chip key={m} label={PAYMENT_METHOD_LABELS[m]} active={method === m} onPress={() => setMethod(m)} styles={styles} />
                  ))}
                </View>
                <ThemedFormField label="Reference (optional)" value={reference} onChangeText={setReference} placeholder="e.g. receipt number" />
                <ThemedButton label={saving ? "Saving..." : `Record ${amountCents && !amountProblem ? formatCentsAsAud(amountCents) : "payment"}`} onPress={recordOther} disabled={saving || !!amountProblem} />
              </View>
            )}
          </>
        )}

        <Text style={styles.sectionTitle}>Payments</Text>
        {payments.length === 0 ? <Text style={styles.hint}>None yet.</Text> : null}
        {payments.map((p) => (
          <View key={p.id} style={styles.paymentRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.paymentMethod}>
                {PAYMENT_METHOD_LABELS[p.method]}
                {p.kind === "deposit" ? " · deposit" : ""}
              </Text>
              <Text style={styles.hint}>
                {new Date(p.paid_at).toLocaleDateString("en-AU")}
                {p.reference ? ` · ${p.reference}` : ""}
              </Text>
            </View>
            <Text style={styles.paymentAmount}>{formatCentsAsAud(p.amount_cents)}</Text>
          </View>
        ))}
        <Text style={styles.footnote}>No card surcharge is added. Card payments go to the business's Stripe account; Stripe emails the client a receipt when they have an email address.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

type Styles = ReturnType<typeof createStyles>;

function SummaryRow({ label, value, strong, styles }: { label: string; value: string; strong?: boolean; styles: Styles }) {
  return (
    <View style={styles.summaryRow}>
      <Text style={styles.summaryLabel}>{label}</Text>
      <Text style={strong ? styles.summaryStrong : styles.summaryValue}>{value}</Text>
    </View>
  );
}

function Chip({ label, active, onPress, styles }: { label: string; active: boolean; onPress: () => void; styles: Styles }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, active && styles.chipActive]}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

type Stage = "idle" | "starting" | "connecting" | "charging" | "tapping" | "confirming";
const STAGE_LABELS: Record<Stage, string> = {
  idle: "",
  starting: "Getting ready...",
  connecting: "Setting up Tap to Pay on this phone...",
  charging: "Preparing the charge...",
  tapping: "Ask the client to tap their card or phone",
  confirming: "Confirming with Stripe...",
};

// Must render inside StripeTerminalProvider (useStripeTerminal).
function TapToPayButton({
  amountCents,
  invoiceId,
  quoteId,
  onPaid,
  onError,
  styles,
}: {
  amountCents: number | null;
  invoiceId?: string;
  quoteId?: string;
  onPaid: (cents: number) => void;
  onError: (text: string) => void;
  styles: Styles;
}) {
  const { initialize, getIsInitialized, easyConnect, getConnectedReader, retrievePaymentIntent, processPaymentIntent } = useStripeTerminal();
  const [stage, setStage] = useState<Stage>("idle");

  const take = async () => {
    if (!amountCents) return;
    try {
      setStage("starting");
      // Tap to Pay won't run without location access (a Stripe/card
      // network rule for in-person payments).
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== "granted") {
        throw new TerminalError("Tap to Pay needs location access - allow it for this app in Android Settings, then try again.");
      }
      if (!getIsInitialized()) {
        const init = await initialize();
        if (init.error) throw new TerminalError(init.error.message, init.error.code);
      }

      const connected = await getConnectedReader();
      if (!connected) {
        setStage("connecting");
        const location = await callStripeTerminal<{ location_id: string; livemode: boolean; merchant_display_name: string }>({ action: "location" });
        const connect = await easyConnect({
          discoveryMethod: "tapToPay",
          locationId: location.location_id,
          // Test Stripe keys -> a simulated reader (tap the screen to pay).
          simulated: !location.livemode,
          merchantDisplayName: location.merchant_display_name,
          autoReconnectOnUnexpectedDisconnect: true,
        });
        if (connect.error) throw new TerminalError(connect.error.message, connect.error.code);
      }

      setStage("charging");
      const intent = await callStripeTerminal<{ payment_intent_id: string; client_secret: string; amount_cents: number }>({
        action: "create_intent",
        invoice_id: invoiceId ?? null,
        quote_id: invoiceId ? null : quoteId ?? null,
        amount_cents: amountCents,
      });
      const retrieved = await retrievePaymentIntent(intent.client_secret);
      if (retrieved.error) throw new TerminalError(retrieved.error.message, retrieved.error.code);

      setStage("tapping");
      const processed = await processPaymentIntent({ paymentIntent: retrieved.paymentIntent });
      if (processed.error) throw new TerminalError(processed.error.message, processed.error.code);

      setStage("confirming");
      const confirmed = await callStripeTerminal<{ ok: boolean; status: string; amount_cents?: number }>({
        action: "confirm",
        payment_intent_id: intent.payment_intent_id,
      });
      if (!confirmed.ok) {
        throw new TerminalError(
          confirmed.status === "processing"
            ? "Stripe is still processing the card - it'll show against the invoice once it's through."
            : `The payment didn't go through (${confirmed.status}). Nothing was charged.`
        );
      }
      onPaid(confirmed.amount_cents ?? amountCents);
    } catch (e) {
      const code = e instanceof TerminalError ? e.code : undefined;
      if (code === "CANCELED" || code === "CANCELED_BY_READER") {
        onError("Cancelled - nothing was charged.");
      } else {
        onError(getErrorMessage(e, "Tap to Pay didn't work - try again"));
      }
    } finally {
      setStage("idle");
    }
  };

  const busy = stage !== "idle";
  return (
    <View style={{ gap: 8 }}>
      <ThemedButton
        label={busy ? STAGE_LABELS[stage] : amountCents ? `Tap to Pay ${formatCentsAsAud(amountCents)}` : "Tap to Pay"}
        onPress={() => {
          if (!amountCents) return;
          Alert.alert("Tap to Pay", `Charge ${formatCentsAsAud(amountCents)} to the client's card?`, [
            { text: "Cancel", style: "cancel" },
            { text: "Charge", onPress: take },
          ]);
        }}
        disabled={busy || !amountCents}
      />
      {busy ? <ActivityIndicator /> : null}
      <Text style={styles.hint}>The client taps their card, phone or watch on the back of this phone, near the camera.</Text>
    </View>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    container: { flex: 1, backgroundColor: tokens.background },
    header: { paddingHorizontal: 16, paddingTop: 12, gap: 4 },
    link: { color: tokens.accent, fontWeight: "600" as const, ...mono },
    title: { fontSize: font.title + 4, fontWeight: "700" as const, color: tokens.textPrimary, letterSpacing: 1, ...mono },
    subtitle: { color: tokens.textMuted, fontSize: font.body - 1, ...mono },
    body: { padding: 16, gap: 12, paddingBottom: 40 },
    summary: { borderWidth: 1, borderColor: tokens.border, borderRadius: 4, backgroundColor: tokens.surface, padding: 12, gap: 6 },
    summaryRow: { flexDirection: "row" as const, justifyContent: "space-between" as const },
    summaryLabel: { color: tokens.textMuted, fontSize: font.body - 1, ...mono },
    summaryValue: { color: tokens.textPrimary, fontSize: font.body - 1, ...mono },
    summaryStrong: { color: tokens.accent, fontSize: font.body + 2, fontWeight: "800" as const, ...mono },
    modeRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
    chip: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 3, borderWidth: 1, borderColor: tokens.border },
    chipActive: { borderColor: tokens.accent, backgroundColor: tokens.accentGlow },
    chipText: { color: tokens.textMuted, fontWeight: "600" as const, fontSize: font.label, ...mono },
    chipTextActive: { color: tokens.accent },
    hint: { color: tokens.textMuted, fontSize: font.label, ...mono },
    notice: { color: tokens.textPrimary, fontSize: font.body - 1, borderWidth: 1, borderColor: tokens.accent, borderRadius: 4, padding: 12, ...mono },
    ok: { color: tokens.accent, fontSize: font.body, fontWeight: "700" as const, ...mono },
    error: { color: tokens.danger, fontSize: font.body - 1, padding: 4, ...mono },
    sectionTitle: { color: tokens.accent, fontSize: font.label, fontWeight: "700" as const, letterSpacing: 1, textTransform: "uppercase" as const, marginTop: 12, ...mono },
    paymentRow: { flexDirection: "row" as const, alignItems: "center" as const, borderTopWidth: 1, borderTopColor: tokens.border, paddingTop: 8, gap: 8 },
    paymentMethod: { color: tokens.textPrimary, fontSize: font.body - 1, ...mono },
    paymentAmount: { color: tokens.textPrimary, fontSize: font.body, fontWeight: "700" as const, ...mono },
    footnote: { color: tokens.textMuted, fontSize: font.label - 1, marginTop: 16, ...mono },
  };
}

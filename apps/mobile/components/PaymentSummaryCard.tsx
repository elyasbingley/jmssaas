import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { formatCentsAsAud, quoteDepositDueCents } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useThemedStyles, type StyleTheme } from "../lib/use-themed-styles";
import { ThemedButton } from "./theme/ThemedButton";

// Paid / balance (invoice) or deposit asked / paid (quote), with the button
// into the Take payment screen. Re-reads its own few numbers whenever the
// screen comes back into focus (e.g. after taking a payment) without
// refetching - and so resetting - the rest of the detail screen it sits on.

type Totals = { total: number; paid: number; depositDue: number; status: string };

export function PaymentSummaryCard({ kind, id }: { kind: "invoice" | "quote"; id: string }) {
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const [totals, setTotals] = useState<Totals | null>(null);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        if (kind === "invoice") {
          const { data } = await supabase.from("invoices").select("total_cents, amount_paid_cents, status").eq("id", id).single();
          if (!cancelled && data) setTotals({ total: data.total_cents, paid: data.amount_paid_cents, depositDue: 0, status: data.status });
        } else {
          const { data } = await supabase
            .from("quotes")
            .select("total_cents, deposit_paid_cents, deposit_percent, deposit_fixed_cents, status")
            .eq("id", id)
            .single();
          if (!cancelled && data) {
            setTotals({ total: data.total_cents, paid: data.deposit_paid_cents, depositDue: quoteDepositDueCents(data), status: data.status });
          }
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [kind, id])
  );

  if (!totals) return null;
  const balance = Math.max(totals.total - totals.paid, 0);
  const closed = kind === "invoice" ? totals.status === "void" : ["draft", "declined", "expired"].includes(totals.status);

  return (
    <View style={styles.card}>
      <Text style={styles.title}>{kind === "invoice" ? "Payments" : "Deposit"}</Text>
      {kind === "invoice" ? (
        <Text style={styles.line}>
          Paid {formatCentsAsAud(totals.paid)} of {formatCentsAsAud(totals.total)} · <Text style={styles.strong}>{formatCentsAsAud(balance)} owing</Text>
        </Text>
      ) : (
        <Text style={styles.line}>
          {totals.depositDue > 0 ? `Deposit ${formatCentsAsAud(totals.depositDue)}` : "No deposit set"} · paid {formatCentsAsAud(totals.paid)}
        </Text>
      )}
      {kind === "quote" && totals.status === "draft" ? <Text style={styles.hint}>Send the quote before taking a deposit.</Text> : null}
      {!closed && balance > 0 ? (
        <ThemedButton
          label={kind === "invoice" ? "Take payment" : "Take deposit"}
          onPress={() => router.push({ pathname: "/take-payment", params: kind === "invoice" ? { invoice_id: id } : { quote_id: id } })}
        />
      ) : null}
    </View>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return {
    card: { borderWidth: 1, borderColor: tokens.accent, borderRadius: 4, backgroundColor: tokens.surface, padding: 12, gap: 8, marginTop: 12 },
    title: { color: tokens.accent, fontSize: font.label, fontWeight: "700" as const, letterSpacing: 1, textTransform: "uppercase" as const, ...mono },
    line: { color: tokens.textPrimary, fontSize: font.body - 1, ...mono },
    strong: { color: tokens.accent, fontWeight: "800" as const },
    hint: { color: tokens.textMuted, fontSize: font.label, ...mono },
  };
}

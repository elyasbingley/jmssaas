import { useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import {
  collectRecipientEmails,
  createJobMaterialOrderSchema,
  type Client,
  type ClientContact,
  type EmailAttachment,
  type JobCard,
  type JobMaterialOrder,
  type MaterialOrderLineItem,
  type MaterialOrderStatus,
  type MaterialTallyItem,
  type Tenant,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { triggerImmediateDispatch } from "../lib/dispatch-now";
import { exportPdf } from "../lib/print";
import { buildMaterialOrderPdfHtml } from "../lib/material-order-pdf";
import { FormField } from "./FormField";
import { DateField } from "./DateField";
import { EmailComposeModal } from "./EmailComposeModal";

const STATUS_OPTIONS: MaterialOrderStatus[] = ["DRAFT", "ORDERED", "DELIVERED", "CANCELLED"];
const STATUS_LABELS: Record<MaterialOrderStatus, string> = {
  DRAFT: "Draft",
  ORDERED: "Ordered",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
};

async function fetchOrders(jobCardId: string): Promise<JobMaterialOrder[]> {
  const { data, error } = await supabase.from("job_material_orders").select("*").eq("job_card_id", jobCardId).order("created_at", { ascending: false });
  if (error) throw error;
  return data as JobMaterialOrder[];
}
async function fetchJob(jobCardId: string): Promise<JobCard> {
  const { data, error } = await supabase.from("job_cards").select("*").eq("id", jobCardId).single();
  if (error) throw error;
  return data as JobCard;
}
async function fetchTenant(tenantId: string): Promise<Tenant> {
  const { data, error } = await supabase.from("tenants").select("*").eq("id", tenantId).single();
  if (error) throw error;
  return data as Tenant;
}
async function fetchClient(clientId: string): Promise<Client> {
  const { data, error } = await supabase.from("clients").select("*").eq("id", clientId).single();
  if (error) throw error;
  return data as Client;
}
async function fetchClientContacts(clientId: string): Promise<ClientContact[]> {
  const { data, error } = await supabase.from("client_contacts").select("*").eq("client_id", clientId);
  if (error) throw error;
  return data as ClientContact[];
}

// Job Material Order Form (mobile) - same requisition-form idea as
// desktop's MaterialOrderForm.tsx: items added manually or imported from
// the Material Tally tool via the `prefillItems` handoff, order_number is
// server-assigned (assign_material_order_number trigger), PDF export via
// expo-print's share sheet and email send via the same inline
// scheduled_communications + triggerImmediateDispatch pattern the job
// card's own free-form email button uses (see jobs/[id].tsx).
export function MaterialOrderFormTool({
  jobCardId,
  prefillItems,
  onConsumedPrefill,
}: {
  jobCardId: string;
  prefillItems: MaterialTallyItem[] | null;
  onConsumedPrefill: () => void;
}) {
  const { profile } = useAuth();
  const [orders, setOrders] = useState<JobMaterialOrder[]>([]);
  const [job, setJob] = useState<JobCard | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [recipientOptions, setRecipientOptions] = useState<string[]>([]);

  const reload = async () => {
    const updated = await fetchOrders(jobCardId);
    setOrders(updated);
  };

  useMemo(() => {
    reload().catch((e) => console.error("[MaterialOrderForm] Failed to load orders", e));
    fetchJob(jobCardId)
      .then(async (j) => {
        setJob(j);
        const client = await fetchClient(j.client_id);
        const contacts = await fetchClientContacts(j.client_id);
        setRecipientOptions(collectRecipientEmails({ clientEmail: client.email, contactEmails: contacts.map((c) => c.email) }));
      })
      .catch((e) => console.error("[MaterialOrderForm] Failed to load job", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobCardId]);

  useMemo(() => {
    if (!profile) return;
    fetchTenant(profile.tenant_id)
      .then(setTenant)
      .catch((e) => console.error("[MaterialOrderForm] Failed to load tenant", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.tenant_id]);

  const [supplierName, setSupplierName] = useState("");
  const [deliveryDate, setDeliveryDate] = useState<Date | null>(null);
  const [status, setStatus] = useState<MaterialOrderStatus>("DRAFT");
  const [lineItems, setLineItems] = useState<MaterialOrderLineItem[]>([]);
  const [newItemName, setNewItemName] = useState("");
  const [newItemQty, setNewItemQty] = useState("1");
  const [newItemUnit, setNewItemUnit] = useState("ea");

  useMemo(() => {
    if (!prefillItems) return;
    setLineItems((prev) => [
      ...prev,
      ...prefillItems.map((i) => ({ item_name: i.name, quantity: i.count, unit_type: "ea", notes: i.category })),
    ]);
    onConsumedPrefill();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillItems]);

  const handleAddItem = () => {
    if (!newItemName.trim()) return;
    setLineItems((prev) => [...prev, { item_name: newItemName.trim(), quantity: Number(newItemQty) || 1, unit_type: newItemUnit || "ea", notes: "" }]);
    setNewItemName("");
    setNewItemQty("1");
  };
  const handleRemoveItem = (index: number) => setLineItems((prev) => prev.filter((_, i) => i !== index));

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!profile) return;
    const result = createJobMaterialOrderSchema.safeParse({
      job_card_id: jobCardId,
      supplier_name: supplierName || undefined,
      delivery_date: deliveryDate ? deliveryDate.toISOString().slice(0, 10) : undefined,
      line_items: lineItems,
      status,
    });
    if (!result.success) {
      setSaveError(result.error.issues[0]?.message ?? "Add at least one line item first");
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      const { error } = await supabase.from("job_material_orders").insert({
        tenant_id: profile.tenant_id,
        job_card_id: jobCardId,
        supplier_name: result.data.supplier_name || null,
        delivery_date: result.data.delivery_date || null,
        line_items: result.data.line_items,
        status: result.data.status,
        created_by: profile.id,
      });
      if (error) throw error;

      await reload();
      setSupplierName("");
      setDeliveryDate(null);
      setStatus("DRAFT");
      setLineItems([]);
    } catch (e) {
      setSaveError(getErrorMessage(e, "Failed to save order"));
    } finally {
      setSaving(false);
    }
  };

  const handleExportPdf = async (order: JobMaterialOrder) => {
    if (!tenant || !job) return;
    const html = buildMaterialOrderPdfHtml({
      tenant,
      job,
      orderNumber: order.order_number,
      supplierName: order.supplier_name,
      deliveryDate: order.delivery_date,
      lineItems: order.line_items,
    });
    try {
      await exportPdf(html, `Material Order ${order.order_number}`);
    } catch (e) {
      Alert.alert("Export failed", getErrorMessage(e, "Failed to export the material order PDF"));
    }
  };

  const [emailOrder, setEmailOrder] = useState<JobMaterialOrder | null>(null);
  const handleSendOrderEmail = async (payload: { to: string; cc: string; bcc: string; subject: string; body: string; attachments: EmailAttachment[] }) => {
    if (!profile || !job) throw new Error("Not signed in");
    const { data: row, error: insertError } = await supabase
      .from("scheduled_communications")
      .insert({
        tenant_id: profile.tenant_id,
        entity_type: "job",
        entity_id: job.id,
        trigger_key: "material_order_email",
        template_id: null,
        channel: "email",
        recipient_phone_or_email: payload.to,
        cc_emails: payload.cc ? payload.cc.split(",").map((s) => s.trim()).filter(Boolean) : [],
        bcc_emails: payload.bcc ? payload.bcc.split(",").map((s) => s.trim()).filter(Boolean) : [],
        rendered_subject: payload.subject,
        rendered_body: payload.body,
        attachments: payload.attachments,
        scheduled_for: new Date().toISOString(),
        status: "pending",
      })
      .select("id")
      .single();
    if (insertError) throw insertError;
    const wasSent = await triggerImmediateDispatch(row.id);
    Alert.alert(wasSent ? "Sent" : "Queued", wasSent ? "The order email has been sent." : "The order email is queued and will go out shortly.");
  };

  return (
    <View>
      <FormField label="Supplier (optional)" placeholder='e.g. "Bunnings"' value={supplierName} onChangeText={setSupplierName} />
      <View style={{ marginTop: 8 }}>
        <DateField label="Delivery date (optional)" value={deliveryDate} onChange={setDeliveryDate} />
      </View>

      <Text style={styles.sectionLabel}>Status</Text>
      <View style={styles.statusRow}>
        {STATUS_OPTIONS.map((s) => (
          <Pressable key={s} style={[styles.statusChip, status === s && styles.statusChipActive]} onPress={() => setStatus(s)}>
            <Text style={[styles.statusChipText, status === s && styles.statusChipTextActive]}>{STATUS_LABELS[s]}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.sectionLabel}>Add item</Text>
      <View style={styles.addRow}>
        <TextInput style={[styles.addInput, { flex: 2 }]} placeholder="Item name" value={newItemName} onChangeText={setNewItemName} />
        <TextInput style={[styles.addInput, { flex: 1 }]} placeholder="Qty" keyboardType="numeric" value={newItemQty} onChangeText={setNewItemQty} />
        <TextInput style={[styles.addInput, { flex: 1 }]} placeholder="Unit" value={newItemUnit} onChangeText={setNewItemUnit} />
      </View>
      <Pressable style={[styles.addButton, !newItemName.trim() && styles.addButtonDisabled]} onPress={handleAddItem} disabled={!newItemName.trim()}>
        <Text style={styles.addButtonText}>+ Add</Text>
      </Pressable>

      {lineItems.length === 0 ? (
        <Text style={styles.subtitle}>No items yet - add one above, or transfer a tally from the Material Tally tool.</Text>
      ) : (
        <View style={{ marginTop: 10, gap: 6 }}>
          {lineItems.map((item, index) => (
            <View key={index} style={styles.itemRow}>
              <Text style={styles.itemName} numberOfLines={1}>{item.item_name}</Text>
              <Text style={styles.itemQty}>{item.quantity} {item.unit_type}</Text>
              <Pressable onPress={() => handleRemoveItem(index)}>
                <Text style={styles.deleteLink}>Remove</Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}

      {saveError ? <Text style={styles.error}>{saveError}</Text> : null}
      <Pressable style={[styles.saveButton, (saving || lineItems.length === 0) && styles.saveButtonDisabled]} onPress={handleSave} disabled={saving || lineItems.length === 0}>
        <Text style={styles.saveButtonText}>{saving ? "Saving..." : "Save Material Order"}</Text>
      </Pressable>

      {orders.length > 0 ? (
        <View style={styles.pastList}>
          <Text style={styles.pastHeading}>Past orders</Text>
          {orders.map((order) => (
            <View key={order.id} style={styles.orderCard}>
              <View style={styles.orderCardTop}>
                <Text style={styles.orderNumber}>{order.order_number}</Text>
                <Text style={styles.orderStatus}>{order.status}</Text>
              </View>
              <Text style={styles.orderMeta}>
                {order.supplier_name ?? "No supplier"} · {order.line_items.length} item{order.line_items.length === 1 ? "" : "s"}
              </Text>
              <View style={styles.orderActions}>
                <Pressable onPress={() => handleExportPdf(order)}>
                  <Text style={styles.link}>Export Material Order PDF</Text>
                </Pressable>
                <Pressable onPress={() => setEmailOrder(order)}>
                  <Text style={styles.link}>Email Order to Supplier</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </View>
      ) : null}

      <EmailComposeModal
        visible={!!emailOrder}
        onClose={() => setEmailOrder(null)}
        title="Email material order"
        defaultTo=""
        defaultSubject={emailOrder ? `Material Order ${emailOrder.order_number}${job ? ` - ${job.title}` : ""}` : ""}
        defaultBody={
          emailOrder
            ? [
                `Please find our material order ${emailOrder.order_number} below.`,
                "",
                ...emailOrder.line_items.map((i) => `- ${i.item_name}: ${i.quantity} ${i.unit_type}${i.notes ? ` (${i.notes})` : ""}`),
                emailOrder.delivery_date ? `\nRequested delivery date: ${emailOrder.delivery_date}` : "",
              ].join("\n")
            : ""
        }
        recipientOptions={recipientOptions}
        onSend={handleSendOrderEmail}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  sectionLabel: { fontSize: 13, fontWeight: "600", color: "#374151", marginTop: 14, marginBottom: 6 },
  statusRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  statusChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, backgroundColor: "#f3f4f6" },
  statusChipActive: { backgroundColor: "#1d4ed8" },
  statusChipText: { color: "#374151", fontWeight: "600", fontSize: 13 },
  statusChipTextActive: { color: "#fff" },
  addRow: { flexDirection: "row", gap: 8 },
  addInput: { borderWidth: 1, borderColor: "#d1d5db", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 10, fontSize: 14 },
  addButton: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingVertical: 10, alignItems: "center", marginTop: 8 },
  addButtonDisabled: { opacity: 0.6 },
  addButtonText: { color: "#fff", fontWeight: "700" },
  subtitle: { color: "#6b7280", fontSize: 13, marginTop: 10 },
  itemRow: { flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 },
  itemName: { flex: 2, fontSize: 14, fontWeight: "600", color: "#111827" },
  itemQty: { flex: 1, fontSize: 13, color: "#374151" },
  deleteLink: { color: "#dc2626", fontWeight: "600", fontSize: 12 },
  error: { color: "#dc2626", marginTop: 10 },
  saveButton: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingVertical: 14, alignItems: "center", marginTop: 16 },
  saveButtonDisabled: { opacity: 0.6 },
  saveButtonText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  pastList: { marginTop: 20, gap: 8 },
  pastHeading: { fontSize: 11, fontWeight: "700", textTransform: "uppercase", color: "#6b7280", marginBottom: 4 },
  orderCard: { backgroundColor: "#f9fafb", borderRadius: 10, padding: 10, gap: 4 },
  orderCardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  orderNumber: { fontSize: 14, fontWeight: "700", color: "#111827" },
  orderStatus: { fontSize: 12, fontWeight: "600", color: "#6b7280" },
  orderMeta: { fontSize: 12, color: "#6b7280" },
  orderActions: { flexDirection: "row", gap: 16, marginTop: 4 },
  link: { color: "#1d4ed8", fontWeight: "600", fontSize: 12 },
});

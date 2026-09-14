import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createJobMaterialOrderSchema,
  type EmailAttachment,
  type JobCard,
  type JobMaterialOrder,
  type MaterialOrderLineItem,
  type MaterialOrderStatus,
  type MaterialTallyItem,
  type Tenant,
} from "@jmssaas/shared";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth-context";
import { getErrorMessage } from "../../lib/errors";
import { exportPdf } from "../../lib/print";
import { buildMaterialOrderPdfHtml } from "../../lib/material-order-pdf";
import { queueAndSendEmail } from "../../lib/send-email";
import { FormField, SelectField } from "../FormField";
import { EmailComposeModal } from "../EmailComposeModal";

const STATUS_OPTIONS: MaterialOrderStatus[] = ["DRAFT", "ORDERED", "DELIVERED", "CANCELLED"];

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

// Job Material Order Form - a requisition form scoped to one job. Items
// are either added manually or imported in one click from the Material
// Tally tool (see the `prefillItems` prop, populated by MaterialTally's
// "Transfer to Material Order Form" button via QuoteToolsSection's shared
// state - a pure in-memory handoff between two sibling tools, no DB
// round-trip needed). order_number is server-assigned (see the
// migration's assign_material_order_number trigger) - never set here.
export function MaterialOrderForm({
  jobCardId,
  prefillItems,
  onConsumedPrefill,
}: {
  jobCardId: string;
  prefillItems: MaterialTallyItem[] | null;
  onConsumedPrefill: () => void;
}) {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const { data: orders } = useQuery({ queryKey: ["job-material-orders", jobCardId], queryFn: () => fetchOrders(jobCardId) });
  const { data: job } = useQuery({ queryKey: ["job", jobCardId], queryFn: () => fetchJob(jobCardId) });
  const { data: tenant } = useQuery({ queryKey: ["tenant", profile?.tenant_id], queryFn: () => fetchTenant(profile!.tenant_id), enabled: !!profile });

  const [supplierName, setSupplierName] = useState("");
  const [deliveryDate, setDeliveryDate] = useState("");
  const [status, setStatus] = useState<MaterialOrderStatus>("DRAFT");
  const [lineItems, setLineItems] = useState<MaterialOrderLineItem[]>([]);
  const [newItemName, setNewItemName] = useState("");
  const [newItemQty, setNewItemQty] = useState("1");
  const [newItemUnit, setNewItemUnit] = useState("ea");

  useEffect(() => {
    if (!prefillItems) return;
    setLineItems((prev) => [
      ...prev,
      ...prefillItems.map((i) => ({ item_name: i.name, quantity: i.count, unit_type: "ea", notes: i.category })),
    ]);
    onConsumedPrefill();
  }, [prefillItems, onConsumedPrefill]);

  const handleAddItem = () => {
    if (!newItemName.trim()) return;
    setLineItems((prev) => [...prev, { item_name: newItemName.trim(), quantity: Number(newItemQty) || 1, unit_type: newItemUnit || "ea", notes: "" }]);
    setNewItemName("");
    setNewItemQty("1");
  };
  const handleRemoveItem = (index: number) => setLineItems((prev) => prev.filter((_, i) => i !== index));

  const [saveError, setSaveError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      if (!profile) throw new Error("Not signed in");
      const result = createJobMaterialOrderSchema.safeParse({
        job_card_id: jobCardId,
        supplier_name: supplierName || undefined,
        delivery_date: deliveryDate || undefined,
        line_items: lineItems,
        status,
      });
      if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Add at least one line item first");

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
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job-material-orders", jobCardId] });
      setSupplierName("");
      setDeliveryDate("");
      setStatus("DRAFT");
      setLineItems([]);
      setSaveError(null);
    },
    onError: (e) => setSaveError(getErrorMessage(e, "Failed to save order")),
  });

  const handleExportPdf = (order: JobMaterialOrder) => {
    if (!tenant || !job) return;
    const html = buildMaterialOrderPdfHtml({
      tenant,
      job,
      orderNumber: order.order_number,
      supplierName: order.supplier_name,
      deliveryDate: order.delivery_date,
      lineItems: order.line_items,
    });
    exportPdf(html, `Material Order ${order.order_number}`);
  };

  const [emailOrder, setEmailOrder] = useState<JobMaterialOrder | null>(null);
  const handleSendOrderEmail = async (payload: { to: string; cc: string; bcc: string; subject: string; body: string; attachments: EmailAttachment[] }) => {
    if (!profile || !job) throw new Error("Not signed in");
    await queueAndSendEmail({ tenantId: profile.tenant_id, entityType: "job", entityId: job.id, triggerKey: "material_order_email", ...payload });
  };

  return (
    <div>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Supplier (optional)" placeholder='e.g. "Bunnings"' value={supplierName} onChange={(e) => setSupplierName(e.target.value)} />
        <FormField label="Delivery date (optional)" type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} />
      </div>
      <div className="mt-3">
        <SelectField
          label="Status"
          value={status}
          onChange={(v) => v && setStatus(v as MaterialOrderStatus)}
          options={STATUS_OPTIONS.map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }))}
        />
      </div>

      <div className="mt-3 mb-3 grid grid-cols-[1fr,80px,90px,auto] gap-2">
        <input
          type="text"
          placeholder="Item name"
          value={newItemName}
          onChange={(e) => setNewItemName(e.target.value)}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        />
        <input
          type="number"
          placeholder="Qty"
          value={newItemQty}
          onChange={(e) => setNewItemQty(e.target.value)}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        />
        <input
          type="text"
          placeholder="Unit"
          value={newItemUnit}
          onChange={(e) => setNewItemUnit(e.target.value)}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        />
        <button onClick={handleAddItem} disabled={!newItemName.trim()} className="rounded-md bg-blue-700 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60">
          + Add
        </button>
      </div>

      {lineItems.length === 0 ? (
        <p className="text-sm text-gray-500">No items yet - add one above, or transfer a tally from the Material Tally tool.</p>
      ) : (
        <div className="space-y-1">
          {lineItems.map((item, index) => (
            <div key={index} className="flex items-center justify-between rounded border border-gray-200 px-3 py-1.5 text-sm">
              <span className="truncate font-medium text-gray-900">{item.item_name}</span>
              <span className="flex-shrink-0 text-gray-600">
                {item.quantity} {item.unit_type}
              </span>
              <button onClick={() => handleRemoveItem(index)} className="ml-3 flex-shrink-0 text-xs font-semibold text-red-600 hover:underline">
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {saveError ? <p className="mt-3 text-sm text-red-600">{saveError}</p> : null}
      <button
        onClick={() => save.mutate()}
        disabled={save.isPending || lineItems.length === 0}
        className="mt-4 rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
      >
        {save.isPending ? "Saving..." : "Save Material Order"}
      </button>

      {orders && orders.length > 0 ? (
        <div className="mt-6">
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-gray-500">Past orders</h3>
          <div className="space-y-2">
            {orders.map((order) => (
              <div key={order.id} className="rounded-lg border border-gray-200 p-3">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-sm font-bold text-gray-900">{order.order_number}</span>
                  <span className="text-xs font-semibold text-gray-500">{order.status}</span>
                </div>
                <p className="mb-2 text-xs text-gray-500">
                  {order.supplier_name ?? "No supplier"} &middot; {order.line_items.length} item{order.line_items.length === 1 ? "" : "s"}
                </p>
                <div className="flex gap-3 text-xs font-semibold">
                  <button onClick={() => handleExportPdf(order)} className="text-blue-700 hover:underline">
                    Export Material Order PDF
                  </button>
                  <button onClick={() => setEmailOrder(order)} className="text-blue-700 hover:underline">
                    Email Order to Supplier
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <EmailComposeModal
        open={!!emailOrder}
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
        recipientOptions={[]}
        onSend={handleSendOrderEmail}
      />
    </div>
  );
}

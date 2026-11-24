import { useState } from "react";
import { sydneyToday, type Client, type Tenant } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { fetchAssetTypes, fetchAssetsFor, toPdfAsset } from "../lib/assets-data";
import { blobToDataUrl, buildHomeRecordPdf, downloadBlob } from "../lib/quote-invoice-pdf-bytes";
import { queueAndSendEmail } from "../lib/send-email";

// A client's "Home record": every active asset at each of their addresses
// with its warranties and next services, as a PDF to download or email.

async function build(clientId: string, tenantId: string) {
  const [{ data: client, error: ce }, { data: tenant, error: te }, { data: sites }, bundle, types] = await Promise.all([
    supabase.from("clients").select("*").eq("id", clientId).single(),
    supabase.from("tenants").select("*").eq("id", tenantId).single(),
    supabase.from("client_sites").select("id, label, address_line1, suburb, state, postcode").eq("client_id", clientId),
    fetchAssetsFor({ type: "client", id: clientId }),
    fetchAssetTypes(),
  ]);
  if (ce) throw ce;
  if (te) throw te;
  const c = client as Client;
  const address = (a: { address_line1: string | null; suburb: string | null; state?: string | null; postcode?: string | null }) =>
    [a.address_line1, [a.suburb, a.state, a.postcode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const active = bundle.assets.filter((a) => a.status === "active");
  const siteIds = [...new Set(active.map((a) => a.site_id ?? ""))];
  const groups = siteIds.map((sid) => {
    const site = (sites ?? []).find((s) => s.id === sid);
    return {
      address: (site ? address(site) : address(c)) || "Address",
      assets: active
        .filter((a) => (a.site_id ?? "") === sid)
        .sort((a, b) => a.asset_name.localeCompare(b.asset_name))
        .map((a) => toPdfAsset(a, types.find((t) => t.id === a.asset_type_id) ?? null, bundle.warranties, bundle.services)),
    };
  });
  const blob = await buildHomeRecordPdf({ tenant: tenant as Tenant, client: c, groups, preparedOn: sydneyToday() });
  return { blob, client: c, tenant: tenant as Tenant, filename: `Home record - ${c.name}.pdf` };
}

export function HomeRecordButton({ clientId }: { clientId: string }) {
  const { profile } = useAuth();
  const [busy, setBusy] = useState<"download" | "email" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const link = { color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" } as const;

  const run = async (mode: "download" | "email") => {
    if (!profile) return;
    setBusy(mode);
    setError(null);
    setMessage(null);
    try {
      const { blob, client, tenant, filename } = await build(clientId, profile.tenant_id);
      if (mode === "download") {
        downloadBlob(blob, filename);
      } else {
        if (!client.email) throw new Error("This client has no email address");
        if (!window.confirm(`Email the home record to ${client.email}?`)) return;
        await queueAndSendEmail({
          tenantId: profile.tenant_id,
          entityType: "client",
          entityId: clientId,
          triggerKey: "home_record",
          to: client.email,
          subject: `Your home record from ${tenant.name}`,
          body: `Hi ${client.first_name ?? client.name},\n\nAttached is a record of what we've installed and serviced at your place, with warranty dates and when things are next due. Worth keeping with your home's documents.\n\nAny questions, just reply.\n\n${tenant.name}`,
          attachments: [{ filename, content: await blobToDataUrl(blob) }],
        });
        setMessage(`Sent to ${client.email}.`);
      }
    } catch (e) {
      setError(getErrorMessage(e, "Couldn't make the home record"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-3">
      <button onClick={() => run("download")} disabled={!!busy} className="font-semibold hover:underline" style={link}>
        {busy === "download" ? "Making PDF..." : "Home record PDF"}
      </button>
      <button onClick={() => run("email")} disabled={!!busy} className="font-semibold hover:underline" style={link}>
        {busy === "email" ? "Sending..." : "Email it to them"}
      </button>
      {message ? <span style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>{message}</span> : null}
      {error ? <span style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}>{error}</span> : null}
    </span>
  );
}

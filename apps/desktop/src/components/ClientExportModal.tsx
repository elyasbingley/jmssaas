import { useState } from "react";
import { buildClientExport, toCsv, type Client, type ClientExportFormat, type ClientExportInput } from "@jmssaas/shared";
import { fetchAllRows } from "../lib/fetch-all-rows";
import { getErrorMessage } from "../lib/errors";
import { ThemedModal } from "./theme/ThemedModal";
import { ThemedButton } from "./theme/ThemedButton";

// Clients > Export: a CSV for Excel / Google Sheets, or one ready for
// Mailchimp's contact import. The rules (columns, phone formatting, who
// Mailchimp leaves out, Excel safety) are packages/shared's client-export.ts.

const muted = { color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" } as const;
const body = { color: "var(--jms-text)", fontSize: "var(--jms-font-body)" } as const;

function Choice({ checked, onChange, title, detail }: { checked: boolean; onChange: () => void; title: string; detail: string }) {
  return (
    <label
      className="mb-2 flex cursor-pointer gap-3 rounded p-3"
      style={{ border: `1px solid ${checked ? "var(--jms-accent)" : "var(--jms-border)"}`, backgroundColor: checked ? "var(--jms-accent-glow)" : "transparent" }}
    >
      <input type="radio" checked={checked} onChange={onChange} className="mt-1" />
      <span>
        <span className="block font-semibold" style={body}>
          {title}
        </span>
        <span style={muted}>{detail}</span>
      </span>
    </label>
  );
}

export function ClientExportModal({ open, onClose, shownIds, totalCount }: { open: boolean; onClose: () => void; shownIds: string[] | null; totalCount: number }) {
  const [format, setFormat] = useState<ClientExportFormat>("spreadsheet");
  const [onlyShown, setOnlyShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const [clients, jobs, invoices, sources, tagRows] = await Promise.all([
        fetchAllRows<Client & { marketing_opt_out: boolean | null; google_review_stars: number | null }>("clients", "*"),
        fetchAllRows<{ client_id: string; created_at: string; lead_source_id: string | null }>("job_cards", "id, client_id, created_at, lead_source_id"),
        fetchAllRows<{ client_id: string; status: string; amount_paid_cents: number | null }>("invoices", "id, client_id, status, amount_paid_cents"),
        fetchAllRows<{ id: string; name: string }>("lead_sources", "id, name"),
        fetchAllRows<{ client_id: string; client_tags: { name: string } | null }>("client_tag_assignments", "id, client_id, client_tags(name)"),
      ]);
      const sourceName = new Map(sources.map((s) => [s.id, s.name]));
      const jobsBy = new Map<string, typeof jobs>();
      for (const j of jobs) jobsBy.set(j.client_id, [...(jobsBy.get(j.client_id) ?? []), j]);
      const paidBy = new Map<string, number>();
      for (const i of invoices) if (i.status !== "void") paidBy.set(i.client_id, (paidBy.get(i.client_id) ?? 0) + (i.amount_paid_cents ?? 0));
      const tagsBy = new Map<string, string[]>();
      for (const t of tagRows) if (t.client_tags) tagsBy.set(t.client_id, [...(tagsBy.get(t.client_id) ?? []), t.client_tags.name]);

      const wanted = onlyShown && shownIds ? new Set(shownIds) : null;
      const input: ClientExportInput[] = clients
        .filter((c) => !wanted || wanted.has(c.id))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((c) => {
          const theirJobs = [...(jobsBy.get(c.id) ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at));
          // Where they first came from: their earliest job with a lead source.
          const firstSource = theirJobs.find((j) => j.lead_source_id)?.lead_source_id;
          return {
            ...c,
            tags: (tagsBy.get(c.id) ?? []).sort(),
            lead_source: firstSource ? sourceName.get(firstSource) ?? null : null,
            job_count: theirJobs.length,
            last_job_at: theirJobs.length ? theirJobs[theirJobs.length - 1]!.created_at : null,
            paid_cents: paidBy.get(c.id) ?? 0,
          };
        });

      const today = new Date().toLocaleDateString("en-CA");
      const exp = buildClientExport(input, format, today);
      const url = URL.createObjectURL(new Blob([toCsv(exp, format)], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = exp.filename;
      a.click();
      URL.revokeObjectURL(url);

      const left = [
        exp.skipped.noEmail ? `${exp.skipped.noEmail} with no email` : "",
        exp.skipped.optedOut ? `${exp.skipped.optedOut} opted out of marketing` : "",
        exp.skipped.duplicateEmail ? `${exp.skipped.duplicateEmail} sharing an email with someone above` : "",
      ].filter(Boolean);
      setDone(`Downloaded ${exp.filename}: ${exp.rows.length} ${exp.rows.length === 1 ? "client" : "clients"}.${left.length ? ` Left out: ${left.join(", ")}.` : ""}`);
    } catch (e) {
      setError(getErrorMessage(e, "Couldn't export the clients"));
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    setDone(null);
    setError(null);
    onClose();
  };

  return (
    <ThemedModal open={open} onClose={close} title="Export clients">
      <p className="mb-2 uppercase tracking-wide" style={muted}>
        For
      </p>
      <Choice
        checked={format === "spreadsheet"}
        onChange={() => setFormat("spreadsheet")}
        title="Excel or Google Sheets"
        detail="Every client with contact details, address, tags, lead source, number of jobs, last job, total paid and whether they've opted out of marketing."
      />
      <Choice
        checked={format === "mailchimp"}
        onChange={() => setFormat("mailchimp")}
        title="Mailchimp"
        detail="Columns named the way Mailchimp's import expects. Only clients with an email who haven't opted out of marketing, one row per email."
      />

      {shownIds && shownIds.length !== totalCount ? (
        <>
          <p className="mb-2 mt-3 uppercase tracking-wide" style={muted}>
            Which clients
          </p>
          <Choice checked={!onlyShown} onChange={() => setOnlyShown(false)} title={totalCount >= 1000 ? "All clients" : `All clients (${totalCount})`} detail="Everyone in JMS." />
          <Choice checked={onlyShown} onChange={() => setOnlyShown(true)} title={`Just the ${shownIds.length} shown`} detail="The clients matching your search or tag filter." />
        </>
      ) : null}

      {format === "mailchimp" ? (
        <p className="mb-3 mt-2 rounded p-3" style={{ ...muted, border: "1px dashed var(--jms-border)" }}>
          In Mailchimp: Audience, then Add contacts, then Import contacts, and upload this file. The columns match on their own. Map "Tags" to tags and tick that they've agreed
          to hear from you: existing customers count, and anyone who's opted out is already left out.
        </p>
      ) : (
        <p className="mb-3 mt-2" style={muted}>
          A CSV file. Excel and Google Sheets open it directly, with phone numbers and postcodes kept intact.
        </p>
      )}

      {done ? <p className="mb-3" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>{done}</p> : null}
      {error ? <p className="mb-3" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>{error}</p> : null}
      <div className="flex justify-end gap-3">
        <button onClick={close} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
          {done ? "Close" : "Cancel"}
        </button>
        <ThemedButton onClick={run} disabled={busy}>
          {busy ? "Exporting..." : "Download CSV"}
        </ThemedButton>
      </div>
    </ThemedModal>
  );
}

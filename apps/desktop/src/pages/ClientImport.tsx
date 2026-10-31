import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { joinClientName, splitClientName, type Client } from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { parseCsv } from "../lib/csv";
import { ThemedButton } from "../components/theme/ThemedButton";

// Bulk-add past clients from a CSV export (e.g. ServiceM8's own client
// list) - a wizard, not a single form: upload -> map the file's own
// columns onto our fields (every export names its columns differently,
// so guessing a fixed header name would silently mis-map or drop data) ->
// preview every row with duplicate matching already run against both the
// tenant's existing clients and the file itself -> confirm. Nothing here
// blocks an import on a flagged duplicate - the preview just defaults its
// checkbox off, and importing one anyway still flags it
// (possible_duplicate_of_client_id, see the client_csv_import migration)
// so it stays visible on the Clients page's own review queue afterward.

type TargetField =
  | "first_name"
  | "last_name"
  | "full_name"
  | "email"
  | "phone"
  | "address_line1"
  | "address_line2"
  | "suburb"
  | "state"
  | "postcode";

const TARGET_FIELDS: { key: TargetField; label: string; hint?: string }[] = [
  { key: "first_name", label: "First name" },
  { key: "last_name", label: "Last name" },
  { key: "full_name", label: "Full name", hint: "only if the file has one combined name column instead of first/last" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Mobile / phone" },
  { key: "address_line1", label: "Address line 1", hint: "or the whole address, if the file has just one address column" },
  { key: "address_line2", label: "Address line 2" },
  { key: "suburb", label: "Suburb" },
  { key: "state", label: "State" },
  { key: "postcode", label: "Postcode" },
];

const AUTO_MATCH: Record<TargetField, string[]> = {
  first_name: ["first name", "firstname", "given name"],
  last_name: ["last name", "lastname", "surname", "family name"],
  full_name: ["name", "full name", "client name", "customer name", "contact name", "contact"],
  email: ["email", "email address", "e-mail"],
  phone: ["mobile", "mobile phone", "mobile number", "phone", "phone number", "contact phone", "cell"],
  address_line1: ["address", "address line 1", "address 1", "street address", "billing address", "site address"],
  address_line2: ["address line 2", "address 2", "unit"],
  suburb: ["suburb", "city", "town"],
  state: ["state"],
  postcode: ["postcode", "post code", "zip", "zip code"],
};

function guessColumnMap(headers: string[]): Partial<Record<TargetField, string>> {
  const map: Partial<Record<TargetField, string>> = {};
  const used = new Set<string>();
  for (const field of TARGET_FIELDS) {
    const match = headers.find((h) => !used.has(h) && AUTO_MATCH[field.key].includes(h.trim().toLowerCase()));
    if (match) {
      map[field.key] = match;
      used.add(match);
    }
  }
  return map;
}

function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}
function normalizePhone(s: string): string {
  return s.replace(/\D/g, "").slice(-9);
}
function normalizeEmail(s: string): string {
  return s.trim().toLowerCase();
}

interface BaseRow {
  rowNumber: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  suburb: string;
  state: string;
  postcode: string;
}

interface PreviewRow extends BaseRow {
  include: boolean;
  duplicateReason: string | null;
  duplicateOfExistingClientId: string | null;
}

function buildBaseRow(rawRow: string[], headers: string[], columnMap: Partial<Record<TargetField, string>>, rowNumber: number): BaseRow {
  const get = (field: TargetField): string => {
    const header = columnMap[field];
    if (!header) return "";
    const idx = headers.indexOf(header);
    return idx >= 0 ? (rawRow[idx] ?? "").trim() : "";
  };

  let firstName = get("first_name");
  let lastName = get("last_name");
  if (!firstName && !lastName) {
    const full = get("full_name");
    if (full) {
      const split = splitClientName(full);
      firstName = split.first_name;
      lastName = split.last_name ?? "";
    }
  }

  return {
    rowNumber,
    firstName,
    lastName,
    email: get("email"),
    phone: get("phone"),
    addressLine1: get("address_line1"),
    addressLine2: get("address_line2"),
    suburb: get("suburb"),
    state: get("state"),
    postcode: get("postcode"),
  };
}

function findDuplicate(
  row: BaseRow,
  existingClients: Pick<Client, "id" | "name" | "email" | "phone">[],
  priorRows: BaseRow[]
): { reason: string; existingClientId: string | null } | null {
  const fullName = normalizeName(`${row.firstName} ${row.lastName}`);
  const email = row.email ? normalizeEmail(row.email) : "";
  const phone = row.phone ? normalizePhone(row.phone) : "";

  for (const existing of existingClients) {
    const existingEmail = existing.email ? normalizeEmail(existing.email) : "";
    const existingPhone = existing.phone ? normalizePhone(existing.phone) : "";
    const existingName = normalizeName(existing.name);
    if ((email && email === existingEmail) || (phone && phone.length >= 8 && phone === existingPhone) || (fullName && fullName === existingName)) {
      return { reason: `Matches existing client "${existing.name}"`, existingClientId: existing.id };
    }
  }

  for (const prior of priorRows) {
    const priorName = normalizeName(`${prior.firstName} ${prior.lastName}`);
    const priorEmail = prior.email ? normalizeEmail(prior.email) : "";
    const priorPhone = prior.phone ? normalizePhone(prior.phone) : "";
    if ((email && email === priorEmail) || (phone && phone.length >= 8 && phone === priorPhone) || (fullName && fullName === priorName)) {
      return { reason: `Duplicate of row ${prior.rowNumber} in this file`, existingClientId: null };
    }
  }

  return null;
}

export default function ClientImportPage() {
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<"upload" | "map" | "preview" | "done">("upload");
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<string[][]>([]);
  const [columnMap, setColumnMap] = useState<Partial<Record<TargetField, string>>>({});
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([]);
  const [stepError, setStepError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<{ imported: number; duplicates: number } | null>(null);

  const { data: existingClients } = useQuery({
    queryKey: ["clients-for-import-dedupe"],
    queryFn: async () => {
      const { data, error } = await supabase.from("clients").select("id, name, email, phone");
      if (error) throw error;
      return data as Pick<Client, "id" | "name" | "email" | "phone">[];
    },
  });

  const handleFileSelected = async (file: File) => {
    setStepError(null);
    const text = await file.text();
    const { headers: parsedHeaders, rows } = parseCsv(text);
    if (parsedHeaders.length === 0 || rows.length === 0) {
      setStepError("Couldn't find any rows in that file - check it's a plain CSV export.");
      return;
    }
    setFileName(file.name);
    setHeaders(parsedHeaders);
    setRawRows(rows);
    setColumnMap(guessColumnMap(parsedHeaders));
    setStep("map");
  };

  const handleBuildPreview = () => {
    if (!columnMap.full_name && !columnMap.first_name) {
      setStepError('Map either "Full name" or "First name" before continuing.');
      return;
    }
    setStepError(null);
    const existing = existingClients ?? [];
    const built: PreviewRow[] = [];
    const baseRows: BaseRow[] = [];
    for (let i = 0; i < rawRows.length; i++) {
      const base = buildBaseRow(rawRows[i] ?? [], headers, columnMap, i + 2);
      if (!base.firstName && !base.lastName) continue;
      const dup = findDuplicate(base, existing, baseRows);
      baseRows.push(base);
      built.push({ ...base, include: !dup, duplicateReason: dup?.reason ?? null, duplicateOfExistingClientId: dup?.existingClientId ?? null });
    }
    setPreviewRows(built);
    setStep("preview");
  };

  const toggleRow = (rowNumber: number) => {
    setPreviewRows((rows) => rows.map((r) => (r.rowNumber === rowNumber ? { ...r, include: !r.include } : r)));
  };

  const importMutation = useMutation({
    mutationFn: async () => {
      if (!profile) throw new Error("Not signed in");
      const rowsToImport = previewRows.filter((r) => r.include);
      if (rowsToImport.length === 0) throw new Error("No rows selected to import");

      const { data: batch, error: batchError } = await supabase
        .from("client_import_batches")
        .insert({
          tenant_id: profile.tenant_id,
          file_name: fileName,
          total_rows: previewRows.length,
          imported_count: rowsToImport.length,
          possible_duplicate_count: rowsToImport.filter((r) => r.duplicateReason).length,
          created_by: profile.id,
        })
        .select("id")
        .single();
      if (batchError) throw batchError;

      const payload = rowsToImport.map((r) => ({
        tenant_id: profile.tenant_id,
        first_name: r.firstName,
        last_name: r.lastName || null,
        name: joinClientName(r.firstName, r.lastName),
        email: r.email || null,
        phone: r.phone || null,
        address_line1: r.addressLine1 || null,
        address_line2: r.addressLine2 || null,
        suburb: r.suburb || null,
        state: r.state || null,
        postcode: r.postcode || null,
        import_batch_id: batch.id as string,
        possible_duplicate_of_client_id: r.duplicateOfExistingClientId,
        created_by: profile.id,
      }));

      // Chunked rather than one request - a ServiceM8-sized export can be
      // a few thousand rows, past what's comfortable in one insert.
      const CHUNK_SIZE = 200;
      for (let i = 0; i < payload.length; i += CHUNK_SIZE) {
        const { error } = await supabase.from("clients").insert(payload.slice(i, i + CHUNK_SIZE));
        if (error) throw error;
      }

      return { imported: rowsToImport.length, duplicates: rowsToImport.filter((r) => r.duplicateReason).length };
    },
    onSuccess: (result) => {
      setImportResult(result);
      setStep("done");
      queryClient.invalidateQueries({ queryKey: ["clients"] });
    },
    onError: (e) => setStepError(getErrorMessage(e, "Failed to import clients")),
  });

  const includedCount = previewRows.filter((r) => r.include).length;
  const duplicateCount = previewRows.filter((r) => r.duplicateReason).length;

  return (
    <div className="p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <div className="mb-6">
        <Link to="/clients" className="mb-2 inline-block font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
          ‹ Back to Clients
        </Link>
        <h1 className="uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
          Import Clients from CSV
        </h1>
      </div>

      {step === "upload" ? (
        <div className="rounded p-6" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)", maxWidth: 520 }}>
          <p className="mb-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Pick a CSV export from ServiceM8 (or any other system) - the next step lets you tell us which column is which, so it doesn't matter what it's named.
          </p>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFileSelected(file);
            }}
            style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
          />
          {stepError ? (
            <p className="mt-3" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
              {stepError}
            </p>
          ) : null}
        </div>
      ) : null}

      {step === "map" ? (
        <div className="rounded p-6" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)", maxWidth: 640 }}>
          <p className="mb-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            {fileName} - {rawRows.length} row{rawRows.length === 1 ? "" : "s"} found. Match each field to a column from your file (we've guessed where we could).
          </p>
          <div className="mb-5 grid grid-cols-2 gap-4">
            {TARGET_FIELDS.map((field) => (
              <div key={field.key}>
                <label className="mb-1 block font-semibold uppercase" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                  {field.label}
                </label>
                <select
                  value={columnMap[field.key] ?? ""}
                  onChange={(e) => setColumnMap({ ...columnMap, [field.key]: e.target.value || undefined })}
                  className="w-full rounded border px-3 py-2 focus:outline-none"
                  style={{ backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
                >
                  <option value="">-- Not mapped --</option>
                  {headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
                {field.hint ? (
                  <p className="mt-1" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                    {field.hint}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
          {stepError ? (
            <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
              {stepError}
            </p>
          ) : null}
          <div className="flex justify-end gap-3">
            <button onClick={() => setStep("upload")} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
              Back
            </button>
            <ThemedButton onClick={handleBuildPreview}>Continue to preview</ThemedButton>
          </div>
        </div>
      ) : null}

      {step === "preview" ? (
        <div>
          <p className="mb-4" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            {previewRows.length} client{previewRows.length === 1 ? "" : "s"} found, {includedCount} selected to import.{" "}
            {duplicateCount > 0 ? (
              <span style={{ color: "var(--jms-danger)" }}>
                {duplicateCount} flagged as possible duplicates (unchecked by default - tick one to import it anyway, it'll still be flagged for review afterward).
              </span>
            ) : null}
          </p>
          <div className="mb-4 overflow-hidden rounded" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)", maxHeight: 520, overflowY: "auto" }}>
            <table className="w-full text-left" style={{ fontSize: "var(--jms-font-body)" }}>
              <thead
                className="sticky top-0 uppercase"
                style={{ borderBottom: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}
              >
                <tr>
                  <th className="px-3 py-2 font-semibold">Import</th>
                  <th className="px-3 py-2 font-semibold">Name</th>
                  <th className="px-3 py-2 font-semibold">Email</th>
                  <th className="px-3 py-2 font-semibold">Phone</th>
                  <th className="px-3 py-2 font-semibold">Address</th>
                </tr>
              </thead>
              <tbody>
                {previewRows.map((row) => (
                  <tr key={row.rowNumber} className="last:border-0" style={{ borderBottom: "1px solid var(--jms-border)" }}>
                    <td className="px-3 py-2">
                      <input type="checkbox" checked={row.include} onChange={() => toggleRow(row.rowNumber)} />
                    </td>
                    <td className="px-3 py-2" style={{ color: "var(--jms-text)" }}>
                      {row.firstName} {row.lastName}
                      {row.duplicateReason ? (
                        <p style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}>⚠ {row.duplicateReason}</p>
                      ) : null}
                    </td>
                    <td className="px-3 py-2" style={{ color: "var(--jms-text-muted)" }}>
                      {row.email || "-"}
                    </td>
                    <td className="px-3 py-2" style={{ color: "var(--jms-text-muted)" }}>
                      {row.phone || "-"}
                    </td>
                    <td className="px-3 py-2" style={{ color: "var(--jms-text-muted)" }}>
                      {[row.addressLine1, row.suburb, row.state, row.postcode].filter(Boolean).join(", ") || "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {stepError ? (
            <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
              {stepError}
            </p>
          ) : null}
          <div className="flex justify-end gap-3">
            <button onClick={() => setStep("map")} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
              Back
            </button>
            <ThemedButton onClick={() => importMutation.mutate()} disabled={importMutation.isPending || includedCount === 0}>
              {importMutation.isPending ? "Importing..." : `Import ${includedCount} client${includedCount === 1 ? "" : "s"}`}
            </ThemedButton>
          </div>
        </div>
      ) : null}

      {step === "done" && importResult ? (
        <div className="rounded p-6" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)", maxWidth: 520 }}>
          <p className="mb-4" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
            Imported {importResult.imported} client{importResult.imported === 1 ? "" : "s"}.
            {importResult.duplicates > 0 ? ` ${importResult.duplicates} flagged as possible duplicates - review them from the Clients page.` : ""}
          </p>
          <Link to="/clients">
            <ThemedButton>Back to Clients</ThemedButton>
          </Link>
        </div>
      ) : null}
    </div>
  );
}

// Client export (desktop Clients > Export): a CSV for Excel / Google Sheets
// with everything useful about each client, or one shaped for Mailchimp's
// contact import. Pure functions so the rules are unit tested.

export type ClientExportFormat = "spreadsheet" | "mailchimp";

export interface ClientExportInput {
  id: string;
  name: string;
  first_name: string | null;
  last_name: string | null;
  client_type: string;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  marketing_opt_out?: boolean | null;
  google_review_stars?: number | null;
  created_at: string;
  // Worked out by the page from jobs, invoices and tags.
  tags: string[];
  lead_source: string | null;
  job_count: number;
  last_job_at: string | null;
  paid_cents: number;
}

// Australian numbers spaced the usual way ("0412 345 678", "02 9876 5432",
// "1300 123 456"). Spaces also stop Excel treating them as numbers and
// dropping the leading 0. Anything else is left as typed.
export function formatAuPhone(raw: string | null | undefined): string {
  const text = (raw ?? "").trim();
  if (!text) return "";
  let d = text.replace(/[^\d+]/g, "");
  if (d.startsWith("+61")) d = "0" + d.slice(3).replace(/^0/, "");
  else if (/^61\d{9}$/.test(d)) d = "0" + d.slice(2);
  if (/^04\d{8}$/.test(d) || /^05\d{8}$/.test(d)) return `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}`;
  if (/^0[2378]\d{8}$/.test(d)) return `${d.slice(0, 2)} ${d.slice(2, 6)} ${d.slice(6)}`;
  if (/^1[38]00\d{6}$/.test(d)) return `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}`;
  if (/^13\d{4}$/.test(d)) return `${d.slice(0, 2)} ${d.slice(2, 4)} ${d.slice(4)}`;
  return text;
}

const validEmail = (e: string | null | undefined) => !!e && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e.trim());
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

export interface ClientExport {
  filename: string;
  header: string[];
  rows: string[][];
  // How many were left out, and why (Mailchimp only).
  skipped: { noEmail: number; optedOut: number; duplicateEmail: number };
}

export function buildClientExport(clients: ClientExportInput[], format: ClientExportFormat, today: string): ClientExport {
  const skipped = { noEmail: 0, optedOut: 0, duplicateEmail: 0 };
  if (format === "mailchimp") {
    // Mailchimp's own column names, so its import matches them without
    // any mapping. One row per email address.
    const header = ["Email Address", "First Name", "Last Name", "Phone Number", "Company", "Address", "Suburb", "State", "Postcode", "Tags"];
    const seen = new Set<string>();
    const rows: string[][] = [];
    for (const c of clients) {
      if (c.marketing_opt_out) {
        skipped.optedOut++;
        continue;
      }
      if (!validEmail(c.email)) {
        skipped.noEmail++;
        continue;
      }
      const email = c.email!.trim().toLowerCase();
      if (seen.has(email)) {
        skipped.duplicateEmail++;
        continue;
      }
      seen.add(email);
      rows.push([
        email,
        c.first_name ?? "",
        c.last_name ?? "",
        formatAuPhone(c.phone),
        c.company_name ?? "",
        [c.address_line1, c.address_line2].filter(Boolean).join(", "),
        c.suburb ?? "",
        c.state ?? "",
        c.postcode ?? "",
        c.tags.join(","),
      ]);
    }
    return { filename: `mailchimp-contacts-${today}.csv`, header, rows, skipped };
  }

  const header = [
    "First name",
    "Last name",
    "Name",
    "Company",
    "Type",
    "Email",
    "Phone",
    "Address line 1",
    "Address line 2",
    "Suburb",
    "State",
    "Postcode",
    "Tags",
    "Lead source",
    "Jobs",
    "Last job",
    "Total paid",
    "Google review",
    "Marketing",
    "Client since",
    "JMS ID",
  ];
  const rows = clients.map((c) => [
    c.first_name ?? "",
    c.last_name ?? "",
    c.name,
    c.company_name ?? "",
    c.client_type === "company" ? "Company" : "Individual",
    (c.email ?? "").trim(),
    formatAuPhone(c.phone),
    c.address_line1 ?? "",
    c.address_line2 ?? "",
    c.suburb ?? "",
    c.state ?? "",
    c.postcode ?? "",
    c.tags.join(", "),
    c.lead_source ?? "",
    String(c.job_count),
    day(c.last_job_at),
    (c.paid_cents / 100).toFixed(2),
    c.google_review_stars ? `${c.google_review_stars} stars` : "",
    c.marketing_opt_out ? "Opted out" : "OK",
    day(c.created_at),
    c.id,
  ]);
  return { filename: `clients-${today}.csv`, header, rows, skipped };
}

// One CSV cell, made safe for Excel:
//  * a value starting with = + - @ would run as a formula when the file is
//    opened (someone could type one into the website sign-up form), so it
//    gets a leading apostrophe - except plain numbers like -12.50;
//  * for the spreadsheet, digits with a leading 0 (postcode 0800) are kept
//    as text so Excel doesn't drop the 0.
export function csvCell(value: string, format: ClientExportFormat): string {
  let v = value ?? "";
  if (/^[=+\-@\t\r]/.test(v) && !/^[+-]?\d+(\.\d+)?$/.test(v)) v = "'" + v;
  if (format === "spreadsheet" && /^0\d+$/.test(v)) return `="${v}"`;
  return `"${v.replace(/"/g, '""')}"`;
}

// The whole file. The spreadsheet one starts with a byte-order mark so
// Excel reads accented names (José, Zoë) correctly; Mailchimp doesn't need
// it.
export function toCsv(exp: ClientExport, format: ClientExportFormat): string {
  const lines = [exp.header, ...exp.rows].map((row) => row.map((v) => csvCell(v, format)).join(","));
  return (format === "spreadsheet" ? "﻿" : "") + lines.join("\r\n") + "\r\n";
}

// Asset register (see the asset_register migration): types, warranties,
// service plans and the due/expiry rules the desktop lists and the phone
// both use. The database applies the same rules on its side (next due
// dates, reminders, assets created from a completed job).

import type { PropertyAssetCategory } from "./types";

export type AssetFieldType = "text" | "number" | "date" | "select";
export interface AssetField {
  key: string;
  label: string;
  type: AssetFieldType;
  options?: string[];
}
export interface AssetDefaultService {
  name: string;
  interval_months: number | null;
}
export type AssetWarrantyKind = "manufacturer" | "workmanship";
export interface AssetDefaultWarranty {
  kind: AssetWarrantyKind;
  label: string;
  years: number | null;
}

export interface AssetType {
  id: string;
  tenant_id: string;
  name: string;
  icon: string | null;
  category: PropertyAssetCategory;
  fields: AssetField[];
  default_services: AssetDefaultService[];
  default_warranties: AssetDefaultWarranty[];
  replace_after_years: number | null;
  lead_days: number;
  sort_order: number;
  is_archived: boolean;
}

export interface Asset {
  id: string;
  tenant_id: string;
  property_id: string | null;
  client_id: string | null;
  site_id: string | null;
  category: PropertyAssetCategory;
  asset_type_id: string | null;
  asset_name: string;
  attributes: Record<string, string | number | null | undefined>;
  installed_on: string | null;
  install_year: number | null;
  location: string | null;
  notes: string | null;
  status: "active" | "removed";
  removed_on: string | null;
  removed_reason: string | null;
  replaced_by_asset_id: string | null;
  installed_by_job_id: string | null;
  needs_details: boolean;
  replacement_reminded_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AssetWarranty {
  id: string;
  tenant_id: string;
  asset_id: string;
  kind: AssetWarrantyKind;
  label: string;
  starts_on: string | null;
  expires_on: string | null;
  notes: string | null;
}

export interface AssetService {
  id: string;
  tenant_id: string;
  asset_id: string;
  name: string;
  interval_months: number | null;
  last_done_on: string | null;
  next_due_on: string | null;
  notes: string | null;
}

export interface AssetServiceRecord {
  id: string;
  tenant_id: string;
  asset_id: string;
  service_id: string | null;
  job_card_id: string | null;
  done_on: string;
  done_by: string | null;
  note: string | null;
  created_at: string;
}

export interface AssetFile {
  id: string;
  tenant_id: string;
  asset_id: string;
  kind: "photo" | "document";
  storage_path: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  caption: string | null;
  uploaded_by: string | null;
  created_at: string;
}

export type AssetClaimStatus = "lodged" | "approved" | "declined" | "completed";
export interface AssetWarrantyClaim {
  id: string;
  tenant_id: string;
  asset_id: string;
  warranty_id: string | null;
  job_card_id: string | null;
  lodged_on: string;
  claim_with: string | null;
  reference: string | null;
  status: AssetClaimStatus;
  parts_supplied: string | null;
  notes: string | null;
  created_at: string;
}

export const ASSET_CLAIM_STATUS_LABELS: Record<AssetClaimStatus, string> = {
  lodged: "Lodged",
  approved: "Approved",
  declined: "Declined",
  completed: "Completed",
};

// ---------------------------------------------------------------------------
// Dates (all plain YYYY-MM-DD, no time zones)
// ---------------------------------------------------------------------------

function parse(day: string): { y: number; m: number; d: number } {
  const [y, m, d] = day.split("-").map(Number);
  return { y: y!, m: m!, d: d! };
}
const pad = (n: number) => String(n).padStart(2, "0");
function format(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// Same as Postgres's date + interval 'N months': the day is kept, or the
// month's last day if it's shorter (31 Jan + 1 month = 28/29 Feb).
export function addMonths(day: string, months: number): string {
  const { y, m, d } = parse(day);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return format(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}
export function addDaysToDay(day: string, days: number): string {
  const { y, m, d } = parse(day);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return format(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
function daysBetween(from: string, to: string): number {
  const a = parse(from);
  const b = parse(to);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
}
export const yearsToMonths = (years: number) => Math.round(years * 12);

// Today in Sydney, as YYYY-MM-DD.
export function sydneyToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(now);
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

// The date an asset counts as installed: the exact date, or 1 July of the
// year when only the year is known.
export function assetInstalledDate(asset: Pick<Asset, "installed_on" | "install_year">): string | null {
  if (asset.installed_on) return asset.installed_on;
  return asset.install_year ? `${asset.install_year}-07-01` : null;
}

export function assetAgeYears(asset: Pick<Asset, "installed_on" | "install_year">, today: string): number | null {
  const installed = assetInstalledDate(asset);
  if (!installed) return null;
  const a = parse(installed);
  const b = parse(today);
  let years = b.y - a.y;
  if (b.m < a.m || (b.m === a.m && b.d < a.d)) years--;
  return Math.max(0, years);
}

// Next due date for a service, the same rule as the database: from the
// last time it was done, else from the install date - rolled forward to
// the next one from today for an older asset with no service recorded.
export function serviceNextDue(lastDoneOn: string | null, intervalMonths: number | null, installedOn: string | null, today: string): string | null {
  if (!intervalMonths) return null;
  if (lastDoneOn) return addMonths(lastDoneOn, intervalMonths);
  if (!installedOn) return null;
  let next = addMonths(installedOn, intervalMonths);
  let k = 1;
  while (next < today && k < 1200) {
    k++;
    next = addMonths(installedOn, intervalMonths * k);
  }
  return next;
}

export type ServiceState = "overdue" | "due" | "ok" | "unknown";
export function serviceState(nextDueOn: string | null, today: string, leadDays: number): ServiceState {
  if (!nextDueOn) return "unknown";
  if (nextDueOn < today) return "overdue";
  if (daysBetween(today, nextDueOn) <= leadDays) return "due";
  return "ok";
}

export type WarrantyState = "active" | "expiring" | "expired" | "unknown";
// Expiring = within the next 90 days.
export function warrantyState(expiresOn: string | null, today: string, soonDays = 90): WarrantyState {
  if (!expiresOn) return "unknown";
  if (expiresOn < today) return "expired";
  if (daysBetween(today, expiresOn) <= soonDays) return "expiring";
  return "active";
}

// When it's due for replacement (install date + the type's age), or null.
export function replacementDueDate(asset: Pick<Asset, "installed_on" | "install_year">, type: Pick<AssetType, "replace_after_years"> | null): string | null {
  const installed = assetInstalledDate(asset);
  if (!installed || !type?.replace_after_years) return null;
  return addMonths(installed, yearsToMonths(type.replace_after_years));
}

// The rows a new asset gets from its type: its service plan, and its
// warranties (from the price book item if given, else the type), dated
// from the install date. Ids are left to the caller.
export function assetDefaults(
  type: Pick<AssetType, "default_services" | "default_warranties">,
  installedOn: string | null,
  today: string,
  warranties?: AssetDefaultWarranty[] | null
): {
  services: { name: string; interval_months: number | null; next_due_on: string | null }[];
  warranties: { kind: AssetWarrantyKind; label: string; starts_on: string | null; expires_on: string | null }[];
} {
  return {
    services: (type.default_services ?? [])
      .filter((s) => s.name?.trim())
      .map((s) => ({ name: s.name.trim(), interval_months: s.interval_months ?? null, next_due_on: serviceNextDue(null, s.interval_months ?? null, installedOn, today) })),
    warranties: (warranties ?? type.default_warranties ?? []).map((w) => ({
      kind: w.kind === "workmanship" ? "workmanship" : "manufacturer",
      label: w.label ?? "",
      starts_on: installedOn,
      expires_on: installedOn && w.years ? addMonths(installedOn, yearsToMonths(w.years)) : null,
    })),
  };
}

// "hot water system" for a type name, for messages and lists.
export function assetLabel(asset: Pick<Asset, "asset_name">, type: Pick<AssetType, "name"> | null): string {
  if (type && type.name !== "Other") return /^[A-Z][a-z]/.test(type.name) ? type.name[0]!.toLowerCase() + type.name.slice(1) : type.name;
  return asset.asset_name;
}

// "Rheem Stellar 330 · SN 1234" - the identifying bits of an asset.
export function assetSummary(asset: Pick<Asset, "attributes">): string {
  const a = asset.attributes ?? {};
  return [[a.brand, a.model].filter(Boolean).join(" "), a.serial_number ? `SN ${a.serial_number}` : ""].filter(Boolean).join(" · ");
}

// What the JMS API can do. Each action is one REST endpoint and one MCP
// tool, described once here (the OpenAPI spec and the MCP tool list are
// both built from this). Every query is limited to the API key's own
// company by hand - the service-role client bypasses row-level security.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { customLine, lineFromPriceBookItem, type CrewRow, type MaterialRow } from "./pricing.ts";

export type Scope = "read" | "jobs" | "notes" | "quotes" | "messages";

export interface Ctx {
  db: SupabaseClient;
  tenantId: string;
  keyId: string;
  keyName: string;
  actorId: string | null;
  env: {
    supabaseUrl: string;
    serviceRoleKey: string;
    twilioSid: string;
    twilioToken: string;
    twilioApiBase: string;
  };
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

// deno-lint-ignore no-explicit-any
type Json = any;
type Schema = Record<string, unknown>;

export interface Action {
  name: string;
  title: string;
  description: string;
  scope: Scope;
  method: "GET" | "POST";
  path: string; // REST path; {param} segments come from the input
  input: Schema; // JSON Schema (object)
  readOnly: boolean;
  run: (ctx: Ctx, input: Json) => Promise<Json>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TZ = "Australia/Sydney";
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function need(cond: unknown, message: string, code = "invalid_input"): asserts cond {
  if (!cond) throw new ApiError(400, code, message);
}
function uuid(value: unknown, field: string): string {
  need(typeof value === "string" && uuidRe.test(value), `${field} must be an id (uuid) - look it up first`);
  return value as string;
}
function str(value: unknown, field: string, max = 500, required = true): string | null {
  if (value == null || value === "") {
    need(!required, `${field} is required`);
    return null;
  }
  need(typeof value === "string", `${field} must be text`);
  const t = (value as string).trim();
  need(!required || t.length > 0, `${field} is required`);
  need(t.length <= max, `${field} is too long (max ${max} characters)`);
  return t || null;
}
function num(value: unknown, field: string, min: number, max: number, fallback: number | null = null): number | null {
  if (value == null || value === "") return fallback;
  const n = typeof value === "string" ? Number(value) : value;
  need(typeof n === "number" && Number.isFinite(n), `${field} must be a number`);
  need((n as number) >= min && (n as number) <= max, `${field} must be between ${min} and ${max}`);
  return n as number;
}
// Strips what would break a PostgREST or() filter.
function searchTerm(value: unknown): string | null {
  const t = str(value, "query", 100, false);
  if (!t) return null;
  const clean = t.replace(/[,()*%\\"]/g, " ").replace(/\s+/g, " ").trim();
  return clean || null;
}
async function q<T = Json>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new ApiError(500, "database_error", error.message);
  return data as T;
}
const money = (cents: number | null | undefined) => (cents == null ? null : Math.round(Number(cents)) / 100);

export function sydneyDay(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
}
export function sydneyLabel(iso: string | null): string | null {
  if (!iso) return null;
  return new Intl.DateTimeFormat("en-AU", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}
function offsetMinutes(at: Date): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - at.getTime()) / 60000);
}
// "2026-12-03T09:00" (Sydney time) or a full ISO time with an offset/Z.
export function parseStart(value: unknown): Date {
  need(typeof value === "string" && value.trim(), "start is required, e.g. 2026-12-03T09:00 (Sydney time)");
  const v = (value as string).trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(v)) {
    const d = new Date(v);
    need(!Number.isNaN(d.getTime()), "start isn't a valid time");
    return d;
  }
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?$/);
  need(m, "start must look like 2026-12-03T09:00 (Sydney time)");
  const naive = Date.UTC(+m![1], +m![2] - 1, +m![3], +m![4], +m![5]);
  let guess = new Date(naive - offsetMinutes(new Date(naive)) * 60000);
  guess = new Date(naive - offsetMinutes(guess) * 60000);
  return guess;
}
function dayBounds(day: string): { start: Date; end: Date } {
  need(/^\d{4}-\d{2}-\d{2}$/.test(day), "date must look like 2026-12-03");
  const start = parseStart(`${day}T00:00`);
  const next = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10) + 1));
  const end = parseStart(`${next.toISOString().slice(0, 10)}T00:00`);
  return { start, end };
}
function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (raw.trim().startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.startsWith("0") && digits.length === 10) return `+61${digits.slice(1)}`;
  if (digits.startsWith("61") && digits.length === 11) return `+${digits}`;
  return null;
}
const address = (r: { address_line1?: string | null; suburb?: string | null; state?: string | null; postcode?: string | null } | null) =>
  r ? [r.address_line1, [r.suburb, r.state, r.postcode].filter(Boolean).join(" ")].filter((x) => x && String(x).trim()).join(", ") || null : null;

async function client(ctx: Ctx, id: string): Promise<Json> {
  const row = await q(ctx.db.from("clients").select("*").eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle());
  if (!row) throw new ApiError(404, "not_found", "No client with that id");
  return row;
}
async function job(ctx: Ctx, id: string): Promise<Json> {
  const row = await q(ctx.db.from("job_cards").select("*").eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle());
  if (!row) throw new ApiError(404, "not_found", "No job with that id");
  return row;
}
async function names(ctx: Ctx): Promise<Map<string, string>> {
  const rows = await q<Json[]>(ctx.db.from("profiles").select("id, full_name").eq("tenant_id", ctx.tenantId));
  return new Map(rows.map((p) => [p.id, p.full_name]));
}
async function stages(ctx: Ctx): Promise<Map<string, Json>> {
  const rows = await q<Json[]>(ctx.db.from("job_lifecycle_stages").select("id, name, position, is_closed").eq("tenant_id", ctx.tenantId));
  return new Map(rows.map((s) => [s.id, s]));
}
async function bookingsFor(ctx: Ctx, jobIds: string[]): Promise<Json[]> {
  if (jobIds.length === 0) return [];
  return await q<Json[]>(ctx.db.from("calendar_events").select("id, job_card_id, start_at, end_at").eq("tenant_id", ctx.tenantId).in("job_card_id", jobIds).order("start_at"));
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

const searchClients: Action = {
  name: "search_clients",
  title: "Search clients",
  description: "Find clients by name, phone, email, street or suburb. Returns up to `limit` matches (most recent first). Use get_client for the full record.",
  scope: "read",
  method: "GET",
  path: "/clients",
  readOnly: true,
  input: {
    type: "object",
    properties: {
      query: { type: "string", description: "Part of a name, phone number, email, street or suburb. Leave out to list recent clients." },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
    },
  },
  run: async (ctx, input) => {
    const term = searchTerm(input.query);
    const limit = num(input.limit, "limit", 1, 50, 20)!;
    let query = ctx.db.from("clients").select("id, name, company_name, phone, email, address_line1, suburb, state, postcode, client_type, marketing_opt_out, created_at").eq("tenant_id", ctx.tenantId);
    // A phone number is matched on its last digits whatever the spacing
    // ("0411000031" finds "0411 000 031"): the database narrows it down with
    // the digits in order, then it's checked exactly here.
    const digits = term ? term.replace(/\D/g, "") : "";
    const phoneSearch = digits.length >= 6 && digits.length >= term!.replace(/[\s+()-]/g, "").length - 1;
    const tail = digits.startsWith("61") && digits.length === 11 ? digits.slice(2) : digits.replace(/^0/, "");
    if (term) {
      const ors = ["name", "company_name", "email", "address_line1", "suburb"].map((c) => `${c}.ilike.*${term}*`);
      if (phoneSearch) ors.push(`phone.ilike.*${tail.split("").join("*")}*`);
      query = query.or(ors.join(","));
    }
    let rows = await q<Json[]>(query.order("created_at", { ascending: false }).limit(phoneSearch ? 200 : limit));
    if (phoneSearch) {
      rows = rows.filter((c) => String(c.phone ?? "").replace(/\D/g, "").endsWith(tail) || ["name", "company_name", "email", "address_line1", "suburb"].some((k) => String(c[k] ?? "").toLowerCase().includes(term!.toLowerCase()))).slice(0, limit);
    }
    return {
      clients: rows.map((c) => ({ id: c.id, name: c.name, company: c.company_name, phone: c.phone, email: c.email, address: address(c), type: c.client_type, opted_out_of_marketing: !!c.marketing_opt_out })),
    };
  },
};

const getClient: Action = {
  name: "get_client",
  title: "Get a client",
  description: "A client's full record: contact details, other addresses (sites), contacts, recent jobs, quotes and invoices (with what's owing), assets with service due dates, and recurring services.",
  scope: "read",
  method: "GET",
  path: "/clients/{client_id}",
  readOnly: true,
  input: { type: "object", required: ["client_id"], properties: { client_id: { type: "string", format: "uuid" } } },
  run: async (ctx, input) => {
    const id = uuid(input.client_id, "client_id");
    const c = await client(ctx, id);
    const [sites, contacts, jobs, quotes, invoices, assets, recurring, stageMap] = await Promise.all([
      q<Json[]>(ctx.db.from("client_sites").select("id, label, address_line1, suburb, state, postcode, is_primary, notes").eq("tenant_id", ctx.tenantId).eq("client_id", id)),
      q<Json[]>(ctx.db.from("client_contacts").select("id, name, role, email, phone, is_primary").eq("tenant_id", ctx.tenantId).eq("client_id", id)),
      q<Json[]>(ctx.db.from("job_cards").select("id, number, title, lifecycle_stage_id, site_id, assigned_technician_id, created_at").eq("tenant_id", ctx.tenantId).eq("client_id", id).order("created_at", { ascending: false }).limit(20)),
      q<Json[]>(ctx.db.from("quotes").select("id, quote_number, status, total_cents, issue_date, job_card_id").eq("tenant_id", ctx.tenantId).eq("client_id", id).order("created_at", { ascending: false }).limit(20)),
      q<Json[]>(ctx.db.from("invoices").select("id, invoice_number, status, total_cents, amount_paid_cents, issue_date, due_date, job_card_id").eq("tenant_id", ctx.tenantId).eq("client_id", id).order("created_at", { ascending: false }).limit(20)),
      q<Json[]>(ctx.db.from("property_assets").select("id, asset_name, attributes, installed_on, install_year, location, site_id").eq("tenant_id", ctx.tenantId).eq("client_id", id).eq("status", "active")),
      q<Json[]>(ctx.db.from("recurring_services").select("id, title, interval_count, interval_unit, next_due_on, status").eq("tenant_id", ctx.tenantId).eq("client_id", id)),
      stages(ctx),
    ]);
    const services = assets.length ? await q<Json[]>(ctx.db.from("asset_services").select("asset_id, name, next_due_on, last_done_on").eq("tenant_id", ctx.tenantId).in("asset_id", assets.map((a) => a.id))) : [];
    const bookings = await bookingsFor(ctx, jobs.map((j) => j.id));
    const now = new Date().toISOString();
    return {
      client: {
        id: c.id,
        name: c.name,
        first_name: c.first_name,
        last_name: c.last_name,
        company: c.company_name,
        type: c.client_type,
        phone: c.phone,
        email: c.email,
        address: address(c),
        notes: c.notes,
        opted_out_of_marketing: !!c.marketing_opt_out,
        client_since: c.created_at?.slice(0, 10),
      },
      sites: sites.map((s) => ({ id: s.id, label: s.label, address: address(s), is_primary: s.is_primary, notes: s.notes })),
      contacts,
      jobs: jobs.map((j) => {
        const next = bookings.find((b) => b.job_card_id === j.id && b.end_at >= now);
        return { id: j.id, number: j.number, title: j.title, stage: stageMap.get(j.lifecycle_stage_id)?.name ?? null, next_booking: next ? sydneyLabel(next.start_at) : null, created: j.created_at?.slice(0, 10) };
      }),
      quotes: quotes.map((x) => ({ id: x.id, number: x.quote_number, status: x.status, total: money(x.total_cents), issued: x.issue_date, job_id: x.job_card_id })),
      invoices: invoices.map((x) => ({
        id: x.id,
        number: x.invoice_number,
        status: x.status,
        total: money(x.total_cents),
        paid: money(x.amount_paid_cents),
        owing: x.status === "void" || x.status === "paid" ? 0 : money(Math.max(0, Number(x.total_cents) - Number(x.amount_paid_cents ?? 0))),
        issued: x.issue_date,
        due: x.due_date,
        job_id: x.job_card_id,
      })),
      assets: assets.map((a) => ({
        id: a.id,
        name: a.asset_name,
        details: a.attributes,
        installed: a.installed_on ?? (a.install_year ? String(a.install_year) : null),
        location: a.location,
        services: services.filter((s) => s.asset_id === a.id).map((s) => ({ name: s.name, last_done: s.last_done_on, next_due: s.next_due_on })),
      })),
      recurring_services: recurring.map((r) => ({ id: r.id, title: r.title, every: `${r.interval_count} ${r.interval_unit}${r.interval_count === 1 ? "" : "s"}`, next_due: r.next_due_on, status: r.status })),
    };
  },
};

const searchJobs: Action = {
  name: "search_jobs",
  title: "Search jobs",
  description:
    "Find jobs by title or job number, for a client, in a stage, or booked between two dates. Returns each job's client, stage, technician and next booking. Use get_job for notes and documents.",
  scope: "read",
  method: "GET",
  path: "/jobs",
  readOnly: true,
  input: {
    type: "object",
    properties: {
      query: { type: "string", description: "Part of the job title, or its number (e.g. J364)." },
      client_id: { type: "string", format: "uuid" },
      stage: { type: "string", description: "Stage name, e.g. Enquiry, To book, Scheduled. See list_team_and_stages." },
      booked_from: { type: "string", format: "date", description: "Only jobs booked on or after this day (YYYY-MM-DD)." },
      booked_to: { type: "string", format: "date", description: "Only jobs booked on or before this day (YYYY-MM-DD)." },
      open_only: { type: "boolean", default: false, description: "Leave out completed/closed jobs." },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
    },
  },
  run: async (ctx, input) => {
    const limit = num(input.limit, "limit", 1, 50, 20)!;
    const term = searchTerm(input.query);
    const stageMap = await stages(ctx);
    let query = ctx.db.from("job_cards").select("id, number, title, client_id, site_id, lifecycle_stage_id, assigned_technician_id, created_at, recurring_service_id").eq("tenant_id", ctx.tenantId);
    if (input.client_id) query = query.eq("client_id", uuid(input.client_id, "client_id"));
    if (term) query = query.or(`title.ilike.*${term}*,number.ilike.*${term}*`);
    if (input.stage) {
      const wanted = String(input.stage).trim().toLowerCase();
      const ids = [...stageMap.values()].filter((s) => s.name.toLowerCase() === wanted).map((s) => s.id);
      need(ids.length, `No stage called "${input.stage}". Stages: ${[...stageMap.values()].sort((a, b) => a.position - b.position).map((s) => s.name).join(", ")}`);
      query = query.in("lifecycle_stage_id", ids);
    }
    if (input.open_only) {
      const open = [...stageMap.values()].filter((s) => !s.is_closed).map((s) => s.id);
      query = query.in("lifecycle_stage_id", open.length ? open : ["00000000-0000-0000-0000-000000000000"]);
    }
    if (input.booked_from || input.booked_to) {
      let ev = ctx.db.from("calendar_events").select("job_card_id").eq("tenant_id", ctx.tenantId).not("job_card_id", "is", null);
      if (input.booked_from) ev = ev.gte("end_at", dayBounds(String(input.booked_from)).start.toISOString());
      if (input.booked_to) ev = ev.lt("start_at", dayBounds(String(input.booked_to)).end.toISOString());
      const ids = [...new Set((await q<Json[]>(ev.limit(1000))).map((e) => e.job_card_id))];
      query = query.in("id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
    }
    const rows = await q<Json[]>(query.order("created_at", { ascending: false }).limit(limit));
    const [people, clients, bookings] = await Promise.all([
      names(ctx),
      rows.length ? q<Json[]>(ctx.db.from("clients").select("id, name").eq("tenant_id", ctx.tenantId).in("id", [...new Set(rows.map((r) => r.client_id))])) : Promise.resolve([] as Json[]),
      bookingsFor(ctx, rows.map((r) => r.id)),
    ]);
    const now = new Date().toISOString();
    return {
      jobs: rows.map((j) => {
        const mine = bookings.filter((b) => b.job_card_id === j.id);
        const next = mine.find((b) => b.end_at >= now) ?? null;
        return {
          id: j.id,
          number: j.number,
          title: j.title,
          client: { id: j.client_id, name: clients.find((c) => c.id === j.client_id)?.name ?? null },
          stage: stageMap.get(j.lifecycle_stage_id)?.name ?? null,
          technician: j.assigned_technician_id ? people.get(j.assigned_technician_id) ?? null : null,
          booked: mine.length > 0,
          next_booking: next ? sydneyLabel(next.start_at) : null,
          recurring_visit: !!j.recurring_service_id,
          created: j.created_at?.slice(0, 10),
        };
      }),
    };
  },
};

const getJob: Action = {
  name: "get_job",
  title: "Get a job",
  description: "A job's full details: client and address, stage, technician, bookings, notes (newest first), and its quotes and invoices.",
  scope: "read",
  method: "GET",
  path: "/jobs/{job_id}",
  readOnly: true,
  input: { type: "object", required: ["job_id"], properties: { job_id: { type: "string", format: "uuid" } } },
  run: async (ctx, input) => {
    const id = uuid(input.job_id, "job_id");
    const j = await job(ctx, id);
    const [c, site, stageMap, people, bookings, notes, quotes, invoices, category] = await Promise.all([
      client(ctx, j.client_id),
      j.site_id ? q(ctx.db.from("client_sites").select("label, address_line1, suburb, state, postcode").eq("tenant_id", ctx.tenantId).eq("id", j.site_id).maybeSingle()) : Promise.resolve(null),
      stages(ctx),
      names(ctx),
      bookingsFor(ctx, [id]),
      q<Json[]>(ctx.db.from("job_notes").select("id, body, author_id, created_at").eq("tenant_id", ctx.tenantId).eq("job_card_id", id).order("created_at", { ascending: false }).limit(30)),
      q<Json[]>(ctx.db.from("quotes").select("id, quote_number, status, total_cents, issue_date").eq("tenant_id", ctx.tenantId).eq("job_card_id", id)),
      q<Json[]>(ctx.db.from("invoices").select("id, invoice_number, status, total_cents, amount_paid_cents, due_date").eq("tenant_id", ctx.tenantId).eq("job_card_id", id)),
      j.service_category_id ? q(ctx.db.from("service_categories").select("name").eq("tenant_id", ctx.tenantId).eq("id", j.service_category_id).maybeSingle()) : Promise.resolve(null),
    ]);
    return {
      job: {
        id: j.id,
        number: j.number,
        title: j.title,
        description: j.description,
        category: (category as Json)?.name ?? null,
        stage: stageMap.get(j.lifecycle_stage_id)?.name ?? null,
        technician: j.assigned_technician_id ? { id: j.assigned_technician_id, name: people.get(j.assigned_technician_id) ?? null } : null,
        address: address((site as Json) ?? c),
        site: site ? (site as Json).label : null,
        created: j.created_at?.slice(0, 10),
        completed_at: j.completed_at,
        recurring_visit_due: j.recurring_due_on ?? null,
      },
      client: { id: c.id, name: c.name, phone: c.phone, email: c.email },
      bookings: bookings.map((b) => ({ id: b.id, start: b.start_at, end: b.end_at, when: sydneyLabel(b.start_at) })),
      notes: notes.map((n) => ({ id: n.id, note: n.body, by: n.author_id ? people.get(n.author_id) ?? null : null, at: n.created_at })),
      quotes: quotes.map((x) => ({ id: x.id, number: x.quote_number, status: x.status, total: money(x.total_cents), issued: x.issue_date })),
      invoices: invoices.map((x) => ({ id: x.id, number: x.invoice_number, status: x.status, total: money(x.total_cents), owing: x.status === "void" || x.status === "paid" ? 0 : money(Math.max(0, Number(x.total_cents) - Number(x.amount_paid_cents ?? 0))), due: x.due_date })),
    };
  },
};

const teamAndStages: Action = {
  name: "list_team_and_stages",
  title: "List the team, job stages and categories",
  description: "Everyone in the company (id, name, role) - use a technician's id to book a job - plus the job stages and service categories.",
  scope: "read",
  method: "GET",
  path: "/team",
  readOnly: true,
  input: { type: "object", properties: {} },
  run: async (ctx) => {
    const [people, stageRows, categories] = await Promise.all([
      q<Json[]>(ctx.db.from("profiles").select("id, full_name, role, job_title, phone").eq("tenant_id", ctx.tenantId).order("full_name")),
      q<Json[]>(ctx.db.from("job_lifecycle_stages").select("name, position, is_closed").eq("tenant_id", ctx.tenantId).order("position")),
      q<Json[]>(ctx.db.from("service_categories").select("id, name").eq("tenant_id", ctx.tenantId).order("name")),
    ]);
    return {
      team: people.map((p) => ({ id: p.id, name: p.full_name, role: p.role, job_title: p.job_title })),
      job_stages: stageRows.map((s) => ({ name: s.name, closed: s.is_closed })),
      service_categories: categories,
    };
  },
};

const availability: Action = {
  name: "check_availability",
  title: "Check who's free on a day",
  description:
    "Everyone's bookings on a day (Sydney time) and their free gaps between 7am and 5pm. Bookings are jobs on the calendar (counted against the job's technician) and personal calendar events.",
  scope: "read",
  method: "GET",
  path: "/availability",
  readOnly: true,
  input: {
    type: "object",
    required: ["date"],
    properties: {
      date: { type: "string", format: "date", description: "YYYY-MM-DD" },
      technician_id: { type: "string", format: "uuid", description: "Only this person." },
    },
  },
  run: async (ctx, input) => {
    const day = String(input.date ?? "").trim();
    const { start, end } = dayBounds(day);
    const people = await q<Json[]>(ctx.db.from("profiles").select("id, full_name, role").eq("tenant_id", ctx.tenantId).order("full_name"));
    const events = await q<Json[]>(
      ctx.db.from("calendar_events").select("id, title, start_at, end_at, all_day, job_card_id, owner_profile_id").eq("tenant_id", ctx.tenantId).lt("start_at", end.toISOString()).gt("end_at", start.toISOString()).order("start_at")
    );
    const jobIds = [...new Set(events.map((e) => e.job_card_id).filter(Boolean))];
    const jobs = jobIds.length ? await q<Json[]>(ctx.db.from("job_cards").select("id, number, title, assigned_technician_id").eq("tenant_id", ctx.tenantId).in("id", jobIds)) : [];
    const who = (e: Json) => (e.job_card_id ? jobs.find((j) => j.id === e.job_card_id)?.assigned_technician_id ?? null : e.owner_profile_id ?? null);
    const workStart = parseStart(`${day}T07:00`).getTime();
    const workEnd = parseStart(`${day}T17:00`).getTime();
    const time = (ms: number) => new Intl.DateTimeFormat("en-AU", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(new Date(ms));
    const list = input.technician_id ? people.filter((p) => p.id === uuid(input.technician_id, "technician_id")) : people;
    return {
      date: day,
      people: list.map((p) => {
        const busy = events.filter((e) => who(e) === p.id);
        const blocks = busy
          .map((e) => [Math.max(new Date(e.start_at).getTime(), workStart), Math.min(new Date(e.end_at).getTime(), workEnd)] as [number, number])
          .filter(([a, b]) => b > a)
          .sort((a, b) => a[0] - b[0]);
        const free: string[] = [];
        let cursor = workStart;
        for (const [a, b] of blocks) {
          if (a > cursor) free.push(`${time(cursor)}-${time(a)}`);
          cursor = Math.max(cursor, b);
        }
        if (cursor < workEnd) free.push(`${time(cursor)}-${time(workEnd)}`);
        return {
          id: p.id,
          name: p.full_name,
          role: p.role,
          bookings: busy.map((e) => {
            const jb = e.job_card_id ? jobs.find((j) => j.id === e.job_card_id) : null;
            return { from: time(new Date(e.start_at).getTime()), to: time(new Date(e.end_at).getTime()), title: e.title, job: jb ? { id: jb.id, number: jb.number } : null, all_day: e.all_day };
          }),
          free_7am_to_5pm: free,
        };
      }),
      unassigned_job_bookings: events
        .filter((e) => e.job_card_id && !who(e))
        .map((e) => ({ title: e.title, from: sydneyLabel(e.start_at), job_id: e.job_card_id })),
    };
  },
};

const searchPriceBook: Action = {
  name: "search_price_book",
  title: "Search the price book",
  description: "Find price book items to quote with. Prices are each, excluding GST. Pass an item's id to create_draft_quote to use its current price.",
  scope: "read",
  method: "GET",
  path: "/price-book",
  readOnly: true,
  input: {
    type: "object",
    properties: {
      query: { type: "string", description: "Part of the item's description." },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
    },
  },
  run: async (ctx, input) => {
    const term = searchTerm(input.query);
    const limit = num(input.limit, "limit", 1, 50, 20)!;
    let query = ctx.db.from("price_book_items").select("*").eq("tenant_id", ctx.tenantId);
    if (term) query = query.ilike("description", `%${term}%`);
    const rows = await q<Json[]>(query.order("description").limit(limit));
    const itemized = rows.filter((r) => r.pricing_model === "itemized").map((r) => r.id);
    const [crew, materials] = itemized.length
      ? await Promise.all([
          q<Json[]>(ctx.db.from("price_book_item_crew").select("*").in("price_book_item_id", itemized)),
          q<Json[]>(ctx.db.from("price_book_item_materials").select("*").in("price_book_item_id", itemized)),
        ])
      : [[], []];
    return {
      items: rows.map((r) => {
        const line = lineFromPriceBookItem(r, { crew: crew.filter((c) => c.price_book_item_id === r.id) as CrewRow[], materials: materials.filter((m) => m.price_book_item_id === r.id) as MaterialRow[] }, null);
        return { id: r.id, description: r.description, unit: r.unit, price_ex_gst: money(line.unit_price_cents), gst: !!(r.gst_applicable ?? true), priced_for_quantity: Number(line.quantity) };
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

const createJob: Action = {
  name: "create_job",
  title: "Create a job",
  description: "Create a new job for an existing client (e.g. from an enquiry). It starts in the first stage (Enquiry). Book it with schedule_job.",
  scope: "jobs",
  method: "POST",
  path: "/jobs",
  readOnly: false,
  input: {
    type: "object",
    required: ["client_id", "title"],
    properties: {
      client_id: { type: "string", format: "uuid" },
      title: { type: "string", maxLength: 200, description: "Short title, e.g. 'Leaking roof over kitchen'." },
      description: { type: "string", maxLength: 5000 },
      site_id: { type: "string", format: "uuid", description: "One of the client's other addresses (sites); leave out for their main address." },
      category: { type: "string", description: "Service category name (see list_team_and_stages)." },
    },
  },
  run: async (ctx, input) => {
    const clientId = uuid(input.client_id, "client_id");
    await client(ctx, clientId);
    const title = str(input.title, "title", 200)!;
    const description = str(input.description, "description", 5000, false);
    let siteId: string | null = null;
    if (input.site_id) {
      siteId = uuid(input.site_id, "site_id");
      const site = await q(ctx.db.from("client_sites").select("id").eq("tenant_id", ctx.tenantId).eq("client_id", clientId).eq("id", siteId).maybeSingle());
      need(site, "That site isn't one of this client's addresses");
    }
    let categoryId: string | null = null;
    if (input.category) {
      const cats = await q<Json[]>(ctx.db.from("service_categories").select("id, name").eq("tenant_id", ctx.tenantId));
      const hit = cats.find((c) => c.name.toLowerCase() === String(input.category).trim().toLowerCase());
      need(hit, `No category called "${input.category}". Categories: ${cats.map((c) => c.name).join(", ") || "none"}`);
      categoryId = hit.id;
    }
    const row = await q<Json>(
      ctx.db.from("job_cards").insert({ tenant_id: ctx.tenantId, client_id: clientId, site_id: siteId, title, description, service_category_id: categoryId, created_by: ctx.actorId }).select("id, number, title, lifecycle_stage_id").single()
    );
    const stageMap = await stages(ctx);
    return { job: { id: row.id, number: row.number, title: row.title, stage: stageMap.get(row.lifecycle_stage_id)?.name ?? null } };
  },
};

const scheduleJob: Action = {
  name: "schedule_job",
  title: "Book a job",
  description:
    "Put a job on the calendar at a time (Sydney time) and optionally assign the technician - the same as booking it in Dispatch. Check check_availability first. Returns any clashes in that technician's day. Set move_existing to move the job's next booking instead of adding another.",
  scope: "jobs",
  method: "POST",
  path: "/jobs/{job_id}/bookings",
  readOnly: false,
  input: {
    type: "object",
    required: ["job_id", "start"],
    properties: {
      job_id: { type: "string", format: "uuid" },
      start: { type: "string", description: "Start time, e.g. 2026-12-03T09:00 (Sydney time), or an ISO time with offset." },
      duration_minutes: { type: "integer", minimum: 15, maximum: 720, default: 120 },
      technician_id: { type: "string", format: "uuid", description: "Assign this person to the job (see list_team_and_stages)." },
      move_existing: { type: "boolean", default: false },
    },
  },
  run: async (ctx, input) => {
    const id = uuid(input.job_id, "job_id");
    const j = await job(ctx, id);
    const start = parseStart(input.start);
    need(start.getTime() > Date.now() - 24 * 3600 * 1000, "That time is in the past");
    const duration = num(input.duration_minutes, "duration_minutes", 15, 720, 120)!;
    const end = new Date(start.getTime() + duration * 60000);
    let techId: string | null = j.assigned_technician_id;
    if (input.technician_id) {
      techId = uuid(input.technician_id, "technician_id");
      const person = await q(ctx.db.from("profiles").select("id").eq("tenant_id", ctx.tenantId).eq("id", techId).maybeSingle());
      need(person, "No one in the team has that technician_id");
    }
    let bookingId: string;
    let moved = false;
    if (input.move_existing) {
      const next = (await bookingsFor(ctx, [id])).find((b) => b.end_at >= new Date().toISOString());
      need(next, "This job has no upcoming booking to move - leave out move_existing to add one");
      await q(ctx.db.from("calendar_events").update({ start_at: start.toISOString(), end_at: end.toISOString() }).eq("tenant_id", ctx.tenantId).eq("id", next.id).select("id"));
      bookingId = next.id;
      moved = true;
    } else {
      const ev = await q<Json>(
        ctx.db
          .from("calendar_events")
          .insert({ tenant_id: ctx.tenantId, title: j.title, start_at: start.toISOString(), end_at: end.toISOString(), all_day: false, job_card_id: id, created_by: ctx.actorId })
          .select("id")
          .single()
      );
      bookingId = ev.id;
    }
    if (techId !== j.assigned_technician_id) {
      await q(ctx.db.from("job_cards").update({ assigned_technician_id: techId }).eq("tenant_id", ctx.tenantId).eq("id", id).select("id"));
    }
    // Clashes: the technician's other bookings overlapping this one.
    let clashes: Json[] = [];
    if (techId) {
      const overlapping = await q<Json[]>(
        ctx.db.from("calendar_events").select("id, title, start_at, end_at, job_card_id, owner_profile_id").eq("tenant_id", ctx.tenantId).lt("start_at", end.toISOString()).gt("end_at", start.toISOString()).neq("id", bookingId)
      );
      const jobIds = overlapping.map((o) => o.job_card_id).filter(Boolean);
      const jobs = jobIds.length ? await q<Json[]>(ctx.db.from("job_cards").select("id, assigned_technician_id").in("id", jobIds)) : [];
      clashes = overlapping
        .filter((o) => (o.job_card_id ? jobs.find((x) => x.id === o.job_card_id)?.assigned_technician_id === techId : o.owner_profile_id === techId))
        .map((o) => ({ title: o.title, when: sydneyLabel(o.start_at), job_id: o.job_card_id }));
    }
    return {
      booking: { id: bookingId, job_id: id, start: start.toISOString(), end: end.toISOString(), when: sydneyLabel(start.toISOString()), moved },
      technician_id: techId,
      clashes,
      note: "It reaches Google Calendar within the hour.",
    };
  },
};

const addJobNote: Action = {
  name: "add_job_note",
  title: "Add a job note",
  description: "Add a note to a job (shown in the job's notes in JMS and on the phone).",
  scope: "notes",
  method: "POST",
  path: "/jobs/{job_id}/notes",
  readOnly: false,
  input: {
    type: "object",
    required: ["job_id", "note"],
    properties: { job_id: { type: "string", format: "uuid" }, note: { type: "string", maxLength: 5000 } },
  },
  run: async (ctx, input) => {
    const id = uuid(input.job_id, "job_id");
    await job(ctx, id);
    const body = str(input.note, "note", 5000)!;
    const row = await q<Json>(ctx.db.from("job_notes").insert({ tenant_id: ctx.tenantId, job_card_id: id, author_id: ctx.actorId, body: `${body}\n\n- via ${ctx.keyName}` }).select("id, created_at").single());
    return { note: { id: row.id, job_id: id, at: row.created_at } };
  },
};

const createDraftQuote: Action = {
  name: "create_draft_quote",
  title: "Create a draft quote",
  description:
    "Create a DRAFT quote for a client (optionally for a job). It is never sent - someone checks and sends it in JMS. Each line is either a price book item (by id, at its current price) or a typed line with a description and price each (ex GST).",
  scope: "quotes",
  method: "POST",
  path: "/quotes",
  readOnly: false,
  input: {
    type: "object",
    required: ["client_id", "line_items"],
    properties: {
      client_id: { type: "string", format: "uuid" },
      job_id: { type: "string", format: "uuid", description: "The job it's for (must be this client's)." },
      notes: { type: "string", maxLength: 5000, description: "Job summary shown on the quote." },
      expiry_days: { type: "integer", minimum: 1, maximum: 365, default: 30 },
      line_items: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          properties: {
            price_book_item_id: { type: "string", format: "uuid", description: "Use this price book item (search_price_book)." },
            description: { type: "string", maxLength: 1000, description: "For a typed line, or to reword a price book item." },
            quantity: { type: "number", exclusiveMinimum: 0, default: 1 },
            unit_price: { type: "number", minimum: 0, description: "Price each in dollars, excluding GST - for a typed line." },
            gst: { type: "boolean", default: true, description: "For a typed line." },
          },
        },
      },
    },
  },
  run: async (ctx, input) => {
    const clientId = uuid(input.client_id, "client_id");
    const c = await client(ctx, clientId);
    let jobId: string | null = null;
    let siteId: string | null = null;
    if (input.job_id) {
      jobId = uuid(input.job_id, "job_id");
      const j = await job(ctx, jobId);
      need(j.client_id === clientId, "That job belongs to a different client");
      siteId = j.site_id;
    }
    need(Array.isArray(input.line_items) && input.line_items.length > 0, "line_items needs at least one line");
    need(input.line_items.length <= 50, "At most 50 lines");
    const pbIds = input.line_items.filter((l: Json) => l?.price_book_item_id).map((l: Json) => uuid(l.price_book_item_id, "price_book_item_id"));
    const [pb, crew, materials] = pbIds.length
      ? await Promise.all([
          q<Json[]>(ctx.db.from("price_book_items").select("*").eq("tenant_id", ctx.tenantId).in("id", pbIds)),
          q<Json[]>(ctx.db.from("price_book_item_crew").select("*").in("price_book_item_id", pbIds).order("sort_order")),
          q<Json[]>(ctx.db.from("price_book_item_materials").select("*").in("price_book_item_id", pbIds).order("sort_order")),
        ])
      : [[], [], []];
    const items = input.line_items.map((l: Json, i: number) => {
      need(l && typeof l === "object", `Line ${i + 1} is empty`);
      const qty = num(l.quantity, `line ${i + 1} quantity`, 0.01, 100000, null);
      let line: Json;
      if (l.price_book_item_id) {
        const item = pb.find((p) => p.id === l.price_book_item_id);
        need(item, `Line ${i + 1}: no price book item with that id`);
        line = lineFromPriceBookItem(item, { crew: crew.filter((x) => x.price_book_item_id === item.id), materials: materials.filter((x) => x.price_book_item_id === item.id) }, qty);
        const reworded = str(l.description, `line ${i + 1} description`, 1000, false);
        if (reworded) line.description = reworded;
      } else {
        const description = str(l.description, `line ${i + 1} description`, 1000)!;
        const price = num(l.unit_price, `line ${i + 1} unit_price`, 0, 1000000, null);
        need(price != null, `Line ${i + 1}: give a unit_price (dollars ex GST) or a price_book_item_id`);
        line = customLine(description, qty ?? 1, Math.round(price! * 100), l.gst !== false);
      }
      return { ...line, sort_order: i, is_optional: false, is_included: true, waived_amount_cents: 0 };
    });
    const today = sydneyDay();
    const expiryDays = num(input.expiry_days, "expiry_days", 1, 365, 30)!;
    const expiry = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10) + expiryDays)).toISOString().slice(0, 10);
    const quote = await q<Json>(
      ctx.db
        .from("quotes")
        .insert({ tenant_id: ctx.tenantId, client_id: clientId, job_card_id: jobId, site_id: siteId, status: "draft", issue_date: today, expiry_date: expiry, notes: str(input.notes, "notes", 5000, false), created_by: ctx.actorId })
        .select("id")
        .single()
    );
    const { error } = await ctx.db.rpc("replace_quote_line_items", { p_quote_id: quote.id, p_items: items, p_options: null });
    if (error) {
      await ctx.db.from("quotes").delete().eq("id", quote.id);
      throw new ApiError(400, "invalid_input", `Couldn't save the lines: ${error.message}`);
    }
    const saved = await q<Json>(ctx.db.from("quotes").select("id, quote_number, status, subtotal_cents, gst_cents, total_cents, expiry_date").eq("id", quote.id).single());
    return {
      quote: {
        id: saved.id,
        number: saved.quote_number,
        status: saved.status,
        client: c.name,
        job_id: jobId,
        subtotal: money(saved.subtotal_cents),
        gst: money(saved.gst_cents),
        total: money(saved.total_cents),
        expires: saved.expiry_date,
        lines: items.map((l: Json) => ({ description: l.description, quantity: Number(l.quantity), price_each_ex_gst: money(l.unit_price_cents), gst: l.gst_applicable })),
      },
      note: "Draft only - check and send it from JMS.",
    };
  },
};

// Who a message can go to: the client's own number/email or one of their
// contacts', or someone in the team.
async function recipients(ctx: Ctx, clientId: string | null): Promise<{ phones: Map<string, string | null>; emails: Map<string, string | null> }> {
  const phones = new Map<string, string | null>();
  const emails = new Map<string, string | null>();
  if (clientId) {
    const c = await client(ctx, clientId);
    const contacts = await q<Json[]>(ctx.db.from("client_contacts").select("phone, email").eq("tenant_id", ctx.tenantId).eq("client_id", clientId));
    for (const p of [c.phone, ...contacts.map((x) => x.phone)]) if (toE164(p)) phones.set(toE164(p)!, clientId);
    for (const e of [c.email, ...contacts.map((x) => x.email)]) if (e && e.includes("@")) emails.set(e.trim().toLowerCase(), clientId);
  }
  const team = await q<Json[]>(ctx.db.from("profiles").select("phone, email").eq("tenant_id", ctx.tenantId));
  for (const t of team) {
    if (toE164(t.phone) && !phones.has(toE164(t.phone)!)) phones.set(toE164(t.phone)!, null);
    if (t.email && !emails.has(t.email.toLowerCase())) emails.set(t.email.toLowerCase(), null);
  }
  return { phones, emails };
}

const sendSms: Action = {
  name: "send_sms",
  title: "Send a text",
  description:
    "Text a client (their mobile, or one of their contacts') or someone in the team, from the business SMS number. It's logged in Channels so replies thread there. Clients who've opted out (STOP) aren't texted.",
  scope: "messages",
  method: "POST",
  path: "/messages/sms",
  readOnly: false,
  input: {
    type: "object",
    required: ["body"],
    properties: {
      client_id: { type: "string", format: "uuid", description: "Text this client's mobile (or `to`, one of their contacts' numbers)." },
      to: { type: "string", description: "A mobile number belonging to the client, their contacts, or the team." },
      body: { type: "string", maxLength: 1000 },
    },
  },
  run: async (ctx, input) => {
    const clientId = input.client_id ? uuid(input.client_id, "client_id") : null;
    need(clientId || input.to, "Give a client_id or a `to` number");
    const body = str(input.body, "body", 1000)!;
    const { phones } = await recipients(ctx, clientId);
    let to: string | null;
    if (input.to) {
      to = toE164(String(input.to));
      need(to, "`to` isn't a valid Australian mobile number");
      need(phones.has(to!), "That number isn't on the client, their contacts or the team - texts only go to people already in JMS");
    } else {
      const c = await client(ctx, clientId!);
      to = toE164(c.phone);
      need(to, "This client has no mobile number in JMS");
    }
    const owner = clientId ?? phones.get(to!) ?? null;
    if (owner) {
      const c = await client(ctx, owner);
      if (c.marketing_opt_out) throw new ApiError(409, "opted_out", `${c.name} has opted out of texts (STOP) - not sent`);
    }
    const tenant = await q<Json>(ctx.db.from("tenants").select("sms_phone_number").eq("id", ctx.tenantId).single());
    if (!tenant.sms_phone_number) throw new ApiError(409, "sms_not_configured", "No SMS number is set up in Company Settings");
    if (!ctx.env.twilioSid || !ctx.env.twilioToken) throw new ApiError(503, "sms_not_configured", "Texting isn't set up on the server (Twilio)");
    const res = await fetch(`${ctx.env.twilioApiBase}/2010-04-01/Accounts/${ctx.env.twilioSid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`${ctx.env.twilioSid}:${ctx.env.twilioToken}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ From: tenant.sms_phone_number, To: to!, Body: body, StatusCallback: `${ctx.env.supabaseUrl}/functions/v1/twilio-status-callback` }),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (result?.code === 21610) throw new ApiError(409, "opted_out", "They've replied STOP to texts from this number - not sent");
      throw new ApiError(502, "send_failed", result?.message ?? `Twilio said ${res.status}`);
    }
    // Log it in Channels, like a text sent from JMS.
    let conversation = await q<Json>(ctx.db.from("channel_conversations").select("id, client_id").eq("tenant_id", ctx.tenantId).eq("channel_type", "sms").eq("external_contact", to).maybeSingle());
    if (!conversation) {
      conversation = await q<Json>(
        ctx.db.from("channel_conversations").insert({ tenant_id: ctx.tenantId, channel_type: "sms", external_contact: to, client_id: owner, last_message_at: new Date().toISOString() }).select("id, client_id").single()
      );
    } else if (owner && !conversation.client_id) {
      await ctx.db.from("channel_conversations").update({ client_id: owner }).eq("id", conversation.id);
    }
    await q(
      ctx.db.from("channel_messages").insert({ conversation_id: conversation.id, tenant_id: ctx.tenantId, direction: "outbound", body, media: [], external_message_id: result.sid, status: "sent", sent_by: ctx.actorId }).select("id")
    );
    await ctx.db.from("channel_conversations").update({ last_message_at: new Date().toISOString(), last_message_preview: body.slice(0, 200) }).eq("id", conversation.id);
    return { sent: true, to, conversation_id: conversation.id };
  },
};

const sendEmail: Action = {
  name: "send_email",
  title: "Send an email",
  description:
    "Email a client (their email, or one of their contacts') or someone in the team, from the business email, the same way JMS sends emails (it shows in the client's communication log).",
  scope: "messages",
  method: "POST",
  path: "/messages/email",
  readOnly: false,
  input: {
    type: "object",
    required: ["subject", "body"],
    properties: {
      client_id: { type: "string", format: "uuid" },
      to: { type: "string", description: "An email belonging to the client, their contacts, or the team." },
      subject: { type: "string", maxLength: 200 },
      body: { type: "string", maxLength: 20000, description: "Plain text." },
    },
  },
  run: async (ctx, input) => {
    const clientId = input.client_id ? uuid(input.client_id, "client_id") : null;
    need(clientId || input.to, "Give a client_id or a `to` email");
    const subject = str(input.subject, "subject", 200)!;
    const body = str(input.body, "body", 20000)!;
    const { emails } = await recipients(ctx, clientId);
    let to: string;
    if (input.to) {
      to = String(input.to).trim().toLowerCase();
      need(emails.has(to), "That email isn't on the client, their contacts or the team - emails only go to people already in JMS");
    } else {
      const c = await client(ctx, clientId!);
      need(c.email && c.email.includes("@"), "This client has no email in JMS");
      to = c.email.trim();
    }
    const owner = clientId ?? emails.get(to.toLowerCase()) ?? null;
    const row = await q<Json>(
      ctx.db
        .from("scheduled_communications")
        .insert({
          tenant_id: ctx.tenantId,
          entity_type: "client",
          entity_id: owner ?? ctx.tenantId,
          trigger_key: "api_email",
          channel: "email",
          recipient_phone_or_email: to,
          rendered_subject: subject,
          rendered_body: body,
          scheduled_for: new Date().toISOString(),
          status: "pending",
        })
        .select("id")
        .single()
    );
    // Send it now rather than at the next scheduled run: called with the
    // service key, process-scheduled-comms runs its sweep, which picks this
    // row up straight away (it's due now).
    let sentNow = false;
    try {
      const r = await fetch(`${ctx.env.supabaseUrl}/functions/v1/process-scheduled-comms`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ctx.env.serviceRoleKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id }),
      });
      sentNow = r.ok;
    } catch {
      sentNow = false;
    }
    return { queued: true, sent_now: sentNow, to, id: row.id };
  },
};

export const ACTIONS: Action[] = [
  searchClients,
  getClient,
  searchJobs,
  getJob,
  teamAndStages,
  availability,
  searchPriceBook,
  createJob,
  scheduleJob,
  addJobNote,
  createDraftQuote,
  sendSms,
  sendEmail,
];

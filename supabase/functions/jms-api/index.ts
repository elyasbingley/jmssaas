// JMS API for outside tools (Nebula, other AI agents, scripts). See
// docs/SETUP.md section 103 and the api_keys migration.
//
//   GET  /jms-api/openapi.json   the OpenAPI spec (no key needed)
//   POST /jms-api/mcp            MCP server (streamable HTTP, JSON responses)
//   GET|POST /jms-api/...        REST - one endpoint per action (actions.ts)
//
// Every call except the spec needs an API key from Settings > API keys:
// "Authorization: Bearer jms_..." (or "x-api-key: jms_..."). A key only
// reaches its own company, only does what it was given permission for, is
// limited to 120 calls a minute, and every call is logged.
//
// Deploy with --no-verify-jwt: the key, not a Supabase login, is the auth.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { ACTIONS, ApiError, type Action, type Ctx, type Scope } from "./actions.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
const TWILIO_API_BASE = Deno.env.get("TWILIO_API_BASE") ?? "https://api.twilio.com";
// Where the API is reached from outside (for the spec's server URL).
const PUBLIC_URL = (Deno.env.get("JMS_API_PUBLIC_URL") ?? `${SUPABASE_URL}/functions/v1/jms-api`).replace(/\/$/, "");
const RATE_LIMIT_PER_MINUTE = Number(Deno.env.get("JMS_API_RATE_LIMIT") ?? "120");
const VERSION = "1.0.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type, mcp-protocol-version, mcp-session-id",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json", ...CORS, ...extra } });
}
function apiError(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

const SCOPE_LABELS: Record<Scope, string> = {
  read: "look up clients, jobs, quotes, invoices, the price book and the team",
  jobs: "create and book jobs",
  notes: "add job notes",
  quotes: "create draft quotes",
  messages: "text and email clients",
};

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

interface Key {
  id: string;
  tenant_id: string;
  name: string;
  scopes: Scope[];
  created_by: string | null;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function authenticate(db: SupabaseClient, req: Request): Promise<Key | Response> {
  const header = req.headers.get("authorization") ?? "";
  const raw = (header.toLowerCase().startsWith("bearer ") ? header.slice(7) : req.headers.get("x-api-key") ?? "").trim();
  if (!raw.startsWith("jms_")) return apiError(401, "unauthorized", "Send your JMS API key as 'Authorization: Bearer jms_...' (create one in JMS: Settings > API keys).");
  const { data: key } = await db.from("api_keys").select("id, tenant_id, name, scopes, created_by, revoked_at, last_used_at").eq("key_hash", await sha256Hex(raw)).maybeSingle();
  if (!key || key.revoked_at) return apiError(401, "unauthorized", "That API key isn't valid or has been revoked.");
  // Rate limit: calls logged in the last minute.
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count } = await db.from("api_request_log").select("id", { count: "exact", head: true }).eq("api_key_id", key.id).gte("created_at", since);
  if ((count ?? 0) >= RATE_LIMIT_PER_MINUTE) return apiError(429, "rate_limited", `Too many calls - at most ${RATE_LIMIT_PER_MINUTE} a minute.`);
  if (!key.last_used_at || Date.now() - new Date(key.last_used_at).getTime() > 60_000) {
    await db.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", key.id);
  }
  return key as Key;
}

function ctxFor(db: SupabaseClient, key: Key): Ctx {
  return {
    db,
    tenantId: key.tenant_id,
    keyId: key.id,
    keyName: key.name,
    actorId: key.created_by,
    env: { supabaseUrl: SUPABASE_URL, serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY, twilioSid: TWILIO_ACCOUNT_SID, twilioToken: TWILIO_AUTH_TOKEN, twilioApiBase: TWILIO_API_BASE },
  };
}

function summarise(action: Action, input: Record<string, unknown>, result: unknown, error: ApiError | null): string {
  if (error) return error.message.slice(0, 300);
  const ids = ["client_id", "job_id", "date", "query"].filter((k) => input[k]).map((k) => `${k}=${String(input[k]).slice(0, 60)}`);
  // deno-lint-ignore no-explicit-any
  const r = result as any;
  const made = r?.quote?.number ?? r?.job?.number ?? r?.booking?.when ?? (r?.sent ? `to ${r.to}` : null) ?? (r?.queued ? `to ${r.to}` : null);
  return [action.title, ...ids, made].filter(Boolean).join(" · ").slice(0, 300);
}

// Runs one action for a key: permission check, the action, the log line.
async function perform(db: SupabaseClient, key: Key, action: Action, input: Record<string, unknown>, via: "rest" | "mcp"): Promise<{ status: number; body: unknown; error: ApiError | null }> {
  let status = 200;
  let body: unknown;
  let error: ApiError | null = null;
  if (!key.scopes.includes(action.scope)) {
    error = new ApiError(403, "forbidden", `This API key can't ${SCOPE_LABELS[action.scope]}. An admin can create a key with that permission in JMS: Settings > API keys.`);
  } else {
    try {
      body = await action.run(ctxFor(db, key), input);
      if (action.method === "POST") status = 201;
    } catch (e) {
      error = e instanceof ApiError ? e : new ApiError(500, "server_error", e instanceof Error ? e.message : String(e));
      if (!(e instanceof ApiError)) console.error(`[jms-api] ${action.name} failed`, e);
    }
  }
  if (error) {
    status = error.status;
    body = { error: { code: error.code, message: error.message } };
  }
  await db.from("api_request_log").insert({ tenant_id: key.tenant_id, api_key_id: key.id, action: action.name, via, ok: !error, status, summary: summarise(action, input, body, error) });
  return { status, body, error };
}

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

function matchRoute(method: string, path: string): { action: Action; params: Record<string, string> } | null {
  for (const action of ACTIONS) {
    if (action.method !== method) continue;
    const pattern = new RegExp("^" + action.path.replace(/\{(\w+)\}/g, "(?<$1>[^/]+)") + "/?$");
    const m = path.match(pattern);
    if (m) return { action, params: { ...(m.groups ?? {}) } };
  }
  return null;
}

function queryInput(url: URL, action: Action): Record<string, unknown> {
  const props = (action.input.properties ?? {}) as Record<string, { type?: string }>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of url.searchParams) {
    const t = props[k]?.type;
    out[k] = t === "integer" || t === "number" ? Number(v) : t === "boolean" ? v === "true" || v === "1" : v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// OpenAPI
// ---------------------------------------------------------------------------

function openApiSpec(): unknown {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const a of ACTIONS) {
    const props = (a.input.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = (a.input.required ?? []) as string[];
    const pathParams = [...a.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    const parameters = pathParams.map((p) => ({ name: p, in: "path", required: true, schema: props[p] ?? { type: "string" } }));
    const op: Record<string, unknown> = {
      operationId: a.name,
      summary: a.title,
      description: `${a.description}\n\nNeeds the "${a.scope}" permission.`,
      tags: [a.readOnly ? "Look up" : a.scope === "messages" ? "Messages" : "Make changes"],
      responses: {
        [a.method === "POST" ? "201" : "200"]: { description: "OK", content: { "application/json": { schema: { type: "object" } } } },
        "400": { $ref: "#/components/responses/Error" },
        "401": { $ref: "#/components/responses/Error" },
        "403": { $ref: "#/components/responses/Error" },
        "404": { $ref: "#/components/responses/Error" },
        "429": { $ref: "#/components/responses/Error" },
      },
    };
    if (a.method === "GET") {
      for (const [name, schema] of Object.entries(props)) {
        if (pathParams.includes(name)) continue;
        parameters.push({ name, in: "query", required: required.includes(name), schema } as never);
      }
    } else {
      const bodyProps = Object.fromEntries(Object.entries(props).filter(([k]) => !pathParams.includes(k)));
      op.requestBody = {
        required: true,
        content: { "application/json": { schema: { type: "object", required: required.filter((r) => !pathParams.includes(r)), properties: bodyProps } } },
      };
    }
    if (parameters.length) op.parameters = parameters;
    (paths[a.path] ??= {})[a.method.toLowerCase()] = op;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "JMS API",
      version: VERSION,
      description:
        "Look up clients, jobs, quotes, invoices and the price book; create and book jobs; add job notes; create draft quotes; text and email clients. Times are Sydney time unless an offset is given. Money is in dollars. Create an API key in JMS: Settings > API keys.",
    },
    servers: [{ url: PUBLIC_URL }],
    security: [{ apiKey: [] }],
    components: {
      securitySchemes: { apiKey: { type: "http", scheme: "bearer", description: "A JMS API key (jms_...)" } },
      responses: {
        Error: {
          description: "Something went wrong",
          content: { "application/json": { schema: { type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } } } } } },
        },
      },
    },
    paths,
  };
}

// ---------------------------------------------------------------------------
// MCP (streamable HTTP; stateless, JSON responses, no sessions)
// ---------------------------------------------------------------------------

const MCP_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MCP_INSTRUCTIONS =
  "JMS is a job management system for a trades business (roofing and plumbing) in Sydney. Look things up before changing them: search_clients / search_jobs give ids for the other tools. Times are Sydney time (e.g. 2026-12-03T09:00). Money is in dollars. Quotes are created as drafts only - a person checks and sends them. Check check_availability before booking with schedule_job. Only text or email clients when asked to.";

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

async function mcpOne(db: SupabaseClient, key: Key, msg: RpcRequest): Promise<unknown | null> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  if (msg.id === undefined || msg.id === null) return null; // a notification: no reply
  switch (msg.method) {
    case "initialize": {
      const asked = String(msg.params?.protocolVersion ?? "");
      return reply({
        protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "jms", title: "JMS", version: VERSION },
        instructions: MCP_INSTRUCTIONS,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: ACTIONS.filter((a) => key.scopes.includes(a.scope)).map((a) => ({
          name: a.name,
          title: a.title,
          description: a.description,
          inputSchema: a.input,
          annotations: { title: a.title, readOnlyHint: a.readOnly, destructiveHint: false, openWorldHint: a.scope === "messages" },
        })),
      });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const action = ACTIONS.find((a) => a.name === name);
      if (!action) return fail(-32602, `Unknown tool: ${name}`);
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      const { body, error } = await perform(db, key, action, args, "mcp");
      return reply({
        content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
        ...(error ? {} : { structuredContent: body }),
        isError: !!error,
      });
    }
    case "resources/list":
      return reply({ resources: [] });
    case "prompts/list":
      return reply({ prompts: [] });
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

async function handleMcp(db: SupabaseClient, req: Request): Promise<Response> {
  if (req.method === "GET") return new Response(null, { status: 405, headers: { ...CORS, Allow: "POST" } });
  if (req.method === "DELETE") return new Response(null, { status: 204, headers: CORS });
  const key = await authenticate(db, req);
  if (key instanceof Response) {
    const body = await key.json();
    return json(body, key.status, key.status === 401 ? { "WWW-Authenticate": 'Bearer realm="jms"' } : {});
  }
  let payload: RpcRequest | RpcRequest[];
  try {
    payload = await req.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  const batch = Array.isArray(payload);
  const messages = batch ? (payload as RpcRequest[]) : [payload as RpcRequest];
  const replies = (await Promise.all(messages.map((m) => (m && typeof m.method === "string" ? mcpOne(db, key, m) : Promise.resolve({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } }))))).filter((r) => r !== null);
  if (replies.length === 0) return new Response(null, { status: 202, headers: CORS });
  return json(batch ? replies : replies[0]);
}

// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  // Supabase passes the path with the function name in front.
  const path = url.pathname.replace(/^.*?\/jms-api(?=\/|$)/, "") || "/";

  if (req.method === "GET" && (path === "/openapi.json" || path === "/")) {
    return path === "/" ? json({ name: "JMS API", version: VERSION, openapi: `${PUBLIC_URL}/openapi.json`, mcp: `${PUBLIC_URL}/mcp` }) : json(openApiSpec());
  }
  if (!SUPABASE_SERVICE_ROLE_KEY) return apiError(500, "server_error", "The API isn't configured");
  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  if (path === "/mcp" || path === "/mcp/") return handleMcp(db, req);

  const route = matchRoute(req.method, path);
  if (!route) return apiError(404, "not_found", `No ${req.method} ${path}. See ${PUBLIC_URL}/openapi.json`);
  const key = await authenticate(db, req);
  if (key instanceof Response) return key;
  let input: Record<string, unknown> = { ...queryInput(url, route.action) };
  if (req.method === "POST") {
    try {
      const body = await req.json();
      if (!body || typeof body !== "object" || Array.isArray(body)) return apiError(400, "invalid_input", "Send a JSON object");
      input = { ...input, ...body };
    } catch {
      return apiError(400, "invalid_input", "The body isn't valid JSON");
    }
  }
  input = { ...input, ...route.params };
  const { status, body } = await perform(db, key, route.action, input, "rest");
  return json(body, status);
});

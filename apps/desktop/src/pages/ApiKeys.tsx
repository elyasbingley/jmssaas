import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { ThemedButton } from "../components/theme/ThemedButton";

// Settings > API keys (api_keys migration, jms-api function): keys for
// outside tools like Nebula to use JMS through its API or MCP server.

type Scope = "read" | "jobs" | "notes" | "quotes" | "messages";
interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  scopes: Scope[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}
interface LogRow {
  id: string;
  api_key_id: string | null;
  action: string;
  via: "rest" | "mcp";
  ok: boolean;
  status: number;
  summary: string | null;
  created_at: string;
}

const SCOPES: { key: Scope; label: string; detail: string; default: boolean }[] = [
  { key: "read", label: "Look things up", detail: "Clients, jobs, quotes, invoices, assets, the price book, the team and who's booked when.", default: true },
  { key: "jobs", label: "Create and book jobs", detail: "New jobs for existing clients; put jobs on the calendar and assign the technician.", default: true },
  { key: "notes", label: "Add job notes", detail: "Notes are marked with the key's name.", default: true },
  { key: "quotes", label: "Create draft quotes", detail: "Drafts only - you check and send them from JMS.", default: true },
  { key: "messages", label: "Text and email", detail: "To clients, their contacts and the team only, from your SMS number and email. Logged in Channels; clients who've opted out aren't texted.", default: false },
];

const API_URL = `${(import.meta.env.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, "") ?? ""}/functions/v1/jms-api`;
const muted = { color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" } as const;
const body = { color: "var(--jms-text)", fontSize: "var(--jms-font-body)" } as const;
const inputStyle = { backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" } as const;
const panel = { border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" } as const;
const heading = "mb-2 font-bold uppercase tracking-wide";
const headingStyle = { color: "var(--jms-accent)", fontSize: "var(--jms-font-label)", letterSpacing: "0.1em" } as const;

function when(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function CopyField({ label, value, secret = false }: { label: string; value: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mb-2">
      <p className="mb-1 uppercase tracking-wide" style={muted}>
        {label}
      </p>
      <div className="flex gap-2">
        <input readOnly value={value} onFocus={(e) => e.target.select()} className="w-full rounded border px-2 py-1.5 font-mono" style={{ ...inputStyle, ...(secret ? { borderColor: "var(--jms-warning)" } : {}) }} aria-label={label} />
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="rounded border px-3 font-semibold"
          style={{ borderColor: "var(--jms-border)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

export default function ApiKeysPage() {
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const { data: keys, error } = useQuery({
    queryKey: ["api-keys"],
    enabled: isAdmin,
    queryFn: async () => {
      const { data, error: e } = await supabase.from("api_keys").select("id, name, key_prefix, scopes, created_at, last_used_at, revoked_at").order("created_at", { ascending: false });
      if (e) throw e;
      return data as ApiKeyRow[];
    },
  });
  const { data: log } = useQuery({
    queryKey: ["api-keys", "log"],
    enabled: isAdmin,
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error: e } = await supabase.from("api_request_log").select("id, api_key_id, action, via, ok, status, summary, created_at").order("created_at", { ascending: false }).limit(50);
      if (e) throw e;
      return data as LogRow[];
    },
  });

  const [name, setName] = useState("Nebula");
  const [scopes, setScopes] = useState<Scope[]>(SCOPES.filter((s) => s.default).map((s) => s.key));
  const [newKey, setNewKey] = useState<{ name: string; key: string } | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);

  const create = useMutation({
    mutationFn: async () => {
      const { data, error: e } = await supabase.rpc("create_api_key", { p_name: name, p_scopes: scopes });
      if (e) throw e;
      return data as { id: string; key: string };
    },
    onSuccess: (data) => {
      setNewKey({ name, key: data.key });
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });
  const revoke = useMutation({
    mutationFn: async (id: string) => {
      const { error: e } = await supabase.rpc("revoke_api_key", { p_id: id });
      if (e) throw e;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["api-keys"] }),
  });

  if (!isAdmin) {
    return (
      <div className="p-8" style={body}>
        Only an admin can manage API keys.
      </div>
    );
  }

  const keyName = (id: string | null) => keys?.find((k) => k.id === id)?.name ?? "deleted key";
  const live = (keys ?? []).filter((k) => !k.revoked_at);
  const revoked = (keys ?? []).filter((k) => k.revoked_at);

  return (
    <div className="mx-auto max-w-5xl p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <Link to="/settings" className="hover:underline" style={muted}>
        &larr; Settings
      </Link>
      <h1 className="mb-1 mt-2 uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
        API keys
      </h1>
      <p className="mb-5 max-w-3xl" style={muted}>
        Let an outside tool such as Nebula work with JMS: look up clients and jobs, create and book jobs, add notes, draft quotes, and (if you allow it) text and email. Each key
        only does what you tick, can't take payments or delete anything, and every call it makes is listed below. Revoke a key at any time.
      </p>

      <div className="mb-6 rounded p-4" style={panel}>
        <h2 className={heading} style={headingStyle}>
          Connecting
        </h2>
        <p className="mb-3" style={muted}>
          In Nebula, add JMS as an <strong>MCP server</strong> (best) or a <strong>custom API</strong> using the OpenAPI spec. Either way, give it an API key from below as a Bearer
          token: <span className="font-mono">Authorization: Bearer jms_...</span>
        </p>
        <CopyField label="MCP server URL" value={`${API_URL}/mcp`} />
        <CopyField label="OpenAPI spec URL (custom API)" value={`${API_URL}/openapi.json`} />
        <CopyField label="API base URL" value={API_URL} />
      </div>

      {newKey ? (
        <div className="mb-6 rounded p-4" style={{ ...panel, borderColor: "var(--jms-warning)" }} data-testid="new-key">
          <h2 className={heading} style={{ ...headingStyle, color: "var(--jms-warning)" }}>
            Your new key: {newKey.name}
          </h2>
          <p className="mb-2" style={body}>
            Copy it now and paste it into Nebula. <strong>It won't be shown again</strong> - if you lose it, revoke it and make a new one. Treat it like a password.
          </p>
          <CopyField label="API key" value={newKey.key} secret />
          <button onClick={() => setNewKey(null)} className="mt-1 font-semibold hover:underline" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}>
            I've copied it
          </button>
        </div>
      ) : null}

      <div className="mb-6 rounded p-4" style={panel}>
        <h2 className={heading} style={headingStyle}>
          New key
        </h2>
        <div className="mb-3 max-w-sm">
          <p className="mb-1 uppercase tracking-wide" style={muted}>
            Name (what it's for)
          </p>
          <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded border px-2 py-1.5" style={inputStyle} aria-label="Key name" />
        </div>
        <p className="mb-1 uppercase tracking-wide" style={muted}>
          It can
        </p>
        <div className="mb-3 space-y-2">
          {SCOPES.map((s) => (
            <label key={s.key} className="flex items-start gap-2" style={body}>
              <input
                type="checkbox"
                className="mt-1"
                checked={scopes.includes(s.key)}
                onChange={(e) => setScopes((cur) => (e.target.checked ? [...cur, s.key] : cur.filter((x) => x !== s.key)))}
                aria-label={s.label}
              />
              <span>
                <span className="font-semibold">{s.label}</span>
                <span className="block" style={muted}>
                  {s.detail}
                </span>
              </span>
            </label>
          ))}
        </div>
        {create.error ? <p className="mb-2" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>{getErrorMessage(create.error, "Couldn't create the key")}</p> : null}
        <ThemedButton onClick={() => create.mutate()} disabled={create.isPending || !name.trim() || scopes.length === 0}>
          {create.isPending ? "Creating..." : "Create key"}
        </ThemedButton>
      </div>

      <div className="mb-6 rounded p-4" style={panel}>
        <h2 className={heading} style={headingStyle}>
          Keys
        </h2>
        {error ? <p style={{ color: "var(--jms-danger)" }}>{getErrorMessage(error, "Couldn't load keys")}</p> : null}
        {keys && live.length === 0 ? <p style={muted}>No keys yet.</p> : null}
        <div className="space-y-2">
          {[...live, ...(showRevoked ? revoked : [])].map((k) => (
            <div key={k.id} className="flex flex-wrap items-center justify-between gap-3 rounded p-3" style={{ border: "1px solid var(--jms-border)", opacity: k.revoked_at ? 0.55 : 1 }} data-testid="api-key-row">
              <div>
                <p className="font-semibold" style={body}>
                  {k.name} <span className="font-mono" style={muted}>{k.key_prefix}...</span>
                </p>
                <p style={muted}>
                  {k.scopes.map((s) => SCOPES.find((x) => x.key === s)?.label ?? s).join(" · ")}
                </p>
                <p style={muted}>
                  Created {when(k.created_at)} · last used {when(k.last_used_at)}
                  {k.revoked_at ? ` · revoked ${when(k.revoked_at)}` : ""}
                </p>
              </div>
              {!k.revoked_at ? (
                <button
                  onClick={() => {
                    if (window.confirm(`Revoke "${k.name}"? Anything using it stops working straight away.`)) revoke.mutate(k.id);
                  }}
                  className="font-semibold hover:underline"
                  style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-label)" }}
                >
                  Revoke
                </button>
              ) : null}
            </div>
          ))}
        </div>
        {revoked.length ? (
          <button onClick={() => setShowRevoked((v) => !v)} className="mt-2 hover:underline" style={muted}>
            {showRevoked ? "Hide revoked keys" : `Show ${revoked.length} revoked`}
          </button>
        ) : null}
      </div>

      <div className="rounded p-4" style={panel}>
        <h2 className={heading} style={headingStyle}>
          Recent activity
        </h2>
        {!log || log.length === 0 ? (
          <p style={muted}>Nothing yet.</p>
        ) : (
          <table className="w-full text-left" style={{ fontSize: "var(--jms-font-label)", color: "var(--jms-text)" }} data-testid="api-log">
            <thead style={muted}>
              <tr>
                <th className="py-1 pr-3 font-semibold">When</th>
                <th className="py-1 pr-3 font-semibold">Key</th>
                <th className="py-1 pr-3 font-semibold">What</th>
                <th className="py-1 font-semibold">Result</th>
              </tr>
            </thead>
            <tbody>
              {log.map((l) => (
                <tr key={l.id} style={{ borderTop: "1px solid var(--jms-border)" }}>
                  <td className="py-1 pr-3 align-top" style={{ whiteSpace: "nowrap", color: "var(--jms-text-muted)" }}>
                    {when(l.created_at)}
                  </td>
                  <td className="py-1 pr-3 align-top">{keyName(l.api_key_id)}</td>
                  <td className="py-1 pr-3 align-top">{l.summary ?? l.action}</td>
                  <td className="py-1 align-top" style={{ color: l.ok ? "var(--jms-accent)" : "var(--jms-danger)", whiteSpace: "nowrap" }}>
                    {l.ok ? "ok" : `refused (${l.status})`}
                    <span style={{ color: "var(--jms-text-muted)" }}> {l.via === "mcp" ? "MCP" : "API"}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

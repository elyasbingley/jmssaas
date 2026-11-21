import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FOLLOW_UP_FIELDS,
  FOLLOW_UP_STOP_LABELS,
  renderFollowUp,
  smsCount,
  type FollowUpEnrolment,
  type FollowUpMessage,
  type FollowUpSequence,
  type FollowUpSequenceKey,
  type FollowUpStep,
} from "@jmssaas/shared";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";
import { ThemedButton } from "../components/theme/ThemedButton";
import { ThemedPanel } from "../components/theme/ThemedPanel";
import { ThemedBadge } from "../components/theme/ThemedBadge";

// Follow-ups: the plan's automatic texts (see the follow_up_sequences
// migration). One tab per sequence - switch it on or off, edit the wording,
// and run a test to your own number that you can fast-forward a step at a
// time - plus the storm morning button, everyone currently in a sequence,
// and the code for the website's sign-up forms.

type Tab = "storm_checklist" | "storm_morning" | "quote_quiet" | "people" | "website";
type Enrolment = FollowUpEnrolment & { clients: { name: string } | null };
interface TenantFollowUpSettings {
  sms_phone_number: string | null;
  follow_up_test_numbers: string[];
  checklist_signup_key: string | null;
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SIGNUP_URL = `${SUPABASE_URL}/functions/v1/checklist-signup`;
const muted = { color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" } as const;
const body = { color: "var(--jms-text)", fontSize: "var(--jms-font-body)" } as const;
const inputStyle = { backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)", fontFamily: "var(--jms-font)" } as const;
const linkButton = { color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" } as const;
const SEQUENCE_TITLES: Record<FollowUpSequenceKey, string> = {
  storm_checklist: "1. Storm checklist sign-up",
  storm_morning: "3. The morning after a storm",
  quote_quiet: "4. Quotes that go quiet",
};

function when(iso: string | null): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

// 8:30am-6pm in Sydney, the same window the sender uses.
function inSendWindow(): boolean {
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === "hour")?.value);
  const m = Number(parts.find((p) => p.type === "minute")?.value);
  const minutes = h * 60 + m;
  return minutes >= 8 * 60 + 30 && minutes < 18 * 60;
}

async function callSender(payload: Record<string, unknown>): Promise<{ claimed: number; sent: number; failed: number }> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Not signed in");
  const res = await fetch(`${SUPABASE_URL}/functions/v1/process-follow-ups`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || out.error) throw new Error(out.detail || out.error || "The sender didn't respond");
  return out;
}

function useFollowUpData() {
  const { profile } = useAuth();
  const sequences = useQuery({
    queryKey: ["follow-ups", "sequences"],
    queryFn: async () => {
      const { data, error } = await supabase.from("follow_up_sequences").select("*");
      if (error) throw error;
      return data as FollowUpSequence[];
    },
  });
  const steps = useQuery({
    queryKey: ["follow-ups", "steps"],
    queryFn: async () => {
      const { data, error } = await supabase.from("follow_up_steps").select("*").order("position");
      if (error) throw error;
      return data as FollowUpStep[];
    },
  });
  const tenant = useQuery({
    queryKey: ["follow-ups", "tenant", profile?.tenant_id],
    enabled: !!profile,
    queryFn: async () => {
      const { data, error } = await supabase.from("tenants").select("sms_phone_number, follow_up_test_numbers, checklist_signup_key").eq("id", profile!.tenant_id).single();
      if (error) throw error;
      return data as TenantFollowUpSettings;
    },
  });
  const enrolments = useQuery({
    queryKey: ["follow-ups", "enrolments"],
    refetchInterval: 20_000,
    queryFn: async () => {
      const { data, error } = await supabase.from("follow_up_enrolments").select("*, clients(name)").order("created_at", { ascending: false }).limit(1000);
      if (error) throw error;
      return data as Enrolment[];
    },
  });
  return { sequences, steps, tenant, enrolments };
}

// ---------------------------------------------------------------------------

export default function FollowUpsPage() {
  const { isAdmin } = useAuth();
  const { sequences, steps, tenant, enrolments } = useFollowUpData();
  const [tab, setTab] = useState<Tab>("storm_checklist");
  const error = sequences.error ?? steps.error ?? tenant.error ?? enrolments.error;

  const tabs: { key: Tab; label: string }[] = [
    { key: "storm_checklist", label: "1. Storm checklist" },
    { key: "storm_morning", label: "3. Storm morning" },
    { key: "quote_quiet", label: "4. Quiet quotes" },
    { key: "people", label: "Who's in a sequence" },
    { key: "website", label: "Website forms" },
  ];
  const seq = (key: FollowUpSequenceKey) => sequences.data?.find((s) => s.key === key);

  return (
    <div className="mx-auto max-w-5xl p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <h1 className="mb-1 uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
        Follow-ups
      </h1>
      <p className="mb-5 max-w-3xl" style={muted}>
        Automatic texts from your Sell Like Crazy plan. They send between 8:30am and 6pm, from your SMS number, and stop as soon as someone replies (it lands in Channels for you
        to answer), a job is booked, or they text STOP. Each one is off until you switch it on - test it with your own number first.
      </p>

      {error ? <p style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>{getErrorMessage(error, "Couldn't load follow-ups")}</p> : null}
      {!isAdmin ? <p style={body}>Only an admin can change follow-ups.</p> : null}

      {tenant.data && !tenant.data.sms_phone_number ? (
        <p className="mb-4 rounded p-3" style={{ border: "1px solid var(--jms-warning)", color: "var(--jms-warning)", fontSize: "var(--jms-font-body)" }}>
          No SMS number is set yet. Add it in <Link to="/settings/company" className="underline">Company Settings</Link> before switching anything on.
        </p>
      ) : null}

      {tenant.data ? <TestNumbersCard tenant={tenant.data} /> : null}

      <div className="mb-5 flex flex-wrap gap-1" style={{ borderBottom: "1px solid var(--jms-border)" }}>
        {tabs.map((t) => {
          const s = t.key === "people" || t.key === "website" ? null : seq(t.key);
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className="border-b-2 px-4 py-2 font-semibold uppercase tracking-wide"
              style={
                tab === t.key
                  ? { borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }
                  : { borderColor: "transparent", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }
              }
            >
              {t.label}
              {s ? <span style={{ color: s.enabled ? "var(--jms-accent)" : "var(--jms-text-muted)" }}> · {s.enabled ? "on" : "off"}</span> : null}
            </button>
          );
        })}
      </div>

      {sequences.data && steps.data && tenant.data && enrolments.data ? (
        tab === "people" ? (
          <PeopleTab sequences={sequences.data} steps={steps.data} enrolments={enrolments.data} />
        ) : tab === "website" ? (
          <WebsiteTab tenant={tenant.data} />
        ) : (
          <SequenceTab
            key={tab}
            sequence={seq(tab)!}
            steps={steps.data.filter((st) => st.sequence_id === seq(tab)?.id)}
            tenant={tenant.data}
            enrolments={enrolments.data.filter((e) => e.sequence_id === seq(tab)?.id)}
          />
        )
      ) : (
        <p style={muted}>Loading...</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Test numbers
// ---------------------------------------------------------------------------

function TestNumbersCard({ tenant }: { tenant: TenantFollowUpSettings }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(tenant.follow_up_test_numbers.map((n) => "0" + n.slice(3)).join(", "));
  const save = useMutation({
    mutationFn: async () => {
      const numbers = text.split(/[,\n]/).map((n) => n.trim()).filter(Boolean);
      const { error } = await supabase.rpc("set_follow_up_test_numbers", { p_numbers: numbers });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["follow-ups", "tenant"] }),
  });
  return (
    <div className="mb-5 flex flex-wrap items-end gap-3 rounded p-3" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
      <label className="min-w-[16rem] flex-1">
        <span className="mb-1 block uppercase tracking-wide" style={muted}>
          Your test number(s)
        </span>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="04xx xxx xxx" className="w-full rounded border px-3 py-2 focus:outline-none" style={inputStyle} />
      </label>
      <ThemedButton variant="secondary" onClick={() => save.mutate()} disabled={save.isPending}>
        {save.isPending ? "Saving..." : "Save"}
      </ThemedButton>
      <p className="w-full" style={muted}>
        Texts to these numbers go out even while a sequence is off, and their runs can be fast-forwarded. Signing up on the website with this number starts a test run too.
        {save.isSuccess ? <span style={{ color: "var(--jms-accent)" }}> Saved.</span> : null}
        {save.error ? <span style={{ color: "var(--jms-danger)" }}> {getErrorMessage(save.error, "Couldn't save")}</span> : null}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One sequence
// ---------------------------------------------------------------------------

function SequenceTab({ sequence, steps, tenant, enrolments }: { sequence: FollowUpSequence; steps: FollowUpStep[]; tenant: TenantFollowUpSettings; enrolments: Enrolment[] }) {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  const [drafts, setDrafts] = useState<Record<string, { body: string; video_link: string }>>({});
  const [settings, setSettings] = useState(sequence.settings);
  const [saved, setSaved] = useState(false);
  useEffect(() => setSettings(sequence.settings), [sequence.settings]);

  const { data: categories } = useQuery({
    queryKey: ["follow-ups", "categories"],
    enabled: sequence.key === "quote_quiet",
    queryFn: async () => {
      const { data, error } = await supabase.from("service_categories").select("id, name").order("name");
      if (error) throw error;
      return data as { id: string; name: string }[];
    },
  });

  const draftOf = (s: FollowUpStep) => drafts[s.id] ?? { body: s.body, video_link: s.video_link ?? "" };
  const dirty =
    steps.some((s) => {
      const d = drafts[s.id];
      return !!d && (d.body !== s.body || d.video_link !== (s.video_link ?? ""));
    }) ||
    JSON.stringify(settings) !== JSON.stringify(sequence.settings);

  const save = useMutation({
    mutationFn: async () => {
      for (const s of steps) {
        const d = drafts[s.id];
        if (!d || (d.body === s.body && d.video_link === (s.video_link ?? ""))) continue;
        const { error } = await supabase.from("follow_up_steps").update({ body: d.body, video_link: d.video_link.trim() || null }).eq("id", s.id);
        if (error) throw error;
      }
      if (JSON.stringify(settings) !== JSON.stringify(sequence.settings)) {
        const { error } = await supabase.from("follow_up_sequences").update({ settings }).eq("id", sequence.id);
        if (error) throw error;
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["follow-ups"] });
      setDrafts({});
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    },
  });

  const toggle = useMutation({
    mutationFn: async (enabled: boolean) => {
      if (dirty) throw new Error("Save your changes first");
      const { error } = await supabase.rpc("set_follow_up_sequence_enabled", { p_key: sequence.key, p_enabled: enabled });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["follow-ups"] }),
  });

  const firstName = (profile?.full_name ?? "").split(" ")[0] || "Elyas";
  const sampleVars = (step: FollowUpStep, d: { video_link: string }) => ({
    first_name: firstName,
    suburb: "Blacktown",
    job: "roof leak repair",
    quote_total: "$650.00",
    checklist_link: settings.checklist_link || "[checklist link]",
    video_link: d.video_link || "[video link]",
    guarantee: settings.guarantee || "[guarantee]",
  });

  const live = enrolments.filter((e) => !e.is_test);
  const stats = {
    active: live.filter((e) => e.status === "active").length,
    completed: live.filter((e) => e.status === "completed").length,
    stopped: Object.entries(
      live.filter((e) => e.status === "stopped").reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.stop_reason ?? "?"]: (acc[e.stop_reason ?? "?"] ?? 0) + 1 }), {})
    ),
  };

  const trigger: Record<FollowUpSequenceKey, string> = {
    storm_checklist: "Starts when someone signs up at bingleytrades.com.au/storm-check (see Website forms). The day 0 text goes straight away, or at 8:30am if they sign up overnight.",
    storm_morning: "One text, sent when you press the button on the morning after a storm. Nobody gets more than one storm text in 14 days.",
    quote_quiet: "Starts when a quote is sent to a client with a mobile. Days count from the day the quote was sent. Stops if they accept, decline, reply, book or text STOP. A newer quote replaces it.",
  };

  return (
    <div>
      <ThemedPanel
        title={SEQUENCE_TITLES[sequence.key]}
        status={sequence.enabled ? "On" : "Off"}
        actions={
          <ThemedButton
            variant={sequence.enabled ? "danger" : "primary"}
            onClick={() => (sequence.enabled || window.confirm(`Switch on "${sequence.name}"? Real people will start getting these texts.`)) && toggle.mutate(!sequence.enabled)}
            disabled={toggle.isPending}
            style={{ paddingBlock: 4, paddingInline: 12 }}
          >
            {sequence.enabled ? "Switch off" : "Switch on"}
          </ThemedButton>
        }
      >
        <p style={body}>{trigger[sequence.key]}</p>
        {toggle.error ? <p className="mt-2" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>{getErrorMessage(toggle.error, "Couldn't switch it")}</p> : null}
        {sequence.key !== "storm_morning" ? (
          <p className="mt-2" style={muted}>
            In it now: {stats.active} · finished: {stats.completed}
            {stats.stopped.length ? " · stopped: " + stats.stopped.map(([r, n]) => `${FOLLOW_UP_STOP_LABELS[r] ?? r} ${n}`).join(", ") : ""}
          </p>
        ) : null}
      </ThemedPanel>

      {sequence.key === "storm_checklist" ? (
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Checklist link ({checklist_link})" value={settings.checklist_link ?? ""} onChange={(v) => setSettings({ ...settings, checklist_link: v })} placeholder="https://bingleytrades.com.au/storm-check/thanks" />
          <Field label="Email sent from (name)" value={settings.email_from_name ?? ""} onChange={(v) => setSettings({ ...settings, email_from_name: v })} placeholder="Elyas" />
        </div>
      ) : null}
      {sequence.key === "quote_quiet" ? (
        <div className="mt-4">
          <Field
            label="Guarantee ({guarantee}, day 5)"
            value={settings.guarantee ?? ""}
            onChange={(v) => setSettings({ ...settings, guarantee: v })}
            placeholder="if water comes through the same spot within 90 days of my visit, I come back and fix it free"
          />
          {categories && categories.length ? (
            <details className="mb-3">
              <summary className="cursor-pointer" style={linkButton}>
                A different guarantee for some job categories (e.g. plumbing)
              </summary>
              <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                {categories.map((c) => (
                  <Field
                    key={c.id}
                    label={c.name}
                    value={settings.guarantee_by_category?.[c.id] ?? ""}
                    onChange={(v) => setSettings({ ...settings, guarantee_by_category: { ...(settings.guarantee_by_category ?? {}), [c.id]: v } })}
                    placeholder="Blank = the guarantee above"
                  />
                ))}
              </div>
            </details>
          ) : null}
          <p className="mb-2 rounded p-2" style={{ ...muted, border: "1px dashed var(--jms-border)" }}>
            The payment plan line is left out of day 5 until you've signed up with a payment provider. Then paste it after "{"{guarantee}"}.": <span style={{ color: "var(--jms-text)" }}>{settings.payment_plan_line ?? "And if it helps, the {quote_total} can be split into payments."}</span>
          </p>
        </div>
      ) : null}

      <div className="mt-4 space-y-3">
        {steps.map((s) => {
          const d = draftOf(s);
          const preview = renderFollowUp(d.body, sampleVars(s, d));
          const count = smsCount(preview);
          const needsVideo = d.body.includes("{video_link}");
          return (
            <div key={s.id} className="rounded p-3" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }} data-testid={`step-${s.position}`}>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <ThemedBadge label={sequence.key === "storm_morning" ? "The text" : `Day ${s.day_offset}`} />
                <span style={muted}>{s.label}</span>
                {s.also_email ? <span style={muted}>· also emailed if they gave an email ("{s.email_subject}")</span> : null}
              </div>
              <textarea
                value={d.body}
                onChange={(e) => setDrafts({ ...drafts, [s.id]: { ...d, body: e.target.value } })}
                rows={3}
                className="w-full rounded border px-3 py-2 focus:outline-none"
                style={inputStyle}
                aria-label={`Day ${s.day_offset} text`}
              />
              {needsVideo ? (
                <Field label={`Video link for day ${s.day_offset} ({video_link})`} value={d.video_link} onChange={(v) => setDrafts({ ...drafts, [s.id]: { ...d, video_link: v } })} placeholder="https://youtu.be/..." />
              ) : null}
              <p className="mt-1" style={muted}>
                Fields: {FOLLOW_UP_FIELDS[sequence.key].join(" ")} · {count.characters} characters, {count.texts} text{count.texts === 1 ? "" : "s"}
                {count.unicode ? <span style={{ color: "var(--jms-warning)" }}> · {count.unicodeChars.join(" ")} makes every part cost more - take it out</span> : null}
                {!/reply stop/i.test(d.body) ? <span style={{ color: "var(--jms-danger)" }}> · needs "Reply STOP to opt out"</span> : null}
              </p>
              <p className="mt-1" style={{ ...muted, color: "var(--jms-text)" }}>
                Preview: {preview}
              </p>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <ThemedButton onClick={() => save.mutate()} disabled={!dirty || save.isPending || steps.some((s) => !/reply stop/i.test(draftOf(s).body))}>
          {save.isPending ? "Saving..." : "Save wording"}
        </ThemedButton>
        {saved ? <span style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>Saved.</span> : null}
        {save.error ? <span style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>{getErrorMessage(save.error, "Couldn't save")}</span> : null}
      </div>

      {sequence.key === "storm_morning" ? (
        <StormMorning sequence={sequence} tenant={tenant} steps={steps} />
      ) : (
        <TestRuns sequence={sequence} steps={steps} tenant={tenant} enrolments={enrolments.filter((e) => e.is_test)} dirty={dirty} />
      )}
    </div>
  );
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="mb-2 mt-2 block">
      <span className="mb-1 block uppercase tracking-wide" style={muted}>
        {label}
      </span>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="w-full rounded border px-3 py-2 focus:outline-none" style={inputStyle} aria-label={label} />
    </label>
  );
}

// ---------------------------------------------------------------------------
// Test runs (fast-forward)
// ---------------------------------------------------------------------------

function TestRuns({ sequence, steps, tenant, enrolments, dirty }: { sequence: FollowUpSequence; steps: FollowUpStep[]; tenant: TenantFollowUpSettings; enrolments: Enrolment[]; dirty: boolean }) {
  const queryClient = useQueryClient();
  const numbers = tenant.follow_up_test_numbers;
  const [phone, setPhone] = useState(numbers[0] ?? "");
  useEffect(() => setPhone((p) => p || numbers[0] || ""), [numbers]);
  const runs = enrolments.slice(0, 3);
  const { data: messages } = useQuery({
    queryKey: ["follow-ups", "messages", runs.map((r) => r.id).join(",")],
    enabled: runs.length > 0,
    refetchInterval: 15_000,
    queryFn: async () => {
      const { data, error } = await supabase.from("follow_up_messages").select("*").in("enrolment_id", runs.map((r) => r.id)).order("created_at");
      if (error) throw error;
      return data as FollowUpMessage[];
    },
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["follow-ups"] });

  const start = useMutation({
    mutationFn: async () => {
      if (dirty) throw new Error("Save your wording first, so the test uses it");
      const { data: id, error } = await supabase.rpc("start_follow_up_test", { p_key: sequence.key, p_phone: phone });
      if (error) throw error;
      // Day 0 goes now, like the real thing.
      if (steps[0]?.day_offset === 0) await callSender({ enrolment_id: id, force: true });
    },
    onSettled: refresh,
  });
  const next = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("fast_forward_follow_up", { p_enrolment_id: id });
      if (error) throw error;
      const result = await callSender({ enrolment_id: id, force: true });
      if (!result.claimed) throw new Error("Nothing was sent - the run may have stopped (did you reply?)");
    },
    onSettled: refresh,
  });
  const stop = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("stop_follow_up", { p_enrolment_id: id });
      if (error) throw error;
    },
    onSettled: refresh,
  });

  return (
    <div className="mt-6">
      <ThemedPanel title="Test with your own number">
        {numbers.length === 0 ? (
          <p style={body}>Add your mobile as a test number above first.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <select value={phone} onChange={(e) => setPhone(e.target.value)} className="rounded border px-3 py-2" style={inputStyle} aria-label="Test number">
              {numbers.map((n) => (
                <option key={n} value={n}>
                  {"0" + n.slice(3)}
                </option>
              ))}
            </select>
            <ThemedButton onClick={() => start.mutate()} disabled={start.isPending || !phone}>
              {start.isPending ? "Starting..." : "Start a test run"}
            </ThemedButton>
            <span style={muted}>
              Uses sample details (your first name, Blacktown{sequence.key === "quote_quiet" ? ", a $650.00 roof leak repair" : ""}). Reply to a test text to see it stop.
            </span>
          </div>
        )}
        {start.error ? <p className="mt-2" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>{getErrorMessage(start.error, "Couldn't start the test")}</p> : null}
        {next.error ? <p className="mt-2" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>{getErrorMessage(next.error, "Couldn't send")}</p> : null}

        {runs.map((run) => {
          const runMessages = (messages ?? []).filter((m) => m.enrolment_id === run.id);
          return (
            <div key={run.id} className="mt-4 rounded p-3" style={{ border: "1px solid var(--jms-border)" }} data-testid="test-run">
              <div className="mb-2 flex flex-wrap items-center gap-3">
                <span style={body}>
                  Test to {"0" + run.phone.slice(3)} · started {when(run.enrolled_at)} ·{" "}
                  <span style={{ color: run.status === "active" ? "var(--jms-accent)" : "var(--jms-text-muted)" }}>
                    {run.status === "active" ? "running" : run.status === "completed" ? "finished" : `stopped: ${FOLLOW_UP_STOP_LABELS[run.stop_reason ?? ""] ?? run.stop_reason}`}
                  </span>
                </span>
                {run.status === "active" ? (
                  <>
                    <ThemedButton onClick={() => next.mutate(run.id)} disabled={next.isPending} style={{ paddingBlock: 4, paddingInline: 12 }}>
                      {next.isPending ? "Sending..." : "Send next now ⏩"}
                    </ThemedButton>
                    <button onClick={() => stop.mutate(run.id)} className="font-semibold hover:underline" style={linkButton}>
                      Stop test
                    </button>
                  </>
                ) : null}
              </div>
              <ol className="space-y-1">
                {steps.map((s) => {
                  const sent = runMessages.filter((m) => m.step_position === s.position);
                  const isNext = run.status === "active" && run.next_position === s.position;
                  return (
                    <li key={s.id} className="flex gap-3" style={{ fontSize: "var(--jms-font-label)" }}>
                      <span className="w-14 shrink-0" style={{ color: "var(--jms-text-muted)" }}>
                        Day {s.day_offset}
                      </span>
                      <span style={{ color: sent.some((m) => m.status === "sent") ? "var(--jms-accent)" : sent.length ? "var(--jms-danger)" : isNext ? "var(--jms-text)" : "var(--jms-text-muted)" }}>
                        {sent.length
                          ? sent.map((m) => `${m.channel === "email" ? "Email" : "Text"} ${m.status} ${when(m.created_at)}${m.detail ? ` (${m.detail})` : ""}`).join(" · ")
                          : isNext
                            ? `Next - due ${when(run.next_due_at)} (or press Send next now)`
                            : run.status === "active"
                              ? "Waiting"
                              : "-"}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
          );
        })}
      </ThemedPanel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Storm morning
// ---------------------------------------------------------------------------

interface StormRecipient {
  client_id: string;
  name: string;
  first_name: string | null;
  phone: string;
  suburb: string;
  source: "checklist" | "past_client";
  skip_reason: string | null;
}

function StormMorning({ sequence, tenant, steps }: { sequence: FollowUpSequence; tenant: TenantFollowUpSettings; steps: FollowUpStep[] }) {
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const { data: suburbs } = useQuery({
    queryKey: ["follow-ups", "storm-suburbs"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("storm_morning_suburbs");
      if (error) throw error;
      return data as { suburb: string; people: number; skipped: number }[];
    },
  });
  const { data: recipients, isFetching: checking } = useQuery({
    queryKey: ["follow-ups", "storm-recipients", picked.join("|")],
    enabled: picked.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("storm_morning_recipients", { p_suburbs: picked });
      if (error) throw error;
      return data as StormRecipient[];
    },
  });
  const going = (recipients ?? []).filter((r) => !r.skip_reason);
  const skipped = (recipients ?? []).filter((r) => r.skip_reason);
  const shown = useMemo(() => (suburbs ?? []).filter((s) => !filter || s.suburb.toLowerCase().includes(filter.toLowerCase())), [suburbs, filter]);
  const sample = going[0];

  const test = useMutation({
    mutationFn: async () => {
      const phone = tenant.follow_up_test_numbers[0];
      if (!phone) throw new Error("Add your mobile as a test number above first");
      const { data: id, error } = await supabase.rpc("start_follow_up_test", { p_key: "storm_morning", p_phone: phone, p_suburb: picked[0] ?? "Blacktown" });
      if (error) throw error;
      await callSender({ enrolment_id: id, force: true });
      return phone;
    },
    onSuccess: (phone) => setResult(`Test sent to ${"0" + phone.slice(3)}.`),
  });
  const send = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("start_storm_morning", { p_suburbs: picked });
      if (error) throw error;
      const queued = (data as { queued: number }).queued;
      let sent = 0;
      if (inSendWindow()) {
        for (let i = 0; i < 20; i++) {
          const r = await callSender({ action: "sweep" });
          sent += r.sent;
          if (!r.claimed) break;
        }
      }
      return { queued, sent };
    },
    onSuccess: ({ queued, sent }) => {
      setResult(inSendWindow() ? `Sent ${sent} of ${queued}. Any left go out in the next few minutes.` : `${queued} queued. It's outside 8:30am-6pm, so they go out at 8:30am.`);
      setPicked([]);
      queryClient.invalidateQueries({ queryKey: ["follow-ups"] });
    },
  });

  return (
    <div className="mt-6">
      <ThemedPanel title="Send the storm text">
        <p className="mb-3" style={body}>
          Pick the suburbs the storm hit. It goes to everyone who signed up for a checklist plus past clients there, with a mobile and not opted out - skipping anyone who's had a
          storm text in the last 14 days.
        </p>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a suburb..." className="mb-2 w-full rounded border px-3 py-2 focus:outline-none md:w-80" style={inputStyle} />
        <div className="mb-3 flex max-h-64 flex-wrap gap-2 overflow-y-auto" data-testid="storm-suburbs">
          {shown.map((s) => {
            const on = picked.includes(s.suburb);
            return (
              <button
                key={s.suburb}
                onClick={() => setPicked(on ? picked.filter((p) => p !== s.suburb) : [...picked, s.suburb])}
                className="rounded-full border px-3 py-1"
                style={
                  on
                    ? { borderColor: "var(--jms-accent)", backgroundColor: "var(--jms-accent-glow)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }
                    : { borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-label)" }
                }
              >
                {s.suburb} ({s.people}
                {s.skipped ? `, ${s.skipped} had one recently` : ""})
              </button>
            );
          })}
          {suburbs && suburbs.length === 0 ? <span style={muted}>No one to text yet - checklist sign-ups and past clients with a mobile and suburb show up here.</span> : null}
        </div>
        {picked.length && !recipients && checking ? (
          <p className="mb-3" style={muted}>
            Checking who's in...
          </p>
        ) : null}
        {picked.length && recipients ? (
          <>
            <p className="mb-1" style={body}>
              <span className="font-semibold">{going.length}</span> will get it{skipped.length ? `, ${skipped.length} skipped (storm text in the last 14 days)` : ""}.
            </p>
            {sample && steps[0] ? (
              <p className="mb-2" style={muted}>
                e.g. to {sample.name}: <span style={{ color: "var(--jms-text)" }}>{renderFollowUp(steps[0].body, { first_name: sample.first_name || "there", suburb: sample.suburb })}</span>
              </p>
            ) : null}
            <details className="mb-3">
              <summary className="cursor-pointer" style={linkButton}>
                See who
              </summary>
              <ul className="mt-1" style={muted}>
                {(recipients ?? []).map((r) => (
                  <li key={r.phone}>
                    {r.name} ({r.suburb}, {r.source === "checklist" ? "checklist sign-up" : "past client"}){r.skip_reason ? " - skipped, storm text in the last 14 days" : ""}
                  </li>
                ))}
              </ul>
            </details>
          </>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <ThemedButton
            onClick={() => window.confirm(`Send the storm text to ${going.length} people in ${picked.join(", ")}?`) && send.mutate()}
            disabled={!sequence.enabled || !going.length || send.isPending || checking}
          >
            {send.isPending ? "Sending..." : `Send storm text to ${going.length} ${going.length === 1 ? "person" : "people"}`}
          </ThemedButton>
          <ThemedButton variant="secondary" onClick={() => test.mutate()} disabled={test.isPending}>
            {test.isPending ? "Sending..." : "Send me a test"}
          </ThemedButton>
          {!sequence.enabled ? <span style={muted}>Switch this on (above) to send it for real. Test it first.</span> : null}
        </div>
        {result ? <p className="mt-2" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-body)" }}>{result}</p> : null}
        {send.error || test.error ? <p className="mt-2" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>{getErrorMessage(send.error ?? test.error, "Couldn't send")}</p> : null}
      </ThemedPanel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Everyone in a sequence
// ---------------------------------------------------------------------------

function PeopleTab({ sequences, steps, enrolments }: { sequences: FollowUpSequence[]; steps: FollowUpStep[]; enrolments: Enrolment[] }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<"active" | "stopped" | "completed" | "all">("active");
  const [seqId, setSeqId] = useState("");
  const rows = enrolments.filter((e) => (status === "all" || e.status === status) && (!seqId || e.sequence_id === seqId));
  const stop = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("stop_follow_up", { p_enrolment_id: id });
      if (error) throw error;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["follow-ups"] }),
  });
  const seqName = (id: string) => sequences.find((s) => s.id === id)?.name ?? "";
  const stepCount = (id: string) => steps.filter((s) => s.sequence_id === id).length;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {(["active", "stopped", "completed", "all"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className="rounded-full border px-3 py-1 font-semibold"
            style={
              status === s
                ? { borderColor: "var(--jms-accent)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }
                : { borderColor: "var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }
            }
          >
            {s === "active" ? "In a sequence" : s === "completed" ? "Finished" : s === "stopped" ? "Stopped" : "All"}
          </button>
        ))}
        <select value={seqId} onChange={(e) => setSeqId(e.target.value)} className="rounded border px-3 py-1" style={inputStyle} aria-label="Sequence">
          <option value="">Every sequence</option>
          {sequences.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      {rows.length === 0 ? (
        <p style={muted}>Nobody here.</p>
      ) : (
        <div className="overflow-x-auto rounded" style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)" }}>
          <table className="w-full text-left" style={{ fontSize: "var(--jms-font-body)" }}>
            <thead className="uppercase" style={{ borderBottom: "1px solid var(--jms-border)", backgroundColor: "var(--jms-bg)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
              <tr>
                <th className="px-4 py-2 font-semibold">Who</th>
                <th className="px-4 py-2 font-semibold">Sequence</th>
                <th className="px-4 py-2 font-semibold">Started</th>
                <th className="px-4 py-2 font-semibold">Where they're up to</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 300).map((e) => (
                <tr key={e.id} className="last:border-0" style={{ borderBottom: "1px solid var(--jms-border)" }}>
                  <td className="px-4 py-2">
                    {e.client_id ? (
                      <Link to={`/clients/${e.client_id}`} className="hover:underline" style={{ color: "var(--jms-accent)" }}>
                        {e.clients?.name ?? e.vars.first_name ?? "Client"}
                      </Link>
                    ) : (
                      <span style={{ color: "var(--jms-text)" }}>{e.vars.first_name ?? "-"}</span>
                    )}
                    <span style={muted}> {"0" + e.phone.slice(3)}</span>
                    {e.is_test ? <span style={{ color: "var(--jms-warning)", fontSize: "var(--jms-font-label)" }}> · test</span> : null}
                  </td>
                  <td className="px-4 py-2" style={{ color: "var(--jms-text-muted)" }}>
                    {seqName(e.sequence_id)}
                  </td>
                  <td className="px-4 py-2" style={{ color: "var(--jms-text-muted)" }}>
                    {when(e.enrolled_at)}
                  </td>
                  <td className="px-4 py-2" style={{ color: "var(--jms-text)" }}>
                    {e.status === "active"
                      ? `Text ${Math.min(e.next_position + 1, stepCount(e.sequence_id))} of ${stepCount(e.sequence_id)} due ${when(e.next_due_at)}`
                      : e.status === "completed"
                        ? "Finished"
                        : `Stopped: ${FOLLOW_UP_STOP_LABELS[e.stop_reason ?? ""] ?? e.stop_reason}`}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {e.status === "active" ? (
                      <button onClick={() => window.confirm("Stop this person's follow-up texts?") && stop.mutate(e.id)} className="font-semibold hover:underline" style={linkButton}>
                        Stop
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Website forms
// ---------------------------------------------------------------------------

export function signupFormHtml(key: string, checklist: "roof" | "hot_water"): string {
  const path = checklist === "roof" ? "storm-check" : "hot-water-check";
  return `<form class="jms-checklist-form" action="${SIGNUP_URL}" method="POST">
  <input type="hidden" name="key" value="${key}">
  <input type="hidden" name="checklist" value="${checklist}">
  <input type="hidden" name="redirect" value="https://bingleytrades.com.au/${path}/thanks">
  <!-- Leave this empty - it catches bots -->
  <input type="text" name="botcheck" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">
  <label>First name <input name="first_name" required autocomplete="given-name"></label>
  <label>Mobile <input name="mobile" type="tel" required autocomplete="tel" placeholder="04xx xxx xxx"></label>
  <label>Suburb <input name="suburb" required autocomplete="address-level2"></label>
  <label>Email (optional) <input name="email" type="email" autocomplete="email"></label>
  <button type="submit">Text me the checklist</button>
  <p class="jms-form-error" role="alert" style="color:#b91c1c"></p>
  <p>I'll text you the checklist and a few tips over the next week. Reply STOP any time.</p>
</form>
<script>
// Optional: shows a mistake (like a landline) on the page instead of on a new one.
document.querySelectorAll(".jms-checklist-form").forEach(function (form) {
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var button = form.querySelector("button");
    var error = form.querySelector(".jms-form-error");
    button.disabled = true; error.textContent = "";
    var data = new FormData(form); data.delete("redirect");
    fetch(form.action, { method: "POST", body: data })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (r.ok) { window.location.href = form.querySelector("[name=redirect]").value; }
        else { error.textContent = r.message || "Something went wrong. Please try again."; button.disabled = false; }
      })
      .catch(function () { form.submit(); });
  });
});
</script>`;
}

function WebsiteTab({ tenant }: { tenant: TenantFollowUpSettings }) {
  const [copied, setCopied] = useState<string | null>(null);
  const key = tenant.checklist_signup_key ?? "";
  const copy = async (what: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied(null), 2000);
  };
  return (
    <div className="space-y-4">
      <ThemedPanel title="How sign-ups reach JMS">
        <p style={body}>
          Each sign-up on the website creates a lead here: the client (matched by mobile if they're already in JMS), and a job in your first stage with lead source "Checklist: roof"
          or "Checklist: hot water". You get a notification. Roof sign-ups also start sequence 1 once it's on. Hot water sign-ups are a lead and a notification for now.
        </p>
        <p className="mt-2" style={muted}>
          Form address: <span style={{ color: "var(--jms-text)" }}>{SIGNUP_URL}</span> · your form key: <span style={{ color: "var(--jms-text)" }}>{key}</span>
        </p>
      </ThemedPanel>
      {(["roof", "hot_water"] as const).map((c) => {
        const html = signupFormHtml(key, c);
        return (
          <ThemedPanel
            key={c}
            title={c === "roof" ? "Form for /storm-check" : "Form for /hot-water-check"}
            actions={
              <button onClick={() => copy(c, html)} className="font-semibold hover:underline" style={linkButton}>
                {copied === c ? "Copied" : "Copy code"}
              </button>
            }
          >
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded p-3" style={{ backgroundColor: "var(--jms-bg)", color: "var(--jms-text)", fontSize: "var(--jms-font-label)" }}>
              {html}
            </pre>
          </ThemedPanel>
        );
      })}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

// The top bar's search - everything in one box (global_search migration):
// clients by name, company, phone (any spacing), email or address; their
// contacts and other addresses; jobs, job notes, quotes, invoices, files,
// tasks, notes, assets (serial numbers too), price book, knowledge,
// agency properties, agencies, property managers, subcontractors, purchase
// orders, inbox emails, Channels conversations and the team. The database
// applies each person's own access, so a technician only finds what they
// could open anyway. Arrow keys and Enter work; "/" focuses it.

interface Hit {
  kind: string;
  id: string;
  title: string;
  subtitle: string | null;
  link: string;
  matched: string | null;
}

const GROUPS: { kind: string; label: string; icon: string }[] = [
  { kind: "client", label: "Clients", icon: "👤" },
  { kind: "contact", label: "Contacts", icon: "📇" },
  { kind: "address", label: "Addresses", icon: "📍" },
  { kind: "property", label: "Agency properties", icon: "🏠" },
  { kind: "job", label: "Jobs", icon: "🧰" },
  { kind: "job_note", label: "Job notes", icon: "🗒️" },
  { kind: "quote", label: "Quotes", icon: "📝" },
  { kind: "invoice", label: "Invoices", icon: "💲" },
  { kind: "file", label: "Files", icon: "📎" },
  { kind: "asset", label: "Assets", icon: "🚿" },
  { kind: "task", label: "Tasks", icon: "✅" },
  { kind: "note", label: "Notes", icon: "📒" },
  { kind: "conversation", label: "Channels", icon: "💬" },
  { kind: "email", label: "Inbox", icon: "📥" },
  { kind: "price_book", label: "Price book", icon: "📦" },
  { kind: "knowledge", label: "Knowledge", icon: "📚" },
  { kind: "agency", label: "Agencies", icon: "🏢" },
  { kind: "property_manager", label: "Property managers", icon: "🧑‍💼" },
  { kind: "subcontractor", label: "Subcontractors", icon: "🦺" },
  { kind: "purchase_order", label: "Purchase orders", icon: "🧾" },
  { kind: "team", label: "Team", icon: "👥" },
];

export function GlobalSearch() {
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timeout = setTimeout(async () => {
      const { data, error } = await supabase.rpc("global_search", { p_query: trimmed });
      if (cancelled) return;
      setFailed(!!error);
      setHits(((data ?? []) as Hit[]) ?? []);
      setActive(0);
      setSearching(false);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [query]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    // "/" jumps to search from anywhere that isn't already a text field.
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  // In display order, so the arrow keys follow what's on screen.
  const grouped = useMemo(
    () => GROUPS.map((g) => ({ ...g, hits: hits.filter((h) => h.kind === g.kind) })).filter((g) => g.hits.length > 0),
    [hits]
  );
  const flat = useMemo(() => grouped.flatMap((g) => g.hits), [grouped]);

  const go = (hit: Hit) => {
    navigate(hit.link);
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
  };

  const trimmed = query.trim();
  let index = -1;

  return (
    <div ref={ref} className="relative w-full max-w-md" style={{ fontFamily: "var(--jms-font)" }}>
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "var(--jms-text-muted)" }} aria-hidden>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
      </span>
      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpen(false);
            inputRef.current?.blur();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, Math.max(flat.length - 1, 0)));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter" && flat[active]) {
            e.preventDefault();
            go(flat[active]);
          }
        }}
        placeholder="Search anything... (press /)"
        aria-label="Search"
        className="w-full rounded-full border py-1.5 pl-9 pr-3 focus:outline-none"
        style={{ backgroundColor: "var(--jms-bg)", borderColor: "var(--jms-border)", color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}
      />
      {open && trimmed.length >= 2 ? (
        <div
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-[70vh] overflow-y-auto rounded-lg"
          style={{ border: "1px solid var(--jms-border)", backgroundColor: "var(--jms-surface)", boxShadow: "0 8px 24px rgba(0,0,0,0.35)", minWidth: 380 }}
          role="listbox"
          data-testid="search-results"
        >
          {searching && hits.length === 0 ? <p className="p-3" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>Searching...</p> : null}
          {failed ? <p className="p-3" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>Search isn't working right now.</p> : null}
          {!searching && !failed && hits.length === 0 ? (
            <p className="p-3" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
              Nothing found for "{trimmed}".
            </p>
          ) : null}
          {grouped.map((g) => (
            <div key={g.kind} className="py-1" style={{ borderBottom: "1px solid var(--jms-border)" }}>
              <p className="px-3 py-1 uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                {g.label}
              </p>
              {g.hits.map((h) => {
                index++;
                const i = index;
                return (
                  <button
                    key={`${h.kind}-${h.id}-${i}`}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(h)}
                    className="flex w-full items-start gap-2 px-3 py-1.5 text-left"
                    style={{ backgroundColor: i === active ? "var(--jms-accent-glow)" : "transparent" }}
                    role="option"
                    aria-selected={i === active}
                  >
                    <span aria-hidden>{g.icon}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate" style={{ color: "var(--jms-text)", fontSize: "var(--jms-font-body)" }}>
                        {h.title}
                        {h.matched ? (
                          <span className="ml-2 rounded px-1" style={{ border: "1px solid var(--jms-border)", color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                            {h.matched}
                          </span>
                        ) : null}
                      </span>
                      {h.subtitle ? (
                        <span className="block truncate" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" }}>
                          {h.subtitle}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

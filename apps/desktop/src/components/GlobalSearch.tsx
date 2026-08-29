import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

// ServiceM8-style master search - clients (name/company/phone/email),
// jobs (title/number), quotes/invoices (their own number). Same debounced-
// ilike, no-RPC-no-full-text-index shape as AddLineItemBar's price-book
// search (this codebase's established "keep search dumb" pattern - there's
// no pg_trgm/tsvector infrastructure anywhere in this repo to build
// anything fancier on top of), just fired as several parallel per-table
// queries instead of one, grouped into labeled result sections.

interface ClientResult {
  id: string;
  name: string;
  company_name: string | null;
  phone: string | null;
  email: string | null;
}
interface JobResult {
  id: string;
  number: string | null;
  title: string;
}
interface QuoteResult {
  id: string;
  quote_number: string;
}
interface InvoiceResult {
  id: string;
  invoice_number: string;
}

interface Results {
  clients: ClientResult[];
  jobs: JobResult[];
  quotes: QuoteResult[];
  invoices: InvoiceResult[];
}

const EMPTY_RESULTS: Results = { clients: [], jobs: [], quotes: [], invoices: [] };

async function runSearch(rawQuery: string): Promise<Results> {
  // Strip characters that are special to PostgREST's .or() filter syntax
  // (comma separates conditions, parens aren't expected mid-value) so a
  // client typing something like "Smith, John" or "(123) 456" can't
  // produce a malformed filter string.
  const q = rawQuery.replace(/[,()]/g, "").trim();
  if (!q) return EMPTY_RESULTS;

  const [clients, jobs, quotes, invoices] = await Promise.all([
    supabase
      .from("clients")
      .select("id, name, company_name, phone, email")
      .or(`name.ilike.%${q}%,company_name.ilike.%${q}%,phone.ilike.%${q}%,email.ilike.%${q}%`)
      .limit(5),
    supabase.from("job_cards").select("id, number, title").or(`title.ilike.%${q}%,number.ilike.%${q}%`).limit(5),
    supabase.from("quotes").select("id, quote_number").ilike("quote_number", `%${q}%`).limit(5),
    supabase.from("invoices").select("id, invoice_number").ilike("invoice_number", `%${q}%`).limit(5),
  ]);

  return {
    clients: (clients.data ?? []) as ClientResult[],
    jobs: (jobs.data ?? []) as JobResult[],
    quotes: (quotes.data ?? []) as QuoteResult[],
    invoices: (invoices.data ?? []) as InvoiceResult[],
  };
}

export function GlobalSearch() {
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Results>(EMPTY_RESULTS);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults(EMPTY_RESULTS);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timeout = setTimeout(async () => {
      const found = await runSearch(trimmed);
      if (!cancelled) {
        setResults(found);
        setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [query]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, []);

  const go = (path: string) => {
    navigate(path);
    setOpen(false);
    setQuery("");
  };

  const hasResults = results.clients.length + results.jobs.length + results.quotes.length + results.invoices.length > 0;
  const trimmed = query.trim();

  return (
    <div ref={ref} className="relative w-96">
      <input
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Search clients, jobs, quotes, invoices..."
        className="w-full rounded-md border border-gray-300 bg-gray-50 px-3 py-1.5 text-sm focus:border-blue-500 focus:bg-white focus:outline-none"
      />
      {open && trimmed.length >= 2 ? (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-96 overflow-y-auto rounded-md border border-gray-300 bg-white shadow-lg">
          {searching ? <p className="p-3 text-sm text-gray-400">Searching...</p> : null}
          {!searching && !hasResults ? <p className="p-3 text-sm text-gray-500">No results for "{trimmed}".</p> : null}

          {results.clients.length > 0 ? (
            <div className="border-b border-gray-100 py-1">
              <p className="px-3 py-1 text-xs font-bold uppercase tracking-wide text-gray-400">Clients</p>
              {results.clients.map((c) => (
                <button
                  key={c.id}
                  onClick={() => go(`/clients/${c.id}`)}
                  className="block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-gray-50"
                >
                  <span className="font-medium text-gray-900">{c.company_name || c.name}</span>
                  <span className="ml-2 text-xs text-gray-500">{c.phone || c.email || ""}</span>
                </button>
              ))}
            </div>
          ) : null}

          {results.jobs.length > 0 ? (
            <div className="border-b border-gray-100 py-1">
              <p className="px-3 py-1 text-xs font-bold uppercase tracking-wide text-gray-400">Jobs</p>
              {results.jobs.map((j) => (
                <button
                  key={j.id}
                  onClick={() => go(`/jobs/${j.id}`)}
                  className="block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-gray-50"
                >
                  <span className="font-mono text-xs text-blue-700">{j.number ?? "Pending"}</span>
                  <span className="ml-2 text-gray-900">{j.title}</span>
                </button>
              ))}
            </div>
          ) : null}

          {results.quotes.length > 0 ? (
            <div className="border-b border-gray-100 py-1">
              <p className="px-3 py-1 text-xs font-bold uppercase tracking-wide text-gray-400">Quotes</p>
              {results.quotes.map((q) => (
                <button
                  key={q.id}
                  onClick={() => go(`/quotes/${q.id}`)}
                  className="block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-gray-50"
                >
                  {q.quote_number}
                </button>
              ))}
            </div>
          ) : null}

          {results.invoices.length > 0 ? (
            <div className="py-1">
              <p className="px-3 py-1 text-xs font-bold uppercase tracking-wide text-gray-400">Invoices</p>
              {results.invoices.map((inv) => (
                <button
                  key={inv.id}
                  onClick={() => go(`/invoices/${inv.id}`)}
                  className="block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-gray-50"
                >
                  {inv.invoice_number}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

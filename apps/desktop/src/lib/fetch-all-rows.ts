import { supabase } from "./supabase";

// PostgREST caps every response at 1000 rows (supabase/config.toml's
// max_rows, same on the hosted project), silently - a plain select on a
// table with more just returns the first 1000. Anything that needs every
// row pages through instead. Ordered by id so pages can't overlap or skip.
const PAGE_SIZE = 1000;

// The query builder's own type is generic over the schema; a filter only
// ever chains one more call onto it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Filter = (query: any) => any;

export async function fetchAllRows<T>(table: string, columns: string, filter?: Filter): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = supabase.from(table).select(columns);
    if (filter) query = filter(query);
    const { data, error } = await query.order("id").range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

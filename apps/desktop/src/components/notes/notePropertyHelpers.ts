import type { NoteProperty } from "@jmssaas/shared";

// Table/Card view helpers - a minimal Bases-style layer over note_properties
// (typed EAV), grouping a tenant's properties by note and by key so the
// views can filter/sort on actual property values instead of just titles.

export function groupPropertiesByNote(properties: NoteProperty[]): Map<string, NoteProperty[]> {
  const map = new Map<string, NoteProperty[]>();
  for (const p of properties) {
    const list = map.get(p.note_id) ?? [];
    list.push(p);
    map.set(p.note_id, list);
  }
  return map;
}

/** Every distinct property key seen across the tenant's notes, in first-seen order. */
export function distinctPropertyKeys(properties: NoteProperty[]): string[] {
  const seen: string[] = [];
  const set = new Set<string>();
  for (const p of properties) {
    if (!set.has(p.key)) {
      set.add(p.key);
      seen.push(p.key);
    }
  }
  return seen;
}

/** Plain display string for a property value, regardless of its value_type. */
export function formatPropertyValue(p: NoteProperty): string {
  switch (p.value_type) {
    case "text":
      return p.value_text ?? "";
    case "number":
      return p.value_number != null ? String(p.value_number) : "";
    case "checkbox":
      return p.value_checkbox ? "Yes" : "No";
    case "date":
      return p.value_date ?? "";
    case "list":
      return (p.value_list ?? []).join(", ");
    default:
      return "";
  }
}

/** Sortable primitive for a property value - numbers/dates sort numerically,
 * everything else falls back to a lowercased string compare. */
export function sortableValue(p: NoteProperty | undefined): number | string {
  if (!p) return "";
  if (p.value_type === "number") return p.value_number ?? -Infinity;
  if (p.value_type === "date") return p.value_date ?? "";
  if (p.value_type === "checkbox") return p.value_checkbox ? 1 : 0;
  return formatPropertyValue(p).toLowerCase();
}

// Supports a leading comparison operator for number/date properties
// (">10", "<=2026-01-01") and falls back to a case-insensitive substring
// match for text/list, an exact yes/no match for checkbox.
export function propertyMatchesFilter(p: NoteProperty | undefined, rawFilter: string): boolean {
  const filter = rawFilter.trim();
  if (!filter) return true;
  if (!p) return false;

  if (p.value_type === "checkbox") {
    const wantsTrue = /^(y|yes|true|1|checked)$/i.test(filter);
    const wantsFalse = /^(n|no|false|0|unchecked)$/i.test(filter);
    if (wantsTrue) return p.value_checkbox === true;
    if (wantsFalse) return p.value_checkbox === false;
    return formatPropertyValue(p).toLowerCase().includes(filter.toLowerCase());
  }

  if (p.value_type === "number" || p.value_type === "date") {
    const match = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(filter);
    const op = match?.[1] ?? "=";
    const rhsRaw = (match?.[2] ?? filter).trim();
    if (p.value_type === "number") {
      const lhs = p.value_number;
      const rhs = Number(rhsRaw);
      if (lhs == null || Number.isNaN(rhs)) return false;
      switch (op) {
        case ">":
          return lhs > rhs;
        case "<":
          return lhs < rhs;
        case ">=":
          return lhs >= rhs;
        case "<=":
          return lhs <= rhs;
        default:
          return lhs === rhs;
      }
    }
    const lhs = p.value_date;
    if (!lhs) return false;
    switch (op) {
      case ">":
        return lhs > rhsRaw;
      case "<":
        return lhs < rhsRaw;
      case ">=":
        return lhs >= rhsRaw;
      case "<=":
        return lhs <= rhsRaw;
      default:
        return lhs === rhsRaw;
    }
  }

  return formatPropertyValue(p).toLowerCase().includes(filter.toLowerCase());
}

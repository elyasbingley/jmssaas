import { useState } from "react";
import { LINE_ITEM_UNITS } from "@jmssaas/shared";

// Shared by LineItemEditor.tsx and PriceBookItem.tsx - curated dropdown
// (LINE_ITEM_UNITS minus "other") plus a free-text field for anything not
// on the list. "other" is tracked as separate local state rather than
// derived purely from `value`, since an empty custom unit and "no unit
// chosen yet" would otherwise be indistinguishable.
const CURATED_UNITS = LINE_ITEM_UNITS.filter((u) => u !== "other");

const textInputStyle = {
  backgroundColor: "var(--jms-bg)",
  borderColor: "var(--jms-border)",
  color: "var(--jms-text)",
  fontFamily: "var(--jms-font)",
  fontSize: "var(--jms-font-body)",
} as const;

export function UnitSelect({ value, onChange }: { value: string | null | undefined; onChange: (unit: string | null) => void }) {
  const [otherMode, setOtherMode] = useState(() => !!value && !(CURATED_UNITS as readonly string[]).includes(value));

  return (
    <div>
      <select
        className="w-full rounded-md border px-3 py-2 focus:outline-none"
        style={textInputStyle}
        value={otherMode ? "other" : value ?? ""}
        onChange={(e) => {
          const next = e.target.value;
          if (next === "other") {
            setOtherMode(true);
            onChange(value && !(CURATED_UNITS as readonly string[]).includes(value) ? value : "");
          } else {
            setOtherMode(false);
            onChange(next === "" ? null : next);
          }
        }}
      >
        <option value="">No unit</option>
        {CURATED_UNITS.map((u) => (
          <option key={u} value={u}>
            {u}
          </option>
        ))}
        <option value="other">Other...</option>
      </select>
      {otherMode ? (
        <input
          type="text"
          placeholder="Unit (e.g. roll, sheet)"
          className="mt-1 w-full rounded-md border px-3 py-2 focus:outline-none"
          style={textInputStyle}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : null}
    </div>
  );
}

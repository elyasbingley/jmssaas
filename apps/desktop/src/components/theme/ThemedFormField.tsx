import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";

// Theme-aware sibling of components/FormField.tsx - see ThemedModal.tsx for
// why this isn't just a retheme of the shared original.
interface ThemedFormFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
}

const fieldLabelClass = "mb-1 block uppercase tracking-wide";
const fieldLabelStyle: React.CSSProperties = { color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)" };
const fieldInputClass = "w-full rounded border px-3 py-2 focus:outline-none";
const fieldInputStyle: React.CSSProperties = {
  backgroundColor: "var(--jms-bg)",
  borderColor: "var(--jms-border)",
  color: "var(--jms-text)",
  fontFamily: "var(--jms-font)",
  fontSize: "var(--jms-font-body)",
};

export function ThemedFormField({ label, id, className, style, ...props }: ThemedFormFieldProps) {
  const fieldId = id ?? label.toLowerCase().replace(/\s+/g, "-");
  return (
    <div className="mb-4">
      <label className={fieldLabelClass} style={fieldLabelStyle} htmlFor={fieldId}>
        {label}
      </label>
      <input id={fieldId} className={`${fieldInputClass} ${className ?? ""}`} style={{ ...fieldInputStyle, ...style }} {...props} />
    </div>
  );
}

interface ThemedTextAreaFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  labelHidden?: boolean;
}

export const ThemedTextAreaField = forwardRef<HTMLTextAreaElement, ThemedTextAreaFieldProps>(function ThemedTextAreaField(
  { label, labelHidden, id, className, style, ...props },
  ref
) {
  const fieldId = id ?? label.toLowerCase().replace(/\s+/g, "-");
  return (
    <div className="mb-4">
      <label className={`${fieldLabelClass} ${labelHidden ? "sr-only" : ""}`} style={fieldLabelStyle} htmlFor={fieldId}>
        {label}
      </label>
      <textarea id={fieldId} ref={ref} className={`${fieldInputClass} ${className ?? ""}`} style={{ ...fieldInputStyle, ...style }} {...props} />
    </div>
  );
});

interface ThemedSelectFieldProps<T extends string> {
  label: string;
  value: T | "";
  onChange: (value: T | "") => void;
  options: { value: T; label: string }[];
  placeholder?: string;
}

export function ThemedSelectField<T extends string>({ label, value, onChange, options, placeholder }: ThemedSelectFieldProps<T>) {
  const fieldId = label.toLowerCase().replace(/\s+/g, "-");
  return (
    <div className="mb-4">
      <label className={fieldLabelClass} style={fieldLabelStyle} htmlFor={fieldId}>
        {label}
      </label>
      <select
        id={fieldId}
        value={value}
        onChange={(e) => onChange(e.target.value as T | "")}
        className={fieldInputClass}
        style={fieldInputStyle}
      >
        <option value="">{placeholder ?? "None"}</option>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

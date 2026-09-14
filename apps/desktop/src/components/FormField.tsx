import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";

interface FormFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
}

export function FormField({ label, id, className, ...props }: FormFieldProps) {
  const fieldId = id ?? label.toLowerCase().replace(/\s+/g, "-");
  return (
    <div className="mb-4">
      <label className="mb-1 block text-sm font-semibold text-gray-700" htmlFor={fieldId}>
        {label}
      </label>
      <input
        id={fieldId}
        className={`w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none ${className ?? ""}`}
        {...props}
      />
    </div>
  );
}

interface TextAreaFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  // Keeps the <label>/htmlFor association (accessibility, click-to-focus)
  // without rendering visible label text - for callers like
  // EmailComposeModal's Body field that render their own label alongside
  // an action button (InsertLinkButton) and don't want it duplicated.
  labelHidden?: boolean;
}

// forwardRef so callers can reach the underlying <textarea> for
// cursor-position-aware insertions (InsertLinkButton's "wrap the current
// selection" behavior) - every existing caller ignores the ref, so this is
// purely additive.
export const TextAreaField = forwardRef<HTMLTextAreaElement, TextAreaFieldProps>(function TextAreaField(
  { label, labelHidden, id, className, ...props },
  ref
) {
  const fieldId = id ?? label.toLowerCase().replace(/\s+/g, "-");
  return (
    <div className="mb-4">
      <label className={`mb-1 block text-sm font-semibold text-gray-700 ${labelHidden ? "sr-only" : ""}`} htmlFor={fieldId}>
        {label}
      </label>
      <textarea
        id={fieldId}
        ref={ref}
        className={`w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none ${className ?? ""}`}
        {...props}
      />
    </div>
  );
});

interface SelectFieldProps<T extends string> {
  label: string;
  value: T | "";
  onChange: (value: T | "") => void;
  options: { value: T; label: string }[];
  placeholder?: string;
}

export function SelectField<T extends string>({ label, value, onChange, options, placeholder }: SelectFieldProps<T>) {
  const fieldId = label.toLowerCase().replace(/\s+/g, "-");
  return (
    <div className="mb-4">
      <label className="mb-1 block text-sm font-semibold text-gray-700" htmlFor={fieldId}>
        {label}
      </label>
      <select
        id={fieldId}
        value={value}
        onChange={(e) => onChange(e.target.value as T | "")}
        className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
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

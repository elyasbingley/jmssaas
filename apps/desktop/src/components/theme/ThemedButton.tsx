import type { ButtonHTMLAttributes } from "react";

interface ThemedButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger";
}

// Padding is a `style` default (paddingBlock/paddingInline), not a
// Tailwind class, specifically so callers can override the size via the
// `style` prop (e.g. `style={{ paddingBlock: 12, paddingInline: 24 }}`)
// without a losing specificity fight against the base `px-4 py-2` class -
// two same-specificity utility classes resolve by CSS source order, not
// JSX order, so appending a conflicting padding class via `className`
// would be unreliable.
export function ThemedButton({ variant = "primary", className, style, disabled, ...props }: ThemedButtonProps) {
  const base: React.CSSProperties = {
    fontFamily: "var(--jms-font)",
    fontSize: "var(--jms-font-button)",
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    borderWidth: 1,
    borderStyle: "solid",
    paddingBlock: 8,
    paddingInline: 16,
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? "not-allowed" : "pointer",
  };
  const variantStyle: React.CSSProperties =
    variant === "primary"
      ? { backgroundColor: "var(--jms-accent)", borderColor: "var(--jms-accent)", color: "var(--jms-bg)", boxShadow: "0 0 10px var(--jms-accent-glow)" }
      : variant === "danger"
        ? { backgroundColor: "transparent", borderColor: "var(--jms-danger)", color: "var(--jms-danger)" }
        : { backgroundColor: "transparent", borderColor: "var(--jms-border)", color: "var(--jms-accent)" };

  return (
    <button className={`rounded font-semibold ${className ?? ""}`} style={{ ...base, ...variantStyle, ...style }} disabled={disabled} {...props} />
  );
}

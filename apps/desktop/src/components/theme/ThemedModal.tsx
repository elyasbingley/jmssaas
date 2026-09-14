import type { ReactNode } from "react";

// Theme-aware sibling of components/Modal.tsx, used only from screens that
// have opted into the CRT theme so every other screen's modals are left
// exactly as they were.
export function ThemedModal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
      style={{ fontFamily: "var(--jms-font)" }}
    >
      <div
        className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded p-6"
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: "var(--jms-surface)",
          border: "1px solid var(--jms-border)",
          boxShadow: "0 0 16px var(--jms-accent-glow)",
          color: "var(--jms-text)",
        }}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 text-xl leading-none"
          style={{ color: "var(--jms-text-muted)" }}
        >
          &times;
        </button>
        <h2
          className="mb-4 pr-6 uppercase tracking-widest"
          style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}
        >
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

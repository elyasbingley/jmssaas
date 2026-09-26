import { useState, type RefObject } from "react";
import { ThemedModal } from "./theme/ThemedModal";
import { ThemedFormField } from "./theme/ThemedFormField";
import { ThemedButton } from "./theme/ThemedButton";

// Inserts an <a href="..."> tag into a plain-text body field at the
// current cursor position (or wraps the current selection as the link
// text) - the send pipeline already renders template/composer bodies as
// HTML (see process-scheduled-comms's sendEmail: `html: body.replace(/\n/g,
// "<br>")`), so raw <a> markup in the body already worked, this just saves
// having to type it by hand. Shared by AutomationSettings.tsx's template
// editor and EmailComposeModal.tsx (and, through that, every "send email"
// button in the app - job, quote, invoice, purchase order, report).
export function InsertLinkButton({
  textareaRef,
  value,
  onChange,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [linkText, setLinkText] = useState("");
  const [url, setUrl] = useState("");
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openModal = () => {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    setSelection({ start, end });
    setLinkText(start !== end ? value.slice(start, end) : "");
    setUrl("");
    setError(null);
    setOpen(true);
  };

  const insertLink = () => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      setError("Enter a URL");
      return;
    }
    // A business owner typing "bingleytrades.com.au" shouldn't need to
    // remember the scheme - default to https rather than rejecting it.
    const href = /^[a-z][a-z0-9+.-]*:/i.test(trimmedUrl) ? trimmedUrl : `https://${trimmedUrl}`;
    const text = linkText.trim() || href;
    const tag = `<a href="${href}">${text}</a>`;
    const { start, end } = selection ?? { start: value.length, end: value.length };
    const next = value.slice(0, start) + tag + value.slice(end);
    onChange(next);
    setOpen(false);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      el?.focus();
      el?.setSelectionRange(start + tag.length, start + tag.length);
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        className="rounded border px-2 py-1 font-semibold"
        style={{ borderColor: "var(--jms-border)", color: "var(--jms-accent)", fontSize: "var(--jms-font-label)" }}
      >
        🔗 Insert link
      </button>
      <ThemedModal open={open} onClose={() => setOpen(false)} title="Insert link">
        <ThemedFormField label="Link text" value={linkText} onChange={(e) => setLinkText(e.target.value)} placeholder="e.g. View your invoice" />
        <ThemedFormField label="URL" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" />
        {error ? (
          <p className="mb-4" style={{ color: "var(--jms-danger)", fontSize: "var(--jms-font-body)" }}>
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <button onClick={() => setOpen(false)} className="px-4 py-2 font-semibold" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-body)" }}>
            Cancel
          </button>
          <ThemedButton onClick={insertLink}>Insert</ThemedButton>
        </div>
      </ThemedModal>
    </>
  );
}

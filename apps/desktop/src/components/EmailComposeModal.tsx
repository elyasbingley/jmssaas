import { useEffect, useRef, useState } from "react";
import type { EmailAttachment } from "@jmssaas/shared";
import { Modal } from "./Modal";
import { FormField, TextAreaField } from "./FormField";
import { InsertLinkButton } from "./InsertLinkButton";
import { getErrorMessage } from "../lib/errors";

export interface EmailTemplateOption {
  id: string;
  name: string;
  subject: string;
  body: string;
}

// Kept well under Resend's ~40MB total request limit - base64 inflates
// raw file size by ~33%, and this is a per-file guardrail, not a total
// one, so a few of these together could still get close. Good enough for
// "stop someone attaching an entire video by mistake" without needing a
// running total.
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

interface EmailComposeModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  defaultTo: string;
  defaultSubject: string;
  defaultBody: string;
  // Every email address linked to this client/job (see
  // packages/shared/src/email-recipients.ts's collectRecipientEmails) -
  // rendered as click-to-add chips under To/Cc/Bcc, the "drop down" of
  // already-known addresses the person asked for, without needing a full
  // tag-input widget to get there.
  recipientOptions: string[];
  templates?: EmailTemplateOption[];
  // Pre-attached when the modal opens - the quote/invoice PDF for
  // QuoteDetail/InvoiceDetail's send buttons, empty everywhere else.
  // Still shown as a removable attachment, same as anything the user adds
  // themselves, in case they genuinely don't want it on this particular
  // send.
  defaultAttachments?: EmailAttachment[];
  onSend: (payload: { to: string; cc: string; bcc: string; subject: string; body: string; attachments: EmailAttachment[] }) => Promise<void>;
  sendLabel?: string;
}

// One editable-body, To/Cc/Bcc, optional-template compose modal, used
// everywhere this app sends an email (quote/invoice delivery, job review
// requests, and the free-form job card email) so "the email body should
// pop up and be editable" and "let me cc/bcc people" only need building
// once, not once per send button.
export function EmailComposeModal({
  open,
  onClose,
  title,
  defaultTo,
  defaultSubject,
  defaultBody,
  recipientOptions,
  templates,
  defaultAttachments,
  onSend,
  sendLabel,
}: EmailComposeModalProps) {
  const [to, setTo] = useState(defaultTo);
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState(defaultBody);
  const [templateId, setTemplateId] = useState("");
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [attachments, setAttachments] = useState<EmailAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setTo(defaultTo);
      setCc("");
      setBcc("");
      setSubject(defaultSubject);
      setBody(defaultBody);
      setTemplateId("");
      setShowCcBcc(false);
      setAttachments(defaultAttachments ?? []);
      setAttachmentError(null);
      setError(null);
    }
    // Only re-seed when the modal opens, not on every prop change while
    // it's already open, so it doesn't clobber in-progress edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleAddAttachments = async (files: FileList) => {
    setAttachmentError(null);
    const oversized = Array.from(files).find((f) => f.size > MAX_ATTACHMENT_BYTES);
    if (oversized) {
      setAttachmentError(`${oversized.name} is too large (max 10MB per file)`);
      return;
    }
    try {
      const newAttachments = await Promise.all(
        Array.from(files).map(async (file) => ({ filename: file.name, content: await readFileAsDataUrl(file) }))
      );
      setAttachments((prev) => [...prev, ...newAttachments]);
    } catch (e) {
      setAttachmentError(e instanceof Error ? e.message : "Failed to attach file");
    }
  };

  const addToField = (field: "to" | "cc" | "bcc", email: string) => {
    const current = field === "to" ? to : field === "cc" ? cc : bcc;
    const parts = current
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.some((p) => p.toLowerCase() === email.toLowerCase())) return;
    const next = [...parts, email].join(", ");
    if (field === "to") setTo(next);
    else if (field === "cc") setCc(next);
    else setBcc(next);
  };

  const handleSend = async () => {
    if (!to.trim()) {
      setError("Add at least one recipient");
      return;
    }
    setSending(true);
    setError(null);
    try {
      await onSend({ to: to.trim(), cc: cc.trim(), bcc: bcc.trim(), subject, body, attachments });
      onClose();
    } catch (e) {
      // Supabase's PostgrestError isn't a real Error instance (no
      // `instanceof Error` match), so a plain `e instanceof Error ?
      // e.message : fallback` check silently swallows the actual DB error
      // message/hint and shows nothing but "Failed to send" - getErrorMessage
      // (already used everywhere else in the app for this exact reason)
      // reads `.message`/`.hint` off any object shape, not just real Errors.
      setError(getErrorMessage(e, "Failed to send"));
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={title}>
      {templates && templates.length > 0 ? (
        <div className="mb-4">
          <label className="mb-1 block text-sm font-semibold text-gray-700">Template</label>
          <select
            value={templateId}
            onChange={(e) => {
              setTemplateId(e.target.value);
              const template = templates.find((t) => t.id === e.target.value);
              if (template) {
                setSubject(template.subject);
                setBody(template.body);
              }
            }}
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          >
            <option value="">Write from scratch</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <FormField label="To" value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@example.com" />
      {recipientOptions.length > 0 ? (
        <RecipientChips options={recipientOptions} onPick={(email) => addToField("to", email)} />
      ) : null}

      {!showCcBcc ? (
        <button onClick={() => setShowCcBcc(true)} className="mb-4 text-xs font-semibold text-blue-700 hover:underline">
          + Cc / Bcc
        </button>
      ) : (
        <>
          <FormField label="Cc" value={cc} onChange={(e) => setCc(e.target.value)} placeholder="name@example.com, another@example.com" />
          {recipientOptions.length > 0 ? <RecipientChips options={recipientOptions} onPick={(email) => addToField("cc", email)} /> : null}
          <FormField label="Bcc" value={bcc} onChange={(e) => setBcc(e.target.value)} placeholder="name@example.com" />
          {recipientOptions.length > 0 ? <RecipientChips options={recipientOptions} onPick={(email) => addToField("bcc", email)} /> : null}
        </>
      )}

      <FormField label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
      <div className="mb-1 flex items-center justify-between">
        <label className="block text-sm font-semibold text-gray-700">Body</label>
        <InsertLinkButton textareaRef={bodyRef} value={body} onChange={setBody} />
      </div>
      <TextAreaField label="Body" labelHidden rows={10} value={body} onChange={(e) => setBody(e.target.value)} ref={bodyRef} />

      <div className="mb-4">
        <label className="mb-1 block text-sm font-semibold text-gray-700">Attachments</label>
        {attachments.length > 0 ? (
          <ul className="mb-2 space-y-1">
            {attachments.map((a, i) => (
              <li key={`${a.filename}-${i}`} className="flex items-center justify-between rounded-md bg-gray-100 px-2.5 py-1.5 text-xs text-gray-700">
                <span className="truncate">📎 {a.filename}</span>
                <button
                  type="button"
                  onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                  className="ml-2 shrink-0 font-semibold text-red-600 hover:underline"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <label className="inline-block cursor-pointer text-xs font-semibold text-blue-700 hover:underline">
          + Add attachment
          <input
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) void handleAddAttachments(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
        {attachmentError ? <p className="mt-1 text-xs text-red-600">{attachmentError}</p> : null}
      </div>

      {error ? <p className="mb-4 text-sm text-red-600">{error}</p> : null}
      <div className="flex justify-end gap-3">
        <button onClick={onClose} className="px-4 py-2 text-sm font-semibold text-gray-600">
          Cancel
        </button>
        <button
          onClick={handleSend}
          disabled={sending}
          className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
        >
          {sending ? "Sending..." : (sendLabel ?? "Send")}
        </button>
      </div>
    </Modal>
  );
}

function RecipientChips({ options, onPick }: { options: string[]; onPick: (email: string) => void }) {
  return (
    <div className="-mt-2 mb-4 flex flex-wrap gap-1.5">
      {options.map((email) => (
        <button
          key={email}
          type="button"
          onClick={() => onPick(email)}
          className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-200"
        >
          + {email}
        </button>
      ))}
    </div>
  );
}

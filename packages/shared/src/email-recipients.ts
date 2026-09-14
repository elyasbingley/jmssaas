// Builds the recipient-suggestion list for the email composer: every email
// address linked to a client (their own + any client_contacts) plus any
// address found written down in a job's own notes/description text, so a
// technician who scribbled "cc the site foreman - foreman@site.com" in a
// job note doesn't need that contact re-entered anywhere to show up as a
// pickable option later.

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

export function extractEmailsFromText(text: string | null | undefined): string[] {
  if (!text) return [];
  return text.match(EMAIL_PATTERN) ?? [];
}

export interface RecipientSource {
  clientEmail?: string | null;
  contactEmails?: (string | null)[];
  freeText?: (string | null)[];
}

// Case-insensitively deduped, original casing of the first occurrence kept.
export function collectRecipientEmails(source: RecipientSource): string[] {
  const seen = new Map<string, string>();
  const add = (email: string | null | undefined) => {
    if (!email) return;
    const trimmed = email.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) seen.set(key, trimmed);
  };

  add(source.clientEmail);
  (source.contactEmails ?? []).forEach(add);
  (source.freeText ?? []).forEach((text) => extractEmailsFromText(text).forEach(add));

  return Array.from(seen.values());
}

// Follow-up sequences (see the follow_up_sequences migration). The texts
// themselves are rendered by the database (follow_up_render); these are the
// same rules for the desktop's previews and text counts.

export type FollowUpSequenceKey = "storm_checklist" | "storm_morning" | "quote_quiet" | "asset_service" | "asset_replacement";

export interface FollowUpSequence {
  id: string;
  tenant_id: string;
  key: FollowUpSequenceKey;
  name: string;
  enabled: boolean;
  settings: {
    checklist_link?: string;
    email_from_name?: string;
    guarantee?: string;
    guarantee_by_category?: Record<string, string>;
    payment_plan_line?: string;
  };
  created_at: string;
  updated_at: string;
}

export interface FollowUpStep {
  id: string;
  tenant_id: string;
  sequence_id: string;
  position: number;
  day_offset: number;
  label: string | null;
  body: string;
  video_link: string | null;
  also_email: boolean;
  email_subject: string | null;
  updated_at: string;
}

export type FollowUpStopReason = "replied" | "booked" | "opted_out" | "quote_closed" | "newer_quote" | "manual";

export interface FollowUpEnrolment {
  id: string;
  tenant_id: string;
  sequence_id: string;
  client_id: string | null;
  job_card_id: string | null;
  quote_id: string | null;
  phone: string;
  email: string | null;
  vars: { first_name?: string; suburb?: string; job?: string; quote_total?: string; category_id?: string | null };
  is_test: boolean;
  status: "active" | "completed" | "stopped";
  stop_reason: FollowUpStopReason | string | null;
  stopped_at: string | null;
  enrolled_at: string;
  next_position: number;
  next_due_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FollowUpMessage {
  id: string;
  enrolment_id: string;
  step_position: number;
  channel: "sms" | "email";
  recipient: string | null;
  body: string | null;
  status: "sent" | "failed" | "skipped";
  detail: string | null;
  created_at: string;
}

export const FOLLOW_UP_STOP_LABELS: Record<string, string> = {
  replied: "They replied",
  booked: "Job booked",
  opted_out: "Opted out (STOP)",
  quote_closed: "Quote declined or expired",
  newer_quote: "Newer quote sent",
  manual: "Stopped by you",
};

export const FOLLOW_UP_FIELDS: Record<FollowUpSequenceKey, string[]> = {
  storm_checklist: ["{first_name}", "{suburb}", "{checklist_link}", "{video_link}"],
  storm_morning: ["{first_name}", "{suburb}"],
  quote_quiet: ["{first_name}", "{job}", "{quote_total}", "{guarantee}"],
  asset_service: ["{first_name}", "{items}", "{address}"],
  asset_replacement: ["{first_name}", "{item}", "{age}", "{address}"],
};

// Same as the database's sms_plain_text: straight quotes, no long dashes.
export function smsPlainText(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/ /g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

// Same as the database's follow_up_render.
export function renderFollowUp(body: string, vars: Record<string, string | null | undefined>): string {
  let text = body;
  for (const [key, value] of Object.entries(vars)) text = text.split(`{${key}}`).join(value ?? "");
  return smsPlainText(text);
}

// The plain SMS alphabet (GSM 03.38). Anything outside it - an emoji, a
// curly quote the cleaner missed - switches the whole text to the 70-
// character Unicode encoding.
const GSM_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "^{}\\[~]|€\f";

export function smsCount(text: string): { characters: number; texts: number; unicode: boolean; unicodeChars: string[] } {
  const chars = [...text];
  const unicodeChars = [...new Set(chars.filter((c) => !GSM_BASIC.includes(c) && !GSM_EXTENDED.includes(c)))];
  const unicode = unicodeChars.length > 0;
  const length = unicode ? chars.length : chars.reduce((n, c) => n + (GSM_EXTENDED.includes(c) ? 2 : 1), 0);
  const texts = length === 0 ? 0 : unicode ? (length <= 70 ? 1 : Math.ceil(length / 67)) : length <= 160 ? 1 : Math.ceil(length / 153);
  return { characters: length, texts, unicode, unicodeChars };
}

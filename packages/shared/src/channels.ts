// Channels - a consolidated per-client communications hub (SMS, WhatsApp,
// Facebook Messenger, Instagram DMs) - see the channels migration's own
// comment for the full picture, including why Email is deliberately NOT
// one of the real channel_type values (it's folded in from the existing
// inbox_messages table at query/display time instead of duplicated here).
// The row-shaped types (ChannelConnection/ChannelConversation/
// ChannelMessage) live in types.ts, same convention as Knowledge/Inbox -
// this file only holds the UI-only widened type and the phone helper.

import type { ChannelType } from "./types";

// The Channels UI displays a fifth pseudo-channel (the existing Inbox
// email threads) alongside the four real ones - this widened type is for
// anywhere the UI needs to talk about "any channel including email"
// (icons, badges, filters), never for a database row's own channel_type.
export type ChannelTypeOrEmail = ChannelType | "email";

// Only Australian local-format input needs special-casing here - anything
// already E.164 (leading "+") is trusted as-is regardless of country. This
// is deliberately narrow rather than a general phone-parsing library
// (libphonenumber and friends): the previous SMS attempt broke specifically
// because a local AU-format number was stored and sent to Twilio unchanged
// (see docs/SETUP.md's "SMS removed" section) - null-on-anything-uncertain
// is safer than a library silently normalising an ambiguous number wrong.
export function toE164(rawPhone: string, defaultCountry: "AU" = "AU"): string | null {
  const trimmed = rawPhone.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15) return null;
    return `+${digits}`;
  }

  const digitsOnly = trimmed.replace(/\D/g, "");
  if (!digitsOnly) return null;

  if (defaultCountry === "AU") {
    // "0491 570 156" -> "+61491570156"
    if (digitsOnly.startsWith("0") && digitsOnly.length === 10) {
      return `+61${digitsOnly.slice(1)}`;
    }
    // Already has the country code but no leading "+", e.g. "61491570156".
    if (digitsOnly.startsWith("61") && digitsOnly.length === 11) {
      return `+${digitsOnly}`;
    }
  }

  return null;
}

export function isValidE164(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

// SMS/WhatsApp/Messenger/Instagram message bodies are plain text - neither
// RN's <Text> nor a browser auto-linkifies a bare URL inside one, so both
// mobile (app/channels/[id].tsx) and desktop (ChannelConversationDetail.tsx)
// split a message body through this before rendering, and turn only the
// "url" segments into a tappable/clickable link. Deliberately no `www.`-only
// matching (no scheme) - too easy to false-positive on an ordinary sentence
// fragment like "see you Wed. thanks" - a real link a customer pastes from
// their phone's share sheet always carries a scheme.
const URL_PATTERN = /https?:\/\/[^\s<>]+/g;

export function splitTextWithLinks(text: string): { text: string; isUrl: boolean }[] {
  const segments: { text: string; isUrl: boolean }[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    if (start > lastIndex) segments.push({ text: text.slice(lastIndex, start), isUrl: false });
    // Trim trailing punctuation a sentence would put right after the URL
    // (".", ",", ")", "!", "?") so "check https://example.com." doesn't
    // treat the full stop as part of the link.
    let url = match[0];
    let trailing = "";
    while (url.length > 0 && /[.,!?)]/.test(url[url.length - 1]!)) {
      trailing = url[url.length - 1]! + trailing;
      url = url.slice(0, -1);
    }
    segments.push({ text: url, isUrl: true });
    if (trailing) segments.push({ text: trailing, isUrl: false });
    lastIndex = start + match[0].length;
  }
  if (lastIndex < text.length) segments.push({ text: text.slice(lastIndex), isUrl: false });
  return segments;
}

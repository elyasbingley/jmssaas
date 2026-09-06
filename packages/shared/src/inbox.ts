// Inbox - the shape of inbox_messages.parsed_job_suggestion, written by
// the process-inbox-ai-parse Edge Function (Claude) and read by the
// Inbox screen's "Create job" review form. Deliberately just a
// suggestion, never applied automatically - see the inbox migration's own
// comment on why AI-parsed jobs always go through a human review step
// (a bad parse creates a wrong job otherwise, with no one in the loop to
// catch it before it exists).
//
// Every field is optional/nullable: the model is asked to extract what it
// can find and leave the rest blank rather than guess, so the review form
// always shows real gaps as empty fields instead of silently-wrong filled
// ones.
export interface InboxJobSuggestion {
  client_name: string | null;
  client_email: string | null;
  client_phone: string | null;
  address_line1: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  title: string | null;
  description: string | null;
  // The model's own confidence in this parse - shown on the review form
  // so an admin knows to double-check a "low" one more carefully rather
  // than skimming it like a "high" one.
  confidence: "low" | "medium" | "high";
}

// Inbox - drafts a job suggestion from a text-only inbox message (no
// attachment) using Claude, per the "Draft + review queue" decision: this
// NEVER creates a job_cards row itself, only writes parsed_job_suggestion +
// status 'needs_review' for an admin to review/edit/approve from the Inbox
// screen (see InboxJobSuggestion in packages/shared/src/inbox.ts). Called
// by resend-inbound-webhook right after a message with no attachments and
// a non-empty text body lands - never invoked directly by either app.
//
// Uses the official Anthropic SDK via Deno's npm: specifier (same pattern
// as every other function here importing npm:@supabase/supabase-js@2), not
// a raw fetch - tool use with strict:true guarantees the response matches
// InboxJobSuggestion's shape exactly, so no ad-hoc JSON-parsing/validation
// of freeform model output is needed here.

import Anthropic from "npm:@anthropic-ai/sdk@0.71.0";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const EXTRACT_TOOL_NAME = "extract_job_suggestion";

// Mirrors InboxJobSuggestion exactly - see that type's own comment on why
// every field is nullable (the model is asked to leave gaps blank rather
// than guess, so the review form shows real gaps instead of silently-
// wrong filled ones).
const EXTRACT_TOOL_SCHEMA = {
  type: "object",
  properties: {
    client_name: { type: ["string", "null"], description: "The sender's or requester's full name, if mentioned" },
    client_email: { type: ["string", "null"], description: "A contact email, if different from the message's From address" },
    client_phone: { type: ["string", "null"], description: "A phone number mentioned in the email" },
    address_line1: { type: ["string", "null"], description: "The job site's street address" },
    suburb: { type: ["string", "null"] },
    state: { type: ["string", "null"], description: "Australian state/territory abbreviation, e.g. NSW" },
    postcode: { type: ["string", "null"] },
    title: { type: ["string", "null"], description: "A short job title summarising the request, e.g. 'Roof leak repair'" },
    description: { type: ["string", "null"], description: "A fuller description of the work requested, in the sender's own words where possible" },
    confidence: {
      type: "string",
      enum: ["low", "medium", "high"],
      description: "How confident you are that this email is actually a quote request or work order, and that the extracted fields are accurate",
    },
  },
  required: ["client_name", "client_email", "client_phone", "address_line1", "suburb", "state", "postcode", "title", "description", "confidence"],
  additionalProperties: false,
};

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!SUPABASE_SERVICE_ROLE_KEY || !ANTHROPIC_API_KEY) return json({ error: "server_error" }, 500);

  // Same trust model as every other inter-function call in this app
  // (process-scheduled-comms, xero-sync, ...): the service role key is
  // the shared secret, checked here since this function is reachable over
  // the public internet like any other Edge Function.
  const authHeader = req.headers.get("authorization") ?? "";
  if (authHeader !== `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`) return json({ error: "unauthorized" }, 401);

  let body: { message_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!body.message_id) return json({ error: "message_id_required" }, 400);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: message, error: fetchError } = await admin
    .from("inbox_messages")
    .select("id, from_email, from_name, subject, body_text")
    .eq("id", body.message_id)
    .single();
  if (fetchError || !message) {
    console.error("[process-inbox-ai-parse] Message not found", body.message_id, fetchError);
    return json({ error: "not_found" }, 404);
  }

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  try {
    const response = await anthropic.messages.create({
      model: "claude-opus-5",
      max_tokens: 1024,
      tools: [
        {
          name: EXTRACT_TOOL_NAME,
          description:
            "Extract job/quote-request details (client contact info, site address, a short title, and a description) from an inbound email that may be a trade quote request or work order.",
          // @ts-ignore - `strict` isn't yet in this SDK version's Tool type but is a valid API field.
          strict: true,
          input_schema: EXTRACT_TOOL_SCHEMA,
        },
      ],
      tool_choice: { type: "tool", name: EXTRACT_TOOL_NAME },
      messages: [
        {
          role: "user",
          content: [
            "This email arrived at a trade business's job intake inbox. Extract any quote-request/work-order details it contains.",
            "Leave a field null rather than guessing if the email doesn't actually say it.",
            "",
            `From: ${message.from_name ? `${message.from_name} <${message.from_email}>` : message.from_email}`,
            `Subject: ${message.subject ?? "(no subject)"}`,
            "",
            message.body_text ?? "",
          ].join("\n"),
        },
      ],
    });

    const toolUse = response.content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
    if (!toolUse) {
      console.error("[process-inbox-ai-parse] No tool_use block in response", response.stop_reason);
      return json({ error: "no_extraction" }, 502);
    }

    const { error: updateError } = await admin
      .from("inbox_messages")
      .update({ parsed_job_suggestion: toolUse.input, status: "needs_review", parsed_at: new Date().toISOString() })
      .eq("id", message.id);
    if (updateError) throw updateError;

    return json({ ok: true });
  } catch (e) {
    console.error("[process-inbox-ai-parse] Failed to parse message", message.id, e);
    return json({ error: "server_error" }, 500);
  }
});

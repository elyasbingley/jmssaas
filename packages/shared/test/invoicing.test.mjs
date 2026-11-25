import test from "node:test";
import assert from "node:assert/strict";
import * as a from "../src/analytics.ts";
import * as v from "../src/invoicing.ts";

const job = (over) => ({ id: "j?", number: null, title: "Job", client_id: "c1", site_id: null, created_at: "2026-08-01T00:00:00+00:00", completed_at: null, service_category_id: null, lifecycle_stage_id: null, lead_source_id: null, callback_of_job_card_id: null, ...over });
const inv = (over) => ({ id: "i?", job_card_id: null, client_id: "c1", site_id: null, invoice_number: "INV", status: "sent", total_cents: 0, issue_date: "2026-08-01", due_date: null, paid_at: null, amount_paid_cents: 0, ...over });
const quote = (over) => ({ id: "q?", job_card_id: null, client_id: "c1", quote_number: "Q", status: "sent", total_cents: 0, issue_date: "2026-08-01", lost_reason_category: null, ...over });
const client = (over) => ({ id: "c?", name: "Client", suburb: null, postcode: null, google_review_stars: null, google_review_recorded_at: null, ...over });
const ix = (over) => a.indexAnalytics({ jobs: [], quotes: [], invoices: [], clients: [], sites: [], categories: [], stages: [], leadSources: [], ...over });
const TODAY = "2026-11-25";

test("items by status", () => {
  const data = ix({
    jobs: [job({ id: "j1" }), job({ id: "j2" })],
    quotes: [
      quote({ id: "q1", status: "sent", total_cents: 1000 }),
      quote({ id: "q2", status: "draft", total_cents: 9999 }),
      quote({ id: "q3", status: "accepted", total_cents: 5000, job_card_id: "j1" }),
      quote({ id: "q4", status: "accepted", total_cents: 7000, job_card_id: "j2" }),
    ],
    invoices: [
      inv({ id: "i1", status: "draft", total_cents: 300, job_card_id: "j2" }),
      inv({ id: "i2", status: "sent", total_cents: 1000, amount_paid_cents: 400, due_date: "2026-12-01" }),
      inv({ id: "i3", status: "sent", total_cents: 2000, due_date: "2026-11-01" }),
      inv({ id: "i4", status: "overdue", total_cents: 500 }),
      inv({ id: "i5", status: "paid", total_cents: 800, paid_at: "2026-11-03T01:00:00+00:00" }),
      inv({ id: "i6", status: "paid", total_cents: 900, paid_at: "2026-10-30T01:00:00+00:00" }),
      inv({ id: "i7", status: "void", total_cents: 100000, job_card_id: "j1" }),
    ],
  });
  const rows = Object.fromEntries(v.itemsByStatus(data, TODAY).map((r) => [r.key, [r.cents, r.count]]));
  assert.deepEqual(rows, {
    open_quotes: [1000, 1],
    // q4's job already has a (draft) invoice; a void invoice doesn't count
    accepted_not_invoiced: [5000, 1],
    draft_invoices: [300, 1],
    awaiting_payment: [600, 1],
    overdue: [2500, 2],
    paid_this_month: [800, 1],
  });
});

test("money coming in by due date (what's owing)", () => {
  const data = ix({
    invoices: [
      inv({ id: "a", total_cents: 100, due_date: "2026-08-01" }), // 116 days late
      inv({ id: "b", total_cents: 200, due_date: "2026-10-10" }), // 46 late
      inv({ id: "c", total_cents: 300, due_date: "2026-11-24" }), // 1 late
      inv({ id: "d", total_cents: 400, due_date: "2026-11-25" }), // due today
      inv({ id: "e", total_cents: 500, due_date: "2026-12-10", amount_paid_cents: 100 }),
      inv({ id: "f", total_cents: 600 }), // no due date
      inv({ id: "g", total_cents: 700, status: "overdue" }), // marked overdue, no date
      inv({ id: "h", total_cents: 800, status: "paid" }),
      inv({ id: "k", total_cents: 900, amount_paid_cents: 900 }), // fully paid by part payments
    ],
  });
  const b = Object.fromEntries(v.moneyComingIn(data, TODAY).map((x) => [x.key, x.cents]));
  assert.deepEqual(b, { late_60: 100, late_31: 200, late_1: 1000, week: 400, month: 400, later: 600 });
});

test("debtors: owing per client, overdue part, oldest days late", () => {
  const data = ix({
    clients: [client({ id: "c1", name: "Rizzo" }), client({ id: "c2", name: "Cathy" })],
    invoices: [
      inv({ id: "1", client_id: "c1", total_cents: 3000, due_date: "2026-11-15" }),
      inv({ id: "2", client_id: "c1", total_cents: 500, due_date: "2026-12-15" }),
      inv({ id: "3", client_id: "c2", total_cents: 1000, due_date: "2026-10-26" }),
      inv({ id: "4", client_id: "c2", total_cents: 9000, status: "paid" }),
    ],
  });
  const rows = v.debtors(data, TODAY).map((r) => [r.name, r.cents, r.overdueCents, r.oldestDaysLate]);
  assert.deepEqual(rows, [
    ["Rizzo", 3500, 3000, 10],
    ["Cathy", 1000, 1000, 30],
  ]);
});

test("invoiced by month, lead sources and days to pay", () => {
  const data = ix({
    jobs: [job({ id: "j1", lead_source_id: "ls1" }), job({ id: "j2" })],
    leadSources: [{ id: "ls1", name: "Google" }],
    invoices: [
      inv({ id: "1", total_cents: 1000, issue_date: "2026-11-02", job_card_id: "j1", status: "paid", paid_at: "2026-11-12T03:00:00+00:00" }),
      inv({ id: "2", total_cents: 500, issue_date: "2026-10-05", job_card_id: "j2", status: "paid", paid_at: "2026-10-25T03:00:00+00:00" }),
      inv({ id: "3", total_cents: 700, issue_date: "2025-11-30" }), // 12 months back - outside
      inv({ id: "4", total_cents: 999, issue_date: "2026-11-03", status: "draft" }),
    ],
  });
  const months = v.invoicedByMonth(data, TODAY, 12);
  assert.equal(months.length, 12);
  assert.equal(months[0].month, "2025-12");
  assert.equal(months[11].cents, 1000);
  assert.equal(months[10].cents, 500);
  const sources = v.revenueByLeadSource(data, { from: "2026-01-01", to: TODAY }).map((r) => [r.label, r.cents]);
  assert.deepEqual(sources, [["Google", 1000], ["No source recorded", 500]]);
  assert.deepEqual(v.averageDaysToPay(data, TODAY, 90), { average: 15, count: 2 });
});

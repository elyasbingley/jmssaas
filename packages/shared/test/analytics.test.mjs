// Run with `pnpm --filter @jmssaas/shared test` (sets TZ=Australia/Sydney,
// which the timestamp-to-local-day cases below rely on).
import test from "node:test";
import assert from "node:assert/strict";
import * as a from "../src/analytics.ts";

const job = (over) => ({
  id: "j?", number: null, title: "Job", client_id: "c1", site_id: null, created_at: "2026-08-01T00:00:00+00:00",
  completed_at: null, service_category_id: null, lifecycle_stage_id: null, lead_source_id: null, callback_of_job_card_id: null, ...over,
});
const inv = (over) => ({
  id: "i?", job_card_id: null, client_id: "c1", site_id: null, invoice_number: "INV", status: "sent", total_cents: 0,
  issue_date: "2026-08-01", due_date: null, paid_at: null, ...over,
});
const quote = (over) => ({
  id: "q?", job_card_id: null, client_id: "c1", quote_number: "Q", status: "sent", total_cents: 0, issue_date: "2026-08-01", lost_reason_category: null, ...over,
});
const client = (over) => ({ id: "c?", name: "Client", suburb: null, postcode: null, google_review_stars: null, google_review_recorded_at: null, ...over });
const data = (over) => a.indexAnalytics({ jobs: [], quotes: [], invoices: [], clients: [], sites: [], categories: [], stages: [], leadSources: [], ...over });

test("timestamps become local Sydney days, date-only values pass through", () => {
  assert.equal(process.env.TZ, "Australia/Sydney");
  // 30 June 22:30 UTC is 1 July 08:30 in Sydney - the first day of the FY.
  assert.equal(a.toDayKey("2026-06-30T22:30:00+00:00"), "2026-07-01");
  assert.equal(a.toDayKey("2026-06-30"), "2026-06-30");
  assert.equal(a.monthKeyOf("2026-06-30T22:30:00+00:00"), "2026-07");
});

test("day arithmetic crosses months, years, leap days and daylight saving", () => {
  assert.equal(a.addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(a.addDays("2028-03-01", -1), "2028-02-29");
  assert.equal(a.addDays("2026-12-31", 1), "2027-01-01");
  // Sydney DST ends 5 April 2026 and starts 4 October 2026.
  assert.equal(a.addDays("2026-04-04", 2), "2026-04-06");
  assert.equal(a.daysBetween("2026-10-03", "2026-10-05"), 2);
  assert.equal(a.addYears("2028-02-29", -1), "2027-02-28");
});

test("preset ranges", () => {
  assert.deepEqual(a.presetRange("7d", "2026-11-16"), { from: "2026-11-10", to: "2026-11-16" });
  assert.deepEqual(a.presetRange("28d", "2026-11-16"), { from: "2026-10-20", to: "2026-11-16" });
  assert.deepEqual(a.presetRange("last_quarter", "2026-11-16"), { from: "2026-07-01", to: "2026-09-30" });
  assert.deepEqual(a.presetRange("last_quarter", "2026-02-10"), { from: "2025-10-01", to: "2025-12-31" });
  assert.deepEqual(a.presetRange("fy", "2026-11-16"), { from: "2026-07-01", to: "2026-11-16" });
  assert.deepEqual(a.presetRange("fy", "2026-06-30"), { from: "2025-07-01", to: "2026-06-30" });
  assert.deepEqual(a.presetRange("fy", "2026-07-01"), { from: "2026-07-01", to: "2026-07-01" });
});

test("comparison ranges", () => {
  const today = "2026-11-16";
  assert.deepEqual(a.comparisonRange("7d", a.presetRange("7d", today), today), { from: "2026-11-03", to: "2026-11-09" });
  assert.deepEqual(a.comparisonRange("28d", a.presetRange("28d", today), today), { from: "2026-09-22", to: "2026-10-19" });
  assert.deepEqual(a.comparisonRange("last_quarter", a.presetRange("last_quarter", today), today), { from: "2026-04-01", to: "2026-06-30" });
  assert.deepEqual(a.comparisonRange("fy", a.presetRange("fy", today), today), { from: "2025-07-01", to: "2025-11-16" });
  assert.deepEqual(a.comparisonRange("custom", { from: "2026-03-01", to: "2026-03-10" }, today), { from: "2026-02-19", to: "2026-02-28" });
});

test("financial year labels and month lists", () => {
  assert.deepEqual(a.financialYearOf("2026-11-16"), { from: "2026-07-01", to: "2027-06-30", label: "FY 2026-27" });
  assert.deepEqual(a.financialYearOf("2026-06-30"), { from: "2025-07-01", to: "2026-06-30", label: "FY 2025-26" });
  assert.deepEqual(a.monthsInRange({ from: "2026-11-20", to: "2027-02-03" }), ["2026-11", "2026-12", "2027-01", "2027-02"]);
  assert.equal(a.monthLabel("2027-02"), "Feb 27");
});

test("revenue counts issued invoices only, by issue date; collected counts by paid date", () => {
  const range = { from: "2026-08-01", to: "2026-08-31" };
  const ix = data({
    invoices: [
      inv({ id: "sent", total_cents: 1000 }),
      inv({ id: "paid", status: "paid", total_cents: 2000, paid_at: "2026-09-02T01:00:00+00:00" }),
      inv({ id: "overdue", status: "overdue", total_cents: 400 }),
      inv({ id: "draft", status: "draft", total_cents: 9000 }),
      inv({ id: "void", status: "void", total_cents: 9000 }),
      inv({ id: "july-paid-in-aug", status: "paid", issue_date: "2026-07-20", total_cents: 500, paid_at: "2026-08-03T01:00:00+00:00" }),
      inv({ id: "sept", issue_date: "2026-09-01", total_cents: 7000 }),
    ],
  });
  const k = a.computeKpis(ix, range);
  assert.equal(k.revenueCents, 3400);
  assert.deepEqual(k.revenueInvoices.map((i) => i.id), ["sent", "paid", "overdue"]);
  assert.equal(k.collectedCents, 500);
  assert.equal(k.daysToPayment, 14);
});

test("an invoice paid at 8am Sydney on the 1st is collected in the new month", () => {
  const ix = data({ invoices: [inv({ status: "paid", issue_date: "2026-08-25", total_cents: 100, paid_at: "2026-08-31T22:00:00+00:00" })] });
  assert.equal(a.computeKpis(ix, { from: "2026-08-01", to: "2026-08-31" }).collectedCents, 0);
  assert.equal(a.computeKpis(ix, { from: "2026-09-01", to: "2026-09-30" }).collectedCents, 100);
});

test("jobs completed and average job value", () => {
  const range = { from: "2026-08-01", to: "2026-08-31" };
  const ix = data({
    jobs: [
      job({ id: "j1", completed_at: "2026-08-10T02:00:00+00:00" }),
      job({ id: "j2", completed_at: "2026-09-10T02:00:00+00:00" }),
      job({ id: "j3" }),
    ],
    invoices: [
      inv({ id: "a", job_card_id: "j1", total_cents: 1000 }),
      inv({ id: "b", job_card_id: "j1", total_cents: 500 }),
      inv({ id: "c", job_card_id: "j2", total_cents: 3000 }),
      inv({ id: "d", job_card_id: null, total_cents: 9999 }),
    ],
  });
  const k = a.computeKpis(ix, range);
  assert.deepEqual(k.jobsCompleted.map((j) => j.id), ["j1"]);
  assert.equal(k.invoicedJobCount, 2);
  assert.equal(k.averageJobValueCents, 2250);
  assert.equal(a.computeKpis(data({}), range).averageJobValueCents, null);
});

test("win rate ignores drafts and pending quotes", () => {
  const o = a.quoteOutcome([
    quote({ status: "accepted" }), quote({ status: "accepted" }), quote({ status: "declined" }), quote({ status: "expired" }),
    quote({ status: "sent" }), quote({ status: "sent" }), quote({ status: "draft" }),
  ]);
  assert.equal(o.quotes.length, 6);
  assert.equal(o.pending.length, 2);
  assert.equal(o.winRate, 50);
  assert.equal(a.quoteOutcome([quote({ status: "sent" })]).winRate, null);
});

test("first time fix: callbacks aren't scored, and an original with a callback counts against the rate", () => {
  const range = { from: "2026-08-01", to: "2026-08-31" };
  const done = "2026-08-10T02:00:00+00:00";
  const ix = data({
    jobs: [
      job({ id: "ok1", completed_at: done }),
      job({ id: "ok2", completed_at: done }),
      job({ id: "ok3", completed_at: done }),
      job({ id: "bad", completed_at: done }),
      job({ id: "cb", completed_at: done, callback_of_job_card_id: "bad" }),
      // A callback raised later, outside the range, still counts against the original.
      job({ id: "bad2", completed_at: done }),
      job({ id: "cb2", created_at: "2026-10-01T00:00:00+00:00", callback_of_job_card_id: "bad2" }),
    ],
  });
  const k = a.computeKpis(ix, range);
  assert.equal(k.firstTimeFixEligible.length, 5);
  assert.deepEqual(k.calledBackJobs.map((j) => j.id), ["bad", "bad2"]);
  assert.equal(k.firstTimeFixRate, 60);
  assert.equal(a.computeKpis(data({}), range).firstTimeFixRate, null);
});

test("return customer rate is job-based and ignores callbacks", () => {
  const range = { from: "2026-08-01", to: "2026-08-31" };
  const ix = data({
    jobs: [
      job({ id: "old", client_id: "repeat", created_at: "2025-01-01T00:00:00+00:00" }),
      job({ id: "r1", client_id: "repeat", created_at: "2026-08-05T00:00:00+00:00" }),
      job({ id: "n1", client_id: "new", created_at: "2026-08-06T00:00:00+00:00" }),
      // Second job in the same period for a brand new client is repeat business.
      job({ id: "n2", client_id: "new", created_at: "2026-08-20T00:00:00+00:00" }),
      job({ id: "solo", client_id: "solo", created_at: "2026-08-07T00:00:00+00:00" }),
      // A callback neither counts as a job here nor makes its client "returning".
      job({ id: "solo-cb", client_id: "solo2", created_at: "2026-08-01T00:00:00+00:00", callback_of_job_card_id: "x" }),
      job({ id: "solo2", client_id: "solo2", created_at: "2026-08-09T00:00:00+00:00" }),
    ],
  });
  const k = a.computeKpis(ix, range);
  assert.deepEqual(k.returnCustomerJobs.map((j) => j.id), ["r1", "n2"]);
  assert.deepEqual(k.newCustomerJobs.map((j) => j.id), ["n1", "solo", "solo2"]);
  assert.equal(k.returnCustomerRate, 40);
});

test("feedback average uses reviews recorded in the range", () => {
  const ix = data({
    clients: [
      client({ id: "a", google_review_stars: 5, google_review_recorded_at: "2026-08-02T00:00:00+00:00" }),
      client({ id: "b", google_review_stars: 4, google_review_recorded_at: "2026-08-20T00:00:00+00:00" }),
      client({ id: "c", google_review_stars: 1, google_review_recorded_at: "2026-05-20T00:00:00+00:00" }),
      client({ id: "d" }),
    ],
  });
  const k = a.computeKpis(ix, { from: "2026-08-01", to: "2026-08-31" });
  assert.equal(k.feedbackAverage, 4.5);
  assert.deepEqual(a.recentFeedback(ix, 2).map((c) => c.id), ["b", "a"]);
  const months = a.feedbackByMonth(ix, { from: "2026-05-01", to: "2026-08-31" });
  assert.deepEqual(months.map((m) => [m.month, m.clients.length, m.average]), [["2026-05", 1, 1], ["2026-06", 0, null], ["2026-07", 0, null], ["2026-08", 2, 4.5]]);
});

test("jobs by category, stage and month", () => {
  const range = { from: "2026-08-01", to: "2026-09-30" };
  const ix = data({
    categories: [{ id: "roof", name: "Roof Repairs" }, { id: "gutter", name: "Gutters" }],
    stages: [{ id: "s2", name: "Scheduled", position: 2, is_closed: false }, { id: "s1", name: "Enquiry", position: 1, is_closed: false }],
    jobs: [
      job({ id: "j1", service_category_id: "roof", lifecycle_stage_id: "s2", completed_at: "2026-09-02T00:00:00+00:00" }),
      job({ id: "j2", service_category_id: "roof", lifecycle_stage_id: "s1" }),
      job({ id: "j3", service_category_id: "gutter", lifecycle_stage_id: "s1", created_at: "2026-09-03T00:00:00+00:00" }),
      job({ id: "j4", lifecycle_stage_id: "s1" }),
      job({ id: "outside", service_category_id: "roof", created_at: "2026-01-01T00:00:00+00:00" }),
    ],
    invoices: [inv({ job_card_id: "j1", total_cents: 700 }), inv({ job_card_id: "j1", status: "draft", total_cents: 9000 })],
  });
  assert.deepEqual(a.jobsByCategory(ix, range).map((r) => [r.label, r.jobs.length, r.completed.length, r.revenueCents]), [
    ["Roof Repairs", 2, 1, 700], ["Gutters", 1, 0, 0], ["No category", 1, 0, 0],
  ]);
  assert.deepEqual(a.jobsByStage(ix, range).map((r) => [r.label, r.jobs.length]), [["Enquiry", 3], ["Scheduled", 1]]);
  assert.deepEqual(a.jobsByMonth(ix, range).map((r) => [r.month, r.created.length, r.completed.length]), [["2026-08", 3, 0], ["2026-09", 1, 1]]);
});

test("quote outcomes by month and lost reasons", () => {
  const range = { from: "2026-08-01", to: "2026-09-30" };
  const ix = data({
    quotes: [
      quote({ id: "w", status: "accepted", total_cents: 1000 }),
      quote({ id: "l1", status: "declined", total_cents: 300, lost_reason_category: "price" }),
      quote({ id: "l2", status: "expired", total_cents: 200 }),
      quote({ id: "l3", status: "declined", total_cents: 50, issue_date: "2026-09-05", lost_reason_category: "price" }),
      quote({ id: "p", status: "sent", issue_date: "2026-09-06" }),
      quote({ id: "d", status: "draft", issue_date: "2026-09-06" }),
    ],
  });
  const months = a.quoteOutcomesByMonth(ix, range);
  assert.deepEqual(months.map((m) => [m.month, m.quotes.length, m.won.length, m.lost.length, m.expired.length, m.pending.length, m.wonCents, m.lostCents]), [
    ["2026-08", 3, 1, 1, 1, 0, 1000, 500], ["2026-09", 2, 0, 1, 0, 1, 0, 50],
  ]);
  assert.equal(Math.round(months[0].winRate), 33);
  assert.deepEqual(a.lostReasons(ix, range).map((r) => [r.key, r.quotes.length, r.cents]), [["price", 2, 350], ["unrecorded", 1, 200]]);
});

test("price book usage counts linked lines on issued invoices and non-draft quotes in range", () => {
  const range = { from: "2026-08-01", to: "2026-08-31" };
  const ix = data({
    invoices: [inv({ id: "i1" }), inv({ id: "i2" }), inv({ id: "draft", status: "draft" }), inv({ id: "old", issue_date: "2026-01-01" })],
    quotes: [quote({ id: "q1" }), quote({ id: "qd", status: "draft" })],
  });
  const line = (over) => ({ parent_id: "i1", price_book_item_id: "pb1", quantity: 1, unit_price_cents: 1000, ...over });
  const rows = a.priceBookUsage(
    ix,
    [
      line({ quantity: 2 }),
      line({ parent_id: "i2", quantity: 1.5, waived_amount_cents: 500 }),
      line({ parent_id: "i2", price_book_item_id: "pb2", unit_price_cents: 100 }),
      line({ price_book_item_id: null, unit_price_cents: 99999 }),
      line({ parent_id: "draft" }),
      line({ parent_id: "old" }),
    ],
    [
      line({ parent_id: "q1", quantity: 4 }),
      line({ parent_id: "q1", is_included: false }),
      line({ parent_id: "qd" }),
      line({ parent_id: "q1", price_book_item_id: "pb3", quantity: 1 }),
    ],
    range
  );
  assert.deepEqual(rows.map((r) => [r.itemId, r.timesBilled, r.quantityBilled, r.billedCents, r.invoiceIds, r.timesQuoted, r.quantityQuoted]), [
    ["pb1", 2, 3.5, 3000, ["i1", "i2"], 1, 4],
    ["pb2", 1, 1, 100, ["i2"], 0, 0],
    ["pb3", 0, 0, 0, [], 1, 1],
  ]);
});

test("top clients, revenue by category and by suburb", () => {
  const range = { from: "2026-08-01", to: "2026-08-31" };
  const ix = data({
    clients: [client({ id: "c1", name: "Alpha", suburb: "bondi", postcode: "2026" }), client({ id: "c2", name: "Beta" })],
    sites: [{ id: "s1", suburb: "Manly", postcode: "2095" }, { id: "s2", suburb: "BONDI", postcode: "2026" }],
    categories: [{ id: "roof", name: "Roof Repairs" }],
    jobs: [job({ id: "j1", service_category_id: "roof", site_id: "s1" }), job({ id: "j2", client_id: "c2" })],
    invoices: [
      inv({ id: "a", client_id: "c1", job_card_id: "j1", total_cents: 1000 }),
      inv({ id: "b", client_id: "c1", total_cents: 300 }),
      inv({ id: "c", client_id: "c2", job_card_id: "j2", total_cents: 500 }),
      inv({ id: "d", client_id: "c2", site_id: "s2", total_cents: 50 }),
    ],
  });
  assert.deepEqual(a.topClients(ix, range).map((r) => [r.label, r.cents, r.invoices.length, r.jobIds.size]), [["Alpha", 1300, 2, 1], ["Beta", 550, 2, 1]]);
  assert.deepEqual(a.revenueByCategory(ix, range).map((r) => [r.label, r.cents]), [["Roof Repairs", 1000], ["No category", 500], ["Not linked to a job", 350]]);
  // Job site beats client address; invoice site beats both; case differences merge.
  assert.deepEqual(a.revenueBySuburb(ix, range).map((r) => [r.label, r.cents]), [["Manly 2095", 1000], ["No address recorded", 500], ["Bondi 2026", 350]]);
});

test("revenue by month across years", () => {
  const ix = data({
    invoices: [
      inv({ issue_date: "2026-03-10", total_cents: 100 }), inv({ issue_date: "2026-03-28", total_cents: 50 }),
      inv({ issue_date: "2024-03-01", total_cents: 70 }), inv({ issue_date: "2021-03-01", total_cents: 999 }),
      inv({ issue_date: "2025-12-31", total_cents: 5 }), inv({ issue_date: "2026-03-05", status: "void", total_cents: 999 }),
    ],
  });
  const grid = a.revenueByMonthAcrossYears(ix, [2022, 2023, 2024, 2025, 2026]);
  assert.deepEqual(grid[2].map((c) => c.cents), [0, 0, 70, 0, 150]);
  assert.deepEqual(grid[11].map((c) => c.cents), [0, 0, 0, 5, 0]);
  assert.equal(grid.length, 12);
});

test("aged receivables bucket boundaries", () => {
  const today = "2026-11-16";
  const ix = data({
    invoices: [
      inv({ id: "d0", issue_date: today, total_cents: 1 }),
      inv({ id: "d30", issue_date: a.addDays(today, -30), total_cents: 10 }),
      inv({ id: "d31", issue_date: a.addDays(today, -31), status: "overdue", total_cents: 100 }),
      inv({ id: "d60", issue_date: a.addDays(today, -60), total_cents: 1000 }),
      inv({ id: "d61", issue_date: a.addDays(today, -61), status: "overdue", total_cents: 10000 }),
      inv({ id: "paid", issue_date: a.addDays(today, -90), status: "paid", total_cents: 99999 }),
      inv({ id: "draft", status: "draft", total_cents: 99999 }),
    ],
  });
  assert.deepEqual(a.agedReceivables(ix, today).map((b) => [b.key, b.cents, b.invoices.map((i) => i.id)]), [
    ["0-30", 11, ["d30", "d0"]], ["31-60", 1100, ["d60", "d31"]], ["61+", 10000, ["d61"]],
  ]);
});

test("quote pipeline only holds sent quotes, bucketed by days waiting", () => {
  const today = "2026-11-16";
  const ix = data({
    quotes: [
      quote({ id: "w7", issue_date: a.addDays(today, -7), total_cents: 1 }),
      quote({ id: "w8", issue_date: a.addDays(today, -8), total_cents: 10 }),
      quote({ id: "w30", issue_date: a.addDays(today, -30), total_cents: 100 }),
      quote({ id: "w45", issue_date: a.addDays(today, -45), total_cents: 1000 }),
      quote({ id: "won", status: "accepted", total_cents: 9999 }),
      quote({ id: "draft", status: "draft", total_cents: 9999 }),
    ],
  });
  assert.deepEqual(a.quotePipeline(ix, today).map((b) => [b.key, b.cents, b.quotes.length]), [["0-7", 1, 1], ["8-14", 10, 1], ["15-30", 100, 1], ["31+", 1000, 1]]);
});

test("financial year target pace", () => {
  // 138 of 365 days into FY 2026-27 on 15 Nov 2026.
  const today = "2026-11-15";
  const ix = data({
    invoices: [
      inv({ issue_date: "2026-07-10", total_cents: 4_000_000 }),
      inv({ issue_date: "2026-11-01", total_cents: 6_000_000 }),
      inv({ issue_date: "2026-06-30", total_cents: 99_000_000 }),
      inv({ issue_date: "2026-11-20", total_cents: 99_000_000 }),
    ],
  });
  const p = a.fyTargetProgress(ix, 36_500_000, today);
  assert.equal(p.label, "FY 2026-27");
  assert.equal(p.actualCents, 10_000_000);
  assert.equal(p.expectedCents, 13_800_000);
  assert.equal(p.varianceCents, -3_800_000);
  assert.equal(p.projectedCents, Math.round(10_000_000 / (138 / 365)));
  assert.equal(p.months.length, 12);
  assert.deepEqual(p.months.slice(0, 6).map((m) => [m.month, m.cumulativeCents, m.elapsed]), [
    ["2026-07", 4_000_000, true], ["2026-08", 4_000_000, true], ["2026-09", 4_000_000, true], ["2026-10", 4_000_000, true], ["2026-11", 10_000_000, true], ["2026-12", 10_000_000, false],
  ]);
  assert.equal(p.months[11].targetCumulativeCents, 36_500_000);
  const none = a.fyTargetProgress(ix, null, today);
  assert.equal(none.expectedCents, null);
  assert.equal(none.varianceCents, null);
});

test("lead sources: leads, conversion and completed revenue", () => {
  const range = { from: "2026-08-01", to: "2026-08-31" };
  const ix = data({
    leadSources: [{ id: "mc", name: "Missed call" }, { id: "web", name: "Website" }],
    jobs: [
      job({ id: "m1", lead_source_id: "mc" }),
      job({ id: "m2", lead_source_id: "mc" }),
      job({ id: "m3", lead_source_id: "mc", completed_at: "2026-09-01T00:00:00+00:00" }),
      job({ id: "m4", lead_source_id: "mc" }),
      job({ id: "w1", lead_source_id: "web" }),
      job({ id: "none" }),
      job({ id: "old", lead_source_id: "mc", created_at: "2026-01-01T00:00:00+00:00", completed_at: "2026-08-05T00:00:00+00:00" }),
    ],
    quotes: [quote({ job_card_id: "m2", status: "accepted" }), quote({ job_card_id: "m1", status: "sent" })],
    invoices: [
      inv({ job_card_id: "m3", total_cents: 800 }), inv({ job_card_id: "m3", status: "draft", total_cents: 9000 }),
      inv({ job_card_id: "m4", total_cents: 200 }), inv({ job_card_id: "old", total_cents: 7000 }),
    ],
  });
  assert.deepEqual(
    a.leadSourcePerformance(ix, range).map((r) => [r.label, r.leads.length, r.converted.map((j) => j.id), r.conversionRate, r.completed.length, r.completedRevenueCents]),
    [["Missed call", 4, ["m2", "m3", "m4"], 75, 1, 800], ["No source recorded", 1, [], 0, 0, 0], ["Website", 1, [], 0, 0, 0]]
  );
});

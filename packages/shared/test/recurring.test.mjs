import { test } from "node:test";
import assert from "node:assert/strict";
import { addRecurringInterval, describeRepeat, recurringVisitTotals, upcomingVisits, visitCreatedOn } from "../src/recurring.ts";

test("intervals match the database (months keep the day or the month's end; weeks are 7 days)", () => {
  assert.equal(addRecurringInterval("2026-12-14", 6, "month"), "2027-06-14");
  assert.equal(addRecurringInterval("2026-08-31", 6, "month"), "2027-02-28");
  assert.equal(addRecurringInterval("2026-11-27", 1, "week"), "2026-12-04");
  assert.equal(addRecurringInterval("2026-12-28", 2, "week"), "2027-01-11");
});

test("describing the repeat in plain words", () => {
  assert.equal(describeRepeat(6, "month"), "every 6 months");
  assert.equal(describeRepeat(1, "month"), "every month");
  assert.equal(describeRepeat(12, "month"), "every year");
  assert.equal(describeRepeat(24, "month"), "every 2 years");
  assert.equal(describeRepeat(1, "week"), "every week");
  assert.equal(describeRepeat(4, "week"), "every 4 weeks");
});

test("upcoming visits and when each job is made", () => {
  assert.deepEqual(upcomingVisits("2026-12-14", 6, "month"), ["2026-12-14", "2027-06-14", "2027-12-14"]);
  assert.equal(visitCreatedOn("2026-12-14", 28), "2026-11-16");
});

test("price per visit from the saved lines (same as the draft invoice the database makes)", () => {
  assert.deepEqual(
    recurringVisitTotals([
      { quantity: 1, unit_price_cents: 25000, gst_applicable: true },
      { quantity: 3, unit_price_cents: 2000, gst_applicable: true },
    ]),
    { subtotal_cents: 31000, gst_cents: 3100, total_cents: 34100 }
  );
  assert.deepEqual(recurringVisitTotals([{ quantity: "2.5", unit_price_cents: 1000, gst_applicable: false }]), { subtotal_cents: 2500, gst_cents: 0, total_cents: 2500 });
});

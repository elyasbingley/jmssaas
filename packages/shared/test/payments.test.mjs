import { test } from "node:test";
import assert from "node:assert/strict";
import {
  quoteDepositDueCents,
  quoteDepositRemainingCents,
  quoteDepositKind,
  quoteBalanceCents,
  invoiceBalanceCents,
  invoiceOverpaidCents,
  parseDollarsToCents,
} from "../src/payments.ts";

test("deposit as a percent of the quote", () => {
  assert.equal(quoteDepositDueCents({ deposit_percent: 20, deposit_fixed_cents: null, total_cents: 110000 }), 22000);
  // rounds to the cent like the database does
  assert.equal(quoteDepositDueCents({ deposit_percent: 33.33, deposit_fixed_cents: null, total_cents: 10001 }), 3333);
  assert.equal(quoteDepositKind({ deposit_percent: 20, deposit_fixed_cents: null }), "percent");
});

test("fixed deposit is capped at the quote total", () => {
  assert.equal(quoteDepositDueCents({ deposit_percent: null, deposit_fixed_cents: 50000, total_cents: 110000 }), 50000);
  assert.equal(quoteDepositDueCents({ deposit_percent: null, deposit_fixed_cents: 50000, total_cents: 30000 }), 30000);
  assert.equal(quoteDepositKind({ deposit_percent: null, deposit_fixed_cents: 1 }), "fixed");
});

test("no deposit", () => {
  assert.equal(quoteDepositDueCents({ deposit_percent: null, deposit_fixed_cents: null, total_cents: 110000 }), 0);
  assert.equal(quoteDepositKind({ deposit_percent: null, deposit_fixed_cents: null }), "none");
});

test("remaining deposit and balances never go negative", () => {
  const quote = { deposit_percent: 20, deposit_fixed_cents: null, total_cents: 110000, deposit_paid_cents: 5000 };
  assert.equal(quoteDepositRemainingCents(quote), 17000);
  assert.equal(quoteDepositRemainingCents({ ...quote, deposit_paid_cents: 30000 }), 0);
  assert.equal(quoteBalanceCents(quote), 105000);
  assert.equal(invoiceBalanceCents({ total_cents: 110000, amount_paid_cents: 27000 }), 83000);
  assert.equal(invoiceBalanceCents({ total_cents: 50000, amount_paid_cents: 57000 }), 0);
  assert.equal(invoiceOverpaidCents({ total_cents: 50000, amount_paid_cents: 57000 }), 7000);
  assert.equal(invoiceOverpaidCents({ total_cents: 50000, amount_paid_cents: 100 }), 0);
});

test("typed dollar amounts", () => {
  assert.equal(parseDollarsToCents("$1,234.50"), 123450);
  assert.equal(parseDollarsToCents("220"), 22000);
  assert.equal(parseDollarsToCents(" 0.5 "), 50);
  assert.equal(parseDollarsToCents("19.999"), null);
  assert.equal(parseDollarsToCents("0"), null);
  assert.equal(parseDollarsToCents("-5"), null);
  assert.equal(parseDollarsToCents("abc"), null);
  assert.equal(parseDollarsToCents(""), null);
});

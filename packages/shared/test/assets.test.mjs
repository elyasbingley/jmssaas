import { test } from "node:test";
import assert from "node:assert/strict";
import { addMonths, assetAgeYears, assetDefaults, assetLabel, assetSummary, replacementDueDate, serviceNextDue, serviceState, warrantyState } from "../src/assets.ts";

test("adding months keeps the day, or the month's last day (like Postgres)", () => {
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2028-01-31", 1), "2028-02-29");
  assert.equal(addMonths("2026-11-23", 12), "2027-11-23");
  assert.equal(addMonths("2026-11-23", 120), "2036-11-23");
});

test("next service due: from last done, else install, rolled forward for older assets (matches the database)", () => {
  assert.equal(serviceNextDue("2027-02-01", 12, null, "2026-11-23"), "2028-02-01");
  assert.equal(serviceNextDue(null, 12, "2026-11-23", "2026-11-23"), "2027-11-23");
  // the database's results for the migrated 2016 hot water system and 2004 roof
  assert.equal(serviceNextDue(null, 12, "2016-03-10", "2026-11-23"), "2027-03-10");
  assert.equal(serviceNextDue(null, 60, "2016-03-10", "2026-11-23"), "2031-03-10");
  assert.equal(serviceNextDue(null, 24, "2004-07-01", "2026-11-23"), "2028-07-01");
  assert.equal(serviceNextDue(null, 12, null, "2026-11-23"), null);
  assert.equal(serviceNextDue(null, null, "2016-03-10", "2026-11-23"), null);
});

test("service and warranty states", () => {
  assert.equal(serviceState("2026-11-01", "2026-11-23", 28), "overdue");
  assert.equal(serviceState("2026-12-20", "2026-11-23", 28), "due");
  assert.equal(serviceState("2027-01-10", "2026-11-23", 28), "ok");
  assert.equal(serviceState(null, "2026-11-23", 28), "unknown");
  assert.equal(warrantyState("2026-11-22", "2026-11-23"), "expired");
  assert.equal(warrantyState("2027-01-31", "2026-11-23"), "expiring");
  assert.equal(warrantyState("2030-01-01", "2026-11-23"), "active");
});

test("age and replacement date use the install date or 1 July of the install year", () => {
  assert.equal(assetAgeYears({ installed_on: "2015-05-01", install_year: null }, "2026-11-23"), 11);
  assert.equal(assetAgeYears({ installed_on: "2016-12-01", install_year: null }, "2026-11-23"), 9);
  assert.equal(assetAgeYears({ installed_on: null, install_year: 2004 }, "2026-11-23"), 22);
  assert.equal(assetAgeYears({ installed_on: null, install_year: null }, "2026-11-23"), null);
  assert.equal(replacementDueDate({ installed_on: "2015-05-01", install_year: null }, { replace_after_years: 10 }), "2025-05-01");
  assert.equal(replacementDueDate({ installed_on: "2015-05-01", install_year: null }, { replace_after_years: null }), null);
});

test("a new asset gets its type's services and warranties, dated from install", () => {
  const type = {
    default_services: [{ name: "Relief valve check", interval_months: 12 }, { name: " ", interval_months: 6 }],
    default_warranties: [{ kind: "workmanship", label: "Workmanship", years: 10 }],
  };
  const d = assetDefaults(type, "2026-11-23", "2026-11-23");
  assert.deepEqual(d.services, [{ name: "Relief valve check", interval_months: 12, next_due_on: "2027-11-23" }]);
  assert.deepEqual(d.warranties, [{ kind: "workmanship", label: "Workmanship", starts_on: "2026-11-23", expires_on: "2036-11-23" }]);
  const fromItem = assetDefaults(type, "2026-11-23", "2026-11-23", [{ kind: "manufacturer", label: "Cylinder", years: 7 }, { kind: "manufacturer", label: "Parts", years: 0.5 }]);
  assert.deepEqual(fromItem.warranties.map((w) => `${w.label} ${w.expires_on}`), ["Cylinder 2033-11-23", "Parts 2027-05-23"]);
  assert.equal(assetDefaults(type, null, "2026-11-23").warranties[0].expires_on, null);
});

test("labels for messages and lists", () => {
  assert.equal(assetLabel({ asset_name: "Rheem 315" }, { name: "Hot water system" }), "hot water system");
  assert.equal(assetLabel({ asset_name: "Garden tap" }, { name: "Other" }), "Garden tap");
  assert.equal(assetLabel({ asset_name: "RPZD" }, { name: "RPZD valve" }), "RPZD valve");
  assert.equal(assetSummary({ attributes: { brand: "Rheem", model: "Stellar 330", serial_number: "A1" } }), "Rheem Stellar 330 · SN A1");
  assert.equal(assetSummary({ attributes: {} }), "");
});

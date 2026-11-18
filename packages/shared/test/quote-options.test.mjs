import { test } from "node:test";
import assert from "node:assert/strict";
import { sectionLines, optionLines, optionTotals, headlineOption, cheapestOption, replaceSection, orderForSave, duplicateOption } from "../src/quote-options.ts";

const line = (description, unit_price_cents, option_id = null, extra = {}) => ({ description, quantity: 1, unit_price_cents, gst_applicable: true, sort_order: 0, option_id, ...extra });
const items = [
  line("Call-out", 10000),
  line("Patch", 20000, "o1"),
  line("Restore", 300000, "o2"),
  line("Gutter guard", 50000, "o2", { is_optional: true, is_included: false }),
];

test("sections and options", () => {
  assert.deepEqual(sectionLines(items, null).map((i) => i.description), ["Call-out"]);
  assert.deepEqual(sectionLines(items, "o2").map((i) => i.description), ["Restore", "Gutter guard"]);
  assert.deepEqual(optionLines(items, "o1").map((i) => i.description), ["Call-out", "Patch"]);
});

test("an option's total includes shared lines, not unticked extras", () => {
  assert.equal(optionTotals(items, "o1").total_cents, 33000);
  assert.equal(optionTotals(items, "o2").total_cents, 341000);
  const ticked = items.map((i) => (i.description === "Gutter guard" ? { ...i, is_included: true } : i));
  assert.equal(optionTotals(ticked, "o2").total_cents, 396000);
});

test("which option the quote counts as", () => {
  const options = [
    { id: "a", is_recommended: false, sort_order: 0, total_cents: 300 },
    { id: "b", is_recommended: true, sort_order: 1, total_cents: 100 },
    { id: "c", is_recommended: false, sort_order: 2, total_cents: 200 },
  ];
  assert.equal(headlineOption(options).id, "b");
  assert.equal(headlineOption(options, "c").id, "c");
  assert.equal(headlineOption(options.map((o) => ({ ...o, is_recommended: false }))).id, "a");
  assert.equal(headlineOption([]), null);
  assert.equal(cheapestOption(options).id, "b");
});

test("editing one section keeps the others, saving orders shared first", () => {
  const edited = replaceSection(items, "o1", [line("Patch 5 tiles", 20000), line("Ridge cap", 5000)]);
  assert.deepEqual(sectionLines(edited, "o1").map((i) => i.description), ["Patch 5 tiles", "Ridge cap"]);
  assert.equal(sectionLines(edited, "o2").length, 2);
  const options = [{ id: "o2", sort_order: 0 }, { id: "o1", sort_order: 1 }];
  const saved = orderForSave(edited, options);
  assert.deepEqual(saved.map((i) => `${i.option_id ?? "-"}:${i.description}`), ["-:Call-out", "o2:Restore", "o2:Gutter guard", "o1:Patch 5 tiles", "o1:Ridge cap"]);
  assert.deepEqual(saved.map((i) => i.sort_order), [0, 1, 2, 3, 4]);
  // a line pointing at an option that no longer exists goes to shared
  assert.equal(orderForSave([line("Stray", 1, "gone")], options)[0].option_id, null);
});

test("copying an option copies its lines, not the recommended flag", () => {
  const { option, lines } = duplicateOption(items, { id: "o2", name: "Restore", description: "", is_recommended: true, sort_order: 1 }, "o3", 2);
  assert.equal(option.name, "Restore (copy)");
  assert.equal(option.is_recommended, false);
  assert.deepEqual(lines.map((l) => `${l.option_id}:${l.description}`), ["o3:Restore", "o3:Gutter guard"]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClientExport, csvCell, formatAuPhone, toCsv } from "../src/client-export.ts";

const base = {
  name: "Sam Smith",
  first_name: "Sam",
  last_name: "Smith",
  client_type: "individual",
  company_name: null,
  email: "Sam@Example.com ",
  phone: "0412345678",
  address_line1: "4 Wallaby Cl",
  address_line2: null,
  suburb: "Blacktown",
  state: "NSW",
  postcode: "2148",
  marketing_opt_out: false,
  google_review_stars: 5,
  created_at: "2026-03-04T01:00:00Z",
  tags: ["Roof", "VIP"],
  lead_source: "Google",
  job_count: 3,
  last_job_at: "2026-10-01T03:00:00Z",
  paid_cents: 123450,
};

test("Australian phone numbers are spaced the usual way", () => {
  assert.equal(formatAuPhone("0412345678"), "0412 345 678");
  assert.equal(formatAuPhone("+61 412 345 678"), "0412 345 678");
  assert.equal(formatAuPhone("61412345678"), "0412 345 678");
  assert.equal(formatAuPhone("(02) 9876-5432"), "02 9876 5432");
  assert.equal(formatAuPhone("1300123456"), "1300 123 456");
  assert.equal(formatAuPhone("131313"), "13 13 13");
  assert.equal(formatAuPhone("+44 20 7946 0958"), "+44 20 7946 0958");
  assert.equal(formatAuPhone(null), "");
});

test("spreadsheet export has every client and the useful extras", () => {
  const exp = buildClientExport([{ ...base, id: "a" }, { ...base, id: "b", email: null, marketing_opt_out: true }], "spreadsheet", "2026-11-23");
  assert.equal(exp.filename, "clients-2026-11-23.csv");
  assert.equal(exp.rows.length, 2);
  const row = Object.fromEntries(exp.header.map((h, i) => [h, exp.rows[0][i]]));
  assert.deepEqual(
    { phone: row.Phone, email: row.Email, tags: row.Tags, jobs: row.Jobs, last: row["Last job"], paid: row["Total paid"], review: row["Google review"], marketing: row.Marketing, since: row["Client since"] },
    { phone: "0412 345 678", email: "Sam@Example.com", tags: "Roof, VIP", jobs: "3", last: "2026-10-01", paid: "1234.50", review: "5 stars", marketing: "OK", since: "2026-03-04" }
  );
  assert.equal(exp.rows[1][exp.header.indexOf("Marketing")], "Opted out");
});

test("Mailchimp export: its own column names, emails only, no opt-outs, no duplicates", () => {
  const exp = buildClientExport(
    [
      { ...base, id: "a" },
      { ...base, id: "b", email: "sam@example.com" },
      { ...base, id: "c", email: "not an email" },
      { ...base, id: "d", email: "x@y.com", marketing_opt_out: true },
      { ...base, id: "e", email: "co@biz.com.au", client_type: "company", company_name: "Harbour Realty", first_name: "Mia", last_name: "Chen" },
    ],
    "mailchimp",
    "2026-11-23"
  );
  assert.deepEqual(exp.header.slice(0, 4), ["Email Address", "First Name", "Last Name", "Phone Number"]);
  assert.deepEqual(exp.rows.map((r) => r[0]), ["sam@example.com", "co@biz.com.au"]);
  assert.deepEqual(exp.skipped, { noEmail: 1, optedOut: 1, duplicateEmail: 1 });
  assert.equal(exp.rows[0][exp.header.indexOf("Tags")], "Roof,VIP");
  assert.equal(exp.rows[1][exp.header.indexOf("Company")], "Harbour Realty");
});

test("cells are safe to open in Excel", () => {
  assert.equal(csvCell('=HYPERLINK("http://bad","x")', "spreadsheet"), `"'=HYPERLINK(""http://bad"",""x"")"`);
  assert.equal(csvCell("@SUM(1)", "mailchimp"), `"'@SUM(1)"`);
  assert.equal(csvCell("-12.50", "spreadsheet"), `"-12.50"`);
  assert.equal(csvCell("0800", "spreadsheet"), `="0800"`);
  assert.equal(csvCell("0800", "mailchimp"), `"0800"`);
  assert.equal(csvCell("O'Brien, Jo", "spreadsheet"), `"O'Brien, Jo"`);
});

test("the spreadsheet file starts with a byte-order mark for Excel; Mailchimp's doesn't", () => {
  const people = [{ ...base, id: "a", first_name: "Zoë", name: "Zoë Smith" }];
  const sheet = toCsv(buildClientExport(people, "spreadsheet", "2026-11-23"), "spreadsheet");
  const mc = toCsv(buildClientExport(people, "mailchimp", "2026-11-23"), "mailchimp");
  assert.equal(sheet.charCodeAt(0), 0xfeff);
  assert.ok(sheet.includes('"Zoë"'));
  assert.ok(mc.startsWith('"Email Address"'));
  assert.equal(sheet.split("\r\n").length, 3);
});

// Run with `pnpm --filter @jmssaas/shared test`.
import test from "node:test";
import assert from "node:assert/strict";
import { matchingClientIds, defaultClientForSender } from "../src/client-match.ts";

// A tiny stand-in for the Supabase query builder: supports the calls the
// matcher makes (select, ilike, not-null, order, range) over in-memory rows.
function fakeDb(tables) {
  return {
    from(table) {
      let rows = [...(tables[table] ?? [])];
      const q = {
        select: () => q,
        ilike: (col, value) => {
          rows = rows.filter((r) => (r[col] ?? "").toLowerCase() === value.toLowerCase());
          return q;
        },
        not: (col) => {
          rows = rows.filter((r) => r[col] != null);
          return q;
        },
        order: () => q,
        range: (from, to) => Promise.resolve({ data: rows.slice(from, to + 1), error: null }),
        then: (resolve, reject) => Promise.resolve({ data: rows, error: null }).then(resolve, reject),
      };
      return q;
    },
  };
}

const db = fakeDb({
  clients: [
    { id: "c1", email: "Jo@Example.com", phone: "0491 570 156" },
    { id: "c2", email: null, phone: null },
    { id: "c3", email: "other@example.com", phone: "+61 400 000 000" },
  ],
  client_contacts: [
    { id: "k1", client_id: "c2", email: "jo@example.com", phone: null },
    { id: "k2", client_id: "c3", email: null, phone: "61491570156" },
  ],
});

test("matches email case-insensitively against clients and contacts", async () => {
  assert.deepEqual(await matchingClientIds(db, "jo@example.COM", null), ["c1", "c2"]);
});

test("matches phone after E.164 normalisation", async () => {
  assert.deepEqual(await matchingClientIds(db, null, "+61491570156"), ["c1", "c3"]);
});

test("unknown sender or blank input matches nothing", async () => {
  assert.deepEqual(await matchingClientIds(db, "nobody@example.com", "+61499999999"), []);
  assert.deepEqual(await matchingClientIds(db, "  ", ""), []);
  assert.deepEqual(await matchingClientIds(db, null, "not a phone"), []);
});

test("query errors are thrown, not treated as no match", async () => {
  const broken = { from: () => ({ select: () => ({ ilike: () => Promise.resolve({ data: null, error: new Error("rls") }) }) }) };
  await assert.rejects(matchingClientIds(broken, "jo@example.com", null), /rls/);
});

test("default client prefers the linked client, then the first match", () => {
  assert.equal(defaultClientForSender("c9", ["c1"]), "c9");
  assert.equal(defaultClientForSender(null, ["c1", "c2"]), "c1");
  assert.equal(defaultClientForSender(null, []), null);
});

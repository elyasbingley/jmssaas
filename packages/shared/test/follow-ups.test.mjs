import { test } from "node:test";
import assert from "node:assert/strict";
import { renderFollowUp, smsCount, smsPlainText } from "../src/follow-ups.ts";

test("render fills fields and keeps texts in plain SMS characters", () => {
  assert.equal(
    renderFollowUp("Hi {first_name}, spots in {suburb} – it’s {missing} fine", { first_name: "Bec", suburb: "Quakers Hill" }),
    "Hi Bec, spots in Quakers Hill - it's {missing} fine"
  );
  assert.equal(smsPlainText("“quoted”…  ok "), '"quoted"... ok');
});

test("text counts: one text up to 160, then 153 a part; Unicode at 70/67", () => {
  assert.deepEqual(smsCount("a".repeat(160)), { characters: 160, texts: 1, unicode: false, unicodeChars: [] });
  assert.equal(smsCount("a".repeat(161)).texts, 2);
  assert.equal(smsCount("a".repeat(306)).texts, 2);
  assert.equal(smsCount("a".repeat(307)).texts, 3);
  const emoji = smsCount("Hi \u{1F44B}");
  assert.equal(emoji.unicode, true);
  assert.deepEqual(emoji.unicodeChars, ["\u{1F44B}"]);
  assert.equal(smsCount("x".repeat(71) + "’").texts, 2);
  assert.equal(smsCount("[]").characters, 4);
});

test("the plan's storm sign-up text is 2 texts and plain SMS", () => {
  const body = "Hi Bec, Elyas here, The Leak Detective. Here's your storm season roof check: https://bingleytrades.com.au/storm-check/thanks The short video is on the same page. If water's already coming in, reply with a photo and I'll tell you what I'd do. Reply STOP to opt out";
  const c = smsCount(body);
  assert.equal(c.unicode, false);
  assert.equal(c.texts, 2);
});

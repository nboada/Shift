import { expect, test } from "bun:test";
import { matchScore, rank } from "./palette-match";

test("substring beats letters-in-order, word starts beat mid-word", () => {
  expect(matchScore("Archive", "arc")).toBeGreaterThan(matchScore("Mark read / unread", "arc"));
  expect(matchScore("Go to Inbox", "inbox")).toBeGreaterThan(matchScore("Go to Spam", "inbox"));
  expect(matchScore("Go to Inbox", "gti")).toBeGreaterThan(0);
  expect(matchScore("Archive", "xyz")).toBe(-1);
});

test("empty query keeps the original order", () => {
  const items = [{ label: "B" }, { label: "A" }];
  expect(rank(items, "").map((x) => x.label)).toEqual(["B", "A"]);
  expect(rank([{ label: "Reply" }, { label: "Reply all" }, { label: "Forward" }], "rep").map((x) => x.label)).toEqual(["Reply", "Reply all"]);
});

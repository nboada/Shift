import { expect, test } from "bun:test";
import { remember } from "./recent";

test("a search goes to the top of the recent list once, however it was typed", () => {
  let list = remember([], "invoice");
  list = remember(list, "from:ana@example.com");
  list = remember(list, "  Invoice ");
  expect(list).toEqual(["Invoice", "from:ana@example.com"]);
  expect(remember(list, "   ")).toBe(list);
  expect(remember(remember([], "lunch   friday"), "lunch friday")).toEqual(["lunch friday"]);
});

test("the recent list keeps the newest eight", () => {
  const list = Array.from({ length: 12 }, (_, i) => `q${i}`).reduce(remember, [] as string[]);
  expect(list).toEqual(["q11", "q10", "q9", "q8", "q7", "q6", "q5", "q4"]);
});

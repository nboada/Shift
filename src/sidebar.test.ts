import { expect, test } from "bun:test";
import { arrange } from "./sidebar";

test("arrange hides, orders, and keeps unordered items in place at the end", () => {
  const id = (x: string) => x;
  expect(arrange(["a", "b", "c", "d", "e"], id, ["d", "b"], ["c"])).toEqual(["d", "b", "a", "e"]);
  expect(arrange(["a", "b"], id, [], [])).toEqual(["a", "b"]);
});

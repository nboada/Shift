import { expect, test } from "bun:test";
import { isValidAddress, parseAddress, splitList } from "./recipients";

test("splits address lists without breaking quoted names", () => {
  expect(splitList(`"Doe, Jane" <jane@x.com>, bob@y.com; Al <al@z.com>\nzed@q.io`)).toEqual([
    `"Doe, Jane" <jane@x.com>`, "bob@y.com", "Al <al@z.com>", "zed@q.io",
  ]);
  expect(splitList(" , ")).toEqual([]);
});

test("parses names and validates addresses", () => {
  expect(parseAddress("Maya Chen <maya@x.com>")).toEqual(["Maya Chen", "maya@x.com"]);
  expect(parseAddress("bob@y.com")).toEqual(["", "bob@y.com"]);
  expect(isValidAddress("Maya <maya@x.com>")).toBe(true);
  expect(isValidAddress("maya@x")).toBe(false);
  expect(isValidAddress("not an email")).toBe(false);
});

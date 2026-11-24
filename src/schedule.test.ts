import { expect, test } from "bun:test";
import { quickTimes } from "./schedule";

const s = { laterTodayHours: 3, morning: "09:00", weekendDay: "saturday", nextWeekDay: "monday" };
const at = (list: ReturnType<typeof quickTimes>, id: string) => list.find((t) => t.id === id)?.at.toString();

test("quick times from a Wednesday afternoon", () => {
  const list = quickTimes(new Date(2026, 10, 25, 14, 30), s);
  expect(at(list, "later")).toBe(new Date(2026, 10, 25, 17, 30).toString());
  expect(at(list, "tomorrow")).toBe(new Date(2026, 10, 26, 9, 0).toString());
  expect(at(list, "weekend")).toBe(new Date(2026, 10, 28, 9, 0).toString());
  expect(at(list, "nextWeek")).toBe(new Date(2026, 10, 30, 9, 0).toString());
});

test("next week from a Monday is the following Monday, and duplicates collapse", () => {
  expect(at(quickTimes(new Date(2026, 10, 30, 8, 0), s), "nextWeek")).toBe(new Date(2026, 11, 7, 9, 0).toString());
  // Friday: tomorrow morning and this weekend are both Saturday 9:00.
  const friday = quickTimes(new Date(2026, 10, 27, 10, 0), s);
  expect(friday.map((t) => t.id)).toEqual(["later", "tomorrow", "nextWeek"]);
});

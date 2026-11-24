import type { Settings } from "./settings";

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export const formatWhen = (d: Date) =>
  d.toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** The quick send-later times from Settings → Scheduling, soonest first, without duplicates. */
export function quickTimes(now: Date, s: Settings["scheduling"]) {
  const [h, m] = s.morning.split(":").map(Number);
  /** The next given weekday strictly after today, at the morning time. */
  const next = (day: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + (((day - d.getDay() + 6) % 7) + 1));
    d.setHours(h, m, 0, 0);
    return d;
  };
  const times = [
    { id: "later", label: "Later today", at: new Date(now.getTime() + s.laterTodayHours * 3_600_000) },
    { id: "tomorrow", label: "Tomorrow morning", at: next((now.getDay() + 1) % 7) },
    { id: "weekend", label: "This weekend", at: next(DAYS.indexOf(s.weekendDay)) },
    { id: "nextWeek", label: "Next week", at: next(DAYS.indexOf(s.nextWeekDay)) },
  ];
  return times.filter((t, i) => times.findIndex((u) => u.at.getTime() === t.at.getTime()) === i);
}

import { expect, test } from "bun:test";
import { type Invite, inviteCard, inviteLength, inviteTile, inviteWhen, isCalendarFile } from "./invite";

const at = (iso: string) => Date.parse(iso);
const invite = (over: Partial<Invite> = {}): Invite => ({
  method: "REQUEST",
  uid: "ev1",
  summary: "Design review",
  location: "Room 4",
  start: at("2026-11-30T23:00:00Z"),
  end: at("2026-12-01T00:00:00Z"),
  all_day: false,
  organizer: { name: "Ella Rivera", email: "ella@example.com", status: "ACCEPTED" },
  attendees: [],
  status: "NEEDS-ACTION",
  ...over,
});
// 9 am on Monday 30 November in Sydney.
const sydney = { locale: "en-AU", timeZone: "Australia/Sydney", now: at("2026-11-29T22:00:00Z") };

test("an event tomorrow says so, with its times", () => {
  expect(inviteWhen(invite(), sydney)).toBe("Tomorrow · 10:00 am – 11:00 am");
});

test("a later event shows its date, and the year only when it isn't this one", () => {
  const later = { ...sydney, now: at("2026-11-20T00:00:00Z") };
  expect(inviteWhen(invite(), later)).toBe("Tue, 1 Dec · 10:00 am – 11:00 am");
  const lastYear = { ...sydney, now: at("2025-11-20T00:00:00Z") };
  expect(inviteWhen(invite(), lastYear)).toBe("Tue, 1 Dec 2026 · 10:00 am – 11:00 am");
});

test("an event over midnight shows both days", () => {
  expect(inviteWhen(invite({ end: at("2026-12-01T14:00:00Z") }), sydney)).toBe(
    "Tomorrow, 10:00 am – Wed, 2 Dec, 1:00 am",
  );
});

test("all-day events show their dates wherever the reader is, ending on the last day", () => {
  const i = invite({ all_day: true, start: at("2026-12-24T00:00:00Z"), end: at("2026-12-26T00:00:00Z") });
  expect(inviteWhen(i, { ...sydney, timeZone: "America/Los_Angeles" })).toBe("Thu, 24 Dec – Fri, 25 Dec · All day");
  expect(inviteWhen({ ...i, end: at("2026-12-25T00:00:00Z") }, sydney)).toBe("Thu, 24 Dec · All day");
});

test("lengths read like a calendar", () => {
  expect(inviteLength(invite())).toBe("1 hr");
  expect(inviteLength(invite({ end: at("2026-12-01T00:30:00Z") }))).toBe("1 hr 30 min");
  expect(inviteLength(invite({ end: at("2026-11-30T23:45:00Z") }))).toBe("45 min");
  expect(inviteLength(invite({ all_day: true }))).toBe("");
});

test("the date tile shows the local month and day", () => {
  expect(inviteTile(invite(), sydney)).toEqual({ month: "Dec", day: "1" });
});

test("the user's answer is the pressed button", () => {
  const html = inviteCard(invite({ status: "TENTATIVE" }), 2, sydney);
  expect(html).toContain('data-rsvp="TENTATIVE" data-msg="2" aria-pressed="true"');
  expect(html).toContain('data-rsvp="ACCEPTED" data-msg="2" aria-pressed="false"');
});

test("cancelled events and answers have no buttons", () => {
  expect(inviteCard(invite({ method: "CANCEL" }), 0)).not.toContain("data-rsvp");
  const reply = inviteCard(
    invite({ method: "REPLY", attendees: [{ name: "Sam", email: "sam@x.com", status: "DECLINED" }] }),
    0,
  );
  expect(reply).toContain("Sam declined");
  expect(reply).not.toContain("data-rsvp");
});

test("event text is escaped", () => {
  const html = inviteCard(invite({ summary: "<img src=x onerror=alert(1)>", location: "<b>" }), 0);
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<b>");
});

test("no event, no card", () => {
  expect(inviteCard(null, 0)).toBe("");
});

test("the invite's .ics file is recognised", () => {
  expect(isCalendarFile({ mime: "application/ics", filename: "invite.ics" })).toBe(true);
  expect(isCalendarFile({ mime: "application/octet-stream", filename: "Meeting.ICS" })).toBe(true);
  expect(isCalendarFile({ mime: "application/pdf", filename: "a.pdf" })).toBe(false);
});

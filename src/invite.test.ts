import { expect, test } from "bun:test";
import { type Invite, inviteCard, inviteWhen } from "./invite";

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
const sydney = { locale: "en-AU", timeZone: "Australia/Sydney" };

test("a timed event shows its day once when it starts and ends the same day", () => {
  expect(inviteWhen(invite(), sydney)).toBe("Tue, 1 Dec 2026, 10:00 am – 11:00 am");
});

test("an event over midnight shows both days", () => {
  expect(inviteWhen(invite({ end: at("2026-12-01T14:00:00Z") }), sydney)).toBe(
    "Tue, 1 Dec 2026, 10:00 am – Wed, 2 Dec 2026, 1:00 am",
  );
});

test("all-day events show their dates wherever the reader is, ending on the last day", () => {
  const i = invite({ all_day: true, start: at("2026-12-24T00:00:00Z"), end: at("2026-12-26T00:00:00Z") });
  expect(inviteWhen(i, { locale: "en-AU", timeZone: "America/Los_Angeles" })).toBe(
    "Thu, 24 Dec 2026 – Fri, 25 Dec 2026",
  );
  expect(inviteWhen({ ...i, end: at("2026-12-25T00:00:00Z") }, sydney)).toBe("Thu, 24 Dec 2026");
});

test("the user's answer is the pressed button", () => {
  const html = inviteCard(invite({ status: "TENTATIVE" }), 2);
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
  const html = inviteCard(invite({ summary: "<img src=x onerror=alert(1)>", location: "From <b>" }), 0);
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<b>");
});

test("no event, no card", () => {
  expect(inviteCard(null, 0)).toBe("");
});

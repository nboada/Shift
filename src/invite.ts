// The event card at the top of an invite email, with Yes, Maybe and No (sent by `rsvp` in Rust).

export type Person = { name: string; email: string; status: string };
export type Invite = {
  method: string;
  uid: string;
  summary: string;
  location: string;
  /** Milliseconds; an all-day event starts at midnight UTC of its first day. */
  start: number | null;
  /** Exclusive: an all-day event ends the day after its last. */
  end: number | null;
  all_day: boolean;
  organizer: Person;
  attendees: Person[];
  /** The user's own answer: NEEDS-ACTION, ACCEPTED, TENTATIVE or DECLINED. */
  status: string;
};

export const ANSWERS = [
  ["ACCEPTED", "Yes"],
  ["TENTATIVE", "Maybe"],
  ["DECLINED", "No"],
] as const;

const PAST: Record<string, string> = { ACCEPTED: "accepted", TENTATIVE: "said maybe", DECLINED: "declined" };

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const DAY = 86_400_000;

/** "Tue, 1 Dec 2026, 10:00 – 11:00", or the dates alone for an all-day event. */
export function inviteWhen(i: Invite, opts: { locale?: string; timeZone?: string } = {}): string {
  if (i.start == null) return "";
  // All-day dates are calendar days, not instants: read them in UTC so no time zone moves them.
  const timeZone = i.all_day ? "UTC" : opts.timeZone;
  const day = new Intl.DateTimeFormat(opts.locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone,
  });
  if (i.all_day) {
    const last = i.end != null && i.end - DAY > i.start ? i.end - DAY : i.start;
    return last === i.start ? day.format(i.start) : `${day.format(i.start)} – ${day.format(last)}`;
  }
  const time = new Intl.DateTimeFormat(opts.locale, { hour: "numeric", minute: "2-digit", timeZone });
  const start = `${day.format(i.start)}, ${time.format(i.start)}`;
  if (i.end == null || i.end <= i.start) return start;
  return day.format(i.start) === day.format(i.end)
    ? `${start} – ${time.format(i.end)}`
    : `${start} – ${day.format(i.end)}, ${time.format(i.end)}`;
}

/** The card for message `msg` of the open conversation. Empty when the email holds no event. */
export function inviteCard(i: Invite | null | undefined, msg: number): string {
  if (!i) return "";
  const who = (p: Person) => esc(p.name || p.email);
  let side = "";
  if (i.method === "CANCEL") side = `<span class="invite-note">Cancelled</span>`;
  else if (i.method === "REPLY") {
    const a = i.attendees.find((p) => PAST[p.status]);
    if (a) side = `<span class="invite-note">${who(a)} ${PAST[a.status]}</span>`;
  } else if (i.organizer.email) {
    side = `<div class="invite-answers" role="group" aria-label="Going?">${ANSWERS.map(
      ([status, label]) =>
        `<button type="button" data-rsvp="${status}" data-msg="${msg}" aria-pressed="${i.status === status}">${label}</button>`,
    ).join("")}</div>`;
  }
  const lines = [
    esc(inviteWhen(i)),
    esc(i.location),
    i.organizer.email && i.method !== "REPLY" ? `From ${who(i.organizer)}` : "",
  ]
    .filter(Boolean)
    .map((l) => `<span>${l}</span>`);
  return `<div class="invite${i.method === "CANCEL" ? " cancelled" : ""}">
    <i class="ti ti-calendar-event" aria-hidden="true"></i>
    <div class="invite-info"><strong>${esc(i.summary || "(no title)")}</strong>${lines.join("")}</div>${side}
  </div>`;
}

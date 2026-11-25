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

type Opts = { locale?: string; timeZone?: string; now?: number };

/** The calendar day of `ms` in `timeZone`, as "2026-11-26", for telling today and tomorrow apart. */
const dayKey = (ms: number, timeZone?: string) =>
  new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(ms);

/** "Tomorrow · 17:00 – 18:00", "Thu, 24 Dec – Fri, 25 Dec · All day"; the year only when it isn't this one. */
export function inviteWhen(i: Invite, opts: Opts = {}): string {
  if (i.start == null) return "";
  // All-day dates are calendar days, not instants: read them in UTC so no time zone moves them.
  const timeZone = i.all_day ? "UTC" : opts.timeZone;
  const now = opts.now ?? Date.now();
  const thisYear = dayKey(i.start, timeZone).slice(0, 4) === dayKey(now, opts.timeZone).slice(0, 4);
  const date = new Intl.DateTimeFormat(opts.locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: thisYear ? undefined : "numeric",
    timeZone,
  });
  // Today and tomorrow are counted in the reader's zone; an all-day date's key is already its calendar day.
  const day = (ms: number) => {
    const key = dayKey(ms, timeZone);
    if (key === dayKey(now, opts.timeZone)) return "Today";
    if (key === dayKey(now + DAY, opts.timeZone)) return "Tomorrow";
    return date.format(ms);
  };
  if (i.all_day) {
    const last = i.end != null && i.end - DAY > i.start ? i.end - DAY : i.start;
    return `${last === i.start ? day(i.start) : `${day(i.start)} – ${day(last)}`} · All day`;
  }
  const time = new Intl.DateTimeFormat(opts.locale, { hour: "numeric", minute: "2-digit", timeZone });
  if (i.end == null || i.end <= i.start) return `${day(i.start)} · ${time.format(i.start)}`;
  return dayKey(i.start, timeZone) === dayKey(i.end, timeZone)
    ? `${day(i.start)} · ${time.format(i.start)} – ${time.format(i.end)}`
    : `${day(i.start)}, ${time.format(i.start)} – ${day(i.end)}, ${time.format(i.end)}`;
}

/** "45 min", "1 hr", "1 hr 30 min"; empty for all-day events and anything a day or longer. */
export function inviteLength(i: Invite): string {
  if (i.all_day || i.start == null || i.end == null) return "";
  const minutes = Math.round((i.end - i.start) / 60_000);
  if (minutes <= 0 || minutes >= 24 * 60) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h} hr` : "", m ? `${m} min` : ""].filter(Boolean).join(" ");
}

/** The month and day for the card's date tile, like a page of a desk calendar. */
export function inviteTile(i: Invite, opts: Opts = {}): { month: string; day: string } | null {
  if (i.start == null) return null;
  const timeZone = i.all_day ? "UTC" : opts.timeZone;
  return {
    month: new Intl.DateTimeFormat(opts.locale, { month: "short", timeZone }).format(i.start).replace(".", ""),
    day: new Intl.DateTimeFormat(opts.locale, { day: "numeric", timeZone }).format(i.start),
  };
}

/** The invite's own .ics file, which the card already shows, so the reader doesn't list it again. */
export const isCalendarFile = (a: { mime: string; filename: string }) =>
  /^(text\/calendar|application\/ics)$/i.test(a.mime) || /\.ics$/i.test(a.filename);

const ICONS: Record<string, string> = { ACCEPTED: "check", TENTATIVE: "help", DECLINED: "x" };

/** The card for message `msg` of the open conversation. Empty when the email holds no event. */
export function inviteCard(i: Invite | null | undefined, msg: number, opts: Opts = {}): string {
  if (!i) return "";
  const who = (p: Person) => esc(p.name || p.email);
  let side = "";
  if (i.method === "CANCEL") side = `<span class="invite-note">Cancelled</span>`;
  else if (i.method === "REPLY") {
    const a = i.attendees.find((p) => PAST[p.status]);
    if (a) side = `<span class="invite-note" data-status="${a.status}">${who(a)} ${PAST[a.status]}</span>`;
  } else if (i.organizer.email) {
    side = `<div class="invite-rsvp"><span class="invite-ask" aria-hidden="true">Going?</span>
      <div class="invite-answers" role="group" aria-label="Going?">${ANSWERS.map(
        ([status, label]) =>
          `<button type="button" data-rsvp="${status}" data-msg="${msg}" aria-pressed="${i.status === status}"><i class="ti ti-${ICONS[status]}" aria-hidden="true"></i>${label}</button>`,
      ).join("")}</div></div>`;
  }
  const tile = inviteTile(i, opts);
  const length = inviteLength(i);
  const meta = [
    i.location ? `<span><i class="ti ti-map-pin" aria-hidden="true"></i>${esc(i.location)}</span>` : "",
    i.organizer.email && i.method !== "REPLY"
      ? `<span><i class="ti ti-user" aria-hidden="true"></i>${who(i.organizer)}</span>`
      : "",
  ].join("");
  return `<div class="invite${i.method === "CANCEL" ? " cancelled" : ""}">
    ${tile ? `<div class="invite-tile" aria-hidden="true"><span>${esc(tile.month)}</span><strong>${esc(tile.day)}</strong></div>` : ""}
    <div class="invite-info">
      <strong class="invite-title">${esc(i.summary || "(no title)")}</strong>
      <span class="invite-when">${esc(inviteWhen(i, opts))}${length ? `<span class="invite-length">${length}</span>` : ""}</span>
      ${meta ? `<span class="invite-meta">${meta}</span>` : ""}
    </div>${side}
  </div>`;
}

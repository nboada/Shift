import { iconHtml } from "./icons";
import { initOnboarding, onboardingDue, startOnboarding } from "./onboarding";
import { initCleanup, openCleanup } from "./cleanup";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SEND, bindingsFrom, comboOf, formatCombo, keysFor } from "./keys";
import {
  ACCOUNT_COLOR_ORDER,
  accountSettings,
  applyVisualSettings,
  flushSettings,
  loadSettings,
  onSaveError,
  onSettingsChange,
  setAccountSetting,
  setSetting,
  settings,
  signatureFor,
  stepZoom,
} from "./settings";
import { closeSettings, initSettings, openSettings, settingsOpen } from "./settings-ui";
import { arrange } from "./sidebar";
import { blockText, docToText, emailHtml, textToHtml } from "./compose";
import { createEditor, foldReplyQuote } from "./editor";
import { generateHTML, generateJSON } from "@tiptap/core";
import { ask, askChoice, askOpen, askText, askTextAndColor } from "./dialog";
import { addImapAccount } from "./imap-signin";
import { FOLD_CSS } from "./quote";
import DOMPurify from "dompurify";
import { Recipients, isValidAddress, splitList } from "./recipients";
import { rank } from "./palette-match";
import { formatWhen, quickTimes } from "./schedule";
import { type Invite, inviteCard, isCalendarFile } from "./invite";
import { actionToastOpen, toast } from "./toast";
import { Menu } from "@tauri-apps/api/menu";
import AirDatepicker from "air-datepicker";
import localeEnModule from "air-datepicker/locale/en";
import {
  type Attachment,
  type OutFile,
  attachmentButton,
  checkSize,
  fileIcon,
  listedAttachments,
  readFile,
} from "./attachments";

type Label = { id: string; name: string; kind: string; unread: number; color: string | null };
type Thread = {
  id: string;
  subject: string;
  sender: string;
  snippet: string;
  date: number;
  count: number;
  unread: boolean;
  starred: boolean;
  primary: boolean;
  labels: string;
  /** Address of the account the thread belongs to. */
  account: string;
};
type Message = {
  id: string;
  sender: string;
  recipients: string;
  cc: string;
  date: number;
  subject: string;
  message_id: string;
  refs: string;
  html: string | null;
  text: string | null;
  attachments: Attachment[];
  /** Where replies go when the sender set Reply-To (mailing lists, help desks); empty otherwise. */
  reply_to: string;
  /** The calendar event when the email is an invite, or an answer to one. */
  invite: Invite | null;
};

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const app = $("#app");
const threadList = $("#threads");
const reader = $("#reader");
const searchInputs = [...document.querySelectorAll<HTMLInputElement>(".search input")];
// Desktop shows the top-right field, phones the one above the list; use whichever is on screen.
const visibleSearch = () => searchInputs.find((i) => i.offsetParent !== null) ?? searchInputs[0];
let userLabels: Label[] = [];
/** Each account's own user labels, for the per-thread Label and Move menus (ids differ between accounts). */
let accountLabels = new Map<string, Label[]>();
const composer = $<HTMLDialogElement>("#composer");
const composeForm = $<HTMLFormElement>("#compose-form");

const SYSTEM: [string | null, string, string][] = [
  ["INBOX", "Inbox", "inbox"],
  ["STARRED", "Starred", "star"],
  ["IMPORTANT", "Important", "bookmark"],
  ["SENT", "Sent", "send"],
  ["DRAFT", "Drafts", "file"],
  ["SCHEDULED", "Scheduled", "clock"],
  ["ARCHIVE", "Archive", "archive"],
  [null, "All Mail", "mail"],
  ["SPAM", "Spam", "alert-octagon"],
  ["TRASH", "Trash", "trash"],
];

/** Accounts signed in with a password over IMAP rather than with Google. */
let imapAccounts = new Set<string>();
type Status = { accounts: string[]; imap: string[]; broken: string[] };
async function loadStatus(): Promise<Status> {
  const s = await invoke<Status>("status");
  imapAccounts = new Set(s.imap);
  return s;
}
/** Signed-in accounts, oldest first. */
let accounts: string[] = [];
/** Which accounts the sidebar and list show; null is "All accounts". */
let scope: string[] | null = null;
const multi = () => accounts.length > 1;
/** The account new emails come from: the one being viewed, else the first. */
/** Where a new email is sent from: the account on screen when viewing one, else the default from Settings → Composer. */
const defaultAccount = () => {
  if (scope?.length === 1) return scope[0];
  const pick = settings.composer.defaultFrom;
  return pick && accounts.includes(pick) && (!scope || scope.includes(pick)) ? pick : (scope?.[0] ?? accounts[0]);
};
const accountName = (a: string) => accountSettings(a).title || a;
let mailbox: string | null = "INBOX";
let search: string | null = null;
let threads: Thread[] = [];
let selected: string | null = null;
let messages: Message[] = [];

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const displayName = (addr: string) => {
  const m = addr.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  return (m ? m[1] || m[2] : addr).trim();
};
const bareEmail = (addr: string) => (addr.match(/<([^>]+)>/)?.[1] ?? addr).trim().toLowerCase();

function shortDate(ms: number) {
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: "short", day: "numeric" });
  return d.toLocaleDateString();
}

const hash = (text: string) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0);

/** List heading for a date: Today, Yesterday, This week (last 7 days), then the month. */
function dateGroup(ms: number) {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  const d = new Date(ms);
  if (d >= day) return "Today";
  if (d.getTime() >= day.getTime() - 86_400_000) return "Yesterday";
  if (d.getTime() >= day.getTime() - 6 * 86_400_000) return "This week";
  return d.toLocaleDateString([], {
    month: "long",
    ...(d.getFullYear() === day.getFullYear() ? {} : { year: "numeric" }),
  });
}

const setView = (v: "mailboxes" | "list" | "reader") => (app.dataset.view = v);

// WebKit's own menu (Reload, Inspect Element, Open Link) only where Shift has none: text fields and selected text keep
// it for Copy, Paste and Look Up. Reload would restart the app and Open Link would load the page inside it. In dev
// builds, ⌥-right-click still reaches Inspect Element.
document.addEventListener("contextmenu", (e) => {
  if (e.defaultPrevented || (import.meta.env.DEV && e.altKey)) return;
  const el = e.target as Element;
  if (el.closest("input, textarea, [contenteditable]") || !window.getSelection()?.isCollapsed) return;
  e.preventDefault();
});

// Dev builds surface uncaught errors on screen, since the webview console isn't visible.
if (import.meta.env.DEV) {
  window.addEventListener("error", (e) => toast(`Error: ${e.message}`, { kind: "error" }));
  window.addEventListener("unhandledrejection", (e) => toast(`Error: ${e.reason}`, { kind: "error" }));
}

/** The first key bound to an action, formatted for display ("⇧R"), if it has one. */
const keyLabel = (action: string) => {
  const k = keysFor(settings.shortcuts)[action]?.[0];
  return k ? formatCombo(k) : undefined;
};

// Pairs from Gmail's label palette (it rejects other colours); text colour is what Gmail draws the name in.
const LABEL_COLORS: [name: string, background: string, text: string][] = [
  ["Red", "#fb4c2f", "#ffffff"],
  ["Orange", "#ffad47", "#ffffff"],
  ["Yellow", "#fad165", "#000000"],
  ["Green", "#16a766", "#ffffff"],
  ["Mint", "#43d692", "#ffffff"],
  ["Teal", "#2da2bb", "#ffffff"],
  ["Blue", "#4a86e8", "#ffffff"],
  ["Purple", "#a479e2", "#ffffff"],
  ["Pink", "#f691b3", "#ffffff"],
  ["Grey", "#999999", "#ffffff"],
];
const isHex = (c: string | null): c is string => !!c && /^#[0-9a-f]{6}$/i.test(c);
// Gmail colours go through a generated stylesheet (no inline styles); only #rrggbb values get into it.
function labelColorCss(colors: string[]) {
  const hexes = new Set([...colors, ...LABEL_COLORS.map((c) => c[1])].filter(isHex).map((c) => c.toLowerCase()));
  // Dots take the colour as is; list chips a faded tint of it with the name in the colour, mixed toward the text colour
  // so pale ones (yellow, mint) stay readable.
  $("#label-colors").textContent = [...hexes]
    .map(
      (h) => `.label-dot[data-color="${h.slice(1)}"] { background: ${h}; }
.row-label[data-color="${h.slice(1)}"] { background: color-mix(in srgb, ${h} 16%, transparent); color: color-mix(in srgb, ${h} 70%, var(--text)); }`,
    )
    .join("\n");
}
/** A label's Gmail colour, or a plain grey dot when it has none, as in Gmail (a made-up colour looked like a real one). */
const labelDot = (_name: string, color: string | null) =>
  isHex(color)
    ? `<span class="label-dot" data-color="${color.slice(1).toLowerCase()}"></span>`
    : `<span class="label-dot none"></span>`;

/** Unread Inbox mail across every account in the unified view, on the Dock icon, whichever account is on screen. */
async function updateDockBadge() {
  const count = settings.inbox.unreadBadge
    ? ((await invoke<Label[]>("labels", { accounts: null })).find((l) => l.id === "INBOX")?.unread ?? 0)
    : 0;
  await getCurrentWindow().setBadgeCount(count || undefined);
}

async function renderMailboxes() {
  const labels = await invoke<Label[]>("labels", { accounts: scope });
  userLabels = labels.filter((l) => l.kind === "user");
  accountLabels = new Map(
    await Promise.all(
      accounts.map(
        async (a) =>
          [a, (await invoke<Label[]>("labels", { accounts: [a] })).filter((l) => l.kind === "user")] as const,
      ),
    ),
  );
  const unread = new Map(labels.map((l) => [l.id, l.unread]));
  labelColorCss(labels.map((l) => l.color ?? ""));
  const link = (group: string, id: string | null, name: string, icon: string, count = 0, color: string | null = null) =>
    `<a href="#" draggable="false" data-group="${group}" data-mailbox="${esc(id ?? "")}" class="${!search && id === mailbox ? "active" : ""}" ${!search && id === mailbox ? 'aria-current="page"' : ""}>
      ${icon ? iconHtml(icon) : labelDot(name, color)}<span>${esc(name)}</span>${count ? `<small>${count}</small>` : ""}</a>`;
  const badge = settings.inbox.unreadBadge;
  void updateDockBadge();
  const { order, hidden } = settings.sidebar;
  const system = arrange(SYSTEM, ([id]) => id ?? "ALL", order, hidden).map(([id, name, icon]) =>
    link("system", id, name, icon, badge && id === "INBOX" ? unread.get(id) : 0),
  );
  const user = arrange(userLabels, (l) => l.id, order, hidden).map((l) =>
    link("label", l.id, l.name, "", badge ? l.unread : 0, l.color),
  );
  $("#mailboxes").innerHTML =
    system.join("") +
    `<h3><span>Labels</span><button type="button" class="label-add" data-tip="New label" aria-label="New label">${iconHtml("plus")}</button></h3>${user.join("")}`;
}

function listTitle() {
  if (search) return `Search: ${search}`;
  return (
    SYSTEM.find(([id]) => id === mailbox)?.[1] ??
    document.querySelector(`[data-mailbox="${CSS.escape(mailbox ?? "")}"] span:not(.label-dot)`)?.textContent ??
    ""
  );
}

const PERSONAL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "yahoo.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "fastmail.com",
  "bigpond.com",
]);

// shortcut: approximates the registrable domain (handles com.au/co.uk style suffixes); swap in a public-suffix list if logos misfire.
function siteDomain(domain: string) {
  const parts = domain.split(".");
  const n =
    parts.length > 2 && parts.at(-1)!.length === 2 && /^(com|co|org|net|gov|edu|ac)$/.test(parts.at(-2)!) ? 3 : 2;
  return parts.slice(-n).join(".");
}

/** Company logo for work domains, coloured initials otherwise (and whenever the logo is missing). */
function avatar(addr: string) {
  const email = bareEmail(addr);
  const name = displayName(addr) || email;
  const initials =
    name
      .split(/[\s.@_-]+/)
      .filter((w) => /\w/.test(w))
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase() || "?";
  const color = hash(email) % 8;
  const domain = email.split("@")[1] ?? "";
  const site = domain && !PERSONAL_DOMAINS.has(domain) ? siteDomain(domain) : "";
  const known = site ? logos.get(site) : false;
  // Initials show until a logo has loaded once; after that the domain's logo is drawn straight away.
  const logo =
    known === false
      ? ""
      : `<img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(site)}&sz=64" alt="" data-site="${esc(site)}"${known ? "" : ' class="pending"'}>`;
  return `<span class="avatar c${color}${known ? " logo" : ""}">${esc(initials)}${logo}</span>`;
}

/** Which sites have a logo, remembered across launches so the list never waits on the favicon service to decide. */
const logos = new Map<string, boolean>(
  Object.entries(
    (() => {
      try {
        return JSON.parse(localStorage.getItem("avatar-logos") ?? "{}") as Record<string, boolean>;
      } catch {
        return {};
      }
    })(),
  ),
);
let logosSave = 0;
function rememberLogo(site: string, has: boolean) {
  if (logos.get(site) === has) return;
  logos.set(site, has);
  clearTimeout(logosSave);
  logosSave = window.setTimeout(() => {
    try {
      localStorage.setItem("avatar-logos", JSON.stringify(Object.fromEntries(logos)));
    } catch {
      // Storage full or blocked: the logos just get looked up again next launch.
    }
  }, 1000);
}

// Google answers unknown domains with a 16px globe, so anything that small falls back to initials.
document.addEventListener(
  "load",
  (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.dataset.site) return;
    const has = img.naturalWidth >= 32;
    rememberLogo(img.dataset.site, has);
    if (!has) return img.remove();
    img.classList.remove("pending");
    img.parentElement?.classList.add("logo");
  },
  true,
);
document.addEventListener(
  "error",
  (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.dataset.site) return;
    rememberLogo(img.dataset.site, false);
    img.remove();
  },
  true,
);

type Section = "pinned" | "new" | "people" | "notifications" | "seen";
const SECTIONS: [Section, string, string][] = [
  ["pinned", "Pinned", "push-pin"],
  ["new", "New", "envelope-simple"],
  ["people", "People", "user"],
  ["notifications", "Notifications", "bell"],
  ["seen", "Seen", "eye"],
];

// Threads opened while this mailbox is showing keep their section, so reading one doesn't make the list jump.
const keptUnread = new Set<string>();

function sectionOf(t: Thread): Section {
  if (t.starred && settings.inbox.pinnedOnTop) return "pinned";
  if (!t.unread && !keptUnread.has(t.id)) return "seen";
  if (!settings.inbox.splitUnread) return "new";
  return t.primary ? "people" : "notifications";
}

const pinnedFirst = () => settings.inbox.pinnedOnTop && mailbox === "INBOX" && !search;
const PINNED_HEAD = `${iconHtml("push-pin")}Pinned`;

// "smart" groups the Inbox into Pinned/People/Notifications/Seen; "list" is plain newest-first.
const smartInbox = () => settings.inbox.view === "smart" && mailbox === "INBOX" && !search;

function renderViewButton() {
  const btn = $("#view-btn");
  const smart = settings.inbox.view === "smart";
  btn.dataset.tip = smart ? "Switch to plain list" : "Switch to Smart Inbox";
  btn.setAttribute("aria-label", btn.dataset.tip);
  btn.querySelector("i")!.className = smart ? "ti ti-stack-2" : "ti ti-list";
}

/** The thread's own (user) labels as coloured chips. */
function labelChips(t: Thread) {
  const ids = t.labels.split(" ");
  return (accountLabels.get(t.account) ?? [])
    .filter((l) => ids.includes(l.id))
    .map(
      (l) =>
        `<span class="row-label"${isHex(l.color) ? ` data-color="${l.color.slice(1).toLowerCase()}"` : ""}>${esc(l.name)}</span>`,
    );
}

/** The thread's labels at the right end of the preview line, like Spark: two at most, then "+N". */
function rowLabels(t: Thread) {
  const chips = labelChips(t);
  if (!chips.length) return "";
  return `<span class="row-labels">${chips.slice(0, 2).join("")}${chips.length > 2 ? `<span class="row-label more">+${chips.length - 2}</span>` : ""}</span>`;
}

/** Hover buttons on a row: reply, archive (Inbox mail only) and delete, each with its shortcut in the tooltip. */
function rowActions(t: Thread) {
  const button = (action: string, label: string, icon: string) =>
    `<button type="button" class="icon" data-row-action="${action}" data-tip="${esc(keyLabel(action) ? `${label} (${keyLabel(action)})` : label)}" aria-label="${label}">${iconHtml(icon)}</button>`;
  return `<span class="row-actions">${button("reply", "Reply", "arrow-bend-up-left")}${
    t.labels.split(" ").includes("INBOX") ? button("archive", "Archive", "archive") : ""
  }${button("trash", "Delete", "trash")}</span>`;
}

function threadRow(t: Thread) {
  const on = multiPicked() ? picked.has(t.id) : t.id === selected;
  return `<li data-id="${t.id}" role="option" aria-selected="${on}" aria-label="${esc(`${t.unread ? "Unread, " : ""}${displayName(t.sender)}, ${t.subject || "(no subject)"}`)}" class="${t.unread ? "unread" : ""} ${on ? "selected" : ""}">
        <span class="dot"></span>
        <span class="avatar-ring${multi() ? ` acct-${accountSettings(t.account).color}` : ""}" ${multi() ? `data-tip="${esc(accountName(t.account))}"` : ""}>${avatar(t.sender)}</span>
        <span class="from">${esc(displayName(t.sender) || "(no sender)")}${t.count > 1 ? `<em>${t.count}</em>` : ""}${t.starred ? '<i class="ti ti-pinned pin"></i>' : ""}</span>
        <span class="date">${shortDate(t.date)}</span>
        <span class="subject"><span class="subject-text">${esc(t.subject || "(no subject)")}</span></span>
        <span class="snippet">${esc(decodeEntities(t.snippet))}</span>${rowLabels(t)}
        ${mailbox === "SCHEDULED" ? "" : rowActions(t)}
      </li>`;
}

const PAGE = 80;
let drawn = PAGE;
let drawnFor = "";

/** The reader's Pin and Unread buttons follow the open email: a solid pin when it's pinned, labels that say what a click does. */
function syncToolbar() {
  const t = threads.find((x) => x.id === selected);
  const set = (action: string, label: string, on?: boolean) => {
    const b = document.querySelector<HTMLElement>(`.toolbar [data-action="${action}"]`);
    if (!b) return;
    const key = keyLabel(action);
    b.dataset.label = label;
    b.dataset.tip = key ? `${label} (${key})` : label;
    b.setAttribute("aria-label", label);
    if (on !== undefined) b.setAttribute("aria-pressed", String(on));
  };
  set("star", t?.starred ? "Unpin" : "Pin", !!t?.starred);
  set("unread", t && !t.unread ? "Mark unread" : "Mark read");
  // The open email's labels under its subject, kept current as labels are added or removed.
  const h1 = reader.querySelector("h1");
  if (!t || !h1) return;
  const chips = labelChips(t).join("");
  let row = reader.querySelector<HTMLElement>(".reader-labels");
  if (!chips) return row?.remove();
  if (!row) {
    row = Object.assign(document.createElement("div"), { className: "reader-labels" });
    h1.after(row);
  }
  row.innerHTML = chips;
}

function renderThreads() {
  syncToolbar();
  $("#list-title").textContent = listTitle();
  const emptyBtn = $("#empty-btn");
  emptyBtn.hidden = !!search || (mailbox !== "TRASH" && mailbox !== "SPAM");
  emptyBtn.querySelector("span")!.textContent = mailbox === "SPAM" ? "Empty Spam" : "Empty Trash";
  emptyBtn.toggleAttribute("disabled", !threads.length);
  // Smart Inbox / plain list only applies to the Inbox.
  $("#view-btn").hidden = !!search || mailbox !== "INBOX";
  $("#cleanup-btn").hidden = !!search || mailbox !== "INBOX";
  if (!threads.length) {
    threadList.innerHTML = `<li class="empty">${search ? "No results" : "No messages"}</li>`;
    return;
  }
  // Only the rows near the top are drawn, more as the list scrolls: a mailbox of a thousand threads redrawn on every
  // open, archive or sync took a few hundred ms each time.
  const key = `${mailbox}|${search}|${scope?.join(",") ?? ""}`;
  if (key !== drawnFor) [drawn, drawnFor] = [PAGE, key];
  const visible = threads.slice(0, Math.max(drawn, threads.findIndex((t) => t.id === selected) + PAGE / 2));
  if (!smartInbox()) {
    let last = "";
    threadList.innerHTML = visible
      .map((t) => {
        const group =
          search || mailbox === "SCHEDULED" ? "" : pinnedFirst() && t.starred ? PINNED_HEAD : dateGroup(t.date);
        const head = group !== last ? `<li class="section">${group}</li>` : "";
        last = group;
        return head + threadRow(t);
      })
      .join("");
    return;
  }
  threadList.innerHTML = SECTIONS.map(([key, title, icon]) => {
    const rows = visible.filter((t) => sectionOf(t) === key);
    return rows.length ? `<li class="section">${iconHtml(icon)}${title}</li>${rows.map(threadRow).join("")}` : "";
  }).join("");
}

/** Smart Inbox order (pinned, unread people, unread notifications, seen) so j/k follows what's on screen. */
function sortForInbox(list: Thread[]) {
  const rank = (t: Thread) => SECTIONS.findIndex(([key]) => key === sectionOf(t));
  if (smartInbox()) return [...list].sort((a, b) => rank(a) - rank(b) || b.date - a.date);
  // The plain Inbox list also keeps pinned mail on top; sort is stable, so each part stays newest first.
  return pinnedFirst() ? [...list].sort((a, b) => Number(b.starred) - Number(a.starred)) : list;
}

// Gmail snippets arrive HTML-escaped.
function decodeEntities(s: string) {
  const t = document.createElement("textarea");
  t.innerHTML = s;
  return t.value;
}

type Scheduled = {
  id: number;
  account: string;
  draft_id: string | null;
  send_at: number;
  sending: boolean;
  error: string | null;
  draft: { to: string };
  ui: { fields: Fields; opts: ComposeOptions };
};
/** Rows of the Scheduled view by list id; they are emails waiting in this Mac, not Gmail threads. */
const scheduledRows = new Map<string, Scheduled>();

/** Bumped on every list load, so a slow result (a search, another mailbox) can't land after the user moved on. */
let loadSeq = 0;

async function loadThreads() {
  const seq = ++loadSeq;
  if (mailbox === "SCHEDULED" && !search) {
    const rows = await invoke<Scheduled[]>("scheduled", { accounts: scope });
    if (seq !== loadSeq) return;
    scheduledRows.clear();
    threads = rows.map((r) => {
      // Row ids are numbered per account, so two accounts can both have row 1: the list id carries the account.
      const id = `${r.account}:${r.id}`;
      scheduledRows.set(id, r);
      return {
        id,
        account: r.account,
        subject: r.ui.fields.subject ?? "",
        sender: `To: ${r.draft.to}`,
        snippet: r.sending
          ? "Sending…"
          : r.error
            ? `Couldn't send yet, trying again: ${r.error}`
            : `Sends ${formatWhen(new Date(r.send_at))}`,
        date: r.send_at,
        count: 1,
        unread: false,
        starred: false,
        primary: true,
        labels: "",
      };
    });
    return renderThreads();
  }
  if (search) return searchAccounts(search, seq);
  const list = await invoke<Thread[]>("threads", { label: mailbox, accounts: scope });
  if (seq !== loadSeq) return;
  threads = sortForInbox(list);
  renderThreads();
  // A list too short to scroll (Trash, a quiet label) asks for older mail straight away.
  if (threadList.scrollHeight <= threadList.clientHeight) loadMore();
}

const searchingTitle = (q: string) => `Searching ${inMail() === "in Gmail" ? "Gmail" : "your mail"} for “${q}”…`;

/**
 * Gmail search, one request per account at once: each account's results join the list as they arrive, rather than
 * waiting for the slowest account (and every old conversation it has to download first). Rejects with the first
 * error once all have answered, so the results that did arrive stay.
 */
async function searchAccounts(query: string, seq: number) {
  const inView = scope ?? accounts.filter((a) => accountSettings(a).unified !== false);
  let pending = inView.length;
  const errors: unknown[] = [];
  await Promise.all(
    inView.map(async (account) => {
      try {
        const found = await invoke<Thread[]>("search", { query, accounts: [account] });
        if (seq !== loadSeq) return;
        const ids = new Set(found.map((t) => t.id));
        const merged = [...threads.filter((t) => t.account !== account || !ids.has(t.id)), ...found];
        threads = sortForInbox(merged.sort((a, b) => b.date - a.date));
      } catch (e) {
        errors.push(e);
      } finally {
        pending--;
        if (seq === loadSeq) {
          renderThreads();
          if (pending) $("#list-title").textContent = searchingTitle(query);
        }
      }
    }),
  );
  if (errors.length) throw errors[0];
}

/**
 * Older mail beyond what the first sync listed: fetched from Gmail when the list is scrolled near its end, a page at a
 * time per account. Stops asking once Gmail says there's nothing older for this mailbox and view.
 */
let loadingMore = false;
let loadMoreAfter = 0; // after a failure (offline), wait a minute rather than retry on every scroll
const noMore = new Set<string>();
function loadMore() {
  const key = `${mailbox}|${scope?.join(",") ?? "all"}`;
  if (loadingMore || search || mailbox === "SCHEDULED" || noMore.has(key) || Date.now() < loadMoreAfter) return;
  loadingMore = true;
  invoke<[number, boolean]>("load_more", { accounts: scope, label: mailbox })
    .then(([added, more]) => {
      if (!more) noMore.add(key);
      if (added) refresh();
    })
    .catch(() => (loadMoreAfter = Date.now() + 60_000))
    .finally(() => (loadingMore = false));
}

let refreshQueued = false;
function refresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  // A short timer, not requestAnimationFrame: rAF is paused while the window is hidden, which left the list empty
  // when Shift started or reloaded in the background. The 60 ms gathers bursts (a bulk archive sends one
  // mail-changed per thread) into one repaint.
  setTimeout(async () => {
    refreshQueued = false;
    // Something changed in the cache, so messages loaded ahead may be out of date.
    nearby.clear();
    await renderMailboxes();
    if (!search) await loadThreads();
    // A new message in the open conversation (a reply, or one just sent) shows without reopening it. Not while an
    // inline reply is being written, and not in Drafts or Scheduled, where opening a row opens the composer.
    const open = threads.find((t) => t.id === selected);
    if (open && open.count !== messages.length && !compose?.inline && mailbox !== "DRAFT" && mailbox !== "SCHEDULED")
      void openThread(open.id);
    if (selected) prefetchAround(selected);
  }, 60);
}

const EMAIL_CSS = `<style>
  body { margin: 0; padding: 16px; font: 14px/1.5 -apple-system, system-ui, sans-serif; color: #1d1d1f; overflow-wrap: anywhere; }
  img { max-width: 100%; height: auto; }
  blockquote { margin-left: 0; padding-left: 12px; border-left: 3px solid #ddd; color: #555; }
  ${FOLD_CSS}
</style>`;
// !important so it beats the inline font-family most HTML emails set; code keeps its monospace.
const UNIFORM_FONT_CSS = `<style>body :not(pre, code, kbd, samp, pre *, code *) { font-family: -apple-system, system-ui, sans-serif !important; }</style>`;

/** Something in the email that would load from the network: shown as the "Load images" bar. */
const REMOTE = `[src^="http" i], [src^="//"], [srcset], [poster], [background], image[href], [style*="url(" i]`;

/**
 * Sanitises an email for the reader with DOMPurify: no scripts, event handlers, javascript: links, forms, embedded
 * frames, meta refresh or <base>. The frame's CSP and sandbox stay as a second layer, not the only one.
 * Returns the HTML and whether it has remote content (images, backgrounds) to hold back.
 */
function cleanEmail(html: string): { html: string; remote: boolean } {
  const clean = DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    ADD_TAGS: ["style"],
    FORBID_TAGS: [
      "form",
      "input",
      "button",
      "textarea",
      "select",
      "meta",
      "base",
      "link",
      "iframe",
      "frame",
      "object",
      "embed",
    ],
  });
  const doc = new DOMParser().parseFromString(clean, "text/html");
  const remote =
    !!doc.querySelector(REMOTE) || [...doc.querySelectorAll("style")].some((s) => /url\(/i.test(s.textContent ?? ""));
  return { html: doc.documentElement.outerHTML, remote };
}

/** Shows an email. Returns true when it has remote images that are being held back. */
function mountEmail(frame: HTMLIFrameElement, html: string, images = settings.appearance.loadRemoteImages): boolean {
  const clean = cleanEmail(html);
  const hidden = !images && clean.remote;
  // No allow-same-origin: the email gets an opaque origin of its own, so nothing in it can reach the app. Scripts are
  // allowed only for public/email-frame.js, which reports size, links and keys by postMessage (see the listener
  // below); the CSP comes before any email markup and names that one file. The frame also inherits the app's CSP from
  // index.html; this one only tightens it. With remote images off, network loads are blocked whatever the markup.
  const script = new URL("/email-frame.js", location.href).href;
  const csp = `default-src 'none'; script-src ${script}; style-src 'unsafe-inline'; form-action 'none'; ${
    images
      ? "img-src data: blob: https: http:; media-src https: http:; font-src data: https: http:"
      : "img-src data: blob:; font-src data:"
  }`;
  frame.setAttribute("sandbox", "allow-scripts");
  // Hidden until it reports its height, so the default 150px frame and the sender's raw fonts never show.
  frame.classList.add("loading");
  frame.srcdoc =
    `<meta http-equiv="Content-Security-Policy" content="${csp}"><script defer src="${script}"${
      settings.appearance.uniformEmailFont ? ' data-even="1"' : ""
    }></script>` +
    EMAIL_CSS +
    clean.html +
    (settings.appearance.uniformEmailFont ? UNIFORM_FONT_CSS : "");
  // Shown even if the frame's script never reports (it failed on odd markup, or didn't load).
  frame.onload = () => setTimeout(() => frame.classList.remove("loading"), 300);
  return hidden;
}

// Messages from email frames (public/email-frame.js). Only a frame of ours is listened to, matched by its window.
window.addEventListener("message", (e) => {
  if (!e.data?.shift) return;
  const frame = [...document.querySelectorAll<HTMLIFrameElement>(".message iframe")].find(
    (f) => f.contentWindow === e.source,
  );
  if (!frame) return;
  const d = e.data as { type: string; height?: number; url?: string } & Partial<KeyboardEventInit>;
  if (d.type === "height" && typeof d.height === "number") {
    frame.style.height = `${d.height}px`;
    frame.classList.remove("loading");
  } else if (d.type === "hover" && typeof d.url === "string") {
    const status = $("#link-status");
    status.textContent = d.url.replace(/^mailto:/i, "");
    status.hidden = !d.url;
  } else if (d.type === "link" && typeof d.url === "string" && /^(https?|mailto):/i.test(d.url)) {
    openUrl(d.url);
  } else if (d.type === "key" && typeof d.key === "string") {
    const { key, code, metaKey, ctrlKey, altKey, shiftKey } = d;
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key, code, metaKey, ctrlKey, altKey, shiftKey, bubbles: true, cancelable: true }),
    );
  }
});

/** One line of the email's text for its collapsed header. */
function preview(m: Message) {
  const text = m.text ?? new DOMParser().parseFromString(m.html ?? "", "text/html").body.textContent ?? "";
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

const ACCORDION = { duration: 320, easing: "cubic-bezier(0.32, 0.72, 0, 1)" };

/** Opens or closes one email, animating its height. Closing keeps the content visible (and clipped) until the
 *  animation ends, so it slides shut instead of vanishing; a click mid-animation reverses from where it is. */
/** Collapsed messages whose email hasn't been rendered yet; opening one renders it first (`toggleMessage`). */
const lazyMounts = new WeakMap<HTMLElement, () => Promise<void>>();

function toggleMessage(header: HTMLElement) {
  const el = header.parentElement!;
  const pending = lazyMounts.get(el);
  if (pending) {
    lazyMounts.delete(el);
    void pending().then(() => toggleMessage(header));
    return;
  }
  const opening = el.classList.contains("collapsed") || el.classList.contains("closing");
  header.setAttribute("aria-expanded", String(opening));
  const from = el.getBoundingClientRect().height;
  el.getAnimations().forEach((a) => a.cancel());
  el.classList.remove("closing");
  el.classList.add("collapsed");
  const closed = el.getBoundingClientRect().height;
  if (opening) {
    el.classList.remove("collapsed");
  }
  const to = opening ? el.getBoundingClientRect().height : closed;
  if (settings.accessibility.reduceMotion || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (!opening) {
    el.classList.remove("collapsed");
    el.classList.add("closing");
  }
  const run = el.animate([{ height: `${from}px` }, { height: `${to}px` }], ACCORDION);
  if (opening) {
    for (const child of el.querySelectorAll(":scope > :not(header)"))
      child.animate([{ opacity: 0 }, { opacity: 1 }], { ...ACCORDION, duration: 240 });
  }
  run.finished.then(
    () => {
      if (!el.classList.contains("closing")) return;
      el.classList.remove("closing");
      el.classList.add("collapsed");
    },
    () => {},
  );
}
reader.addEventListener("click", (e) => {
  const header = (e.target as Element).closest<HTMLElement>(".message > header[role=button]");
  if (header && !(e.target as Element).closest("a, button")) toggleMessage(header);
});
reader.addEventListener("keydown", (e) => {
  const header = (e.target as Element).closest<HTMLElement>(".message > header[role=button]");
  if (!header || (e.key !== "Enter" && e.key !== " ")) return;
  e.preventDefault();
  e.stopPropagation();
  toggleMessage(header);
});

/** Opens a conversation at its newest email, with the one before it (collapsed) at the top for context. Older emails
 *  are collapsed to fixed-height headers, so positions are known right away: set before the first paint, no jump. */
function scrollToLatest() {
  const all = [...reader.querySelectorAll<HTMLElement>(":scope > .message:not(.compose-inline)")];
  const anchor = all.at(-2);
  if (!anchor) return;
  const target = anchor.getBoundingClientRect().top - reader.getBoundingClientRect().top + reader.scrollTop - 12;
  reader.scrollTop = target;
  // The newest email is still short until its frame loads, which can clamp the scroll; apply it again as it grows,
  // unless the user has scrolled since.
  let set = reader.scrollTop;
  const grow = new ResizeObserver(() => {
    if (reader.scrollTop !== set || !anchor.isConnected) return grow.disconnect();
    reader.scrollTop = target;
    set = reader.scrollTop;
    if (set >= target - 1) grow.disconnect();
  });
  grow.observe(all.at(-1)!);
}

/** Messages of the open email and its neighbours, loaded ahead so moving on (j/k, archive, delete, move) doesn't wait. */
const nearby = new Map<string, Promise<Message[]>>();
function loadMessages(account: string, id: string) {
  const key = `${account} ${id}`;
  let p = nearby.get(key);
  if (!p) {
    p = invoke<Message[]>("thread", { account, id });
    nearby.set(key, p);
    p.catch(() => nearby.delete(key));
  }
  return p;
}
function prefetchAround(id: string) {
  const i = threads.findIndex((t) => t.id === id);
  if (i < 0 || mailbox === "SCHEDULED") return;
  for (const t of [threads[i + 1], threads[i - 1]]) if (t) loadMessages(t.account, t.id).catch(() => {});
}

async function openThread(id: string) {
  $("#link-status").hidden = true;
  if (mailbox === "SCHEDULED") return editScheduled(id);
  if (mailbox === "DRAFT" && (await openDraft(id))) return;
  picked.clear();
  pickAnchor = id;
  delete app.dataset.picked;
  if (compose?.inline) closeComposer();
  selected = id;
  app.dataset.open = "";
  renderThreads();
  setView("reader");
  const thread = threads.find((t) => t.id === id);
  // Into a local first: if the user opened another email meanwhile, this late answer must not replace `messages`,
  // which Reply and Forward read.
  let loaded: Message[];
  try {
    loaded = await loadMessages(thread?.account ?? defaultAccount(), id);
  } catch (e) {
    if (selected === id) reader.innerHTML = `<div class="placeholder">${esc(String(e))}</div>`;
    return;
  }
  if (selected !== id) return;
  messages = loaded;
  reader.innerHTML = `<div class="reader-head"><h1>${esc(messages[0]?.subject || thread?.subject || "(no subject)")}</h1></div>`;
  syncToolbar();
  for (const m of messages) {
    const el = document.createElement("section");
    el.className = "message";
    const name = displayName(m.sender);
    // Accordion: older emails in a conversation start collapsed to one line; the header toggles each one.
    if (messages.length > 1 && m !== messages.at(-1)) el.classList.add("collapsed");
    const toggles = messages.length > 1;
    el.innerHTML = `<header ${toggles ? `role="button" tabindex="0" aria-expanded="${!el.classList.contains("collapsed")}"` : ""}>
        ${avatar(m.sender)}
        <div class="meta"><strong>${esc(name)}</strong><span class="to">To: ${esc(m.recipients)}${m.cc ? `, Cc: ${esc(m.cc)}` : ""}</span><span class="preview">${esc(preview(m))}</span></div>
        <time>${new Date(m.date).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</time>${toggles ? '<i class="ti ti-chevron-down toggle-caret" aria-hidden="true"></i>' : ""}
      </header>${inviteCard(m.invite, messages.indexOf(m))}`;
    const account = thread?.account ?? defaultAccount();
    if (m.html) {
      const frame = document.createElement("iframe");
      frame.title = `Email from ${name}`;
      el.append(frame);
      reader.append(el);
      const html = m.html;
      const mount = () => {
        if (mountEmail(frame, html)) {
          frame.insertAdjacentHTML(
            "beforebegin",
            `<div class="images-bar"><i class="ti ti-photo-off"></i><span>Remote images are hidden to protect your privacy.</span><button type="button">Load images</button></div>`,
          );
          frame.previousElementSibling!.querySelector("button")!.addEventListener("click", (e) => {
            (e.currentTarget as Element).closest(".images-bar")!.remove();
            mountEmail(frame, html, true);
            showInlineImages(frame, m, account);
          });
        }
        showInlineImages(frame, m, account);
        // Resolves once the frame has loaded (and sized itself), or after a moment if it never says so.
        return new Promise<void>((done) => {
          frame.addEventListener("load", () => done(), { once: true });
          setTimeout(done, 600);
        });
      };
      // A long conversation used to build a document for every message up front; collapsed ones wait until opened.
      if (el.classList.contains("collapsed")) lazyMounts.set(el, mount);
      else void mount();
    } else {
      const text = document.createElement("div");
      text.className = "text";
      text.textContent = m.text ?? "";
      el.append(text);
      reader.append(el);
    }
    el.insertAdjacentHTML(
      "beforeend",
      attachmentStrip(m, account) +
        `<footer class="message-actions">
        <button class="icon" data-reply="reply" data-msg="${messages.indexOf(m)}" data-tip="Reply" aria-label="Reply"><i class="ti ti-arrow-back-up"></i></button>
        <button class="icon" data-reply="all" data-msg="${messages.indexOf(m)}" data-tip="Reply all" aria-label="Reply all"><i class="ti ti-arrow-back-up-double"></i></button>
        <button class="icon" data-reply="forward" data-msg="${messages.indexOf(m)}" data-tip="Forward" aria-label="Forward"><i class="ti ti-arrow-forward-up"></i></button>
      </footer>`,
    );
  }
  reader.scrollTop = 0;
  scrollToLatest();
  prefetchAround(id);
  if (thread?.unread && settings.general.markReadOnOpen) {
    keptUnread.add(id);
    modify(thread, [], ["UNREAD"]);
  }
}

// ---- Attachments in the reader

function attachmentStrip(m: Message, account: string) {
  const files = listedAttachments(m.attachments, m.html).filter((a) => !(m.invite && isCalendarFile(a)));
  if (!files.length) return "";
  return `<div class="attachments message-files">${files
    .map((a) =>
      attachmentButton(fileIcon(a.mime, a.filename), a.filename || "attachment", a.size, {
        account,
        message: m.id,
        idx: a.idx,
      }),
    )
    .join("")}</div>`;
}

/** Swaps `cid:` image sources for the attachment's bytes once the email has loaded (email-frame.js does the swap). */
function showInlineImages(frame: HTMLIFrameElement, m: Message, account: string) {
  const refs = new Set(
    [...(m.html ?? "").matchAll(/cid:([^"'\s)>]+)/gi)].map(([, ref]) => {
      try {
        return decodeURIComponent(ref).toLowerCase();
      } catch {
        return ref.toLowerCase();
      }
    }),
  );
  const inline = m.attachments.filter((a) => a.content_id && refs.has(a.content_id.toLowerCase()));
  if (!inline.length) return;
  frame.addEventListener(
    "load",
    () => {
      for (const a of inline) {
        invoke<string>("attachment_data", { account, message: m.id, idx: a.idx })
          .then((data) =>
            frame.contentWindow?.postMessage(
              { type: "cid", cid: a.content_id, src: `data:${a.mime};base64,${data}` },
              "*",
            ),
          )
          .catch(() => {});
      }
    },
    { once: true },
  );
}

reader.addEventListener("click", (e) => {
  const b = (e.target as Element).closest<HTMLElement>("[data-reply]");
  if (b) reply(b.dataset.reply as "reply" | "all" | "forward", messages[Number(b.dataset.msg)]);
});

// Yes, Maybe or No on an invite: shown as chosen at once, put back if the answer couldn't be sent.
reader.addEventListener("click", async (e) => {
  const b = (e.target as Element).closest<HTMLButtonElement>("[data-rsvp]");
  if (!b || b.getAttribute("aria-pressed") === "true") return;
  const m = messages[Number(b.dataset.msg)];
  const account = threads.find((t) => t.id === selected)?.account ?? defaultAccount();
  const group = [...b.parentElement!.querySelectorAll<HTMLButtonElement>("[data-rsvp]")];
  const before = group.find((x) => x.getAttribute("aria-pressed") === "true");
  const press = (on: HTMLButtonElement | undefined) =>
    group.forEach((x) => x.setAttribute("aria-pressed", String(x === on)));
  press(b);
  group.forEach((x) => (x.disabled = true));
  try {
    await invoke("rsvp", {
      account,
      message: m.id,
      status: b.dataset.rsvp,
      fromName: accountSettings(account).name,
    });
    toast(`Sent “${b.textContent?.trim()}” to ${m.invite?.organizer.name || m.invite?.organizer.email}`, {
      kind: "success",
    });
  } catch (err) {
    press(before);
    toast(`Couldn't send your answer: ${err}`, { kind: "error" });
  } finally {
    group.forEach((x) => (x.disabled = false));
  }
});

reader.addEventListener("click", async (e) => {
  const el = (e.target as Element).closest<HTMLElement>(".message-files .attachment");
  if (!el) return;
  const { account, message, idx } = el.dataset;
  try {
    const path = await invoke<string>("open_attachment", { account, message, idx: Number(idx) });
    toast(`Saved to ${path.split("/").slice(-2).join("/")}`, { kind: "success" });
  } catch (err) {
    toast(String(err), { kind: "error" });
  }
});

function clearReader() {
  if (compose?.inline) closeComposer();
  selected = null;
  delete app.dataset.open;
  delete app.dataset.picked;
  messages = [];
  reader.innerHTML = `<div class="placeholder empty-reader"><i class="ti ti-chevron-up"></i><span>No email selected</span></div>`;
}

// Takes the thread itself, not its id: archive/trash drop it from `threads` first, and looking it up again
// would fall back to the default account and change the wrong mailbox.
function changeLocally(t: Thread, add: string[], remove: string[]) {
  if (add.includes("UNREAD")) t.unread = true;
  if (remove.includes("UNREAD")) t.unread = false;
  if (add.includes("STARRED")) t.starred = true;
  if (remove.includes("STARRED")) t.starred = false;
}

async function modify(t: Thread, add: string[], remove: string[], trash = false) {
  changeLocally(t, add, remove);
  renderThreads();
  try {
    await invoke("modify", { account: t.account, id: t.id, add, remove, trash });
  } catch (e) {
    toast(`Couldn't update message: ${e}`, { kind: "error" });
  }
}

// Archive, delete, spam and move, newest last; ⌘Z applies the reverse label change.
// One entry per action, so ⌘Z undoes a whole multi-selection at once.
const undoStack: { t: Thread; add: string[]; remove: string[] }[][] = [];
function undoable(t: Thread, add: string[], remove: string[], trash = false) {
  return undoableAll([t], add, remove, trash);
}
function undoableAll(list: Thread[], add: string[], remove: string[], trash = false) {
  // Only labels the thread has are removed, so ⌘Z after deleting from Sent doesn't put it in the Inbox.
  const changes = list.map((t) => ({ t, add, remove: remove.filter((l) => t.labels.split(" ").includes(l)) }));
  undoStack.push(changes);
  if (undoStack.length > 50) undoStack.shift();
  return applyChanges(changes, trash);
}
function undo() {
  const last = undoStack.pop();
  if (!last) return toast("Nothing to undo");
  toast("Undone", { kind: "success" });
  // The backend's mail-changed refresh puts the threads back in the list.
  return applyChanges(last.map((u) => ({ t: u.t, add: u.remove, remove: u.add })));
}

/** Label changes for several threads: one `modify_many` (Gmail's batch call) per account and change. */
function applyChanges(changes: { t: Thread; add: string[]; remove: string[] }[], trash = false) {
  const groups = new Map<string, typeof changes>();
  for (const c of changes) {
    const key = JSON.stringify([c.t.account, c.add, c.remove]);
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return Promise.all(
    [...groups.values()].map(async (group) => {
      const [{ t, add, remove }] = group;
      if (group.length === 1) return modify(t, add, remove, trash);
      group.forEach((c) => changeLocally(c.t, add, remove));
      renderThreads();
      try {
        await invoke("modify_many", { account: t.account, ids: group.map((c) => c.t.id), add, remove, trash });
      } catch (e) {
        toast(`Couldn't update ${group.length} emails: ${e}`, { kind: "error" });
      }
    }),
  );
}

/** Delete inside Trash: gone for good in Gmail too, so it always asks and can't be undone. */
async function deleteForever(list: Thread[]) {
  const yes = await ask({
    title: list.length === 1 ? "Delete forever?" : `Delete ${list.length} emails forever?`,
    message: "This can't be undone.",
    confirm: "Delete forever",
    danger: true,
  });
  if (!yes) return;
  if (multiPicked()) {
    threads = threads.filter((t) => !picked.has(t.id));
    picked.clear();
    delete app.dataset.picked;
    clearReader();
    setView("list");
    renderThreads();
  } else list.forEach((t) => removeAndAdvance(t.id));
  const byAccount = new Map<string, string[]>();
  for (const t of list) byAccount.set(t.account, [...(byAccount.get(t.account) ?? []), t.id]);
  await Promise.all(
    [...byAccount].map(([account, ids]) =>
      invoke("delete_forever", { account, ids }).catch((e) => toast(String(e), { kind: "error" })),
    ),
  );
}

/** Archive/trash: drop the thread from the list and move selection to its neighbour. */
function removeAndAdvance(id: string) {
  const i = threads.findIndex((t) => t.id === id);
  threads = threads.filter((t) => t.id !== id);
  if (id !== selected) return renderThreads();
  const next = threads[Math.min(i, threads.length - 1)];
  if (next && app.dataset.view !== "list") openThread(next.id);
  else {
    clearReader();
    setView("list");
  }
  renderThreads();
}

/** Runs an action on the open thread, or on `id` (e.g. a right-clicked row) without disturbing the reader. */
function act(action: string, id = selected) {
  if (multiPicked() && (!id || picked.has(id))) return actOnPicked(action);
  const t = threads.find((t) => t.id === id);
  if (!t) return;
  if (mailbox === "SCHEDULED") return scheduledAction(action, t.id);
  // Replies need the thread's messages, so open it first.
  if (["reply", "replyAll", "forward", "aiReply"].includes(action) && t.id !== selected) {
    openThread(t.id).then(() => act(action, t.id));
    return;
  }
  switch (action) {
    case "archive":
      removeAndAdvance(t.id);
      return undoable(t, [], ["INBOX"]);
    case "trash":
      if (mailbox === "TRASH") return void deleteForever([t]);
      if (settings.general.confirmDelete) {
        ask({
          title: "Delete this email?",
          message: `“${t.subject || "(no subject)"}” will move to Trash.`,
          confirm: "Delete",
          danger: true,
        }).then((yes) => yes && act("trashNow", t.id));
        return;
      }
      removeAndAdvance(t.id);
      return undoable(t, ["TRASH"], ["INBOX", "SPAM"], true);
    case "trashNow":
      removeAndAdvance(t.id);
      return undoable(t, ["TRASH"], ["INBOX", "SPAM"], true);
    case "unread":
      return modify(t, t.unread ? [] : ["UNREAD"], t.unread ? ["UNREAD"] : []);
    case "star":
      return modify(t, t.starred ? [] : ["STARRED"], t.starred ? ["STARRED"] : []);
    case "spam":
      removeAndAdvance(t.id);
      if (mailbox === "SPAM") return undoable(t, ["INBOX"], ["SPAM"]);
      return undoable(t, ["SPAM"], ["INBOX", "TRASH"]);
    case "reply":
      return reply("reply");
    case "replyAll":
      return reply("all");
    case "forward":
      return reply("forward");
    case "aiReply":
      return reply(settings.composer.defaultReply === "all" ? "all" : "reply")?.then(aiDraftReply);
    case "move":
      return openMenu("move", t);
    case "label":
      return openMenu("label", t);
  }
}

// ---- Multi-selection: ⌘-click adds or removes a row, ⇧-click adds the range from the last clicked row. With two or
// more picked, the reader shows the count and the actions, and actions (buttons, keys, right-click) apply to all of them.

const picked = new Set<string>();
let pickAnchor: string | null = null;
const multiPicked = () => picked.size > 1;

function pick(id: string, range: boolean) {
  if (!picked.size && selected) picked.add(selected);
  const anchor = pickAnchor ?? selected;
  const ids = threads.map((t) => t.id);
  const [a, b] = [anchor ? ids.indexOf(anchor) : -1, ids.indexOf(id)];
  if (range && a >= 0)
    ids.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((x) => picked.size < PICK_MAX && picked.add(x));
  else if (!picked.has(id) && picked.size >= PICK_MAX) return toast(`You can select up to ${PICK_MAX} emails at once`);
  else {
    if (picked.has(id)) picked.delete(id);
    else picked.add(id);
    pickAnchor = id;
  }
  if (multiPicked()) return showPicked();
  // Back to one (or none): just that email.
  const only = [...picked][0];
  picked.clear();
  if (only) openThread(only);
  else renderThreads();
}

// Label changes go out as one messages.batchModify (50 units per 1,000 messages), but Delete is still a
// threads.trash call per email (20 units). Gmail allows 6,000 units a minute per user, and sync shares them:
// 250 deletes is 5,000.
const PICK_MAX = 250;

function selectAll() {
  if (mailbox === "SCHEDULED" || !threads.length) return;
  picked.clear();
  threads.slice(0, PICK_MAX).forEach((t) => picked.add(t.id));
  if (!multiPicked()) return openThread(threads[0].id);
  showPicked();
  if (threads.length > PICK_MAX) toast(`Selected the first ${PICK_MAX} emails, the most Shift changes at once`);
}

function clearPicked() {
  if (!picked.size) return;
  picked.clear();
  clearReader();
  renderThreads();
}

const PICK_ACTIONS: [action: string, label: string, icon: string][] = [
  ["archive", "Archive", "archive"],
  ["unread", "", ""],
  ["star", "Pin", "push-pin"],
  ["spam", "Spam", "warning-octagon"],
];

function showPicked() {
  if (compose?.inline) closeComposer();
  selected = null;
  messages = [];
  app.dataset.open = "";
  app.dataset.picked = "";
  setView("reader");
  const list = threads.filter((t) => picked.has(t.id));
  const anyUnread = list.some((t) => t.unread);
  const button = ([action, label, icon]: (typeof PICK_ACTIONS)[number]) => {
    if (action === "unread")
      [label, icon] = anyUnread ? ["Mark as read", "envelope-simple-open"] : ["Mark as unread", "envelope-simple"];
    const key = keyLabel(action);
    return `<button type="button" data-pick-action="${action}">${iconHtml(icon)}<span>${label}</span>${key ? `<kbd>${esc(key)}</kbd>` : ""}</button>`;
  };
  reader.innerHTML = `<div class="picked-panel">
      <span class="picked-count">${list.length}</span>
      <h2>${list.length} emails selected</h2>
      <div class="picked-actions">${PICK_ACTIONS.map(button).join("")}
        <button type="button" class="quiet-danger" data-pick-action="trash">${iconHtml("trash")}<span>Delete</span>${keyLabel("trash") ? `<kbd>${esc(keyLabel("trash")!)}</kbd>` : ""}</button></div>
      <button type="button" class="picked-clear" data-pick-action="clear">Clear selection <kbd>esc</kbd></button>
    </div>`;
  renderThreads();
}

reader.addEventListener("click", (e) => {
  const b = (e.target as Element).closest<HTMLElement>("[data-pick-action]");
  if (!b) return;
  if (b.dataset.pickAction === "clear") return clearPicked();
  actOnPicked(b.dataset.pickAction!);
});

function actOnPicked(action: string) {
  const list = threads.filter((t) => picked.has(t.id));
  if (!list.length || mailbox === "SCHEDULED") return;
  const n = `${list.length} ${list.length === 1 ? "email" : "emails"}`;
  const leave = (add: string[], remove: string[], trash = false) => {
    threads = threads.filter((t) => !picked.has(t.id));
    picked.clear();
    delete app.dataset.picked;
    clearReader();
    setView("list");
    renderThreads();
    void undoableAll(list, add, remove, trash);
  };
  switch (action) {
    case "archive":
      return leave([], ["INBOX"]);
    case "spam":
      return leave(["SPAM"], ["INBOX", "TRASH"]);
    case "trash":
      if (mailbox === "TRASH") return void deleteForever(list);
      if (settings.general.confirmDelete) {
        void ask({ title: `Delete ${n}?`, message: "They will move to Trash.", confirm: "Delete", danger: true }).then(
          (yes) => yes && actOnPicked("trashNow"),
        );
        return;
      }
      return leave(["TRASH"], ["INBOX", "SPAM"], true);
    case "trashNow":
      return leave(["TRASH"], ["INBOX", "SPAM"], true);
    case "unread": {
      // Any unread: mark them all read; otherwise all unread.
      const read = list.some((t) => t.unread);
      void applyChanges(list.map((t) => ({ t, add: read ? [] : ["UNREAD"], remove: read ? ["UNREAD"] : [] })));
      return showPicked();
    }
    case "star": {
      const pin = list.some((t) => !t.starred);
      void applyChanges(list.map((t) => ({ t, add: pin ? ["STARRED"] : [], remove: pin ? [] : ["STARRED"] })));
      return showPicked();
    }
    default:
      toast(`Select one email to ${action === "move" ? "move" : action === "label" ? "label" : "do that"}`);
  }
}

const menu = $("#menu");
let menuAnchor: Element | null = null;
let menuPos = { x: 0, y: 0 };

/** `checked`: a toggle (the Label menu), shown with a check mark when on. */
type MenuItem =
  | {
      id: string;
      label: string;
      icon: string;
      key?: string;
      disabled?: boolean;
      danger?: boolean;
      acct?: string;
      dot?: string;
      checked?: boolean;
    }
  | "-";

function closeMenu() {
  if (!menu.hidden && menu.contains(document.activeElement)) menuReturn?.focus();
  menuReturn = null;
  menu.hidden = true;
  if (menu.matches(":popover-open")) menu.hidePopover();
  menuAnchor = null;
  threadList.querySelector(".context")?.classList.remove("context");
}

/** Shows `items` at a point, kept inside the window. `pick` returns true to keep the menu open. */
function showMenu(
  title: string | null,
  items: MenuItem[],
  pos: { x: number; y: number },
  pick: (id: string) => boolean | void,
) {
  menuPos = pos;
  // Re-rendered in place (the Label menu after a toggle): keep focus on the same item.
  const keep = menu.hidden ? null : (document.activeElement as HTMLElement | null)?.dataset?.target;
  if (menu.hidden) menuReturn = document.activeElement as HTMLElement | null;
  menu.innerHTML =
    (title ? `<h4>${esc(title)}</h4>` : "") +
    (items.length
      ? items
          .map((x) =>
            x === "-"
              ? "<hr>"
              : `<button role="${x.checked === undefined ? "menuitem" : `menuitemcheckbox" aria-checked="${x.checked}`}" data-target="${x.id}" class="${x.danger ? "danger" : ""}" ${x.disabled ? "disabled" : ""}>
        ${x.dot ? labelDot(x.label, x.dot) : x.icon ? iconHtml(x.icon) : ""}${x.acct ? `<span class="account-dot acct-${x.acct}"></span>` : ""}<span>${esc(x.label)}</span>${x.key ? `<kbd>${esc(x.key)}</kbd>` : ""}${
          x.checked === undefined ? "" : `<i class="ti ti-check menu-check" aria-hidden="true"></i>`
        }</button>`,
          )
          .join("")
      : `<p>No labels yet</p>`);
  menu.onclick = (e) => {
    const item = (e.target as Element).closest<HTMLButtonElement>("[data-target]");
    if (!item || item.disabled) return;
    if (!pick(item.dataset.target!)) closeMenu();
  };
  menu.hidden = false;
  // A popover, so it shows above an open modal (the composer); and inside that modal, since everything outside it is
  // inert while it's open.
  const host = document.querySelector("dialog:modal") ?? document.body;
  if (menu.parentElement !== host) {
    if (menu.matches(":popover-open")) menu.hidePopover();
    host.append(menu);
  }
  if (!menu.matches(":popover-open")) menu.showPopover();
  hideTip();
  const left = Math.max(8, Math.min(pos.x, window.innerWidth - menu.offsetWidth - 8));
  const top = Math.max(8, Math.min(pos.y, window.innerHeight - menu.offsetHeight - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  // Grows out of the point it was opened from, even when pushed back inside the window.
  menu.style.transformOrigin = `${pos.x - left}px ${pos.y - top}px`;
  const items$ = menuItems();
  (items$.find((b) => b.dataset.target === keep) ?? items$[0])?.focus();
}

/** Where focus was before a menu opened, so closing it hands focus back. */
let menuReturn: HTMLElement | null = null;
const menuItems = () => [...menu.querySelectorAll<HTMLButtonElement>("button[data-target]:not(:disabled)")];

// Keyboard menus: arrows and Home/End move, Return or Space picks, Esc closes. Keys stay in the menu, so a letter
// doesn't also run a shortcut behind it.
menu.addEventListener("keydown", (e) => {
  const list = menuItems();
  const i = list.indexOf(document.activeElement as HTMLButtonElement);
  const go = (n: number) => list[(n + list.length) % list.length]?.focus();
  e.stopPropagation();
  if (e.key === "ArrowDown") go(i + 1);
  else if (e.key === "ArrowUp") go(i < 0 ? -1 : i - 1);
  else if (e.key === "Home") go(0);
  else if (e.key === "End") go(-1);
  else if (e.key === "Escape") closeMenu();
  else if (e.key === "Tab") closeMenu();
  else return; // Return and Space click the focused button natively
  e.preventDefault();
});

// Round-trips through a data attribute, so no characters HTML rewrites (a NUL becomes U+FFFD); Gmail label ids never hold ":".
const NEW_LABEL = "new-label:";
/** Gmail labels that act as folders: mail sits in at most one, and Archive is none of them. */
const FOLDERS = ["INBOX", "SPAM", "TRASH"];

/** Move: file the thread under one folder. Label: toggle labels, menu stays open. */
function openMenu(kind: "move" | "label", t: Thread, pos?: { x: number; y: number }) {
  const anchor = document.querySelector(`[data-action="${kind}"]`)!;
  if (!pos && menuAnchor === anchor && !menu.hidden) return closeMenu();
  if (!pos) {
    const r = anchor.getBoundingClientRect();
    pos = { x: r.left, y: r.bottom + 6 };
  }
  const has = new Set(t.labels.split(" "));
  const own = accountLabels.get(t.account) ?? [];
  const items: MenuItem[] =
    kind === "move"
      ? [
          { id: "INBOX", label: "Inbox", icon: "tray", disabled: has.has("INBOX") },
          { id: "ARCHIVE", label: "Archive", icon: "archive", disabled: !FOLDERS.some((f) => has.has(f)) },
          { id: "SPAM", label: "Spam", icon: "warning-octagon", disabled: has.has("SPAM") },
          { id: "TRASH", label: "Trash", icon: "trash", disabled: has.has("TRASH") },
        ]
      : [
          ...own.map(
            (l): MenuItem => ({ id: l.id, label: l.name, icon: "", dot: l.color ?? "none", checked: has.has(l.id) }),
          ),
          ...(own.length ? ["-" as const] : []),
          { id: NEW_LABEL, label: "New label…", icon: "plus" },
        ];
  showMenu(kind === "move" ? "Move to" : "Labels", items, pos, (id) => {
    if (id === NEW_LABEL) {
      void askText({
        title: "New label",
        message: `Created ${inMail()} and added to this email.`,
        confirm: "Create",
        value: "",
      }).then(async (name) => {
        if (!name) return;
        try {
          const created = await invoke<string>("create_label", { account: t.account, name });
          t.labels = `${t.labels} ${created}`.trim();
          await modify(t, [created], []);
        } catch (err) {
          toast(String(err), { kind: "error" });
        }
      });
      return;
    }
    if (kind === "label") {
      const on = !t.labels.split(" ").includes(id);
      t.labels = on
        ? `${t.labels} ${id}`.trim()
        : t.labels
            .split(" ")
            .filter((l) => l !== id)
            .join(" ");
      modify(t, on ? [id] : [], on ? [] : [id]);
      openMenu("label", t, menuPos);
      return true;
    }
    if (id === "TRASH") return void act("trash", t.id);
    if (mailbox !== null && mailbox !== id) removeAndAdvance(t.id);
    undoable(
      t,
      id === "ARCHIVE" ? [] : [id],
      FOLDERS.filter((f) => f !== id && has.has(f)),
    );
  });
  menuAnchor = anchor;
}

// Right-click a mailbox: mark all read; on a label also rename, colour and delete (in Gmail, every account in view).
$("#mailboxes").addEventListener("contextmenu", (e) => {
  const a = (e.target as Element).closest<HTMLElement>("[data-mailbox]");
  if (!a) return;
  e.preventDefault();
  closeMenu();
  const id = a.dataset.mailbox || null;
  const label = userLabels.find((l) => l.id === id);
  const items: MenuItem[] = [
    {
      id: "read",
      label: "Mark all as read",
      icon: "envelope-simple-open",
      disabled: id === "SCHEDULED" || id === "DRAFT",
    },
  ];
  if (id === "TRASH" || id === "SPAM")
    items.push("-", { id: "empty", label: id === "TRASH" ? "Empty Trash" : "Empty Spam", icon: "trash", danger: true });
  items.push("-", { id: "hide", label: "Hide from sidebar", icon: "eye-slash" });
  const names = new Map([
    ...SYSTEM.map(([sid, name]) => [sid ?? "ALL", name] as const),
    ...userLabels.map((l) => [l.id, l.name] as const),
  ]);
  const hidden = settings.sidebar.hidden.filter((k) => names.has(k));
  if (hidden.length)
    items.push(...hidden.map((k) => ({ id: `show:${k}`, label: `Show ${names.get(k)}`, icon: "eye" })));
  if (label) {
    items.push(
      "-",
      { id: "rename", label: "Rename…", icon: "pencil-simple" },
      { id: "color", label: "Colour", icon: "palette" },
      "-",
      { id: "delete", label: "Delete label", icon: "trash", danger: true },
    );
  }
  showMenu(null, items, { x: e.clientX, y: e.clientY }, (pick) => {
    if (pick === "read") {
      // Gmail marks every unread email in the mailbox, older ones not shown here included.
      const box = a.querySelector("span")?.textContent ?? "this mailbox";
      void ask({
        title: `Mark all of ${box} as read?`,
        message: `Every unread email in ${box}${inAccounts()} is marked read ${inMail()}, including older ones not shown here.`,
        confirm: "Mark as read",
      }).then((yes) => void (yes && labelAction(invoke("mark_all_read", { label: id, accounts: scope }))));
      return;
    }
    if (pick === "empty") return void emptyMailbox(id!);
    if (pick === "hide") return setSetting("sidebar.hidden", [...settings.sidebar.hidden, id ?? "ALL"]);
    if (pick.startsWith("show:"))
      return setSetting(
        "sidebar.hidden",
        settings.sidebar.hidden.filter((k) => k !== pick.slice(5)),
      );
    if (!label) return;
    if (pick === "color") {
      showMenu(
        label.name,
        LABEL_COLORS.map(([name, bg]) => ({ id: bg, label: name, icon: "", dot: bg })),
        menuPos,
        (bg) => {
          const text = LABEL_COLORS.find((c) => c[1] === bg)![2];
          // Shown at once, then sent to Gmail; if Gmail refuses, the refresh puts the saved colour back.
          for (const l of [...userLabels, ...[...accountLabels.values()].flat()])
            if (l.name === label.name) l.color = bg;
          const dot = document.querySelector<HTMLElement>(
            `#mailboxes [data-mailbox="${CSS.escape(label.id)}"] .label-dot`,
          );
          if (dot) {
            dot.className = "label-dot";
            dot.dataset.color = bg.slice(1).toLowerCase();
          }
          renderThreads();
          invoke("set_label_color", { label: label.id, background: bg, text, accounts: scope }).catch((err) => {
            toast(String(err), { kind: "error" });
            refresh();
          });
        },
      );
      return true;
    }
    if (pick === "rename") {
      void askText({
        title: "Rename label",
        message: `The label is renamed ${inMail()} too.`,
        confirm: "Rename",
        value: label.name,
      }).then((name) => {
        if (!name || name === label.name) return;
        // A merged label's id is its name, so the open mailbox follows the rename.
        const follow = mailbox === label.id && label.id.startsWith("name:") ? `name:${name}` : undefined;
        void labelAction(invoke("rename_label", { label: label.id, name, accounts: scope }), follow);
        for (const key of ["needsReply", "waiting"] as const)
          if (settings.inbox.followUps[key] === label.name) setSetting(`inbox.followUps.${key}`, name);
      });
    }
    if (pick === "delete") {
      void ask({
        title: `Delete “${label.name}”?`,
        message: `The label is removed ${inMail()}${inAccounts()}. Its emails keep their other labels and stay in All Mail.`,
        confirm: "Delete",
        danger: true,
      }).then(
        (yes) =>
          void (
            yes &&
            labelAction(
              invoke("delete_label", { label: label.id, accounts: scope }),
              mailbox === label.id ? "INBOX" : undefined,
            )
          ),
      );
    }
  });
});

let sortedJustNow = false;
// Drag a mailbox to reorder it within its group (system mailboxes or labels): the row lifts and follows the pointer,
// the others slide out of its way, and it drops into the gap. Pointer events, not HTML drag and drop, whose
// see-through copy floated over the list while the real row jumped between slots.
$("#mailboxes").addEventListener("pointerdown", (e) => {
  const item = (e.target as Element).closest<HTMLElement>("[data-mailbox]");
  if (!item || e.button !== 0) return;
  const box = $("#mailboxes");
  const rows = [...box.querySelectorAll<HTMLElement>(`[data-group="${item.dataset.group}"]`)];
  const tops = rows.map((r) => r.getBoundingClientRect().top);
  const from = rows.indexOf(item);
  const pitch = rows.length > 1 ? tops[1] - tops[0] : 0;
  let to = from;
  let dragging = false;
  const move = (ev: PointerEvent) => {
    const dy = ev.clientY - e.clientY;
    if (!dragging) {
      if (Math.abs(dy) < 4) return;
      dragging = true;
      item.classList.add("lifted");
      box.classList.add("sorting");
    }
    const y = Math.max(tops[0] - tops[from], Math.min(tops.at(-1)! - tops[from], dy));
    item.style.transform = `translateY(${y}px)`;
    to = Math.max(0, Math.min(rows.length - 1, from + Math.round(y / pitch)));
    rows.forEach((r, i) => {
      if (r === item) return;
      const shift = i > from && i <= to ? -pitch : i < from && i >= to ? pitch : 0;
      r.style.transform = shift ? `translateY(${shift}px)` : "";
    });
  };
  const up = () => {
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    removeEventListener("pointercancel", up);
    if (!dragging) return;
    // The release would otherwise click the row and open that mailbox.
    sortedJustNow = true;
    setTimeout(() => (sortedJustNow = false));
    rows.forEach((r) => (r.style.transform = ""));
    item.classList.remove("lifted");
    box.classList.remove("sorting");
    if (to === from) return;
    if (to > from) rows[to].after(item);
    else rows[to].before(item);
    saveSidebarOrder();
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
  addEventListener("pointercancel", up);
});
function saveSidebarOrder() {
  const shown = [...$("#mailboxes").querySelectorAll<HTMLElement>("[data-mailbox]")].map(
    (a) => a.dataset.mailbox || "ALL",
  );
  setSetting("sidebar.order", [...shown, ...settings.sidebar.order.filter((k) => !shown.includes(k))]);
}

/** " in both accounts" / " in all 3 accounts" when an action reaches every account in the unified view, else "". */
/** Where a change lands: "in Gmail", or "on your mail server" once an IMAP account is in view. */
function inMail() {
  return (scope ?? accounts).some((a) => imapAccounts.has(a)) ? "on your mail server" : "in Gmail";
}

function inAccounts() {
  const n = (scope ?? accounts.filter((x) => accountSettings(x).unified !== false)).length;
  return n < 2 ? "" : n === 2 ? " in both accounts" : ` in all ${n} accounts`;
}

async function emptyMailbox(id: string) {
  const name = id === "TRASH" ? "Trash" : "Spam";
  const yes = await ask({
    title: `Empty ${name}?`,
    message: `Everything in ${name}${inAccounts()} is deleted for good, ${inMail()} too. This can't be undone.`,
    confirm: `Empty ${name}`,
    danger: true,
  });
  if (yes) await labelAction(invoke("empty_mailbox", { label: id, accounts: scope }));
}
$("#empty-btn").addEventListener("click", () => mailbox && emptyMailbox(mailbox));

async function labelAction(run: Promise<unknown>, nextMailbox?: string) {
  try {
    await run;
  } catch (err) {
    return toast(String(err), { kind: "error" });
  }
  if (nextMailbox) openMailbox(nextMailbox);
}

threadList.addEventListener("contextmenu", (e) => {
  const li = (e.target as Element).closest<HTMLElement>("li[data-id]");
  if (!li) return;
  e.preventDefault();
  const t = threads.find((x) => x.id === li.dataset.id);
  if (!t) return;
  closeMenu();
  li.classList.add("context");
  if (multiPicked() && picked.has(t.id)) {
    const list = threads.filter((x) => picked.has(x.id));
    return showMenu(
      `${list.length} emails`,
      [
        {
          id: "unread",
          label: list.some((x) => x.unread) ? "Mark as read" : "Mark as unread",
          icon: "envelope-simple-open",
          key: keyLabel("unread"),
        },
        { id: "star", label: list.some((x) => !x.starred) ? "Pin" : "Unpin", icon: "push-pin", key: keyLabel("star") },
        "-",
        { id: "archive", label: "Archive", icon: "archive", key: keyLabel("archive") },
        { id: "spam", label: "Spam", icon: "warning-octagon", key: keyLabel("spam") },
        { id: "trash", label: "Delete", icon: "trash", key: keyLabel("trash"), danger: true },
      ],
      { x: e.clientX, y: e.clientY },
      (id) => actOnPicked(id),
    );
  }
  if (mailbox === "SCHEDULED") {
    return showMenu(
      null,
      [
        { id: "edit", label: "Edit", icon: "pencil-simple" },
        { id: "sendNow", label: "Send now", icon: "paper-plane-right" },
        "-",
        { id: "cancel", label: "Cancel send", icon: "x-circle", key: keyLabel("trash"), danger: true },
      ],
      { x: e.clientX, y: e.clientY },
      (id) => void scheduledAction(id, t.id),
    );
  }
  const binned = mailbox === "SPAM" || mailbox === "TRASH";
  // Your own sent mail is never unread and never spam.
  const sent = mailbox === "SENT";
  const items: MenuItem[] = [
    { id: "reply", label: "Reply", icon: "arrow-bend-up-left", key: keyLabel("reply") },
    { id: "replyAll", label: "Reply all", icon: "arrow-bend-double-up-left", key: keyLabel("replyAll") },
    { id: "forward", label: "Forward", icon: "arrow-bend-up-right", key: keyLabel("forward") },
    { id: "aiReply", label: "Draft a reply with AI", icon: "message-ai" },
    "-",
    // Spam and Trash are on their way out: no reading state, pins or labels, just where the email goes next.
    ...(binned
      ? []
      : ([
          ...(sent
            ? []
            : [
                {
                  id: "unread",
                  label: t.unread ? "Mark as read" : "Mark as unread",
                  icon: t.unread ? "envelope-simple-open" : "envelope-simple",
                  key: keyLabel("unread"),
                },
              ]),
          { id: "star", label: t.starred ? "Unpin" : "Pin", icon: "push-pin", key: keyLabel("star") },
          "-",
        ] as MenuItem[])),
    { id: "move", label: "Move to…", icon: "folder", key: keyLabel("move") },
    ...(binned ? [] : [{ id: "label", label: "Label…", icon: "tag", key: keyLabel("label") }]),
    "-",
    {
      id: "archive",
      label: "Archive",
      icon: "archive",
      key: keyLabel("archive"),
      disabled: !t.labels.split(" ").includes("INBOX"),
    },
    ...(sent
      ? []
      : [
          mailbox === "SPAM"
            ? { id: "spam", label: "Not spam", icon: "inbox", key: keyLabel("spam") }
            : { id: "spam", label: "Spam", icon: "warning-octagon", key: keyLabel("spam") },
        ]),
    {
      id: "trash",
      label: mailbox === "TRASH" ? "Delete forever" : "Delete",
      icon: "trash",
      key: keyLabel("trash"),
      danger: true,
    },
  ];
  showMenu(null, items, { x: e.clientX, y: e.clientY }, (id) => {
    if (id === "move" || id === "label") {
      openMenu(id, t, menuPos);
      li.classList.add("context");
      return true;
    }
    act(id, t.id);
  });
});

document.addEventListener("pointerdown", (e) => {
  if (!menu.hidden && !menu.contains(e.target as Node) && !menuAnchor?.contains(e.target as Node)) closeMenu();
});

// ---- Composer: replies open inline under the thread, new emails in a resizable window.
// Drafts save to Gmail Drafts as you type, so closing never loses work and drafts reach your other devices.

type ReplyContext = { thread_id: string; in_reply_to: string; references: string };
type Fields = { to?: string; cc?: string; bcc?: string; subject?: string; body?: string };
type ComposeOptions = {
  title?: string;
  context?: ReplyContext | null;
  inline?: boolean;
  draftId?: string | null;
  touched?: boolean;
  /** Which account sends it. Replies use the thread's account. */
  account?: string;
  attachments?: OutFile[];
  /** A scheduled email being edited: its send time, which closing the composer keeps. */
  resumeAt?: number | null;
  /** The Drafts row it was opened from, dropped from the list when the draft is discarded. */
  thread?: string | null;
};
type ComposeState = Required<ComposeOptions>;

let compose: ComposeState | null = null;
let draftTimer = 0;
let draftQueue: Promise<unknown> = Promise.resolve();

const subjectInput = composeForm.elements.namedItem("subject") as HTMLInputElement;
const editor = createEditor(
  $("#compose-body"),
  $("#format-bar"),
  () => markTouched(),
  () => signatureFor(compose?.account).html,
  renderQuote,
);
const suggestContacts = (q: string) => invoke<string[]>("suggest_contacts", { query: q }).catch(() => [] as string[]);
const rcpt = {
  to: new Recipients($("#rcpt-to"), suggestContacts, () => markTouched()),
  cc: new Recipients($("#rcpt-cc"), suggestContacts, () => markTouched()),
  bcc: new Recipients($("#rcpt-bcc"), suggestContacts, () => markTouched()),
};

const draftStatus = (text: string) => ($("#draft-status").textContent = text);

function showCcRows(cc: boolean, bcc: boolean) {
  composeForm.querySelector<HTMLElement>('[data-row="cc"]')!.hidden = !cc;
  composeForm.querySelector<HTMLElement>('[data-row="bcc"]')!.hidden = !bcc;
  $("#cc-toggle").hidden = cc && bcc;
}

/** "From" chips, shown only with several accounts and not on replies (they belong to their thread's account). */
function renderFromRow() {
  const row = $("#from-row");
  row.hidden = !multi() || !compose || !!compose.context;
  if (row.hidden || !compose) return;
  row.querySelector(".from-choices")!.innerHTML = accounts
    .map(
      (
        a,
      ) => `<button type="button" role="radio" aria-checked="${a === compose!.account}" class="${a === compose!.account ? "on" : ""}" data-from="${esc(a)}">
      <span class="account-dot acct-${accountSettings(a).color}"></span>${esc(accountName(a))}</button>`,
    )
    .join("");
}
$("#from-row").addEventListener("click", (e) => {
  const b = (e.target as Element).closest<HTMLElement>("[data-from]");
  if (!b || !compose || b.dataset.from === compose.account) return;
  const state = compose;
  const prev = state.account;
  // A Gmail draft lives in one account: delete it there (after any save already queued), so the next save creates it in the new one.
  draftQueue = draftQueue.then(() => {
    const id = state.draftId;
    state.draftId = null;
    if (id) return invoke("delete_draft", { account: prev, draftId: id }).catch(() => {});
  });
  state.account = b.dataset.from!;
  swapSignature(prev, state.account);
  renderFromRow();
  markTouched();
});

function markTouched() {
  if (!compose) return;
  compose.touched = true;
  clearTimeout(draftTimer);
  // drafts.update replaces the whole message, so every save re-uploads the files; with big ones, save less often.
  const bytes = compose.attachments.reduce((n, f) => n + f.size, 0);
  draftTimer = window.setTimeout(() => saveDraft(), bytes > 1_000_000 ? 15_000 : 1500);
}
subjectInput.addEventListener("input", markTouched);
// Tab into the body lands on the first line. Left to the browser, focus can select the signature block instead.
subjectInput.addEventListener("keydown", (e) => {
  if (e.key !== "Tab" || e.shiftKey) return;
  e.preventDefault();
  editor.commands.focus("start");
});

const hasContent = () =>
  !!compose?.touched &&
  !!(
    compose.attachments.length ||
    editor.getText().trim() ||
    subjectInput.value.trim() ||
    rcpt.to.count ||
    rcpt.cc.count ||
    rcpt.bcc.count
  );

/** The message as the backend expects it: HTML from the editor plus a plain-text version. */
function currentDraft(state: ComposeState): Record<string, unknown> {
  const sigHtml = signatureFor(state.account).html;
  const sigText =
    new DOMParser().parseFromString(sigHtml.replace(/<br\s*\/?>/gi, "\n"), "text/html").body.textContent ?? "";
  return {
    to: rcpt.to.value,
    cc: rcpt.cc.value,
    bcc: rcpt.bcc.value,
    subject: subjectInput.value,
    body: docToText(editor.state.doc, sigText),
    html: emailHtml(editor.getHTML(), sigHtml),
    from_name: accountSettings(state.account).name,
    ...(state.context ?? {}),
    attachments: state.attachments,
  };
}

/**
 * Saves are queued, so a slow save can't race the next one into creating a duplicate draft. Resolves to whether this
 * save reached Gmail.
 */
/** The composer's fields as typed, for reopening it later. */
const currentFields = (): Fields => ({
  to: rcpt.to.value,
  cc: rcpt.cc.value,
  bcc: rcpt.bcc.value,
  subject: subjectInput.value,
  body: editor.getHTML(),
});

/** Schedules an edited scheduled email again for the time it had (`resumeAt`). */
const resumeSchedule = (state: ComposeState, payload: unknown, fields: Fields) =>
  invoke("schedule_send", {
    account: state.account,
    draft: payload,
    draftId: state.draftId,
    sendAt: state.resumeAt,
    ui: { fields, opts: { title: state.title, context: state.context } },
  });

function saveDraft(state = compose, payload = state && currentDraft(state)): Promise<boolean> {
  clearTimeout(draftTimer);
  if (!state || !payload) return draftQueue.then(() => true);
  draftStatus("Saving…");
  // The account is fixed now; the draft id is read when the save runs, after the saves queued before it.
  const account = state.account;
  const saved = draftQueue.then(() =>
    invoke<string>("save_draft", { account, draft: payload, draftId: state.draftId })
      .then((id) => {
        state.draftId = id;
        if (compose === state) draftStatus("Saved");
        return true;
      })
      .catch(() => {
        if (compose === state) draftStatus("Not saved — will retry");
        return false;
      }),
  );
  draftQueue = saved;
  return saved;
}

/** Takes the form out of the reader / window and parks it back in the (closed) dialog. */
function detachComposer() {
  const host = composeForm.closest(".compose-inline");
  if (composer.open) composer.close();
  composer.append(composeForm);
  host?.remove();
}

/** Closes the composer, keeping the draft (default) or deleting it. */
async function closeComposer(discard = false) {
  const state = compose;
  if (!state) return;
  const keep = !discard && hasContent();
  const payload = keep ? currentDraft(state) : null;
  const fields = currentFields();
  compose = null;
  detachComposer();
  if (discard) {
    if (state.thread && mailbox === "DRAFT") {
      threads = threads.filter((t) => t.id !== state.thread);
      renderThreads();
    }
    await draftQueue;
    if (state.draftId) invoke("delete_draft", { account: state.account, draftId: state.draftId }).catch(() => {});
  } else if (keep) {
    if (await saveDraft(state, payload)) {
      if (!state.resumeAt) return showDraftPill(fields, state);
      if (state.resumeAt <= Date.now()) return toast("Its send time passed while you edited, so it's in Drafts");
      return resumeSchedule(state, payload, fields).then(
        () => toast(`Still scheduled for ${formatWhen(new Date(state.resumeAt!))}`),
        (err) => toast(`Couldn't schedule it again, so it's in Drafts: ${err}`),
      );
    }
    // Not in Gmail: bring it back rather than lose it, unless another email was opened meanwhile.
    if (compose) return toast(`Couldn't save a draft ${inMail()}; it wasn't kept`, { kind: "error" });
    await openComposer(fields, { ...state, touched: true });
    $("#compose-error").textContent =
      `Couldn't save this draft ${inMail()}, so it's still open. Check your connection and close it again.`;
  }
}

// The last draft closed with "keep": a corner card that reopens it, until dismissed or another email is written.
const draftPill = $("#draft-pill");
let pillDraft: { fields: Fields; state: ComposeState } | null = null;
function showDraftPill(fields: Fields, state: ComposeState) {
  pillDraft = { fields, state };
  $("#draft-pill-subject").textContent = fields.subject || "(no subject)";
  draftPill.hidden = false;
}
function hideDraftPill() {
  pillDraft = null;
  draftPill.hidden = true;
}
function reopenPillDraft() {
  const d = pillDraft;
  if (!d) return;
  hideDraftPill();
  void openComposer(d.fields, { ...d.state, touched: false });
}
draftPill.addEventListener("click", (e) => {
  if ((e.target as Element).closest("#draft-pill-close")) return hideDraftPill();
  if ((e.target as Element).closest("#draft-pill-delete")) return void discardPillDraft();
  reopenPillDraft();
});
async function discardPillDraft() {
  const d = pillDraft;
  if (!d) return;
  const sure = await ask({
    title: "Discard this draft?",
    message: "It will be deleted from Drafts too.",
    confirm: "Discard",
    danger: true,
  });
  if (!sure || pillDraft !== d) return;
  hideDraftPill();
  const { state } = d;
  if (state.thread && mailbox === "DRAFT") {
    threads = threads.filter((t) => t.id !== state.thread);
    renderThreads();
  }
  if (state.draftId) invoke("delete_draft", { account: state.account, draftId: state.draftId }).catch(() => {});
}
draftPill.addEventListener("keydown", (e) => {
  if (e.target === draftPill && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    reopenPillDraft();
  }
});

async function openComposer(fields: Fields = {}, opts: ComposeOptions = {}) {
  hideDraftPill();
  if (compose) {
    await closeComposer();
    // Its draft couldn't be saved, so it came back open: keep it rather than replace it.
    if (compose) return;
  }
  const inline = !!opts.inline && !!selected && (!opts.context || opts.context.thread_id === selected);
  compose = {
    title: opts.title ?? "New Email",
    context: opts.context ?? null,
    inline,
    draftId: opts.draftId ?? null,
    touched: !!opts.touched,
    account: opts.account ?? defaultAccount(),
    attachments: opts.attachments ?? [],
    resumeAt: opts.resumeAt ?? null,
    thread: opts.thread ?? null,
  };
  renderComposeFiles();
  renderFromRow();
  rcpt.to.set(fields.to ?? "");
  rcpt.cc.set(fields.cc ?? "");
  rcpt.bcc.set(fields.bcc ?? "");
  showCcRows(!!fields.cc, !!fields.bcc);
  subjectInput.value = fields.subject ?? "";
  // setContent leaves the selection at the end, which selects the signature node.
  editor
    .chain()
    .setContent(fields.body ?? "", { emitUpdate: false })
    .setTextSelection(0)
    .run();
  foldReplyQuote(editor);
  $("#compose-title").textContent = compose.title;
  $("#compose-error").textContent = "";
  draftStatus(compose.draftId ? "Saved" : "");
  if (inline) {
    const host = document.createElement("section");
    host.className = "message compose-inline";
    host.append(composeForm);
    reader.append(host);
  } else {
    composer.append(composeForm);
    composer.style.removeProperty("--drag-x");
    composer.style.removeProperty("--drag-y");
    dock(false);
    composer.showModal();
  }
  if (fields.to || opts.context) {
    editor.commands.focus("start");
    $("#compose-body").scrollTop = 0;
  } else rcpt.to.focus();
  // After focusing: focus jumps the scroll and would cut a smooth scroll short.
  if (inline)
    composeForm.parentElement!.scrollIntoView({
      block: "start",
      behavior: settings.accessibility.reduceMotion ? "auto" : "smooth",
    });
}

/** Splits an address header on commas that aren't inside a quoted display name. */
const splitAddresses = (list: string) =>
  list
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((a) => a.trim())
    .filter(Boolean);

/** The account's signature block ("-- " separator for text, the email convention), or "" if it has none. */
function signatureBlock(account: string) {
  const sig = signatureFor(account);
  if (sig.mode === "html") return sig.html.trim() ? "<p></p><div data-signature></div>" : "";
  return sig.text.trim() ? `<p></p>${textToHtml(`-- \n${sig.text.trim()}`)}` : "";
}

/** An empty line to write on, then the account's signature. */
const signature = (account: string) => "<p></p>" + signatureBlock(account);

/** After a From change: the new account's signature replaces the old one, unless the old block no longer appears as inserted (edited). */
function swapSignature(from: string, to: string) {
  const exts = editor.extensionManager.extensions;
  const normal = (html: string) => (html ? generateHTML(generateJSON(html, exts), exts) : "");
  const [before, after] = [normal(signatureBlock(from)), normal(signatureBlock(to))];
  const body = editor.getHTML();
  // shortcut: from an account without a signature, the new one is only added to emails without a quote (at the end); place it above the quote if forwards need it.
  const next = before
    ? body.includes(before)
      ? body.replace(before, () => after)
      : null
    : body.includes("<blockquote")
      ? null
      : body + after;
  // Always reset when found, even if unchanged: it rebuilds the HTML signature's preview for the new account.
  if (next !== null) editor.chain().setContent(next, { emitUpdate: false }).setTextSelection(0).run();
}

/** The original message for a reply or forward: its HTML where there is some, quoted under a header line. */
// shortcut: styles in the original's <head> and inline (cid:) images are left out of the quote; carry them as inline
// MIME parts with their Content-IDs, and scope the styles, if forwards need them.
/** The quoted email for a reply or forward, whole: cleaned of anything active, its inline (cid:) images dropped since
 *  they don't travel with the reply, and a text version for the plain-text part. */
function quoted(m: Message, header: string) {
  const body = m.html ? new DOMParser().parseFromString(cleanEmail(m.html).html, "text/html").body : null;
  body?.querySelectorAll('img[src^="cid:" i]').forEach((img) => img.remove());
  const html = body ? body.innerHTML : textToHtml(m.text ?? "");
  const text = m.text ?? (body ? blockText(body) : "");
  return `<p></p>${header}<div data-quote="${esc(html)}" data-text="${esc(text)}"></div>`;
}

/** The composer's preview of a quoted email: sandboxed with no scripts, remote images only when they're allowed. */
function renderQuote(frame: HTMLIFrameElement, html: string) {
  const images = settings.appearance.loadRemoteImages ? "https: http: data:" : "data:";
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.onload = () => (frame.style.height = `${frame.contentDocument?.documentElement.scrollHeight ?? 80}px`);
  frame.srcdoc =
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src ${images}">` +
    EMAIL_CSS +
    cleanEmail(html).html;
}

/** Replies to or forwards `last`: the newest message, or the one whose own buttons were clicked. */
function reply(kind: "reply" | "all" | "forward", last = messages.at(-1)) {
  if (!last || !selected) return;
  const thread = threads.find((t) => t.id === selected);
  const account = thread?.account ?? defaultAccount();
  const notMe = (a: string) => !accounts.includes(bareEmail(a));
  const when = new Date(last.date).toLocaleString();
  if (kind === "forward") {
    const header = textToHtml(
      `---------- Forwarded message ----------\nFrom: ${last.sender}\nDate: ${when}\nSubject: ${last.subject}\nTo: ${last.recipients}`,
    );
    const opened = openComposer(
      {
        subject: /^fwd?:/i.test(last.subject) ? last.subject : `Fwd: ${last.subject}`,
        body: signature(account) + quoted(last, header),
      },
      { title: "Forward", inline: settings.composer.replyIn === "inline", account },
    );
    return opened.then(() => attachFrom(last, account));
  }
  const mine = !notMe(last.sender);
  const primary = mine ? splitAddresses(last.recipients) : [last.reply_to || last.sender];
  const others = kind === "all" ? [...splitAddresses(last.recipients), ...splitAddresses(last.cc)] : [];
  const cc = [...new Set(others.filter((a) => notMe(a) && !primary.some((p) => bareEmail(p) === bareEmail(a))))];
  const header = textToHtml(`On ${when}, ${displayName(last.sender)} wrote:`);
  return openComposer(
    {
      to: primary.join(", "),
      cc: cc.join(", "),
      subject: /^re:/i.test(last.subject) ? last.subject : `Re: ${last.subject}`,
      body: signature(account) + (settings.composer.quoteOriginal ? quoted(last, header) : ""),
    },
    {
      title: kind === "all" ? "Reply all" : "Reply",
      context: { thread_id: selected, in_reply_to: last.message_id, references: last.refs },
      inline: settings.composer.replyIn === "inline",
      account,
    },
  );
}

function recipientProblem() {
  const all = [rcpt.to.value, rcpt.cc.value, rcpt.bcc.value].flatMap(splitList);
  if (!all.length) return "Add at least one recipient";
  const bad = all.find((a) => !isValidAddress(a));
  return bad ? `Check this address: ${bad}` : "";
}

/** Composers being sent or scheduled: a second ⌘↩ or click during the first must not send the email twice. */
const submitting = new WeakSet<ComposeState>();
/** A forward's files still downloading; Send and Send later wait for them so the email doesn't go out without them. */
const pendingFiles = new WeakMap<ComposeState, Promise<void>>();

/** Waits for a forward's files, saying so while it does. */
async function filesReady(state: ComposeState) {
  const pending = pendingFiles.get(state);
  if (!pending) return;
  $("#compose-error").textContent = "Attaching files…";
  await pending;
  $("#compose-error").textContent = "";
}

composeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const state = compose;
  if (!state || submitting.has(state)) return;
  const error = (msg: string) => ($("#compose-error").textContent = msg);
  const problem = recipientProblem();
  if (problem) return error(problem);
  submitting.add(state);
  await filesReady(state);
  if (compose !== state) return void submitting.delete(state);
  const draft = currentDraft(state);
  const fields = currentFields();
  // Let any pending save finish first, so it can't recreate the draft after it's been sent.
  clearTimeout(draftTimer);
  await draftQueue;
  const send = () => invoke("send", { account: state.account, draft, draftId: state.draftId });
  const reopen = (msg = "") => openComposer(fields, { ...state, touched: true }).then(() => error(msg));
  const delay = settings.composer.undoSendSeconds;
  if (delay > 0) {
    // Undo send goes through the scheduled queue, due in `delay` seconds: it's saved in Drafts and on this Mac, so
    // quitting or restarting for an update during the countdown still sends it, and Undo cancels the schedule.
    let id: number;
    try {
      if (!(await saveDraft(state, draft)))
        throw new Error("Couldn't save it to Drafts, so it wasn't sent. Check your connection and try again");
      id = await invoke<number>("schedule_send", {
        account: state.account,
        draft,
        draftId: state.draftId,
        sendAt: Date.now() + delay * 1000,
        ui: { fields, opts: { title: state.title, context: state.context } },
      });
    } catch (err) {
      submitting.delete(state);
      return error(err instanceof Error ? err.message : String(err));
    }
    compose = null;
    detachComposer();
    const sending = toast(`Sending in ${delay}s…`, {
      ms: delay * 1000,
      action: {
        label: "Undo",
        run: () => {
          clearInterval(tick);
          invoke("reschedule", { account: state.account, id, sendAt: null }).then(
            () => reopen(),
            (err) => toast(String(err)),
          );
        },
      },
    });
    let left = delay;
    // open: another toast may have replaced this one mid-countdown.
    const tick = window.setInterval(
      () => sending.open && left > 1 && sending.setMessage(`Sending in ${--left}s…`),
      1000,
    );
    return;
  }
  const button = composeForm.querySelector<HTMLButtonElement>("button[type=submit]")!;
  button.disabled = true;
  try {
    await send();
    compose = null;
    detachComposer();
    toast("Message sent", { kind: "success" });
  } catch (err) {
    // Still open: the user can fix the problem and send again.
    submitting.delete(state);
    error(String(err));
  } finally {
    button.disabled = false;
  }
});

// ---- Send later: the clock next to Send, and the Scheduled view.

// The locale files are CommonJS, so the bundler can hand back the module wrapper instead of the locale itself.
const localeEn = (localeEnModule as unknown as { default?: typeof localeEnModule }).default ?? localeEnModule;

// The "Pick Date & Time…" popover: Air Datepicker's calendar, a time field with quick times, and a summary.
const laterPanel = $("#later-panel");
const laterTime = $<HTMLInputElement>("#later-time");
let laterDay = new Date();
const laterCal = new AirDatepicker(laterPanel.querySelector<HTMLElement>(".later-cal")!, {
  inline: true,
  locale: localeEn,
  firstDay: 1,
  minDate: new Date(),
  onSelect: ({ date }) => {
    if (date instanceof Date) laterDay = date;
    updateLater();
  },
});
/** The chosen day at the chosen time, or null while the time field is empty. */
function laterAt(): Date | null {
  const [h, m] = laterTime.value.split(":").map(Number);
  if (!laterTime.value || Number.isNaN(h)) return null;
  const at = new Date(laterDay);
  at.setHours(h, m || 0, 0, 0);
  return at;
}
function updateLater() {
  const at = laterAt();
  const past = !at || at.getTime() <= Date.now();
  laterPanel.querySelector(".later-summary")!.textContent = at
    ? past
      ? "That time has passed"
      : `Sends ${formatWhen(at)}`
    : "Pick a time";
  laterPanel.querySelector<HTMLButtonElement>(".later-go")!.disabled = past;
  laterPanel
    .querySelectorAll<HTMLElement>("[data-time]")
    .forEach((b) => b.classList.toggle("on", b.dataset.time === laterTime.value));
}
function openLater(at: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  laterDay = at;
  laterCal.update({ minDate: new Date() });
  laterCal.selectDate(at, { silent: true });
  laterCal.setViewDate(at);
  laterTime.value = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  laterPanel.hidden = false;
  updateLater();
  laterTime.focus();
}
const closeLater = () => (laterPanel.hidden = true);
laterTime.addEventListener("input", updateLater);
laterPanel.querySelectorAll<HTMLElement>("[data-time]").forEach((b) =>
  b.addEventListener("click", () => {
    laterTime.value = b.dataset.time!;
    updateLater();
  }),
);
laterPanel.querySelector(".later-go")!.addEventListener("click", () => {
  const at = laterAt();
  if (at) scheduleSend(at);
});
laterPanel.addEventListener("keydown", (e) => {
  // Handled here so Escape closes the popover, not the whole composer.
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeLater();
  } else if (e.key === "Enter" && !e.metaKey && e.target === laterTime) {
    e.preventDefault();
    const at = laterAt();
    if (at && at.getTime() > Date.now()) scheduleSend(at);
  }
});
document.addEventListener("pointerdown", (e) => {
  if (!laterPanel.hidden && !laterPanel.contains(e.target as Node) && !(e.target as Element).closest("#send-later"))
    closeLater();
});

async function scheduleSend(at: Date) {
  const state = compose;
  if (!state || submitting.has(state)) return;
  const error = (msg: string) => ($("#compose-error").textContent = msg);
  const problem = recipientProblem();
  if (problem) return error(problem);
  if (at.getTime() <= Date.now()) return error("Pick a time in the future");
  submitting.add(state);
  await filesReady(state);
  if (compose !== state) return void submitting.delete(state);
  const draft = currentDraft(state);
  const fields = currentFields();
  // Saved to Gmail Drafts first, so the email is safe there (and visible on other devices) until it goes out.
  await saveDraft(state, draft);
  try {
    const id = await invoke<number>("schedule_send", {
      account: state.account,
      draft,
      draftId: state.draftId,
      sendAt: at.getTime(),
      ui: { fields, opts: { title: state.title, context: state.context } },
    });
    compose = null;
    detachComposer();
    closeLater();
    toast(`Scheduled for ${formatWhen(at)}`, {
      ms: 6000,
      action: {
        label: "Undo",
        run: () => {
          invoke("reschedule", { account: state.account, id, sendAt: null }).then(() =>
            openComposer(fields, { ...state, touched: true, resumeAt: null }),
          );
        },
      },
    });
  } catch (err) {
    submitting.delete(state);
    error(String(err));
  }
}

$("#send-later").addEventListener("click", async () => {
  const times = quickTimes(new Date(), settings.scheduling);
  const menu = await Menu.new({
    items: [
      ...times.map((t) => ({ text: `${t.label}  ·  ${formatWhen(t.at)}`, action: () => scheduleSend(t.at) })),
      { item: "Separator" as const },
      {
        text: "Pick Date & Time…",
        action: () => openLater(times.find((t) => t.id === "tomorrow")!.at),
      },
      { item: "Separator" as const },
      { text: "Sent from this Mac while Shift is running", enabled: false },
    ],
  });
  menu.popup();
});

// ---- Write with AI: the AI button next to Send later. Edits the selection, or the part of the email the user
// wrote; in a reply it can also draft the reply, using what's typed so far as notes.

const AI_EDITS: [label: string, icon: string, instruction: string][] = [
  ["Improve writing", "wand", "Improve the writing: clearer and more natural, same meaning, roughly the same length."],
  ["Make shorter", "arrows-diagonal-minimize-2", "Make it shorter and more direct, keeping everything important."],
  ["Make friendlier", "mood-smile", "Make it warmer and friendlier."],
  ["Make more formal", "tie", "Make it more formal and professional."],
  ["Fix spelling & grammar", "text-spellcheck", "Fix spelling, grammar and punctuation only. Change nothing else."],
];

/** The selection, or everything above the signature and the quoted original (and its "On …, X wrote:" line). */
function ownText(): { from: number; to: number; text: string } {
  const { doc, selection } = editor.state;
  if (!selection.empty)
    return { from: selection.from, to: selection.to, text: doc.textBetween(selection.from, selection.to, "\n\n") };
  let to = 0;
  let stop = false;
  doc.forEach((node, offset) => {
    if (stop) return;
    const text = node.textContent.trim();
    stop =
      ["signature", "blockquote", "quote"].includes(node.type.name) ||
      text.startsWith("-- ") ||
      /^On .+ wrote:$/s.test(text) ||
      /^-{5,} Forwarded message/.test(text);
    if (!stop) to = offset + node.nodeSize;
  });
  return { from: 0, to, text: doc.textBetween(0, to, "\n\n").trim() };
}

/** An email's text for the AI: its plain-text part, or its HTML read as text. */
const messageText = (m: Message) =>
  (m.text ?? new DOMParser().parseFromString(m.html ?? "", "text/html").body.textContent ?? "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

async function aiWrite(run: () => Promise<string>, range: { from: number; to: number }) {
  const btn = $<HTMLButtonElement>("#ai-write");
  btn.disabled = true;
  btn.classList.add("busy");
  draftStatus("Writing with AI…");
  // A skeleton stands in for the text being replaced; the editor is locked meanwhile so the range stays valid.
  const replaced: HTMLElement[] = [];
  editor.state.doc.forEach((_, offset, i) => {
    if (offset < range.to) replaced.push(editor.view.dom.children[i] as HTMLElement);
  });
  const writing = (on: boolean) => {
    $("#ai-skeleton").hidden = !on;
    $("#compose-body").classList.toggle("ai-writing", on);
    replaced.forEach((el) => el.classList.toggle("ai-replacing", on));
    editor.setEditable(!on);
  };
  writing(true);
  try {
    const text = await run();
    if (!text) throw new Error("The AI returned nothing");
    writing(false);
    editor.chain().focus().insertContentAt(range, textToHtml(text)).run();
    draftStatus("");
    markTouched();
  } catch (e) {
    draftStatus("");
    toast(String(e), { kind: "error" });
  } finally {
    writing(false);
    btn.disabled = false;
    btn.classList.remove("busy");
  }
}

/** Drafts a reply to the open conversation into the composer, from the user's notes there if any. */
function aiDraftReply() {
  const state = compose;
  if (!state) return;
  const own = ownText();
  const name = accountSettings(state.account).name;
  const conversation = messages
    .slice(-8)
    .map((m) => `From: ${m.sender}\nDate: ${new Date(m.date).toLocaleString()}\n\n${messageText(m).slice(-4000)}`)
    .join("\n\n---\n\n");
  return aiWrite(
    () =>
      invoke<string>("ai_draft_reply", {
        conversation,
        notes: own.text,
        me: name ? `${name} <${state.account}>` : state.account,
        rules: settings.ai.writingRules,
      }),
    own,
  );
}

$("#ai-write").addEventListener("click", () => {
  const state = compose;
  const anchor = $<HTMLButtonElement>("#ai-write");
  if (!state) return;
  if (menuAnchor === anchor && !menu.hidden) return closeMenu();
  const own = ownText();
  const rewrite = (instruction: string) =>
    aiWrite(() => invoke<string>("ai_rewrite", { text: own.text, instruction, rules: settings.ai.writingRules }), own);
  // Edits only once there's text to edit, rather than a list of greyed-out ones.
  const items: MenuItem[] = [
    ...(state.context && messages.length
      ? [
          { id: "draft", label: own.text ? "Draft a reply from my notes" : "Draft a reply", icon: "message-reply" },
          ...(own.text ? ["-" as const] : []),
        ]
      : []),
    ...(own.text
      ? [
          ...AI_EDITS.map(([label, icon], i): MenuItem => ({ id: `edit-${i}`, label, icon })),
          "-" as const,
          { id: "custom", label: "Custom instruction…", icon: "pencil" },
        ]
      : [{ id: "none", label: "Write something to edit it with AI", icon: "info-circle", disabled: true }]),
  ];
  const r = anchor.getBoundingClientRect();
  showMenu(editor.state.selection.empty ? null : "Edit the selection", items, { x: r.left, y: r.bottom + 6 }, (id) => {
    if (id === "draft") void aiDraftReply();
    else if (id === "custom") {
      void askText({
        title: "Rewrite with AI",
        message: 'Say what to change, for example "Make it sound more confident".',
        confirm: "Rewrite",
        value: "",
      }).then((instruction) => void (instruction && rewrite(instruction)));
    } else if (id.startsWith("edit-")) void rewrite(AI_EDITS[Number(id.slice(5))][2]);
  });
  menuAnchor = anchor;
  // The button sits at the bottom of the composer: open upward when there's no room below.
  if (r.bottom + 6 + menu.offsetHeight > window.innerHeight - 8)
    menu.style.top = `${Math.max(8, r.top - menu.offsetHeight - 6)}px`;
});

/** Opening a scheduled email pauses it while it's edited; closing the composer schedules it again for the same time. */
async function editScheduled(id: string) {
  const r = scheduledRows.get(id);
  if (!r) return;
  // One step in the backend, so it can't be sent between reading it and taking it off the schedule.
  let attachments: OutFile[] | null;
  try {
    attachments = await invoke<OutFile[] | null>("take_scheduled", { account: r.account, id: r.id });
  } catch (err) {
    refresh();
    return toast(String(err), { kind: "error" });
  }
  await openComposer(r.ui.fields, {
    ...r.ui.opts,
    account: r.account,
    draftId: r.draft_id,
    attachments: attachments ?? [],
    touched: true,
    inline: false,
    resumeAt: r.send_at,
  });
  toast("Paused while you edit. Closing keeps it scheduled.");
}

function scheduledAction(action: string, id: string) {
  const r = scheduledRows.get(id);
  if (!r) return;
  if (action === "edit") return editScheduled(id);
  if (action === "sendNow") return invoke("reschedule", { account: r.account, id: r.id, sendAt: Date.now() });
  if (action === "cancel" || action === "trash") {
    return invoke("reschedule", { account: r.account, id: r.id, sendAt: null }).then(() =>
      toast("Send cancelled. The email is in Drafts."),
    );
  }
}

// ---- Composer attachments: the paperclip, drag and drop, and removable chips.

const composeFiles = $("#compose-files");
const fileInput = $<HTMLInputElement>("#compose-file");

function renderComposeFiles() {
  const files = compose?.attachments ?? [];
  composeFiles.hidden = !files.length;
  composeFiles.innerHTML = files
    .map((f, i) => attachmentButton(fileIcon(f.mime, f.name), f.name, f.size, { i }, true))
    .join("");
}

async function addComposeFiles(list: Iterable<File>) {
  const state = compose;
  if (!state) return;
  for (const file of list) {
    const tooBig = checkSize(state.attachments, file.size);
    if (tooBig) {
      $("#compose-error").textContent = tooBig;
      break;
    }
    const f = await readFile(file).catch(() => null);
    if (compose !== state) return;
    if (!f) continue;
    state.attachments.push(f);
    renderComposeFiles();
    markTouched();
  }
}

/** Adds the forwarded message's files (including inline images) to the composer as they download. */
/** Adds `m`'s files to the open composer (a forward, a reopened draft). Send waits for them (`pendingFiles`). */
function attachFrom(m: Message, account: string) {
  const state = compose;
  const files = forwardAttachments(m, account);
  if (state)
    pendingFiles.set(
      state,
      files.finally(() => pendingFiles.delete(state)),
    );
  return files;
}

/**
 * Drafts: reopens the Gmail draft in the composer to keep editing it (saves update the same draft). False when it
 * can't be found, for example in demo mode or once sent, so the email opens read-only instead.
 */
/**
 * Opens a Drafts row in the composer straight from the cache; the Gmail draft id and Bcc (which the cache doesn't
 * keep) are looked up meanwhile, queued ahead of any save so an early save replaces this draft instead of adding one.
 */
async function openDraft(id: string): Promise<boolean> {
  const account = threads.find((t) => t.id === id)?.account ?? defaultAccount();
  const lookup = invoke<[string, string, string] | null>("find_draft", { account, thread: id }).catch(() => null);
  const msgs = await invoke<Message[]>("thread", { account, id }).catch(() => [] as Message[]);
  // The draft is the newest message in its conversation; a reply draft answers the one before it.
  const m = msgs.at(-1);
  if (!m) return false;
  const earlier = msgs.at(-2);
  await openComposer(
    { to: m.recipients, cc: m.cc, subject: m.subject, body: m.html ?? textToHtml(m.text ?? "") },
    {
      title: "Draft",
      account,
      inline: false,
      thread: id,
      context: earlier ? { thread_id: id, in_reply_to: earlier.message_id, references: m.refs } : null,
    },
  );
  const state = compose;
  if (!state) return true;
  draftQueue = draftQueue.then(async () => {
    const found = await lookup;
    if (!found) {
      if (compose === state)
        $("#compose-error").textContent = `Couldn't find this draft ${inMail()}; saving makes a new one.`;
      return;
    }
    const [draftId, , bcc] = found;
    state.draftId = draftId;
    if (compose !== state) return;
    draftStatus("Saved");
    if (bcc && !rcpt.bcc.value) {
      rcpt.bcc.set(bcc);
      showCcRows(!!rcpt.cc.value, true);
      // A save made before the Bcc arrived went out without it.
      if (state.touched) markTouched();
    }
  });
  void attachFrom(m, account);
  return true;
}

async function forwardAttachments(m: Message, account: string) {
  const state = compose;
  for (const a of m.attachments) {
    const name = a.filename || "attachment";
    // Same 25 MB limit as files added by hand, checked before downloading; smaller files after it can still fit.
    const tooBig = checkSize(state?.attachments ?? [], a.size);
    if (tooBig) {
      $("#compose-error").textContent = `${name} wasn't attached. ${tooBig}`;
      continue;
    }
    const data = await invoke<string>("attachment_data", { account, message: m.id, idx: a.idx }).catch(() => null);
    if (compose !== state || !state) return;
    if (data === null) {
      toast(`Couldn't attach ${name}`, { kind: "error" });
      continue;
    }
    state.attachments.push({ name, mime: a.mime, data, size: a.size });
    renderComposeFiles();
  }
}

$("#compose-attach").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  addComposeFiles([...(fileInput.files ?? [])]);
  fileInput.value = "";
});
composeFiles.addEventListener("click", (e) => {
  const el = (e.target as Element).closest<HTMLElement>(".attachment-remove");
  if (!el || !compose) return;
  compose.attachments.splice(Number(el.closest<HTMLElement>(".attachment")!.dataset.i), 1);
  renderComposeFiles();
  markTouched();
});
composeForm.addEventListener("dragover", (e) => {
  if (!e.dataTransfer?.types.includes("Files")) return;
  e.preventDefault();
  composeForm.classList.add("dropping");
});
composeForm.addEventListener("dragleave", (e) => {
  if (!composeForm.contains(e.relatedTarget as Node)) composeForm.classList.remove("dropping");
});
composeForm.addEventListener("drop", (e) => {
  composeForm.classList.remove("dropping");
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  addComposeFiles([...e.dataTransfer.files]);
});

$("#compose-close").addEventListener("click", () => closeComposer());
$("#compose-discard").addEventListener("click", async () => {
  if (
    hasContent() &&
    !(await ask({
      title: "Discard this draft?",
      message: "It will be deleted from Drafts too.",
      confirm: "Discard",
      danger: true,
    }))
  )
    return;
  closeComposer(true);
});
$("#cc-toggle").addEventListener("click", () => {
  showCcRows(true, true);
  rcpt.cc.focus();
});
// Escape is handled by the app's keydown handler (escapeComposer); the window never closes itself.
composer.addEventListener("cancel", (e) => e.preventDefault());
// A click on the dimmed backdrop closes it and keeps the draft. Both ends of the click must be outside, so a text
// selection dragged past the edge, or the resize corner, doesn't close it.
let pressedOutside = false;
const outsideComposer = (e: MouseEvent) => {
  if (e.target !== composer) return false;
  const r = composer.getBoundingClientRect();
  return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
};
composer.addEventListener("pointerdown", (e) => (pressedOutside = outsideComposer(e)));
composer.addEventListener("click", (e) => {
  if (pressedOutside && outsideComposer(e) && !askOpen()) void closeComposer();
  pressedOutside = false;
});
// The window moves by its header; each new composer opens centred again (openComposer clears the offset).
composer.addEventListener("pointerdown", (e) => {
  const head = (e.target as Element).closest<HTMLElement>(".compose-form > header");
  if (!head || e.button !== 0 || composer.classList.contains("docked")) return;
  if ((e.target as Element).closest("button, input")) return;
  e.preventDefault();
  const x0 = e.clientX - (parseFloat(composer.style.getPropertyValue("--drag-x")) || 0);
  const y0 = e.clientY - (parseFloat(composer.style.getPropertyValue("--drag-y")) || 0);
  const start = composer.getBoundingClientRect();
  const base = { left: start.left - (e.clientX - x0), top: start.top - (e.clientY - y0) };
  const move = (m: PointerEvent) => {
    // Keep the header reachable: at least 80px of it on screen, and never above the top edge.
    const x = Math.min(Math.max(m.clientX - x0, 80 - base.left - start.width), innerWidth - 80 - base.left);
    const y = Math.min(Math.max(m.clientY - y0, -base.top), innerHeight - 48 - base.top);
    composer.style.setProperty("--drag-x", `${x}px`);
    composer.style.setProperty("--drag-y", `${y}px`);
  };
  head.setPointerCapture(e.pointerId);
  head.addEventListener("pointermove", move);
  head.addEventListener("lostpointercapture", () => head.removeEventListener("pointermove", move), { once: true });
});
// Docked: a smaller, non-modal window in the bottom-right corner, so the email behind it can be read and used. It
// keeps its own size; the centred window's size comes back when it's undocked.
let undockedSize = ["", ""];
function dock(on: boolean) {
  if (on === composer.classList.contains("docked")) return;
  if (on) {
    undockedSize = [composer.style.width, composer.style.height];
    composer.style.width = composer.style.height = "";
  } else [composer.style.width, composer.style.height] = undockedSize;
  composer.classList.toggle("docked", on);
  const button = $("#compose-dock");
  button.dataset.tip = on ? "Move to centre" : "Move to corner";
  button.setAttribute("aria-label", button.dataset.tip);
  button.querySelector("i")!.className = `ti ${on ? "ti-arrows-diagonal" : "ti-picture-in-picture"}`;
}
// Dropping .moving while open would replay the opening animation, so it stays until the window really closes (the
// close event arrives after a dock toggle has already reopened it).
composer.addEventListener("close", () => {
  if (!composer.open) composer.classList.remove("moving");
});
$("#compose-dock").addEventListener("click", () => {
  const focused = document.activeElement as HTMLElement | null;
  const on = !composer.classList.contains("docked");
  const from = composer.getBoundingClientRect();
  composer.classList.add("moving");
  composer.close();
  dock(on);
  if (on) composer.show();
  else composer.showModal();
  focused?.focus();
  const to = composer.getBoundingClientRect();
  if (settings.accessibility.reduceMotion || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  // FLIP: start where it was and glide to its new place and size.
  composer.animate(
    [
      {
        transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`,
      },
      { transform: "none" },
    ],
    { duration: 360, easing: ACCORDION.easing },
  );
  if (!on) composer.animate({ opacity: [0, 1] }, { duration: 360, easing: "ease-out", pseudoElement: "::backdrop" });
});
// Resizing from any edge or corner. The dialog is centred, so a size change grows both sides; shifting the offset by
// half of it keeps the opposite edge still.
for (const grip of composer.querySelectorAll<HTMLElement>(".resize-edge")) {
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const edge = grip.dataset.edge!;
    const r = composer.getBoundingClientRect();
    const ox = parseFloat(composer.style.getPropertyValue("--drag-x")) || 0;
    const oy = parseFloat(composer.style.getPropertyValue("--drag-y")) || 0;
    const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
    const move = (m: PointerEvent) => {
      const dx = m.clientX - e.clientX;
      const dy = m.clientY - e.clientY;
      if (edge.includes("e") || edge.includes("w")) {
        const sign = edge.includes("e") ? 1 : -1;
        const w = clamp(r.width + sign * dx, 420, innerWidth - 32);
        composer.style.width = `${w}px`;
        composer.style.setProperty("--drag-x", `${ox + (sign * (w - r.width)) / 2}px`);
      }
      if (edge.includes("n") || edge.includes("s")) {
        const sign = edge.includes("s") ? 1 : -1;
        const h = clamp(r.height + sign * dy, 360, innerHeight - 32);
        composer.style.height = `${h}px`;
        composer.style.setProperty("--drag-y", `${oy + (sign * (h - r.height)) / 2}px`);
      }
    };
    grip.setPointerCapture(e.pointerId);
    grip.addEventListener("pointermove", move);
    grip.addEventListener("lostpointercapture", () => grip.removeEventListener("pointermove", move), { once: true });
  });
}

/** Escape: closes an empty composer, otherwise asks whether to keep the draft. A second Escape discards it. */
async function escapeComposer() {
  if (!hasContent()) return closeComposer();
  if (askOpen()) return;
  const choice = await askChoice({
    title: "Close this email?",
    message: "Save it to Drafts to finish later, or press Esc again to discard it.",
    confirm: "Save draft",
    alt: "Discard",
    escapeIsAlt: true,
  });
  if (choice === "ok") return closeComposer();
  if (choice === "alt") return closeComposer(true);
  editor.commands.focus();
}
$("#compose-btn").addEventListener("click", () => openComposer({ body: signature(defaultAccount()) }));

$("#mailboxes").addEventListener("click", (e) => {
  // Real links (href="#") so they're focusable and work with Return and VoiceOver; never navigate.
  e.preventDefault();
  if (sortedJustNow) return;
  if ((e.target as Element).closest(".label-add")) return void newLabel();
  const a = (e.target as Element).closest<HTMLElement>("[data-mailbox]");
  if (a) openMailbox(a.dataset.mailbox || null);
});

/** The sidebar's + next to Labels: creates the label in every account on screen. Gmail labels belong to one account;
 * the sidebar merges labels with the same name, so one created in each account shows as one label for all of them. */
async function newLabel() {
  const list = scope ?? accounts.filter((a) => accountSettings(a).unified !== false);
  const where =
    list.length === 1 ? accountName(list[0]) : list.length === 2 ? "both accounts" : `all ${list.length} accounts`;
  const picked = await askTextAndColor({
    title: "New label",
    message: accounts.length > 1 ? `Created ${inMail()} for ${where}.` : `Created ${inMail()}.`,
    confirm: "Create",
    value: "",
    colors: LABEL_COLORS.map(([colorName, bg]) => [
      colorName,
      `class="label-dot ask-swatch" data-color="${bg.slice(1)}"`,
    ]),
  });
  if (!picked) return;
  const [, background, text] = LABEL_COLORS.find(([n]) => n === picked.color)!;
  const name = picked.text;
  const failed = (
    await Promise.allSettled(
      list.map(async (account) => {
        await invoke<string>("create_label", { account, name });
        await invoke("set_label_color", { label: `name:${name}`, background, text, accounts: [account] });
      }),
    )
  ).flatMap((r, i) => (r.status === "rejected" ? [`${accountName(list[i])}: ${r.reason}`] : []));
  if (failed.length) toast(`Couldn't create the label in ${failed.join("; ")}`, { kind: "error" });
  await renderMailboxes();
}

/** Shows some accounts (null: all of them); keeps the current mailbox when it exists there. */
function setScope(list: string[] | null) {
  scope = list && list.length < accounts.length ? accounts.filter((a) => list.includes(a)) : null;
  renderAccountFooter();
  // Label ids belong to one account and merged ones to several, so a label mailbox falls back to the Inbox.
  if (mailbox && !SYSTEM.some(([id]) => id === mailbox)) mailbox = "INBOX";
  openMailbox(mailbox);
}

function openMailbox(id: string | null) {
  mailbox = id;
  keptUnread.clear();
  search = null;
  searchInputs.forEach((i) => (i.value = ""));
  clearReader();
  setView("list");
  refresh();
}

let suppressClick = false;
threadList.addEventListener(
  "scroll",
  () => {
    if (threadList.scrollTop + threadList.clientHeight < threadList.scrollHeight - 400) return;
    if (drawn >= threads.length) return loadMore();
    drawn += PAGE;
    renderThreads();
  },
  { passive: true },
);

threadList.addEventListener("click", (e) => {
  if (suppressClick) return void (suppressClick = false);
  const li = (e.target as Element).closest<HTMLElement>("li[data-id]");
  if (!li) return;
  const rowAction = (e.target as Element).closest<HTMLElement>("[data-row-action]")?.dataset.rowAction;
  if (rowAction) act(rowAction, li.dataset.id);
  else if ((e.metaKey || e.shiftKey) && mailbox !== "SCHEDULED") pick(li.dataset.id!, e.shiftKey);
  else openThread(li.dataset.id!);
});

// Swipes: two-finger horizontal scroll on the trackpad, or a touch drag. Past the threshold on release runs the
// action configured in Settings → Swipes.
const SWIPE_AT = 90;
function swipeShow(li: HTMLElement, dx: number) {
  const action = dx < 0 ? settings.swipes.left : settings.swipes.right;
  li.style.transform = `translateX(${dx}px)`;
  li.dataset.swipe = action;
  li.classList.toggle("swipe-armed", action !== "none" && Math.abs(dx) > SWIPE_AT);
}
function swipeEnd(li: HTMLElement, dx: number) {
  li.style.transform = "";
  delete li.dataset.swipe;
  li.classList.remove("swipe-armed");
  const action = dx < 0 ? settings.swipes.left : settings.swipes.right;
  if (Math.abs(dx) > SWIPE_AT && action !== "none") act(action, li.dataset.id);
}
let wheelSwipe: { li: HTMLElement; dx: number; timer: number } | null = null;
let swipeCooldown = 0;
threadList.addEventListener(
  "wheel",
  (e) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    const li = (e.target as Element).closest<HTMLElement>("li[data-id]");
    if (!li) return;
    e.preventDefault();
    // Trackpad momentum keeps sending events after the fingers lift; don't let it start a second swipe.
    if (Date.now() < swipeCooldown) return;
    if (wheelSwipe?.li !== li) wheelSwipe = { li, dx: 0, timer: 0 };
    const s = wheelSwipe;
    s.dx = Math.max(-160, Math.min(160, s.dx - e.deltaX));
    swipeShow(li, s.dx);
    clearTimeout(s.timer);
    s.timer = window.setTimeout(() => {
      wheelSwipe = null;
      swipeCooldown = Date.now() + 400;
      swipeEnd(li, s.dx);
    }, 140);
  },
  { passive: false },
);
threadList.addEventListener("pointerdown", (e) => {
  if (e.pointerType !== "touch") return;
  const li = (e.target as Element).closest<HTMLElement>("li[data-id]");
  if (!li) return;
  const x0 = e.clientX;
  const y0 = e.clientY;
  let dx = 0;
  let swiping = false;
  const move = (ev: PointerEvent) => {
    dx = ev.clientX - x0;
    if (!swiping && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(ev.clientY - y0)) {
      swiping = true;
      li.setPointerCapture(ev.pointerId);
    }
    if (swiping) swipeShow(li, Math.max(-160, Math.min(160, dx)));
  };
  const up = () => {
    li.removeEventListener("pointermove", move);
    if (swiping) {
      suppressClick = true;
      swipeEnd(li, dx);
    }
  };
  li.addEventListener("pointermove", move);
  li.addEventListener("pointerup", up, { once: true });
  li.addEventListener("pointercancel", up, { once: true });
});

document
  .querySelectorAll<HTMLElement>("[data-action]")
  .forEach((b) => b.addEventListener("click", () => act(b.dataset.action!)));
document
  .querySelectorAll<HTMLElement>("[data-back]")
  .forEach((b) => b.addEventListener("click", () => setView(b.dataset.back as "mailboxes" | "list")));

// Live search: results from the local cache on every keystroke, sender suggestions underneath. Return also
// asks Gmail, which finds mail that isn't stored on this Mac. Emptying the field goes back to the mailbox.
let suggestions: string[] = [];
let suggestIndex = -1;
let liveTimer = 0;
let liveSeq = 0;

function closeSuggest() {
  document.querySelectorAll(".suggest").forEach((el) => el.remove());
  suggestions = [];
  suggestIndex = -1;
}

function renderSuggest(form: HTMLFormElement) {
  form.querySelector(".suggest")?.remove();
  if (!suggestions.length) return;
  const box = document.createElement("div");
  box.className = "suggest";
  box.setAttribute("role", "listbox");
  box.innerHTML = suggestions
    .map(
      (
        s,
        i,
      ) => `<button type="button" role="option" data-i="${i}" aria-selected="${i === suggestIndex}" class="${i === suggestIndex ? "on" : ""}">
        ${avatar(s)}<span class="from-chip"><em>from:</em> ${esc(displayName(s) || bareEmail(s))}</span><small>${esc(bareEmail(s))}</small></button>`,
    )
    .join("");
  // pointerdown + preventDefault keeps focus in the field, so blur doesn't close the list before the pick lands.
  box.addEventListener("pointerdown", (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-i]");
    if (!b) return;
    e.preventDefault();
    pickSuggestion(form, Number(b.dataset.i));
  });
  form.append(box);
}

function pickSuggestion(form: HTMLFormElement, i: number) {
  form.querySelector("input")!.value = `from:${bareEmail(suggestions[i])}`;
  closeSuggest();
  form.requestSubmit();
}

async function runLive(form: HTMLFormElement, value: string) {
  const seq = ++liveSeq;
  const [rows, senders] = await Promise.all([
    invoke<Thread[]>("search_local", { query: value, accounts: scope }),
    invoke<string[]>("suggest_senders", { query: value, accounts: scope }),
  ]);
  if (seq !== liveSeq) return; // a newer keystroke already ran
  search = value;
  loadSeq++; // a list load still in flight mustn't replace these results
  threads = rows;
  renderThreads();
  suggestions = value.includes("from:") ? [] : senders;
  suggestIndex = -1;
  renderSuggest(form);
}

searchInputs.forEach((input) => {
  const form = input.closest("form")!;
  input.addEventListener("input", () => {
    clearTimeout(liveTimer);
    searchInputs.forEach((i) => i !== input && (i.value = input.value));
    const value = input.value.trim();
    if (!value) {
      liveSeq++;
      closeSuggest();
      if (search !== null) {
        search = null;
        clearReader();
        refresh();
      }
      return;
    }
    liveTimer = window.setTimeout(() => runLive(form, value), 60);
  });
  input.addEventListener("keydown", (e) => {
    if (!suggestions.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      suggestIndex =
        e.key === "ArrowDown" ? Math.min(suggestIndex + 1, suggestions.length - 1) : Math.max(suggestIndex - 1, -1);
      renderSuggest(form);
    } else if (e.key === "Enter" && suggestIndex >= 0) {
      e.preventDefault();
      pickSuggestion(form, suggestIndex);
    } else if (e.key === "Escape") {
      e.stopPropagation(); // first Escape closes the suggestions, the next leaves the field
      closeSuggest();
    }
  });
  input.addEventListener("blur", () => window.setTimeout(closeSuggest, 120));
});

document.querySelectorAll<HTMLFormElement>(".search").forEach((form) =>
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = form.querySelector("input")!;
    searchInputs.forEach((i) => i !== input && (i.value = input.value));
    const value = input.value.trim();
    clearTimeout(liveTimer);
    liveSeq++;
    closeSuggest();
    if (!value) return;
    search = value;
    clearReader();
    try {
      threads = await invoke<Thread[]>("search_local", { query: value, accounts: scope });
      renderThreads();
      $("#list-title").textContent = searchingTitle(value);
      await loadThreads();
    } catch (err) {
      // Offline or Gmail error: keep the results already showing (this Mac's, and any account that answered).
      renderThreads();
      toast(`Some results may be missing: ${err}`);
    }
  }),
);

$("#sync-btn").addEventListener("click", () => invoke("sync_now"));

$("#view-btn").addEventListener("click", () =>
  setSetting("inbox.view", settings.inbox.view === "smart" ? "list" : "smart"),
);

async function signOut(account: string) {
  const waiting = (await invoke<unknown[]>("scheduled", { accounts: [account] })).length;
  const unsent = waiting
    ? ` ${waiting} scheduled ${waiting === 1 ? "email" : "emails"} won't be sent; ${waiting === 1 ? "it stays" : "they stay"} in ${imapAccounts.has(account) ? "Drafts" : "Gmail's Drafts"}.`
    : "";
  const yes = await ask({
    title: `Sign out of ${account}?`,
    message: `Mail stored on this Mac for this account will be removed. ${imapAccounts.has(account) ? "The mail on your server" : "Your Gmail"} isn't affected.${unsent}`,
    confirm: "Sign out",
    danger: true,
  });
  if (!yes) return;
  await invoke("sign_out", { account });
  const left = (await loadStatus()).accounts;
  if (!left.length) return location.reload();
  accounts = left;
  scope = scope?.filter((a) => a !== account) ?? null;
  if (!scope?.length) scope = null;
  closeSettings();
  start(accounts);
}

$("#settings-btn").addEventListener("click", () => openSettings());
/** Browser sign-in; the new account appears in the sidebar and starts syncing. */
async function addAccount() {
  try {
    await invoke<string>("add_account");
    start((await loadStatus()).accounts);
  } catch (e) {
    toast(String(e), { kind: "error" });
  }
}

/** Email and password sign-in for an account that isn't Gmail. */
async function addOtherAccount() {
  if (await addImapAccount()) start((await loadStatus()).accounts);
}

initSettings({
  accounts: () => accounts,
  isImap: (a) => imapAccounts.has(a),
  onAddAccount: addAccount,
  onAddImap: addOtherAccount,
  onSignOut: signOut,
});
$("#signin-other").addEventListener("click", () => void addOtherAccount());
initOnboarding();
initCleanup({ scope: () => scope, toast });
$("#cleanup-btn").addEventListener("click", () => void openCleanup());

$("#signin-btn").addEventListener("click", async () => {
  const btn = $<HTMLButtonElement>("#signin-btn");
  btn.disabled = true;
  $("#signin-error").textContent = "Finish signing in in your browser…";
  try {
    await invoke<string>("add_account");
    start((await loadStatus()).accounts);
  } catch (e) {
    $("#signin-error").textContent = String(e);
  } finally {
    btn.disabled = false;
  }
});

// ---- ⌘K command palette ----

type Command = { label: string; icon: string; key?: string; group: string; run: () => void };

const paletteEl = $<HTMLDialogElement>("#palette");
const paletteInput = paletteEl.querySelector("input")!;
const paletteList = $("#palette-list");
let paletteItems: Command[] = [];
let paletteIndex = 0;

function paletteCommands(): Command[] {
  const k = (a: string) => keyLabel(a);
  const thread = threads.find((t) => t.id === selected);
  const email: Command[] = thread
    ? [
        { label: "Archive", icon: "archive", key: k("archive"), group: "Email", run: () => act("archive") },
        { label: "Delete", icon: "trash", key: k("trash"), group: "Email", run: () => act("trash") },
        {
          label: thread.unread ? "Mark as read" : "Mark as unread",
          icon: "envelope-simple",
          key: k("unread"),
          group: "Email",
          run: () => act("unread"),
        },
        {
          label: thread.starred ? "Unpin" : "Pin",
          icon: "push-pin",
          key: k("star"),
          group: "Email",
          run: () => act("star"),
        },
        { label: "Reply", icon: "arrow-bend-up-left", key: k("reply"), group: "Email", run: () => act("reply") },
        {
          label: "Reply all",
          icon: "arrow-bend-double-up-left",
          key: k("replyAll"),
          group: "Email",
          run: () => act("replyAll"),
        },
        { label: "Forward", icon: "arrow-bend-up-right", key: k("forward"), group: "Email", run: () => act("forward") },
        { label: "Move to…", icon: "folder", key: k("move"), group: "Email", run: () => act("move") },
        { label: "Label…", icon: "tag", key: k("label"), group: "Email", run: () => act("label") },
        { label: "Mark as spam", icon: "warning-octagon", key: k("spam"), group: "Email", run: () => act("spam") },
      ]
    : [];
  const switchTo: Command[] = multi()
    ? [null, ...accounts].map(
        (a): Command => ({
          label: a ? `Switch to ${accountName(a)}` : "Switch to All accounts",
          icon: "user-circle",
          group: "Accounts",
          run: () => setScope(a ? [a] : null),
        }),
      )
    : [];
  const go: Command[] = [
    ...SYSTEM.map(
      ([id, name, icon]): Command => ({ label: `Go to ${name}`, icon, group: "Go to", run: () => openMailbox(id) }),
    ),
    ...userLabels.map(
      (l): Command => ({ label: `Go to ${l.name}`, icon: "tag", group: "Go to", run: () => openMailbox(l.id) }),
    ),
  ];
  const sections: [string, string, string][] = [
    ["general", "General", "gear-six"],
    ["appearance", "Appearance", "palette"],
    ["accounts", "Accounts", "user-circle"],
    ["ai", "AI", "message-ai"],
    ["inbox", "Inbox", "tray"],
    ["composer", "Composer", "pencil-simple-line"],
    ["accessibility", "Accessibility", "text-aa"],
    ["swipes", "Swipes", "hand-swipe-left"],
    ["shortcuts", "Keyboard shortcuts", "keyboard"],
  ];
  return [
    ...email,
    {
      label: "New email",
      icon: "pencil-simple-line",
      key: k("compose"),
      group: "Mail",
      run: () => $("#compose-btn").click(),
    },
    { label: "Check for mail", icon: "arrows-clockwise", key: k("sync"), group: "Mail", run: () => invoke("sync_now") },
    { label: "Clean up Inbox with AI", icon: "message-ai", group: "Mail", run: () => void openCleanup() },
    {
      label: settings.inbox.view === "smart" ? "Switch to plain list" : "Switch to Smart Inbox",
      icon: "stack",
      group: "Mail",
      run: () => $("#view-btn").click(),
    },
    ...go,
    ...switchTo,
    { label: "Add a Google account", icon: "user-plus", group: "Accounts", run: () => addAccount() },
    { label: "Add another email account", icon: "user-plus", group: "Accounts", run: () => void addOtherAccount() },
    ...sections.map(
      ([id, name, icon]): Command => ({
        label: `Settings: ${name}`,
        icon,
        group: "Settings",
        run: () => openSettings(id),
      }),
    ),
    {
      label: "Use light appearance",
      icon: "sun",
      group: "Appearance",
      run: () => setSetting("appearance.theme", "light"),
    },
    {
      label: "Use dark appearance",
      icon: "moon",
      group: "Appearance",
      run: () => setSetting("appearance.theme", "dark"),
    },
    {
      label: "Match system appearance",
      icon: "desktop",
      group: "Appearance",
      run: () => setSetting("appearance.theme", "system"),
    },
    { label: "Zoom in", icon: "magnifying-glass-plus", key: k("zoomIn"), group: "Appearance", run: () => stepZoom(1) },
    {
      label: "Zoom out",
      icon: "magnifying-glass-minus",
      key: k("zoomOut"),
      group: "Appearance",
      run: () => stepZoom(-1),
    },
    {
      label: "Actual size",
      icon: "magnifying-glass",
      key: k("zoomReset"),
      group: "Appearance",
      run: () => stepZoom(0),
    },
  ];
}

function renderPalette() {
  const q = paletteInput.value.trim();
  const found = rank(paletteCommands(), q);
  // Typing always offers a mail search too, after the matching commands.
  if (q)
    found.push({ label: `Search mail for “${q}”`, icon: "magnifying-glass", group: "Search", run: () => searchFor(q) });
  paletteItems = found;
  paletteIndex = Math.min(paletteIndex, Math.max(found.length - 1, 0));
  let lastGroup = "";
  paletteList.innerHTML = found.length
    ? found
        .map((c, i) => {
          const head =
            !q && c.group !== lastGroup ? `<li class="palette-group" role="presentation">${esc(c.group)}</li>` : "";
          lastGroup = c.group;
          return `${head}<li role="option" id="pc-${i}" data-i="${i}" aria-selected="${i === paletteIndex}" class="${i === paletteIndex ? "on" : ""}">
          ${iconHtml(c.icon)}<span>${esc(c.label)}</span>${c.key ? `<kbd>${esc(c.key)}</kbd>` : ""}</li>`;
        })
        .join("")
    : `<li class="palette-empty">No matching commands</li>`;
  paletteInput.setAttribute("aria-activedescendant", `pc-${paletteIndex}`);
  paletteList.querySelector(".on")?.scrollIntoView({ block: "nearest" });
}

function openPalette() {
  if (paletteEl.open) return;
  closeMenu();
  paletteInput.value = "";
  paletteIndex = 0;
  renderPalette();
  paletteEl.showModal();
  paletteInput.focus();
}

function runPaletteItem(i: number) {
  const c = paletteItems[i];
  if (!c) return;
  paletteEl.close();
  c.run();
}

/** Runs a search as if typed into the search field and submitted. */
function searchFor(q: string) {
  const input = visibleSearch();
  input.value = q;
  input.closest("form")!.requestSubmit();
}

paletteInput.addEventListener("input", () => {
  paletteIndex = 0;
  renderPalette();
});
paletteInput.addEventListener("keydown", (e) => {
  const combo = comboOf(e);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const n = paletteItems.length;
    if (n) paletteIndex = (paletteIndex + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
    renderPalette();
  } else if (e.key === "Enter") {
    e.preventDefault();
    runPaletteItem(paletteIndex);
  } else if (bindings[combo] === "palette") {
    e.preventDefault();
    paletteEl.close();
  }
});
paletteList.addEventListener("click", (e) => {
  const li = (e.target as Element).closest<HTMLElement>("[data-i]");
  if (li) runPaletteItem(Number(li.dataset.i));
});
paletteList.addEventListener("pointermove", (e) => {
  const li = (e.target as Element).closest<HTMLElement>("[data-i]");
  if (!li || Number(li.dataset.i) === paletteIndex) return;
  paletteIndex = Number(li.dataset.i);
  paletteList.querySelector(".on")?.classList.remove("on");
  li.classList.add("on");
});
// Clicking the dimmed backdrop lands on the <dialog> itself.
paletteEl.addEventListener("click", (e) => e.target === paletteEl && paletteEl.close());

let bindings = bindingsFrom({});

document.addEventListener("keydown", (e) => {
  if (app.hidden || askOpen() || paletteEl.open || ($("#cleanup") as HTMLDialogElement).open) return;
  const combo = comboOf(e);
  if (settingsOpen()) {
    const a = bindings[combo];
    if (e.key === "Escape" || a === "settings") {
      e.preventDefault();
      closeSettings();
    } else if (a?.startsWith("zoom")) {
      e.preventDefault();
      stepZoom(a === "zoomIn" ? 1 : a === "zoomOut" ? -1 : 0);
    }
    return;
  }
  // Writing an email (window or inline reply): only send and Escape act, everything else is typing. A docked window
  // leaves the app's shortcuts working while focus is outside it.
  if ((composer.open && !composer.classList.contains("docked")) || composeForm.contains(document.activeElement)) {
    if (SEND.has(combo)) {
      e.preventDefault();
      composeForm.requestSubmit();
    } else if (e.key === "Escape") {
      // Handled on keydown so the window's own Escape (cancel) never fires: WebKit closes a dialog outright on a second
      // cancelled Escape in a row.
      e.preventDefault();
      void escapeComposer();
    }
    return;
  }
  let action = bindings[combo];
  // "Default reply" in Settings swaps what the reply keys do; the buttons keep their literal meaning.
  if (settings.composer.defaultReply === "all" && (action === "reply" || action === "replyAll")) {
    action = action === "reply" ? "replyAll" : "reply";
  }
  // In the search field only ⌘ shortcuts act, so typing (and Backspace) stays text editing.
  if ((e.target as Element).closest("input, textarea, [contenteditable]")) {
    if (e.key === "Escape") (e.target as HTMLElement).blur();
    // ⌘Z and ⌘A there undo and select typing, not the last archive or the list.
    if (!combo.includes("cmd+") || action === "undo" || action === "selectAll") return;
  }
  if (!action) return;
  e.preventDefault();
  const i = threads.findIndex((t) => t.id === selected);
  const go = (n: number) => threads[n] && openThread(threads[n].id);
  switch (action) {
    case "compose":
      return $("#compose-btn").click();
    case "search":
      visibleSearch().focus();
      return visibleSearch().select();
    case "sync":
      return invoke("sync_now");
    case "next":
      go(i + 1);
      break;
    case "prev":
      go(Math.max(i - 1, 0));
      break;
    case "escape":
      if (!menu.hidden) return closeMenu();
      if (multiPicked()) return clearPicked();
      return setView("list");
    case "settings":
      return openSettings();
    case "palette":
      return openPalette();
    case "zoomIn":
      return stepZoom(1);
    case "zoomOut":
      return stepZoom(-1);
    case "zoomReset":
      return stepZoom(0);
    case "undo":
      return undo();
    case "selectAll":
      return selectAll();
    default:
      act(action);
  }
  threadList.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
});

// Message list width: drag the divider (or use arrow keys on it); double-click resets. Remembered per device.
const LIST_MIN = 280;
const LIST_MAX = 720;
const resizer = $("#resizer");
function setListWidth(px: number) {
  const w = Math.round(Math.min(LIST_MAX, Math.max(LIST_MIN, px)));
  app.style.setProperty("--list-width", `${w}px`);
  resizer.setAttribute("aria-valuenow", String(w));
  try {
    localStorage.setItem("listWidth", String(w));
  } catch {}
}
try {
  const saved = Number(localStorage.getItem("listWidth"));
  if (saved) setListWidth(saved);
} catch {}
resizer.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  resizer.setPointerCapture(e.pointerId);
  resizer.classList.add("dragging");
  document.body.classList.add("resizing");
  const left = $(".list-pane").getBoundingClientRect().left;
  const move = (ev: PointerEvent) => setListWidth(ev.clientX - left);
  const stop = () => {
    resizer.removeEventListener("pointermove", move);
    resizer.classList.remove("dragging");
    document.body.classList.remove("resizing");
  };
  resizer.addEventListener("pointermove", move);
  resizer.addEventListener("pointerup", stop, { once: true });
  resizer.addEventListener("pointercancel", stop, { once: true });
});
resizer.addEventListener("dblclick", () => setListWidth(360));
resizer.addEventListener("keydown", (e) => {
  const step = e.shiftKey ? 40 : 10;
  const current = $(".list-pane").getBoundingClientRect().width;
  if (e.key === "ArrowLeft") setListWidth(current - step);
  else if (e.key === "ArrowRight") setListWidth(current + step);
  else return;
  e.preventDefault();
  e.stopPropagation();
});

// Custom tooltips: WKWebView doesn't show native `title` tooltips. `data-tip="Archive (e)"` renders as "Archive" plus an "E" key chip.
const tooltip = $("#tooltip");
let tipTimer = 0;
let tipTarget: HTMLElement | null = null;
let tipHiddenAt = 0;
// A popover, so it opens in the top layer above any open modal (composer, settings, sheets).
const tipOpen = () => tooltip.matches(":popover-open");
function hideTip() {
  clearTimeout(tipTimer);
  if (tipOpen()) {
    tipHiddenAt = Date.now();
    tooltip.hidePopover();
  }
  tipTarget = null;
}
document.addEventListener("pointerover", (e) => {
  const el = (e.target as Element).closest<HTMLElement>("[data-tip]");
  if (el === tipTarget) return;
  hideTip();
  if (!el || !menu.hidden) return;
  tipTarget = el;
  // A visible tooltip is already "warm", so moving along a toolbar switches instantly.
  tipTimer = window.setTimeout(
    () => {
      const [, label, key] = el.dataset.tip!.match(/^(.*?)(?: \((.+)\))?$/)!;
      tooltip.innerHTML = esc(label) + (key ? ` <kbd>${esc(key.toUpperCase())}</kbd>` : "");
      tooltip.showPopover();
      const r = el.getBoundingClientRect();
      const below = r.bottom + 8 + tooltip.offsetHeight < window.innerHeight;
      tooltip.style.top = `${below ? r.bottom + 8 : r.top - 8 - tooltip.offsetHeight}px`;
      tooltip.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - tooltip.offsetWidth / 2, window.innerWidth - tooltip.offsetWidth - 8))}px`;
    },
    Date.now() - tipHiddenAt < 300 ? 0 : 450,
  );
});
document.addEventListener("pointerdown", hideTip);
document.addEventListener("keydown", hideTip);
document.querySelectorAll<HTMLElement>("[data-tip]").forEach((el) => {
  if (!el.hasAttribute("aria-label")) el.setAttribute("aria-label", el.dataset.tip!.replace(/ \(.+\)$/, ""));
});

// Tooltips show each button's current first key, so remapped shortcuts stay truthful.
const TIP_ACTIONS: Record<string, string> = {
  "compose-btn": "compose",
  "sync-btn": "sync",
  "settings-btn": "settings",
};
$("#palette-hint").addEventListener("click", () => openPalette());

function updateShortcutTips() {
  // The command palette's key, shown inside the search bar.
  const palette = keyLabel("palette");
  $("#palette-hint").hidden = !palette;
  $("#palette-hint kbd").textContent = palette ?? "";
  document.querySelectorAll<HTMLElement>("[data-tip]").forEach((el) => {
    const action = el.dataset.action ?? TIP_ACTIONS[el.id];
    if (!action) return;
    el.dataset.label ??= el.dataset.tip!.replace(/ \(.+\)$/, "");
    const key = keyLabel(action);
    el.dataset.tip = key ? `${el.dataset.label} (${key})` : el.dataset.label;
  });
}

/** Sidebar footer: the accounts being shown, which opens the account picker when there are several. */
function renderAccountFooter() {
  const one = scope?.length === 1 ? scope[0] : !multi() ? accounts[0] : null;
  $("#account-email").textContent = one
    ? accountName(one)
    : scope
      ? `${scope.length} accounts`
      : `All accounts (${accounts.length})`;
  $("#account-dot").className = `account-dot ${one ? `acct-${accountSettings(one).color}` : ""}`;
  $("#account-dot").hidden = !one;
  $("#account-all").hidden = !!one;
  $<HTMLButtonElement>("#account-btn").disabled = !multi();
  // Next to the list title: a dot per account, to show just that one (click it again for all).
  const only = scope?.length === 1 ? scope[0] : null;
  const dots = $("#acct-dots");
  dots.hidden = !multi();
  dots.classList.toggle("filtered", !!only);
  dots.innerHTML = accounts
    .map((a) => {
      const label = only === a ? "Show all accounts" : `Show only ${accountName(a)}`;
      return `<button type="button" class="acct-pick${only === a ? " on" : ""}" data-acct="${esc(a)}" data-tip="${esc(label)}" aria-label="${esc(label)}" aria-pressed="${only === a}"><span class="account-dot acct-${accountSettings(a).color}"></span></button>`;
    })
    .join("");
}
$("#acct-dots").addEventListener("click", (e) => {
  const a = (e.target as Element).closest<HTMLElement>("[data-acct]")?.dataset.acct;
  if (a) setScope(scope?.length === 1 && scope[0] === a ? null : [a]);
});

/** Multi-select account picker above the sidebar footer; stays open while ticking accounts. */
function openAccountMenu() {
  const btn = $("#account-btn");
  const shown = scope ?? accounts.filter((a) => accountSettings(a).unified !== false);
  const items: MenuItem[] = [
    { id: "", label: "All accounts", icon: "users", checked: !scope },
    "-",
    ...accounts.map((a) => ({
      id: a,
      label: accountName(a),
      icon: "",
      acct: accountSettings(a).color,
      checked: shown.includes(a),
    })),
  ];
  const r = btn.getBoundingClientRect();
  showMenu(null, items, { x: r.left, y: r.top }, (id) => {
    if (!id) setScope(null);
    // From "All accounts", or with just two, clicking an account shows only that one.
    else if (!scope || accounts.length === 2) setScope([id]);
    else {
      const next = shown.includes(id) ? shown.filter((a) => a !== id) : [...shown, id];
      // At least one account stays ticked.
      if (next.length) setScope(next);
    }
    openAccountMenu();
    return true;
  });
  menu.style.top = `${Math.max(8, r.top - menu.offsetHeight - 6)}px`;
  menuAnchor = btn;
}

$("#account-btn").addEventListener("click", () =>
  menuAnchor === $("#account-btn") && !menu.hidden ? closeMenu() : openAccountMenu(),
);

onSettingsChange((path) => {
  applyVisualSettings();
  if (accounts.length) renderAccountFooter();
  bindings = bindingsFrom(settings.shortcuts);
  renderViewButton();
  updateShortcutTips();
  if (!app.hidden && (path === "*" || path.startsWith("inbox.") || path === "accounts")) refresh();
  else if (!app.hidden && path.startsWith("sidebar.")) void renderMailboxes();
});

function start(list: string[]) {
  accounts = list;
  // New accounts take the next unused colour in Shift's order, like the native app.
  for (const a of accounts) {
    if (settings.accounts[a]?.color) continue;
    const used = accounts.map((x) => settings.accounts[x]?.color).filter(Boolean);
    setAccountSetting(a, "color", ACCOUNT_COLOR_ORDER.find((c) => !used.includes(c)) ?? ACCOUNT_COLOR_ORDER[0]);
  }
  scope = scope?.filter((a) => accounts.includes(a)) ?? null;
  if (!scope?.length) scope = null;
  renderAccountFooter();
  $("#signin").hidden = true;
  app.hidden = false;
  clearReader();
  refresh();
  // Adding an account from inside the walkthrough calls start() again; the open walkthrough carries on.
  if (onboardingDue() && $("#onboarding").hidden) startOnboarding({ accounts: () => accounts, addAccount, keyLabel });
}

listen("mail-changed", refresh);
// Counted, since a manual sync can overlap the timed one.
let syncs = 0;
listen<boolean>("syncing", (e) =>
  $("#sync-btn").classList.toggle("spinning", (syncs = Math.max(0, syncs + (e.payload ? 1 : -1))) > 0),
);
// Undo send and Send later both go out through the scheduled queue.
listen("scheduled-sent", () => toast("Email sent", { kind: "success" }));
// A clicked new-mail notification: its email (or, for several, the Inbox), in a view that includes its account.
listen<{ account?: string; thread?: string }>("open-from-notification", async ({ payload }) => {
  if (settingsOpen()) closeSettings();
  if (payload.account && scope && !scope.includes(payload.account)) setScope(null);
  if (mailbox !== "INBOX" || search) openMailbox("INBOX");
  await loadThreads();
  if (payload.thread && threads.some((t) => t.id === payload.thread)) await openThread(payload.thread);
});
// Messages from the backend, such as the outcome of Shift → Check for Updates….
listen<string>("app-toast", (e) => toast(e.payload));
// Shift → Settings… (⌘,) in the menu bar.
listen("open-settings", () => openSettings());
/** Saves an open draft before Shift quits or restarts, so the last few seconds of typing aren't lost. */
const saveBeforeQuit = async () => {
  await flushSettings();
  const state = compose;
  if (!state || !hasContent()) return;
  const payload = currentDraft(state);
  const fields = currentFields();
  // A scheduled email open for editing goes back on its schedule, as closing the composer would.
  if ((await saveDraft(state, payload)) && state.resumeAt && state.resumeAt > Date.now()) {
    await resumeSchedule(state, payload, fields).catch(() => {});
  }
};
onSaveError((err) => toast(`Couldn't save your settings: ${err}`, { kind: "error" }));
// ⌘Q: the backend waits (up to 5 s) for this before quitting.
listen("before-quit", () => void saveBeforeQuit().finally(() => invoke("quit_now")));
listen<string>("update-ready", (e) =>
  toast(`Shift ${e.payload} is ready`, {
    ms: 10 * 60_000,
    action: { label: "Restart", run: () => void saveBeforeQuit().finally(() => invoke("restart_app")) },
  }),
);
// Shown once per distinct error every 10 minutes (sync retries every tick), and never over an Undo or Restart toast.
const syncErrorShown = new Map<string, number>();
listen<string>("sync-error", (e) => {
  const now = Date.now();
  if (now - (syncErrorShown.get(e.payload) ?? 0) < 10 * 60_000) return;
  if (actionToastOpen()) return;
  syncErrorShown.set(e.payload, now);
  toast(`Sync failed: ${e.payload}`, { kind: "error" });
});

loadSettings()
  .then(loadStatus)
  .then((s) => {
    if (s.accounts.length) start(s.accounts);
    else $("#signin").hidden = false;
    if (s.broken.length) {
      void ask({
        title: "Some mail couldn't be opened",
        message: `The mail Shift stored for ${s.broken.join(", ")} is damaged, so that account was left out. Add it again in Settings → Accounts to download its mail afresh. The mail itself isn't affected.`,
        confirm: "OK",
      });
    }
  });

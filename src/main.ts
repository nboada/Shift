import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SEND, bindingsFrom, comboOf, formatCombo, keysFor } from "./keys";
import {
  ACCOUNT_COLOR_ORDER, accountSettings, applyVisualSettings, loadSettings, onSettingsChange, setAccountSetting, setSetting, settings, stepZoom,
} from "./settings";
import { closeSettings, initSettings, openSettings, renderSignaturePreview, settingsOpen } from "./settings-ui";
import { withHtmlSignature } from "./compose";
import { ask, askOpen } from "./dialog";
import { Recipients, isValidAddress, splitList } from "./recipients";
import { rank } from "./palette-match";
import { type Attachment, type OutFile, attachmentButton, checkSize, fileIcon, listedAttachments, readFile } from "./attachments";

type Label = { id: string; name: string; kind: string; unread: number };
type Thread = {
  id: string; subject: string; sender: string; snippet: string;
  date: number; count: number; unread: boolean; starred: boolean; primary: boolean; labels: string;
  /** Address of the account the thread belongs to. */
  account: string;
};
type Message = {
  id: string; sender: string; recipients: string; cc: string; date: number; subject: string;
  message_id: string; refs: string; html: string | null; text: string | null; attachments: Attachment[];
};

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const app = $("#app");
const threadList = $("#threads");
const reader = $("#reader");
const searchInputs = [...document.querySelectorAll<HTMLInputElement>(".search input")];
// Desktop shows the top-right field, phones the one above the list; use whichever is on screen.
const visibleSearch = () => searchInputs.find((i) => i.offsetParent !== null) ?? searchInputs[0];
let userLabels: Label[] = [];
const composer = $<HTMLDialogElement>("#composer");
const composeForm = $<HTMLFormElement>("#compose-form");

const SYSTEM: [string | null, string, string][] = [
  ["INBOX", "Inbox", "tray"],
  ["STARRED", "Starred", "star"],
  ["IMPORTANT", "Important", "bookmark-simple"],
  ["SENT", "Sent", "paper-plane-tilt"],
  ["DRAFT", "Drafts", "file"],
  ["ARCHIVE", "Archive", "archive"],
  [null, "All Mail", "tray-arrow-down"],
  ["SPAM", "Spam", "warning-octagon"],
  ["TRASH", "Trash", "trash"],
];

/** Signed-in Google accounts, oldest first. */
let accounts: string[] = [];
/** Which accounts the sidebar and list show; null is "All accounts". */
let scope: string[] | null = null;
const multi = () => accounts.length > 1;
/** The account new emails come from: the one being viewed, else the first. */
const defaultAccount = () => scope?.[0] ?? accounts[0];
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
  return d.toLocaleDateString([], { month: "long", ...(d.getFullYear() === day.getFullYear() ? {} : { year: "numeric" }) });
}

let toastTimer = 0;
function toast(msg: string) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 4000);
}

/** Toast with one button (e.g. Undo); the button works until the toast hides. */
function toastAction(msg: string, label: string, onClick: () => void, ms: number) {
  const t = $("#toast");
  t.innerHTML = `<span>${esc(msg)}</span><button type="button">${esc(label)}</button>`;
  t.querySelector("button")!.onclick = () => {
    t.hidden = true;
    onClick();
  };
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), ms);
}

const setView = (v: "mailboxes" | "list" | "reader") => (app.dataset.view = v);

// Dev builds surface uncaught errors on screen, since the webview console isn't visible.
if (import.meta.env.DEV) {
  window.addEventListener("error", (e) => toast(`Error: ${e.message}`));
  window.addEventListener("unhandledrejection", (e) => toast(`Error: ${e.reason}`));
}

/** The first key bound to an action, formatted for display ("⇧R"), if it has one. */
const keyLabel = (action: string) => {
  const k = keysFor(settings.shortcuts)[action]?.[0];
  return k ? formatCombo(k) : undefined;
};

async function renderMailboxes() {
  const labels = await invoke<Label[]>("labels", { accounts: scope });
  userLabels = labels.filter((l) => l.kind === "user");
  const unread = new Map(labels.map((l) => [l.id, l.unread]));
  const link = (id: string | null, name: string, icon: string, count = 0) =>
    `<a href="#" data-mailbox="${id ?? ""}" class="${!search && id === mailbox ? "active" : ""}" ${!search && id === mailbox ? 'aria-current="page"' : ""}>
      ${icon ? `<i class="ph ph-${icon}"></i>` : `<span class="label-dot l${hash(name) % 8}"></span>`}<span>${esc(name)}</span>${count ? `<small>${count}</small>` : ""}</a>`;
  const badge = settings.inbox.unreadBadge;
  const system = SYSTEM.map(([id, name, icon]) => link(id, name, icon, badge && id === "INBOX" ? unread.get(id) : 0));
  const user = labels.filter((l) => l.kind === "user").map((l) => link(l.id, l.name, "", badge ? l.unread : 0));
  $("#mailboxes").innerHTML = system.join("") + (user.length ? `<h3>Labels</h3>${user.join("")}` : "");
}

function listTitle() {
  if (search) return `Search: ${search}`;
  return SYSTEM.find(([id]) => id === mailbox)?.[1] ?? document.querySelector(`[data-mailbox="${mailbox}"] span`)?.textContent ?? "";
}

const PERSONAL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "icloud.com", "me.com",
  "mac.com", "yahoo.com", "aol.com", "proton.me", "protonmail.com", "fastmail.com", "bigpond.com",
]);

// shortcut: approximates the registrable domain (handles com.au/co.uk style suffixes); swap in a public-suffix list if logos misfire.
function siteDomain(domain: string) {
  const parts = domain.split(".");
  const n = parts.length > 2 && parts.at(-1)!.length === 2 && /^(com|co|org|net|gov|edu|ac)$/.test(parts.at(-2)!) ? 3 : 2;
  return parts.slice(-n).join(".");
}

/** Company logo for work domains, coloured initials otherwise (and whenever the logo is missing). */
function avatar(addr: string) {
  const email = bareEmail(addr);
  const name = displayName(addr) || email;
  const initials = name.split(/[\s.@_-]+/).filter((w) => /\w/.test(w)).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
  const color = hash(email) % 8;
  const domain = email.split("@")[1] ?? "";
  const logo = domain && !PERSONAL_DOMAINS.has(domain)
    ? `<img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(siteDomain(domain))}&sz=64" alt="" loading="lazy">`
    : "";
  return `<span class="avatar c${color}">${esc(initials)}${logo}</span>`;
}

// Google answers unknown domains with a 16px globe, so anything that small falls back to initials.
document.addEventListener("load", (e) => {
  const img = e.target;
  if (img instanceof HTMLImageElement && img.parentElement?.classList.contains("avatar") && img.naturalWidth < 32) img.remove();
}, true);
document.addEventListener("error", (e) => {
  const img = e.target;
  if (img instanceof HTMLImageElement && img.parentElement?.classList.contains("avatar")) img.remove();
}, true);

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

// "smart" groups the Inbox into Pinned/People/Notifications/Seen; "list" is plain newest-first.
const smartInbox = () => settings.inbox.view === "smart" && mailbox === "INBOX" && !search;

function renderViewButton() {
  const btn = $("#view-btn");
  const smart = settings.inbox.view === "smart";
  btn.dataset.tip = smart ? "Switch to plain list" : "Switch to Smart Inbox";
  btn.setAttribute("aria-label", btn.dataset.tip);
  btn.querySelector("i")!.className = `ph ${smart ? "ph-stack" : "ph-list"}`;
}

function threadRow(t: Thread) {
  return `<li data-id="${t.id}" role="option" aria-selected="${t.id === selected}" aria-label="${esc(`${t.unread ? "Unread, " : ""}${displayName(t.sender)}, ${t.subject || "(no subject)"}`)}" class="${t.unread ? "unread" : ""} ${t.id === selected ? "selected" : ""}">
        <span class="dot"></span>
        <span class="avatar-ring${multi() ? ` acct-${accountSettings(t.account).color}` : ""}" ${multi() ? `data-tip="${esc(accountName(t.account))}"` : ""}>${avatar(t.sender)}</span>
        <span class="from">${esc(displayName(t.sender) || "(no sender)")}${t.count > 1 ? `<em>${t.count}</em>` : ""}${t.starred ? '<i class="ph-fill ph-push-pin pin"></i>' : ""}</span>
        <span class="date">${shortDate(t.date)}</span>
        <span class="subject">${esc(t.subject || "(no subject)")}</span>
        <span class="snippet">${esc(decodeEntities(t.snippet))}</span>
      </li>`;
}

function renderThreads() {
  $("#list-title").textContent = listTitle();
  if (!threads.length) {
    threadList.innerHTML = `<li class="empty">${search ? "No results" : "No messages"}</li>`;
    return;
  }
  if (!smartInbox()) {
    let last = "";
    threadList.innerHTML = threads.map((t) => {
      const group = search ? "" : dateGroup(t.date);
      const head = group !== last ? `<li class="section">${group}</li>` : "";
      last = group;
      return head + threadRow(t);
    }).join("");
    return;
  }
  threadList.innerHTML = SECTIONS.map(([key, title, icon]) => {
    const rows = threads.filter((t) => sectionOf(t) === key);
    return rows.length ? `<li class="section"><i class="ph ph-${icon}"></i>${title}</li>${rows.map(threadRow).join("")}` : "";
  }).join("");
}

/** Smart Inbox order (pinned, unread people, unread notifications, seen) so j/k follows what's on screen. */
function sortForInbox(list: Thread[]) {
  const rank = (t: Thread) => SECTIONS.findIndex(([key]) => key === sectionOf(t));
  return smartInbox() ? [...list].sort((a, b) => rank(a) - rank(b) || b.date - a.date) : list;
}

// Gmail snippets arrive HTML-escaped.
function decodeEntities(s: string) {
  const t = document.createElement("textarea");
  t.innerHTML = s;
  return t.value;
}

async function loadThreads() {
  threads = sortForInbox(
    search
      ? await invoke<Thread[]>("search", { query: search, accounts: scope })
      : await invoke<Thread[]>("threads", { label: mailbox, accounts: scope }),
  );
  renderThreads();
}

let refreshQueued = false;
function refresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  // A microtask, not requestAnimationFrame: rAF is paused while the window is hidden, which left the list empty
  // when Shift started or reloaded in the background.
  queueMicrotask(async () => {
    refreshQueued = false;
    await renderMailboxes();
    if (!search) await loadThreads();
  });
}

const EMAIL_CSS = `<style>
  body { margin: 0; padding: 16px; font: 14px/1.5 -apple-system, system-ui, sans-serif; color: #1d1d1f; overflow-wrap: anywhere; }
  img { max-width: 100%; height: auto; }
  blockquote { margin-left: 0; padding-left: 12px; border-left: 3px solid #ddd; color: #555; }
</style>`;

function mountEmail(frame: HTMLIFrameElement, html: string) {
  // No allow-scripts: email markup can never run code. allow-same-origin lets us size the frame and catch link clicks.
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.srcdoc = EMAIL_CSS + html;
  frame.addEventListener("load", () => {
    const doc = frame.contentDocument!;
    const fit = () => (frame.style.height = `${doc.documentElement.scrollHeight}px`);
    fit();
    new ResizeObserver(fit).observe(doc.body);
    doc.addEventListener("click", (e) => {
      const a = (e.target as Element).closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      e.preventDefault();
      if (/^(https?|mailto):/i.test(a.href)) openUrl(a.href);
    });
  });
}

async function openThread(id: string) {
  if (compose?.inline) closeComposer();
  selected = id;
  app.dataset.open = "";
  renderThreads();
  setView("reader");
  const thread = threads.find((t) => t.id === id);
  try {
    messages = await invoke<Message[]>("thread", { account: thread?.account ?? defaultAccount(), id });
  } catch (e) {
    reader.innerHTML = `<div class="placeholder">${esc(String(e))}</div>`;
    return;
  }
  if (selected !== id) return;
  reader.innerHTML = `<h1>${esc(messages[0]?.subject || thread?.subject || "(no subject)")}</h1>`;
  for (const m of messages) {
    const el = document.createElement("section");
    el.className = "message";
    const name = displayName(m.sender);
    el.innerHTML = `<header>
        ${avatar(m.sender)}
        <div class="meta"><strong>${esc(name)}</strong><span>To: ${esc(m.recipients)}${m.cc ? `, Cc: ${esc(m.cc)}` : ""}</span></div>
        <time>${new Date(m.date).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</time>
      </header>`;
    const account = thread?.account ?? defaultAccount();
    if (m.html) {
      const frame = document.createElement("iframe");
      el.append(frame);
      reader.append(el);
      mountEmail(frame, m.html);
      showInlineImages(frame, m, account);
    } else {
      const text = document.createElement("div");
      text.className = "text";
      text.textContent = m.text ?? "";
      el.append(text);
      reader.append(el);
    }
    el.insertAdjacentHTML("beforeend", attachmentStrip(m, account));
  }
  reader.scrollTop = 0;
  if (thread?.unread && settings.general.markReadOnOpen) {
    keptUnread.add(id);
    modify(id, [], ["UNREAD"]);
  }
}

// ---- Attachments in the reader

function attachmentStrip(m: Message, account: string) {
  const files = listedAttachments(m.attachments, m.html);
  if (!files.length) return "";
  return `<div class="attachments message-files">${files
    .map((a) => attachmentButton(fileIcon(a.mime, a.filename), a.filename || "attachment", a.size, { account, message: m.id, idx: a.idx }))
    .join("")}</div>`;
}

/** Swaps `cid:` image sources for the attachment's bytes once the email has loaded. */
function showInlineImages(frame: HTMLIFrameElement, m: Message, account: string) {
  const inline = m.attachments.filter((a) => a.content_id);
  if (!inline.length) return;
  frame.addEventListener("load", () => {
    for (const img of frame.contentDocument!.querySelectorAll<HTMLImageElement>('img[src^="cid:" i]')) {
      const a = inline.find((a) => a.content_id === decodeURIComponent(img.getAttribute("src")!.slice(4)));
      if (!a) continue;
      invoke<string>("attachment_data", { account, message: m.id, idx: a.idx })
        .then((data) => (img.src = `data:${a.mime};base64,${data}`))
        .catch(() => {});
    }
  }, { once: true });
}

reader.addEventListener("click", async (e) => {
  const el = (e.target as Element).closest<HTMLElement>(".message-files .attachment");
  if (!el) return;
  const { account, message, idx } = el.dataset;
  try {
    const path = await invoke<string>("open_attachment", { account, message, idx: Number(idx) });
    toast(`Saved to ${path.split("/").slice(-2).join("/")}`);
  } catch (err) {
    toast(String(err));
  }
});

function clearReader() {
  if (compose?.inline) closeComposer();
  selected = null;
  delete app.dataset.open;
  messages = [];
  reader.innerHTML = `<div class="placeholder empty-reader"><i class="ph-bold ph-caret-up"></i><span>No email selected</span></div>`;
}

async function modify(id: string, add: string[], remove: string[], trash = false) {
  const t = threads.find((t) => t.id === id);
  if (t) {
    if (add.includes("UNREAD")) t.unread = true;
    if (remove.includes("UNREAD")) t.unread = false;
    if (add.includes("STARRED")) t.starred = true;
    if (remove.includes("STARRED")) t.starred = false;
  }
  renderThreads();
  try {
    await invoke("modify", { account: t?.account ?? defaultAccount(), id, add, remove, trash });
  } catch (e) {
    toast(`Couldn't update message: ${e}`);
  }
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
  const t = threads.find((t) => t.id === id);
  if (!t) return;
  // Replies need the thread's messages, so open it first.
  if (["reply", "replyAll", "forward"].includes(action) && t.id !== selected) {
    openThread(t.id).then(() => act(action, t.id));
    return;
  }
  switch (action) {
    case "archive":
      removeAndAdvance(t.id);
      return modify(t.id, [], ["INBOX"]);
    case "trash":
      if (settings.general.confirmDelete) {
        ask({ title: "Delete this email?", message: `“${t.subject || "(no subject)"}” will move to Trash.`, confirm: "Delete", danger: true })
          .then((yes) => yes && act("trashNow", t.id));
        return;
      }
      removeAndAdvance(t.id);
      return modify(t.id, ["TRASH"], ["INBOX"], true);
    case "trashNow":
      removeAndAdvance(t.id);
      return modify(t.id, ["TRASH"], ["INBOX"], true);
    case "unread":
      return modify(t.id, t.unread ? [] : ["UNREAD"], t.unread ? ["UNREAD"] : []);
    case "star":
      return modify(t.id, t.starred ? [] : ["STARRED"], t.starred ? ["STARRED"] : []);
    case "spam":
      removeAndAdvance(t.id);
      return modify(t.id, ["SPAM"], ["INBOX"]);
    case "reply":
      return reply("reply");
    case "replyAll":
      return reply("all");
    case "forward":
      return reply("forward");
    case "move":
      return openMenu("move", t);
    case "label":
      return openMenu("label", t);
  }
}

const menu = $("#menu");
let menuAnchor: Element | null = null;
let menuPos = { x: 0, y: 0 };

type MenuItem = { id: string; label: string; icon: string; key?: string; disabled?: boolean; danger?: boolean; acct?: string } | "-";

function closeMenu() {
  menu.hidden = true;
  menuAnchor = null;
  threadList.querySelector(".context")?.classList.remove("context");
}

/** Shows `items` at a point, kept inside the window. `pick` returns true to keep the menu open. */
function showMenu(title: string | null, items: MenuItem[], pos: { x: number; y: number }, pick: (id: string) => boolean | void) {
  menuPos = pos;
  menu.innerHTML = (title ? `<h4>${esc(title)}</h4>` : "") + (items.length
    ? items.map((x) => x === "-" ? "<hr>" : `<button role="menuitem" data-target="${x.id}" class="${x.danger ? "danger" : ""}" ${x.disabled ? "disabled" : ""}>
        <i class="ph ph-${x.icon}"></i>${x.acct ? `<span class="account-dot acct-${x.acct}"></span>` : ""}<span>${esc(x.label)}</span>${x.key ? `<kbd>${esc(x.key)}</kbd>` : ""}</button>`).join("")
    : `<p>No labels yet</p>`);
  menu.onclick = (e) => {
    const item = (e.target as Element).closest<HTMLButtonElement>("[data-target]");
    if (!item || item.disabled) return;
    if (!pick(item.dataset.target!)) closeMenu();
  };
  menu.hidden = false;
  menu.style.left = `${Math.max(8, Math.min(pos.x, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(pos.y, window.innerHeight - menu.offsetHeight - 8))}px`;
}

/** Move: file the thread under one mailbox (leaving the Inbox). Label: toggle labels, menu stays open. */
function openMenu(kind: "move" | "label", t: Thread, pos?: { x: number; y: number }) {
  const anchor = document.querySelector(`[data-action="${kind}"]`)!;
  if (!pos && menuAnchor === anchor && !menu.hidden) return closeMenu();
  if (!pos) {
    const r = anchor.getBoundingClientRect();
    pos = { x: r.left, y: r.bottom + 6 };
  }
  const has = new Set(t.labels.split(" "));
  const items: MenuItem[] = kind === "move"
    ? [{ id: "INBOX", label: "Inbox", icon: "tray" }, ...userLabels.map((l) => ({ id: l.id, label: l.name, icon: "tag" })), { id: "SPAM", label: "Spam", icon: "warning-octagon" }]
        .map((x) => ({ ...x, disabled: has.has(x.id) }))
    : userLabels.map((l) => ({ id: l.id, label: l.name, icon: has.has(l.id) ? "check-square" : "square" }));
  showMenu(kind === "move" ? "Move to" : "Labels", items, pos, (id) => {
    if (kind === "label") {
      const on = !t.labels.split(" ").includes(id);
      t.labels = on ? `${t.labels} ${id}`.trim() : t.labels.split(" ").filter((l) => l !== id).join(" ");
      modify(t.id, on ? [id] : [], on ? [] : [id]);
      openMenu("label", t, menuPos);
      return true;
    }
    const remove = ["INBOX", mailbox].filter((l): l is string => !!l && l !== id && has.has(l));
    if (mailbox !== null && mailbox !== id) removeAndAdvance(t.id);
    modify(t.id, [id], remove);
  });
  menuAnchor = anchor;
}

threadList.addEventListener("contextmenu", (e) => {
  const li = (e.target as Element).closest<HTMLElement>("li[data-id]");
  if (!li) return;
  e.preventDefault();
  const t = threads.find((x) => x.id === li.dataset.id);
  if (!t) return;
  closeMenu();
  li.classList.add("context");
  const items: MenuItem[] = [
    { id: "reply", label: "Reply", icon: "arrow-bend-up-left", key: keyLabel("reply") },
    { id: "replyAll", label: "Reply all", icon: "arrow-bend-double-up-left", key: keyLabel("replyAll") },
    { id: "forward", label: "Forward", icon: "arrow-bend-up-right", key: keyLabel("forward") },
    "-",
    { id: "unread", label: t.unread ? "Mark as read" : "Mark as unread", icon: t.unread ? "envelope-simple-open" : "envelope-simple", key: keyLabel("unread") },
    { id: "star", label: t.starred ? "Unpin" : "Pin", icon: "push-pin", key: keyLabel("star") },
    "-",
    { id: "move", label: "Move to…", icon: "folder", key: keyLabel("move") },
    { id: "label", label: "Label…", icon: "tag", key: keyLabel("label") },
    "-",
    { id: "archive", label: "Archive", icon: "archive", key: keyLabel("archive"), disabled: !t.labels.split(" ").includes("INBOX") },
    { id: "spam", label: "Spam", icon: "warning-octagon", key: keyLabel("spam") },
    { id: "trash", label: "Delete", icon: "trash", key: keyLabel("trash"), danger: true },
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
  /** Where the quoted message starts in the body, so an HTML signature can go above it. */
  quoteMarker?: string | null;
  inline?: boolean;
  draftId?: string | null;
  touched?: boolean;
  /** Which account sends it. Replies use the thread's account. */
  account?: string;
  attachments?: OutFile[];
};
type ComposeState = Required<ComposeOptions>;

let compose: ComposeState | null = null;
let draftTimer = 0;
let draftQueue: Promise<unknown> = Promise.resolve();

const subjectInput = composeForm.elements.namedItem("subject") as HTMLInputElement;
const bodyInput = composeForm.elements.namedItem("body") as HTMLTextAreaElement;
const suggestContacts = (q: string) => invoke<string[]>("suggest_contacts", { query: q }).catch(() => [] as string[]);
const rcpt = {
  to: new Recipients($("#rcpt-to"), suggestContacts, () => markTouched()),
  cc: new Recipients($("#rcpt-cc"), suggestContacts, () => markTouched()),
  bcc: new Recipients($("#rcpt-bcc"), suggestContacts, () => markTouched()),
};

const htmlSignature = () => settings.composer.signatureMode === "html" && settings.composer.signatureHtml.trim() !== "";
const draftStatus = (text: string) => ($("#draft-status").textContent = text);

function showCcRows(cc: boolean, bcc: boolean) {
  composeForm.querySelector<HTMLElement>('[data-row="cc"]')!.hidden = !cc;
  composeForm.querySelector<HTMLElement>('[data-row="bcc"]')!.hidden = !bcc;
  $("#cc-toggle").hidden = cc && bcc;
}

/** "From" chips, shown only with several accounts. A saved draft stays with the account it was saved in. */
function renderFromRow() {
  const row = $("#from-row");
  row.hidden = !multi() || !compose || !!compose.draftId || !!compose.context;
  if (row.hidden || !compose) return;
  row.querySelector(".from-choices")!.innerHTML = accounts
    .map((a) => `<button type="button" role="radio" aria-checked="${a === compose!.account}" class="${a === compose!.account ? "on" : ""}" data-from="${esc(a)}">
      <span class="account-dot acct-${accountSettings(a).color}"></span>${esc(accountName(a))}</button>`)
    .join("");
}
$("#from-row").addEventListener("click", (e) => {
  const b = (e.target as Element).closest<HTMLElement>("[data-from]");
  if (!b || !compose) return;
  compose.account = b.dataset.from!;
  renderFromRow();
  markTouched();
});

function markTouched() {
  if (!compose) return;
  compose.touched = true;
  clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => saveDraft(), 1500);
}
subjectInput.addEventListener("input", markTouched);
bodyInput.addEventListener("input", markTouched);

const hasContent = () =>
  !!compose?.touched && !!(compose.attachments.length || bodyInput.value.trim() || subjectInput.value.trim() || rcpt.to.count || rcpt.cc.count || rcpt.bcc.count);

/** The message as the backend expects it, with an HTML signature merged in when one is set. */
function currentDraft(state: ComposeState): Record<string, unknown> {
  const draft: Record<string, unknown> = {
    to: rcpt.to.value, cc: rcpt.cc.value, bcc: rcpt.bcc.value, subject: subjectInput.value, body: bodyInput.value,
    from_name: accountSettings(state.account).name, ...(state.context ?? {}), attachments: state.attachments,
  };
  if (htmlSignature()) {
    const sigHtml = settings.composer.signatureHtml;
    const sigText = new DOMParser().parseFromString(sigHtml.replace(/<br\s*\/?>/gi, "\n"), "text/html").body.textContent ?? "";
    const { text, html } = withHtmlSignature(bodyInput.value, state.quoteMarker, sigHtml, sigText);
    Object.assign(draft, { body: text, html });
  }
  return draft;
}

/** Saves are queued, so a slow save can't race the next one into creating a duplicate draft. */
function saveDraft(state = compose, payload = state && currentDraft(state)) {
  clearTimeout(draftTimer);
  if (!state || !payload) return draftQueue;
  draftStatus("Saving…");
  draftQueue = draftQueue.then(() =>
    invoke<string>("save_draft", { account: state.account, draft: payload, draftId: state.draftId })
      .then((id) => {
        state.draftId = id;
        if (compose === state) draftStatus("Saved");
      })
      .catch(() => compose === state && draftStatus("Not saved — will retry")),
  );
  return draftQueue;
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
  compose = null;
  detachComposer();
  if (discard) {
    await draftQueue;
    if (state.draftId) invoke("delete_draft", { account: state.account, draftId: state.draftId }).catch(() => {});
  } else if (keep) {
    await saveDraft(state, payload);
    toast(state.draftId ? "Draft saved" : "Couldn't save the draft to Gmail");
  }
}

async function openComposer(fields: Fields = {}, opts: ComposeOptions = {}) {
  if (compose) await closeComposer();
  const inline = !!opts.inline && !!selected && (!opts.context || opts.context.thread_id === selected);
  compose = {
    title: opts.title ?? "New Email", context: opts.context ?? null, quoteMarker: opts.quoteMarker ?? null,
    inline, draftId: opts.draftId ?? null, touched: !!opts.touched, account: opts.account ?? defaultAccount(),
    attachments: opts.attachments ?? [],
  };
  renderComposeFiles();
  renderFromRow();
  rcpt.to.set(fields.to ?? "");
  rcpt.cc.set(fields.cc ?? "");
  rcpt.bcc.set(fields.bcc ?? "");
  showCcRows(!!fields.cc, !!fields.bcc);
  subjectInput.value = fields.subject ?? "";
  bodyInput.value = fields.body ?? "";
  $("#compose-title").textContent = compose.title;
  $("#compose-error").textContent = "";
  draftStatus(compose.draftId ? "Saved" : "");
  // HTML signatures can't live in a plain textarea, so they show as a preview and are added on send.
  const sig = $("#compose-signature");
  sig.hidden = !htmlSignature();
  if (!sig.hidden) renderSignaturePreview(sig.querySelector("iframe"));
  if (inline) {
    const host = document.createElement("section");
    host.className = "message compose-inline";
    host.append(composeForm);
    reader.append(host);
    host.scrollIntoView({ block: "nearest", behavior: settings.accessibility.reduceMotion ? "auto" : "smooth" });
  } else {
    composer.append(composeForm);
    composer.showModal();
  }
  if (fields.to || opts.context) {
    bodyInput.focus();
    bodyInput.setSelectionRange(0, 0);
    bodyInput.scrollTop = 0;
  } else rcpt.to.focus();
}

/** Splits an address header on commas that aren't inside a quoted display name. */
const splitAddresses = (list: string) => list.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((a) => a.trim()).filter(Boolean);

/** Signature block ("-- " separator, the email convention) or nothing. */
const signature = () =>
  settings.composer.signatureMode === "text" && settings.composer.signature.trim() ? `\n\n-- \n${settings.composer.signature.trim()}` : "";

function reply(kind: "reply" | "all" | "forward") {
  const last = messages.at(-1);
  if (!last || !selected) return;
  const thread = threads.find((t) => t.id === selected);
  const account = thread?.account ?? defaultAccount();
  const notMe = (a: string) => !accounts.includes(bareEmail(a));
  const when = new Date(last.date).toLocaleString();
  if (kind === "forward") {
    const marker = "---------- Forwarded message ----------";
    const opened = openComposer(
      {
        subject: /^fwd?:/i.test(last.subject) ? last.subject : `Fwd: ${last.subject}`,
        body: `${signature()}\n\n${marker}\nFrom: ${last.sender}\nDate: ${when}\nSubject: ${last.subject}\nTo: ${last.recipients}\n\n${last.text ?? ""}`,
      },
      { title: "Forward", quoteMarker: marker, inline: true, account },
    );
    return opened.then(() => forwardAttachments(last, account));
  }
  const mine = !notMe(last.sender);
  const primary = mine ? splitAddresses(last.recipients) : [last.sender];
  const others = kind === "all" ? [...splitAddresses(last.recipients), ...splitAddresses(last.cc)] : [];
  const cc = [...new Set(others.filter((a) => notMe(a) && !primary.some((p) => bareEmail(p) === bareEmail(a))))];
  const marker = `On ${when}, ${displayName(last.sender)} wrote:`;
  const quoted = (last.text ?? "").split("\n").map((l) => `> ${l}`).join("\n");
  return openComposer(
    {
      to: primary.join(", "),
      cc: cc.join(", "),
      subject: /^re:/i.test(last.subject) ? last.subject : `Re: ${last.subject}`,
      body: signature() + (settings.composer.quoteOriginal ? `\n\n${marker}\n${quoted}` : ""),
    },
    {
      title: kind === "all" ? "Reply all" : "Reply",
      context: { thread_id: selected, in_reply_to: last.message_id, references: last.refs },
      quoteMarker: marker,
      inline: true,
      account,
    },
  );
}

composeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const state = compose;
  if (!state) return;
  const error = (msg: string) => ($("#compose-error").textContent = msg);
  const all = [rcpt.to.value, rcpt.cc.value, rcpt.bcc.value].flatMap(splitList);
  if (!all.length) return error("Add at least one recipient");
  const bad = all.find((a) => !isValidAddress(a));
  if (bad) return error(`Check this address: ${bad}`);
  const draft = currentDraft(state);
  const fields: Fields = { to: rcpt.to.value, cc: rcpt.cc.value, bcc: rcpt.bcc.value, subject: subjectInput.value, body: bodyInput.value };
  // Let any pending save finish first, so it can't recreate the draft after it's been sent.
  clearTimeout(draftTimer);
  await draftQueue;
  const send = () => invoke("send", { account: state.account, draft, draftId: state.draftId });
  const reopen = (msg = "") => openComposer(fields, { ...state, touched: true }).then(() => error(msg));
  const delay = settings.composer.undoSendSeconds;
  if (delay > 0) {
    // Undo send: the email only leaves this Mac when the countdown ends.
    compose = null;
    detachComposer();
    const timer = window.setTimeout(async () => {
      try {
        await send();
        toast("Message sent");
      } catch (err) {
        reopen(String(err));
      }
    }, delay * 1000);
    return toastAction(`Sending in ${delay}s…`, "Undo", () => {
      clearTimeout(timer);
      reopen();
    }, delay * 1000);
  }
  const button = composeForm.querySelector<HTMLButtonElement>("button[type=submit]")!;
  button.disabled = true;
  try {
    await send();
    compose = null;
    detachComposer();
    toast("Message sent");
  } catch (err) {
    error(String(err));
  } finally {
    button.disabled = false;
  }
});

// ---- Composer attachments: the paperclip, drag and drop, and removable chips.

const composeFiles = $("#compose-files");
const fileInput = $<HTMLInputElement>("#compose-file");

function renderComposeFiles() {
  const files = compose?.attachments ?? [];
  composeFiles.hidden = !files.length;
  composeFiles.innerHTML = files.map((f, i) => attachmentButton(fileIcon(f.mime, f.name), f.name, f.size, { i }, true)).join("");
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
async function forwardAttachments(m: Message, account: string) {
  const state = compose;
  for (const a of m.attachments) {
    const name = a.filename || "attachment";
    const data = await invoke<string>("attachment_data", { account, message: m.id, idx: a.idx }).catch(() => null);
    if (compose !== state || !state) return;
    if (data === null) {
      toast(`Couldn't attach ${name}`);
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
  if (hasContent() && !(await ask({ title: "Discard this draft?", message: "It will be deleted from Drafts too.", confirm: "Discard", danger: true }))) return;
  closeComposer(true);
});
$("#cc-toggle").addEventListener("click", () => {
  showCcRows(true, true);
  rcpt.cc.focus();
});
// Escape (or the window's own close) keeps the draft rather than throwing it away.
composer.addEventListener("cancel", (e) => {
  e.preventDefault();
  closeComposer();
});
$("#compose-btn").addEventListener("click", () => openComposer({ body: signature() }));

$("#mailboxes").addEventListener("click", (e) => {
  // Real links (href="#") so they're focusable and work with Return and VoiceOver; never navigate.
  e.preventDefault();
  const a = (e.target as Element).closest<HTMLElement>("[data-mailbox]");
  if (a) openMailbox(a.dataset.mailbox || null);
});

/** Shows some accounts (null: all of them); keeps the current mailbox when it exists there. */
function setScope(list: string[] | null) {
  scope = list && list.length < accounts.length ? accounts.filter((a) => list.includes(a)) : null;
  renderAccountFooter();
  // Label ids belong to one account, so a label mailbox falls back to the Inbox.
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
threadList.addEventListener("click", (e) => {
  if (suppressClick) return void (suppressClick = false);
  const li = (e.target as Element).closest<HTMLElement>("li[data-id]");
  if (li) openThread(li.dataset.id!);
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
threadList.addEventListener("wheel", (e) => {
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
}, { passive: false });
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

document.querySelectorAll<HTMLElement>("[data-action]").forEach((b) => b.addEventListener("click", () => act(b.dataset.action!)));
document.querySelectorAll<HTMLElement>("[data-back]").forEach((b) =>
  b.addEventListener("click", () => setView(b.dataset.back as "mailboxes" | "list")),
);

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
    .map((s, i) => `<button type="button" role="option" data-i="${i}" aria-selected="${i === suggestIndex}" class="${i === suggestIndex ? "on" : ""}">
        ${avatar(s)}<span class="from-chip"><em>from:</em> ${esc(displayName(s) || bareEmail(s))}</span><small>${esc(bareEmail(s))}</small></button>`)
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
      suggestIndex = e.key === "ArrowDown" ? Math.min(suggestIndex + 1, suggestions.length - 1) : Math.max(suggestIndex - 1, -1);
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

document.querySelectorAll<HTMLFormElement>(".search").forEach((form) => form.addEventListener("submit", async (e) => {
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
    $("#list-title").textContent = `Searching Gmail for “${value}”…`;
    await loadThreads();
  } catch (err) {
    // Offline or Gmail error: keep the local results that are already showing.
    renderThreads();
    toast(`Showing results from this Mac only: ${err}`);
  }
}));

$("#sync-btn").addEventListener("click", () => invoke("sync_now"));

$("#view-btn").addEventListener("click", () => setSetting("inbox.view", settings.inbox.view === "smart" ? "list" : "smart"));

async function signOut(account: string) {
  const yes = await ask({
    title: `Sign out of ${account}?`,
    message: "Mail stored on this Mac for this account will be removed. Your Gmail isn't affected.",
    confirm: "Sign out",
    danger: true,
  });
  if (!yes) return;
  await invoke("sign_out", { account });
  const left = (await invoke<{ accounts: string[] }>("status")).accounts;
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
    start((await invoke<{ accounts: string[] }>("status")).accounts);
  } catch (e) {
    toast(String(e));
  }
}

initSettings({ accounts: () => accounts, onAddAccount: addAccount, onSignOut: signOut });

$("#signin-btn").addEventListener("click", async () => {
  const btn = $<HTMLButtonElement>("#signin-btn");
  btn.disabled = true;
  $("#signin-error").textContent = "Finish signing in in your browser…";
  try {
    await invoke<string>("add_account");
    start((await invoke<{ accounts: string[] }>("status")).accounts);
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
        { label: thread.unread ? "Mark as read" : "Mark as unread", icon: "envelope-simple", key: k("unread"), group: "Email", run: () => act("unread") },
        { label: thread.starred ? "Unpin" : "Pin", icon: "push-pin", key: k("star"), group: "Email", run: () => act("star") },
        { label: "Reply", icon: "arrow-bend-up-left", key: k("reply"), group: "Email", run: () => act("reply") },
        { label: "Reply all", icon: "arrow-bend-double-up-left", key: k("replyAll"), group: "Email", run: () => act("replyAll") },
        { label: "Forward", icon: "arrow-bend-up-right", key: k("forward"), group: "Email", run: () => act("forward") },
        { label: "Move to…", icon: "folder", key: k("move"), group: "Email", run: () => act("move") },
        { label: "Label…", icon: "tag", key: k("label"), group: "Email", run: () => act("label") },
        { label: "Mark as spam", icon: "warning-octagon", key: k("spam"), group: "Email", run: () => act("spam") },
      ]
    : [];
  const switchTo: Command[] = multi()
    ? [null, ...accounts].map((a): Command => ({
        label: a ? `Switch to ${accountName(a)}` : "Switch to All accounts", icon: "user-circle", group: "Accounts", run: () => setScope(a ? [a] : null),
      }))
    : [];
  const go: Command[] = [
    ...SYSTEM.map(([id, name, icon]): Command => ({ label: `Go to ${name}`, icon, group: "Go to", run: () => openMailbox(id) })),
    ...userLabels.map((l): Command => ({ label: `Go to ${l.name}`, icon: "tag", group: "Go to", run: () => openMailbox(l.id) })),
  ];
  const sections: [string, string, string][] = [
    ["general", "General", "gear-six"], ["appearance", "Appearance", "palette"], ["accounts", "Accounts", "user-circle"],
    ["ai", "AI", "sparkle"], ["inbox", "Inbox", "tray"], ["composer", "Composer", "pencil-simple-line"],
    ["accessibility", "Accessibility", "text-aa"], ["swipes", "Swipes", "hand-swipe-left"], ["shortcuts", "Keyboard shortcuts", "keyboard"],
  ];
  return [
    ...email,
    { label: "New email", icon: "pencil-simple-line", key: k("compose"), group: "Mail", run: () => $("#compose-btn").click() },
    { label: "Check for mail", icon: "arrows-clockwise", key: k("sync"), group: "Mail", run: () => invoke("sync_now") },
    { label: settings.inbox.view === "smart" ? "Switch to plain list" : "Switch to Smart Inbox", icon: "stack", group: "Mail", run: () => $("#view-btn").click() },
    ...go,
    ...switchTo,
    { label: "Add a Google account", icon: "user-plus", group: "Accounts", run: () => addAccount() },
    ...sections.map(([id, name, icon]): Command => ({ label: `Settings: ${name}`, icon, group: "Settings", run: () => openSettings(id) })),
    { label: "Use light appearance", icon: "sun", group: "Appearance", run: () => setSetting("appearance.theme", "light") },
    { label: "Use dark appearance", icon: "moon", group: "Appearance", run: () => setSetting("appearance.theme", "dark") },
    { label: "Match system appearance", icon: "desktop", group: "Appearance", run: () => setSetting("appearance.theme", "system") },
    { label: "Zoom in", icon: "magnifying-glass-plus", key: k("zoomIn"), group: "Appearance", run: () => stepZoom(1) },
    { label: "Zoom out", icon: "magnifying-glass-minus", key: k("zoomOut"), group: "Appearance", run: () => stepZoom(-1) },
    { label: "Actual size", icon: "magnifying-glass", key: k("zoomReset"), group: "Appearance", run: () => stepZoom(0) },
  ];
}

function renderPalette() {
  const q = paletteInput.value.trim();
  const found = rank(paletteCommands(), q);
  // Typing always offers a mail search too, after the matching commands.
  if (q) found.push({ label: `Search mail for “${q}”`, icon: "magnifying-glass", group: "Search", run: () => searchFor(q) });
  paletteItems = found;
  paletteIndex = Math.min(paletteIndex, Math.max(found.length - 1, 0));
  let lastGroup = "";
  paletteList.innerHTML = found.length
    ? found.map((c, i) => {
        const head = !q && c.group !== lastGroup ? `<li class="palette-group" role="presentation">${esc(c.group)}</li>` : "";
        lastGroup = c.group;
        return `${head}<li role="option" id="pc-${i}" data-i="${i}" aria-selected="${i === paletteIndex}" class="${i === paletteIndex ? "on" : ""}">
          <i class="ph ph-${c.icon}"></i><span>${esc(c.label)}</span>${c.key ? `<kbd>${esc(c.key)}</kbd>` : ""}</li>`;
      }).join("")
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
  if (app.hidden || askOpen() || paletteEl.open) return;
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
  // Writing an email (window or inline reply): only send and Escape act, everything else is typing.
  if (composer.open || composeForm.contains(document.activeElement)) {
    if (SEND.has(combo)) {
      e.preventDefault();
      composeForm.requestSubmit();
    } else if (e.key === "Escape" && !composer.open) {
      e.preventDefault();
      closeComposer();
    }
    return;
  }
  let action = bindings[combo];
  // "Default reply" in Settings swaps what the reply keys do; the buttons keep their literal meaning.
  if (settings.composer.defaultReply === "all" && (action === "reply" || action === "replyAll")) {
    action = action === "reply" ? "replyAll" : "reply";
  }
  // In the search field only ⌘ shortcuts act, so typing (and Backspace) stays text editing.
  if ((e.target as Element).closest("input, textarea")) {
    if (e.key === "Escape") (e.target as HTMLElement).blur();
    if (!combo.includes("cmd+")) return;
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
      return menu.hidden ? setView("list") : closeMenu();
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
function hideTip() {
  clearTimeout(tipTimer);
  if (!tooltip.hidden) tipHiddenAt = Date.now();
  tooltip.hidden = true;
  tipTarget = null;
}
document.addEventListener("pointerover", (e) => {
  const el = (e.target as Element).closest<HTMLElement>("[data-tip]");
  if (el === tipTarget) return;
  hideTip();
  if (!el) return;
  tipTarget = el;
  // A visible tooltip is already "warm", so moving along a toolbar switches instantly.
  tipTimer = window.setTimeout(() => {
    const [, label, key] = el.dataset.tip!.match(/^(.*?)(?: \((.+)\))?$/)!;
    tooltip.innerHTML = esc(label) + (key ? ` <kbd>${esc(key.toUpperCase())}</kbd>` : "");
    tooltip.hidden = false;
    const r = el.getBoundingClientRect();
    const below = r.bottom + 8 + tooltip.offsetHeight < window.innerHeight;
    tooltip.style.top = `${below ? r.bottom + 8 : r.top - 8 - tooltip.offsetHeight}px`;
    tooltip.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - tooltip.offsetWidth / 2, window.innerWidth - tooltip.offsetWidth - 8))}px`;
  }, Date.now() - tipHiddenAt < 300 ? 0 : 450);
});
document.addEventListener("pointerdown", hideTip);
document.addEventListener("keydown", hideTip);
document.querySelectorAll<HTMLElement>("[data-tip]").forEach((el) => {
  if (!el.hasAttribute("aria-label")) el.setAttribute("aria-label", el.dataset.tip!.replace(/ \(.+\)$/, ""));
});

// Tooltips show each button's current first key, so remapped shortcuts stay truthful.
const TIP_ACTIONS: Record<string, string> = { "compose-btn": "compose", "sync-btn": "sync", "settings-btn": "settings" };
function updateShortcutTips() {
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
  $("#account-email").textContent = one ? accountName(one) : scope ? `${scope.length} accounts` : `All accounts (${accounts.length})`;
  $("#account-dot").className = `account-dot ${one ? `acct-${accountSettings(one).color}` : "all"}`;
  $<HTMLButtonElement>("#account-btn").disabled = !multi();
}

/** Multi-select account picker above the sidebar footer; stays open while ticking accounts. */
function openAccountMenu() {
  const btn = $("#account-btn");
  const shown = scope ?? accounts.filter((a) => accountSettings(a).unified !== false);
  const items: MenuItem[] = [
    { id: "", label: "All accounts", icon: scope ? "square" : "check-square" },
    "-",
    ...accounts.map((a) => ({ id: a, label: accountName(a), icon: shown.includes(a) ? "check-square" : "square", acct: accountSettings(a).color })),
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

/** Hides the mailboxes column; remembered per device. */
function setSidebar(hidden: boolean) {
  app.dataset.sidebar = hidden ? "hidden" : "";
  closeMenu();
  const btn = $("#sidebar-toggle");
  btn.dataset.tip = hidden ? "Show sidebar" : "Hide sidebar";
  btn.setAttribute("aria-label", btn.dataset.tip);
  btn.setAttribute("aria-expanded", String(!hidden));
  try { localStorage.setItem("sidebar-hidden", hidden ? "1" : ""); } catch {}
}
$("#sidebar-toggle").addEventListener("click", () => setSidebar(app.dataset.sidebar !== "hidden"));
try { setSidebar(localStorage.getItem("sidebar-hidden") === "1"); } catch {}

$("#account-btn").addEventListener("click", () => (menuAnchor === $("#account-btn") && !menu.hidden ? closeMenu() : openAccountMenu()));

onSettingsChange((path) => {
  applyVisualSettings();
  if (accounts.length) renderAccountFooter();
  bindings = bindingsFrom(settings.shortcuts);
  renderViewButton();
  updateShortcutTips();
  if (!app.hidden && (path === "*" || path.startsWith("inbox.") || path === "accounts")) refresh();
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
}

listen("mail-changed", refresh);
listen<string>("sync-error", (e) => toast(`Sync failed: ${e.payload}`));

loadSettings()
  .then(() => invoke<{ accounts: string[] }>("status"))
  .then((s) => {
    if (s.accounts.length) start(s.accounts);
    else $("#signin").hidden = false;
  });

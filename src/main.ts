import { iconHtml } from "./icons";
import { DEVICE, IS_IOS } from "./platform";
import { initOnboarding, onboardingDue, startOnboarding } from "./onboarding";
import { initCleanup, openCleanup } from "./cleanup";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
import { textToHtml } from "./compose";
import { createEditor, foldReplyQuote } from "./editor";
import { ask, askChoice, askOpen, askText, askTextAndColor } from "./dialog";
import { initUpdates, updateOpen } from "./updates";
import { addImapAccount } from "./imap-signin";
import { Recipients } from "./recipients";
import { rank } from "./palette-match";
import { formatWhen, quickTimes } from "./schedule";
import { type Toast, actionToastOpen, toast } from "./toast";
import { Menu } from "@tauri-apps/api/menu";
import AirDatepicker from "air-datepicker";
import localeEnModule from "air-datepicker/locale/en";
import { attachmentButton, fileIcon } from "./attachments";
import { type Fields, type Label, type Message, type Thread, SECTIONS, SYSTEM, createMailCore } from "./core/mail";
import { AI_EDITS, type ComposeState, createComposer, editorContent, ownText, swapSignature } from "./core/composer";
import {
  type ReplyKind,
  ACCORDION,
  LABEL_COLORS,
  avatar,
  bareEmail,
  codeChip,
  quoted,
  renderQuote,
  dateGroup,
  decodeEntities,
  displayName,
  esc,
  labelChips,
  labelColorCss,
  labelDot,
  renderMessages,
  shortDate,
  wireReader,
} from "./email-view";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const app = $("#app");
const threadList = $("#threads");
const reader = $("#reader");
const searchInputs = [...document.querySelectorAll<HTMLInputElement>(".search input")];
// Desktop shows the top-right field, phones the one above the list; use whichever is on screen.
const visibleSearch = () => searchInputs.find((i) => i.offsetParent !== null) ?? searchInputs[0];
const composer = $<HTMLDialogElement>("#composer");
const composeForm = $<HTMLFormElement>("#compose-form");

const mail = createMailCore();
const multi = () => mail.accounts.length > 1;
const defaultAccount = () => mail.defaultAccount();
const accountName = (a: string) => accountSettings(a).title || a;

const setView = (v: "mailboxes" | "list" | "reader") => (app.dataset.view = v);
// The iOS keyboard covers the page without resizing it; full-screen sheets size to what's still visible (--visible-height).
if (IS_IOS && window.visualViewport) {
  const vv = window.visualViewport;
  const fit = () => document.documentElement.style.setProperty("--visible-height", `${vv.height}px`);
  vv.addEventListener("resize", fit);
  fit();
}

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

/** Unread Inbox mail across every account in the unified view, on the Dock icon, whichever account is on screen. */
async function updateDockBadge() {
  const count = settings.inbox.unreadBadge
    ? ((await invoke<Label[]>("labels", { accounts: null })).find((l) => l.id === "INBOX")?.unread ?? 0)
    : 0;
  // The window plugin is desktop-only; iOS has no Dock badge to set.
  await getCurrentWindow()
    .setBadgeCount(count || undefined)
    .catch(() => {});
}

/** An account's small round avatar: its initial in its colour. */
const accountAvatar = (a: string) =>
  `<span class="acct-av acct-${accountSettings(a).color}" aria-hidden="true">${esc(accountName(a).trim().charAt(0).toUpperCase() || "?")}</span>`;

/** The one account on screen, when the list is narrowed to a single account. */
const scopedAccount = () => (mail.scope?.length === 1 ? mail.scope[0] : null);

/** Accounts the combined view (no scope) covers. */
const unifiedAccounts = () => mail.accounts.filter((a) => accountSettings(a).unified !== false);

/** Folder key used by `settings.sidebar.expanded` and the order/hidden lists. */
const boxKey = (id: string | null) => id ?? "ALL";

function drawMailboxes() {
  const labels = mail.labels;
  labelColorCss(labels.map((l) => l.color ?? ""));
  const badge = settings.inbox.unreadBadge;
  void updateDockBadge();
  const { order, hidden, expanded } = settings.sidebar;
  // With several accounts each folder can open into a row per account, like Spark: the folder row is every account
  // together, an account row narrows the folder to that account.
  const nested = multi();
  const only = scopedAccount();
  const unreadIn = (a: string, id: string) => mail.accountUnread.get(a)?.get(id) ?? 0;
  const inboxTotal = unifiedAccounts().reduce((n, a) => n + unreadIn(a, "INBOX"), 0);
  const here = (id: string | null) => !mail.search && id === mail.mailbox;
  const current = (on: boolean) => (on ? ' class="active" aria-current="page"' : "");
  // One chevron, turned by CSS when its row is open, so toggling can rotate it.
  const toggle = `<span class="mb-toggle" data-toggle aria-hidden="true">${iconHtml("chevron-right")}</span>`;
  const system = arrange(SYSTEM, ([id]) => boxKey(id), order, hidden).map(([id, name, icon]) => {
    const count = badge && id === "INBOX" ? (nested ? inboxTotal : (labels.find((l) => l.id === id)?.unread ?? 0)) : 0;
    // One folder at a time shows its account rows; going to an account row opens its folder (openMailbox).
    const open = nested && expanded[0] === boxKey(id);
    const row = `<a href="#" draggable="false" data-group="system" data-mailbox="${esc(id ?? "")}"${current(here(id) && !only)}${nested ? ` aria-expanded="${open}"` : ""}>
      ${nested ? toggle : ""}${iconHtml(icon)}<span>${esc(name)}</span>${nested ? `<span class="acct-stack">${unifiedAccounts().map(accountAvatar).join("")}</span>` : ""}${count ? `<small>${count}</small>` : ""}</a>`;
    if (!nested) return row;
    const accounts = mail.accounts.map((a) => {
      const n = badge && id === "INBOX" ? unreadIn(a, "INBOX") : 0;
      return `<a href="#" draggable="false" class="mb-acct${here(id) && only === a ? " active" : ""}" data-box="${esc(id ?? "")}" data-acct="${esc(a)}"${here(id) && only === a ? ' aria-current="page"' : ""}>
        ${accountAvatar(a)}<span>${esc(accountName(a))}</span>${n ? `<small>${n}</small>` : ""}</a>`;
    });
    // Closed folders keep their rows, hidden, so toggling slides them in place without a redraw.
    return `${row}<div class="mb-accts" data-accts-for="${esc(boxKey(id))}"${open ? "" : " hidden"}>${accounts.join("")}</div>`;
  });
  const user = arrange(mail.userLabels, (l) => l.id, order, hidden).map(
    (l) =>
      `<a href="#" draggable="false" data-group="label" data-mailbox="${esc(l.id)}"${current(here(l.id))}>
      ${labelDot(l.name, l.color)}<span>${esc(l.name)}</span>${badge && l.unread ? `<small>${l.unread}</small>` : ""}</a>`,
  );
  const box = $("#mailboxes");
  box.classList.toggle("nested", nested);
  $("#sidebar").classList.toggle("nested", nested);
  box.innerHTML =
    system.join("") +
    `<h3><span>Labels</span><button type="button" class="label-add" data-tip="New label" aria-label="New label">${iconHtml("plus")}</button></h3>${user.join("")}`;
}

const reduceMotion = () =>
  settings.accessibility.reduceMotion || matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Opens or closes a folder's account rows in place, sliding them, and remembers it in settings. Only one folder is
 * open at a time, so opening one slides the other shut. */
function toggleFolder(id: string | null) {
  const key = boxKey(id);
  const box = $("#mailboxes");
  const rows = box.querySelector<HTMLElement>(`[data-accts-for="${CSS.escape(key)}"]`);
  if (!rows) return;
  // By the chevron's state rather than `hidden`, which stays false while a closing slide runs.
  const opening =
    box.querySelector(`[data-mailbox="${CSS.escape(id ?? "")}"]`)?.getAttribute("aria-expanded") !== "true";
  // Saved without redrawing the sidebar (see onSettingsChange), so nothing interrupts the slide.
  setSetting("sidebar.expanded", opening ? [key] : []);
  if (opening)
    box.querySelectorAll<HTMLElement>("[data-accts-for]").forEach((other) => {
      if (other !== rows && !other.hidden) slideFolder(other, false);
    });
  slideFolder(rows, opening);
}

function slideFolder(rows: HTMLElement, opening: boolean) {
  const box = $("#mailboxes");
  // The chevron turns and the combined avatars fade by CSS on aria-expanded.
  const id = rows.dataset.acctsFor === "ALL" ? "" : rows.dataset.acctsFor!;
  box.querySelector(`[data-mailbox="${CSS.escape(id)}"]`)?.setAttribute("aria-expanded", String(opening));
  // From wherever a slide still running left off, so a quick second click reverses smoothly.
  const from = rows.hidden ? 0 : rows.getBoundingClientRect().height;
  rows.getAnimations().forEach((a) => a.cancel());
  rows.hidden = false;
  const full = rows.scrollHeight;
  if (!opening && reduceMotion()) return void (rows.hidden = true);
  if (reduceMotion()) return;
  rows.style.overflow = "hidden";
  const slide = rows.animate(
    [
      { height: `${from}px`, opacity: full ? from / full : 0 },
      { height: opening ? `${full}px` : "0px", opacity: opening ? 1 : 0 },
    ],
    { duration: 220, easing: "ease" },
  );
  slide.onfinish = () => {
    rows.style.removeProperty("overflow");
    if (!opening) rows.hidden = true;
  };
}

function listTitle() {
  if (mail.search) return `Search: ${mail.search}`;
  return (
    SYSTEM.find(([id]) => id === mail.mailbox)?.[1] ??
    document.querySelector(`[data-mailbox="${CSS.escape(mail.mailbox ?? "")}"] span:not(.label-dot)`)?.textContent ??
    ""
  );
}

const PINNED_HEAD = `${iconHtml("push-pin")}Pinned`;

function renderViewButton() {
  const btn = $("#view-btn");
  const smart = settings.inbox.view === "smart";
  btn.dataset.tip = smart ? "Switch to plain list" : "Switch to Smart Inbox";
  btn.setAttribute("aria-label", btn.dataset.tip);
  btn.querySelector("i")!.className = smart ? "ti ti-stack-2" : "ti ti-list";
}

/** The thread's labels at the right end of the preview line, like Spark: two at most, then "+N". */
function rowLabels(t: Thread) {
  const chips = labelChips(t, mail.accountLabels.get(t.account) ?? []);
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
  const on = multiPicked() ? picked.has(t.id) : t.id === mail.selected;
  return `<li data-id="${t.id}" role="option" aria-selected="${on}" aria-label="${esc(`${t.unread ? "Unread, " : ""}${displayName(t.sender)}, ${t.subject || "(no subject)"}`)}" class="${t.unread ? "unread" : ""} ${on ? "selected" : ""}">
        <span class="dot"></span>
        <span class="avatar-ring${multi() ? ` acct-${accountSettings(t.account).color}` : ""}" ${multi() ? `data-tip="${esc(accountName(t.account))}"` : ""}>${avatar(t.sender)}</span>
        <span class="from">${esc(displayName(t.sender) || "(no sender)")}${t.count > 1 ? `<em>${t.count}</em>` : ""}${t.starred ? '<i class="ti ti-pinned pin"></i>' : ""}</span>
        <span class="date">${shortDate(t.date)}</span>
        <span class="subject">${t.count > 1 ? `<em class="subject-count">${t.count}</em>` : ""}<span class="subject-text">${esc(t.subject || "(no subject)")}</span>${t.code ? codeChip(t.code) : ""}</span>
        <span class="snippet">${esc(decodeEntities(t.snippet))}</span>${rowLabels(t)}
        ${mail.mailbox === "SCHEDULED" ? "" : rowActions(t)}
      </li>`;
}

const PAGE = 80;
let drawn = PAGE;
let drawnFor = "";

/** The reader's Pin and Unread buttons follow the open email: a solid pin when it's pinned, labels that say what a click does. */
function syncToolbar() {
  const t = mail.threads.find((x) => x.id === mail.selected);
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
  const chips = labelChips(t, mail.accountLabels.get(t.account) ?? []).join("");
  let row = reader.querySelector<HTMLElement>(".reader-labels");
  if (!chips) return row?.remove();
  if (!row) {
    row = Object.assign(document.createElement("div"), { className: "reader-labels" });
    h1.after(row);
  }
  row.innerHTML = chips;
}

/** The list's identity: rows only slide between redraws of the same list, not when switching mailboxes. */
const listKey = () => `${mail.mailbox}|${mail.search}|${mail.scope?.join(",") ?? ""}`;
const rowKey = (li: HTMLElement) => li.dataset.id ?? `section:${li.textContent}`;
const LIST_ROWS = "li[data-id], li.section";

/** Rows leaving the list fade out on this layer above it, so a redraw that follows straight away (archiving opens
 * the next email, which redraws again) can't cut them short. */
const ghostLayer = Object.assign(document.createElement("ul"), { className: "threads list-ghosts" });
ghostLayer.setAttribute("aria-hidden", "true");
threadList.after(ghostLayer);

/** Redraws the list; when it's the same list, rows glide from where they are on screen to their new places (FLIP),
 * so pinning, archiving or new mail moves them instead of making them jump, and a second redraw mid-glide carries
 * on from there. A row that's gone fades and slides out where it was while the rows below close the gap. */
function renderThreads() {
  const same = !reduceMotion() && listKey() === drawnFor;
  const listTop = threadList.getBoundingClientRect().top;
  const before = same
    ? new Map(
        [...threadList.querySelectorAll<HTMLElement>(LIST_ROWS)].map((li) => [
          rowKey(li),
          { li, rect: li.getBoundingClientRect(), top: li.getBoundingClientRect().top - listTop },
        ]),
      )
    : null;
  drawThreads();
  if (!before?.size) return;
  // Screen px per layout px: the list can have its own text size (CSS zoom), and transforms are in layout px.
  const first = threadList.querySelector<HTMLElement>("li[data-id]");
  const scale = first && first.offsetHeight ? first.getBoundingClientRect().height / first.offsetHeight : 1;
  const now = new Set<string>();
  for (const li of threadList.querySelectorAll<HTMLElement>(LIST_ROWS)) {
    const key = rowKey(li);
    now.add(key);
    const was = before.get(key);
    if (!was) {
      li.animate(
        { opacity: [0, 1], transform: ["translateY(-6px)", "none"] },
        { duration: 260, easing: "cubic-bezier(0.25, 0.1, 0.25, 1)" },
      );
      continue;
    }
    const dy = (was.top - (li.getBoundingClientRect().top - listTop)) / scale;
    if (Math.abs(dy) >= 1)
      li.animate(
        { transform: [`translateY(${dy}px)`, "none"] },
        { duration: 320, easing: "cubic-bezier(0.25, 0.1, 0.25, 1)" },
      );
  }
  // Gone rows: the old element on the ghost layer, where it was on screen, fading and sliding away. A few at most; a
  // bigger change (a whole selection archived) just closes up.
  const gone = [...before].filter(([key, r]) => !now.has(key) && r.li.dataset.id);
  if (!gone.length || gone.length > 8) return;
  const pane = threadList.parentElement!.getBoundingClientRect();
  for (const [, r] of gone) {
    const ghost = r.li;
    ghost.classList.remove("selected", "context");
    Object.assign(ghost.style, {
      position: "absolute",
      top: `${(r.rect.top - pane.top) / scale}px`,
      left: `${(r.rect.left - pane.left) / scale}px`,
      width: `${r.rect.width / scale}px`,
      margin: "0",
    });
    ghostLayer.append(ghost);
    ghost
      .animate(
        { opacity: [1, 0], transform: ["none", "translateX(-28px)"] },
        { duration: 240, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" },
      )
      .finished.finally(() => ghost.remove());
  }
}

function drawThreads() {
  syncToolbar();
  $("#list-title").textContent = listTitle();
  const emptyBtn = $("#empty-btn");
  emptyBtn.hidden = !!mail.search || (mail.mailbox !== "TRASH" && mail.mailbox !== "SPAM");
  emptyBtn.querySelector("span")!.textContent = mail.mailbox === "SPAM" ? "Empty Spam" : "Empty Trash";
  emptyBtn.toggleAttribute("disabled", !mail.threads.length);
  // Smart Inbox / plain list only applies to the Inbox.
  $("#view-btn").hidden = !!mail.search || mail.mailbox !== "INBOX";
  $("#cleanup-btn").hidden = !!mail.search || mail.mailbox !== "INBOX";
  if (!mail.threads.length) {
    threadList.innerHTML = `<li class="empty">${mail.search ? "No results" : "No messages"}</li>`;
    return;
  }
  // Only the rows near the top are drawn, more as the list scrolls: a mailbox of a thousand threads redrawn on every
  // open, archive or sync took a few hundred ms each time.
  const key = listKey();
  if (key !== drawnFor) [drawn, drawnFor] = [PAGE, key];
  const visible = mail.threads.slice(
    0,
    Math.max(drawn, mail.threads.findIndex((t) => t.id === mail.selected) + PAGE / 2),
  );
  if (!mail.smartInbox()) {
    let last = "";
    threadList.innerHTML = visible
      .map((t) => {
        const group =
          mail.search || mail.mailbox === "SCHEDULED"
            ? ""
            : mail.pinnedFirst() && t.starred
              ? PINNED_HEAD
              : dateGroup(t.date);
        const head = group !== last ? `<li class="section">${group}</li>` : "";
        last = group;
        return head + threadRow(t);
      })
      .join("");
    return;
  }
  threadList.innerHTML = SECTIONS.map(([key, title, icon]) => {
    const rows = visible.filter((t) => mail.sectionOf(t) === key);
    return rows.length ? `<li class="section">${iconHtml(icon)}${title}</li>${rows.map(threadRow).join("")}` : "";
  }).join("");
}

const searchingTitle = (q: string) => `Searching ${inMail() === "in Gmail" ? "Gmail" : "your mail"} for “${q}”…`;

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

async function openThread(id: string) {
  $("#link-status").hidden = true;
  if (mail.mailbox === "SCHEDULED") return editScheduled(id);
  if (mail.mailbox === "DRAFT" && (await openDraft(id))) return;
  picked.clear();
  pickAnchor = id;
  delete app.dataset.picked;
  if (compose.state?.inline) void compose.close();
  app.dataset.open = "";
  const opening = mail.openThread(id, show);
  setView("reader");
  const thread = mail.threads.find((t) => t.id === id);
  try {
    await opening;
  } catch (e) {
    reader.innerHTML = `<div class="placeholder">${esc(String(e))}</div>`;
  }
  function show() {
    reader.innerHTML = `<div class="reader-head"><h1>${esc(mail.messages[0]?.subject || thread?.subject || "(no subject)")}</h1></div>`;
    syncToolbar();
    renderMessages(reader, mail.messages, thread?.account ?? defaultAccount());
    reader.querySelectorAll(".message > header").forEach((header, i) => {
      const code = mail.messages[i]?.code;
      if (code) header.querySelector("time")?.insertAdjacentHTML("beforebegin", codeChip(code));
    });
    reader.scrollTop = 0;
    scrollToLatest();
  }
}

reader.addEventListener("click", (e) => {
  const chip = (e.target as Element).closest<HTMLElement>("[data-code]");
  if (chip)
    void copyCode(
      chip.dataset.code!,
      mail.threads.find((t) => t.id === mail.selected),
    );
});

/** Copies a one-time code (unless a notification already did), then archives its email if Settings → Inbox says so. */
async function copyCode(code: string, t: Thread | undefined, copied = false) {
  if (!copied) {
    try {
      await navigator.clipboard.writeText(code);
    } catch (err) {
      return void toast(`Couldn't copy: ${err}`, { kind: "error" });
    }
  }
  if (!settings.inbox.archiveAfterCode || !t?.labels.split(" ").includes("INBOX")) {
    return void toast(`Copied ${code}`, { kind: "success", icon: "copy" });
  }
  removeAndAdvance(t.id);
  void mail.undoable(t, [], ["INBOX"]);
  toast(`Copied ${code} and archived the email`, {
    kind: "success",
    icon: "copy",
    action: {
      label: "Undo",
      key: keyLabel("undo"),
      run: () => {
        void mail.undo();
        toast("Undone", { kind: "success" });
      },
    },
  });
}

wireReader(
  reader,
  mail,
  reply,
  (action, m) => void draftAction(action, m),
  (raw, m, chip) => personCard(raw, m, chip),
);

/** A person's card from a message header: write to them, copy their address, find your emails with them, or reply
 * to them alone. */
function personCard(raw: string, m: Message, chip: HTMLElement) {
  const email = bareEmail(raw);
  const name = displayName(raw) || email;
  const first = name.includes("@") ? name : name.split(" ")[0];
  const account = mail.threads.find((t) => t.id === mail.selected)?.account ?? mail.defaultAccount();
  const me = email === account.toLowerCase();
  const head = `<div class="person-card">${avatar(raw)}<div><strong>${esc(name)}</strong><span>${esc(email)}</span></div></div>`;
  const items: MenuItem[] = [
    { id: "write", label: "New email", icon: "pencil" },
    { id: "copy", label: "Copy address", icon: "copy" },
    { id: "search", label: me ? "Search your emails" : `Emails with ${first}`, icon: "search" },
    ...(me ? [] : [{ id: "reply", label: `Reply to ${first} only`, icon: "arrow-back-up" }]),
  ];
  const r = chip.getBoundingClientRect();
  chip.classList.add("open");
  showMenu(
    null,
    items,
    { x: r.left, y: r.bottom + 6 },
    (id) => {
      if (id === "write") void compose.write({ to: raw });
      else if (id === "copy")
        void navigator.clipboard
          .writeText(email)
          .then(() => toast(`Copied ${email}`, { kind: "success", icon: "copy" }))
          .catch((err) => toast(`Couldn't copy: ${err}`, { kind: "error" }));
      else if (id === "search") {
        const input = $<HTMLInputElement>(".search-top input");
        input.value = email;
        input.closest("form")!.requestSubmit();
      } else if (id === "reply") void compose.reply("reply", { ...m, reply_to: raw });
    },
    head,
  );
  menuAnchor = chip;
}

/** Edit or Delete on a draft shown in its conversation. */
async function draftAction(action: "edit" | "delete", _m: Message) {
  const t = mail.threads.find((x) => x.id === mail.selected);
  if (!t) return;
  if (action === "edit") {
    hidePillFor(t.id);
    return void openDraft(t.id);
  }
  await discardDrafts([t], false);
}

/** Deletes the drafts in these conversations, and only them: a reply draft's conversation keeps the emails it
 * answers (trashing the conversation, what Delete does elsewhere, would take those too). Drafts have no Undo, so it
 * asks first. `leave`: the conversations drop out of the list (Drafts). */
async function discardDrafts(list: Thread[], leave = true) {
  const n = list.length;
  const yes = await ask({
    title: n === 1 ? "Delete this draft?" : `Delete ${n} drafts?`,
    message: `${n === 1 ? "It" : "They"} will be deleted ${inMail()} too. The rest of the conversation stays.`,
    confirm: "Delete",
    danger: true,
  });
  if (!yes) return;
  if (leave) {
    const gone = new Set(list.map((t) => t.id));
    mail.threads = mail.threads.filter((t) => !gone.has(t.id));
    if (mail.selected && gone.has(mail.selected)) clearReader();
    picked.clear();
    delete app.dataset.picked;
    renderThreads();
  }
  const failed: string[] = [];
  await Promise.all(
    list.map(async (t) => {
      try {
        const found = await invoke<[string, string, string] | null>("find_draft", { account: t.account, thread: t.id });
        hidePillFor(t.id, found?.[0]);
        if (found) await invoke("delete_draft", { account: t.account, draftId: found[0] });
      } catch (err) {
        failed.push(String(err));
      }
    }),
  );
  if (failed.length)
    toast(`Couldn't delete ${failed.length === n ? "the draft" : "some drafts"}: ${failed[0]}`, { kind: "error" });
  else toast(n === 1 ? "Draft deleted" : `${n} drafts deleted`, { icon: "trash" });
  mail.refresh();
}

function clearReader() {
  if (compose.state?.inline) void compose.close();
  mail.closeThread();
  delete app.dataset.open;
  delete app.dataset.picked;
  reader.innerHTML = `<div class="placeholder empty-reader"><i class="ti ti-chevron-up"></i><span>No email selected</span></div>`;
}

function undo() {
  const undone = mail.undo();
  if (!undone) return toast("Nothing to undo");
  toast("Undone", { kind: "success" });
  return undone;
}

/** The open move toast, so quick moves of the same kind in a row merge into one ("Archived 3 emails"). */
let lastMove: { key: string; emails: number; actions: number; toast: Toast } | null = null;

/** Confirms emails moved to `add` (nothing: archived), with Undo for every move the toast covers. */
function confirmMove(add: string[], emails: number) {
  const key = add.join();
  if (lastMove?.key === key && lastMove.toast.open) {
    lastMove.emails += emails;
    lastMove.actions += 1;
    return lastMove.toast.setMessage(movedMessage(add, lastMove.emails), true);
  }
  const icon = add.includes("TRASH")
    ? "trash"
    : add.includes("SPAM")
      ? "alert-octagon"
      : add.includes("INBOX")
        ? "inbox"
        : "archive";
  const entry = { key, emails, actions: 1, toast: null as unknown as Toast };
  entry.toast = toast(movedMessage(add, emails), {
    icon,
    action: {
      label: "Undo",
      key: keyLabel("undo"),
      run: () => {
        for (let i = 0; i < entry.actions; i++) mail.undo();
        toast("Undone", { kind: "success" });
      },
    },
  });
  lastMove = entry;
}

/** Confirms pinning or unpinning; there's nothing to undo, so it just says so. */
const confirmPin = (msg: string) => toast(msg, { icon: "pinned" });

/** What moving emails into `add` says (nothing added: archived). */
function movedMessage(add: string[], n: number) {
  const what = n === 1 ? "" : ` ${n} emails`;
  if (add.includes("TRASH")) return `Moved${what} to Trash`;
  if (add.includes("SPAM")) return `Marked${what} as spam`;
  if (add.includes("INBOX")) return `Moved${what} to Inbox`;
  return `Archived${what}`;
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
    mail.threads = mail.threads.filter((t) => !picked.has(t.id));
    picked.clear();
    delete app.dataset.picked;
    clearReader();
    setView("list");
    renderThreads();
  } else list.forEach((t) => removeAndAdvance(t.id));
  await mail.deleteForever(list);
}

/** Archive/trash: drop the thread from the list and move selection to its neighbour. */
function removeAndAdvance(id: string) {
  const i = mail.threads.findIndex((t) => t.id === id);
  mail.threads = mail.threads.filter((t) => t.id !== id);
  if (id !== mail.selected) return renderThreads();
  const next = mail.threads[Math.min(i, mail.threads.length - 1)];
  if (next && app.dataset.view !== "list") openThread(next.id);
  else {
    clearReader();
    setView("list");
  }
  renderThreads();
}

/** Runs an action on the open thread, or on `id` (e.g. a right-clicked row) without disturbing the reader. */
function act(action: string, id = mail.selected) {
  if (multiPicked() && (!id || picked.has(id))) return actOnPicked(action);
  const t = mail.threads.find((t) => t.id === id);
  if (!t) return;
  if (mail.mailbox === "SCHEDULED") return scheduledAction(action, t.id);
  // Replies need the thread's messages, so open it first.
  if (["reply", "replyAll", "forward", "aiReply"].includes(action) && t.id !== mail.selected) {
    openThread(t.id).then(() => act(action, t.id));
    return;
  }
  switch (action) {
    case "archive":
      removeAndAdvance(t.id);
      confirmMove([], 1);
      return mail.undoable(t, [], ["INBOX"]);
    case "trash":
      if (mail.mailbox === "TRASH") return void deleteForever([t]);
      if (mail.mailbox === "DRAFT") return void discardDrafts([t]);
      if (settings.general.confirmDelete) {
        ask({
          title: "Delete this email?",
          message: `“${t.subject || "(no subject)"}” will move to Trash.`,
          confirm: "Delete",
          danger: true,
        }).then((yes) => yes && act("trashNow", t.id));
        return;
      }
      return act("trashNow", t.id);
    case "trashNow":
      removeAndAdvance(t.id);
      confirmMove(["TRASH"], 1);
      return mail.undoable(t, ["TRASH"], ["INBOX", "SPAM"], true);
    case "unread":
      return mail.modify(t, t.unread ? [] : ["UNREAD"], t.unread ? ["UNREAD"] : []);
    case "star":
      confirmPin(t.starred ? "Unpinned" : "Pinned");
      return mail.modify(t, t.starred ? [] : ["STARRED"], t.starred ? ["STARRED"] : []);
    case "spam":
      removeAndAdvance(t.id);
      if (mail.mailbox === "SPAM") {
        confirmMove(["INBOX"], 1);
        return mail.undoable(t, ["INBOX"], ["SPAM"]);
      }
      confirmMove(["SPAM"], 1);
      return mail.undoable(t, ["SPAM"], ["INBOX", "TRASH"]);
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
  if (!picked.size && mail.selected) picked.add(mail.selected);
  const anchor = pickAnchor ?? mail.selected;
  const ids = mail.threads.map((t) => t.id);
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
  if (mail.mailbox === "SCHEDULED" || !mail.threads.length) return;
  picked.clear();
  mail.threads.slice(0, PICK_MAX).forEach((t) => picked.add(t.id));
  if (!multiPicked()) return openThread(mail.threads[0].id);
  showPicked();
  if (mail.threads.length > PICK_MAX) toast(`Selected the first ${PICK_MAX} emails, the most Shift changes at once`);
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
  if (compose.state?.inline) void compose.close();
  mail.closeThread();
  app.dataset.open = "";
  app.dataset.picked = "";
  setView("reader");
  const list = mail.threads.filter((t) => picked.has(t.id));
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
  const list = mail.threads.filter((t) => picked.has(t.id));
  if (!list.length || mail.mailbox === "SCHEDULED") return;
  const n = `${list.length} ${list.length === 1 ? "email" : "emails"}`;
  const leave = (add: string[], remove: string[], trash = false) => {
    mail.threads = mail.threads.filter((t) => !picked.has(t.id));
    picked.clear();
    delete app.dataset.picked;
    clearReader();
    setView("list");
    renderThreads();
    confirmMove(add, list.length);
    void mail.undoableAll(list, add, remove, trash);
  };
  switch (action) {
    case "archive":
      return leave([], ["INBOX"]);
    case "spam":
      return leave(["SPAM"], ["INBOX", "TRASH"]);
    case "trash":
      if (mail.mailbox === "TRASH") return void deleteForever(list);
      if (mail.mailbox === "DRAFT") return void discardDrafts(list);
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
      void mail.applyChanges(list.map((t) => ({ t, add: read ? [] : ["UNREAD"], remove: read ? ["UNREAD"] : [] })));
      return showPicked();
    }
    case "star": {
      const pin = list.some((t) => !t.starred);
      confirmPin(`${pin ? "Pinned" : "Unpinned"} ${n}`);
      void mail.applyChanges(list.map((t) => ({ t, add: pin ? ["STARRED"] : [], remove: pin ? [] : ["STARRED"] })));
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
  reader.querySelector("[data-person].open")?.classList.remove("open");
}

/** Shows `items` at a point, kept inside the window. `pick` returns true to keep the menu open. */
function showMenu(
  title: string | null,
  items: MenuItem[],
  pos: { x: number; y: number },
  pick: (id: string) => boolean | void,
  /** Markup above the items instead of a title (a person's card). */
  head?: string,
) {
  menuPos = pos;
  // Re-rendered in place (the Label menu after a toggle): keep focus on the same item.
  const keep = menu.hidden ? null : (document.activeElement as HTMLElement | null)?.dataset?.target;
  if (menu.hidden) menuReturn = document.activeElement as HTMLElement | null;
  menu.innerHTML =
    (head ?? (title ? `<h4>${esc(title)}</h4>` : "")) +
    (items.length
      ? items
          .map((x) =>
            x === "-"
              ? "<hr>"
              : `<button role="${x.checked === undefined ? "menuitem" : `menuitemcheckbox" aria-checked="${x.checked}`}" data-target="${esc(x.id)}" class="${x.danger ? "danger" : ""}" ${x.disabled ? "disabled" : ""}>
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
  const own = mail.accountLabels.get(t.account) ?? [];
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
          await mail.modify(t, [created], []);
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
      mail.modify(t, on ? [id] : [], on ? [] : [id]);
      openMenu("label", t, menuPos);
      return true;
    }
    if (id === "TRASH") return void act("trash", t.id);
    if (mail.mailbox !== null && mail.mailbox !== id) removeAndAdvance(t.id);
    confirmMove(id === "ARCHIVE" ? [] : [id], 1);
    mail.undoable(
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
  const label = mail.userLabels.find((l) => l.id === id);
  // A label's own options come first; deleting it stays last, apart from the rest.
  const items: MenuItem[] = label
    ? [
        { id: "rename", label: "Rename…", icon: "pencil-simple" },
        { id: "color", label: "Colour", icon: "palette" },
        "-",
      ]
    : [];
  items.push({
    id: "read",
    label: "Mark all as read",
    icon: "envelope-simple-open",
    disabled: id === "SCHEDULED" || id === "DRAFT",
  });
  if (id === "TRASH" || id === "SPAM")
    items.push("-", { id: "empty", label: id === "TRASH" ? "Empty Trash" : "Empty Spam", icon: "trash", danger: true });
  items.push("-", { id: "hide", label: "Hide from sidebar", icon: "eye-slash" });
  const names = new Map([
    ...SYSTEM.map(([sid, name]) => [sid ?? "ALL", name] as const),
    ...mail.userLabels.map((l) => [l.id, l.name] as const),
  ]);
  const hidden = settings.sidebar.hidden.filter((k) => names.has(k));
  if (hidden.length)
    items.push(...hidden.map((k) => ({ id: `show:${k}`, label: `Show ${names.get(k)}`, icon: "eye" })));
  if (label) items.push("-", { id: "delete", label: "Delete label", icon: "trash", danger: true });
  showMenu(null, items, { x: e.clientX, y: e.clientY }, (pick) => {
    if (pick === "read") {
      // Gmail marks every unread email in the mailbox, older ones not shown here included.
      const box = a.querySelector("span:not(.mb-toggle):not(.label-dot)")?.textContent || "this mailbox";
      void ask({
        title: `Mark all of ${box} as read?`,
        message: `Every unread email in ${box}${inAccounts()} is marked read ${inMail()}, including older ones not shown here.`,
        confirm: "Mark as read",
      }).then((yes) => void (yes && labelAction(invoke("mark_all_read", { label: id, accounts: mail.scope }))));
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
          for (const l of [...mail.userLabels, ...[...mail.accountLabels.values()].flat()])
            if (l.name === label.name) l.color = bg;
          const dot = document.querySelector<HTMLElement>(
            `#mailboxes [data-mailbox="${CSS.escape(label.id)}"] .label-dot`,
          );
          if (dot) {
            dot.className = "label-dot";
            dot.dataset.color = bg.slice(1).toLowerCase();
          }
          renderThreads();
          invoke("set_label_color", { label: label.id, background: bg, text, accounts: mail.scope }).catch((err) => {
            toast(String(err), { kind: "error" });
            mail.refresh();
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
        const follow = mail.mailbox === label.id && label.id.startsWith("name:") ? `name:${name}` : undefined;
        void labelAction(invoke("rename_label", { label: label.id, name, accounts: mail.scope }), follow);
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
              invoke("delete_label", { label: label.id, accounts: mail.scope }),
              mail.mailbox === label.id ? "INBOX" : undefined,
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
  const measure = () => rows.map((r) => r.getBoundingClientRect().top);
  let tops = measure();
  const from = rows.indexOf(item);
  let pitch = rows.length > 1 ? tops[1] - tops[0] : 0;
  let to = from;
  let dragging = false;
  const move = (ev: PointerEvent) => {
    const dy = ev.clientY - e.clientY;
    if (!dragging) {
      if (Math.abs(dy) < 4) return;
      dragging = true;
      item.classList.add("lifted");
      // Account rows hide while sorting (.sorting), so the folders sit evenly spaced; measure them again.
      box.classList.add("sorting");
      tops = measure();
      pitch = rows.length > 1 ? tops[1] - tops[0] : 0;
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
  return (mail.scope ?? mail.accounts).some((a) => mail.imapAccounts.has(a)) ? "on your mail server" : "in Gmail";
}

function inAccounts() {
  const n = (mail.scope ?? mail.accounts.filter((x) => accountSettings(x).unified !== false)).length;
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
  if (yes) await labelAction(mail.emptyMailbox(id));
}
$("#empty-btn").addEventListener("click", () => mail.mailbox && emptyMailbox(mail.mailbox));

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
  const t = mail.threads.find((x) => x.id === li.dataset.id);
  if (!t) return;
  closeMenu();
  li.classList.add("context");
  if (multiPicked() && picked.has(t.id)) {
    const list = mail.threads.filter((x) => picked.has(x.id));
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
  if (mail.mailbox === "SCHEDULED") {
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
  const binned = mail.mailbox === "SPAM" || mail.mailbox === "TRASH";
  // Your own sent mail is never unread and never spam.
  const sent = mail.mailbox === "SENT";
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
          mail.mailbox === "SPAM"
            ? { id: "spam", label: "Not spam", icon: "inbox", key: keyLabel("spam") }
            : { id: "spam", label: "Spam", icon: "warning-octagon", key: keyLabel("spam") },
        ]),
    {
      id: "trash",
      label: mail.mailbox === "TRASH" ? "Delete forever" : "Delete",
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
// A click inside an email (its sandboxed frame) never reaches this document, but it takes focus from the window, as
// does switching to another app: either way an open menu closes, like a Mac menu.
window.addEventListener("blur", () => {
  if (!menu.hidden) closeMenu();
});

// ---- Composer: replies open inline under the thread, new emails in a resizable window. Drafts save to Gmail Drafts as
// you type, so closing never loses work and drafts reach your other devices. What it does is in core/composer.ts,
// shared with the phone; this is the Mac's view of it.

const subjectInput = composeForm.elements.namedItem("subject") as HTMLInputElement;
const editor = createEditor(
  $("#compose-body"),
  $("#format-bar"),
  () => compose.touch(),
  () => signatureFor(compose.state?.account).html,
  renderQuote,
);
const suggestContacts = (q: string) => invoke<string[]>("suggest_contacts", { query: q }).catch(() => [] as string[]);
const rcpt = {
  to: new Recipients($("#rcpt-to"), suggestContacts, () => compose.touch()),
  cc: new Recipients($("#rcpt-cc"), suggestContacts, () => compose.touch()),
  bcc: new Recipients($("#rcpt-bcc"), suggestContacts, () => compose.touch()),
};

const draftStatus = (text: string) => ($("#draft-status").textContent = text);
const composeError = (text: string) => ($("#compose-error").textContent = text);

function showCcRows(cc: boolean, bcc: boolean) {
  composeForm.querySelector<HTMLElement>('[data-row="cc"]')!.hidden = !cc;
  composeForm.querySelector<HTMLElement>('[data-row="bcc"]')!.hidden = !bcc;
  $("#cc-toggle").setAttribute("aria-expanded", String(cc && bcc));
}

/** "From" chips, shown only with several accounts and not on replies (they belong to their thread's account). */
function renderFromRow() {
  const row = $("#from-row");
  const state = compose.state;
  row.hidden = !multi() || !state || !!state.context;
  if (row.hidden || !state) return;
  row.querySelector(".from-choices")!.innerHTML = mail.accounts
    .map(
      (
        a,
      ) => `<button type="button" role="radio" aria-checked="${a === state.account}" class="${a === state.account ? "on" : ""}" data-from="${esc(a)}">
      <span class="account-dot acct-${accountSettings(a).color}"></span>${esc(accountName(a))}</button>`,
    )
    .join("");
}
$("#from-row").addEventListener("click", (e) => {
  const b = (e.target as Element).closest<HTMLElement>("[data-from]");
  const state = compose.state;
  if (!b || !state || b.dataset.from === state.account) return;
  const prev = state.account;
  compose.setAccount(b.dataset.from!);
  swapSignature(editor, prev, state.account);
  renderFromRow();
  compose.touch();
});

subjectInput.addEventListener("input", () => compose.touch());
// Tab into the body lands on the first line. Left to the browser, focus can select the signature block instead.
subjectInput.addEventListener("keydown", (e) => {
  if (e.key !== "Tab" || e.shiftKey) return;
  e.preventDefault();
  editor.commands.focus("start");
});

/** The composer's fields as typed, for reopening it later. */
const currentFields = (): Fields => ({
  to: rcpt.to.value,
  cc: rcpt.cc.value,
  bcc: rcpt.bcc.value,
  subject: subjectInput.value,
  body: editor.getHTML(),
});

/** Takes the form out of the reader / window and parks it back in the (closed) dialog. */
function detachComposer() {
  const host = composeForm.closest(".compose-inline");
  if (composer.open) composer.close();
  composer.append(composeForm);
  host?.remove();
}

// The last draft closed with "keep": a corner card that reopens it, until dismissed or another email is written.
const draftPill = $("#draft-pill");
let pillDraft: { fields: Fields; state: ComposeState } | null = null;
/** Set when a draft from the open conversation was just saved, so the next refresh redraws it with the draft. */
let redrawOpenThread = false;

function showDraftPill(fields: Fields, state: ComposeState) {
  pillDraft = { fields, state };
  $("#draft-pill-subject").textContent = fields.subject || "(no subject)";
  draftPill.hidden = false;
}
function hideDraftPill() {
  pillDraft = null;
  draftPill.hidden = true;
}
/** Closes the pill when it stands for this draft (by Gmail draft id, or by its conversation), which was just deleted
 * or reopened elsewhere: it would offer a draft that's gone, or one already open. */
function hidePillFor(thread: string, draftId?: string) {
  const s = pillDraft?.state;
  if (!s) return;
  if ((draftId && s.draftId === draftId) || (s.thread ?? s.context?.thread_id) === thread) hideDraftPill();
}
function reopenPillDraft() {
  const d = pillDraft;
  if (!d) return;
  hideDraftPill();
  void compose.open(d.fields, { ...d.state, touched: false });
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
  if (state.thread && mail.mailbox === "DRAFT") {
    mail.threads = mail.threads.filter((t) => t.id !== state.thread);
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

function showComposer(fields: Fields, state: ComposeState) {
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
  $("#compose-title").textContent = state.title;
  if (state.inline) {
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
  if (fields.to || state.context) {
    editor.commands.focus("start");
    $("#compose-body").scrollTop = 0;
  } else rcpt.to.focus();
  // After focusing: focus jumps the scroll and would cut a smooth scroll short.
  if (state.inline)
    composeForm.parentElement!.scrollIntoView({
      block: "start",
      behavior: settings.accessibility.reduceMotion ? "auto" : "smooth",
    });
}

const compose = createComposer(mail, {
  opening: hideDraftPill,
  show: showComposer,
  hide: detachComposer,
  read: () => ({ fields: currentFields(), ...editorContent(editor, compose.state?.account) }),
  status: draftStatus,
  error: composeError,
  files: renderComposeFiles,
  busy: (on) => (composeForm.querySelector<HTMLButtonElement>("button[type=submit]")!.disabled = on),
  kept: (fields, state) => {
    // Its conversation is open: show the saved draft there once the sync that follows the save brings it in.
    const thread = state.thread ?? state.context?.thread_id;
    if (thread && thread === mail.selected) redrawOpenThread = true;
    showDraftPill(fields, state);
  },
  discarded: (thread) => {
    if (mail.mailbox !== "DRAFT") return;
    mail.threads = mail.threads.filter((t) => t.id !== thread);
    renderThreads();
  },
  quote: quoted,
  toast,
  where: inMail,
});

function reply(kind: ReplyKind, last?: Message) {
  return compose.reply(kind, last);
}

composeForm.addEventListener("submit", (e) => {
  e.preventDefault();
  void compose.send();
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

const scheduleSend = (at: Date) => void compose.schedule(at).then((ok) => ok && closeLater());

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
      { text: `Sent from this ${DEVICE} while Shift is running`, enabled: false },
    ],
  });
  menu.popup();
});

// ---- Write with AI: the AI button next to Send later. Edits the selection, or the part of the email the user
// wrote; in a reply it can also draft the reply, using what's typed so far as notes.

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
    compose.touch();
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
  if (!compose.state) return;
  const own = ownText(editor);
  return aiWrite(() => compose.aiReply(own.text), own);
}

$("#ai-write").addEventListener("click", () => {
  const state = compose.state;
  const anchor = $<HTMLButtonElement>("#ai-write");
  if (!state) return;
  if (menuAnchor === anchor && !menu.hidden) return closeMenu();
  const own = ownText(editor);
  const rewrite = (instruction: string) => aiWrite(() => compose.aiRewrite(own.text, instruction), own);
  // Edits only once there's text to edit, rather than a list of greyed-out ones.
  const items: MenuItem[] = [
    ...(state.context && mail.messages.length
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

function editScheduled(id: string) {
  return compose.editScheduled(id);
}
function scheduledAction(action: string, id: string) {
  return compose.scheduledAction(action, id);
}
function openDraft(id: string) {
  return compose.openDraft(id, (bcc) => {
    rcpt.bcc.set(bcc);
    showCcRows(!!rcpt.cc.value, true);
  });
}

// ---- Composer attachments: the paperclip, drag and drop, and removable chips.

const composeFiles = $("#compose-files");
const fileInput = $<HTMLInputElement>("#compose-file");

function renderComposeFiles() {
  const files = compose.state?.attachments ?? [];
  composeFiles.hidden = !files.length;
  composeFiles.innerHTML = files
    .map((f, i) => attachmentButton(fileIcon(f.mime, f.name), f.name, f.size, { i }, true))
    .join("");
}

$("#compose-attach").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  void compose.addFiles([...(fileInput.files ?? [])]);
  fileInput.value = "";
});
composeFiles.addEventListener("click", (e) => {
  const el = (e.target as Element).closest<HTMLElement>(".attachment-remove");
  if (el) compose.removeFile(Number(el.closest<HTMLElement>(".attachment")!.dataset.i));
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
  void compose.addFiles([...e.dataTransfer.files]);
});

$("#compose-close").addEventListener("click", () => compose.close());
$("#compose-discard").addEventListener("click", async () => {
  if (
    compose.hasContent() &&
    !(await ask({
      title: "Discard this draft?",
      message: "It will be deleted from Drafts too.",
      confirm: "Discard",
      danger: true,
    }))
  )
    return;
  void compose.close(true);
});
// Opens both rows; when they're open, closes the ones without recipients.
$("#cc-toggle").addEventListener("click", (e) => {
  if ((e.currentTarget as HTMLElement).getAttribute("aria-expanded") === "true") {
    showCcRows(!!rcpt.cc.value, !!rcpt.bcc.value);
    return rcpt.to.focus();
  }
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
  if (pressedOutside && outsideComposer(e) && !askOpen()) void compose.close();
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
  if (!compose.hasContent()) return compose.close();
  if (askOpen()) return;
  const choice = await askChoice({
    title: "Close this email?",
    message: "Save it to Drafts to finish later, or press Esc again to discard it.",
    confirm: "Save draft",
    alt: "Discard",
    escapeIsAlt: true,
  });
  if (choice === "ok") return compose.close();
  if (choice === "alt") return compose.close(true);
  editor.commands.focus();
}
$("#compose-btn").addEventListener("click", () => void compose.write());

$("#mailboxes").addEventListener("click", (e) => {
  // Real links (href="#") so they're focusable and work with Return and VoiceOver; never navigate.
  e.preventDefault();
  if (sortedJustNow) return;
  if ((e.target as Element).closest(".label-add")) return void newLabel();
  const target = e.target as Element;
  const acct = target.closest<HTMLElement>("[data-acct]");
  if (acct) return void showMailbox(acct.dataset.box || null, acct.dataset.acct!);
  const a = target.closest<HTMLElement>("[data-mailbox]");
  if (!a) return;
  const id = a.dataset.mailbox || null;
  // The arrow, or a second click on the folder already showing every account, opens or closes its account rows.
  const showing = !mail.search && mail.mailbox === id && !mail.scope;
  if (target.closest("[data-toggle]") || (showing && multi() && a.dataset.group === "system")) return toggleFolder(id);
  // A folder row is every account together.
  showMailbox(id, null);
});

/** The sidebar's + next to Labels: creates the label in every account on screen. Gmail labels belong to one account;
 * the sidebar merges labels with the same name, so one created in each account shows as one label for all of them. */
async function newLabel() {
  const list = mail.scope ?? mail.accounts.filter((a) => accountSettings(a).unified !== false);
  const where =
    list.length === 1 ? accountName(list[0]) : list.length === 2 ? "both accounts" : `all ${list.length} accounts`;
  const picked = await askTextAndColor({
    title: "New label",
    message: mail.accounts.length > 1 ? `Created ${inMail()} for ${where}.` : `Created ${inMail()}.`,
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
  await mail.loadLabels();
}

/** Shows some accounts (null: all of them); keeps the current mailbox when it exists there. */
function setScope(list: string[] | null) {
  mail.setScope(list);
  openMailbox(mail.mailbox);
}

/** Opens a folder for one account, or for all of them (null). */
function showMailbox(id: string | null, account: string | null) {
  if ((account ? [account] : null)?.join() !== mail.scope?.join()) mail.setScope(account ? [account] : null);
  openMailbox(id);
}

function openMailbox(id: string | null) {
  // An account row's folder stays open, so the selected row stays in view.
  if (multi() && scopedAccount() && SYSTEM.some(([s]) => s === id) && settings.sidebar.expanded[0] !== boxKey(id))
    setSetting("sidebar.expanded", [boxKey(id)]);
  mail.openMailbox(id);
  searchInputs.forEach((i) => (i.value = ""));
  clearReader();
  setView("list");
}

let suppressClick = false;
threadList.addEventListener(
  "scroll",
  () => {
    if (threadList.scrollTop + threadList.clientHeight < threadList.scrollHeight - 400) return;
    if (drawn >= mail.threads.length) return mail.loadMore();
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
  const code = (e.target as Element).closest<HTMLElement>("[data-code]")?.dataset.code;
  if (code)
    void copyCode(
      code,
      mail.threads.find((t) => t.id === li.dataset.id),
    );
  else if (rowAction) act(rowAction, li.dataset.id);
  else if ((e.metaKey || e.shiftKey) && mail.mailbox !== "SCHEDULED") pick(li.dataset.id!, e.shiftKey);
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
    invoke<Thread[]>("search_local", { query: value, accounts: mail.scope }),
    invoke<string[]>("suggest_senders", { query: value, accounts: mail.scope }),
  ]);
  if (seq !== liveSeq) return; // a newer keystroke already ran
  mail.showResults(value, rows);
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
      if (mail.search !== null) {
        mail.search = null;
        clearReader();
        mail.refresh();
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
    mail.search = value;
    clearReader();
    try {
      mail.threads = await invoke<Thread[]>("search_local", { query: value, accounts: mail.scope });
      renderThreads();
      $("#list-title").textContent = searchingTitle(value);
      await mail.loadThreads();
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
    ? ` ${waiting} scheduled ${waiting === 1 ? "email" : "emails"} won't be sent; ${waiting === 1 ? "it stays" : "they stay"} in ${mail.imapAccounts.has(account) ? "Drafts" : "Gmail's Drafts"}.`
    : "";
  const yes = await ask({
    title: `Sign out of ${account}?`,
    message: `Mail stored on this ${DEVICE} for this account will be removed. ${mail.imapAccounts.has(account) ? "The mail on your server" : "Your Gmail"} isn't affected.${unsent}`,
    confirm: "Sign out",
    danger: true,
  });
  if (!yes) return;
  await invoke("sign_out", { account });
  const left = (await mail.loadStatus()).accounts;
  if (!left.length) return location.reload();
  mail.setAccounts(left);
  closeSettings();
  start(mail.accounts);
}

$("#settings-btn").addEventListener("click", () => openSettings());
/** Browser sign-in; the new account appears in the sidebar and starts syncing. */
async function addAccount() {
  try {
    await invoke<string>("add_account");
    start((await mail.loadStatus()).accounts);
  } catch (e) {
    toast(String(e), { kind: "error" });
  }
}

/** Email and password sign-in for an account that isn't Gmail. */
async function addOtherAccount() {
  if (await addImapAccount()) start((await mail.loadStatus()).accounts);
}

initSettings({
  accounts: () => mail.accounts,
  isImap: (a) => mail.imapAccounts.has(a),
  onAddAccount: addAccount,
  onAddImap: addOtherAccount,
  onSignOut: signOut,
});
$("#signin-other").addEventListener("click", () => void addOtherAccount());
initOnboarding();
initCleanup({ scope: () => mail.scope, toast });
$("#cleanup-btn").addEventListener("click", () => void openCleanup());

$("#signin-btn").addEventListener("click", async () => {
  const btn = $<HTMLButtonElement>("#signin-btn");
  btn.disabled = true;
  $("#signin-error").textContent = "Finish signing in with Google…";
  try {
    await invoke<string>("add_account");
    start((await mail.loadStatus()).accounts);
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
  const thread = mail.threads.find((t) => t.id === mail.selected);
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
    ? [null, ...mail.accounts].map(
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
    ...mail.userLabels.map(
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
  if (app.hidden || askOpen() || updateOpen() || paletteEl.open || ($("#cleanup") as HTMLDialogElement).open) return;
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
  const i = mail.threads.findIndex((t) => t.id === mail.selected);
  const go = (n: number) => mail.threads[n] && openThread(mail.threads[n].id);
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
  // On the button, a ⌘ shortcut reads better than a single letter, so prefer one when New Email has both.
  const composeKeys = keysFor(settings.shortcuts).compose ?? [];
  const composeKey = composeKeys.find((k) => k.startsWith("cmd+")) ?? composeKeys[0];
  $("#compose-key").textContent = composeKey ? formatCombo(composeKey) : "";
  document.querySelectorAll<HTMLElement>("[data-tip]").forEach((el) => {
    const action = el.dataset.action ?? TIP_ACTIONS[el.id];
    if (!action) return;
    el.dataset.label ??= el.dataset.tip!.replace(/ \(.+\)$/, "");
    const key = keyLabel(action);
    el.dataset.tip = key ? `${el.dataset.label} (${key})` : el.dataset.label;
  });
}

onSettingsChange((path) => {
  applyVisualSettings();
  // The open email is drawn again in its new text size or font.
  if (
    (path === "appearance.emailTextSize" || path === "appearance.uniformEmailFont") &&
    mail.selected &&
    !app.hidden &&
    !compose.state?.inline
  )
    void openThread(mail.selected);
  // The sidebar, the From menu and the phone's account list follow the user's account order.
  if (mail.accounts.length && (path === "*" || path === "accountOrder")) mail.setAccounts(mail.accounts);
  // Account names, colours and order show in the sidebar.
  if (mail.accounts.length && (path === "*" || path.startsWith("account"))) drawMailboxes();
  bindings = bindingsFrom(settings.shortcuts);
  renderViewButton();
  updateShortcutTips();
  if (!app.hidden && (path === "*" || path.startsWith("inbox.") || path === "accounts")) mail.refresh();
  // Opening or closing a folder's account rows happens in place (toggleFolder), so it needs no redraw.
  else if (!app.hidden && path.startsWith("sidebar.") && path !== "sidebar.expanded") void mail.loadLabels();
});

function start(list: string[]) {
  mail.setAccounts(list);
  // New accounts take the next unused colour in Shift's order, like the native app.
  for (const a of mail.accounts) {
    if (settings.accounts[a]?.color) continue;
    const used = mail.accounts.map((x) => settings.accounts[x]?.color).filter(Boolean);
    setAccountSetting(a, "color", ACCOUNT_COLOR_ORDER.find((c) => !used.includes(c)) ?? ACCOUNT_COLOR_ORDER[0]);
  }
  $("#signin").hidden = true;
  clearReader();
  if (IS_IOS) void showPhone();
  else app.hidden = false;
  mail.refresh();
  // Adding an account from inside the walkthrough calls start() again; the open walkthrough carries on.
  if (onboardingDue() && $("#onboarding").hidden) {
    const begin = () => startOnboarding({ accounts: () => mail.accounts, addAccount, keyLabel });
    // On the phone, once its screens (and their stylesheet) are in, so the walkthrough doesn't flash unstyled.
    if (phone) void phone.then(begin);
    else begin();
  }
}

/** The iPhone gets its own screens on the same core (src/mobile), loaded only there. */
let phone: Promise<ReturnType<typeof import("./mobile/phone").mountPhone>> | null = null;
async function showPhone() {
  phone ??= import("./mobile/phone").then((m) => m.mountPhone(mail));
  (await phone).reset();
}

mail.subscribe((e) => {
  // The desktop panes only draw while they're showing; errors are toasted for either interface.
  if (app.hidden && e.type !== "error" && e.type !== "sync-error") return;
  switch (e.type) {
    case "labels":
      return drawMailboxes();
    case "threads":
      return renderThreads();
    case "loaded":
      // A list too short to scroll (Trash, a quiet label) asks for older mail straight away.
      if (threadList.scrollHeight <= threadList.clientHeight) void mail.loadMore();
      return;
    case "searching":
      $("#list-title").textContent = searchingTitle(e.query);
      return;
    case "refreshed": {
      // A new message in the open conversation (a reply, or one just sent) shows without reopening it. Not while an
      // inline reply is being written, and not in Drafts or Scheduled, where opening a row opens the composer.
      const open = mail.threads.find((t) => t.id === mail.selected);
      const redraw = redrawOpenThread;
      redrawOpenThread = false;
      if (!open || compose.state?.inline || mail.mailbox === "DRAFT" || mail.mailbox === "SCHEDULED") return;
      // Redrawn when its emails changed, not only their count: a sent draft becomes the sent email in its place.
      if (redraw || open.count !== mail.messages.length) void openThread(open.id);
      else void mail.openChanged().then((changed) => changed && !compose.state?.inline && openThread(open.id));
      return;
    }
    case "error":
      toast(e.message, { kind: "error" });
      return;
    case "sync-error": {
      // Shown once per distinct error every 10 minutes (sync retries every tick), and never over an Undo or Restart toast.
      const now = Date.now();
      if (now - (syncErrorShown.get(e.message) ?? 0) < 10 * 60_000) return;
      if (actionToastOpen()) return;
      syncErrorShown.set(e.message, now);
      toast(`Sync failed: ${e.message}`, { kind: "error" });
    }
  }
});
const syncErrorShown = new Map<string, number>();
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
  if (IS_IOS) return void (await phone)?.openFromNotification(payload);
  if (payload.account && mail.scope && !mail.scope.includes(payload.account)) setScope(null);
  if (mail.mailbox !== "INBOX" || mail.search) openMailbox("INBOX");
  await mail.loadThreads();
  if (payload.thread && mail.threads.some((t) => t.id === payload.thread)) await openThread(payload.thread);
});
// Copy code on a new-mail notification: the backend has copied it already.
listen<{ account?: string; thread?: string; code: string }>("code-copied", ({ payload: { account, thread, code } }) => {
  const listed = mail.threads.find((t) => t.id === thread && t.account === account);
  // Not in the list on screen (another mailbox is open): the notification was for Inbox mail.
  const t = listed ?? (thread && account ? ({ id: thread, account, labels: "INBOX" } as Thread) : undefined);
  void copyCode(code, t, true);
});
// Messages from the backend, such as the outcome of Shift → Check for Updates….
listen<string>("app-toast", (e) => toast(e.payload));
// Shift → Settings… (⌘,) in the menu bar.
listen("open-settings", () => openSettings());
/** Saves an open draft before Shift quits or restarts, so the last few seconds of typing aren't lost. */
const saveBeforeQuit = async () => {
  await flushSettings();
  await compose.flush();
};
onSaveError((err) => toast(`Couldn't save your settings: ${err}`, { kind: "error" }));
// ⌘Q: the backend waits (up to 5 s) for this before quitting.
listen("before-quit", () => void saveBeforeQuit().finally(() => invoke("quit_now")));
initUpdates(saveBeforeQuit);
// With Settings → General → "Install updates automatically", the release is already in place: only restart.
listen<string>("update-ready", (e) =>
  toast(`Shift ${e.payload} is ready`, {
    ms: 10 * 60_000,
    action: { label: "Restart", run: () => void saveBeforeQuit().finally(() => invoke("restart_app")) },
  }),
);

loadSettings()
  .then(mail.loadStatus)
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

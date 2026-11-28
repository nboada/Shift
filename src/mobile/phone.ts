// The iPhone interface: mailboxes → conversation list → conversation on a navigation stack, on the shared mail core.
// main.ts mounts it instead of the desktop panes.
import "./mobile.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  type Change,
  FOLDERS,
  type Label,
  type MailCore,
  type Thread,
  SECTIONS,
  SYSTEM,
  labelToggle,
  moveChanges,
  relabel,
} from "../core/mail";
import {
  avatar,
  bareEmail,
  dateGroup,
  decodeEntities,
  displayName,
  esc,
  labelChips,
  labelColorCss,
  labelDot,
  renderMessages,
  type ReplyKind,
  shortDate,
  wireReader,
} from "../email-view";
import { iconClass } from "../icons";
import { type SwipeAction, accountSettings, onSettingsChange, settings } from "../settings";
import { openSettings } from "../settings-ui";
import { arrange } from "../sidebar";
import { toast } from "../toast";
import { createComposeSheet } from "./compose-sheet";
import { loadRecent, remember, saveRecent } from "./recent";
import { type Choice, type Item, actionSheet, confirmSheet, contextMenu, listSheet } from "./sheet";
import { type Page, barButton, createStack } from "./stack";

/** Rows drawn at a time; more as the list nears its end. */
const PAGE = 60;
/** How far a row slides before letting go runs its swipe action: a share of its width, at least SWIPE_MIN. */
const SWIPE_AT = 0.35;
const SWIPE_MIN = 110;
/** How far a finger moves before a press turns into a swipe or a scroll, whichever way it went. */
const SLOP = 8;
/** How far the list is pulled down past its top before letting go checks for mail. */
const PULL_AT = 70;
/** How long a row is held before its menu opens. */
const PRESS_MS = 450;
/** Pauses in typing before the search screen asks the cache, and then Gmail. */
const LOCAL_AFTER = 120;
const REMOTE_AFTER = 800;

const SWIPES: Record<Exclude<SwipeAction, "none">, [label: string, icon: string]> = {
  archive: ["Archive", "archive"],
  trash: ["Delete", "trash"],
  unread: ["Unread", "envelope-simple"],
  star: ["Pin", "push-pin"],
  spam: ["Spam", "warning-octagon"],
};

/** A tap of feedback from the phone (none on the Mac); a failure is no reason to interrupt anything. */
const haptic = (style: "light" | "medium" | "selection" | "success") =>
  void invoke("haptic", { style }).catch(() => {});

/** Icons are decoration here: every control already has a name, so VoiceOver skips the glyph. */
const icon = (name: string) => `<i class="${iconClass(name)}" aria-hidden="true"></i>`;
const labelsOf = (t: Thread) => t.labels.split(" ");
const emails = (n: number) => `${n} ${n === 1 ? "email" : "emails"}`;
/** Label changes that only take off labels a thread has, so Undo doesn't add ones it never had. */
const changesFor = (ts: Thread[], add: string[], remove: string[]): Change[] =>
  ts.map((t) => ({ t, add, remove: remove.filter((l) => labelsOf(t).includes(l)) }));

type Notified = { account?: string; thread?: string };

export function mountPhone(mail: MailCore) {
  const host = createComposeSheet(mail, {
    discarded: (id) => {
      const t = mail.mailbox === "DRAFT" ? mail.threads.find((x) => x.id === id) : undefined;
      if (t) removeAll([t]);
    },
  });
  document.documentElement.classList.add("phone-ui");
  const root = document.createElement("div");
  root.className = "phone";
  document.body.append(root);
  const stack = createStack(root);

  const multi = () => mail.accounts.length > 1;
  const accountName = (a: string) => accountSettings(a).title || a;
  const boxName = (id: string | null) =>
    SYSTEM.find(([s]) => s === id)?.[1] ?? mail.userLabels.find((l) => l.id === id)?.name ?? "Mail";
  const inView = () => mail.scope ?? mail.accounts.filter((a) => accountSettings(a).unified !== false);
  const inMail = () => (inView().some((a) => mail.imapAccounts.has(a)) ? "on your mail server" : "in Gmail");

  // ---- Mailboxes

  const boxes = stack.page("Mailboxes", "m-boxes");
  boxes.end.innerHTML = barButton("settings", "gear-six", "Settings");
  boxes.end.addEventListener("click", () => openSettings());
  boxes.scroller.querySelector(".m-title")!.insertAdjacentHTML("beforebegin", `<p class="m-eyebrow"></p>`);
  /** An account's initial in its colour. */
  const accountAv = (a: string) =>
    `<span class="acct-av acct-${accountSettings(a).color}" aria-hidden="true">${esc(accountName(a).trim().charAt(0).toUpperCase() || "?")}</span>`;

  function renderBoxes() {
    labelColorCss([...mail.labels, ...[...mail.accountLabels.values()].flat()].map((l) => l.color ?? ""));
    const unread = new Map(mail.labels.map((l) => [l.id, l.unread]));
    const badge = settings.inbox.unreadBadge;
    const row = (id: string | null, name: string, glyph: string, count = 0, color?: string | null) =>
      `<button type="button" class="m-cell${id === mail.mailbox && !mail.search ? " on" : ""}${id === "INBOX" ? " inbox" : ""}" data-box="${esc(id ?? "")}" aria-label="${esc(count ? `${name}, ${count} unread` : name)}">
        ${glyph ? icon(glyph) : labelDot(name, color ?? null)}<span>${esc(name)}</span>${count ? `<small>${count}</small>` : ""}</button>`;
    const { order, hidden } = settings.sidebar;
    // The Waiting label (Settings → Inbox → Follow-ups) sits under the Inbox, which it's the other half of.
    const waiting = waitingLabel();
    const system = arrange(SYSTEM, ([id]) => id ?? "ALL", order, hidden).flatMap(([id, name, glyph]) => [
      row(id, name, glyph, badge && id === "INBOX" ? unread.get(id) : 0),
      ...(id === "INBOX" && waiting ? [row(waiting.id, waiting.name, "clock")] : []),
    ]);
    const labels = arrange(
      mail.userLabels.filter((l) => l !== waiting),
      (l) => l.id,
      order,
      hidden,
    ).map((l) => row(l.id, l.name, "", badge ? l.unread : 0, l.color));
    const one = mail.scope?.length === 1 ? mail.scope[0] : null;
    const chip = (id: string, name: string, lead: string, on: boolean) =>
      `<button type="button" class="m-chip" data-scope="${esc(id)}" role="radio" aria-checked="${on}">${lead}<span>${esc(name)}</span></button>`;
    const accounts = multi()
      ? `<div class="m-chip-row" role="radiogroup" aria-label="Accounts">${chip("", "All", "", !mail.scope)}${mail.accounts
          .map((a) => chip(a, accountName(a), accountAv(a), one === a))
          .join("")}</div>`
      : "";
    const fresh = unread.get("INBOX") ?? 0;
    boxes.el.querySelector(".m-eyebrow")!.textContent = [
      multi() ? `${mail.accounts.length} accounts` : mail.accounts[0] ? accountName(mail.accounts[0]) : "",
      fresh ? `${fresh} new` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    boxes.content.innerHTML =
      accounts +
      `<div class="m-cells">${system.join("")}</div>` +
      (labels.length ? `<h3 class="m-group-title">Labels</h3><div class="m-cells">${labels.join("")}</div>` : "");
  }

  boxes.content.addEventListener("click", (e) => {
    const cell = (e.target as Element).closest<HTMLElement>("[data-box], [data-scope]");
    if (!cell) return;
    if (cell.dataset.scope !== undefined) {
      mail.setScope(cell.dataset.scope ? [cell.dataset.scope] : null);
      mail.openMailbox(mail.mailbox);
      return renderBoxes();
    }
    openBox(cell.dataset.box || null);
  });

  // ---- Conversation list

  let list: Page | null = null;
  let drawn = PAGE;
  let loaded = false;
  let syncing = 0;
  /** Edit mode: conversations picked for a bulk action, by id. */
  let editing = false;
  const picked = new Set<string>();

  function openBox(id: string | null, animate = true) {
    if (id !== mail.mailbox || mail.search) mail.openMailbox(id);
    loaded = false;
    drawn = PAGE;
    editing = false;
    picked.clear();
    list = stack.page(boxName(id), "m-list-page");
    const page = list;
    page.bar.insertAdjacentHTML(
      "afterbegin",
      `<button type="button" class="m-text m-select-all" data-act="done" hidden>Cancel</button>`,
    );
    page.end.innerHTML = `<button type="button" class="m-text m-quiet" data-act="edit">Select</button>
      <button type="button" class="m-text m-strong" data-act="select-all" hidden>Select all</button>
      <button type="button" class="m-accounts" data-act="accounts" hidden></button>`;
    page.content.innerHTML = `<div class="m-banner" hidden><span></span><button type="button" class="m-text" data-act="empty"></button></div>
      <ul class="m-list" aria-label="Conversations"></ul>`;
    // The heading: a small line of context over the large title, and a link to the view next to this one.
    const title = page.scroller.querySelector<HTMLElement>(".m-title")!;
    const head = document.createElement("div");
    head.className = "m-head";
    title.before(head);
    head.append(title);
    head.insertAdjacentHTML("beforeend", `<button type="button" class="m-jump" data-act="jump" hidden></button>`);
    head.insertAdjacentHTML("beforebegin", `<p class="m-eyebrow" aria-live="polite"></p>`);
    page.scroller.insertAdjacentHTML(
      "afterbegin",
      `<div class="m-pull" aria-hidden="true"><span>${icon("arrows-clockwise")}</span></div>`,
    );
    page.el.insertAdjacentHTML(
      "beforeend",
      `<div class="m-dock">
        <button type="button" class="m-search-pill" data-act="search">${icon("magnifying-glass")}<span>Search mail</span></button>
        <button type="button" class="m-fab" data-act="compose" aria-label="New email">${icon("pencil-simple-line")}</button>
      </div>
      <footer class="m-toolbar m-edit-tools" role="toolbar" aria-label="Selected conversations" hidden>
        ${tool("archive", "archive", "Archive")}${tool("move", "folder", "Move")}${tool("label", "tag", "Label")}${tool("mark", "envelope-simple-open", "Mark")}${tool("trash", "trash", "Delete")}
      </footer>`,
    );
    page.el.addEventListener("click", (e) => {
      const b = (e.target as Element).closest<HTMLButtonElement>("[data-act], [data-edit]");
      if (!b || b.disabled) return;
      if (b.dataset.edit) return void editAction(b.dataset.edit);
      switch (b.dataset.act) {
        case "compose":
          return void host.write();
        case "edit":
          return setEditing(true);
        case "done":
          return setEditing(false);
        case "accounts":
          return accountSheet();
        case "select-all":
          if (picked.size === mail.threads.length) picked.clear();
          else mail.threads.forEach((t) => picked.add(t.id));
          return syncEdit();
        case "empty":
          return void emptyBox();
        case "search":
          return openSearch();
        case "jump":
          if (b.dataset.box !== undefined) openBox(b.dataset.box || null);
      }
    });
    page.onClose = () => {
      if (list === page) list = null;
    };
    wireRows(page.content.querySelector<HTMLElement>(".m-list")!, page);
    wireScroll(page);
    syncListTools();
    renderList();
    void stack.push(page, animate);
  }

  const tool = (act: string, glyph: string, label: string) =>
    `<button type="button" class="m-tool" data-edit="${act}">${icon(glyph)}<span>${label}</span></button>`;

  /** Days a conversation has waited for an answer before Waiting puts it forward with Nudge and Drop it. */
  const DUE_DAYS = 3;
  const daysSince = (date: number) => Math.floor((Date.now() - date) / 86_400_000);
  /** The user's "waiting for a reply" label (Settings → Inbox → Follow-ups), when they've chosen one. */
  const waitingLabel = () => mail.userLabels.find((l) => l.name && l.name === settings.inbox.followUps.waiting);
  const inWaiting = () => !mail.search && !!mail.mailbox && mail.mailbox === waitingLabel()?.id;

  function rowHtml(t: Thread) {
    const ring = multi() && mail.scope?.length !== 1 ? ` acct-${accountSettings(t.account).color}` : "";
    const name = displayName(t.sender) || "(no sender)";
    const subject = t.subject || "(no subject)";
    const chips = labelChips(t, mail.accountLabels.get(t.account) ?? []);
    const waiting = inWaiting() && !searchView;
    const days = daysSince(t.date);
    const due = waiting && days >= DUE_DAYS;
    const when = waiting ? (days < 1 ? "Today" : `${days} ${days === 1 ? "day" : "days"}`) : shortDate(t.date);
    const said = `${t.unread ? "Unread. " : ""}${t.starred ? "Pinned. " : ""}${name}. ${subject}. ${when}`;
    const label = multi() ? `${said}. ${accountName(t.account)}` : said;
    const on = picked.has(t.id);
    const role = editing && !searchView ? `role="checkbox" aria-checked="${on}"` : `role="button"`;
    // Below the preview, one line for small extras: label chips, Waiting's Nudge and Drop it, and later more (codes).
    const extras = [
      ...(due
        ? [
            `<button type="button" class="m-pill m-pill-go" data-row-act="nudge">Nudge</button>`,
            `<button type="button" class="m-pill" data-row-act="drop">Drop it</button>`,
          ]
        : []),
      ...chips.slice(0, 3),
    ];
    return `<li class="m-row${t.unread ? " unread" : ""}${due ? " due" : ""}${on ? " picked" : ""}" data-id="${esc(t.id)}">
      <div class="m-swipe" aria-hidden="true"><i></i><span></span></div>
      <div class="m-row-body" ${role} tabindex="0" aria-label="${esc(label)}">
        <span class="m-check" aria-hidden="true">${icon("check")}</span>
        ${settings.appearance.showAvatars ? `<span class="m-ava${ring}">${avatar(t.sender)}</span>` : ""}
        <span class="m-row-main">
          <span class="m-row-top"><span class="m-from">${esc(name)}${t.count > 1 ? `<em>${t.count}</em>` : ""}</span>${t.starred ? icon("push-pin") : ""}<time>${esc(when)}</time></span>
          <span class="m-preview">${waiting ? "You: " : ""}<b>${esc(subject)}</b> <span>${esc(decodeEntities(t.snippet))}</span></span>
          ${extras.length ? `<span class="m-chips">${extras.join("")}</span>` : ""}
        </span>
      </div>
    </li>`;
  }

  function emptyState() {
    if (mail.search) return ["magnifying-glass", `No results for “${mail.search}”`, "Try other words, or a sender's name."];
    const name = boxName(mail.mailbox);
    const why: Record<string, [string, string]> = {
      INBOX: ["Inbox zero", "New mail shows up here."],
      SCHEDULED: ["Nothing scheduled", "Emails you send later wait here until they go."],
      DRAFT: ["No drafts", "Emails you start and don't send are kept here."],
      TRASH: ["Trash is empty", "Deleted mail stays here for 30 days."],
      SPAM: ["No spam", "Mail that looks like spam lands here."],
      STARRED: ["Nothing pinned", "Pin a conversation to keep it here."],
    };
    const [title, text] = why[mail.mailbox ?? ""] ?? [`No mail in ${name}`, "Conversations with this label show up here."];
    return [SYSTEM.find(([s]) => s === mail.mailbox)?.[2] ?? "tag", title, text];
  }

  /** A finger on a row (swiping or holding): redraws wait until it lets go, so the row stays under it. */
  let touching = false;
  let redrawLater = false;
  function letGo() {
    touching = false;
    if (redrawLater) {
      redrawLater = false;
      renderList();
    }
  }

  /** Draws the list on screen: the search results while searching, otherwise the mailbox. */
  function renderList() {
    if (touching) return void (redrawLater = true);
    if (searchView) return renderResults();
    if (!list) return;
    if (!editing) list.setTitle(boxName(mail.mailbox));
    const ul = list.content.querySelector<HTMLElement>(".m-list")!;
    syncListTools();
    if (!mail.threads.length) {
      if (!loaded) return void (ul.innerHTML = "");
      const [glyph, title, text] = emptyState();
      ul.innerHTML = `<li class="m-empty">${icon(glyph)}<strong>${esc(title)}</strong><span>${esc(text)}</span></li>`;
      return;
    }
    const visible = mail.threads.slice(0, drawn);
    const head = (title: string, glyph = "") =>
      `<li class="m-section" role="presentation">${glyph ? icon(glyph) : ""}${title}</li>`;
    if (mail.smartInbox()) {
      ul.innerHTML = SECTIONS.map(([key, title, glyph]) => {
        const rows = visible.filter((t) => mail.sectionOf(t) === key);
        return rows.length ? head(title, glyph) + rows.map(rowHtml).join("") : "";
      }).join("");
      return;
    }
    let last = "";
    ul.innerHTML = visible
      .map((t) => {
        const group =
          mail.mailbox === "SCHEDULED" ? "" : mail.pinnedFirst() && t.starred ? "Pinned" : dateGroup(t.date);
        const h = group && group !== last ? head(group, group === "Pinned" ? "push-pin" : "") : "";
        last = group;
        return h + rowHtml(t);
      })
      .join("");
  }

  /** The line over the title: the day and what's new, how many are waiting on others, or that mail is being checked. */
  function setStatus() {
    const s = list?.el.querySelector(".m-eyebrow");
    if (!s) return;
    const unread = mail.threads.filter((t) => t.unread).length;
    const people = new Set(mail.threads.map((t) => bareEmail(t.sender))).size;
    const day = new Date().toLocaleDateString(undefined, { weekday: "long" });
    s.textContent = editing
      ? boxName(mail.mailbox)
      : syncing
      ? "Checking for mail…"
      : inWaiting()
        ? people
          ? `${people} ${people === 1 ? "person owes" : "people owe"} you a reply`
          : "Nobody owes you a reply"
        : unread
          ? `${day} · ${unread} new`
          : day;
  }

  /** The link by the title: Inbox to Waiting (once there's a Waiting label), Waiting to Sent. */
  function syncJump() {
    const jump = list?.el.querySelector<HTMLButtonElement>(".m-jump");
    if (!jump) return;
    const waiting = waitingLabel();
    const to = mail.mailbox === "INBOX" && waiting ? waiting : inWaiting() ? { id: "SENT", name: "Sent" } : null;
    jump.hidden = !to || editing;
    if (!to) return;
    jump.dataset.box = to.id;
    jump.innerHTML = `${esc(to.name)} ${icon("arrow-right")}`;
  }

  /** The list's bars: Edit where it applies, and Empty Trash or Empty Spam in those two. */
  function syncListTools() {
    if (!list) return;
    syncJump();
    setStatus();
    const el = list.el;
    const edit = el.querySelector<HTMLButtonElement>("[data-act=edit]")!;
    edit.hidden = mail.mailbox === "SCHEDULED" || editing;
    const accts = el.querySelector<HTMLButtonElement>("[data-act=accounts]")!;
    accts.hidden = !multi() || editing;
    if (multi()) {
      accts.innerHTML = `<span class="acct-stack">${inView().map(accountAv).join("")}</span>`;
      accts.setAttribute("aria-label", `Accounts: ${mail.scope ? accountName(mail.scope[0]) : "All"}`);
    }
    edit.disabled = !editing && !mail.threads.length;
    const banner = el.querySelector<HTMLElement>(".m-banner")!;
    const box = mail.mailbox === "TRASH" || mail.mailbox === "SPAM" ? boxName(mail.mailbox) : null;
    banner.hidden = !box || !mail.threads.length || !!mail.search;
    if (box) {
      banner.querySelector("span")!.textContent =
        box === "Trash" ? "Emails in Trash are deleted after 30 days." : "Emails in Spam are deleted after 30 days.";
      banner.querySelector("button")!.textContent = `Empty ${box} Now`;
    }
  }

  // ---- Rows: tap, swipe and long press, in the mailbox list and the search results alike

  function wireRows(ul: HTMLElement, page: Page) {
    let suppressTap = false;
    const tap = (e: Event) => {
      if (suppressTap) return void (suppressTap = false);
      const li = (e.target as Element).closest<HTMLElement>(".m-row");
      const id = li?.dataset.id;
      if (!id) return;
      const rowAct = (e.target as Element).closest<HTMLElement>("[data-row-act]")?.dataset.rowAct;
      const t = mail.threads.find((x) => x.id === id);
      if (rowAct && t) return void (rowAct === "nudge" ? replyFromList(t, "reply") : dropWaiting(t));
      if (editing && page === list && !searchView) {
        if (picked.has(id)) picked.delete(id);
        else picked.add(id);
        return syncEdit();
      }
      void openRow(id);
    };
    ul.addEventListener("click", tap);
    ul.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && (e.target as Element).matches(".m-row-body")) {
        e.preventDefault();
        tap(e);
      }
    });

    // Row swipes: the row slides over a strip in the colour of the action it will run, with its icon, which grows
    // (with a tap of feedback) once letting go would run it. Archive and delete slide the row away; the others spring
    // back. A move counts once it passes SLOP: mostly sideways makes it a swipe, otherwise the list scrolls. Holding
    // still instead opens the row's menu.
    ul.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" || e.clientX < 24 || touching) return;
      const li = (e.target as Element).closest<HTMLElement>(".m-row");
      if (!li || mail.mailbox === "SCHEDULED" || (editing && page === list)) return;
      const body = li.querySelector<HTMLElement>(".m-row-body")!;
      const strip = li.querySelector<HTMLElement>(".m-swipe")!;
      const at = Math.max(SWIPE_MIN, li.clientWidth * SWIPE_AT);
      const x0 = e.clientX;
      const y0 = e.clientY;
      let dx = 0;
      let swiping = false;
      let armed = false;
      touching = true;
      li.classList.add("pressing");
      const press = window.setTimeout(() => {
        done();
        letGo();
        suppressTap = true;
        setTimeout(() => (suppressTap = false), 600);
        const t = mail.threads.find((x) => x.id === li.dataset.id);
        if (!t) return;
        haptic("medium");
        rowMenu(t, li);
      }, PRESS_MS);
      const move = (ev: PointerEvent) => {
        const mx = ev.clientX - x0;
        const my = ev.clientY - y0;
        if (!swiping) {
          if (Math.hypot(mx, my) < SLOP) return;
          if (Math.abs(mx) < Math.abs(my) * 1.3) {
            done();
            return letGo();
          }
          swiping = true;
          clearTimeout(press);
          li.classList.remove("pressing");
          li.setPointerCapture(ev.pointerId);
        }
        // Measured from where the swipe was recognised, so the row doesn't jump by the slop.
        dx = mx - Math.sign(mx) * SLOP;
        const action = dx < 0 ? settings.swipes.left : settings.swipes.right;
        if (action === "none") dx = Math.sign(dx) * Math.min(Math.abs(dx), 24);
        body.style.transform = `translateX(${dx}px)`;
        li.dataset.swipe = action;
        li.dataset.side = dx < 0 ? "left" : "right";
        strip.querySelector("i")!.className = action === "none" ? "" : swipeIcon(action, li);
        strip.querySelector("span")!.textContent = action === "none" ? "" : SWIPES[action][0];
        const now = action !== "none" && Math.abs(dx) > at;
        if (now !== armed) haptic("light");
        armed = now;
        li.classList.toggle("armed", now);
      };
      const up = () => {
        done();
        if (!swiping) return letGo();
        suppressTap = true;
        setTimeout(() => (suppressTap = false), 400);
        const action = dx < 0 ? settings.swipes.left : settings.swipes.right;
        const t = mail.threads.find((x) => x.id === li.dataset.id);
        const go = t && armed;
        const asks = action === "trash" && (settings.general.confirmDelete || labelsOf(t!).includes("TRASH"));
        const away = go && ["archive", "trash", "spam"].includes(action) && !asks;
        const to = away ? Math.sign(dx) * li.clientWidth : 0;
        const anim = body.animate([{ transform: `translateX(${dx}px)` }, { transform: `translateX(${to}px)` }], {
          duration: away ? 240 : 380,
          easing: away ? "cubic-bezier(0.4, 0, 1, 1)" : "cubic-bezier(0.32, 0.72, 0, 1)",
          fill: "forwards",
        });
        body.style.transform = "";
        void anim.finished.then(() => {
          if (!away || !li.isConnected) {
            anim.cancel();
            li.classList.remove("armed");
            delete li.dataset.swipe;
          }
          letGo();
          if (go) void act(action, [t]);
        });
      };
      const done = () => {
        clearTimeout(press);
        li.classList.remove("pressing");
        li.removeEventListener("pointermove", move);
        li.removeEventListener("pointerup", up);
        li.removeEventListener("pointercancel", cancel);
      };
      // The system took the touch (a scroll began, a call came in): the row goes back, nothing runs.
      const cancel = () => {
        if (!swiping) {
          done();
          return letGo();
        }
        dx = Math.sign(dx) * Math.min(Math.abs(dx), at - 1);
        armed = false;
        up();
      };
      li.addEventListener("pointermove", move);
      li.addEventListener("pointerup", up);
      li.addEventListener("pointercancel", cancel);
    });
  }

  function wireScroll(page: Page) {
    const sc = page.scroller;
    sc.addEventListener(
      "scroll",
      () => {
        if (sc.scrollTop + sc.clientHeight < sc.scrollHeight - 600 || mail.search) return;
        if (drawn < mail.threads.length) {
          drawn += PAGE;
          return renderList();
        }
        void mail.loadMore();
      },
      { passive: true },
    );

    // Pull to refresh rides on the scroll view's own bounce: pulled far enough past the top, letting go checks for
    // mail, with the spinner holding the list down until it's done.
    const pull = sc.querySelector<HTMLElement>(".m-pull")!;
    let armed = false;
    sc.addEventListener(
      "scroll",
      () => {
        const over = Math.max(0, -sc.scrollTop);
        pull.style.setProperty("--pull", String(Math.min(1, over / PULL_AT)));
        if (over > PULL_AT && !armed && !editing) {
          armed = true;
          pull.classList.add("armed");
          haptic("light");
        }
      },
      { passive: true },
    );
    sc.addEventListener("touchend", () => {
      if (!armed) return;
      armed = false;
      pull.classList.remove("armed");
      void refreshNow(pull);
    });
  }

  function swipeIcon(action: Exclude<SwipeAction, "none">, li: HTMLElement) {
    if (action === "unread" && mail.threads.find((x) => x.id === li.dataset.id)?.unread)
      return iconClass("envelope-simple-open");
    return iconClass(SWIPES[action][1]);
  }

  async function refreshNow(pull: HTMLElement) {
    if (pull.classList.contains("spinning")) return;
    pull.classList.add("spinning");
    await invoke("sync_now").catch((e) => toast(String(e), { kind: "error" }));
    setTimeout(() => pull.classList.remove("spinning"), 400);
  }

  async function openRow(id: string) {
    if (mail.mailbox === "SCHEDULED" && !mail.search) return host.editScheduled(id);
    if (searchView && mail.search) rememberSearch(mail.search);
    const t = mail.threads.find((x) => x.id === id);
    if ((mail.mailbox === "DRAFT" || t?.labels.split(" ").includes("DRAFT")) && (await host.openDraft(id))) return;
    openConversation(id);
  }

  // ---- Edit mode

  function setEditing(on: boolean) {
    if (!list) return;
    editing = on;
    picked.clear();
    const el = list.el;
    el.classList.toggle("m-editing", on);
    el.querySelector<HTMLElement>(".m-dock")!.hidden = on;
    syncListTools();
    el.querySelector<HTMLElement>(".m-edit-tools")!.hidden = !on;
    syncEdit();
  }

  /** The title, Select All and the toolbar follow what's picked. */
  function syncEdit() {
    if (!list) return;
    const el = list.el;
    for (const id of picked) if (!mail.threads.some((t) => t.id === id)) picked.delete(id);
    const all = el.querySelector<HTMLElement>("[data-act=select-all]")!;
    all.hidden = !editing;
    el.querySelector<HTMLElement>("[data-act=done]")!.hidden = !editing;
    el.querySelector<HTMLElement>(".m-back")!.classList.toggle("m-gone", editing);
    all.textContent = picked.size && picked.size === mail.threads.length ? "Deselect all" : "Select all";
    list.setTitle(editing ? (picked.size ? `${picked.size} selected` : "Select emails") : boxName(mail.mailbox));
    const none = !picked.size;
    el.querySelectorAll<HTMLButtonElement>("[data-edit]").forEach((b) => (b.disabled = none));
    const ts = pickedThreads();
    el.querySelector<HTMLButtonElement>("[data-edit=archive]")!.disabled = !ts.some((t) => labelsOf(t).includes("INBOX"));
    renderList();
  }

  const pickedThreads = () => mail.threads.filter((t) => picked.has(t.id));

  function editAction(action: string) {
    const ts = pickedThreads();
    if (!ts.length) return;
    const finish = () => setEditing(false);
    switch (action) {
      case "mark":
        return markSheet(ts, finish);
      case "move":
        return moveSheet(ts, finish);
      case "label":
        return labelSheet(ts, finish);
      default:
        return void act(action, ts).then((ok) => ok && finish());
    }
  }

  // ---- Actions

  /** Takes threads off the list; if the open one goes, shows the next (or goes back when there's none). */
  function removeAll(ts: Thread[]) {
    if (!ts.length) return;
    const gone = new Set(ts.map((t) => t.id));
    const i = mail.threads.findIndex((x) => x.id === convo?.id);
    mail.threads = mail.threads.filter((x) => !gone.has(x.id));
    gone.forEach((id) => picked.delete(id));
    if (convo && gone.has(convo.id)) {
      const next = mail.threads[Math.min(i, mail.threads.length - 1)];
      if (next) showConversation(next.id);
      else void stack.pop();
    }
    renderList();
  }

  const undoToast = (msg: string) =>
    toast(msg, {
      kind: "success",
      action: {
        label: "Undo",
        run: () => void (mail.undo() ? toast("Undone", { kind: "success" }) : toast("Nothing to undo")),
      },
    });

  /** Whether a change takes a thread out of the list on screen. */
  function leaves(c: Change) {
    const away = c.add.includes("TRASH") || c.add.includes("SPAM");
    if (mail.search || mail.mailbox === null) return away;
    return c.remove.includes(mail.mailbox) || (away && mail.mailbox !== "TRASH" && mail.mailbox !== "SPAM");
  }

  /** Label changes that can be undone: the list shows them at once, then the core sends them. */
  function change(changes: Change[], msg: string, trash = false) {
    if (!changes.length) return;
    changes.forEach(relabel);
    removeAll(changes.filter(leaves).map((c) => c.t));
    void mail.undoableChanges(changes, trash);
    undoToast(msg);
  }

  /** Runs an action on one or more threads; false when it was cancelled. */
  async function act(action: string, ts: Thread[]): Promise<boolean> {
    const n = ts.length;
    const many = n > 1 ? ` ${emails(n)}` : "";
    switch (action) {
      case "archive":
        change(changesFor(ts, [], ["INBOX"]).filter((c) => c.remove.length), n > 1 ? `Archived${many}` : "Archived");
        return true;
      case "trash": {
        if (ts.every((t) => labelsOf(t).includes("TRASH"))) {
          const yes = await confirmSheet({
            title: n > 1 ? `Delete${many} forever?` : "Delete forever?",
            message: `${n > 1 ? "They're" : "It's"} deleted ${inMail()} too. This can't be undone.`,
            confirm: "Delete Forever",
          });
          if (!yes) return false;
          removeAll(ts);
          void mail.deleteForever(ts);
          toast(n > 1 ? `Deleted${many} forever` : "Deleted forever", { kind: "success" });
          return true;
        }
        if (settings.general.confirmDelete) {
          const yes = await confirmSheet({
            title: n > 1 ? `Delete${many}?` : "Delete this email?",
            message:
              n > 1 ? "They'll move to Trash." : `“${ts[0].subject || "(no subject)"}” will move to Trash.`,
            confirm: "Delete",
          });
          if (!yes) return false;
        }
        change(changesFor(ts, ["TRASH"], ["INBOX", "SPAM"]), n > 1 ? `Moved${many} to Trash` : "Moved to Trash", true);
        return true;
      }
      case "spam": {
        const back = ts.every((t) => labelsOf(t).includes("SPAM"));
        if (back) change(changesFor(ts, ["INBOX"], ["SPAM"]), "Not spam: moved to Inbox");
        else change(changesFor(ts, ["SPAM"], ["INBOX", "TRASH"]), n > 1 ? `Marked${many} as spam` : "Marked as spam");
        return true;
      }
      case "read":
      case "unread": {
        const read = action === "read" || (n === 1 && ts[0].unread);
        void mail.applyChanges(ts.map((t) => ({ t, add: read ? [] : ["UNREAD"], remove: read ? ["UNREAD"] : [] })));
        return true;
      }
      case "pin":
      case "unpin":
      case "star": {
        const pin = action === "pin" || (action === "star" && ts.some((t) => !t.starred));
        void mail.applyChanges(ts.map((t) => ({ t, add: pin ? ["STARRED"] : [], remove: pin ? [] : ["STARRED"] })));
        return true;
      }
    }
    return false;
  }

  /** Every label of the accounts these threads belong to, once per name (ids differ between accounts). */
  function labelsFor(ts: Thread[]) {
    const byName = new Map<string, Label>();
    for (const a of new Set(ts.map((t) => t.account)))
      for (const l of mail.accountLabels.get(a) ?? []) if (!byName.has(l.name)) byName.set(l.name, l);
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }
  const labelIn = (name: string) => (account: string) =>
    mail.accountLabels.get(account)?.find((l) => l.name === name)?.id;

  function moveTo(ts: Thread[], target: string) {
    if (target === "TRASH") return void act("trash", ts);
    if (target === "SPAM") return void act("spam", ts);
    const name = target.startsWith("label:") ? target.slice(6) : null;
    const changes = name ? moveChanges(ts, target, labelIn(name)) : moveChanges(ts, target);
    // From a label, moving to another one takes it out of this one, like Gmail's Move to.
    const here = mail.mailbox && !SYSTEM.some(([id]) => id === mail.mailbox) && !mail.search ? mail.mailbox : null;
    if (here) for (const c of changes) if (!c.add.includes(here) && labelsOf(c.t).includes(here)) c.remove.push(here);
    const to = name ?? boxName(target);
    const n = ts.length > 1 ? ` ${emails(ts.length)}` : "";
    change(
      changes.filter((c) => c.add.length || c.remove.length),
      target === "ARCHIVE" ? `Archived${n}` : `Moved${n} to ${to}`,
    );
  }

  function moveSheet(ts: Thread[], then = () => {}) {
    const every = (l: string) => ts.every((t) => labelsOf(t).includes(l));
    const mailboxes: Choice[] = [
      { id: "INBOX", label: "Inbox", icon: "tray", disabled: every("INBOX") },
      {
        id: "ARCHIVE",
        label: "Archive",
        icon: "archive",
        disabled: ts.every((t) => !FOLDERS.some((f) => labelsOf(t).includes(f))),
      },
      { id: "SPAM", label: "Spam", icon: "warning-octagon", disabled: every("SPAM") },
      { id: "TRASH", label: "Trash", icon: "trash", disabled: every("TRASH") },
    ];
    const labels = labelsFor(ts).map(
      (l): Choice => ({
        id: `label:${l.name}`,
        label: l.name,
        color: l.color,
        disabled: ts.every((t) => {
          const id = labelIn(l.name)(t.account);
          return !id || (labelsOf(t).includes(id) && !FOLDERS.some((f) => labelsOf(t).includes(f)));
        }),
      }),
    );
    listSheet({
      title: ts.length > 1 ? `Move ${emails(ts.length)}` : "Move to",
      groups: [{ items: mailboxes }, ...(labels.length ? [{ title: "Labels", items: labels }] : [])],
      pick: (id) => {
        moveTo(ts, id);
        then();
      },
    });
  }

  function labelSheet(ts: Thread[], then = () => {}) {
    const labels = labelsFor(ts);
    if (!labels.length) return toast("No labels yet. Add them on your Mac or in Gmail.");
    let changed = false;
    const d = listSheet({
      title: ts.length > 1 ? `Label ${emails(ts.length)}` : "Labels",
      toggle: true,
      groups: [
        {
          items: labels.map((l) => ({
            id: l.name,
            label: l.name,
            color: l.color,
            state: labelToggle(ts, labelIn(l.name)).state,
          })),
        },
      ],
      pick: (name) => {
        const { changes } = labelToggle(ts, labelIn(name));
        changes.forEach(relabel);
        void mail.applyChanges(changes);
        changed = true;
        renderList();
        syncConvoTools();
        return labelToggle(ts, labelIn(name)).state;
      },
    });
    d.addEventListener("close", () => changed && then());
  }

  function markSheet(ts: Thread[], then: () => void) {
    const run = (action: string) => () => void act(action, ts).then((ok) => ok && then());
    const inSpam = ts.every((t) => labelsOf(t).includes("SPAM"));
    actionSheet(emails(ts.length), [
      { label: "Mark as Read", icon: "envelope-simple-open", disabled: !ts.some((t) => t.unread), run: run("read") },
      { label: "Mark as Unread", icon: "envelope-simple", disabled: ts.every((t) => t.unread), run: run("unread") },
      { label: "Pin", icon: "push-pin", disabled: ts.every((t) => t.starred), run: run("pin") },
      { label: "Unpin", icon: "pinned-off", disabled: !ts.some((t) => t.starred), run: run("unpin") },
      { label: inSpam ? "Not Spam" : "Report Spam", icon: "warning-octagon", run: run("spam") },
    ]);
  }

  /** The accounts in view, from the avatars by the list's title. */
  function accountSheet() {
    const one = mail.scope?.length === 1 ? mail.scope[0] : null;
    const show = (scope: string[] | null) => () => {
      mail.setScope(scope);
      mail.openMailbox(mail.mailbox);
      renderBoxes();
    };
    actionSheet("Show mail from", [
      { label: "All accounts", icon: "users", checked: !mail.scope, run: show(null) },
      ...mail.accounts.map((a) => ({ label: accountName(a), icon: "user-circle", checked: one === a, run: show([a]) })),
    ]);
  }

  async function emptyBox() {
    const id = mail.mailbox;
    if (id !== "TRASH" && id !== "SPAM") return;
    const name = boxName(id);
    const n = inView().length;
    const where = n < 2 ? "" : n === 2 ? " in both accounts" : ` in all ${n} accounts`;
    const yes = await confirmSheet({
      title: `Empty ${name}?`,
      message: `Everything in ${name}${where} is deleted for good, ${inMail()} too. This can't be undone.`,
      confirm: `Empty ${name}`,
    });
    if (!yes) return;
    try {
      await mail.emptyMailbox(id);
      if (mail.mailbox === id) removeAll([...mail.threads]);
      toast(`${name} emptied`, { kind: "success" });
    } catch (e) {
      toast(`Couldn't empty ${name}: ${e}`, { kind: "error" });
    }
  }

  /** Waiting's Drop it: stop waiting on this conversation (takes its Waiting label off), with Undo. */
  function dropWaiting(t: Thread) {
    const name = waitingLabel()?.name;
    const id = name && labelIn(name)(t.account);
    if (id) change(changesFor([t], [], [id]), "No longer waiting");
  }

  /** Reply, Reply All or Forward from the list, without opening the conversation. */
  async function replyFromList(t: Thread, kind: ReplyKind) {
    try {
      const messages = await mail.loadMessages(t.account, t.id);
      mail.selected = t.id;
      mail.messages = messages;
      await host.reply(kind, messages.at(-1));
    } catch (e) {
      toast(`Couldn't open this email: ${e}`, { kind: "error" });
    } finally {
      if (!convo) mail.closeThread();
    }
  }

  /** The long-press menu of a row. */
  function rowMenu(t: Thread, row: HTMLElement) {
    const has = labelsOf(t);
    const draft = mail.mailbox === "DRAFT";
    const inTrash = has.includes("TRASH");
    const inSpam = has.includes("SPAM");
    const one = [t];
    const run = (action: string) => () => void act(action, one);
    contextMenu(row, t.subject || "(no subject)", [
      draft
        ? []
        : [
            { label: "Reply", icon: "arrow-bend-up-left", run: () => void replyFromList(t, "reply") },
            { label: "Reply All", icon: "arrow-bend-double-up-left", run: () => void replyFromList(t, "all") },
            { label: "Forward", icon: "arrow-bend-up-right", run: () => void replyFromList(t, "forward") },
          ],
      [
        t.unread
          ? { label: "Mark as Read", icon: "envelope-simple-open", run: run("read") }
          : { label: "Mark as Unread", icon: "envelope-simple", run: run("unread") },
        t.starred
          ? { label: "Unpin", icon: "pinned-off", run: run("unpin") }
          : { label: "Pin", icon: "push-pin", run: run("pin") },
        { label: "Move…", icon: "folder", run: () => moveSheet(one) },
        { label: "Label…", icon: "tag", run: () => labelSheet(one) },
      ],
      [
        ...(has.includes("INBOX") ? [{ label: "Archive", icon: "archive", run: run("archive") }] : []),
        ...(inTrash || inSpam ? [] : [{ label: "Report Spam", icon: "warning-octagon", run: run("spam") }]),
        inSpam
          ? { label: "Not Spam", icon: "tray", run: run("spam") }
          : { label: inTrash ? "Delete Forever" : "Delete", icon: "trash", danger: true, run: run("trash") },
      ],
    ]);
  }

  // ---- Search

  type SearchView = { page: Page; input: HTMLInputElement; ul: HTMLElement; status: HTMLElement };
  let searchView: SearchView | null = null;
  let recent = loadRecent();
  let senders: string[] = [];
  let searchSeq = 0;
  let searching = false;
  let localTimer = 0;
  let remoteTimer = 0;

  function rememberSearch(q: string) {
    recent = remember(recent, q);
    saveRecent(recent);
  }

  /** The search screen: over the list, with recent searches until something is typed, then results as you type. */
  function openSearch() {
    if (searchView || !list) return;
    if (editing) setEditing(false);
    const page = stack.page("Search", "m-search-page");
    page.bar.insertAdjacentHTML(
      "beforeend",
      `<form class="m-search-bar" role="search">
        <label class="m-search">${icon("magnifying-glass")}<input type="search" placeholder="Search mail" aria-label="Search mail" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" /><button type="button" class="m-search-clear" aria-label="Clear search" hidden>${icon("circle-x")}</button></label>
        <button type="button" class="m-text" data-act="cancel">Cancel</button>
      </form>`,
    );
    page.content.innerHTML = `<div class="m-search-help"></div><p class="m-search-status" aria-live="polite"></p><ul class="m-list" aria-label="Results"></ul>`;
    const input = page.bar.querySelector<HTMLInputElement>("input")!;
    const view: SearchView = {
      page,
      input,
      ul: page.content.querySelector(".m-list")!,
      status: page.content.querySelector(".m-search-status")!,
    };
    searchView = view;
    const clear = page.bar.querySelector<HTMLButtonElement>(".m-search-clear")!;

    input.addEventListener("input", () => {
      clear.hidden = !input.value;
      typed(input.value.trim());
    });
    clear.addEventListener("click", () => {
      input.value = "";
      clear.hidden = true;
      typed("");
      input.focus();
    });
    page.bar.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault();
      const q = input.value.trim();
      input.blur();
      if (!q) return;
      rememberSearch(q);
      void runSearch(q, true);
    });
    page.bar.querySelector("[data-act=cancel]")!.addEventListener("click", () => void closeSearch());
    page.content.addEventListener("click", (e) => {
      const b = (e.target as Element).closest<HTMLElement>("[data-query], [data-clear-recent]");
      if (!b) return;
      if (b.dataset.clearRecent !== undefined) {
        recent = [];
        saveRecent(recent);
        return renderResults();
      }
      input.value = b.dataset.query!;
      clear.hidden = false;
      input.blur();
      rememberSearch(input.value);
      void runSearch(input.value, true);
    });
    wireRows(view.ul, page);
    page.onClose = () => {
      if (searchView !== view) return;
      searchView = null;
      searchSeq++;
      clearTimeout(localTimer);
      clearTimeout(remoteTimer);
      senders = [];
      // Back to the mailbox as it was; its rows weren't redrawn meanwhile, so the scroll position is still there.
      mail.search = null;
      mail.refresh();
    };
    renderResults();
    void stack.push(page, false);
    if (!settings.accessibility.reduceMotion) page.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
    input.focus();
  }

  async function closeSearch() {
    const view = searchView;
    if (!view) return;
    view.input.blur();
    if (!settings.accessibility.reduceMotion)
      await view.page.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: "forwards" }).finished;
    if (list) stack.popTo(list);
  }

  /** Each keystroke: the cache's results and matching senders straight away, then Gmail once typing pauses. */
  function typed(q: string) {
    clearTimeout(localTimer);
    clearTimeout(remoteTimer);
    const n = ++searchSeq;
    if (!q) {
      senders = [];
      searching = false;
      mail.showResults("", []);
      mail.search = null;
      return renderResults();
    }
    localTimer = window.setTimeout(() => void searchLocal(q, n), LOCAL_AFTER);
    remoteTimer = window.setTimeout(() => void runSearch(q, false, n), REMOTE_AFTER);
  }

  async function searchLocal(q: string, n: number) {
    const [rows, found] = await Promise.all([
      invoke<Thread[]>("search_local", { query: q, accounts: mail.scope }).catch(() => [] as Thread[]),
      q.includes("from:")
        ? Promise.resolve([] as string[])
        : invoke<string[]>("suggest_senders", { query: q, accounts: mail.scope }).catch(() => [] as string[]),
    ]);
    if (n !== searchSeq || !searchView) return false;
    senders = found.slice(0, 3);
    mail.showResults(q, rows);
    return true;
  }

  /** Gmail search in every account in view, through the core, which merges each account's results as they come. */
  async function runSearch(q: string, now: boolean, n = ++searchSeq) {
    if (now) {
      clearTimeout(localTimer);
      clearTimeout(remoteTimer);
      senders = [];
      if (!(await searchLocal(q, n))) return;
    }
    if (n !== searchSeq || !searchView) return;
    searching = true;
    renderResults();
    try {
      mail.search = q;
      await mail.loadThreads();
    } catch (e) {
      if (n === searchSeq) toast(`Some results may be missing: ${e}`);
    } finally {
      if (n === searchSeq) {
        searching = false;
        renderResults();
      }
    }
  }

  function renderResults() {
    const view = searchView;
    if (!view) return;
    const help = view.page.content.querySelector<HTMLElement>(".m-search-help")!;
    const q = view.input.value.trim();
    if (!q) {
      view.status.textContent = "";
      view.ul.innerHTML = "";
      help.innerHTML = recent.length
        ? `<div class="m-search-head"><h3 class="m-group-title" id="m-recent">Recent</h3><button type="button" class="m-text" data-clear-recent>Clear</button></div>
          <div class="m-group" role="group" aria-labelledby="m-recent">${recent
            .map(
              (r) =>
                `<button type="button" class="m-cell" data-query="${esc(r)}">${icon("history")}<span>${esc(r)}</span></button>`,
            )
            .join("")}</div>`
        : `<div class="m-empty">${icon("magnifying-glass")}<strong>Search your mail</strong><span>${esc(
            multi() && !mail.scope ? "Results come from all your accounts." : "Search by words, a sender or a subject.",
          )}</span></div>`;
      return;
    }
    help.innerHTML = senders.length
      ? `<h3 class="m-group-title" id="m-suggest">People</h3><div class="m-group" role="group" aria-labelledby="m-suggest">${senders
          .map(
            (s) =>
              `<button type="button" class="m-cell m-suggest" data-query="from:${esc(bareEmail(s))}" aria-label="${esc(`Mail from ${displayName(s) || bareEmail(s)}`)}"><span class="m-ava">${avatar(s)}</span><span><strong>${esc(displayName(s) || bareEmail(s))}</strong><small>${esc(bareEmail(s))}</small></span></button>`,
          )
          .join("")}</div>`
      : "";
    const shown = mail.search === q ? mail.threads : [];
    const where = multi() && !mail.scope ? " in all accounts" : "";
    view.status.textContent = searching
      ? `Searching ${inMail() === "in Gmail" ? "Gmail" : "your mail"}${where}…`
      : shown.length
        ? `${shown.length === 100 ? "100+" : shown.length} ${shown.length === 1 ? "result" : "results"}${where}`
        : "";
    if (!shown.length && !searching && mail.search === q) {
      const [glyph, title, text] = emptyState();
      view.ul.innerHTML = `<li class="m-empty">${icon(glyph)}<strong>${esc(title)}</strong><span>${esc(text)}</span></li>`;
      return;
    }
    view.ul.innerHTML = shown.map(rowHtml).join("");
  }

  // ---- Conversation

  /** `shown` settles once the page has slid in: emails (iframes) are drawn after that, so the slide stays smooth. */
  let convo: { id: string; page: Page; shown: Promise<void> } | null = null;

  function openConversation(id: string) {
    const page = stack.page("", "m-convo");
    page.end.innerHTML =
      barButton("prev", "caret-up", "Previous conversation") + barButton("next", "caret-down", "Next conversation");
    page.end.addEventListener("click", (e) => {
      const b = (e.target as Element).closest<HTMLElement>("[data-act]");
      const i = mail.threads.findIndex((t) => t.id === convo?.id);
      const next = mail.threads[i + (b?.dataset.act === "next" ? 1 : -1)];
      if (b && next) showConversation(next.id);
    });
    page.el.insertAdjacentHTML(
      "beforeend",
      `<footer class="m-dock m-convo-tools">
        <span class="m-dock-pill">${barButton("archive", "archive", "Archive")}${barButton("trash", "trash", "Delete")}${barButton("move", "folder", "Move")}${barButton("more", "dots", "More actions")}</span>
        <button type="button" class="m-fab" data-act="reply" aria-label="Reply">${icon("arrow-bend-up-left")}</button>
      </footer>`,
    );
    page.el.querySelector(".m-convo-tools")!.addEventListener("click", (e) => {
      const action = (e.target as Element).closest<HTMLElement>("[data-act]")?.dataset.act;
      const t = mail.threads.find((x) => x.id === convo?.id);
      if (!action || !t) return;
      if (action === "move") return moveSheet([t]);
      if (action === "more") return moreSheet(t);
      // Reply All and Forward are on each email's card.
      if (action === "reply") return void host.reply("reply");
      void act(action, [t]);
    });
    wireReader(page.content, mail, (kind, m) => host.reply(kind, m));
    page.onClose = () => {
      if (convo?.page !== page) return;
      convo = null;
      mail.closeThread();
      renderList();
    };
    convo = { id, page, shown: stack.push(page) };
    showConversation(id);
  }

  function moreSheet(t: Thread) {
    const has = labelsOf(t);
    const run = (action: string) => () => void act(action, [t]);
    const items: Item[] = [
      t.unread
        ? { label: "Mark as Read", icon: "envelope-simple-open", run: run("read") }
        : { label: "Mark as Unread", icon: "envelope-simple", run: run("unread") },
      t.starred
        ? { label: "Unpin", icon: "pinned-off", run: run("unpin") }
        : { label: "Pin", icon: "push-pin", run: run("pin") },
      { label: "Label…", icon: "tag", run: () => labelSheet([t]) },
    ];
    if (has.includes("SPAM")) items.push({ label: "Not Spam", icon: "tray", run: run("spam") });
    else if (has.includes("TRASH")) items.push({ label: "Move to Inbox", icon: "tray", run: () => moveTo([t], "INBOX") });
    else items.push({ label: "Report Spam", icon: "warning-octagon", run: run("spam") });
    actionSheet("", items);
  }

  /** Fills the open conversation page with thread `id` (opening, or moving to the next or previous one). */
  function showConversation(id: string) {
    if (!convo) return;
    const { page } = convo;
    convo.id = id;
    const t = mail.threads.find((x) => x.id === id);
    page.setTitle(t?.subject || "(no subject)");
    page.content.innerHTML = "";
    page.scroller.scrollTop = 0;
    syncConvoTools();
    const shown = convo.shown;
    mail
      .openThread(id, async (messages) => {
        await shown;
        if (convo?.id !== id) return;
        page.setTitle(messages[0]?.subject || t?.subject || "(no subject)");
        page.content.innerHTML = `<div class="m-chips"></div>`;
        renderMessages(page.content, messages, t?.account ?? mail.defaultAccount(), true);
        syncConvoTools();
        // The newest email is open at the bottom; start at the one before it, for context, like the Mac.
        const cards = page.content.querySelectorAll<HTMLElement>(".message");
        const anchor = cards[cards.length - 2];
        if (anchor) page.scroller.scrollTop = anchor.offsetTop - 8;
      })
      .catch((e) => {
        if (convo?.id === id) page.content.innerHTML = `<p class="m-error">${esc(String(e))}</p>`;
      });
  }

  function syncConvoTools() {
    if (!convo) return;
    const t = mail.threads.find((x) => x.id === convo!.id);
    const tools = convo.page.el;
    const i = mail.threads.findIndex((x) => x.id === convo!.id);
    tools.querySelector<HTMLButtonElement>("[data-act=prev]")!.disabled = i <= 0;
    tools.querySelector<HTMLButtonElement>("[data-act=next]")!.disabled = i < 0 || i >= mail.threads.length - 1;
    tools.querySelector<HTMLElement>("[data-act=archive]")!.hidden = !t?.labels.split(" ").includes("INBOX");
    const trash = tools.querySelector<HTMLElement>("[data-act=trash]")!;
    trash.setAttribute("aria-label", t && labelsOf(t).includes("TRASH") ? "Delete forever" : "Delete");
    const chips = convo.page.content.querySelector(".m-chips");
    if (chips && t) chips.innerHTML = labelChips(t, mail.accountLabels.get(t.account) ?? []).join("");
  }

  // ---- Wiring

  mail.subscribe((e) => {
    switch (e.type) {
      case "labels":
        renderBoxes();
        if (list && !editing) list.setTitle(boxName(mail.mailbox));
        return;
      case "threads":
        if (editing) syncEdit();
        else renderList();
        setStatus();
        return syncConvoTools();
      case "loaded": {
        loaded = true;
        renderList();
        const sc = list?.scroller;
        if (sc && !searchView && sc.scrollHeight <= sc.clientHeight) void mail.loadMore();
        return;
      }
      case "searching":
        return renderResults();
      case "refreshed": {
        const open = mail.threads.find((t) => t.id === convo?.id);
        if (open && open.count !== mail.messages.length) showConversation(open.id);
      }
    }
  });
  void listen<boolean>("syncing", (e) => {
    syncing = Math.max(0, syncing + (e.payload ? 1 : -1));
    setStatus();
  });
  onSettingsChange((path) => {
    if (path === "*" || path.startsWith("inbox.") || path === "accounts") mail.refresh();
    else if (path.startsWith("sidebar.") || path.startsWith("accounts.")) void mail.loadLabels();
    else if (path.startsWith("appearance.")) renderList();
  });

  /** Back to the Inbox at the top of the stack: on launch, and when accounts change. */
  function reset() {
    stack.popTo(boxes);
    if (!stack.pages.length) void stack.push(boxes);
    renderBoxes();
    openBox("INBOX", false);
  }

  /** A tapped new-mail notification: its conversation (or, for several emails, the Inbox) in a view with its account. */
  async function openFromNotification(p: Notified) {
    if (p.account && mail.scope && !mail.scope.includes(p.account)) mail.setScope(null);
    stack.popTo(boxes);
    renderBoxes();
    openBox("INBOX", false);
    await mail.loadThreads();
    if (p.thread && mail.threads.some((t) => t.id === p.thread)) openConversation(p.thread);
  }

  return { reset, openFromNotification };
}

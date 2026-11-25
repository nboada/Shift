// The iPhone interface: mailboxes → conversation list → conversation on a navigation stack, on the shared mail core.
// main.ts mounts it instead of the desktop panes and lends it the composer until the phone has its own sheet.
import "./mobile.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { type MailCore, type Message, type Thread, SECTIONS, SYSTEM } from "../core/mail";
import { ask } from "../dialog";
import {
  type ReplyKind,
  avatar,
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
} from "../email-view";
import { iconClass } from "../icons";
import { type SwipeAction, accountSettings, onSettingsChange, settings } from "../settings";
import { openSettings } from "../settings-ui";
import { arrange } from "../sidebar";
import { toast } from "../toast";
import { type Page, barButton, createStack } from "./stack";

export type PhoneHost = {
  mail: MailCore;
  compose: () => void;
  reply: (kind: ReplyKind, m?: Message) => void;
  /** Reopens a draft in the composer; false when it isn't one after all. */
  openDraft: (id: string) => Promise<boolean>;
  editScheduled: (id: string) => void;
};

/** Rows drawn at a time; more as the list nears its end. */
const PAGE = 60;
/** How far a row slides before letting go runs its swipe action. */
const SWIPE_AT = 80;
/** How far the list is pulled down past its top before letting go checks for mail. */
const PULL_AT = 70;

const SWIPES: Record<Exclude<SwipeAction, "none">, [label: string, icon: string]> = {
  archive: ["Archive", "archive"],
  trash: ["Delete", "trash"],
  unread: ["Unread", "envelope-simple"],
  star: ["Pin", "push-pin"],
  spam: ["Spam", "warning-octagon"],
};
/** Gmail labels that act as folders: mail sits in at most one, and Archive is none of them. */
const FOLDERS = ["INBOX", "SPAM", "TRASH"];

/** Icons are decoration here: every control already has a name, so VoiceOver skips the glyph. */
const icon = (name: string) => `<i class="${iconClass(name)}" aria-hidden="true"></i>`;

type Item = { label: string; icon: string; run: () => void; danger?: boolean; disabled?: boolean; checked?: boolean };

export function mountPhone(host: PhoneHost) {
  const { mail } = host;
  document.documentElement.classList.add("phone-ui");
  const root = document.createElement("div");
  root.className = "phone";
  document.body.append(root);
  const stack = createStack(root);

  const multi = () => mail.accounts.length > 1;
  const accountName = (a: string) => accountSettings(a).title || a;
  const boxName = (id: string | null) =>
    SYSTEM.find(([s]) => s === id)?.[1] ?? mail.userLabels.find((l) => l.id === id)?.name ?? "Mail";
  const listTitle = () => (mail.search ? "Search" : boxName(mail.mailbox));

  // ---- Mailboxes

  const boxes = stack.page("Mailboxes", "m-boxes");
  boxes.end.innerHTML = barButton("settings", "gear-six", "Settings");
  boxes.end.addEventListener("click", () => openSettings());

  function renderBoxes() {
    labelColorCss(mail.labels.map((l) => l.color ?? ""));
    const unread = new Map(mail.labels.map((l) => [l.id, l.unread]));
    const badge = settings.inbox.unreadBadge;
    const row = (id: string | null, name: string, glyph: string, count = 0, color?: string | null) =>
      `<button type="button" class="m-cell" data-box="${esc(id ?? "")}" aria-label="${esc(count ? `${name}, ${count} unread` : name)}">
        ${glyph ? icon(glyph) : labelDot(name, color ?? null)}<span>${esc(name)}</span>${count ? `<small>${count}</small>` : ""}${icon("caret-right")}</button>`;
    const { order, hidden } = settings.sidebar;
    const system = arrange(SYSTEM, ([id]) => id ?? "ALL", order, hidden).map(([id, name, glyph]) =>
      row(id, name, glyph, badge && id === "INBOX" ? unread.get(id) : 0),
    );
    const labels = arrange(mail.userLabels, (l) => l.id, order, hidden).map((l) =>
      row(l.id, l.name, "", badge ? l.unread : 0, l.color),
    );
    const one = mail.scope?.length === 1 ? mail.scope[0] : null;
    const pick = (id: string, name: string, lead: string, on: boolean) =>
      `<button type="button" class="m-cell" data-scope="${esc(id)}" role="radio" aria-checked="${on}">${lead}<span>${esc(name)}</span>${on ? icon("check") : ""}</button>`;
    const accounts = multi()
      ? `<h3 class="m-group-title" id="m-accounts">Accounts</h3><div class="m-group" role="radiogroup" aria-labelledby="m-accounts">${pick("", "All accounts", icon("users"), !mail.scope)}${mail.accounts
          .map((a) =>
            pick(a, accountName(a), `<span class="account-dot acct-${accountSettings(a).color}"></span>`, one === a),
          )
          .join("")}</div>`
      : "";
    boxes.content.innerHTML =
      accounts +
      `<div class="m-group">${system.join("")}</div>` +
      (labels.length ? `<h3 class="m-group-title">Labels</h3><div class="m-group">${labels.join("")}</div>` : "");
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

  function openBox(id: string | null, animate = true) {
    if (id !== mail.mailbox || mail.search) mail.openMailbox(id);
    loaded = false;
    drawn = PAGE;
    list = stack.page(boxName(id), "m-list-page");
    const page = list;
    page.content.innerHTML = `<form class="m-search" role="search">${icon("magnifying-glass")}<input type="search" placeholder="Search" aria-label="Search mail" autocomplete="off" spellcheck="false" enterkeyhint="search" /></form>
      <ul class="m-list" aria-label="Conversations"></ul>`;
    page.scroller.insertAdjacentHTML(
      "afterbegin",
      `<div class="m-pull" aria-hidden="true">${icon("arrows-clockwise")}</div>`,
    );
    page.el.insertAdjacentHTML(
      "beforeend",
      `<footer class="m-toolbar"><span class="m-status" aria-live="polite"></span>${barButton("compose", "pencil-simple-line", "New email")}</footer>`,
    );
    page.el.querySelector("[data-act=compose]")!.addEventListener("click", () => host.compose());
    page.onClose = () => {
      if (list === page) list = null;
    };
    wireList(page);
    renderList();
    void stack.push(page, animate);
  }

  function rowHtml(t: Thread) {
    const ring = multi() && mail.scope?.length !== 1 ? ` acct-${accountSettings(t.account).color}` : "";
    const name = displayName(t.sender) || "(no sender)";
    const subject = t.subject || "(no subject)";
    const chips = labelChips(t, mail.accountLabels.get(t.account) ?? []);
    const said = `${t.unread ? "Unread. " : ""}${t.starred ? "Pinned. " : ""}${name}. ${subject}. ${shortDate(t.date)}`;
    return `<li class="m-row${t.unread ? " unread" : ""}" data-id="${esc(t.id)}">
      <div class="m-swipe" aria-hidden="true"><i></i><span></span></div>
      <div class="m-row-body" role="button" tabindex="0" aria-label="${esc(multi() ? `${said}. ${accountName(t.account)}` : said)}">
        <span class="m-unread-dot"></span>
        ${settings.appearance.showAvatars ? `<span class="m-ava${ring}">${avatar(t.sender)}</span>` : ""}
        <span class="m-row-main">
          <span class="m-row-top"><span class="m-from">${esc(name)}${t.count > 1 ? `<em>${t.count}</em>` : ""}</span>${t.starred ? icon("push-pin") : ""}<time>${shortDate(t.date)}</time></span>
          <span class="m-subject">${esc(subject)}</span>
          <span class="m-snippet">${esc(decodeEntities(t.snippet))}</span>
          ${chips.length ? `<span class="m-chips">${chips.slice(0, 3).join("")}</span>` : ""}
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

  function renderList() {
    if (!list) return;
    list.setTitle(listTitle());
    const ul = list.content.querySelector<HTMLElement>(".m-list")!;
    if (!mail.threads.length) {
      if (!loaded && !mail.search) return void (ul.innerHTML = "");
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
          mail.search || mail.mailbox === "SCHEDULED" ? "" : mail.pinnedFirst() && t.starred ? "Pinned" : dateGroup(t.date);
        const h = group && group !== last ? head(group, group === "Pinned" ? "push-pin" : "") : "";
        last = group;
        return h + rowHtml(t);
      })
      .join("");
  }

  function setStatus() {
    const s = list?.el.querySelector(".m-status");
    if (!s) return;
    const unread = mail.threads.filter((t) => t.unread).length;
    s.textContent = syncing ? "Checking for mail…" : unread ? `${unread} unread` : "";
  }

  function wireList(page: Page) {
    const ul = page.content.querySelector<HTMLElement>(".m-list")!;
    const sc = page.scroller;

    sc.addEventListener(
      "scroll",
      () => {
        if (sc.scrollTop + sc.clientHeight < sc.scrollHeight - 600) return;
        if (drawn < mail.threads.length) {
          drawn += PAGE;
          return renderList();
        }
        void mail.loadMore();
      },
      { passive: true },
    );

    let suppressTap = false;
    const tap = (e: Event) => {
      if (suppressTap) return void (suppressTap = false);
      const id = (e.target as Element).closest<HTMLElement>(".m-row")?.dataset.id;
      if (id) void openRow(id);
    };
    ul.addEventListener("click", tap);
    ul.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && (e.target as Element).matches(".m-row-body")) {
        e.preventDefault();
        tap(e);
      }
    });

    // Row swipes: the row slides over a strip in the colour of the action it will run, with its icon, which grows
    // once letting go would run it. Archive and delete slide the row away; the others spring back.
    ul.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" || e.clientX < 24) return;
      const li = (e.target as Element).closest<HTMLElement>(".m-row");
      if (!li || mail.mailbox === "SCHEDULED") return;
      const body = li.querySelector<HTMLElement>(".m-row-body")!;
      const strip = li.querySelector<HTMLElement>(".m-swipe")!;
      const x0 = e.clientX;
      const y0 = e.clientY;
      let dx = 0;
      let swiping = false;
      const move = (ev: PointerEvent) => {
        dx = ev.clientX - x0;
        if (!swiping) {
          if (Math.abs(ev.clientY - y0) > 10) return done();
          if (Math.abs(dx) < 10) return;
          swiping = true;
          li.setPointerCapture(ev.pointerId);
        }
        const action = dx < 0 ? settings.swipes.left : settings.swipes.right;
        if (action === "none") dx = Math.sign(dx) * Math.min(Math.abs(dx), 24);
        body.style.transform = `translateX(${dx}px)`;
        li.dataset.swipe = action;
        li.dataset.side = dx < 0 ? "left" : "right";
        strip.querySelector("i")!.className = action === "none" ? "" : swipeIcon(action, li);
        strip.querySelector("span")!.textContent = action === "none" ? "" : SWIPES[action][0];
        li.classList.toggle("armed", action !== "none" && Math.abs(dx) > SWIPE_AT);
      };
      const up = () => {
        done();
        if (!swiping) return;
        suppressTap = true;
        setTimeout(() => (suppressTap = false), 400);
        const action = dx < 0 ? settings.swipes.left : settings.swipes.right;
        const t = mail.threads.find((x) => x.id === li.dataset.id);
        const go = t && action !== "none" && Math.abs(dx) > SWIPE_AT;
        const away = go && ["archive", "trash", "spam"].includes(action) && !(action === "trash" && confirmsDelete());
        const to = away ? Math.sign(dx) * li.clientWidth : 0;
        const anim = body.animate([{ transform: `translateX(${dx}px)` }, { transform: `translateX(${to}px)` }], {
          duration: away ? 220 : 320,
          easing: "cubic-bezier(0.32, 0.72, 0, 1)",
          fill: "forwards",
        });
        body.style.transform = "";
        void anim.finished.then(() => {
          if (go) act(action, t);
          if (!away || !li.isConnected) {
            anim.cancel();
            li.classList.remove("armed");
            delete li.dataset.swipe;
          }
        });
      };
      const done = () => {
        li.removeEventListener("pointermove", move);
        li.removeEventListener("pointerup", up);
        li.removeEventListener("pointercancel", up);
      };
      li.addEventListener("pointermove", move);
      li.addEventListener("pointerup", up);
      li.addEventListener("pointercancel", up);
    });

    // Pull to refresh rides on the scroll view's own bounce: pulled far enough past the top, letting go checks for mail.
    const pull = page.scroller.querySelector<HTMLElement>(".m-pull")!;
    let armed = false;
    sc.addEventListener(
      "scroll",
      () => {
        const over = Math.max(0, -sc.scrollTop);
        pull.style.setProperty("--pull", String(Math.min(1, over / PULL_AT)));
        if (over > PULL_AT && !armed) {
          armed = true;
          pull.classList.add("armed");
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

    const search = page.content.querySelector<HTMLInputElement>(".m-search input")!;
    let timer = 0;
    let seq = 0;
    const local = async (q: string) => {
      const n = ++seq;
      const rows = await invoke<Thread[]>("search_local", { query: q, accounts: mail.scope }).catch(() => []);
      if (n === seq && search.value.trim() === q) mail.showResults(q, rows);
    };
    search.addEventListener("input", () => {
      clearTimeout(timer);
      const q = search.value.trim();
      if (q) return void (timer = window.setTimeout(() => void local(q), 150));
      seq++;
      if (mail.search !== null) mail.openMailbox(mail.mailbox);
    });
    search.form!.addEventListener("submit", async (e) => {
      e.preventDefault();
      search.blur();
      const q = search.value.trim();
      if (!q) return;
      clearTimeout(timer);
      await local(q);
      try {
        await mail.loadThreads();
      } catch (err) {
        toast(`Some results may be missing: ${err}`);
      }
    });
  }

  function swipeIcon(action: Exclude<SwipeAction, "none">, li: HTMLElement) {
    if (action === "unread" && mail.threads.find((x) => x.id === li.dataset.id)?.unread)
      return iconClass("envelope-simple-open");
    return iconClass(SWIPES[action][1]);
  }

  async function refreshNow(pull: HTMLElement) {
    pull.classList.add("spinning");
    await invoke("sync_now").catch((e) => toast(String(e), { kind: "error" }));
    setTimeout(() => pull.classList.remove("spinning"), 400);
  }

  async function openRow(id: string) {
    if (mail.mailbox === "SCHEDULED") return host.editScheduled(id);
    if (mail.mailbox === "DRAFT" && (await host.openDraft(id))) return;
    openConversation(id);
  }

  // ---- Actions

  const confirmsDelete = () => settings.general.confirmDelete || mail.mailbox === "TRASH";

  /** Takes a thread off the list; if it's open, shows the next one (or goes back when there's none). */
  function remove(t: Thread) {
    const i = mail.threads.findIndex((x) => x.id === t.id);
    mail.threads = mail.threads.filter((x) => x.id !== t.id);
    if (convo?.id === t.id) {
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

  async function act(action: string, t: Thread) {
    switch (action) {
      case "archive":
        remove(t);
        void mail.undoable(t, [], ["INBOX"]);
        return undoToast("Archived");
      case "trash":
        if (mail.mailbox === "TRASH") {
          const yes = await ask({
            title: "Delete forever?",
            message: "This can't be undone.",
            confirm: "Delete forever",
            danger: true,
          });
          if (!yes) return;
          remove(t);
          return void mail.deleteForever([t]);
        }
        if (settings.general.confirmDelete) {
          const yes = await ask({
            title: "Delete this email?",
            message: `“${t.subject || "(no subject)"}” will move to Trash.`,
            confirm: "Delete",
            danger: true,
          });
          if (!yes) return;
        }
        remove(t);
        void mail.undoable(t, ["TRASH"], ["INBOX", "SPAM"], true);
        return undoToast("Moved to Trash");
      case "spam":
        remove(t);
        if (mail.mailbox === "SPAM") void mail.undoable(t, ["INBOX"], ["SPAM"]);
        else void mail.undoable(t, ["SPAM"], ["INBOX", "TRASH"]);
        return undoToast(mail.mailbox === "SPAM" ? "Not spam: moved to Inbox" : "Marked as spam");
      case "unread":
        return void mail.modify(t, t.unread ? [] : ["UNREAD"], t.unread ? ["UNREAD"] : []);
      case "star":
        return void mail.modify(t, t.starred ? [] : ["STARRED"], t.starred ? ["STARRED"] : []);
    }
  }

  function moveTo(t: Thread, id: string) {
    if (id === "TRASH") return void act("trash", t);
    if (id === "SPAM") return void act("spam", t);
    const has = new Set(t.labels.split(" "));
    if (mail.mailbox !== null && mail.mailbox !== id) remove(t);
    void mail.undoable(t, id === "ARCHIVE" ? [] : [id], FOLDERS.filter((f) => f !== id && has.has(f)));
    undoToast(id === "ARCHIVE" ? "Archived" : `Moved to ${boxName(id)}`);
  }

  function moveSheet(t: Thread) {
    const has = new Set(t.labels.split(" "));
    actionSheet("Move to", [
      { label: "Inbox", icon: "tray", disabled: has.has("INBOX"), run: () => moveTo(t, "INBOX") },
      { label: "Archive", icon: "archive", disabled: !FOLDERS.some((f) => has.has(f)), run: () => moveTo(t, "ARCHIVE") },
      { label: "Spam", icon: "warning-octagon", disabled: has.has("SPAM"), run: () => moveTo(t, "SPAM") },
      { label: "Trash", icon: "trash", danger: true, disabled: has.has("TRASH"), run: () => moveTo(t, "TRASH") },
      { label: "Labels…", icon: "tag", run: () => labelSheet(t) },
    ]);
  }

  function labelSheet(t: Thread) {
    const own = mail.accountLabels.get(t.account) ?? [];
    if (!own.length) return toast("No labels yet. Add them on your Mac or in Gmail.");
    const has = new Set(t.labels.split(" "));
    actionSheet(
      "Labels",
      own.map((l) => ({
        label: l.name,
        icon: "tag",
        checked: has.has(l.id),
        run: () => {
          const on = !has.has(l.id);
          t.labels = on ? `${t.labels} ${l.id}`.trim() : [...has].filter((x) => x !== l.id).join(" ");
          void mail.modify(t, on ? [l.id] : [], on ? [] : [l.id]);
          labelSheet(t);
        },
      })),
    );
  }

  /** A sheet of choices from the bottom of the screen, with Cancel; tapping outside closes it too. */
  function actionSheet(title: string, items: Item[]) {
    document.querySelector("dialog.m-sheet")?.remove();
    const d = document.createElement("dialog");
    d.className = "m-sheet";
    d.setAttribute("aria-label", title);
    d.innerHTML = `<div class="m-sheet-group"><h2>${esc(title)}</h2>${items
      .map(
        (x, i) =>
          `<button type="button" data-i="${i}" class="${x.danger ? "quiet-danger" : ""}" ${x.disabled ? "disabled" : ""} ${x.checked === undefined ? "" : `role="menuitemcheckbox" aria-checked="${x.checked}"`}>${icon(x.icon)}<span>${esc(x.label)}</span>${x.checked ? icon("check") : ""}</button>`,
      )
      .join("")}</div><div class="m-sheet-group"><button type="button" class="m-sheet-cancel">Cancel</button></div>`;
    d.addEventListener("click", (e) => {
      const b = (e.target as Element).closest<HTMLButtonElement>("button");
      if (e.target === d || b?.classList.contains("m-sheet-cancel")) return d.close();
      if (!b || b.disabled) return;
      d.close();
      items[Number(b.dataset.i)].run();
    });
    d.addEventListener("close", () => d.remove());
    document.body.append(d);
    d.showModal();
  }

  // ---- Conversation

  let convo: { id: string; page: Page } | null = null;

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
      `<footer class="m-toolbar m-convo-tools">
        ${barButton("archive", "archive", "Archive")}${barButton("trash", "trash", "Delete")}${barButton("move", "folder", "Move or label")}${barButton("unread", "envelope-simple", "Mark unread")}${barButton("reply", "arrow-bend-up-left", "Reply")}
      </footer>`,
    );
    page.el.querySelector(".m-convo-tools")!.addEventListener("click", (e) => {
      const action = (e.target as Element).closest<HTMLElement>("[data-act]")?.dataset.act;
      const t = mail.threads.find((x) => x.id === convo?.id);
      if (!action || !t) return;
      if (action === "move") return moveSheet(t);
      if (action === "reply")
        return actionSheet("Reply", [
          { label: "Reply", icon: "arrow-bend-up-left", run: () => host.reply("reply") },
          { label: "Reply all", icon: "arrow-bend-double-up-left", run: () => host.reply("all") },
          { label: "Forward", icon: "arrow-bend-up-right", run: () => host.reply("forward") },
        ]);
      void act(action, t);
    });
    wireReader(page.content, mail, (kind, m) => host.reply(kind, m));
    page.onClose = () => {
      if (convo?.page !== page) return;
      convo = null;
      mail.closeThread();
      renderList();
    };
    convo = { id, page };
    showConversation(id);
    void stack.push(page);
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
    mail
      .openThread(id, (messages) => {
        if (convo?.id !== id) return;
        page.setTitle(messages[0]?.subject || t?.subject || "(no subject)");
        const chips = t ? labelChips(t, mail.accountLabels.get(t.account) ?? []).join("") : "";
        page.content.innerHTML = chips ? `<div class="m-chips">${chips}</div>` : "";
        renderMessages(page.content, messages, t?.account ?? mail.defaultAccount(), true);
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
    const unread = tools.querySelector<HTMLElement>("[data-act=unread]")!;
    const label = t?.unread ? "Mark read" : "Mark unread";
    unread.setAttribute("aria-label", label);
    unread.innerHTML = icon(t?.unread ? "envelope-simple-open" : "envelope-simple");
    tools.querySelector<HTMLElement>("[data-act=archive]")!.hidden = !t?.labels.split(" ").includes("INBOX");
  }

  // ---- Wiring

  mail.subscribe((e) => {
    switch (e.type) {
      case "labels":
        renderBoxes();
        return list?.setTitle(listTitle());
      case "threads":
        renderList();
        setStatus();
        return syncConvoTools();
      case "loaded": {
        loaded = true;
        renderList();
        const sc = list?.scroller;
        if (sc && sc.scrollHeight <= sc.clientHeight) void mail.loadMore();
        return;
      }
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

  return { reset };
}

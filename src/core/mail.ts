import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import type { Attachment } from "../attachments";
import type { Invite } from "../invite";
import { formatWhen } from "../schedule";
import { accountSettings, settings } from "../settings";

export type Label = { id: string; name: string; kind: string; unread: number; color: string | null };
export type Thread = {
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
export type Message = {
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
export type Fields = { to?: string; cc?: string; bcc?: string; subject?: string; body?: string };
export type Scheduled = {
  id: number;
  account: string;
  draft_id: string | null;
  send_at: number;
  sending: boolean;
  error: string | null;
  draft: { to: string };
  /** The composer's own data for reopening it; only the UI reads `opts`. */
  ui: { fields: Fields; opts: unknown };
};
export type Status = { accounts: string[]; imap: string[]; broken: string[] };
export type Change = { t: Thread; add: string[]; remove: string[] };

export type CoreEvent =
  /** Labels and unread counts were reloaded. */
  | { type: "labels" }
  /** The list, the selection or a thread's flags changed. */
  | { type: "threads" }
  /** A mailbox list (not a search) finished loading. */
  | { type: "loaded" }
  /** Search results arrived from some accounts; others are still searching. */
  | { type: "searching"; query: string }
  /** A refresh after a change in the cache finished. */
  | { type: "refreshed" }
  | { type: "error"; message: string }
  | { type: "sync-error"; message: string };

export type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
export type Listen = <T>(event: string, handler: (e: { payload: T }) => void) => unknown;

export const SYSTEM: [string | null, string, string][] = [
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

export type Section = "pinned" | "new" | "people" | "notifications" | "seen";
export const SECTIONS: [Section, string, string][] = [
  ["pinned", "Pinned", "push-pin"],
  ["new", "New", "envelope-simple"],
  ["people", "People", "user"],
  ["notifications", "Notifications", "bell"],
  ["seen", "Seen", "eye"],
];

/** Gmail labels that act as folders: mail sits in at most one, and Archive is none of them. */
export const FOLDERS = ["INBOX", "SPAM", "TRASH"];

export type MailCore = ReturnType<typeof createMailCore>;

/**
 * The mail state and the actions on it, shared by every interface. It reaches the backend only through `invoke` and
 * `listen`, and tells interfaces what changed through `subscribe`; it never touches the DOM.
 */
export function createMailCore(
  invoke: Invoke = tauriInvoke as Invoke,
  listen: Listen = tauriListen as unknown as Listen,
) {
  const subscribers = new Set<(e: CoreEvent) => void>();
  const emit = (e: CoreEvent) => subscribers.forEach((fn) => fn(e));

  /** Bumped on every list load, so a slow result (a search, another mailbox) can't land after the user moved on. */
  let loadSeq = 0;
  let refreshQueued = false;
  let loadingMore = false;
  let loadMoreAfter = 0; // after a failure (offline), wait a minute rather than retry on every scroll
  const noMore = new Set<string>();
  /** Messages of the open email and its neighbours, loaded ahead so moving on doesn't wait. */
  const nearby = new Map<string, Promise<Message[]>>();
  // Archive, delete, spam and move, newest last; one entry per action, so Undo reverts a whole multi-selection.
  const undoStack: Change[][] = [];

  const mail = {
    /** Signed-in accounts, oldest first. */
    accounts: [] as string[],
    /** Accounts signed in with a password over IMAP rather than with Google. */
    imapAccounts: new Set<string>(),
    /** Which accounts the sidebar and list show; null is "All accounts". */
    scope: null as string[] | null,
    mailbox: "INBOX" as string | null,
    search: null as string | null,
    threads: [] as Thread[],
    selected: null as string | null,
    messages: [] as Message[],
    /** Every label in scope, with unread counts. */
    labels: [] as Label[],
    userLabels: [] as Label[],
    /** Each account's own user labels, for the per-thread Label and Move menus (ids differ between accounts). */
    accountLabels: new Map<string, Label[]>(),
    /** Rows of the Scheduled view by list id; they are emails waiting on this device, not Gmail threads. */
    scheduledRows: new Map<string, Scheduled>(),
    // Threads opened while this mailbox is showing keep their section, so reading one doesn't make the list jump.
    keptUnread: new Set<string>(),

    subscribe(fn: (e: CoreEvent) => void) {
      subscribers.add(fn);
      return () => void subscribers.delete(fn);
    },

    async loadStatus() {
      const s = await invoke<Status>("status");
      mail.imapAccounts = new Set(s.imap);
      return s;
    },

    setAccounts(list: string[]) {
      mail.accounts = list;
      mail.scope = mail.scope?.filter((a) => list.includes(a)) ?? null;
      if (!mail.scope?.length) mail.scope = null;
    },

    /** Where a new email is sent from: the account on screen when viewing one, else the default from Settings → Composer. */
    defaultAccount() {
      if (mail.scope?.length === 1) return mail.scope[0];
      const pick = settings.composer.defaultFrom;
      return pick && mail.accounts.includes(pick) && (!mail.scope || mail.scope.includes(pick))
        ? pick
        : (mail.scope?.[0] ?? mail.accounts[0]);
    },

    pinnedFirst: () => settings.inbox.pinnedOnTop && mail.mailbox === "INBOX" && !mail.search,
    // "smart" groups the Inbox into Pinned/People/Notifications/Seen; "list" is plain newest-first.
    smartInbox: () => settings.inbox.view === "smart" && mail.mailbox === "INBOX" && !mail.search,

    sectionOf(t: Thread): Section {
      if (t.starred && settings.inbox.pinnedOnTop) return "pinned";
      if (!t.unread && !mail.keptUnread.has(t.id)) return "seen";
      if (!settings.inbox.splitUnread) return "new";
      return t.primary ? "people" : "notifications";
    },

    /** Smart Inbox order (pinned, unread people, unread notifications, seen) so j/k follows what's on screen. */
    sortForInbox(list: Thread[]) {
      const rank = (t: Thread) => SECTIONS.findIndex(([key]) => key === mail.sectionOf(t));
      if (mail.smartInbox()) return [...list].sort((a, b) => rank(a) - rank(b) || b.date - a.date);
      // The plain Inbox list also keeps pinned mail on top; sort is stable, so each part stays newest first.
      return mail.pinnedFirst() ? [...list].sort((a, b) => Number(b.starred) - Number(a.starred)) : list;
    },

    async loadLabels() {
      const labels = await invoke<Label[]>("labels", { accounts: mail.scope });
      mail.labels = labels;
      mail.userLabels = labels.filter((l) => l.kind === "user");
      mail.accountLabels = new Map(
        await Promise.all(
          mail.accounts.map(
            async (a) =>
              [a, (await invoke<Label[]>("labels", { accounts: [a] })).filter((l) => l.kind === "user")] as const,
          ),
        ),
      );
      emit({ type: "labels" });
    },

    async loadThreads(): Promise<void> {
      const seq = ++loadSeq;
      if (mail.mailbox === "SCHEDULED" && !mail.search) {
        const rows = await invoke<Scheduled[]>("scheduled", { accounts: mail.scope });
        if (seq !== loadSeq) return;
        mail.scheduledRows.clear();
        mail.threads = rows.map((r) => {
          // Row ids are numbered per account, so two accounts can both have row 1: the list id carries the account.
          const id = `${r.account}:${r.id}`;
          mail.scheduledRows.set(id, r);
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
        emit({ type: "threads" });
        emit({ type: "loaded" });
        return;
      }
      if (mail.search) return searchAccounts(mail.search, seq);
      const list = await invoke<Thread[]>("threads", { label: mail.mailbox, accounts: mail.scope });
      if (seq !== loadSeq) return;
      mail.threads = mail.sortForInbox(list);
      emit({ type: "threads" });
      emit({ type: "loaded" });
    },

    /** Local search results as the user types; a list load still in flight mustn't replace them. */
    showResults(query: string, rows: Thread[]) {
      mail.search = query;
      loadSeq++;
      mail.threads = rows;
      emit({ type: "threads" });
    },

    /**
     * Older mail beyond what the first sync listed: fetched when the list is scrolled near its end, a page at a time per
     * account. Stops asking once the backend says there's nothing older for this mailbox and view.
     */
    loadMore() {
      const key = `${mail.mailbox}|${mail.scope?.join(",") ?? "all"}`;
      if (loadingMore || mail.search || mail.mailbox === "SCHEDULED" || noMore.has(key) || Date.now() < loadMoreAfter)
        return;
      loadingMore = true;
      return invoke<[number, boolean]>("load_more", { accounts: mail.scope, label: mail.mailbox })
        .then(([added, more]) => {
          if (!more) noMore.add(key);
          if (added) mail.refresh();
        })
        .catch(() => void (loadMoreAfter = Date.now() + 60_000))
        .finally(() => (loadingMore = false));
    },

    refresh() {
      if (refreshQueued) return;
      refreshQueued = true;
      // A short timer, not requestAnimationFrame: rAF is paused while the window is hidden, which left the list empty
      // when Shift started or reloaded in the background. The 60 ms gathers bursts (a bulk archive sends one
      // mail-changed per thread) into one repaint.
      setTimeout(async () => {
        refreshQueued = false;
        // Something changed in the cache, so messages loaded ahead may be out of date.
        nearby.clear();
        await mail.loadLabels();
        if (!mail.search) await mail.loadThreads();
        emit({ type: "refreshed" });
        if (mail.selected) mail.prefetchAround(mail.selected);
      }, 60);
    },

    loadMessages(account: string, id: string) {
      const key = `${account} ${id}`;
      let p = nearby.get(key);
      if (!p) {
        p = invoke<Message[]>("thread", { account, id });
        nearby.set(key, p);
        p.catch(() => nearby.delete(key));
      }
      return p;
    },

    prefetchAround(id: string) {
      const i = mail.threads.findIndex((t) => t.id === id);
      if (i < 0 || mail.mailbox === "SCHEDULED") return;
      for (const t of [mail.threads[i + 1], mail.threads[i - 1]])
        if (t) mail.loadMessages(t.account, t.id).catch(() => {});
    },

    /**
     * Selects a thread and loads its messages. `show` runs once they're in `messages`, before neighbours are prefetched
     * and the thread is marked read. False when another thread was opened meanwhile; throws if loading failed.
     */
    async openThread(id: string, show: (messages: Message[]) => void = () => {}) {
      mail.selected = id;
      emit({ type: "threads" });
      const thread = mail.threads.find((t) => t.id === id);
      // Into a local first: if the user opened another email meanwhile, this late answer must not replace `messages`,
      // which Reply and Forward read.
      let loaded: Message[];
      try {
        loaded = await mail.loadMessages(thread?.account ?? mail.defaultAccount(), id);
      } catch (e) {
        if (mail.selected === id) throw e;
        return false;
      }
      if (mail.selected !== id) return false;
      mail.messages = loaded;
      show(loaded);
      mail.prefetchAround(id);
      if (thread?.unread && settings.general.markReadOnOpen) {
        mail.keptUnread.add(id);
        void mail.modify(thread, [], ["UNREAD"]);
      }
      return true;
    },

    closeThread() {
      mail.selected = null;
      mail.messages = [];
    },

    // Takes the thread itself, not its id: archive/trash drop it from `threads` first, and looking it up again
    // would fall back to the default account and change the wrong mailbox.
    async modify(t: Thread, add: string[], remove: string[], trash = false) {
      changeLocally(t, add, remove);
      emit({ type: "threads" });
      try {
        await invoke("modify", { account: t.account, id: t.id, add, remove, trash });
      } catch (e) {
        emit({ type: "error", message: `Couldn't update message: ${e}` });
      }
    },

    undoable(t: Thread, add: string[], remove: string[], trash = false) {
      return mail.undoableAll([t], add, remove, trash);
    },

    undoableAll(list: Thread[], add: string[], remove: string[], trash = false) {
      // Only labels the thread has are removed, so Undo after deleting from Sent doesn't put it in the Inbox.
      const changes = list.map((t) => ({ t, add, remove: remove.filter((l) => t.labels.split(" ").includes(l)) }));
      return mail.undoableChanges(changes, trash);
    },

    /** Changes that differ per thread (a move into a label whose id differs by account), undone together. */
    undoableChanges(changes: Change[], trash = false) {
      undoStack.push(changes);
      if (undoStack.length > 50) undoStack.shift();
      return mail.applyChanges(changes, trash);
    },

    /** Reverts the last undoable action; null when there's nothing to undo. */
    undo() {
      const last = undoStack.pop();
      if (!last) return null;
      // The backend's mail-changed refresh puts the threads back in the list.
      return mail.applyChanges(last.map((u) => ({ t: u.t, add: u.remove, remove: u.add })));
    },

    /** Label changes for several threads: one `modify_many` (Gmail's batch call) per account and change. */
    applyChanges(changes: Change[], trash = false) {
      const groups = new Map<string, Change[]>();
      for (const c of changes) {
        const key = JSON.stringify([c.t.account, c.add, c.remove]);
        groups.set(key, [...(groups.get(key) ?? []), c]);
      }
      return Promise.all(
        [...groups.values()].map(async (group) => {
          const [{ t, add, remove }] = group;
          if (group.length === 1) return mail.modify(t, add, remove, trash);
          group.forEach((c) => changeLocally(c.t, add, remove));
          emit({ type: "threads" });
          try {
            await invoke("modify_many", { account: t.account, ids: group.map((c) => c.t.id), add, remove, trash });
          } catch (e) {
            emit({ type: "error", message: `Couldn't update ${group.length} emails: ${e}` });
          }
        }),
      );
    },

    /** Delete inside Trash: gone for good in Gmail too. The UI asks first and takes the threads off its list. */
    async deleteForever(list: Thread[]) {
      const byAccount = new Map<string, string[]>();
      for (const t of list) byAccount.set(t.account, [...(byAccount.get(t.account) ?? []), t.id]);
      await Promise.all(
        [...byAccount].map(([account, ids]) =>
          invoke("delete_forever", { account, ids }).catch((e) => emit({ type: "error", message: String(e) })),
        ),
      );
    },

    emptyMailbox: (id: string) => invoke("empty_mailbox", { label: id, accounts: mail.scope }),

    /** Shows some accounts (null: all of them); keeps the current mailbox when it exists there. */
    setScope(list: string[] | null) {
      mail.scope = list && list.length < mail.accounts.length ? mail.accounts.filter((a) => list.includes(a)) : null;
      // Label ids belong to one account and merged ones to several, so a label mailbox falls back to the Inbox.
      if (mail.mailbox && !SYSTEM.some(([id]) => id === mail.mailbox)) mail.mailbox = "INBOX";
    },

    openMailbox(id: string | null) {
      mail.mailbox = id;
      mail.keptUnread.clear();
      mail.search = null;
      mail.refresh();
    },
  };

  /**
   * Gmail search, one request per account at once: each account's results join the list as they arrive, rather than
   * waiting for the slowest account. Rejects with the first error once all have answered, so the results that did
   * arrive stay.
   */
  async function searchAccounts(query: string, seq: number) {
    const inView = mail.scope ?? mail.accounts.filter((a) => accountSettings(a).unified !== false);
    let pending = inView.length;
    const errors: unknown[] = [];
    await Promise.all(
      inView.map(async (account) => {
        try {
          const found = await invoke<Thread[]>("search", { query, accounts: [account] });
          if (seq !== loadSeq) return;
          const ids = new Set(found.map((t) => t.id));
          const merged = [...mail.threads.filter((t) => t.account !== account || !ids.has(t.id)), ...found];
          mail.threads = mail.sortForInbox(merged.sort((a, b) => b.date - a.date));
        } catch (e) {
          errors.push(e);
        } finally {
          pending--;
          if (seq === loadSeq) {
            emit({ type: "threads" });
            if (pending) emit({ type: "searching", query });
          }
        }
      }),
    );
    if (errors.length) throw errors[0];
  }

  void listen("mail-changed", () => mail.refresh());
  void listen<string>("sync-error", (e) => emit({ type: "sync-error", message: e.payload }));

  return mail;
}

/**
 * Moving threads into a mailbox: into `target`'s label (looked up per account, since ids differ; "ARCHIVE" is none)
 * and out of the folders they're in. Threads whose account lacks the label are left out.
 */
export function moveChanges(list: Thread[], target: string, labelId: (account: string) => string | undefined = () => target) {
  return list.flatMap((t): Change[] => {
    const id = target === "ARCHIVE" ? null : labelId(t.account);
    if (id === undefined) return [];
    const has = t.labels.split(" ");
    return [{ t, add: id ? [id] : [], remove: FOLDERS.filter((f) => f !== id && has.includes(f)) }];
  });
}

/**
 * A label for several threads at once: whether all, some or none of them have it (`labelId` finds it in each thread's
 * account), and the changes a tap makes: off for all when all have it, otherwise on for the ones without it.
 */
export function labelToggle(list: Thread[], labelId: (account: string) => string | undefined) {
  const own = list.flatMap((t) => {
    const id = labelId(t.account);
    return id ? [{ t, id, on: t.labels.split(" ").includes(id) }] : [];
  });
  const on = own.filter((x) => x.on).length;
  const state = !own.length || !on ? "none" : on === own.length ? "all" : "some";
  const changes: Change[] =
    state === "all"
      ? own.map(({ t, id }) => ({ t, add: [], remove: [id] }))
      : own.filter((x) => !x.on).map(({ t, id }) => ({ t, add: [id], remove: [] }));
  return { state, changes } as const;
}

/** A thread's label list after a change, so its chips and menus are right before the list reloads. */
export function relabel({ t, add, remove }: Change) {
  const has = new Set(t.labels.split(" ").filter(Boolean));
  remove.forEach((l) => has.delete(l));
  add.forEach((l) => has.add(l));
  t.labels = [...has].join(" ");
}

function changeLocally(t: Thread, add: string[], remove: string[]) {
  if (add.includes("UNREAD")) t.unread = true;
  if (remove.includes("UNREAD")) t.unread = false;
  if (add.includes("STARRED")) t.starred = true;
  if (remove.includes("STARRED")) t.starred = false;
}

import { afterEach, expect, test } from "bun:test";
import { settings } from "../settings";
import {
  type CoreEvent,
  type Label,
  type Message,
  type Thread,
  createMailCore,
  labelToggle,
  moveChanges,
  relabel,
} from "./mail";

const ANA = "ana@example.com";
const WORK = "ops@example.org";

type Stored = { id: string; account: string; subject: string; from: string; date: number; labels: Set<string> };

/** Gmail-like mailboxes in memory, answering the Tauri commands the core uses, with events like the real backend's. */
function fakeBackend(mail: Stored[], { listed = Infinity, page = 2 } = {}) {
  const handlers = new Map<string, ((e: { payload: unknown }) => void)[]>();
  const emit = (event: string, payload: unknown = null) => handlers.get(event)?.forEach((h) => h({ payload }));
  const calls: string[] = [];
  const failing = new Set<string>();
  const delays = new Map<string, number>();
  // How many of each account's newest threads have been synced into the cache; load_more fetches older ones.
  const shown = new Map<string, number>();
  const synced = (s: Stored) => {
    const own = mail.filter((x) => x.account === s.account).sort((a, b) => b.date - a.date);
    return own.indexOf(s) < (shown.get(s.account) ?? listed);
  };
  const inScope = (s: Stored, accounts: string[] | null) => !accounts || accounts.includes(s.account);
  const row = (s: Stored): Thread => ({
    id: s.id,
    account: s.account,
    subject: s.subject,
    sender: s.from,
    snippet: `About ${s.subject}`,
    date: s.date,
    count: 1,
    unread: s.labels.has("UNREAD"),
    starred: s.labels.has("STARRED"),
    primary: true,
    labels: [...s.labels].join(" "),
  });
  const find = (account: string, id: string) => mail.find((s) => s.account === account && s.id === id)!;
  const change = (s: Stored, add: string[], remove: string[]) => {
    remove.forEach((l) => s.labels.delete(l));
    add.forEach((l) => s.labels.add(l));
  };
  // Like the Rust commands: change the cache, tell the UI, ask Gmail; if Gmail refuses, re-fetch (undo) and tell again.
  const labelChange = async (cmd: string, targets: Stored[], add: string[], remove: string[]) => {
    const before = targets.map((s) => new Set(s.labels));
    targets.forEach((s) => change(s, add, remove));
    emit("mail-changed");
    if (failing.has(cmd)) {
      targets.forEach((s, i) => (s.labels = before[i]));
      emit("mail-changed");
      throw "Gmail said no";
    }
  };

  const commands: Record<string, (a: any) => unknown> = {
    status: () => ({ accounts: [ANA, WORK], imap: [WORK], broken: [] }),
    labels: ({ accounts }) => {
      const inbox = mail.filter((s) => inScope(s, accounts) && synced(s) && s.labels.has("INBOX"));
      return [
        { id: "INBOX", name: "INBOX", kind: "system", unread: inbox.filter((s) => s.labels.has("UNREAD")).length },
        { id: "Label_1", name: "Receipts", kind: "user", unread: 0, color: null },
      ] as Label[];
    },
    threads: ({ label, accounts }) =>
      mail
        .filter((s) => inScope(s, accounts) && synced(s) && (label === null || s.labels.has(label)))
        .sort((a, b) => b.date - a.date)
        .map(row),
    scheduled: () => [],
    load_more: ({ accounts }) => {
      let added = 0;
      let more = false;
      for (const account of accounts ?? [ANA, WORK]) {
        const total = mail.filter((s) => s.account === account).length;
        const now = Math.min(shown.get(account) ?? listed, total);
        shown.set(account, Math.min(now + page, total));
        added += shown.get(account)! - now;
        more ||= shown.get(account)! < total;
      }
      return [added, more];
    },
    search: ({ query, accounts }) =>
      mail.filter((s) => inScope(s, accounts) && s.subject.toLowerCase().includes(query)).map(row),
    thread: ({ account, id }): Message[] => {
      const s = find(account, id);
      return [
        {
          id: `${id}-0`,
          sender: s.from,
          recipients: account,
          cc: "",
          date: s.date,
          subject: s.subject,
          message_id: `<${id}@example.com>`,
          refs: "",
          html: null,
          text: `About ${s.subject}`,
          attachments: [],
          reply_to: "",
          invite: null,
        },
      ];
    },
    modify: ({ account, id, add, remove }) => labelChange("modify", [find(account, id)], add, remove),
    modify_many: ({ account, ids, add, remove }) =>
      labelChange(
        "modify_many",
        ids.map((id: string) => find(account, id)),
        add,
        remove,
      ),
    delete_forever: ({ account, ids }) => {
      if (failing.has("delete_forever")) throw "offline";
      for (const id of ids) mail.splice(mail.indexOf(find(account, id)), 1);
      emit("mail-changed");
    },
  };

  async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    calls.push(cmd);
    const wait = delays.get(`${cmd} ${(args.accounts as string[] | undefined)?.join(",")}`);
    if (wait) await new Promise((r) => setTimeout(r, wait));
    if (failing.has(cmd) && cmd !== "modify" && cmd !== "modify_many" && cmd !== "delete_forever") throw `${cmd} failed`;
    return commands[cmd](args) as T;
  }
  const listen = <T>(event: string, handler: (e: { payload: T }) => void) => {
    handlers.set(event, [...(handlers.get(event) ?? []), handler as (e: { payload: unknown }) => void]);
  };
  return { invoke, listen, emit, calls, failing, delays, mail };
}

const at = (day: number) => Date.UTC(2026, 10, day, 9);
const stored = (account: string, id: string, subject: string, day: number, ...labels: string[]): Stored => ({
  id,
  account,
  subject,
  from: `Sender ${id} <${id}@example.net>`,
  date: at(day),
  labels: new Set(labels),
});

function setup(mail = defaultMail(), opts?: { listed?: number; page?: number }) {
  const backend = fakeBackend(mail, opts);
  const core = createMailCore(backend.invoke, backend.listen);
  core.setAccounts([ANA, WORK]);
  const events: CoreEvent[] = [];
  core.subscribe((e) => events.push(e));
  /** Resolves on the next event of this type. */
  const next = (type: CoreEvent["type"]) =>
    new Promise<CoreEvent>((done) => {
      const off = core.subscribe((e) => e.type === type && (off(), done(e)));
    });
  return { backend, core, events, next };
}

const defaultMail = () => [
  stored(ANA, "t1", "Lunch on Friday", 20, "INBOX", "UNREAD"),
  stored(ANA, "t2", "Invoice 1042", 19, "INBOX"),
  stored(WORK, "w1", "Deploy notes", 18, "INBOX", "UNREAD"),
  stored(WORK, "w2", "Old invoice", 10, "SENT"),
];

const ids = (list: Thread[]) => list.map((t) => t.id).sort();

afterEach(() => {
  settings.general.markReadOnOpen = true;
});

test("archiving removes the thread from the Inbox, and undo puts it back", async () => {
  const { core, next } = setup();
  await core.loadThreads();
  const t = core.threads.find((x) => x.id === "t2")!;

  let refreshed = next("refreshed");
  await core.undoable(t, [], ["INBOX"]);
  await refreshed;
  expect(ids(core.threads)).toEqual(["t1", "w1"]);

  refreshed = next("refreshed");
  await core.undo();
  await refreshed;
  expect(ids(core.threads)).toEqual(["t1", "t2", "w1"]);
  expect(core.undo()).toBeNull();
});

test("undo only restores labels the thread had", async () => {
  const { core, backend } = setup();
  core.mailbox = "SENT";
  await core.loadThreads();
  const sent = core.threads[0];
  await core.undoable(sent, ["TRASH"], ["INBOX", "SPAM"], true);
  await core.undo();
  expect([...backend.mail.find((s) => s.id === "w2")!.labels]).toEqual(["SENT"]);
});

test("a refused change is rolled back and reported", async () => {
  const { core, backend, events, next } = setup();
  await core.loadThreads();
  backend.failing.add("modify");
  const t = core.threads.find((x) => x.id === "t1")!;

  const refreshed = next("refreshed");
  const done = core.modify(t, [], ["UNREAD"]);
  expect(t.unread).toBe(false);
  await done;
  await refreshed;
  expect(events).toContainEqual({ type: "error", message: "Couldn't update message: Gmail said no" });
  expect(core.threads.find((x) => x.id === "t1")!.unread).toBe(true);
});

test("a change to several threads is one batch call per account", async () => {
  const { core, backend } = setup();
  await core.loadThreads();
  const [a, b, w] = ["t1", "t2", "w1"].map((id) => core.threads.find((t) => t.id === id)!);
  await core.undoableAll([a, b, w], [], ["INBOX"]);
  expect(backend.calls.filter((c) => c === "modify_many" || c === "modify")).toEqual(["modify_many", "modify"]);
});

test("opening a thread loads its messages and marks it read", async () => {
  const { core, backend } = setup();
  await core.loadThreads();
  let shown: Message[] = [];
  expect(await core.openThread("t1", (m) => (shown = m))).toBe(true);
  expect(core.selected).toBe("t1");
  expect(shown.map((m) => m.subject)).toEqual(["Lunch on Friday"]);
  expect(core.messages).toBe(shown);
  expect(backend.mail.find((s) => s.id === "t1")!.labels.has("UNREAD")).toBe(false);
  // It keeps its place among the new mail until the mailbox is left.
  expect(core.sectionOf(core.threads.find((t) => t.id === "t1")!)).toBe("people");
});

test("opening leaves mail unread when Settings say so, and a late answer doesn't replace a newer one", async () => {
  settings.general.markReadOnOpen = false;
  const { core, backend } = setup();
  await core.loadThreads();
  backend.delays.set("thread undefined", 30);
  const first = core.openThread("t1");
  const second = core.openThread("w1");
  expect(await first).toBe(false);
  expect(await second).toBe(true);
  expect(core.messages[0].subject).toBe("Deploy notes");
  expect(backend.mail.find((s) => s.id === "w1")!.labels.has("UNREAD")).toBe(true);
});

test("loadMore appends the next page and stops at the end", async () => {
  const mail = [1, 2, 3, 4, 5].map((n) => stored(ANA, `a${n}`, `Note ${n}`, 20 - n, "INBOX"));
  const { core, backend, next } = setup(mail, { listed: 2, page: 2 });
  core.setScope([ANA]);
  await core.loadThreads();
  expect(core.threads.map((t) => t.id)).toEqual(["a1", "a2"]);

  let refreshed = next("refreshed");
  await core.loadMore();
  await refreshed;
  expect(core.threads.map((t) => t.id)).toEqual(["a1", "a2", "a3", "a4"]);

  refreshed = next("refreshed");
  await core.loadMore();
  await refreshed;
  expect(core.threads.map((t) => t.id)).toEqual(["a1", "a2", "a3", "a4", "a5"]);

  await core.loadMore();
  expect(backend.calls.filter((c) => c === "load_more")).toHaveLength(2);
});

test("search results from several accounts arrive one account at a time and merge", async () => {
  const { core, backend, events } = setup();
  backend.delays.set(`search ${WORK}`, 30);
  core.search = "invoice";
  const done = core.loadThreads();
  await new Promise((r) => setTimeout(r, 10));
  expect(ids(core.threads)).toEqual(["t2"]);
  expect(events).toContainEqual({ type: "searching", query: "invoice" });
  await done;
  expect(core.threads.map((t) => t.id)).toEqual(["t2", "w2"]);
});

test("a failed account's search keeps the other account's results and reports the error", async () => {
  const { core, backend } = setup();
  const invoke = backend.invoke;
  const core2 = createMailCore(
    (<T>(cmd: string, args?: Record<string, unknown>) =>
      cmd === "search" && (args?.accounts as string[])[0] === WORK
        ? Promise.reject("offline")
        : invoke<T>(cmd, args)) as typeof invoke,
    backend.listen,
  );
  core2.setAccounts(core.accounts);
  core2.search = "invoice";
  await expect(core2.loadThreads()).rejects.toBe("offline");
  expect(ids(core2.threads)).toEqual(["t2"]);
});

test("a mail-changed event refreshes the labels and the current list, once per burst", async () => {
  const { core, backend, next } = setup();
  await core.loadThreads();
  backend.mail.push(stored(ANA, "t3", "New reply", 21, "INBOX", "UNREAD"));
  backend.calls.length = 0;
  const refreshed = next("refreshed");
  backend.emit("mail-changed");
  backend.emit("mail-changed");
  backend.emit("mail-changed");
  await refreshed;
  expect(core.threads[0].id).toBe("t3");
  expect(core.labels.find((l) => l.id === "INBOX")!.unread).toBe(3);
  expect(backend.calls.filter((c) => c === "threads")).toHaveLength(1);
});

test("sync errors are passed on to the interface", () => {
  const { backend, events } = setup();
  backend.emit("sync-error", "token expired");
  expect(events).toContainEqual({ type: "sync-error", message: "token expired" });
});

test("a slower, older list load doesn't replace the mailbox the user moved to", async () => {
  const { core, backend } = setup();
  const slow = createMailCore(
    (<T>(cmd: string, args?: Record<string, unknown>) =>
      cmd === "threads" && args?.label === "INBOX"
        ? new Promise<T>((r) => setTimeout(() => r(backend.invoke<T>(cmd, args)), 30))
        : backend.invoke<T>(cmd, args)) as typeof backend.invoke,
    backend.listen,
  );
  slow.setAccounts(core.accounts);
  const inbox = slow.loadThreads();
  slow.mailbox = "SENT";
  await slow.loadThreads();
  await inbox;
  expect(slow.threads.map((t) => t.id)).toEqual(["w2"]);
});

test("a single-account scope keeps system mailboxes and leaves labels for the Inbox", async () => {
  const { core } = setup();
  core.mailbox = "Label_1";
  core.setScope([WORK]);
  expect(core.scope).toEqual([WORK]);
  expect(core.mailbox).toBe("INBOX");
  await core.loadThreads();
  expect(ids(core.threads)).toEqual(["w1"]);
  core.setScope([ANA, WORK]);
  expect(core.scope).toBeNull();
});

test("delete forever goes to each account once and reports failures", async () => {
  const { core, backend, events } = setup();
  await core.loadThreads();
  await core.deleteForever(core.threads.filter((t) => t.account === ANA));
  expect(backend.mail.map((s) => s.id)).toEqual(["w1", "w2"]);
  backend.failing.add("delete_forever");
  await core.deleteForever(core.threads.filter((t) => t.id === "w1"));
  expect(events).toContainEqual({ type: "error", message: "offline" });
});

// Label ids per account, as Gmail numbers them: the same name has a different id in each account.
const RECEIPTS: Record<string, string> = { [ANA]: "Label_1", [WORK]: "Label_9" };

test("moving several threads into a label uses each account's own id and is undone in one step", async () => {
  const { core, backend, next } = setup();
  await core.loadThreads();
  const changes = moveChanges(core.threads, "Receipts", (a) => RECEIPTS[a]);
  expect(changes.map((c) => [c.t.id, c.add, c.remove]).sort()).toEqual([
    ["t1", ["Label_1"], ["INBOX"]],
    ["t2", ["Label_1"], ["INBOX"]],
    ["w1", ["Label_9"], ["INBOX"]],
  ]);
  let refreshed = next("refreshed");
  await core.undoableChanges(changes);
  await refreshed;
  expect(core.threads).toEqual([]);
  expect([...backend.mail.find((s) => s.id === "w1")!.labels].sort()).toEqual(["Label_9", "UNREAD"]);

  refreshed = next("refreshed");
  await core.undo();
  await refreshed;
  expect(ids(core.threads)).toEqual(["t1", "t2", "w1"]);
  expect(core.undo()).toBeNull();
});

test("moving to Archive takes threads out of their folder, and skips accounts without the label", () => {
  const t = (id: string, account: string, labels: string) => ({ id, account, labels }) as Thread;
  const list = [t("a", ANA, "SPAM UNREAD"), t("b", WORK, "SENT")];
  expect(moveChanges(list, "ARCHIVE").map((c) => [c.add, c.remove])).toEqual([
    [[], ["SPAM"]],
    [[], []],
  ]);
  expect(moveChanges(list, "INBOX").map((c) => c.remove)).toEqual([["SPAM"], []]);
  expect(moveChanges(list, "Receipts", (a) => (a === ANA ? "Label_1" : undefined)).map((c) => c.t.id)).toEqual(["a"]);
});

test("a label on several threads: off for all when all have it, otherwise on for the rest", () => {
  const t = (id: string, account: string, labels: string) => ({ id, account, labels }) as Thread;
  const id = (a: string) => RECEIPTS[a];
  const some = [t("a", ANA, "INBOX Label_1"), t("b", WORK, "INBOX")];
  const toggle = labelToggle(some, id);
  expect(toggle.state).toBe("some");
  expect(toggle.changes.map((c) => [c.t.id, c.add, c.remove])).toEqual([["b", ["Label_9"], []]]);
  toggle.changes.forEach(relabel);
  expect(some[1].labels).toBe("INBOX Label_9");

  const all = labelToggle(some, id);
  expect(all.state).toBe("all");
  all.changes.forEach(relabel);
  expect(some.map((x) => x.labels)).toEqual(["INBOX", "INBOX"]);
  expect(labelToggle(some, id).state).toBe("none");
  expect(labelToggle(some, () => undefined)).toEqual({ state: "none", changes: [] });
});

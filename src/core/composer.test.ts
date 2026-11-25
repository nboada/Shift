import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import type { OutFile } from "../attachments";
import { settings } from "../settings";
import { type ComposeState, type ComposeView, createComposer } from "./composer";
import type { Fields, MailCore, Message, Scheduled } from "./mail";

const ME = "ana@example.com";
const WORK = "ops@example.org";

const message = (over: Partial<Message> = {}): Message => ({
  id: "m1",
  sender: "Ben Ito <ben@example.net>",
  recipients: `Ana <${ME}>, Cleo <cleo@example.net>`,
  cc: `Dev <dev@example.net>, ${WORK}`,
  date: Date.UTC(2026, 10, 20),
  subject: "Lunch",
  message_id: "<m1@example.net>",
  refs: "",
  html: null,
  text: "Shall we?",
  attachments: [],
  reply_to: "",
  invite: null,
  ...over,
});

type Call = { cmd: string; args: Record<string, any> };

/** The backend's compose commands in memory: drafts, scheduled sends and attachments, with failures and slow calls. */
function fakeBackend() {
  const calls: Call[] = [];
  const failing = new Set<string>();
  const delays = new Map<string, number>();
  const drafts = new Map<string, unknown>();
  const scheduled = new Map<number, { draftId: string | null; sendAt: number | null }>();
  const threads = new Map<string, Message[]>();
  const found = new Map<string, [string, string, string]>();
  let nextDraft = 1;
  let nextScheduled = 1;
  const commands: Record<string, (a: any) => unknown> = {
    save_draft: ({ draft, draftId }) => {
      const id = draftId ?? `d${nextDraft++}`;
      drafts.set(id, draft);
      return id;
    },
    delete_draft: ({ draftId }) => void drafts.delete(draftId),
    send: () => null,
    schedule_send: ({ draftId, sendAt }) => {
      if (!draftId) throw "Save the draft first";
      const id = nextScheduled++;
      scheduled.set(id, { draftId, sendAt });
      return id;
    },
    reschedule: ({ id, sendAt }) => {
      if (sendAt === null) scheduled.delete(id);
      else scheduled.get(id)!.sendAt = sendAt;
    },
    attachment_data: ({ idx }) => `data${idx}`,
    thread: ({ id }) => threads.get(id) ?? [],
    find_draft: ({ thread }) => found.get(thread) ?? null,
    take_scheduled: ({ id }) => {
      scheduled.delete(Number(id));
      return [];
    },
  };
  const invoke = async <T,>(cmd: string, args: Record<string, unknown> = {}): Promise<T> => {
    calls.push({ cmd, args: structuredClone(args) });
    const wait = delays.get(cmd);
    if (wait) await new Promise((r) => setTimeout(r, wait));
    if (failing.has(cmd)) throw `${cmd} failed`;
    return commands[cmd](args) as T;
  };
  return { invoke, calls, failing, delays, drafts, scheduled, threads, found, of: (cmd: string) => calls.filter((c) => c.cmd === cmd) };
}

/** A composer on screen: what's typed lives here, and toasts are recorded with their actions. */
function fakeView() {
  const typed: Fields = {};
  const shown: { fields: Fields; state: ComposeState }[] = [];
  const toasts: { msg: string; action?: { run: () => void } }[] = [];
  const errors: string[] = [];
  const kept: Fields[] = [];
  let open = false;
  const view: ComposeView = {
    show(fields, state) {
      Object.assign(typed, { to: "", cc: "", bcc: "", subject: "", body: "" }, fields);
      shown.push({ fields: { ...fields }, state });
      open = true;
    },
    hide: () => void (open = false),
    read: () => ({ fields: { ...typed }, text: typed.body ?? "", html: typed.body ?? "", typed: !!typed.body?.trim() }),
    status: () => {},
    error: (text) => void (text && errors.push(text)),
    files: () => {},
    kept: (f) => void kept.push(f),
    quote: (m, header) => `${header}<div data-quote="${m.id}"></div>`,
    toast(msg, opts) {
      toasts.push({ msg, action: opts?.action });
      return { setMessage: () => {}, close: () => {}, open: true };
    },
    where: () => "in Gmail",
  };
  return {
    view,
    shown,
    toasts,
    errors,
    kept,
    isOpen: () => open,
    type(f: Fields) {
      Object.assign(typed, f);
    },
  };
}

function fakeMail(over: Partial<MailCore> = {}) {
  return {
    accounts: [ME, WORK],
    threads: [],
    selected: null,
    messages: [],
    mailbox: "INBOX",
    scheduledRows: new Map<string, Scheduled>(),
    defaultAccount: () => ME,
    refresh: () => {},
    ...over,
  } as unknown as MailCore;
}

function setup(mail = fakeMail()) {
  const backend = fakeBackend();
  const ui = fakeView();
  const compose = createComposer(mail, ui.view, backend.invoke);
  return { backend, ui, compose, mail };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const undoSeconds = settings.composer.undoSendSeconds;
beforeEach(() => {
  settings.composer.undoSendSeconds = 0;
  settings.composer.quoteOriginal = true;
});
afterEach(() => {
  settings.composer.undoSendSeconds = undoSeconds;
  jest.useRealTimers();
});

test("a draft saves a moment after typing stops, and later edits update the same draft", async () => {
  jest.useFakeTimers();
  const { backend, ui, compose } = setup();
  await compose.write();
  ui.type({ to: "ben@example.net", body: "Hello" });
  compose.touch();
  jest.advanceTimersByTime(1000);
  expect(backend.of("save_draft")).toHaveLength(0);
  jest.advanceTimersByTime(600);
  await flush();
  expect(backend.of("save_draft")).toHaveLength(1);
  ui.type({ body: "Hello again" });
  compose.touch();
  jest.advanceTimersByTime(1600);
  await flush();
  const saves = backend.of("save_draft");
  expect(saves).toHaveLength(2);
  expect(saves[1].args.draftId).toBe("d1");
  expect(backend.drafts.size).toBe(1);
});

test("an edit saved behind a slow save waits for it and updates that draft instead of making another", async () => {
  const { backend, ui, compose } = setup();
  await compose.write();
  backend.delays.set("save_draft", 30);
  ui.type({ to: "ben@example.net", body: "One" });
  compose.touch();
  const first = compose.save();
  ui.type({ body: "Two" });
  compose.touch();
  const second = compose.save();
  expect(await first).toBe(true);
  expect(await second).toBe(true);
  const saves = backend.of("save_draft");
  expect(saves.map((c) => [c.args.draft.body, c.args.draftId])).toEqual([
    ["One", null],
    ["Two", "d1"],
  ]);
  expect(backend.drafts.size).toBe(1);
});

test("files over 1 MB save less often", async () => {
  jest.useFakeTimers();
  const { backend, compose } = setup();
  const big: OutFile = { name: "plan.pdf", mime: "application/pdf", data: "", size: 2_000_000 };
  await compose.open({ to: "ben@example.net" }, { attachments: [big] });
  compose.touch();
  jest.advanceTimersByTime(5000);
  await flush();
  expect(backend.of("save_draft")).toHaveLength(0);
  jest.advanceTimersByTime(10_500);
  await flush();
  expect(backend.of("save_draft")).toHaveLength(1);
});

test("sending a saved draft sends that draft; a new email sends without one", async () => {
  const { backend, ui, compose } = setup();
  await compose.write();
  ui.type({ to: "ben@example.net", body: "Saved first" });
  compose.touch();
  await compose.save();
  await compose.send();
  expect(backend.of("send")[0].args.draftId).toBe("d1");
  expect(ui.isOpen()).toBe(false);

  await compose.write();
  ui.type({ to: "ben@example.net", body: "Straight out" });
  await compose.send();
  expect(backend.of("send")[1].args.draftId).toBeNull();
  expect(ui.toasts.at(-1)?.msg).toBe("Message sent");
});

test("send refuses without a valid recipient and stays open", async () => {
  const { backend, ui, compose } = setup();
  await compose.write();
  ui.type({ body: "Hi" });
  await compose.send();
  ui.type({ to: "not an address" });
  await compose.send();
  expect(backend.of("send")).toHaveLength(0);
  expect(ui.errors).toEqual(["Add at least one recipient", "Check this address: not an address"]);
  expect(ui.isOpen()).toBe(true);
});

test("Undo send cancels the scheduled send and reopens the email", async () => {
  settings.composer.undoSendSeconds = 5;
  const { backend, ui, compose } = setup();
  await compose.write();
  ui.type({ to: "ben@example.net", subject: "Oops", body: "Wrong person" });
  await compose.send();
  expect(backend.of("send")).toHaveLength(0);
  const [{ args }] = backend.of("schedule_send");
  expect(args.draftId).toBe("d1");
  expect(args.sendAt).toBeGreaterThan(Date.now() + 4000);
  expect(backend.scheduled.size).toBe(1);
  expect(ui.isOpen()).toBe(false);

  ui.toasts.find((t) => t.msg === "Sending in 5s…")!.action!.run();
  await flush();
  expect(backend.scheduled.size).toBe(0);
  expect(ui.isOpen()).toBe(true);
  expect(ui.shown.at(-1)?.fields.subject).toBe("Oops");
  expect(compose.state?.draftId).toBe("d1");
});

test("a send with Undo isn't scheduled when its draft can't be saved", async () => {
  settings.composer.undoSendSeconds = 5;
  const { backend, ui, compose } = setup();
  await compose.write();
  backend.failing.add("save_draft");
  ui.type({ to: "ben@example.net", body: "Offline" });
  await compose.send();
  expect(backend.of("schedule_send")).toHaveLength(0);
  expect(ui.isOpen()).toBe(true);
  expect(ui.errors.at(-1)).toMatch(/wasn't sent/);
});

test("Send later saves the draft first, and schedule_send refuses without a draft id", async () => {
  const at = new Date(Date.now() + 3_600_000);
  const { backend, ui, compose } = setup();
  await compose.write();
  backend.failing.add("save_draft");
  ui.type({ to: "ben@example.net", body: "Later" });
  expect(await compose.schedule(at)).toBe(false);
  expect(backend.of("schedule_send")[0].args.draftId).toBeNull();
  expect(backend.scheduled.size).toBe(0);
  expect(ui.isOpen()).toBe(true);

  backend.failing.delete("save_draft");
  expect(await compose.schedule(at)).toBe(true);
  expect(backend.scheduled.get(1)).toEqual({ draftId: "d1", sendAt: at.getTime() });
  expect(ui.toasts.at(-1)?.msg).toMatch(/^Scheduled for/);
});

test("Send later refuses a time in the past", async () => {
  const { backend, ui, compose } = setup();
  await compose.write();
  ui.type({ to: "ben@example.net" });
  expect(await compose.schedule(new Date(Date.now() - 1000))).toBe(false);
  expect(ui.errors).toEqual(["Pick a time in the future"]);
  expect(backend.of("save_draft")).toHaveLength(0);
});

test("reply all answers the sender, keeps Cc and leaves out your own addresses", async () => {
  const last = message();
  const { ui, compose } = setup(fakeMail({ selected: "t1", messages: [last] }));
  await compose.reply("all");
  const { fields, state } = ui.shown[0];
  expect(fields.to).toBe("Ben Ito <ben@example.net>");
  expect(fields.cc).toBe("Cleo <cleo@example.net>, Dev <dev@example.net>");
  expect(fields.subject).toBe("Re: Lunch");
  expect(fields.body).toContain('data-quote="m1"');
  expect(state.context).toEqual({ thread_id: "t1", in_reply_to: "<m1@example.net>", references: "" });

  await compose.reply("reply", message({ reply_to: "List <list@example.net>" }));
  expect(ui.shown[1].fields.to).toBe("List <list@example.net>");
  expect(ui.shown[1].fields.cc).toBe("");
});

test("a reply to your own email goes to its recipients again", async () => {
  const mine = message({ sender: `Ana <${ME}>`, recipients: "Ben Ito <ben@example.net>", cc: "" });
  const { ui, compose } = setup(fakeMail({ selected: "t1", messages: [mine] }));
  await compose.reply("reply");
  expect(ui.shown[0].fields.to).toBe("Ben Ito <ben@example.net>");
});

test("a reply goes from the conversation's account", async () => {
  const thread = { id: "t1", account: WORK } as never;
  const { ui, compose } = setup(fakeMail({ selected: "t1", messages: [message()], threads: [thread] }));
  await compose.reply("reply");
  expect(ui.shown[0].state.account).toBe(WORK);
});

test("a forward carries the original's attachments, and Send waits for them", async () => {
  const last = message({
    attachments: [
      { idx: 0, filename: "menu.pdf", mime: "application/pdf", size: 1000, content_id: null },
      { idx: 1, filename: "map.png", mime: "image/png", size: 2000, content_id: null },
    ],
  });
  const { backend, ui, compose } = setup(fakeMail({ selected: "t1", messages: [last] }));
  backend.delays.set("attachment_data", 10);
  const forwarding = compose.reply("forward");
  await flush();
  expect(ui.shown[0].fields.subject).toBe("Fwd: Lunch");
  expect(ui.shown[0].fields.to).toBeUndefined();
  ui.type({ to: "cleo@example.net" });
  await compose.send();
  await forwarding;
  const sent = backend.of("send")[0].args.draft;
  expect(sent.attachments.map((f: OutFile) => [f.name, f.data])).toEqual([
    ["menu.pdf", "data0"],
    ["map.png", "data1"],
  ]);
});

test("attachments stop at Gmail's 25 MB", async () => {
  const { ui, compose } = setup();
  await compose.write();
  const file = (name: string, size: number) => ({ name, size }) as File;
  const read = async (f: File): Promise<OutFile> => ({ name: f.name, mime: "image/jpeg", data: "", size: f.size });
  await compose.addFiles([file("a.jpg", 20_000_000), file("b.jpg", 7_000_000), file("c.jpg", 1000)], read);
  expect(compose.state!.attachments.map((f) => f.name)).toEqual(["a.jpg"]);
  expect(ui.errors.at(-1)).toMatch(/25\.0 MB/);

  const big = message({
    attachments: [{ idx: 0, filename: "video.mov", mime: "video/quicktime", size: 10_000_000, content_id: null }],
  });
  await compose.attachFrom(big, ME);
  expect(compose.state!.attachments).toHaveLength(1);
  expect(ui.errors.at(-1)).toMatch(/^video\.mov wasn't attached/);
});

test("closing a draft that can't be saved reopens it instead of dropping it", async () => {
  const { backend, ui, compose } = setup();
  await compose.write();
  backend.failing.add("save_draft");
  ui.type({ to: "ben@example.net", subject: "Important", body: "Don't lose me" });
  compose.touch();
  await compose.close();
  expect(ui.isOpen()).toBe(true);
  expect(ui.shown.at(-1)?.fields.subject).toBe("Important");
  expect(ui.errors.at(-1)).toMatch(/still open/);
  expect(ui.kept).toHaveLength(0);

  backend.failing.delete("save_draft");
  await compose.close();
  expect(ui.isOpen()).toBe(false);
  expect(ui.kept.map((f) => f.subject)).toEqual(["Important"]);
});

test("opening another email while a draft can't be saved keeps the first one open", async () => {
  const { backend, ui, compose } = setup();
  await compose.write();
  backend.failing.add("save_draft");
  ui.type({ to: "ben@example.net", body: "First" });
  compose.touch();
  await compose.open({ subject: "Second" });
  expect(ui.shown.at(-1)?.fields.body).toBe("First");
});

test("an untouched or empty composer closes without saving", async () => {
  const { backend, compose } = setup();
  await compose.write();
  await compose.close();
  expect(backend.of("save_draft")).toHaveLength(0);
});

test("discarding deletes the saved draft after any save under way", async () => {
  const { backend, ui, compose } = setup();
  await compose.write();
  backend.delays.set("save_draft", 20);
  ui.type({ to: "ben@example.net", body: "Never mind" });
  compose.touch();
  void compose.save();
  await compose.close(true);
  await flush();
  expect(backend.of("delete_draft")[0].args).toEqual({ account: ME, draftId: "d1" });
  expect(backend.drafts.size).toBe(0);
});

test("a reopened draft waits for its Gmail draft id before saving, and picks up its Bcc", async () => {
  const { backend, ui, compose } = setup(fakeMail({ threads: [{ id: "t9", account: ME } as never] }));
  backend.threads.set("t9", [message({ id: "m9", sender: ME, recipients: "ben@example.net", cc: "", subject: "Plan" })]);
  backend.found.set("t9", ["r-42", "m9", "boss@example.net"]);
  backend.delays.set("find_draft", 30);
  let bcc = "";
  expect(await compose.openDraft("t9", (b) => void (bcc = b))).toBe(true);
  expect(ui.shown[0].fields.subject).toBe("Plan");
  ui.type({ body: "Edited right away" });
  compose.touch();
  await compose.save();
  expect(backend.of("save_draft")[0].args.draftId).toBe("r-42");
  expect(bcc).toBe("boss@example.net");
});

test("changing the From account moves the draft to that account", async () => {
  const { backend, ui, compose } = setup();
  await compose.write();
  ui.type({ to: "ben@example.net", body: "Hi" });
  compose.touch();
  await compose.save();
  compose.setAccount(WORK);
  await compose.save();
  expect(backend.of("delete_draft")[0].args).toEqual({ account: ME, draftId: "d1" });
  expect(backend.of("save_draft")[1].args).toMatchObject({ account: WORK, draftId: null });
});

test("editing a scheduled email puts it back on its schedule when closed", async () => {
  const sendAt = Date.now() + 86_400_000;
  const row: Scheduled = {
    id: 7,
    account: ME,
    draft_id: "d7",
    send_at: sendAt,
    sending: false,
    error: null,
    draft: { to: "ben@example.net" },
    ui: { fields: { to: "ben@example.net", subject: "Later", body: "Hi" }, opts: { title: "New Email" } },
  };
  const { backend, ui, compose } = setup(fakeMail({ scheduledRows: new Map([["s7", row]]) }));
  await compose.editScheduled("s7");
  expect(backend.of("take_scheduled")).toHaveLength(1);
  ui.type({ body: "Hi, edited" });
  await compose.close();
  const resumed = backend.of("schedule_send")[0].args;
  expect(resumed).toMatchObject({ draftId: "d7", sendAt });
  expect(resumed.draft.body).toBe("Hi, edited");
  expect(ui.toasts.at(-1)?.msg).toMatch(/^Still scheduled for/);
});

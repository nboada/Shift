// Writing email, shared by the Mac's composer and the phone's compose sheet: the open email's state, drafts saved to
// Gmail as you type, sending (with Undo send), Send later, replies and forwards, signatures, attachments, reopening
// drafts and scheduled emails. It reaches the backend through `invoke` and the screen through the UI's `ComposeView`.
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { type Editor, generateHTML, generateJSON } from "@tiptap/core";
import { type OutFile, checkSize, readFile } from "../attachments";
import { docToText, emailHtml, textToHtml } from "../compose";
import { bareEmail, displayName, isValidAddress, splitAddresses, splitList } from "../recipients";
import { formatWhen } from "../schedule";
import { accountSettings, settings, signatureFor } from "../settings";
import type { Toast, ToastOptions } from "../toast";
import type { ReplyKind } from "../email-view";
import type { Fields, Invoke, MailCore, Message } from "./mail";

export type ReplyContext = { thread_id: string; in_reply_to: string; references: string };

export type ComposeOptions = {
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
export type ComposeState = Required<ComposeOptions>;

/** What the open composer holds: the fields as typed (`body` is the editor's HTML) and the email as sent. */
export type Content = { fields: Fields; text: string; html: string; typed: boolean };

/** The screen a composer core draws on: the Mac's dialog or the phone's sheet. */
export type ComposeView = {
  /** An email is about to open (before the one open now is closed). */
  opening?(): void;
  /** Shows the composer for `state`, filled with `fields`. */
  show(fields: Fields, state: ComposeState): void | Promise<void>;
  /** Takes it off screen. */
  hide(): void;
  read(): Content;
  status(text: string): void;
  error(text: string): void;
  /** The open email's files changed. */
  files(): void;
  /** Send is under way (true) or over. */
  busy?(on: boolean): void;
  /** A draft was closed and kept. */
  kept?(fields: Fields, state: ComposeState): void;
  /** A draft opened from the Drafts list was discarded. */
  discarded?(thread: string): void;
  /** The quoted original for a reply or forward, under `header`. */
  quote(m: Message, header: string): string;
  toast(msg: string, opts?: ToastOptions): Toast;
  /** Where drafts are kept, for messages: "in Gmail" or "on your mail server". */
  where(): string;
};

/** The account's signature block ("-- " separator for text, the email convention), or "" if it has none. */
export function signatureBlock(account: string) {
  const sig = signatureFor(account);
  if (sig.mode === "html") return sig.html.trim() ? "<p></p><div data-signature></div>" : "";
  return sig.text.trim() ? `<p></p>${textToHtml(`-- \n${sig.text.trim()}`)}` : "";
}

/** An empty line to write on, then the account's signature. */
export const signature = (account: string) => "<p></p>" + signatureBlock(account);

/** The editor's email as sent, HTML plus a plain-text version, and whether anything is written in it. */
export function editorContent(editor: Editor, account: string | undefined) {
  const sigHtml = signatureFor(account).html;
  const sigText =
    new DOMParser().parseFromString(sigHtml.replace(/<br\s*\/?>/gi, "\n"), "text/html").body.textContent ?? "";
  return {
    text: docToText(editor.state.doc, sigText),
    html: emailHtml(editor.getHTML(), sigHtml),
    typed: !!editor.getText().trim(),
  };
}

/** After a From change: the new account's signature replaces the old one, unless the old block no longer appears as inserted (edited). */
export function swapSignature(editor: Editor, from: string, to: string) {
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

/** The editing instructions in the Write with AI menu. */
export const AI_EDITS: [label: string, icon: string, instruction: string][] = [
  ["Improve writing", "wand", "Improve the writing: clearer and more natural, same meaning, roughly the same length."],
  ["Make shorter", "arrows-diagonal-minimize-2", "Make it shorter and more direct, keeping everything important."],
  ["Make friendlier", "mood-smile", "Make it warmer and friendlier."],
  ["Make more formal", "tie", "Make it more formal and professional."],
  ["Fix spelling & grammar", "text-spellcheck", "Fix spelling, grammar and punctuation only. Change nothing else."],
];

/** The selection, or everything above the signature and the quoted original (and its "On …, X wrote:" line). */
export function ownText(editor: Editor): { from: number; to: number; text: string } {
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

/** Quoted history in an HTML email: Gmail, Apple Mail, Thunderbird, Yahoo and Outlook (as public/email-frame.js folds it). */
const QUOTE_HTML = ".gmail_quote, blockquote[type=cite], .moz-cite-prefix, .yahoo_quoted, #divRplyFwdMsg, #appendonsend";
/** Where quoted history starts in a plain-text email: "On … wrote:" (it can wrap onto a second line), Outlook's
 * "-----Original Message-----" or "From: … Sent:" header, or the first "> " line. */
const QUOTE_TEXT = [
  /^On [^\n]*(\n[^\n]*)?wrote:\s*$/m,
  /^-{2,}\s*Original Message\s*-{2,}/im,
  /^From: [^\n]*\n(Sent|Date): /m,
  /^>/m,
];

/** An email's own text for the AI, without the quoted history under a reply: the conversation's earlier emails are
 * sent separately, and the quote could crowd out what this one says. An email that's all quote keeps it. */
export function messageText(m: Pick<Message, "text" | "html">) {
  const tidy = (t: string) => t.replace(/\n{3,}/g, "\n\n").trim();
  let text: string;
  if (m.text != null) {
    const cut = Math.min(...QUOTE_TEXT.map((re) => m.text!.search(re)).filter((i) => i >= 0), m.text.length);
    text = m.text.slice(0, cut);
    if (!text.trim()) text = m.text;
  } else {
    const body = new DOMParser().parseFromString(m.html ?? "", "text/html").body;
    const full = body.textContent ?? "";
    for (const q of body.querySelectorAll(QUOTE_HTML)) {
      // The quote is that element and everything after it in its block (Outlook puts the header first).
      for (let n = q.nextSibling; n; n = q.nextSibling) n.remove();
      q.remove();
    }
    text = body.textContent?.trim() ? body.textContent : full;
  }
  return tidy(text);
}

export type Composer = ReturnType<typeof createComposer>;

export function createComposer(mail: MailCore, view: ComposeView, invoke: Invoke = tauriInvoke as Invoke) {
  let state: ComposeState | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  /** Composers being sent or scheduled: a second ⌘↩ or tap during the first must not send the email twice. */
  const submitting = new WeakSet<ComposeState>();
  /** A forward's files still downloading; Send and Send later wait for them so the email doesn't go out without them. */
  const pendingFiles = new WeakMap<ComposeState, Promise<void>>();

  const fields = () => view.read().fields;

  /** The message as the backend expects it: HTML from the editor plus a plain-text version. */
  function payload(s: ComposeState): Record<string, unknown> {
    const c = view.read();
    return {
      to: c.fields.to ?? "",
      cc: c.fields.cc ?? "",
      bcc: c.fields.bcc ?? "",
      subject: c.fields.subject ?? "",
      body: c.text,
      html: c.html,
      from_name: accountSettings(s.account).name,
      ...(s.context ?? {}),
      attachments: s.attachments,
    };
  }

  function hasContent() {
    if (!state?.touched) return false;
    const c = view.read();
    const f = c.fields;
    return !!(state.attachments.length || c.typed || f.subject?.trim() || f.to || f.cc || f.bcc);
  }

  function touch() {
    if (!state) return;
    state.touched = true;
    clearTimeout(timer);
    // drafts.update replaces the whole message, so every save re-uploads the files; with big ones, save less often.
    const bytes = state.attachments.reduce((n, f) => n + f.size, 0);
    timer = setTimeout(() => save(), bytes > 1_000_000 ? 15_000 : 1500);
  }

  /**
   * Saves are queued, so a slow save can't race the next one into creating a duplicate draft. Resolves to whether this
   * save reached Gmail.
   */
  function save(s = state, draft = s && payload(s)): Promise<boolean> {
    clearTimeout(timer);
    if (!s || !draft) return queue.then(() => true);
    view.status("Saving…");
    // The account is fixed now; the draft id is read when the save runs, after the saves queued before it.
    const account = s.account;
    const saved = queue.then(() =>
      invoke<string>("save_draft", { account, draft, draftId: s.draftId })
        .then((id) => {
          s.draftId = id;
          if (state === s) view.status("Saved");
          return true;
        })
        .catch(() => {
          if (state === s) view.status("Not saved — will retry");
          return false;
        }),
    );
    queue = saved;
    return saved;
  }

  const ui = (s: ComposeState, f: Fields) => ({ fields: f, opts: { title: s.title, context: s.context } });

  /** Schedules an edited scheduled email again for the time it had (`resumeAt`). */
  const resume = (s: ComposeState, draft: unknown, f: Fields) =>
    invoke("schedule_send", { account: s.account, draft, draftId: s.draftId, sendAt: s.resumeAt, ui: ui(s, f) });

  async function open(f: Fields = {}, opts: ComposeOptions = {}) {
    view.opening?.();
    if (state) {
      await close();
      // Its draft couldn't be saved, so it came back open: keep it rather than replace it.
      if (state) return;
    }
    const inline = !!opts.inline && !!mail.selected && (!opts.context || opts.context.thread_id === mail.selected);
    state = {
      title: opts.title ?? "New Email",
      context: opts.context ?? null,
      inline,
      draftId: opts.draftId ?? null,
      touched: !!opts.touched,
      account: opts.account ?? mail.defaultAccount(),
      attachments: opts.attachments ?? [],
      resumeAt: opts.resumeAt ?? null,
      thread: opts.thread ?? null,
    };
    await view.show(f, state);
    view.error("");
    view.status(state.draftId ? "Saved" : "");
  }

  /** Closes the composer, keeping the draft (default) or deleting it. */
  async function close(discard = false) {
    const s = state;
    if (!s) return;
    const keep = !discard && hasContent();
    const draft = keep ? payload(s) : null;
    const f = fields();
    state = null;
    clearTimeout(timer);
    view.hide();
    if (discard) {
      if (s.thread) view.discarded?.(s.thread);
      await queue;
      if (s.draftId) invoke("delete_draft", { account: s.account, draftId: s.draftId }).catch(() => {});
    } else if (keep) {
      if (await save(s, draft)) {
        // Saving only reaches Gmail; a sync brings the draft into its conversation (and Drafts) now rather than on
        // the next tick, so it shows in the open conversation as soon as the composer closes.
        void invoke("sync_now").catch(() => {});
        if (!s.resumeAt) return view.kept?.(f, s);
        if (s.resumeAt <= Date.now()) return void view.toast("Its send time passed while you edited, so it's in Drafts");
        return resume(s, draft, f).then(
          () => void view.toast(`Still scheduled for ${formatWhen(new Date(s.resumeAt!))}`),
          (err) => void view.toast(`Couldn't schedule it again, so it's in Drafts: ${err}`),
        );
      }
      // Not in Gmail: bring it back rather than lose it, unless another email was opened meanwhile.
      if (state) return void view.toast(`Couldn't save a draft ${view.where()}; it wasn't kept`, { kind: "error" });
      await open(f, { ...s, touched: true });
      view.error(`Couldn't save this draft ${view.where()}, so it's still open. Check your connection and close it again.`);
    }
  }

  /** Sends from another account. A Gmail draft lives in one account, so it's deleted there (after any save already
   *  queued) and the next save creates it in the new one. */
  function setAccount(account: string) {
    const s = state;
    if (!s || s.account === account) return;
    const prev = s.account;
    queue = queue.then(() => {
      const id = s.draftId;
      s.draftId = null;
      if (id) return invoke("delete_draft", { account: prev, draftId: id }).catch(() => {});
    });
    s.account = account;
  }

  function recipientProblem(f: Fields) {
    const all = [f.to ?? "", f.cc ?? "", f.bcc ?? ""].flatMap(splitList);
    if (!all.length) return "Add at least one recipient";
    const bad = all.find((a) => !isValidAddress(a));
    return bad ? `Check this address: ${bad}` : "";
  }

  /** Waits for a forward's files, saying so while it does. */
  async function filesReady(s: ComposeState) {
    const pending = pendingFiles.get(s);
    if (!pending) return;
    view.error("Attaching files…");
    await pending;
    view.error("");
  }

  async function send() {
    const s = state;
    if (!s || submitting.has(s)) return;
    const problem = recipientProblem(fields());
    if (problem) return view.error(problem);
    submitting.add(s);
    await filesReady(s);
    if (state !== s) return void submitting.delete(s);
    const draft = payload(s);
    const f = fields();
    // Let any pending save finish first, so it can't recreate the draft after it's been sent.
    clearTimeout(timer);
    await queue;
    const reopen = (msg = "") => open(f, { ...s, touched: true }).then(() => view.error(msg));
    const delay = settings.composer.undoSendSeconds;
    if (delay > 0) {
      // Undo send goes through the scheduled queue, due in `delay` seconds: it's saved in Drafts and on this device, so
      // quitting or restarting for an update during the countdown still sends it, and Undo cancels the schedule.
      let id: number;
      try {
        if (!(await save(s, draft)))
          throw new Error("Couldn't save it to Drafts, so it wasn't sent. Check your connection and try again");
        id = await invoke<number>("schedule_send", {
          account: s.account,
          draft,
          draftId: s.draftId,
          sendAt: Date.now() + delay * 1000,
          ui: ui(s, f),
        });
      } catch (err) {
        submitting.delete(s);
        return view.error(err instanceof Error ? err.message : String(err));
      }
      state = null;
      view.hide();
      const sending = view.toast(`Sending in ${delay}s…`, {
        ms: delay * 1000,
        action: {
          label: "Undo",
          run: () => {
            clearInterval(tick);
            invoke("reschedule", { account: s.account, id, sendAt: null }).then(
              () => reopen(),
              (err) => void view.toast(String(err)),
            );
          },
        },
      });
      let left = delay;
      // open: another toast may have replaced this one mid-countdown.
      const tick = setInterval(() => {
        if (!sending.open || left <= 1) return clearInterval(tick);
        sending.setMessage(`Sending in ${--left}s…`);
      }, 1000);
      return;
    }
    view.busy?.(true);
    try {
      await invoke("send", { account: s.account, draft, draftId: s.draftId });
      state = null;
      view.hide();
      view.toast("Message sent", { kind: "success" });
    } catch (err) {
      // Still open: the user can fix the problem and send again.
      submitting.delete(s);
      view.error(String(err));
    } finally {
      view.busy?.(false);
    }
  }

  /** Send later. Resolves to whether it was scheduled. */
  async function schedule(at: Date): Promise<boolean> {
    const s = state;
    if (!s || submitting.has(s)) return false;
    const problem = recipientProblem(fields());
    if (problem) return (view.error(problem), false);
    if (at.getTime() <= Date.now()) return (view.error("Pick a time in the future"), false);
    submitting.add(s);
    await filesReady(s);
    if (state !== s) return (submitting.delete(s), false);
    const draft = payload(s);
    const f = fields();
    // Saved to Gmail Drafts first, so the email is safe there (and visible on other devices) until it goes out.
    await save(s, draft);
    try {
      const id = await invoke<number>("schedule_send", {
        account: s.account,
        draft,
        draftId: s.draftId,
        sendAt: at.getTime(),
        ui: ui(s, f),
      });
      state = null;
      view.hide();
      view.toast(`Scheduled for ${formatWhen(at)}`, {
        ms: 6000,
        action: {
          label: "Undo",
          run: () =>
            void invoke("reschedule", { account: s.account, id, sendAt: null }).then(() =>
              open(f, { ...s, touched: true, resumeAt: null }),
            ),
        },
      });
      return true;
    } catch (err) {
      submitting.delete(s);
      view.error(String(err));
      return false;
    }
  }

  /** Adds files picked or dropped by the user, up to Gmail's limit. */
  async function addFiles(list: Iterable<File>, read: (f: File) => Promise<OutFile> = readFile) {
    const s = state;
    if (!s) return;
    for (const file of list) {
      const tooBig = checkSize(s.attachments, file.size);
      if (tooBig) {
        view.error(tooBig);
        break;
      }
      const f = await read(file).catch(() => null);
      if (state !== s) return;
      if (!f) continue;
      s.attachments.push(f);
      view.files();
      touch();
    }
  }

  function removeFile(i: number) {
    if (!state) return;
    state.attachments.splice(i, 1);
    view.files();
    touch();
  }

  async function downloadFiles(s: ComposeState, m: Message, account: string) {
    for (const a of m.attachments) {
      const name = a.filename || "attachment";
      // Same 25 MB limit as files added by hand, checked before downloading; smaller files after it can still fit.
      const tooBig = checkSize(s.attachments, a.size);
      if (tooBig) {
        view.error(`${name} wasn't attached. ${tooBig}`);
        continue;
      }
      const data = await invoke<string>("attachment_data", { account, message: m.id, idx: a.idx }).catch(() => null);
      if (state !== s) return;
      if (data === null) {
        view.toast(`Couldn't attach ${name}`, { kind: "error" });
        continue;
      }
      s.attachments.push({ name, mime: a.mime, data, size: a.size });
      view.files();
    }
  }

  /** Adds `m`'s files to the open composer (a forward, a reopened draft). Send waits for them (`pendingFiles`). */
  function attachFrom(m: Message, account: string) {
    const s = state;
    if (!s) return Promise.resolve();
    const files = downloadFiles(s, m, account);
    pendingFiles.set(
      s,
      files.finally(() => pendingFiles.delete(s)),
    );
    return files;
  }

  /** Replies to or forwards `last`: the newest message, or the one whose own buttons were clicked. */
  function reply(kind: ReplyKind, last = mail.messages.at(-1)) {
    if (!last || !mail.selected) return;
    const thread = mail.threads.find((t) => t.id === mail.selected);
    const account = thread?.account ?? mail.defaultAccount();
    const notMe = (a: string) => !mail.accounts.includes(bareEmail(a));
    const when = new Date(last.date).toLocaleString();
    const inline = settings.composer.replyIn === "inline";
    if (kind === "forward") {
      const header = textToHtml(
        `---------- Forwarded message ----------\nFrom: ${last.sender}\nDate: ${when}\nSubject: ${last.subject}\nTo: ${last.recipients}`,
      );
      const opened = open(
        {
          subject: /^fwd?:/i.test(last.subject) ? last.subject : `Fwd: ${last.subject}`,
          body: signature(account) + view.quote(last, header),
        },
        { title: "Forward", inline, account },
      );
      return opened.then(() => attachFrom(last, account));
    }
    const mine = !notMe(last.sender);
    const primary = mine ? splitAddresses(last.recipients) : [last.reply_to || last.sender];
    const others = kind === "all" ? [...splitAddresses(last.recipients), ...splitAddresses(last.cc)] : [];
    const cc = [...new Set(others.filter((a) => notMe(a) && !primary.some((p) => bareEmail(p) === bareEmail(a))))];
    const header = textToHtml(`On ${when}, ${displayName(last.sender)} wrote:`);
    return open(
      {
        to: primary.join(", "),
        cc: cc.join(", "),
        subject: /^re:/i.test(last.subject) ? last.subject : `Re: ${last.subject}`,
        body: signature(account) + (settings.composer.quoteOriginal ? view.quote(last, header) : ""),
      },
      {
        title: kind === "all" ? "Reply all" : "Reply",
        context: { thread_id: mail.selected, in_reply_to: last.message_id, references: last.refs },
        inline,
        account,
      },
    );
  }

  /** A new email from the default account, with its signature. */
  const write = (f: Fields = {}) => {
    const account = mail.defaultAccount();
    return open({ body: signature(account), ...f }, { account });
  };

  /**
   * Opens a Drafts row in the composer straight from the cache; the Gmail draft id and Bcc (which the cache doesn't
   * keep) are looked up meanwhile, queued ahead of any save so an early save replaces this draft instead of adding one.
   * False when it isn't there, so the email opens read-only instead.
   */
  async function openDraft(id: string, setBcc: (bcc: string) => void): Promise<boolean> {
    const account = mail.threads.find((t) => t.id === id)?.account ?? mail.defaultAccount();
    const lookup = invoke<[string, string, string] | null>("find_draft", { account, thread: id }).catch(() => null);
    const msgs = await invoke<Message[]>("thread", { account, id }).catch(() => [] as Message[]);
    // The draft is the newest message in its conversation; a reply draft answers the one before it.
    const m = msgs.at(-1);
    if (!m) return false;
    const earlier = msgs.at(-2);
    await open(
      { to: m.recipients, cc: m.cc, subject: m.subject, body: m.html ?? textToHtml(m.text ?? "") },
      {
        title: "Draft",
        account,
        inline: false,
        thread: id,
        context: earlier ? { thread_id: id, in_reply_to: earlier.message_id, references: m.refs } : null,
      },
    );
    const s = state;
    if (!s) return true;
    queue = queue.then(async () => {
      const found = await lookup;
      if (!found) {
        if (state === s) view.error(`Couldn't find this draft ${view.where()}; saving makes a new one.`);
        return;
      }
      const [draftId, , bcc] = found;
      s.draftId = draftId;
      if (state !== s) return;
      view.status("Saved");
      if (bcc && !fields().bcc) {
        setBcc(bcc);
        // A save made before the Bcc arrived went out without it.
        if (s.touched) touch();
      }
    });
    void attachFrom(m, account);
    return true;
  }

  /** Opening a scheduled email pauses it while it's edited; closing the composer schedules it again for the same time. */
  async function editScheduled(id: string) {
    const r = mail.scheduledRows.get(id);
    if (!r) return;
    // One step in the backend, so it can't be sent between reading it and taking it off the schedule.
    let attachments: OutFile[] | null;
    try {
      attachments = await invoke<OutFile[] | null>("take_scheduled", { account: r.account, id: r.id });
    } catch (err) {
      mail.refresh();
      return void view.toast(String(err), { kind: "error" });
    }
    await open(r.ui.fields, {
      ...(r.ui.opts as ComposeOptions),
      account: r.account,
      draftId: r.draft_id,
      attachments: attachments ?? [],
      touched: true,
      inline: false,
      resumeAt: r.send_at,
    });
    view.toast("Paused while you edit. Closing keeps it scheduled.");
  }

  function scheduledAction(action: string, id: string) {
    const r = mail.scheduledRows.get(id);
    if (!r) return;
    if (action === "edit") return editScheduled(id);
    if (action === "sendNow") return invoke("reschedule", { account: r.account, id: r.id, sendAt: Date.now() });
    if (action === "cancel" || action === "trash") {
      return invoke("reschedule", { account: r.account, id: r.id, sendAt: null }).then(
        () => void view.toast("Send cancelled. The email is in Drafts."),
      );
    }
  }

  /** Saves an open draft before the app quits, putting a scheduled email being edited back on its schedule. */
  async function flush() {
    const s = state;
    if (!s || !hasContent()) return;
    const draft = payload(s);
    const f = fields();
    if ((await save(s, draft)) && s.resumeAt && s.resumeAt > Date.now()) await resume(s, draft, f).catch(() => {});
  }

  /** Asks the AI to draft a reply to the open conversation, from the user's `notes`. */
  function aiReply(notes: string) {
    const s = state;
    if (!s) return Promise.reject(new Error("No email is open"));
    const name = accountSettings(s.account).name;
    // A draft already in the conversation isn't part of it yet: only what was sent and received.
    const conversation = mail.messages
      .filter((m) => !m.draft)
      .slice(-8)
      .map((m) => `From: ${m.sender}\nDate: ${new Date(m.date).toLocaleString()}\n\n${messageText(m).slice(0, 4000)}`)
      .join("\n\n---\n\n");
    return invoke<string>("ai_draft_reply", {
      conversation,
      notes,
      me: name ? `${name} <${s.account}>` : s.account,
      rules: settings.ai.writingRules,
    });
  }

  const aiRewrite = (text: string, instruction: string) =>
    invoke<string>("ai_rewrite", { text, instruction, rules: settings.ai.writingRules });

  return {
    get state() {
      return state;
    },
    open,
    close,
    write,
    touch,
    save: () => save(),
    hasContent,
    setAccount,
    send,
    schedule,
    addFiles,
    removeFile,
    attachFrom,
    reply,
    openDraft,
    editScheduled,
    scheduledAction,
    flush,
    aiReply,
    aiRewrite,
  };
}

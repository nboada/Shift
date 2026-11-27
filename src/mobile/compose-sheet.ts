// The phone's compose sheet: a full-screen sheet that slides up, with the formatting bar on the keyboard. What it does
// (drafts, sending, Undo send, Send later, replies, attachments) is the shared core in core/composer.ts.
import { invoke } from "@tauri-apps/api/core";
import { attachmentButton, fileIcon } from "../attachments";
import { textToHtml } from "../compose";
import { AI_EDITS, createComposer, editorContent, ownText, swapSignature } from "../core/composer";
import type { MailCore, Message } from "../core/mail";
import { askText } from "../dialog";
import { createEditor, foldReplyQuote } from "../editor";
import { type ReplyKind, esc, quoted, renderQuote } from "../email-view";
import { iconClass } from "../icons";
import { Recipients } from "../recipients";
import { formatWhen, quickTimes } from "../schedule";
import { accountSettings, settings, signatureFor } from "../settings";
import { toast } from "../toast";
import { type Item, actionSheet } from "./sheet";

/** How far the sheet is pulled down before letting go closes it. */
const CLOSE_AT = 120;
const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

const icon = (name: string) => `<i class="${iconClass(name)}" aria-hidden="true"></i>`;
const tool = (act: string, glyph: string, label: string) =>
  `<button type="button" class="m-icon" data-act="${act}" aria-label="${label}">${icon(glyph)}</button>`;
const reduced = () => settings.accessibility.reduceMotion || matchMedia("(prefers-reduced-motion: reduce)").matches;

/** `discarded`: a draft opened from the Drafts list was deleted, so its row can go at once. */
export function createComposeSheet(mail: MailCore, on: { discarded?: (thread: string) => void } = {}) {
  const d = document.createElement("dialog");
  d.className = "m-compose";
  d.setAttribute("aria-labelledby", "mc-title");
  d.innerHTML = `<header class="mc-bar">
      <div class="mc-grab" aria-hidden="true"></div>
      <button type="button" class="mc-cancel" data-act="cancel">Cancel</button>
      <h1 id="mc-title" class="mc-title"></h1>
      <button type="button" class="mc-send" data-act="send" aria-label="Send">${icon("arrow-up")}</button>
    </header>
    <div class="mc-scroll">
      <div class="mc-row mc-from" hidden><span>From:</span><button type="button" data-act="from"></button></div>
      <div class="mc-row"><span>To:</span><div class="rcpt" data-rcpt="to"><input type="email" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="next" aria-label="To" /></div><button type="button" class="mc-cc-toggle" data-act="cc">Cc/Bcc</button></div>
      <div class="mc-row" data-row="cc" hidden><span>Cc:</span><div class="rcpt" data-rcpt="cc"><input type="email" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Cc" /></div></div>
      <div class="mc-row" data-row="bcc" hidden><span>Bcc:</span><div class="rcpt" data-rcpt="bcc"><input type="email" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Bcc" /></div></div>
      <label class="mc-row"><span>Subject:</span><input class="mc-subject" autocomplete="off" enterkeyhint="next" /></label>
      <div class="mc-files attachments" hidden></div>
      <p class="mc-error" role="alert"></p>
      <div class="mc-body"></div>
    </div>
    <footer class="mc-tools" role="toolbar" aria-label="Formatting">
      ${tool("bold", "bold", "Bold")}${tool("italic", "italic", "Italic")}${tool("bulletList", "list", "Bulleted list")}${tool("orderedList", "list-numbers", "Numbered list")}${tool("link", "link", "Link")}
      <span class="mc-status" aria-live="polite"></span>
      ${tool("attach", "paperclip", "Attach photos or files")}${tool("later", "clock", "Send later")}${tool("ai", "message-ai", "Write with AI")}
    </footer>
    <div class="mc-float" hidden><input /></div>
    <input type="file" class="mc-file" multiple hidden />`;
  document.body.append(d);

  const $ = <T extends HTMLElement = HTMLElement>(sel: string) => d.querySelector<T>(sel)!;
  const subject = $<HTMLInputElement>(".mc-subject");
  const files = $(".mc-files");
  const fileInput = $<HTMLInputElement>(".mc-file");
  const tools = $(".mc-tools");
  const status = (text: string) => ($(".mc-status").textContent = text);
  const error = (text: string) => ($(".mc-error").textContent = text);

  const editor = createEditor(
    $(".mc-body"),
    $(".mc-float"),
    () => compose.touch(),
    () => signatureFor(compose.state?.account).html,
    renderQuote,
  );
  const suggest = (q: string) => invoke<string[]>("suggest_contacts", { query: q }).catch(() => [] as string[]);
  const field = (name: string) => new Recipients($(`[data-rcpt=${name}]`), suggest, () => compose.touch());
  const rcpt = { to: field("to"), cc: field("cc"), bcc: field("bcc") };

  function showCc(cc: boolean, bcc: boolean) {
    $("[data-row=cc]").hidden = !cc;
    $("[data-row=bcc]").hidden = !bcc;
    $(".mc-cc-toggle").setAttribute("aria-expanded", String(cc && bcc));
  }

  function renderFrom() {
    const s = compose.state;
    const row = $(".mc-from");
    row.hidden = mail.accounts.length < 2 || !s || !!s.context;
    if (row.hidden || !s) return;
    const a = accountSettings(s.account);
    row.querySelector("button")!.innerHTML =
      `<span class="account-dot acct-${a.color}"></span>${esc(a.title || s.account)}${icon("caret-up-down")}`;
  }

  function renderFiles() {
    const list = compose.state?.attachments ?? [];
    files.hidden = !list.length;
    files.innerHTML = list.map((f, i) => attachmentButton(fileIcon(f.mime, f.name), f.name, f.size, { i }, true)).join("");
  }

  const fields = () => ({
    to: rcpt.to.value,
    cc: rcpt.cc.value,
    bcc: rcpt.bcc.value,
    subject: subject.value,
    body: editor.getHTML(),
  });

  let hiding: Animation | null = null;

  const compose = createComposer(mail, {
    show(f, state) {
      hiding?.cancel();
      hiding = null;
      $("#mc-title").textContent = state.title;
      rcpt.to.set(f.to ?? "");
      rcpt.cc.set(f.cc ?? "");
      rcpt.bcc.set(f.bcc ?? "");
      showCc(!!f.cc, !!f.bcc);
      subject.value = f.subject ?? "";
      editor
        .chain()
        .setContent(f.body ?? "", { emitUpdate: false })
        .setTextSelection(0)
        .run();
      foldReplyQuote(editor);
      renderFrom();
      renderFiles();
      d.style.transform = "";
      if (!d.open) d.showModal();
      $(".mc-scroll").scrollTop = 0;
      void aiAvailable();
      if (f.to || state.context) editor.commands.focus("start");
      else rcpt.to.focus();
    },
    hide() {
      (document.activeElement as HTMLElement | null)?.blur();
      if (reduced()) return d.close();
      const from = d.style.transform || "translateY(0)";
      d.style.transform = "";
      hiding = d.animate([{ transform: from }, { transform: "translateY(100%)" }], {
        duration: 320,
        easing: EASE,
        fill: "forwards",
      });
      hiding.finished.then(
        () => {
          hiding?.cancel();
          hiding = null;
          if (!compose.state) d.close();
        },
        () => {},
      );
    },
    read: () => ({ fields: fields(), ...editorContent(editor, compose.state?.account) }),
    status,
    error,
    files: renderFiles,
    busy: (on) => ($<HTMLButtonElement>(".mc-send").disabled = on),
    kept: (f, state) =>
      void toast(`Saved to Drafts${f.subject ? `: ${f.subject}` : ""}`, {
        icon: "file",
        action: { label: "Open", run: () => void compose.open(f, { ...state, touched: false }) },
      }),
    discarded: (thread) => on.discarded?.(thread),
    quote: quoted,
    toast,
    where: () => (mail.imapAccounts.has(compose.state?.account ?? "") ? "on your mail server" : "in Gmail"),
  });

  subject.addEventListener("input", () => compose.touch());

  // ---- the bar: Cancel, Send, and swiping the sheet down to keep the draft

  /** Cancel: an empty email just closes; otherwise, like Mail, delete or keep it as a draft. */
  function cancel() {
    // A draft already saved (reopened from Drafts) can be deleted even if nothing was changed.
    const saved = !!(compose.state?.draftId || compose.state?.thread);
    if (!compose.hasContent() && !saved) return void compose.close();
    actionSheet("", [
      { label: "Delete Draft", icon: "trash", danger: true, run: () => void compose.close(true) },
      { label: "Save Draft", icon: "file", run: () => void compose.close() },
    ]);
  }

  d.addEventListener("click", (e) => {
    const act = (e.target as Element).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act) void run(act);
    const remove = (e.target as Element).closest<HTMLElement>(".attachment-remove");
    if (remove) compose.removeFile(Number(remove.closest<HTMLElement>(".attachment")!.dataset.i));
  });
  // Format buttons keep the editor's focus, so the keyboard stays up.
  tools.addEventListener("mousedown", (e) => {
    if ((e.target as Element).closest("[data-act]")) e.preventDefault();
  });

  async function run(act: string) {
    switch (act) {
      case "cancel":
        return cancel();
      case "send":
        return compose.send();
      case "cc":
        if ($(".mc-cc-toggle").getAttribute("aria-expanded") === "true") {
          showCc(!!rcpt.cc.value, !!rcpt.bcc.value);
          return rcpt.to.focus();
        }
        showCc(true, true);
        return rcpt.cc.focus();
      case "from":
        return pickFrom();
      case "bold":
        return editor.chain().focus().toggleBold().run();
      case "italic":
        return editor.chain().focus().toggleItalic().run();
      case "bulletList":
        return editor.chain().focus().toggleBulletList().run();
      case "orderedList":
        return editor.chain().focus().toggleOrderedList().run();
      case "link":
        return link();
      case "attach":
        return fileInput.click();
      case "later":
        return later();
      case "ai":
        return aiMenu();
    }
  }

  const syncTools = () =>
    tools
      .querySelectorAll<HTMLElement>("[data-act]")
      .forEach((b) => b.classList.toggle("on", editor.isActive(b.dataset.act!)));
  editor.on("transaction", syncTools);

  // Dragging the bar down moves the sheet with the finger; far enough, letting go closes it and keeps the draft.
  $(".mc-bar").addEventListener("pointerdown", (e) => {
    if ((e.target as Element).closest("button")) return;
    const y0 = e.clientY;
    let dy = 0;
    const bar = e.currentTarget as HTMLElement;
    bar.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      dy = Math.max(0, ev.clientY - y0);
      d.style.transform = `translateY(${dy}px)`;
    };
    const up = () => {
      bar.removeEventListener("pointermove", move);
      bar.removeEventListener("pointerup", up);
      bar.removeEventListener("pointercancel", up);
      if (dy > CLOSE_AT) return void compose.close();
      const back = d.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], {
        duration: 300,
        easing: EASE,
      });
      d.style.transform = "";
      void back.finished.catch(() => {});
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up);
    bar.addEventListener("pointercancel", up);
  });

  // The app's keyboard shortcuts stay out of the sheet; a hardware keyboard gets ⌘↩ to send and Escape to cancel.
  d.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && e.metaKey) {
      e.preventDefault();
      void compose.send();
    }
  });
  d.addEventListener("cancel", (e) => {
    e.preventDefault();
    cancel();
  });

  // The keyboard shrinks what's visible (--visible-height, set in main.ts); WebKit can also scroll the page under it.
  const vv = window.visualViewport;
  if (vv) {
    const fit = () => d.style.setProperty("--vv-top", `${vv.offsetTop}px`);
    vv.addEventListener("resize", fit);
    vv.addEventListener("scroll", fit);
  }
  // With the keyboard up, the tools sit on it rather than above the home indicator.
  const typing = () =>
    d.classList.toggle("keyboard", !!document.activeElement?.closest("input, textarea, [contenteditable]"));
  d.addEventListener("focusin", typing);
  d.addEventListener("focusout", () => setTimeout(typing));

  // ---- From

  function pickFrom() {
    const s = compose.state;
    if (!s) return;
    actionSheet(
      "Send from",
      mail.accounts.map(
        (a): Item => ({
          label: accountSettings(a).title || a,
          icon: "user",
          checked: a === s.account,
          run: () => {
            if (a === s.account) return;
            const prev = s.account;
            compose.setAccount(a);
            swapSignature(editor, prev, a);
            renderFrom();
            compose.touch();
          },
        }),
      ),
    );
  }

  // ---- links and files

  async function link() {
    const { from, to } = editor.state.selection;
    const current = editor.getAttributes("link").href ?? "";
    const v = (await askText({ title: "Link", message: "Paste or type a web or email address.", confirm: "Add", value: current }))?.trim();
    if (v === undefined) return;
    const href = !v || /^[a-z][\w+.-]*:/i.test(v) ? v : /^[^/\s]+@[^/\s]+$/.test(v) ? `mailto:${v}` : `https://${v}`;
    const chain = editor.chain().focus().setTextSelection({ from, to }).extendMarkRange("link");
    if (!href) chain.unsetLink().run();
    else if (from === to && !editor.isActive("link"))
      chain.insertContent({ type: "text", text: v, marks: [{ type: "link", attrs: { href } }] }).run();
    else chain.setLink({ href }).run();
  }

  fileInput.addEventListener("change", () => {
    void compose.addFiles([...(fileInput.files ?? [])]);
    fileInput.value = "";
  });

  // ---- Send later

  function later() {
    const times = quickTimes(new Date(), settings.scheduling);
    actionSheet("Send later", [
      ...times.map((t): Item => ({ label: `${t.label} · ${formatWhen(t.at)}`, icon: "clock", run: () => void compose.schedule(t.at) })),
      { label: "Pick Date & Time…", icon: "calendar", run: () => pickTime(times.find((t) => t.id === "tomorrow")!.at) },
    ]);
  }

  /** The system's date and time wheels, in a sheet with a summary and Schedule. */
  function pickTime(at: Date) {
    const local = (t: Date) => new Date(t.getTime() - t.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    const p = document.createElement("dialog");
    p.className = "m-sheet mc-picker";
    p.setAttribute("aria-label", "Pick a send time");
    p.innerHTML = `<div class="m-sheet-group">
        <h2>Send later</h2>
        <label class="mc-when">${icon("calendar")}<input type="datetime-local" min="${local(new Date())}" value="${local(at)}" /></label>
        <p class="mc-summary"></p>
        <button type="button" class="mc-schedule">Schedule</button>
      </div>
      <div class="m-sheet-group"><button type="button" class="m-sheet-cancel">Cancel</button></div>`;
    const input = p.querySelector("input")!;
    const go = p.querySelector<HTMLButtonElement>(".mc-schedule")!;
    const update = () => {
      const t = input.value ? new Date(input.value) : null;
      const past = !t || t.getTime() <= Date.now();
      p.querySelector(".mc-summary")!.textContent = !t ? "Pick a time" : past ? "That time has passed" : `Sends ${formatWhen(t)}`;
      go.disabled = past;
    };
    input.addEventListener("input", update);
    go.addEventListener("click", () => {
      void compose.schedule(new Date(input.value)).then((ok) => ok && p.close());
    });
    p.addEventListener("click", (e) => {
      if (e.target === p || (e.target as Element).closest(".m-sheet-cancel")) p.close();
    });
    p.addEventListener("close", () => p.remove());
    document.body.append(p);
    p.showModal();
    update();
  }

  // ---- Write with AI, when a provider is set up

  async function aiAvailable() {
    const provider = settings.ai.tasks.writing.provider || settings.ai.provider;
    const has = await invoke<boolean>("has_ai_key", { provider }).catch(() => false);
    $("[data-act=ai]").hidden = !has;
  }

  async function aiWrite(work: () => Promise<string>, range: { from: number; to: number }) {
    const b = $<HTMLButtonElement>("[data-act=ai]");
    b.disabled = true;
    b.classList.add("busy");
    status("Writing with AI…");
    try {
      const text = await work();
      if (!text) throw new Error("The AI returned nothing");
      editor.chain().focus().insertContentAt(range, textToHtml(text)).run();
      compose.touch();
    } catch (e) {
      toast(String(e), { kind: "error" });
    } finally {
      status("");
      b.disabled = false;
      b.classList.remove("busy");
    }
  }

  function aiMenu() {
    const s = compose.state;
    if (!s) return;
    const own = ownText(editor);
    const rewrite = (instruction: string) => aiWrite(() => compose.aiRewrite(own.text, instruction), own);
    const items: Item[] = [];
    if (s.context && mail.messages.length)
      items.push({
        label: own.text ? "Draft a reply from my notes" : "Draft a reply",
        icon: "message-reply",
        run: () => void aiWrite(() => compose.aiReply(own.text), own),
      });
    if (own.text) {
      items.push(...AI_EDITS.map(([label, glyph, instruction]): Item => ({ label, icon: glyph, run: () => void rewrite(instruction) })));
      items.push({
        label: "Custom instruction…",
        icon: "pencil",
        run: () =>
          void askText({
            title: "Rewrite with AI",
            message: 'Say what to change, for example "Make it sound more confident".',
            confirm: "Rewrite",
            value: "",
          }).then((i) => void (i && rewrite(i))),
      });
    }
    if (!items.length) return toast("Write something to edit it with AI");
    actionSheet(editor.state.selection.empty ? "Write with AI" : "Edit the selection", items);
  }

  return {
    write: () => compose.write(),
    reply: (kind: ReplyKind, m?: Message) => compose.reply(kind, m),
    openDraft: (id: string) =>
      compose.openDraft(id, (bcc) => {
        rcpt.bcc.set(bcc);
        showCc(!!rcpt.cc.value, true);
      }),
    editScheduled: (id: string) => compose.editScheduled(id),
  };
}

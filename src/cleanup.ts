// "Clean up Inbox": the AI sorts the newest Inbox mail into groups and the user archives a group (or some of it) in
// one click. Nothing moves until the user clicks Archive, and every archive can be undone.
import { invoke } from "@tauri-apps/api/core";
import { iconHtml } from "./icons";

type Item = { account: string; id: string; group: "newsletter" | "notification" | "done" | "keep"; sender: string; subject: string };

type Context = {
  scope: () => string[] | null;
  toast: (msg: string) => void;
};

const GROUPS: [Item["group"], string, string, string][] = [
  ["newsletter", "Newsletters", "news", "Marketing, newsletters and digests"],
  ["notification", "Notifications", "bell", "Receipts, alerts, codes and app updates"],
  ["done", "Done", "circle-check", "Conversations that need nothing more from you"],
];

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const name = (sender: string) => sender.split("<")[0].trim().replace(/^"|"$/g, "") || sender;

const sheet = () => document.getElementById("cleanup") as HTMLDialogElement;
const body = () => sheet().querySelector<HTMLElement>(".cu-body")!;
let ctx: Context;

export function initCleanup(context: Context) {
  ctx = context;
  sheet().addEventListener("click", (e) => {
    if (e.target === sheet() || (e.target as Element).closest("[data-cu-close]")) sheet().close();
  });
  body().addEventListener("change", (e) => {
    const box = e.target as HTMLInputElement;
    const group = box.closest<HTMLElement>(".cu-group");
    if (!group) return;
    if (box.dataset.all !== undefined) group.querySelectorAll<HTMLInputElement>("li input").forEach((b) => (b.checked = box.checked));
    updateCounts(group);
  });
  body().addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>("[data-archive]");
    if (b) void archive(b.closest<HTMLElement>(".cu-group")!);
    const undo = (e.target as Element).closest<HTMLButtonElement>("[data-undo]");
    if (undo) void restore(undo);
  });
}

export async function openCleanup() {
  sheet().showModal();
  body().innerHTML = `<div class="cu-loading"><span class="cu-spinner"></span><p>Sorting your Inbox with AI…</p><small>This reads the sender, subject and preview of your newest Inbox emails.</small></div>`;
  let items: Item[];
  try {
    items = await invoke<Item[]>("ai_cleanup", { accounts: ctx.scope() });
  } catch (err) {
    body().innerHTML = `<div class="cu-loading">${iconHtml("alert-circle")}<p>${esc(String(err))}</p></div>`;
    return;
  }
  const kept = items.filter((i) => i.group === "keep").length;
  const groups = GROUPS.map(([id, title, icon, hint]) => {
    const rows = items.filter((i) => i.group === id);
    if (!rows.length) return "";
    return `<section class="cu-group">
      <header>
        <label class="cu-all"><input type="checkbox" data-all checked />${iconHtml(icon)}<span><strong>${title}</strong><small>${hint}</small></span></label>
        <button type="button" class="primary" data-archive>Archive <b>${rows.length}</b></button>
      </header>
      <ul>${rows.map((r) => `<li><label><input type="checkbox" checked data-account="${esc(r.account)}" data-id="${esc(r.id)}" /><b>${esc(name(r.sender))}</b><span>${esc(r.subject || "(no subject)")}</span></label></li>`).join("")}</ul>
    </section>`;
  }).join("");
  body().innerHTML = groups
    ? `${groups}<p class="cu-kept">${kept} ${kept === 1 ? "email stays" : "emails stay"} in your Inbox. Archived mail stays in All Mail.</p>`
    : `<div class="cu-loading">${iconHtml("circle-check")}<p>Your Inbox already looks tidy.</p></div>`;
}

function updateCounts(group: HTMLElement) {
  const boxes = [...group.querySelectorAll<HTMLInputElement>("li input")];
  const n = boxes.filter((b) => b.checked).length;
  group.querySelector("[data-archive] b")!.textContent = String(n);
  group.querySelector<HTMLButtonElement>("[data-archive]")!.disabled = n === 0;
  const all = group.querySelector<HTMLInputElement>("[data-all]")!;
  all.checked = n === boxes.length;
  all.indeterminate = n > 0 && n < boxes.length;
}

const setInbox = (list: { account: string; id: string }[], inInbox: boolean) =>
  Promise.all(list.map(({ account, id }) =>
    invoke("modify", { account, id, add: inInbox ? ["INBOX"] : [], remove: inInbox ? [] : ["INBOX"], trash: false })));

async function archive(group: HTMLElement) {
  const boxes = [...group.querySelectorAll<HTMLInputElement>("li input:checked")];
  const list = boxes.map((b) => ({ account: b.dataset.account!, id: b.dataset.id! }));
  if (!list.length) return;
  group.querySelector<HTMLButtonElement>("[data-archive]")!.disabled = true;
  try {
    await setInbox(list, false);
  } catch (err) {
    ctx.toast(`Couldn't archive everything: ${err}`);
  }
  boxes.forEach((b) => b.closest("li")!.remove());
  // Shown in the sheet, not as a toast: the app's toasts sit under a modal sheet.
  const done = document.createElement("div");
  done.className = "cu-done";
  done.dataset.list = JSON.stringify(list);
  done.innerHTML = `${iconHtml("circle-check")}<span>Archived ${list.length} ${list.length === 1 ? "email" : "emails"}</span><button type="button" data-undo>Undo</button>`;
  group.before(done);
  if (!group.querySelector("li")) group.remove();
  else updateCounts(group);
}

async function restore(button: HTMLButtonElement) {
  const done = button.closest<HTMLElement>(".cu-done")!;
  button.disabled = true;
  try {
    await setInbox(JSON.parse(done.dataset.list!), true);
    done.querySelector("span")!.textContent = "Moved back to your Inbox";
    button.remove();
  } catch (err) {
    ctx.toast(String(err));
    button.disabled = false;
  }
}

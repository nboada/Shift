// "Clean up Inbox": the AI sorts the newest Inbox mail into groups and the user archives a group (or some of it) in
// one click. Nothing moves until the user clicks Archive, and every archive can be undone. Sorting takes a while, so
// it runs in the background: closing the sheet leaves a small card in the corner that says when the results are ready.
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
const card = () => document.getElementById("cleanup-status")!;
let ctx: Context;

/** The sort in progress (or finished, until it's reviewed). */
let run: { result: Item[] | null; error: string | null } | null = null;

export function initCleanup(context: Context) {
  ctx = context;
  sheet().addEventListener("click", (e) => {
    if (e.target === sheet() || (e.target as Element).closest("[data-cu-close]")) sheet().close();
  });
  // Results stay until they've been seen; closing while sorting leaves the corner card.
  sheet().addEventListener("close", () => {
    if (run && (run.result || run.error)) run = null;
    showCard();
  });
  body().addEventListener("change", (e) => {
    const box = e.target as HTMLInputElement;
    const group = box.closest<HTMLElement>(".cu-group");
    if (!group) return;
    if (box.dataset.all !== undefined) group.querySelectorAll<HTMLInputElement>("li input").forEach((b) => (b.checked = box.checked));
    updateCounts(group);
  });
  body().addEventListener("click", (e) => {
    const target = e.target as Element;
    const b = target.closest<HTMLButtonElement>("[data-archive]");
    if (b) return void archive(b.closest<HTMLElement>(".cu-group")!);
    const undo = target.closest<HTMLButtonElement>("[data-undo]");
    if (undo) return void restore(undo);
    // The header opens and closes its group, except on the checkbox.
    const head = target.closest(".cu-group header");
    if (head && !target.closest(".cu-all")) head.parentElement!.classList.toggle("open");
  });
  card().addEventListener("click", (e) => {
    if ((e.target as Element).closest("[data-cu-dismiss]")) {
      run = null;
      return showCard();
    }
    void openCleanup();
  });
}

export async function openCleanup() {
  if (!sheet().open) sheet().showModal();
  card().hidden = true;
  if (run) return render();
  run = { result: null, error: null };
  const mine = run;
  render();
  try {
    mine.result = await invoke<Item[]>("ai_cleanup", { accounts: ctx.scope() });
  } catch (err) {
    mine.error = String(err);
  }
  if (run !== mine) return;
  if (sheet().open) render();
  else showCard();
}

function showCard() {
  const c = card();
  if (!run || sheet().open) return void (c.hidden = true);
  c.hidden = false;
  if (!run.result && !run.error) {
    c.innerHTML = `<span class="cu-spinner small"></span><span><strong>Sorting your Inbox</strong><small>You can keep working</small></span>`;
    return;
  }
  const n = run.result?.filter((i) => i.group !== "keep").length ?? 0;
  c.innerHTML = `${iconHtml(run.error ? "alert-circle" : "circle-check")}<span><strong>${run.error ? "Couldn't sort your Inbox" : "Your Inbox is sorted"}</strong>
    <small>${run.error ? "Click to see why" : n ? `${n} ${n === 1 ? "email" : "emails"} to review` : "Nothing to archive"}</small></span>
    <button type="button" class="icon" data-cu-dismiss aria-label="Dismiss">${iconHtml("x")}</button>`;
}

function render() {
  if (!run) return;
  if (run.error) {
    body().innerHTML = `<div class="cu-loading">${iconHtml("alert-circle")}<p>${esc(run.error)}</p></div>`;
    return;
  }
  if (!run.result) {
    body().innerHTML = `<div class="cu-loading"><span class="cu-spinner"></span><p>Sorting your Inbox with AI…</p>
      <small>This reads the sender, subject and preview of your newest Inbox emails. It can take a minute: close this and keep working, and Shift lets you know when it's done.</small></div>`;
    return;
  }
  const items = run.result;
  const kept = items.filter((i) => i.group === "keep").length;
  let first = true;
  const groups = GROUPS.map(([id, title, icon, hint]) => {
    const rows = items.filter((i) => i.group === id);
    if (!rows.length) return "";
    // The first group starts open; the rest open on click.
    const open = first;
    first = false;
    return `<section class="cu-group${open ? " open" : ""}">
      <header>
        <label class="cu-all"><input type="checkbox" data-all checked aria-label="Select all ${title}" /></label>
        ${iconHtml(icon)}
        <span class="cu-title"><strong>${title}</strong><small>${hint}</small></span>
        <span class="cu-count" data-count>${rows.length}</span>
        <button type="button" class="primary small" data-archive>Archive</button>
        <i class="ti ti-chevron-down cu-caret" aria-hidden="true"></i>
      </header>
      <div class="cu-rows"><ul>${rows.map((r) => `<li><label><input type="checkbox" checked data-account="${esc(r.account)}" data-id="${esc(r.id)}" /><b>${esc(name(r.sender))}</b><span>${esc(r.subject || "(no subject)")}</span></label></li>`).join("")}</ul></div>
    </section>`;
  }).join("");
  body().innerHTML = groups
    ? `${groups}<p class="cu-kept">${kept} ${kept === 1 ? "email stays" : "emails stay"} in your Inbox. Archived mail stays in All Mail.</p>`
    : `<div class="cu-loading">${iconHtml("circle-check")}<p>Your Inbox already looks tidy.</p></div>`;
}

function updateCounts(group: HTMLElement) {
  const boxes = [...group.querySelectorAll<HTMLInputElement>("li input")];
  const n = boxes.filter((b) => b.checked).length;
  group.querySelector("[data-count]")!.textContent = n === boxes.length ? String(n) : `${n} of ${boxes.length}`;
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
  // In the sheet, next to the group it came from, so Undo stays at hand while reviewing the rest.
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

// A newer Shift, offered rather than installed: a dialog when one is found at launch (or asked for), and an icon by
// Settings in the sidebar while it waits. The download starts only from the dialog's Update button (updates.rs).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type Available = { version: string; current: string; notes: string | null; launch: boolean };

const dialog = document.getElementById("update") as HTMLDialogElement;
const button = document.getElementById("update-btn") as HTMLButtonElement;
const title = dialog.querySelector("h3")!;
const sub = dialog.querySelector<HTMLElement>(".update-sub")!;
const notes = dialog.querySelector<HTMLElement>(".update-notes")!;
const progress = dialog.querySelector<HTMLElement>(".update-progress")!;
const bar = progress.querySelector<HTMLElement>("i")!;
const status = progress.querySelector<HTMLElement>(".update-status")!;
const size = progress.querySelector<HTMLElement>(".update-size")!;
const error = dialog.querySelector<HTMLElement>(".update-error")!;
const later = dialog.querySelector<HTMLButtonElement>("[data-later]")!;
const go = dialog.querySelector<HTMLButtonElement>("[data-update]")!;
const cancel = dialog.querySelector<HTMLButtonElement>("[data-cancel]")!;

let waiting: Available | null = null;
let downloading = false;
/** The release the launch dialog was shown for, so the launch check and `pending_update` don't both open it. */
let offered: string | null = null;
let beforeRestart: () => Promise<void> = async () => {};

export const updateOpen = () => dialog.open;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

/** The release notes (latest.json's "notes", the changelog entry): one line is a sentence, several a list. */
function notesHtml(text: string | null) {
  const lines = (text ?? "")
    .split("\n")
    .map((l) => l.replace(/^\s*[-*•]\s*/, "").trim())
    .filter(Boolean);
  if (!lines.length) return "";
  // The changelog's **bold** lead-ins stay bold; nothing else of Markdown is used there.
  const line = (l: string) => esc(l).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  return lines.length === 1
    ? `<p>${line(lines[0])}</p>`
    : `<ul>${lines.map((l) => `<li>${line(l)}</li>`).join("")}</ul>`;
}

function offer(a: Available) {
  waiting = a;
  button.hidden = false;
  button.dataset.tip = `Update to Shift ${a.version}`;
  button.setAttribute("aria-label", button.dataset.tip);
}

/** The dialog in its first state: what's new, Later and Update. */
export function openUpdate(a: Available | null = waiting) {
  if (!a) return;
  offer(a);
  title.textContent = `Shift ${a.version} is available`;
  sub.textContent = `You have ${a.current}`;
  notes.innerHTML = notesHtml(a.notes);
  notes.hidden = !notes.innerHTML;
  progress.hidden = true;
  error.hidden = true;
  later.hidden = go.hidden = false;
  cancel.hidden = true;
  go.textContent = "Update and restart";
  go.disabled = false;
  if (!dialog.open) dialog.showModal();
  go.focus();
}

async function install() {
  if (!waiting) return;
  downloading = true;
  title.textContent = `Updating to Shift ${waiting.version}`;
  sub.textContent = "Shift restarts when it's done";
  notes.hidden = error.hidden = true;
  progress.hidden = false;
  bar.style.width = "0%";
  status.textContent = "Downloading…";
  size.textContent = "";
  later.hidden = go.hidden = true;
  cancel.hidden = false;
  cancel.disabled = false;
  try {
    await invoke("install_update");
    bar.style.width = "100%";
    status.textContent = "Restarting…";
    cancel.disabled = true;
    await beforeRestart().catch(() => {});
    await invoke("restart_app");
  } catch (e) {
    if (String(e) === "cancelled") return void dialog.close();
    openUpdate();
    error.textContent = `Couldn't update: ${e}`;
    error.hidden = false;
    go.textContent = "Try again";
  } finally {
    downloading = false;
  }
}

listen<[number, number | null]>("update-progress", ({ payload: [got, total] }) => {
  bar.style.width = total ? `${Math.min(100, (got / total) * 100)}%` : "";
  progress.classList.toggle("unknown", !total);
  size.textContent = total ? `${mb(got)} of ${mb(total)} MB` : `${mb(got)} MB`;
  if (total && got >= total) status.textContent = "Installing…";
});

/** Settings → General → Check now: opens the dialog when there's a newer version, else resolves null. */
export async function checkForUpdate(): Promise<Available | null> {
  const found = await invoke<Available | null>("check_update");
  if (found) openUpdate(found);
  return found;
}

/** Wires the dialog and the sidebar icon; `save` runs before the restart (an open draft, settings). */
export function initUpdates(save: () => Promise<void>) {
  beforeRestart = save;
  const announce = (a: Available) => {
    offer(a);
    if (a.launch && offered !== a.version && !downloading) {
      offered = a.version;
      openUpdate(a);
    }
  };
  listen<Available>("update-available", (e) => announce(e.payload));
  // The launch check may finish before this window listens.
  void invoke<Available | null>("pending_update")
    .then((a) => a && announce(a))
    .catch(() => {});
  button.addEventListener("click", () => openUpdate());
  later.addEventListener("click", () => dialog.close());
  go.addEventListener("click", () => void install());
  cancel.addEventListener("click", () => {
    cancel.disabled = true;
    status.textContent = "Cancelling…";
    void invoke("cancel_update");
  });
  // Escape is Later; during a download it does nothing, so Cancel stays the one way out.
  dialog.addEventListener("cancel", (e) => {
    if (downloading) e.preventDefault();
  });
}

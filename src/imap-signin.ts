// Sign-in for IMAP + SMTP accounts (anything that isn't Gmail): email and password, server settings found for the
// user and shown only when that fails or they want to change them.

import { invoke } from "@tauri-apps/api/core";

type Config = { user: string; imapHost: string; imapPort: number; smtpHost: string; smtpPort: number };

const dialog = document.getElementById("imap-signin") as HTMLDialogElement;
const form = dialog.querySelector("form")!;
const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
const error = dialog.querySelector<HTMLElement>(".error")!;
const details = dialog.querySelector("details")!;
const ok = dialog.querySelector<HTMLButtonElement>("[data-ok]")!;

let done: ((email: string | null) => void) | null = null;

function fill(c: Config) {
  field("user").value = c.user;
  field("imapHost").value = c.imapHost;
  field("imapPort").value = String(c.imapPort);
  field("smtpHost").value = c.smtpHost;
  field("smtpPort").value = String(c.smtpPort);
}

function config(email: string): Config {
  return {
    user: field("user").value.trim() || email,
    imapHost: field("imapHost").value.trim(),
    imapPort: Number(field("imapPort").value) || 993,
    smtpHost: field("smtpHost").value.trim(),
    smtpPort: Number(field("smtpPort").value) || 465,
  };
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = field("email").value.trim();
  const password = field("password").value;
  ok.disabled = true;
  error.textContent = "";
  try {
    if (!field("imapHost").value.trim()) {
      ok.textContent = "Finding your mail server…";
      fill({ ...(await invoke<Config>("guess_imap", { email })), user: field("user").value.trim() || email });
    }
    ok.textContent = "Signing in…";
    const added = await invoke<string>("add_imap_account", { email, password, config: config(email) });
    done?.(added);
    dialog.close();
  } catch (err) {
    error.textContent = String(err);
    details.open = true;
  } finally {
    ok.disabled = false;
    ok.textContent = "Sign in";
  }
});

dialog.querySelector("[data-cancel]")!.addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => {
  field("password").value = "";
  done?.(null);
  done = null;
});

/** Opens the form; resolves the signed-in address, or null when cancelled. */
export function addImapAccount(): Promise<string | null> {
  form.reset();
  error.textContent = "";
  details.open = false;
  dialog.showModal();
  field("email").focus();
  return new Promise((resolve) => (done = resolve));
}

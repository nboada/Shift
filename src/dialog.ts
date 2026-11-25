// In-app confirm dialog. window.confirm() is a no-op in the Tauri webview, so every "are you sure" goes through here.

type Ask = { title: string; message: string; confirm: string; cancel?: string; danger?: boolean };
type Choice = Ask & { alt: string; escapeIsAlt?: boolean };

const dialog = document.getElementById("ask") as HTMLDialogElement;

export const askOpen = () => dialog.open;

const input = dialog.querySelector("input")!;
input.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  dialog.querySelector<HTMLButtonElement>("[data-ok]")!.click();
});

const swatches = dialog.querySelector<HTMLElement>(".ask-swatches")!;
swatches.addEventListener("click", (e) => {
  const b = (e.target as Element).closest<HTMLElement>("[role=radio]");
  if (!b) return;
  swatches.querySelectorAll("[role=radio]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
});

/**
 * `askText` plus a row of colour swatches. `colors` are [name, swatch HTML attributes] pairs; resolves the text and
 * the picked colour's name, or null when cancelled or left empty.
 */
export async function askTextAndColor(
  opts: Ask & { value: string; colors: [name: string, attrs: string][] },
): Promise<{ text: string; color: string } | null> {
  swatches.innerHTML = opts.colors
    .map(
      ([name, attrs], i) =>
        `<button type="button" role="radio" aria-label="${name}" aria-checked="${i === 0}" data-name="${name}" ${attrs}></button>`,
    )
    .join("");
  swatches.hidden = false;
  const text = await askText(opts);
  swatches.hidden = true;
  const color = swatches.querySelector<HTMLElement>("[aria-checked=true]")?.dataset.name ?? opts.colors[0][0];
  return text ? { text, color } : null;
}

/** `ask` with a text field; resolves the trimmed text, or null when cancelled or left empty. */
export async function askText(opts: Ask & { value: string }): Promise<string | null> {
  input.hidden = false;
  input.value = opts.value;
  const answer = ask(opts);
  input.focus();
  input.select();
  const ok = await answer;
  input.hidden = true;
  return ok ? input.value.trim() || null : null;
}

/** Resolves true when confirmed; Escape, Cancel or clicking outside resolve false. */
export const ask = (opts: Ask) => choose(opts).then((c) => c === "ok");

/** `ask` with a third button left of Cancel: resolves "ok", "alt", or null when cancelled. */
export const askChoice = (opts: Choice) => choose(opts);

function choose({
  title,
  message,
  confirm,
  cancel = "Cancel",
  danger = false,
  alt,
  escapeIsAlt = false,
}: Ask & { alt?: string; escapeIsAlt?: boolean }): Promise<"ok" | "alt" | null> {
  dialog.querySelector("h3")!.textContent = title;
  dialog.querySelector("p")!.textContent = message;
  const ok = dialog.querySelector<HTMLButtonElement>("[data-ok]")!;
  const no = dialog.querySelector<HTMLButtonElement>("[data-cancel]")!;
  const other = dialog.querySelector<HTMLButtonElement>("[data-alt]")!;
  ok.textContent = confirm;
  no.textContent = cancel;
  other.querySelector("span")!.textContent = alt ?? "";
  other.hidden = !alt;
  ok.classList.toggle("danger", danger);
  return new Promise((resolve) => {
    const finish = (value: "ok" | "alt" | null) => {
      ok.onclick = no.onclick = other.onclick = dialog.onclick = null;
      dialog.removeEventListener("close", onClose);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    // Escape closes the dialog; it means Cancel unless the caller makes it the third button.
    const onClose = () => finish(escapeIsAlt ? "alt" : null);
    ok.onclick = () => finish("ok");
    no.onclick = () => finish(null);
    other.onclick = () => finish("alt");
    // A click on the backdrop lands on the <dialog> itself.
    dialog.onclick = (e) => e.target === dialog && finish(null);
    dialog.addEventListener("close", onClose);
    dialog.showModal();
    ok.focus();
  });
}

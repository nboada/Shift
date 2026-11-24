// In-app confirm dialog. window.confirm() is a no-op in the Tauri webview, so every "are you sure" goes through here.

type Ask = { title: string; message: string; confirm: string; cancel?: string; danger?: boolean };

const dialog = document.getElementById("ask") as HTMLDialogElement;

export const askOpen = () => dialog.open;

/** Resolves true when confirmed; Escape, Cancel or clicking outside resolve false. */
export function ask({ title, message, confirm, cancel = "Cancel", danger = false }: Ask): Promise<boolean> {
  dialog.querySelector("h3")!.textContent = title;
  dialog.querySelector("p")!.textContent = message;
  const ok = dialog.querySelector<HTMLButtonElement>("[data-ok]")!;
  const no = dialog.querySelector<HTMLButtonElement>("[data-cancel]")!;
  ok.textContent = confirm;
  no.textContent = cancel;
  ok.classList.toggle("danger", danger);
  return new Promise((resolve) => {
    const finish = (value: boolean) => {
      ok.onclick = no.onclick = dialog.onclick = null;
      dialog.removeEventListener("close", onClose);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onClose = () => finish(false);
    ok.onclick = () => finish(true);
    no.onclick = () => finish(false);
    // A click on the backdrop lands on the <dialog> itself.
    dialog.onclick = (e) => e.target === dialog && finish(false);
    dialog.addEventListener("close", onClose);
    dialog.showModal();
    ok.focus();
  });
}

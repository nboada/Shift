// The phone's action sheet: choices sliding up from the bottom of the screen, with Cancel.
import { esc } from "../email-view";
import { iconClass } from "../icons";

export type Item = {
  label: string;
  icon: string;
  run: () => void;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
};

const icon = (name: string) => `<i class="${iconClass(name)}" aria-hidden="true"></i>`;

/** A sheet of choices from the bottom of the screen, with Cancel; tapping outside closes it too. */
export function actionSheet(title: string, items: Item[]) {
  document.querySelector("dialog.m-sheet")?.remove();
  const d = document.createElement("dialog");
  d.className = "m-sheet";
  d.setAttribute("aria-label", title);
  d.innerHTML = `<div class="m-sheet-group">${title ? `<h2>${esc(title)}</h2>` : ""}${items
    .map(
      (x, i) =>
        `<button type="button" data-i="${i}" class="${x.danger ? "quiet-danger" : ""}" ${x.disabled ? "disabled" : ""} ${x.checked === undefined ? "" : `role="menuitemcheckbox" aria-checked="${x.checked}"`}>${icon(x.icon)}<span>${esc(x.label)}</span>${x.checked ? icon("check") : ""}</button>`,
    )
    .join("")}</div><div class="m-sheet-group"><button type="button" class="m-sheet-cancel">Cancel</button></div>`;
  d.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>("button");
    if (e.target === d || b?.classList.contains("m-sheet-cancel")) return d.close();
    if (!b || b.disabled) return;
    d.close();
    items[Number(b.dataset.i)].run();
  });
  d.addEventListener("close", () => d.remove());
  document.body.append(d);
  d.showModal();
}


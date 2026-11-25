import { iconClass } from "./icons";

export type ToastOptions = {
  /** One button next to the message (Undo, Restart). It closes the toast before running. */
  action?: { label: string; run: () => void };
  /** How long it stays up. Hovering pauses the countdown. */
  ms?: number;
  /** Picks the icon and its colour; `icon` overrides the icon. */
  kind?: "success" | "error" | "info";
  icon?: string;
};

const KIND_ICONS = { success: "circle-check", error: "alert-circle", info: "info-circle" };

export type Toast = { setMessage: (msg: string) => void; close: () => void; readonly open: boolean };

let current: { el: HTMLElement; timer: number } | null = null;

/** The single toast at the bottom of the window. A new one replaces whatever is showing. */
export function toast(
  msg: string,
  { action, ms = action ? 8000 : 4000, kind = "info", icon = KIND_ICONS[kind] }: ToastOptions = {},
): Toast {
  current?.el.remove();
  clearTimeout(current?.timer);

  // A popover, so it opens in the top layer above any open modal (composer, sheets).
  const el = document.createElement("div");
  el.className = "toast";
  el.dataset.kind = kind;
  el.popover = "manual";
  el.setAttribute("role", "status");
  el.append(Object.assign(document.createElement("i"), { className: `${iconClass(icon)} toast-icon` }));
  const text = Object.assign(document.createElement("span"), { className: "toast-text", textContent: msg });
  el.append(text);
  if (action) {
    const btn = Object.assign(document.createElement("button"), {
      type: "button",
      className: "toast-action",
      textContent: action.label,
    });
    btn.onclick = () => {
      close();
      action.run();
    };
    el.append(btn);
  }
  const x = Object.assign(document.createElement("button"), {
    type: "button",
    className: "toast-close",
    ariaLabel: "Dismiss",
  });
  x.innerHTML = `<i class="${iconClass("x")}" aria-hidden="true"></i>`;
  x.onclick = () => close();
  el.append(x);

  const state = { el, timer: 0 };
  const arm = () => (state.timer = window.setTimeout(close, ms));
  function close() {
    clearTimeout(state.timer);
    el.remove();
    if (current === state) current = null;
  }
  el.onpointerenter = () => clearTimeout(state.timer);
  el.onpointerleave = arm;

  document.body.append(el);
  el.showPopover();
  arm();
  current = state;
  return {
    setMessage: (m) => (text.textContent = m),
    close,
    get open() {
      return el.isConnected;
    },
  };
}

/** True while a toast with a button (Undo, Restart) is up, so routine messages can wait their turn. */
export const actionToastOpen = () => !!current?.el.querySelector(".toast-action");

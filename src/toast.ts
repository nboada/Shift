import { iconClass } from "./icons";

export type ToastOptions = {
  /** One button next to the message (Undo, Restart), with its shortcut if it has one. It closes the toast before
   * running, and a thin line drains along the bottom while it's still on offer. */
  action?: { label: string; run: () => void; key?: string };
  /** How long it stays up. Hovering pauses the countdown. */
  ms?: number;
  /** Picks the icon and its colour; `icon` overrides the icon. */
  kind?: "success" | "error" | "info";
  icon?: string;
};

const KIND_ICONS = { success: "circle-check", error: "alert-circle", info: "info-circle" };

export type Toast = {
  /** New text; `restart` gives it its full time again (a merged "Archived 3 emails"). */
  setMessage: (msg: string, restart?: boolean) => void;
  close: () => void;
  readonly open: boolean;
};

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
    const btn = Object.assign(document.createElement("button"), { type: "button", className: "toast-action" });
    btn.append(action.label);
    if (action.key) btn.append(Object.assign(document.createElement("kbd"), { textContent: action.key }));
    btn.onclick = () => {
      close();
      action.run();
    };
    el.append(btn);
  }
  // Only errors, which can be long and stay a while, get a close button; the rest leave on their own.
  if (kind === "error") {
    const x = Object.assign(document.createElement("button"), {
      type: "button",
      className: "toast-close",
      ariaLabel: "Dismiss",
    });
    x.innerHTML = `<i class="${iconClass("x")}" aria-hidden="true"></i>`;
    x.onclick = () => close();
    el.append(x);
  }
  // How long the action stays on offer, drawn as a line that drains (paused with the countdown on hover).
  const timer = action ? Object.assign(document.createElement("span"), { className: "toast-timer" }) : null;
  if (timer) el.append(timer);

  const state = { el, timer: 0 };
  let deadline = 0;
  let left = ms;
  const arm = (wait: number) => {
    clearTimeout(state.timer);
    deadline = Date.now() + wait;
    state.timer = window.setTimeout(close, wait);
  };
  const restartLine = () => {
    if (!timer) return;
    timer.style.animation = "none";
    void timer.offsetWidth; // so the animation starts over
    timer.style.removeProperty("animation");
    timer.style.setProperty("--toast-ms", `${ms}ms`);
  };
  function close() {
    clearTimeout(state.timer);
    el.remove();
    if (current === state) current = null;
  }
  el.onpointerenter = () => {
    clearTimeout(state.timer);
    left = Math.max(0, deadline - Date.now());
  };
  el.onpointerleave = () => arm(left);

  document.body.append(el);
  el.showPopover();
  restartLine();
  arm(ms);
  current = state;
  return {
    setMessage: (m, restart = false) => {
      text.textContent = m;
      if (!restart) return;
      restartLine();
      left = ms;
      if (!el.matches(":hover")) arm(ms);
    },
    close,
    get open() {
      return el.isConnected;
    },
  };
}

/** True while a toast with a button (Undo, Restart) is up, so routine messages can wait their turn. */
export const actionToastOpen = () => !!current?.el.querySelector(".toast-action");

// The phone's sheets: action sheets sliding up from the bottom, a confirmation for what can't be undone, a taller
// searchable list for moving and labelling, and the menu a long press opens over a row.
import { esc, labelDot } from "../email-view";
import { iconClass } from "../icons";
import { settings } from "../settings";

export type Item = {
  label: string;
  /** A second line under the label, such as the time a Send later choice sends at. */
  detail?: string;
  icon: string;
  run: () => void;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
};

const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
/** How far a list sheet is pulled down by its top before letting go closes it. */
const CLOSE_AT = 100;

const icon = (name: string) => `<i class="${iconClass(name)}" aria-hidden="true"></i>`;
const reduced = () => settings.accessibility.reduceMotion || matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Only one sheet or menu is open at a time; opening another replaces it. */
function replaceOpen() {
  document.querySelectorAll<HTMLDialogElement>("dialog.m-sheet, dialog.m-menu-layer").forEach((d) => {
    d.close();
    d.remove();
  });
}

/** Slides the sheet out of view, then closes it. */
function slideClose(d: HTMLDialogElement, from = 0) {
  if (!d.open) return;
  if (reduced()) return d.close();
  const sheet = d.querySelector<HTMLElement>(".m-sheet-panel") ?? d;
  d.classList.add("closing");
  void sheet
    .animate([{ transform: `translateY(${from}px)` }, { transform: "translateY(110%)" }], {
      duration: 260,
      easing: EASE,
      fill: "forwards",
    })
    .finished.then(() => d.close(), () => d.close());
}

/** A sheet of choices from the bottom of the screen, with Cancel; tapping outside closes it too. */
export function actionSheet(title: string, items: Item[]) {
  replaceOpen();
  const d = document.createElement("dialog");
  d.className = "m-sheet";
  d.setAttribute("aria-label", title || "Actions");
  d.innerHTML = `<div class="m-sheet-group">${title ? `<h2>${esc(title)}</h2>` : ""}${items
    .map(
      (x, i) =>
        `<button type="button" data-i="${i}" class="${x.danger ? "quiet-danger" : ""}" ${x.disabled ? "disabled" : ""} ${x.checked === undefined ? "" : `role="menuitemcheckbox" aria-checked="${x.checked}"`}>${icon(x.icon)}<span>${esc(x.label)}${x.detail ? `<small>${esc(x.detail)}</small>` : ""}</span>${x.checked ? icon("check") : ""}</button>`,
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

/**
 * Asks before something that can't be undone (Empty Trash, Delete forever): what will happen, the action in the
 * danger colour, and Cancel. Resolves true when confirmed.
 */
export function confirmSheet(o: { title: string; message: string; confirm: string }) {
  replaceOpen();
  return new Promise<boolean>((done) => {
    const d = document.createElement("dialog");
    d.className = "m-sheet m-confirm";
    d.setAttribute("aria-labelledby", "m-confirm-title");
    d.setAttribute("aria-describedby", "m-confirm-text");
    d.innerHTML = `<div class="m-sheet-group">
        <div class="m-confirm-head"><h2 id="m-confirm-title">${esc(o.title)}</h2><p id="m-confirm-text">${esc(o.message)}</p></div>
        <button type="button" class="m-confirm-go" data-ok>${esc(o.confirm)}</button>
      </div>
      <div class="m-sheet-group"><button type="button" class="m-sheet-cancel">Cancel</button></div>`;
    let ok = false;
    d.addEventListener("click", (e) => {
      const b = (e.target as Element).closest<HTMLButtonElement>("button");
      if (e.target !== d && !b) return;
      ok = !!b?.hasAttribute("data-ok");
      d.close();
    });
    d.addEventListener("close", () => {
      d.remove();
      done(ok);
    });
    document.body.append(d);
    d.showModal();
    d.querySelector<HTMLButtonElement>(".m-sheet-cancel")!.focus();
  });
}

export type Choice = {
  id: string;
  label: string;
  /** A Tabler icon; without one, a label dot in `color`. */
  icon?: string;
  color?: string | null;
  disabled?: boolean;
  /** For a list of toggles: on, off, or on for only some of the selected emails. */
  state?: "all" | "some" | "none";
};
export type ChoiceGroup = { title?: string; items: Choice[] };

/**
 * A taller sheet listing mailboxes or labels, with a search field once the list is long, so a few hundred labels stay
 * usable. Without `toggle`, a tap picks and closes. With it, each tap flips one entry at once (`pick` returns its new
 * state) and Done closes. Pulled down by its top, it closes too.
 */
export function listSheet(o: {
  title: string;
  groups: ChoiceGroup[];
  toggle?: boolean;
  pick: (id: string) => Choice["state"] | void;
  empty?: string;
}) {
  replaceOpen();
  const all = o.groups.flatMap((g) => g.items);
  const searchable = all.length > 8;
  const d = document.createElement("dialog");
  d.className = "m-sheet m-list-sheet";
  d.setAttribute("aria-labelledby", "m-list-sheet-title");
  d.innerHTML = `<div class="m-sheet-panel">
      <header class="m-sheet-head">
        <div class="m-grab" aria-hidden="true"></div>
        <h2 id="m-list-sheet-title">${esc(o.title)}</h2>
        <button type="button" class="m-sheet-done" data-close>${o.toggle ? "Done" : "Cancel"}</button>
      </header>
      ${searchable ? `<form class="m-search m-sheet-search" role="search">${icon("magnifying-glass")}<input type="search" placeholder="Search" aria-label="Search ${esc(o.title.toLowerCase())}" autocomplete="off" spellcheck="false" enterkeyhint="done" /></form>` : ""}
      <div class="m-sheet-list"></div>
    </div>`;
  const list = d.querySelector<HTMLElement>(".m-sheet-list")!;
  const search = d.querySelector<HTMLInputElement>(".m-sheet-search input");

  const row = (c: Choice) => {
    const lead = c.icon ? icon(c.icon) : labelDot(c.label, c.color ?? null);
    const state = o.toggle
      ? ` role="menuitemcheckbox" aria-checked="${c.state === "all" ? "true" : c.state === "some" ? "mixed" : "false"}"`
      : "";
    const mark = c.state === "all" ? icon("check") : c.state === "some" ? icon("minus") : "";
    return `<button type="button" class="m-choice" data-id="${esc(c.id)}"${state} ${c.disabled ? "disabled" : ""}>${lead}<span>${esc(c.label)}</span>${mark}</button>`;
  };
  const render = () => {
    const q = search?.value.trim().toLowerCase() ?? "";
    const html = o.groups
      .map((g) => {
        const items = g.items.filter((c) => !q || c.label.toLowerCase().includes(q));
        if (!items.length) return "";
        return `${g.title ? `<h3 class="m-group-title">${esc(g.title)}</h3>` : ""}<div class="m-group" role="group"${g.title ? ` aria-label="${esc(g.title)}"` : ""}>${items.map(row).join("")}</div>`;
      })
      .join("");
    list.innerHTML = html || `<p class="m-sheet-empty">${esc(q ? `No matches for “${search!.value.trim()}”` : (o.empty ?? "Nothing here"))}</p>`;
  };
  render();
  search?.addEventListener("input", render);
  search?.form!.addEventListener("submit", (e) => {
    e.preventDefault();
    search.blur();
  });

  d.addEventListener("click", (e) => {
    const t = e.target as Element;
    if (t === d || t.closest("[data-close]")) return slideClose(d);
    const b = t.closest<HTMLButtonElement>(".m-choice");
    if (!b || b.disabled) return;
    const c = all.find((x) => x.id === b.dataset.id)!;
    if (!o.toggle) {
      slideClose(d);
      return void o.pick(c.id);
    }
    const next = o.pick(c.id);
    if (next) c.state = next;
    b.outerHTML = row(c);
  });

  // The keyboard (searching) covers the bottom of the screen without resizing it, and WebKit may scroll the page under
  // it: the sheet fills what's visible (--visible-height, set in main.ts) and sits at its bottom.
  const vv = window.visualViewport;
  const fit = () => vv && d.style.setProperty("--vv-top", `${vv.offsetTop}px`);
  vv?.addEventListener("resize", fit);
  vv?.addEventListener("scroll", fit);
  fit();

  // Pulled down by its top: follows the finger, and closes past CLOSE_AT or with a flick.
  const panel = d.querySelector<HTMLElement>(".m-sheet-panel")!;
  d.querySelector(".m-sheet-head")!.addEventListener("pointerdown", (e) => {
    const ev0 = e as PointerEvent;
    if (ev0.pointerType === "mouse" || (ev0.target as Element).closest("button")) return;
    const y0 = ev0.clientY;
    let dy = 0;
    let last = { y: y0, t: ev0.timeStamp };
    let speed = 0;
    const head = ev0.currentTarget as HTMLElement;
    head.setPointerCapture(ev0.pointerId);
    const move = (ev: PointerEvent) => {
      dy = Math.max(0, ev.clientY - y0);
      speed = (ev.clientY - last.y) / Math.max(1, ev.timeStamp - last.t);
      last = { y: ev.clientY, t: ev.timeStamp };
      panel.style.transform = `translateY(${dy}px)`;
    };
    const up = () => {
      head.removeEventListener("pointermove", move);
      head.removeEventListener("pointerup", up);
      head.removeEventListener("pointercancel", up);
      if (dy > CLOSE_AT || speed > 0.6) return slideClose(d, dy);
      panel.style.transform = "";
      if (!reduced())
        panel.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], { duration: 300, easing: EASE });
    };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", up);
    head.addEventListener("pointercancel", up);
  });

  d.addEventListener("close", () => {
    vv?.removeEventListener("resize", fit);
    vv?.removeEventListener("scroll", fit);
    d.remove();
  });
  document.body.append(d);
  d.showModal();
  // showModal focuses the first control; with a search field, that would raise the keyboard before anyone asked.
  (document.activeElement as HTMLElement | null)?.blur();
  return d;
}

/**
 * The menu a long press opens over `row`: the row lifted above a blurred screen, and the actions beside it in groups.
 * Tapping outside closes it.
 */
export function contextMenu(row: HTMLElement, label: string, groups: Item[][]) {
  replaceOpen();
  const rect = row.getBoundingClientRect();
  const d = document.createElement("dialog");
  d.className = "m-menu-layer";
  d.setAttribute("aria-label", label);
  const preview = row.cloneNode(true) as HTMLElement;
  preview.querySelectorAll("[tabindex], [role]").forEach((el) => {
    el.removeAttribute("tabindex");
    el.removeAttribute("role");
  });
  preview.setAttribute("aria-hidden", "true");
  preview.classList.remove("pressing");
  preview.classList.add("m-menu-preview");
  let i = 0;
  const items = groups.flat();
  const menu = document.createElement("div");
  menu.className = "m-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", label);
  menu.innerHTML = groups
    .filter((g) => g.length)
    .map(
      (g) =>
        `<div class="m-menu-group" role="group">${g
          .map(
            (x) =>
              `<button type="button" role="menuitem" data-i="${i++}" class="${x.danger ? "quiet-danger" : ""}" ${x.disabled ? "disabled" : ""}><span>${esc(x.label)}</span>${icon(x.icon)}</button>`,
          )
          .join("")}</div>`,
    )
    .join("");
  d.append(preview, menu);
  document.body.append(d);
  d.showModal();

  // The row stays where it was; the menu goes under it, or above it when there's no room, and the row moves up when
  // there's room for neither.
  // Between the screen's bar and its bottom toolbar, which sit inside the safe areas.
  const page = document.querySelector(".m-page:not(.m-covered):last-of-type");
  const top = (page?.querySelector(".m-bar")?.getBoundingClientRect().bottom ?? 60) + 8;
  const bottom = (page?.querySelector(".m-toolbar")?.getBoundingClientRect().top ?? innerHeight - 34) - 8;
  const h = menu.offsetHeight;
  let y = rect.top;
  let below = true;
  if (rect.bottom + 8 + h > bottom) {
    if (rect.top - 8 - h > top) below = false;
    else y = Math.max(top, bottom - h - 8 - rect.height);
  }
  d.style.setProperty("--row-top", `${y}px`);
  d.style.setProperty("--row-left", `${rect.left}px`);
  d.style.setProperty("--row-width", `${rect.width}px`);
  d.style.setProperty("--menu-top", `${below ? y + rect.height + 8 : y - 8 - h}px`);
  d.classList.toggle("above", !below);
  (menu.querySelector("button:not(:disabled)") as HTMLElement | null)?.focus({ preventScroll: true });

  // The finger that held the row still has to lift: that click started outside the menu, so it doesn't count.
  let touched = false;
  d.addEventListener("pointerdown", () => (touched = true));
  d.addEventListener("click", (e) => {
    if (!touched && e.detail) return;
    const b = (e.target as Element).closest<HTMLButtonElement>(".m-menu button");
    if (!b) return d.close();
    if (b.disabled) return;
    d.close();
    items[Number(b.dataset.i)].run();
  });
  d.addEventListener("close", () => d.remove());
}
